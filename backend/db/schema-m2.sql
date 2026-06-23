-- M2: ตัวเลือกแบบ "ไม่+เงิน แค่ระบุ" (ไม่รับซอส/ทานที่นี่) — ไม่ตัดสต๊อก ไม่คิดต้นทุน
alter table option_choices add column if not exists is_metadata_only boolean default false;
