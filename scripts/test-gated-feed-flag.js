/**
 * 🔐 Feed cards must carry the `gated` flag so the frontend can draw a lock badge.
 *
 * This exists because of a specific shape trap: hydrate() builds the embed card
 * object field by field rather than spreading the Mongo doc, so any field not
 * named there is silently dropped. A projection or a doc change elsewhere looks
 * correct and still loses the flag. Legacy videos take the spread path instead,
 * which is why they are checked separately.
 *
 * The flag is presentation only. The gate enforces access on every manifest and
 * key request, so a card claiming gated:false changes nothing about who can
 * actually watch.
 *
 * Usage: node scripts/test-gated-feed-flag.js
 */

const { hydrate } = require('../utils/discoverPool');

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** Minimal stand-in for the two collections hydrate() reads. */
function fakeDb({ embed = [], legacy = [] }) {
  return {
    collection(name) {
      const docs = name === 'embed-video' ? embed : legacy;
      return {
        find() {
          return { toArray: async () => docs };
        },
        // hydrate() also attaches topic tags. Not under test here, but stubbed
        // so the fake is complete and the run stays quiet.
        aggregate() {
          return { toArray: async () => [] };
        },
      };
    },
  };
}

function embedDoc(over = {}) {
  return {
    owner: 'creator',
    permlink: 'asset123',
    hive_author: 'creator',
    hive_permlink: 'post123',
    hive_title: 'A video',
    createdAt: new Date('2026-08-01'),
    duration: 120,
    hive_tags: ['threespeak'],
    thumbnail_url: 'https://img.3speak.tv/x/thumbnail.png',
    manifest_cid: 'Qm123',
    views: 5,
    ...over,
  };
}

async function main() {
  console.log('\nEmbed cards');

  const entries = [{ source: 'embed', owner: 'creator', assetPermlink: 'asset123' }];

  const gated = await hydrate(fakeDb({ embed: [embedDoc({ gated: true })] }), entries);
  ok('a gated video reaches the card as gated:true', gated[0]?.gated === true, JSON.stringify(gated[0]?.gated));

  const plain = await hydrate(fakeDb({ embed: [embedDoc({ gated: false })] }), entries);
  ok('an ungated video reaches the card as gated:false', plain[0]?.gated === false);

  // Every video predating this feature has no `gated` field at all. It must
  // render as a normal card, not as undefined leaking into a truthiness check.
  const legacyShape = await hydrate(fakeDb({ embed: [embedDoc()] }), entries);
  ok('a doc with no gated field becomes gated:false, not undefined', legacyShape[0]?.gated === false, String(legacyShape[0]?.gated));

  ok('the rest of the card is unchanged',
    legacyShape[0]?.title === 'A video' && legacyShape[0]?.duration === 120 && legacyShape[0]?.views === 5);

  console.log('\nLegacy cards');

  // Legacy docs take the spread path, so they need no explicit handling. Assert
  // that, so nobody "fixes" it by adding a field that path never needed.
  const legacyEntries = [{ source: 'legacy', owner: 'creator', permlink: 'oldpost' }];
  const legacyOut = await hydrate(
    fakeDb({ legacy: [{ owner: 'creator', permlink: 'oldpost', title: 'Old', status: 'published' }] }),
    legacyEntries,
  );
  ok('legacy videos still hydrate', legacyOut[0]?.title === 'Old');
  ok('legacy videos carry no gated flag (spread path, never gated)', legacyOut[0]?.gated === undefined);

  console.log('\nShared embed mapper');

  // transformEmbedVideoToLegacy feeds /new, /firstUploads, the community feeds
  // and the profile shelf. Same field-by-field trap as hydrate().
  const feeds = require('../routes/feeds');
  const t = feeds.__testables?.transformEmbedVideoToLegacy;
  if (!t) {
    ok('transformEmbedVideoToLegacy is exported for testing', false, 'add it to module.exports.__testables');
  } else {
    ok('mapper marks a gated video', t(embedDoc({ gated: true })).gated === true);
    ok('mapper marks an ungated video false, not undefined', t(embedDoc()).gated === false);
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\ntest crashed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
