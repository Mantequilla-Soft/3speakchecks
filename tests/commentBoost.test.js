/**
 * Comment boost: the bounded multiplier, the native-3Speak detection, and the
 * "effective" weighting (native comments count 1.5×).
 */
const { commentBoost } = require('../utils/commentBoost');
const { isNative3SpeakComment } = require('../utils/hive');
const { COMMENT_BOOST_MAX, COMMENT_NATIVE_MULT } = require('../utils/config');

describe('commentBoost', () => {
  test('no comments is exactly neutral', () => {
    expect(commentBoost(0)).toBe(1);
    expect(commentBoost(undefined)).toBe(1);
    expect(commentBoost(null)).toBe(1);
  });

  test('more discussion lifts the video, monotonically', () => {
    expect(commentBoost(1)).toBeGreaterThan(1);
    expect(commentBoost(5)).toBeGreaterThan(commentBoost(1));
    expect(commentBoost(20)).toBeGreaterThan(commentBoost(5));
  });

  test('log-damped: the 10th comment is worth far less than the 1st', () => {
    const first = commentBoost(1) - commentBoost(0);
    const tenth = commentBoost(10) - commentBoost(9);
    expect(tenth).toBeLessThan(first / 3);
  });

  test('hard-capped, so a brigaded comment section cannot run away', () => {
    expect(commentBoost(1e6)).toBe(COMMENT_BOOST_MAX);
    expect(commentBoost(50)).toBeLessThanOrEqual(COMMENT_BOOST_MAX);
  });

  test('negative / garbage effective is treated as zero', () => {
    expect(commentBoost(-5)).toBe(1);
    expect(commentBoost(NaN)).toBe(1);
  });
});

describe('effective weighting (native comments count NATIVE_MULT×)', () => {
  // effective = comments + (NATIVE_MULT − 1)·native — the formula the sync stores.
  const effective = (comments, native) => comments + (COMMENT_NATIVE_MULT - 1) * native;

  test('a native comment is worth more than a generic one', () => {
    expect(effective(1, 1)).toBeGreaterThan(effective(1, 0));
    expect(effective(10, 10)).toBeCloseTo(10 * COMMENT_NATIVE_MULT, 5); // all native → ×MULT
  });

  test('and that flows through to a higher boost', () => {
    const generic = commentBoost(effective(10, 0));   // 10 non-native
    const native = commentBoost(effective(10, 10));   // 10 native
    expect(native).toBeGreaterThan(generic);
  });
});

describe('isNative3SpeakComment — detects the 3Speak-frontend app tag', () => {
  const md = (app) => ({ json_metadata: JSON.stringify(app === undefined ? {} : { app }) });

  test('3Speak frontend comments are native', () => {
    expect(isNative3SpeakComment(md('3speak/new-version'))).toBe(true);  // CommentSection.jsx
    expect(isNative3SpeakComment(md('3speak/openpod'))).toBe(true);
    expect(isNative3SpeakComment(md('threespeak'))).toBe(true);
    expect(isNative3SpeakComment(md('3Speak/2.0'))).toBe(true);          // case-insensitive
  });

  test('comments from other Hive frontends are NOT native', () => {
    expect(isNative3SpeakComment(md('ecency/3.0.0'))).toBe(false);
    expect(isNative3SpeakComment(md('peakd/2024'))).toBe(false);
    expect(isNative3SpeakComment(md('hiveblog/0.1'))).toBe(false);
    expect(isNative3SpeakComment(md('leothreads'))).toBe(false);
    expect(isNative3SpeakComment(md(undefined))).toBe(false);            // no app tag
  });

  test('malformed / object json_metadata never throws', () => {
    expect(isNative3SpeakComment({ json_metadata: 'not json{' })).toBe(false);
    expect(isNative3SpeakComment({ json_metadata: { app: '3speak/x' } })).toBe(true); // already-object
    expect(isNative3SpeakComment({})).toBe(false);
    expect(isNative3SpeakComment(null)).toBe(false);
  });
});
