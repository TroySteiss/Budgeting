-- 011: the Assumptions dialog used to save every corporate-rate box onto the budget, typed or
-- not, so a 2027 budget whose Assumptions were applied carries the 2026 6310 rate
-- ($43.14/unit/yr + $483/mo) as if it had been typed. The 2027 Payroll Budget Workbook rev2
-- raised 6310 to $58.17/unit/yr + $513/mo (6451 folded in). Strip that untouched 2026 default
-- from 2027+ budgets so they follow the 2027 rate on their next recalc. A rate that differs
-- from the old default (someone typed it) is kept. Budget lines are not touched here.
-- (Keep this file ASCII: a local WIN1252 database rejects other characters.)
update budgets
set inputs = inputs #- '{corpRates,6310}'
where year >= 2027
  and jsonb_typeof(inputs->'corpRates'->'6310') = 'object'
  and coalesce((inputs->'corpRates'->'6310'->>'perUnitYr')::numeric, 0) = 43.14
  and coalesce((inputs->'corpRates'->'6310'->>'flatMo')::numeric, 0) = 483;
