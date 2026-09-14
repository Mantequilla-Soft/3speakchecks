/**
 * Who referred an advertiser?
 *
 * Butter Auth asks every new user who sent them here, at the moment they name
 * themselves. When one of those people later books an ad campaign, the person
 * who brought them gets a cut of what we keep -- see AD_REFERRAL_POOL_PCT and
 * the referral block in services/adPayouts.js.
 *
 * 🚨 FAILS OPEN, ALWAYS. Every path that cannot get an answer returns "no
 * referrer" rather than throwing. A settlement run is the one place in this
 * system where a thrown error costs real money twice over: creators and viewers
 * do not get paid either, and the period is left half-written. Butter Auth being
 * unreachable must cost nothing worse than the platform keeping 2% it would
 * otherwise have passed on, which is the status quo before this existed.
 *
 * 🚨 THE ANSWER IS NOT A VERIFIED IDENTITY. `referredBy` is a name the user
 * typed into a form. Butter Auth checks it has the shape of a Hive name and
 * refuses a self-referral, and that is all -- it does not check the account
 * exists. Anything about to SEND money to one of these names has to confirm it
 * first; adPayouts.js does that against the chain.
 */

const {
    BUTRAUTH_URL, BUTRAUTH_CLIENT_ID, BUTRAUTH_CLIENT_SECRET,
} = require('../utils/config');

// Mirrors MAX_LOOKUP_BATCH server-side.
const BATCH = 100;
const TIMEOUT_MS = 8000;

/**
 * @param {string[]} accounts Hive account names (advertisers).
 * @returns {Promise<Map<string,string>>} account -> referrer name. Accounts with
 *          no referrer, or any account at all if the lookup could not run, are
 *          simply absent.
 */
async function referrersFor(accounts) {
    const out = new Map();
    const wanted = [...new Set(
        (Array.isArray(accounts) ? accounts : [])
            .filter((a) => typeof a === 'string' && a.trim())
            .map((a) => a.trim().toLowerCase().replace(/^@/, '')),
    )];
    if (!wanted.length) return out;

    // Not configured. Deliberately quiet at debug level rather than a warning on
    // every settlement: an operator who has not set this up has not broken
    // anything, they just are not paying referrers yet.
    if (!BUTRAUTH_CLIENT_ID || !BUTRAUTH_CLIENT_SECRET) return out;

    for (let i = 0; i < wanted.length; i += BATCH) {
        const chunk = wanted.slice(i, i + BATCH);
        try {
            const res = await fetch(`${BUTRAUTH_URL}/api/referral/lookup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: BUTRAUTH_CLIENT_ID,
                    client_secret: BUTRAUTH_CLIENT_SECRET,
                    usernames: chunk,
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !Array.isArray(data.results)) {
                console.warn(`[adReferrals] lookup failed (${res.status}) — `
                    + `${chunk.length} advertiser(s) treated as unreferred this period`);
                continue;
            }
            for (const r of data.results) {
                const who = String(r?.referredBy || '').trim().toLowerCase();
                const acct = String(r?.username || '').trim().toLowerCase();
                // A self-referral should already be impossible (Butter Auth
                // refuses one at write time), but it is checked again here
                // because this is the side that spends money on the answer.
                if (acct && who && who !== acct) out.set(acct, who);
            }
        } catch (err) {
            console.warn(`[adReferrals] lookup error: ${err.message} — `
                + `${chunk.length} advertiser(s) treated as unreferred this period`);
        }
    }
    return out;
}

module.exports = { referrersFor };
