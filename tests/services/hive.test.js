/**
 * utils/hive.js: the Hive reads behind feeds, payouts and engagement.
 *
 * tests/hiveNodes.test.js already covers node failover and cooldown. This file is
 * about what the readers do with the answers: date-bounded history paging, the
 * per-post caches and their TTLs, "a failed batch is ABSENT, never zero", the
 * follower and following walks, and the comment walk with its anchor skipping.
 *
 * A fake node answers each JSON-RPC method from a table (global fetch is
 * replaced, nothing leaves the process). Every test gets a fresh copy of the
 * module, so the caches start empty, and Date.now is pinned.
 */
jest.mock('../../utils/config', () => ({
  ...jest.requireActual('../../utils/config'),
  HIVE_RPC_ENDPOINTS: ['https://node-a', 'https://node-b'],
  HIVE_RPC_TIMEOUT_MS: 3000,
  HIVE_RPC_HEAVY_TIMEOUT_MS: 10000,
  HIVE_NODE_COOLDOWN_MS: 60000,
}));

const T0 = Date.parse('2026-11-01T12:00:00Z');
let now;
let hive;
let methods; // method -> (params, request, endpoint) => result | { error } | throws
let requests; // every JSON-RPC request the code sent: { endpoint, method, params }

function fakeNode() {
  global.fetch = jest.fn(async (endpoint, init) => {
    const body = JSON.parse(init.body);
    const batch = Array.isArray(body) ? body : [body];
    const answers = [];
    for (const r of batch) {
      requests.push({ endpoint, method: r.method, params: r.params });
      const fn = methods[r.method];
      if (!fn) throw new Error(`[fake node] no handler for ${r.method}`);
      const out = await fn(r.params, r, endpoint);
      if (out === SKIP) continue; // the node silently dropped this entry
      answers.push(out && out.error ? { jsonrpc: '2.0', id: r.id, error: out.error } : { jsonrpc: '2.0', id: r.id, result: out });
    }
    return { json: async () => (Array.isArray(body) ? answers : answers[0]) };
  });
}
const SKIP = Symbol('skip');

beforeEach(() => {
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  requests = [];
  methods = {};
  fakeNode();
  jest.isolateModules(() => { hive = require('../../utils/hive'); });
});

const iso = (ms) => new Date(ms).toISOString().slice(0, 19); // Hive style: UTC, no zone
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

describe('historySince / transfersSince: paging back to a date', () => {
  // An account with `n` history entries, index 0..n-1, one per hour ending at T0.
  function account(n) {
    const all = Array.from({ length: n }, (_, i) => [i, { timestamp: iso(T0 - (n - 1 - i) * HOUR), op: ['transfer', { amount: `${i}.000 HBD` }] }]);
    methods['condenser_api.get_account_history'] = ([, start, limit]) => {
      const top = start === -1 ? n - 1 : start;
      return all.filter(([i]) => i <= top).slice(-limit);
    };
    return all;
  }

  test('walks pages backwards until the oldest entry predates the cutoff', async () => {
    account(50);
    const out = await hive.transfersSince('ads', T0 - 25 * HOUR, { pageSize: 10 });
    const starts = requests.map((r) => r.params[1]);
    expect(starts).toEqual([-1, 39, 29]); // three pages, each starting one below the last
    expect(out.map(([i]) => i)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    // the transfer filter (op id 2) is asked for
    expect(requests[0].params).toEqual(['ads', -1, 10, 4, 0]);
  });

  test('stops at the account\'s first operation', async () => {
    account(15);
    const out = await hive.historySince('ads', 0, 1 << 18, { pageSize: 10 });
    expect(out).toHaveLength(15);
    expect(requests).toHaveLength(2);
  });

  test('maxPages is a backstop against an unbounded scan', async () => {
    account(1000);
    await hive.historySince('ads', 0, 4, { pageSize: 10, maxPages: 3 });
    expect(requests).toHaveLength(3);
  });

  test('timestamps are read as UTC whatever the server time zone', async () => {
    // Entry exactly at the cutoff stops the walk; a local-time parse would shift it by hours.
    account(30);
    await hive.historySince('ads', T0 - 9 * HOUR, 4, { pageSize: 10 });
    expect(requests).toHaveLength(1);
  });

  test('an empty or failed answer ends the walk with what it has', async () => {
    methods['condenser_api.get_account_history'] = () => ({ error: { message: 'boom' } });
    await expect(hive.historySince('ads', 0, 4)).resolves.toEqual([]);
    global.fetch.mockRejectedValue(new Error('down'));
    await expect(hive.historySince('ads', 0, 4)).resolves.toEqual([]);
  });

  test('history is a heavy call: the long timeout, config order', async () => {
    const seen = [];
    const real = AbortSignal.timeout;
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { seen.push(ms); return real.call(AbortSignal, ms); });
    account(3);
    await hive.historySince('ads', 0, 4);
    expect(seen).toEqual([10000]);
  });
});

describe('hiveReputationToScore', () => {
  test.each([
    ['0', 25],
    [0, 25],
    ['garbage', 25],
    [undefined, 25],
    ['1000000000', 25],          // log10 = 9, the floor
    ['999999999', 25],           // below 1e9 clamps to 25 too
    ['10000000000', 34],
    ['95832978796820', 69.8],    // a well-known account
    ['-10000000000', 16],        // negative reputation goes below 25
  ])('%p -> %p', (raw, score) => {
    expect(hive.hiveReputationToScore(raw)).toBe(score);
  });
});

describe('fetchHiveRewards: trending sort data, cached 15 minutes', () => {
  const post = (author, permlink, extra = {}) => ({
    author, permlink, title: `T ${permlink}`, body: 'b',
    pending_payout_value: '1.500 HBD', total_payout_value: '0.250 HBD', curator_payout_value: '0.250 HBD',
    json_metadata: JSON.stringify({ tags: ['hive', '3speak'] }),
    author_reputation: '95832978796820',
    ...extra,
  });

  beforeEach(() => {
    methods['condenser_api.get_content'] = ([author, permlink]) => post(author, permlink);
  });

  test('sums pending, paid and curator payout and reads title, body and tags', async () => {
    const map = await hive.fetchHiveRewards([{ author: 'alice', permlink: 'p1' }]);
    expect(map.get('alice/p1')).toEqual({ reward: 2, title: 'T p1', body: 'b', tags: ['hive', '3speak'], sound: null });
    expect(hive.reputationCache.get('alice').reputation).toBe(69.8);
  });

  test('a short\'s music is passed on, trimmed to safe lengths', async () => {
    methods['condenser_api.get_content'] = ([a, p]) => post(a, p, {
      json_metadata: JSON.stringify({ video: { sound: { title: 'x'.repeat(500), artist: 'Band', account: 'a'.repeat(40), url: 7 } } }),
    });
    const { sound } = (await hive.fetchHiveRewards([{ author: 'alice', permlink: 'p1' }])).get('alice/p1');
    expect(sound.title).toHaveLength(100);
    expect(sound.artist).toBe('Band');
    expect(sound.account).toHaveLength(16);
    expect(sound.url).toBeUndefined(); // not a string
  });

  test.each([
    ['broken JSON', '{nope'],
    ['tags not an array', JSON.stringify({ tags: 'music' })],
    ['a sound without a title', JSON.stringify({ video: { sound: { artist: 'x' } } })],
  ])('bad metadata (%s) means no tags / no sound, not a crash', async (_l, json_metadata) => {
    methods['condenser_api.get_content'] = ([a, p]) => post(a, p, { json_metadata });
    const row = (await hive.fetchHiveRewards([{ author: 'alice', permlink: 'p1' }])).get('alice/p1');
    expect(row.sound).toBeNull();
    expect(Array.isArray(row.tags)).toBe(true);
  });

  test('more than 20 posts go out as parallel batches of 20', async () => {
    const items = Array.from({ length: 45 }, (_, i) => ({ author: 'alice', permlink: `p${i}` }));
    const map = await hive.fetchHiveRewards(items);
    expect(map.size).toBe(45);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    const sizes = global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).length).sort((a, b) => b - a);
    expect(sizes).toEqual([20, 20, 5]);
  });

  test('a cached post is not asked for again within 15 minutes, and is after', async () => {
    await hive.fetchHiveRewards([{ author: 'alice', permlink: 'p1' }]);
    now += 15 * 60 * 1000 - 1;
    await hive.fetchHiveRewards([{ author: 'alice', permlink: 'p1' }]);
    expect(requests).toHaveLength(1);
    now += 1;
    await hive.fetchHiveRewards([{ author: 'alice', permlink: 'p1' }]);
    expect(requests).toHaveLength(2);
  });

  test('a post the node did not return reads as zero, and is NOT cached', async () => {
    methods['condenser_api.get_content'] = () => SKIP;
    const map = await hive.fetchHiveRewards([{ author: 'alice', permlink: 'gone' }]);
    expect(map.get('alice/gone')).toEqual({ reward: 0, title: '', body: '', tags: [] });
    methods['condenser_api.get_content'] = ([a, p]) => post(a, p);
    expect((await hive.fetchHiveRewards([{ author: 'alice', permlink: 'gone' }])).get('alice/gone').reward).toBe(2);
  });
});

describe('fetchHiveVideoStats: card numbers from bridge.get_post', () => {
  beforeEach(() => {
    methods['bridge.get_post'] = ({ author, permlink }) => ({ author, permlink, payout: 3.14159, stats: { total_votes: 12 }, children: 4 });
  });

  test('payout rounded to 3 places, votes and comments', async () => {
    const map = await hive.fetchHiveVideoStats([{ author: 'alice', permlink: 'p1' }]);
    expect(map.get('alice/p1')).toEqual({ reward: 3.142, votes: 12, comments: 4 });
  });

  test('a failed batch leaves its posts ABSENT, so a stored value is never zeroed', async () => {
    global.fetch.mockRejectedValue(new Error('all nodes down'));
    const map = await hive.fetchHiveVideoStats([{ author: 'alice', permlink: 'p1' }]);
    expect(map.size).toBe(0);
  });

  test('half-formed answers and incomplete keys are skipped', async () => {
    methods['bridge.get_post'] = ({ author, permlink }) => (permlink === 'odd' ? { payout: 1 } : { author, permlink });
    const map = await hive.fetchHiveVideoStats([
      { author: 'alice', permlink: 'odd' }, { author: 'alice', permlink: 'bare' }, { author: '', permlink: 'x' }, { author: 'bob' },
    ]);
    expect([...map.entries()]).toEqual([['alice/bare', { reward: 0, votes: 0, comments: 0 }]]);
    expect(requests.map((r) => r.params.permlink)).toEqual(['odd', 'bare']);
  });

  test('cached per post for the given ttl, with the batch size honoured', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ author: 'a', permlink: `p${i}` }));
    await hive.fetchHiveVideoStats(items, { batchSize: 3 });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    now += 999;
    await hive.fetchHiveVideoStats(items, { ttl: 1000 });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    now += 1;
    await hive.fetchHiveVideoStats(items, { ttl: 1000 });
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });
});

describe('fetchLivePageData: uncached display data for one page', () => {
  test('full card data, defaults for posts the node did not return', async () => {
    methods['condenser_api.get_content'] = ([author, permlink]) => (permlink === 'gone' ? SKIP : {
      author, permlink, title: 'T', body: 'B', net_votes: 9, children: 2,
      pending_payout_value: '1.000 HBD', total_payout_value: '0.000 HBD', curator_payout_value: '0.000 HBD',
      json_metadata: '{"tags":["a"]}', author_reputation: '10000000000',
    });
    const map = await hive.fetchLivePageData([{ author: 'alice', permlink: 'p1' }, { author: 'alice', permlink: 'gone' }]);
    expect(map.get('alice/p1')).toEqual({ reward: 1, title: 'T', body: 'B', tags: ['a'], votes: 9, comments: 2, author_reputation: 34 });
    expect(map.get('alice/gone')).toEqual({ reward: 0, title: '', body: '', tags: [], votes: 0, comments: 0, author_reputation: 25 });
  });

  test('broken metadata still yields the post, without tags', async () => {
    methods['condenser_api.get_content'] = ([author, permlink]) => ({ author, permlink, json_metadata: '{' });
    const map = await hive.fetchLivePageData([{ author: 'alice', permlink: 'p1' }]);
    expect(map.get('alice/p1').tags).toEqual([]);
  });

  test('is never served from the cache', async () => {
    methods['condenser_api.get_content'] = ([author, permlink]) => ({ author, permlink });
    await hive.fetchLivePageData([{ author: 'alice', permlink: 'p1' }]);
    await hive.fetchLivePageData([{ author: 'alice', permlink: 'p1' }]);
    expect(requests).toHaveLength(2);
  });
});

describe('fetchFollowerCounts', () => {
  beforeEach(() => {
    methods['condenser_api.get_follow_count'] = ([account]) => (account === 'ghost' ? SKIP : { account, follower_count: account.length * 10 });
  });

  test('counts per author, cached for four hours', async () => {
    const map = await hive.fetchFollowerCounts(['alice', 'bob']);
    expect(Object.fromEntries(map)).toEqual({ alice: 50, bob: 30 });
    now += 4 * HOUR - 1;
    await hive.fetchFollowerCounts(['alice', 'bob']);
    expect(requests).toHaveLength(2);
    now += 1;
    await hive.fetchFollowerCounts(['alice']);
    expect(requests).toHaveLength(3);
  });

  test('an author the node did not answer for gets `missing` (0 by default)', async () => {
    expect((await hive.fetchFollowerCounts(['ghost'])).get('ghost')).toBe(0);
    expect((await hive.fetchFollowerCounts(['ghost'], { missing: null })).get('ghost')).toBeNull();
  });

  test('staleOnFailure: a Hive hiccup serves the last known count instead', async () => {
    await hive.fetchFollowerCounts(['alice']);
    now += 5 * HOUR; // expired
    global.fetch.mockRejectedValue(new Error('down'));
    expect((await hive.fetchFollowerCounts(['alice'], { missing: null, staleOnFailure: true })).get('alice')).toBe(50);
    expect((await hive.fetchFollowerCounts(['alice'], { missing: null })).get('alice')).toBeNull();
  });

  test('a zero follower count from the node is a real zero', async () => {
    methods['condenser_api.get_follow_count'] = ([account]) => ({ account });
    expect((await hive.fetchFollowerCounts(['newbie'], { missing: null })).get('newbie')).toBe(0);
  });
});

describe('getFollowingList', () => {
  // `n` followed accounts, paged like condenser: a page starts AT the start name.
  function follows(n, { failPage } = {}) {
    const names = Array.from({ length: n }, (_, i) => `u${String(i).padStart(5, '0')}`);
    let page = 0;
    methods['condenser_api.get_following'] = ([, start, , limit]) => {
      page += 1;
      if (failPage === page) return { error: { message: 'node hiccup' } };
      const from = start ? names.indexOf(start) : 0;
      return names.slice(from, from + limit).map((following) => ({ follower: 'me', following, what: ['blog'] }));
    };
    return names;
  }

  test('walks past 1000 without counting the repeated anchor twice', async () => {
    const names = follows(2500);
    const list = await hive.getFollowingList('me');
    expect(list).toEqual(names);
    expect(requests.map((r) => r.params[1])).toEqual(['', 'u00999', 'u01998']);
  });

  test('cached for ten minutes', async () => {
    follows(3);
    await hive.getFollowingList('me');
    now += 10 * 60 * 1000 - 1;
    await hive.getFollowingList('me');
    expect(requests).toHaveLength(1);
    now += 1;
    await hive.getFollowingList('me');
    expect(requests).toHaveLength(2);
  });

  test('following nobody, or a failed first page, is null and not cached', async () => {
    follows(0);
    expect(await hive.getFollowingList('me')).toBeNull();
    follows(2);
    expect(await hive.getFollowingList('me')).toEqual(['u00000', 'u00001']);
  });

  test('a thrown error is caught and reads as null', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    methods['condenser_api.get_following'] = () => { throw new Error('x'); };
    global.fetch.mockImplementation(async () => ({ json: async () => { throw new SyntaxError('html'); } }));
    expect(await hive.getFollowingList('me')).toBeNull();
  });

  // Regression: a page that failed mid-walk used to end the loop like a short page,
  // and the TRUNCATED list was cached for ten minutes as if it were the whole answer.
  // Someone following 2500 accounts got a follow feed (and new-video push fan-out)
  // built from the first 1000 until the cache expired. A failed page returns the
  // stale/no list (null) rather than caching a partial one.
  test('a page that fails mid-walk does not cache a truncated following list', async () => {
    follows(2500, { failPage: 2 });
    const list = await hive.getFollowingList('me');
    expect(list === null || list.length === 2500).toBe(true);
  });
});

describe('mulberry32: the seeded shuffle', () => {
  test('the same seed gives the same sequence, in [0, 1)', () => {
    const a = hive.mulberry32(42);
    const b = hive.mulberry32(42);
    const seqA = Array.from({ length: 50 }, a);
    expect(Array.from({ length: 50 }, b)).toEqual(seqA);
    for (const x of seqA) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });

  test('another seed gives another sequence', () => {
    expect(hive.mulberry32(1)()).not.toBe(hive.mulberry32(2)());
  });
});

describe('fetchCommentReplyCounts', () => {
  const reply = (app) => ({ json_metadata: JSON.stringify({ app }) });

  test('counts direct replies and native 3Speak ones, mapped back by request id', async () => {
    methods['condenser_api.get_content_replies'] = ([, permlink]) => ({
      p0: [reply('3speak/new-version'), reply('peakd/1.0'), reply('threespeak')],
      p1: [],
      p2: [reply('ecency')],
    }[permlink]);
    // The node answers in reverse order: mapping must use the id, not the position.
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url, init) => {
      const res = await realFetch(url, init);
      const arr = await res.json();
      return { json: async () => arr.reverse() };
    });
    const map = await hive.fetchCommentReplyCounts([
      { author: 'a', permlink: 'p0' }, { author: 'a', permlink: 'p1' }, { author: 'a', permlink: 'p2' },
    ], { batchSize: 2 });
    expect(Object.fromEntries(map)).toEqual({
      'a/p0': { comments: 3, native3Speak: 2, commenters: 0, nativeCommenters: 0 },
      'a/p1': { comments: 0, native3Speak: 0, commenters: 0, nativeCommenters: 0 },
      'a/p2': { comments: 1, native3Speak: 0, commenters: 0, nativeCommenters: 0 },
    });
  });

  test('commenters are distinct accounts other than the post author', async () => {
    const by = (author, app) => ({ author, json_metadata: JSON.stringify({ app }) });
    methods['condenser_api.get_content_replies'] = () => [
      // One viewer's live chat: many top-level replies, one person.
      ...Array.from({ length: 30 }, () => by('viewer', '3speak/new-version')),
      by('Viewer', 'peakd/1.0'),                 // same account, other case + app
      by('other', 'ecency'),
      by('streamer', '3speak/new-version'),      // the creator answering in chat
      by('', 'peakd/1.0'),                       // no author: not a commenter
    ];
    const map = await hive.fetchCommentReplyCounts([{ author: 'Streamer', permlink: 'vod' }]);
    expect(map.get('Streamer/vod')).toEqual({ comments: 34, native3Speak: 31, commenters: 2, nativeCommenters: 1 });
  });

  test('an error entry or a dropped entry leaves that post absent', async () => {
    methods['condenser_api.get_content_replies'] = ([, permlink]) => (permlink === 'bad' ? { error: { message: 'x' } } : permlink === 'drop' ? SKIP : []);
    const map = await hive.fetchCommentReplyCounts([{ author: 'a', permlink: 'bad' }, { author: 'a', permlink: 'drop' }, { author: 'a', permlink: 'ok' }]);
    expect([...map.keys()]).toEqual(['a/ok']);
  });

  test('an answer with an id outside the batch is ignored', async () => {
    global.fetch = jest.fn(async () => ({ json: async () => [{ id: 99, result: [] }, null] }));
    expect((await hive.fetchCommentReplyCounts([{ author: 'a', permlink: 'p' }])).size).toBe(0);
  });

  test('json_metadata given as an object is read too', () => {
    expect(hive.isNative3SpeakComment({ json_metadata: { app: '3speak/openpod' } })).toBe(true);
    expect(hive.isNative3SpeakComment({ json_metadata: null })).toBe(false);
    expect(hive.isNative3SpeakComment({ json_metadata: '{bad' })).toBe(false);
  });
});

describe('hiveRpcCall', () => {
  test('returns the result of the first node that has one', async () => {
    methods['bridge.get_community'] = (_p, _r, endpoint) => (endpoint === 'https://node-a' ? { error: { message: 'not hivemind' } } : { name: 'hive-1' });
    await expect(hive.hiveRpcCall('bridge.get_community', { name: 'hive-1' })).resolves.toEqual({ name: 'hive-1' });
    expect(requests.map((r) => r.endpoint)).toEqual(['https://node-a', 'https://node-b']);
  });

  test('a total outage is null ("no data"), never an empty answer', async () => {
    global.fetch.mockRejectedValue(new Error('down'));
    await expect(hive.hiveRpcCall('bridge.get_post', {})).resolves.toBeNull();
  });

  test('a null result is a real answer and is returned as null', async () => {
    methods['bridge.get_post'] = () => null;
    await expect(hive.hiveRpcCall('bridge.get_post', {})).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('a heavy method keeps config order and never marks a node down', async () => {
    let first = true;
    global.fetch = jest.fn(async (endpoint) => {
      if (first) { first = false; throw new Error('slow'); }
      return { json: async () => ({ result: endpoint }) };
    });
    await expect(hive.hiveRpcCall('condenser_api.get_account_history', ['x', -1, 1])).resolves.toBe('https://node-b');
    // node-a was not marked down: a normal call still tries it first.
    global.fetch = jest.fn(async (endpoint) => ({ json: async () => [{ result: endpoint }] }));
    const [r] = await hive.hiveRpcBatch([{ method: 'condenser_api.get_content' }]);
    expect(r.result).toBe('https://node-a');
  });
});

describe('fetchAccountComments: the 90-day comment walk', () => {
  // `n` comments, newest first, one per day before T0.
  function comments(n, { url = true } = {}) {
    const all = Array.from({ length: n }, (_, i) => ({
      author: 'viewer',
      permlink: `re-${i}`,
      parent_author: i % 2 ? 'SomeReplier' : 'Creator',
      parent_permlink: `parent-${i}`,
      url: url ? `/hive-181335/@Creator/video-${i}#@viewer/re-${i}` : undefined,
      created: iso(T0 - (i + 1) * DAY),
      depth: 1 + (i % 2),
    }));
    methods['bridge.get_account_posts'] = ({ start_author: sa, start_permlink: sp, limit }) => {
      const from = sa ? all.findIndex((c) => c.author === sa && c.permlink === sp) : 0;
      return all.slice(from, from + limit);
    };
    return all;
  }

  test('pages of 20, the anchor of each page skipped, newest first', async () => {
    comments(45);
    const out = await hive.fetchAccountComments('@Viewer', 0);
    expect(out).toHaveLength(45);
    expect(new Set(out.map((c) => c.permlink)).size).toBe(45);
    expect(requests.map((r) => r.params.start_permlink)).toEqual(['', 're-19', 're-38']);
    expect(requests[0].params).toMatchObject({ sort: 'comments', account: 'viewer', limit: 20 });
  });

  test('stops at the first comment older than the cutoff', async () => {
    comments(100);
    const out = await hive.fetchAccountComments('viewer', T0 - 30.5 * DAY);
    expect(out).toHaveLength(30);
    expect(requests).toHaveLength(2);
  });

  test('the root author comes from the url, not from parent_author', async () => {
    comments(2);
    const [first, second] = await hive.fetchAccountComments('viewer', 0);
    expect(first).toMatchObject({ root_author: 'creator', root_permlink: 'video-0', parent_author: 'creator', depth: 1 });
    expect(second).toMatchObject({ root_author: 'creator', root_permlink: 'video-1', parent_author: 'somereplier' });
    expect(first.created).toBe(T0 - DAY);
  });

  test('without a url it falls back to the parent', async () => {
    comments(1, { url: false });
    const [c] = await hive.fetchAccountComments('viewer', 0);
    expect(c).toMatchObject({ root_author: 'creator', root_permlink: 'parent-0' });
  });

  test('a comment with an unreadable date is skipped, not fatal', async () => {
    methods['bridge.get_account_posts'] = () => [{ author: 'viewer', permlink: 'x', created: 'yesterday' }];
    await expect(hive.fetchAccountComments('viewer', 0)).resolves.toEqual([]);
  });

  test('an empty account name asks nothing', async () => {
    await expect(hive.fetchAccountComments('  @ ', 0)).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });

  test('maxPages bounds the walk; a non-array answer ends it', async () => {
    comments(500);
    await hive.fetchAccountComments('viewer', 0, { maxPages: 2 });
    expect(requests).toHaveLength(2);
    methods['bridge.get_account_posts'] = () => ({ not: 'an array' });
    await expect(hive.fetchAccountComments('viewer', 0)).resolves.toEqual([]);
  });
});

describe('hiveRpcBatch answers', () => {
  test('a single (non-array) answer is wrapped in an array', async () => {
    global.fetch = jest.fn(async () => ({ json: async () => ({ id: 1, result: 'x' }) }));
    await expect(hive.hiveRpcBatch([{ method: 'condenser_api.get_content' }])).resolves.toEqual([{ id: 1, result: 'x' }]);
  });
});
