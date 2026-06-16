// รัน schema ลงฐานข้อมูล: node src/migrate.js
// ใช้ทั้งตอน dev เครื่องตัวเอง และตอน setup Railway
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const files = [
  '../db/schema.sql',
  '../db/schema-extend.sql',
  '../db/seed.sql',
];

(async () => {
  try {
    for (const rel of files) {
      const p = path.join(__dirname, rel);
      const sql = fs.readFileSync(p, 'utf8');
      process.stdout.write(`running ${rel} ... `);
      await pool.query(sql);
      console.log('ok');
    }
    console.log('migrate: done');
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('migrate failed:', e.message);
    await pool.end();
    process.exit(1);
  }
})();
