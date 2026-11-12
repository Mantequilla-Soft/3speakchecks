const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const { GATEWAY_HOSTS } = require('../utils/adGateways');
const { s3CopyOf, s3UrlsFor } = require('../utils/s3Storage');
const { grabFrame, ffmpegAvailable, uploadImage } = require('../utils/videoFrame');
const { pickThumbnail } = require('./thumbnailSync');
const {
    ENABLE_MONGO_WRITES,
    IMAGE_UPLOAD_URL,
    IMAGE_UPLOAD_KEY,
    THUMBNAIL_FRAME_BATCH,
    THUMBNAIL_FRAME_MIN_AGE_MIN,
    THUMBNAIL_FRAME_RETRY_H,
    THUMBNAIL_FRAME_MAX_ATTEMPTS,
} = require('../utils/config');

// Last resort for a video with NO thumbnail anywhere: a frame from the video
// itself becomes its thumbnail.
//
// Some apps upload without one (snapie-mobile and hivesuite.app shorts, Ecency
// shorts with an empty post), and their Hive post carries no image either, so
// thumbnailSync has nothing to copy and the card shows the 3Speak placeholder
// forever. 960 of the 1,740 such videos on 2026-11-09 were shorts.
//
// Only once there really is nothing else:
//   - thumbnailSync has already read the post and found no image
//     (thumbnail_sync_checked_at is set), and the upload is old enough that the
//     uploading app has had its chance to add one;
//   - the post is read once more right before, and an image there wins over a
//     frame;
//   - the write re-asserts "still empty", so it never replaces a thumbnail that
//     arrived in the meantime.
// A frame that cannot be made is retried a few times, then left alone.

const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;
const EMPTY = [{ thumbnail_url: null }, { thumbnail_url: { $exists: false } }, { thumbnail_url: '' }];

let ffmpegChecked = null;   // memoised: true / false once probed

/**
 * A frame from the first gateway that yields one, at 1 s in. The very start is
 * tried only when ffmpeg ran to the end and found nothing at 1 s (a clip shorter
 * than that); a gateway that stalled is simply passed over.
 */
async function frameFor(manifestCid, doc = null) {
    // The S3 copy first when there is one: an archived video may be gone from IPFS.
    const urls = [
        ...s3UrlsFor(s3CopyOf(doc, manifestCid)),
        ...GATEWAY_HOSTS.map((host) => `https://${host}/ipfs/${manifestCid}/manifest.m3u8`),
    ];
    for (const url of urls) {
        const first = await grabFrame(url, 1);
        if (first.frame) return first.frame;
        if (first.timedOut) continue;
        const start = await grabFrame(url, 0);
        if (start.frame) return start.frame;
    }
    return null;
}

/** author/permlink -> the image on the live post (null = none), for the docs given. */
async function postImages(docs) {
    const out = new Map();
    const rpc = docs.map((d, id) => ({
        jsonrpc: '2.0', id, method: 'condenser_api.get_content', params: [d.hive_author, d.hive_permlink],
    }));
    const results = await hiveRpcBatch(rpc);
    for (const r of results || []) {
        const post = r && r.result;
        if (!post || !post.author) continue;   // unreadable or deleted: no answer, try later
        out.set(`${post.author}/${post.permlink}`, pickThumbnail(post));
    }
    return out;
}

async function generateFrameThumbnails() {
    if (!IMAGE_UPLOAD_KEY) return { skipped: 'no IMAGE_UPLOAD_KEY' };
    if (ffmpegChecked === null) {
        ffmpegChecked = await ffmpegAvailable();
        if (!ffmpegChecked) console.error('[thumbnailFrame] ffmpeg not found: frame thumbnails are off');
    }
    if (!ffmpegChecked) return { skipped: 'no ffmpeg' };

    const ev = getDb().collection('embed-video');
    const now = Date.now();
    const oldEnough = new Date(now - THUMBNAIL_FRAME_MIN_AGE_MIN * 60 * 1000);
    const retryBefore = new Date(now - THUMBNAIL_FRAME_RETRY_H * 60 * 60 * 1000);

    const docs = await ev.find({
        status: 'published',
        gated: { $ne: true },
        manifest_cid: { $type: 'string' },
        hive_author: { $type: 'string' },
        hive_permlink: { $type: 'string' },
        thumbnail_sync_checked_at: { $exists: true },
        createdAt: { $lt: oldEnough },
        $and: [
            { $or: EMPTY },
            { $or: [{ thumbnail_frame_attempts: { $exists: false } },
                { thumbnail_frame_attempts: { $lt: THUMBNAIL_FRAME_MAX_ATTEMPTS }, thumbnail_frame_failed_at: { $lt: retryBefore } }] },
        ],
    })
        .project({ _id: 1, hive_author: 1, hive_permlink: 1, manifest_cid: 1, storage_state: 1, s3_url: 1 })
        .sort({ createdAt: -1 })   // newest first: what is on the feeds right now
        .limit(THUMBNAIL_FRAME_BATCH)
        .toArray();

    const res = { scanned: docs.length, fromPost: 0, generated: 0, failed: 0 };
    if (!docs.length || !ENABLE_MONGO_WRITES) return res;

    let images;
    try {
        images = await postImages(docs);
    } catch (err) {
        console.error('[thumbnailFrame] Hive read failed:', err.message);
        return res;   // without the re-check we do not know there is no image
    }

    for (const d of docs) {
        const key = `${d.hive_author}/${d.hive_permlink}`;
        if (!images.has(key)) continue;   // post unreadable this run: leave for next time
        const still = { _id: d._id, $or: EMPTY };

        const fromPost = images.get(key);
        if (fromPost) {
            // The post has an image after all (added since the sync looked): that one.
            const r = await ev.updateOne(still, { $set: {
                thumbnail_url: fromPost, thumbnail_backfilled_at: new Date(), thumbnail_sync_checked_at: new Date(),
            } });
            res.fromPost += r.modifiedCount || 0;
            continue;
        }

        let url = null;
        let reason = 'no frame';
        if (CID_RE.test(d.manifest_cid)) {
            const frame = await frameFor(d.manifest_cid, d);
            if (frame) {
                try {
                    url = await uploadImage(frame, { url: IMAGE_UPLOAD_URL, key: IMAGE_UPLOAD_KEY });
                } catch (err) {
                    reason = err.message;
                }
            }
        } else {
            reason = 'bad manifest_cid';
        }

        if (url) {
            const r = await ev.updateOne(still, { $set: {
                thumbnail_url: url, thumbnail_source: 'frame', thumbnail_generated_at: new Date(),
            } });
            res.generated += r.modifiedCount || 0;
        } else {
            await ev.updateOne({ _id: d._id }, {
                $set: { thumbnail_frame_failed_at: new Date(), thumbnail_frame_error: reason },
                $inc: { thumbnail_frame_attempts: 1 },
            });
            res.failed++;
        }
    }

    if (res.generated || res.fromPost || res.failed) {
        console.log(`[thumbnailFrame] ${res.generated} frame thumbnail(s), ${res.fromPost} from the post, ${res.failed} failed`);
    }
    return res;
}

/** Tests only: forget the memoised ffmpeg probe. */
function _reset() { ffmpegChecked = null; }

module.exports = { generateFrameThumbnails, _reset };
