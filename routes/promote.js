const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { validateApiKey } = require('../utils/middleware');
const { hiveRpcBatch } = require('../utils/hive');
const { PROMOTION_ACCOUNT, COST_PER_24H_PROMOTION_HBD, MAX_PROMOTION_DAYS } = require('../utils/config');

const DAY_MS = 24 * 60 * 60 * 1000;

// Unique index on trx_id makes payment dedup atomic (race/replay safe). Ensured
// once per process, lazily, the first time a claim runs.
let paymentIndexEnsured = false;
async function ensurePaymentIndex(coll) {
    if (paymentIndexEnsured) return;
    try { await coll.createIndex({ trx_id: 1 }, { unique: true }); } catch (_) { /* already exists */ }
    paymentIndexEnsured = true;
}

// HBD per HIVE from the on-chain median price feed. Used to value HIVE payments.
async function getHbdPerHive() {
    const [res] = await hiveRpcBatch([{
        jsonrpc: '2.0', method: 'condenser_api.get_current_median_history_price', params: [], id: 1,
    }]);
    const base = parseFloat(res?.result?.base);   // X HBD
    const quote = parseFloat(res?.result?.quote); // Y HIVE
    if (!base || !quote) return 0;
    return base / quote;
}

// Parse a Hive asset string ("1.234 HBD") into { amount, symbol }.
function parseAsset(str) {
    const [amount, symbol] = String(str || '').trim().split(' ');
    return { amount: parseFloat(amount) || 0, symbol: (symbol || '').toUpperCase() };
}

// Public: cost / recipient / current price so the frontend can show the price
// and build the transfer. No auth — it's just public config + a chain read.
router.get('/promote/quote', async (req, res) => {
    try {
        const hbdPerHive = await getHbdPerHive();
        res.json({
            success: true,
            account: PROMOTION_ACCOUNT,
            costPer24hHbd: COST_PER_24H_PROMOTION_HBD,
            maxDays: MAX_PROMOTION_DAYS,
            hbdPerHive,
        });
    } catch (error) {
        console.error('Error building promote quote:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Public: current promotion status for a video. The promote UI uses this as the
// authoritative check to block promoting while a promotion is still active.
router.get('/promote/status/:author/:permlink', async (req, res) => {
    try {
        const db = getDb();
        const { author, permlink } = req.params;
        const embedDoc = await db.collection('embed-video').findOne(
            { $or: [{ owner: author, permlink }, { hive_author: author, hive_permlink: permlink }] },
            { projection: { promotedUntil: 1 } },
        );
        const videoDoc = embedDoc ? null : await db.collection('videos').findOne(
            { owner: author, permlink }, { projection: { promotedUntil: 1 } },
        );
        const until = embedDoc?.promotedUntil || videoDoc?.promotedUntil || null;
        const promoted = until ? new Date(until).getTime() > Date.now() : false;
        res.json({ success: true, promotedUntil: until, promoted });
    } catch (error) {
        console.error('Error fetching promote status:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Verify an on-chain promotion payment and credit the video with promotedUntil.
// The frontend broadcasts a `transfer` to PROMOTION_ACCOUNT with memo
// `promote:<author>/<permlink>` (signed by a front-facing wallet), then calls
// this. We read PROMOTION_ACCOUNT's recent transfer history, match by memo,
// dedup processed txids, value HBD + HIVE-equivalent, and extend promotedUntil
// (capped at MAX_PROMOTION_DAYS from now). App-key gated; security comes from the
// on-chain check, not the key.
router.put('/promote/claim', validateApiKey, async (req, res) => {
    const db = getDb();
    try {
        const { author, permlink } = req.body;
        if (!author || !permlink) {
            return res.status(400).json({ success: false, error: 'Invalid request', message: 'author and permlink are required' });
        }

        const embedVideoCollection = db.collection('embed-video');
        const videosCollection = db.collection('videos');
        const paymentsCollection = db.collection('promotion_payments');

        const embedDoc = await embedVideoCollection.findOne({
            $or: [{ owner: author, permlink }, { hive_author: author, hive_permlink: permlink }],
        });
        const videoDoc = await videosCollection.findOne({ owner: author, permlink });
        if (!embedDoc && !videoDoc) {
            // Likely still encoding / not indexed yet. Don't mark anything processed
            // so a retry can apply the payment once the doc exists.
            return res.status(404).json({ success: false, error: 'Video not indexed yet', message: 'The video is not indexed yet — please try again in a moment.' });
        }

        // Pull recent transfer ops involving the promotion account.
        // operation filter (low) for `transfer` (op id 2) = 1<<2 = 4.
        const [histRes] = await hiveRpcBatch([{
            jsonrpc: '2.0', method: 'condenser_api.get_account_history',
            params: [PROMOTION_ACCOUNT, -1, 1000, 4, 0], id: 1,
        }]);
        const ops = Array.isArray(histRes?.result) ? histRes.result : [];

        const memoWanted = `promote:${author}/${permlink}`.toLowerCase();
        const matches = [];
        for (const entry of ops) {
            const op = entry?.[1]?.op;
            const trxId = entry?.[1]?.trx_id;
            if (!op || op[0] !== 'transfer' || !trxId) continue;
            const t = op[1];
            if (t.to !== PROMOTION_ACCOUNT) continue;
            if (String(t.memo || '').trim().toLowerCase() !== memoWanted) continue;
            matches.push({ trxId, from: t.from, amount: t.amount });
        }

        if (matches.length === 0) {
            return res.status(404).json({ success: false, error: 'No payment found', message: 'No matching transfer to the promotion account was found yet.' });
        }

        // Atomically RESERVE each txid before crediting. A unique index on trx_id
        // means a concurrent claim (or a replayed request) inserting the same txid
        // fails with a duplicate-key error, so each on-chain payment is counted
        // exactly once — read-then-write can't race into a double credit.
        await ensurePaymentIndex(paymentsCollection);
        const nowDate = new Date();
        const reserved = [];
        for (const m of matches) {
            try {
                await paymentsCollection.insertOne({
                    trx_id: m.trxId, author, permlink, from: m.from, amount: m.amount, processedAt: nowDate,
                });
                reserved.push(m);
            } catch (e) {
                if (e?.code !== 11000) throw e; // already processed → skip
            }
        }

        const existingUntil = Math.max(
            new Date(embedDoc?.promotedUntil || 0).getTime() || 0,
            new Date(videoDoc?.promotedUntil || 0).getTime() || 0,
        );

        if (reserved.length === 0) {
            return res.json({ success: true, message: 'Already credited', promotedUntil: existingUntil ? new Date(existingUntil).toISOString() : null, addedDays: 0 });
        }

        // Value is derived ONLY from the actual on-chain amounts — never from the
        // client. HIVE is valued at the on-chain median price.
        const hbdPerHive = await getHbdPerHive();
        let valueHbd = 0;
        for (const m of reserved) {
            const { amount, symbol } = parseAsset(m.amount);
            if (symbol === 'HBD') valueHbd += amount;
            else if (symbol === 'HIVE') valueHbd += amount * hbdPerHive;
        }

        const addedDays = valueHbd / COST_PER_24H_PROMOTION_HBD;
        const now = Date.now();
        const base = Math.max(now, existingUntil);
        const cap = now + MAX_PROMOTION_DAYS * DAY_MS;
        const newUntil = Math.min(base + addedDays * DAY_MS, cap);
        const promotedUntilDate = new Date(newUntil);

        try {
            if (embedDoc) {
                await embedVideoCollection.updateOne({ _id: embedDoc._id }, { $set: { promotedUntil: promotedUntilDate } });
            }
            if (videoDoc) {
                await videosCollection.updateOne({ _id: videoDoc._id }, { $set: { promotedUntil: promotedUntilDate } });
            }
        } catch (creditErr) {
            // Roll back the reservation so the (real) payment isn't lost on a transient DB error.
            await paymentsCollection.deleteMany({ trx_id: { $in: reserved.map(m => m.trxId) } }).catch(() => {});
            throw creditErr;
        }

        console.log(`Promotion credited for ${author}/${permlink}: +${addedDays.toFixed(2)}d (${valueHbd.toFixed(3)} HBD) → ${promotedUntilDate.toISOString()}`);
        res.json({ success: true, message: 'Promotion credited', promotedUntil: promotedUntilDate.toISOString(), addedDays, valueHbd });
    } catch (error) {
        console.error('Error claiming promotion:', error);
        res.status(500).json({ success: false, error: 'Internal server error', message: 'Failed to verify promotion payment' });
    }
});

module.exports = router;
