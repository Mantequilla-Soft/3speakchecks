/**
 * Discord messages for new Shorts challenge entries (services/shortsChallengeNotify.js)
 * against the real test MongoDB, with a stand-in Discord: each entry is sent once,
 * a refused send is retried on the next run, old entries are left alone, and the
 * job does nothing without a webhook.
 */
const testDb = require('./helpers/db');
const { pinClock } = require('./routes-misc/_fixtures');
const sc = require('../utils/shortsChallenge');
const notify = require('../services/shortsChallengeNotify');

const db = testDb.use();
const NOW = new Date('2026-11-25T10:00:00.000Z'); // Wednesday of 2026-W48 (Sun 11-22 .. Sat 11-28)
const HOOK = 'https://discord.test.invalid/api/webhooks/1/abc';

const short = (owner, permlink, extra = {}) => db().collection('embed-video').insertOne({
  owner, permlink, short: true, status: 'published', processed: true,
  createdAt: new Date('2026-11-24T09:00:00.000Z'),
  hive_tags: ['hive-181335', 'challenge2026w48'], hive_tags_lower: ['hive-181335', 'challenge2026w48'],
  hive_body: `My desk tour! @everyone ![x](https://img.example/a.png) https://play.3speak.tv/embed?v=${owner}/${permlink}`,
  thumbnail_url: `https://img.example/${permlink}.jpg`,
  ...extra,
});

function discord(statuses = []) {
  const calls = [];
  const fn = jest.fn(async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const status = statuses.length ? statuses.shift() : 204;
    return { ok: status < 300, status };
  });
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  pinClock(NOW);
  sc._test.resetReady();
  sc._test.lastSync.clear();
  notify._test.reset();
  process.env.SHORTS_CHALLENGE_DISCORD_WEBHOOK = HOOK;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.SHORTS_CHALLENGE_DISCORD_WEBHOOK;
});

test('without a webhook it does nothing', async () => {
  delete process.env.SHORTS_CHALLENGE_DISCORD_WEBHOOK;
  const fetchImpl = discord();
  expect(await notify.runOnce({ db: db(), fetchImpl, now: NOW.getTime() })).toMatchObject({ sent: 0, skipped: 'no webhook' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a new entry is sent once, with the theme, the author, a plain caption and no pings', async () => {
  await short('badadib', 'desk1');
  const fetchImpl = discord();
  expect(await notify.runOnce({ db: db(), fetchImpl, now: NOW.getTime() })).toEqual({ sent: 1, failed: 0 });
  expect(fetchImpl.calls[0].url).toBe(HOOK);
  const msg = fetchImpl.calls[0].body;
  expect(msg.allowed_mentions).toEqual({ parse: [] });
  const e = msg.embeds[0];
  expect(e).toMatchObject({
    title: 'New entry: Your workspace',
    url: 'https://3speak.tv/shorts?v=badadib/desk1',
    author: { name: '@badadib', url: 'https://3speak.tv/@badadib' },
    thumbnail: { url: 'https://img.example/desk1.jpg' },
    footer: { text: '#challenge2026w48' },
  });
  expect(e.description).toBe('My desk tour! @everyone');
  expect(e.fields[0].value).toBe('2026-W48 (Nov 22 to Nov 28)');

  // the next run has nothing new
  const again = discord();
  expect(await notify.runOnce({ db: db(), fetchImpl: again, now: NOW.getTime() + 5 * 60000 })).toEqual({ sent: 0, failed: 0 });
  expect(again).not.toHaveBeenCalled();
});

test('a refused send is given back and sent on the next run', async () => {
  await short('badadib', 'desk1');
  const down = discord([500]);
  expect(await notify.runOnce({ db: db(), fetchImpl: down, now: NOW.getTime() })).toEqual({ sent: 0, failed: 1 });
  const entry = await db().collection('shorts_challenge_entries').findOne({ permlink: 'desk1' });
  expect(entry).toMatchObject({ notified_at: null, notify_attempts: 1 });
  const up = discord();
  expect(await notify.runOnce({ db: db(), fetchImpl: up, now: NOW.getTime() + 5 * 60000 })).toEqual({ sent: 1, failed: 0 });
});

test('gives up on an entry after five refusals', async () => {
  await short('badadib', 'desk1');
  for (let i = 0; i < 5; i += 1) {
    await notify.runOnce({ db: db(), fetchImpl: discord([400]), now: NOW.getTime() + i * 60000 });
  }
  const sixth = discord();
  expect(await notify.runOnce({ db: db(), fetchImpl: sixth, now: NOW.getTime() + 10 * 60000 })).toEqual({ sent: 0, failed: 0 });
  expect(sixth).not.toHaveBeenCalled();
});

test('several new entries in one run, oldest first; entries older than 3 days are not sent', async () => {
  await short('badadib', 'b', { createdAt: new Date('2026-11-24T12:00:00.000Z') });
  await short('ashenadib', 'a', { createdAt: new Date('2026-11-23T08:00:00.000Z') });
  await db().collection('shorts_challenge_entries').insertOne({
    week: '2026-W47', tag: 'challenge2026w47', owner: 'badadib', permlink: 'old',
    posted_at: new Date('2026-11-18T08:00:00.000Z'), checked: false, reviewed_at: null,
  });
  const fetchImpl = discord();
  expect(await notify.runOnce({ db: db(), fetchImpl, now: NOW.getTime() })).toEqual({ sent: 2, failed: 0 });
  expect(fetchImpl.calls.map((c) => c.body.embeds[0].url)).toEqual([
    'https://3speak.tv/shorts?v=ashenadib/a',
    'https://3speak.tv/shorts?v=badadib/b',
  ]);
});

test('plainCaption drops links, images and Markdown and keeps it short', () => {
  expect(notify.plainCaption('**Hi** [my site](https://x.y) ![p](https://i/p.png) https://3speak.tv/x #tag')).toBe('Hi my site tag');
  expect(notify.plainCaption('x'.repeat(400))).toHaveLength(300);
});
