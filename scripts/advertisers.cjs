#!/usr/bin/env node
/**
 * The advertiser approval queue (CLI) — the operator side of routes/advertise.js.
 *
 *   node scripts/advertisers.cjs queue                    # pending applications
 *   node scripts/advertisers.cjs list [approved|rejected|all]
 *   node scripts/advertisers.cjs show <reference>         # one application in full
 *   node scripts/advertisers.cjs approve <reference> [--note "shown to them"]
 *   node scripts/advertisers.cjs reject  <reference> [--note "shown to them"]
 *   node scripts/advertisers.cjs inventory                # current sellable forecast
 *   node scripts/advertisers.cjs spots                    # spots waiting to be watched
 *   node scripts/advertisers.cjs spot <embedId>           # one spot, with a watch link
 *   node scripts/advertisers.cjs approve-spot <embedId> [--note "..."]
 *   node scripts/advertisers.cjs reject-spot  <embedId> [--note "..."]
 *
 * Approving a spot is the ONLY way a creative reaches `ready`, and nothing serves
 * until it does. Watch it first — this is the last check before it runs in front of
 * other people's audiences.
 *
 * Why a CLI and not a page in the 3Speak app: the admin HTTP surface is gated by
 * AD_ADMIN_SECRET, which must never reach a browser. Every VITE_ variable is
 * inlined into the frontend bundle — that is exactly how API_SECRET_KEY became
 * public as VITE_CHECKER_API_KEY — so an in-app approval queue could only be
 * secured by a secret that is not secret. Same reasoning as scripts/gdpr.cjs.
 *
 * --note is shown TO THE APPLICANT. Use --internal for a reviewer-only note.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const ADVERTISERS = process.env.ADVERTISERS_COLLECTION || 'ad_advertisers';
const INVENTORY = process.env.AD_INVENTORY_COLLECTION || 'ad_inventory_snapshot';
const CREATIVES = process.env.AD_CREATIVES_COLLECTION || 'ad_creatives';

const argv = process.argv.slice(2);
const [cmd, arg] = argv;
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const pad = (v, n) => String(v == null ? '—' : v).padEnd(n);
const date = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

async function withDb(fn) {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    return await fn(client.db(process.env.DATABASE_NAME || 'threespeak'));
  } finally {
    await client.close();
  }
}

function printRow(a) {
  const verified = a.hiveVerified ? 'signed' : 'unsigned';
  console.log(
    `${pad(a.reference, 14)} ${pad('@' + a.hiveAccount, 18)} ${pad(a.projectName, 26)} `
    + `${pad(a.category, 15)} ${pad(a.budgetHbd != null ? a.budgetHbd + ' HBD' : '—', 12)} `
    + `${pad(verified, 9)} ${date(a.createdAt)}`,
  );
}

function printHeader() {
  console.log(
    `${pad('REFERENCE', 14)} ${pad('ACCOUNT', 18)} ${pad('PROJECT', 26)} `
    + `${pad('CATEGORY', 15)} ${pad('BUDGET', 12)} ${pad('OWNERSHIP', 9)} SUBMITTED`,
  );
  console.log('-'.repeat(112));
}

async function decide(db, reference, decision) {
  if (!reference) {
    console.error(`Usage: node scripts/advertisers.cjs ${decision === 'approved' ? 'approve' : 'reject'} <reference> [--note "..."]`);
    process.exitCode = 1;
    return;
  }
  const existing = await db.collection(ADVERTISERS).findOne({ reference });
  if (!existing) {
    console.error(`No application with reference ${reference}`);
    process.exitCode = 1;
    return;
  }
  if (existing.status === decision) {
    console.log(`Already ${decision}. Nothing to do.`);
    return;
  }
  await db.collection(ADVERTISERS).updateOne({ reference }, { $set: {
    status: decision,
    applicantNote: flag('--note') || existing.applicantNote || null,
    reviewerNote: flag('--internal') || existing.reviewerNote || null,
    reviewedBy: process.env.USER || 'cli',
    reviewedAt: new Date(),
    updatedAt: new Date(),
  } });
  console.log(`${existing.projectName} (@${existing.hiveAccount}) → ${decision}`);
  if (flag('--note')) console.log(`  they will see: "${flag('--note')}"`);
  else console.log('  no note left for the applicant (--note "…" adds one)');
}

withDb(async (db) => {
  if (!cmd || cmd === 'queue' || cmd === 'list') {
    const wanted = cmd === 'list' ? (arg || 'all') : 'pending';
    const query = wanted === 'all' ? {} : { status: wanted };
    const rows = await db.collection(ADVERTISERS).find(query).sort({ createdAt: -1 }).limit(200).toArray();
    if (!rows.length) {
      console.log(wanted === 'pending' ? 'Nothing waiting for review.' : `No ${wanted} applications.`);
      return;
    }
    printHeader();
    rows.forEach(printRow);
    console.log(`\n${rows.length} application(s). "show <reference>" for the full text.`);
    return;
  }

  if (cmd === 'show') {
    if (!arg) { console.error('Usage: node scripts/advertisers.cjs show <reference>'); process.exitCode = 1; return; }
    const a = await db.collection(ADVERTISERS).findOne({ reference: arg });
    if (!a) { console.error(`No application with reference ${arg}`); process.exitCode = 1; return; }
    console.log(`${a.projectName}  (@${a.hiveAccount})`);
    console.log(`  status      ${a.status}${a.reviewedAt ? ` by ${a.reviewedBy || '?'} on ${date(a.reviewedAt)}` : ''}`);
    console.log(`  ownership   ${a.hiveVerified ? 'signed — they proved they hold the account' : 'unsigned — account ownership NOT proven'}`);
    console.log(`  category    ${a.category}`);
    console.log(`  budget      ${a.budgetHbd != null ? `${a.budgetHbd} HBD` : 'not stated'}`);
    console.log(`  markets     ${a.markets && a.markets.length ? a.markets.join(', ') : 'everywhere'}`);
    console.log(`  website     ${a.website || '—'}`);
    console.log(`  contact     ${a.contact}`);
    console.log(`  submitted   ${date(a.createdAt)}`);
    console.log(`\n  what they want to run:\n    ${String(a.creativeConcept || '').replace(/\n/g, '\n    ')}`);
    if (a.applicantNote) console.log(`\n  note shown to them: ${a.applicantNote}`);
    if (a.reviewerNote) console.log(`  internal note:      ${a.reviewerNote}`);
    return;
  }

  if (cmd === 'approve') return decide(db, arg, 'approved');
  if (cmd === 'reject') return decide(db, arg, 'rejected');

  if (cmd === 'inventory') {
    const s = await db.collection(INVENTORY).findOne({ _id: 'current' });
    if (!s) { console.log('No forecast yet — the job runs a couple of minutes after the checker boots.'); return; }
    console.log(`Forecast from ${new Date(s.runAt).toISOString()} over the last ${s.windowDays} days\n`);
    console.log(`  raw          ${s.raw.sessions} sessions, ${s.raw.videos} videos, ${s.raw.watchHours}h`);
    console.log(`  sellable     ${s.sellable.sessions} sessions, ${s.sellable.videos} videos, ${s.sellable.watchHours}h`);
    console.log(`  removed      ${s.sellable.removedSessions} (${s.sellable.removedPct}%) as junk or opted-out`);
    console.log(`  per day      ${s.sellable.sessionsPerDay} (trailing 7 days)\n`);
    console.log('  SLOT           PLAYS/DAY   PLAYS/MONTH   REACH');
    s.slots.forEach((x) => console.log(
      `  ${pad(x.position === 0 ? 'pre-roll' : `${x.position}s in`, 14)} ${pad(x.perDay, 11)} ${pad(x.perMonth, 13)} ${x.reachPct}%`,
    ));
    if (s.excluded.suspectAccounts.length) {
      console.log('\n  excluded as non-human traffic:');
      s.excluded.suspectAccounts.forEach((x) => console.log(`    @${pad(x.owner, 20)} ${x.sessions} sessions, ${x.avgSeconds}s average`));
    }
    if (s.excluded.optedOutAccounts.length) {
      console.log(`\n  creators opted out: ${s.excluded.optedOutAccounts.map((o) => '@' + o).join(', ')}`);
    }
    return;
  }

  if (cmd === 'spots') {
    const wanted = arg || 'review';
    const rows = await db.collection(CREATIVES)
      .find(wanted === 'all' ? {} : { status: wanted }).sort({ createdAt: -1 }).limit(100).toArray();
    if (!rows.length) { console.log(wanted === 'review' ? 'No spots waiting to be watched.' : `No ${wanted} spots.`); return; }
    console.log(`${pad('EMBED ID', 14)} ${pad('ADVERTISER', 16)} ${pad('STATUS', 10)} ${pad('LENGTH', 8)} SUBMITTED`);
    console.log('-'.repeat(70));
    rows.forEach((c) => console.log(
      `${pad(c.embedId, 14)} ${pad(c.advertiserRef, 16)} ${pad(c.status, 10)} ${pad(c.durationSeconds ? c.durationSeconds + 's' : '—', 8)} ${date(c.createdAt)}`,
    ));
    console.log(`\n${rows.length} spot(s). "spot <embedId>" for the watch link.`);
    return;
  }

  if (cmd === 'spot') {
    if (!arg) { console.error('Usage: node scripts/advertisers.cjs spot <embedId>'); process.exitCode = 1; return; }
    const c = await db.collection(CREATIVES).findOne({ $or: [{ embedId: arg }, { permlink: arg }] });
    if (!c) { console.error(`No spot with id ${arg}`); process.exitCode = 1; return; }
    const advertiser = await db.collection(ADVERTISERS).findOne({ reference: c.advertiserRef });
    console.log(`spot ${c.embedId}`);
    console.log(`  advertiser  ${advertiser ? `${advertiser.projectName} (@${advertiser.hiveAccount})` : c.advertiserRef}`);
    console.log(`  status      ${c.status}${c.reviewedAt ? ` by ${c.reviewedBy || '?'} on ${date(c.reviewedAt)}` : ''}`);
    console.log(`  length      ${c.durationSeconds ? c.durationSeconds + 's' : 'not measured yet'}`);
    console.log(`  encoded     ${c.manifestUrl ? 'yes' : 'NOT YET — cannot be approved'}`);
    if (c.owner && c.permlink) console.log(`\n  WATCH IT:   https://3speak.tv/embed/${c.owner}/${c.permlink}`);
    if (c.reviewNote) console.log(`\n  note        ${c.reviewNote}`);
    return;
  }

  if (cmd === 'approve-spot' || cmd === 'reject-spot') {
    const approving = cmd === 'approve-spot';
    if (!arg) { console.error(`Usage: node scripts/advertisers.cjs ${cmd} <embedId> [--note "..."]`); process.exitCode = 1; return; }
    const coll = db.collection(CREATIVES);
    const c = await coll.findOne({ $or: [{ embedId: arg }, { permlink: arg }] });
    if (!c) { console.error(`No spot with id ${arg}`); process.exitCode = 1; return; }
    if (approving && !c.manifestUrl) {
      console.error('That spot has not finished encoding — there is nothing to play yet.');
      process.exitCode = 1;
      return;
    }
    await coll.updateOne({ _id: c._id }, { $set: {
      status: approving ? 'ready' : 'rejected',
      reviewNote: flag('--note') || c.reviewNote || null,
      reviewedBy: process.env.USER || 'cli',
      reviewedAt: new Date(),
      updatedAt: new Date(),
    } });
    console.log(`spot ${c.embedId} → ${approving ? 'ready (it can now run)' : 'rejected'}`);
    return;
  }

  console.error('Unknown command. Run with no arguments to see the pending queue.');
  process.exitCode = 1;
}).catch((err) => {
  console.error(err && err.message);
  process.exit(1);
});
