/**
 * utils/adSettings.js: the platform rate card as data. A stored override is used
 * only when it is a sane price, clearing removes it rather than pinning a copy, a
 * failed read keeps the last good snapshot, and nothing ever falls back to zero.
 */
const fx = require('./_fixtures');

fx.useAdEnv();
const testDb = require('../helpers/db');
const adSettings = require('../../utils/adSettings');
const { AD_SETTINGS_COLLECTION } = require('../../utils/config');

const db = testDb.use();
fx.freezeTime();
beforeEach(() => adSettings.refresh());

describe('validRate', () => {
  test.each([
    [0.25, true], ['1.5', true], [adSettings.MAX_RATE, true],
    [0, false], [-1, false], [adSettings.MAX_RATE + 0.001, false], ['free', false], [null, false], [NaN, false],
  ])('%p -> %p', (v, ok) => expect(adSettings.validRate(v)).toBe(ok));
});

describe('platformRate', () => {
  test('uses the built-in number the caller passes while nothing is stored', () => {
    expect(adSettings.platformRate('video_roll', 0.25)).toBe(0.25);
    expect(adSettings.currentSettings()).toEqual({ _id: 'rates', formats: {} });
  });

  test('uses a stored rate once it is written, read back as a number', async () => {
    await adSettings.setRate('video_roll', '0.4', 'ops');
    expect(adSettings.platformRate('video_roll', 0.25)).toBe(0.4);
    const stored = await db().collection(AD_SETTINGS_COLLECTION).findOne({ _id: 'rates' });
    expect(stored).toMatchObject({ formats: { video_roll: 0.4 }, updatedBy: 'ops' });
    expect(stored.updatedAt).toEqual(new Date(fx.NOW));
  });
});

describe('setRate', () => {
  test.each([[null], [undefined], ['']])('%p clears the override with $unset', async (clear) => {
    await adSettings.setRate('video_banner', 0.5);
    const after = await adSettings.setRate('video_banner', clear);
    expect(after.formats).not.toHaveProperty('video_banner');
    expect(after.updatedBy).toBeNull();
    expect(adSettings.platformRate('video_banner', 0.12)).toBe(0.12);
  });

  test.each([[0], [-3], ['abc'], [5000]])('refuses %p as a price', async (bad) => {
    await expect(adSettings.setRate('video_roll', bad)).rejects.toThrow(/greater than 0 and at most 1000/);
    expect(await db().collection(AD_SETTINGS_COLLECTION).countDocuments()).toBe(0);
  });

  test('refuses a blank format key', async () => {
    await expect(adSettings.setRate('  ', 1)).rejects.toThrow('format key required');
  });
});

describe('refresh', () => {
  test('a failed read keeps the previous snapshot rather than dropping to defaults', async () => {
    let down = false;
    const mod = fx.loadIsolated('../../utils/adSettings', {
      mocks: {
        '../../utils/db': () => ({
          getDb: () => (down ? { collection: () => ({ findOne: async () => { throw new Error('socket closed'); } }) } : db()),
        }),
      },
    });
    await mod.setRate('video_roll', 2);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    down = true;
    const kept = await mod.refresh();
    expect(kept.formats.video_roll).toBe(2);
    expect(mod.platformRate('video_roll', 0.25)).toBe(2);
    expect(err).toHaveBeenCalledWith('[ad-settings] refresh failed:', 'socket closed');
  });
});

describe('schedule', () => {
  test('loads once and refreshes on one timer, however often it is called', async () => {
    const mod = fx.loadIsolated('../../utils/adSettings', { mocks: { '../../utils/db': () => ({ getDb: () => db() }) } });
    const unref = jest.fn();
    const interval = jest.spyOn(global, 'setInterval').mockImplementation(() => ({ unref }));
    await db().collection(AD_SETTINGS_COLLECTION).insertOne({ _id: 'rates', formats: { video_roll: 0.6 } });

    expect((await mod.schedule()).formats.video_roll).toBe(0.6);
    await mod.schedule();
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls[0][1]).toBe(60 * 1000);
    expect(unref).toHaveBeenCalled();
  });
});
