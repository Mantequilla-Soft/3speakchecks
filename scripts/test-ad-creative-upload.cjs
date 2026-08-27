/**
 * Proves the claim that matters about creative ingest: a spot lands as an ordinary
 * upload but with NO Hive post and out of every feed. Uploads a 3-second generated
 * clip, then removes everything it created.
 */
process.chdir('/mnt/HC_Volume_103240961/prodops/services/3speakchecks');
const fs = require('fs');
const db = require('../utils/db');
const cfg = require('../utils/config');
const { servableReason } = require('../utils/adModel');

// The feature can be switched fully dark (ADS_STAGE=off), in which case every route
// under test answers 404 by design. Say so and skip, rather than reporting a wall of
// failures that look like breakage.
if (require('../utils/config').ADS_STAGE === 'off') {
  console.log('SKIPPED — ADS_STAGE=off, the ad surface is dark by design.');
  console.log('Set ADS_STAGE=beta in 3speakchecks/.env and restart to run these.');
  process.exit(0);
}

const CLIP = require('path').join(__dirname, 'fixtures', 'test-spot.mp4');
const CHECKER = 'https://checker.3speak.tv/advertise';
const env = fs.readFileSync('/mnt/HC_Volume_103240961/prodops/services/preview-3speak/.env', 'utf8');
const get = (k) => { const l = env.split('\n').find((x) => x.startsWith(k + '=')); return l ? l.slice(k.length + 1).trim() : ''; };
const EMBED_API_URL = get('VITE_EMBED_API_URL') || 'https://embed2.3speak.tv';
const EMBED_API_KEY = get('VITE_EMBED_API_KEY');

let fails = 0;
const check = (l, g, w) => { const ok = String(g) === String(w); if (!ok) fails++; console.log(`${ok?' ok ':'FAIL'}  ${l.padEnd(52)} ${g}${ok?'':`  want ${w}`}`); };
const ok = (l, c, d='') => { if (!c) fails++; console.log(`${c?' ok ':'FAIL'}  ${l.padEnd(52)} ${d}`); };

(async () => {
  await db.connectToMongo();
  const d = db.getDb();
  let permlink = null;
  try {
    await d.collection(cfg.ADVERTISERS_COLLECTION).insertOne({
      reference: 'UPLOAD-TEST-REF', hiveAccount: 'meno', projectName: 'Upload Test Co',
      status: 'approved', category: 'tooling', createdAt: new Date(),
    });

    console.log('── upload through the ordinary embed pipeline ──');
    const form = new FormData();
    form.append('owner', 'meno');
    form.append('frontend_app', '3speak-ads');
    form.append('filename', 'test-spot.mp4');
    form.append('duration', '3');
    form.append('file', new Blob([fs.readFileSync(CLIP)], { type: 'video/mp4' }), 'test-spot.mp4');
    const up = await fetch(`${EMBED_API_URL}/upload/simple`, {
      method: 'POST', headers: { 'X-API-Key': EMBED_API_KEY }, body: form,
    });
    const uj = await up.json().catch(() => ({}));
    check('upload accepted', up.status, 201);
    ok('a permlink came back', !!uj.permlink, uj.permlink || JSON.stringify(uj).slice(0, 120));
    permlink = uj.permlink;
    if (!permlink) throw new Error('no permlink');

    console.log('\n── the thing we actually care about ──');
    const row = await d.collection('embed-video').findOne({ owner: 'meno', permlink });
    ok('an embed-video row exists', !!row);
    check('NO hive post (author)', row.hive_author === null || row.hive_author === undefined ? 'none' : row.hive_author, 'none');
    check('NO hive post (permlink)', row.hive_permlink === null || row.hive_permlink === undefined ? 'none' : row.hive_permlink, 'none');
    check('not listed on 3speak', row.listed_on_3speak, false);
    check('tagged as an ad upload', row.frontend_app, '3speak-ads');

    console.log('\n── register it as a creative ──');
    const reg = await fetch(`${CHECKER}/creatives`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference: 'UPLOAD-TEST-REF', embedId: permlink }),
    });
    const rj = await reg.json();
    check('creative registered', reg.status, 201);
    ok('starts un-approved', rj.creative && ['pending', 'review'].includes(rj.creative.status), rj.creative && rj.creative.status);
    ok('preview link offered', !!(rj.creative && rj.creative.previewUrl), rj.creative && rj.creative.previewUrl);

    console.log('\n── it is refused without an approved advertiser ──');
    const bad = await fetch(`${CHECKER}/creatives`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference: 'NOT-A-REAL-REF', embedId: permlink }),
    });
    check('unknown reference refused', bad.status, 403);

    console.log('\n── the lifecycle that used to dead-end ──');
    // Registration happens before the encoder has produced anything, so a fresh
    // creative has no manifest. Nothing used to revisit it, and nothing could move
    // it to `ready`, so no ad could ever serve. This walks the whole path.
    const creatives = d.collection(cfg.AD_CREATIVES_COLLECTION);
    let cr = await creatives.findOne({ permlink });
    check('starts pending with no manifest', `${cr.status}/${cr.manifestUrl ? 'has' : 'none'}`, 'pending/none');

    // Pretend the encoder finished.
    await d.collection('embed-video').updateOne({ owner: 'meno', permlink },
      { $set: { manifest_cid: 'QmTestManifestCidForLifecycleCheck00000000000', duration: 3 } });
    const sync = await require('../services/adCreativeSync').runOnce();
    ok('encode watcher advanced it', sync && sync.advanced >= 1, JSON.stringify(sync));
    cr = await creatives.findOne({ permlink });
    check('now awaiting review, with a manifest', `${cr.status}/${cr.manifestUrl ? 'has' : 'none'}`, 'review/has');
    check('still not servable', servableReason({ status: 'running', paidHbd: 1, startAt: new Date(Date.now()-1000), endAt: new Date(Date.now()+1000) }, cr), 'creative_review');

    // Approve, exactly as the CLI and the admin endpoint do.
    await creatives.updateOne({ _id: cr._id }, { $set: { status: 'ready', reviewedBy: 'test', reviewedAt: new Date() } });
    cr = await creatives.findOne({ permlink });
    check('approved spot is servable', servableReason({ status: 'running', paidHbd: 1, startAt: new Date(Date.now()-1000), endAt: new Date(Date.now()+1000) }, cr) === null ? 'yes' : 'no', 'yes');

    // An over-long spot must be caught once the encoder measures it, not at splice time.
    await creatives.updateOne({ _id: cr._id }, { $set: { status: 'pending', manifestUrl: null } });
    await d.collection('embed-video').updateOne({ owner: 'meno', permlink }, { $set: { duration: 900 } });
    await require('../services/adCreativeSync').runOnce();
    cr = await creatives.findOne({ permlink });
    check('over-long spot auto-rejected', cr.status, 'rejected');
    ok('  with a reason the advertiser can read', !!cr.reviewNote, cr.reviewNote);

    console.log('\n── a published video cannot be used as a spot ──');
    const published = await d.collection('embed-video').findOne({ hive_author: { $ne: null }, manifest_cid: { $ne: null } }, { projection: { permlink: 1 } });
    if (published) {
      const pr = await fetch(`${CHECKER}/creatives`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference: 'UPLOAD-TEST-REF', embedId: published.permlink }),
      });
      check('published upload refused', pr.status, 400);
    }
  } finally {
    await d.collection(cfg.ADVERTISERS_COLLECTION).deleteMany({ reference: 'UPLOAD-TEST-REF' });
    await d.collection(cfg.AD_CREATIVES_COLLECTION).deleteMany({ advertiserRef: 'UPLOAD-TEST-REF' });
    if (permlink) {
      await d.collection('embed-video').deleteMany({ owner: 'meno', permlink });
      // Don't leave an encode job queued for a throwaway clip.
      await d.collection('embed-jobs').deleteMany({ permlink }).catch(() => {});
      await d.collection('encoding_jobs').deleteMany({ permlink }).catch(() => {});
      console.log(`\ncleaned up upload ${permlink} and any queued job`);
    }
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
