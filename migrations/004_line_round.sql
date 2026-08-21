-- 004: standing MROUND per line — a modifier applied AFTER the formula
-- computes (survives regeneration; not an override/lock)
alter table budget_lines add column if not exists round numeric(12,2) not null default 0;
