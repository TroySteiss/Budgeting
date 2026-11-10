-- 013: saved formula sets - a named recipe (per-GL shape / factor / MROUND rules, deliberate
-- zero-outs and the formula settings) saved from one budget and picked when another is started.
-- No dollars and nothing hand-typed is stored. A budget keeps its own COPY of the set it was
-- given (budgets.inputs.rules), so editing or deleting a set never moves a budget.
create table if not exists formula_sets (
  id serial primary key,
  name text not null,
  data jsonb not null default '{}'::jsonb,
  source text not null default '',
  created_by text not null default '',
  created_at timestamptz default now()
);
create unique index if not exists formula_sets_name_lower on formula_sets (lower(name));
