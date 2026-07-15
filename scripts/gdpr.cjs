#!/usr/bin/env node
/**
 * Fulfil GDPR data-subject requests (CLI). Thin wrapper over utils/gdprAdmin.js —
 * the same logic the secret-gated /gdpr-admin HTTP endpoints use, so the two can't
 * drift.
 *
 *   node scripts/gdpr.cjs list [all]           # requests (open, or 'all')
 *   node scripts/gdpr.cjs export <username>    # everything we hold, as JSON (Art. 15)
 *   node scripts/gdpr.cjs delete <username>    # purge our copies (Art. 17)  [--dry-run]
 *   node scripts/gdpr.cjs close <ref>          # mark a request done
 *
 * DELETE is REAL unless you pass --dry-run. It purges hot storage + suppression-lists
 * the account (so the indexer won't re-add it), and CANNOT touch the Hive blockchain.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const gdpr = require('../utils/gdprAdmin');

const DRY = process.argv.includes('--dry-run');
const [, , cmd, arg] = process.argv;

async function withDb(fn) {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    return await fn(client.db(process.env.DATABASE_NAME || process.env.MONGODB_DB || 'threespeak'));
  } finally {
    await client.close();
  }
}

withDb(async (db) => {
  if (cmd === 'list') {
    const rows = await gdpr.listRequests(db, { status: arg === 'all' ? 'all' : 'open' });
    if (!rows.length) return console.log('No requests.');
    for (const r of rows) {
      const flag = r.daysLeft != null && r.daysLeft < 7 ? '  <-- DUE SOON' : '';
      console.log(`${r.ref}  ${String(r.type).padEnd(6)}  @${String(r.username).padEnd(16)}  ${String(r.contact).padEnd(28)}  ${r.status}  due in ${r.daysLeft}d${flag}`);
      if (!r.notified) console.log('        (not yet announced by the Discord bot)');
    }
    return undefined;
  }
  if (cmd === 'export' && arg) {
    console.log(JSON.stringify(await gdpr.exportUser(db, arg), null, 2));
    return undefined;
  }
  if (cmd === 'delete' && arg) {
    const res = await gdpr.deleteUser(db, arg, { dryRun: DRY });
    console.log(DRY ? `=== DRY RUN — @${res.username} ===` : `=== PURGED @${res.username} ===`);
    for (const [coll, n] of Object.entries(res.breakdown)) {
      console.log(`  ${coll.padEnd(22)} ${String(n).padStart(6)} row(s) ${DRY ? 'would be' : ''} deleted`);
    }
    console.log(`\n  ${res.total} row(s) ${DRY ? 'would be' : ''} purged. Suppression-listed: ${res.suppressed}`);
    console.log(`  ${res.note}`);
    return undefined;
  }
  if (cmd === 'close' && arg) {
    const res = await gdpr.closeRequest(db, arg);
    console.log(res.closed ? `Closed ${res.ref}.` : `No request with ref ${res.ref}.`);
    return undefined;
  }
  console.log('usage: gdpr.cjs list [all] | export <user> | delete <user> [--dry-run] | close <ref>');
  return undefined;
}).catch((e) => { console.error(e); process.exit(1); });
