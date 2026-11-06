/**
 * Scheduled posts worker: a queued post is broadcast only once it is due, only
 * once, only when well formed, and stranded claims are reconciled against the
 * chain instead of being blindly retried.
 *
 * The posting key is a throwaway one derived from a test seed; broadcasts are
 * captured on dhive's BroadcastAPI and never leave the process. The embed API is
 * a fake fetch, the chain read behind isPostOnChain is a fake hiveRpcBatch, and
 * every status change lands in the real test MongoDB.
 */
const dhive = require('@hiveio/dhive');

process.env.SCHEDULED_POSTS_RUNNER = 'true';
process.env.THREESPEAK_POSTING_KEY = dhive.PrivateKey.fromSeed('checker-tests:threespeak-scheduler').toString();
process.env.EMBED_API_URL = 'http://embed.test/';
process.env.EMBED_API_KEY = 'test-embed-key';

jest.mock('../../utils/hive', () => ({ hiveRpcBatch: jest.fn() }));

const { BroadcastAPI } = require('@hiveio/dhive/lib/helpers/broadcast');
const testDb = require('../helpers/db');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { hiveRpcBatch } = require('../../utils/hive');
const scheduled = require('../../services/scheduledPosts');
const { NOW, MINUTE, HOUR, ago, ahead, fakeFetch } = require('./_fixtures');

const db = testDb.use();
const posts = () => db().collection(scheduled.COLLECTION);

const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

let broadcasts;
let embedFetch;
let realFetch;

function stubBroadcast(impl) {
  broadcasts = [];
  return jest.spyOn(BroadcastAPI.prototype, 'sendOperations').mockImplementation(async (ops, key) => {
    // Only whether the configured key signed it is kept: a failing assertion must
    // never print key material, even a throwaway one.
    broadcasts.push({ ops, signedWithConfiguredKey: key.toString() === process.env.THREESPEAK_POSTING_KEY });
    if (impl) return impl(ops, broadcasts.length);
    return { id: `tx${broadcasts.length}` };
  });
}

// A due, well formed post. Everything the create route would store.
const post = (permlink, extra = {}) => ({
  owner: 'alice',
  permlink,
  title: `Title ${permlink}`,
  body: `Body of ${permlink}`,
  jsonMetadata: { app: '3speak/0.3', tags: ['threespeak'] },
  status: 'scheduled',
  attempts: 0,
  scheduledOn: ago(MINUTE),
  createdAt: ago(HOUR),
  ...extra,
});
const byPermlink = (permlink) => posts().findOne({ permlink });

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ONLY_DATE });
  stubBroadcast();
  hiveRpcBatch.mockReset();
  embedFetch = fakeFetch([['http://embed.test/', () => ({ status: 200, body: { ok: true } })]]);
  realFetch = global.fetch;
  global.fetch = embedFetch;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

describe('publishing only what is due', () => {
  test('a due post is broadcast once and marked posted with its transaction id', async () => {
    await posts().insertOne(post('due'));

    await scheduled.runOnce();

    expect(broadcasts).toHaveLength(1);
    const d = await byPermlink('due');
    expect(d).toMatchObject({ status: 'posted', broadcastTxId: 'tx1', lastError: null, attempts: 1 });
    expect(d.postedAt).toEqual(NOW);
  });

  test('a post scheduled for later is left alone until its time comes', async () => {
    await posts().insertOne(post('later', { scheduledOn: ahead(HOUR) }));

    await scheduled.runOnce();
    expect(broadcasts).toHaveLength(0);
    expect((await byPermlink('later')).status).toBe('scheduled');

    jest.setSystemTime(ahead(HOUR + MINUTE));
    await scheduled.runOnce();
    expect(broadcasts).toHaveLength(1);
    expect((await byPermlink('later')).status).toBe('posted');
  });

  test('due posts go out oldest first, at most ten per tick', async () => {
    await posts().insertMany(Array.from({ length: 12 }, (_, i) => post(`p${String(i).padStart(2, '0')}`, {
      scheduledOn: ago((20 - i) * MINUTE),
    })));

    await scheduled.runOnce();

    expect(broadcasts.map((b) => b.ops[0][1].permlink)).toEqual(
      ['p00', 'p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09'],
    );
    expect(await posts().countDocuments({ status: 'scheduled' })).toBe(2);
  });

  test('running again after a post went out broadcasts nothing', async () => {
    await posts().insertOne(post('once'));
    await scheduled.runOnce();
    const after = await byPermlink('once');

    await scheduled.runOnce();

    expect(broadcasts).toHaveLength(1);
    expect(await byPermlink('once')).toEqual(after);
  });

  test('two overlapping ticks never broadcast the same post twice', async () => {
    await posts().insertMany([post('a'), post('b')]);

    await Promise.all([scheduled.runOnce(), scheduled.runOnce()]);

    expect(broadcasts.map((b) => b.ops[0][1].permlink).sort()).toEqual(['a', 'b']);
  });

  test.each([
    ['status is not scheduled', { status: 'draft' }],
    ['the attempt cap is spent', { attempts: 3 }],
    ['the owner is empty', { owner: '' }],
    ['the permlink is not a string', { permlink: 42 }],
  ])('a post is never claimed when %s', async (_label, extra) => {
    await posts().insertOne(post('x', extra));

    await scheduled.runOnce();

    expect(broadcasts).toHaveLength(0);
    expect(await posts().findOne({})).toMatchObject({ attempts: extra.attempts || 0 });
  });
});

describe('the operations that are signed', () => {
  test('a default post: comment under the 3Speak community, 50/50 payout, metadata as JSON', async () => {
    await posts().insertOne(post('default', {
      beneficiaries: [{ account: 'spk.beneficiary', weight: 900 }, { account: '', weight: 5 }, { account: 'x', weight: 'a lot' }],
    }));

    await scheduled.runOnce();

    const [comment, options] = broadcasts[0].ops;
    expect(comment).toEqual(['comment', {
      parent_author: '',
      parent_permlink: 'hive-181335',
      author: 'alice',
      permlink: 'default',
      title: 'Title default',
      body: 'Body of default',
      json_metadata: JSON.stringify({ app: '3speak/0.3', tags: ['threespeak'] }),
    }]);
    expect(options).toEqual(['comment_options', {
      author: 'alice',
      permlink: 'default',
      max_accepted_payout: '1000000.000 HBD',
      percent_hbd: 10000,
      allow_votes: true,
      allow_curation_rewards: true,
      // Malformed beneficiaries are dropped before signing.
      extensions: [[0, { beneficiaries: [{ account: 'spk.beneficiary', weight: 900 }] }]],
    }]);
    expect(broadcasts[0].signedWithConfiguredKey).toBe(true);
  });

  test.each([
    ['powerup', { max_accepted_payout: '1000000.000 HBD', percent_hbd: 0 }, 1],
    ['DECLINE', { max_accepted_payout: '0.000 HBD', percent_hbd: 10000 }, 0],
  ])('payout option %s', async (payoutOptions, expected, extensionCount) => {
    await posts().insertOne(post('p', {
      payoutOptions, beneficiaries: [{ account: 'b', weight: 1000 }],
      parentPermlink: 'hive-100000', jsonMetadata: '{"raw":true}',
    }));

    await scheduled.runOnce();

    const [comment, options] = broadcasts[0].ops;
    expect(comment[1]).toMatchObject({ parent_permlink: 'hive-100000', json_metadata: '{"raw":true}' });
    expect(options[1]).toMatchObject(expected);
    expect(options[1].extensions).toHaveLength(extensionCount);
  });
});

describe('malformed and failing posts', () => {
  test.each([
    ['an empty body', { body: '   ' }, 'doc.body missing or empty'],
    ['a non-string title', { title: { evil: true } }, 'doc.title must be a string'],
  ])('a claimed post with %s is failed without ever being signed', async (_label, extra, message) => {
    await posts().insertOne(post('bad', extra));

    await scheduled.runOnce();

    expect(broadcasts).toHaveLength(0);
    expect(await byPermlink('bad')).toMatchObject({ status: 'failed', lastError: `validation: ${message}` });
  });

  test('a post that keeps failing is failed for good after three attempts and never signed again', async () => {
    stubBroadcast(() => { throw new Error('RC exhausted'); });
    await posts().insertOne(post('flaky'));

    for (let tick = 0; tick < 4; tick++) await scheduled.runOnce();

    expect(await byPermlink('flaky')).toMatchObject({ status: 'failed', attempts: 3, lastError: 'RC exhausted' });
    expect(broadcasts).toHaveLength(3);
  });

  // Regression: after a failed broadcast the post is put back to `scheduled`, but it
  // is still due, so the next iteration of the same tick's loop used to claim it
  // again. A single RPC blip burned all three attempts within milliseconds and the
  // post landed in `failed` instead of being retried INTERVAL_MIN later.
  test('a failed broadcast is retried on the next tick, not three times in the same one', async () => {
    stubBroadcast(() => { throw new Error('timeout'); });
    await posts().insertOne(post('flaky'));

    await scheduled.runOnce();

    expect(broadcasts.map((b) => b.ops[0][1].permlink)).toEqual(['flaky']);
    expect(await byPermlink('flaky')).toMatchObject({ status: 'scheduled', attempts: 1, lastError: 'timeout' });
  });

  test('one failing post does not stop the rest of the tick', async () => {
    stubBroadcast((ops) => { if (ops[0][1].permlink === 'a') throw new Error('boom'); return { id: 'ok' }; });
    await posts().insertMany([post('a', { scheduledOn: ago(2 * MINUTE) }), post('b')]);

    await scheduled.runOnce();

    expect((await byPermlink('a')).status).not.toBe('posted');
    expect((await byPermlink('b')).status).toBe('posted');
  });
});

describe('after the broadcast', () => {
  test('the embed video is linked to the new post, then given its thumbnail', async () => {
    await posts().insertOne(post('linked', {
      embedPermlink: 'asset 1', thumbnail: 'https://img/t.jpg', tags: ['a', 'b'],
    }));

    await scheduled.runOnce();

    expect(embedFetch.calls.map((c) => c.url)).toEqual([
      'http://embed.test/video/asset%201/hive',
      'http://embed.test/video/asset%201/thumbnail',
    ]);
    const [hive, thumb] = embedFetch.calls;
    expect(hive.init.headers).toMatchObject({ 'X-API-Key': 'test-embed-key' });
    expect(JSON.parse(hive.init.body)).toEqual({
      hive_author: 'alice', hive_permlink: 'linked', hive_title: 'Title linked', hive_body: 'Body of linked', hive_tags: ['a', 'b'],
    });
    expect(JSON.parse(thumb.init.body)).toEqual({ thumbnail_url: 'https://img/t.jpg' });
  });

  test('no embedPermlink means no embed call; no thumbnail means only the /hive call', async () => {
    await posts().insertMany([post('plain'), post('nothumb', { embedPermlink: 'e2', scheduledOn: ago(30 * MINUTE) })]);

    await scheduled.runOnce();

    expect(embedFetch.calls.map((c) => c.url)).toEqual(['http://embed.test/video/e2/hive']);
  });

  test.each([
    ['answers 500', () => ({ status: 500, body: 'down' })],
    ['is unreachable', () => { throw new Error('ECONNREFUSED'); }],
  ])('an embed API that %s does not undo the post', async (_label, responder) => {
    global.fetch = fakeFetch([['http://embed.test/', responder]]);
    await posts().insertOne(post('p', { embedPermlink: 'e', thumbnail: 'https://img/t.jpg' }));

    await scheduled.runOnce();

    expect((await byPermlink('p')).status).toBe('posted');
    expect(global.fetch.calls).toHaveLength(2); // the thumbnail step is still attempted
  });

  test('"add to my blog" reblogs the post as its own signed op; a failed reblog is ignored', async () => {
    stubBroadcast((ops) => {
      if (ops[0][0] === 'custom_json') throw new Error('already reblogged');
      return { id: 'tx' };
    });
    await posts().insertOne(post('reb', { reblog: true }));

    await scheduled.runOnce();

    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1].ops).toEqual([['custom_json', {
      required_auths: [],
      required_posting_auths: ['alice'],
      id: 'follow',
      json: JSON.stringify(['reblog', { account: 'alice', author: 'alice', permlink: 'reb' }]),
    }]]);
    expect((await byPermlink('reb')).status).toBe('posted');
  });

  test('a per-video ad opt-out in the metadata is mirrored for the ad server', async () => {
    await posts().insertOne(post('noads', { jsonMetadata: { '3speak': { ads: false } } }));

    await scheduled.runOnce();

    expect(await db().collection('ad_video_optouts').findOne({ _id: 'alice/noads' }))
      .toMatchObject({ owner: 'alice', permlink: 'noads', mode: 'off', hiveAuthor: 'alice' });
  });
});

describe('isPostOnChain', () => {
  const answer = (res) => hiveRpcBatch.mockResolvedValue(res === undefined ? [] : [res]);

  test.each([
    ['every node is down', undefined, null],
    ['the node says the post does not exist', { error: { data: { extension: { assertion_expression: 'Post alice/p1 does not exist' } } } }, false],
    ['a generic node error', { error: { message: 'Internal Error' } }, null],
    ['a reply without a result', { id: 1 }, null],
    ['a null result', { result: null }, false],
    ['a non-object result', { result: 'weird' }, null],
    ['a result without author/permlink strings', { result: { author: 7 } }, null],
    ['a zeroed stub', { result: { author: '', permlink: '' } }, false],
    ['the post itself', { result: { author: 'alice', permlink: 'p1' } }, true],
    ['somebody else\'s post', { result: { author: 'bob', permlink: 'p1' } }, false],
  ])('%s -> %p', async (_label, res, expected) => {
    answer(res);
    await expect(scheduled.isPostOnChain('alice', 'p1')).resolves.toBe(expected);
  });
});

describe('reconciling posts stranded in processing', () => {
  const stranded = (permlink, extra = {}) => post(permlink, {
    status: 'processing', attempts: 1, processingStartedAt: ago(20 * MINUTE), ...extra,
  });
  const chainSays = (fn) => hiveRpcBatch.mockImplementation(async ([r]) => fn(r.params[1]));

  test('already on chain: marked posted and the embed link is redone, without a new broadcast', async () => {
    chainSays((permlink) => [{ result: { author: 'alice', permlink } }]);
    await posts().insertOne(stranded('landed', { embedPermlink: 'e1' }));

    await scheduled.requeueStuckPosts(posts());

    expect(await byPermlink('landed')).toMatchObject({ status: 'posted', recoveredAt: NOW, lastError: null });
    expect(broadcasts).toHaveLength(0);
    expect(embedFetch.calls.map((c) => c.url)).toEqual(['http://embed.test/video/e1/hive']);
  });

  test('not on chain: requeued, or failed once the attempts are spent', async () => {
    chainSays(() => [{ result: null }]);
    await posts().insertMany([stranded('retry', { attempts: 1 }), stranded('spent', { attempts: 3 })]);

    await scheduled.requeueStuckPosts(posts());

    expect(await byPermlink('retry')).toMatchObject({ status: 'scheduled', lastError: expect.stringMatching(/abandoned in processing/) });
    expect(await byPermlink('spent')).toMatchObject({ status: 'failed' });
  });

  test('when the chain cannot be read the post is left exactly as it is', async () => {
    hiveRpcBatch.mockResolvedValue([]);
    await posts().insertOne(stranded('unknown'));
    const before = await byPermlink('unknown');

    await scheduled.requeueStuckPosts(posts());

    expect(await byPermlink('unknown')).toEqual(before);
  });

  test('a claim younger than the stuck threshold is still in flight and is not touched', async () => {
    chainSays(() => [{ result: null }]);
    await posts().insertOne(stranded('young', { processingStartedAt: ago(5 * MINUTE) }));

    await scheduled.requeueStuckPosts(posts());

    expect((await byPermlink('young')).status).toBe('processing');
    expect(hiveRpcBatch).not.toHaveBeenCalled();
  });

  test('a doc with no timestamps at all counts as stuck rather than staying invisible', async () => {
    chainSays(() => [{ result: null }]);
    await posts().insertOne(stranded('ancient', { processingStartedAt: undefined }));

    await scheduled.requeueStuckPosts(posts());

    expect((await byPermlink('ancient')).status).toBe('scheduled');
  });

  test('a tick that finishes the doc while the sweep is on the network wins', async () => {
    hiveRpcBatch.mockImplementation(async () => {
      await posts().updateOne({ permlink: 'race' }, { $set: { status: 'posted', broadcastTxId: 'real' } });
      return [{ result: null }];
    });
    await posts().insertOne(stranded('race'));

    await scheduled.requeueStuckPosts(posts());

    expect(await byPermlink('race')).toMatchObject({ status: 'posted', broadcastTxId: 'real' });
  });

  test('runOnce sweeps first, so a requeued post goes out in the same tick', async () => {
    chainSays(() => [{ result: null }]);
    await posts().insertOne(stranded('again', { scheduledOn: ago(HOUR) }));

    await scheduled.runOnce();

    expect(broadcasts).toHaveLength(1);
    expect(await byPermlink('again')).toMatchObject({ status: 'posted', attempts: 2 });
  });

  test('a sweep that throws does not stop the tick from publishing', async () => {
    hiveRpcBatch.mockRejectedValue(new Error('kaput'));
    await posts().insertMany([stranded('stuck'), post('fresh')]);

    await scheduled.runOnce();

    expect((await byPermlink('fresh')).status).toBe('posted');
  });
});

describe('hasThreespeakPostingAuthority', () => {
  test.each([
    ['granted with enough weight', ['threespeak'], 1, true],
    ['not granted', ['someoneelse'], 1, false],
    ['granted below the threshold', ['threespeak'], 2, false],
  ])('%s -> %p', async (_label, delegates, threshold, expected) => {
    const acct = hiveAccount('alice', { postingDelegates: delegates });
    const chainAccount = acct.chainAccount();
    chainAccount.posting.weight_threshold = threshold;
    fakeHiveChain([chainAccount]);
    await expect(scheduled.hasThreespeakPostingAuthority('alice')).resolves.toBe(expected);
  });

  test('an account that does not exist has no authority', async () => {
    fakeHiveChain([]);
    await expect(scheduled.hasThreespeakPostingAuthority('ghost')).resolves.toBe(false);
  });
});

describe('schedule()', () => {
  // A fresh copy of the module under other env. `dbModule` defaults to this
  // file's real database layer.
  function loadWith(env, dbModule = require('../../utils/db')) {
    const saved = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    let mod;
    jest.isolateModules(() => {
      jest.doMock('../../utils/db', () => dbModule);
      mod = require('../../services/scheduledPosts');
    });
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    jest.dontMock('../../utils/db');
    return mod;
  }
  function captureTimers() {
    const timers = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => { timers.push({ kind: 'timeout', fn, ms }); return 0; });
    jest.spyOn(global, 'setInterval').mockImplementation((fn, ms) => { timers.push({ kind: 'interval', fn, ms }); return 0; });
    return timers;
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test('is a no-op unless the runner is switched on and a key is set', async () => {
    const off = loadWith({ SCHEDULED_POSTS_RUNNER: 'false' });
    const noKey = loadWith({ THREESPEAK_POSTING_KEY: '' });
    await posts().insertOne(post('due'));
    const timers = captureTimers();
    off.schedule();
    noKey.schedule();
    await off.runOnce();
    await noKey.runOnce();
    expect(timers).toHaveLength(0);
    expect((await byPermlink('due')).status).toBe('scheduled');
  });

  test('a key that does not parse disables the worker at boot', () => {
    const bad = loadWith({ THREESPEAK_POSTING_KEY: 'not-a-wif' });
    const timers = captureTimers();
    bad.schedule();
    expect(timers).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/could not parse/), expect.any(String));
  });

  test('creates its indexes, ticks first after 30s and then every SCHEDULED_POSTS_INTERVAL_MIN', async () => {
    // An in-memory stand-in, so the boot work settles within the test.
    const created = [];
    const queries = [];
    const coll = {
      createIndex: async (key, opts) => { created.push(opts.name); },
      find: (q) => { queries.push(q); return { limit: () => ({ toArray: async () => [] }) }; },
      findOneAndUpdate: async () => null,
    };
    const mod = loadWith({ SCHEDULED_POSTS_INTERVAL_MIN: '2' }, { getDb: () => ({ collection: () => coll }) });
    const timers = captureTimers();

    mod.schedule();
    await settle();
    expect(created).toEqual(['sched_owner_status_date', 'sched_due', 'sched_owner_permlink']);
    expect(timers).toEqual([expect.objectContaining({ kind: 'timeout', ms: 30 * 1000 })]);

    timers[0].fn();
    await settle();
    expect(timers[1]).toEqual(expect.objectContaining({ kind: 'interval', ms: 2 * 60 * 1000 }));
    expect(queries).toEqual([{ status: 'processing' }]); // the first tick ran its sweep
    timers[1].fn();
    await settle();
    expect(queries).toHaveLength(2);
  });
});
