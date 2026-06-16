# ชุด Prompt สำหรับ Claude Code (ทำทีละเฟส อย่าทำทีเดียวหมด)

> เปิด Claude Code ในโฟลเดอร์ `recipro-saas/` แล้ววางทีละ prompt ตามลำดับ
> **สแตก:** Railway + Node/Express + PostgreSQL + JWT + Omise (ไม่ใช้ Supabase)

## เฟส A — รากฐาน (Auth + Multi-tenant + ย้ายแอปเดิม)
```
อ่าน docs/architecture.md, docs/migration-plan.md และ backend/db/schema.sql
1) ทำ Node/Express API + เชื่อม PostgreSQL (DATABASE_URL) ให้รันได้
2) ทำระบบล็อกอินเอง: register / login / refresh token (JWT) + hash รหัสผ่าน (bcrypt)
3) ทำ REST /api/* ให้ทุก endpoint แยกข้อมูลด้วย shop_id ที่ดึงจาก JWT membership (ชั้นแอป)
4) เปลี่ยนชั้นเก็บข้อมูลใน frontend จาก localStorage/Supabase เดิม → เรียก REST API
ทำให้รันได้จริง ทดสอบ login แล้วเห็นเฉพาะข้อมูลร้านตัวเอง
```

## เฟส B — แอดมินหลัก (Super admin)
```
สร้างฟีเจอร์แอดมินสำหรับผู้ใช้ role='superadmin':
- สร้างร้านใหม่ + สร้างบัญชี login แรกของร้าน (ผ่าน API ที่เช็คสิทธิ์ superadmin)
- ดูทุกร้าน / เปิด-ปิด-พักร้าน (อัปเดต shops.status)
- ผูกแบรนด์/ธีม/โลโก้ของแต่ละร้านกับตาราง shop_settings
สิทธิ์ทั้งหมดตรวจที่ชั้น API (middleware เช็ค role) — frontend แค่ซ่อน/โชว์เมนู
```

## เฟส C — สมาชิก + ตัดบัตร (Billing ด้วย Omise)
```
อ่าน docs/architecture.md ส่วนจุดเชื่อม (2) และ (3)
1) ทำหน้าเลือกแพ็กเกจ (รายเดือน/รายปี) จากตาราง plans
2) ต่อ Omise สำหรับจ่ายครั้งแรก (สร้าง customer + charge/subscription)
3) ทำ endpoint POST /webhooks/omise ให้ครบ (ยืนยัน event โดยดึงกลับจาก Omise API):
   charge สำเร็จ -> active, charge ล้มเหลว -> past_due, ยกเลิก -> canceled
4) ลอจิกพักร้านเมื่อ status เป็น past_due เกิน GRACE_DAYS + แจ้งเตือนอีเมล (ทำใน cron)
```

## เฟส D — เก็บงาน
```
- แดชบอร์ดแอดมิน: จำนวนร้าน / รายได้ / ร้านใกล้หมดอายุ  (✅ ทำหน้า UI ไว้แล้ว — ต่อ API จริง)
- งาน cron: เตือนก่อนตัดบัตร + ส่งใบเสร็จค่าบริการ + พักร้านที่ค้างชำระเกินกำหนด
- ทดสอบ end-to-end ทุกบทบาท (superadmin / owner / staff) แล้ว deploy ขึ้น Railway
```

---

## เฟสเพิ่มเติม J–L (บิลมาตรฐาน · POS · ฉลาก/Niimbot)
ดูสเปกเต็ม + prompt ของแต่ละเฟสได้ที่ `docs/next-phases.md`
ฐานข้อมูลส่วนนี้: `backend/db/schema-extend.sql` (รันต่อจาก `schema.sql`)
