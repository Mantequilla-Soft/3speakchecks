/**
 * Comment inbox: the comments people left FOR a creator (on their posts, or as a
 * reply to one of their comments under their posts), newest first, with what the
 * inbox filters on.
 *
 *   POST /creator-inbox       { user, signature, timestamp }
 *   POST /creator-inbox/done  { user, signature, timestamp, author, permlink, done? }
 *
 * Both take the session vouch (utils/progressVouch.js): the list itself is public
 * on Hive, but what a creator marked done is theirs.
 *
 * Source: HafSQL's `comments` table (it keeps root_author, so one query finds every
 * comment under a creator's posts), the last COMMENT_INBOX_DAYS days, at most
 * MAX_ITEMS. Each item carries:
 *   answered   the creator has replied to this comment (any reply of theirs to it)
 *   question   the text asks something (a '?' outside links and code)
 *   firstTime  it is this person's first comment under any of the creator's posts
 *              (as far as HafSQL's history goes, which is all of Hive)
 *   supporter  this person upvoted the creator's posts in the last 365 days, or
 *              tipped them on 3Speak (the `supports` collection, Hive and Lightning
 *              tips with a known tipper)
 *   done       the creator marked it done (`comment_inbox_done`)
 *
 * Not in it: comments between other people further down a thread (they are not
 * addressed to the creator), deleted comments, off-chain comments of warm-up
 * users, the service accounts that reply to everything (NOT_PEOPLE), and the
 * accounts on the global comment mutelist (utils/commentMutes.js).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { getDb } = require('../utils/db');
const hafsql = require('../utils/hafsql');
const { clientIp } = require('../utils/clientIp');
const { proveProgressUser } = require('../utils/progressVouch');
const { getMutedSet } = require('../utils/commentMutes');
const { COMMENT_INBOX_DONE_COLLECTION, COMMENT_INBOX_DAYS, ENABLE_MONGO_WRITES } = require('../utils/config');

const router = express.Router();
const MAX_ITEMS = 300;
const BODY_CHARS = 2000;
const BLOCKS_PER_DAY = 28800;
const CACHE_MS = 2 * 60 * 1000;
const DONE_TTL_DAYS = 365;
const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9][a-z0-9._-]{0,254}$/i;
// Bots and service accounts that reply to everything; never a conversation.
const NOT_PEOPLE = ['hivebuzz', 'pizzabot', 'lolzbot', 'hiq.smartbot', 'beerlover', 'peak.snaps',
  'threespeak', 'spk.beneficiary', 'hive.helps', 'tipu', 'wine.bot', 'commentrewarder', 'ecency',
  'hivesuite.app', 'curation-cartel', 'steemitboard', 'discovery-it'];

const doneCol = () => getDb().collection(COMMENT_INBOX_DONE_COLLECTION);
let indexesEnsured = false;
async function ensureIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await doneCol().createIndex({ user: 1 });
    await doneCol().createIndex({ at: 1 }, { expireAfterSeconds: DONE_TTL_DAYS * 86400 });
  } catch (err) {
    indexesEnsured = false;
    console.error('[commentInbox] index setup failed:', err && err.message);
  }
}

const limiter = (max) => rateLimit({
  windowMs: 60 * 1000, max, standardHeaders: false, legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req) || ''), validate: { xForwardedForHeader: false, ip: false },
  message: { success: false, error: 'Too many requests' },
});

/** Does the text ask something? A '?' in a link or in code does not count. */
function isQuestion(body) {
  const text = String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  return /[?？؟]/.test(text);
}

const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

async function loadInbox(user) {
  const since = new Date(Date.now() - COMMENT_INBOX_DAYS * 24 * 3600 * 1000);
  // The service accounts above plus the global comment mutelist (utils/commentMutes.js),
  // left out in the query so a busy bot cannot push real comments past the limit.
  const muted = await getMutedSet();
  const skip = [...new Set([...NOT_PEOPLE, ...muted])];
  const comments = await hafsql.query(
    `select author, permlink, parent_permlink, root_permlink, body, created from hafsql.comments
      where root_author = $1 and parent_author = $1 and author <> $1 and deleted = false and created >= $2
        and not (author = any($4))
      order by created desc limit $3`,
    [user, since, MAX_ITEMS, skip],
  );
  const items = comments.filter((c) => !skip.includes(c.author)).slice(0, MAX_ITEMS);
  if (!items.length) return [];
  const authors = [...new Set(items.map((c) => c.author))];
  const roots = [...new Set(items.map((c) => c.root_permlink))];

  const [{ head }] = await hafsql.query('select block_num as head from hafsql.follows order by block_num desc limit 1');
  const [replies, firsts, voters, rootRows, tips] = await Promise.all([
    hafsql.query(
      'select parent_author, parent_permlink from hafsql.comments where author = $1 and parent_author = any($2) and created >= $3',
      [user, authors, since],
    ),
    hafsql.query(
      'select author, min(created) as first from hafsql.comments where root_author = $1 and author = any($2) group by author',
      [user, authors],
    ),
    hafsql.query(
      'select distinct voter from hafsql.operation_vote_view where author = $1 and voter = any($2) and block_num >= $3 and weight > 0',
      [user, authors, Number(head) - 365 * BLOCKS_PER_DAY],
    ),
    hafsql.query('select permlink, title from hafsql.comments where author = $1 and permlink = any($2)', [user, roots]),
    getDb().collection('supports').distinct('tipper', { author: user, tipper: { $in: authors } }),
  ]);
  const answered = new Set(replies.map((r) => `${r.parent_author}/${r.parent_permlink}`));
  const firstAt = new Map(firsts.map((f) => [f.author, iso(f.first)]));
  const supporters = new Set([...voters.map((v) => v.voter), ...tips]);
  const titles = new Map(rootRows.map((r) => [r.permlink, r.title || '']));

  return items.map((c) => {
    const created = iso(c.created);
    return {
      author: c.author,
      permlink: c.permlink,
      parentPermlink: c.parent_permlink,
      rootPermlink: c.root_permlink,
      rootTitle: titles.get(c.root_permlink) || '',
      onPost: c.parent_permlink === c.root_permlink,
      body: String(c.body || '').slice(0, BODY_CHARS),
      created,
      answered: answered.has(`${c.author}/${c.permlink}`),
      question: isQuestion(c.body),
      firstTime: firstAt.get(c.author) === created,
      supporter: supporters.has(c.author),
    };
  });
}

const cache = new Map(); // user -> { at, promise }
function inboxFor(user) {
  let hit = cache.get(user);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    hit = { at: Date.now(), promise: loadInbox(user) };
    cache.set(user, hit);
    hit.promise.catch(() => cache.delete(user));
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return hit.promise;
}

router.post('/creator-inbox', limiter(20), async (req, res) => {
  const user = await proveProgressUser(req.body || {});
  if (!user || !HIVE_RE.test(user)) return res.status(401).json({ success: false, error: 'Invalid signature' });
  res.set('Cache-Control', 'no-store');
  try {
    const [items, done] = await Promise.all([
      inboxFor(user),
      doneCol().find({ user }, { projection: { _id: 0, author: 1, permlink: 1 } }).toArray(),
    ]);
    const doneSet = new Set(done.map((d) => `${d.author}/${d.permlink}`));
    res.json({
      success: true,
      days: COMMENT_INBOX_DAYS,
      items: items.map((it) => ({ ...it, done: doneSet.has(`${it.author}/${it.permlink}`) })),
    });
  } catch (err) {
    console.error('[commentInbox] list failed:', err && err.message);
    res.status(503).json({ success: false, error: 'comments unavailable' });
  }
});

router.post('/creator-inbox/done', limiter(120), async (req, res) => {
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user || !HIVE_RE.test(user)) return res.status(401).json({ success: false, error: 'Invalid signature' });
  const author = String(b.author || '').toLowerCase();
  const permlink = String(b.permlink || '');
  if (!HIVE_RE.test(author) || !PERMLINK_RE.test(permlink)) return res.status(400).json({ success: false, error: 'bad comment' });
  if (!ENABLE_MONGO_WRITES) return res.status(503).json({ success: false, error: 'Writes disabled' });
  try {
    await ensureIndexes();
    const _id = `${user}|${author}/${permlink}`;
    if (b.done === false) await doneCol().deleteOne({ _id });
    else await doneCol().updateOne({ _id }, { $set: { user, author, permlink, at: new Date() } }, { upsert: true });
    res.json({ success: true, done: b.done !== false });
  } catch (err) {
    console.error('[commentInbox] done failed:', err && err.message);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

module.exports = router;
module.exports._test = { isQuestion, loadInbox, NOT_PEOPLE, reset: () => { cache.clear(); indexesEnsured = false; } };
