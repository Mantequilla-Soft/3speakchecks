const { MongoClient } = require('mongodb');
const { MONGODB_URI, DATABASE_NAME, SOCIAL_LINKS_COLLECTION, UNVERIFIED_TTL_DAYS } = require('./config');
const searchWeights = require('../config/search-weights.json');

// Social-link verifier indexes (merged from mantequilla-social-verifier):
// one row per (hive_username, platform, canonical platform_username), a
// duplicate-claim lookup, and a config-driven TTL on unverified rows.
async function ensureSocialLinkIndexes(database) {
    const coll = database.collection(SOCIAL_LINKS_COLLECTION);
    const expireAfterSeconds = UNVERIFIED_TTL_DAYS * 24 * 60 * 60;
    try {
        await coll.createIndex(
            { hive_username: 1, platform: 1, platform_username: 1 },
            { unique: true, name: 'social_link_unique' },
        );
        await coll.createIndex(
            { platform: 1, platform_username: 1, verified: 1 },
            { name: 'social_link_platform_verified' },
        );
        const idxs = await coll.indexes();
        const ttl = idxs.find(i => i.name === 'social_link_unverified_ttl');
        if (ttl && ttl.expireAfterSeconds !== expireAfterSeconds) {
            await coll.dropIndex('social_link_unverified_ttl');
        }
        await coll.createIndex(
            { first_seen: 1 },
            { name: 'social_link_unverified_ttl', expireAfterSeconds, partialFilterExpression: { verified: false } },
        );
    } catch (err) {
        console.error('Failed to ensure social-link indexes:', err.message);
    }
}

let db;

async function ensureTextIndex(collectionName, config) {
    const col = db.collection(collectionName);
    const fields = {};
    const weights = {};
    for (const [field, weight] of Object.entries(config.fields)) {
        fields[field] = 'text';
        weights[field] = weight;
    }
    const opts = { name: config.indexName, weights };
    if (config.languageOverride) opts.language_override = config.languageOverride;

    try {
        await col.createIndex(fields, opts);
    } catch (err) {
        if (err.codeName === 'IndexOptionsConflict' || err.code === 85) {
            console.log(`Recreating text index on ${collectionName}...`);
            // Drop any existing text index (only one allowed per collection)
            const indexes = await col.indexes();
            for (const idx of indexes) {
                if (idx.textIndexVersion) {
                    await col.dropIndex(idx.name);
                    break;
                }
            }
            await col.createIndex(fields, opts);
        } else {
            throw err;
        }
    }
}

async function connectToMongo() {
    try {
        // Cap the pool (was the driver default of 100). The shared Mongo was
        // hitting its connection limit — 100 here + the retention worker's client
        // was tipping it into ECONNREFUSED. 75 is ample for this feed API and
        // leaves headroom for the other services on the same Mongo.
        const client = new MongoClient(MONGODB_URI, {
            maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) || 75,
            minPoolSize: 0,
            waitQueueTimeoutMS: 20000,
        });
        await client.connect();
        db = client.db(DATABASE_NAME);
        console.log('Connected to MongoDB successfully');

        // Create text indexes for search (non-blocking — may take a while on large collections)
        Promise.all(
            Object.values(searchWeights).map(config =>
                ensureTextIndex(config.collection, config)
            )
        ).then(() => console.log('Text search indexes ensured'))
          .catch(err => console.error('Text index creation failed:', err.message));

        ensureSocialLinkIndexes(db)
            .then(() => console.log('Social-link indexes ensured'))
            .catch(err => console.error('Social-link index creation failed:', err.message));
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }
}

function getDb() {
    return db;
}

function getLinksCollection() {
    return getDb().collection(SOCIAL_LINKS_COLLECTION);
}

module.exports = { connectToMongo, getDb, getLinksCollection };
