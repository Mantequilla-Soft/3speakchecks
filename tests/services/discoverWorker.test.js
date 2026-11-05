/**
 * Discover pool worker (services/discoverWorker.js): which videos make the
 * discover and interest pools, what each pool row carries, and that a rebuild
 * replaces the previous one. The worker runs on require and reports through
 * parentPort, so parentPort is a fake, process.exit is stubbed, and every run is
 * a fresh copy of the module against the real test MongoDB.
 */
jest.mock('worker_threads', () => {
  const { EventEmitter } = require('events');
  const port = new EventEmitter();
  port.postMessage = (msg) => port.emit('posted', msg);
  return { parentPort: port };
});

const { parentPort } = require('worker_threads');
const testDb = require('../helpers/db');
const { DAY } = require('./_fixtures');

const db = testDb.use();
const col = (name) => db().collection(name);
const daysAgo = (d) => new Date(Date.now() - d * DAY);

/** Run the worker once; resolves to { msg, code } (what it posted, how it exited). */
async function runWorker(env = {}) {
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  const posted = new Promise((resolve) => parentPort.once('posted', resolve));
  jest.isolateModules(() => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      require('../../services/discoverWorker');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
  const msg = await posted;
  return { msg, code: exit.mock.calls[0] && exit.mock.calls[0][0] };
}

const embed = (owner, permlink, extra = {}) => ({
  owner, permlink, status: 'published', short: false, listed_on_3speak: true,
  hive_author: owner, hive_permlink: `hive-${permlink}`, hive_tags: [], createdAt: daysAgo(1), ...extra,
});
const legacy = (owner, permlink, extra = {}) => ({
  owner, permlink, status: 'published', created: daysAgo(2), tags: '', ...extra,
});
// A watch row in the last 14 days: puts the video in the "retention" source,
// which (unlike "recent") has no filter of its own, so every gate is exercised.
const watched = (owner, permlink) => ({ owner, permlink, updatedAt: daysAgo(1) });

const pool = async (name = 'discover-pool') => new Map((await col(name).find().toArray()).map((d) => [d._id, d]));

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the recent source', () => {
  test('a new embed enters the pool, keyed by owner/asset and pointing at its Hive post', async () => {
    await col('embed-video').insertOne(embed('Alice', 'asset1', { hive_author: 'Alice', hive_tags: ['Music', '#Live'] }));

    const { msg, code } = await runWorker();

    expect(code).toBe(0);
    expect(msg).toMatchObject({ ok: true, pool: 1, skipped: 0, removed: 0, sources: { recent: 1, random: 0, retention: 0, topic: 0 } });
    const row = (await pool()).get('Alice/asset1');
    expect(row).toMatchObject({
      owner: 'Alice',
      author: 'alice',             // the Hive author, lowercased
      permlink: 'hive-asset1',     // what the watch page uses
      assetPermlink: 'asset1',     // what retention and transcription use
      source: 'embed',
      src: 'recent',
      nsfw: false,
      tags: ['music', 'live'],
      winnerTag: null,
      reshares: 0,
      saves: 0,
      viewerTags: 0,
      comments: 0,
      relQ: null,
      retentionMult: 1,
      commentBoost: 1,
      curationBoost: 1,
    });
    expect(row.base).toBeGreaterThan(0);
    expect(row.created).toBeInstanceOf(Date);
  });

  test('a new legacy video enters with its own permlink and its v2 tags', async () => {
    await col('videos').insertOne(legacy('bob', 'old-style', { tags: 'a,b', tags_v2: ['science'] }));

    await runWorker();

    expect((await pool()).get('bob/old-style')).toMatchObject({
      source: 'legacy', author: 'bob', permlink: 'old-style', assetPermlink: 'old-style', tags: ['science'],
    });
  });

  test.each([
    ['a short', { short: true }],
    ['an unlisted embed', { listed_on_3speak: false }],
    ['an embed not linked to Hive yet', { hive_permlink: null }],
    ['an embed still encoding', { status: 'encoding_ipfs' }],
    ['an embed older than the 14-day window', { createdAt: daysAgo(20) }],
  ])('%s does not enter', async (_name, extra) => {
    await col('embed-video').insertOne(embed('alice', 'x', extra));
    const { msg } = await runWorker();
    expect(msg.pool).toBe(0);
  });
});

describe('gates every source passes through', () => {
  test.each([
    ['banned', legacy('bob', 'v', { created: daysAgo(30), banned: true })],
    ['media gone from every gateway', legacy('bob', 'v', { created: daysAgo(30), unavailable: true })],
    ['hidden from feeds by its author', legacy('bob', 'v', { created: daysAgo(30), hiddenFromFeed: true })],
    ['not published', legacy('bob', 'v', { created: daysAgo(30), status: 'uploaded' })],
    ['a failed publish', legacy('bob', 'v', { created: daysAgo(30), publishFailed: true })],
    ['older than a year (still watched, but too old to recommend)', legacy('bob', 'v', { created: daysAgo(400) })],
    ['undated', legacy('bob', 'v', { created: null })],
  ])('a watched video that is %s is skipped', async (_name, doc) => {
    await col('videos').insertOne(doc);
    await col('view-durations').insertOne(watched('bob', 'v'));

    const { msg } = await runWorker();

    expect(msg).toMatchObject({ pool: 0, skipped: 1, sources: { retention: 1 } });
  });

  test('a watched video that no longer exists is skipped', async () => {
    await col('view-durations').insertOne(watched('ghost', 'nothing'));
    const { msg } = await runWorker();
    expect(msg).toMatchObject({ pool: 0, skipped: 1 });
  });

  test('test/system accounts never enter, as owner or as Hive author', async () => {
    await col('videos').insertOne(legacy('threespeak-fixer', 'v'));
    await col('embed-video').insertOne(embed('uploader', 'e', { hive_author: 'threespeak-fixer' }));
    await col('view-durations').insertMany([watched('threespeak-fixer', 'v'), watched('uploader', 'e')]);

    const { msg } = await runWorker();

    expect(msg.pool).toBe(0);
    expect(msg.sources.retention).toBe(1); // the fixer's own row never even became a candidate
    expect(msg.skipped).toBe(1);
  });

  test('a moderation-hidden creator never enters, as owner or as Hive author', async () => {
    await col('contentcreators').insertMany([
      { username: 'hiddenowner', hidden: true },
      { username: 'hiddenauthor', hidden: true },
    ]);
    await col('embed-video').insertMany([
      embed('hiddenowner', 'a'),
      embed('uploader', 'b', { hive_author: 'HiddenAuthor' }),
      embed('fine', 'c'),
    ]);

    const { msg } = await runWorker();

    expect([...(await pool()).keys()]).toEqual(['fine/c']);
    expect(msg.skipped).toBe(2);
  });

  test('an embed watched recently but banned is skipped even though "recent" did not filter it', async () => {
    await col('embed-video').insertOne(embed('alice', 'b', { banned: true }));
    const { msg } = await runWorker();
    expect(msg).toMatchObject({ pool: 0, skipped: 1, sources: { recent: 1 } });
  });
});

describe('the random and topic samples', () => {
  test('a tagged back-catalogue video enters as "random"; an untagged one does not', async () => {
    await col('videos').insertMany([legacy('carol', 'tagged', { created: daysAgo(100) }), legacy('carol', 'plain', { created: daysAgo(100) })]);
    await col('subtitles-tags').insertMany([
      { author: 'carol', permlink: 'tagged', tags: 'music' },
      { author: 'carol', permlink: 'plain', tags: '' },
    ]);

    const { msg } = await runWorker();

    expect(msg.sources).toMatchObject({ random: 1 });
    expect((await pool()).get('carol/tagged')).toMatchObject({ src: 'random', tags: ['music'], winnerTag: 'music' });
    expect((await pool()).has('carol/plain')).toBe(false);
  });

  test('a tagged video older than the age bound is not sampled', async () => {
    await col('videos').insertOne(legacy('carol', 'ancient', { created: daysAgo(500) }));
    await col('subtitles-tags').insertOne({ author: 'carol', permlink: 'ancient', tags: 'music' });
    const { msg } = await runWorker();
    expect(msg.sources.random).toBe(0);
    expect(msg.pool).toBe(0);
  });

  test('the topic sample feeds the interest pool only, never the discover pool', async () => {
    // With Math.random at 0 the samplers take items in order: the 1-item random
    // sample is "first", so "second" only comes in through the topic sample.
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await col('videos').insertMany([
      legacy('dan', 'first', { created: daysAgo(100) }),
      legacy('dan', 'second', { created: daysAgo(100) }),
    ]);
    await col('subtitles-tags').insertMany([
      { author: 'dan', permlink: 'first', tags: 'music' },
      { author: 'dan', permlink: 'second', tags: 'music' },
    ]);

    const { msg } = await runWorker({ DISCOVER_RANDOM_OLD_COUNT: '1' });

    expect(msg.sources).toMatchObject({ random: 1, topic: 1 });
    expect([...(await pool()).keys()]).toEqual(['dan/first']);
    expect([...(await pool('interest-pool')).keys()].sort()).toEqual(['dan/first', 'dan/second']);
    expect(msg).toMatchObject({ pool: 1, interestPool: 2 });
  });

  test('only videos with a winning topic enter the interest pool', async () => {
    await col('embed-video').insertMany([embed('e', 'untagged'), embed('e', 'tagged')]);
    await col('subtitles-tags').insertOne({ author: 'e', permlink: 'tagged', tags: 'technology' });

    await runWorker();

    expect([...(await pool('interest-pool')).keys()]).toEqual(['e/tagged']);
    expect((await pool()).size).toBe(2);
  });

  test('with the age bounds switched off the whole tagged catalogue is sampled', async () => {
    await col('videos').insertOne(legacy('old', 'classic', { created: daysAgo(5 * 365) }));
    await col('subtitles-tags').insertOne({ author: 'old', permlink: 'classic', tags: 'music' });

    const { msg } = await runWorker({ RECOMMEND_MAX_AGE_DAYS: '0', FEED_MAX_AGE_YEARS: '0' });

    expect(msg.sources.random).toBe(1);
    expect((await pool()).get('old/classic')).toMatchObject({ src: 'random', winnerTag: 'music' });
    expect((await pool('interest-pool')).has('old/classic')).toBe(true);
  });
});

describe('topic and score inputs', () => {
  test('viewer votes on the Hive post outweigh the transcription order', async () => {
    await col('embed-video').insertOne(embed('fay', 'v', { hive_author: 'Fay', hive_permlink: 'post' }));
    await col('subtitles-tags').insertOne({ author: 'fay', permlink: 'v', tags: 'music,technology' });
    await col('viewer-tags').insertMany([
      { author: 'Fay', permlink: 'post', 'viewer-tag': 'technology', voter: 'v1', weight: 3 },
      { author: 'fay', permlink: 'post', 'viewer-tag': 'technology', voter: 'v2' },
    ]);

    await runWorker();

    const row = (await pool()).get('fay/v');
    expect(row.winnerTag).toBe('technology');
    expect(row.tags).toEqual(['music', 'technology']);
    expect(row.viewerTags).toBe(2);
  });

  test('retention, comments and reshares lift a video above an identical plain one', async () => {
    const created = daysAgo(3);
    await col('embed-video').insertMany([
      embed('gus', 'loved', { createdAt: created }),
      embed('gus', 'plain', { createdAt: created }),
    ]);
    await col('video-retention').insertOne({ _id: 'gus/loved', score: 2, viewers: 40 });
    await col('video-comment-counts').insertOne({ _id: 'gus/hive-loved', effective: 12, comments: 10, native3Speak: 4 });
    await col('reshares').insertOne({ username: 'fan', author: 'gus', permlink: 'hive-loved' });

    await runWorker();

    const p = await pool();
    const loved = p.get('gus/loved');
    const plain = p.get('gus/plain');
    expect(loved).toMatchObject({ relQ: 2, retentionViewers: 40, comments: 10, native3Speak: 4, reshares: 1 });
    expect(loved.retentionMult).toBeGreaterThan(1);
    expect(loved.commentBoost).toBeGreaterThan(1);
    expect(loved.curationBoost).toBeGreaterThan(1);
    expect(loved.base).toBeGreaterThan(plain.base);
    expect(plain.freshness).toBe(loved.freshness);
  });

  test('a poorly retained video with enough viewers is demoted', async () => {
    await col('embed-video').insertOne(embed('h', 'meh'));
    await col('video-retention').insertOne({ _id: 'h/meh', score: 0.3, viewers: 50 });
    await runWorker();
    expect((await pool()).get('h/meh').retentionMult).toBeLessThan(1);
  });

  test.each([
    ['flagged NSFW', { isNsfwContent: true }],
    ['tagged nsfw by its author', { hive_tags: ['nsfw'] }],
  ])('a video %s is marked nsfw', async (_name, extra) => {
    await col('embed-video').insertOne(embed('i', 'v', extra));
    await runWorker();
    expect((await pool()).get('i/v').nsfw).toBe(true);
  });
});

describe('rebuilding', () => {
  test('rows not refreshed by this run are dropped, and a second run changes nothing else', async () => {
    await col('discover-pool').insertOne({ _id: 'old/row', runAt: daysAgo(1) });
    await col('interest-pool').insertOne({ _id: 'old/row', runAt: daysAgo(1) });
    await col('embed-video').insertOne(embed('j', 'v'));
    await col('subtitles-tags').insertOne({ author: 'j', permlink: 'v', tags: 'music' });

    const first = await runWorker();
    const strip = (rows) => rows.map(({ runAt, base, freshness, newBoost, recencyBoost, ...rest }) => rest);
    const after1 = strip(await col('discover-pool').find().toArray());
    const second = await runWorker();
    const after2 = strip(await col('discover-pool').find().toArray());

    expect(first.msg).toMatchObject({ removed: 1, interestRemoved: 1, pool: 1, interestPool: 1 });
    expect(second.msg).toMatchObject({ removed: 0, interestRemoved: 0, pool: 1, interestPool: 1 });
    expect(after2).toEqual(after1);
    expect(await col('discover-pool').countDocuments()).toBe(1);
  });

  test('the pools are capped at their limits', async () => {
    await col('embed-video').insertMany([embed('k', 'a'), embed('k', 'b'), embed('k', 'c')]);
    await col('subtitles-tags').insertMany(['a', 'b', 'c'].map((p) => ({ author: 'k', permlink: p, tags: 'music' })));

    const { msg } = await runWorker({ DISCOVER_POOL_LIMIT: '2', INTEREST_POOL_LIMIT: '1' });

    expect(msg).toMatchObject({ pool: 2, interestPool: 1 });
    expect(await col('discover-pool').countDocuments()).toBe(2);
    expect(await col('interest-pool').countDocuments()).toBe(1);
  });

  test('more legacy candidates than one lookup holds are all resolved', async () => {
    const n = 450; // over two 200-clause chunks
    await col('videos').insertMany(Array.from({ length: n }, (_, i) => legacy('many', `v${i}`, { created: daysAgo(30) })));
    await col('view-durations').insertMany(Array.from({ length: n }, (_, i) => watched('many', `v${i}`)));

    const { msg } = await runWorker();

    expect(msg).toMatchObject({ pool: n, skipped: 0 });
  });
});

describe('when it cannot run', () => {
  test('a broken database address is reported to the parent and the thread exits 1', async () => {
    const { msg, code } = await runWorker({ MONGODB_URI: 'not-a-mongo-uri' });
    expect(msg.ok).toBe(false);
    expect(msg.error).toMatch(/scheme|mongodb/i);
    expect(code).toBe(1);
  });
});
