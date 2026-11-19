/**
 * Stream recordings (VODs) are recognised for the card badge and the profile's
 * Streams tab: uploaded by the live server, flagged by the old studio path, or
 * named by the old recorder.
 */
const { isStreamVod } = require('../utils/streamVod');

describe('isStreamVod', () => {
  test('a recording the live server uploaded', () => {
    expect(isStreamVod({ frontend_app: '3speak-hangouts', originalFilename: 'badadib-i39k1j5.mp4', short: false })).toBe(true);
  });

  test('a recording flagged by the old studio path', () => {
    expect(isStreamVod({ frontend_app: '3speak-tv', is_openpod_stream: true })).toBe(true);
  });

  test('a recording from before the flag, by its filename', () => {
    expect(isStreamVod({ frontend_app: '3speak-tv', originalFilename: 'stream-badadib-j788mkk-7s.webm' })).toBe(true);
  });

  test('a regular upload is not', () => {
    expect(isStreamVod({ frontend_app: '3speak-tv', originalFilename: 'holiday.mp4' })).toBe(false);
    expect(isStreamVod({})).toBe(false);
    expect(isStreamVod(null)).toBe(false);
  });

  test('a Short never is, whatever made it', () => {
    expect(isStreamVod({ frontend_app: '3speak-hangouts', short: true })).toBe(false);
  });
});
