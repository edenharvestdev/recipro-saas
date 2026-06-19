-- Unit conversion fields for materials
alter table materials add column if not exists conv_qty numeric;
alter table materials add column if not exists stock_unit text;
