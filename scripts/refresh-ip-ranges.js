#!/usr/bin/env node
/**
 * Refresh the datacenter / cloud / VPN IP range file by hand. The checker also does
 * this on its own (services/ipRanges.js, scheduled in server.js).
 *
 * Usage:
 *   node scripts/refresh-ip-ranges.js              # writes data/datacenter-ranges.json
 *   node scripts/refresh-ip-ranges.js --dry-run    # fetch and report, write nothing
 *   node scripts/refresh-ip-ranges.js --out <path>
 *
 * Needs no .env and no database.
 */
const { refresh } = require('../services/ipRanges');

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};

refresh({ out: arg('--out') || undefined, dryRun: process.argv.includes('--dry-run') })
  .then((r) => { if (!r.written) console.log('  --dry-run, not writing'); })
  .catch((err) => { console.error(`FATAL: ${err.message}`); process.exit(1); });
