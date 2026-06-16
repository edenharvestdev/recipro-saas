// งานตามเวลา — รันด้วย Railway Cron: `node src/cron.js`
// 1) พักร้านที่ค้างชำระเกิน GRACE_DAYS  2) เตือนก่อนตัดบัตร (≤3 วัน)
require('dotenv').config();
const { query, pool } = require('./db');
const { sendRenewalReminder } = require('./email');

async function suspendOverdue() {
  const graceDays = Number(process.env.GRACE_DAYS) || 3;
  const { rows } = await query(
    `update shops set status='suspended'
      where id in (
        select s.shop_id from subscriptions s
         where s.status='past_due'
           and s.current_period_end is not null
           and s.current_period_end + ($1 || ' days')::interval < now()
      )
      and status <> 'suspended'
      returning id`,
    [String(graceDays)]
  );
  console.log(`[cron] suspended ${rows.length} overdue shop(s)`);
  return rows.length;
}

async function sendReminders() {
  const { rows } = await query(
    `select s.shop_id, sh.name as shop_name, s.current_period_end,
            (select u.email from users u join memberships m on m.user_id=u.id
              where m.shop_id=s.shop_id order by m.role='owner' desc limit 1) as email
       from subscriptions s join shops sh on sh.id = s.shop_id
      where s.status in ('active','trialing')
        and s.current_period_end is not null
        and s.current_period_end between now() and now() + interval '3 days'`
  );
  for (const r of rows) {
    await sendRenewalReminder(r.email, {
      shopName: r.shop_name,
      endDate: new Date(r.current_period_end).toLocaleDateString('th-TH'),
    });
  }
  console.log(`[cron] sent ${rows.length} renewal reminder(s)`);
  return rows.length;
}

async function run() {
  await suspendOverdue();
  await sendReminders();
}

// ให้เรียกเป็นโมดูล (เทสต์) หรือรันตรง ๆ จาก CLI ก็ได้
if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => { console.error('[cron] failed:', e.message); process.exit(1); });
}

module.exports = { run, suspendOverdue, sendReminders };
