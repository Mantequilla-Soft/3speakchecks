/**
 * 🏁 Weekly Shorts challenge: a Discord message for every new entry, so the team
 * sees it and can check it in the admin frontend (owner 2026-11-22).
 *
 * Background job (BACKGROUND_JOBS instances only, server.js), every
 * SHORTS_CHALLENGE_NOTIFY_MIN minutes (default 5):
 *   1. find new entries: syncEntries for this week and the one before (a tag can
 *      reach embed-video late), the same lookup the routes use;
 *   2. for each entry without `notified_at` (posted in the last NOTIFY_MAX_AGE_DAYS),
 *      claim it (set notified_at first, so two instances never send it twice),
 *      post it to the webhook, and give the claim back when Discord refused it
 *      (retried on the next run, at most MAX_ATTEMPTS times).
 *
 * It also posts each week's theme once when the week starts (the team's weekly
 * reminder to join, owner 2026-11-22): claimed with `announced_at` on the
 * shorts_challenges doc, only within ANNOUNCE_WITHIN_DAYS of the start.
 *
 * The webhook is SHORTS_CHALLENGE_DISCORD_WEBHOOK (env only, never in the repo or
 * a log line). Unset = the job does nothing. Mentions are switched off, so a
 * caption's "@everyone" stays text.
 */
const { getDb } = require('../utils/db');
const { CHALLENGES, ENTRIES, weekIdOf, ensureReady, syncEntries } = require('../utils/shortsChallenge');

const DAY_MS = 24 * 3600 * 1000;
const MAX_PER_RUN = 20;
const MAX_ATTEMPTS = 5;
const NOTIFY_MAX_AGE_DAYS = 3;
const ANNOUNCE_WITHIN_DAYS = 2;
const CYAN = 0x5fc4d8;

const webhookUrl = () => process.env.SHORTS_CHALLENGE_DISCORD_WEBHOOK || '';
const intervalMin = () => Math.max(parseInt(process.env.SHORTS_CHALLENGE_NOTIFY_MIN, 10) || 5, 1);

/** A Short's caption as plain text for Discord: no embed links, no Markdown images, short. */
function plainCaption(body, max = 300) {
  const text = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // Markdown images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links: keep their text
    .replace(/https?:\/\/\S+/g, ' ') // bare links (the embed URL)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function dayRange(c) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${f.format(new Date(c.starts_at))} to ${f.format(new Date(c.ends_at))}`;
  } catch {
    return '';
  }
}

/** The Discord message for one entry. */
function buildMessage(entry, video, challenge) {
  const author = entry.hive_author || video?.hive_author || entry.owner;
  const url = `https://3speak.tv/shorts?v=${author}/${entry.permlink}`;
  const theme = challenge?.texts?.en?.title || entry.week;
  const caption = plainCaption(video?.hive_body || video?.hive_title || video?.embed_title || '');
  const embed = {
    title: `New entry: ${theme}`.slice(0, 256),
    url,
    color: CYAN,
    author: { name: `@${author}`, url: `https://3speak.tv/@${author}` },
    ...(caption ? { description: caption } : {}),
    fields: [
      { name: 'Week', value: `${entry.week}${challenge ? ` (${dayRange(challenge)})` : ''}`, inline: true },
      { name: 'Status', value: 'Waiting for the team to check it', inline: true },
    ],
    footer: { text: `#${entry.tag}` },
    ...(entry.posted_at ? { timestamp: new Date(entry.posted_at).toISOString() } : {}),
  };
  if (video?.thumbnail_url && /^https:\/\//.test(video.thumbnail_url)) embed.thumbnail = { url: video.thumbnail_url };
  return { username: '3Speak Shorts challenge', embeds: [embed], allowed_mentions: { parse: [] } };
}

/** The "new week" message: this week's theme, its prompt and the way in. */
function buildWeekMessage(challenge) {
  const en = challenge?.texts?.en || {};
  return {
    username: '3Speak Shorts challenge',
    content: "🏁 This week's Shorts challenge has started. Join with a Short!",
    embeds: [{
      title: `This week: ${en.title || challenge.week}`.slice(0, 256),
      url: `https://3speak.tv/challenge/${challenge.week}`,
      color: CYAN,
      ...(en.prompt ? { description: en.prompt } : {}),
      fields: [
        { name: 'Week', value: `${challenge.week} (${dayRange(challenge)}, UTC)`, inline: true },
        { name: 'Tag', value: `#${challenge.tag}`, inline: true },
      ],
      footer: { text: 'Post a Short and turn on "Join this week\'s challenge"' },
    }],
    allowed_mentions: { parse: [] },
  };
}

/** Post this week's theme once, at its start. Returns true when it was sent now. */
async function announceWeek(db, hook, fetchImpl, now) {
  const week = weekIdOf(new Date(now));
  const claimed = await db.collection(CHALLENGES).findOneAndUpdate(
    {
      _id: week,
      announced_at: null,
      starts_at: { $lte: new Date(now), $gte: new Date(now - ANNOUNCE_WITHIN_DAYS * DAY_MS) },
    },
    { $set: { announced_at: new Date(now) } },
    { returnDocument: 'after' },
  );
  const challenge = claimed && Object.prototype.hasOwnProperty.call(claimed, 'value') ? claimed.value : claimed;
  if (!challenge) return false;
  let res = null;
  try {
    res = await fetchImpl(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWeekMessage(challenge)),
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* network: give the claim back below */ }
  if (res && res.ok) return true;
  await db.collection(CHALLENGES).updateOne({ _id: week }, { $set: { announced_at: null } });
  console.warn(`[challenge-discord] week ${week} announcement refused (${res ? res.status : 'network'}), retry next run`);
  return false;
}

let running = false;

/**
 * One pass. `fetchImpl` and `now` for tests. Returns { sent, failed, skipped? }.
 */
async function runOnce({ db = getDb(), fetchImpl = fetch, now = Date.now() } = {}) {
  const hook = webhookUrl();
  if (!hook) return { sent: 0, failed: 0, skipped: 'no webhook' };
  if (running) return { sent: 0, failed: 0, skipped: 'already running' };
  running = true;
  try {
    await ensureReady(db);
    const weeks = [...new Set([weekIdOf(new Date(now)), weekIdOf(new Date(now - 7 * DAY_MS))])];
    const challenges = await db.collection(CHALLENGES).find({ _id: { $in: weeks } }).toArray();
    for (const c of challenges) {
      await syncEntries(db, c, { force: true, now }).catch((err) => console.warn('[challenge-discord] sync failed:', err.message));
    }
    const byWeek = new Map(challenges.map((c) => [c.week, c]));
    const announced = await announceWeek(db, hook, fetchImpl, now);

    let sent = 0;
    let failed = 0;
    const cutoff = new Date(now - NOTIFY_MAX_AGE_DAYS * DAY_MS);
    for (let i = 0; i < MAX_PER_RUN; i += 1) {
      // Claim the oldest waiting entry
      const claimed = await db.collection(ENTRIES).findOneAndUpdate(
        { notified_at: null, posted_at: { $gte: cutoff }, notify_attempts: { $not: { $gte: MAX_ATTEMPTS } } },
        { $set: { notified_at: new Date(now) }, $inc: { notify_attempts: 1 } },
        { sort: { posted_at: 1 }, returnDocument: 'after' },
      );
      const entry = claimed && Object.prototype.hasOwnProperty.call(claimed, 'value') ? claimed.value : claimed;
      if (!entry) break;

      const video = await db.collection('embed-video').findOne(
        { owner: entry.owner, permlink: entry.permlink },
        { projection: { hive_author: 1, hive_body: 1, hive_title: 1, embed_title: 1, thumbnail_url: 1 } },
      );
      const challenge = byWeek.get(entry.week) || await db.collection(CHALLENGES).findOne({ _id: entry.week });
      let res = null;
      try {
        res = await fetchImpl(hook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildMessage(entry, video, challenge)),
          signal: AbortSignal.timeout(10000),
        });
      } catch { /* network: give the claim back below */ }
      if (res && res.ok) {
        sent += 1;
        continue;
      }
      failed += 1;
      await db.collection(ENTRIES).updateOne({ _id: entry._id }, { $set: { notified_at: null } });
      const status = res ? res.status : 'network';
      console.warn(`[challenge-discord] Discord refused ${entry.owner}/${entry.permlink} (${status}), retry next run`);
      if (!res || res.status === 429 || res.status >= 500) break; // slow down / Discord trouble: stop this run
    }
    if (sent || failed || announced) console.log(`[challenge-discord] sent ${sent}, failed ${failed}${announced ? ', new week announced' : ''}`);
    return { sent, failed, ...(announced ? { announced: true } : {}) };
  } finally {
    running = false;
  }
}

/** Schedule the job (server.js, BACKGROUND_JOBS only). First run after 3 minutes. */
function start() {
  if (!webhookUrl()) {
    console.log('[challenge-discord] off (no SHORTS_CHALLENGE_DISCORD_WEBHOOK)');
    return false;
  }
  const run = () => runOnce().catch((err) => console.error('[challenge-discord] run:', err.message));
  setTimeout(() => {
    run();
    setInterval(run, intervalMin() * 60 * 1000);
  }, 3 * 60 * 1000);
  console.log(`[challenge-discord] new Shorts challenge entries to Discord every ${intervalMin()}min (first run in 3min)`);
  return true;
}

module.exports = { runOnce, start, buildMessage, buildWeekMessage, plainCaption, _test: { reset: () => { running = false; } } };
