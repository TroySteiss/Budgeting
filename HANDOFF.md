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
