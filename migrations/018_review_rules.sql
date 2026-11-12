-- 018: budget review checklist rules (Troy 2026-11-12, the "Budget Review" workbook). Per region; null = the
-- built-in DEFAULT_REVIEW_RULES in shared/review.ts for the region. Each rule is one known pattern for one GL
-- (January-high vendor rebates, April accounting fee, November gift cards, bonuses the same each quarter,
-- snow removal budgeted...), checked automatically against every budget on the Summary tab's Review view.
-- Admins edit them under Settings. A checklist only: nothing is changed by it.
-- (Keep this file ASCII: a local WIN1252 database rejects other characters.)
alter table app_meta add column if not exists review_rules jsonb;
