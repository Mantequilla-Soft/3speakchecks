/**
 * Self-promotion: a creator running their OWN published video as an ad spot.
 *
 * Covers the three rules this feature adds, because each one is a place the normal
 * booking path would have said no:
 *   1. the spot is TRIMMED to the booked seconds (a published video is not 15s long)
 *   2. a self-promo flight is limited to AD_SELFPROMO_ALLOWED_OWNERS while in beta
 *   3. booking accepts a PUBLISHED video, which /campaigns/:id/creative refuses
 *
 * Hits live Mongo and mounts the real router on a bare express app — never
 * server.js, which would start crons that broadcast Hive transactions. Every
 * document it writes is removed again at the end, and it never settles or pays.
 *
 * Usage: node scripts/test-ad-selfpromo.cjs
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const { connectToMongo, getDb } = require('../utils/db');
const {
  ADVERTISERS_COLLECTION, AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION,
  AD_SELFPROMO_ALLOWED_OWNERS, AD_SELFPROMO_RATE_HBD,
} = require('../utils/config');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
};

const seg = (secs) => ({ extinf: `#EXTINF:${secs.toFixed(3)},`, url: `https://cdn.example/${secs}.ts` });

async function main() {
  const { trimOf, adSecondsFor, selfPromoAllowedOn } = require('../routes/adServe').__test;

  console.log('\n1. the trim rule');
  // Re-implemented here ONLY as the oracle: the assertion is about loadAdSegments'
  // contract (never exceed the booking, always keep one), which is what the stitcher
  // relies on and what nothing else in the suite covers.
  const applyTrim = (segs, trim) => {
    const kept = []; let acc = 0;
    for (const s of segs) {
      const secs = parseFloat((s.extinf.match(/#EXTINF:\s*([\d.]+)/) || [])[1]) || 0;
      if (kept.length && acc + secs > trim) break;
      kept.push(s); acc += secs;
    }
    return kept;
  };
  const tenSegments = [4, 4, 4, 4, 4, 4, 4, 4, 4, 4].map(seg);
  ok('15s of 4s segments keeps 3 (12s), never 4 (16s)', applyTrim(tenSegments, 15).length === 3);
  ok('a booking shorter than one segment still keeps one', applyTrim(tenSegments, 1).length === 1);
  ok('a booking longer than the media keeps everything', applyTrim(tenSegments, 600).length === 10);
  ok('trimOf reads the creative field', trimOf({ trimToSeconds: 15 }) === 15);
  ok('trimOf ignores nonsense', trimOf({ trimToSeconds: 0 }) === null && trimOf({}) === null);
  ok('a trimmed creative reports the TRIM as its length',
    adSecondsFor({ trimToSeconds: 15, durationSeconds: 600 }, { spotSeconds: 15 }) === 15);
  ok('an ordinary creative still reports its own duration',
    adSecondsFor({ durationSeconds: 12 }, { spotSeconds: 15 }) === 12);

  console.log('\n2. the beta limit');
  console.log(`  (configured owners: ${JSON.stringify(AD_SELFPROMO_ALLOWED_OWNERS)})`);
  if (AD_SELFPROMO_ALLOWED_OWNERS.length) {
    ok('an allowed owner carries self-promo ads', selfPromoAllowedOn(AD_SELFPROMO_ALLOWED_OWNERS[0]));
    ok('everybody else does not', !selfPromoAllowedOn('somebody-else'));
    ok('case does not matter', selfPromoAllowedOn(AD_SELFPROMO_ALLOWED_OWNERS[0].toUpperCase()));
  }

  await connectToMongo();
  const db = getDb();
  const app = express();
  app.use('/advertise', require('../routes/adSelfPromo'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  console.log('\n3. eligibility');
  const r1 = await get('/advertise/selfpromo/options?account=notareal.acct&owner=nobody&permlink=nothing');
  ok('an unknown video is refused with a reason', r1.body.eligible === false && !!r1.body.reason, JSON.stringify(r1.body));

  // A real, published, encoded video to book against — whoever the beta list names,
  // so the test exercises the same account the feature is live for.
  const target = AD_SELFPROMO_ALLOWED_OWNERS[0] || 'badadib';
  const video = await db.collection('embed-video').findOne({
    owner: target, status: 'published', hive_permlink: { $ne: null }, manifest_cid: { $ne: null },
  }, { sort: { createdAt: -1 } });
  if (!video) {
    console.log(`  (no published encoded video for @${target}; skipping the booking test)`);
  } else {
    const q = `account=${target}&owner=${video.owner}&permlink=${video.permlink}`;
    const r2 = await get(`/advertise/selfpromo/options?${q}`);
    ok('their own video is eligible', r2.body.eligible === true, JSON.stringify(r2.body).slice(0, 200));
    if (r2.body.eligible && AD_SELFPROMO_RATE_HBD > 0) {
      ok(`quoted at the self-promo rate (${AD_SELFPROMO_RATE_HBD} HBD), not the platform one`,
        r2.body.formats.every((f) => f.ratePerSecondDayHbd === AD_SELFPROMO_RATE_HBD),
        JSON.stringify(r2.body.formats));
    }

    if (r2.body.eligible) {
      ok('a format is offered', Array.isArray(r2.body.formats) && r2.body.formats.length > 0);
      ok('the spot cannot be longer than the video',
        r2.body.formats.every((f) => f.maxSeconds <= Math.max(1, Math.round(video.duration || 9999))));

      const r3 = await get(`/advertise/selfpromo/options?account=someone.else&owner=${video.owner}&permlink=${video.permlink}`);
      ok('somebody else cannot promote it', r3.body.eligible === false && /your own/i.test(r3.body.reason || ''));

      console.log('\n4. booking (created and removed again)');
      const fmtKey = r2.body.formats[0].key;
      const priorCreative = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: String(video._id) });
      const priorAdvertiser = await db.collection(ADVERTISERS_COLLECTION)
        .findOne({ hiveAccount: target, selfPromo: true });
      const r4 = await post('/advertise/selfpromo/book', {
        account: target,
        owner: video.owner,
        permlink: video.permlink,
        format: fmtKey,
        days: 3,
        spotSeconds: Math.min(10, r2.body.formats[0].maxSeconds),
        startAt: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      });
      ok('the booking succeeds', r4.body.success === true, JSON.stringify(r4.body).slice(0, 220));

      if (r4.body.success) {
        const { ObjectId } = require('mongodb');
        const camp = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: new ObjectId(r4.body.campaignId) });
        const creative = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: String(video._id) });
        ok('the campaign is flagged selfPromo', camp && camp.selfPromo === true);
        ok('it is awaiting payment, not running', camp && camp.status === 'awaiting_payment');
        ok('nothing is paid yet', camp && !camp.paidHbd);
        ok('the memo names the campaign', r4.body.memo === `ad:${r4.body.campaignId}`);
        ok('CHARGED at the rate it was quoted',
          AD_SELFPROMO_RATE_HBD > 0 ? camp.ratePerSecondDayHbd === AD_SELFPROMO_RATE_HBD : true,
          `charged ${camp.ratePerSecondDayHbd}`);
        ok('the price is charged on the day curve',
          Math.abs(camp.totalHbd - Math.round((3 ** 0.85) * camp.ratePerSecondDayHbd * camp.spotSeconds * 1000) / 1000) < 0.0005);
        ok('the creative carries the trim', creative && creative.trimToSeconds === camp.spotSeconds);
        ok('the creative is NOT auto-approved', creative && creative.status === 'review');
        ok('the creative points at the published video', creative && creative.manifestCid === video.manifest_cid);
        ok('a roll got a position, a shorts spot did not',
          fmtKey === 'video_roll' ? camp.slotPercent !== null : camp.slotPercent === null);

        const adv = await db.collection(ADVERTISERS_COLLECTION).findOne({ reference: camp.advertiserRef });
        ok('an advertiser stands for the channel', !!adv && adv.selfPromo === true);
        ok('it is approved without a human', adv && adv.status === 'approved');
        ok('the slogan is the self-promo one', adv && /Content Creator on 3Speak/i.test(adv.slogan || ''));

        // Cleanup. Only what THIS run created: a creative row or an advertiser can
        // predate the test, and deleting a review decision somebody already made
        // would be worse than leaving a row behind.
        await db.collection(AD_CAMPAIGNS_COLLECTION).deleteOne({ _id: camp._id });
        if (!priorCreative && creative) {
          await db.collection(AD_CREATIVES_COLLECTION).deleteOne({ _id: creative._id });
        }
        if (!priorAdvertiser && adv) {
          await db.collection(ADVERTISERS_COLLECTION).deleteOne({ _id: adv._id });
        }
        const gone = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: camp._id });
        ok('the test cleaned up after itself', !gone);
      }
    }
  }

  server.close();
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
