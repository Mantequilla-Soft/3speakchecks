#!/usr/bin/env node
/**
 * A creator never sees an ad on their own video.
 *
 *   node scripts/test-ad-self-view.cjs
 *
 * They are the one person guaranteed to replay a video repeatedly — checking the
 * thumbnail, the title, whether the encode came out right. Every replay used to be an
 * impression an advertiser paid for and the creator earned from, which is a farm that
 * requires no effort and no bad intent to run.
 *
 * Hits the live decision function rather than the HTTP surface, so it also covers the
 * shorts feed, which shares it. The pre-upload gate does NOT: there the uploader IS the
 * audience, and that branch returns in routes/adServe.js before reaching this code.
 *
 * Read-only. Touches no money and writes nothing.
 */
require('dotenv').config();
const { connectToMongo } = require('../utils/db');
const { adDecision, ADS_ALLOWED_OWNERS } = require('../utils/adEligibility');

let failed = 0;
const check = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${l}${ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);
};

(async () => {
  await connectToMongo();
  // Whoever the trial allows, so this passes the gate ahead of the one under test
  // rather than being masked by it.
  const owner = ADS_ALLOWED_OWNERS.length ? ADS_ALLOWED_OWNERS[0] : 'badadib';
  console.log(`  testing as owner @${owner}\n`);

  const self = await adDecision({ viewer: owner, owner });
  check('the author gets no ad on their own video', self.reason, 'own_video');
  check('  and it is decided as "no ads"', self.ads, false);

  // Case and a leading @ are cosmetic; the same person is the same person.
  check('  uppercase is the same person', (await adDecision({ viewer: owner.toUpperCase(), owner })).reason, 'own_video');
  check('  a leading @ is the same person', (await adDecision({ viewer: `@${owner}`, owner })).reason, 'own_video');

  console.log('\n-- and nobody else is affected --');
  // A viewer the trial does not gate on: only the OWNER is checked against the
  // allowlist, so any other name exercises the normal path.
  const other = await adDecision({ viewer: `${owner}-someone-else`, owner });
  check('a different viewer is NOT stopped by this rule', other.reason === 'own_video', false);
  // Anonymous viewers have no identity to match, and must keep seeing ads — they are
  // most of the audience.
  const anon = await adDecision({ viewer: null, owner });
  check('an anonymous viewer is not stopped by it either', anon.reason === 'own_video', false);
  check('  nor is an empty string', (await adDecision({ viewer: '', owner })).reason === 'own_video', false);

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
