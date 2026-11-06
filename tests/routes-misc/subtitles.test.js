/**
 * Captions: an author correcting their own video's captions (routes/subtitleEdit.js)
 * and the same-origin SRT proxy (routes/subtitleProxy.js).
 *
 * The IPFS node next door is a local stub. The public gateways are never reached:
 * fetch is wrapped so a test decides what each gateway answers, and the proxy's
 * CID check is shown to stop it from fetching anything but a bare CID.
 */
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { pinClock, NOW, startStub } = require('./_fixtures');

const db = testDb.use();
const T = NOW.getTime();

const alice = hiveAccount('alice', { postingDelegates: ['threespeak', 'peakd.app'] });
const mallory = hiveAccount('mallory');
const threespeak = hiveAccount('threespeak');
const peakd = hiveAccount('peakd.app');
const busy = hiveAccount('busy-author');

// ── the IPFS node stub ───────────────────────────────────────────────────────
const ipfs = {
  added: [],          // { query, body } of every /api/v0/add
  nextHash: null,     // the CID the next add answers with
  addStatus: 200,
  onAdd: null,        // runs before the add answers (to simulate a concurrent edit)
  cat: {},            // cid -> text the node holds
  catStatus: 200,
};
let ipfsStub;
let app;
let E; // subtitleEdit._test

beforeAll(async () => {
  ipfsStub = await startStub((a) => {
    a.post('/api/v0/add', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
      ipfs.added.push({ query: req.query, body: req.body.toString('utf8') });
      if (ipfs.onAdd) await ipfs.onAdd();
      if (ipfs.addStatus !== 200) return res.status(ipfs.addStatus).end();
      return res.json(ipfs.nextHash === undefined ? {} : { Hash: ipfs.nextHash || `QmNew${ipfs.added.length}` });
    });
    a.post('/api/v0/cat', (req, res) => {
      if (ipfs.catStatus !== 200) return res.status(ipfs.catStatus).end();
      const text = ipfs.cat[req.query.arg];
      return text === undefined ? res.status(404).end() : res.type('text/plain').send(text);
    });
  });
  process.env.IPFS_API_URL = `${ipfsStub.url}/`;
  app = buildApp(['/', require('../../routes/subtitleEdit')], ['/', require('../../routes/subtitleProxy')]);
  E = require('../../routes/subtitleEdit')._test;
});
afterAll(() => ipfsStub.close());

beforeEach(() => {
  Object.assign(ipfs, { added: [], nextHash: null, addStatus: 200, onAdd: null, cat: {}, catStatus: 200 });
  ipfsStub.seen.length = 0;
});

describe('SRT building (pure helpers)', () => {
  test.each([
    [0, '00:00:00,000'],
    [1.5, '00:00:01,500'],
    [3661.0456, '01:01:01,046'],
    [-3, '00:00:00,000'],
  ])('srtTime(%p) is %p', (s, out) => {
    expect(E.srtTime(s)).toBe(out);
  });

  test('cue text is plain: no tags, no control characters, two trimmed lines at most, 500 characters', () => {
    expect(E.cleanText('<b>Hi</b> <script>x</script>there')).toBe('Hi xthere');
    expect(E.cleanText('a\u0000b\u0007c')).toBe('abc');
    expect(E.cleanText('  one \n\n two \r\n three ')).toBe('one\ntwo');
    expect(E.cleanText('y'.repeat(900))).toHaveLength(500);
  });

  test('cuesToSrt numbers the blocks and ends every block with a blank line', () => {
    expect(E.cuesToSrt([{ start: 0, end: 1, text: 'A' }, { start: 1, end: 2.25, text: 'B' }]))
      .toBe('1\n00:00:00,000 --> 00:00:01,000\nA\n\n2\n00:00:01,000 --> 00:00:02,250\nB\n\n');
  });

  test.each([
    ['not a list', 'x'],
    ['an empty list', []],
    ['more than 6000 cues', Array.from({ length: 6001 }, () => ({ start: 0, end: 1, text: 'a' }))],
    ['a start that is not a number', [{ start: 'soon', end: 1, text: 'a' }]],
    ['a negative start', [{ start: -1, end: 1, text: 'a' }]],
    ['an end before the start', [{ start: 5, end: 4, text: 'a' }]],
    ['an end past 24 hours', [{ start: 0, end: 24 * 3600 + 1, text: 'a' }]],
    ['only emptied lines', [{ start: 0, end: 1, text: '  ' }, { start: 1, end: 2, text: '<i></i>' }]],
  ])('validCues refuses %s', (_label, cues) => {
    expect(E.validCues(cues)).toBeNull();
  });

  test('validCues drops emptied lines and keeps the rest', () => {
    expect(E.validCues([{ start: 0, end: 1, text: 'keep' }, { start: 1, end: 2, text: '' }, { start: 2, end: 3 }]))
      .toEqual([{ start: 0, end: 1, text: 'keep' }]);
  });
});

describe('POST /subtitles/edit', () => {
  const CUES = [{ start: 0, end: 2, text: 'Hello <b>world</b>' }, { start: 2, end: 4.5, text: 'Second line' }];
  const srtOf = (cues) => E.cuesToSrt(E.validCues(cues));
  const shaOf = (cues) => crypto.createHash('sha256').update(srtOf(cues), 'utf8').digest('hex');

  function editRequest({ signer = alice, author = 'alice', permlink = 'my-video', lang = 'en', cues = CUES, timestamp = T } = {}, signFor = {}) {
    const m = { author, permlink, lang, sha: shaOf(cues), timestamp, ...signFor };
    return { author, permlink, lang, cues, timestamp, signature: signer.sign(E.editMessage(m.author, m.permlink, m.lang, m.sha, m.timestamp)) };
  }
  const send = (body) => request(app).post('/subtitles/edit').send(body);
  const row = () => db().collection('subtitles').findOne({ author: 'alice', permlink: 'my-video' });

  beforeEach(async () => {
    pinClock(NOW);
    fakeHiveChain([alice, mallory, threespeak, peakd, busy]);
    await db().collection('subtitles').insertOne({ author: 'alice', permlink: 'my-video', subtitles: { en: 'QmOldEn', es: 'QmOldEs' } });
  });
  afterEach(() => jest.useRealTimers());

  describe('input', () => {
    test.each([
      ['an invalid author', { author: 'Not Valid' }],
      ['a permlink with a dot', { permlink: 'a.b' }],
      ['a language that would be a nested key', { lang: 'en.x' }],
      ['a language that is an operator', { lang: '$set' }],
      ['no language', { lang: '' }],
    ])('400 for %s', async (_label, change) => {
      await send({ ...editRequest(), ...change }).expect(400, { success: false, error: 'invalid author, permlink or language' });
    });

    test('400 for captions that do not validate', async () => {
      await send({ ...editRequest(), cues: [{ start: 3, end: 1, text: 'x' }] }).expect(400, { success: false, error: 'invalid captions' });
      expect(ipfs.added).toHaveLength(0);
    });

    test('413 for captions over 1 MB once rebuilt', async () => {
      // Mounted without a global JSON parser so the route's own 2 MB body limit
      // applies (see the BUG test below for what server.js does instead).
      const bare = express().use('/', require('../../routes/subtitleEdit'));
      const big = Array.from({ length: 2500 }, (_, i) => ({ start: i, end: i + 1, text: 'z'.repeat(480) }));
      await request(bare).post('/subtitles/edit').send({ ...editRequest(), cues: big }).expect(413, { success: false, error: 'captions too large' });
      expect(ipfs.added).toHaveLength(0);
    });

    // BUG (server.js:83 with routes/subtitleEdit.js:122): server.js parses every JSON
    // body first with express.json() at its default 100 kB limit, so the route's own
    // express.json({ limit: '2mb' }) never runs. Captions of a long video (here
    // 1500 cues, about 200 kB) are refused with 413 before the route sees them.
    test('captions between 100 kB and 1 MB can be saved through the server.js middleware stack', async () => {
      const long = Array.from({ length: 1500 }, (_, i) => ({ start: i, end: i + 1, text: `line ${i} `.padEnd(90, 'x') }));
      await send(editRequest({ cues: long })).expect(200);
    });

    // SECURITY, denial of service (routes/subtitleEdit.js:85 and :124-126): input is
    // read outside any try/catch in an async handler. Express 4 does not catch a
    // rejected handler promise and server.js installs no unhandledRejection handler,
    // so on Node 22 the whole checker process exits. No signature is needed: a cue
    // of null, or an object with a non-callable toString where a string is expected,
    // is enough. Correct behaviour is a 400.
    test.each([
      ['a null cue', { author: 'alice', permlink: 'my-video', lang: 'en', cues: [null] }],
      ['an author object that cannot become a string', { author: { toString: 1 }, permlink: 'my-video', lang: 'en', cues: CUES }],
      ['a language object that cannot become a string', { author: 'alice', permlink: 'my-video', lang: { toString: 1 }, cues: CUES }],
    ])('%s is a 400, not an unhandled rejection that kills the process', async (_label, body) => {
      await send(body).timeout(2000).expect(400);
    });
  });

  describe('who may edit', () => {
    test('401 without a signature, with the message to sign (it carries the SRT hash)', async () => {
      const res = await send({ author: 'alice', permlink: 'my-video', lang: 'en', cues: CUES }).expect(401);
      expect(res.body.expected_message).toBe(`3speak-captions|edit|alice|my-video|en|${shaOf(CUES)}|<ms>`);
    });

    test('401 for an expired signature', async () => {
      await send(editRequest({ timestamp: T - 6 * 60 * 1000 })).expect(401, { success: false, error: 'timestamp out of tolerance' });
    });

    test('a viewer cannot replace the author captions', async () => {
      await send(editRequest({ signer: mallory })).expect(401, { success: false, error: 'Invalid signature' });
      expect(ipfs.added).toHaveLength(0);
      expect((await row()).subtitles.en).toBe('QmOldEn');
    });

    test('a valid signature for your own account cannot reach another author captions', async () => {
      await send(editRequest({ signer: mallory, author: 'mallory' })).expect(404, { success: false, error: 'no captions in this language' });
      expect((await row()).subtitles.en).toBe('QmOldEn');
    });

    test.each([
      ['other text', { sha: 'f'.repeat(64) }],
      ['another language', { lang: 'es' }],
      ['another video', { permlink: 'other-video' }],
      ['another time', { timestamp: T - 1 }],
    ])('a signature made for %s is refused', async (_label, signFor) => {
      await send(editRequest({}, signFor)).expect(401);
      expect(ipfs.added).toHaveLength(0);
    });

    test('a third-party delegate the author granted (peakd.app) is refused', async () => {
      await send(editRequest({ signer: peakd })).expect(401);
    });

    test('404 when the author is not a Hive account', async () => {
      await send(editRequest({ signer: mallory, author: 'ghost-user' })).expect(404, { success: false, error: 'Hive account not found' });
    });

    test('a garbage signature is a 401', async () => {
      await send({ ...editRequest(), signature: 'zzz' }).expect(401);
    });
  });

  describe('saving', () => {
    test('stores the rebuilt SRT pinned on IPFS and records who replaced what', async () => {
      const res = await send(editRequest()).expect(200);
      expect(res.body).toEqual({ success: true, cid: 'QmNew1' });

      expect(ipfs.added).toHaveLength(1);
      expect(ipfs.added[0].query).toEqual({ pin: 'true', 'cid-version': '0' });
      expect(ipfs.added[0].body).toContain(srtOf(CUES));
      expect(ipfs.added[0].body).not.toContain('<b>');

      const saved = await row();
      expect(saved.subtitles).toEqual({ en: 'QmNew1', es: 'QmOldEs' });
      expect(saved.subtitle_edits.en).toEqual({
        by: 'alice', signedBy: 'alice', at: NOW, lines: 2, history: [{ cid: 'QmOldEn', replacedAt: NOW }],
      });
    });

    test('@threespeak signing for the author is recorded as the signer', async () => {
      await send(editRequest({ signer: threespeak })).expect(200);
      expect((await row()).subtitle_edits.en).toMatchObject({ by: 'alice', signedBy: 'threespeak' });
    });

    test('each edit puts the replaced file first in a history capped at 20', async () => {
      const old = Array.from({ length: 20 }, (_, i) => ({ cid: `QmH${i}`, replacedAt: NOW }));
      await db().collection('subtitles').updateOne({ author: 'alice' }, { $set: { 'subtitle_edits.en': { history: old } } });
      await send(editRequest()).expect(200);
      const { history } = (await row()).subtitle_edits.en;
      expect(history).toHaveLength(20);
      expect(history[0].cid).toBe('QmOldEn');
      expect(history[19].cid).toBe('QmH18');
    });

    test('saving unchanged captions (same CID) changes nothing', async () => {
      ipfs.nextHash = 'QmOldEn';
      await send(editRequest()).expect(200, { success: true, cid: 'QmOldEn', unchanged: true });
      expect(await row()).not.toHaveProperty('subtitle_edits');
    });

    test('404 for a language the video has no captions in: adding languages is not this route', async () => {
      await send(editRequest({ lang: 'de' })).expect(404);
      expect(ipfs.added).toHaveLength(0);
    });

    test('409 when the captions were replaced between reading and writing', async () => {
      ipfs.onAdd = () => db().collection('subtitles').updateOne({ author: 'alice' }, { $set: { 'subtitles.en': 'QmSomeoneElse' } });
      await send(editRequest()).expect(409);
      expect((await row()).subtitles.en).toBe('QmSomeoneElse');
    });

    test.each([
      ['answers 500', { addStatus: 500 }],
      ['answers without a hash', { nextHash: undefined }],
    ])('502 when the IPFS node %s, and the row is untouched', async (_label, state) => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      Object.assign(ipfs, state);
      await send(editRequest()).expect(502, { success: false, error: 'could not save the captions' });
      expect((await row()).subtitles.en).toBe('QmOldEn');
    });

    test('an author is braked after 60 saves in an hour', async () => {
      await db().collection('subtitles').insertOne({ author: 'busy-author', permlink: 'v', subtitles: { en: 'QmX' } });
      const body = editRequest({ signer: busy, author: 'busy-author', permlink: 'v' });
      ipfs.nextHash = 'QmX'; // unchanged each time, so the row stays put
      for (let i = 0; i < 60; i += 1) await send(body).expect(200);
      await send(body).expect(429);
    });
  });
});

describe('GET /subtitle-proxy/:cid', () => {
  const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const CDN = `https://hotipfs-3speak-1.b-cdn.net/ipfs/${CID}`;
  const PUBLIC = `https://ipfs.3speak.tv/ipfs/${CID}`;
  const realFetch = global.fetch;
  let gateway; // url -> Response factory, or an Error to throw
  let fetched;

  beforeEach(() => {
    gateway = {};
    fetched = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
      fetched.push(String(url));
      if (String(url).startsWith(ipfsStub.url)) return realFetch(url, opts);
      const answer = gateway[url];
      if (answer instanceof Error) throw answer;
      if (answer) return answer();
      throw new TypeError('fetch failed');
    });
  });

  test.each([
    ['too short', 'Qm123'],
    ['a path traversal', '..%2F..%2Fetc%2Fpasswd'],
    ['a full URL', encodeURIComponent('http://169.254.169.254/latest/meta-data')],
    ['a CID with a path', encodeURIComponent(`${CID}/../x`)],
    ['a CID with a query', encodeURIComponent(`${CID}?x=1`)],
    ['a CID with an IPFS API argument injected', encodeURIComponent(`${CID}&arg=other`)],
  ])('400 for %s, and nothing is fetched', async (_label, cid) => {
    await request(app).get(`/subtitle-proxy/${cid}`).expect(400, { success: false, error: 'invalid cid' });
    expect(fetched).toEqual([]);
  });

  test('the node next door answers first, as cacheable plain text', async () => {
    ipfs.cat[CID] = '1\n00:00:00,000 --> 00:00:01,000\nHi\n\n';
    const res = await request(app).get(`/subtitle-proxy/${CID}`).expect(200);
    expect(res.text).toBe(ipfs.cat[CID]);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(fetched).toEqual([`${ipfsStub.url}/api/v0/cat?arg=${CID}`]);
    expect(ipfsStub.seen.at(-1).method).toBe('POST');
  });

  test('when the node lacks the file the CDN gateway is next', async () => {
    gateway[CDN] = () => new Response('from cdn', { status: 200 });
    const res = await request(app).get(`/subtitle-proxy/${CID}`).expect(200);
    expect(res.text).toBe('from cdn');
    expect(fetched.slice(1)).toEqual([CDN]);
  });

  test('when the CDN 500s the public gateway is tried last', async () => {
    ipfs.catStatus = 500;
    gateway[CDN] = () => new Response('x', { status: 500 });
    gateway[PUBLIC] = () => new Response('from public', { status: 200 });
    const res = await request(app).get(`/subtitle-proxy/${CID}`).expect(200);
    expect(res.text).toBe('from public');
    expect(fetched.slice(1)).toEqual([CDN, PUBLIC]);
  });

  test('502 with the last status when every source fails', async () => {
    gateway[CDN] = () => new Response('', { status: 500 });
    gateway[PUBLIC] = () => new Response('', { status: 404 });
    const res = await request(app).get(`/subtitle-proxy/${CID}`).expect(502);
    expect(res.body).toEqual({ success: false, error: 'no gateway succeeded', lastStatus: 404 });
  });

  test('a timed-out source is reported as 504, an unreachable one as 502', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    gateway[CDN] = new TypeError('fetch failed');
    gateway[PUBLIC] = abort;
    const timedOut = await request(app).get(`/subtitle-proxy/${CID}`).expect(502);
    expect(timedOut.body.lastStatus).toBe(504);

    gateway[PUBLIC] = new TypeError('fetch failed');
    const unreachable = await request(app).get(`/subtitle-proxy/${CID}`).expect(502);
    expect(unreachable.body.lastStatus).toBe(502);
  });

  test('an unreachable local node falls through to the gateways', async () => {
    global.fetch.mockImplementation(async (url) => {
      fetched.push(String(url));
      if (String(url).startsWith(ipfsStub.url)) throw Object.assign(new Error('t'), { name: 'AbortError' });
      return new Response('gateway copy', { status: 200 });
    });
    const res = await request(app).get(`/subtitle-proxy/${CID}`).expect(200);
    expect(res.text).toBe('gateway copy');
  });
});
