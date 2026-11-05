/**
 * audioHiveSync: an embed-audio upload with no Hive post yet is matched against
 * the owner's recent comment ops, linked, tagged with the post's audio metadata
 * and flagged pay-per-listen from the post's beneficiaries.
 *
 * The worker calls the Hive nodes with fetch directly, so fetch is a fake JSON-RPC
 * node backed by in-memory posts and account history. Writes go to the real test
 * MongoDB.
 */
process.env.HIVE_RPC_ENDPOINTS = 'http://node-a.test,http://node-b.test';

const testDb = require('../helpers/db');
const { syncAudioHiveLinks } = require('../../services/audioHiveSync');

const db = testDb.use();
const audio = () => db().collection('embed-audio');

function skipDelays(...wanted) {
  const realSetTimeout = global.setTimeout;
  jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => (
    wanted.includes(ms) ? realSetTimeout(fn, 0, ...args) : realSetTimeout(fn, ms, ...args)));
}

// A JSON-RPC node: get_account_history from `history` (oldest first, deleted
// posts included), get_content from `live`. `fail` makes a method answer with
// a JSON-RPC error.
let history;
let live;
let fail;
let rpc;
let realFetch;
function installNode() {
  history = new Map();
  live = new Map();
  fail = new Set();
  rpc = [];
  realFetch = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    rpc.push({ url, method, params });
    const reply = (value) => ({ json: async () => value });
    if (fail.has(method)) return reply({ error: { message: `${method} unavailable` } });
    if (method === 'condenser_api.get_account_history') {
      const ops = (history.get(params[0]) || []).map((c, i) => [i, { op: ['comment', c] }]);
      return reply({ result: ops });
    }
    if (method === 'condenser_api.get_content') {
      return reply({ result: live.get(`${params[0]}/${params[1]}`) || { author: '', permlink: '', beneficiaries: [] } });
    }
    throw new Error(`unexpected ${method}`);
  });
}
function publish(post, { alive = true, into = post.author } = {}) {
  const full = { parent_author: '', parent_permlink: 'hive-181335', body: '', json_metadata: '{}', ...post };
  if (!history.has(into)) history.set(into, []);
  history.get(into).push(full);
  if (alive) live.set(`${full.author}/${full.permlink}`, { beneficiaries: [], ...full });
  return full;
}

const track = (owner, permlink, extra = {}) => ({
  owner, permlink, status: 'published', audio_cid: `cid-${permlink}`, createdAt: new Date('2026-10-30T00:00:00Z'), ...extra,
});
const playBody = (permlink) => `Listen: https://audio.3speak.tv/play?a=${permlink}`;
const get = (permlink) => audio().findOne({ permlink });

beforeEach(() => {
  skipDelays(500);
  installNode();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { global.fetch = realFetch; });

describe('linking a track to its post', () => {
  test('links the post that references the track and copies type, genre and bpm', async () => {
    publish({
      author: 'dj', permlink: 'my-track-post', body: playBody('trk1'),
      json_metadata: JSON.stringify({ audio: { type: 'music', genre: 'house', bpm: '124' } }),
    });
    await audio().insertOne(track('dj', 'trk1'));

    const res = await syncAudioHiveLinks();

    expect(res).toEqual({ checked: 1, linked: 1, errors: 0 });
    expect(await get('trk1')).toMatchObject({
      post_permlink: 'my-track-post', post_author: 'dj', category: 'music', genre: 'house', bpm: 124, ppl: false,
    });
  });

  test('a post that embeds the audio CID instead of the permlink also counts', async () => {
    publish({ author: 'dj', permlink: 'p', body: 'player?audio_cid=cid-trk2 here' });
    await audio().insertOne(track('dj', 'trk2'));

    await syncAudioHiveLinks();

    expect((await get('trk2')).post_permlink).toBe('p');
  });

  test.each([
    ['all weight to the PPL account', [{ account: 'threespeak-audio', weight: 10000 }], true],
    ['split entries that add up past 90%', [{ account: 'threespeak-audio', weight: 5000 }, { account: 'threespeak-audio', weight: 4000 }], true],
    ['a small platform cut only', [{ account: 'threespeak-audio', weight: 1000 }, { account: 'other', weight: 9000 }], false],
    ['no beneficiaries', [], false],
  ])('pay-per-listen flag: %s -> %p', async (_label, beneficiaries, expected) => {
    publish({ author: 'dj', permlink: 'p', body: playBody('trk'), beneficiaries });
    await audio().insertOne(track('dj', 'trk'));

    await syncAudioHiveLinks();

    expect((await get('trk')).ppl).toBe(expected);
  });

  test('when the beneficiaries cannot be read the ppl flag is left unset, not guessed', async () => {
    publish({ author: 'dj', permlink: 'p', body: playBody('trk') });
    fail.add('condenser_api.get_content');
    await audio().insertOne(track('dj', 'trk'));

    await syncAudioHiveLinks();

    const d = await get('trk');
    expect(d.post_permlink).toBe('p');
    expect(d).not.toHaveProperty('ppl');
  });

  test('broken or partial audio metadata is ignored, the link still happens', async () => {
    publish({ author: 'dj', permlink: 'p1', body: playBody('t1'), json_metadata: '{oops' });
    publish({ author: 'dj', permlink: 'p2', body: playBody('t2'), json_metadata: { audio: { genre: 5, bpm: 'fast', type: 'podcast' } } });
    await audio().insertMany([track('dj', 't1'), track('dj', 't2')]);

    await syncAudioHiveLinks();

    expect(await get('t1')).toMatchObject({ post_permlink: 'p1' });
    expect(await get('t1')).not.toHaveProperty('genre');
    const t2 = await get('t2');
    expect(t2).toMatchObject({ post_permlink: 'p2', category: 'podcast' });
    expect(t2).not.toHaveProperty('genre');
    expect(t2).not.toHaveProperty('bpm');
  });

  test('a reply by somebody else in the owner\'s history is never linked', async () => {
    publish({ author: 'troll', permlink: 'quote', body: playBody('trk') }, { into: 'dj' });
    await audio().insertOne(track('dj', 'trk'));

    await syncAudioHiveLinks();

    expect(await get('trk')).toMatchObject({ hive_link_checked: true });
    expect((await get('trk')).post_permlink).toBeUndefined();
  });
});

describe('what gets scanned', () => {
  test('only published tracks with no link and not yet checked, at most 30 per run, newest first', async () => {
    await audio().insertMany([
      ...Array.from({ length: 31 }, (_, i) => track('dj', `t${String(i).padStart(2, '0')}`, {
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      })),
      track('dj', 'draft', { status: 'uploaded' }),
      track('dj', 'linked', { post_permlink: 'x' }),
      track('dj', 'checked', { hive_link_checked: true }),
    ]);

    const res = await syncAudioHiveLinks();

    expect(res.checked).toBe(30);
    expect(await get('t00')).not.toHaveProperty('hive_link_checked'); // the oldest waits
    expect(await get('draft')).not.toHaveProperty('hive_link_checked');
  });

  test('one history read per owner, rotating across the configured nodes', async () => {
    await audio().insertMany([track('a', 't1'), track('a', 't2'), track('b', 't3')]);

    await syncAudioHiveLinks();

    const walks = rpc.filter((r) => r.method === 'condenser_api.get_account_history');
    expect(walks.map((r) => r.params[0]).sort()).toEqual(['a', 'b']);
    expect(walks[0].params).toEqual([walks[0].params[0], -1, 50, 2, 0]);
    expect(new Set(rpc.map((r) => r.url))).toEqual(new Set(['http://node-a.test', 'http://node-b.test']));
  });

  test('running again changes nothing: a miss is stamped once and then skipped', async () => {
    publish({ author: 'dj', permlink: 'p', body: playBody('hit') });
    await audio().insertMany([track('dj', 'hit'), track('dj', 'miss')]);
    await syncAudioHiveLinks();
    const after = await audio().find({}).sort({ permlink: 1 }).toArray();
    rpc.length = 0;

    const res = await syncAudioHiveLinks();

    expect(res).toEqual({ checked: 0, linked: 0, errors: 0 });
    expect(rpc).toHaveLength(0);
    expect(await audio().find({}).sort({ permlink: 1 }).toArray()).toEqual(after);
  });
});

describe('failures', () => {
  test('a failing database write for one owner is counted and the others still run', async () => {
    publish({ author: 'a', permlink: 'pa', body: playBody('ta') });
    publish({ author: 'b', permlink: 'pb', body: playBody('tb') });
    await audio().insertMany([track('a', 'ta', { createdAt: new Date('2026-10-31') }), track('b', 'tb')]);
    const { Collection } = require('mongodb');
    const realUpdate = Collection.prototype.updateOne;
    jest.spyOn(Collection.prototype, 'updateOne').mockImplementation(function (filter, update, ...rest) {
      if (update.$set && update.$set.post_author === 'a') return Promise.reject(new Error('write conflict'));
      return realUpdate.call(this, filter, update, ...rest);
    });

    const res = await syncAudioHiveLinks();

    expect(res).toEqual({ checked: 2, linked: 1, errors: 1 });
    expect((await get('tb')).post_permlink).toBe('pb');
  });

  // BUG: getRecentPosts() swallows every RPC failure into [] (services/audioHiveSync.js:67),
  // so a node error or a network blip reads as "the owner has no posts" and every
  // track in the batch is stamped hive_link_checked: true (line 199). That stamp is
  // permanent: the query excludes it and nothing ever clears it, so a single bad
  // minute on Hive leaves those tracks unlinked for good.
  test.skip('BUG: a Hive outage does not permanently mark tracks as checked', async () => {
    publish({ author: 'dj', permlink: 'p', body: playBody('trk') });
    fail.add('condenser_api.get_account_history');
    await audio().insertOne(track('dj', 'trk'));

    await syncAudioHiveLinks();

    expect(await get('trk')).not.toHaveProperty('hive_link_checked');
    fail.clear();
    await syncAudioHiveLinks();
    expect((await get('trk')).post_permlink).toBe('p');
  });

  // BUG: the match is posts.find() over account history, which is oldest first
  // (services/audioHiveSync.js:155), and the chosen post is never checked to
  // still exist. A client that publishes twice and deletes one attempt can leave
  // the track linked to the deleted post. videoHiveSync.js:497-500 documents and
  // fixes exactly this for videos (newest live post wins via get_content).
  test.skip('BUG: a track is linked to the live post, not to a deleted older twin', async () => {
    publish({ author: 'dj', permlink: 'attempt-1', body: playBody('trk') }, { alive: false });
    publish({ author: 'dj', permlink: 'attempt-2', body: playBody('trk') });
    await audio().insertOne(track('dj', 'trk'));

    await syncAudioHiveLinks();

    expect((await get('trk')).post_permlink).toBe('attempt-2');
  });

  test('an empty backlog makes no Hive call', async () => {
    expect(await syncAudioHiveLinks()).toEqual({ checked: 0, linked: 0, errors: 0 });
    expect(rpc).toHaveLength(0);
  });
});
