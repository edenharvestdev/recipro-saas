-- รายรับ-รายจ่าย: เพิ่มประเภท income/expense (เดิมมีแต่รายจ่าย)
alter table expenses add column if not exists kind text default 'expense'; -- expense | income
