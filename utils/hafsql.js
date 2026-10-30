// Read-only access to HafSQL, the public PostgreSQL copy of Hive's history
// (https://mahdiyari.gitlab.io/hafsql). Used where the Hive APIs can't answer,
// e.g. WHEN someone started following an account: a follow sits only in the
// follower's history, and notifications keep about 90 days.
//
// The default connection is HafSQL's published public read-only account; set
// HAFSQL_* in .env to point at another HAF/HafSQL database.

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.HAFSQL_HOST || 'hafsql-sql.mahdiyari.info',
      port: parseInt(process.env.HAFSQL_PORT, 10) || 5432,
      database: process.env.HAFSQL_DATABASE || 'haf_block_log',
      user: process.env.HAFSQL_USER || 'hafsql_public',
      password: process.env.HAFSQL_PASSWORD || 'hafsql_public',
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      query_timeout: 20000,
    });
    // A dropped idle connection must not take the process down.
    pool.on('error', (err) => console.error('[hafsql] pool error:', err.message));
  }
  return pool;
}

async function query(sql, params) {
  const { rows } = await getPool().query(sql, params);
  return rows;
}

module.exports = { query };
