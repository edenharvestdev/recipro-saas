// จุดเชื่อม frontend — ใส่ค่าที่เปิดเผยได้เท่านั้น (ห้ามใส่ secret/JWT/Omise secret)
window.RECIPRO_CONFIG = {
  // "" = ต่อ API จากโดเมนเดียวกับเว็บ (Node เสิร์ฟ frontend เอง — ใช้บน Railway)
  //  หรือใส่ URL เต็มถ้า frontend อยู่คนละโดเมนกับ API เช่น "https://api.recipro.co"
  //  ตั้งเป็น "MOCK" เพื่อใช้โหมดจำลอง (localStorage ไม่ต้องมีหลังบ้าน)
  API_BASE_URL: "",

  // Omise public key (ใช้สร้าง token บัตรฝั่ง browser) — เว้นว่างได้ถ้ายังไม่ต่อจ่ายเงิน
  OMISE_PUBLIC_KEY: ""
};
