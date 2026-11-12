/**
 * utils/rewardRefusal.js: content nobody may earn from carries no ads. A creator an
 * admin reward-blocked, and a Hive post whose max_accepted_payout is zero. The decline
 * is read off the chain (faked here) behind a cache that keeps a decline for good,
 * re-reads an accepting post after a while and fails open, briefly, when Hive is down.
 */
const fx = require('./_fixtures');

fx.useAdEnv();
const testDb = require('../helpers/db');

const db = testDb.use();
fx.freezeTime();
beforeEach(() => jest.setSystemTime(fx.NOW));

const post = (over = {}) => ({ author: 'creator1', permlink: 'p', max_accepted_payout: '1000000.000 HBD', ...over });

/** A fresh module (fresh cache) whose chain answers with `answer(author, permlink)`. */
function load(answer = () => post()) {
  const rpc = jest.fn(async ([call]) => {
    const r = answer(...call.params);
    if (r === 'down') return [];
    if (r === 'error') return [{ id: 1, error: { message: 'boom' } }];
    return [{ id: 1, result: r }];
  });
  const mod = fx.loadIsolated('../../utils/rewardRefusal', {
    mocks: {
      '../../utils/db': () => ({ getDb: () => db() }),
      '../../utils/hive': () => ({ hiveRpcBatch: rpc }),
    },
  });
  return { ...mod, rpc };
}

describe('creatorRewardBlocked', () => {
  test.each([
    ['no row', null, false],
    ['blocked', { adRewardDisabled: true }, true],
    ['explicitly not blocked', { adRewardDisabled: false }, false],
    ['only a literal true counts', { adRewardDisabled: 'yes' }, false],
  ])('%s -> %p', async (_label, row, want) => {
    if (row) await db().collection('contentcreators').insertOne({ username: 'creator1', ...row });
    await expect(load().creatorRewardBlocked('@Creator1')).resolves.toBe(want);
  });

  test('no owner is never blocked, and costs no read', async () => {
    await expect(load().creatorRewardBlocked('')).resolves.toBe(false);
  });
});

describe('declinedPayout', () => {
  const { declinedPayout } = require('../../utils/rewardRefusal');
  test.each([
    ['0.000 HBD', true],
    ['0.000 SBD', true],
    ['1000000.000 HBD', false],
    ['0.001 HBD', false],
    ['', false],
    [undefined, false],
    ['garbage', false],
  ])('%p -> %p', (v, want) => expect(declinedPayout(v)).toBe(want));
});

describe('contentDeclinesRewards: which post is asked', () => {
  test('an embed video asks its linked Hive post', async () => {
    await db().collection('embed-video').insertOne({ owner: 'creator1', permlink: 'asset1', hive_author: 'Creator1', hive_permlink: 'my-post' });
    const { contentDeclinesRewards, rpc } = load(() => post({ max_accepted_payout: '0.000 HBD' }));
    await expect(contentDeclinesRewards({ owner: 'creator1', permlink: 'asset1' })).resolves.toBe(true);
    expect(rpc.mock.calls[0][0][0]).toMatchObject({ method: 'condenser_api.get_content', params: ['creator1', 'my-post'] });
  });

  test('an embed video with no Hive post yet declined nothing, and the chain is not asked', async () => {
    await db().collection('embed-video').insertOne({ owner: 'creator1', permlink: 'asset1' });
    const { contentDeclinesRewards, rpc } = load();
    await expect(contentDeclinesRewards({ owner: 'creator1', permlink: 'asset1' })).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('no embed row: a legacy video or a live room, asked under its own name', async () => {
    const { contentDeclinesRewards, rpc } = load(() => post({ max_accepted_payout: '0.000 HBD' }));
    await expect(contentDeclinesRewards({ owner: 'creator1', permlink: 'room-1' })).resolves.toBe(true);
    expect(rpc.mock.calls[0][0][0].params).toEqual(['creator1', 'room-1']);
  });

  test('audio asks the post its track was published as, "author/permlink" rows included', async () => {
    await db().collection('embed-audio').insertMany([
      { owner: 'creator1', permlink: 't1', post_permlink: 'ep-1' },
      { owner: 'creator1', permlink: 't2', post_permlink: 'creator1/ep-2' },
      { owner: 'creator1', permlink: 't3' },
    ]);
    const { contentDeclinesRewards, rpc } = load((a, p) => post({ max_accepted_payout: p === 'ep-2' ? '0.000 HBD' : '5.000 HBD' }));
    await expect(contentDeclinesRewards({ kind: 'audio', owner: 'creator1', permlink: 't1' })).resolves.toBe(false);
    await expect(contentDeclinesRewards({ kind: 'audio', owner: 'creator1', permlink: 't2' })).resolves.toBe(true);
    await expect(contentDeclinesRewards({ kind: 'audio', owner: 'creator1', permlink: 't3' })).resolves.toBe(false);
    await expect(contentDeclinesRewards({ kind: 'audio', owner: 'creator1', permlink: 'nope' })).resolves.toBe(false);
    expect(rpc.mock.calls.map((c) => c[0][0].params)).toEqual([['creator1', 'ep-1'], ['creator1', 'ep-2']]);
  });

  test('a post the chain does not have declined nothing; no owner or permlink asks nothing', async () => {
    const { contentDeclinesRewards, rpc } = load(() => ({ author: '' }));
    await expect(contentDeclinesRewards({ owner: 'creator1', permlink: 'gone' })).resolves.toBe(false);
    await expect(contentDeclinesRewards({ owner: '', permlink: 'x' })).resolves.toBe(false);
    await expect(contentDeclinesRewards({ owner: 'creator1', permlink: '' })).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('contentDeclinesRewards: the cache', () => {
  const v = { owner: 'creator1', permlink: 'v1' };

  test('a decline is kept for good: it can never be undone on chain', async () => {
    const { contentDeclinesRewards, rpc } = load(() => post({ max_accepted_payout: '0.000 HBD' }));
    await contentDeclinesRewards(v);
    fx.advance(30 * fx.DAY);
    await expect(contentDeclinesRewards(v)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test('an accepting post is re-read after ten minutes, so a later decline is seen', async () => {
    let payout = '1000000.000 HBD';
    const { contentDeclinesRewards, rpc } = load(() => post({ max_accepted_payout: payout }));
    await expect(contentDeclinesRewards(v)).resolves.toBe(false);
    payout = '0.000 HBD';
    fx.advance(9 * fx.MIN);
    await expect(contentDeclinesRewards(v)).resolves.toBe(false);
    fx.advance(2 * fx.MIN);
    await expect(contentDeclinesRewards(v)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  test.each(['down', 'error'])('chain %s: fails open, and asks again after a minute', async (state) => {
    let s = state;
    const { contentDeclinesRewards, rpc } = load(() => (s === 'ok' ? post({ max_accepted_payout: '0.000 HBD' }) : s));
    await expect(contentDeclinesRewards(v)).resolves.toBe(false);
    s = 'ok';
    await expect(contentDeclinesRewards(v)).resolves.toBe(false);
    fx.advance(61 * 1000);
    await expect(contentDeclinesRewards(v)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  test('concurrent playbacks of one video share a single read; video and audio are keyed apart', async () => {
    const { contentDeclinesRewards, rpc } = load();
    await Promise.all([contentDeclinesRewards(v), contentDeclinesRewards(v), contentDeclinesRewards({ ...v, owner: '@Creator1' })]);
    expect(rpc).toHaveBeenCalledTimes(1);
    await db().collection('embed-audio').insertOne({ owner: 'creator1', permlink: 'v1', post_permlink: 'ep' });
    await contentDeclinesRewards({ ...v, kind: 'audio' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
