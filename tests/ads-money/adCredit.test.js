/**
 * Who a delivered impression owes, and when it becomes payable (utils/adCredit.js).
 *
 * The watch surfaces owe the video's owner at once. The upload gate owes the
 * uploader only once the gated video is published, has survived a hold, and the
 * period's cap is not reached; until then it is `pending`, and anything that will
 * never convert is `void` with a reason. Pure decisions, no database.
 */
const { CREDIT_STATES, creditForImpression, onGatedUploadPublished, resolvePending, isPayable } = require('../../utils/adCredit');
const cfg = require('../../utils/config');

const NOW = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const { PENDING, SETTLED, VOID } = CREDIT_STATES;

test('the configured rules this file is written against', () => {
  expect([cfg.AD_GATE_CONVERSION_DAYS, cfg.AD_GATE_SETTLE_HOLD_HOURS, cfg.AD_GATE_MIN_VIDEO_SECONDS, cfg.AD_GATE_MAX_CREDITS_PER_PERIOD])
    .toEqual([7, 48, 30, 10]);
  expect(Object.isFrozen(CREDIT_STATES)).toBe(true);
});

describe('what a new impression is credited to', () => {
  test.each([
    ['a roll on a video credits its owner at once', 'video_roll', { owner: 'creator', viewer: 'fan' }, { creditAccount: 'creator', creditState: SETTLED, creditReason: null }],
    ['a banner credits the owner, never the viewer', 'video_banner', { owner: 'creator', viewer: 'fan' }, { creditAccount: 'creator', creditState: SETTLED, creditReason: null }],
    ['an unknown format is treated as a roll', 'no_such_format', { owner: 'creator' }, { creditAccount: 'creator', creditState: SETTLED, creditReason: null }],
    ['an owned format with no owner pays nobody', 'video_roll', { viewer: 'fan' }, { creditAccount: null, creditState: VOID, creditReason: 'no_owner' }],
    ['the upload gate with nobody signed in pays nobody', 'upload_gate', { owner: 'x' }, { creditAccount: null, creditState: VOID, creditReason: 'no_viewer' }],
  ])('%s', (_label, format, who, want) => {
    expect(creditForImpression({ campaign: { format }, ...who, now: NOW })).toEqual(want);
  });

  test('the upload gate credits the UPLOADER, pending, tied to the upload it gated, with a deadline', () => {
    expect(creditForImpression({ campaign: { format: 'upload_gate' }, viewer: 'uploader', owner: 'ignored', gatedUploadId: 'up-1', now: NOW })).toEqual({
      creditAccount: 'uploader', creditState: PENDING, creditReason: null,
      gatedUploadId: 'up-1', creditDeadlineAt: new Date(NOW + 7 * DAY),
    });
  });

  test('a format whose credit rule is neither of the two pays nobody, and says so', () => {
    let isolated;
    jest.isolateModules(() => {
      jest.doMock('../../utils/adFormats', () => ({
        ...jest.requireActual('../../utils/adFormats'),
        formatOf: () => ({ creatorCredit: 'someone_new' }),
      }));
      isolated = require('../../utils/adCredit');
      jest.dontMock('../../utils/adFormats');
    });
    expect(isolated.creditForImpression({ campaign: {}, owner: 'creator', viewer: 'fan' }))
      .toEqual({ creditAccount: null, creditState: VOID, creditReason: 'format_pays_nobody' });
  });

  test('a gate impression with no upload id still waits, unlinked', () => {
    expect(creditForImpression({ campaign: { format: 'upload_gate' }, viewer: 'uploader', now: NOW }).gatedUploadId).toBeNull();
  });
});

describe('when the gated upload is published', () => {
  const pending = { creditState: PENDING };

  test('the hold starts: nothing is settled yet', () => {
    expect(onGatedUploadPublished({ impression: pending, videoSeconds: 120, now: NOW }))
      .toEqual({ publishedAt: new Date(NOW), settleAfterAt: new Date(NOW + 48 * HOUR) });
  });

  test.each([
    ['29 seconds is too short to be what we were buying', 29, { creditState: VOID, creditReason: 'video_too_short' }],
    ['30 seconds starts the hold', 30, 'held'],
    ['an unknown length (0) is not "too short": it starts the hold', 0, 'held'],
    ['no length at all starts the hold', undefined, 'held'],
  ])('a video of %s', (_label, videoSeconds, want) => {
    const got = onGatedUploadPublished({ impression: pending, videoSeconds, now: NOW });
    if (want === 'held') expect(got).toHaveProperty('settleAfterAt');
    else expect(got).toEqual(want);
  });

  test.each([[null], [{ creditState: SETTLED }], [{ creditState: VOID }]])('an impression that is not pending (%p) is not touched', (impression) => {
    expect(onGatedUploadPublished({ impression, videoSeconds: 120, now: NOW })).toBeNull();
  });
});

describe('what a pending credit becomes', () => {
  const published = { creditState: PENDING, publishedAt: new Date(NOW - 50 * HOUR), settleAfterAt: new Date(NOW - 2 * HOUR) };

  test.each([
    ['not published, deadline passed: void', { creditState: PENDING, creditDeadlineAt: new Date(NOW - 1) }, {}, { creditState: VOID, creditReason: 'not_published_in_time' }],
    ['not published, still inside its window: waits', { creditState: PENDING, creditDeadlineAt: new Date(NOW + DAY) }, {}, null],
    ['not published and no deadline on record: waits', { creditState: PENDING }, {}, null],
    ['published then removed inside the hold: void', published, { stillPublished: false }, { creditState: VOID, creditReason: 'post_removed' }],
    ['could not check whether the post survived: waits, NEVER voids', published, { stillPublished: null }, null],
    ['survived, but the hold has not elapsed: waits', { ...published, settleAfterAt: new Date(NOW + HOUR) }, { stillPublished: true }, null],
    ['survived with no hold on record: waits', { ...published, settleAfterAt: null }, { stillPublished: true }, null],
    ['survived the hold, cap reached: void', published, { stillPublished: true, settledThisPeriod: 10 }, { creditState: VOID, creditReason: 'period_cap_reached' }],
    ['survived the hold, under the cap: settled', published, { stillPublished: true, settledThisPeriod: 9 }, { creditState: SETTLED, creditReason: null, settledAt: new Date(NOW) }],
    ['already settled: nothing to decide', { creditState: SETTLED }, { stillPublished: true }, null],
  ])('%s', (_label, impression, facts, want) => {
    expect(resolvePending({ impression, ...facts, now: NOW })).toEqual(want);
  });

  test('no impression at all decides nothing', () => {
    expect(resolvePending({ impression: undefined })).toBeNull();
  });
});

describe('only settled credits are money', () => {
  test.each([
    [{ creditState: SETTLED, creditAccount: 'creator' }, true],
    [{ creditState: SETTLED, creditAccount: null }, false],
    [{ creditState: PENDING, creditAccount: 'uploader' }, false],
    [{ creditState: VOID, creditAccount: 'uploader' }, false],
    [null, false],
  ])('isPayable(%p) is %p', (impression, want) => {
    expect(isPayable(impression)).toBe(want);
  });
});
