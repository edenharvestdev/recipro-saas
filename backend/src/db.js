// เชื่อม PostgreSQL (Railway) ผ่าน pg Pool
const { Pool } = require('pg');

const needSSL = /[?&]sslmode=require/.test(process.env.DATABASE_URL || '') ||
  process.env.PGSSL === 'require';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needSSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// query สั้น ๆ
async function query(text, params) {
  return pool.query(text, params);
}

// ทำงานในทรานแซกชันเดียว (auto begin/commit/rollback)
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
