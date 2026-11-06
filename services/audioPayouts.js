/**
 * Pay-per-listen payout worker.
 *
 * Once per month (period = the previous calendar month, boundaries on the 1st
 * at 00:00 UTC) the liquid HBD + HIVE balance of the PPL_BENEFICIARY account is
 * distributed over every qualifying listen in `audio-listen-log` from that
 * month. The longer period lets the beneficiary account accumulate funds before
 * each payout. Each verified (logged-in) listen's value is split between the
 * track's author (owner) and the listener (username) by PPL_AUTHOR_SHARE
 * (default 1 = 100% to artists). Anonymous (IP-based) listens on a ppl track
 * also credit the author, but at PPL_ANON_LISTEN_WEIGHT (default 0.25) of a
 * verified listen — lower because an IP is cheap to forge and the self-listen
 * guard can't apply without an identity. Set it to 0 to ignore anon listens.
 *
 * Scheduling: a check runs every PPL_PAYOUT_CHECK_HOURS (default 12h). It
 * looks at the most recent month-start (1st, 00:00 UTC) boundary; if no payout
 * has been recorded for that period it runs one — so a missed month is caught
 * up on the next check.
 *
 * Money-safety:
 *  - No PPL_PAYOUT_ACTIVE_KEY (or PPL_PAYOUT_DRY_RUN=true) → DRY RUN: the
 *    plan is computed/logged but nothing is broadcast and no period claim is
 *    written, so a real run still happens later for that period.
 *  - A unique index on `periodEnd` + an in-progress claim row makes
 *    double-paying a period impossible even if checks overlap.
 *  - A crashed/partial payout is left status:'error' and is NOT auto-retried
 *    (retrying could double-pay early recipients) — needs manual review.
 *  - Transfers are irreversible; per-recipient failures are recorded and the
 *    rest continue.
 *
 * Entirely env-gated: schedule() still runs in dry-run mode without a key so
 * the plan is observable; it only moves funds once the key is set.
 */

const { Client, PrivateKey } = require('@hiveio/dhive');
const { getDb } = require('../utils/db');
const { HIVE_RPC_ENDPOINTS, PPL_BENEFICIARY } = require('../utils/config');

const PAYOUT_COLLECTION = 'audio-payouts';
const LISTEN_LOG_COLLECTION = 'audio-listen-log';

const SOURCE_ACCOUNT = (PPL_BENEFICIARY || '').trim();
const ACTIVE_KEY = (process.env.PPL_PAYOUT_ACTIVE_KEY || '').trim();
const FORCE_DRY_RUN = process.env.PPL_PAYOUT_DRY_RUN === 'true';
// Author's portion of each listen (0..1); listener gets the remainder.
// Defaults to 1 (100% to artists) when unset/invalid.
let AUTHOR_SHARE = parseFloat(process.env.PPL_AUTHOR_SHARE);
if (!Number.isFinite(AUTHOR_SHARE) || AUTHOR_SHARE < 0 || AUTHOR_SHARE > 1) AUTHOR_SHARE = 1;
const LISTENER_SHARE = 1 - AUTHOR_SHARE;
// Weight of an anonymous (IP-based) listen relative to a verified logged-in one
// (0..1). Anonymous listens on a ppl track credit the author this fraction of a
// normal listen — lower because an IP is cheaper to forge than a Hive account
// and the self-listen guard can't apply without an identity. 0 = ignore anon
// listens entirely (the pre-existing behaviour).
let ANON_WEIGHT = parseFloat(process.env.PPL_ANON_LISTEN_WEIGHT);
if (!Number.isFinite(ANON_WEIGHT) || ANON_WEIGHT < 0 || ANON_WEIGHT > 1) ANON_WEIGHT = 0.25;
const CHECK_HOURS = Math.max(1, parseFloat(process.env.PPL_PAYOUT_CHECK_HOURS || '12'));
const CHECK_MS = CHECK_HOURS * 60 * 60 * 1000;
// Hive transfer precision is 0.001; anything below rounds to nothing.
const MIN_AMOUNT = Math.max(0.001, parseFloat(process.env.PPL_PAYOUT_MIN || '0.001'));
// Optional one-off / testing override: pin the period end to a specific
// instant instead of the current month-start. Window is the calendar month
// immediately before periodEnd.
const PERIOD_END_OVERRIDE = (process.env.PPL_PAYOUT_PERIOD_END || '').trim();

let hiveClient = null;
function getClient() {
    if (hiveClient) return hiveClient;
    const nodes = HIVE_RPC_ENDPOINTS.filter((u) => /^https?:\/\//.test(u) && !/testnet/.test(u));
    hiveClient = new Client(nodes.length ? nodes : ['https://api.hive.blog']);
    return hiveClient;
}

const floor3 = (n) => Math.floor(n * 1000) / 1000;
const fmt3 = (n) => n.toFixed(3);
const parseAmt = (s) => parseFloat(String(s || '0').trim().split(' ')[0]) || 0;

// First day of the current month, 00:00:00 UTC (most recent month boundary).
function lastMonthBoundary(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}
// Exactly one calendar month before `periodEnd` (Date.UTC normalises the month
// underflow, e.g. Jan → previous Dec).
function monthBefore(periodEnd) {
    return new Date(Date.UTC(
        periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 1, periodEnd.getUTCDate(),
        periodEnd.getUTCHours(), periodEnd.getUTCMinutes(), periodEnd.getUTCSeconds(),
    ));
}

async function accountsExist(names) {
    const live = new Set();
    const client = getClient();
    for (let i = 0; i < names.length; i += 100) {
        const chunk = names.slice(i, i + 100);
        // eslint-disable-next-line no-await-in-loop
        const accts = await client.database.getAccounts(chunk).catch(() => []);
        for (const a of accts || []) live.add(a.name);
    }
    return live;
}

/**
 * Compute + (optionally) execute the payout for the month ending `periodEnd`.
 */
async function runPayout(now = new Date()) {
    const db = getDb();
    const col = db.collection(PAYOUT_COLLECTION);
    // Unique only over real period rows (periodEnd is a Date). The singleton
    // dry-run preview deliberately has no Date periodEnd so it never occupies
    // — or blocks — a period's claim slot.
    await col.createIndex(
        { periodEnd: 1 },
        { unique: true, partialFilterExpression: { periodEnd: { $type: 'date' } } },
    ).catch(() => {});
    await db.collection(LISTEN_LOG_COLLECTION)
        .createIndex({ paid: 1, createdAt: 1 }).catch(() => {});

    let periodEnd = lastMonthBoundary(now);
    if (PERIOD_END_OVERRIDE) {
        const o = new Date(PERIOD_END_OVERRIDE);
        if (!isNaN(o.getTime())) periodEnd = o;
        else console.error(`[pplPayout] PPL_PAYOUT_PERIOD_END="${PERIOD_END_OVERRIDE}" is not a valid date — using month boundary.`);
    }
    const periodStart = monthBefore(periodEnd);
    const tag = periodEnd.toISOString().slice(0, 10);
    const dryRun = FORCE_DRY_RUN || !ACTIVE_KEY;

    // Already handled this period?
    const existing = await col.findOne({ periodEnd });
    if (existing) {
        if (existing.status === 'completed') return; // done — silent
        if (existing.status === 'in_progress' || existing.status === 'error') {
            console.error(
                `[pplPayout] period ${tag} is status='${existing.status}' — NOT auto-retrying ` +
                `(could double-pay). Inspect/clear the audio-payouts row manually.`,
            );
            return;
        }
        if (existing.status === 'no_listens' || existing.status === 'empty_pool') return;
    }

    // Gather UNPAID listens in the window. Excluding paid:true makes a
    // double payout impossible even if windows ever overlap or a run is
    // re-triggered manually.
    const listenCol = db.collection(LISTEN_LOG_COLLECTION);
    // Fetch rows that can contribute to a payout:
    //  - full listens: payable !== false (verified logged-in, plus legacy rows
    //    that predate the field), and
    //  - anonymous listens on ppl tracks (payable:false, ppl:true) which earn
    //    the author a reduced share.
    // Non-ppl, self, and durationless rows are filtered out below.
    const listens = await listenCol
        .find({
            createdAt: { $gte: periodStart, $lt: periodEnd },
            paid: { $ne: true },
            $or: [{ payable: { $ne: false } }, { ppl: true }],
        })
        .project({ owner: 1, username: 1, payable: 1, ppl: 1, noDuration: 1 })
        .toArray();

    if (listens.length === 0) {
        if (!dryRun) await col.updateOne(
            { periodEnd },
            { $set: { periodStart, periodEnd, status: 'no_listens', ranAt: new Date(), listens: 0, recipients: 0 } },
            { upsert: true },
        );
        console.log(`[pplPayout] ${tag}: no listens in window — nothing to distribute.`);
        return;
    }

    // Accumulate split weights per account.
    //  - Full listen (payable !== false): author gets AUTHOR_SHARE, listener
    //    (the Hive username) gets LISTENER_SHARE — total weight 1.
    //  - Anonymous listen on a ppl track (no username, measured): author gets
    //    ANON_WEIGHT, no listener to credit.
    //  - Everything else (self-listen, non-ppl, durationless) contributes 0.
    const weight = new Map();
    const add = (acct, w) => { if (acct && w > 0) weight.set(acct, (weight.get(acct) || 0) + w); };
    let anonListens = 0;
    for (const l of listens) {
        if (l.payable !== false) {
            add(l.owner, AUTHOR_SHARE);
            add(l.username, LISTENER_SHARE);
        } else if (l.ppl === true && !l.username && l.noDuration !== true) {
            add(l.owner, ANON_WEIGHT);
            anonListens += 1;
        }
    }
    const totalWeight = [...weight.values()].reduce((a, b) => a + b, 0);

    // The window had rows but none qualified (all self / non-ppl / durationless,
    // or ANON_WEIGHT is 0). Nothing to distribute — record + return like an
    // empty window so the period is settled and not retried forever.
    if (totalWeight <= 0) {
        if (!dryRun) await col.updateOne(
            { periodEnd },
            { $set: { periodStart, periodEnd, status: 'no_listens', ranAt: new Date(), listens: listens.length, recipients: 0 } },
            { upsert: true },
        );
        console.log(`[pplPayout] ${tag}: ${listens.length} row(s) in window but none qualify for payout — nothing to distribute.`);
        return;
    }

    // Source account liquid balances.
    const [src] = await getClient().database.getAccounts([SOURCE_ACCOUNT]);
    if (!src) {
        console.error(`[pplPayout] source account @${SOURCE_ACCOUNT} not found.`);
        return;
    }
    const hbdPool = parseAmt(src.hbd_balance);
    const hivePool = parseAmt(src.balance);

    if (hbdPool < MIN_AMOUNT && hivePool < MIN_AMOUNT) {
        if (!dryRun) await col.updateOne(
            { periodEnd },
            { $set: { periodStart, periodEnd, status: 'empty_pool', ranAt: new Date(), listens: listens.length, recipients: 0, poolBalance: { hbd: hbdPool, hive: hivePool } } },
            { upsert: true },
        );
        console.log(`[pplPayout] ${tag}: pool empty (HBD ${hbdPool}, HIVE ${hivePool}) — skipping.`);
        return;
    }

    // Build the per-recipient plan.
    let plan = [];
    for (const [account, w] of weight) {
        const hbd = floor3((w / totalWeight) * hbdPool);
        const hive = floor3((w / totalWeight) * hivePool);
        if (hbd < MIN_AMOUNT && hive < MIN_AMOUNT) continue; // dust → rolls to next month
        plan.push({ account, weight: w, hbd, hive });
    }

    // Drop recipients whose Hive account no longer exists (a transfer to a
    // missing account fails the whole tx).
    const live = await accountsExist(plan.map((p) => p.account));
    const skipped = plan.filter((p) => !live.has(p.account)).map((p) => p.account);
    plan = plan.filter((p) => live.has(p.account));

    const totHbd = floor3(plan.reduce((s, p) => s + p.hbd, 0));
    const totHive = floor3(plan.reduce((s, p) => s + p.hive, 0));

    console.log(
        `[pplPayout] ${tag}: ${listens.length} listens (${anonListens} anon @${ANON_WEIGHT}x) → ${plan.length} recipients ` +
        `(author ${AUTHOR_SHARE}/listener ${LISTENER_SHARE}); pool HBD ${hbdPool}/HIVE ${hivePool}; ` +
        `distributing ${fmt3(totHbd)} HBD + ${fmt3(totHive)} HIVE` +
        (skipped.length ? `; skipped ${skipped.length} missing acct(s)` : '') +
        (dryRun ? ' [DRY RUN]' : ''),
    );

    if (dryRun) {
        // Don't claim the period — keep observable + let a real run catch up
        // once the key is configured.
        await col.updateOne(
            { _id: 'ppl-dry-run-latest' },
            { $set: {
                _id: 'ppl-dry-run-latest',
                // ISO strings, NOT a Date `periodEnd` — must not touch the
                // unique period index or it would block the real payout.
                windowStart: periodStart.toISOString(),
                windowEnd: periodEnd.toISOString(),
                ranAt: new Date(),
                listens: listens.length, recipients: plan.length,
                poolBalance: { hbd: hbdPool, hive: hivePool },
                wouldDistribute: { hbd: fmt3(totHbd), hive: fmt3(totHive) },
                authorShare: AUTHOR_SHARE,
                plan: plan.map((p) => ({ account: p.account, hbd: fmt3(p.hbd), hive: fmt3(p.hive) })),
                skipped,
            } },
            { upsert: true },
        );
        return;
    }

    // ── Real payout: atomically claim the period first ──────────────────────
    try {
        await col.insertOne({
            periodEnd, periodStart, status: 'in_progress',
            startedAt: new Date(), authorShare: AUTHOR_SHARE,
            listens: listens.length,
            poolBalance: { hbd: hbdPool, hive: hivePool },
        });
    } catch (err) {
        if (err && err.code === 11000) {
            console.log(`[pplPayout] ${tag}: period already claimed by another run — skipping.`);
            return;
        }
        throw err;
    }

    const key = PrivateKey.fromString(ACTIVE_KEY);
    const memo = `3Speak pay-per-listen ${periodStart.toISOString().slice(0, 10)}..${tag}`;
    const results = [];
    // Running totals of what was actually sent, in thousandths: integer sums do
    // not drift the way a float sum floored at every step does.
    let paidHbdMilli = 0;
    let paidHiveMilli = 0;
    const milli = (n) => Math.round(Number(fmt3(n)) * 1000);

    for (const p of plan) {
        const ops = [];
        if (p.hbd >= MIN_AMOUNT) ops.push(['transfer', { from: SOURCE_ACCOUNT, to: p.account, amount: `${fmt3(p.hbd)} HBD`, memo }]);
        if (p.hive >= MIN_AMOUNT) ops.push(['transfer', { from: SOURCE_ACCOUNT, to: p.account, amount: `${fmt3(p.hive)} HIVE`, memo }]);
        if (ops.length === 0) continue;
        try {
            // eslint-disable-next-line no-await-in-loop
            const tx = await getClient().broadcast.sendOperations(ops, key);
            if (p.hbd >= MIN_AMOUNT) paidHbdMilli += milli(p.hbd);
            if (p.hive >= MIN_AMOUNT) paidHiveMilli += milli(p.hive);
            results.push({ account: p.account, hbd: fmt3(p.hbd), hive: fmt3(p.hive), status: 'ok', txId: tx.id });
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            console.error(`[pplPayout] ${tag}: transfer to @${p.account} failed: ${msg}`);
            results.push({ account: p.account, hbd: fmt3(p.hbd), hive: fmt3(p.hive), status: 'error', error: msg });
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1200)); // node-friendly throttle
    }

    const failures = results.filter((r) => r.status === 'error').length;
    const paidHbdStr = (paidHbdMilli / 1000).toFixed(3);
    const paidHiveStr = (paidHiveMilli / 1000).toFixed(3);
    await col.updateOne(
        { periodEnd },
        { $set: {
            status: failures ? 'error' : 'completed',
            finishedAt: new Date(),
            recipients: results.filter((r) => r.status === 'ok').length,
            failures,
            totals: { hbd: paidHbdStr, hive: paidHiveStr },
            skipped,
            details: results,
        } },
    );

    // Stamp the settled listens so they're never paid again and the payout
    // is auditable per listen. Only on a clean run — if any transfer failed
    // the period needs manual review, so leave its listens unpaid.
    if (failures === 0) {
        const perListenHbd = floor3(hbdPool / totalWeight);
        const perListenHive = floor3(hivePool / totalWeight);
        const upd = await listenCol.updateMany(
            // Same set the payout read (full + anon-ppl rows) so every counted
            // listen is flagged paid and can't be re-counted on a manual re-run.
            { createdAt: { $gte: periodStart, $lt: periodEnd }, paid: { $ne: true }, $or: [{ payable: { $ne: false } }, { ppl: true }] },
            { $set: {
                paid: true,
                paidAt: new Date(),
                payoutPeriodEnd: periodEnd,
                paidValue: { hbd: fmt3(perListenHbd), hive: fmt3(perListenHive) },
            } },
        );
        await col.updateOne({ periodEnd }, { $set: { listensMarkedPaid: upd.modifiedCount } });
    }

    console.log(
        `[pplPayout] ${tag}: ${failures ? 'COMPLETED WITH ERRORS' : 'completed'} — ` +
        `paid ${paidHbdStr} HBD + ${paidHiveStr} HIVE to ` +
        `${results.filter((r) => r.status === 'ok').length} accounts` +
        (failures ? `, ${failures} failed (status='error', will NOT auto-retry)` : ''),
    );
}

/** Wire into server boot. Runs in dry-run without a key (still observable). */
function schedule() {
    if (!SOURCE_ACCOUNT) {
        console.log('[pplPayout] disabled — PPL_BENEFICIARY is not set.');
        return;
    }
    if (ACTIVE_KEY && !FORCE_DRY_RUN) {
        try { PrivateKey.fromString(ACTIVE_KEY); }
        catch (err) {
            console.error(`[pplPayout] disabled — PPL_PAYOUT_ACTIVE_KEY does not parse: ${err.message}`);
            return;
        }
    }
    const mode = (ACTIVE_KEY && !FORCE_DRY_RUN) ? 'LIVE' : 'DRY RUN';
    console.log(
        `[pplPayout] scheduled — checking every ${CHECK_HOURS}h, monthly period (previous calendar month), ` +
        `source @${SOURCE_ACCOUNT}, author/listener ${AUTHOR_SHARE}/${LISTENER_SHARE} [${mode}] (first check in 1min)`,
    );
    setTimeout(() => {
        runPayout().catch((err) => console.error('[pplPayout] tick error:', err));
        setInterval(() => {
            runPayout().catch((err) => console.error('[pplPayout] tick error:', err));
        }, CHECK_MS);
    }, 60 * 1000);
}

module.exports = { schedule, runPayout, lastMonthBoundary };
