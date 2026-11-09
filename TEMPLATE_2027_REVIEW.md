# 2027 budget template review — what to take, what to skip, what imports

Reviewed 2026-11-09 against Seth Russell's release email of the same day (rev1 at 12:33 fixed a shifted formula for unallocated employees and refreshed the property list; no change to the §3 table layout) to the Asset
Managers and Analysts lists: *Instructions for 2027 Budget Templates* (docx/pdf) and
*Payroll Budget Workbook 2027.xlsb*. Budget questions go to Quentin; template errors to Seth
(email only, no reply-all).

The Yardi budget template itself is **not** in the release — each property's is pulled from
Yardi (Asset Manager role → Reports → Monarch → 2027 Budgeting Template, start 01/01/2027).
The open points from the 11-05 draft (see the end of this file) still need a real pull.

No pay figures appear in this file. The payroll workbook holds individual compensation;
only structure, counts, statutory rates and vendor cost constants are described.

## 1. The instructions, where they touch the tool

| Step | Instruction | Tool today | Call |
|---|---|---|---|
| 2 | *Employee Relations Budget* worksheet feeds **6318** employee relations, **6316** education, **6732** uniforms, **6733** tools: staff counts × per-person amounts (per month / quarter / year) | 6316 rule is `engine` (points at that worksheet), 6732/6733 `flatT12` (T12 ÷ 12 over the $1,000 threshold), 6318 plain baseline | **Decide.** A per-head driver (heads from the roster × an amount) is easy once we see the worksheet's amounts in a real pull. Until then history-based is defensible. |
| 3 | Real estate taxes preload as **October × 12**; "coordinate with the property accountant" | Fixed 11-05: T12 ÷ 12 flat, warning when the last month is off | **Skip the template's method.** The accountant's number goes in as a manual override. |
| 4 | Payroll comes from the separate workbook, pasted into *Paste Payroll Here* | Tool builds payroll itself from the roster + Pay-rates raises; `parseYardiBudgetTemplate` never reads the paste tab | **Skip the paste flow.** See §2 for the workbook's math. |
| 4 | Rover wages: overages move to special projects via **6450**, "generally not budgeted" | 6450 is a T12 ratio of wages — the negative T12 budgets a credit | **Take: zero 6450 by default.** |
| 4 | Bi-weekly payroll is accrued — no 3rd-payroll month adjustment | Flat months | Already consistent. |
| 4 | Marketing worksheet: default **+5 % over PY actual**; 6550–6560 prefilled by corporate | 6550/6555 same-month × 1.05 MROUND $10; 6560 corporate rate; 6565 engine | Already consistent. |
| 4 | Special projects: SP General in **December** when category/timing unknown | SP entered per site | No change; worth a hint in the SP entry UI. |
| 5–7 | CSV export, upload, NOI check; **6451 is combined with 6310 since 2026**; check **principal payments** (ysi_cf tree) landed | 6451 zeroed, allocation in 6310 (matches); principal from the template debt schedule to 3080/3090/3091; CSV byte-exact | Consistent. Confirm principal rows post after the first 2027 upload. |
| 8–9 | Copy to Accrual book, transfer to GL budget | Yardi-side | Outside the tool. |

## 2. The payroll workbook — how it builds each GL

Per-property sheet *Budget Section*: §1 allocated employees, §2 unallocated, §3 the
GL × 12-month paste table (rows 58–77), appendix with bonus/commission math and a
2026-budget / prior-year comparison. Portfolio data sheets behind it: *Dictionary of
Employees* (HRIS roster), *Allocated Employee Data* (splits), *Property Details* (state, units),
*Tax Table* (statutory rates by state), *Bonus Key* / *Bonus Potential By Position* (comp plan),
*Renewal Data* (per property per month: leases ended, renewals, avg increase, MTM, occupancy,
move-outs, 2019–Aug 2026), *Financial Data* (payroll GL actuals + budget Sep-25 → Oct-26),
*Sensitive Data* (protected; not readable, not needed).

| GL | Workbook 2027 | Tool today (ratio lines = same-month % of wages since 11-09) | Call |
|---|---|---|---|
| 6402/6404/6405/6406/6407 wages | Current rate × allocation (hourly × 2080 ÷ 12), **flat 12 months, no raise step**. No 2027 increases are loaded for ND ("Old Pay Rate" blank). | Roster wages with Pay-rates raises prorated from each effective month | **Keep ours** — the workbook has no raise. |
| 6408 bonus | Per-position quarterly NOI potential (Bonus Key) × allocation, placed **Jan / Apr / Jul / Oct**; + office delinquency bonus tiered by unit count, monthly; + maintenance on-call bonus × days in month | Same-month T12 ratio × that month's wages (keeps the Jan/Apr/Jul/Oct shape) | **Offer as a method.** Deterministic, but it budgets the full potential; the same-month ratio is what was actually paid, in the months it was paid. Troy's call on the default. |
| 6410 commissions | Expirations (PY same-month leases ended from Renewal Data, else units ÷ 12) × PY renewal rate (else 60 %) × top renewal tier, + new leases × 11–12-month tier; paid ~45 days later with a seasonal weighting | Same-month T12 ratio (keeps the summer peak) | **Take.** We already have expirations (UAD) and renewal %; commissions = renewals × tier + new leases × tier, lagged a month. |
| 6412 overtime | Hourly wages × (T12 OT ÷ T12 wages, **capped 8 %**, fallback 3.75 %) | Ratio of all wages, no cap | Minor. Hourly-only base + cap is a small refinement. |
| 6413 employee rent | **Last actual month (Oct-26) flat** | Same since 11-09 (`BURDEN_LAST_GLS`) | Matches. |
| 6414 contract labor | **PY same-month actuals**, no growth | Ratio × wages | **Take: PY same month** (shape `actual`, 0 %). It is not wage-driven. |
| 6416 admin fee | Payroll-provider fee per allocated head per month (Tax Table) | Ratio | Take when convenient: heads × fee. Ratio approximates it. |
| 6418 payroll taxes | Per seat: SS 6.2 % + Medicare 1.45 % + SUTA 1.62 % to a $46,600 base + FUTA 0.6 % to $7,000; full rate on bonus/commission/OT | Same-month T12 / CY-budget / mix ratio | **Offer "statutory" as a basis option.** The T12 ratio carries real SUTA experience and the Q1 front-load from wage caps; statutory is flat. |
| 6420 workers comp | WC admin 0.535 % on 6402 seats, WC maintenance 1.605 % on the rest; admin rate on bonus/commission/OT | Ratio | Same as taxes. |
| 6421 401(k) | 2 % of wages + bonus + commissions + OT | Ratio | Same as taxes. |
| 6422 medical | Per-seat monthly benefits from HRIS × allocation (portfolio default per seat from the Tax Table) | Ratio | **Take.** The roster we already parse carries each person's monthly benefits. |
| 6424 drug / background | 0.5 % of wages | Ratio | Same as taxes. |
| 6450 allocations out | **Do not budget** (0) | Ratio of a negative T12 | **Take: zero.** |
| 6310 corp alloc + consulting | Units × $43.14/yr ÷ 12 + $390 + $93, "do not change" | `CORP_RATES['6310']` identical | Matches (the paste table labels this row 6310, confirming the 6451 merge). |

## 3. Importing the workbook

- **Tie-out import (built 11-09):** run *Create a Payroll Budget* for a property, save, and drop
  the workbook on the Data page. The property sheet's §3 table is stored as a reference and
  shows under each payroll GL, with Δ rows under TOTAL PAYROLL EXPENSE and a toolbar chip. The
  employee sections are never read.
- **Staffing upload parses it as-is.** `parseStaffingReport` recognises *Dictionary of
  Employees* + *Allocated Employee Data*: 2,241 people; **85 with ND allocations across 16 ND
  codes** (bcnd 14, clnd 16, cwnd 17, drnd 8, ecnd 13, fhnd 8, grks 8, lhnd 17, mwnd 8,
  nrnd 17, phnd 10, rrnd 17, spnd 11, tcnd 13, tpnd 13, wynd 15 seats; a person split across
  sites counts at each). All FULL status; every ND split sums to 100 %; one ND person is
  flagged Allocated with no split rows (falls back to their home property — check on upload).
  No 2027 raises are pre-loaded, so raises come from the Pay-rates cycle.
- **Title mapping fixed 11-09:** *Dual Site Property Mgr*, *Roving Asst Prop Mgr* and
  *Asst Reg Property Mgr II* were unmapped and landed in 6404 maintenance; now 6402, and the
  assistant regional is RM-masked. The raise grid's burden estimate (`BURDEN_EST`) now uses
  the Tax Table's ND rates.
- The old aggregate **payroll-model upload does not read this workbook** (no Wages grid) —
  expected; wages come from the roster apply.
- **Not imported yet, worth it:** *Renewal Data* (a ready source for each property's renewal %
  and a cross-check on UAD expirations); *Bonus Key* constants if the comp-plan bonus method is
  built; the per-property *Budget Section* paste table, if an AM ever builds payroll in Excel
  instead. *Financial Data* duplicates what our statements already carry.

## 4. Still to verify on a real 2027 Yardi pull (from the 11-05 draft)

Done since: mgmt fee on prior-month income, 6331 fixed cost from column D, MoveOuts sheet
carried. Open: template GLs 5141/6304/6341/6613/6624 not in the seed chart (and seed
6451/7451/7499 not in the template); 5160/5161 carport vs parking labels; a sanity bound on
GPR steps (a bare "15" imports as a 15 % step); validation of the template's lease-expiration
count against the UAD.
