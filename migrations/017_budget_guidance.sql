-- 017: budget guidance ranges (Troy 2026-11-11, exec team 2027 Budget Guidance). Per region; empty =
-- the built-in DEFAULT_GUIDANCE in shared/annual.ts (income 3.0-3.25%, expenses 3.0-3.5%, expense
-- growth at most 50 bps over income growth, NOI +2.5% or better and not below the current budget,
-- March rental income 1.5-2% over October, insurance $275/unit, RE taxes +3%, payroll 3-4%, SP 2% of
-- capital). Admins edit them under Settings. A scorecard only: nothing is changed by it.
-- (Keep this file ASCII: a local WIN1252 database rejects other characters.)
alter table app_meta add column if not exists guidance jsonb not null default '{}'::jsonb;
