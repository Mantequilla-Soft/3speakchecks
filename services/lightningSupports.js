/**
 * Lightning supports: tips paid over Lightning from the tip window's Lightning tab
 * (new-3speak-tv src/lib/lightningTip.js), recorded into the same `supports`
 * collection as Hive tips (routes/supports.js).
 *
 * The Hive tip route verifies a transfer from the tipper to the creator; a
 * Lightning tip has none. What it does have on chain: the moment a payment reaches
 * <account>@v4v.app, @v4vapp credits that account with a `v4vapp_transfer`
 * custom_json whose memo carries the payer's LNURL comment, and the tip window
 * puts the post's 3speak.tv link in that comment. So every credit whose memo
 * links a 3Speak post OF THE CREDITED ACCOUNT is a tip for that post. Reading
 * them from @v4vapp's history means a tip counts even when the viewer closed the
 * window before it was confirmed, and nothing a client says is trusted.
 *
 * Who paid: Lightning doesn't say. A viewer who paid from Hive through v4v.app
 * sent @v4vapp a transfer whose memo is the invoice, and that invoice's payment
 * hash is the credit's `parent_id`; that account is the tipper. Anyone else is
 * anonymous (`tipper: null`).
 *
 * Rows: `amount` in sats, `currency: 'SATS'`, `hbd_value: 0` (sats are shown as
 * sats, never converted), `trx_id` = the credit's, so a re-read never counts twice.
 *
 * Main thread, not a worker thread: a new file here only goes live with a restart.
 *
 * Env:
 *   LIGHTNING_SUPPORTS_ENABLED       default true
 *   LIGHTNING_SUPPORTS_INTERVAL_MIN  default 2
 *   LIGHTNING_SUPPORTS_BACKFILL_DAYS default 7 (first run after boot)
 */
const { getDb } = require('../utils/db');
const { historySince } = require('../utils/hive');
const { paymentHash, findInvoice } = require('../utils/bolt11');
const supports = require('../routes/supports');

const ENABLED = String(process.env.LIGHTNING_SUPPORTS_ENABLED || 'true').toLowerCase() !== 'false';
const INTERVAL_MIN = Math.max(1, parseInt(process.env.LIGHTNING_SUPPORTS_INTERVAL_MIN, 10) || 2);
const BACKFILL_DAYS = Math.max(1, parseInt(process.env.LIGHTNING_SUPPORTS_BACKFILL_DAYS, 10) || 7);

const V4V_ACCOUNT = 'v4vapp';
const CUSTOM_JSON_FILTER = 2 ** 18;
const TRANSFER_FILTER = 4;
// Re-read this much before where the last run stopped (clock skew, a block that
// landed mid-scan). Harmless: a credit already counted is skipped on its trx_id.
const OVERLAP_MS = 10 * 60 * 1000;
// The payer's transfer comes before the credit; an invoice from v4v.app is paid
// within its expiry, so an hour back covers it.
const PAYER_LOOKBACK_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The post link the tip window adds to the comment, in any of the site's forms.
const LINK_RE = /3speak\.tv\/(?:audio\/|watch\?v=|shorts\?v=|@)([a-z0-9.-]{3,16})\/([a-z0-9-]{1,255})/i;

let coveredUntilMs = null;
let running = false;

const enabled = () => ENABLED;
const tsMs = (raw) => Date.parse(`${raw}Z`);

/**
 * v4v.app memos read "<account> | <comment> #v4vapp #lightningaddress". Only the
 * comment is the tipper's; the rest is v4v.app's bookkeeping.
 */
function commentOf(memo, account) {
    let s = String(memo || '').trim();
    const prefix = `${account} |`;
    if (s.toLowerCase().startsWith(prefix)) s = s.slice(prefix.length);
    return s.replace(/(\s+#[a-z0-9_]+)+\s*$/i, '').trim();
}

/** Lightning credits from @v4vapp to a Hive account, from raw history entries. */
function creditsFrom(entries) {
    const out = [];
    for (const entry of entries) {
        const e = entry?.[1];
        const op = e?.op;
        if (!op || op[0] !== 'custom_json' || op[1].id !== 'v4vapp_transfer' || !e.trx_id) continue;
        if (!(op[1].required_auths || []).includes(V4V_ACCOUNT)) continue;
        let body;
        try { body = JSON.parse(op[1].json); } catch { continue; }
        const to = String(body?.to_account || '').toLowerCase();
        const sats = Number(body?.sats);
        if (body?.from_account !== V4V_ACCOUNT || !to || to === V4V_ACCOUNT || !(sats > 0) || !body.parent_id) continue;
        out.push({
            trx_id: e.trx_id,
            block: e.block,
            timestamp: e.timestamp,
            to,
            sats: Math.round(sats),
            memo: String(body.memo || ''),
            hash: Buffer.from(String(body.parent_id), 'base64').toString('hex'),
        });
    }
    return out;
}

/** payment hash → Hive account that paid that invoice from Hive through v4v.app. */
function payersFrom(entries) {
    const payers = new Map();
    for (const entry of entries) {
        const op = entry?.[1]?.op;
        if (!op || op[0] !== 'transfer' || op[1].to !== V4V_ACCOUNT) continue;
        const hash = paymentHash(findInvoice(op[1].memo));
        if (hash) payers.set(hash, String(op[1].from).toLowerCase());
    }
    return payers;
}

async function runOnce() {
    if (running) return;
    running = true;
    try {
        const scanStartedMs = Date.now();
        const sinceMs = coveredUntilMs ? coveredUntilMs - OVERLAP_MS : scanStartedMs - BACKFILL_DAYS * DAY_MS;
        const pageSize = coveredUntilMs ? 100 : 1000;
        const credits = creditsFrom(await historySince(V4V_ACCOUNT, sinceMs, CUSTOM_JSON_FILTER, { pageSize }))
            .filter((c) => tsMs(c.timestamp) >= sinceMs);

        const tips = [];
        for (const c of credits) {
            const m = LINK_RE.exec(c.memo);
            // Only a link to the credited account's own post counts.
            if (!m || m[1].toLowerCase() !== c.to) continue;
            tips.push({ ...c, permlink: m[2].toLowerCase() });
        }
        if (!tips.length) {
            coveredUntilMs = scanStartedMs;
            return;
        }

        const db = getDb();
        const coll = db.collection(supports.COLLECTION);
        await supports.ensureIndexes(coll);
        const known = new Set((await coll.find(
            { trx_id: { $in: tips.map((t) => t.trx_id) } },
            { projection: { trx_id: 1 } },
        ).toArray()).map((r) => r.trx_id));
        const fresh = tips.filter((t) => !known.has(t.trx_id));

        let payers = new Map();
        if (fresh.length) {
            const oldest = Math.min(...fresh.map((t) => tsMs(t.timestamp)));
            payers = payersFrom(await historySince(V4V_ACCOUNT, oldest - PAYER_LOOKBACK_MS, TRANSFER_FILTER, { pageSize }));
        }

        let recorded = 0;
        for (const t of fresh) {
            const content = await supports.findContent(db, t.to, t.permlink);
            if (!content) continue;
            const payer = payers.get(t.hash) || null;
            if (payer === t.to) continue; // a creator paying themselves is no support
            try {
                await coll.insertOne({
                    trx_id: t.trx_id,
                    tipper: payer,
                    author: t.to,
                    permlink: t.permlink,
                    kind: content.kind,
                    hbd_value: 0,
                    amount: t.sats,
                    currency: 'SATS',
                    hbd_per_hive: null,
                    via: 'lightning',
                    payment_hash: t.hash,
                    memo: supports.cleanMemo(commentOf(t.memo, t.to)),
                    block: t.block,
                    tippedAt: new Date(`${t.timestamp}Z`),
                    createdAt: new Date(),
                });
                recorded += 1;
            } catch (err) {
                if (!(err && err.code === 11000)) throw err;
            }
        }
        if (recorded) console.log(`[lightning-supports] recorded ${recorded} Lightning tip(s)`);
        coveredUntilMs = scanStartedMs;
    } catch (err) {
        console.error('[lightning-supports] run failed:', err && err.message);
    } finally {
        running = false;
    }
}

module.exports = { enabled, runOnce, INTERVAL_MIN, _test: { creditsFrom, payersFrom, commentOf, LINK_RE } };
