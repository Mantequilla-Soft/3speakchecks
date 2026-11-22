/**
 * 🏁 Weekly Shorts challenge (owner 2026-11-22): one theme per week, Sunday
 * 00:00 UTC to Saturday 23:59:59.999 UTC (owner: weeks start on Sundays). A week
 * is named after the ISO week its Monday falls in, so '2026-W48' runs from Sunday
 * 2026-11-22 to Saturday 2026-11-28. A Short joins by carrying the week's
 * Hive tag (`challenge2026w48`), set by a switch in the 3Speak uploader.
 *
 * Two collections:
 *
 *   shorts_challenges          one doc per week, the prompts the team defines
 *     { _id: '2026-W48', week, tag, theme, texts: { en: { title, prompt }, de: ... },
 *       starts_at, ends_at, created_at, updated_at }
 *
 *   shorts_challenge_entries   one doc per Short that carries a week's tag and was
 *                              posted inside that week (found by syncEntries)
 *     { week, tag, owner, permlink (embed asset id), hive_author, hive_permlink,
 *       posted_at, found_at, checked, reviewed_at, reviewed_by }
 *
 * An entry counts as participation ONLY once the team has checked it
 * (`checked: true`, set from the admin frontend). `reviewed_at` null = not looked
 * at yet; `reviewed_at` set with `checked: false` = the team turned it down.
 *
 * The first plan (2026-W48 .. 2027-W52) is seeded from
 * data/shortsChallenges.seed.json, insert-only: a week the team has edited is
 * never overwritten.
 */
const path = require('path');

const CHALLENGES = 'shorts_challenges';
const ENTRIES = 'shorts_challenge_entries';

const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 24 * 3600 * 1000;
const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const TITLE_MAX = 80;
const PROMPT_MAX = 300;

/** The challenge week a moment falls in, in UTC: '2026-W48' (a Sunday counts with the Monday after it). */
function weekIdOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  const day = d.getUTCDay() || 7; // Monday 1 .. Sunday 7
  d.setUTCDate(d.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Sunday 00:00 UTC of a week id, or null for something that is not one. */
function weekStart(weekId) {
  const m = WEEK_RE.exec(String(weekId || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday1 = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY_MS;
  const start = new Date(monday1 + (week - 1) * 7 * DAY_MS - DAY_MS); // the Sunday before
  return weekIdOf(start) === weekId ? start : null; // W53 only in years that have one
}

/** The last moment of a week (Saturday 23:59:59.999 UTC), or null. */
function weekEnd(weekId) {
  const s = weekStart(weekId);
  return s ? new Date(s.getTime() + 7 * DAY_MS - 1) : null;
}

/** The Hive tag a week's entries carry: '2026-W48' -> 'challenge2026w48'. */
function tagOf(weekId) {
  return `challenge${String(weekId).replace('-W', 'w').toLowerCase()}`;
}

const isWeekId = (v) => !!weekStart(v);

/**
 * A team-written `texts` map, checked: { lang: { title, prompt } } with English
 * required. Returns { texts } or { error }.
 */
function cleanTexts(texts) {
  if (!texts || typeof texts !== 'object' || Array.isArray(texts)) return { error: 'texts must be an object of languages' };
  const out = {};
  for (const [lang, v] of Object.entries(texts)) {
    if (!LANG_RE.test(lang)) return { error: `bad language code: ${lang}` };
    const title = typeof v?.title === 'string' ? v.title.trim() : '';
    const prompt = typeof v?.prompt === 'string' ? v.prompt.trim() : '';
    if (!title || !prompt) return { error: `${lang}: title and prompt are both needed` };
    if (title.length > TITLE_MAX) return { error: `${lang}: title is longer than ${TITLE_MAX}` };
    if (prompt.length > PROMPT_MAX) return { error: `${lang}: prompt is longer than ${PROMPT_MAX}` };
    out[lang.toLowerCase()] = { title, prompt };
  }
  if (!out.en) return { error: 'texts.en is required' };
  return { texts: out };
}

// ── Indexes + seed, once per process ─────────────────────────────────────────
let readyPromise = null;
function ensureReady(db, { seedFile = path.join(__dirname, '../data/shortsChallenges.seed.json') } = {}) {
  if (!readyPromise) {
    readyPromise = (async () => {
      await Promise.all([
        db.collection(CHALLENGES).createIndex({ starts_at: 1 }),
        db.collection(ENTRIES).createIndex({ owner: 1, permlink: 1 }, { unique: true }),
        db.collection(ENTRIES).createIndex({ week: 1, checked: 1, posted_at: -1 }),
        db.collection(ENTRIES).createIndex({ week: 1, reviewed_at: 1, posted_at: -1 }),
      ]);
      await seedChallenges(db, seedFile);
      await fixWeekDates(db);
    })().catch((err) => {
      readyPromise = null; // try again on the next request
      throw err;
    });
  }
  return readyPromise;
}

/**
 * A week's dates always follow from its id (they are never edited by hand): put
 * them right where they differ, e.g. the weeks seeded while weeks still started
 * on Mondays (2026-11-22).
 */
async function fixWeekDates(db) {
  const docs = await db.collection(CHALLENGES).find({}, { projection: { starts_at: 1, ends_at: 1 } }).toArray();
  const ops = [];
  for (const d of docs) {
    const s = weekStart(d._id);
    const e = weekEnd(d._id);
    if (!s) continue;
    if (new Date(d.starts_at).getTime() !== s.getTime() || new Date(d.ends_at).getTime() !== e.getTime()) {
      ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { starts_at: s, ends_at: e } } } });
    }
  }
  if (ops.length) await db.collection(CHALLENGES).bulkWrite(ops, { ordered: false });
  return ops.length;
}

/** Insert the planned weeks that are not in Mongo yet; never touches an existing week. */
async function seedChallenges(db, seedFile) {
  let plan;
  try {
    plan = require(seedFile);
  } catch {
    return 0;
  }
  const now = new Date();
  const ops = [];
  for (const row of plan) {
    if (!isWeekId(row.week) || !row.theme) continue;
    const { texts, error } = cleanTexts(row.texts);
    if (error) continue;
    ops.push({
      updateOne: {
        filter: { _id: row.week },
        update: {
          $setOnInsert: {
            week: row.week,
            tag: tagOf(row.week),
            theme: String(row.theme),
            texts,
            starts_at: weekStart(row.week),
            ends_at: weekEnd(row.week),
            created_at: now,
            updated_at: now,
          },
        },
        upsert: true,
      },
    });
  }
  if (!ops.length) return 0;
  const res = await db.collection(CHALLENGES).bulkWrite(ops, { ordered: false });
  return res.upsertedCount || 0;
}

// ── Entries: the Shorts that carry a week's tag ──────────────────────────────
// Found on demand (public entries, admin list), at most every SYNC_MIN per week,
// so it works on every checker instance without a background job. Upserts are
// idempotent (unique owner+permlink), so two instances syncing at once is fine.
const SYNC_MIN = Math.max(parseInt(process.env.SHORTS_CHALLENGE_SYNC_MIN, 10) || 2, 0);
// After a week ends, keep looking for a while: tags reach embed-video late
// sometimes (the Hive post is linked after the upload).
const SYNC_AFTER_END_DAYS = 14;
const lastSync = new Map(); // week → ms

async function syncEntries(db, challenge, { force = false, now = Date.now() } = {}) {
  if (!challenge?.week) return 0;
  const starts = new Date(challenge.starts_at).getTime();
  const ends = new Date(challenge.ends_at).getTime();
  if (now < starts || now > ends + SYNC_AFTER_END_DAYS * DAY_MS) return 0;
  if (!force && now - (lastSync.get(challenge.week) || 0) < SYNC_MIN * 60 * 1000) return 0;
  lastSync.set(challenge.week, now);
  if (lastSync.size > 200) lastSync.delete(lastSync.keys().next().value);

  const shorts = await db.collection('embed-video').find(
    {
      hive_tags_lower: challenge.tag,
      short: true,
      status: 'published',
      createdAt: { $gte: new Date(starts), $lte: new Date(ends) },
    },
    { projection: { owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1, createdAt: 1 } },
  ).limit(5000).toArray();
  if (!shorts.length) return 0;

  const found = new Date(now);
  const ops = shorts.filter((s) => s.owner && s.permlink).map((s) => {
    const link = {};
    if (s.hive_author) link.hive_author = s.hive_author;
    if (s.hive_permlink) link.hive_permlink = s.hive_permlink;
    return {
      updateOne: {
        filter: { owner: s.owner, permlink: s.permlink },
        update: {
          $setOnInsert: {
            week: challenge.week,
            tag: challenge.tag,
            owner: s.owner,
            permlink: s.permlink,
            posted_at: s.createdAt,
            found_at: found,
            checked: false,
            reviewed_at: null,
            reviewed_by: null,
          },
          ...(Object.keys(link).length ? { $set: link } : {}),
        },
        upsert: true,
      },
    };
  });
  const res = await db.collection(ENTRIES).bulkWrite(ops, { ordered: false });
  return res.upsertedCount || 0;
}

/** pending | checked | rejected, from an entry's flags. */
function statusOf(entry) {
  if (entry.checked) return 'checked';
  return entry.reviewed_at ? 'rejected' : 'pending';
}

/** The Mongo filter for a status (anything else = every entry). */
function statusFilter(status) {
  if (status === 'checked') return { checked: true };
  if (status === 'pending') return { checked: { $ne: true }, reviewed_at: null };
  if (status === 'rejected') return { checked: { $ne: true }, reviewed_at: { $ne: null } };
  return {};
}

module.exports = {
  CHALLENGES,
  ENTRIES,
  weekIdOf,
  weekStart,
  weekEnd,
  tagOf,
  isWeekId,
  cleanTexts,
  ensureReady,
  seedChallenges,
  fixWeekDates,
  syncEntries,
  statusOf,
  statusFilter,
  _test: { lastSync, resetReady: () => { readyPromise = null; } },
};
