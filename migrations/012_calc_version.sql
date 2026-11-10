-- 012: stamp each budget with the formula version of its last FULL calculation, so the editor
-- can say "calculated before the latest formula changes - Recalc". Stored lines only move on a
-- recalc; without the stamp a budget built on older formulas looks current. Null = never
-- stamped (built before this migration).
alter table budgets add column if not exists calc_version text;
alter table budgets add column if not exists calc_at timestamptz;
