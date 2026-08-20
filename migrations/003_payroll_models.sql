-- 003: regional payroll model — PROPERTY-LEVEL AGGREGATES ONLY.
-- Org policy: individual employee compensation is restricted data. The importer
-- sums the roster to per-property totals by wage GL and discards everything
-- else; names/rates/positions are never stored.
create table if not exists payroll_models (
  id serial primary key,
  upload_id int references uploads(id) on delete set null,
  label text not null default '',
  data jsonb not null default '{}'::jsonb,   -- {properties: {clnd: {"6402": $, "6404": $, ...}}, unmappedPositions: []}
  created_at timestamptz default now()
);

alter table budgets add column if not exists payroll_model_id int references payroll_models(id) on delete set null;
