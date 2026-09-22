/**
 * Move ad creatives off a stored gateway url and onto a stored CID.
 *
 * WHY THEY HAVE A URL: until 2026-09-22 both services/adCreativeSync.js and
 * routes/adCampaigns.js wrote `https://<gateway>/ipfs/<cid>/manifest.m3u8` onto the
 * row as the encode landed. That froze a delivery decision minutes before anyone
 * would try to fetch it, in a process with no idea who would read it or whether they
 * could retry, and the gateway it named (hotipfs-3speak-1) answers 500 for anything
 * not already in its cache — which is every creative at the moment it is encoded.
 *
 * WHAT IT COST: the first banner ever booked drew nothing, while its close button,
 * its open-in-new icon and its "Ad" label all rendered correctly, because those are
 * built from the placement the server sends and never touch the asset. Server-side
 * readers survived it because they walk sibling gateways; a url handed to a browser
 * gets one attempt. See utils/adGateways.js.
 *
 * NOT REQUIRED FOR CORRECTNESS. creativeManifestUrl() parses the CID back out of a
 * legacy url, so an un-migrated row already resolves to a working host. This is
 * tidiness: it removes a wrong hostname sitting in the database waiting to be
 * rediscovered by someone who trusts it.
 *
 * SOURCE: the row's own url. Nothing is fetched and no gateway is contacted — the CID
 * is the path segment after /ipfs/. A url that does not parse is reported and left
 * alone, because a guessed CID points at somebody else's video.
 *
 * Safe to re-run: a migrated row no longer matches the filter.
 *
 * Usage:
 *   node scripts/backfill-creative-cids.cjs --dry-run    # report only, no writes
 *   node scripts/backfill-creative-cids.cjs              # apply
 */
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { cidFromManifestUrl } = require('../utils/adGateways');

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';
const CREATIVES = process.env.AD_CREATIVES_COLLECTION || 'ad_creatives';

const DRY_RUN = process.argv.includes('--dry-run');

// Anything still carrying the field, whether or not the CID was already copied
// across: a row with both is half-migrated and the stale url is the half to drop.
const FILTER = { manifestUrl: { $nin: [null, ''] } };

async function run() {
    if (!MONGODB_URI) throw new Error('MONGODB_URI is not set');
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    try {
        const col = client.db(DATABASE_NAME).collection(CREATIVES);
        const rows = await col.find(FILTER).toArray();
        console.log(`${rows.length} creative(s) still holding a gateway url`
            + `${DRY_RUN ? '  (DRY RUN, nothing will be written)' : ''}\n`);

        let migrated = 0;
        let unparsed = 0;
        for (const cr of rows) {
            const cid = cr.manifestCid || cidFromManifestUrl(cr.manifestUrl);
            const host = (() => {
                try { return new URL(cr.manifestUrl).hostname; } catch (_) { return '?'; }
            })();
            if (!cid) {
                unparsed += 1;
                console.log(`  SKIP  ${cr.embedId}  no CID in ${cr.manifestUrl}`);
                continue;
            }
            console.log(`  ${DRY_RUN ? 'would ' : ''}move  ${String(cr.embedId).padEnd(26)}`
                + `  ${host} -> cid ${cid}`);
            if (!DRY_RUN) {
                await col.updateOne(
                    { _id: cr._id },
                    { $set: { manifestCid: cid }, $unset: { manifestUrl: '' } },
                );
            }
            migrated += 1;
        }

        console.log(`\n${DRY_RUN ? 'would migrate' : 'migrated'} ${migrated}`
            + `${unparsed ? `, left ${unparsed} alone (no CID to read)` : ''}`);
        if (unparsed) {
            console.log('A row with no readable CID cannot serve either way and needs a person:'
                + ' re-attach the creative, or reject it.');
        }
    } finally {
        await client.close();
    }
}

run().catch((err) => {
    console.error('backfill failed:', err && err.message);
    process.exit(1);
});
