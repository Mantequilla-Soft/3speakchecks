/**
 * /scheduled-posts routes — user-facing API for the scheduled-posts feature.
 *
 * Write paths (POST create, POST cancel) require a Hive posting-key signature
 * from the owner, so a stranger can't queue or cancel posts on behalf of
 * another user. Read paths are public.
 *
 * Signed message format:
 *   create: scheduled-post|create|<owner>|<permlink>|<scheduledOnIso>|<timestamp>
 *   cancel: scheduled-post|cancel|<owner>|<permlink>|<timestamp>
 */

const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const { verifyHiveSignedMessage } = require('../utils/hiveAuth');
const { validateApiKey } = require('../utils/middleware');
const { COLLECTION, hasThreespeakPostingAuthority } = require('../services/scheduledPosts');
const { SIGNATURE_TIMESTAMP_TOLERANCE_MS, HIVE_AUTH_REQUIRED } = require('../utils/config');

const VALID_PAYOUT = new Set(['default', 'powerup', 'decline']);
// Backend floor is 5 minutes (slack for cron drift / clock skew); the frontend
// keeps a stricter 15-minute floor for the schedule picker.
const MIN_LEAD_MS = 5 * 60 * 1000;
const MAX_LEAD_MS = 90 * 24 * 60 * 60 * 1000; // and no more than 90 days

function buildCreateMessage({ owner, permlink, scheduledOn, timestamp }) {
    return ['scheduled-post', 'create', owner, permlink, scheduledOn, String(timestamp)].join('|');
}
function buildCancelMessage({ owner, permlink, timestamp }) {
    return ['scheduled-post', 'cancel', owner, permlink, String(timestamp)].join('|');
}
function buildUpdateMessage({ owner, permlink, timestamp }) {
    return ['scheduled-post', 'update', owner, permlink, String(timestamp)].join('|');
}

async function verifySignedPayload({ message, signature, owner }) {
    if (!HIVE_AUTH_REQUIRED) return true;
    return verifyHiveSignedMessage({ message, signature, username: owner });
}

function badTimestamp(ts) {
    const n = parseInt(ts, 10);
    if (!Number.isFinite(n)) return 'invalid';
    if (Math.abs(Date.now() - n) > SIGNATURE_TIMESTAMP_TOLERANCE_MS) return 'out of tolerance';
    return null;
}

/* ─── POST /scheduled-posts/create ────────────────────────────────────── */
router.post('/create', validateApiKey, express.json({ limit: '2mb' }), async (req, res) => {
    try {
        const {
            owner,
            permlink,
            scheduledOn,           // ISO-8601 string
            title = '',
            description = '',
            body,                  // full post body — frontend builds it (description + embed URL etc.)
            tags = [],
            jsonMetadata,          // optional; if missing, we build a minimal one from app/tags
            beneficiaries = [],
            payoutOptions = 'default',
            thumbnail = null,
            parentAuthor = '',
            parentPermlink = 'hive-181335',
            embedPermlink = null,   // embedvideos service's internal permlink; lets the cron link the video record to the broadcast Hive post afterwards
            reblog = false,         // "Add to my blog": the cron reblogs the post onto the owner's blog after posting
        } = req.body || {};

        // ─── basic validation ──────────────────────────────────────────
        if (!owner || typeof owner !== 'string') {
            return res.status(422).json({ error: 'owner is required' });
        }
        if (!permlink || typeof permlink !== 'string') {
            return res.status(422).json({ error: 'permlink is required' });
        }
        const scheduledMs = Date.parse(scheduledOn);
        if (!Number.isFinite(scheduledMs)) {
            return res.status(422).json({ error: 'scheduledOn must be a valid ISO-8601 date' });
        }
        const leadMs = scheduledMs - Date.now();
        if (leadMs < MIN_LEAD_MS || leadMs > MAX_LEAD_MS) {
            return res.status(422).json({ error: 'scheduledOn must be between 5 minutes and 90 days from now' });
        }
        if (!VALID_PAYOUT.has(String(payoutOptions).toLowerCase())) {
            return res.status(422).json({ error: 'payoutOptions must be default | powerup | decline' });
        }

        // ─── authorize: app key (validateApiKey) + on-chain @threespeak grant ──
        // We use the app-key trust model (same as PUT /video/thumbnail and the
        // /api/broadcast app-key path) instead of a client Hive signature, because
        // HiveSigner / ManteAuth can't sign arbitrary messages client-side. Safety
        // comes from requiring that `owner` has granted @threespeak posting
        // authority on-chain — without that grant the cron couldn't broadcast for
        // them anyway, so the worst case is "act as a user who opted into @threespeak".
        let granted;
        try {
            granted = await hasThreespeakPostingAuthority(owner);
        } catch (err) {
            console.error('[scheduledPosts] posting-auth check error:', err.message || err);
            return res.status(502).json({ error: 'Could not verify posting authority' });
        }
        if (!granted) {
            return res.status(403).json({ error: 'owner has not granted @threespeak posting authority' });
        }

        // ─── upsert (allow re-scheduling a not-yet-posted entry) ──────
        const db = await getDb();
        const coll = db.collection(COLLECTION);

        const now = new Date();
        const finalJsonMetadata = jsonMetadata && typeof jsonMetadata === 'object'
            ? jsonMetadata
            : { app: '3speak/embed', tags: Array.isArray(tags) ? tags : [] };

        const doc = {
            owner,
            permlink,
            status: 'scheduled',
            scheduledOn: new Date(scheduledMs),
            title,
            description,
            body: body || description, // body is what gets broadcast; fall back to description.
            tags: Array.isArray(tags) ? tags : [],
            jsonMetadata: finalJsonMetadata,
            beneficiaries: Array.isArray(beneficiaries) ? beneficiaries : [],
            payoutOptions: String(payoutOptions).toLowerCase(),
            thumbnail,
            parentAuthor,
            parentPermlink,
            embedPermlink,
            reblog: reblog === true,
            attempts: 0,
            lastError: null,
            createdAt: now,
            updatedAt: now,
        };

        try {
            const result = await coll.findOneAndUpdate(
                { owner, permlink },
                { $set: doc },
                { upsert: true, returnDocument: 'after' },
            );
            const saved = result && (result.value || result);
            return res.status(201).json({ success: true, id: saved && saved._id, scheduledOn: doc.scheduledOn });
        } catch (err) {
            // Duplicate-key on (owner, permlink) shouldn't happen under upsert,
            // but surface it loudly if it ever does.
            console.error('[scheduledPosts] create error:', err.message || err);
            return res.status(500).json({ error: 'Could not save scheduled post' });
        }
    } catch (err) {
        console.error('[scheduledPosts] /create unexpected error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/* ─── GET /scheduled-posts/:username ──────────────────────────────────── */
router.get('/:username', async (req, res) => {
    try {
        const owner = String(req.params.username || '').trim().toLowerCase();
        if (!owner) return res.status(400).json({ error: 'username required' });

        const status = req.query.status ? String(req.query.status) : null;
        const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);

        const db = await getDb();
        const query = { owner };
        if (status) query.status = status;

        const docs = await db.collection(COLLECTION)
            .find(query)
            .sort({ scheduledOn: 1 })
            .limit(limit)
            .toArray();

        // Strip the large `body` / `jsonMetadata` fields from the list view to keep responses small.
        const list = docs.map(d => ({
            id: d._id,
            owner: d.owner,
            permlink: d.permlink,
            status: d.status,
            scheduledOn: d.scheduledOn,
            title: d.title,
            description: d.description,
            tags: d.tags,
            beneficiaries: d.beneficiaries,
            payoutOptions: d.payoutOptions,
            thumbnail: d.thumbnail,
            postedAt: d.postedAt || null,
            broadcastTxId: d.broadcastTxId || null,
            lastError: d.lastError || null,
            attempts: d.attempts || 0,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
        }));

        return res.json({ count: list.length, scheduled_posts: list });
    } catch (err) {
        console.error('[scheduledPosts] /:username error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/* ─── POST /scheduled-posts/update ────────────────────────────────────── */
// Edit a still-`scheduled` post: title/description/body/scheduledOn/tags/
// beneficiaries/payoutOptions/thumbnail/jsonMetadata/embedPermlink can all
// change. Posts already in `processing`, `posted`, `cancelled`, or `failed`
// states are immutable — the route returns 404 / 409 for those.
router.post('/update', validateApiKey, express.json({ limit: '2mb' }), async (req, res) => {
    try {
        const { owner, permlink, updates } = req.body || {};

        if (!owner || typeof owner !== 'string') return res.status(422).json({ error: 'owner required' });
        if (!permlink || typeof permlink !== 'string') return res.status(422).json({ error: 'permlink required' });
        if (!updates || typeof updates !== 'object') return res.status(422).json({ error: 'updates object required' });

        // Authorize via app key (validateApiKey) + on-chain @threespeak grant — same
        // model as /create (see note there). No client Hive signature required.
        let granted;
        try {
            granted = await hasThreespeakPostingAuthority(owner);
        } catch (err) {
            console.error('[scheduledPosts] posting-auth check error:', err.message || err);
            return res.status(502).json({ error: 'Could not verify posting authority' });
        }
        if (!granted) {
            return res.status(403).json({ error: 'owner has not granted @threespeak posting authority' });
        }

        // Whitelist of fields the user can edit — never lets the client touch
        // status / attempts / postedAt / broadcastTxId etc.
        const ALLOWED = [
            'title', 'description', 'body', 'tags', 'jsonMetadata',
            'beneficiaries', 'payoutOptions', 'thumbnail',
            'parentAuthor', 'parentPermlink', 'embedPermlink', 'reblog',
        ];
        const $set = { updatedAt: new Date() };
        for (const k of ALLOWED) {
            if (Object.prototype.hasOwnProperty.call(updates, k)) {
                $set[k] = updates[k];
            }
        }
        if ('reblog' in $set) $set.reblog = $set.reblog === true;
        if (Object.prototype.hasOwnProperty.call(updates, 'payoutOptions')) {
            const v = String(updates.payoutOptions).toLowerCase();
            if (!VALID_PAYOUT.has(v)) {
                return res.status(422).json({ error: 'payoutOptions must be default | powerup | decline' });
            }
            $set.payoutOptions = v;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'scheduledOn')) {
            const ms = Date.parse(updates.scheduledOn);
            if (!Number.isFinite(ms)) {
                return res.status(422).json({ error: 'scheduledOn must be a valid ISO-8601 date' });
            }
            const lead = ms - Date.now();
            if (lead < MIN_LEAD_MS || lead > MAX_LEAD_MS) {
                return res.status(422).json({ error: 'scheduledOn must be between 5 minutes and 90 days from now' });
            }
            $set.scheduledOn = new Date(ms);
            // Re-arming the schedule: zero the failure bookkeeping so the cron
            // gets a fresh shot at it.
            $set.attempts = 0;
            $set.lastError = null;
        }

        const db = await getDb();

        // Keep jsonMetadata (the actual broadcast payload) in sync with field-level
        // edits. Tags and thumbnail changes both live in jsonMetadata too (tags
        // array + top-level `image: [url]` + nested `video.thumbnail`). Without
        // this, the cron would broadcast with stale metadata while the doc fields
        // show the new values.
        const fieldsThatAffectJsonMeta = ['tags', 'thumbnail'];
        const touchesJsonMeta = fieldsThatAffectJsonMeta.some(
            k => Object.prototype.hasOwnProperty.call(updates, k)
        );
        if (touchesJsonMeta) {
            const current = await db.collection(COLLECTION).findOne(
                { owner, permlink, status: 'scheduled' },
                { projection: { jsonMetadata: 1 } },
            );
            if (current) {
                const meta = Object.assign({}, current.jsonMetadata || {});
                if (Object.prototype.hasOwnProperty.call(updates, 'tags')) {
                    meta.tags = Array.isArray(updates.tags) ? updates.tags : [];
                }
                if (Object.prototype.hasOwnProperty.call(updates, 'thumbnail')) {
                    const t = updates.thumbnail;
                    if (t) {
                        meta.image = [t];
                        meta.video = Object.assign({}, meta.video || {});
                        meta.video.thumbnail = t;
                    } else {
                        delete meta.image;
                        if (meta.video) delete meta.video.thumbnail;
                    }
                }
                $set.jsonMetadata = meta;
            }
        }

        const result = await db.collection(COLLECTION).findOneAndUpdate(
            { owner, permlink, status: 'scheduled' },
            { $set },
            { returnDocument: 'after' },
        );
        const saved = result && (result.value || result);
        if (!saved) {
            // Either the doc doesn't exist or it's already past the editable state.
            return res.status(404).json({ error: 'No editable scheduled post found (must be in status=scheduled)' });
        }
        return res.json({ success: true, id: saved._id, scheduledOn: saved.scheduledOn });
    } catch (err) {
        console.error('[scheduledPosts] /update error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/* ─── POST /scheduled-posts/cancel ────────────────────────────────────── */
router.post('/cancel', validateApiKey, express.json(), async (req, res) => {
    try {
        const { owner, permlink } = req.body || {};
        if (!owner || !permlink) return res.status(422).json({ error: 'owner and permlink required' });

        // Authorize via app key (validateApiKey) + on-chain @threespeak grant — same
        // model as /create. No client Hive signature required.
        let granted;
        try {
            granted = await hasThreespeakPostingAuthority(owner);
        } catch (err) {
            console.error('[scheduledPosts] posting-auth check error:', err.message || err);
            return res.status(502).json({ error: 'Could not verify posting authority' });
        }
        if (!granted) {
            return res.status(403).json({ error: 'owner has not granted @threespeak posting authority' });
        }

        const db = await getDb();
        const result = await db.collection(COLLECTION).findOneAndUpdate(
            { owner, permlink, status: { $in: ['scheduled', 'failed'] } },
            { $set: { status: 'cancelled', updatedAt: new Date() } },
            { returnDocument: 'after' },
        );
        const saved = result && (result.value || result);
        if (!saved) return res.status(404).json({ error: 'No cancellable scheduled post found' });
        return res.json({ success: true, id: saved._id, status: saved.status });
    } catch (err) {
        console.error('[scheduledPosts] /cancel error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
