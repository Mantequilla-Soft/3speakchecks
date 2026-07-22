/**
 * Seasonal (holiday) content gating for the discover feed.
 *
 * A Christmas video is great on December 12th and faintly depressing on July 20th.
 * This module recognises holiday content by its tags and keeps it out of discover
 * while its holiday is out of season. Everything else about the video is untouched:
 * the Hive post stands, the watch page plays, search finds it, the author's profile
 * still lists it, and the moment the window opens it flows back into discover on its
 * own. Nothing is written to the video document — the gate is purely a function of
 * (tags, today's date).
 *
 * ── How it is wired ──────────────────────────────────────────────────────────────
 * Matching happens ONCE, at pool build time: services/discoverWorker.js stamps each
 * pool entry with `seasonal: ['christmas']` (usually absent — ~1% of the library).
 * utils/discoverPool.js then drops out-of-season keys at READ time, so the gate opens
 * and closes on the calendar without waiting for a pool rebuild.
 *
 * The stamp is computed from the video's OWN tags only, never from the transcription
 * tags that get merged into the pool's `tags` field for display. A video that merely
 * *says* "christmas" out loud is not a Christmas video. It also requires the UPLOAD
 * DATE to corroborate the tag — see seasonalKeys(), which is where the second-biggest
 * source of false positives gets removed.
 *
 * ── Why the alias lists look so paranoid ─────────────────────────────────────────
 * Substring matching on holiday words is a minefield, and this is measured, not
 * hypothetical — every example below is a real tag in the library:
 *
 *   'advent'    →  adventure (856 videos!), adventures, pixeladventure, sonicadventuredx
 *   'valentin'  →  valentinazoe / valentina / valentinazoetv (~300, a poetry channel),
 *                  jillvalentine (Resident Evil)
 *   'eid'       →  apartheid, kaleidoscope, feid (the artist), zeidler, breitscheidplatz
 *   'santa'     →  santana, santander, santacruz, santamonica, santafeklan
 *   'pascua'    →  malapascua (a Philippine island — 9 videos)
 *   'easter'    →  easteregg (gaming), eastern, easterneurope
 *   'xmas'      →  pivxmasternodesetup ("pivx masternode setup")
 *   'navid'     →  coronavid19
 *   'paddy'     →  paddyfield, paddyfields (rice)
 *
 * So each holiday declares its aliases in three explicit flavours, and a `deny` list
 * that overrides all of them:
 *
 *   exact    — the normalised tag must equal this exactly. Safest; used wherever the
 *              stem is a live word ('advent', 'santa', 'spooky', 'noel').
 *   prefix   — the tag must START with this ('xmas' → xmas2023, xmasmovies, but NOT
 *              pivxmasternodesetup).
 *   contains — the stem may appear anywhere. Only for stems with no known collisions
 *              ('christmas', 'navidad', 'weihnacht', 'halloween', 'thanksgiving').
 *   deny     — if the tag contains any of these, the holiday does not match, whatever
 *              the three lists above say. Last line of defence.
 *
 * The asymmetry that drives every judgement call here: a false NEGATIVE shows one
 * Christmas video in June, while a false POSITIVE hides a legitimate video for eleven
 * months. When in doubt, don't match — and prefer a WIDER date window, since a wider
 * window means the content is visible more of the year, not less.
 *
 * ── Env ──────────────────────────────────────────────────────────────────────────
 *   SEASONAL_FILTER_ENABLED   default true. Set false to make this a no-op everywhere
 *                             without a code change (the stamp is still written, so
 *                             re-enabling is instant — no pool rebuild needed).
 *   SEASONAL_HOLIDAYS_OFF     comma-separated holiday ids to exempt, e.g.
 *                             "carnival,valentine". Those ids never gate anything.
 *   SEASONAL_REQUIRE_TIMELY   default true. Require the upload date to corroborate
 *                             the tag before gating. Turning this off roughly
 *                             doubles the false-positive rate — see seasonalKeys().
 *   SEASONAL_TIMELY_GRACE_DAYS  default 45. How far off-window an upload may be and
 *                             still count as holiday content.
 *   SEASONAL_NOW              ISO date ("2026-07-20") to override "today". TESTING
 *                             ONLY — lets you see the July feed in December.
 *
 * Ops: `node scripts/audit-seasonal-tags.js` prints the in-season calendar and every
 * tag token that triggers each holiday. Run it after touching an alias list — reading
 * that token list is the only reliable way to spot a false positive.
 */

const SEASONAL_FILTER_ENABLED =
  String(process.env.SEASONAL_FILTER_ENABLED ?? 'true').toLowerCase() !== 'false';

// Require a video's upload date to corroborate its holiday tags before gating it.
// See seasonalKeys() for why this matters more than it sounds like it should.
const SEASONAL_REQUIRE_TIMELY =
  String(process.env.SEASONAL_REQUIRE_TIMELY ?? 'true').toLowerCase() !== 'false';
const SEASONAL_TIMELY_GRACE_DAYS = Number(
  process.env.SEASONAL_TIMELY_GRACE_DAYS !== undefined ? process.env.SEASONAL_TIMELY_GRACE_DAYS : 45
);

const SEASONAL_HOLIDAYS_OFF = new Set(
  String(process.env.SEASONAL_HOLIDAYS_OFF || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

/** "Today", honouring the SEASONAL_NOW test override. Always UTC-normalised. */
function seasonalNow() {
  const override = process.env.SEASONAL_NOW;
  if (override) {
    const d = new Date(override);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

// ── Moveable feasts ──────────────────────────────────────────────────────────────

/**
 * Easter Sunday (Gregorian), by the Anonymous/Meeus computus. Returns a UTC Date.
 * Half the Christian calendar hangs off this: Carnival/Mardi Gras is Easter-47,
 * Holy Week is Easter-7, so those windows are expressed as day offsets from here.
 */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);   // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Lunar / lunisolar holidays can't be computed from a formula worth maintaining, so
 * they get a lookup table of first-day dates. Windows are built around these.
 *
 * IMPORTANT: a year with no entry FAILS OPEN — the holiday is treated as always in
 * season, i.e. nothing is ever hidden. Running past the end of this table degrades
 * to "no seasonal gating for these holidays", never to "content wrongly hidden".
 * Extend it when convenient; nothing breaks if you forget.
 */
const LUNAR_DATES = {
  // Ramadan begins (Eid al-Fitr follows ~30 days later; window covers both).
  ramadan: {
    2025: '2025-03-01', 2026: '2026-02-18', 2027: '2027-02-08',
    2028: '2028-01-28', 2029: '2029-01-16', 2030: '2030-01-06',
  },
  // Eid al-Adha — a separate festival ~70 days after Eid al-Fitr, so it needs its
  // own window rather than a wider Ramadan one.
  eidaladha: {
    2025: '2025-06-06', 2026: '2026-05-27', 2027: '2027-05-16',
    2028: '2028-05-05', 2029: '2029-04-24', 2030: '2030-04-13',
  },
  diwali: {
    2025: '2025-10-20', 2026: '2026-11-08', 2027: '2027-10-29',
    2028: '2028-10-17', 2029: '2029-11-05', 2030: '2030-10-26',
  },
  lunarnewyear: {
    2025: '2025-01-29', 2026: '2026-02-17', 2027: '2027-02-06',
    2028: '2028-01-26', 2029: '2029-02-13', 2030: '2030-02-03',
  },
  hanukkah: {
    2025: '2025-12-14', 2026: '2026-12-04', 2027: '2027-12-24',
    2028: '2028-12-12', 2029: '2029-12-01', 2030: '2030-12-20',
  },
};

// ── The holiday table ────────────────────────────────────────────────────────────
//
// `window` is one of the following, or an ARRAY of them when a holiday occupies more
// than one period in the year (Ramadan carries both Eids):
//   { from: [month, day], to: [month, day] }   fixed dates, MAY wrap the year end
//   { easter: [fromOffset, toOffset] }         days relative to Easter Sunday
//   { lunar: 'key', from: n, to: m }           days relative to LUNAR_DATES[key]
//
// Month is 1-based. Both ends are inclusive.

const HOLIDAYS = [
  {
    id: 'christmas',
    window: { from: [12, 1], to: [12, 26] },
    contains: ['christmas', 'navidad', 'navideñ', 'navideno', 'weihnacht', 'kerstmis', 'joulu'],
    prefix: ['xmas'],
    exact: [
      'advent', 'adventskalender', 'adventcalendar', 'vlogmas',
      'santa', 'santaclaus', 'papanoel', 'papainoel', 'sinterklaas', 'nikolaus',
      'noel', 'yule', 'yuletide', 'chrismas', 'chrismast', 'christmast',
      'natale', 'julen', 'nochebuena',
      // NOT 'nadal' (Catalan for Christmas, but also Rafael Nadal) and NOT bare
      // 'jul' (reads as an abbreviation for July). Both cost more than they buy.
    ],
    deny: ['adventure', 'masternode', 'coronavid'],
  },
  {
    id: 'newyear',
    window: { from: [12, 26], to: [1, 6] },      // wraps the year end
    contains: ['newyear', 'nochevieja', 'anonuevo', 'añonuevo', 'reveillon', 'réveillon'],
    exact: ['nye', 'hogmanay', 'silvester', 'sylwester', 'saintsylvestre'],
    // Lunar/Chinese New Year is a different holiday on a different date — including
    // when it's written in Spanish ("añonuevochino2026").
    deny: ['lunarnewyear', 'chinesenewyear', 'koreannewyear', 'nuevochino'],
  },
  {
    id: 'halloween',
    window: { from: [10, 1], to: [11, 2] },
    contains: ['halloween', 'diadelosmuertos', 'diademuertos', 'dayofthedead'],
    exact: [
      'spooky', 'spookyseason', 'spookymonth', 'trickortreat', 'trick-or-treat',
      'jackolantern', 'jack-o-lantern', 'allhallows', 'allhallowseve', 'samhain',
      'nochedebrujas',
    ],
    // 'spookyzone' is a channel brand, not October content — exact-only already
    // excludes it, this is belt and braces.
    deny: ['spookyzone'],
    // Deliberately NOT matched: pumpkin, horror, scary, costume, ghost. All are
    // year-round content that merely correlates with October.
  },
  {
    id: 'easter',
    // Three weeks before Easter Sunday through Easter Monday — covers Lent's tail,
    // Palm Sunday, Holy Week / Semana Santa and Good Friday.
    window: { easter: [-21, 1] },
    contains: ['easter', 'semanasanta', 'osterhase', 'osterei', 'pascoa', 'páscoa', 'pasqua'],
    exact: [
      'ostern', 'pascua', 'paques', 'pâques', 'goodfriday', 'viernessanto',
      'holyweek', 'palmsunday', 'domingoderamos', 'karfreitag', 'lent', 'cuaresma',
    ],
    // easteregg/eastern are the two big collisions; malapascua and easterisland
    // are places, and a travel video shouldn't vanish for eleven months.
    deny: ['easteregg', 'eastern', 'malapascua', 'easterisland'],
  },
  {
    id: 'carnival',
    // Mardi Gras is Easter-47; the season runs the week or so before it.
    window: { easter: [-54, -45] },
    contains: ['carnaval', 'carnival', 'karneval', 'fasching', 'fastnacht', 'mardigras'],
    exact: ['shrovetuesday', 'pancakeday', 'ashwednesday', 'miercolesdeceniza'],
    // NOTE: "carnival" also means a funfair. This is the least clear-cut entry in
    // the table — SEASONAL_HOLIDAYS_OFF=carnival turns it off if it misfires.
  },
  {
    id: 'thanksgiving',
    // US is the 4th Thursday of November, Canada the 2nd Monday of October. One
    // wide window covers both rather than computing two nth-weekday dates.
    window: { from: [10, 1], to: [11, 30] },
    contains: ['thanksgiving', 'acciondegracias', 'accióndegracias'],
    exact: ['turkeyday'],
  },
  {
    id: 'blackfriday',
    window: { from: [11, 15], to: [12, 2] },
    contains: ['blackfriday', 'viernesnegro', 'cybermonday'],
  },
  {
    id: 'valentine',
    window: { from: [2, 1], to: [2, 15] },
    // NO `contains` at any price: 'valentin' collides with the valentinazoe channel
    // (~300 videos) and jillvalentine. Exact aliases only, apostrophes included
    // because normalisation keeps them.
    exact: [
      'valentine', 'valentines', 'valentinesday', "valentine'sday", "valentine's",
      'valentineday', 'valentinday', 'happyvalentinesday', "happyvalentine'sday",
      'happyvalentineday', 'valentinstag', 'sanvalentin', 'sanvalentín',
      'diadelamor', 'diadelosenamorados', 'saintvalentin',
    ],
    deny: ['valentina', 'jillvalentine', 'espavalentin', 'valentindehorror'],
  },
  {
    id: 'stpatricks',
    window: { from: [3, 8], to: [3, 19] },
    contains: ['stpatrick', 'saintpatrick', 'stpaddy', 'paddysday'],
    // 'paddy' alone is rice (paddyfield, paddyfields) — never match it bare.
    deny: ['paddyfield', 'paddyrice'],
  },
  {
    id: 'oktoberfest',
    window: { from: [9, 10], to: [10, 10] },
    contains: ['oktoberfest'],
    exact: ['wiesn', 'wiesnfest'],
  },
  {
    id: 'ramadan',
    // Two windows: Ramadan (~30 days) through Eid al-Fitr, and Eid al-Adha ~70 days
    // later. A bare "eid" tag can mean either, so this id covers both and is in
    // season for both — over-permissive on purpose, in the show-it direction.
    window: [
      { lunar: 'ramadan', from: -7, to: 38 },
      { lunar: 'eidaladha', from: -5, to: 6 },
    ],
    contains: ['ramadan', 'ramadhan', 'ramzan', 'eidmubarak', 'eidul', 'hariraya'],
    // 'eid' as a bare stem is the worst offender in the whole library — apartheid,
    // kaleidoscope, feid, zeidler, breitscheidplatz. Prefix-only, plus a deny list.
    prefix: ['eid'],
    exact: ['eid', 'bakrid', 'iftar', 'suhoor', 'sehri'],
    deny: [
      'apartheid', 'kaleidoscope', 'feid', 'zeidler', 'breitscheid', 'philschneider',
      'whiteidentity', 'danielreid', 'viruswaarheid', 'nucleide', 'eider',
    ],
  },
  {
    id: 'diwali',
    window: { lunar: 'diwali', from: -10, to: 5 },
    contains: ['diwali', 'deepavali', 'dipavali'],
  },
  {
    id: 'lunarnewyear',
    window: { lunar: 'lunarnewyear', from: -10, to: 16 },
    contains: ['lunarnewyear', 'chinesenewyear', 'springfestival', 'seollal', 'nuevochino'],
    // 'tet' (Vietnamese New Year) is EXACT-ONLY and must stay that way. As a
    // `contains` stem it matched 245 videos — tether, arteterapia, quartet,
    // obstetrics, competetion, aminutetomidnite, fluteteacher...
    exact: ['tet', 'cny', 'yearofthedragon', 'yearofthesnake', 'yearofthehorse'],
  },
  {
    id: 'hanukkah',
    window: { lunar: 'hanukkah', from: -5, to: 12 },
    contains: ['hanukk', 'chanuk', 'hanuka', 'menorah'],
  },
  // Deliberately NOT in this table:
  //   independenceday — 15 videos, and the date is per-country (US Jul 4, Poland
  //     Nov 11, India Aug 15, Mexico Sep 16...). One window would be wrong for most.
  //   mothersday / fathersday — dates vary widely by country for the same reason.
];

const HOLIDAY_BY_ID = new Map(HOLIDAYS.map((h) => [h.id, h]));

// ── Tag normalisation ────────────────────────────────────────────────────────────

/**
 * Tighter than utils/interests.js `normalizeTags`: that one keeps internal spaces and
 * punctuation, so "merry christmas" and "santa claus" would never hit an alias list.
 * Here we strip a leading #/@, lowercase, and squeeze out spaces, dots and
 * underscores — but KEEP hyphens and apostrophes, because several aliases carry them
 * ("trick-or-treat", "valentine'sday") and both spellings appear in the wild.
 */
function normalizeSeasonalTag(tag) {
  return String(tag == null ? '' : tag)
    .toLowerCase()
    .replace(/^[#@]+/, '')
    .replace(/[\s._]+/g, '')
    .replace(/^-+|-+$/g, '')
    .trim();
}

/** Accepts an array of tags or a comma-separated string; yields normalised tokens. */
function seasonalTokens(tags) {
  const arr = typeof tags === 'string' ? tags.split(',') : (Array.isArray(tags) ? tags : []);
  const out = [];
  for (const t of arr) {
    const n = normalizeSeasonalTag(t);
    if (n) out.push(n);
    // "trick-or-treat" and "trickortreat" should both hit; index the de-hyphenated
    // form too so an alias only has to be spelled one way.
    const flat = n.replace(/[-']/g, '');
    if (flat && flat !== n) out.push(flat);
  }
  return out;
}

/** Does one normalised token identify this holiday? */
function tokenMatchesHoliday(token, h) {
  if (h.deny && h.deny.some((d) => token.includes(d))) return false;
  if (h.exact && h.exact.includes(token)) return true;
  if (h.prefix && h.prefix.some((p) => token.startsWith(p))) return true;
  if (h.contains && h.contains.some((c) => token.includes(c))) return true;
  return false;
}

/**
 * The holiday ids a video's own tags identify it with — normally [].
 *
 * `created` is optional but you should almost always pass it. Tags alone are a noisy
 * signal, because a good number of creators paste the SAME tag block onto every
 * upload: one channel tags every video "easter", another tags unrelated vlogs
 * "christmas". Requiring that the video was also POSTED near that holiday cuts the
 * noise without weakening the real cases — measured on the live library, it drops
 * 121 of 2330 matches, and the ones it drops are exactly the wrong ones:
 *
 *   [carnival]    2019-08-26  "UNCUT: Crazy Scenes at the 2019 Notting Hill Carnival"
 *   [halloween]   2021-01-19  "HIVE Ghost Wheel Spin - 19 January 2021"
 *   [christmas]   2020-07-14  "Santa's little shop of horrors - Killing Floor 2"
 *   [easter]      2020-07-15  "Lent and fasting."
 *
 * A genuine Christmas video is posted in December; one posted in July is using the
 * word for something else. The grace margin is generous (default 45 days) so
 * "filmed at Christmas, published January 20th" still counts.
 *
 * The result is DATE-FREE with respect to today — it is stamped onto the pool entry
 * once and stays valid forever; only the read side cares what day it is now.
 *
 * Env: SEASONAL_REQUIRE_TIMELY (default true), SEASONAL_TIMELY_GRACE_DAYS (default 45).
 */
function seasonalKeys(tags, created = null) {
  const tokens = seasonalTokens(tags);
  if (!tokens.length) return [];
  const hits = [];
  for (const h of HOLIDAYS) {
    if (!tokens.some((t) => tokenMatchesHoliday(t, h))) continue;
    if (SEASONAL_REQUIRE_TIMELY && created) {
      const at = new Date(created);
      // An unparseable date is not evidence AGAINST the tag — keep the key.
      if (!Number.isNaN(at.getTime()) && !isInSeason(h, at, SEASONAL_TIMELY_GRACE_DAYS)) continue;
    }
    hits.push(h.id);
  }
  return hits;
}

// ── Date windows ─────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;
const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/**
 * The concrete [start, end] day ranges this holiday occupies in a given year, as UTC
 * day-timestamps. A holiday may declare several windows (Ramadan carries both Eids).
 * Yields nothing for an undecidable year — a lunar holiday past the end of
 * LUNAR_DATES — which callers read as "don't know" and fail open on.
 *
 * Resolving every window kind to real dates — rather than comparing month/day pairs
 * — is what lets `grace` below widen a window by N days without special-casing the
 * year-end wrap or a moveable feast.
 */
function windowRanges(h, year) {
  const specs = Array.isArray(h.window) ? h.window : [h.window];
  return specs.map((w) => oneRange(w, year)).filter(Boolean);
}

function oneRange(w, year) {
  if (w.easter) {
    const e = utcDay(easterSunday(year));
    return { start: e + w.easter[0] * DAY_MS, end: e + w.easter[1] * DAY_MS };
  }

  if (w.lunar) {
    const iso = (LUNAR_DATES[w.lunar] || {})[year];
    if (!iso) return null;
    const s = utcDay(new Date(`${iso}T00:00:00Z`));
    return { start: s + w.from * DAY_MS, end: s + w.to * DAY_MS };
  }

  if (Array.isArray(w.from) && Array.isArray(w.to)) {
    const start = Date.UTC(year, w.from[0] - 1, w.from[1]);
    // A window whose end month/day precedes its start wraps into the next year
    // (new year: Dec 26 → Jan 6).
    const wraps = (w.to[0] * 100 + w.to[1]) < (w.from[0] * 100 + w.from[1]);
    const end = Date.UTC(year + (wraps ? 1 : 0), w.to[0] - 1, w.to[1]);
    return { start, end };
  }

  return null;
}

/**
 * Is this holiday in season on `when`? `graceDays` widens the window on both sides.
 *
 * Undecidable cases return TRUE — in season ⇒ nothing hidden. That fail-open rule is
 * deliberate and applies to unknown holiday ids, malformed windows, and lunar years
 * past the end of the table.
 */
function isInSeason(holiday, when = seasonalNow(), graceDays = 0) {
  const h = typeof holiday === 'string' ? HOLIDAY_BY_ID.get(holiday) : holiday;
  if (!h) return true;                                   // unknown id → never gate
  if (SEASONAL_HOLIDAYS_OFF.has(h.id)) return true;      // operator exempted it

  const day = utcDay(when);
  const y = when.getUTCFullYear();
  const pad = graceDays * DAY_MS;
  let decidable = false;

  // Probe the neighbouring years too: windows can straddle a year boundary and
  // Easter alone swings across five weeks.
  for (const year of [y - 1, y, y + 1]) {
    for (const r of windowRanges(h, year)) {
      decidable = true;
      if (day >= r.start - pad && day <= r.end + pad) return true;
    }
  }
  return decidable ? false : true;   // no data for any probed year → fail open
}

/** Holiday ids that are NOT in season right now — the set discover filters out. */
function outOfSeasonKeys(now = seasonalNow()) {
  if (!SEASONAL_FILTER_ENABLED) return [];
  return HOLIDAYS.filter((h) => !isInSeason(h, now)).map((h) => h.id);
}

/** Holiday ids in season right now. Handy for ops/debug endpoints. */
function inSeasonKeys(now = seasonalNow()) {
  return HOLIDAYS.filter((h) => isInSeason(h, now)).map((h) => h.id);
}

/**
 * Mongo condition to spread into a discover-pool query, alongside its neighbours:
 *   { ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
 *     ...seasonalMatch() }
 *
 * `$nin` is the right operator here for the same reason `$ne: true` is right in
 * hiddenFromFeed: the overwhelming majority of pool entries have no `seasonal` field
 * at all (or an empty array), and every one of them must still match. Returns {} when
 * the filter is disabled or when every holiday happens to be in season.
 */
function seasonalMatch(field = 'seasonal') {
  const out = outOfSeasonKeys();
  return out.length ? { [field]: { $nin: out } } : {};
}

/**
 * In-memory equivalent, for an already-fetched doc or a raw key array.
 * True ⇒ this video's holiday is out of season and it should be withheld.
 */
function isOutOfSeason(keysOrDoc, now = seasonalNow()) {
  if (!SEASONAL_FILTER_ENABLED) return false;
  const keys = Array.isArray(keysOrDoc)
    ? keysOrDoc
    : (keysOrDoc && Array.isArray(keysOrDoc.seasonal) ? keysOrDoc.seasonal : []);
  if (!keys.length) return false;
  return keys.some((k) => !isInSeason(k, now));
}

module.exports = {
  SEASONAL_FILTER_ENABLED,
  SEASONAL_REQUIRE_TIMELY,
  SEASONAL_TIMELY_GRACE_DAYS,
  HOLIDAYS,
  windowRanges,
  seasonalNow,
  easterSunday,
  normalizeSeasonalTag,
  seasonalTokens,
  seasonalKeys,
  isInSeason,
  inSeasonKeys,
  outOfSeasonKeys,
  seasonalMatch,
  isOutOfSeason,
};
