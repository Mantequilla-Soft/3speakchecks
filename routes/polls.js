/**
 * Polls on community snaps: the poll is on Hive (utils/polls.js), the votes are
 * kept here, one per account.
 *
 *   POST /polls/vote     { user, signature, timestamp, author, permlink, choice }
 *        -> { result }   one vote per account; voting again moves it (last vote
 *                        counts) until the poll ends, then votes are frozen
 *   POST /polls/results  { keys: ['author/permlink', ...], user?, signature?, timestamp? }
 *        -> { results: { key: { counts, total, closed, ends_at, mine } } }
 *                        `mine` (the caller's choice) only with a good vouch
 *   GET  /polls/creator/:owner
 *        -> { polls: [{ key, permlink, question, options, counts, total, ends_at, closed, created }] }
 *                        the creator's polls with their tallies, for creator stats
 *
 * WHY HERE AND NOT ON HIVE: a vote is the session vouch (utils/progressVouch.js),
 * which every login type has without a wallet prompt, so voting is one tap. A
 * custom_json per vote would ask Keychain users to sign every time and we would
 * still need an index to count them. The vouch proves the account, so "one per
 * account" holds; the counts are public, who voted what is not served to anyone.
 */
const express = require('express');
const { getDb } = require('../utils/db');
const { POLL_VOTES_COLLECTION } = require('../utils/config');
const { proveProgressUser } = require('../utils/progressVouch');
const { isClosed } = require('../utils/polls');

const router = express.Router();
const SNAPS = 'community-snaps';
const OWNER_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;
const MAX_KEYS = 50;

const votes = () => getDb().collection(POLL_VOTES_COLLECTION);

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  try {
    await votes().createIndex({ poll: 1, choice: 1 });
    await votes().createIndex({ voter: 1 });
  } catch (err) {
    indexed = false;
    console.error('[polls] index setup failed:', err && err.message);
  }
}

// Changing a vote is allowed, so a brake per account keeps it a choice, not a loop.
const brake = new Map();
function tooMany(user) {
  const now = Date.now();
  const list = (brake.get(user) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= 120) return true;
  list.push(now);
  brake.set(user, list);
  if (brake.size > 5000) brake.delete(brake.keys().next().value);
  return false;
}

const keyOf = (author, permlink) => `${author}/${permlink}`;
function parseKey(k) {
  const s = String(k || '');
  const i = s.indexOf('/');
  if (i < 0) return null;
  const author = s.slice(0, i).toLowerCase();
  const permlink = s.slice(i + 1);
  return OWNER_RE.test(author) && PERMLINK_RE.test(permlink) ? keyOf(author, permlink) : null;
}

/** key -> counts per option, for every key given. */
async function tallies(keys, sizes) {
  const rows = keys.length
    ? await votes().aggregate([
      { $match: { poll: { $in: keys } } },
      { $group: { _id: { poll: '$poll', choice: '$choice' }, n: { $sum: 1 } } },
    ]).toArray()
    : [];
  const out = new Map(keys.map((k) => [k, new Array(sizes.get(k) || 0).fill(0)]));
  for (const r of rows) {
    const arr = out.get(r._id.poll);
    if (arr && r._id.choice >= 0 && r._id.choice < arr.length) arr[r._id.choice] = r.n;
  }
  return out;
}

const resultOf = (poll, counts, mine) => ({
  counts,
  total: counts.reduce((a, b) => a + b, 0),
  closed: isClosed(poll),
  ends_at: poll.ends_at || null,
  ...(mine !== undefined ? { mine } : {}),
});

router.post('/polls/vote', express.json({ limit: '2kb' }), async (req, res) => {
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  const key = parseKey(`${b.author}/${b.permlink}`);
  const choice = Number.isInteger(b.choice) ? b.choice : parseInt(b.choice, 10);
  if (!key || !Number.isInteger(choice)) return res.status(400).json({ success: false, error: 'invalid poll or choice' });
  const snap = await getDb().collection(SNAPS).findOne({ _id: key }, { projection: { poll: 1 } });
  const poll = snap && snap.poll;
  if (!poll || !Array.isArray(poll.options)) return res.status(404).json({ success: false, error: 'not a poll' });
  if (choice < 0 || choice >= poll.options.length) return res.status(400).json({ success: false, error: 'invalid choice' });
  if (isClosed(poll)) return res.status(409).json({ success: false, error: 'poll closed' });
  if (tooMany(user)) return res.status(429).json({ success: false, error: 'too many votes' });

  await ensureIndexes();
  const now = new Date();
  await votes().updateOne(
    { _id: `${key}|${user}` },
    { $set: { poll: key, voter: user, choice, at: now }, $setOnInsert: { first_at: now } },
    { upsert: true },
  );
  const counts = (await tallies([key], new Map([[key, poll.options.length]]))).get(key);
  res.json({ success: true, result: resultOf(poll, counts, choice) });
});

router.post('/polls/results', express.json({ limit: '8kb' }), async (req, res) => {
  const b = req.body || {};
  const keys = [...new Set((Array.isArray(b.keys) ? b.keys : []).map(parseKey).filter(Boolean))].slice(0, MAX_KEYS);
  // Signed in: the caller's own choices too. A bad or missing vouch is not an
  // error here, the counts are public.
  const user = b.signature ? await proveProgressUser(b) : null;
  res.set('Cache-Control', 'no-store');
  if (!keys.length) return res.json({ success: true, results: {} });
  const snaps = await getDb().collection(SNAPS).find({ _id: { $in: keys }, poll: { $ne: null } }, { projection: { poll: 1 } }).toArray();
  const polls = new Map(snaps.filter((s) => s.poll && Array.isArray(s.poll.options)).map((s) => [s._id, s.poll]));
  const found = [...polls.keys()];
  const counts = await tallies(found, new Map(found.map((k) => [k, polls.get(k).options.length])));
  const mine = new Map();
  if (user && found.length) {
    const rows = await votes().find({ _id: { $in: found.map((k) => `${k}|${user}`) } }, { projection: { poll: 1, choice: 1 } }).toArray();
    for (const r of rows) mine.set(r.poll, r.choice);
  }
  const results = {};
  for (const k of found) results[k] = resultOf(polls.get(k), counts.get(k), user ? (mine.has(k) ? mine.get(k) : null) : undefined);
  res.json({ success: true, results });
});

router.get('/polls/creator/:owner', async (req, res) => {
  const owner = String(req.params.owner || '').trim().toLowerCase().replace(/^@/, '');
  if (!OWNER_RE.test(owner)) return res.status(400).json({ success: false, error: 'invalid owner' });
  const snaps = await getDb().collection(SNAPS)
    .find({ owner, poll: { $ne: null } }, { projection: { permlink: 1, body: 1, poll: 1, created: 1 } })
    .sort({ created: -1 }).limit(20).toArray();
  const list = snaps.filter((s) => s.poll && Array.isArray(s.poll.options));
  const counts = await tallies(list.map((s) => s._id), new Map(list.map((s) => [s._id, s.poll.options.length])));
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    success: true,
    polls: list.map((s) => ({
      key: s._id,
      permlink: s.permlink,
      question: String(s.body || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      options: s.poll.options,
      created: s.created,
      ...resultOf(s.poll, counts.get(s._id)),
    })),
  });
});

module.exports = router;
module.exports.ensureIndexes = ensureIndexes;
