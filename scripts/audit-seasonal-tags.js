#!/usr/bin/env node
/**
 * Audit the holiday gate (utils/seasonal.js) against the real library.
 *
 * Prints, per holiday, how many videos it would gate and EVERY distinct tag token
 * that triggered it. Read that token list: it is the only way to catch a false
 * positive before it hides someone's video for eleven months. This is how the
 * 'tet' → tether/arteterapia/quartet bug (245 videos) was found.
 *
 * Read-only — touches nothing, writes nothing.
 *
 *   node scripts/audit-seasonal-tags.js              # all holidays
 *   node scripts/audit-seasonal-tags.js christmas    # just one
 *   node scripts/audit-seasonal-tags.js --calendar   # who's in season each month
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const S = require('../utils/seasonal');

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const calendarOnly = args.includes('--calendar');

function calendar() {
  console.log('In season, by date (mid-month sample):\n');
  for (let m = 1; m <= 12; m++) {
    const iso = `2026-${String(m).padStart(2, '0')}-15`;
    const ins = S.inSeasonKeys(new Date(`${iso}T12:00:00Z`));
    console.log(`  ${iso}   ${ins.length ? ins.join(', ') : '—'}`);
  }
  console.log('\n  (Easter-linked and lunar holidays move year to year; this is 2026.)');
}

async function audit() {
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const db = client.db(process.env.DATABASE_NAME || 'threespeak');

  const per = new Map();
  let total = 0, flagged = 0;

  let untimely = 0;
  // Date field differs per collection, same as feedAgeMatch.
  for (const [cname, fields, dateField] of [
    ['videos', ['tags_v2', 'tags'], 'created'],
    ['embed-video', ['hive_tags'], 'createdAt'],
  ]) {
    const cursor = db.collection(cname)
      .find({}, { projection: { tags: 1, tags_v2: 1, hive_tags: 1, created: 1, createdAt: 1 } });
    for await (const doc of cursor) {
      total++;
      const raw = fields.map((f) => doc[f])
        .find((v) => v && (Array.isArray(v) ? v.length : String(v).trim()));
      if (!raw) continue;
      const created = doc[dateField];
      const keys = S.seasonalKeys(raw, created);
      // Tag says holiday, upload date disagrees → boilerplate tagging, not gated.
      if (!keys.length) { if (S.seasonalKeys(raw).length) untimely++; continue; }
      flagged++;
      const toks = [...new Set(S.seasonalTokens(raw))];
      for (const k of keys) {
        if (only.length && !only.includes(k)) continue;
        if (!per.has(k)) per.set(k, { videos: 0, tokens: new Map() });
        const e = per.get(k);
        e.videos++;
        for (const t of toks) {
          if (S.seasonalKeys([t]).includes(k)) e.tokens.set(t, (e.tokens.get(t) || 0) + 1);
        }
      }
    }
  }
  console.log(`${untimely} further videos carry a holiday tag but were uploaded far out of season — treated as noise, never gated.`);

  console.log(`${flagged} of ${total} videos carry a holiday tag (${(flagged / total * 100).toFixed(2)}%)\n`);
  for (const [id, e] of [...per.entries()].sort((a, b) => b[1].videos - a[1].videos)) {
    console.log(`── ${id}: ${e.videos} videos, ${e.tokens.size} distinct triggering tags`);
    console.log('   ' + [...e.tokens.entries()].sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}(${n})`).join('  ') + '\n');
  }

  await client.close();
}

(async () => {
  calendar();
  if (!calendarOnly) { console.log('\n' + '─'.repeat(78) + '\n'); await audit(); }
})().catch((e) => { console.error(e); process.exit(1); });
