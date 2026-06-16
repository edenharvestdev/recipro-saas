// ตัวช่วยเรียก Omise API ผ่าน fetch (ไม่ต้องลง SDK)
// เอกสาร: https://docs.opn.ooo/api  · auth = Basic base64(secretKey + ':')
const BASE = 'https://api.omise.co';

function authHeader() {
  const key = process.env.OMISE_SECRET_KEY;
  if (!key) throw new Error('ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

async function omiseRequest(method, path, params) {
  const opts = { method, headers: { Authorization: authHeader() } };
  if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(params).toString();
  }
  const r = await fetch(BASE + path, opts);
  const data = await r.json();
  if (!r.ok || data.object === 'error') {
    throw new Error(data.message || data.code || `Omise error ${r.status}`);
  }
  return data;
}

module.exports = {
  hasKeys: () => !!process.env.OMISE_SECRET_KEY,
  createCustomer: (email, card) => omiseRequest('POST', '/customers', { email, card }),
  createCharge: (params) => omiseRequest('POST', '/charges', params),
  retrieveCharge: (id) => omiseRequest('GET', `/charges/${id}`),
  retrieveEvent: (id) => omiseRequest('GET', `/events/${id}`),
};
