// First-run seeding (รันหลัง migrate, ก่อน start) — ทำงานเฉพาะตอนฐานข้อมูลยังว่าง
// - โหลดข้อมูลจริงของ Merry Jane (ร้าน + วัตถุดิบ + สูตร + ตั้งค่า + บัญชี owner)
// - สร้าง superadmin จาก env SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD (ถ้าตั้งไว้)
// ออก exit 0 เสมอ (best-effort) เพื่อไม่ให้บล็อกการสตาร์ทเซิร์ฟเวอร์
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, query, tx } = require('./db');
const { seedMerryJane } = require('../scripts/import-merryjane');

(async () => {
  try {
    const n = (await query('select count(*)::int n from shops')).rows[0].n;
    if (n > 0) {
      console.log(`[bootstrap] มีร้านอยู่แล้ว (${n}) — ข้ามการ seed`);
      await pool.end();
      return process.exit(0);
    }

    console.log('[bootstrap] ฐานข้อมูลว่าง → กำลัง seed ข้อมูล Merry Jane + superadmin');
    await tx(async (c) => {
      const summary = await seedMerryJane(c);
      console.log(`[bootstrap] seed Merry Jane: ร้าน=${summary.shopName} วัตถุดิบ=${summary.materials} สูตร=${summary.recipes}`);

      const email = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
      const pass = process.env.SUPERADMIN_PASSWORD || '';
      if (email && pass.length >= 8) {
        const hash = await bcrypt.hash(pass, Number(process.env.BCRYPT_ROUNDS) || 10);
        let u = (await c.query('select id from users where email = $1', [email])).rows[0];
        if (!u) u = (await c.query('insert into users (email, password_hash) values ($1,$2) returning id', [email, hash])).rows[0];
        await c.query(
          "insert into memberships (user_id, shop_id, role) values ($1,$2,'superadmin') on conflict (user_id, shop_id) do update set role='superadmin'",
          [u.id, summary.shopId]
        );
        console.log(`[bootstrap] สร้าง superadmin: ${email}`);
      } else {
        console.log('[bootstrap] ยังไม่ได้ตั้ง SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD (รหัส >=8 ตัว) — ข้ามการสร้าง superadmin');
        console.log('[bootstrap] ตั้งค่าใน Railway Variables แล้ว redeploy เพื่อสร้าง superadmin อัตโนมัติ');
      }
    });

    console.log('[bootstrap] เสร็จสิ้น');
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('[bootstrap] ผิดพลาด (ข้ามไปเพื่อสตาร์ทเซิร์ฟเวอร์ต่อ):', e.message);
    try { await pool.end(); } catch (_) {}
    process.exit(0); // best-effort — ห้ามบล็อก start
  }
})();
