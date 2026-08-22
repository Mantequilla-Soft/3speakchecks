/**
 * Pays creators (and the communities they post in) for ads their videos carried.
 *
 * WHY A PERIOD POOL, AND NOT PER CAMPAIGN
 * The obvious design — take a campaign's fee, divide by the impressions that
 * campaign delivered, pay those creators — is wrong, and wrong in a way creators
 * would notice immediately. Per-impression value would then depend on the campaign
 * that happened to be shown, not on the audience the creator brought:
 *
 *     50 HBD over 7 days delivering   100 plays → 0.2500 HBD per play
 *     50 HBD over 90 days delivering 2000 plays → 0.0125 HBD per play
 *
 * Two creators with identical delivery would be paid twenty times differently
 * because the rotation gave one of them the short expensive flight. So instead:
 * every campaign accrues revenue PRO RATA over its own flight, all accruals inside
 * a period are pooled, and that pool is divided by every impression in the period.
 * One rate for everyone, per period.
 *
 * It also fixes the other half of the problem — WHEN. Settling at flight end meant
 * a creator could wait up to 90 days for a share of a campaign that finished on
 * someone else's schedule. Periods close on a fixed cadence and pay everyone
 * together, whether or not any particular flight has ended.
 *
 * A period with no impressions does not lose the money: its pool carries into the
 * next period, because the advertiser paid for the time either way and the pool
 * belongs to the creator side regardless of when it gets distributed.
 *
 * DRY RUN unless AD_PAYOUT_ACTIVE_KEY is set — and note a Hive `transfer` needs the
 * ACTIVE authority, not the posting key everything else here uses. Without it the
 * plan is computed, stored and logged, and nothing moves. That is the correct
 * default for code that sends money.
 */
const { Client, PrivateKey } = require('@hiveio/dhive');
const { getDb } = require('../utils/db');
const {
  HIVE_RPC_ENDPOINTS, AD_CAMPAIGNS_COLLECTION, AD_IMPRESSIONS_COLLECTION,
  AD_PAYOUTS_COLLECTION, AD_PAYOUT_PERIODS_COLLECTION, AD_CREATOR_POOL_PCT,
  AD_DEFAULT_COMMUNITY_PCT, AD_CREATOR_PREFS_COLLECTION, AD_PAYMENT_ACCOUNT,
  AD_PAYOUTS_ENABLED, AD_PAYOUT_INTERVAL_H, AD_PAYOUT_MIN_HBD, AD_PAYOUT_PERIOD_DAYS,
} = require('../utils/config');
const { STATES } = require('../utils/adModel');

const ACTIVE_KEY = (process.env.AD_PAYOUT_ACTIVE_KEY || '').trim();
const SOURCE_ACCOUNT = (process.env.AD_PAYOUT_SOURCE || AD_PAYMENT_ACCOUNT || '').trim();
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_MS = () => AD_PAYOUT_PERIOD_DAYS * DAY_MS;
const fmt3 = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

let hiveClient = null;
function getClient() {
  if (hiveClient) return hiveClient;
  const nodes = HIVE_RPC_ENDPOINTS.filter((u) => /^https?:\/\//.test(u) && !/testnet/.test(u));
  hiveClient = new Client(nodes.length ? nodes : ['https://api.hive.blog']);
  return hiveClient;
}

/** Period boundaries are absolute, anchored to the epoch, so they never drift. */
function periodContaining(ts) {
  const start = Math.floor(ts / PERIOD_MS()) * PERIOD_MS();
  return { start: new Date(start), end: new Date(start + PERIOD_MS()), key: dayKey(start) };
}

/**
 * Revenue a campaign accrues inside [start, end).
 *
 * Pro rata by TIME, not by delivery: a flat booking buys the slot for the flight,
 * so each day of that flight is worth the same whether it delivered well or badly.
 * Paying by delivery instead would quietly move money from quiet weeks to busy
 * ones and make a creator's rate depend on other people's traffic.
 */
function accrualFor(campaign, start, end) {
  const fs = new Date(campaign.startAt || 0).getTime();
  const fe = new Date(campaign.endAt || 0).getTime();
  if (!fs || !fe || fe <= fs) return 0;
  const overlap = Math.max(0, Math.min(fe, end.getTime()) - Math.max(fs, start.getTime()));
  if (overlap <= 0) return 0;
  // Never accrue more than was actually paid, however the flight window was edited.
  const earned = Math.min(campaign.paidHbd || 0, campaign.priceHbd || campaign.paidHbd || 0);
  return earned * (overlap / (fe - fs));
}

async function communityOf(db, owner, permlink) {
  const embed = await db.collection('embed-video').findOne(
    { $or: [{ owner, permlink }, { hive_author: owner, hive_permlink: permlink }] },
    { projection: { category: 1 } },
  );
  const cat = embed?.category
    || (await db.collection('videos').findOne({ owner, permlink }, { projection: { category: 1 } }))?.category;
  // Communities are `hive-NNNNNN`; anything else is a plain tag, not an account.
  return /^hive-\d+$/.test(String(cat || '')) ? String(cat) : null;
}

async function communitySharePctOf(db, owner) {
  const doc = await db.collection(AD_CREATOR_PREFS_COLLECTION)
    .findOne({ _id: owner }, { projection: { communitySharePct: 1 } });
  const stored = doc && doc.communitySharePct;
  // Nullish, not falsy: a stored 0 is a creator who chose to keep the whole pool.
  return (stored === undefined || stored === null) ? AD_DEFAULT_COMMUNITY_PCT : stored;
}

/** Settle one closed period. Idempotent — a settled period is skipped. */
async function settlePeriod(db, period) {
  const periods = db.collection(AD_PAYOUT_PERIODS_COLLECTION);
  const existing = await periods.findOne({ _id: period.key });
  if (existing && existing.status === 'settled') return null;

  // Every campaign whose flight overlaps this period, whatever its status now —
  // a campaign that has since completed still earned during the window it ran.
  const campaigns = await db.collection(AD_CAMPAIGNS_COLLECTION).find({
    startAt: { $lt: period.end },
    endAt: { $gt: period.start },
    paidHbd: { $gt: 0 },
  }).toArray();

  const revenue = campaigns.reduce((sum, c) => sum + accrualFor(c, period.start, period.end), 0);
  // Anything a previous period could not distribute (no impressions) rolls in here.
  const carriedIn = (await periods.findOne({ carryTo: period.key }))?.carriedOut || 0;
  const pool = revenue * (AD_CREATOR_POOL_PCT / 100) + carriedIn;

  const impressions = await db.collection(AD_IMPRESSIONS_COLLECTION).find({
    completed: true,
    payoutId: null,
    completedAt: { $gte: period.start, $lt: period.end },
  }).toArray();

  if (!impressions.length) {
    // Nothing delivered. The money is not ours to keep — carry it forward.
    await periods.updateOne({ _id: period.key }, {
      $set: {
        startAt: period.start, endAt: period.end, revenueHbd: revenue, poolHbd: pool,
        impressions: 0, ratePerImpression: 0, carriedIn, carriedOut: pool,
        carryTo: periodContaining(period.end.getTime()).key,
        status: 'settled', settledAt: new Date(),
      },
    }, { upsert: true });
    if (pool > 0) console.log(`[adPayout] period ${period.key}: ${fmt3(pool)} HBD pool, 0 impressions → carried forward`);
    return { periodKey: period.key, recipients: 0, totalHbd: 0, carriedOut: pool };
  }

  const rate = pool / impressions.length;

  const owed = new Map();
  const add = (account, hbd, kind) => {
    if (!account || hbd <= 0) return;
    const cur = owed.get(account) || { hbd: 0, kind };
    cur.hbd += hbd;
    owed.set(account, cur);
  };

  // A period can hold thousands of impressions across a handful of creators; each
  // lookup is a round trip, so cache both by the key that actually varies.
  const prefCache = new Map();
  const communityCache = new Map();

  for (const imp of impressions) {
    const owner = imp.owner;
    if (!owner) continue;
    if (!prefCache.has(owner)) prefCache.set(owner, await communitySharePctOf(db, owner));
    const communityPct = prefCache.get(owner);

    const key = `${owner}/${imp.permlink}`;
    if (!communityCache.has(key)) communityCache.set(key, await communityOf(db, owner, imp.permlink));
    const community = communityCache.get(key);

    const communityCut = rate * (communityPct / AD_CREATOR_POOL_PCT);
    if (community) {
      add(owner, rate - communityCut, 'creator');
      add(community, communityCut, 'community');
    } else {
      // No community to pay — the whole share goes to the creator. They are the
      // other party to the split they configured, and keeping it would be the
      // self-serving reading of a choice they made for someone else's benefit.
      add(owner, rate, 'creator');
    }
  }

  const rows = [...owed.entries()]
    .map(([account, v]) => ({ account, hbd: Math.round(v.hbd * 1000) / 1000, kind: v.kind }))
    .sort((a, b) => b.hbd - a.hbd);
  const payable = rows.filter((r) => r.hbd >= AD_PAYOUT_MIN_HBD);
  // Dust below Hive's 0.001 precision would round to nothing if sent. Carry it
  // rather than dropping it: across a long tail of small creators that is real money.
  const dust = rows.filter((r) => r.hbd < AD_PAYOUT_MIN_HBD).reduce((a, r) => a + r.hbd, 0);

  for (const r of payable) {
    await db.collection(AD_PAYOUTS_COLLECTION).updateOne(
      { periodKey: period.key, account: r.account },
      {
        $set: { hbd: r.hbd, kind: r.kind, updatedAt: new Date() },
        $setOnInsert: { status: 'pending', createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  await db.collection(AD_IMPRESSIONS_COLLECTION).updateMany(
    { _id: { $in: impressions.map((i) => i._id) } },
    { $set: { payoutId: period.key } },
  );

  await periods.updateOne({ _id: period.key }, {
    $set: {
      startAt: period.start, endAt: period.end, revenueHbd: revenue, poolHbd: pool,
      impressions: impressions.length, ratePerImpression: rate, carriedIn,
      carriedOut: dust, carryTo: periodContaining(period.end.getTime()).key,
      recipients: payable.length, status: 'settled', settledAt: new Date(),
    },
  }, { upsert: true });

  const total = payable.reduce((a, r) => a + r.hbd, 0);
  console.log(
    `[adPayout] period ${period.key}: ${fmt3(pool)} HBD pool / ${impressions.length} impressions `
    + `= ${rate.toFixed(5)} HBD each → ${payable.length} recipient(s), ${fmt3(total)} HBD`
    + (dust > 0 ? ` (${fmt3(dust)} dust carried)` : ''),
  );
  return { periodKey: period.key, recipients: payable.length, totalHbd: total, ratePerImpression: rate };
}

/**
 * Close ended flights and work out what, if anything, is owed back.
 *
 * A flat booking buys the slot for a period, so a campaign that delivered nothing
 * bought nothing. Leaving that money with us because the advertiser did not chase it
 * is not a policy, it is an oversight with a profit motive — so every ended campaign
 * gets an explicit refund figure, computed the same way for everyone:
 *
 *   owed back = what they paid × (1 − delivered / forecast)
 *
 * `forecast` is what the inventory said the slot would deliver over the flight, so
 * an advertiser is made whole for the shortfall against what we told them to expect,
 * not against an unbounded promise. Nothing is transferred automatically — refunds
 * are recorded as `pending` and a human sends them, because a refund is a
 * conversation and a mistake here is unrecoverable.
 */
async function closeFinishedCampaigns(db) {
  const ended = await db.collection(AD_CAMPAIGNS_COLLECTION).find({
    status: { $in: [STATES.SCHEDULED, STATES.RUNNING] },
    endAt: { $lte: new Date() },
  }).toArray();

  for (const c of ended) {
    const delivered = c.deliveredImpressions || 0;
    const forecast = c.forecastImpressions || 0;
    // No forecast recorded (booked before we started storing it) → we cannot say
    // what was promised, so we do not invent a shortfall. Flag it for a human.
    const shortfall = forecast > 0 ? Math.max(0, 1 - delivered / forecast) : null;
    const refundHbd = shortfall === null ? null : Math.round((c.paidHbd || 0) * shortfall * 1000) / 1000;

    await db.collection(AD_CAMPAIGNS_COLLECTION).updateOne({ _id: c._id }, {
      $set: {
        status: STATES.COMPLETE,
        closedAt: new Date(),
        updatedAt: new Date(),
        undelivered: delivered <= 0,
        deliveryRate: forecast > 0 ? Math.round((delivered / forecast) * 1000) / 1000 : null,
        refundHbd,
        // 'none' keeps the zero case explicit rather than absent — "we checked and
        // owe nothing" and "nobody looked" must not be the same state.
        refundStatus: refundHbd === null ? 'review' : (refundHbd >= AD_PAYOUT_MIN_HBD ? 'pending' : 'none'),
      },
    });

    if (refundHbd !== null && refundHbd >= AD_PAYOUT_MIN_HBD) {
      console.log(
        `[adPayout] campaign ${c._id} under-delivered: ${delivered}/${forecast} `
        + `→ ${fmt3(refundHbd)} HBD owed back to @${c.hiveAccount}`,
      );
    } else if (refundHbd === null) {
      console.log(`[adPayout] campaign ${c._id} closed with no forecast on record — refund needs a human`);
    }
  }
  return ended.length;
}

async function payPending(db) {
  const pending = await db.collection(AD_PAYOUTS_COLLECTION).find({ status: 'pending' }).toArray();
  if (!pending.length) return { sent: 0, dryRun: !ACTIVE_KEY };

  if (!ACTIVE_KEY) {
    console.log(`[adPayout] DRY RUN — ${pending.length} payout(s) totalling ${fmt3(pending.reduce((a, p) => a + p.hbd, 0))} HBD would be sent from @${SOURCE_ACCOUNT}`);
    return { sent: 0, dryRun: true };
  }

  const key = PrivateKey.fromString(ACTIVE_KEY);
  let sent = 0;
  for (const p of pending) {
    // One transfer per recipient, marked individually: a batch that fails halfway
    // must never leave us unable to say who was paid.
    try {
      await getClient().broadcast.sendOperations([['transfer', {
        from: SOURCE_ACCOUNT,
        to: p.account,
        amount: `${fmt3(p.hbd)} HBD`,
        memo: `3Speak ad revenue share (${p.kind}) — ${p.periodKey}`,
      }]], key);
      await db.collection(AD_PAYOUTS_COLLECTION).updateOne({ _id: p._id }, { $set: { status: 'paid', paidAt: new Date() } });
      sent += 1;
    } catch (err) {
      const msg = err && err.message;
      console.error(`[adPayout] transfer to @${p.account} failed: ${msg}`);
      await db.collection(AD_PAYOUTS_COLLECTION).updateOne({ _id: p._id }, { $set: { lastError: String(msg).slice(0, 300), lastTriedAt: new Date() } });
    }
  }
  return { sent, dryRun: false };
}

async function runOnce() {
  if (!AD_PAYOUTS_ENABLED) return null;
  try {
    const db = getDb();
    const closed = await closeFinishedCampaigns(db);

    // Settle every period that has fully elapsed and is not settled yet. Looping
    // rather than doing only the last one means a service that was down for a
    // fortnight catches up instead of silently skipping a period.
    const current = periodContaining(Date.now());
    const settled = [];
    const oldest = await db.collection(AD_IMPRESSIONS_COLLECTION)
      .find({ payoutId: null, completed: true }).sort({ completedAt: 1 }).limit(1).toArray();
    let cursor = oldest.length
      ? periodContaining(new Date(oldest[0].completedAt || oldest[0].at).getTime())
      : current;

    let guard = 0;
    while (cursor.start < current.start && guard < 200) {
      const r = await settlePeriod(db, cursor);
      if (r) settled.push(r);
      cursor = periodContaining(cursor.end.getTime());
      guard += 1;
    }

    const paid = await payPending(db);
    if (closed || settled.length || paid.sent) {
      console.log(`[adPayout] closed ${closed} campaign(s), settled ${settled.length} period(s); ${paid.dryRun ? 'dry run' : `${paid.sent} transfer(s) sent`}`);
    }
    return { closed, settled: settled.length, ...paid };
  } catch (err) {
    console.error('[adPayout] run failed:', err && err.message);
    return null;
  }
}

function schedule() {
  if (!AD_PAYOUTS_ENABLED) {
    console.log('[adPayout] disabled (AD_PAYOUTS_ENABLED=false)');
    return;
  }
  if (!SOURCE_ACCOUNT) {
    console.log('[adPayout] disabled — no payout source account configured.');
    return;
  }
  if (ACTIVE_KEY) {
    try { PrivateKey.fromString(ACTIVE_KEY); }
    catch (err) {
      console.error(`[adPayout] disabled — AD_PAYOUT_ACTIVE_KEY does not parse: ${err.message}`);
      return;
    }
  }
  const mode = ACTIVE_KEY ? 'LIVE' : 'DRY RUN';
  const ms = Math.max(1, AD_PAYOUT_INTERVAL_H) * 60 * 60 * 1000;
  setTimeout(() => { runOnce(); setInterval(runOnce, ms); }, 5 * 60 * 1000);
  console.log(
    `[adPayout] scheduled every ${AD_PAYOUT_INTERVAL_H}h, ${AD_PAYOUT_PERIOD_DAYS}-day periods, `
    + `from @${SOURCE_ACCOUNT} [${mode}] (first run in 5min)`,
  );
}

module.exports = { schedule, runOnce, settlePeriod, periodContaining, accrualFor, closeFinishedCampaigns };
