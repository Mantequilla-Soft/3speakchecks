/* Ticker ad format, end to end: rate card, beta booking gate, text creative rules,
 * attach, serving gates, counted click, impression pacing, 5-minute cap.
 * Runs against a THROWAWAY database (threespeak_tickertest) and drops it after:
 * it fakes a paid flight, which the live payout run would pay.
 *   node scripts/test-ad-ticker.cjs */
// End-to-end test of the ticker format against a THROWAWAY database.
// Never the live one: this fakes a paid flight, and the live payout run would pay it.
process.env.DATABASE_NAME = 'threespeak_tickertest';
// The format is public by default now. The beta gates still exist as settings, so they
// are switched ON here to keep testing that they hold.
process.env.AD_TICKER_BETA_ONLY = 'true';
process.env.AD_TICKER_ALLOWED_OWNERS = 'badadib';
const ROOT = '/mnt/HC_Volume_103240961/prodops/services/3speakchecks';
process.chdir(ROOT);
require(`${ROOT}/node_modules/dotenv`).config({ path: `${ROOT}/.env` });
process.env.DATABASE_NAME = 'threespeak_tickertest';

const express = require(`${ROOT}/node_modules/express`);
const db = require(`${ROOT}/utils/db`);
const cfg = require(`${ROOT}/utils/config`);

let fails = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fails += 1;
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label.padEnd(58)} ${detail}`);
};

(async () => {
  if (cfg.DATABASE_NAME !== 'threespeak_tickertest') throw new Error(`refusing: db is ${cfg.DATABASE_NAME}`);
  await db.connectToMongo();
  const d = db.getDb();
  if (d.databaseName !== 'threespeak_tickertest') throw new Error(`refusing: connected to ${d.databaseName}`);

  const app = express();
  app.use('/advertise', require(`${ROOT}/routes/adCampaigns`));
  app.use('/m', require(`${ROOT}/routes/adServe`));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, path, body) => {
    const r = await fetch(base + path, {
      method, redirect: 'manual',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null; try { data = await r.json(); } catch { /* redirect or text */ }
    return { status: r.status, data, location: r.headers.get('location') };
  };

  try {
    await d.collection(cfg.ADVERTISERS_COLLECTION).insertMany([
      { reference: 'TICK-BETA', hiveAccount: 'meno', projectName: 'Ticker Co', status: 'approved', website: 'https://example.com/site', createdAt: new Date() },
      { reference: 'TICK-OUT', hiveAccount: 'someoneelse', projectName: 'Outsider', status: 'approved', createdAt: new Date() },
    ]);

    console.log('-- rate card');
    const plain = await j('GET', '/advertise/pricing');
    ok('hidden from the default rate card', !(plain.data?.formats || []).some((f) => f.key === 'video_ticker'));
    const pr = await j('GET', '/advertise/pricing?reference=TICK-BETA&beta=1');
    const tf = (pr.data?.formats || []).find((f) => f.key === 'video_ticker');
    ok('ticker on the rate card', !!tf);
    ok('marked beta, overlay-only, positioned', tf?.beta && tf?.overlayOnly && tf?.positioned);
    ok('creative kind text, 140 char spec', tf?.creativeKind === 'text' && tf?.creativeSpec?.maxChars === 140);

    console.log('-- booking gate');
    const slot = (cfg.AD_SLOT_PERCENTS || [25]).find((p) => p > 0) ?? 25;
    const book = (reference, format = 'video_ticker') => j('POST', '/advertise/campaigns', {
      reference, format, days: 1, slotPercent: slot, spotSeconds: 10,
    });
    const out = await book('TICK-OUT');
    ok('non-beta account refused', out.status === 403, `${out.status} ${out.data?.error || ''}`);
    const inn = await book('TICK-BETA');
    const campId = inn.data?.campaign?.id;
    ok('beta account books', inn.status === 201 && !!campId, `${inn.status} ${inn.data?.error || ''}`);
    const roll = await book('TICK-BETA', 'video_roll');
    const rollId = roll.data?.campaign?.id;

    console.log('-- text creative');
    const long = await j('POST', '/advertise/creatives', { reference: 'TICK-BETA', message: 'x'.repeat(141), clickUrl: 'https://example.com' });
    ok('141 chars refused', long.status === 400, long.data?.error);
    const http = await j('POST', '/advertise/creatives', { reference: 'TICK-BETA', message: 'Hello', clickUrl: 'http://example.com' });
    ok('http link refused', http.status === 400, http.data?.error);
    const good = await j('POST', '/advertise/creatives', {
      reference: 'TICK-BETA', message: 'Try Ticker Co\ntoday,   it is great', clickUrl: 'https://example.com/go?x=1',
    });
    const key = good.data?.creative?.embedId;
    ok('creative saved in review', good.status === 201 && good.data?.creative?.status === 'review', key);
    ok('newline + spaces folded', good.data?.creative?.message === 'Try Ticker Co today, it is great');
    const again = await j('POST', '/advertise/creatives', { reference: 'TICK-BETA', message: 'Try Ticker Co today, it is great', clickUrl: 'https://example.com/go?x=1' });
    ok('same text = same creative', again.data?.creative?.embedId === key);

    console.log('-- attach');
    const att = await j('POST', `/advertise/campaigns/${campId}/creative`, { reference: 'TICK-BETA', embedId: key });
    ok('ticker attached to ticker flight', att.status === 200, `${att.status} ${att.data?.error || ''}`);
    const bad = await j('POST', `/advertise/campaigns/${rollId}/creative`, { reference: 'TICK-BETA', embedId: key });
    ok('ticker refused on a roll flight', bad.status === 400, bad.data?.error);
    const filey = await j('POST', `/advertise/campaigns/${campId}/creative`, { reference: 'TICK-BETA', imageUrl: 'https://example.com/a.png' });
    ok('image refused on a ticker flight', filey.status === 400, filey.data?.error);

    // Paid and in window, as the claim route would leave it. Throwaway db only.
    const { ObjectId } = require(`${ROOT}/node_modules/mongodb`);
    await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).updateOne(
      { _id: new ObjectId(campId) },
      { $set: { status: 'running', paidHbd: 1, startAt: new Date(Date.now() - 60000), endAt: new Date(Date.now() + 86400000) } },
    );

    console.log('-- serving');
    let n = 0;
    const session = (owner, extra = {}) => j('POST', '/m/session', {
      owner, permlink: `tickertest-${n += 1}`, manifestUrl: 'https://example.com/v.m3u8',
      capId: 'abcdef0123456789abcdef01', viewer: 'meno', ticker: true, ...extra,
    });
    const inReview = await session('badadib');
    ok('creative in review: nothing served', !inReview.data?.ticker, inReview.data?.reason);
    await d.collection(cfg.AD_CREATIVES_COLLECTION).updateOne({ embedId: key }, { $set: { status: 'ready' } });

    const noFlag = await session('badadib', { ticker: false });
    ok('client without ticker flag: none', !noFlag.data?.ticker, noFlag.data?.reason);
    const anon = await session('badadib', { viewer: 'randomviewer', capId: 'ffffeeee0123456789abcdef' });
    ok('any viewer on badadib: served', !!anon.data?.ticker, anon.data?.reason || '');
    const notOwner = await session('meno');
    ok('non-allowlisted owner: none', !notOwner.data?.ticker, notOwner.data?.reason);
    const s = await session('badadib');
    const t = s.data?.ticker;
    ok('badadib + flag: ticker served', !!t, s.data?.reason || '');
    ok('ticker carries message/account/product', t?.message === 'Try Ticker Co today, it is great' && t?.account === 'meno' && t?.productName === 'Ticker Co');
    ok('position + seconds from the booking', t?.positionPercent === slot && t?.durationSeconds === 10, `${t?.positionPercent} ${t?.durationSeconds}`);
    ok('no roll, no banner, no manifest', !s.data?.ad && !s.data?.banner);
    const sid = (t?.clickUrl || '').match(/\/m\/([0-9a-f]{32})\/tc/)?.[1];
    ok('click url is our own counted redirect', !!sid, t?.clickUrl);

    console.log('-- click + impression');
    const c1 = await j('GET', `/m/${sid}/tc`);
    ok('click redirects to the APPROVED link', c1.status === 302 && c1.location === 'https://example.com/go?x=1', `${c1.status} ${c1.location}`);
    await j('GET', `/m/${sid}/tc`);
    const camp = await d.collection(cfg.AD_CAMPAIGNS_COLLECTION).findOne({ _id: new ObjectId(campId) });
    ok('click counted once', camp.clicks === 1, String(camp.clicks));
    const early = await j('POST', `/m/${sid}/ticker-shown`, {});
    ok('impression claimed too soon: refused', early.data?.ok === false && early.data?.reason === 'too_soon', JSON.stringify(early.data));
    await d.collection('ad_sessions').updateOne({ sid }, { $set: { startedAt: new Date(Date.now() - 60000) } });
    const shown = await j('POST', `/m/${sid}/ticker-shown`, {});
    ok('impression recorded after the run', shown.data?.ok === true, JSON.stringify(shown.data));
    const imp = await d.collection(cfg.AD_IMPRESSIONS_COLLECTION).findOne({ sid, campaignId: new ObjectId(campId) });
    ok('impression row tagged ticker + completed', imp?.ticker === true && imp?.completed === true, JSON.stringify({ ticker: imp?.ticker, completed: imp?.completed }));

    console.log('-- frequency cap');
    const capped = await session('badadib');
    ok('same viewer again inside the window: none', !capped.data?.ticker, capped.data?.reason);
    ok('ticker carries its cap (5 min)', t?.capMinutes === 5, String(t?.capMinutes));
    await d.collection('ad_sessions').updateMany({}, { $set: { startedAt: new Date(Date.now() - 6 * 60000) } });
    const after = await session('badadib');
    ok('6 minutes later: served again (not the banner 10 / roll 15)', !!after.data?.ticker, after.data?.reason || '');
  } finally {
    server.close();
    if (d.databaseName === 'threespeak_tickertest') await d.dropDatabase();
    console.log(`\n${fails ? `${fails} FAILED` : 'all passed'}  (throwaway db dropped)`);
    process.exit(fails ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
