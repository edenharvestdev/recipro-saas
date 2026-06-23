-- A3: แนบสลิป/ใบเสร็จต่อรายจ่าย (เพื่อรวมยื่นภาษี) — เก็บ base64
alter table expenses add column if not exists slip_data text;
