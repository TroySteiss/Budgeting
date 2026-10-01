# nd-budget-tool — Handoff / State of the World (2026-08-22)

Feed this to a new chat to continue work. The repo's PROJECT_MAP.md has deeper
architecture detail; this is the operational summary.

## What & where

- **Purpose**: web app replacing the FHND/PHND Excel budget workbooks. Live mode:
  **new-acquisition budgets** for Bismarck 4 (cwnd Cottonwood 268u, lhnd Legacy
  Heights 119u, nrnd North Ridge 68u, rrnd River Ridge 146u) and Jamestown 2
  (drnd Deer Ridge 163u, mwnd Meadows 84u). Annual-budget mode is future phase 3
  (blocked on a monthly-actuals Yardi export — the Budget Worksheet export has none).
- **Prod**: https://app-production-15d8.up.railway.app · login = your name + password `Monarch7!`
- **Repo**: https://github.com/TroySteiss/Budgeting (local: `C:\Users\TroySteiss\nd-budget-tool`)
- **Deploys**: `railway up` from the local folder (Railway project `nd-budget-tool`,
  service `app` + Postgres). GitHub is source control only — connect the Railway
  service to the repo for push-to-deploy if wanted.
- **Local dev**: Postgres 17 db `budget_tool`, `npm run dev` → :3100. 62 vitest
  tests (`npm test`) run against real fixture files in test/fixtures (gitignored).
- Stack: Node+TS+Express+Postgres, vanilla-JS SPA (public/app.js), ExcelJS for the
  styled workbook export, SheetJS for parsing. Same conventions as SP Tracker.

## The model (core concepts)

- **A budget IS UW Year 1**: 12 ownership months from the editable Start month
  (currently Sep-26 → Aug-27 on all six). Yardi uploads are calendar SLICES of the
  one plan: 2026 CSV = Sep–Dec (a *Revision* — replaces the seller budgets still
  sitting in Yardi!), 2027 CSV = Jan–Aug.
- **Chart of accounts**: 385 Monarch GLs seeded from the real upload CSV (335
  uploadable, exact order) + FHND workbook; each detail GL has a P-code (UW
  category 1, loss, 2–14) and a seasonal curve. Totals are always computed.
- **Data layers per property** (all loaded for the six): UW snapshot (tie-out
  targets + financing), rent snapshot (summary roll — unit-level rolls with lease
  dates/charges NOT yet uploaded), seller T12 (Jun-26), Minot 4 12-month Budget
  comp set (712 units; per-GL $ weights + monthly shapes; a 12-month Statement
  actuals comp set also on file), ND payroll model (property-level wage
  aggregates ONLY — individual comp is restricted and never stored).

## Line-generation rules (drivers, shown as colored Fx chips + cell fills)

- GPR (4994): rent-roll market rents anchored at the start month × monthly growth.
- **LTL (5003): PURELY MECHANICAL** — per-lease burnoff at each turnover (needs
  unit-level roll) or uniform-expiry burnoff of the actual rent-roll gap (1/12 of
  leases/month; renewals burn half, move-ins all; renewal rate default 70%,
  largest-LTL leases renew first). **Nothing automatic ever reshapes it.**
- Vacancy (5031): % of GPR (default UW's 5%); concessions & rental-loss remainder:
  UW % of budget GPR via comp weights.
- Utilities (cat 12): SELLER statement levels, each seller line keyword-mapped to
  the closest Monarch GL, same calendar month × growth (default 3%). Utility
  income (cat 4): **recovery % × PRIOR month's billing** (default = seller's
  actual ratio). Both switchable back to UW allocation per budget.
- Payroll (cat 10): wages from the payroll model; benefits/bonuses = Minot
  ratio × subject wage total (cat 10 floats vs UW).
- Other income: charge-code lines (pet/garage/parking/storage) = T1 charges × 12
  when a unit-level roll exists; remainder UW-allocated.
- Expenses 6, 8, 9, 11, 13, 14: UW Y1 totals allocated by Minot per-GL weights,
  spread by Minot monthly shapes (fallback: seller-T12 category shape, then
  named curves). Per-category basis toggle: UW tie ↔ Minot $/unit × units.
- Mgmt fee: % of income. Interest: loan × rate/360 × days (financing parsed from
  the UW books; capital = price−loan estimate, refine when real equity known).

## Tie policy (Troy's rules — hard-learned, do not regress)

1. **NOI ties 100% to UW** — auto at generation (tieNoi on) via the flex
   categories (default admin/marketing/R&M/rehab; the "tie NOI" button opens a
   category checklist).
2. **Income does NOT auto-tie** (tieIncome off). The EGI variance stays visible;
   Troy places it via the "tie income" chooser (LTL, vacancy, delinquency,
   prior-period, write-offs, concessions — pick is remembered per budget).
3. **NO UNPROMPTED ADJUSTMENTS, EVER**: a tie touches ONLY the explicitly chosen
   line/category. Clamps that LIMIT a change are fine (absorbers never go
   positive); redirecting a remainder elsewhere is not — leftovers stay as
   visible variance. Never unilaterally change a budget's saved settings.
4. Category totals just need to be "in line" — variances display, only NOI forces.
5. Seller T12 = old-owner data: shapes/seasonality only, EXCEPT utilities where
   seller levels are the basis by design. Levels otherwise follow UW + Minot.

## Editor features

Fx chips (color = data source; legend above grid) with row menu: zero, flat
annual/monthly, growth fill, Minot $/unit seasonal, **T3 weighted avg of a
pickable comp line × growth → MROUND $250** (flat), **weighted-avg DISTRIBUTION
(WAVG)** — Troy's Excel formula: each month = (2×month + prev + next)/4 of a
pickable source (seller T12 line or Minot comp line, per-unit scaled) × growth,
MROUND to a prompted multiple — **seller actuals matched to a pickable seller
line × growth**, reset to engine. WAVG picker (fixed 2026-08-21 PM after the
"Lease Terms 79K→30K" surprise): seller actuals now rank first, Minot rows show
the per-unit-SCALED total ("$79,000 → $30,000 at 268u"), and the MROUND prompt
previews the resulting annual total. **Year 1 column is editable**: type a new
annual total and the months rescale proportionally (distribution flows
backwards; TOTAL chip, penny-fixed, standing MROUND still applies).
**⧉ Copy formulas…** (editor header): replay another budget's named formulas
(WAVG, T3, Seller line, Minot $/unit) onto this budget — each re-evaluates on
THIS property's own seller T12 / comps at its units, so nothing references the
source property; fixed values (manual, typed totals, flats) never copy; standing
MROUNDs copy optionally; preview shows recomputed Year-1 totals; one Undo
reverses the whole copy. Inline param inputs beside chips (vacancy %,
GPR growth, renewal %, mgmt %, utility growth/recovery, rate). Row-buffered
editing (focus selects, Tab flows, saves on row exit). Bulk **MROUND is a
STANDING modifier, not a lock**: sets a per-line rounding multiple that
re-applies after every regeneration/tie (≈$250 badge; 0 clears; lines stay live
on their formulas). **Undo** (25 snapshots). Column picker. Dark mode.
Tie-out panel with UW-native subtotals (Net GPR, Total Rental Income, Vacancy
split from Delinq & Other, Total Other+Utility, EGI/OpEx/NOI). Monthly trend
chart (toggle series, tight scale). Assumptions dialog (⚙). Exports: 2 Yardi
CSVs (byte-exact ETL format, cutoff option) + styled review workbook
(FHND-style, live formulas, UW column, driver colors, Summary, Raw Data).

## Current budget state (prod, 2026-08-22 after the LTL fix)

All six: LTL = clean declining burnoff from the rent-roll gap (RRND's
"growing LTL" bug is fixed — it was the removed auto income-tie).
**Income variances visible, awaiting Troy's placement** via the "tie income"
chooser: cwnd −153k, drnd −30k, nrnd −18k, lhnd +2k, mwnd +26k.
**RRND is special**: it shows ~138 "manual" overrides — Troy confirmed
(2026-08-21 PM) these are NOT manual work: they're leftovers of the old bulk-
MROUND that LOCKED lines (override+manual) instead of setting a standing
multiple. The editor's 🔓 overrides-audit chip detects them (MAN lines whose
months sit in exact $ multiples) and releases them back to live engine
formulas with a standing MROUND. Its EGI/NOI variance shows because locked
flex lines block the NOI tie — releasing fixes that too. Going forward,
hand-edits on formula lines keep the formula identity (`revised` flag, `*`
on the chip) instead of demoting to MAN.

## 2026-08-27/28 round-up (see PROJECT_MAP + git log for detail)

Formula copier (⧉, replays recipes incl. zero-outs on the target's own data,
ends with recalc) · overrides audit + round-lock release (🔓 chip) · revised
formulas keep identity (`*`) · GL Active flag kills comp-weight contamination
(5118 COMMERCIAL RENT ≈ half of cat-5 weight) · non-accrual ⚠ + bold-red rows +
one-click missed-bill smoothing + T12-total-on-curve tool (winter curve) ·
utility recovery = per-utility EXCLUSIVE claims (sewer→sewer always; GAS REIM
also takes 6604 electric-common; STREET REIM never; unmatched reims zero;
editable per budget via REC chip; live on every edit) · linked lines (= GL ×
weight, live) · payroll: relink on upload, edit-in-place (✎, add-property,
6405→6404 — nothing maps to 6405), delete auto-repoints, March +3.5% raise,
burden follows actual wage lines live · NOI tie can opt into scaling formula
overrides (chooser shows per-category room; alerts on shortfall) · capital =
Fee Breakdown capital-to-close (lhnd 5.2M nrnd 3.2M rrnd 6.6M cwnd 11M drnd
9.2M mwnd 4.4M — EXISTING budgets need it typed into ⚙) · seller category
shapes smoothed (Aug utilities dip = fake last-month NOI spike) · full-width
layout + ⏴ Panel + condensable headers · SP section always visible, orange ·
save points (⎘, persisted iterations, auto pre-restore capture) · dashboard
shows per-budget income/opex/NOI, Δ vs UW, CoC, override mix, save points.

## 2026-09-10 — Actualize month (Troy's partial-month rule)

After the first partial month of ownership closes, that month is budgeted 1:1
to what posted (Cash book). In the editor: **✓ Actualize month…** → upload the
month-end Yardi Property Comparison (Book = Cash, one period) → the budget's own
Actual column is mirrored onto the upload chart; 5006 TENANT RENT lands on 4994;
loan proceeds (3080), depreciation/amortization (8500/8601) and balance-sheet
rows are excluded and LISTED; report subtotal rows are skipped. Stored on
`inputs.actuals["YYYY-MM"]`; plan lines untouched (overlaid on read/export).
For the Sep-start Bismarck/Jamestown budgets Aug-26 is a **pre-start** month:
it appears only in the 2026 Yardi CSV (Amount8) + Raw Data, not in the grid.
Cells in a locked in-window column stay editable (an edit corrects the posted
figure); "release" hands the month back to the plan. Save point + Undo cover
both. RRND was done by hand first (2026-09-10: 40 lines, income 175,435.10 /
opex 8,873.63 tie to the report) and the tool reproduces that file exactly.
**Off Yardi (same day, Troy: "changes are sometimes made in Yardi — don't undo
them"):** dashboard **✓ Actualize from Yardi CSVs…** — upload the comparison + each
property's budget CSV exported from Yardi; the property comes from the CSV header;
only the closed month's column changes, everything else stays verbatim; the
matching budget records the month and (adopt, default on) takes the CSV's other
months as YARDI overrides. Done 2026-09-10 for rrnd, lhnd, nrnd, drnd off their
Yardi exports (each ties to 5500 / 7279 / 7315), then all six off the six-budget
Yardi export (Budget.csv, one //Budget block per property — the first cut read it as
one MWND budget and broke Meadows; fixed the same day, per-block parsing + a test).
Also fixed the same day: a TDZ bug (actIdx used before declaration in gridHtml) that
blanked the editor for every budget on the first deploy. If MWND's plan shows odd
YARDI overrides from the broken run, re-run the CSV feature with adopt on (it
re-syncs the differing lines) or restore its "before actualize" save point.

## 2026-10-01 — ANNUAL (non-acquisition) budgets — the primary use from here on

Phase 3 landed: `budget_type = 'annual'`, a calendar-year operating budget for a
property Monarch already runs. **No UW book — the reference is the property's own
statements**, and the METHODOLOGY IS MONARCH'S YARDI BUDGET TEMPLATE
(`budgetYSR<year>_budget_<id>.xlsm`, one per property, exported from Yardi; Troy
supplied the raw clnd/grks templates + last year's GRKS/THMO RMC drafts as the spec).
Engine: `shared/annual.ts` (pure, 32 tests in `test/annual.test.ts`, incl. a
reproduction of the clnd template's own cached Budget Worksheet values and the
GRKS draft's Summary T12 income/expense/NOI to the cent).

**Data flow.** Uploads → *Yardi budget template* (multi-file, one per property):
`parseYardiBudgetTemplate` reads PriorFinancials (14 months of MTD actual +
MTDBudget per GL) → two `stmt_snapshots` (kind `actual` = the template's PY months
Jan–Oct this year + Nov–Dec last year; kind `budget` = Jan–Dec current-year budget)
+ one `template_snapshots` row (debt schedule, ManFeeMatrix + Q4 actual fee %,
Conservice utility forecasts by GL/month, BudgetSuggestions, LeaseGoals /
LeaseExpirations, PropertyInfo units/capital, MortgageDetail, DistHist, the
Budget Worksheet assumption cells: renewal %, burnoffs, GPR % changes, October
vacancy %). **"Paste Payroll Here" is never read** (restricted roster) — payroll
comes from the regional payroll model. A property the chart doesn't know (grks)
is created on the fly. A plain *12 Month Statement / 12 Month Budget* export also
works (`parseMonarchStatement`). Budgets link `py_stmt_id`, `cy_budget_stmt_id`,
`template_id` (Data sources panel re-points; delete re-points to the newest).

**Rules (defaults = the template; Troy's upgrades where the data exists):**
every ordinary GL = SAME CALENDAR MONTH of the T12 × (1 + factor): admin 5%,
maint/rehab 5%, reims + websites 5%, trash 7%, utilities per the Conservice
forecast (per GL per month), other income 0% · "October actual" lines flat
(HAP, RE tax, auto ins, phones/cable/internet, models/admin/down, write-offs,
concession lines) · GPR = rent-roll market rents (or Oct actual) × the template's
monthly % changes · LTL = per-lease burnoff when the rent roll is linked, else the
template's expiration method; market growth deepens LTL 1:1 (`ltl.followGpr`) ·
vacancy = Oct % × GPR · delinquency / prior-period / PEP / recapture at their
ratios (`pctGpr`) · application / deposit / admin fees = last year's $ spread by
this year's projected move-ins (`perTurn`) · rent-roll charges × 12 (pet, garage,
storage, ub*) · corporate rates: insurance $285/unit/yr, IT $483/mo + $43.14/unit,
legal $7.86/unit, marketing alloc $24.76/unit (`corpRate`, editable) · accounting /
third-party billing / donations from BudgetSuggestions, software $275/mo
(`suggested`) · mgmt fee = Q4 actual % × income, whole dollars · interest 7300 and
principal 3080 straight off the amortization schedule (`debtService`) · payroll
model wages + burden at the property's own benefit/wage ratios · special projects
zero (per site). **NOTHING ties automatically** (tieNoi/tieIncome default off);
the tie-out compares to T12 actuals / CY budget / typed targets (picker in the
tie card), category "tie" = match the reference. Grid shows T12 and CY-budget
columns; row menu adds "Own T12 → shape × factor…", "% of GPR…", "Corporate
suggestion…"; the seller-line / WAVG / T12-curve tools run on the own statement.

**Exports**: single calendar-year Yardi CSV (same byte-exact format); review
workbook = Budget tab with T12 Actuals + CY Budget columns, Summary in the
template's analysis layout (Trailing 12 / Budget / Δ / per unit / CY budget / Δ /
4-months-annualized / % change — same rows A–H so the Portfolio tab still rolls
up), Raw Data lists the reference columns + template facts.

**New rent-roll format**: Yardi "Rent Roll with Lease Charges" (9/30/26 export,
15 ND sites, 3,305 units) parses with per-lease detail AND per-property recurring
charge codes (the charge-driven other income the plain roll never had). Also
fixed: Yardi omits the section marker between properties when the prior one has
no Future section (phnd was dropped) — both unit-level parsers now continue.

**Local dev without a system Postgres**: `npm run db:local` boots an embedded
PostgreSQL 18 in `.pgdata/` (devDependency `embedded-postgres`), then
`npm run dev`. Fixtures (gitignored): `yardi-template-clnd.xlsm`,
`yardi-template-grks-draft.xlsm`, `rentroll-lease-charges.xlsx`.

**The foundation = the GRKS draft's formulas (Troy, same day).** Every Budget
Worksheet formula of `GRKS Budget Draft RMC 11.16.2025.xlsm` was classified and
written to `seed/annual-rules.json` (272 GLs; `node scripts/extract-annual-rules.mjs
<draft.xlsm> --write` regenerates it from any draft). Four history methods carry
~210 GLs: `same` (PY same month × factor, MROUND $10 / $50 — most other income,
admin lines), `wavg` (the 1-2-1 weighted average × factor, MROUND $25–$300 —
electric, gas, sewer, water, trash, application / NSF / misc fees, lease
terminations, MTM, pet move-in, sewer reim, painting contractor), `flatT12` (T12 ×
factor ÷ 12, flat, only when the T12 exceeds $1,000 — ~110 small / erratic lines:
most admin, all in-house maintenance, CAM, contract services, rehab), `last`
(October actual flat — HAP, concessions, models / admin / down, write-offs, taxes,
phones, cable). Factors by section as RMC set them: other income 0%, reims 5%,
admin 5%, maintenance / CAM / contract services 10%, rehab 15%, utilities 5% flat
(trash 7%, internet 3%) — the Conservice per-month forecast is now OPT-IN
(`baseline.useUtilForecast`). The engine's precedence: a budget's own per-GL
override (chip input / "Own T12 → shape × factor…" / `glMround`) → the GL's
foundation rule → the built-in template rules → the budget-wide shape / category %.
RMC's typed numbers (payroll, reims flat 9,000, RE tax 103,355 ÷ 12, delinquency
seasonal multipliers) are property decisions, not rules — they stay with the engine
defaults (payroll model, PY × factor, October actual × 3%, T12 ratio). Verified:
with the rules on, the engine lands on RMC's own cells where the formulas were left
alone (6604 Jan 800, 6702 2,092, 5165 Jan 1,050).

**Open items for Troy**: confirm the default increase factors and corporate
rates for 2027 (they're the 2026 template's); decide whether GPR should default
to the rent roll (current) or October actual for existing sites; HAP / Section 8
properties may need 4995/4996 driven off the HAP roll; the ManFeeMatrix tiers are
shown, not auto-applied (fee % stays an input).

## Known gaps / next steps

- **Unit-level rent roll support LANDED (2026-08-21 PM):** the parser now reads
  the Yardi multi-property unit-level "Rent Roll" export (sections per property,
  closed by "Total | Name(code)" rows; occupied = t-prefixed resident ids,
  VACANT/MODEL/ADMIN excluded from leases; in-flight $0-actual residents count
  occupied but carry no lease). The upload panel shows a Leases column and a
  **"Relink existing budgets & regenerate" checkbox** (default on) — one upload
  flips every mapped budget to the per-lease LTL burnoff. The 8/21/26 roll
  (RentRoll08_21_2026.xlsx, all 15 ND properties, 3,305 units) is the test
  fixture; the six subjects tie exactly. **Remaining: Troy uploads it in prod.**
  Note: this Yardi format has no charge-code columns, so charge-driven other
  income still needs an export with charges (OneSite detail).
- After budgets are final: export 2026 Revision CSVs to replace the seller
  budgets in Yardi + 2027 CSVs for Jan–Aug.
- Phase 3 annual-budget mode needs a monthly-actuals export (Property Comparison
  on Actual book, or 12-month income statement).
- Capital figures are price−loan estimates; refine for true CoC.
- Railway CLI is v5.23.3 (upgrade available); deploys via `railway up`, ~2-4 min;
  app assets are no-cache so a normal refresh picks up new UI.
