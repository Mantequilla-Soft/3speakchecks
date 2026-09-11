const { runBadgeIndex } = require('../utils/badgeIndex');

/**
 * Keep the badge index current.
 *
 * Badges are Hive accounts, so their name, picture and description can be
 * changed from any Hive frontend at any time — 3Speak is not the only way to
 * edit one, and nothing tells us when somebody does. A badge created HERE is
 * indexed the moment it exists; everything else is caught by this pass.
 *
 * Cheap by design: one profile read per badge, a few hundred at most, and the
 * directory it feeds is then a single database query however many people ask
 * for it.
 */
async function runOnce() {
    const started = Date.now();
    try {
        const { imported, indexed } = await runBadgeIndex();
        console.log(`[badges] indexed ${indexed} badges (${imported} in the peakd list) in ${Date.now() - started}ms`);
    } catch (err) {
        // Never fatal: the directory keeps serving the rows from last time.
        console.error('[badges] index run failed:', err.message);
    }
}

module.exports = { runOnce };
