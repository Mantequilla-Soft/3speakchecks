/**
 * Tests for utils/seasonal.js — the holiday gate on the discover feed.
 *
 * The "must NOT match" block is the important one, and every string in it is a REAL
 * tag from the library. Two of them are regression tests for bugs this suite caught
 * before the feature shipped:
 *   - 'tet' as a `contains` stem matched 245 videos (tether, arteterapia, quartet,
 *     obstetrics, competetion, ...). It is exact-only now.
 *   - lunar windows carry numeric from/to day offsets; an `if (w.from && w.to)`
 *     dispatch read -7 as a [month, day] pair and broke every lunar holiday.
 *
 * Guiding asymmetry: a false negative shows one Christmas video in June; a false
 * positive hides a legitimate video for eleven months. Bias to not matching.
 */

const {
  easterSunday, seasonalKeys, isInSeason, inSeasonKeys, outOfSeasonKeys,
  seasonalMatch, isOutOfSeason,
} = require('../utils/seasonal');

/** Midday UTC, so no timezone can nudge a boundary case onto the wrong day. */
const D = (iso) => new Date(`${iso}T12:00:00Z`);

describe('easterSunday (computus)', () => {
  test.each([
    [2024, '2024-03-31'], [2025, '2025-04-20'], [2026, '2026-04-05'],
    [2027, '2027-03-28'], [2030, '2030-04-21'],
  ])('Easter %i is %s', (year, iso) => {
    expect(easterSunday(year).toISOString().slice(0, 10)).toBe(iso);
  });
});

describe('fixed-date windows', () => {
  test.each([
    ['christmas', '2026-12-01', true],
    ['christmas', '2026-12-12', true],
    ['christmas', '2026-12-26', true],
    ['christmas', '2026-12-27', false],   // Christmas is over
    ['christmas', '2026-11-30', false],   // not December yet
    ['christmas', '2026-07-20', false],
    ['halloween', '2026-10-01', true],
    ['halloween', '2026-10-31', true],
    ['halloween', '2026-11-03', false],
    ['valentine', '2026-02-14', true],
    ['valentine', '2026-06-01', false],
    ['stpatricks', '2026-03-17', true],
    ['oktoberfest', '2026-09-25', true],
    ['thanksgiving', '2026-11-26', true],  // US, 4th Thursday
    ['thanksgiving', '2026-10-12', true],  // Canadian, 2nd Monday — same wide window
    ['thanksgiving', '2026-01-15', false],
  ])('%s on %s → in season: %s', (id, iso, want) => {
    expect(isInSeason(id, D(iso))).toBe(want);
  });

  test('new year wraps the year boundary', () => {
    expect(isInSeason('newyear', D('2026-12-31'))).toBe(true);
    expect(isInSeason('newyear', D('2027-01-03'))).toBe(true);
    expect(isInSeason('newyear', D('2026-01-06'))).toBe(true);
    expect(isInSeason('newyear', D('2026-01-07'))).toBe(false);
    expect(isInSeason('newyear', D('2026-12-25'))).toBe(false);
  });
});

describe('moveable windows', () => {
  // Easter 2026 = Apr 5, so the window is Mar 15 .. Apr 6.
  test.each([
    ['2026-03-15', true], ['2026-04-05', true], ['2026-04-06', true],
    ['2026-03-14', false], ['2026-04-07', false], ['2026-12-25', false],
  ])('easter on %s → %s', (iso, want) => {
    expect(isInSeason('easter', D(iso))).toBe(want);
  });

  // Mardi Gras 2026 = Easter-47 = Feb 17.
  test('carnival tracks Easter', () => {
    expect(isInSeason('carnival', D('2026-02-17'))).toBe(true);
    expect(isInSeason('carnival', D('2026-02-25'))).toBe(false);
  });

  // Regression: numeric from/to offsets must not be read as [month, day].
  test.each([
    ['ramadan', '2026-03-01', true], ['ramadan', '2026-08-01', false],
    ['diwali', '2026-11-08', true], ['diwali', '2026-05-08', false],
    ['lunarnewyear', '2026-02-17', true], ['lunarnewyear', '2026-07-17', false],
    ['hanukkah', '2026-12-06', true], ['hanukkah', '2026-06-06', false],
  ])('%s on %s → %s', (id, iso, want) => {
    expect(isInSeason(id, D(iso))).toBe(want);
  });
});

describe('multi-window holidays', () => {
  // Ramadan declares two windows; a bare "eid" tag can mean either festival.
  test('eid is in season for BOTH Eid al-Fitr and Eid al-Adha', () => {
    expect(isInSeason('ramadan', D('2026-03-19'))).toBe(true);   // Eid al-Fitr
    expect(isInSeason('ramadan', D('2026-05-27'))).toBe(true);   // Eid al-Adha
    expect(isInSeason('ramadan', D('2026-09-01'))).toBe(false);  // neither
  });

  test('an Eid al-Adha upload is corroborated by its own window', () => {
    expect(seasonalKeys(['eid-ul-adha'], D('2025-06-07'))).toEqual(['ramadan']);
  });
});

describe('fail-open behaviour', () => {
  test('a year past the end of the lunar table hides nothing', () => {
    expect(isInSeason('diwali', D('2099-05-01'))).toBe(true);
  });
  test('an unknown holiday id hides nothing', () => {
    expect(isInSeason('nosuchholiday', D('2026-07-20'))).toBe(true);
  });
  test('a video with no seasonal keys is never withheld', () => {
    expect(isOutOfSeason([], D('2026-07-20'))).toBe(false);
    expect(isOutOfSeason({}, D('2026-07-20'))).toBe(false);
    expect(isOutOfSeason({ seasonal: [] }, D('2026-07-20'))).toBe(false);
  });
});

describe('tag matching — must match', () => {
  test.each([
    ['christmas', 'christmas'], ['christmas', 'Merry Christmas'],
    ['christmas', 'xmas2023'], ['christmas', 'afri-christmas'],
    ['christmas', 'navidad2022'], ['christmas', 'weihnachten'],
    ['christmas', 'advent'], ['christmas', 'santa claus'],
    ['christmas', '#FelizNavidad'], ['christmas', 'hivecreatorschristmas'],
    ['christmas', 'celebraciónnavideña'],
    ['halloween', 'halloween'], ['halloween', 'diyhalloween'],
    ['halloween', 'spooky'], ['halloween', 'trick-or-treat'],
    ['halloween', 'jackolantern'],
    ['easter', 'easter'], ['easter', 'ostern'], ['easter', 'semanasanta'],
    ['easter', 'hiveeaster2025'],
    ['newyear', 'happynewyear2022'], ['newyear', 'nye'],
    ['valentine', "valentine's day"], ['valentine', 'sanvalentin'],
    ['valentine', 'valentinesday'],
    ['thanksgiving', 'thanksgivinggnomes'], ['blackfriday', 'blackfriday'],
    ['ramadan', 'eid'], ['ramadan', 'eid-mubarak'], ['ramadan', 'ramadan'],
    ['diwali', 'celebratediwali'], ['lunarnewyear', 'chinesenewyear'],
    ['lunarnewyear', 'tet'], ['stpatricks', 'stpatricksday'],
    ['oktoberfest', 'oktoberfest'], ['carnival', 'carnaval2022'],
  ])('%s ← "%s"', (id, tag) => {
    expect(seasonalKeys([tag])).toContain(id);
  });

  test('accepts a comma-separated string as well as an array', () => {
    expect(seasonalKeys('spanish,navidad,music')).toEqual(['christmas']);
    expect(seasonalKeys(['spanish', 'navidad', 'music'])).toEqual(['christmas']);
  });
});

describe('tag matching — must NOT match (real tags from the library)', () => {
  test.each([
    // 'advent' → adventure, 856 videos
    'adventure', 'adventures', 'adventurer', 'pixeladventure', 'sonicadventuredx',
    'action-adventuregame', 'hikingadventures', 'adventuretime', 'spaceadventure',
    // 'valentin' → the valentinazoe poetry channel, ~300 videos
    'valentinazoe', 'valentina', 'valentinazoetv', 'jillvalentine', 'jillvalentinedbd',
    'espavalentin', 'valentindehorror', 'valentinazoeviolin',
    // 'eid' → the single worst stem in the library
    'apartheid', 'kaleidoscope', 'feid', 'zeidler', 'breitscheidplatz', 'philschneider',
    'whiteidentity', 'danielreid', 'viruswaarheid', 'nucleidemusicalediting',
    // 'tet' → 245 videos when it was a `contains` stem
    'tether', 'arteterapia', 'quartet', 'obstetrics', 'competetion', 'fluteteacher',
    'aminutetomidnite', 'corporatetraining', 'skatetricks', 'tastetest',
    // 'santa' → places and people
    'santana', 'santander', 'santacruz', 'santamonica', 'santafeklan', 'santacatarina',
    // 'pascua'/'easter' → an island, a beach, a gaming trope
    'malapascua', 'malapascuacebu', 'malapascuaisland', 'easterisland',
    'easteregg', 'eastereggs', 'eastern', 'easterneurope', 'diemachineeasteregg',
    // assorted
    'pivxmasternodesetup', 'coronavid19', 'paddyfield', 'paddyfields', 'paddy',
    'spookyzone', 'tetris', 'tetrahedroseph', 'karly-noel', 'natal', 'prenatal',
    'nadal',
  ])('"%s" matches no holiday', (tag) => {
    expect(seasonalKeys([tag])).toEqual([]);
  });

  test('Chinese New Year in Spanish is not the Gregorian new year', () => {
    expect(seasonalKeys(['añonuevochino2026'])).toEqual(['lunarnewyear']);
  });
});

describe('upload-date corroboration', () => {
  test('a christmas tag on a December upload counts', () => {
    expect(seasonalKeys(['christmas'], D('2022-12-18'))).toEqual(['christmas']);
  });

  test('a christmas tag on a July upload is treated as noise', () => {
    expect(seasonalKeys(['christmas'], D('2022-07-14'))).toEqual([]);
  });

  test('the grace margin covers filmed-at-Christmas, posted-in-January', () => {
    expect(seasonalKeys(['christmas'], D('2023-01-20'))).toEqual(['christmas']);
  });

  test('omitting created keeps the tag-only verdict', () => {
    expect(seasonalKeys(['christmas'])).toEqual(['christmas']);
    expect(seasonalKeys(['christmas'], null)).toEqual(['christmas']);
  });

  test('an unparseable date is not evidence against the tag', () => {
    expect(seasonalKeys(['christmas'], 'not-a-date')).toEqual(['christmas']);
  });

  // Real false positives from the library that this rule removes.
  test.each([
    [['carnival'], '2019-08-26', 'Notting Hill Carnival (a real August carnival)'],
    [['spooky'], '2021-01-19', 'HIVE Ghost Wheel Spin, a January game show'],
    [['santa'], '2020-07-14', "Santa's little shop of horrors — Killing Floor 2"],
    [['lent'], '2020-07-15', 'Lent and fasting, posted mid-July'],
  ])('%s posted %s is not gated (%s)', (tags, iso) => {
    expect(seasonalKeys(tags, D(iso))).toEqual([]);
  });
});

describe('query helpers', () => {
  test('outOfSeasonKeys covers everything on a quiet summer day', () => {
    const out = outOfSeasonKeys(D('2026-07-20'));
    expect(out).toContain('christmas');
    expect(out).toContain('halloween');
    expect(inSeasonKeys(D('2026-07-20'))).toEqual([]);
  });

  test('a holiday in season is excluded from the out-of-season set', () => {
    expect(outOfSeasonKeys(D('2026-12-12'))).not.toContain('christmas');
    expect(inSeasonKeys(D('2026-12-12'))).toContain('christmas');
  });

  test('seasonalMatch produces a spreadable $nin fragment', () => {
    const m = seasonalMatch();
    // Uses $nin (not $ne) because most pool entries have no `seasonal` field at
    // all and every one of them must still match.
    if (Object.keys(m).length) {
      expect(m.seasonal.$nin).toEqual(expect.arrayContaining(['christmas']));
    }
  });

  test('isOutOfSeason withholds a Christmas video in July, keeps it in December', () => {
    expect(isOutOfSeason({ seasonal: ['christmas'] }, D('2026-07-20'))).toBe(true);
    expect(isOutOfSeason({ seasonal: ['christmas'] }, D('2026-12-12'))).toBe(false);
  });
});
