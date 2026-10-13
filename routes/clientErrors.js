/**
 * Client error reports
 * POST /client-errors   (text/plain JSON, sent with navigator.sendBeacon)
 *
 * The frontend's route error boundary ("This page didn't load") reports what
 * broke the page here, because the panel itself says little and the real error
 * only ever reached the visitor's console. Stored in Mongo `client_errors` and
 * kept 30 days (TTL). No account name, no IP: route, error, stack, app version
 * and browser only.
 *
 * Read them with e.g.
 *   db.client_errors.find().sort({ createdAt: -1 }).limit(20)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../utils/db');

const router = express.Router();
const COLLECTION = 'client_errors';
const KEEP_DAYS = 30;

// One bucket for everyone: the checker sees every visitor as nginx anyway,
// and this only has to stop a broken page from flooding the collection.
const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 300,
    keyGenerator: () => 'all',
    standardHeaders: false,
    legacyHeaders: false,
    validate: false,
    message: { error: 'Too many reports' },
});

let indexed = false;
async function ensureIndexes(coll) {
    if (indexed) return;
    indexed = true;
    try {
        await coll.createIndex({ createdAt: 1 }, { expireAfterSeconds: KEEP_DAYS * 24 * 3600 });
    } catch (err) {
        console.warn('[client-errors] index:', err.message);
    }
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

// sendBeacon posts text/plain (no CORS preflight), so parse the body ourselves.
router.post('/', limiter, express.text({ type: '*/*', limit: '16kb' }), async (req, res) => {
    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Path only: a query string can carry tokens (e.g. a HiveSigner callback).
    const route = (str(body.route, 300) || '').split('?')[0].split('#')[0];
    const doc = {
        kind: body.kind === 'chunk' ? 'chunk' : 'render',
        route,
        message: str(body.message, 500),
        stack: str(body.stack, 4000),
        componentStack: str(body.componentStack, 3000),
        appVersion: str(body.appVersion, 20),
        site: str(req.get('origin'), 80),
        userAgent: str(req.get('user-agent'), 300),
        createdAt: new Date(),
    };
    if (!doc.message && !doc.stack) return res.status(400).json({ error: 'Empty report' });

    try {
        const coll = getDb().collection(COLLECTION);
        await ensureIndexes(coll);
        await coll.insertOne(doc);
        console.warn(`[client-errors] ${doc.kind} on ${doc.route}: ${doc.message}`);
        res.status(204).end();
    } catch (err) {
        console.error('[client-errors] store failed:', err.message);
        res.status(500).json({ error: 'Could not store report' });
    }
});

module.exports = router;
