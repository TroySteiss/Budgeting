-- 007: Monarch statement snapshots — the data layer for ANNUAL (non-acquisition)
-- budgets. A Yardi "12 Month Statement" (posted actuals, kind=actual) or
-- "12 Month Budget" (the year's budget as it sits in Yardi, kind=budget) for
-- ONE Monarch property, on the Monarch chart (4-digit GLs — no mapping).
create table if not exists stmt_snapshots (
  id serial primary key,
  property_code text not null references properties(code) on delete cascade,
  upload_id int references uploads(id) on delete set null,
  kind text not null default 'actual',          -- actual | budget
  label text not null default '',
  period text not null default '',              -- as printed: "Oct 2025-Sep 2026"
  book text not null default '',                -- Cash | Accrual
  data jsonb not null default '{}'::jsonb,      -- {monthCal:[1-12 per col], monthYear:[yyyy per col], rows:[{gl,name,months[12],total}]}
  created_at timestamptz default now()
);
create index if not exists stmt_snapshots_prop on stmt_snapshots(property_code, kind, created_at desc);

-- The Yardi BUDGET TEMPLATE workbook (budgetYSR<year>_budget_<id>.xlsm) per
-- property: everything in it EXCEPT the pasted payroll roster (restricted —
-- never read). PriorFinancials become two stmt_snapshots (actual + budget);
-- the rest (debt schedule, fee matrix, Conservice utility forecasts,
-- corporate suggestions, lease expirations, property info) lands here.
create table if not exists template_snapshots (
  id serial primary key,
  property_code text not null references properties(code) on delete cascade,
  upload_id int references uploads(id) on delete set null,
  budget_year int not null,
  label text not null default '',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists template_snapshots_prop on template_snapshots(property_code, created_at desc);

-- an annual budget points at its trailing-12 actuals, the current-year budget
-- and (optionally) the Yardi template it was exported with
alter table budgets add column if not exists py_stmt_id int references stmt_snapshots(id) on delete set null;
alter table budgets add column if not exists cy_budget_stmt_id int references stmt_snapshots(id) on delete set null;
alter table budgets add column if not exists template_id int references template_snapshots(id) on delete set null;
