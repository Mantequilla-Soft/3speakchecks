/**
 * Boost wall: GET /boosts/:author/:permlink
 *
 * The tips sent for ONE post, newest first, with the sender's message: boosts
 * (sent from its Boost button, memo tagged `#boost`), plain tips from the tip
 * window, and the day totals of sats streamed while people listened. Rows come
 * from the `supports` collection (routes/supports.js), so the wall shows only what
 * was verified on chain:
 *
 *   - HIVE / HBD: a real transfer from the sender to the creator, found in Hive
 *     account history (POST /supports/record after the send, or the scan below).
 *   - Lightning paid to <creator>@v4v.app: v4v.app's credit on Hive carries the
 *     comment, so services/lightningSupports.js sees it. The sender is known only
 *     when they paid from Hive through v4v.app; anyone else shows as a Lightning
 *     supporter. Streamed sats arrive the same way, tagged `#stream`.
 *   - NOT visible: Lightning paid to a creator's OWN Lightning address (it never
 *     touches Hive), keysend payments without a comment, and encrypted memos.
 *
 * The scan: a boost sent from another wallet or app (or one whose report was
 * lost when the tab closed) is still a transfer to the creator whose memo links
 * this post and says `#boost`. So, at most every BOOST_SCAN_MIN per creator, the
 * route reads the creator's incoming transfers of the last BOOST_SCAN_DAYS and
 * records those it has not seen, exactly like the record route would.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../utils/db');
const { transfersSince } = require('../utils/hive');
const { isHiddenSync } = require('../utils/hiddenCreators');
const { boostKind, wallMessage, linkedPosts } = require('../utils/boosts');
const supports = require('./supports');

const router = express.Router();

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;
const MAX_LIMIT = 50;
const BOOST_SCAN_MIN = Math.max(parseInt(process.env.BOOST_SCAN_MIN, 10) || 10, 1);
const BOOST_SCAN_DAYS = Math.max(parseInt(process.env.BOOST_SCAN_DAYS, 10) || 3, 1);
const VISIBLE = { hidden: { $ne: true } };

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: false,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

/** Every permlink a tip for this content can be filed under (asset, Hive post). */
function permlinksOf(content, permlink) {
  const d = content?.doc || {};
  return [...new Set([permlink, d.permlink, d.hive_permlink, d.post_permlink].filter(Boolean))];
}

const lastScan = new Map(); // author → ms
async function scanAuthor(db, author, permlinks, content, now = Date.now()) {
  if (now - (lastScan.get(author) || 0) < BOOST_SCAN_MIN * 60 * 1000) return 0;
  lastScan.set(author, now);
  if (lastScan.size > 5000) lastScan.delete(lastScan.keys().next().value);

  const history = await transfersSince(author, now - BOOST_SCAN_DAYS * 86400000, { maxPages: 2, pageSize: 1000 });
  const wanted = new Set(permlinks);
  const found = [];
  for (const [, e] of history) {
    const op = e && e.op;
    if (!op || op[0] !== 'transfer' || !e.trx_id) continue;
    const t = op[1];
    if (t.to !== author || t.from === author || boostKind(t.memo) !== 'boost') continue;
    const link = linkedPosts(t.memo).find(([a, p]) => a === author && wanted.has(p));
    if (!link) continue;
    const a = supports.parseAsset(t.amount);
    if (!['HIVE', 'HBD'].includes(a.symbol) || !(a.amount > 0)) continue;
    found.push({ e, t, a, permlink: link[1] });
  }
  if (!found.length) return 0;

  const coll = db.collection(supports.COLLECTION);
  await supports.ensureIndexes(coll);
  const known = new Set((await coll.find({ trx_id: { $in: found.map((f) => f.e.trx_id) } }, { projection: { trx_id: 1 } }).toArray())
    .map((r) => r.trx_id));
  const fresh = found.filter((f) => !known.has(f.e.trx_id));
  if (!fresh.length) return 0;
  const hbdPerHive = fresh.some((f) => f.a.symbol === 'HIVE') ? await supports.getHbdPerHive() : 1;

  let added = 0;
  for (const { e, t, a, permlink } of fresh) {
    if (a.symbol === 'HIVE' && !hbdPerHive) continue;
    try {
      await coll.insertOne({
        trx_id: e.trx_id,
        tipper: String(t.from).toLowerCase(),
        author,
        permlink,
        kind: content.kind,
        hbd_value: supports.roundHbd(a.amount * (a.symbol === 'HIVE' ? hbdPerHive : 1)),
        amount: a.amount,
        currency: a.symbol,
        hbd_per_hive: a.symbol === 'HIVE' ? hbdPerHive : null,
        memo: supports.cleanMemo(t.memo),
        boost: true,
        found_by: 'scan',
        block: e.block,
        tippedAt: new Date(`${e.timestamp}Z`),
        createdAt: new Date(),
      });
      added += 1;
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
    }
  }
  return added;
}

const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

// GET /boosts/:author/:permlink?limit= → { total_hbd, total_sats, count, boosts,
//   items: [{ tipper, amount, currency, via, boost, stream, message, tippedAt }] }
router.get('/boosts/:author/:permlink', limiter, async (req, res) => {
  const author = String(req.params.author || '').trim().toLowerCase().replace(/^@/, '');
  const permlink = String(req.params.permlink || '').trim().toLowerCase();
  if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) return res.status(400).json({ success: false, error: 'Invalid post' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), MAX_LIMIT);
  const empty = { success: true, total_hbd: 0, total_sats: 0, count: 0, boosts: 0, items: [] };
  if (isHiddenSync(author)) return res.json(empty);
  try {
    const db = getDb();
    const content = await supports.findContent(db, author, permlink);
    if (!content) return res.json(empty);
    const permlinks = permlinksOf(content, permlink);
    await scanAuthor(db, author, permlinks, content).catch((err) => {
      console.error('[boosts] scan failed:', err && err.message);
    });

    const coll = db.collection(supports.COLLECTION);
    const filter = { author, permlink: { $in: permlinks }, ...VISIBLE };
    const [rows, sums] = await Promise.all([
      coll.find(filter, { projection: { _id: 0, tipper: 1, amount: 1, currency: 1, via: 1, memo: 1, boost: 1, stream: 1, hbd_value: 1, tippedAt: 1 } })
        .sort({ tippedAt: -1 }).limit(limit).toArray(),
      coll.aggregate([{ $match: filter }, {
        $group: {
          _id: null,
          hbd: { $sum: '$hbd_value' },
          sats: { $sum: { $cond: [{ $eq: ['$currency', 'SATS'] }, '$amount', 0] } },
          count: { $sum: 1 },
          boosts: { $sum: { $cond: [{ $eq: ['$boost', true] }, 1, 0] } },
        },
      }]).toArray(),
    ]);
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      success: true,
      total_hbd: round(sums[0]?.hbd),
      total_sats: sums[0]?.sats || 0,
      count: sums[0]?.count || 0,
      boosts: sums[0]?.boosts || 0,
      items: rows.map((r) => ({
        tipper: r.tipper || null,
        amount: r.amount,
        currency: r.currency,
        hbd_value: r.hbd_value,
        via: r.via || 'hive',
        boost: r.boost === true || boostKind(r.memo) === 'boost',
        stream: r.stream === true,
        message: wallMessage(r.memo),
        tippedAt: r.tippedAt,
      })),
    });
  } catch (err) {
    console.error('[boosts] wall failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
module.exports._test = { scanAuthor, permlinksOf, lastScan };
