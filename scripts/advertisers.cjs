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
 *   node scripts/advertisers.cjs rates                    # platform rate card
 *   node scripts/advertisers.cjs set-rate <format> <hbd>  # change one default price
 *   node scripts/advertisers.cjs reset-rate <format>      # back to the built-in default
 *   node scripts/advertisers.cjs below-rate               # advertisers still on an old price list
 *   node scripts/advertisers.cjs set-advertiser-rate   <reference> <format> <hbd>
 *   node scripts/advertisers.cjs reset-advertiser-rate <reference> <format> | all
 *   node scripts/advertisers.cjs resnapshot-advertiser <reference>   # end their discount
 *   node scripts/advertisers.cjs refunds                  # money owed back
 *   node scripts/advertisers.cjs refund-sent <trx> <return-trx>
 *   node scripts/advertisers.cjs spots                    # spots waiting to be watched
 *   node scripts/advertisers.cjs spot <embedId>           # one spot, with a watch link
 *   node scripts/advertisers.cjs approve-spot <embedId> [--note "..."]
 *   node scripts/advertisers.cjs reject-spot  <embedId> [--note "..."]
 *
 * Approving a spot is the ONLY way a creative reaches `ready`, and nothing serves
 * until it does. Watch it first — this is the last check before it runs in front of
 * other people's audiences.
 *
 * RATES. An advertiser is given a COPY of the price list when they register, so
 * raising the platform rate moves new signups and leaves existing ones alone.
 * `below-rate` finds the ones that have fallen behind; `reset-advertiser-rate` puts
 * one back on current prices and keeps them tracking them, while
 * `resnapshot-advertiser` freezes them at today's prices instead.
 *
 * REFUNDS. A transfer only counts if it came from the account the campaign is booked
 * under — that is how an advertiser proves the account is theirs, since registering
 * is unsigned. Anything else is refused and sent straight back on the next payout
 * run. `refunds` shows the queue; `refunds review` shows the ones that got stuck and
 * need a person, and `refund-sent` records a return you made by hand.
 *
 * ⚠️ Do NOT confuse this with an under-delivery shortfall, which is the opposite:
 * that money is KEPT as credit toward the advertiser's next campaign (`below-rate`
 * is unrelated; see utils/adBalance.js). Refused payment → returned. Short
 * delivery → credited.
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
const SETTINGS = process.env.AD_SETTINGS_COLLECTION || 'ad_settings';
const PAYMENTS = process.env.AD_PAYMENTS_COLLECTION || 'ad_payments';

// Pulled in for the format table and the one definition of a valid rate. Both are
// pure — neither touches a database at require time — so this stays a script with
// its own connection rather than booting the checker's db layer to read a price.
const { FORMATS, FORMAT_KEYS } = require('../utils/adFormats');
const adSettings = require('../utils/adSettings');

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

    // Asked on the application form now, not only at booking. Worth surfacing here:
    // "they have no video and want us to make one" changes what approving them means.
    if (a.production && a.production.requested) {
      console.log(`\n  ⚑ WANTS US TO MAKE THE SPOT — brief:\n    ${String(a.production.brief || '').replace(/\n/g, '\n    ')}`);
    }

    // Spots can be attached while the application is still pending, so the reviewer
    // can watch what would actually run before deciding on the advertiser.
    const spots = await db.collection(CREATIVES)
      .find({ advertiserRef: a.reference }).sort({ createdAt: 1 }).toArray();
    if (spots.length) {
      console.log(`\n  attached before review (${spots.length}):`);
      spots.forEach((c) => {
        const what = c.kind === 'image'
          ? `image  ${c.imageUrl}`
          : `video  ${c.durationSeconds || '?'}s  ${c.manifestUrl ? 'encoded' : 'still encoding'}`;
        console.log(`    ${pad(c.status, 10)} ${what}`);
        if (c.kind !== 'image' && c.owner && c.permlink) {
          console.log(`               watch: https://3speak.tv/embed/${c.owner}/${c.permlink}`);
          console.log(`               approve-spot ${c.embedId}`);
        }
      });
    } else {
      console.log('\n  attached before review: nothing yet');
    }

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

  if (cmd === 'rates') {
    const doc = await db.collection(SETTINGS).findOne({ _id: adSettings.RATES_ID });
    const stored = (doc && doc.formats) || {};
    console.log(`${pad('FORMAT', 16)} ${pad('RATE', 12)} ${pad('BUILT-IN', 12)} SOURCE`);
    console.log('-'.repeat(58));
    FORMAT_KEYS.forEach((key) => {
      const f = FORMATS[key];
      const has = Object.prototype.hasOwnProperty.call(stored, key);
      const rate = has && adSettings.validRate(stored[key]) ? Number(stored[key]) : f.ratePerSecondDayHbd;
      console.log(`${pad(key, 16)} ${pad(rate, 12)} ${pad(f.ratePerSecondDayHbd, 12)} ${has ? 'database' : 'built-in'}`);
    });
    console.log('\nHBD per second of spot, per day of flight. A 10s spot for 7 days at 1.5 = 105 HBD.');
    if (doc && doc.updatedAt) console.log(`Last changed ${new Date(doc.updatedAt).toISOString()}${doc.updatedBy ? ` by ${doc.updatedBy}` : ''}.`);
    console.log('set-rate <format> <hbd>   to change one · reset-rate <format>   to go back to the built-in');
    return;
  }

  // Money that arrived from the wrong account and is owed back. A transfer only
  // counts if it came from the account the campaign is booked under — that is how
  // an advertiser proves the account is theirs, since registration is unsigned.
  if (cmd === 'refunds') {
    const wanted = arg || 'pending';
    const rows = await db.collection(PAYMENTS)
      .find({ status: 'refused', refundStatus: wanted }).sort({ processedAt: 1 }).limit(200).toArray();
    if (!rows.length) { console.log(wanted === 'pending' ? 'Nothing owed back.' : `No ${wanted} refunds.`); return; }

    console.log(`${pad('RECEIVED', 12)} ${pad('FROM', 18)} ${pad('AMOUNT', 14)} ${pad('BOOKED AS', 18)} TRX`);
    console.log('-'.repeat(90));
    rows.forEach((p) => console.log(
      `${pad(date(p.processedAt), 12)} ${pad('@' + (p.refundTo || p.from), 18)} `
      + `${pad(p.refundAmount || p.amount, 14)} ${pad('@' + (p.expectedFrom || '?'), 18)} ${p.trx_id}`,
    ));
    console.log(`\n${rows.length} in "${wanted}".`);
    if (wanted === 'pending') {
      console.log('These go back on their own with the next payout run — nothing to do.');
    } else if (wanted === 'review') {
      console.log('These are STUCK and need you: check the chain for a transfer that already went out');
      console.log(`from @${process.env.AD_PAYMENT_ACCOUNT || 'the ad payment account'} before sending anything, then record it:`);
      console.log('  refund-sent <trx> <the-return-trx>');
    }
    console.log('\nStatuses: pending (queued) · sending (in flight) · returned (done) · review (needs you)');
    return;
  }

  if (cmd === 'refund-sent') {
    const [, trx, returnTrx] = argv;
    if (!trx || !returnTrx) {
      console.error('Usage: refund-sent <original-trx-id> <return-trx-id>\nBoth are required — a refund nobody can point at on-chain is not a receipt.');
      process.exitCode = 1;
      return;
    }
    const coll = db.collection(PAYMENTS);
    const existing = await coll.findOne({ trx_id: trx });
    if (!existing) { console.error(`No payment with trx ${trx}`); process.exitCode = 1; return; }
    if (existing.refundStatus === 'returned') {
      console.error(`Already returned on ${existing.returnedAt} as ${existing.returnedTrxId}. Do NOT send it again.`);
      process.exitCode = 1;
      return;
    }
    await coll.updateOne({ trx_id: trx }, { $set: {
      refundStatus: 'returned', returnedTrxId: returnTrx,
      returnedBy: process.env.USER || 'cli', returnedAt: new Date(),
    } });
    console.log(`${existing.refundAmount || existing.amount} returned to @${existing.refundTo || existing.from} — recorded as ${returnTrx}.`);
    return;
  }

  // Who is still paying less than a new advertiser would. This is the working list
  // for "the founding discount has run its year, put them on current prices".
  if (cmd === 'below-rate') {
    const advs = await db.collection(ADVERTISERS).find({}).sort({ createdAt: 1 }).limit(500).toArray();
    const platform = {};
    const settings = await db.collection(SETTINGS).findOne({ _id: adSettings.RATES_ID });
    const storedPlatform = (settings && settings.formats) || {};
    FORMAT_KEYS.forEach((k) => {
      platform[k] = adSettings.validRate(storedPlatform[k])
        ? Number(storedPlatform[k]) : FORMATS[k].ratePerSecondDayHbd;
    });

    const rows = advs.filter((a) => FORMAT_KEYS.some((k) => {
      const own = a.rates && a.rates[k];
      return adSettings.validRate(own) && Number(own) < platform[k];
    }));
    if (!rows.length) { console.log('Every advertiser is on current platform rates.'); return; }

    console.log(`${pad('ADVERTISER', 18)} ${pad('REFERENCE', 14)} ${pad('SIGNED UP', 12)} RATES vs PLATFORM`);
    console.log('-'.repeat(84));
    rows.forEach((a) => {
      const diffs = FORMAT_KEYS
        .filter((k) => adSettings.validRate(a.rates && a.rates[k]) && Number(a.rates[k]) < platform[k])
        .map((k) => `${k} ${a.rates[k]} < ${platform[k]}`);
      console.log(`${pad('@' + a.hiveAccount, 18)} ${pad(a.reference, 14)} ${pad(date(a.createdAt), 12)} ${diffs.join(' · ')}`);
    });
    console.log(`\n${rows.length} advertiser(s) below platform rates.`);
    console.log('set-advertiser-rate <reference> <format> <hbd>   ·   reset-advertiser-rate <reference> <format>');
    return;
  }

  // End one advertiser's founding discount: re-freeze them at today's platform rates,
  // every format at once. They then hold THOSE until somebody moves them again — the
  // same arrangement they had, at the new number. This is the whole "after a year" job.
  if (cmd === 'resnapshot-advertiser') {
    if (!arg) { console.error('Usage: resnapshot-advertiser <reference>'); process.exitCode = 1; return; }
    const coll = db.collection(ADVERTISERS);
    const a = await coll.findOne({ reference: arg });
    if (!a) { console.error(`No advertiser with reference ${arg}`); process.exitCode = 1; return; }

    const settings = await db.collection(SETTINGS).findOne({ _id: adSettings.RATES_ID });
    const storedPlatform = (settings && settings.formats) || {};
    const next = {};
    FORMAT_KEYS.forEach((k) => {
      next[k] = adSettings.validRate(storedPlatform[k])
        ? Number(storedPlatform[k]) : FORMATS[k].ratePerSecondDayHbd;
    });

    console.log(`@${a.hiveAccount} (${a.projectName || 'no project name'})`);
    FORMAT_KEYS.forEach((k) => {
      const own = a.rates && a.rates[k];
      const before = adSettings.validRate(own) ? Number(own) : next[k];
      console.log(`  ${pad(k, 15)} ${before} -> ${next[k]}${before === next[k] ? '  (unchanged)' : ''}`);
    });

    await coll.updateOne({ reference: arg }, {
      $set: { rates: next, ratesSource: 'admin', ratesSetAt: new Date(), updatedAt: new Date() },
    });
    console.log('\nFrozen at today\'s platform rates. They keep these until you move them again.');
    console.log('Applies to their NEXT booking; campaigns already booked keep the price they were quoted.');
    return;
  }

  // Move ONE advertiser onto a different rate. reset- drops them onto the platform
  // rate and keeps them tracking it, which storing a copy of today's number would not.
  // Pass `all` as the format to clear every one of them.
  if (cmd === 'set-advertiser-rate' || cmd === 'reset-advertiser-rate') {
    const clearing = cmd === 'reset-advertiser-rate';
    const [, ref, fmt] = argv;
    const value = argv[3];

    if (clearing && ref && fmt === 'all') {
      const coll = db.collection(ADVERTISERS);
      const a = await coll.findOne({ reference: ref });
      if (!a) { console.error(`No advertiser with reference ${ref}`); process.exitCode = 1; return; }
      await coll.updateOne({ reference: ref }, {
        $unset: Object.fromEntries(FORMAT_KEYS.map((k) => [`rates.${k}`, ''])),
        $set: { ratesSource: 'admin', ratesSetAt: new Date(), updatedAt: new Date() },
      });
      console.log(`@${a.hiveAccount}: all own rates cleared — now tracking the platform rate for every format.`);
      return;
    }

    if (!ref || !FORMAT_KEYS.includes(fmt)) {
      console.error(`Usage: ${cmd} <reference> <format>${clearing ? ' | all' : ' <hbd>'}\nFormats: ${FORMAT_KEYS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    if (!clearing && !adSettings.validRate(value)) {
      console.error(`Rate must be a number greater than 0 and at most ${adSettings.MAX_RATE}.`);
      process.exitCode = 1;
      return;
    }
    const coll = db.collection(ADVERTISERS);
    const a = await coll.findOne({ reference: ref });
    if (!a) { console.error(`No advertiser with reference ${ref}`); process.exitCode = 1; return; }

    const settings = await db.collection(SETTINGS).findOne({ _id: adSettings.RATES_ID });
    const storedPlatform = (settings && settings.formats) || {};
    const platformRate = adSettings.validRate(storedPlatform[fmt])
      ? Number(storedPlatform[fmt]) : FORMATS[fmt].ratePerSecondDayHbd;
    const own = a.rates && a.rates[fmt];
    const before = adSettings.validRate(own) ? Number(own) : platformRate;

    await coll.updateOne({ reference: ref }, clearing
      ? { $unset: { [`rates.${fmt}`]: '' }, $set: { ratesSource: 'admin', ratesSetAt: new Date(), updatedAt: new Date() } }
      : { $set: { [`rates.${fmt}`]: Number(value), ratesSource: 'admin', ratesSetAt: new Date(), updatedAt: new Date() } });

    const after = clearing ? platformRate : Number(value);
    console.log(`@${a.hiveAccount} ${fmt}: ${before} -> ${after} HBD/s/day${clearing ? ' (now tracking the platform rate)' : ''}`);
    console.log('Applies to their NEXT booking. Campaigns already booked keep the price they were quoted.');
    return;
  }

  // Changing a price does NOT reprice anything already booked: a campaign stores
  // its rate and its total when it is created, and the payment claim settles
  // against those. This is the price of the NEXT booking.
  if (cmd === 'set-rate' || cmd === 'reset-rate') {
    const clearing = cmd === 'reset-rate';
    if (!arg || !FORMAT_KEYS.includes(arg)) {
      console.error(`Usage: ${cmd} <format>${clearing ? '' : ' <hbd-per-second-per-day>'}\nFormats: ${FORMAT_KEYS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const value = argv[2];
    if (!clearing && !adSettings.validRate(value)) {
      console.error(`Rate must be a number greater than 0 and at most ${adSettings.MAX_RATE}.`);
      process.exitCode = 1;
      return;
    }
    const doc = await db.collection(SETTINGS).findOne({ _id: adSettings.RATES_ID });
    const storedBefore = (doc && doc.formats) || {};
    const hadBefore = Object.prototype.hasOwnProperty.call(storedBefore, arg);
    const before = hadBefore && adSettings.validRate(storedBefore[arg])
      ? Number(storedBefore[arg]) : FORMATS[arg].ratePerSecondDayHbd;

    const who = flag('--by') || process.env.USER || null;
    await db.collection(SETTINGS).updateOne(
      { _id: adSettings.RATES_ID },
      clearing
        ? { $unset: { [`formats.${arg}`]: '' }, $set: { updatedAt: new Date(), updatedBy: who } }
        : { $set: { [`formats.${arg}`]: Number(value), updatedAt: new Date(), updatedBy: who } },
      { upsert: true },
    );
    const after = clearing ? FORMATS[arg].ratePerSecondDayHbd : Number(value);
    console.log(`${arg}: ${before} -> ${after} HBD/s/day${clearing ? ' (back to the built-in default)' : ''}`);
    // The running checker caches this document; it re-reads on a one-minute timer,
    // so a quote taken in the next few seconds may still show the old price.
    console.log('The live checker picks this up within a minute. No restart needed.');
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
