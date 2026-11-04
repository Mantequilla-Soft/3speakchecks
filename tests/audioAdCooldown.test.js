/**
 * routes/adServe.js inAudioCooldown: one audio ad per listener per
 * AD_AUDIO_COOLDOWN_MINUTES (15 by default), whichever advertiser. Mongo is a stand-in.
 */
const { __test: { inAudioCooldown } } = require('../routes/adServe');
const { AD_AUDIO_COOLDOWN_MINUTES } = require('../utils/config');

const MIN = 60 * 1000;

// Just enough of find/sort/limit and findOne for the two queries inAudioCooldown makes.
function fakeDb({ sessions = [], impressions = [] }) {
  const matches = (row, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && v.$gte) return row[k] >= v.$gte;
    if (v && typeof v === 'object' && v.$in) return v.$in.includes(row[k]);
    return row[k] === v;
  });
  const coll = (rows) => ({
    find: (q) => {
      let out = rows.filter((r) => matches(r, q));
      const cur = {
        sort: () => { out = [...out].sort((a, b) => b.startedAt - a.startedAt); return cur; },
        limit: (n) => { out = out.slice(0, n); return cur; },
        toArray: async () => out,
      };
      return cur;
    },
    findOne: async (q) => rows.find((r) => matches(r, q)) || null,
  });
  return { collection: (name) => coll(/impression/.test(name) ? impressions : sessions) };
}

const ago = (m) => new Date(Date.now() - m * MIN);

describe('audio ad cooldown', () => {
  test('defaults to 15 minutes', () => {
    expect(AD_AUDIO_COOLDOWN_MINUTES).toBe(15);
  });

  test('an audio ad heard 6 minutes ago blocks the next one, whatever the advertiser', async () => {
    const db = fakeDb({
      sessions: [{ sid: 's1', viewer: 'badadib', surface: 'audio', startedAt: ago(6) }],
      impressions: [{ sid: 's1', campaignId: 'c1' }],
    });
    await expect(inAudioCooldown(db, { viewer: 'badadib' })).resolves.toBe(true);
  });

  test('after 15 minutes the next ad may play', async () => {
    const db = fakeDb({
      sessions: [{ sid: 's1', viewer: 'badadib', surface: 'audio', startedAt: ago(16) }],
      impressions: [{ sid: 's1', campaignId: 'c1' }],
    });
    await expect(inAudioCooldown(db, { viewer: 'badadib' })).resolves.toBe(false);
  });

  test('a spot that was served but never heard (no impression) does not count', async () => {
    const db = fakeDb({ sessions: [{ sid: 's1', viewer: 'badadib', surface: 'audio', startedAt: ago(2) }] });
    await expect(inAudioCooldown(db, { viewer: 'badadib' })).resolves.toBe(false);
  });

  test('video ads do not start the audio quiet period', async () => {
    const db = fakeDb({
      sessions: [{ sid: 'v1', viewer: 'badadib', surface: 'watch', startedAt: ago(2) }],
      impressions: [{ sid: 'v1', campaignId: 'c1' }],
    });
    await expect(inAudioCooldown(db, { viewer: 'badadib' })).resolves.toBe(false);
  });

  test('anonymous listeners are kept apart by capId; no key means no check', async () => {
    const db = fakeDb({
      sessions: [{ sid: 's1', capId: 'aaaaaaaaaaaaaaaa', surface: 'audio', startedAt: ago(3) }],
      impressions: [{ sid: 's1', campaignId: 'c1' }],
    });
    await expect(inAudioCooldown(db, { capId: 'aaaaaaaaaaaaaaaa' })).resolves.toBe(true);
    await expect(inAudioCooldown(db, { capId: 'bbbbbbbbbbbbbbbb' })).resolves.toBe(false);
    await expect(inAudioCooldown(db, null)).resolves.toBe(false);
  });
});
