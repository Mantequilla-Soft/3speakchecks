/**
 * Supporters: tips (any amount) that a viewer sent a creator from a video's
 * (or audio post's) tip button on 3Speak.
 *
 * Client POST after broadcast, verified against the tipper's own account history,
 * rather than a watcher. A watcher has nothing to watch: tips go straight to each
 * creator (there is no single receiving account like the ad payment account), and
 * the video a tip was sent from is not on chain at all, only the client knows it.
 *
 * So the client says "I just tipped @author on this video", and we only write a
 * row for a REAL transfer we find on chain: from the tipper, to the video's owner,
 * of exactly that amount, in the last 24 hours, whose trx_id nobody counted yet.
 * The trx_id, amount and timestamp all come from the chain, never from the body.
 * What the client can still choose is which of the author's videos a real tip is
 * credited to, which is harmless.
 *
 * HIVE tips are valued at the on-chain median feed price (same as promote.js and
 * adPaymentClaim.js) and the rate used is stored on the row. `hbd_value` is always
 * HBD, whatever was sent.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../utils/db');
const { transfersSince, hiveRpcBatch } = require('../utils/hive');
const { isHiddenSync, hiddenListSync } = require('../utils/hiddenCreators');
const { verifyHiveAuthority } = require('../utils/hiveAuth');
const { SIGNATURE_TIMESTAMP_TOLERANCE_MS, AD_SIGNING_DELEGATES } = require('../utils/config');

const router = express.Router();

const COLLECTION = 'supports';
// HBD values keep 6 decimals: a 0.001 HIVE tip is worth ~0.00005 HBD, which
// 3-decimal rounding would turn into a zero.
const roundHbd = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
// How far back a tip is looked for: 24h, so a report the browser could only
// resume the next day (tab closed right after tipping) still lands. Replays are
// blocked by the unique trx_id, not by this window; it only bounds how old a
// transfer can be to be credited to a video at all.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
// The tipper's transfer history is paged back until it passes the window. A
// page is 1000 transfer ops; 10 pages covers even a bot-like account's day,
// and anything busier than that just isn't found (the report stays pending).
const HISTORY_PAGES = 10;
const HISTORY_PAGE_SIZE = 1000;
const MAX_LIMIT = 50;

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');

let indexesEnsured = false;
async function ensureIndexes(coll) {
  if (indexesEnsured) return;
  try {
    await coll.createIndex({ trx_id: 1 }, { unique: true, name: 'supports_trx_unique' });
    await coll.createIndex({ author: 1, tippedAt: -1 }, { name: 'supports_author_tipped' });
    await coll.createIndex({ tipper: 1, tippedAt: -1 }, { name: 'supports_tipper_tipped' });
    await coll.createIndex({ author: 1, permlink: 1 }, { name: 'supports_author_permlink' });
    await coll.createIndex({ tipper: 1, author: 1 }, { name: 'supports_tipper_author' });
  } catch (err) {
    console.error('[supports] index setup failed:', err && err.message);
  }
  indexesEnsured = true;
}

// HBD per HIVE from the on-chain median feed. Never trust a client-supplied rate.
async function getHbdPerHive() {
  const [res] = await hiveRpcBatch([{
    jsonrpc: '2.0', method: 'condenser_api.get_current_median_history_price', params: [], id: 1,
  }]);
  const base = parseFloat(res?.result?.base);
  const quote = parseFloat(res?.result?.quote);
  if (!base || !quote) return 0;
  return base / quote;
}

// The tipper's message, from the MATCHED on-chain transfer, never the request.
// An encrypted memo ("#...") is unreadable ciphertext, so it isn't kept. Control
// characters go (newlines stay); capped well under Hive's 2048-byte limit since
// it is shown as a short note under the tip.
const MAX_MEMO_CHARS = 1000;
function cleanMemo(raw) {
  const memo = String(raw || '').trim();
  if (!memo || memo.startsWith('#')) return null;
  // eslint-disable-next-line no-control-regex
  return memo.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').slice(0, MAX_MEMO_CHARS) || null;
}

function parseAsset(s) {
  const [amount, symbol] = String(s || '').trim().split(' ');
  return { amount: parseFloat(amount) || 0, symbol: (symbol || '').toUpperCase() };
}

/**
 * The tipped content, owned by `author`: a video (legacy or embed, by asset or
 * Hive permlink) or an audio post. Null when the author owns nothing by that
 * permlink, so a tip can't be credited to someone else's video.
 */
async function findContent(db, author, permlink) {
  const video = await db.collection('embed-video').findOne(
    { $or: [{ owner: author, permlink }, { hive_author: author, hive_permlink: permlink }] },
    { projection: { owner: 1, permlink: 1, hive_permlink: 1, hive_title: 1, embed_title: 1, thumbnail_url: 1, short: 1 } },
  );
  if (video) return { kind: video.short === true ? 'short' : 'video', doc: video };
  const legacy = await db.collection('videos').findOne(
    { owner: author, permlink },
    { projection: { owner: 1, permlink: 1, title: 1, thumbnail: 1 } },
  );
  if (legacy) return { kind: 'video', doc: legacy };
  const audio = await db.collection('embed-audio').findOne(
    { $and: [{ $or: [{ owner: author }, { post_author: author }] }, { $or: [{ post_permlink: permlink }, { permlink }] }] },
    { projection: { owner: 1, permlink: 1, post_permlink: 1 } },
  );
  if (audio) return { kind: 'audio', doc: audio };
  return null;
}

// One per tipper per 10 minutes is plenty for honest retries; each call reads
// account history from a Hive node.
const recordLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `t:${norm(req.body && req.body.tipper)}`,
  standardHeaders: false,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

// POST /supports/record { tipper, author, permlink, amount, currency, memo? }
//   200 { recorded: true, support }      a matching transfer was found and stored
//   200 { recorded: false, reason }      below threshold / already counted
//   202 { pending: true }                not on chain yet, the client retries
router.post('/supports/record', express.json({ limit: '4kb' }), recordLimiter, async (req, res) => {
  try {
    const tipper = norm(req.body.tipper);
    const author = norm(req.body.author);
    const permlink = String(req.body.permlink || '').trim();
    const currency = String(req.body.currency || '').trim().toUpperCase();
    const amount = Math.round((parseFloat(req.body.amount) || 0) * 1000) / 1000;
    const memo = typeof req.body.memo === 'string' ? req.body.memo.trim() : '';

    if (!ACCOUNT_RE.test(tipper) || !ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) {
      return res.status(400).json({ success: false, error: 'tipper, author and permlink are required' });
    }
    if (tipper === author) {
      return res.status(400).json({ success: false, error: 'A creator cannot support themselves' });
    }
    if (!['HBD', 'HIVE'].includes(currency) || !(amount > 0)) {
      return res.status(400).json({ success: false, error: 'amount and currency (HBD or HIVE) are required' });
    }

    const db = getDb();
    const content = await findContent(db, author, permlink);
    if (!content) return res.status(404).json({ success: false, error: 'Unknown video for this author' });

    const coll = db.collection(COLLECTION);
    await ensureIndexes(coll);

    const now = Date.now();
    const history = await transfersSince(tipper, now - LOOKBACK_MS, { maxPages: HISTORY_PAGES, pageSize: HISTORY_PAGE_SIZE });
    // Encrypted memos ("#...") read differently on chain, so only a plain memo
    // has to match; from/to/amount/currency always do.
    const checkMemo = memo && !memo.startsWith('#');
    const candidates = history
      .map(([, entry]) => entry)
      .filter((e) => {
        const op = e && e.op;
        if (!op || op[0] !== 'transfer' || !e.trx_id) return false;
        const t = op[1];
        if (t.from !== tipper || t.to !== author) return false;
        const a = parseAsset(t.amount);
        if (a.symbol !== currency || Math.abs(a.amount - amount) > 0.0005) return false;
        if (checkMemo && String(t.memo || '').trim() !== memo) return false;
        const ts = Date.parse(`${e.timestamp}Z`);
        return Number.isFinite(ts) && ts >= now - LOOKBACK_MS;
      })
      .sort((a, b) => Date.parse(`${b.timestamp}Z`) - Date.parse(`${a.timestamp}Z`));

    if (!candidates.length) return res.status(202).json({ success: true, pending: true });

    // Newest transfer not already counted, so two identical tips in a row each
    // get their own row.
    const counted = new Set((await coll.find(
      { trx_id: { $in: candidates.map((c) => c.trx_id) } },
      { projection: { trx_id: 1 } },
    ).toArray()).map((r) => r.trx_id));
    const match = candidates.find((c) => !counted.has(c.trx_id));
    if (!match) return res.json({ success: true, recorded: false, reason: 'already_recorded' });

    const hbdPerHive = currency === 'HIVE' ? await getHbdPerHive() : 1;
    if (!hbdPerHive) return res.status(503).json({ success: false, error: 'HIVE price unavailable' });
    const hbdValue = roundHbd(amount * hbdPerHive);

    const support = {
      trx_id: match.trx_id,
      tipper,
      author,
      permlink,
      kind: content.kind,
      hbd_value: hbdValue,
      amount,
      currency,
      hbd_per_hive: currency === 'HIVE' ? hbdPerHive : null,
      memo: cleanMemo(match.op[1].memo),
      block: match.block,
      tippedAt: new Date(`${match.timestamp}Z`),
      createdAt: new Date(),
    };
    try {
      await coll.insertOne(support);
    } catch (err) {
      // A parallel retry of the same tip won the race.
      if (err && err.code === 11000) return res.json({ success: true, recorded: false, reason: 'already_recorded' });
      throw err;
    }
    res.json({ success: true, recorded: true, support });
  } catch (e) {
    console.error('[supports] record failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Title + thumbnail for each tipped item, same fallbacks the feeds use.
async function attachContent(db, rows) {
  const keys = rows.map((r) => ({ author: r.author, permlink: r.permlink }));
  if (!keys.length) return rows;
  const permlinks = [...new Set(keys.map((k) => k.permlink))];
  const authors = [...new Set(keys.map((k) => k.author))];
  const [embeds, legacy, audios] = await Promise.all([
    db.collection('embed-video').find(
      { $or: [{ owner: { $in: authors }, permlink: { $in: permlinks } }, { hive_author: { $in: authors }, hive_permlink: { $in: permlinks } }] },
      { projection: { owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1, hive_title: 1, embed_title: 1, originalFilename: 1, thumbnail_url: 1, short: 1 } },
    ).toArray(),
    db.collection('videos').find(
      { owner: { $in: authors }, permlink: { $in: permlinks } },
      { projection: { owner: 1, permlink: 1, title: 1, thumbnail: 1, thumbUrl: 1 } },
    ).toArray(),
    db.collection('embed-audio').find(
      { post_permlink: { $in: permlinks } },
      { projection: { owner: 1, post_author: 1, post_permlink: 1, title: 1 } },
    ).toArray(),
  ]);
  const byKey = new Map();
  for (const a of audios) {
    byKey.set(`${a.post_author || a.owner}/${a.post_permlink}`, { title: a.title || '', thumbnail: '', short: false });
  }
  for (const v of legacy) {
    // Raw (often ipfs://), the frontend's fixVideoThumbnail() resolves it.
    byKey.set(`${v.owner}/${v.permlink}`, { title: v.title || '', thumbnail: v.thumbnail || v.thumbUrl || '', short: false });
  }
  for (const v of embeds) {
    const short = v.short === true;
    const info = {
      title: v.hive_title || v.embed_title || (short ? (v.originalFilename || '') : ''),
      thumbnail: v.thumbnail_url || `https://img.3speak.tv/${v.permlink}/thumbnail.png`,
      short,
      // /shorts links by the asset id, not the Hive permlink.
      asset_permlink: v.permlink,
    };
    byKey.set(`${v.owner}/${v.permlink}`, info);
    if (v.hive_permlink) byKey.set(`${v.hive_author || v.owner}/${v.hive_permlink}`, info);
  }
  return rows.map((r) => ({ ...r, video: byKey.get(`${r.author}/${r.permlink}`) || null }));
}

const PUBLIC_FIELDS = { _id: 0, trx_id: 1, tipper: 1, author: 1, permlink: 1, kind: 1, hbd_value: 1, amount: 1, currency: 1, tippedAt: 1, createdAt: 1, memo: 1, hidden: 1 };

// A tip its creator hid (POST /supports/hide) counts nowhere public: not in
// lists, chips, totals or counts, on either side.
const VISIBLE = { hidden: { $ne: true } };

// GET /supports/by/:tipper/supported?limit= — the creators THIS account has
// supported, biggest total first (the outgoing chips on a profile). Declared
// before the /supports/:author routes; it has more segments than either, so
// neither could shadow it anyway.
router.get('/supports/by/:tipper/supported', async (req, res) => {
  try {
    const tipper = norm(req.params.tipper);
    if (!ACCOUNT_RE.test(tipper)) return res.status(400).json({ success: false, error: 'Invalid account' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), MAX_LIMIT);
    if (isHiddenSync(tipper)) return res.json({ success: true, total: 0, supported: [] });

    const coll = getDb().collection(COLLECTION);
    await ensureIndexes(coll);
    const [result] = await coll.aggregate([
      { $match: { tipper, ...VISIBLE } },
      { $group: { _id: '$author', hbd_total: { $sum: '$hbd_value' }, count: { $sum: 1 }, last: { $max: '$tippedAt' } } },
      { $sort: { hbd_total: -1, last: -1 } },
      { $facet: { total: [{ $count: 'n' }], top: [{ $limit: limit }] } },
    ]).toArray();
    // A hidden creator's chip would link to a page that refuses to show them.
    const top = (result?.top || []).filter((s) => !isHiddenSync(s._id));
    res.json({
      success: true,
      total: result?.total?.[0]?.n || 0,
      supported: top.map((s) => ({
        author: s._id,
        hbd_total: roundHbd(s.hbd_total),
        count: s.count,
        last: s.last,
      })),
    });
  } catch (e) {
    console.error('[supports] supported failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// One page of tips matching `filter`, newest first, with the video attached, plus
// the count and the HBD sum over ALL matching rows (the tab header's total).
// `includeHidden`: list the hidden rows too (flagged `hidden: true`), for the
// creator's own Received tab. The total stays the visible one either way.
async function listPage(req, res, filter, { includeHidden = false } = {}) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);
  const db = getDb();
  const coll = db.collection(COLLECTION);
  const visible = { ...filter, ...VISIBLE };
  const listed = includeHidden ? filter : visible;
  const [total, sum, rows] = await Promise.all([
    coll.countDocuments(listed),
    coll.aggregate([{ $match: visible }, { $group: { _id: null, hbd: { $sum: '$hbd_value' } } }]).toArray(),
    coll.find(listed, { projection: PUBLIC_FIELDS })
      .sort({ tippedAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
  ]);
  res.json({
    success: true,
    total,
    total_hbd: roundHbd(sum[0]?.hbd),
    page,
    limit,
    items: await attachContent(db, rows),
  });
}

// GET /supports/by/:tipper?page=&limit= — every tip THIS account sent, newest first
// (the profile's "Given" list). Declared before /supports/:author/supporters,
// which would otherwise read a tipper literally named "supporters" as
// author "by".
router.get('/supports/by/:tipper', async (req, res) => {
  try {
    const tipper = norm(req.params.tipper);
    if (!ACCOUNT_RE.test(tipper)) return res.status(400).json({ success: false, error: 'Invalid account' });
    if (isHiddenSync(tipper)) return res.json({ success: true, total: 0, total_hbd: 0, page: 1, limit: 0, items: [] });
    // Tips to hidden creators stay out: their videos aren't shown anywhere.
    const hidden = hiddenListSync();
    await listPage(req, res, hidden.length ? { tipper, author: { $nin: hidden } } : { tipper });
  } catch (e) {
    console.error('[supports] given list failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /supports/:author?page=&limit= — every recorded tip to this creator, newest first.
router.get('/supports/:author', async (req, res) => {
  try {
    const author = norm(req.params.author);
    if (!ACCOUNT_RE.test(author)) return res.status(400).json({ success: false, error: 'Invalid author' });
    if (isHiddenSync(author)) return res.json({ success: true, total: 0, total_hbd: 0, page: 1, limit: 0, items: [] });
    // Hidden rows are public data (the transfer is on chain anyway); only the
    // creator's own tab asks for them, to offer "Unhide".
    await listPage(req, res, { author }, { includeHidden: req.query.includeHidden === '1' });
  } catch (e) {
    console.error('[supports] list failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /supports/:author/supporters?limit= — distinct supporters, biggest total first,
// for the badge row on the profile.
router.get('/supports/:author/supporters', async (req, res) => {
  try {
    const author = norm(req.params.author);
    if (!ACCOUNT_RE.test(author)) return res.status(400).json({ success: false, error: 'Invalid author' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), MAX_LIMIT);
    if (isHiddenSync(author)) return res.json({ success: true, total: 0, supporters: [] });

    const [result] = await getDb().collection(COLLECTION).aggregate([
      { $match: { author, ...VISIBLE } },
      { $group: { _id: '$tipper', hbd_total: { $sum: '$hbd_value' }, count: { $sum: 1 }, last: { $max: '$tippedAt' } } },
      { $sort: { hbd_total: -1, last: -1 } },
      { $facet: { total: [{ $count: 'n' }], top: [{ $limit: limit }] } },
    ]).toArray();
    res.json({
      success: true,
      total: result?.total?.[0]?.n || 0,
      supporters: (result?.top || []).map((s) => ({
        tipper: s._id,
        hbd_total: roundHbd(s.hbd_total),
        count: s.count,
        last: s.last,
      })),
    });
  } catch (e) {
    console.error('[supports] supporters failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Hiding a tip ──────────────────────────────────────────────────────────────
// Only the creator who RECEIVED a tip can hide it from their profile (and
// unhide it). Same proof as comment pins (routes/commentPins.js): a signature
// over a message WE build, from the author's posting key or a posting-authority
// delegate we sign with (@threespeak). The action and the trx_id are in the
// message, so a signature for one tip/action can't be replayed for another.

// Must match hideMessage() in the frontend (src/lib/supportsHide.js) and the
// signer in the preview/prod API (server/index.cjs) exactly.
const hideMessage = (author, trxId, action, timestamp) =>
  ['3speak-supports', action, author, trxId, String(timestamp)].join('|');

const TRX_RE = /^[a-f0-9]{40}$/;

const recentHides = new Map();
function tooManyHides(author) {
  const now = Date.now();
  const list = (recentHides.get(author) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= 120) return true;
  list.push(now);
  recentHides.set(author, list);
  return false;
}

// POST /supports/hide — { author, trx_id, hidden: bool, signature, timestamp }
router.post('/supports/hide', express.json({ limit: '4kb' }), async (req, res) => {
  const b = req.body || {};
  const author = norm(b.author);
  const trxId = String(b.trx_id || '').toLowerCase();
  const action = b.hidden === true ? 'hide' : b.hidden === false ? 'unhide' : '';
  if (!ACCOUNT_RE.test(author) || !TRX_RE.test(trxId) || !action) {
    return res.status(400).json({ success: false, error: 'invalid author, trx_id or action' });
  }

  const signature = typeof b.signature === 'string' ? b.signature.slice(0, 200) : '';
  const timestamp = parseInt(b.timestamp, 10);
  if (!signature || !Number.isFinite(timestamp)) {
    return res.status(401).json({
      success: false,
      error: 'Signature required',
      expected_message: hideMessage(author, trxId, action, '<ms>'),
    });
  }
  if (Math.abs(Date.now() - timestamp) > SIGNATURE_TIMESTAMP_TOLERANCE_MS) {
    return res.status(401).json({ success: false, error: 'timestamp out of tolerance' });
  }

  let verdict = { ok: false };
  try {
    verdict = await verifyHiveAuthority({
      message: hideMessage(author, trxId, action, timestamp),
      signature,
      username: author,
      allowedDelegates: AD_SIGNING_DELEGATES,
    });
  } catch (err) {
    if (err && err.code === 'HIVE_ACCOUNT_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Hive account not found' });
    }
  }
  if (!verdict.ok) return res.status(401).json({ success: false, error: 'Invalid signature' });

  if (tooManyHides(author)) return res.status(429).json({ success: false, error: 'too many changes, try again later' });

  try {
    // `author` in the filter: a creator can only hide tips THEY received.
    const r = await getDb().collection(COLLECTION).updateOne(
      { trx_id: trxId, author },
      action === 'hide'
        ? { $set: { hidden: true, hiddenAt: new Date() } }
        : { $unset: { hidden: '', hiddenAt: '' } },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, error: 'Tip not found' });
    res.json({ success: true, trx_id: trxId, hidden: action === 'hide' });
  } catch (err) {
    console.error('[supports] hide failed:', author, trxId, err && err.message);
    res.status(502).json({ success: false, error: 'could not save' });
  }
});

module.exports = router;
module.exports._test = { hideMessage };
