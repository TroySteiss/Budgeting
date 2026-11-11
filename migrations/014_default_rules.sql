-- 014: default formulas - one per-GL rule table edited on the Default formulas screen. It sits over
-- the built-in formula of every budget that is NOT on a named saved formula set (template defaults or
-- the old GRKS default), so a change here reaches those budgets at their next recalculation.
alter table app_meta add column if not exists default_rules jsonb not null default '{}'::jsonb;
