// ตัวเชื่อม Stripe (lazy init — แอปบูตได้แม้ยังไม่ใส่คีย์/ยังไม่ลงแพ็กเกจ)
let _client = null;

function hasKeys() {
  const k = process.env.STRIPE_SECRET_KEY || '';
  // ต้องเป็นคีย์จริง (sk_live_/sk_test_) และไม่ใช่ placeholder ที่มี xxx
  return /^sk_(live|test)_/.test(k) && !/x{3,}/i.test(k);
}

function client() {
  if (!hasKeys()) throw new Error('ยังไม่ได้ตั้งค่า STRIPE_SECRET_KEY');
  if (!_client) {
    const Stripe = require('stripe'); // require ตอนใช้จริงเท่านั้น
    _client = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _client;
}

module.exports = { client, hasKeys };
