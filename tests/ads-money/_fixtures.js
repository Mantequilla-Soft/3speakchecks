/**
 * Shared building blocks for the money-path tests in tests/ads-money.
 *
 * Everything here builds DATA or STUBS. Nothing here can send a transfer: the
 * broadcast clients below only record what they were asked to send, and the
 * signing key is a deterministic test key derived from a public seed.
 *
 * Periods: with the default config (3-day periods, boundaries at 07:00 UTC) the
 * period holding 2026-10-01T12:00Z runs 2026-10-01T07:00Z .. 2026-10-04T07:00Z and is
 * keyed '2026-10-01'. Tests use that one unless they need a chain of periods.
 */
const { ObjectId } = require('mongodb');
const dhive = require('@hiveio/dhive');

/** "Now" for every test in this folder unless a test says otherwise. */
const NOW = new Date('2026-11-01T12:00:00.000Z');
const DAY = 864e5;

/**
 * Pin Date (and only Date). Timers stay real so the MongoDB driver keeps working.
 * Undo with jest.useRealTimers().
 */
function pinClock(at = NOW) {
  jest.useFakeTimers({
    now: new Date(at),
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  return new Date(at);
}

/** Round to Hive's 0.001 precision, the way the payout code does. */
const r3 = (n) => Math.round(n * 1000) / 1000;

/** A moment safely inside a period. */
const midOf = (period) => new Date((period.start.getTime() + period.end.getTime()) / 2);

const PERIOD_AT = new Date('2026-10-01T12:00:00.000Z');

/** The collections the money path touches, by their configured names. */
function cols(db) {
  const cfg = require('../../utils/config');
  return {
    campaigns: db.collection(cfg.AD_CAMPAIGNS_COLLECTION),
    impressions: db.collection(cfg.AD_IMPRESSIONS_COLLECTION),
    payouts: db.collection(cfg.AD_PAYOUTS_COLLECTION),
    periods: db.collection(cfg.AD_PAYOUT_PERIODS_COLLECTION),
    payments: db.collection(cfg.AD_PAYMENTS_COLLECTION),
    watch: db.collection(cfg.AD_VIEWER_WATCH_COLLECTION),
    listens: db.collection(cfg.AD_LISTENER_LISTEN_COLLECTION),
    prefs: db.collection(cfg.AD_CREATOR_PREFS_COLLECTION),
    creators: db.collection(cfg.AD_REWARD_FLAG_COLLECTION),
    embedVideo: db.collection('embed-video'),
  };
}

/** A paid campaign whose flight covers exactly `period`. */
function campaign(period, over = {}) {
  return {
    _id: new ObjectId(),
    name: 'test flight',
    advertiserRef: 'adv-ref',
    hiveAccount: 'adv',
    status: 'complete',
    paidHbd: 100,
    priceHbd: 100,
    paidAssets: { HBD: 100 },
    startAt: period.start,
    endAt: period.end,
    createdAt: period.start,
    ...over,
  };
}

async function seedCampaign(db, period, over = {}) {
  const c = campaign(period, over);
  if (c.paidAssets === undefined) delete c.paidAssets;
  await cols(db).campaigns.insertOne(c);
  return c;
}

let sidSeq = 0;
/** `n` completed, unpaid impressions of campaign `c` on `owner`'s video. */
async function seedImpressions(db, c, n, { owner, permlink = 'video', at, period } = {}) {
  const when = at || midOf(period);
  const rows = Array.from({ length: n }, () => {
    sidSeq += 1;
    return {
      sid: `sid-${sidSeq}`, campaignId: c._id, owner, permlink,
      completed: true, completedAt: when, at: when, payoutId: null,
    };
  });
  if (rows.length) await cols(db).impressions.insertMany(rows);
  return rows;
}

let watchSeq = 0;
/** Banked, unpaid viewer watch rows: [[viewer, seconds], ...]. */
async function seedWatches(db, pairs, extra = {}) {
  const rows = pairs.map(([viewer, contentSeconds]) => {
    watchSeq += 1;
    return { viewer, owner: 'someone-else', permlink: `w${watchSeq}`, contentSeconds, watchedPct: 90, payoutId: null, ...extra };
  });
  if (rows.length) await cols(db).watch.insertMany(rows);
  return rows;
}

let listenSeq = 0;
/** Banked, unpaid listener rows: [[listener, kind, seconds], ...]. */
async function seedListens(db, triples) {
  const rows = triples.map(([listener, kind, seconds]) => {
    listenSeq += 1;
    return { listener, kind, id: `${kind}-${listenSeq}`, seconds, payoutId: null };
  });
  if (rows.length) await cols(db).listens.insertMany(rows);
  return rows;
}

/** Payout rows of a period, keyed by account. */
async function payoutsOf(db, periodKey) {
  const rows = await cols(db).payouts.find({ periodKey }).toArray();
  return Object.fromEntries(rows.map((r) => [r.account, r]));
}

/**
 * Everything settlePeriod reaches outside the database, stubbed: who referred whom
 * (Butter Auth) and which referrer names are real Hive accounts (the chain).
 *
 *   referrers: { advertiser: referrer }                       (advertiser referral)
 *   referrals: { earner: { referrer, source, referredAt } }  (earner bonus)
 *   real:      [names that exist on chain]  or  'throw' for an unreachable node
 */
function stubDeps({ referrers = {}, referrals = {}, real = [] } = {}) {
  const lookups = [];
  return {
    lookups,
    referrersFor: async (accounts) => new Map(accounts.filter((a) => referrers[a]).map((a) => [a, referrers[a]])),
    referralsFor: async (accounts) => new Map(accounts.filter((a) => referrals[a]).map((a) => [a, referrals[a]])),
    client: {
      database: {
        getAccounts: async (names) => {
          lookups.push(names);
          if (real === 'throw') throw new Error('node unreachable');
          return names.filter((n) => real.includes(n)).map((name) => ({ name }));
        },
      },
    },
  };
}

/**
 * A Hive "content" chain for the community lookup in settlePeriod, as an
 * implementation for a mocked utils/hive.hiveRpcBatch.
 *
 *   posts: { 'author/permlink': 'hive-123456' | 'general' | null }
 * A key absent from `posts` is a post that exists with no community. `null` is a
 * post that does not exist on chain.
 */
function contentChain(posts = {}) {
  return async (batch) => batch.map((req) => {
    const [author, permlink] = req.params;
    const key = `${author}/${permlink}`;
    if (key in posts && posts[key] === null) return { id: req.id, result: { author: '', permlink: '' } };
    return { id: req.id, result: { author, permlink, category: key in posts ? posts[key] : 'general' } };
  });
}

/**
 * A broadcast client that records every transfer instead of sending it.
 * `failOn(op)` decides whether a given transfer throws, like a node rejecting it.
 */
function recordingClient(failOn = () => false) {
  const sent = [];
  const attempts = [];
  return {
    sent,
    attempts,
    broadcast: {
      sendOperations: async (ops, key) => {
        attempts.push({ ops, key });
        const op = ops[0][1];
        if (failOn(op)) throw new Error('simulated node failure');
        sent.push(op);
        return { id: `trx-${sent.length}` };
      },
    },
  };
}

/** A deterministic, obviously-fake active key. It never signs anything real. */
const testActiveKey = () => dhive.PrivateKey.fromSeed('checker-tests:payout-source').toString();

/** A history entry exactly as condenser_api.get_account_history returns one. */
function transferEntry({ index = 1, trxId, from, to, amount, memo, timestamp = '2026-11-01T11:00:00' }) {
  return [index, { trx_id: trxId, timestamp, op: ['transfer', { from, to, amount, memo }] }];
}

module.exports = {
  NOW, DAY, PERIOD_AT, pinClock, r3, midOf, cols,
  campaign, seedCampaign, seedImpressions, seedWatches, seedListens, payoutsOf,
  stubDeps, contentChain, recordingClient, testActiveKey, transferEntry,
};
