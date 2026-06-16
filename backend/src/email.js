// ส่งอีเมลผ่าน Resend (REST) ถ้าตั้งค่าไว้ — ไม่งั้น log ลง console (dev)
// ไม่ throw ขึ้นไปทำให้ flow หลักล้ม (best-effort)
async function sendMail({ to, subject, html }) {
  if (!to) return;
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Recipro <noreply@recipro.co>';
  if (!key) {
    console.log(`[email:dev] to=${to} | ${subject}`);
    return;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!r.ok) console.error('[email] resend failed:', await r.text());
  } catch (e) {
    console.error('[email] error:', e.message);
  }
}

function money(n) {
  return '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function sendReceipt(to, { plan, amount, chargeId }) {
  return sendMail({
    to,
    subject: 'ใบเสร็จค่าบริการ Recipro',
    html: `<h2>ขอบคุณสำหรับการชำระเงิน</h2>
           <p>แพ็กเกจ: <b>${plan}</b></p>
           <p>ยอดชำระ: <b>${money(amount)}</b></p>
           <p>เลขอ้างอิง: ${chargeId}</p>`,
  });
}

async function sendRenewalReminder(to, { shopName, endDate }) {
  return sendMail({
    to,
    subject: 'แจ้งเตือน: ใกล้ถึงรอบตัดบัตร Recipro',
    html: `<h2>ใกล้ถึงรอบต่ออายุ</h2>
           <p>ร้าน <b>${shopName}</b> จะถึงรอบตัดบัตรวันที่ <b>${endDate}</b></p>
           <p>โปรดตรวจสอบว่าบัตรของคุณใช้งานได้ เพื่อให้บริการต่อเนื่อง</p>`,
  });
}

module.exports = { sendMail, sendReceipt, sendRenewalReminder };
