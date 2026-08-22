const dhive = require('@hiveio/dhive');
const {
    HIVE_AUTH_REQUIRED,
    HIVE_RPC_ENDPOINTS,
    SIGNATURE_TIMESTAMP_TOLERANCE_MS,
} = require('./config');

const client = new dhive.Client(HIVE_RPC_ENDPOINTS);

// 60s in-memory cache of (username -> posting public-key strings).
// Hive accounts rarely rotate keys, but a short TTL keeps us correct
// without hammering the RPCs on every request.
const KEY_CACHE_TTL_MS = 60 * 1000;
const keyCache = new Map();

async function getPostingPublicKeys(username) {
    const cached = keyCache.get(username);
    if (cached && Date.now() - cached.t < KEY_CACHE_TTL_MS) {
        return cached.keys;
    }
    const accounts = await client.database.getAccounts([username]);
    const account = accounts && accounts[0];
    if (!account) {
        const err = new Error('Hive account not found');
        err.code = 'HIVE_ACCOUNT_NOT_FOUND';
        throw err;
    }
    const keys = (account.posting && account.posting.key_auths || []).map(([k]) => k);
    keyCache.set(username, { keys, t: Date.now() });
    return keys;
}

// Recover the signing key from the signature, then check it's listed in the
// account's posting authorities. Recovery is single-shot — much cheaper than
// trying every authorized key with PublicKey.verify.
async function verifyHiveSignedMessage({ message, signature, username }) {
    const sig = dhive.Signature.fromString(signature);
    const messageHash = dhive.cryptoUtils.sha256(Buffer.from(message, 'utf8'));
    const recovered = sig.recover(messageHash).toString();
    const authorized = await getPostingPublicKeys(username);
    return authorized.includes(recovered);
}

/**
 * Every public key that may legitimately sign FOR `username` under posting authority.
 *
 * Posting authority on Hive is not just your own keys — `posting.account_auths`
 * lists accounts you have granted the same authority to. On 3Speak most people have
 * granted it to @threespeak; that grant is how HiveSigner and Butter Auth logins
 * publish at all, because those sessions hold no signing key in the browser.
 *
 * So a preference those users must be able to set — turning ads off on their own
 * videos, say — cannot demand a client-side signature. Requiring one would lock the
 * people least able to produce it out of a control that is theirs by right. Reading
 * the delegates is not a loosening of the check: it is asking Hive the question the
 * chain already answers, "who may act with posting authority for this account".
 *
 * Returns [{ account, keys }] — the account itself first, then each delegate that
 * meets the weight threshold on its own.
 */
async function getPostingAuthoritySigners(username) {
  const accounts = await client.database.getAccounts([username]);
  const account = accounts && accounts[0];
  if (!account) {
    const err = new Error('Hive account not found');
    err.code = 'HIVE_ACCOUNT_NOT_FOUND';
    throw err;
  }
  const posting = account.posting || {};
  const threshold = posting.weight_threshold || 1;
  const signers = [{ account: username, keys: (posting.key_auths || []).map(([k]) => k) }];

  // Only grants that clear the threshold ALONE count. A partial weight needs a
  // co-signature to authorise anything, and one signature is all we ever see here.
  const delegates = (posting.account_auths || [])
    .filter(([, weight]) => weight >= threshold)
    .map(([acc]) => acc)
    .filter((acc) => acc !== username);   // an account can auth itself; it is already first

  for (const delegate of delegates) {
    try {
      signers.push({ account: delegate, keys: await getPostingPublicKeys(delegate) });
    } catch (_) {
      // A delegate we cannot read is simply not usable as a signer this time.
    }
  }
  return signers;
}

/**
 * Like verifyHiveSignedMessage, but also accepts a signature from an account the
 * user has granted posting authority to. Returns { ok, signer } so the caller can
 * record WHO signed — "@threespeak on their behalf" is a materially different
 * audit trail from "the account holder themselves", and worth keeping.
 *
 * CALLER'S OBLIGATION: this answers only "may this key act for `username`?" — it
 * cannot answer "is this message about `username`?", because it does not know your
 * message format. A delegate like @threespeak holds authority over MANY accounts,
 * so a signature it produced for account A verifies just as well when asked about
 * account B. Build the message yourself from the same `username` you pass here and
 * never accept a caller-supplied message, or one user's signature will authorise a
 * change to another's record. routes/advertise.js does this via prefsMessage(name).
 */
async function verifyHiveAuthority({ message, signature, username, allowedDelegates = null }) {
  const sig = dhive.Signature.fromString(signature);
  const messageHash = dhive.cryptoUtils.sha256(Buffer.from(message, 'utf8'));
  const recovered = sig.recover(messageHash).toString();

  const signers = await getPostingAuthoritySigners(username);

  // `allowedDelegates` narrows the delegate set to the accounts WE actually sign
  // with. Every real creator here has granted posting authority to peakd.app,
  // ecency.app, steemauto and others too, and under plain Hive semantics any of
  // them could set this preference. That is true but not useful: only @threespeak
  // ever signs on a user's behalf in our flows, so admitting the rest widens the
  // blast radius of a third-party compromise for no gain. Pass null to keep the
  // full Hive-native behaviour.
  const usable = allowedDelegates
    ? signers.filter((s, i) => i === 0 || allowedDelegates.includes(s.account))
    : signers;

  const hit = usable.find((s) => s.keys.includes(recovered));
  return hit ? { ok: true, signer: hit.account } : { ok: false, signer: null };
}

// Build the canonical message-to-sign for a request. Bound to the action,
// the hive_username, the specific link triplet, and a timestamp so a captured
// signature can't be replayed for a different action/user/channel/time.
function buildMessage({ action, hive_username, platform, platform_username, timestamp }) {
    return [
        '3speak-social-verifier',
        action,
        String(hive_username || '').toLowerCase(),
        String(platform || ''),
        String(platform_username || ''),
        String(timestamp),
    ].join('|');
}

// Express middleware factory. `action` is "check" or "unlink" — used in
// the signed message so a check-signature can't be replayed against unlink.
function requireHiveSignature(action) {
    return async function (req, res, next) {
        if (!HIVE_AUTH_REQUIRED) return next();

        const hive_username = String(req.query.hive_username || '').trim();
        const platform = String(req.query.platform || '').trim();
        const platform_username = String(req.query.platform_username || '').trim();
        const signature = String(req.query.signature || req.headers['x-hive-signature'] || '').trim();
        const tsRaw = String(req.query.timestamp || req.headers['x-hive-timestamp'] || '').trim();

        if (!hive_username || !platform || !platform_username) {
            return res.status(400).json({ error: 'hive_username, platform, and platform_username are required' });
        }
        if (!signature || !tsRaw) {
            return res.status(401).json({
                error: 'Missing signature or timestamp',
                expected_message: buildMessage({ action, hive_username, platform, platform_username, timestamp: '<ms>' }),
            });
        }

        const timestamp = parseInt(tsRaw, 10);
        if (!Number.isFinite(timestamp)) {
            return res.status(401).json({ error: 'Invalid timestamp' });
        }
        if (Math.abs(Date.now() - timestamp) > SIGNATURE_TIMESTAMP_TOLERANCE_MS) {
            return res.status(401).json({ error: 'Timestamp out of tolerance window' });
        }

        const message = buildMessage({ action, hive_username, platform, platform_username, timestamp });
        try {
            const ok = await verifyHiveSignedMessage({ message, signature, username: hive_username });
            if (!ok) return res.status(401).json({ error: 'Invalid signature' });
            return next();
        } catch (err) {
            if (err.code === 'HIVE_ACCOUNT_NOT_FOUND') {
                return res.status(404).json({ error: 'Hive account not found' });
            }
            // Most other errors here are signature parse errors (malformed hex,
            // wrong length, etc.) — treat as bad input, not a server fault.
            console.error('hive auth signature parse/recover error:', err.message || err);
            return res.status(401).json({ error: 'Invalid signature' });
        }
    };
}

module.exports = {
  requireHiveSignature, buildMessage, verifyHiveSignedMessage,
  verifyHiveAuthority, getPostingAuthoritySigners,
};
