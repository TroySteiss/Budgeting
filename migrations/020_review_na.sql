-- 020: checks marked not applicable by hand on the Review grid (Troy 2026-11-18: "Need to be able to mark NA").
-- Per region: { "<rule id>": { "<property code>": { "by": "...", "at": "ISO date", "note": "..." } } }. A mark is
-- for the property, not one budget, so it carries to the next year's budgets. Null = nothing marked.
-- (Keep this file ASCII: a local WIN1252 database rejects other characters.)
alter table app_meta add column if not exists review_na jsonb;
