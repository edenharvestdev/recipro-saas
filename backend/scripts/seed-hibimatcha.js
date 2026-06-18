// Seed ร้านกลุ่ม Hibimatcha 6 สาขา
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, tx } = require('../src/db');

const SHOPS = [
  { name: 'Hibimatcha Cafe House',       email: 'hibimatcha@recipro.local',    code: 'HB00' },
  { name: 'HB01-Ladprao107 สาขาลาดพร้าว107', email: 'hb01.ladprao@recipro.local',  code: 'HB01' },
  { name: 'HB02-Samyan สาขาสามย่าน',          email: 'hb02.samyan@recipro.local',   code: 'HB02' },
  { name: 'HB03-Nawamin111 สาขานวมินทร์ 111',  email: 'hb03.nawamin@recipro.local',  code: 'HB03' },
  { name: 'HB04-Saphan Khwai',            email: 'hb04.saphankhwai@recipro.local', code: 'HB04' },
  { name: 'HB05-Nak Niwat48',             email: 'hb05.nakniwat@recipro.local',  code: 'HB05' },
];
const PASS = 'super2026';

async function seedShop(c, shopDef, hash) {
  // idempotent: ข้ามถ้ามีอยู่แล้ว
  const exist = (await c.query('select id from shops where name=$1 limit 1', [shopDef.name])).rows[0];
  if (exist) { console.log(`  ข้าม (มีอยู่แล้ว): ${shopDef.name}`); return null; }

  const shop  = (await c.query("insert into shops (name, status) values ($1,'trial') returning id", [shopDef.name])).rows[0];
  const user  = (await c.query('insert into users (email, password_hash) values ($1,$2) returning id', [shopDef.email, hash])).rows[0];
  await c.query("insert into memberships (user_id, shop_id, role) values ($1,$2,'owner')", [user.id, shop.id]);
  await c.query("insert into shop_settings (shop_id, theme) values ($1,'recipro')", [shop.id]);
  return { shopId: shop.id, userId: user.id };
}

(async () => {
  const hash = await bcrypt.hash(PASS, Number(process.env.BCRYPT_ROUNDS) || 10);
  const results = await tx(async (c) => {
    const out = [];
    for (const s of SHOPS) {
      const r = await seedShop(c, s, hash);
      if (r) out.push({ ...s, ...r });
    }
    return out;
  });
  console.log('\n✅ เพิ่มร้านสำเร็จ:');
  results.forEach(r => console.log(`  ${r.code} | ${r.name}\n     login: ${r.email} / ${PASS}`));
  console.log('\nรหัสผ่านทุกร้าน: ' + PASS + ' (เปลี่ยนหลังล็อกอินครั้งแรก)');
  await pool.end();
  process.exit(0);
})().catch(e => { console.error('failed:', e.message); pool.end(); process.exit(1); });
