/**
 * Run the suspicious views / ad impressions detectors once and PRINT the findings.
 * Never sends the webhook and never records anything (services/susScan.js does that
 * on its own schedule inside the checker).
 *
 * Usage:
 *   node scripts/sus-scan.js                        # the last 2h, as the scheduler sees it
 *   SUS_SCAN_WINDOW_H=24 node scripts/sus-scan.js   # a wider look back
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { connectToMongo } = require('../utils/db');
const susScan = require('../services/susScan');

(async () => {
  await connectToMongo();
  const findings = await susScan.runOnce({ dryRun: true });
  console.log(`window ${susScan.WINDOW_H}h: ${findings.length} finding(s)`);
  for (const f of findings) console.log(`- [${f.type}] ${f.subject}\n    ${f.text.replace(/\*\*/g, '')}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
