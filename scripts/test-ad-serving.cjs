/**
 * End-to-end: book → pay (simulated credit) → serve → measure → settle.
 * Uses two REAL 3Speak videos: a 15s clip as the spot, a 110s clip as the content.
 * Everything it creates is removed at the end.
 */
process.chdir('/mnt/HC_Volume_103240961/prodops/services/3speakchecks');
const db = require('../utils/db');
const { closeFinishedCampaigns } = require('../services/adPayouts');
const cfg = require('../utils/config');
// The feature can be switched fully dark (ADS_STAGE=off), in which case every route
// under test answers 404 by design. Say so and skip, rather than reporting a wall of
// failures that look like breakage.
if (require('../utils/config').ADS_STAGE === 'off') {
  console.log('SKIPPED — ADS_STAGE=off, the ad surface is dark by design.');
  console.log('Set ADS_STAGE=beta in 3speakchecks/.env and restart to run these.');
  process.exit(0);
}

const CDN = 'https://hotipfs-3speak-1.b-cdn.net/ipfs';
const BASE = 'https://checker.3speak.tv';
const CREATIVE = { cid: 'QmRCr2MuWpWXB4DxvXGXBq1p7vdQ4uzg12nmKcP68WSZnr', dur: 15 };
// Owner is the account on ADS_ALLOWED_OWNERS — ads run on its videos and no others.
// The media itself is a known-playable CDN manifest borrowed from another video: the
// stitcher takes the manifest URL from the request and uses owner/permlink only as
// identity, so this exercises the real path without needing that account to happen to
// own a long, currently-reachable upload.
const CONTENT  = { owner: 'badadib', permlink: 'ad-serving-test', cid: 'Qmdajw6HvrgkPuTPyCoTfw4DmtmGaJ8BHZHvWEcizLzHQb', dur: 110 };
const OFF_TRIAL = 'danifoodymas';   // a real creator who must never receive an ad
// Slots are a percentage of the video now. The content clip below is 110s, so a
// quarter of the way in should land around 27s.
const SLOT_PCT = 25;

let fails = 0;
const check = (l, g, w) => { const ok = String(g) === String(w); if (!ok) fails++; console.log(`${ok?' ok ':'FAIL'}  ${l.padEnd(50)} ${g}${ok?'':`  want ${w}`}`); };
const ok = (l, cond, detail='') => { if (!cond) fails++; console.log(`${cond?' ok ':'FAIL'}  ${l.padEnd(50)} ${detail}`); };

/**
 * ISOLATION. This suite serves real ads through the real picker against the real
 * database, and the picker cannot be asked for a particular campaign — it takes
 * whatever is eligible. So on a database with live inventory, a run of this file
 * used to land its synthetic play on somebody's PAID flight: their campaign flipped
 * to `running`, their delivery counter went up by one, and the impression carried a
 * permlink that does not exist. That is corrupted delivery data on a real booking,
 * which is exactly the number an advertiser is billed and refunded against.
 *
 * Two guards, because one is not enough:
 *   1. The test campaign is created with deliveredImpressions BELOW zero, so the
 *      picker's "fewest delivered first" sort puts it ahead of every real campaign.
 *      No production campaign can hold a negative count, so this cannot tie.
 *   2. Every session this file opens is checked against the database before it is
 *      used. If the picker handed us somebody else's campaign anyway, we undo that
 *      serve and stop, rather than carrying on and billing it.
 */
/**
 * For the steps that expect NO ad (the allowlist, the frequency cap, a Pro viewer).
 * If one comes back anyway the assertion will fail on its own — but a session row
 * now exists against whichever campaign was picked, and if that is a real flight we
 * must not leave it there. Removes it and says so.
 */
async function discardStray(d, cfg, response, label) {
  const url = response && response.ad && response.ad.manifestUrl;
  const m = url && String(url).match(/\/m\/([0-9a-f]{32})\.m3u8/);
  if (!m) return null;
  const session = await d.collection('ad_sessions').findOne({ sid: m[1] });
  await d.collection(cfg.AD_IMPRESSIONS_COLLECTION).deleteMany({ sid: m[1] });
  await d.collection('ad_sessions').deleteMany({ sid: m[1] });
  console.log(`      (discarded an unexpected session from "${label}" so it cannot bill a real flight)`);
  return session ? String(session.campaignId) : 'unknown';
}

async function assertOurs(d, cfg, sid, ourCampaignId) {
  const session = await d.collection('ad_sessions').findOne({ sid });
  if (session && String(session.campaignId) === String(ourCampaignId)) return session;

  // Undo whatever this serve just did to a campaign that is not ours, then stop.
  if (session) {
    await d.collection(cfg.AD_IMPRESSIONS_COLLECTION).deleteMany({ sid });
    await d.collection('ad_sessions').deleteMany({ sid });
  }
  throw new Error(
    'ISOLATION FAILURE: the picker served campaign '
    + `${session ? session.campaignId : 'unknown'} instead of the test's ${ourCampaignId}. `
    + 'This run has been rolled back. Check for a live campaign that outranks the test fixture.',
  );
}

(async () => {
  await db.connectToMongo();
  const d = db.getDb();
  const ids = {};
  try {
    // ── set up an approved advertiser + a paid, running campaign ──
    const adv = await d.collection(cfg.ADVERTISERS_COLLECTION).insertOne({
      reference: 'E2E-TEST-REF', hiveAccount: 'meno', projectName: 'E2E Test Co',
      status: 'approved', category: 'tooling', createdAt: new Date(),
    });
    ids.adv = adv.insertedId;

    const camp = await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).insertOne({
      advertiserRef: 'E2E-TEST-REF', hiveAccount: 'meno', projectName: 'E2E Test Co',
      name: 'E2E flight', status: 'scheduled', slotPercent: SLOT_PCT, days: 7, markets: [],
      priceHbd: 35, paidHbd: 35,       // simulated credit — the claim path is tested separately
      startAt: new Date(Date.now() - 60000), endAt: new Date(Date.now() + 864e5),
      // Below zero on purpose: the picker sorts eligible campaigns by fewest
      // delivered, so this wins against any real flight. Reset to 0 the moment the
      // selection is made, so the delivery assertions below read as they should.
      deliveredImpressions: -1, createdAt: new Date(),
    });
    ids.camp = camp.insertedId;

    const cre = await d.collection(cfg.AD_CREATIVES_COLLECTION).insertOne({
      campaignId: camp.insertedId, advertiserRef: 'E2E-TEST-REF', embedId: 'e2e-creative',
      // Formats match a campaign's creativeKind against this, so a fixture without
      // it is refused as the wrong kind — which is what silently broke this suite.
      kind: 'video',
      durationSeconds: CREATIVE.dur, manifestUrl: `${CDN}/${CREATIVE.cid}/manifest.m3u8`,
      status: 'ready', createdAt: new Date(),
    });
    ids.cre = cre.insertedId;

    // ── 1. open a session ──
    console.log('── the serving allowlist ──');
    const contentManifestForGate = `${CDN}/${CONTENT.cid}/manifest.m3u8`;
    const offTrial = await (await fetch(`${BASE}/m/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OFF_TRIAL, permlink: 'x', manifestUrl: contentManifestForGate }),
    })).json();
    check(`@${OFF_TRIAL} is refused an ad`, offTrial.reason, 'owner_not_in_trial');
    ok('  and gets no ad object at all', offTrial.ad === null);
    await discardStray(d, cfg, offTrial, 'off-trial owner');

    console.log('\n── session ──');
    const contentManifest = `${CDN}/${CONTENT.cid}/manifest.m3u8`;
    const sres = await fetch(`${BASE}/m/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: CONTENT.owner, permlink: CONTENT.permlink, viewer: 'paarvez', country: 'DE', manifestUrl: contentManifest }),
    });
    const sj = await sres.json();
    check('session opened', sres.status, 200);
    ok('an ad was selected', !!sj.ad, sj.ad ? `slot ${sj.ad.position}s, ${sj.ad.durationSeconds}s spot` : `reason=${sj.reason}`);
    if (!sj.ad) throw new Error('no ad returned: ' + sj.reason);
    check('label is disclosed', sj.ad.label, 'Sponsored');
    const sid = sj.ad.manifestUrl.match(/\/m\/([0-9a-f]{32})\.m3u8/)[1];
    await assertOurs(d, cfg, sid, ids.camp);
    ok('the served campaign is this test\'s, not a live one', true);
    // Selection is done, so the thumb can come off the scale.
    await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).updateOne({ _id: ids.camp }, { $set: { deliveredImpressions: 0 } });

    // ── 2. master playlist comes back through us ──
    console.log('\n── master playlist ──');
    const m1 = await fetch(sj.ad.manifestUrl);
    const t1 = await m1.text();
    check('master served', m1.status, 200);
    ok('variants routed back through us', (t1.match(/\/m\/[0-9a-f]{32}\.m3u8\?p=/g) || []).length > 0,
       `${(t1.match(/\/m\/[0-9a-f]{32}\.m3u8\?p=/g)||[]).length} variant(s)`);
    ok('no "ad" string anywhere in the manifest', !/\bad\b|advertise|vast|preroll/i.test(t1));

    // ── 3. a variant: the actual splice ──
    console.log('\n── spliced media playlist ──');
    const variantUrl = (t1.split('\n').find((l) => l.includes('/m/') && l.includes('?p=')) || '').trim();
    ok('found a variant to fetch', !!variantUrl);
    const m2 = await fetch(variantUrl);
    const t2 = await m2.text();
    check('variant served', m2.status, 200);
    check('discontinuity tags present', (t2.match(/#EXT-X-DISCONTINUITY/g) || []).length, 2);
    ok('content segments absolutised to the CDN', (t2.match(/hotipfs-3speak-1\.b-cdn\.net/g) || []).length > 3,
       `${(t2.match(/hotipfs-3speak-1\.b-cdn\.net/g)||[]).length} CDN segments`);
    const beacons = t2.match(new RegExp(`/m/${sid}/(a|b|ab)`, 'g')) || [];
    ok('measured segments inserted', beacons.length >= 1, beacons.join(' '));
    // The splice must land at the booked position, not at the top.
    const lines = t2.split('\n');
    let elapsed = 0, discAt = null;
    for (let i = 0; i < lines.length; i++) {
      const mm = lines[i].match(/#EXTINF:\s*([\d.]+)/i);
      if (mm) elapsed += parseFloat(mm[1]);
      if (lines[i].trim() === '#EXT-X-DISCONTINUITY' && discAt === null) discAt = elapsed;
    }
    // Resolved against the playlist's own duration, so the assertion has to be too:
    // a fixed number of seconds would only be right for this one clip.
    const totalSeconds = lines.reduce((sum, l) => {
      const mm = l.match(/^#EXTINF:\s*([\d.]+)/i);
      return sum + (mm ? parseFloat(mm[1]) : 0);
    }, 0);
    const expectedAt = (totalSeconds * SLOT_PCT) / 100;
    ok(`break lands at/after ${SLOT_PCT}% of the video`,
      discAt !== null && discAt >= expectedAt - 0.01,
      `at ${discAt}s of ${Math.round(totalSeconds)}s (${Math.round((discAt / totalSeconds) * 100)}%)`);

    // ── 4. measurement ──
    console.log('\n── delivery measurement ──');
    const b1 = await fetch(`${BASE}/m/${sid}/a`, { redirect: 'manual' });
    check('opening segment redirects to CDN', b1.status, 302);
    ok('  → points at the CDN, not at us', String(b1.headers.get('location') || '').includes('b-cdn.net'));
    let imp = await d.collection(cfg.AD_IMPRESSIONS_COLLECTION).findOne({ sid });
    ok('impression opened', !!imp && imp.started === true);
    check('not yet counted as delivered', imp && imp.completed ? 'yes' : 'no', 'no');

    const b2 = await fetch(`${BASE}/m/${sid}/b`, { redirect: 'manual' });
    check('closing segment redirects', b2.status, 302);
    imp = await d.collection(cfg.AD_IMPRESSIONS_COLLECTION).findOne({ sid });
    ok('impression completed', !!imp && imp.completed === true);
    let c = await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).findOne({ _id: ids.camp });
    check('campaign delivery counter', c.deliveredImpressions, 1);
    check('campaign flipped to running', c.status, 'running');

    // Replay must not double-count — the unique index on sid is the guard.
    await fetch(`${BASE}/m/${sid}/b`);
    c = await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).findOne({ _id: ids.camp });
    ok('replayed beacon does not double-count', c.deliveredImpressions === 1, `still ${c.deliveredImpressions}`);

    // ── 5. frequency cap ──
    console.log('\n── frequency cap ──');
    const again = await (await fetch(`${BASE}/m/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: CONTENT.owner, permlink: CONTENT.permlink, viewer: 'paarvez', country: 'DE', manifestUrl: contentManifest }),
    })).json();
    // The cap is per CAMPAIGN, not "no ad exists anywhere". On a database that also
    // holds live inventory the honest expectation is that this viewer is not shown
    // OUR spot again — being shown a different advertiser's is the system working.
    // Asserting `no_eligible_campaign` outright only held while the test fixture was
    // the only campaign in existence, and it is not any more.
    if (again.ad) {
      const servedInstead = await discardStray(d, cfg, again, 'frequency cap');
      ok('same viewer is not shown THIS spot again',
        servedInstead !== String(ids.camp), `a different campaign was served (${servedInstead})`);
    } else {
      check('same viewer is not shown it again', again.reason, 'no_eligible_campaign');
    }

    // ── 6. premium viewer ──
    console.log('\n── premium viewer ──');
    const premium = await d.collection('embed-users').findOne({ premium: true }, { projection: { username: 1 } });
    const pres = await (await fetch(`${BASE}/m/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: CONTENT.owner, permlink: CONTENT.permlink, viewer: premium.username, manifestUrl: contentManifest }),
    })).json();
    check('a Pro subscriber gets no ad', pres.reason, 'premium_viewer');
    await discardStray(d, cfg, pres, 'premium viewer');

    // ── 7. the flight ends ──
    // Paying is NOT done here. Revenue is pooled per period across every campaign
    // so two creators with identical delivery are paid identically — see
    // scripts/test-ad-payout.cjs, which is where the split itself is proven.
    console.log('\n── flight end ──');
    await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).updateOne({ _id: ids.camp }, { $set: { endAt: new Date(Date.now() - 1000) } });
    const closed = await closeFinishedCampaigns(d);
    ok('finished flight closed', closed >= 1, `${closed} campaign(s)`);
    const c2 = await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).findOne({ _id: ids.camp });
    check('campaign marked complete', c2.status, 'complete');
    const pendingImp = await d.collection(cfg.AD_IMPRESSIONS_COLLECTION).findOne({ campaignId: ids.camp });
    // Read defensively: when this was missing it threw a bare TypeError, which read
    // as the suite breaking rather than as the impression having gone somewhere else.
    check('impression left unpaid for the period run',
      !pendingImp ? 'NO IMPRESSION FOR THIS CAMPAIGN' : (pendingImp.payoutId === null ? 'null' : pendingImp.payoutId),
      'null');

  } finally {
    // ── clean up everything this test created ──
    await d.collection(cfg.ADVERTISERS_COLLECTION).deleteMany({ reference: 'E2E-TEST-REF' });
    await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).deleteMany({ advertiserRef: 'E2E-TEST-REF' });
    await d.collection(cfg.AD_CREATIVES_COLLECTION).deleteMany({ advertiserRef: 'E2E-TEST-REF' });
    if (ids.camp) {
      await d.collection(cfg.AD_IMPRESSIONS_COLLECTION).deleteMany({ campaignId: ids.camp });
      await d.collection(cfg.AD_PAYOUTS_COLLECTION).deleteMany({ periodKey: String(ids.camp) });
      await d.collection('ad_sessions').deleteMany({ campaignId: ids.camp });
    }
    console.log('\ncleaned up');
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
