// รัน schema ลงฐานข้อมูล: node src/migrate.js
// ใช้ทั้งตอน dev เครื่องตัวเอง และตอน setup Railway
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const files = [
  '../db/schema.sql',
  '../db/schema-extend.sql',
  // additive migrations (idempotent: add column / create table if not exists)
  '../db/schema-expenses.sql',
  '../db/schema-unit-conversion.sql',
  '../db/schema-options.sql',
  '../db/schema-consumables.sql',
  '../db/schema-r1.sql',
  '../db/schema-pos.sql',
  '../db/schema-sop.sql',
  '../db/schema-income.sql',
  '../db/schema-item-master.sql',
  '../db/schema-m1.sql',
  '../db/schema-m2.sql',
  '../db/schema-a1.sql',
  '../db/schema-a2.sql',
  '../db/schema-a3.sql',
  '../db/schema-m3.sql',
  '../db/schema-a4.sql',
  '../db/schema-w1.sql',
  '../db/schema-m4.sql',
  '../db/schema-o1.sql',
  '../db/schema-o2.sql',
  '../db/schema-m5.sql',
  '../db/schema-m6.sql',
  '../db/schema-m7.sql',
  '../db/schema-m8.sql',
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
