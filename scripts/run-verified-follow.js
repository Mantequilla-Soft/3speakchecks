/**
 * Run one verified-badge follow sweep by hand.
 *
 * Defaults to a DRY RUN (reads Mongo + the chain, prints the diff, broadcasts
 * nothing) so you can see what the worker would do before arming it. A dry run
 * needs no posting key.
 *
 *   node scripts/run-verified-follow.js              # dry run, prints the diff
 *   node scripts/run-verified-follow.js --broadcast  # actually follow
 *
 * The worker in services/verifiedFollow.js does the same thing every
 * VERIFIED_FOLLOW_INTERVAL_HOURS once the badge key is in .env.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const broadcast = process.argv.includes('--broadcast');
// Set before requiring the service — it reads its env at module load.
if (!broadcast) process.env.VERIFIED_FOLLOW_DRY_RUN = 'true';
if (!process.env.VERIFIED_BADGE_ACCOUNT) {
    console.error('VERIFIED_BADGE_ACCOUNT is not set in .env');
    process.exit(1);
}

const { connectToMongo } = require('../utils/db');
const { runFollowSweep } = require('../services/verifiedFollow');

(async () => {
    await connectToMongo();
    const result = await runFollowSweep();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result && result.error ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
