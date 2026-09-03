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
  AD_EXCLUDED_ACCOUNTS,
  AD_DEFAULT_COMMUNITY_PCT, AD_CREATOR_PREFS_COLLECTION, AD_PAYMENT_ACCOUNT,
  AD_PAYOUTS_ENABLED, AD_PAYOUT_INTERVAL_H, AD_PAYOUT_MIN_HBD, AD_PAYOUT_PERIOD_DAYS, AD_PAYMENTS_COLLECTION, AD_BOOKING_EXPIRY_DAYS,
  AD_VIEWER_POOL_PCT, AD_VIEWER_WATCH_COLLECTION,
} = require('../utils/config');
const { STATES } = require('../utils/adModel');
// The chain is the authority on which community a post was published to — see
// resolveCommunities() for why a Mongo read alone was not enough.
const { hiveRpcBatch } = require('../utils/hive');

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

/**
 * The same accrual, but in the ASSETS the advertiser actually sent.
 *
 * 🚨 `paidHbd` is a valuation. An advertiser may pay in HIVE, and then an
 * HBD-denominated payout is not merely awkward, it is impossible — the transfer
 * fails for want of HBD. So a campaign's asset mix rides through settlement and
 * everyone is paid IN KIND, proportionally.
 *
 * Scaled by the same time fraction as the HBD figure, so the two always agree about
 * how much of a flight has been earned. Campaigns booked before `paidAssets`
 * existed report nothing here; `assetSplitOf()` falls back to HBD for those.
 */
function accrualAssetsFor(campaign, start, end) {
  const fs = new Date(campaign.startAt || 0).getTime();
  const fe = new Date(campaign.endAt || 0).getTime();
  if (!fs || !fe || fe <= fs) return {};
  const overlap = Math.max(0, Math.min(fe, end.getTime()) - Math.max(fs, start.getTime()));
  if (overlap <= 0) return {};
  const fraction = overlap / (fe - fs);
  const out = {};
  for (const [symbol, amount] of Object.entries(campaign.paidAssets || {})) {
    const n = Number(amount);
    if (Number.isFinite(n) && n > 0) out[symbol] = n * fraction;
  }
  return out;
}

/**
 * Turn a pool's asset totals into the fractions each asset represents.
 *
 * Falls back to all-HBD when a period's campaigns predate `paidAssets`, which keeps
 * historical settlements behaving exactly as they did.
 */
function assetSplitOf(assetTotals) {
  const total = Object.values(assetTotals).reduce((a, n) => a + n, 0);
  if (!(total > 0)) return { HBD: 1 };
  const out = {};
  for (const [symbol, n] of Object.entries(assetTotals)) if (n > 0) out[symbol] = n / total;
  return out;
}

/**
 * A recipient's payout, in the NATIVE units of each asset the pool holds.
 *
 * 🚨 Takes a SHARE OF THE POOL, not an HBD figure, and multiplies it by each asset's
 * own native pool. This is the whole point and it is easy to get wrong: "7 HBD worth
 * of HIVE" is not "7 HIVE", so splitting an HBD number by a value ratio and labelling
 * the pieces with symbols would silently overpay or underpay the HIVE leg by the
 * exchange rate. Scaling native pools needs no rate at all, so the platform never
 * takes a currency position and nothing depends on a price at payout time.
 */
function splitAmounts(shareOfPool, assetPool) {
  return Object.entries(assetPool)
    .map(([symbol, poolAmount]) => ({
      symbol,
      amount: Math.round(shareOfPool * poolAmount * 1000) / 1000,
    }))
    .filter((leg) => leg.amount > 0);
}

/**
 * Each asset's share of a pool, in native units.
 *
 * `poolHbd` may exceed this period's own accruals because dust carried in from an
 * earlier period rides along with it. That carry has no asset of its own — it is a
 * remainder of an HBD figure — so it is paid in THIS period's mix, which is what the
 * scale factor does. Without it the legs would not add up to what the recipient is
 * owed.
 */
function assetPoolFor(assetTotals, sharePct, poolHbd, revenueHbd) {
  const own = revenueHbd * (sharePct / 100);
  const scale = own > 0 ? (poolHbd / own) : 1;
  const out = {};
  for (const [symbol, n] of Object.entries(assetTotals)) {
    const v = n * (sharePct / 100) * scale;
    if (v > 0) out[symbol] = v;
  }
  return Object.keys(out).length ? out : { HBD: poolHbd };
}

const isCommunity = (cat) => /^hive-\d+$/.test(String(cat || ''));

/**
 * Which community each video belongs to, for every video in a settlement.
 *
 * 🚨 THE CHAIN IS THE SOURCE OF TRUTH, NOT OUR DATABASE.
 * This decides where money goes, and `embed-video.category` is a denormalised copy of
 * something Hive already knows authoritatively. It was the only source until
 * 2026-08-31, and it silently underpaid communities: the field is missing on a small
 * share of videos that ARE in a community on chain (99 of 5,453 eligible on
 * 2026-08-30, across BOTH the 3speak-tv and ecency upload paths, so a sporadic write
 * failure rather than one broken client). A missing category read as "not in a
 * community", the creator was paid 100%, and nothing said otherwise.
 *
 * Mongo is now used only to find WHICH post to ask about, never for the answer. A
 * sample of 60 videos that did have a stored value found 60 agreeing with the chain,
 * so this is not fixing a present-day mismatch — it removes the dependency on a copy
 * that has already been wrong once by omission and could drift again silently.
 *
 * ⚠️ FALLBACK WHEN HIVE IS UNREACHABLE. Requiring the chain unconditionally would let
 * an RPC outage halt every payout, including the ~98% whose stored value was measured
 * accurate. So on a failed batch a stored community is used, loudly, and only a video
 * with NO stored value is left unresolved. That keeps an outage from stopping
 * everyone while still refusing to guess where there is nothing to guess from.
 *
 * 🚨 AND WHY THE THREE-WAY RESULT MATTERS
 * `null` (definitely no community — an upload with no Hive post) and "we could not
 * find out" are completely different, and collapsing them is the original bug: an
 * unknown treated as a null pays the community's share to the creator, in a
 * settlement that is idempotent and therefore never revisited. `hiveRpcBatch` returns
 * [] when every endpoint fails, which is indistinguishable from "no posts found", so
 * that case is caught here rather than read as data.
 *
 * Resolved in one pass rather than per impression: a period holds thousands of
 * impressions over far fewer videos, and the lookups batch.
 */
async function resolveCommunities(db, pairs) {
  const map = new Map();
  const unresolved = [];
  if (!pairs.length) return { map, unresolved };

  const parsed = pairs.map((key) => {
    const i = key.indexOf('/');
    return { key, owner: key.slice(0, i), permlink: key.slice(i + 1) };
  });

  // One query, to find each video's Hive post — not its category.
  const rows = await db.collection('embed-video').find(
    { $or: parsed.flatMap((p) => [
      { owner: p.owner, permlink: p.permlink },
      { hive_author: p.owner, hive_permlink: p.permlink },
    ]) },
    { projection: { owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1, category: 1 } },
  ).toArray();

  const byKey = new Map();
  for (const r of rows) {
    if (r.owner && r.permlink) byKey.set(`${r.owner}/${r.permlink}`, r);
    if (r.hive_author && r.hive_permlink) byKey.set(`${r.hive_author}/${r.hive_permlink}`, r);
  }

  const needChain = [];
  for (const p of parsed) {
    const row = byKey.get(p.key);
    const stored = isCommunity(row?.category) ? String(row.category) : null;

    if (row?.hive_author && row?.hive_permlink) {
      needChain.push({ ...p, author: row.hive_author, hivePermlink: row.hive_permlink, stored });
      continue;
    }
    if (row) {
      // An embed row with no Hive post: nothing was ever published, so there is no
      // community. A stored category on such a row cannot outrank that.
      map.set(p.key, null);
      continue;
    }
    // No embed row at all. That is a LEGACY video, whose `owner`/`permlink` are the
    // Hive author and permlink directly — so the impression already carries the
    // coordinates of the post and we can just ask.
    //
    // Deliberately NOT checked against the legacy `videos` collection first. Ads
    // serve on legacy videos (routes/adServe.js looks embed-video up for duration
    // but does not require a row) and the inventory forecast counts them, so they
    // earn — and a video we happen to have no local record of has earned just the
    // same. The chain answers "no such post" definitively if there is nothing there,
    // which is a better test than the absence of a row in our own database.
    //
    // A legacy row's own category is a plain tag ("general", "crypto") and never a
    // community, so consulting it could only ever produce a wrong answer anyway.
    needChain.push({ ...p, author: p.owner, hivePermlink: p.permlink, stored: null });
  }

  // Batched, in chunks, so one settlement cannot build a single enormous request.
  const CHUNK = 25;
  let fromChain = 0; let fellBack = 0; let disagreed = 0;
  for (let i = 0; i < needChain.length; i += CHUNK) {
    const slice = needChain.slice(i, i + CHUNK);
    let res = [];
    try {
      res = await hiveRpcBatch(slice.map((s, n) => ({
        jsonrpc: '2.0',
        method: 'condenser_api.get_content',
        params: [s.author, s.hivePermlink],
        id: n + 1,
      })));
    } catch (_) { res = []; }

    // Empty or short means the RPC failed — NOT that these posts do not exist.
    if (!Array.isArray(res) || res.length !== slice.length) {
      slice.forEach((s) => {
        if (s.stored) { map.set(s.key, s.stored); fellBack += 1; } else unresolved.push(s.key);
      });
      continue;
    }
    slice.forEach((s, n) => {
      const post = res[n]?.result;
      if (!post || !post.author) {
        // The RPC answered and has no such post. That is a real answer: an upload
        // whose Hive post was deleted or never landed has no community.
        map.set(s.key, null);
        return;
      }
      const chain = isCommunity(post.category) ? String(post.category) : null;
      // A divergence means our copy has drifted. It changes nothing here — the chain
      // wins — but it is the signal that something upstream is writing badly.
      if (s.stored && s.stored !== chain) {
        disagreed += 1;
        console.warn(`[adPayout] community mismatch @${s.author}/${s.hivePermlink}: stored ${s.stored}, chain ${chain} — using the chain`);
      }
      map.set(s.key, chain);
      fromChain += 1;
    });
  }

  if (needChain.length) {
    console.log(
      `[adPayout] community lookup: ${needChain.length} video(s) checked against Hive — `
      + `${fromChain} answered${disagreed ? `, ${disagreed} disagreed with our copy` : ''}`
      + `${fellBack ? `, ${fellBack} fell back to the stored value (RPC unreachable)` : ''}`
      + `${unresolved.length ? `, ${unresolved.length} unresolved` : ''}`,
    );
  }
  return { map, unresolved };
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
  // The same accrual expressed in the assets advertisers actually sent, so everyone
  // is paid in kind rather than in an HBD figure we may not hold.
  const assetTotals = {};
  for (const c of campaigns) {
    for (const [sym, n] of Object.entries(accrualAssetsFor(c, period.start, period.end))) {
      assetTotals[sym] = (assetTotals[sym] || 0) + n;
    }
  }
  const assetSplit = assetSplitOf(assetTotals);
  // Anything a previous period could not distribute (no impressions) rolls in here.
  const carriedIn = (await periods.findOne({ carryTo: period.key }))?.carriedOut || 0;
  const pool = revenue * (AD_CREATOR_POOL_PCT / 100) + carriedIn;
  // Native-unit pool per asset, so payouts need no exchange rate at all.
  const creatorAssetPool = assetPoolFor(assetTotals, AD_CREATOR_POOL_PCT, pool, revenue);

  /* ─── viewer share ──────────────────────────────────────────────────────
   * A slice of the PLATFORM's own cut, set aside for the people who watched.
   *
   * 🚨 Taken from what we keep, never from `pool`. The creator side must not
   * notice this exists — funding viewer rewards out of the creator pool would be
   * paying viewers with creators' money.
   *
   * ⚠️ EARMARKED, NOT DISTRIBUTED. The metric we pay on is still an open question
   * (completed ad views? verified seconds? distinct days?), so this records what is
   * owed to viewers collectively and stops there. Recording it from day one means
   * that when the metric lands there is a real, auditable balance to pay out of,
   * rather than a number reconstructed after the fact from periods nobody measured.
   * Nothing is lost by waiting: it stays in the platform's own share until claimed.
   */
  const platformPool = revenue * (1 - AD_CREATOR_POOL_PCT / 100);
  const viewerPoolHbd = Math.round(platformPool * (AD_VIEWER_POOL_PCT / 100) * 1000) / 1000;

  const impressions = await db.collection(AD_IMPRESSIONS_COLLECTION).find({
    completed: true,
    payoutId: null,
    completedAt: { $gte: period.start, $lt: period.end },
  }).toArray();

  if (!impressions.length) {
    // No creator impressions does not mean no viewers: someone may still have
    // watched a video to 75% while a flight was running.
    const viewerPaidNoImp = await payViewers(db, period, viewerPoolHbd);
    // Nothing delivered. The money is not ours to keep — carry it forward.
    await periods.updateOne({ _id: period.key }, {
      $set: {
        startAt: period.start, endAt: period.end, revenueHbd: revenue, poolHbd: pool,
        viewerPoolHbd,
        viewerPoolStatus: viewerPaidNoImp.recipients ? 'paid' : 'earmarked',
        viewerRecipients: viewerPaidNoImp.recipients,
        viewerPaidHbd: viewerPaidNoImp.paidHbd,
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
  // lookup is a round trip, so cache by the key that actually varies.
  const prefCache = new Map();

  // Resolved up front, and BEFORE anything is written. A video whose community
  // cannot be determined must not be settled at a guess: settlement is idempotent
  // and marks its impressions paid, so a wrong split here is never revisited. Better
  // to leave the period unsettled and pick it up on the next run — the money is not
  // going anywhere, and the impressions keep `payoutId: null` so the walk retries.
  const { map: communityCache, unresolved } = await resolveCommunities(
    db,
    [...new Set(impressions.filter((i) => i.owner).map((i) => `${i.owner}/${i.permlink}`))],
  );
  if (unresolved.length) {
    console.error(
      `[adPayout] period ${period.key} NOT settled: could not determine the community for `
      + `${unresolved.length} video(s) (${unresolved.slice(0, 3).join(', ')}${unresolved.length > 3 ? ', …' : ''}). `
      + 'Hive RPC is unreachable — retrying next run rather than paying a guess.',
    );
    return null;
  }

  for (const imp of impressions) {
    const owner = imp.owner;
    if (!owner) continue;
    if (!prefCache.has(owner)) prefCache.set(owner, await communitySharePctOf(db, owner));
    const communityPct = prefCache.get(owner);

    const community = communityCache.get(`${owner}/${imp.permlink}`) || null;

    // An excluded owner is the platform's own account. Its impression is still one of
    // `impressions.length` above, so `rate` — what every other creator is paid per
    // impression — is unchanged by whether we happen to be running ads on ourselves.
    // Only the credit is withheld; that money is never sent and stays where it is.
    const ownerExcluded = AD_EXCLUDED_ACCOUNTS.includes(String(owner).toLowerCase());

    const communityCut = rate * (communityPct / AD_CREATOR_POOL_PCT);
    if (community) {
      // The community is a different party and is paid on its own terms: the excluded
      // account's videos still earn their community whatever that creator configured.
      if (!ownerExcluded) add(owner, rate - communityCut, 'creator');
      add(community, communityCut, 'community');
    } else if (!ownerExcluded) {
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
        // `hbd` stays the HBD-equivalent total — it is what every report, test and
        // dust threshold is expressed in. `amounts` is what actually gets sent.
        $set: { hbd: r.hbd, amounts: splitAmounts(pool > 0 ? r.hbd / pool : 0, creatorAssetPool), kind: r.kind, updatedAt: new Date() },
        $setOnInsert: { status: 'pending', createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  await db.collection(AD_IMPRESSIONS_COLLECTION).updateMany(
    { _id: { $in: impressions.map((i) => i._id) } },
    { $set: { payoutId: period.key } },
  );

  // Viewers settle from the platform's slice, independently of the creator pool
  // above: a period can owe viewers even when it owed creators nothing.
  const viewerPaid = await payViewers(db, period, viewerPoolHbd,
    assetPoolFor(assetTotals, (100 - AD_CREATOR_POOL_PCT) * (AD_VIEWER_POOL_PCT / 100), viewerPoolHbd, revenue));

  await periods.updateOne({ _id: period.key }, {
    $set: {
      startAt: period.start, endAt: period.end, revenueHbd: revenue, poolHbd: pool,
      assetTotals,
      assetSplit,
      viewerPoolHbd,
      viewerPoolStatus: viewerPaid.recipients ? 'paid' : 'earmarked',
      viewerRecipients: viewerPaid.recipients,
      viewerPaidHbd: viewerPaid.paidHbd,
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
 * not against an unbounded promise.
 *
 * The shortfall is kept as CREDIT against their next campaign rather than transferred
 * back — see utils/adBalance.js for why, and for why the balance is derived from these
 * fields instead of being a counter. An advertiser who never books again and asks for
 * the money is a conversation, not an automated transfer: `balanceOf()` says exactly
 * what they are owed.
 *
 * 🚨 The status transition is the LOCK. The update is guarded on the campaign still
 * being scheduled/running, and the credit is written inside that same update — so two
 * concurrent runs cannot both close one campaign and bank its shortfall twice.
 */
async function closeFinishedCampaigns(db) {
  const ended = await db.collection(AD_CAMPAIGNS_COLLECTION).find({
    status: { $in: [STATES.SCHEDULED, STATES.RUNNING] },
    endAt: { $lte: new Date() },
  }).toArray();

  let closed = 0;
  for (const c of ended) {
    const delivered = c.deliveredImpressions || 0;
    const forecast = c.forecastImpressions || 0;
    // No forecast recorded (booked before we started storing it) → we cannot say
    // what was promised, so we do not invent a shortfall. Flag it for a human.
    const shortfall = forecast > 0 ? Math.max(0, 1 - delivered / forecast) : null;
    const owedHbd = shortfall === null ? null : Math.round((c.paidHbd || 0) * shortfall * 1000) / 1000;
    const bankable = owedHbd !== null && owedHbd >= AD_PAYOUT_MIN_HBD;

    const res = await db.collection(AD_CAMPAIGNS_COLLECTION).updateOne(
      // The guard: whoever flips it out of scheduled/running owns the close.
      { _id: c._id, status: { $in: [STATES.SCHEDULED, STATES.RUNNING] } },
      {
        $set: {
          status: STATES.COMPLETE,
          closedAt: new Date(),
          updatedAt: new Date(),
          undelivered: delivered <= 0,
          deliveryRate: forecast > 0 ? Math.round((delivered / forecast) * 1000) / 1000 : null,
          // What the shortfall came to, whether or not it cleared the minimum.
          refundHbd: owedHbd,
          // What was actually banked as spendable credit. Written here, in the same
          // atomic update as the status change, so the derived balance in
          // utils/adBalance.js can never disagree with what happened.
          creditHbd: bankable ? owedHbd : 0,
          // 'none' keeps the zero case explicit rather than absent — "we checked and
          // owe nothing" and "nobody looked" must not be the same state.
          refundStatus: owedHbd === null ? 'review' : (bankable ? 'credited' : 'none'),
        },
      },
    );
    if (res.modifiedCount !== 1) continue;   // another run closed it first
    closed += 1;

    if (bankable) {
      console.log(
        `[adPayout] campaign ${c._id} under-delivered: ${delivered}/${forecast} `
        + `→ ${fmt3(owedHbd)} HBD credited to @${c.hiveAccount} for their next campaign`,
      );
    } else if (owedHbd === null) {
      console.log(`[adPayout] campaign ${c._id} closed with no forecast on record — needs a human`);
    }
  }
  return closed;
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
      /* Pay in the assets the advertisers actually sent. `amounts` is written by
       * settlePeriod; a row from before this existed has none, and falls back to
       * the HBD figure so old pending rows still settle correctly. */
      const legs = (Array.isArray(p.amounts) && p.amounts.length)
        ? p.amounts
        : [{ symbol: 'HBD', amount: p.hbd }];
      for (const leg of legs) {
        const amt = Math.round((Number(leg.amount) || 0) * 1000) / 1000;
        if (amt <= 0) continue;
        await getClient().broadcast.sendOperations([['transfer', {
          from: SOURCE_ACCOUNT,
          to: p.account,
          amount: `${fmt3(amt)} ${leg.symbol}`,
          memo: `3Speak ad revenue share (${p.kind}) — ${p.periodKey}`,
        }]], key);
      }
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

/**
 * Send back money that arrived from the wrong account.
 *
 * A transfer only buys a flight if it came from the account the campaign is booked
 * under — that is how an advertiser proves they hold it, since registering is
 * unsigned. Anything else is refused at claim time and lands here.
 *
 * This one IS automatic, unlike the under-delivery credit above, and the difference
 * is deliberate: a shortfall is a judgement about delivery, but a payment we have
 * declined to accept is simply not ours. Holding it pending a human is holding
 * somebody's money for no reason.
 *
 * 🚨 CLAIM-THEN-SEND, never send-then-mark. The row is moved to `sending` with a
 * conditional update BEFORE the broadcast, so a crash mid-flight leaves it parked
 * rather than re-sent by the next run. Double-paying a refund is unrecoverable;
 * a stuck row is a support ticket. The payout path above does mark-after-send and
 * carries the opposite risk — this is the safer order and the one to copy.
 */
/**
 * Pay viewers their share of the period's ad revenue.
 *
 * Same pooled shape as the creator side, and for the same reason: one rate for
 * everyone in the period, so what you earn depends on how much you watched and not
 * on which campaign happened to be running while you did.
 *
 *   rate = viewerPool / (total qualifying seconds)
 *
 * Every guard that decides WHETHER a watch counts already ran when the row was
 * written (preview-player/watchTracking.js recordViewerReward): 3speak.tv only,
 * >=75% coverage, not the owner, not premium, not private, capped seconds, one row
 * per video with $max. This function only divides money between rows that exist.
 *
 * 🚨 Rows are CLAIMED before payment is computed, by stamping `payoutId`. That is
 * what stops a viewer being paid twice for the same watch if a settlement is retried
 * — the same job `payoutId` does for impressions on the creator side.
 */
async function payViewers(db, period, viewerPoolHbd, viewerAssetPool = null) {
  if (!(viewerPoolHbd > 0)) return { recipients: 0, paidHbd: 0 };
  const watch = db.collection(AD_VIEWER_WATCH_COLLECTION);

  // Everything banked and not yet settled. No date filter: a watch recorded in an
  // earlier period that was never paid is still owed, and dropping it would quietly
  // keep money we said belonged to viewers.
  const claimable = await watch.find({ payoutId: null }).toArray();
  if (!claimable.length) return { recipients: 0, paidHbd: 0 };

  // Excluded accounts are dropped from the pool ENTIRELY, not just from the payout.
  // Leaving their seconds in the denominator would hand part of a pool we earmarked
  // for viewers back to ourselves. Their rows are still claimed below, so they settle
  // once and are not re-read every period.
  const rows = claimable.filter((r) => !AD_EXCLUDED_ACCOUNTS.includes(String(r.viewer || '').toLowerCase()));
  if (!rows.length) {
    // Only excluded viewers had anything banked. Claim regardless: an unclaimed row is
    // re-read on every settlement forever, and these can never become payable.
    await watch.updateMany({ payoutId: null }, { $set: { payoutId: period.key, settledAt: new Date() } });
    return { recipients: 0, paidHbd: 0 };
  }

  const totalSeconds = rows.reduce((a, r) => a + (Number(r.contentSeconds) || 0), 0);
  if (totalSeconds <= 0) return { recipients: 0, paidHbd: 0 };
  const perSecond = viewerPoolHbd / totalSeconds;

  const owed = new Map();
  for (const r of rows) {
    const secs = Number(r.contentSeconds) || 0;
    if (secs <= 0 || !r.viewer) continue;
    owed.set(r.viewer, (owed.get(r.viewer) || 0) + secs * perSecond);
  }

  const payable = [...owed.entries()]
    .map(([account, hbd]) => ({ account, hbd: Math.round(hbd * 1000) / 1000 }))
    .filter((r) => r.hbd >= AD_PAYOUT_MIN_HBD);

  // Claim first, pay second. A crash between the two leaves rows marked settled and
  // a payout row already written, which `payPending` will retry — the safe order.
  await watch.updateMany({ payoutId: null }, { $set: { payoutId: period.key, settledAt: new Date() } });

  for (const r of payable) {
    await db.collection(AD_PAYOUTS_COLLECTION).updateOne(
      { periodKey: period.key, account: r.account },
      {
        $set: { hbd: r.hbd, amounts: splitAmounts(viewerPoolHbd > 0 ? r.hbd / viewerPoolHbd : 0, viewerAssetPool || { HBD: viewerPoolHbd }), kind: 'viewer', updatedAt: new Date() },
        $setOnInsert: { status: 'pending', createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  const total = payable.reduce((a, r) => a + r.hbd, 0);
  console.log(
    `[adPayout] period ${period.key}: viewer pool ${fmt3(viewerPoolHbd)} HBD / `
    + `${(totalSeconds / 3600).toFixed(1)}h qualifying = ${(perSecond * 3600).toFixed(4)} HBD/hour `
    + `→ ${payable.length} viewer(s), ${fmt3(total)} HBD`,
  );
  return { recipients: payable.length, paidHbd: total };
}

/**
 * Give back credit that an abandoned booking is sitting on.
 *
 * Credit is spent when a campaign is CREATED, so the advertiser is quoted a reduced
 * amount — that is the only point at which a discount can affect what they send. The
 * cost of that choice is this: a booking created and never paid holds the credit, and
 * there is no cancel route and no other expiry to let go of it.
 *
 * Releasing restores the full `amountDueHbd` as well as the balance, so the two can
 * never disagree. If the advertiser then pays the old, smaller figure they are simply
 * short — which `claim` already reports as a partial payment, and the claim-time
 * top-up will re-apply their credit if they still have any.
 */
async function releaseStaleCredit(db) {
  const campaigns = db.collection(AD_CAMPAIGNS_COLLECTION);
  const cutoff = new Date(Date.now() - AD_BOOKING_EXPIRY_DAYS * DAY_MS);
  const stale = await campaigns.find({
    status: STATES.AWAITING_PAYMENT,
    creditAppliedHbd: { $gt: 0 },
    createdAt: { $lt: cutoff },
  }).limit(200).toArray();

  let released = 0;
  for (const c of stale) {
    // Real money on top of the credit means this is a part-paid booking, not an
    // abandoned one. Taking its credit back would push it further from being paid.
    const onChain = (c.paidHbd || 0) - (c.creditAppliedHbd || 0);
    if (onChain > 0.0005) continue;

    const res = await campaigns.updateOne(
      { _id: c._id, status: STATES.AWAITING_PAYMENT, creditAppliedHbd: { $gt: 0 } },
      {
        $unset: { creditAppliedHbd: '', creditAppliedAt: '' },
        $set: {
          paidHbd: 0,
          amountDueHbd: c.priceHbd,
          creditReleasedHbd: c.creditAppliedHbd,
          creditReleasedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
    if (res.modifiedCount !== 1) continue;
    released += 1;
    console.log(`[adPayout] released ${fmt3(c.creditAppliedHbd)} HBD of credit from unpaid campaign ${c._id} back to @${c.hiveAccount}`);
  }
  return released;
}

const REFUND_MAX_ATTEMPTS = 3;

async function refundRefusedPayments(db) {
  const payments = db.collection(AD_PAYMENTS_COLLECTION);
  const owed = await payments.find({ status: 'refused', refundStatus: 'pending' }).limit(50).toArray();
  if (!owed.length) return { refunded: 0, dryRun: !ACTIVE_KEY };

  if (!ACTIVE_KEY) {
    console.log(`[adPayout] DRY RUN — ${owed.length} refused payment(s) would be returned from @${SOURCE_ACCOUNT}`);
    return { refunded: 0, dryRun: true };
  }

  const key = PrivateKey.fromString(ACTIVE_KEY);
  let refunded = 0;
  for (const p of owed) {
    // Return exactly what arrived, in the asset it arrived as. Reformatting from the
    // parsed number rather than echoing the string keeps a malformed amount from
    // reaching the chain, and refunding HBD for a HIVE payment would be a second
    // mistake on top of the first.
    const [rawAmount, rawSymbol] = String(p.refundAmount || p.amount || '').trim().split(/\s+/);
    const amount = Number(rawAmount);
    const symbol = String(rawSymbol || '').toUpperCase();
    const to = p.refundTo || p.from;
    if (!Number.isFinite(amount) || amount <= 0 || (symbol !== 'HBD' && symbol !== 'HIVE') || !to) {
      await payments.updateOne({ _id: p._id }, {
        $set: { refundStatus: 'review', lastError: `unreturnable amount "${p.refundAmount || p.amount}" or recipient "${to}"` },
      });
      console.error(`[adPayout] refund ${p.trx_id} needs a human: cannot parse ${p.refundAmount || p.amount} to @${to}`);
      continue;
    }

    // Claim it. If this does not match, another run already has it.
    const claim = await payments.findOneAndUpdate(
      { _id: p._id, refundStatus: 'pending' },
      { $set: { refundStatus: 'sending', sendStartedAt: new Date() }, $inc: { refundAttempts: 1 } },
      { returnDocument: 'after' },
    );
    const claimed = claim && (claim.value || claim);
    if (!claimed || claimed.refundStatus !== 'sending') continue;

    try {
      const result = await getClient().broadcast.sendOperations([['transfer', {
        from: SOURCE_ACCOUNT,
        to,
        amount: `${fmt3(amount)} ${symbol}`,
        memo: `3Speak ads: returned — please pay from @${p.expectedFrom || 'the account the campaign is booked under'}`,
      }]], key);
      await payments.updateOne({ _id: p._id }, {
        $set: {
          refundStatus: 'returned',
          returnedTrxId: result && result.id ? result.id : null,
          returnedBy: 'auto',
          returnedAt: new Date(),
        },
        $unset: { lastError: '' },
      });
      refunded += 1;
      console.log(`[adPayout] returned ${fmt3(amount)} ${symbol} to @${to} (refused payment ${p.trx_id})`);
    } catch (err) {
      const msg = String(err && err.message).slice(0, 300);
      // A throw here MIGHT still have landed on chain. Retry a bounded number of
      // times, then stop and let a person check rather than risk a second transfer.
      const parkForReview = (claimed.refundAttempts || 1) >= REFUND_MAX_ATTEMPTS;
      await payments.updateOne({ _id: p._id }, {
        $set: { refundStatus: parkForReview ? 'review' : 'pending', lastError: msg, lastTriedAt: new Date() },
      });
      console.error(`[adPayout] refund to @${to} failed (attempt ${claimed.refundAttempts}): ${msg}${parkForReview ? ' — parked for review, CHECK THE CHAIN before resending' : ''}`);
    }
  }
  return { refunded, dryRun: false };
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
    // Returning money we declined to accept is not conditional on anything above it
    // succeeding, so it runs regardless of what the payout pass did.
    const returns = await refundRefusedPayments(db);
    const releasedCredit = await releaseStaleCredit(db);
    if (closed || settled.length || paid.sent || returns.refunded || releasedCredit) {
      console.log(`[adPayout] closed ${closed} campaign(s), settled ${settled.length} period(s); ${paid.dryRun ? 'dry run' : `${paid.sent} transfer(s) sent`}, ${returns.refunded} refund(s) returned, ${releasedCredit} credit release(s)`);
    }
    return { closed, settled: settled.length, ...paid, refunded: returns.refunded };
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

module.exports = { schedule, runOnce, settlePeriod, periodContaining, accrualFor, closeFinishedCampaigns, refundRefusedPayments, releaseStaleCredit, payViewers };
