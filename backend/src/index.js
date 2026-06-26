// จุดเริ่มเซิร์ฟเวอร์ (Railway: npm start)
require('dotenv').config();
const app = require('./app');
const { run: runCron } = require('./cron');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Recipro API + frontend on :${PORT}`));

// งานตามเวลาแบบฝังในแอป — เตือนก่อนหมด + พักร้านค้างชำระ (วันละครั้ง, ไม่ต้องตั้ง Railway Cron แยก)
// readonly cutoff ทำงานสดทุก request อยู่แล้ว; ตัวนี้เสริม: อีเมลเตือน (ถ้ามีคีย์) + flip past_due → suspended
let _lastCronDay = null;
async function cronTick() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (_lastCronDay === today) return;   // กันรันซ้ำในวันเดียว
    _lastCronDay = today;
    await runCron();
  } catch (e) { console.error('[cron] tick error:', e.message); }
}
setTimeout(cronTick, 60 * 1000);             // ครั้งแรก ~1 นาทีหลังบูต
setInterval(cronTick, 6 * 60 * 60 * 1000);   // เช็คทุก 6 ชม. (รันจริงวันละครั้ง)
