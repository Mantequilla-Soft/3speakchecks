/**
 * "Follow these" creator suggestions — the pure ranking step (scoring, exclusions,
 * ordering, limit). The DB aggregation is verified live, not here.
 */
const { rankCandidates } = require('../utils/suggestedCreators');

// A tiny engagement map: author -> stats.
const eng = (m) => new Map(Object.entries(m).map(([a, s]) => [a, { author: a, videoCount: 1, sample: null, ...s }]));

describe('rankCandidates', () => {
  const engagement = eng({
    alice: { views: 1000, comments: 20, reshares: 5 },
    bob: { views: 5000, comments: 0, reshares: 0 },
    carol: { views: 100, comments: 2, reshares: 1 },
    dave: { views: 0, comments: 0, reshares: 0 },   // no measurable engagement
  });
  const cands = (names) => names.map((a) => ({ author: a, topics: ['music'] }));

  test('ranks by the engagement blend, most-engaged first', () => {
    // alice dominates. carol (100 views + 2 comments + 1 reshare) BEATS bob (5000
    // views, zero engagement) — comments/reshares are weighted above raw views.
    const out = rankCandidates(cands(['carol', 'alice', 'bob']), engagement, { limit: 10 });
    expect(out.map((c) => c.author)).toEqual(['alice', 'carol', 'bob']);
  });

  test('comments + reshares outweigh raw views (a discussed video beats a merely-viewed one)', () => {
    // bob has 5× alice's views but zero comments/reshares; alice still wins.
    const out = rankCandidates(cands(['alice', 'bob']), engagement, { limit: 10 });
    expect(out[0].author).toBe('alice');
  });

  test('a creator with no measurable engagement is dropped', () => {
    const out = rankCandidates(cands(['dave', 'carol']), engagement, { limit: 10 });
    expect(out.map((c) => c.author)).toEqual(['carol']);
  });

  test('excludes the caller and anyone they already follow — the whole point of "follow THESE"', () => {
    const out = rankCandidates(cands(['alice', 'bob', 'carol']), engagement, {
      limit: 10, excludeUser: 'Alice', followSet: new Set(['bob']),
    });
    expect(out.map((c) => c.author)).toEqual(['carol']);   // alice=self, bob=followed
  });

  test('respects the limit (the row only fits so many tiles)', () => {
    const out = rankCandidates(cands(['alice', 'bob', 'carol']), engagement, { limit: 2 });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.author)).toEqual(['alice', 'carol']);   // carol > bob (see above)
  });

  test('carries the matched topics and a sample through for the tile', () => {
    const withSample = eng({ alice: { views: 10, comments: 1, reshares: 1, sample: { permlink: 'p', title: 'T' } } });
    const out = rankCandidates([{ author: 'alice', topics: ['music', 'art'] }], withSample, { limit: 5 });
    expect(out[0].matchedTopics).toEqual(['music', 'art']);
    expect(out[0].sample).toEqual({ permlink: 'p', title: 'T' });
  });

  test('author matching is case-insensitive for self/follow exclusion', () => {
    const out = rankCandidates([{ author: 'ALICE', topics: [] }], engagement, {
      limit: 5, followSet: new Set(['alice']),
    });
    expect(out).toHaveLength(0);
  });

  test('deterministic tie-break by views then name when scores collide', () => {
    const tie = eng({ x: { views: 50, comments: 1, reshares: 1 }, y: { views: 50, comments: 1, reshares: 1 } });
    const out = rankCandidates([{ author: 'y', topics: [] }, { author: 'x', topics: [] }], tie, { limit: 5 });
    expect(out.map((c) => c.author)).toEqual(['x', 'y']);   // equal score+views → name order
  });
});
