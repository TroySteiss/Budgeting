-- 021: the change log per budget (Troy 2026-11-24: "keep a log of changes under more, with notes about who made them,
-- and if they came from an import ... Admin only insight"). budget_ids = the budget(s) an entry touched; source =
-- 'import' when it came from a file. Older entries are tagged from their detail's budget id where the action is a
-- budget action. (Keep this file ASCII: a local WIN1252 database rejects other characters.)
alter table change_log add column if not exists budget_ids int[] not null default '{}';
alter table change_log add column if not exists source text not null default '';
create index if not exists change_log_budget_ids on change_log using gin (budget_ids);

update change_log set budget_ids = array[(detail->>'id')::int]
 where budget_ids = '{}' and detail->>'id' ~ '^[0-9]{1,9}$'
   and (action in ('create budget', 'relink annual data', 'relink budget snapshots', 'update budget inputs', 'edit actualized month',
     'edit line', 'save point', 'restore save point', 'undo (restore snapshot)', 'apply formula set', 'review budget defaults',
     'clear defaults review', 'set standing MROUND', 'untie category from UW', 'tie category to UW (acquisition plan)',
     'tie growth target', 'quarter shift', 'quarter shift cleared', 'rebalance category', 'delete budget', 'budget summary email',
     'import draft workbook (review)', 'import review decisions', 'import review: month edited', 'actualize month',
     'release actualized month', 'actualize month (Yardi CSV)', 'ND review apply', 'ND review apply (new budget)',
     'ND review re-file contracts', 'import draft workbook')
    or action like 'tie NOI to %' or action like 'tie income to %');

update change_log set source = 'import'
 where source = '' and (action ilike '%import%' or action ilike '%upload%' or action ilike '%yardi csv%'
   or action ilike 'ND review apply%' or action ilike '%re-file%');
