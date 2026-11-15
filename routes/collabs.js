/**
 * Collab posts: a creator names a co-creator while publishing; the co-creator
 * accepts or declines here.
 *
 *   POST /collabs/register  { author, permlink }
 *        Reads the post from Hive and opens a pending invite for each account in
 *        its json_metadata `collaborators` (at most 3, not the author). Nothing is
 *        taken from the request but the address: the post is the author's signed
 *        claim, as with stories and snaps. Idempotent; an answered invite keeps
 *        its answer.
 *   POST /collabs/respond   { user, signature, timestamp, author, permlink, accept }
 *        The co-creator's answer, with the session vouch. Can be changed later
 *        (leaving a collab = declining it after accepting).
 *   POST /collabs/mine      { user, signature, timestamp }
 *        -> { invites: [...] } pending and accepted invites to the caller
 *   GET  /collabs/post/:author/:permlink
 *        -> { collaborators: [{ account, weight }] } accepted ones only
 *
 * Accepted invites put the post on the co-creator's channel (/api/my-videos) and
 * in their followers' Follow feed (utils/followFeed.js), see utils/collabs.js.
 * Pending invites reach the co-creator's bell through the checker notification
 * feed (routes/notify.js), as type 'collab_invite'.
 */
const express = require('express');
const dhive = require('@hiveio/dhive');
const { getDb } = require('../utils/db');
const { HIVE_RPC_ENDPOINTS, COLLABS_COLLECTION } = require('../utils/config');
const { proveProgressUser } = require('../utils/progressVouch');
const { MAX_COLLABORATORS, ensureIndexes } = require('../utils/collabs');
const { levelOf } = require('../utils/notifyLevels');
const notify = require('./notify');

const router = express.Router();
const client = new dhive.Client(HIVE_RPC_ENDPOINTS);
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;

const col = () => getDb().collection(COLLABS_COLLECTION);
const norm = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');

function parseMeta(post) {
  try {
    return typeof post.json_metadata === 'string' ? JSON.parse(post.json_metadata || '{}') : (post.json_metadata || {});
  } catch { return {}; }
}

/** The collaborators a post names: valid, distinct, not the author, at most 3. */
function collaboratorsIn(meta, author) {
  const raw = Array.isArray(meta && meta.collaborators) ? meta.collaborators : [];
  const out = [];
  for (const c of raw) {
    const a = norm(typeof c === 'string' ? c : c && c.account);
    if (ACCOUNT_RE.test(a) && a !== author && !out.includes(a)) out.push(a);
    if (out.length >= MAX_COLLABORATORS) break;
  }
  return out;
}

async function fetchPost(author, permlink, tries = 3, delayMs = 1500) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const post = await client.call('condenser_api', 'get_content', [author, permlink]);
      if (post && post.author && String(post.permlink) === permlink) return post;
    } catch { /* transient: retry */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/**
 * Open the invites a published post names. Exported for the scheduled-post
 * publisher, which publishes on the creator's behalf after the upload page is gone.
 * Returns the collaborators, or null when the post is not a 3Speak post.
 */
async function registerFromPost(post) {
  const author = norm(post.author);
  const permlink = String(post.permlink || '');
  const meta = parseMeta(post);
  if (!String(meta.app || '').startsWith('3speak')) return null;
  const names = collaboratorsIn(meta, author);
  if (!names.length) return [];
  await ensureIndexes(getDb());
  const benes = Array.isArray(post.beneficiaries) ? post.beneficiaries : [];
  const now = new Date();
  for (const collaborator of names) {
    const b = benes.find((x) => norm(x.account) === collaborator);
    await col().updateOne(
      { _id: `${author}/${permlink}|${collaborator}` },
      {
        $set: {
          author, permlink, collaborator,
          title: String(post.title || '').slice(0, 200),
          weight: b ? Number(b.weight) || 0 : 0,
          updated_at: now,
        },
        $setOnInsert: { status: 'pending', created_at: now },
      },
      { upsert: true },
    );
  }
  return names;
}

const brake = new Map();
function tooMany(key, max = 60) {
  const now = Date.now();
  const list = (brake.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= max) return true;
  list.push(now);
  brake.set(key, list);
  if (brake.size > 5000) brake.delete(brake.keys().next().value);
  return false;
}

router.post('/collabs/register', express.json({ limit: '2kb' }), async (req, res) => {
  const author = norm(req.body && req.body.author);
  const permlink = String((req.body && req.body.permlink) || '').trim();
  if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) return res.status(400).json({ success: false, error: 'invalid post' });
  if (tooMany(`reg:${author}`)) return res.status(429).json({ success: false, error: 'too many requests' });
  const post = await fetchPost(author, permlink);
  if (!post) return res.status(404).json({ success: false, error: 'post not found on chain (try again in a moment)' });
  if (norm(post.author) !== author) return res.status(403).json({ success: false, error: 'author mismatch' });
  const names = await registerFromPost(post);
  if (names === null) return res.status(400).json({ success: false, error: 'not a 3Speak post' });
  res.json({ success: true, collaborators: names });
});

router.post('/collabs/respond', express.json({ limit: '2kb' }), async (req, res) => {
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  const author = norm(b.author);
  const permlink = String(b.permlink || '').trim();
  if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) return res.status(400).json({ success: false, error: 'invalid post' });
  if (tooMany(`resp:${user}`, 300)) return res.status(429).json({ success: false, error: 'too many updates' });
  const status = b.accept === true || b.accept === 'true' ? 'accepted' : 'declined';
  const r = await col().updateOne(
    { _id: `${author}/${permlink}|${user}` },
    { $set: { status, responded_at: new Date() } },
  );
  if (!r.matchedCount) return res.status(404).json({ success: false, error: 'no invite' });
  res.json({ success: true, status });
});

router.post('/collabs/mine', express.json({ limit: '2kb' }), async (req, res) => {
  const user = await proveProgressUser(req.body || {});
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  res.set('Cache-Control', 'no-store');
  const rows = await col().find({ collaborator: user, status: { $in: ['pending', 'accepted'] } })
    .sort({ created_at: -1 }).limit(50).toArray();
  res.json({
    success: true,
    invites: rows.map((r) => ({
      author: r.author, permlink: r.permlink, title: r.title, status: r.status, weight: r.weight, created_at: r.created_at,
    })),
  });
});

router.get('/collabs/post/:author/:permlink', async (req, res) => {
  const author = norm(req.params.author);
  const permlink = String(req.params.permlink || '');
  if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) return res.status(400).json({ success: false, error: 'invalid post' });
  const rows = await col().find({ author, permlink, status: 'accepted' }, { projection: { collaborator: 1, weight: 1 } }).toArray();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, collaborators: rows.map((r) => ({ account: r.collaborator, weight: r.weight || 0 })).sort((a, b) => a.account.localeCompare(b.account)) });
});

// Pending invites in the bell (routes/notify.js). Off for the inviter hides them;
// the invite itself stays and can still be answered on the post.
async function collabSource({ user, levels }) {
  const rows = await col().find({ collaborator: user, status: 'pending' }).sort({ created_at: -1 }).limit(20).toArray();
  return rows.filter((r) => levelOf(levels, r.author) !== 'off').map((r) => ({
    id: `collab:${r._id}`,
    type: 'collab_invite',
    actor: r.author,
    title: r.title || r.permlink,
    url: `/watch?v=${r.author}/${r.permlink}`,
    thumbnail: null,
    at: new Date(r.created_at).toISOString(),
    author: r.author,
    permlink: r.permlink,
  }));
}
notify.addSource(collabSource);

module.exports = router;
module.exports.registerFromPost = registerFromPost;
module.exports.collaboratorsIn = collaboratorsIn;
module.exports.collabSource = collabSource;
