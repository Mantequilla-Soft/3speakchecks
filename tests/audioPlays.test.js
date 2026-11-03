/**
 * What counts as a play of a 3Speak audio track (utils/audioPlays.js): a
 * pay-per-listen credit from after listening sessions began is already a
 * session, so neither the play count nor the consolidation counts it twice.
 */
const { countedElsewhere, LISTEN_SESSIONS_SINCE } = require('../utils/audioPlays');

describe('countedElsewhere', () => {
  const after = new Date(LISTEN_SESSIONS_SINCE.getTime() + 1000);
  const before = new Date(LISTEN_SESSIONS_SINCE.getTime() - 1000);

  it('skips pay-per-listen credits written since sessions began', () => {
    expect(countedElsewhere({ ppl: true, createdAt: after })).toBe(true);
  });

  it('keeps older credits and every Snapie play', () => {
    expect(countedElsewhere({ ppl: true, createdAt: before })).toBe(false);
    expect(countedElsewhere({ ppl: false, payable: false, createdAt: after })).toBe(false);
    expect(countedElsewhere({ createdAt: after })).toBe(false);
  });
});
