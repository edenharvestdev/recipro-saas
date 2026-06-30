// Service worker — ทำให้ติดตั้งเป็นแอป (PWA) ได้ + ใช้ออฟไลน์ได้บางส่วน
// กลยุทธ์: network-first สำหรับไฟล์ static (ได้ของใหม่เสมอ, ออฟไลน์ค่อย fallback cache)
// ไม่แตะ /api /auth /webhooks (ข้อมูลสด — ให้วิ่ง network ตรง)
const CACHE = 'recipro-v2'; // bumped: pos card layout fix

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|auth|webhooks)\b/.test(url.pathname)) return; // ข้อมูลสด — ไม่ cache

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((c) => c || caches.match('/')))
  );
});
