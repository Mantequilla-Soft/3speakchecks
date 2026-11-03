/**
 * utils/warmupAudio.js: warm-up audio in the lists, one per account, three in all.
 * The hosted incubation service and Mongo are stand-ins; nothing leaves the process.
 */
jest.mock('../utils/incubationHosted', () => ({ call: jest.fn() }));
jest.mock('../utils/db', () => ({ getDb: jest.fn() }));
const { call } = require('../utils/incubationHosted');
const { getDb } = require('../utils/db');
const { capWarmup, _test } = require('../utils/warmupAudio');

const day = (n) => new Date(Date.UTC(2026, 10, n));
const ROWS = [
  { owner: 'alice', permlink: 'a1', createdAt: day(1), status: 'published' },
  { owner: 'alice', permlink: 'a2', createdAt: day(9), status: 'published' },
  { owner: 'bob', permlink: 'b1', createdAt: day(5), status: 'published' },
  { owner: 'carol', permlink: 'c1', createdAt: day(7), status: 'published' },
  { owner: 'dave', permlink: 'd1', createdAt: day(3), status: 'published' },
  { owner: 'hiveuser', permlink: 'h1', createdAt: day(8), status: 'published' },
  { owner: 'gradded', permlink: 'g1', createdAt: day(8), status: 'published' },
];

// Just enough of distinct + the one aggregate shape rebuild() uses.
function fakeDb(rows) {
  return {
    collection: () => ({
      distinct: async () => [...new Set(rows.map((r) => r.owner))],
      aggregate: (stages) => ({
        toArray: async () => {
          const owners = stages[0].$match.owner.$in;
          const limit = stages.find((s) => s.$limit).$limit;
          const byOwner = new Map();
          for (const r of [...rows].sort((x, y) => y.createdAt - x.createdAt)) {
            if (!owners.includes(r.owner)) continue;
            if (!byOwner.has(r.owner)) byOwner.set(r.owner, { _id: r.owner, permlinks: [], at: r.createdAt });
            byOwner.get(r.owner).permlinks.push(r.permlink);
          }
          return [...byOwner.values()].sort((x, y) => y.at - x.at).slice(0, limit);
        },
      }),
    }),
  };
}

beforeEach(() => {
  _test.ownerCache.clear();
  getDb.mockReturnValue(fakeDb(ROWS));
  call.mockImplementation(async (method, path) => {
    const h = decodeURIComponent(path.split('/').pop());
    if (h === 'hiveuser') return { status: 404, body: { error: 'not found' } };
    if (h === 'gradded') return { status: 200, body: { handle: h, hiveUsername: 'gradded' } };
    return { status: 200, body: { handle: h, hiveUsername: null } };
  });
});

describe('warm-up audio cap', () => {
  test('warm-up owners are handles without a Hive account; graduated ones and Hive users are not', async () => {
    const { owners } = await _test.rebuild();
    expect(owners.sort()).toEqual(['alice', 'bob', 'carol', 'dave']);
  });

  test('one track per account (the newest), three accounts in all (the most recent)', async () => {
    const { allowed } = await _test.rebuild();
    // alice's newest a2 (day 9), carol c1 (day 7), bob b1 (day 5); dave (day 3) is the fourth.
    expect(allowed).toEqual(['a2', 'c1', 'b1']);
  });

  test('capWarmup keeps all other audio and only the allowed warm-up tracks', () => {
    const q = capWarmup({ status: 'published' }, { owners: ['alice', 'bob'], allowed: ['a2'] });
    expect(q.$and).toEqual([{ $or: [{ owner: { $nin: ['alice', 'bob'] } }, { permlink: { $in: ['a2'] } }] }]);
  });

  test('keeps an existing $and and leaves the query alone when nobody is warming up', () => {
    const q = capWarmup({ $and: [{ x: 1 }] }, { owners: ['alice'], allowed: [] });
    expect(q.$and).toHaveLength(2);
    expect(capWarmup({ status: 'published' }, { owners: [], allowed: [] })).toEqual({ status: 'published' });
  });

  test('an unreachable service keeps the last answer for that owner', async () => {
    await _test.rebuild();
    _test.ownerCache.get('alice').at = 0; // stale: will be asked again
    call.mockImplementation(async () => { throw new Error('down'); });
    const { owners } = await _test.rebuild();
    expect(owners).toContain('alice');
  });
});
