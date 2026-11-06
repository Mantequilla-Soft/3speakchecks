/**
 * Premium Subscription Sync (VSC/Magi Okinoko Subs → embed-users.premium)
 *
 * Two sources of premium access, unioned every run:
 *
 *   1. RECURRING SUBS — `oki_subs_subscription_current` rows with
 *      `status: 'active'` and `next_billing_at` in the future. The
 *      contract auto-collects from prepaid balance; when balance runs
 *      out the status flips so we don't have to track expiry ourselves.
 *
 *   2. ONE-TIME PASSES — `oki_subs_onetime_purchases` rows with
 *      `indexer_ts` newer than `now - ONETIME_VALIDITY_HOURS`. The
 *      contract does NOT create a SubscriptionEntry for one-time
 *      payments (it just emits an `offerPaid` event and transfers
 *      funds), so the validity window has to be enforced by us.
 *
 * Manually-set premium flags are protected: every auto-managed row is
 * tagged with `premium_source: 'subs'` on promote, and the demote pass
 * only touches rows carrying that tag. Manual upgrades (no source tag,
 * or any other source) are left alone forever.
 *
 * Precision: the sync runs every 60s, so a 1-day pass grants premium
 * for ~24h ± 1min. For sub-minute precision an API consumer can read
 * `premium_expires_at` (set for one-time-pass users) and gate locally.
 */

const { getDb } = require('../utils/db');
const { ENABLE_MONGO_WRITES } = require('../utils/config');

const HASURA_URL = process.env.OKI_HASURA_URL || 'https://api.okinoko.io/hasura/v1/graphql';

const SUB_OFFER_IDS = (process.env.PREMIUM_SUB_OFFER_IDS || '5')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);

const ONETIME_OFFER_IDS = (process.env.PREMIUM_ONETIME_OFFER_IDS || '4')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);

const ONETIME_VALIDITY_HOURS = parseFloat(process.env.PREMIUM_ONETIME_VALIDITY_HOURS || '24');
const ONETIME_VALIDITY_MS = ONETIME_VALIDITY_HOURS * 60 * 60 * 1000;

const SUBSCRIBER_PREFIX = 'hive:';
const PREMIUM_USERS_COLLECTION = process.env.PREMIUM_USERS_COLLECTION || 'embed-users';
const SOURCE_TAG = 'subs';
// Sources this sync may take over on promote: its own rows, and a Pro trial whose
// user went on to pay (left as 'testing', the trial sweep would switch them off).
const TAKEOVER_SOURCES = [SOURCE_TAG, 'testing'];

// Premium granted by hand (no source tag) or by another source. Promoting such a
// row would tag it 'subs', and the demote pass would then switch it off once the
// subscription lapses, so it is left exactly as it is.
const isForeignGrant = (row) => !!row && row.premium === true && !TAKEOVER_SOURCES.includes(row.premium_source);

function stripPrefix(address) {
    const id = address || '';
    if (!id.startsWith(SUBSCRIBER_PREFIX)) return null;
    const u = id.slice(SUBSCRIBER_PREFIX.length).toLowerCase();
    return u || null;
}

async function hasura(query, variables) {
    const resp = await fetch(HASURA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    if (!resp.ok) throw new Error(`Hasura HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.errors) throw new Error(data.errors[0]?.message || 'Hasura GraphQL error');
    return data.data || {};
}

async function fetchActiveSubscribers() {
    if (SUB_OFFER_IDS.length === 0) return [];
    const query = `
      query ActiveSubs($offerIds: [numeric!]) {
        rows: oki_subs_subscription_current(
          where: {
            offer_id: { _in: $offerIds }
            status: { _eq: "active" }
          }
        ) {
          subscriber
          offer_id
          status
          next_billing_at
        }
      }
    `;
    const data = await hasura(query, { offerIds: SUB_OFFER_IDS });
    const now = Date.now();
    const out = [];
    for (const row of data.rows ?? []) {
        if (row.next_billing_at) {
            const expiry = Date.parse(row.next_billing_at);
            if (Number.isFinite(expiry) && expiry < now) continue;
        }
        const username = stripPrefix(row.subscriber);
        if (username) out.push({ username, expiresAt: null });
    }
    return out;
}

async function fetchRecentOnetimeBuyers() {
    if (ONETIME_OFFER_IDS.length === 0) return [];
    const cutoffIso = new Date(Date.now() - ONETIME_VALIDITY_MS).toISOString();
    const query = `
      query RecentPurchases($offerIds: [numeric!], $cutoff: timestamp!) {
        rows: oki_subs_onetime_purchases(
          where: {
            offer_id: { _in: $offerIds }
            indexer_ts: { _gt: $cutoff }
          }
          order_by: { indexer_ts: desc }
        ) {
          buyer
          offer_id
          indexer_ts
        }
      }
    `;
    const data = await hasura(query, { offerIds: ONETIME_OFFER_IDS, cutoff: cutoffIso });
    // Keep the MOST RECENT purchase per buyer so premium_expires_at
    // reflects their longest remaining window.
    const latest = new Map();
    for (const row of data.rows ?? []) {
        const username = stripPrefix(row.buyer);
        if (!username) continue;
        const ts = Date.parse(row.indexer_ts);
        if (!Number.isFinite(ts)) continue;
        const prev = latest.get(username);
        if (!prev || prev.purchasedAt < ts) {
            latest.set(username, { purchasedAt: ts, expiresAt: ts + ONETIME_VALIDITY_MS });
        }
    }
    return Array.from(latest.entries()).map(([username, v]) => ({
        username,
        expiresAt: new Date(v.expiresAt),
    }));
}

/**
 * Run one sync pass.
 * @returns {{ active: number, promoted: number, demoted: number, errors: number }}
 */
async function syncPremiumFromSubs() {
    let subEntries, onetimeEntries;
    try {
        [subEntries, onetimeEntries] = await Promise.all([
            fetchActiveSubscribers(),
            fetchRecentOnetimeBuyers(),
        ]);
    } catch (err) {
        console.error('[premiumSubsSync] Hasura query failed:', err.message);
        return { active: 0, promoted: 0, demoted: 0, errors: 1 };
    }

    // Merge: recurring sub wins over one-time when both present, by
    // dropping the explicit expires_at (recurring auto-renews).
    const active = new Map();
    for (const e of onetimeEntries) active.set(e.username, { expiresAt: e.expiresAt });
    for (const e of subEntries) active.set(e.username, { expiresAt: null });

    console.log(
        `[premiumSubsSync] Hasura: ${subEntries.length} subs + ${onetimeEntries.length} active 1-day passes = ${active.size} unique users`,
    );

    const db = getDb();
    const col = db.collection(PREMIUM_USERS_COLLECTION);
    const now = new Date();

    let promoted = 0;
    let demoted = 0;
    let errors = 0;

    for (const [username, info] of active) {
        try {
            if (ENABLE_MONGO_WRITES) {
                const existing = await col.findOne({ username }, { projection: { premium: 1, premium_source: 1 } });
                if (isForeignGrant(existing)) continue;
                const $set = {
                    premium: true,
                    premium_source: SOURCE_TAG,
                    premium_synced_at: now,
                };
                const $unset = {};
                if (info.expiresAt) {
                    $set.premium_expires_at = info.expiresAt;
                } else {
                    // Recurring sub: clear any prior one-time expiry so a
                    // user who upgrades from 1-day to monthly isn't still
                    // marked as expiring.
                    $unset.premium_expires_at = '';
                }
                const update = { $set, $setOnInsert: { username, banned: false } };
                if (Object.keys($unset).length) update.$unset = $unset;
                const r = await col.updateOne({ username }, update, { upsert: true });
                if (r.modifiedCount > 0 || r.upsertedCount > 0) promoted++;
            }
        } catch (err) {
            console.error(`[premiumSubsSync] Promote failed for ${username}:`, err.message);
            errors++;
        }
    }

    // Demote: anyone tagged 'subs' who's no longer in the active set.
    let stale;
    try {
        stale = await col.find(
            { premium: true, premium_source: SOURCE_TAG },
            { projection: { username: 1 } },
        ).toArray();
    } catch (err) {
        console.error('[premiumSubsSync] Stale-row scan failed:', err.message);
        return { active: active.size, promoted, demoted, errors: errors + 1 };
    }

    for (const row of stale) {
        const u = (row.username || '').toLowerCase();
        if (!u || active.has(u)) continue;
        try {
            if (ENABLE_MONGO_WRITES) {
                await col.updateOne(
                    { _id: row._id },
                    {
                        $set: { premium: false, premium_synced_at: now },
                        $unset: { premium_source: '', premium_expires_at: '' },
                    },
                );
                demoted++;
            }
        } catch (err) {
            console.error(`[premiumSubsSync] Demote failed for ${u}:`, err.message);
            errors++;
        }
    }

    // Expire Pro trial users whose 24h window is up. These rows are
    // tagged premium_source='testing' and were written by the hangouts-
    // api `/premium/start-testing` endpoint. We flip premium back off
    // and clear the source / expiry — but keep `testing_started` so the
    // user can't claim a second trial.
    let expiredTrials = 0;
    try {
        if (ENABLE_MONGO_WRITES) {
            const r = await col.updateMany(
                {
                    premium: true,
                    premium_source: 'testing',
                    premium_expires_at: { $lte: now },
                },
                {
                    $set: { premium: false, premium_synced_at: now },
                    $unset: { premium_source: '', premium_expires_at: '' },
                },
            );
            expiredTrials = r.modifiedCount || 0;
        }
    } catch (err) {
        console.error('[premiumSubsSync] Trial expiry sweep failed:', err.message);
        errors++;
    }

    console.log(
        `[premiumSubsSync] Done: ${active.size} active, ${promoted} promoted, ${demoted} demoted, ${expiredTrials} trial-expired, ${errors} errors`,
    );

    return { active: active.size, promoted, demoted, expiredTrials, errors };
}

module.exports = { syncPremiumFromSubs };
