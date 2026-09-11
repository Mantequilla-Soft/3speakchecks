/**
 * Moves an uploaded spot from "still encoding" to "ready for a human to watch".
 *
 * Registration happens the moment the upload finishes, which is BEFORE the encoder
 * has produced anything playable — so a creative is created with no manifest and
 * status `pending`. Without this, nothing ever revisited it: the encode would
 * complete, `embed-video.manifest_cid` would appear, and the creative would sit at
 * `pending` with a null manifest forever. It could never be reviewed, never reach
 * `ready`, and therefore never serve.
 *
 * Same shape as services/thumbnailSync.js — poll a small backlog on an interval and
 * fill in the field the upstream pipeline produced asynchronously.
 *
 * It deliberately stops at `review`. Encoding finishing is not approval: a spot is
 * about to run in front of other people's audiences, so the last step is a person.
 */
const { getDb } = require('../utils/db');
const {
  AD_CREATIVES_COLLECTION, AD_LENGTH_SECONDS, ENABLE_MONGO_WRITES,
} = require('../utils/config');
const { CREATIVE_STATES } = require('../utils/adModel');

const CDN = process.env.AD_CDN_GATEWAY || 'https://hotipfs-3speak-1.b-cdn.net/ipfs';
// How often we check whether a spot has finished encoding. This is the whole delay an
// advertiser sees between their upload being ready and the page saying so, and there is
// no push from the encoder to shorten it. The sweep only touches creatives that are
// still pending, so it costs nothing when nothing is uploading.
const INTERVAL_MIN = parseInt(process.env.AD_CREATIVE_SYNC_INTERVAL_MIN, 10) || 1;
const BATCH = parseInt(process.env.AD_CREATIVE_SYNC_BATCH, 10) || 40;

async function runOnce() {
  if (!ENABLE_MONGO_WRITES) return null;
  try {
    const db = getDb();
    const pending = await db.collection(AD_CREATIVES_COLLECTION)
      .find({ status: CREATIVE_STATES.PENDING }).limit(BATCH).toArray();
    if (!pending.length) return { checked: 0, advanced: 0 };

    let advanced = 0;
    let rejected = 0;
    for (const cr of pending) {
      const embed = await db.collection('embed-video').findOne(
        { $or: [{ permlink: cr.permlink }, { owner: cr.owner, permlink: cr.permlink }] },
        { projection: { manifest_cid: 1, duration: 1, status: 1 } },
      );
      if (!embed || !embed.manifest_cid) continue;   // still encoding — try again next tick

      const durationSeconds = Math.round(Number(embed.duration) || cr.durationSeconds || 0);

      // The duration is only trustworthy once the encoder has measured it. An
      // over-long spot slipping through at upload (browser metadata can be wrong,
      // or absent) has to be caught here rather than at serve time, where it would
      // splice a 90-second ad into someone's video.
      if (durationSeconds > AD_LENGTH_SECONDS) {
        await db.collection(AD_CREATIVES_COLLECTION).updateOne({ _id: cr._id }, {
          $set: {
            status: CREATIVE_STATES.REJECTED,
            durationSeconds,
            reviewNote: `The encoded spot is ${durationSeconds}s. The slot is ${AD_LENGTH_SECONDS}s.`,
            updatedAt: new Date(),
          },
        });
        rejected += 1;
        continue;
      }

      await db.collection(AD_CREATIVES_COLLECTION).updateOne({ _id: cr._id }, {
        $set: {
          manifestUrl: `${CDN}/${embed.manifest_cid}/manifest.m3u8`,
          durationSeconds,
          status: CREATIVE_STATES.REVIEW,
          encodedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      advanced += 1;
    }

    if (advanced || rejected) {
      console.log(`[adCreative] ${advanced} spot(s) encoded and awaiting review${rejected ? `, ${rejected} rejected as too long` : ''}`);
    }
    return { checked: pending.length, advanced, rejected };
  } catch (err) {
    console.error('[adCreative] sync failed:', err && err.message);
    return null;
  }
}

function schedule() {
  const ms = Math.max(1, INTERVAL_MIN) * 60 * 1000;
  setTimeout(() => { runOnce(); setInterval(runOnce, ms); }, 90 * 1000);
  console.log(`[adCreative] encode watch scheduled every ${INTERVAL_MIN} min (first run in 90s)`);
}

module.exports = { schedule, runOnce };
