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

/* 🚨 NOT a hardcoded gateway any more, and specifically not hotipfs-3speak-1.
 *
 * This line named that host, and the SAFE list below blessed it, so a suite whose
 * whole job is to assert "never point a browser somewhere it cannot follow" was
 * affirming the one gateway that cannot serve content it has not already cached.
 * Both come from utils/adGateways.js now, which is the thing under test. */
const {
  CORS_HOSTS, COLD_CAPABLE_HOSTS, preferredHost,
} = require('../utils/adGateways');

const CDN = `https://${preferredHost()}/ipfs`;
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
  // Either placement carries the same sid, and a banner-only response has no `ad` at
  // all — so reading only that one would walk past a session and leave it billing.
  const url = (response && response.ad && response.ad.manifestUrl)
    || (response && response.banner && response.banner.manifestUrl);
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
      // 🚨 creativesByCampaign() looks a creative up by THIS, not by the creative's
      // own campaignId. Without it the fixture below is invisible, the campaign is
      // never servable, and the suite fails at "an ad was selected" with no clue why.
      creativeEmbedId: 'e2e-creative',
      deliveredImpressions: -1, createdAt: new Date(),
    });
    ids.camp = camp.insertedId;

    const cre = await d.collection(cfg.AD_CREATIVES_COLLECTION).insertOne({
      campaignId: camp.insertedId, advertiserRef: 'E2E-TEST-REF', embedId: 'e2e-creative',
      // Formats match a campaign's creativeKind against this, so a fixture without
      // it is refused as the wrong kind — which is what silently broke this suite.
      kind: 'video',
      // A CID, because that is what a creative row holds. A url here would be a
      // fixture asserting the shape this change removed.
      durationSeconds: CREATIVE.dur, manifestCid: CREATIVE.cid,
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
    /* Every segment line must be absolute AND on a gateway a browser can actually read.
     *
     * This used to assert one specific hostname, hotipfs-3speak-1, and it passed only
     * because the PREFERRED gateway was failing at the time and the code was falling
     * back. When ipfs-3speak.b-cdn.net was fixed on the CDN side the splice got better
     * and the test went red, which is exactly backwards.
     *
     * The real invariant is the one the code enforces in isBrowserSafe(): never sign a
     * playlist pointing somewhere a browser cannot follow. ipfs.3speak.tv serves the
     * bytes with no Access-Control-Allow-Origin, so a playlist naming it plays fine
     * under curl and dies silently in the viewer's player. Assert that, not a host. */
    const SAFE = [...CORS_HOSTS, new URL(BASE).hostname];
    const segLines = t2.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const notAbsolute = segLines.filter((l) => !/^https?:\/\//.test(l));
    const unsafe = segLines.filter((l) => /^https?:\/\//.test(l) && !SAFE.includes(new URL(l).hostname));
    const cdnCount = segLines.filter((l) => /^https?:\/\//.test(l) && new URL(l).hostname.endsWith('b-cdn.net')).length;
    ok('every segment is absolute', notAbsolute.length === 0, `${notAbsolute.length} relative`);
    ok('  and on a gateway a browser can read', unsafe.length === 0,
      unsafe.length ? `unsafe: ${[...new Set(unsafe.map((l) => new URL(l).hostname))].join(', ')}` : '');
    ok('  content segments point at the CDN', cdnCount > 3, `${cdnCount} CDN segments`);
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

    /* The closing beacon is PACED: it cannot count until the spot has had time to
     * actually play, so a script cannot bank a completed impression in one round trip
     * (routes/adServe.js pacingRefusal). This test used to fire it immediately and then
     * assert the impression had completed, so the four checks below had been failing
     * against correct behaviour — which is the worst kind of red, because it makes the
     * thing that proves creators can be paid at all look permanently broken.
     *
     * Wait out the spot the way a player does. */
    const sessionDoc = await d.collection('ad_sessions').findOne({ sid });
    const spotSeconds = Number(sessionDoc?.adDurationSeconds) || 0;
    if (spotSeconds > 0) {
      console.log(`   ..  waiting ${spotSeconds}s for the spot to play (pacing gate)`);
      await new Promise((r) => setTimeout(r, (spotSeconds * 1000) + 750));
    }

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

    /* ── 8. the banner url handed to a PAGE ──
     *
     * The regression this exists for: an overlay banner's creative goes straight onto
     * a <video> element in the viewer's browser. That element gets ONE attempt and no
     * fallback, unlike every server-side fetch in adServe, which walks sibling
     * gateways. The creative row used to carry a gateway that answers 500 for anything
     * it has not already cached, which is every creative at the moment it is encoded.
     *
     * The symptom is why this is asserted rather than eyeballed: the banner drew
     * NOTHING while its close button, its open-in-new icon and its "Ad" label all
     * rendered correctly, because those three are built from the placement the server
     * sends and never touch the asset. It reads as a styling bug, not a dead url.
     *
     * Runs last: it opens a second session, and putting it earlier would perturb the
     * delivery counts every assertion above depends on. */
    console.log('\n── the banner url a page is given ──');
    const bCamp = await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).insertOne({
      advertiserRef: 'E2E-TEST-REF', hiveAccount: 'meno', projectName: 'E2E Test Co',
      name: 'E2E banner', format: 'video_banner', status: 'scheduled', slotPercent: 40,
      days: 7, markets: [], spotSeconds: 10, priceHbd: 10, paidHbd: 10,
      startAt: new Date(Date.now() - 60000), endAt: new Date(Date.now() + 864e5),
      creativeEmbedId: 'e2e-banner-creative',
      deliveredImpressions: -1, createdAt: new Date(),
    });
    ids.bCamp = bCamp.insertedId;
    await d.collection(cfg.AD_CREATIVES_COLLECTION).insertOne({
      advertiserRef: 'E2E-TEST-REF', embedId: 'e2e-banner-creative', kind: 'video',
      durationSeconds: 10, manifestCid: CREATIVE.cid, status: 'ready', createdAt: new Date(),
    });

    const bj = await (await fetch(`${BASE}/m/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // What the web player sends: draw the banner rather than burning it.
      body: JSON.stringify({
        owner: CONTENT.owner, permlink: CONTENT.permlink, capId: 'e2e-banner-cap',
        manifestUrl: contentManifest, bannerOverlay: true,
      }),
    })).json();
    ok('a banner was selected', !!(bj.banner && bj.banner.overlay),
      bj.banner ? 'no overlay on it' : `reason=${bj.reason}`);
    const vurl = bj.banner && bj.banner.overlay ? bj.banner.overlay.videoUrl : null;
    ok('  the page is given a url at all', !!vurl, String(vurl));
    const vhost = vurl ? new URL(vurl).hostname : '';
    ok('  on a gateway that sends CORS', CORS_HOSTS.includes(vhost), vhost);
    ok('  AND that can serve content it has not cached', COLD_CAPABLE_HOSTS.includes(vhost), vhost);
    await discardStray(d, cfg, bj, 'banner overlay');

  } finally {
    // ── clean up everything this test created ──
    await d.collection(cfg.ADVERTISERS_COLLECTION).deleteMany({ reference: 'E2E-TEST-REF' });
    await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).deleteMany({ advertiserRef: 'E2E-TEST-REF' });
    await d.collection(cfg.AD_CREATIVES_COLLECTION).deleteMany({ advertiserRef: 'E2E-TEST-REF' });
    if (ids.bCamp) {
      await d.collection(cfg.AD_IMPRESSIONS_COLLECTION).deleteMany({ campaignId: ids.bCamp });
      await d.collection('ad_sessions').deleteMany({ 'banner.campaignId': ids.bCamp });
    }
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
