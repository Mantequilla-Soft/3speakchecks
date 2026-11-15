/**
 * The global comment mutelist (utils/commentMutes.js): the repo list
 * (data/comment-mutelist.json) UNION the `comment_mutes` collection, cached per
 * TTL, stale on a failed read, never throwing. Fake db with a read counter.
 */
const mutes = require('../utils/commentMutes');
const { COMMENT_MUTES_TTL_MS } = require('../utils/config');
const repoFile = require('../data/comment-mutelist.json');

function fakeDb(rows) {
  const db = {
    reads: 0,
    fail: false,
    rows,
    collection: (name) => ({
      find: () => ({
        limit: () => ({
          toArray: async () => {
            db.reads += 1;
            if (db.fail) throw new Error('mongo down');
            return name === 'comment_mutes' ? db.rows : [];
          },
        }),
      }),
    }),
  };
  return db;
}

let warn;
beforeEach(() => {
  mutes._test.reset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); jest.useRealTimers(); });

describe('the repo list', () => {
  test('ships @ai-agent-hunter as the first entry, every entry a valid lowercase Hive name with a reason and date', () => {
    expect(repoFile[0]).toEqual({ user: 'ai-agent-hunter', reason: 'bot', added: '2026-11-15' });
    for (const r of repoFile) {
      expect(mutes.normalize(r.user)).toBe(r.user);
      expect(typeof r.reason).toBe('string');
      expect(r.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(mutes.repoList().map((r) => r.user)).toContain('ai-agent-hunter');
  });

  test('normalize: lowercases, strips @, drops what is not a Hive name', () => {
    expect(mutes.normalize('@AI-Agent-Hunter')).toBe('ai-agent-hunter');
    expect(['', null, 'ab', 'has space', '1abc', 'x'.repeat(17), {}].map(mutes.normalize)).toEqual(['', '', '', '', '', '', '']);
  });
});

describe('the union with comment_mutes', () => {
  test('repo names plus valid collection names, lowercased; junk ids dropped', async () => {
    const db = fakeDb([{ _id: 'SpamBot' }, { _id: '@other.bot' }, { _id: 'no way' }, { _id: 42 }, {}]);
    const set = await mutes.getMutedSet(db);
    expect([...set].sort()).toEqual(['ai-agent-hunter', 'other.bot', 'spambot']);
    expect(await mutes.isMuted(db, '@SPAMBOT')).toBe(true);
    expect(await mutes.isMuted(db, 'badadib')).toBe(false);
  });

  test('mutedSubset answers the muted ones of a list, deduped; filterMuted drops their rows', async () => {
    const db = fakeDb([{ _id: 'spambot' }]);
    expect(await mutes.mutedSubset(db, ['fan', 'SpamBot', 'spambot', null, 'ai-agent-hunter'])).toEqual(['spambot', 'ai-agent-hunter']);
    expect(await mutes.mutedSubset(db, undefined)).toEqual([]);
    const rows = [{ author: 'fan' }, { author: 'SPAMBOT' }, { author: 'ai-agent-hunter' }, null];
    expect(await mutes.filterMuted(db, rows)).toEqual([{ author: 'fan' }, null]);
    expect(await mutes.filterMuted(db, [{ who: 'spambot' }], 'who')).toEqual([]);
  });
});

describe('the cache', () => {
  test('read once per TTL; a newly added bot shows up after it', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-15T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const db = fakeDb([]);
    await mutes.getMutedSet(db);
    await mutes.getMutedSet(db);
    expect(db.reads).toBe(1);
    db.rows = [{ _id: 'newbot' }];
    expect(await mutes.isMuted(db, 'newbot')).toBe(false);
    jest.setSystemTime(Date.now() + COMMENT_MUTES_TTL_MS + 1);
    expect(await mutes.isMuted(db, 'newbot')).toBe(true);
    expect(db.reads).toBe(2);
  });

  test('a failed read keeps the previous set; a failed first read still has the repo list', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-15T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const db = fakeDb([{ _id: 'spambot' }]);
    db.fail = true;
    expect([...(await mutes.getMutedSet(db))]).toEqual(['ai-agent-hunter']);
    db.fail = false;
    await mutes.getMutedSet(db);
    db.fail = true;
    jest.setSystemTime(Date.now() + COMMENT_MUTES_TTL_MS + 1);
    expect([...(await mutes.getMutedSet(db))].sort()).toEqual(['ai-agent-hunter', 'spambot']);
    expect(warn).toHaveBeenCalled();
  });

  test('no db handle at all never throws', async () => {
    jest.resetModules();
    jest.doMock('../utils/db', () => ({ getDb: () => { throw new Error('not connected'); } }));
    const fresh = require('../utils/commentMutes');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(fresh.mutedSubset(undefined, ['ai-agent-hunter', 'fan'])).resolves.toEqual(['ai-agent-hunter']);
    jest.dontMock('../utils/db');
  });
});
