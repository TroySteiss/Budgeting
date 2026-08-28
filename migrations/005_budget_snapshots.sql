-- Save points: named, server-persisted iterations of a budget (lines + inputs
-- verbatim). Restore writes them back exactly; an automatic "before restore"
-- point is captured first so nothing is ever lost.
create table if not exists budget_snapshots (
  id serial primary key,
  budget_id int not null references budgets(id) on delete cascade,
  name text not null,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  inputs jsonb not null,
  lines jsonb not null,
  summary jsonb not null default '{}'::jsonb
);
create index if not exists budget_snapshots_budget on budget_snapshots(budget_id, created_at desc);
