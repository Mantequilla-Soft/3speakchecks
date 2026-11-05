/**
 * SEASONAL_NOW (utils/seasonal.js) lets a tester pretend it is another day; a
 * value that is not a date is ignored rather than breaking every feed.
 * The holiday windows themselves are covered in tests/seasonal.test.js.
 */
const { seasonalNow } = require('../../utils/seasonal');

afterEach(() => { delete process.env.SEASONAL_NOW; });

test('a valid SEASONAL_NOW overrides today', () => {
  process.env.SEASONAL_NOW = '2026-12-24';
  expect(seasonalNow().toISOString()).toBe('2026-12-24T00:00:00.000Z');
});

test('an unparseable SEASONAL_NOW falls back to the real clock', () => {
  jest.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z') });
  try {
    process.env.SEASONAL_NOW = 'next christmas';
    expect(seasonalNow().toISOString()).toBe('2026-11-01T12:00:00.000Z');
  } finally {
    jest.useRealTimers();
  }
});
