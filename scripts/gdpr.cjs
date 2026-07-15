#!/usr/bin/env node
/**
 * Fulfil GDPR data-subject requests.
 *
 *   node scripts/gdpr.cjs list                 # open requests, soonest deadline first
 *   node scripts/gdpr.cjs export <username>    # everything we hold, as JSON (Art. 15)
 *   node scripts/gdpr.cjs delete <username>    # purge our copies (Art. 17)  [--dry-run]
 *   node scripts/gdpr.cjs close <ref>          # mark a request done
 *
 * WHAT DELETE ACTUALLY DOES — and the part everyone gets wrong:
 *
 *   It purges our hot storage AND writes the account to a suppression list. Without
 *   the suppression list the indexer happily re-pulls the same account from Hive on
 *   the next sync and undoes the whole thing. The suppression list is keyed on the
 *   Hive account name only — no personal data — precisely so it can survive the
 *   deletion it is enforcing.
 *
 *   It CANNOT delete from the Hive blockchain. Posts, comments, votes and
 *   viewer-tags were signed and broadcast by the user's own keys to a public,
 *   immutable ledger. We are a front-end reading that ledger. Removing our cached,
 *   indexed, searchable copy is a real remedy — we stop amplifying the data — but
 *   it is not erasure of the chain, and the reply to the user must say so plainly.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const DRY = process.argv.includes('--dry-run');
const [, , cmd, arg] = process.argv;

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

async function withDb(fn) {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    return await fn(client.db(process.env.DATABASE_NAME || process.env.MONGODB_DB || 'threespeak'));
  } finally {
    await client.close();
  }
}

const listRequests = (db) => db.collection('gdpr-requests')
  .find({ status: 'open' }).sort({ dueAt: 1 }).toArray()
  .then((rows) => {
    if (!rows.length) return console.log('No open requests.');
    for (const r of rows) {
      const daysLeft = Math.ceil((r.dueAt - Date.now()) / 86400000);
      const flag = daysLeft < 7 ? '  <-- DUE SOON' : '';
      console.log(`${r.ref}  ${r.type.padEnd(6)}  @${r.username.padEnd(16)}  ${r.contact.padEnd(28)}  due in ${daysLeft}d${flag}`);
      if (!r.notified) console.log('        (not yet announced by the Discord bot)');
    }
  });

async function exportUser(db, username) {
  const out = { account: username, exportedAt: new Date().toISOString(), data: {} };
  for (const { coll, field } of OWNED) {
    const rows = await db.collection(coll).find({ [field]: username }).toArray();
    if (rows.length) out.data[coll] = rows;
  }
  const wh = await db.collection(WATCH_HISTORY).find({ _id: { $regex: `^${username}:` } }).toArray();
  if (wh.length) out.data[WATCH_HISTORY] = wh;

  out.note = [
    'This is everything 3Speak holds in its own database for this account.',
    'Your posts, comments, votes and viewer-tags also exist on the Hive blockchain,',
    'which is public and outside our control — you published them there with your own',
    'keys. You can read them directly from any Hive API node, e.g.',
    `https://api.hive.blog  (account: ${username})`,
    'We cannot delete blockchain records, and neither can anyone else.',
  ].join(' ');

  console.log(JSON.stringify(out, null, 2));
}

async function deleteUser(db, username) {
  console.log(DRY ? `=== DRY RUN — deleting nothing for @${username} ===` : `=== PURGING @${username} ===`);
  let total = 0;
  for (const { coll, field } of OWNED) {
    const n = await db.collection(coll).countDocuments({ [field]: username });
    if (!n) continue;
    total += n;
    if (!DRY) await db.collection(coll).deleteMany({ [field]: username });
    console.log(`  ${coll.padEnd(22)} ${String(n).padStart(6)} row(s) ${DRY ? 'would be' : ''} deleted`);
  }
  const whN = await db.collection(WATCH_HISTORY).countDocuments({ _id: { $regex: `^${username}:` } });
  if (whN) {
    total += whN;
    if (!DRY) await db.collection(WATCH_HISTORY).deleteMany({ _id: { $regex: `^${username}:` } });
    console.log(`  ${WATCH_HISTORY.padEnd(22)} ${String(whN).padStart(6)} row(s) ${DRY ? 'would be' : ''} deleted`);
  }

  // THE STEP EVERYONE FORGETS. Without this the next indexer sync re-pulls this
  // account straight back out of Hive and silently undoes the deletion above.
  if (!DRY) {
    await db.collection(SUPPRESSION).updateOne(
      { _id: username },
      { $set: { suppressedAt: new Date() } },
      { upsert: true },
    );
  }
  console.log(`\n  ${total} row(s) ${DRY ? 'would be' : ''} purged.`);
  console.log(`  @${username} ${DRY ? 'would be' : 'is'} on the suppression list (${SUPPRESSION}) — the indexer must not re-add it.`);
  console.log('\n  NOT deleted (and cannot be): this account\'s posts, comments, votes and');
  console.log('  viewer-tags on the Hive blockchain. Say so, in writing, in your reply.');
}

const closeRequest = (db, ref) => db.collection('gdpr-requests')
  .updateOne({ ref }, { $set: { status: 'done', closedAt: new Date() } })
  .then((r) => console.log(r.matchedCount ? `Closed ${ref}.` : `No request with ref ${ref}.`));

withDb(async (db) => {
  if (cmd === 'list') return listRequests(db);
  if (cmd === 'export' && arg) return exportUser(db, arg.toLowerCase().replace(/^@/, ''));
  if (cmd === 'delete' && arg) return deleteUser(db, arg.toLowerCase().replace(/^@/, ''));
  if (cmd === 'close' && arg) return closeRequest(db, arg);
  console.log('usage: gdpr.cjs list | export <user> | delete <user> [--dry-run] | close <ref>');
}).catch((e) => { console.error(e); process.exit(1); });
