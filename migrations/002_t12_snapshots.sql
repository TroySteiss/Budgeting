-- 002: seller T12 operating statements (monthly actuals per property)
create table if not exists t12_snapshots (
  id serial primary key,
  property_code text not null references properties(code) on delete cascade,
  upload_id int references uploads(id) on delete set null,
  label text not null default '',
  period text not null default '',
  book text not null default '',
  data jsonb not null default '{}'::jsonb,   -- {monthCal:[calendar month 1-12 per col], rows:[{gl,name,months[12],total}]}
  created_at timestamptz default now()
);

alter table budgets add column if not exists t12_snapshot_id int references t12_snapshots(id) on delete set null;
