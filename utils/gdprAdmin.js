/**
 * Core GDPR fulfilment logic, shared by the CLI (scripts/gdpr.cjs) and the
 * secret-gated admin HTTP endpoints (routes/gdprAdmin.js). Every function takes a
 * live `db` and RETURNS data (no console output) so both callers behave identically
 * — the CLI just formats what these return.
 *
 * WHAT DELETE ACTUALLY DOES: it purges our hot storage AND writes the account to a
 * suppression list (keyed on the Hive name only — no personal data — so it survives
 * the deletion it enforces). Without the suppression entry the indexer re-pulls the
 * account from Hive on the next sync and silently undoes everything. It does NOT and
 * cannot delete from the Hive blockchain — that is public, immutable, and published
 * by the user's own keys; the reply to the user must say so.
 */

// Collections keyed to a Hive account. `field` is the column holding the username.
// Keep in sync with DATA_SCOPE in routes/gdpr.js.
const OWNED = [
  { coll: 'videos', field: 'owner' },
  { coll: 'embed-video', field: 'owner' },
  { coll: 'embed-audio', field: 'owner' },
  { coll: 'playlists', field: 'owner' },
  { coll: 'reshares', field: 'username' },
  { coll: 'viewer-tags', field: 'voter' },
  { coll: 'user-hidden-videos', field: 'username' },
  { coll: 'user-hidden-creators', field: 'username' },
  { coll: 'podcastsettings', field: 'owner' },
  { coll: 'scheduled-posts', field: 'owner' },
  { coll: 'audio-listen-log', field: 'username' },
  { coll: 'hiveprofiles', field: 'username' },
  { coll: 'users', field: 'username' },
];
// watch_history keys by a compound _id "user:owner:permlink" — matched by prefix.
const WATCH_HISTORY = 'watch_history';
const SUPPRESSION = 'gdpr-suppressed';

const HIVE_RE = /^[a-z][a-z0-9.-]{1,15}$/;

// Escape regex metachars — a Hive name can contain '.' which would otherwise match
// any char in the watch_history _id prefix.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normUser = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

/** Data-subject requests. status: 'open' (default) | 'done' | 'all'. */
async function listRequests(db, { status = 'open' } = {}) {
  const q = status === 'all' ? {} : { status };
  const rows = await db.collection('gdpr-requests').find(q).sort({ dueAt: 1 }).toArray();
  return rows.map((r) => ({
    ...r,
    daysLeft: r.dueAt ? Math.ceil((new Date(r.dueAt).getTime() - Date.now()) / 86400000) : null,
  }));
}

/** Everything we hold for an account (Art. 15). Returns the export object. */
async function exportUser(db, usernameRaw) {
  const username = normUser(usernameRaw);
  const out = { account: username, exportedAt: new Date().toISOString(), data: {} };
  for (const { coll, field } of OWNED) {
    const rows = await db.collection(coll).find({ [field]: username }).toArray();
    if (rows.length) out.data[coll] = rows;
  }
  const wh = await db.collection(WATCH_HISTORY).find({ _id: { $regex: `^${esc(username)}:` } }).toArray();
  if (wh.length) out.data[WATCH_HISTORY] = wh;

  out.note = [
    'This is everything 3Speak holds in its own database for this account.',
    'Your posts, comments, votes and viewer-tags also exist on the Hive blockchain,',
    'which is public and outside our control — you published them there with your own',
    'keys. You can read them directly from any Hive API node, e.g.',
    `https://api.hive.blog  (account: ${username})`,
    'We cannot delete blockchain records, and neither can anyone else.',
  ].join(' ');
  return out;
}

/**
 * Purge our copies for an account (Art. 17) + suppression-list it. dryRun:true (the
 * default) counts without deleting. Returns a per-collection breakdown.
 */
async function deleteUser(db, usernameRaw, { dryRun = true } = {}) {
  const username = normUser(usernameRaw);
  const breakdown = {};
  let total = 0;

  for (const { coll, field } of OWNED) {
    const n = await db.collection(coll).countDocuments({ [field]: username });
    if (!n) continue;
    total += n;
    breakdown[coll] = n;
    if (!dryRun) await db.collection(coll).deleteMany({ [field]: username });
  }
  const whN = await db.collection(WATCH_HISTORY).countDocuments({ _id: { $regex: `^${esc(username)}:` } });
  if (whN) {
    total += whN;
    breakdown[WATCH_HISTORY] = whN;
    if (!dryRun) await db.collection(WATCH_HISTORY).deleteMany({ _id: { $regex: `^${esc(username)}:` } });
  }

  // The step everyone forgets — without this the next indexer sync re-adds the account.
  if (!dryRun) {
    await db.collection(SUPPRESSION).updateOne(
      { _id: username },
      { $set: { suppressedAt: new Date() } },
      { upsert: true },
    );
  }

  return {
    username,
    dryRun,
    total,
    breakdown,
    suppressed: !dryRun,
    note: 'Not deleted (and cannot be): this account\'s posts, comments, votes and viewer-tags on the Hive blockchain.',
  };
}

/** Mark a request fulfilled. */
async function closeRequest(db, ref) {
  const r = await db.collection('gdpr-requests').updateOne(
    { ref: String(ref) },
    { $set: { status: 'done', closedAt: new Date() } },
  );
  return { ref: String(ref), closed: r.matchedCount > 0 };
}

module.exports = { listRequests, exportUser, deleteUser, closeRequest, OWNED, HIVE_RE, normUser };
