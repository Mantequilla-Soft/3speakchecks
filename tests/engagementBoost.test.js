/**
 * Engagement affinity: the bounded multiplier, the topic evidence gate, the
 * follow-boost combination rule, and the credited-author rules in the sync.
 */
const {
  engagementMultiplier, applyEngagementBoost, defaultAuthorOf, defaultTopicOf,
  getEngagementAffinity, setWarmer, takeQueued, dequeue, forget, invalidate,
} = require('../utils/engagementBoost');
const { creditedAuthor, decay } = require('../services/engagementSync');
const {
  ENGAGE_MAX_BOOST, ENGAGE_TOPIC_MIN_SHARE, ENGAGE_TOPIC_FULL_EVENTS,
  ENGAGE_HALFLIFE_DAYS, FOLLOW_BOOST,
} = require('../utils/config');

const DAY = 24 * 60 * 60 * 1000;
const affinity = (authors = {}, topics = {}, topic_events = 100) => ({ authors, topics, topic_events });

afterEach(() => invalidate());

describe('engagementMultiplier', () => {
  test('no affinity and no match are exactly neutral', () => {
    expect(engagementMultiplier(null, 'alice', 'music')).toBe(1);
    expect(engagementMultiplier(affinity(), 'alice', 'music')).toBe(1);
    expect(engagementMultiplier(affinity({ bob: 5 }), 'alice', 'music')).toBe(1);
  });

  test('more engagement with a creator lifts them, monotonically', () => {
    const a = (w) => engagementMultiplier(affinity({ alice: w }), 'alice', null);
    expect(a(1)).toBeGreaterThan(1);
    expect(a(5)).toBeGreaterThan(a(1));
    expect(a(20)).toBeGreaterThan(a(5));
  });

  test('log-damped: the 10th engagement is worth far less than the 1st', () => {
    const m = (w) => engagementMultiplier(affinity({ alice: w }), 'alice', null);
    expect(m(10) - m(9)).toBeLessThan((m(1) - m(0)) / 3);
  });

  test('hard-capped, so one obsessive commenter cannot mint a #1 slot', () => {
    expect(engagementMultiplier(affinity({ alice: 1e6 }, { music: 1 }), 'alice', 'music')).toBe(ENGAGE_MAX_BOOST);
  });

  test('capped below the hand-picked interest multiplier', () => {
    // A topic the viewer chose must always beat one we inferred from behaviour.
    const { DISCOVER_INTEREST_EXACT_MULT } = require('../utils/config');
    expect(ENGAGE_MAX_BOOST).toBeLessThan(DISCOVER_INTEREST_EXACT_MULT);
  });

  test('a bigger topic share earns a bigger boost', () => {
    const t = (share) => engagementMultiplier(affinity({}, { music: share }), 'nobody', 'music');
    expect(t(0.4)).toBeGreaterThan(t(0.1));
    expect(t(0.1)).toBeGreaterThan(1);
  });

  test('a topic below the noise floor is ignored entirely', () => {
    const below = ENGAGE_TOPIC_MIN_SHARE / 2;
    expect(engagementMultiplier(affinity({}, { music: below }), 'nobody', 'music')).toBe(1);
  });

  test('the evidence gate keeps a 100% share off thin data', () => {
    const thin = engagementMultiplier({ authors: {}, topics: { music: 1 }, topic_events: 1 }, 'x', 'music');
    const full = engagementMultiplier({ authors: {}, topics: { music: 1 }, topic_events: ENGAGE_TOPIC_FULL_EVENTS }, 'x', 'music');
    expect(thin).toBeLessThan(full);
    expect(thin - 1).toBeCloseTo((full - 1) / ENGAGE_TOPIC_FULL_EVENTS, 5);
  });

  test('a missing topic_events means no topic boost, never a free full one', () => {
    expect(engagementMultiplier({ authors: {}, topics: { music: 1 } }, 'x', 'music')).toBe(1);
  });

  test('author and topic add up, but never past the cap', () => {
    const both = engagementMultiplier(affinity({ alice: 5 }, { music: 0.4 }), 'alice', 'music');
    const authorOnly = engagementMultiplier(affinity({ alice: 5 }, { music: 0.4 }), 'alice', null);
    expect(both).toBeGreaterThan(authorOnly);
    expect(both).toBeLessThanOrEqual(ENGAGE_MAX_BOOST);
  });

  test('garbage weights are treated as no engagement', () => {
    expect(engagementMultiplier(affinity({ alice: NaN }), 'alice', null)).toBe(1);
    expect(engagementMultiplier(affinity({ alice: -5 }), 'alice', null)).toBe(1);
    expect(engagementMultiplier(affinity({ alice: null }), 'alice', null)).toBe(1);
  });
});

describe('applyEngagementBoost', () => {
  const vids = () => ([
    { author: 'alice', winnerTag: 'music', discover_score: 10 },
    { author: 'bob', winnerTag: 'music', discover_score: 10 },
    { author: 'carol', winnerTag: 'gardening', discover_score: 10 },
  ]);

  test('boosts only what the viewer actually engaged with', () => {
    const v = vids();
    const n = applyEngagementBoost(v, affinity({ alice: 5 }), { scoreField: 'discover_score' });
    expect(n).toBe(1);
    expect(v[0].discover_score).toBeGreaterThan(10);
    expect(v[1].discover_score).toBe(10);
    expect(v[2].discover_score).toBe(10);
    expect(v[0].engagement_match).toBe(true);
  });

  test('the topic alone lifts other creators in that topic', () => {
    const v = vids();
    applyEngagementBoost(v, affinity({}, { music: 0.4 }), { scoreField: 'discover_score' });
    expect(v[1].discover_score).toBeGreaterThan(10);   // bob, never engaged with, but music
    expect(v[2].discover_score).toBe(10);              // carol, different topic
  });

  test('no affinity / empty affinity leaves every score untouched', () => {
    const v = vids();
    expect(applyEngagementBoost(v, null, { scoreField: 'discover_score' })).toBe(0);
    expect(applyEngagementBoost(v, affinity(), { scoreField: 'discover_score' })).toBe(0);
    expect(v.every((x) => x.discover_score === 10)).toBe(true);
  });

  test('does not compound with the follow boost for the same creator', () => {
    // applyFollowBoost has already multiplied this score by FOLLOW_BOOST.
    const followed = [{ author: 'alice', winnerTag: null, follow_match: true, discover_score: 10 * FOLLOW_BOOST }];
    const plain = [{ author: 'alice', winnerTag: null, discover_score: 10 }];
    applyEngagementBoost(followed, affinity({ alice: 5 }), { scoreField: 'discover_score' });
    applyEngagementBoost(plain, affinity({ alice: 5 }), { scoreField: 'discover_score' });
    // The followed video ends up at the LARGER of the two multipliers, not their product.
    const engageMult = engagementMultiplier(affinity({ alice: 5 }), 'alice', null);
    expect(followed[0].discover_score).toBeCloseTo(10 * Math.max(engageMult, FOLLOW_BOOST), 6);
    expect(followed[0].discover_score).toBeLessThan(10 * engageMult * FOLLOW_BOOST);
    expect(plain[0].discover_score).toBeCloseTo(10 * engageMult, 6);
  });

  test('a weak engagement never DEMOTES a followed creator', () => {
    const v = [{ author: 'alice', winnerTag: null, follow_match: true, discover_score: 10 * FOLLOW_BOOST }];
    applyEngagementBoost(v, affinity({ alice: 0.01 }), { scoreField: 'discover_score' });
    expect(v[0].discover_score).toBeCloseTo(10 * FOLLOW_BOOST, 6);
  });

  test("'multiply' restores stacking", () => {
    const v = [{ author: 'alice', winnerTag: null, follow_match: true, discover_score: 10 }];
    applyEngagementBoost(v, affinity({ alice: 5 }), { scoreField: 'discover_score', combine: 'multiply' });
    expect(v[0].discover_score).toBeCloseTo(10 * engagementMultiplier(affinity({ alice: 5 }), 'alice', null), 6);
  });

  test('matches the HIVE author, not the asset uploader', () => {
    expect(defaultAuthorOf({ author: 'alice', owner: 'uploader' })).toBe('alice');
    expect(defaultAuthorOf({ owner: 'uploader' })).toBe('uploader');
    expect(defaultAuthorOf({ author: '@Alice' })).toBe('alice');
  });

  test('the topic key is the same winnerTag the feeds rank on', () => {
    expect(defaultTopicOf({ winnerTag: 'Music' })).toBe('music');
    expect(defaultTopicOf({})).toBe(null);
  });
});

describe('credited author (sync)', () => {
  test('a comment credits the ROOT author, not whoever was replied to', () => {
    expect(creditedAuthor({ root_author: 'alice', parent_author: 'bob' })).toBe('alice');
  });

  test('a container account falls back to the person actually replied to', () => {
    // Snap/wave containers are the root author of every thread under them, and would
    // otherwise become the single biggest "creator" every viewer engages with.
    expect(creditedAuthor({ root_author: 'peak.snaps', parent_author: 'bob' })).toBe('bob');
  });

  test('a reply to the container itself credits nobody', () => {
    expect(creditedAuthor({ root_author: 'peak.snaps', parent_author: 'peak.snaps' })).toBe(null);
    expect(creditedAuthor({ root_author: '', parent_author: '' })).toBe(null);
  });
});

describe('recency decay', () => {
  test('a fresh engagement counts fully', () => {
    expect(decay(0)).toBeCloseTo(1, 6);
  });

  test('one half-life halves it', () => {
    expect(decay(ENGAGE_HALFLIFE_DAYS * DAY)).toBeCloseTo(0.5, 6);
  });

  test('the far edge of the window still counts for something', () => {
    expect(decay(90 * DAY)).toBeGreaterThan(0.1);
  });

  test('monotonically decreasing', () => {
    expect(decay(10 * DAY)).toBeGreaterThan(decay(30 * DAY));
  });
});

describe('the cold path (queue + cache)', () => {
  // A db stub: counts reads so we can prove a cached miss is not re-read, and that
  // forget() makes the next request go back to Mongo.
  const stubDb = (rows) => {
    const calls = { reads: 0 };
    return {
      calls,
      collection: () => ({
        findOne: async ({ _id }) => { calls.reads += 1; return rows[_id] || null; },
      }),
    };
  };

  afterEach(() => { setWarmer(null); invalidate(); });

  test('a cold viewer gets no boost and is queued for the sync', async () => {
    const warmed = [];
    setWarmer((u) => warmed.push(u));
    const db = stubDb({});
    expect(await getEngagementAffinity(db, 'newbie')).toBe(null);
    expect(warmed).toEqual(['newbie']);
    expect(takeQueued(10)).toEqual(['newbie']);
  });

  test('a garbage username never reaches Mongo or the sync', async () => {
    const warmed = [];
    setWarmer((u) => warmed.push(u));
    const db = stubDb({});
    for (const bad of ['../../etc/passwd', 'a', '', 'UPPER CASE', '9starts-with-digit', 'x'.repeat(40)]) {
      expect(await getEngagementAffinity(db, bad)).toBe(null);
    }
    expect(db.calls.reads).toBe(0);
    expect(warmed).toEqual([]);
  });

  test('a stored row is read once, then served from the in-process cache', async () => {
    const db = stubDb({ alice: { authors: { bob: 3 }, topics: {}, topic_events: 20, updated_at: new Date() } });
    const a = await getEngagementAffinity(db, 'alice');
    const b = await getEngagementAffinity(db, 'alice');
    expect(a.authors.bob).toBe(3);
    expect(b).toBe(a);
    expect(db.calls.reads).toBe(1);
  });

  test('forget() sends the next request back to Mongo', async () => {
    // Without this, a viewer whose row was just built keeps being served the cached
    // MISS for the whole cache TTL — browsing with the boost silently off.
    const rows = {};
    const db = stubDb(rows);
    expect(await getEngagementAffinity(db, 'alice')).toBe(null);
    rows.alice = { authors: { bob: 3 }, topics: {}, topic_events: 20, updated_at: new Date() };
    expect(await getEngagementAffinity(db, 'alice')).toBe(null);      // still the cached miss
    forget('alice');
    const after = await getEngagementAffinity(db, 'alice');
    expect(after.authors.bob).toBe(3);
  });

  test('dequeue() stops the next tick re-walking a viewer already taken', async () => {
    setWarmer(() => {});
    const db = stubDb({});
    await getEngagementAffinity(db, 'alice');
    dequeue('alice');
    expect(takeQueued(10)).toEqual([]);
  });

  test('a stale row is still served while a refresh is queued', async () => {
    const warmed = [];
    setWarmer((u) => warmed.push(u));
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const db = stubDb({ alice: { authors: { bob: 3 }, topics: {}, topic_events: 20, updated_at: old } });
    const a = await getEngagementAffinity(db, 'alice');
    expect(a.authors.bob).toBe(3);          // stale-while-revalidate, never a stall
    expect(warmed).toEqual(['alice']);
  });

  test('a broken read degrades to no boost, it does not throw', async () => {
    const db = { collection: () => ({ findOne: async () => { throw new Error('mongo down'); } }) };
    await expect(getEngagementAffinity(db, 'alice')).resolves.toBe(null);
  });
});
