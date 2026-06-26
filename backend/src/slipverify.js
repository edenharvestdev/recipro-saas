// ตรวจสลิปโอน/พร้อมเพย์อัตโนมัติผ่าน SlipOK (https://slipok.com)
// เปิดใช้เมื่อมี SLIPOK_API_KEY + SLIPOK_BRANCH_ID · ตั้ง RECIPRO_PROMPTPAY = บัญชีรับเงินของแพลตฟอร์ม
function hasKeys() {
  return !!(process.env.SLIPOK_API_KEY && process.env.SLIPOK_BRANCH_ID);
}

// ส่งรูปสลิป (dataURL/base64) ไปให้ SlipOK อ่าน QR + ตรวจสอบ
// คืน { success, amount, transRef, receiver, raw }
async function verifySlipImage(dataUrl) {
  if (!hasKeys()) throw new Error('ยังไม่ได้ตั้งค่า SlipOK');
  const m = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('ไฟล์สลิปไม่ถูกต้อง');
  const buf = Buffer.from(m[1], 'base64');
  const form = new FormData();
  form.append('files', new Blob([buf], { type: 'image/jpeg' }), 'slip.jpg');
  form.append('log', 'true');   // ให้ SlipOK กันสลิปซ้ำฝั่งเขาด้วย
  const r = await fetch(`https://api.slipok.com/api/line/apikey/${process.env.SLIPOK_BRANCH_ID}`, {
    method: 'POST',
    headers: { 'x-authorization': process.env.SLIPOK_API_KEY },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) {
    const msg = (data && (data.message || data.code)) || `SlipOK error ${r.status}`;
    const err = new Error(msg); err.slipok = data; throw err;
  }
  const d = data.data || {};
  return {
    success: true,
    amount: Number(d.amount) || 0,
    transRef: d.transRef || d.transRefId || d.ref || null,
    receiver: (d.receiver && (d.receiver.displayName || d.receiver.name)) || d.receivingBank || null,
    raw: d,
  };
}

module.exports = { hasKeys, verifySlipImage };
