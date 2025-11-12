const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const useSsl =
  process.env.PGSSLMODE === 'require' ||
  (connectionString && connectionString.includes('sslmode=require'));

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error', err);
  process.exit(-1);
});

module.exports = { pool };
