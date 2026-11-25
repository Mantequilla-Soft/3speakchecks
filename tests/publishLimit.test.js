/**
 * utils/publishLimit.js: the daily publish limit's settings and window
 * arithmetic, on plain times. No database.
 */
const pl = require('../utils/publishLimit');

const H = 3600 * 1000;
const DAY = 24 * H;
const T = Date.UTC(2026, 10, 25, 12); // any moment

describe('settings', () => {
  test('on by default with 1 video and 3 Shorts; only exactly "false" turns it off', () => {
    expect(pl.limitsConfig({})).toEqual({ enabled: true, limits: { video: 1, short: 3 }, exempt: [] });
    expect(pl.limitsConfig({ PUBLISH_DAILY_LIMITS_ENABLED: 'false' }).enabled).toBe(false);
    expect(pl.limitsConfig({ PUBLISH_DAILY_LIMITS_ENABLED: ' false ' }).enabled).toBe(false);
    expect(pl.limitsConfig({ PUBLISH_DAILY_LIMITS_ENABLED: '0' }).enabled).toBe(true);
    expect(pl.limitsConfig({ PUBLISH_DAILY_LIMITS_ENABLED: 'FALSE' }).enabled).toBe(true);
  });

  test('limits from the env; unset, junk or below 1 keep the default', () => {
    expect(pl.limitsConfig({ PUBLISH_LIMIT_VIDEOS_PER_DAY: '2', PUBLISH_LIMIT_SHORTS_PER_DAY: '5' }).limits).toEqual({ video: 2, short: 5 });
    expect(pl.limitsConfig({ PUBLISH_LIMIT_VIDEOS_PER_DAY: 'x', PUBLISH_LIMIT_SHORTS_PER_DAY: '0' }).limits).toEqual({ video: 1, short: 3 });
  });

  test('the exempt list is trimmed, lower case, without @', () => {
    const cfg = pl.limitsConfig({ PUBLISH_LIMIT_EXEMPT: ' @Badadib, threespeak ,,' });
    expect(cfg.exempt).toEqual(['badadib', 'threespeak']);
    expect(pl.isListed('BADADIB', cfg)).toBe(true);
    expect(pl.isListed('fan', cfg)).toBe(false);
  });
});

describe('one video a day (L = 1)', () => {
  test('free with nothing else around', () => {
    expect(pl.allowedAt([], T, 1)).toBe(true);
  });

  test('another video less than 24 hours before or after is a conflict', () => {
    expect(pl.allowedAt([T - 23 * H], T, 1)).toBe(false);
    expect(pl.allowedAt([T + 23 * H], T, 1)).toBe(false);
    expect(pl.allowedAt([T], T, 1)).toBe(false);
  });

  test('exactly 24 hours apart is fine, both ways', () => {
    expect(pl.allowedAt([T - DAY], T, 1)).toBe(true);
    expect(pl.allowedAt([T + DAY], T, 1)).toBe(true);
    expect(pl.allowedAt([T - DAY, T + DAY], T, 1)).toBe(true);
    expect(pl.allowedAt([T - DAY + 1], T, 1)).toBe(false);
  });

  test('the next free time is 24 hours after the last one in the way', () => {
    expect(pl.nextFreeAt([], T, 1)).toBe(T);
    expect(pl.nextFreeAt([T - 3 * H], T, 1)).toBe(T + 21 * H);
    // a gap of exactly 24h between two videos 48h apart is a single free moment
    expect(pl.nextFreeAt([T - 3 * H, T + 45 * H], T, 1)).toBe(T + 21 * H);
    // a gap too small pushes it past the later one
    expect(pl.nextFreeAt([T - 3 * H, T + 30 * H], T, 1)).toBe(T + 54 * H);
  });
});

describe('three Shorts a day (L = 3, sliding)', () => {
  test('up to two others in any window is fine, a third is not', () => {
    expect(pl.allowedAt([T - 2 * H, T - H], T, 3)).toBe(true);
    expect(pl.allowedAt([T - 3 * H, T - 2 * H, T - H], T, 3)).toBe(false);
    expect(pl.allowedAt([T + H, T + 2 * H, T + 3 * H], T, 3)).toBe(false);
  });

  test('the window slides: four others within 24h, but no window holds more than two of them', () => {
    // [-20h, +4h) holds -20h and -10h; [-10h, +14h) -10h and +10h; [at, +24h) +10h and +20h
    expect(pl.allowedAt([T - 20 * H, T - 10 * H, T + 10 * H, T + 20 * H], T, 3)).toBe(true);
    expect(pl.allowedAt([T - 20 * H, T - 10 * H, T - 5 * H, T + 20 * H], T, 3)).toBe(false); // [-20h, +4h) holds three
    expect(pl.allowedAt([T - 20 * H, T + 5 * H, T + 10 * H, T + 20 * H], T, 3)).toBe(false); // [at, +24h) holds three
    expect(pl.allowedAt([T - DAY, T - DAY, T - DAY, T + 1], T, 3)).toBe(true); // 24h back is outside every window
  });

  test('the next free time for a Short', () => {
    const three = [T - 5 * H, T - 4 * H, T - 3 * H];
    expect(pl.allowedAt(three, T, 3)).toBe(false);
    expect(pl.nextFreeAt(three, T, 3)).toBe(T + 19 * H); // once the first leaves the window
  });

  test('a candidate past every publish is always free', () => {
    const times = [T, T + H, T + 2 * H, T + 3 * H];
    const next = pl.nextFreeAt(times, T, 3);
    expect(pl.allowedAt(times, next, 3)).toBe(true);
    for (let t = T; t < next; t += 15 * 60 * 1000) expect(pl.allowedAt(times, t, 3)).toBe(false);
  });
});

describe('conflicts and the message', () => {
  test('publishes less than 24h from `at`, oldest first, in the API shape', () => {
    const p = (permlink, ms, scheduled = false) => ({ permlink, title: permlink.toUpperCase(), at: new Date(ms), scheduled });
    const out = pl.conflictsAt([p('later', T + 2 * H, true), p('far', T - DAY), p('before', T - H)], T);
    expect(out).toEqual([
      { permlink: 'before', title: 'BEFORE', at: new Date(T - H).toISOString(), scheduled: false },
      { permlink: 'later', title: 'LATER', at: new Date(T + 2 * H).toISOString(), scheduled: true },
    ]);
  });

  test('the text names the limit and the next free time', () => {
    expect(pl.limitMessage('video', 1, '2026-11-26T12:00:00.000Z')).toBe(
      'Free accounts can publish 1 video per 24 hours. Schedule it for 2026-11-26T12:00:00.000Z or later, or get 3Speak Pro for no limit.',
    );
    expect(pl.limitMessage('short', 3, null)).toMatch(/^Free accounts can publish 3 Shorts per 24 hours\. Schedule it for a later time,/);
    expect(pl.limitMessage('short', 1, null)).toMatch(/1 Short per/);
    expect(pl.limitMessage('video', 2, null)).toMatch(/2 videos per/);
  });
});
