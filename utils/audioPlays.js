/**
 * What counts as a play of a 3Speak audio track. Shared by the listen count
 * (routes/audio.js listenCountStages) and the listen-log consolidation
 * (services/listenConsolidation.js), so the two never disagree.
 */

// A listening session (listen-durations) is a play from this much audio heard,
// or half of a track shorter than twice this.
const PLAY_MIN_SECONDS = 30;

// listen-durations has a row for every 3speak.tv and audio.3speak.tv listening
// session since this moment (routes/audioListen.js went live).
const LISTEN_SESSIONS_SINCE = new Date('2026-10-31T00:58:00Z');

// audio-listen-log rows that are ALSO a listening session: pay-per-listen
// credits from 3speak.tv's player written since then. They stay in the log for
// payouts but are not counted again. Snapie's plays (ppl false) always count.
const LISTEN_LOG_COUNTED_ELSEWHERE = { ppl: true, createdAt: { $gte: LISTEN_SESSIONS_SINCE } };

const countedElsewhere = (row) => row?.ppl === true
    && row.createdAt instanceof Date && row.createdAt >= LISTEN_SESSIONS_SINCE;

module.exports = { PLAY_MIN_SECONDS, LISTEN_SESSIONS_SINCE, LISTEN_LOG_COUNTED_ELSEWHERE, countedElsewhere };
