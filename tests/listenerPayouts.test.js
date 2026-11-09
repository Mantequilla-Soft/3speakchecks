/**
 * Listener rewards in the ad payout (services/adPayouts.js payViewers, which pays
 * listeners from the viewer pool since 2026-11-09, and the per-reason breakdown in
 * writePayoutRows), against an in-memory database.
 * Nothing here talks to Mongo or Hive.
 */
const { ObjectId } = require('mongodb');

// A tiny stand-in for the few collection calls the payout code makes.
function fakeDb(seed = {}) {
  const data = Object.fromEntries(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ _id: new ObjectId(), ...r }))]));
  const matches = (doc, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(doc[k]));
    if (v === null) return doc[k] === null || doc[k] === undefined;
    return doc[k] === v;
  });
  const col = (name) => {
    data[name] = data[name] || [];
    const rows = data[name];
    return {
      find: (q = {}) => ({ toArray: async () => rows.filter((d) => matches(d, q)) }),
      updateMany: async (q, u) => { for (const d of rows.filter((x) => matches(x, q))) Object.assign(d, u.$set); },
      updateOne: async (q, u) => {
        let d = rows.find((x) => matches(x, q));
        if (!d) { d = { ...q, ...(u.$setOnInsert || {}) }; rows.push(d); }
        Object.assign(d, u.$set);
      },
    };
  };
  return { collection: col, data };
}

const period = { key: '2026-10-30', start: new Date('2026-10-30T07:00:00Z'), end: new Date('2026-11-02T07:00:00Z') };
const row = (listener, kind, seconds, extra = {}) => ({ listener, kind, id: `${kind}-${listener}`, seconds, payoutId: null, ...extra });

let pay;
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  ({ payViewers: pay } = require('../services/adPayouts'));
});

describe('listeners in the viewer pool', () => {
  test('an empty pool pays nobody and claims nothing', async () => {
    const db = fakeDb({ ad_listener_listen: [row('alice', 'audio', 600)] });
    expect(await pay(db, period, 0)).toEqual({ recipients: 0, paidHbd: 0, carriedOut: 0, rows: [] });
    expect(db.data.ad_listener_listen[0].payoutId).toBeNull();
  });

  test('3Speak audio and outside podcasts are one label, shared with viewers by seconds', async () => {
    const db = fakeDb({
      ad_listener_listen: [row('alice', 'audio', 3000), row('carol', 'podcast', 1000)],
      ad_viewer_watch: [{ viewer: 'bob', owner: 'x', permlink: 'v', contentSeconds: 1000, payoutId: null }],
    });
    const res = await pay(db, period, 5, null, { defer: true });
    expect(res.rows.map((r) => [r.account, r.hbd, r.kind]).sort()).toEqual([
      ['alice', 3, 'listener'], ['bob', 1, 'viewer'], ['carol', 1, 'listener'],
    ]);
    expect(db.data.ad_listener_listen.filter((r) => r.payoutId === period.key)).toHaveLength(2);
  });

  test('nobody qualified: the whole pool carries to the next period', async () => {
    const db = fakeDb({ ad_listener_listen: [] });
    expect((await pay(db, period, 1.5)).carriedOut).toBe(1.5);
  });

  test('blocked accounts leave the denominator and are not paid', async () => {
    const db = fakeDb({
      ad_listener_listen: [row('alice', 'audio', 1000), row('spammer', 'audio', 1000)],
      contentcreators: [{ username: 'spammer', adRewardDisabled: true }],
    });
    const res = await pay(db, period, 2, null, { defer: true });
    expect(res.rows.map((r) => [r.account, r.hbd])).toEqual([['alice', 2]]);
  });

  test('a settlement run twice pays a listen once', async () => {
    const db = fakeDb({ ad_listener_listen: [row('alice', 'audio', 1000)] });
    await pay(db, period, 1, null, { defer: true });
    const again = await pay(db, period, 1, null, { defer: true });
    expect(again.rows).toEqual([]);
  });
});

describe('payout rows', () => {
  test('one account paid for several reasons keeps how much each was', async () => {
    const { writePayoutRows } = require('../services/adPayouts');
    const db = fakeDb({ ad_payouts: [] });
    await writePayoutRows(db, period.key, [
      { account: 'alice', hbd: 1, amounts: [{ symbol: 'HBD', amount: 1 }], kind: 'viewer' },
      { account: 'alice', hbd: 0.5, amounts: [{ symbol: 'HBD', amount: 0.5 }], kind: 'listener-podcast' },
      { account: 'alice', hbd: 0.25, amounts: [{ symbol: 'HBD', amount: 0.25 }], kind: 'listener-audio' },
    ]);
    const [p] = db.data.ad_payouts;
    expect(p.hbd).toBe(1.75);
    expect(p.kind).toBe('listener-audio+listener-podcast+viewer');
    expect(p.parts).toEqual({ viewer: 1, 'listener-podcast': 0.5, 'listener-audio': 0.25 });
  });
});
