-- s10: แนบสลิป/ใบเสร็จให้การเติมเงินสดย่อย (petty cash) — additive
alter table cash_topups add column if not exists slip_data text;
