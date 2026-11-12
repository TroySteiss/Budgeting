# PROJECT MAP — nd-budget-tool

> Structural map so a new session can orient without re-exploring.
> **Keep this updated when the architecture changes.**
> Last updated: 2026-11-12 — **Compare card: a "Δ% T3" column after "Δ% T12" (budget vs the T3 annualized, `t3DeltaCell` in tieGrowthHtml; display only, guidance and ties stay on the T12; shown only when a T3 is on file).** Earlier the same day: **Guidance colours are direction-aware, pegged to the 2027 memo: income numbers are floors (above = green), expense numbers ceilings (below = green), with derived targets for every row that has no number of its own (GPR / other income at the income floor, contra lines by share of GPR, the fee no faster than income). New settings `expenseMax` 3.5% / `payrollMax` 4% (the memo's top of range). Same rules on the Summary tab, the compare card and `guidanceCheck` (dashboard scorecard, export check). Summary growth now on the signed reference like the card.** Earlier the same day: **(1) Summary tab rebuilt as ONE table in the dashboard Budgets layout (no per-region cards): property, budget, income / OpEx / NOI, Δ NOI / Δ EGI, guidance, then every compare-card subtotal (income detail behind a toggle), NOI vs CY budget, CoC, status, updated; a subtotal row closes each region and an all-properties row closes the table; view toggle Δ% / Δ$ / budget $ / T12 $; cells green inside the exec-team guidance, red outside (same numbers as the tie card's empty target boxes), always vs the T12 for annual budgets (UW Y1 for acquisitions). Server: `compareOf` in routes.ts on GET /summary (computeTieout, same as the compare card) + `guidance`. (2) Smooth catches sudden DROPS too (`smoothGentle` step 3). (3) Saved formula sets carry "Zero out row" (an override with driver zero, all months 0) and the increase %s as picked (`FormulaSet.row.glGrowth` on every formula line + `row.secGrowth`); sets saved earlier need re-saving.** Earlier the same day: **Payroll: (1) a Regional Manager's rate is never reset from the payroll detail report (that report carries only the properties' 70% of the check, so RM pay and the raise on it were 65-70% of full); the workbook's full Annual stays, and the 70/30 MI split is applied once, on the allocations. (2) Open positions (name Open / Vacant / TBD / New hire, `isOpenSeat`) budget at `OPEN_SEAT_PCT` = 75% of full wages, in the roster wages (`annualWagesByGl` / `monthlyWagesByGl`) and the Wages-sheet model (name in column C; `openRows` counted). (3) Raise re-point matching gains a SEAT pass: an unmatched raise follows a unique same position + same property split onto a genuinely new row (`how: 'seat'`), shown separately in the preview.** Earlier the same day: **Raises survive a re-dropped payroll sheet: re-pointing a cycle (PUT /payroll/cycles/:id with staffingSnapshotId) now previews first (`dryRun`) and carries every raise. Same key as-is; a changed key (Prism ID added, grid vs roster format, "Last, First") is re-matched by a unique name (`matchRaiseKeys` / `personNameId` in shared/payroll.ts). A person whose home region moved gets their raise copied into the new region's open iteration. Unmatched raises are kept and listed, never deleted. Raise-workbook imports match keys the roster no longer has by the Employee column (`resolveRaiseKeys`). "↻ Use latest staffing" shows the preview in a confirm. Tests: test/raise-carry.test.ts.** Earlier the same day: **Saved formula sets now carry T12 FIT on engine-built lines (% of GPR, corporate rate, …) as `FormulaSet.fit` (history lines keep it on `rule.fit`), and the row picks the rules cannot carry: payroll 64xx and 6350 shape / raise % / MROUND as `FormulaSet.row`. applyFormulaSet restores both, and copy-formulas hands engine-line fit in the copied sections to budgets and sets. Before this, those picks were dropped when a set was saved, and applying a set wiped them. Sets saved earlier need re-saving.** Earlier the same day: **Editor side pane is resizable: drag the grip on its left edge (300px to 70% of the window, saved per browser as `bt-side-w`; double-click resets to 400). A hand edit to an income line now re-follows a live % of income management fee (`refollowMgmtFee` in shared/annual.ts, called from PUT /budgets/:id/lines/:gl after the dependent passes): each month keeps its own fee rate on the new prior-month income, January stays fixed when it runs on the CY budget's December. Before this, NOI on the KPIs and the Compare card lagged until a recalc.** Earlier the same day: **Monthly trend: quarterly breakdown under the chart (`trendQuarterHtml`) — for each series picked in the legend, a row per year shown (this budget, the T12 / CY-budget reference, each prior-year T12), Q1–Q4 $ with the share of the year, quarters in the budget's month order. Prior-year T12s now carry income and expense too (`priorT12[].income/expense`), drawn dotted for every picked series, not just NOI**; 2026-11-11 — **Quarter shift never moves fixed-schedule lines: insurance (P6), the fee (P7), RE & PP / franchise taxes (P8), payroll (P10), corporate rates and suggestions (`qShiftLeverOk`, shared/annual.ts; mirrored in `openQShift`). A saved shift that picked one simply leaves it alone**; **One flat option: "Flat + growth over T12…" (T12/12). Annual budgets no longer offer MAN "Flat — annual $", "Flat — $ per month", "Start $/mo + growth" (a hard-coded cell is the override), "Average of active months" or "Last actual month, flat" (`RETIRED_SHAPES`: lines already on them keep them, labelled retired); the seasonal-curve choices (CURVE, T12C) show only on GLs with a real curve (`glHasCurve`), and a "curve" line on a GL without one shows T12/12, which is what it is**; **FIT chip on every fit-able grid row (`fitChipHtml` / `openFitChip`): faint dashed "FIT" when off, "FIT n%" when set; click → 0/25/50/75/100 or a typed % — the same `baseline.glFit` as the row menu and the section box**; **Unit Availability import counts every unit's market once, whatever its status: pre-leased units listed only by an Applicant / Future row were dropped (CLND 11/9: 8 units, $12,325/mo; GPR $477,985 instead of $490,310). Both 11/9 and 11/11 reports now give the same market total for all 15 sites**; **GPR base is ALWAYS the linked rent roll's market total (all units): `loadBudget` sets `inputs.gpr.baseMonthly` from the roll on every load, so a relink moves GPR with loss to lease / HAP / lease ends; the base box is read-only while a roll is linked; an override is a hard-coded cell on the 4994 row (Troy: "rent rolls only")**; **Loss to lease: month 1 is the rent roll (market − rent − HAP, no re-pricing before it is shown); a lease re-prices the month AFTER it ends, at that month's market, so leases ending between the roll and the start re-price in month 2 (`ltlModelCore`, domain.ts)**; **Compare card: an empty target box ties to its guidance number (tie shows only when the row is outside it; NOI, a floor, still needs a typed number); the tie button shares the Target cell and the table scrolls rather than clipping it**; earlier: **prior-year T12s as dotted NOI lines on the trend chart; guidance as single numbers + fill blank targets; quarter shift recommends lines and can phase in the increases**; **HAP inside GPR (GPR + HAP = rent roll GPR, LTL excludes HAP); typed first LTL month runs on; formula chips beside every choice**; **quarter shift: move NOI share between quarters on picked lines, year totals kept** (see "Quarter shift"); **HAP subsidy held out of the loss-to-lease burnoff** (it was being counted twice; see "HAP is not loss to lease"); fit to T12 on any GL; guidance in the tie card's target boxes; **2027 exec-team guidance scorecard** + Total Rental Income / Total Income ties with a picked lever + template-first New budget dialog again (see "2027 budget guidance" below); **2027 Budget notes pass** (contracts & known costs, one-time items out of the T12, flat-fee package schedule, TPND→TPNDC journal split, required lines, 6108 $275, snowContract curve; see "2027 Budget notes pass" below); **regions: North Dakota / KC East toggle in the banner, each region's data in its own Postgres schema** (see "Regions" below); GL-based row options (own T12 actuals, T12 total on a curve, weighted average) use the row's own GL with no picker on annual budgets; Shift-click picks another line (`S.pickOther`); 2026-11-10 — hard-coded CELLS (the months typed by hand, `driver.hard`) show bold in one dedicated colour in the grid and the Excel exports; no negative budget months on history-based lines (`foldCredits`); Smooth rounds to $5, never leaves a negative month and shows as a SECOND chip beside the line's formula chip; "Formula for lines…" applies one formula (incl. the turn curve) to ticked lines in bulk; RE taxes grow 3% by default (`RE_TAX_DEFAULT_PCT`); dashboard "Recalculate…" re-runs many budgets with a before/after preview (`POST /budgets-recalc`); section formulas: one pick on a section header sets how every history-based line under it is built, and More → "Copy section formulas to other budgets…" gives chosen sections' formulas to chosen budgets / saved sets with a preview (`sectionFormulaSource` / `copyFormulas`, `POST /budgets/:id/copy-formulas`); Year-1 plan inside the annual budget: a new acquisition's calendar-year budget takes the months still inside ownership Year 1 from its Y1 (UW-tied) budget on every line through NOI (`applyY1Plan` / `y1Check`, `inputs.y1Plan`); every export formula now carries a stored value so nothing is blank in Protected View (`src/xlsx-calc.ts`); the budget-comps panel is in the Excel exports (`Budget Comps` sheet per property, `Portfolio Comps` + `Schedule` in the all-sites workbook, live formulas + the workbook's colour scale; `src/xlsx-summary.ts`), on-screen Schedule gets the colour scale and drops trend windows nobody has on file; Summary tab (Schedule table by region) and a per-budget Summary view in the budget-comps workbook's formatting, with renameable column headers; payroll ratios and monthly shape can be borrowed from another property (`inputs.burdenFrom`); section increase % boxes on the grid's section headers (`baseline.secGrowth`); Payroll tab opens on All regions with finalize-all; raise import skips zeros and reads a typed New rate as a raise (RM files import in any order); 2026-11-09 — "Flat + growth over T12" (any row-chosen shape) now works on every line, engine-driven ones included; first-year management fee for the first 12 months of ownership, start-up months of a new acquisition left out of its history; saved formula sets (picked when a budget starts; GRKS rules are no longer a silent default), within-year cost drift on expense lines; reviewability pass (dropped lines, chip key, formula-version stamp, defaults-in-use card, export check), vacancy on a carry-over curve from the last actual month, prior-period collections capped at delinquency; loss to lease: market growth deepens every lease and a reset burns only the burnoff share (`ltlModel` growth); vacancy is an annual average shaped by lease expirations (`vacancyByMonth`); roster raises start in the cycle's effective month (editable on the Payroll tab); Δ% T12 column; annual budgets take wages from the Payroll tab by default (roster + raise entries, drafts included; `src/payroll-data.ts`, `inputs.wageSource`); 6310 corporate rate follows the budget year (2027 workbook rev2: $58.17/unit/yr + $513/mo), Minot sites are subjects with the role editable in Settings; editor view pass (quarterly % rows on totals, trend chart axis fitted to the data instead of zero, T3-annualized reference column after the T12 in the grid and the compare card, whole-dollar cell display); flat-fee utility billing (reimbursement income = last actual month × budgeted occupancy, `utilities.billing`), Enter on an assumption box moves to the next row; payroll template tie-out (a Payroll Budget Workbook property sheet imports as a reference: rows under the payroll GLs, Δ rows under 6470, toolbar chip); 2027 template release reviewed (TEMPLATE_2027_REVIEW.md: take/skip per GL, payroll workbook imports as a staffing report, 2027 HRIS titles mapped); payroll burden ratio applied month by month, employee rent carries its last actual month; multi-input Fx chips open a GPR-style popover (LTL renewal % + burnoffs; corp rates, interest); 2026-11-05 engine fixes (RE tax off T12, typed category % precedence, roll as-of date for pre-start leases).
> Earlier: 2026-09-10 — actualized months (partial-month rule; section above Exports); 2026-08-20 (initial build + seller-T12 shapes + monthly comp sets
> w/ per-unit basis + ND payroll model).

## What this is

> 2027 budget season: `TEMPLATE_2027_REVIEW.md` is the per-GL take/skip review of Monarch's
> 2027 template release (instructions + payroll workbook) and what still needs a real Yardi pull.

Budgeting web app for Monarch properties. Replaces the FHND/PHND Excel budget workbooks for
**new acquisitions** (Bismarck 4: cwnd/lhnd/nrnd/rrnd, Jamestown 2: drnd/mwnd), with an
**annual-budget mode planned** (phase 3). Node + TS + Express + Postgres; vanilla-JS SPA;
Railway deploy. Local dev: Postgres 17 `budget_tool` DB, `npm run dev` on port 3100.

```
Browser (public/app.js, single file, no framework)
   │  fetch /api/*  (session cookie)
   ▼
Express (src/server.ts) ── static: public/
   ├── src/auth.ts        shared-password login; admin = ADMIN_USERS env allowlist
   ├── src/routes.ts      ALL /api endpoints (async errors → JSON 500), change_log writes
   │     ├── src/importers.ts    xlsx parsing: UW book / rent roll (2 formats) / comparison
   │     ├── src/csv-export.ts   Yardi Voyager budget ETL CSV (byte-exact, tested vs real file)
   │     └── src/xlsx-export.ts  review workbook (Budget grid w/ formulas, Summary, Raw Data)
   ├── src/db.ts          pool, query, tx
   ├── src/migrate.ts     migrations/*.sql in order on boot (_migrations table)
   └── src/seed-if-empty.ts  first-boot: seed/coa.json (385 GL accounts) + ND portfolios/properties
shared/domain.ts          ALL business math (pure, unit-tested): rollup, curves, allocation,
                          generation, regenerate, rebalance, tie-out
```

## Regions — ND and KC East (Troy 2026-11-11)

"A fork of the budget tool for KC East… a toggle between ND and KC… the data for each separate."
One app, one deploy, one login; **each region is its own Postgres schema** holding the full table
set. ND stays in `public` (nothing moved); KC East (agmo, fpmo, pwmo, trmo, wlmo) lives in `kc`.

- `src/db.ts`: `REGIONS` (key → label, schema), one pool per region; a non-public pool pins
  `search_path` to ONLY its schema, so a query can never fall through to the other region's tables.
  `query`/`tx` pick the pool from an AsyncLocalStorage (`inRegion`, `currentRegion`; default 'nd').
- The region comes from each request: `X-Region` header (the SPA's `api()` sends it) or `?region=`
  (download links, via `rUrl()` in app.js). `regionOfRequest`; unknown/missing → 'nd'.
- Both routers' `h()` wrappers run the handler inside `inRegion(regionOfRequest(req))`, NOT a
  middleware alone — multer's stream callbacks lose the async context. A new route MUST go through
  `h()` (or call `inRegion` itself) or it will silently read/write ND.
- `src/migrate.ts` runs every migration once per region (`create schema if not exists kc`, its own
  `_migrations`). Keep migrations schema-unqualified (no `public.`). ND-specific data migrations
  (010 Minot) are harmless no-ops in `kc`.
- `src/seed-if-empty.ts` seeds each region (COA + its own portfolios). KC sites seed with name =
  code and 0 units until a rent roll / template drop or Settings → Properties fills them.
- Sessions stay on the ND pool (`public.session`), so one sign-in covers both regions. `app_users`,
  `app_meta` (title, default formulas), formula sets, payroll cycles, uploads: all per region.
- Client: `S.region` per TAB (localStorage `bt-region` only picks the next load's default), so two
  tabs on different regions never cross-write (budget ids overlap between schemas).
  `switchRegion()` drops the open budget, undo stack, payroll working set and upload preview, then
  reloads `/state`. KC gets a blue banner rule (`body[data-region=kc]`).
- Hard-coded ND rules (FLAT_FEE_PROPERTIES, Minot comps, ND payroll regions) key on property codes
  or uploaded data, so they don't apply to KC sites. Corporate rates and the GRKS rule file are shared.

## Quarter shift (Troy 2026-11-11: "shift some of the NOI share from one quarter to another, ie, aggressive Q4 and conservative Q1")

- Rule on the budget: `inputs.qShift = { targets: [Q1..Q4 share of the year's NOI, null = absorbs the
  rest in proportion], gls: [picked expense GLs], vacancy: bool, floor?: 0.5 }`. Re-solved on every
  build (`quarterShiftSolve`, shared/annual.ts, called at the end of `generateAnnualLines` after the
  journal split), so Recalc keeps the shares; nothing is hard-coded.
- Levers are only what Troy ticks: operating-expense lines (6101–7069, not the fee, contracts, debt,
  zero / dropped / typed lines, and never insurance, RE & PP taxes, payroll or corporate rates — their
  months follow a schedule) and/or vacancy timing (5031 on the vacancy formula). Each lever keeps
  its year total penny-exact. Method: one % change per quarter shared by every lever, each lever then
  renormalized to its own year total — a $0 quarter stays $0 and each line keeps its seasonality
  (an earlier per-lever allocation blocked the whole shift on any line with an empty quarter). No
  lever's quarter goes below `floor` (half) of its formula amount: bisection finds the largest share
  of the move that fits (`lam`); short of 100% the driver says `capped`. When vacancy moves, the fee is
  rebuilt (`buildFee`, it follows prior-month income) and the split re-applied (`allocLine`); passes
  re-measure NOI until it lands. Year NOI is unchanged with expense levers; vacancy can move it by the
  fee on December's income (billed next January).
- `POST /budgets/:id/qshift {targets, gls, vacancy, apply?, clear?}` → `report {before, after, moved[],
  lam, capped, targets, landed}`. Apply is refused (400, nothing saved) when capped, when nothing could
  move, or when the shares do not land after typed lines / the Year-1 plan months are laid on.
- UI (in the existing place, not a new pane): the NOI total's "% of year by quarter" row (More → %
  distribution on totals — by quarter) has a share box per quarter and "shift…"; More → "Shift NOI
  between quarters…" opens the same picker (`openQShift`): quarter shares, vacancy timing, expense
  lines by section, Preview (before / after NOI by quarter, per-line moves), Apply, Remove shift.
  Moved lines carry driver `qShift {lam, capped, targets}` → chip Q-SHIFT (·cap) and the Excel note.
- Note for Troy's use: the exec-team guidance asks for an aggressive Q1 and no hockey stick; a
  conservative Q1 shows up in the tie card's March-vs-October and rental-income-by-quarter lines.
- **Less manual (Troy 2026-11-11: "should not require so much manual input… look at expenses that are
  furthest… below and above historical data, and recommend shifting those items. Or… not applying expense
  increases as heavily in Q1 as Q2")**:
  - ★ Recommend lines (`recommend` in `openQShift`): each candidate line's quarters vs its own T12 quarters
    scaled to its year; a quarter needing MORE NOI scores lines budgeted above history there, one needing
    less scores lines below it; ticks the best until they cover 1.5× the move (max 25), then previews.
    Typing shares on the NOI row and opening the picker with nothing ticked recommends + previews by itself.
  - Phase in the expense increases (`qShift.increases`): the lever is only each history-based expense
    line's increase over its own T12 month (`Lever.fixed` = the T12 part, never moves; floor 0, so a
    quarter can carry none of the increase but never drops below T12). Preset "Phase in: half of Q1's
    increase" sets Q1's share up by half of the Q1 increase over T12 and previews.

## 2027 budget guidance (exec team, Troy 2026-11-11)

"The ones we MUST more or less adhere to are rental income, total income, total expenses, and any
specific changes called out. NOI targets are the most important of all." Source: the exec team's
2027 Budget Guidance memo (income 3.0–3.25% over October T12; expenses 3.0–3.5%, at most 50 bps over
income growth; NOI +2.5%+, never below the 2026 budget; March rental income 1.5–2% over October;
insurance $275/unit; RE taxes +3% unless documented; payroll 3–4%; SP ~2% of capital).

- `guidanceCheck` (shared/annual.ts, pure, tested): budget lines vs the October T12 (`lb.actualCal`,
  always, whatever the tie reference) and the CY budget (`lb.budgetCal`). Items carry a status
  ok / check / bad / info and `must` (the exec team's must-hold lines). NOI first. Rental income =
  rollup 5070, total income 5500, expenses 7279, NOI 7280, SP 7500. Insurance / RE tax read the gross
  before a journal split. Also rental income by calendar quarter + Q4 vs Q1 (hockey stick, shown only).
- ONE number per target (Troy 2026-11-11: "the targets are ranges right now, whereas they should just
  be a number"): `incomePct` 3.0, `expensePct` 3.0, `noiPct` 2.5 (at least), `marchVsLastPct` 1.5 (at
  least), `payrollPct` 3.5, `reTaxPct` 3.0, `insurancePerUnit` 275, `spreadMax` 0.5, `spPctCapital` 2,
  `tolerance` ±0.25 pt = on target. `normalizeGuidance` folds settings saved as ranges (low end; payroll
  the middle). Per region: `app_meta.guidance` (migration 017); `PUT /guidance` (admin); Settings →
  Budget guidance. `/state.guidance`; `lb.guidance`.
- Tie card: the grey number in an EMPTY target box is the guidance number for that row (rental / total
  income / utility + other income → income %, every expense category and OpEx → expense %, RE taxes,
  payroll, insurance as the $/unit rate over the T12 category). **fill N blank** (`guidanceFill`) writes
  those numbers into the empty boxes only — typed boxes and NOI are left alone, nothing ties until tie.
- Editor: guidance lives IN the tie card's Target column (Troy 2026-11-11: "there is literally a target
  box, why would you create a whole new pane" — never a separate card). An empty target box shows the
  guidance range as its placeholder (Total Income, Total OpEx, NOI, RE & PP taxes, Payroll) and Δ% is
  green inside it / red outside until a target is typed; a typed target still wins and drives "tie".
  Only while the card compares to the T12. The checks with no row of their own (NOI vs the 2026 budget,
  expense spread, March vs October, insurance, SP, rental income by quarter) are one line each under
  the table (`guideNotesHtml`). Must-hold misses join the pre-export check (`exportIssues`). Dashboard: Guidance column (NOI / income / expense growth, red =
  NOI down or below the current budget, amber = a range missed; `b.dash.guide` built in `/state`).
- Ties: the tie card's Total Rental Income (`rental`) and Total Income (`income`) rows now take a target.
  `POST /budgets/:id/tie-growth {pcode, pct, lever}` — Troy picks the lever each time (popover):
  `vacancy` scales the monthly vacancy % (shape kept), `gpr` solves the market-rent steps. Secant
  passes on the measured response. A target the lever cannot reach is REFUSED (400, nothing saved):
  with loss to lease following GPR (per-lease burnoff) most of a market-rent change lands in loss to
  lease, so GPR alone often cannot move rental income (verified on clnd: +3% unreachable by GPR,
  reached by vacancy in 2 passes). The lever used is remembered in `inputs.tieLevers`; "tie all" uses it
  and skips a total that has never been tied by hand. Never automatic.

**New budget dialog is template-first again** (Troy 2026-11-11: "Why do I still need to upload the T12
statement and T12 Budget when the budget template has them? We already fixed this once"). d5ebf92 made
it template-first; 9a80730 (next day) put the two statement pickers back on top, called the template
"optional", and pre-picked any separate statement, which then REPLACED the template's own T12 / budget.
Now: the template is the one file; the statements sit in a collapsed "No template?" fallback and are
never pre-picked when the property has a template. The dashboard property checklist shows ONE required
item (the template, with its T12 and budget periods) when a current template is on file; the two
statement items only appear without one. Server side (POST /budgets fills both from the template via
`stmtsForTemplate`) was already right. Don't re-add statement pickers above the template.

## 2027 Budget notes pass (Troy 2026-11-11, "agreed on all")

From a review of the KB page `Sources/2027 Budget notes.md` against the engine. All annual-mode,
all in `shared/annual.ts` (pure, tested in `test/annual.test.ts` "2027 notes pass"), `ENGINE_VERSION`
2026-11-11a. Every piece is opt-in per budget except the three data fixes and the TPND default.

- **Contracts & known costs** (`inputs.contracts`, `Contract` in domain.ts; `contractMonths`): vendor,
  GL, kind `monthly` (per month or season `total` over ticked months) | `annual` (one invoice in
  `billMonth`) | `perUnit` ($/unit/yr over the billed months), optional escalator (`stepMonth` +
  `stepPct`), `mode` replace (default: the contracts ARE the line) | add (on top of the formula),
  `source`. Applied after every other formula and BEFORE the management fee (a commercial lease is
  in the fee basis). Driver `contract` (chip CONTRACT / CONTRACT+). Year-1 plan months still win.
  Editor: More → Contracts & known costs… (`openContracts`; client mirror `contractCal`, keep in step).
- **One-time items out of the T12** (`inputs.t12Adjust` [{gl, month 1-12, amount, note}];
  `applyT12Adjust`): removed from the posted month at the top of `generateAnnualLines`, so shapes,
  growth, % of GPR / wages and the flat-fee base all read the normalized history. The grid's T12
  column still shows what posted; the line's driver carries `oneTime` (second chip −1X). Editor: More →
  One-time items out of the T12… (`openOneTime`).
- **Flat-fee package schedule** (`inputs.utilities.feeSchedule` {fees by bedroom, units by bedroom,
  onFlatPct, convertFrom}; `flatFeeFromSchedule`): income per occupied unit = share × F + (1 − share) × R,
  F = unit-weighted package fee, R = what a RUBS unit paid in the last actual month (backed out of
  onFlatPct), share ramps as leases (rent-roll `leases`) end from `convertFrom`; × budgeted occupancy;
  split across the reimbursement GLs by the last actual month's mix. Chip FEE SCHED. Without a
  schedule the old last-month rule stands. Editor: More → Flat-fee package schedule… (saving turns
  `utilities.billing` to flat).
- **Journal split** (`inputs.allocOut` {to, pct, gls}; `ALLOC_OUT_DEFAULTS` tpnd → tpndc 41.11% on
  6604 6614 6620 6622 6108 6112 6116; `allocOutFor`): the property keeps (1 − pct) of ENGINE-built lines
  on those GLs (`ALLOC_ENGINE_METHODS`: corpRate, mgmtPct, contract, suggested). History-based lines are
  left alone on the reading that the recurring journal already posts them net (not verified against
  TPND statements: none were on file locally). Driver `allocOut` {to, pct, gross, out}, second chip.
  `inputs.allocOut: null` turns it off. TPNDC's own budget is not generated. Editor: More → Journal split….
- **Required lines** (`app_meta.required_lines`, per region, migration 016; ND seeded with 6917 annual
  fire inspection): `/state.requiredLines`, admin `PUT /required-lines`, Settings card. A zero line
  shows under Defaults in use and in the pre-export check (`missingRequired`).
- **Data fixes** (migration 015 + seeds): 6108 insurance $275/unit/yr from 2027 (`CORP_RATES_2027`,
  client `corpDefaults`; Nov–Dec 2027 renewal not priced, same rate); 6934 SNOW REMOVAL CONTRACTOR on the
  new `snowContract` curve (flat Nov–Apr; 6818 keeps `snow`); 6381 renamed ANNUAL REGIONAL/PORTFOLIO
  EVENTS; CLND property units 340 (budgets keep their saved units).
- Settings → Properties: names are now editable too (admin, Enter saves) — needed for the KC East sites.
- Excel export: `driverLabel` names contracts, one-time removals and the split.

## The domain model (how a budget is built)

- **gl_accounts** — canonical Monarch chart of accounts. Generated by `scripts/gen_coa_seed.py`
  from the real Yardi upload CSV (order, the 335 uploadable posting accounts) + the FHND budget
  workbook (names, display order, 26 total + 23 header rows). Each detail account carries a
  **pcode** (UW category: 1, loss, 2–14) and a **curve** (flat/snow/heat/electric/summer/turnover).
  Total rows are NEVER stored — `rollup()` computes the whole Monarch total chain
  (5004→5070→5500→7099→7280 NOI→9000) from detail lines by numeric code range.
- **uw_snapshots.data** — parsed UW book sheet: `y1` ($ per pcode), egi/toe/noi, assumptions
  (vacancy %, LTL %, mgmt % of EGI…), unit mix, T12 panel (seller GLs w/ pcodes). Parsing is
  **label-driven, never fixed rows** (Cottonwood's sheet is offset +20 rows). Income labels are
  matched before EGI, expense labels only after (so "Utilities" ≠ "Total Utility Income", and
  "Less: Loss to Lease" matches by substring).
- **comp_sets.data** — property-comparison rows; per-GL totals across the comp set become
  **allocation weights** inside each category.
- **rent_snapshots.data** — marketMonthly / inPlaceMonthly / units per property.
- **budgets.inputs** (jsonb, `BudgetInputs`) — everything generation needs: GPR base+growth,
  LTL ramp, vacancy % by month, concession/rental-loss/mgmt %, loan/rate/capital, startMonth,
  and **uwAbs** (the $ targets for categories 4,5,6,8–14). Defaults derive from the UW snapshot
  via `defaultInputs()`; edits regenerate.
- **budget_lines** — one row per GL: 12 months (jsonb), driver, override flag, note.

### Generation rules (shared/domain.ts `generateLines`)
| Category | Rule |
|---|---|
| GPR 4994 | rent-roll market $/mo × cumulative monthly growth (anchors to rent roll, NOT UW) |
| LTL 5003 | linear ramp from actual (market−in-place) gap to UW % × GPR over rampMonths |
| Concessions (2), Rental loss (3) | UW % of **budget** GPR; vacancy 5031 gets its own monthly %; the cat-3 remainder goes to bad-debt GLs |
| Utility/Other income (4,5), expenses (6,8,9,10,11,12,13,14) | UW Y1 $ **exactly** (uwAbs), split across detail GLs by comp-set weights (fallback GL per category), spread monthly by each GL's curve — penny-exact largest-remainder everywhere |
| Mgmt fee 6112 (7) | % × monthly total income (recomputed from generated income) |
| Interest 7300 | loan × rate / 360 × days-in-month |
| startMonth > 1 | all generated months before it are zero (mid-year acquisitions) |

**Seller T12 statements** (`t12_snapshots`, upload kind `seller_t12`): monthly operating
actuals per property (seller GL rows `nnnnnn-nnn`, 12 month cols; `-000`/`-999` rows skipped).
**Used ONLY for monthly seasonality, never dollar levels** — Troy's explicit guidance: these are
the old owner's financials; levels will change and land closer to the Minot comps. When a budget
links a T12, `t12CategoryShapes()` (seller GL → pcode via the UW book's coded T12 panel) replaces
the generic curves for categories 4,5,6,8,9,10,11,12; categories 13/14 keep per-GL curves because
they mix opposite seasonalities (snow vs turnover) that the blended category shape would smear.

**Monthly comp sets & the per-unit basis**: the comp-set upload auto-detects the Yardi
*12 Month Budget* / *12 Month Statement* export (Monarch GLs, monthly cols) vs the annual
*Property Comparison*. Monthly comp sets contribute per-GL monthly shapes; comp sets store total
units (Minot 4 = 712). Spread priority per line: Minot per-GL shape > seller-T12 category shape
(cats 4–12) > named curve. Each abs category has a level **basis** (`inputs.catBasis`): `'uw'`
(default, hard tie) or `'perUnit'` (comp $/unit × subject units, UW as variance) — toggled per
category in the tie-out panel; rebalance targets follow the basis.

**ND payroll model** (`payroll_models`, upload kind `payroll`): parses the "North Dakota
Payroll - Ongoing" workbook's Wages sheet. **RESTRICTED-DATA GUARD — the importer aggregates the
roster to property-level totals by wage GL (position→GL: admin-ish→6402, grounds→6405,
rover→6407, rest→6404) and returns ONLY those; names/rates/rows are never stored** (uploads.payload
holds the aggregates, not the file). When linked, wage GLs come straight from the model (spread by
the Minot per-GL cadence); the rest of category 10 (taxes/benefits/fees) follows the basis —
under 'uw' the remainder is allocated so cat 10 still ties exactly (floored at 0 if wages exceed UW).

**Tie-out policy (Troy, 2026-08-20)**: NOI must tie **100%** to UW — `tieNoiToUw()` scales the
non-overridden lines of the flex categories (`DEFAULT_NOI_FLEX` = 9 admin, 11 marketing, 13 R&M,
14 rehab) at (re)generation (`inputs.tieNoi`, default true) and via the "tie NOI" button.
**Total Income also ties at generation** (`inputs.tieIncome`, default true; "tie income" button):
GPR stays anchored to the rent roll at the start month, `tieIncomeToUw()` adjusts loss-to-lease
(spread ∝ GPR) so EGI hits the (prorated) UW EGI. Category totals only need to be *in line* —
they show variance, they are not forced. Payroll benefits/bonuses = **Minot ratio × subject wage
total** (`burdenRatio` driver); cat 10 floats vs UW (UW-remainder fallback without a comp set).

**Ownership year (the core frame, Troy 2026-08-20)**: a budget IS UW Year 1 — 12 months starting
at `inputs.startMonth` of `inputs.year` (Aug 2026 → Jul 2027 for an August close). Month index 0 =
the start month; seasonal calendar shapes are rotated into ownership order (`rotate12`), interest
day-counts are calendar-aware, GPR anchors to the rent roll in month 0. **The full window ties to
UW Y1 100%** (income via LTL, NOI via flex) — no proration anywhere. Yardi uploads are CALENDAR
slices of the one plan (`calendarSlice`): `export.csv?calYear=2026` → Aug–Dec (a Revision that
replaces the seller budget), `?calYear=2027` → Jan–Jul (an Upload; Aug–Dec 2027 stays zero for the
normal fall budget cycle). Grid columns are labeled Aug-26…Jul-27 (`monthLabels`). startMonth=1
degenerates to a plain calendar year.

**Row quick tools** (the "Fx" chip on every detail row): zero out, flat annual, flat $/mo,
start-$ + %/mo growth fill, Minot $/unit × units with its seasonal shape, reset to engine.
All write overrides via PUT /budgets/:id/lines/:gl.

**Editor UX (2026-08-21)**: every detail row shows a colour-coded **Fx chip** naming its formula
(drvMeta in app.js), and the month cells carry the same fill — green rent-roll/income, amber UW
tie, blue Minot comps, violet payroll, teal %-of-income, gray interest, pink manual override —
with a legend above the grid. Tie-out panel lists Total Income (EGI) as an income subtotal
(after Other Income), TOE/NOI at the bottom. **Dark mode** via CSS variables on
`[data-theme=dark]` (topbar 🌙 toggle, localStorage `bt-theme`). **Column picker** (▦ Columns)
hides/shows Fx, each month, Year 1, $/Unit, Note (localStorage `bt-hidecols`; cell edits are
hidden-column-safe — months come from line data, only the edited index changes). **Undo** (↶):
client keeps up to 25 pre-mutation snapshots per budget; POST /budgets/:id/restore writes a
snapshot back verbatim (no regeneration, no ties).
**Inline formula boxes (`paramFor` in app.js, 2026-11-09):** a chip's single input sits on the row
(`input.fxp`, Enter → PUT inputs → regenerate). A formula with several inputs gets the GPR
treatment instead: `paramFor` returns `{ title, summary, multi: [{k, short, unit, label, value, patch}] }`,
the row shows a summary button (`button[data-multi]`, e.g. "renew 65% · burnoff 75% / 100%") and
`openMultiParams` opens a `.rowmenu.multi` popover with one labelled box per input, Cancel and
Save & regenerate (Troy: "if there are multiple inputs, I should not need to go into settings…
should look like the GPR section"). Save folds only the changed boxes into one PUT, re-deriving
each patch against the inputs-so-far so the last patch carries every change (the server merges
inputs shallowly). Multi today: **LTL 5003** — renewal %, burnoff on renewal %, burnoff on move-in %
(flat mode: start $/mo; ramp: start, target %, months; method + "follows GPR" stay in Assumptions),
**corpRate** ($/unit/yr + $/mo), acquisition **interest** (loan $ + rate %). The LTL chip label
names the method in use.

**Loss to lease (Troy, 2026-08-21)**: per-lease burnoff (`ltlMonths` in domain.ts) — each lease's
LTL changes only in its turnover month; renewals keep `1-burnoffRenew` (default: burn HALF), new
move-ins burn `burnoffNew` (default all). Which expiring leases renew is chosen by `renewalPct`
(default 70%), sorted so the LARGEST-LTL leases renew first (deep discounts renew; GTL/low-LTL
leave). Needs per-lease data: the unit-level rent-roll parser now stores `leases` [{m, r, e}] on
rent snapshots (summary rolls have none → linear-ramp fallback, `inputs.ltl.mode`). The income tie
now SCALES the LTL row (shape preserved) instead of spreading additively. PUT /budgets/:id also
accepts snapshot ids (rentSnapshotId etc.) to relink data without recreating the budget.

**HAP is not loss to lease (Troy 2026-11-11: "a very critical issue with the way this is dealing with
HAP rent")**. On a HAP unit the roll's `rent` charge is only the resident's share; the housing
authority's share is the `subsidy` charge, budgeted on 4996 HAP VOUCHER RENT (charges × 12). The unit's
market − rent gap is therefore mostly subsidy. Before this fix the per-lease model burned that whole
gap at renewal / turnover (and, being the largest gaps, HAP units renewed FIRST) while 4996 still
budgeted the subsidy: income counted twice — about $126k/yr across BCND CLND CWND ECND SPND TCND on the
stored rolls (SPND ~$51k, CWND ~$44k). Now each lease carries `s` (its subsidy, `Lease.s`; the
lease-charges parser stores it, and keeps a fully-subsidized $0-rent unit as a lease); `ltlModel`
holds `s` out of the burnable gap (burnable = market − rent − s). Rolls stored before the fix have no
`s`: `withHap` places the property's subsidy total on the lowest-rent leases, each up to its gap
(driver `hapEst`; re-uploading the roll gives exact per-unit HAP). LTL driver carries `hap` / `hapEst` /
`hapUnplaced`; chip LTL·HAP. Both engines (annual and acquisition) use it.
**HAP is rent, inside GPR (second pass, Troy 2026-11-11: "HAP + GPR should equal rent roll GPR. HAP
should basically be treated as GPR/Rent. It should not be offset by LTL.")**: loss to lease is ONLY the
burnable gap (the first pass posted burnable + s, offsetting HAP). When the GPR base is the rent roll
(`inputs.gpr.baseMonthly` > 0), 4994 = the rent roll GPR (× the steps) less the HAP lines 4995 + 4996,
so 4994 + HAP = the rent roll GPR every month (annual: `hapEarly` before the %-of-GPR lines, then
`squareGpr` to the final HAP lines after contracts; acquisition: less the roll's subsidy charge). A
base off the last actual month is already net (the books post 4994 net of HAP). Driver `gpr.hap` /
`gross`; chip ROLL−HAP. Verified on clnd: 4994 488,149 + 4996 1,101 = 489,250 = the roll. Income
totals are unchanged by the presentation; the burnoff no longer touches HAP. 4995 HAP CONTRACT RENT
stays on the last actual month. GPR / rental-income ties work on the gross (4994 + HAP).

**Typed first LTL month (Troy 2026-11-11: "if I manually adjust the first month of LTL, it flows
through the rest of the months off of the new LTL")**: typing ONLY month 1 of 5003 on its live formula
saves `inputs.ltl.month0` (negative $) instead of hard-coding the row; every mode starts there and runs
on — flat / template burnoff / ramp use it as the start, per-lease scales every lease's burnable gap by
k (secant on month 0, `ltlModel` opts.month0; HAP never scaled). Typing other months still overrides as
before. The LTL popover has a "Month 1 $" box (0 = the formula's own start); chip LTL·START.

**Formula chips beside every choice (Troy 2026-11-11: "colored chips … next to different formula options
when picking out")**: `SHAPE_CHIP` (one table) gives each shape its tag — SAME MO, WAVG, T12/12, CURVE,
AVG≠0, LAST, TURNS (curve and active-months both used to read SAME MO). The row shape menu and the row
quick tools (`TOOL_CHIP`: the chip each tool leaves — MAN, ZERO, MINOT, T3, SLR, CY BUD, T12C, LINK,
SMOOTH, WAVG, CORP, %GPR, ENGINE…) show the real chip; `<select>` pickers (section header, Formula for
lines, Default formulas) carry the tag and the chip's colours on each option (`shapeOpt` / `chipStyle`).

**Rent-roll formats** (`parseRentRoll`, 3 branches): Yardi multi-property SUMMARY ("Rent Roll" /
"For Selected Properties" with a `Property` header row); **Yardi multi-property UNIT-LEVEL**
(same title block but a `Unit`/`Unit Type`/`Market Rent`/`Actual Rent`/`Lease Expiration` header —
`parseYardiUnitLevel`: property sections are delimited by "Current/Notice/Vacant Residents" /
"Future Residents/Applicants" markers and closed by a `Total | Property Name(code)` row, which
supplies name + Yardi code; occupied = `t…` resident ids; VACANT/MODEL/ADMIN count as units but
carry no lease; $0-actual resident rows count occupied but stay OUT of `leases` — they'd fake a
full-market LTL; only Current-section rows feed totals; NO charge codes in this format); OneSite
single-property "RENT ROLL DETAIL" (has Lease Rent + charge columns). Fixture
`rentroll-unit-level.xlsx` = the real 8/21/26 all-ND roll (15 properties, 3,305 units, ties to its
own summary block). `POST /uploads/apply {kind:'rent_roll', relink:true}` (UI checkbox, default
on) also points every existing budget of a mapped property at its new snapshot and regenerates —
inputs untouched (GPR base stays), overrides/MROUNDs kept, per-lease LTL activates itself.

**Editable Year-1 totals (2026-08-21)**: the Year 1 column on detail rows is an input — typing a
new annual total rescales the months proportionally (distribution flows backwards from the total;
flat spread if the line was zero), penny-fixed on the largest month, saved as driver
`{method:'setTotal'}` (TOTAL chip). WAVG picker fix: seller-actuals rows sort first, comp rows
display the per-unit-scaled total they'll actually produce, and the MROUND prompt previews the
resulting annual total.

**Formula copier (2026-08-21, "⧉ Copy formulas…" in the editor)**: replays another budget's named
formulas onto the open budget. The formula *recipes* transfer; every one re-evaluates against the
TARGET property's own data — WAVG/Seller-line sources re-match the target's seller T12 by line
name (truncation-aware), T3/Minot recompute from the shared comp set at the target's unit count —
so no source-property references survive. Recomputable drivers copy (`wavg`, `t3avg`,
`sellerLine`, `perUnitComp`) plus standing MROUND multiples (optional, grouped POST /round) AND
**zero-outs** (driver `zero`) — a zero-out is the structural part of the recipe that kills a GL's
engine share; skipping them left the target's engine allocations (commercial ≈ half of cat 5)
alive under the copied values and inflated the category ~2-3× (2026-08-21 PM bug). Dollar values
(`manual`, `setTotal`, flats) are listed as "NOT copied". The copy finishes with a recalc so
ties/rounding/inactive exclusions land consistently.
Preview dialog shows each formula's recomputed Year-1 total before applying; one Undo snapshot
reverses the whole copy. Implementation: shared pure helpers `fc*` in app.js (fcMinot, fcT3avg,
fcSellerLine, fcFindSeller, fcWavgRows, fcWavg) now power BOTH the row quick tools and the copier
— edit them in one place.

**Utilities (Troy 2026-08-21)** — `buildUtilityModel` in domain.ts: cat-12 expense levels come
from the SELLER statements (exception to shapes-only — utilities are property-physical and the UW
itself used T12×growth), each seller line keyword-mapped to its closest Monarch GL
(UTIL_EXPENSE_MAP / UTIL_INCOME_MAP) at the same calendar month × growth. Cat-4 utility income =
**recoveryPct × the PRIOR month's total utility billing** (RUBS in arrears; month 0 recovers the
pre-start month from seller actuals), split across income GLs by the seller's own mix; recoveryPct
null ⇒ derived from the seller income/expense ratio. `inputs.utilities {source, growthPct,
recoveryPct}` — source 'uw' reverts both cats to UW allocation. UW shows as tie-out variance.

**Charge-driven other income (Troy 2026-08-21)** — the unit-level rent-roll parser also captures
ancillary charge-code monthly totals (PETRENT, GARAGE, PARKING, STORAGE…, occupied units only) on
the snapshot; `chargeGlMonthly` maps them to Monarch GLs (pet→5165, garage/parking→5160,
storage→5136…) and those lines take charge × 12 (driver `charges`), with the cat-5 UW remainder
allocated over the other GLs. Needs unit-level rolls (summary rolls carry no charges).

Manual cell edit ⇒ `override=true`; if the line had a formula driver the identity is KEPT with
`revised:true` (chip shows `WAVG*` etc., "cells hand-revised") — only lines with no formula
history become driver `manual` (purple, 🔓 clears). Y1-total edits on a formula line dictate as
`setTotal` with `of:<method>` ("TOTAL on a WAVG shape"). **Overrides audit** (🔓 chip in the
editor legend, "overrides: X formula · Y fixed"): lists every overridden line; MAN lines whose
months all sit in exact $ multiples are flagged as leftovers of the old bulk-MROUND that LOCKED
lines instead of setting standing multiples (RRND's "138 manual overrides" were these) —
"Release" = standing MROUND at the detected multiple + unlock + one recalc, single Undo.
`regenerate()` recomputes only non-overridden lines. `rebalanceCategory()` (the tie-out panel's
"tie" button) scales a category's non-overridden lines so the total hits the UW-derived target,
keeping overrides — with a penny-fix on the largest line.

**Actualized months — the partial-month rule (Troy 2026-09-10)**: after the first
(partial) month of ownership closes, that month is budgeted 1:1 to what posted, so
Yardi's variance reports stop comparing a full-month plan to a part-month of
actuals. Editor button **✓ Actualize month…** → upload the month-end Yardi *Property
Comparison* (Book = Cash, ONE period, Actual/Budget column pairs per property;
`parseComparisonActuals`). `actualizeFromComparison()` (domain.ts, pure) turns the
budget's own Actual column into upload-chart amounts: every detail GL with a
`csv_order` is mirrored; **5006 TENANT RENT → 4994** (`ACTUAL_REMAP` — a new
acquisition's first-month rent posts to 5006, which is not in the chart); sections
`principal` (3080–3091 loan proceeds) and `below_noi` (depreciation/amortization)
are excluded, as are balance-sheet rows (<4000) and the report's subtotal rows —
every exclusion is listed back to the user, never dropped silently. Result lives on
**`inputs.actuals["YYYY-MM"]`** (`ActualizedMonth`: period, book, source, glMonths,
summary); **budget_lines stay the pure plan**. `effectiveLines(lb)` =
`applyActuals()` overlays each in-window actualized month on read (budgetView, all
exports) so the other 11 months stay live on their formulas and the locked month
shows as honest tie-out variance. A **pre-start closing month** (close mid-Aug, plan
starts Sep — the Bismarck/Jamestown case) is outside the 12 plan columns:
`injectPreStartActuals()` writes it into its calendar column of the calendar-year
CSV slice only (+ the Raw Data sheet of the review workbook). Grid: locked columns
get a ✓ header and the `drv-act` fill; an edit inside a locked month corrects the
POSTED figure (PUT lines writes to inputs.actuals, no override); plan edits never
absorb a locked month's shown value. "Release" (in the dialog) deletes the key —
the plan takes the month back. A save point is captured before apply/release; one
Undo reverses (undo snapshots carry `planLines`, never the overlaid view).
Verified end-to-end: the rrnd Sep-start plan + the real Aug-26 ND Cash comparison
reproduces Troy's hand-built "rrnd 2026 Budget Revision TS 09102026.csv" to the
penny (fixture `comparison-northda-aug26.xlsx`).

**Off the Yardi CSV (Troy 2026-09-10 PM — "changes are sometimes made in Yardi; make
sure not to undo them")**: the same rule runs off the budget AS IT SITS IN YARDI
instead of the tool's plan. Dashboard **✓ Actualize from Yardi CSVs…** → one Property
Comparison + N budget CSVs (exported from Yardi, or the files last uploaded).
`parseBudgetCsv` keeps every token verbatim and reads the PROPERTY FROM THE FILE's
header record (never from the UI) — and a Yardi export can hold SEVERAL budgets in one
file (the ND six-site export is 6 × 338 lines): `parseBudgetCsvBlocks` splits at every
`//Budget:` header and each block is revised with its OWN property, then re-emitted in
order as one complete file (a block that cannot be revised goes out unchanged, flagged).
The 2026-09-10 "Meadows" incident was the single-block parser applying MWND's August to
all six budgets; `parseBudgetCsv` now refuses multi-budget files. `reviseBudgetCsv`
(csv-export.ts) rewrites only
the closed month's Amount column — the file's own decimal format is kept, the
description is restamped `<INI> mmddyyyy` (Upload → Revision), and posted chart GLs
with no row are appended — tested byte-for-byte against Troy's hand-built RRND
revision. `POST /actualize-csv` (multer fields `comparison` + `csv[]`) returns every
revised CSV (the client downloads them) and records the actualized month on the
matching budget (same property; CSV year = start year or start year + 1; save point
first). `adopt=1` (dialog default ON) also copies the CSV's other in-window months
onto plan lines that differ (override, driver `yardiCsv`, YARDI chip) so a later
export from the tool cannot undo Yardi-side edits. Fixtures:
`rrnd-budget-yardi-export-2026.csv`, `rrnd-budget-revision-aug26-hand.csv`.

## Annual (non-acquisition) mode — `shared/annual.ts` (2026-10-01)

`budget_type='annual'` (`inputs.mode='annual'`): a calendar-year budget for an existing
Monarch property. **Reference = the property's own statements, methodology = the Yardi
budget template** (`budgetYSR<year>_budget_<id>.xlsm`). Tables: `stmt_snapshots`
(kind actual|budget; `{monthCal, monthYear, rows[{gl,name,months,total}]}` — columns land on
calendar months via `stmtCalendar`, the T12 is Jan–Oct this year + Nov–Dec last year exactly as
the template's PriorFinancials anchors say) and `template_snapshots` (`TemplateData`: debt
schedule, mgmtFee {actualPct, matrix}, utilForecast gl→%[12], suggestions gl→$[12] + notes,
leaseGoals/leaseExpirations, renewalPct/burnoffs/gprPct/vacancyPct, mortgage, distHist,
softwareFixedMo, moveOuts {scheduled, unscheduled} from the 2027 template's MoveOuts sheet,
lastActual, pyYears). Budget FKs: `py_stmt_id`, `cy_budget_stmt_id`,
`template_id`. `routes.ts`: `loadBudget` builds `actualCal/budgetCal/lastMonth/template`,
`ref` (= `refFromCalendar` of T12 / CY budget / typed targets per `inputs.refSource`) and
`refs` (`refColumn`: annual $ by GL + Monarch totals for T12, CY budget, 4-mo annualized);
`refOf(lb)` is what every tie / tie-out / rebalance uses in place of the UW. `buildLines`
branches to `generateAnnualLines` / `regenerateAnnual` (shared `mergeFresh`). Uploads:
`POST /uploads/parse-many?kind=yardi_template|statement` (multi-file) → `/uploads/apply`
creates the statements + template (and the property if new), optional relink of the
property's annual budgets. `parseYardiBudgetTemplate` never reads "Paste Payroll Here".
2027 template draft (Nov 2026): 6331's fixed cost is read from column D of its row (0 = actuals;
the 2026 "$275/month" note still works), MoveOuts is carried as a reference (settings page
under the expirations input, Raw Data in the export), and 6112 is % of the PRIOR month's total
income — January on December's CY-budget income (its own income when no budget is linked).

**Foundation rules**: `seed/annual-rules.json` (gl → `{method same|wavg|flatT12|last|engine…,
mround, factor, noThreshold}`) extracted from the GRKS 2026 RMC draft by
`scripts/extract-annual-rules.mjs`; loaded by `src/annual-rules.ts` (`loadAnnualRules`, cached) and
passed as `AnnualSources.rules`. `generateAnnualLines` → `baseline()` precedence: per-GL inputs
(`baseline.glShape/glGrowth/glMround`) → rule → built-in sets (`LAST_MONTH_FLAT_GLS`,
`FIXED_ANNUAL_GLS`, `TEMPLATE_GL_PCT`…) → `baseline.shape` / `growthPct`. Conservice forecasts
apply only with `baseline.useUtilForecast`. Driver carries `rule` for the chip label.
**Factor precedence (2026-11-05 fix):** `glGrowth[gl]` → a category % the user TYPED
(`baseline.growthPct[pcode]`; blank box = unset, `defaultAnnualInputs` stores `{}` and migration
009 strips untouched defaults) → the rule's factor → `TEMPLATE_GL_PCT` → typed `'*'` →
`TEMPLATE_CAT_PCT`. Before this the GRKS factors outranked the Assumptions boxes (R&M +25% moved
cat 13 by 4%). **Real estate taxes (6116)** = trailing-12 total ÷ 12 flat (`FIXED_ANNUAL_GLS`, rule
`fixedAnnual` maps to the same), never October × 12 — the template's rule put clnd's 2026 taxes at
407k vs 471k T12 / 517k loaded. Remaining `last`-shape lines get `driver.lastDev` (chip ⚠LAST) when
the last month is >25% off the T12 average (`LAST_DEV_WARN`).

Drivers added: `baseline {src, pct|pcts, shape actual|wavg|flat|curve|last|avgnz, mult, base, rule}`,
`pctGpr {pct, of gpr|netgpr|net, basis last|t12}`, `recapture`, `perTurn {amount, turns}`,
`suggested`, `corpRate {perUnitYr, flatMo}`, `debtService {kind interest|principal}`. Inputs
added: `baseline {source, growthPct by pcode ('*' default), glGrowth, glShape, shape, mround}`,
`pctGpr`, `expirations[12]`, `turnFees`, `corpRates`, `suggestionGls`, `refSource`, `targets`,
`ltl.followGpr`. Rule tables live at the top of annual.ts (`CORP_RATES`, `LAST_MONTH_FLAT_GLS`,
`TEMPLATE_GL_PCT`, `TEMPLATE_CAT_PCT`, `TURN_GLS`, `FLAT_T12_GLS`, `AVG_NZ_GLS`,
`DEFAULT_SUGGESTION_GLS`, `BASELINE_SKIP_SECTIONS`). Client: `annualInputsHtml` /
`applyAnnualInputs` / `openShapeMenu` / `renderAnnualUploadPreview` (end of app.js); grid ref
columns `ref1/ref2`; tie card reference picker; `drv-base` / `drv-corp` fills. Workbook:
`ReviewArgs.annual/refs/template` — Budget tab's UW/comp slots hold T12 Actuals / CY Budget,
Summary keeps rows A–H (Portfolio tab compatible) + columns I–L (CY budget, Δ, 4-mo
annualized, % change). Tests: `test/annual.test.ts`.

## Exports

- **CSV** (`src/csv-export.ts`): reproduces the real Yardi ETL format byte-for-byte
  (test: round-trip vs `test/fixtures/phnd-revision.csv`). Always the full uploadable chart in
  csv_order, including zero rows. `?cutoff=N` zeroes months 1..N for mid-year revisions.
- **XLSX** (`src/xlsx-export.ts`): Budget sheet re-creates the total chain **as live formulas**
  (range totals + composite totals + NOI/NIBD/NPL), Summary = tie-out vs UW, Raw Data = inputs,
  UW categories, nonzero lines with drivers (org rule: show the work).

## API surface (src/routes.ts)

`POST /login /logout`, `GET /auth/status`, `GET /state` (coa+properties+lists),
`POST /uploads/parse?kind=uw_book|rent_roll|comparison` (multer, returns preview),
`POST /uploads/apply` (mappings → snapshots), `POST /budgets` (create+generate),
`GET/PUT /budgets/:id` (PUT inputs ⇒ regenerate), `PUT /budgets/:id/lines/:gl`,
`POST /budgets/:id/recalc | /rebalance {pcode}`, `DELETE /budgets/:id` (admin),
`GET /budgets/:id/export.csv?cutoff= | export.xlsx`,
`POST /budgets/:id/actualize` (multer: one-period Property Comparison → inputs.actuals), `DELETE /budgets/:id/actualize/:key` (release),
`POST /actualize-csv` (bulk; property from each CSV header → revised CSVs + recorded months),
`POST /budgets/:id/import-draft` (multer), `POST /properties` (admin upsert), `PUT /gl/:code` (admin: pcode/curve/active).

## Tests (vitest, `npm test`)

Real-file fixtures in test/fixtures (gitignored): Bismarck UW must parse to portfolio
EGI 11,918,258.14 / TOE 4,612,425.47 / NOI 7,305,832.67 (+ per-property, + offset Cottonwood);
Jamestown NOI 2,945,260.70; rent roll → 6 properties, 848 units, cwnd 433,530/mo;
Minot 4 comparison → clnd/spnd/tcnd/tpnd/tpndc; CSV byte round-trip; domain: penny-exact
allocation, rollup chain, category tie-outs, rebalance-preserves-overrides, startMonth zeroing.

**Commercial-rent contamination (2026-08-21 PM)**: the Minot comp set carries **$1.07M
COMMERCIAL RENT (5118)** + COMM CAM/TAX recoveries (5183/5185) — roughly half the cat-5 weight —
which comp-weight allocation kept assigning to subject properties with no commercial space
(re-filled on every regenerate once the zero-overrides were released). Fix: `categoryItems`
excludes GLs with `active=false`; Settings → COA now has an admin **Active** checkbox (weight
re-spreads over active GLs, category still ties to UW; CSV still exports inactive GLs as zero
rows). Deactivate 5118 + the COMM recovery GLs for the ND subjects. **Deactivation is FINAL**:
`regenerate()` zeroes an inactive GL even when overridden, and the grid never hides an inactive
row that still carries dollars ("inactive — recalc to zero" badge) — stale values can't inflate
totals invisibly. The overrides-audit "All" button skips zeroed lines (releasing one would let
the engine refill it); zeroed rows are labeled in the dialog.

## Pay-rates tab — raise cycles (2026-10-29, Troy)

RMs enter raise %'s per employee-seat off the webpage; approved numbers flow into the
budgets' wage GLs. Modeled on the per-property sheets of the Payroll Budget Workbook.

- **Per-seat pay IS stored** (Troy sign-off 2026-10-28 — supersedes the aggregate-only rule
  FOR THIS AREA ONLY; the old `payroll` upload stays aggregate). Tables (008):
  `staffing_snapshots` (roster: key/name/position/payMethod/payRate/benefits/allocations),
  `raise_cycles` (label, `effective` 'YYYY-MM', snapshot), `raise_iterations`
  (**per REGION** = `properties.market`, Troy 2026-10-29 — each region drafts/finalizes/
  starts its next iteration independently; unique (cycle, region, num); `prop_status` jsonb),
  `raise_entries` (iteration × person → pct, stamped `updated_by/at`). `app_users.sites`
  jsonb scopes non-admins to their properties (admin-set in the tab).
- **Access, three layers** (`src/payroll.ts`, mounted at `/api/payroll` ahead of the main
  router): app login → **payroll password** (`PAYROLL_PASSWORD` env; session
  `payrollAuthed`) → **RM-pay masking**: seats in Regional positions (`isRmPosition`) are
  stripped of every pay figure server-side for anyone outside `RM_PAY_USERS` (env, default
  Troy Steiss + Riley Combs — auth.ts `canSeeRmPay`); masked viewers get per-property
  `hidden` aggregates per iteration so totals still reconcile. Note a lone RM allocation at
  one property is arithmetically recoverable from the subtotal — accepted (Troy saw the
  mockup note).
- **Staffing data** — `parseStaffingReport` (importers.ts) reads TWO shapes: the HRIS
  roster export ("Dictionary of Employees" columns + optional "Allocated Employee Data"
  split sheet, .xlsb payroll budget workbook included), and **THE staffing report (Troy
  2026-10-30): "North Dakota Payroll - Ongoing.xlsx"** — the Splits/Wages grid (rows =
  position | name, columns = MIMG + per-property allocated annual $, Hourly/Annual rate
  cols; allocation % = each property's $ share; Splits sheet preferred as current-year).
  Parsed AND stored in ONE call — `POST /payroll/staffing` (admin, behind the gate) — so
  no API response ever carries the roster back out; the same drop also refreshes the
  wage-aggregate `payroll_models` row when the file carries a Wages-style sheet, so the
  one workbook is never uploaded twice. The generic Data-page parse 400s 'staffing' and
  points at the Payroll tab. Off-portfolio rows are dropped at store time; coverage is
  ALL tracked properties, comps included (the Minot sites are budgeted for payroll).
- **Salaried staff — the TITLE rule, final (Troy 2026-11-02: "All PMs are Salary")**:
  `isSalariedPosition` — Regionals, PMs (Property / Area / Dual-Site) and the LMS are
  salaried; assistants and site staff are hourly. (A check-history heuristic was tried and
  REVERTED — leave/partial periods make salaried checks vary; don't bring it back.)
  `normalizePayBasis` enforces the rule when snapshots are READ (loadSnapshotPeople), so a
  rule fix reaches already-loaded data with NO re-upload — Troy explicitly doesn't want to
  re-drop the reports for every fix. Hourly↔Salary conversions ×/÷2080 (= the workbook's
  ×40×52). payMethod Salary stores the ANNUAL as the rate; salaries keep the exact raise %
  (no 25¢ MROUND — that's hourly only).
- **RM corporate share** (Troy 2026-11-02): MI (corporate) covers 30% of every Regional
  Manager's pay — `normalizeRmCorporateShare` (RM_CORPORATE_SHARE = 0.30) rescales an RM's
  property allocations to total exactly 70%, mix preserved, applied on READ beside
  normalizePayBasis (no re-upload). The ⇄ tooltip on RM rows notes "MIMG corporate 30%".
- **Payroll detail report** ("_PayrollReports_Detail_…", one row per PROPERTY SLICE of
  each check — a person's true check gross is the SUM across properties at one check
  date): dropped WITH the ND workbook or later on its own. `parsePayrollDetail` takes each
  person's canonical Job Title, Booked-To GL, check-history basis and `lastGross`;
  `applyStaffingDetail` (shared, pure; `sameName` tolerates middle names/short forms/
  parenthetical notes) folds them on — titles replace the terse ones, `StaffingPerson.gl`
  beats the position mapping in annualWagesByGl, hourly↔salary flips convert the rate
  (×/÷2080), and **a salaried person's CURRENT pay = latest check × 26** (bi-weekly;
  `PAY_PERIODS_PER_YEAR`) so promotions beat the workbook's stale annual.
  `POST /payroll/staffing` takes `files[]` (≤4); detail-only drops enrich the LATEST
  snapshot into a new one. Unmatched people (OPEN seats, renamed staff) keep workbook data.
- **Two wage buckets** (Troy 2026-11-02): office → 6402 ADMIN wages, maintenance (rovers,
  housekeepers, grounds included) → 6404 MAINT wages. Nothing maps to 6405 or 6407 any
  more; apply writes a ZEROED base over all four wage GLs so a stale payroll-model 6407
  can't double-count underneath.
- **Math** in `shared/payroll.ts` (pure, test/payroll.test.ts, synthetic fixtures ONLY):
  `POSITION_GL` (moved from importers — one source), `seatMonthly` (2080 hrs/yr),
  `raisedMonthCount` (proration from the effective month), `annualWagesByGl` → the
  `inputs.wages` map, `maskPeople`, `hiddenAggregates`, `marginalBurdenPct` (grid's
  burdened-Δ ESTIMATE — FICA+SUTA+WC; real taxes stay with the engine).
- **Lifecycle**: iteration 1 per region at cycle create → entries upsert (finalized ⇒ 409;
  RM seats allowlist-only; non-admins only at their sites) → finalize (admin, stamps) →
  next iteration copies entries and is compared against its base in the UI ("was X%").
  **Apply** (admin, finalized): per property, `annualWagesByGl` → merge into that year's
  budget `inputs.wages` → regenerate (burden ratios/bonuses follow the engine). Targets the
  latest budget of `cycle.effective`'s year per property.
- **Client**: `renderPayroll` + `pay*` helpers in app.js (mirrors shared/payroll math —
  keep in step), region chips → iteration tabs → guardrail cards (3–4% guidance, vs the
  property's budgeted income growth derived client-side from `/state` dash
  `income/(income−egiVar)`) → ONE region table, **each person exactly once** (Troy
  2026-10-30 — pooled staff were repeating under every property), **grouped by the payroll
  workbook's own sections in its own row order** (`StaffingPerson.group`/`ord`, captured by
  parseSplitsGrid from the label column; primary-site fallback when a roster has no
  sections). Snapshots predating group/ord: re-drop the workbook and use the cycle's
  "↻ Use latest staffing" repoint (PUT /payroll/cycles/:id — entries key by person, raises
  carry over). Payroll styles at the end of styles.css.
- **HOME REGIONS (Troy 2026-10-30 — "Shayne should only be on one of the regions")**:
  `homeRegionsOf` (shared/payroll.ts, unit-tested) gives each person ONE region — their
  workbook SECTION's members vote with their allocations (so Minot Support Staff stay
  Minot even when their own split leans elsewhere); sectionless people vote alone.
  ALWAYS compute homes from the FULL roster — a region-scoped subset skews the vote (a
  real bug: the LMS exported in two regions). A person renders/edits ONLY in their home
  region's chain (entries PUT and imports 409/skip elsewhere); other regions read their
  raise via each iteration's `foreignRaises` (pct only — no pay data crosses scopes) so
  property cards and apply stay whole. Apply merges: home people from the applied
  iteration, foreign-home from their own region's latest chain.
- **"All regions" view** (region chip `*`): everyone once, workbook sections, each row
  editing its own home-region latest iteration (per-row lock when that region is
  finalized); no finalize/apply/status there. Cycle-wide Excel:
  `GET/POST /payroll/cycles/:id/export.xlsx|import` (each region's latest iteration;
  import routes each row to its home chain).
- **Excel round trip** (`src/payroll-xlsx.ts`, layout = Troy's own draft 2026-11-02):
  workbook = **Combined first** (its Raise % cells are `='<RM sheet>'!J<row>` cross-refs),
  then **one sheet per RM** — the Regional with the biggest allocation in each region;
  regions sharing an RM share a sheet named by their FIRST NAME (Holly / Brittanee / Gail),
  ordered like the source workbook — then Raw Data. Columns A–K match his draft (Raise %
  stays the J input, green); added: **L Adj %** (the raise actually paid), M Δ wages/mo,
  N Δ burdened/yr, **O Annual wages / P New annual**. **Hourly new rates MROUND to 25¢**
  (`newRate`/`adjustedPct` in shared/payroll — the APP's math too: grid, cards,
  annualWagesByGl, hidden aggregates). J4 = **weighted-average increase** (Σ Δ wages ÷ Σ
  wages; every totals row shows it in the Adj % column), per-REGION totals rows + grand
  total, every formula carries a cached result. `assembleRaiseExport` (payroll.ts) feeds
  both export routes. **RM pay is masked on EVERY export and RM rows refused on EVERY
  import, allowlist or not — files travel**; masked slices ride as per-region aggregate
  rows. Import reads Key + Raise % from EVERY sheet, typed values beating Combined's
  cached formulas; "no entry yet" counts as 0% so re-imports don't restamp authors.
- **All regions is the landing view (Troy 2026-11-10)**: `S.pay.region` starts at `'*'` and
  `loadPayCycle` falls back to it; the All regions pill is first. The view shows each region's
  latest iteration and state, and admins get **Finalize the N draft regions** →
  `POST /payroll/cycles/:id/finalize-all` (finalizes every region's latest un-finalized
  iteration; already-final regions untouched). Apply / start-next-iteration stay per region.
- **Import rules from the first real RM round (2026-11-10)** — `parseRaiseImportDetailed`
  (payroll-xlsx.ts) returns `{ pairs, zeroSkipped, fromNewRate }`; both import routes report the
  two counts. (1) **A 0 / blank Raise % is "not filled in"** and is left out: every exported file
  carries 0 for everyone and each RM fills only their own sheet, so importing one RM's file used
  to write the other RMs' people back to 0. To set someone back to 0%, type it in the app.
  (2) **A New rate typed over its formula is read as a raise**: with Raise % at 0, raise % =
  New rate ÷ Current rate − 1 (4 dp); a typed Raise % still wins. Hourly rates still MROUND to
  25¢ when used, so a rate typed off the quarter lands on the nearest one. Precedence per person:
  typed Raise % → typed New rate → Combined's cached formula. The three RM files can be imported
  in any order through the "All regions" import.
- **The WHOLE app wears the Monarch skin** (Troy 2026-10-30 — he wants nothing of the old
  chrome): `body.monarch` in index.html rescopes the theme vars app-wide (cream page, Lato
  + Aleo from Google Fonts, deep-green topbar with gold rule/active nav, blue headings;
  green-tinted dark palette). The old `:root` palette survives only as the fallback under
  the overrides — don't restyle against it.
- Remember `src/payroll.ts` + `shared/payroll.ts` in the esbuild entry list (done).

## Flat-fee utility billing (Troy 2026-11-09)

BCND bills residents an in-house flat utility fee per occupied unit; PHND and FHND moved off
Conservice RUBS to the same model in fall 2026 (KB case 2026-08). On such a property the
reimbursement income (pcode 4: 5164–5174, not 5122 HAP) is not history-shaped: set
`inputs.utilities.billing = 'flat'` (Assumptions → "Utility reimbursements") and each line =
the most recent actual month × (1 − budgeted vacancy that month) ÷ that month's actual
occupancy (|5031| ÷ 4994, floored at 50%), flat, no GPR link — so it ties to the vacancy
assumption. Driver `flatFee {base, lastMonth, occLast, pct}`, chip FLAT FEE; the row's box is a
fee-increase % (`baseline.glGrowth`). **Site default** (`FLAT_FEE_PROPERTIES`, `flatFeeBilling()`): BCND, PHND and FHND are flat-fee unless the budget's `utilities.billing` says otherwise; every other site is RUBS / history. `budgetView.flatFeeSite` lets the Assumptions select show which is the default.

**Enter on an inline assumption box** (`input.fxp`) applies the value and lands on the next
row's box (`focusFxpAfter`); an unchanged value just moves on. The Assumptions dialog's
category % boxes hop the same way.

## Editor view pass (Troy 2026-11-09)

- **% by quarter**: More → "% distribution on totals — by quarter" (`S.showQDist`, localStorage
  `bt-qdist`) adds a `tr.dist.qdist` row under every total: one cell spanning each quarter's
  visible months (the % is the whole quarter's even when a month column is hidden). Independent of
  the by-month row (`S.showDist`). Quarters are the budget's own month order (Q1–Q4 on a calendar
  year, "Aug-26–Oct-26" style on an ownership year).
- **Prior-year T12s on the trend chart** (Troy 2026-11-11: "drop in prior year T12's, and have them map
  out to the NOI comparison chart as a different colored dotted line"): drop the older 12 Month
  Statements on the Data page; `loadBudget` composes the T12 windows ending 12 / 24 / 36 months before the
  current one (`composeT12(..., back)`, only windows with every month on file — no gap filling) into
  `lb.priorT12` → `summary.priorT12` (budget-month order). `trendSvg` draws each as a dotted NOI line in its
  own colour (purple / orange / teal) with a legend; they share the axis. Uploading an OLDER actual
  statement with "relink" never repoints a budget off its newer T12 (`/uploads/apply` compares ends).
- **Trend chart axis** (`trendSvg`): fitted to the plotted values on round gridlines (1 / 2 / 2.5 /
  5 × 10ⁿ steps), NOT anchored at zero — this reverses the earlier "always includes zero" rule at
  Troy's request. A zero gridline, when in range, draws solid.
- **T3 annualized**: `loadBudget` adds ref `ann3` (`annualizedFromCal(actualCal, lastMonth, 3)`,
  period "Aug–Oct actuals × 4", plus `cat {y1, egi, toe, noi}` from `refFromCalendar`). Grid column
  "T3 ann" right after T12 (`cols.ref3`, column-picker key `ref3`; `refBlank` fills the reference
  columns on rows without figures); compare card column after the reference (`table.t3` tightens
  the card). Reference only — ties and Δ% still run against the chosen reference. Annual budgets
  only (acquisition budgets have no own T12). `ann4` (4-mo, the workbook Summary) is unchanged.
- **Property role** (`properties.role` subject | comp) only drives client lists: the dashboard
  Properties card, the New budget dialog's property picker and the payroll-model preview. Nothing
  server-side reads it (comp sets are uploaded data). Migration 010 made the Minot sites (clnd,
  spnd, tcnd, tpnd, wynd) subjects — they are budgeted here as well as being the comp set; tpndc
  (0-unit commercial) stays a comp. Admins change a role under Settings → Properties (select,
  saves on pick via POST /properties). Keep migration files ASCII: the local dev database is
  WIN1252 and rejects other characters.
- **Corporate rates by year** (`corpRatesFor(year)`, shared/annual.ts; client mirror `corpDefaults`
  in app.js — keep in step): the 2026 constants (`CORP_RATES`) plus `CORP_RATES_2027` from 2027
  on. 6310 = $58.17/unit/yr + $513/mo per the Payroll Budget Workbook 2027 rev2 (6451 folded
  in); 2026 budgets keep $43.14 + $483. A rate typed on a budget (`inputs.corpRates`) still wins.
  The Assumptions dialog no longer saves a box left at the year's default (it used to pin every
  default onto the budget); migration 011 strips the pinned 2026 6310 default from 2027+ budgets.
- **Δ% T12 column** (blended increase, Troy 2026-11-09): right after the year total, every detail
  and total row shows (year total − T12) ÷ T12 (`cols.refpct`, picker key `refpct`, `pctCell` /
  `t12PctText`; signed reference like the compare card; "new" when the line has no T12). Bold in
  the override colour on a hand-adjusted line. It updates LIVE while a row's months or its year
  total are being typed (`liveT12Pct`, before the row saves), so a manual change shows what % it
  comes out to. Annual budgets only.
- **Whole dollars**: month cells and the year-total box DISPLAY rounded dollars; stored months keep
  cents (CSV / workbook unchanged). Display never writes: only a typed change dirties a row, so
  nothing gets overridden or locked by the rounding.

## Payroll template tie-out (Troy 2026-11-09)

Seth Russell's **Payroll Budget Workbook <year>.xlsb** builds a per-property payroll sheet
("Budget Section", or the macro's copy of it: "<Name>: FY 2027 Payroll Budget", property code
in B6, §1/§2 employee lists, §3 the GL × month paste table rows 58–77). The tool uses that
sheet as a **check, not an input**: `parsePayrollTemplate` (importers.ts) reads ONLY §3 — the
header row "GL Code | GL Name | 12 dates" — and never the employee sections (individual pay).
Upload kind `payroll_template` (Data page; `detectUploadKind` picks it ahead of the roster
check since the same workbook carries the HRIS dictionary; one file may yield several property
sheets). Apply stores a `stmt_snapshots` row of kind `payroll_template` for a KNOWN property
only (never creates properties, never relinks); `loadBudget` picks the latest one for the
budget's property + year (`data.year`) into `lb.payrollTpl`, served as `hist.payroll`. Editor:
a reference row under every payroll GL the sheet carries (zeros included), two rows under
**6470 TOTAL PAYROLL EXPENSE** (template by month, Δ budget − template with %), and a toolbar
chip "payroll template Δ" that unfolds the payroll GLs. The budget is never changed by it.
`TEMPLATE_2027_REVIEW.md` §2 documents how the workbook builds each GL.

## Wages follow the Payroll tab by default (Troy 2026-11-09)

"Payroll wages should be coming off of the Payroll tab, with the raise % tied to the payroll
sheet by default." Before this, roster wages reached a budget ONLY through the admin Apply on a
finalized iteration; everything else ran on own trailing-12 wages × a flat 3.5% from March.

- `src/payroll-data.ts` (new; holds the loaders moved out of payroll.ts — `loadSnapshotPeople`,
  `regionOf`, `marketOfCode`, `latestIterByRegion` — so routes.ts and payroll.ts share them
  without importing each other). `rosterWagesFor(code, year)` → `RosterLink | null`: the latest
  raise cycle whose `effective` falls in the budget year, its staffing snapshot, and each
  person's raise from their HOME region's latest iteration — **drafts included** (Troy's call) —
  through `annualWagesByGl` (prorated from the effective month). Returns only wages by wage GL
  (all four present, 0 where the roster books nothing) + cycle label / effective / `draft` /
  per-region iteration state. Null when no cycle is effective that year or nobody is booked to
  the property → the budget falls back to the payroll model / own T12 × `payrollRaisePct`.
- `loadBudget` sets `lb.rosterLink` for every annual budget; `buildLines` uses it unless
  `inputs.wageSource === 'manual'` (decided from the inputs it is GIVEN). Live roster wages
  replace the payroll model and supersede an applied snapshot in `inputs.wages`
  (`wagesFromRoster`); a wage typed on the budget (inputs.wages without that flag) still wins.
  Nothing is written by the link — stored lines move on the next regenerate / Recalc.
- Engine (`AnnualSources.wagesLive`): roster wages get no March step and ignore
  `payrollRaisePct`; driver `{ method: 'payrollModel', roster, live, cycle, effective, draft }`
  (chip PAY, or PAY·draft while a feeding region is un-finalized). A wage GL the roster reports
  as 0 is a SET zero, so the trailing-12 fallback cannot refill it (this also closes that gap
  for the older Apply path).
- Client: Assumptions → "Wages come from" (`#in-wagesrc`: Payroll tab default / own history),
  with the cycle and each region's iteration state; the raise % box is labelled as the fallback.
  `budgetView.rosterLink`. Acquisition budgets are unchanged (payroll model). The Apply button
  still works but is no longer needed for wages to flow. Dashboard: `/state` carries `rosterYears`
  (`rosterCoverage()`: per budget year, the cycle + each property code the roster books staff
  to, with a draft flag — no pay data); `propertyReports`' "Payroll wages" item is on file when
  that covers the property for the budget's year (budget or not yet, unless `wageSource` is
  'manual'), else it falls back to the old test (applied roster / linked payroll model).

- **Raise timing is FIXED (Troy 2026-11-09: "Half of the increase should hit in Feb, and then
  full increase in effect for March. Always.")**: `RAISE_PHASE` / `raisePhase(effective, year)`
  in shared/payroll.ts — January at the old rate, February with half of each person's increase,
  March–December in full. Only the YEAR of the cycle's `effective` matters (later years carry the
  raise all twelve months, earlier ones none); the month on the cycle is ignored. Both
  `annualWagesByGl` (so the Apply path too) and `monthlyWagesByGl` use it; `RosterLink.monthly` →
  `AnnualSources.wagesLive.monthly` and the engine lays wages on that shape — never the annual
  total spread flat (a typed / overridden wage total rides the shape, scaled, penny-fixed on
  December). Burden lines follow each month's wages. Payroll-MODEL wages (no roster) phase
  `payrollRaisePct` the same way in the annual engine. NOT changed: acquisition budgets
  (domain.ts still steps the full raise in March) and wage GLs on the trailing-12 fallback
  (T12 ÷ 12 × (1 + raise), flat). `PUT /payroll/cycles/:id { effective }` exists server-side but
  has no UI — the month no longer drives anything. If the raise entries are 0 there is nothing
  to phase and wages are flat.

## Loss to lease: month 1 is the rent roll (Troy 2026-11-11)

"It should come from the damn rent roll." The per-lease model used to re-price every lease ending between the
roll date and the budget start, every month-1 expiration and the first MTM slot INSIDE month 1, so CLND's
January opened about a fifth below the roll's own loss to lease (local copy: roll −27,446, January −20,805).
Now each month is read before that month's resets: a lease pays its current rent through its end month and
re-prices from the next month, at that month's market (a January end renews into the February step). MTM
leases spread over months 1–11 so each re-prices inside the year. A lease ending in month 12 burns next year.

## Loss to lease: market growth and the burnoff share (Troy 2026-11-09)

Troy, on clnd 2027 (renew 100%, burnoff 0% / 95%, GPR +3% in Feb): "How would LTL get burnt off
if 100% renewal rate and no burnoff?" It did: the annual engine added the market-growth
deepening only on leases that had NOT reset yet (`openMarket`), so every renewal wiped the
growth part of its gap whatever the burnoff %. Fixed in `ltlModel` (domain.ts): `opts.growth`
(GPR[m] / GPR[0]) — each lease keeps its RENT between resets, its gap is measured against the
grown market every month, and a reset burns only the burnoff share of that whole gap (the rent
is re-priced to market − kept gap). So 0% burnoff holds the gap all year, step included; a lease
that reset before a later increase is below market again after it. `openMarket` is still
returned but the annual engine no longer uses it; acquisition budgets pass no growth (unchanged).
The no-leases template path already behaved (burn share × remaining).

## Vacancy: an annual average on a carry-over curve (Troy 2026-11-09)

The input (`inputs.vacancyPct`, one value) is the ANNUAL AVERAGE; the year's 5031 always equals
average × GPR. Where it lands by month is `vacancyByMonth(pcts, exp, gpr, weight, { startPct,
lastMonth })` (shared/annual.ts, tested). The first cut copied the expiration curve 1:1 and Troy
rejected it the same day: "very extreme… not 1:1 correlated. It normally hits the month after,
and vacancy tends to compound and get spread across further when heavy periods are around… if we
just posted 23K in vacancy cost most recently, we likely are not going to fill up over winter all
the way down to 7K." So it is a carry-over chain:

    vacancy[m] = vacancy[m-1] × carry[m] + k × move-outs[m]

- move-outs[m] = the expirations of the month before (the turn-cost lag);
- `VACANCY_CARRY` (calendar months) = the share of last month's vacancy still vacant: 0.85
  Nov–Feb, 0.75 Mar–Apr and Sep–Oct, 0.65 May–Aug. **Judgment values** — the one place to tune;
- the chain starts at the LAST ACTUAL month's vacancy % (|5031| ÷ 4994 posted) and runs through
  the months before January; with no actual it uses its own steady state;
- k is solved so the GPR-weighted average equals the input; an average below what the carry-over
  alone leaves keeps the decay shape, scaled.

With a normal starting point Q1 runs lighter than Q4 (clnd roll, 2.5% average: 1.7% in May to 3.4%
in December). When the last actual month is far above the average, January starts high and the
rest of the year must run low to hit the average — raise the average if that looks wrong.
`inputs.vacancyExpWeight` (default 1; 0 = flat) blends the curve with the flat average
("Vacancy follows move-outs & carry-over %" in Assumptions). Twelve DIFFERENT values = typed by
month. Guard: fewer than nine months with expirations (`VACANCY_MIN_EXP_MONTHS`) → flat. Driver
`{ method: 'vacancy', avg, shaped, pcts, weight, startPct }`, chip VAC·EXP. Annual engine only.

## Prior-period collections follow the previous month's delinquency (Troy 2026-11-09)

"Prior period collections should be based on the previous month's DQ. Higher DQ = higher potential
collections in future months" — and never more than that delinquency ("where would that money
come from??"). 5036[m] = collection rate × |5035[m−1]|; January collects against the LAST ACTUAL
month's delinquency. Rate = trailing-12 collections ÷ trailing-12 delinquency, capped at 100%
(`inputs.collectPct` when typed — the row's box). Driver `{ method: 'collections', pct, startDq,
capped?, t12Rate? }`, chip %PRIOR DQ. With no delinquency budgeted it falls back to the old T12
ratio to net GPR (`pctGpr`). Growth ties no longer scale 5036 directly; it follows 5035.

## Summary tab + per-budget Summary view (Troy 2026-11-10)

> **2026-11-12: the Summary TAB is no longer the Schedule table by region** (Troy: "should look more like the
> 'Budgets' screenshot... all of the items we look at in the property level 'compare to' section, with
> conditional formatting based off of the budget guidance sheet. I do not want different panes, I just want
> different subtotals for each region that act as separators. Make sure all numbers pull through correctly").
> `renderSummary` (app.js) draws ONE `table.sumtbl`: per property (latest budget of the year) the dashboard
> columns (property + units, budget period / overrides / save points, Income, OpEx, NOI, Δ NOI, Δ EGI, Guidance)
> then the compare card's subtotals (`SUM_COLS`: GPR, LTL, Net GPR, concessions, vacancy [income detail, behind
> "Show income detail"], Total Rental Income, Other + Utility, Total Income, the nine expense categories incl.
> the fee, OpEx, NOI), NOI vs the CY budget, CoC, Status, Updated. A **"<region> subtotal"** row closes each
> region (`properties.market`), **"All properties"** closes the table: dollars summed, growth on the sums;
> a subtotal adds like with like (T12-based annual budgets, else UW-based ones; "n of m" shown when mixed).
> View toggle Δ% / Δ$ / Budget $ / T12 $ (`S.sumMode`, localStorage `bt-summode`; detail `bt-sumdetail`).
> Colours: `gin` green = meets the 2027 guidance memo, `gout` red = misses it (`sumGuide`). **Direction-aware**
> (Troy 2026-11-12: "If we are above rental income, it should be green, not red. Reverse is true for expenses...
> If there is not a direct category number, you should easily be able to derive one"): income numbers are
> FLOORS, expense numbers CEILINGS. Rental / total income ≥ incomePct; GPR, net GPR, utility, other, other + util
> ≥ incomePct (derived); loss to lease / concessions / vacancy: share of GPR ≤ the T12 share (derived); mgmt fee
> growth ≤ the row's own income growth (derived); insurance ≤ the $/unit rate as % over the T12 category; RE tax
> ≤ reTaxPct; payroll ≤ `payrollMax` (4%); other categories ≤ `expenseMax` (3.5%); OpEx ≤ min(expenseMax, income
> growth + spreadMax); NOI ≥ noiPct; NOI vs CY budget ≥ 0. `GUIDE_EPS` (0.05 pt) is rounding only. The ceilings
> are new guidance settings `expenseMax` / `payrollMax` (the memo's top of range; Settings → Budget guidance);
> `expensePct` / `payrollPct` stay the fill / tie numbers. The compare card uses the same rules (its GR is
> floor / ceiling; rows with no number of their own use `sumGuide`), and so does `guidanceCheck` (atLeast /
> atMost). Growth is on the SIGNED reference, as on the card (a contra loss that grows reads +). Typed
> per-budget targets are NOT used for the Summary colours. Data: GET /summary adds `cmp`
> (`compareOf`, routes.ts: computeTieout vs `refFromCalendar(actualCal)` for annual — always the T12, whatever
> the budget's refSource — or the UW for acquisitions; KPIs on effective lines; guide scorecard) and the
> region's `guidance`. Verified 2026-11-12: every `cmp` subtotal equals the budget's own tieout to the cent.
> The Schedule table / colour scale / region average panel below now live only in the Excel exports
> (`src/xlsx-summary.ts`) and the per-budget Grid | Summary view.

Modelled on Troy's "Minot 2025 Budget Comps" workbook: its per-property / "Minot Avg." sheet
(the panel) and its "Schedule" sheet (the table). Formatting is copied from the workbook — light
blue `#DDEBF7` for the T12 column and growth over T12, light green `#E2EFDA` for the
T4-annualized column and growth over T4, bold labels, medium outer borders, double rules under
Total Other Income and Rehab / Replace — and is kept in dark mode (`.xsum` forces its colours).

- **Data** (`summaryColumn`, `sumSummaryCols`, `summaryLabels` in shared/annual.ts; `summaryOf`
  in routes.ts → `budgetView.summary`): three columns — T12 (`refs.actual`), last four months
  annualized (`refs.ann4`, carrying the T12's interest as the workbook does) and the budget.
  Rows: 5070, 5190, Total Income; "Fixed Admin Less RE TAXES & MGMT FEE" = 6170 − 6116 − 6112;
  6116; 6112; Admin = 6370 + 6399; 6470; 6570; 6670; 6770; 6870; 6970; 7070; Total Expense; NOI;
  7300; 3080 / 3090 (principal, shown negative); Cash Flow = NOI − interest − principal;
  Return = Cash Flow ÷ capital. The right-hand notes are the workbook's column-G formulas.
- **Per budget**: a `Grid | Summary` switch in the editor header (`editorViewToggle`,
  `S.edView`, localStorage `bt-edview`) swaps the grid for the panel (`summaryPanelHtml`).
- **Column headers**: default "Oct. 26 T12" / "Oct. T4 Ann." / "Draft #1" from the T12 window's
  last month; click a header to rename it (`POST /budgets/:id/summary-labels` →
  `inputs.summaryLabels`, no recalculation) — e.g. to note which T12 is being compared to.
- **Summary tab** (nav, `renderSummary`, `GET /summary?year=`): every property's latest budget
  for the year, grouped by region (`properties.market`), each region as the Schedule table
  (`scheduleTableHtml`): unit count, property, three "T12 NOI Trend" columns, the year's NOI
  budget, growth over each T12, NOI growth over the current-year budget, income growth over T4,
  and "NOI Increase Tax and MGMT Fee Adjusted" per T12; an Average row (sums for $, growth on the
  sums, averages for the two single-column growths). The trend columns are the trailing-12 windows
  that ended 2 / 1 / 0 months before the last posted month (`trailing12(…, { back })`,
  `lb.noiTrend`) — blank where a window is not fully on file. Each region has a collapsible
  "average breakdown" = the panel on the summed columns. Clicking a property opens its budget in
  Summary view.
- **Excel exports** (`src/xlsx-summary.ts`: `fillSummaryPanel`, `fillSchedule`, `PANEL_ROW`;
  wired in `addReviewSheets` / `buildPortfolioWorkbook`): every annual budget's workbook leads
  with a **`<prefix>Budget Comps`** sheet = the panel, same cells as the workbook (labels B, T12 C,
  T4 D, budget E, GR% F, notes G; rows in `PANEL_ROW`). C reads the Budget sheet's T12 column (T),
  E its annual column (R), D a "Budget Comps sheet — inputs" block on Raw Data (four months
  annualized by summary line); everything else is the workbook's formulas. The all-sites workbook
  leads with **`Portfolio Comps`** (the property panels added together, live) and **`Schedule`**
  (one block per region, each row reading that property's panel; the earlier trend windows and the
  current-year budget NOI are Raw Data cells). Conditional formatting is the workbook's: a 3-colour
  scale (min `63BE7B`, 50th percentile `FFEB84`, max `F8696B`) down each growth column over the
  property rows only; a one-property region gets none. The sheet is named "Budget Comps", not
  "… Summary" / "… Budget", so `parseReviewDraft` never mistakes it for an importable sheet.
- **Stored formula values** (`src/xlsx-calc.ts`, `fillCachedResults`, run just before both
  workbooks are written): ExcelJS writes a formula with no value unless one is supplied, and Excel
  does not calculate in Protected View (how every download opens) or in Outlook / Teams previews —
  so the Budget sheet's totals and the whole Summary sheet were empty boxes until "Enable Editing".
  The pass evaluates every formula that has no stored value (SUM, AVERAGE, MIN, MAX, ABS, ROUND, IF,
  IFERROR, SUMIF, INDEX/MATCH, arithmetic, cross-sheet references) and stores the result; formulas
  stay live, and one it cannot read is left untouched. Any NEW function used in an export formula
  must be added there (the XML-level test in `test/xlsx-export.test.ts` fails if a formula is
  written without a value). Note `cell.value` hides a stored 0 / "" — read `cell.model.result`.
- **Schedule columns**: a trend window is a column only when at least one property in the region
  has it on file; the Average row's growth for a window is on the summed dollars of the properties
  that have that window (on screen and in Excel — `SUMIF(trend,"<>",noi)`).
- Not carried over from the workbook: the yellow "TPNDC … Budgeted NOI" row (Minot-specific),
  the hidden RE-tax / fee increase columns (still used in the adjusted growth), and the side
  boxes (historical distributions, cash position, per-unit costs, UW comparison).

## Payroll ratios from another property (Troy 2026-11-10)

"For payroll % allocations for non wage GLs, I need to have an option to take the % and monthly
curve shape from another property." `inputs.burdenFrom` (a property code; blank or the budget's
own code = own history). `loadBudget` builds `lb.burdenSrc { code, actual, budget, period, found }`
from that property's statements — its trailing-12 composed from every actual statement on file,
plus its latest budget statement (property-level GL totals only) — and the engine
(`AnnualSources.burdenSrc`) reads BOTH the annual ratio and each calendar month's own ratio from
it, per the usual basis (T12 / CY budget / mix). Wages stay the budget's own; employee rent and
row-shaped payroll lines are unaffected; a burden GL the donor has and this property never
posted is now budgeted. Driver gains `from`, chip `%WAGES·CLND`. Assumptions: "…ratio and
monthly shape taken from" (properties with an actual statement on file); a donor with no
statements falls back to own and says so. Saved formula sets carry it. Workbook: borrowed-ratio
rows are written as values (their ratio cannot be rebuilt from that sheet's own T12 columns).
Known gap, older than this: the Payroll sheet's live formula is annual ratio × monthly wages,
while the engine has used same-month ratios since 11-09, so those rows only match until Excel
recalculates them.

## Section increase % on the grid (Troy 2026-11-10)

"Need to be able to put an increase % into the column subcategory and have it flow through to make
much quicker. Should not overwrite overwritten formulas." Each section header row in the editor
(other income, fixed admin, admin, corporate events, marketing, utilities, in-house maintenance,
exterior / CAM, contract services, rehab — `SEC_PCT_SECTIONS`) carries an "increase __ %" box
(`secPctBoxHtml`, `input.secpct-in`) → `inputs.baseline.secGrowth[section]` (the chart's
`section`). Engine precedence in `pctFor`: a % typed on the row (`glGrowth`) → **section %** →
category % → the formula set's factor → template defaults. So a row with its own % keeps it, a
hand-typed (override) line is never touched, and lines on their own formula (corporate rate,
fee, suggestion) ignore it; the box's caption counts how many lines follow and how many keep
their own. Blank = unset. `applyFormulaSet` clears `secGrowth` along with the per-GL choices.

## A shape chosen on the row works on every line (Troy 2026-11-09)

"Flat + growth over T12 needs to be an option for all lines." `baseline.glShape[gl]` (+
`glGrowth[gl]`) used to matter only on lines that were history-based anyway. Now
`generateAnnualLines` runs a first pass over every detail GL with a chosen shape and builds it
from the property's own history (`userShaped`); GPR, loss to lease, vacancy, delinquency, wages,
the fee and interest then leave an already-set line alone (the other formulas already checked
`isSet`). GPR on a chosen shape feeds the % of GPR lines and vacancy; a wage GL on a chosen shape
still feeds the burden ratios; a payroll line with no growth typed takes the raise %. A chosen
shape is literal — no cost drift, no $1,000 drop. Lines with no history keep their formula.
Row menu (annual, any line with T12): **"Flat + growth over T12…"** (prompts the growth %, sets
`glShape = 'flat'` + `glGrowth`, clears an override) and **"Back to this line's own formula"**.

## Year-1 plan inside the annual budget (Troy 2026-11-10)

"We made Y1 Budgets for Bismarck and Jamestown. We need to incorporate those NOI's so that we have
made promised returns by Y1." Troy's picks: the Y1 NOIs go **into the 2027 budgets**, measured
against the **UW Y1 NOI**.

- The Y1 (acquisition) budget is 12 ownership months tied 100% to the UW NOI (Aug-26..Jul-27). The
  property's calendar-year annual budget covers the tail of that window. `applyY1Plan`
  (shared/annual.ts): for those calendar months (`y1MonthsIn`), every detail GL that feeds NOI
  (`feedsNoi`: 4994-5189, 6101-7069) takes the Y1 plan's amount; a GL the plan lacks is zero there,
  a GL only the plan has is added. Months after Year 1 stay on the annual formulas. Interest,
  principal and SP are untouched. **Locked lines are never moved** (shown as variance).
- `buildLines` (routes.ts): `clearY1Plan` -> overlay -> dependent passes (fees / recoveries after
  Year 1 read the plan's bases) -> ties -> MROUND -> overlay again (Year-1 months end exactly on
  the plan). `lb.y1Plan` = the property's latest non-annual budget when its startMonth > 1 and its
  year + 1 = this budget's year (lines + the UW snapshot's NOI). Only for startMonth-1 budgets.
- Default ON when such a budget exists; `inputs.y1Plan === false` turns it off (Assumptions
  "Year-1 months"). Lines carry `driver.y1` (month indexes): chip `Y1+<tag>` / `Y1`, export driver
  column "Jan-Jul from the Year-1 budget; then ...".
- `y1Check` -> `budgetView.y1Plan` { months, planNoi, planBefore, planIn, budgetIn, y1Noi, uwNoi,
  variance, locked, on }: Year 1 = the plan's months before this year + this budget's Year-1
  months, vs the UW NOI. Shown on the defaults-in-use card (warns when it does not tie). The months
  before this year are the PLAN, not actuals: there is no catch-up for a short start.
- Existing budgets change on their next recalculation (ENGINE_VERSION bumped), not on their own.

## New acquisitions in annual budgets: first-year fee, start-up months (Troy 2026-11-09)

- **First-year management fee** — "If Management fee is 3% for first year, it should be 3% for
  first 12 months. It should not use 4% flat from the start." `mgmtFeeRates(year, startMonth,
  regular, { pct, start })` (shared/annual.ts): the first 12 months of ownership earn the
  first-year rate, later months the regular `inputs.mgmtPct`. The fee bills in arrears, so the
  rate follows the INCOME month (ownership from Aug-26 → in a 2027 budget the fees posted Jan–Aug
  are first-year, Sep on regular). Sources: `lb.acquisition { start, firstYearPct }` — start =
  the Yardi template's `acquisitionDate`, else the property's acquisition budget (year +
  startMonth); firstYearPct = that acquisition budget's `mgmtPct` (the UW Y1 rate). Typed on the
  budget: `inputs.mgmtFirstYear { pct, start }` (Assumptions "First-year fee %" / "Ownership
  began"; only stored when it differs from what is on file; pct null = none). A property with no
  acquisition budget has no first-year rate until one is typed. Driver gains `firstYear { pct,
  months, through }`, chip %INC·Y1.
- **Start-up months** — "for new acquisitions with only a partial year, we should be excluding
  the first month, and being very careful about the second and potentially even 3rd month of
  ops." `trailing12(stmts, { excludeStartup })` → `annualizeDead`: when the window opens with
  pre-acquisition (no-GPR) months, the first `excludeStartup` months of operations (default
  `STARTUP_EXCLUDE_DEFAULT` = 1; `inputs.startupExclude` 0–3; at least two live months are always
  kept) are left out exactly like the dead months — filled with each GL's average over the
  remaining months. `Trailing12.startup` names them; `Trailing12.early` names months 2–3 of
  operations that are still IN the history. Editor: badges "start-up Aug 2026 left out" and
  "⚠ review Sep 2026, Oct 2026 (month 2-3 of operations)"; Assumptions "Start-up months left out
  of the history" (shown only for a new acquisition); the defaults list and the export check
  carry the review warning. Months 2–3 are flagged, not altered. `PUT /budgets/:id` now saves
  the inputs and reloads before building, because this input changes what is loaded.

## Saved formula sets — no silent GRKS default (Troy 2026-11-09)

> 2026-11-12 (Troy: "zeroing rows is not applied from saved formula set" / "Same thing w increase %'s"):
> `formulaSetFromBudget` checks a zero-out BEFORE skipping hand-typed lines — "Zero out row" saves as an
> override with driver `zero`; it travels as `{ method: 'zero' }` unless it was typed over (`revised` or any
> non-zero month). Increase %s: a rule's `factor` is the resolved %, but on the receiving budget a category %
> from the set's settings outranks a rule factor and section %s were wiped, so row / section %s came back as
> the category %. The set now carries `row.glGrowth` for every formula line and `row.secGrowth`;
> `applyFormulaSet` restores both (the target's own section %s are replaced). Client: `zeroedLine` in the
> save / copy-section counts. Sets saved before this need re-saving to pick these up.

"We should not be using GRKS defaults. I need to be able to save all property formulas applied
minus hard codes with a name. Instead of just picking something random, it should prompt to pick
out a previous presave."

- **What a set is** (`FormulaSet`, shared/annual.ts): per-GL rules — each non-overridden
  history-based line's shape / increase factor / MROUND (`formulaSetFromBudget`; shapes the old
  rule table could not express ride as `{ method: 'custom', shape }`), deliberate zero-outs
  (`{ method: 'zero' }`) — plus the formula settings: category factors, cost drift, LTL mode and
  renewal / burnoff %, vacancy curve weight, burden basis, wage source, fallback raise %.
  **Left out (the hard codes):** hand-typed lines and totals, every dollar amount (GPR base, LTL
  start, $ per move-in, corporate rates), GPR steps, the vacancy average, expirations.
- **Storage**: `formula_sets` (migration 013; unique name, `source` = "clnd 2027"). Routes:
  `GET/POST /formula-sets` (POST `{ name, budgetId, overwrite? }` derives the set server-side),
  `DELETE /formula-sets/:id` (admin), `POST /budgets/:id/formula-set { formulaSet }`. `/state`
  lists them (`formulaSets`).
- **A budget carries a COPY**: `applyFormulaSet` writes `inputs.rules` + `inputs.rulesFrom
  { id, name, at }` and clears the budget's own `baseline.glShape / glGrowth / glMround` (the set
  replaces them); overrides and data inputs stay. Editing or deleting a set never moves a budget.
  `buildLines` uses `inputs.rules ?? loadAnnualRules()` — the GRKS table is now ONLY the fallback
  for budgets created before sets existed (the Defaults card flags them "none picked").
- **Picking is required**: the New budget dialog (annual) has a "Formula set" select with no
  default — saved sets, "Template defaults only" (`rules = {}`), or "GRKS 2026 draft (the old
  default)" as an explicit choice; Create refuses until one is picked. `POST /budgets
  { formulaSet }`.
- **Editor**: More → "★ Save formulas as…" / "☆ Apply a saved formula set…" (one Undo reverses an
  apply; admins can delete sets there).
- Note: a GL that was DROPPED (<$1K) on the source budget carries no rule, so on the target it
  falls to the built-in same-month default and is budgeted.

## Section formulas: set a whole section, copy it to other budgets (Troy 2026-11-10)

"I need to be able to change entire sections of formulas for all templates at once w ease. For
example, Contractor uses T12/12. This is an awful formula to base that on, which is how all of my
budgets are set up." Priority: "being able to selectively apply one set of changes to other
templates". (Clicking into a saved set to edit its items directly is NOT built yet.)

- **Set a section** (grid, annual): the section header carries a `formula:` select beside the
  increase % box (`secShapeHtml` / `setSectionShape`, `SEC_SHAPES`). Picking a shape writes
  `baseline.glShape[gl]` for every non-overridden `baseline`-driven line of the section and
  recalculates (one Undo). "clear row choices" removes them. Hand-typed lines and lines with their
  own formula (corporate rate, fee, suggestion) are not touched.
- **Copy to others**: More → "⇉ Copy section formulas to other budgets…" (`openCopyFormulasOut`):
  tick sections of this budget, tick annual budgets (nothing pre-ticked; "all <year>" link) and
  saved formula sets, optional "Also copy the increase %", **Preview** (dry run: formulas changed,
  lines that move, NOI before / after per budget) then Apply.
- **Engine** (shared/annual.ts, pure): `sectionFormulaSource(rules, coa, sections)` = the source's
  own rule per formula-driven GL in the sections (`formulaSetFromBudget`), plus, when a section is
  built ONE way, that formula for the section's other GLs (`fill`), so lines the source has no
  history on change too; a mixed section hands over only its own lines. `copyFormulas(target, src,
  gls, sections, { pct, fallbackRules, fill })` writes those rules into the target's
  `inputs.rules` (starting from the GRKS fallback table when the budget has no set, so other GLs
  keep it), drops the target's `glShape` / `glMround` on those GLs so the rule governs, and never
  lets a fill replace an engine-type rule (corpRate, suggested, payroll...). Without `pct` each
  line keeps the factor it had; with it the factor, the row % and the section % box come along.
- **Route** `POST /budgets/:id/copy-formulas { sections, budgetIds, setIds, pct, dryRun }`: per
  target a save point "Before formulas copied from <CODE> <year>", inputs + lines saved with a full
  build; saved sets get the rules merged into `data.rules`. A target that was due a recalculation
  is flagged `stale` (its NOI change then includes the engine update). Overridden lines are left
  alone and counted (`locked`).
- Totals can move, not only the monthly spread: a different shape reads the history differently
  (edge months, the $1,000 drop rule).

## No negative months, Smooth, bulk formula, RE-tax default, recalculate-all (Troy 2026-11-10)

- **No negative budget months** ("We can not be budgeting negative numbers"): `foldCredits(months,
  sign, mult)` (shared/domain.ts) runs at the end of `baseline()` in the annual engine. An expense
  GL (code >= 6000) is never negative; an income GL keeps the side its own total is on (contra
  lines stay negative). Wrong-side months become 0 and the rest are scaled so the line's total is
  unchanged (MROUND kept); an expense whose whole year nets to a credit is not budgeted. The driver
  carries `folded: n` and the chip label says so. Only history-based lines: engine lines (GPR, LTL,
  payroll, fee) and hand-typed cells are not touched.
- **Smooth** (row tools, client `smoothMonths(months, { gl, round: 5 })`): after the 1-2-1 passes,
  no month against the line's sign, then every month MROUND $5 (the total can move a few dollars).
  The line keeps its formula driver and gains `driver.smooth { passes, mult }` -> `drvMeta().extra`
  renders a second SMOOTH chip (`drvExtraHtml`); the export driver column appends "missed-bill
  smoothed". Lines smoothed before this change still show the single SMOOTH chip (their original
  formula was not kept); smoothing them again does not restore it.
- **Formula for lines...** (More menu, annual; `openBulkFormula`): pick a formula (turn curve
  preselected), tick lines across sections ("Turn lines" ticks `TURN_GLS`), writes
  `baseline.glShape`. The turn curve = T12 total x factor on lease expirations lagged ONE month
  (`lagMonths(exp, 1)`: a June expiration is a July invoice, December rolls into January).
- **RE taxes 3%** ("3% growth by default on RE taxes. It should not be $0"): `TEMPLATE_GL_PCT['6116']
  = RE_TAX_DEFAULT_PCT`. A saved set's factor of exactly 0 on 6116 is ignored (it only recorded the
  old default); a % typed on the row / section / category still wins, including 0.
- **Hard-coded numbers stand out, per CELL** ("All hardcoded numbers should be in bold and unique
  color" / "highlight the cell, not the row"): `PUT /budgets/:id/lines/:gl` records the month
  indexes a hand edit changed in `driver.hard` (union across edits; reset when the line was not
  already fixed). Grid: only those month cells get class `hard` (bold 800, `--hard` #c2185b, 2px
  underline). An `override` line with NO `driver.hard` = a tool rewrote the whole line (typed
  total, import, flat fill) or it was fixed before cells were recorded: every non-zero
  month and the year total are marked. A SMOOTHED line is not hard-coded ("a formula still drives it versus a random value"): no cell is marked until one is typed on it. Posted-actual months keep their own look. Excel:
  `isHardCell` + `HARD_FONT` on the Budget and Payroll sheets, legend on row 5.
- **No GL re-pick** (Troy 2026-11-11: "I still am having to repick the GL when I pick an option that
  is GL based"): on annual budgets `openSellerMatch`, `openT12CurveMatch` and the WAVG source use
  the row's own statement line (`String(r.gl) === gl`) straight away - the growth % (and the curve
  choice for T12-on-curve) is all that is asked. The picker still opens when the GL has no history
  of its own, or on Shift-click (`S.pickOther`, set by the row-tool dispatcher) to borrow another
  line. Acquisition budgets still pick: their source rows are the SELLER's chart, where the same
  code is not reliably the same account; a same-code row is listed first.
- **The template is the source** (Troy 2026-11-11: "The budget template has T12 data in it... Same
  with budget numbers"): annual `sellerRows` = `ownT12Rows(stmtActual, actualCal)` - one row per GL
  of the COMPOSED trailing-12 (the grid's T12 column), not only the linked statement's rows, so
  every GL with T12 is its own source. A GL with no T12 offers its own current-year budget with one
  yes/no (`fcOwnSource` -> `fcBudgetRow`, from `hist.budget.cal`); the picker is left for a GL with
  neither, and Shift-click. Row menu: **"CY budget × growth (this GL)"** (`ownBudget`). Budget-based
  drivers carry `basis: 'budget'` (`sellerLine` chip CY BUD, `t12curve`, `wavg`); the formula
  copier replays them on the TARGET line's own current-year budget.
- **Default formulas** (Troy 2026-11-11: "If I am able to change default curves used, it is entirely
  too difficult to find... those changes should flow through into anyone using default templates"):
  ONE shared per-GL table, `app_meta.default_rules` (migration 014), edited on the **Default formulas**
  screen (`openDefaultFormulas`; dashboard button, budget More menu, and the last option of every
  section's formula pick). Per GL: default formula + seasonal curve (`gl_accounts.curve`); one pick per
  section sets them all; search box. `GET/PUT /default-formulas` (PUT admin). `effectiveRules()` lays
  the table over the base rules of every budget NOT on a named saved set (`followsDefaults`: no set,
  "Template defaults", old GRKS). A named set is a deliberate copy and is untouched. Above the table:
  `baseline.glShape` (row / section / Formula for lines) and `inputs.rulesOwn` (GLs given by Copy
  section formulas). Engine-built GLs are never taken; the line keeps its own factor and MROUND.
  Saving recalculates nothing: the screen opens Recalculate (NOI before / after) for those budgets.
- **Section formula pick**: "Turnover curve (lease expirations + 1 month)" is shape `turns`; `dropped`
  lines take a section pick too; a pick that changes no line says why; no expirations = a warning.
- **Smooth is gentle** (Troy 2026-11-11: "too aggressive for many adjustments"): `smoothGentle` moves
  only credit months and local spikes (> 1.5x the typical month AND both neighbours), excess into low
  months within 3, filled to the typical month. **Drops too** (Troy 2026-11-12: "Smoothing only looks for
  spikes, not massive drops", 5140 lease termination with two months at 325 / 565): a run of 1-3 months each
  under 35% of the typical month and under 35% of the average of the months either side (those at half the
  typical month or more) is filled to that side level (capped at the typical month), taken from every other
  month in proportion; total kept. Seasonal tapers (gas, pool) and long off-seasons (snow) do not qualify. Nothing wrong = asks before one half-strength pass.
  The old multi-pass `smoothMonths` remains for the "smoothed seller months" curve shape only.
- **Fit a curve to T12** (Troy 2026-11-11: "apply a turnover curve, and then fit it closer to T12
  historical expenses"): `baseline.glFit[gl]` (0..1; saved sets carry `rule.fit`) on shapes `turns`
  and `curve`. `annualBaseline` blends the curve's normalized weights with the GL's own T12 months
  (credit months = 0): 0 = pure curve, 1 = the T12 months; the year total is unchanged. Driver
  `fit`, shown in the chip and the Excel note.
  **Any GL, any category (Troy 2026-11-11: "Why is RR the only category that has a fit to T12
  function??? It should be usable for any GL and any category")**: `fitToT12` (shared/annual.ts) is a
  general step in `generateAnnualLines` after every formula (before the fee; 6112 after it): the
  line's own months are blended with its rotated T12 months by `glFit[gl]` (else `rule.fit`), year
  total kept penny-exact, MROUND re-applied. Curve / turnover baselines keep their in-shape blend (no
  second fit). Skipped: contracts, debt / interest, zero / dropped / manual lines, and GLs with no T12.
  Driver `fitT12` → second chip "FIT n%" and the Excel note. UI: the "fit to T12 %" box is on EVERY
  section header that has a fittable line (`secFitLines`: any non-typed line with T12 history), the
  row menu has "Fit to T12 %…" on any such line, and Formula for lines applies the % with any formula.
  Saved formula sets carry it for history lines only (engine lines have no per-GL rule).
  Not on the Default formulas screen yet.
- **Recalculate many** (dashboard Export menu -> "Recalculate..."; `openRecalcMany`, `POST
  /budgets-recalc { ids, dryRun }`): preview of lines that move and NOI before / after per budget,
  then save with a save point "Before recalculating all". This is how a changed default reaches
  every budget; nothing recalculates on its own.

## Within-year cost drift (Troy 2026-11-09)

"Apply a very small gradual increase to expense items, as things will tend to get more expensive
over the course of the year. Should not be massive, but should make a difference in
distribution." `tiltMonths(months, drift, mult)`: a straight-line tilt so December runs `drift`
above January, **year total unchanged** (cent fix on December; MROUND re-applied). Default
`COST_DRIFT_DEFAULT` 3% (`inputs.baseline.costDrift`; 0 = off; Assumptions "Cost drift within
the year %"). Applies to history-based (`baseline`) lines in categories 9, 11, 12, 13, 14; not
to "last month" (contract-flat) lines, real estate taxes, payroll, corporate rates or the fee.
Driver gains `drift`. The existing engine tests run with drift OFF (`baseInputs` in
test/annual.test.ts) because they assert the template's / GRKS draft's own monthly cells.

## Reviewability pass (devil's advocate 2026-11-09, day-one fixes)

`DEVILS_ADVOCATE_2026-11-09.md` is the review. Built from it:

- **Budget reference label** — `budgetRefLabel(period)`: a calendar year reads "2026 budget";
  the template's T12-window budget reads "budget Nov-25–Oct-26" (it was labelled "2025 budget"
  on 2027 budgets). Grid header "Bud Nov-25–Oct-26"; the compare-card option uses the same label.
- **Dropped lines** — a `flatT12` line at or under $1,000 of T12 now carries driver
  `{ method: 'dropped', t12, limit }` (still zero). Chip `<$1K`; legend chip "N lines dropped
  under $1K · $X" → `openDroppedDialog` (tick lines → `baseline.glShape[gl] = 'flat'`); the row
  menu has "Budget this line". A shape chosen on the row bypasses the threshold.
- **Chips** renamed: RR→ROLL, T12→SAME MO, RATE→$/UNIT, RATIO→%WAGES, TURN→T12·TURNS,
  PAY·draft→PAY·prelim; 5035 / 5036 read %NET RENT / %NET GPR. `TAG_KEY` + "? chip key" lists all.
  Percent boxes on rows carry a % sign (`.fxu`).
- Undo carries `calcVersion` in its snapshot and the restore route puts it back (null for older snapshots), so undoing a recalc does not leave the newer stamp.
- **Formula version** — `ENGINE_VERSION` (shared/annual.ts; BUMP IT when a formula or default
  changes results). `saveLines(id, lines, true)` on every full build stamps
  `budgets.calc_version` / `calc_at` (migration 012); `budgetView.engineVersion`; the editor
  shows a "calculated on older formulas — Recalc" bar when they differ.
- **Defaults in use** (`defaultsInUse` / `defaultsCardHtml`, annual) — NOT in the side panel (Troy: its placement was in the way): a small "defaults · N to check" chip beside the chip key opens it in a dialog (`defaultsChipHtml` / `openDefaultsDialog`). It lists: increase factors, loss
  to lease, vacancy, GPR start vs last posted, wages, management fee (warns when the template's
  tier table reads a different % at the budget's cash-on-cash), corporate rates, taxes, dropped
  lines, special projects — each tagged default / set. "I have reviewed these" →
  `POST /budgets/:id/ack-defaults { hash }` stores `inputs.defaultsAck { by, at, hash }` WITHOUT
  regenerating; a changed fingerprint reads "changed since reviewed".
- **Export check** — `okToExport`: a confirm listing stale formulas, preliminary raises,
  unreviewed defaults, fee-tier and special-project warnings before a Yardi CSV / All exports.
- KPI tiles: "Cash flow · no SP budgeted" / "Cash flow before SP"; cash-on-cash tooltip says what
  it leaves out.
- **WAVG row tool** (annual): uses the row's own statement line without asking for a source; the
  picker only opens when the GL has no history. Acquisition budgets still pick (seller vs Minot).

Still open from the review: management-fee tier (needs Troy's answer), turn costs never taking
the "turns" shape while GRKS rules are loaded, full-staffing wages, 6310 vs what posts, January
GPR step not reaching LTL, burden-ratio cap, expirations frozen at the template's counts.

## Payroll flow into the budget worksheet (Troy 2026-11-03)

Modelled on the "2025 Payroll Budget Draft Revision KC ND Final" workbook's per-property tabs
(rows = payroll GLs × months, budget total / T12 / difference / % change; historicals below)
and its Summary tab. Nothing from that workbook's roster is read — only its layout.

- **Engine** (`shared/annual.ts` payroll block): wage GLs come from the payroll model
  (`inputs.wages`); when `inputs.wagesFromRoster` is set — the Pay-rates **apply** sets it —
  the engine adds NO March step, because `annualWagesByGl` already prorates each person's
  raise from its effective month (before this it double-raised: roster raise + 3.5% in
  March). Every other payroll GL (taxes, WC, 401k, medical, bonus, commissions, OT, …) =
  the SAME-MONTH ratio × that month's budgeted wages (2026-11-09, Troy: "monthly, not
  annualized" — each calendar month's own % of wages, so quarterly NOI bonuses, summer
  commissions and Q1 tax front-loading keep their shape; a flat line guarantees a variance
  both ways every month. A month with no wages in the history falls back to the annual
  ratio; driver carries `sameMonth: true, ratios[12]` calendar-indexed). Lines that are
  not a function of wages skip the ratio: `BURDEN_LAST_GLS` (6413 employee rent → last actual
  month flat, no raise) and any payroll GL whose row shape menu set `baseline.glShape`.
  The ratio comes from `inputs.burdenBasis`: `'t12'` (default,
  T12 actual % of wages), `'budget'` (CY budget % of wages) or `'mix'` (average of the two,
  falling back to whichever side exists). Driver: `{ method: 'burdenRatio', ratio, basis,
  t12Ratio, budgetRatio }`. Settings dialog: "Other payroll lines … = % of wages from".
- **Excel** (`src/xlsx-export.ts`): every annual budget gets a **`<prefix>Payroll` sheet**
  right behind its Budget sheet — GL rows in COA order, months C..N, O budget total, P T12,
  Q CY budget, R Δ, S %, U T12 % of wages, V CY budget % of wages, **W Ratio used** (yellow
  input: `=U` / `=V` / `=AVERAGE(U,V)` per the basis — type a % or any formula), X how.
  Wage rows are typed values (lilac); a **TOTAL WAGES** row sits under the last wage GL
  (`WAGE_GLS`, the engine's ratio base); every burdenRatio row is `=$W{r}*{col}{wagesRow}`;
  manual/other rows stay values. TOTAL PAYROLL EXPENSE, largest increase/decrease
  (INDEX/MATCH on R), then the T12 and CY-budget calendars by month (`ReviewArgs.payrollHist`
  from `lb.actualCal` / `lb.budgetCal`). **The Budget sheet's payroll rows are live
  references** into the Payroll sheet (driver column "→ Payroll sheet · …"), so a change on
  the Payroll sheet flows through the Budget, Summary and Portfolio tabs. Portfolio
  workbook: a **Payroll Summary** tab behind Portfolio — one live row per property (budget,
  T12, Δ, %, largest movers) + total. Every formula carries a cached result.
  `addReviewSheets` returns the `PayrollSheetInfo` the summary needs. Tests:
  `test/xlsx-export.test.ts` (seed COA needs `active: true` stamped on — the DB does that).

## Dashboard property list, full-width editor, GPR month steps (Troy 2026-11-03)

- **Properties card** (`propertyListHtml` / `wirePropertyList`, app.js) above the Budgets
  table: every subject property (plus any comp that owns a budget), the budget for the
  chosen year (`S.dashYear`, default next year) or **Not started** (with "has 2026" when
  another year exists), and a reports pill. Click a row → `propertyReports(st, code,
  budget, year)`: trailing-12 actual statement + CY budget statement are REQUIRED (a Yardi
  template built for that budget year carries both); the template, a rent roll and the
  payroll apply (`inputs.wagesFromRoster` or a payroll model) are recommended. Year-aware:
  a statement whose period ends before `year-1`, or a template for another budget year,
  reads as **stale**, not on file. Buttons: Open budget / **+ Start {year} budget** (presets
  `S.nb = { prop, year }` for `newBudgetDialog`) / Upload data (the Data view).
- **Row buttons (Troy 2026-11-09)**: each property row ends with **Open** (the chosen year's
  budget, `data-rowopen` → `openBudget`) or **+ Start** (`data-rowstart` → the New budget dialog
  preset to that property and year) — no need to unfold the row first. The unfolded detail keeps
  its own buttons.
- **See everything at once**: the editor and payroll views add `.wrap.wide` (no 1340px cap);
  `table.grid` pins the GL and Account columns (`th.l` / `td.code` / `td.name` sticky-left,
  row backgrounds carried); side pane 400px, month inputs 64px.
- **GPR increases in SPECIFIC months**: `inputs.gpr.growthPct[i]` is the % applied IN month
  i (compounding). Assumptions shows a Jan..Dec grid (`gprStepsGrid` / `readGprSteps`, live
  cumulative %); the 4994 row's Fx chip opens the same grid in a popover (`openGprSteps`);
  the driver label reads "GPR — steps: Mar +3%, Sep +2%" (`gprStepsSummary`). The income
  growth tie (`/tie-growth` key '1') calls `gprStepsForTarget` (shared/annual, tested): the
  step pattern on file scales by one factor so the months keep their places; only a budget
  with NO steps falls back to a uniform monthly rate.

## Per-GL history rows (Troy 2026-11-04)

Click a GL's name in the editor to unfold, right under it, the property's prior trailing-12
actuals and current-year budget by month — reference only, never part of the budget.
`budgetView` sends `hist: { t12: { label, period, cal }, budget: {...} }` (annual only; the
calendars rotated to the budget's month order). `gridHtml`: `histFor(code)` lists the sources
with data, `histOpen(code)` = `S.histAll || S.histOpenSet` (persisted in localStorage
`bt-hist`); rows render as `tr.hist` with the hatched background, italic dim text and the
dashed REFERENCE tag (`.histtag`), with the annual and per-unit columns filled and the
reference columns blank. The name cell carries `data-hist` + a ▸/▾ chevron; the toolbar chip
`#hist-all` unfolds every GL at once (clicking one GL while "all" is on narrows back to it).

## Unit Availability Details (UAD) → expirations, LTL burnoff, turn costs (Troy 2026-11-04)

- **The UAD is a rent-roll source.** `parseUnitAvailability` (importers.ts; `parseRentRoll`
  dispatches on the "Unit Availability Details" title, `detectUploadKind` → `rent_roll`)
  reads every unit per "Property (code) - status group" section: units from the "Total for
  <code>" line (else distinct units), market = every unit's Unit Rent, in-place and
  `leases {m, r, e}` from the occupied statuses (Current / Notice / Eviction; Future /
  Applicant rows are the same unit again, Past is history), lease end = "Lease To", as-of
  from the header. Resident names are never read. Output is `source: 'unit_level'`, so the
  Data page mapping, `rent_snapshots`, relink, the per-lease LTL burnoff and
  `expirationsFromLeases` all work unchanged. Date cells are noon-shifted before taking
  the day (xlsx hands back local-midnight Dates).
- **Expiration precedence** (engine): typed `inputs.expirations` → rent roll / UAD leases
  → the Yardi template's count. (Was template before leases.)
- **Roll as-of date (2026-11-05 fix):** `loadBudget` reads `rent_snapshots.as_of` →
  `lb.rollAsOf` → `AnnualSources.rollAsOf` / the last arg of `generateLines`/`regenerate`
  (`ltlModel`/`ltlMonths` `opts.asOf`, `expirationsFromLeases` `{asOf, startMonth}`). A lease ending
  BETWEEN the roll and the budget start has already turned: `ltlModel` resets it in month 0 with
  the renewal mix, `expirationsFromLeases` counts its renewal twelve months on. A lease already
  expired at the roll (or undated) is month-to-month: one twelfth resets each month in BOTH
  functions (expirations used to pile them all into January — 126 on bcnd off the 9/30 roll).
  On the 9/30/26 roll this moved 2027 income +36k clnd / +41k bcnd / +53k ecnd. `dateKey` /
  `leaseEndIndex` (domain.ts) parse ISO and M/D/YYYY. Assumptions shows "roll as of …".
- **Turn costs follow expirations + 1 month**: `TURN_EXPENSE_GLS` (6702 appliance parts,
  6704/6912 blinds, 6706/6908 carpet cleaning, 6726 locks, 6728 paint, 6905 appliance
  repair, 6926 painting, 7002/7006/7010/7015 RR appliances/carpet/blinds/painting) default
  to shape `'turns'` whenever the budget has expirations: T12 total × factor spread on
  `lagMonths(exp, 1)` (December rolls into January); any GL can pick or drop the shape in
  its row shape menu ("T12 total on lease expirations, +1 month lag"); driver tag TURNS,
  `driver.turns` = expirations counted. Tests in annual.test.ts / importers.test.ts (174).

## Gotchas / policy

- **Never ingest individual employee compensation** through the GENERAL upload paths (the
  FHND workbook's Payroll sheet, the Yardi template's "Paste Payroll Here"). The old
  `payroll` upload budgets category 10 at property level (aggregates only). The ONE
  exception is the gated pay-rates tab above — per-seat rates, stored deliberately,
  behind its own password, with RM pay masked outside RM_PAY_USERS.
- UW quirks: bad debt lives inside pcode 3; turnover recovery income is pcode 5; mgmt fee is
  3% of EGI Y1 but 4% Y2+; portfolio sheets are flagged `isPortfolio` and normally not mapped.
- The Yardi *Budget Worksheet* export has NO monthly actuals (annual prior-year budget only) —
  phase-3 annual mode needs an actuals export (property comparison, Actual book, monthly).
- seed/coa.json regenerates via `python scripts/gen_coa_seed.py` (reads the two revision CSVs +
  FHND workbook from their original paths).
