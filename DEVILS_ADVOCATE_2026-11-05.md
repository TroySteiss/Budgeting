# Devil's advocate review — nd-budget-tool (2026-11-05)

> **Addendum (same day):** killers #1, #2 and #3 were fixed after this review — 6116 now
> budgets the trailing-12 total flat (`FIXED_ANNUAL_GLS`) and other `last`-shape lines flag a
> last month >25% off the average; a typed category % now outranks the per-GL foundation
> factors (migration 009 strips untouched defaults); leases ending between the roll date
> and the budget start are treated as already turned. Measured on the fixtures: clnd taxes
> 407k → 471k, R&M +25% now moves cat 13 +16.7% (was +3.9%), 2027 income +36k clnd /
> +41k bcnd / +53k ecnd off the 9/30 roll. Everything else below still stands.

Scope requested: things that would change the outcome of the budget itself. Focus is the
**annual (non-acquisition) engine** (`shared/annual.ts`, the importers it depends on, and the
tie/edit routes), since that is the primary use from here on. Acquisition mode gets a shorter
section. Every "Confirmed" item below was reproduced by running the engine on the real fixture
files (`yardi-template-clnd.xlsm`, `yardi-template-grks-draft.xlsm`, the 9/30/26
`rentroll-lease-charges.xlsx`) or by a synthetic probe; "Plausible" is a code-reading inference;
"Assumption to verify" depends on facts I do not have. The suite passes (176 tests), so nothing
here is a regression against what the tests assert; the problem is what the tests assert.

---

## 1. Verdict

As designed, the tool will reliably produce a budget that **reproduces Monarch's Yardi template,
including the template's own blind spots**, and then lets a user believe they have tuned it when
they have not. Three mechanisms move NOI by material amounts in a direction nobody chose: the
"October actual × 12" rule on real estate taxes and other lumpy lines, the loss-to-lease/turnover
timing when the rent roll is older than the budget start, and a management fee rate applied to a
wider income base than the one it was measured on. A fourth, the category growth inputs being
silently outranked by per-GL factors copied from one RMC's draft, is the one most likely to make
users stop trusting the tool. None of these are caught by the current tests because the tests
check fidelity to the spreadsheet, not correctness of the budget.

## 2. Top killers (ranked)

| # | What fails | Measured on fixtures | Status / severity / likelihood |
|---|---|---|---|
| 1 | **Real estate taxes = last actual month × 12.** 6116 is in `LAST_MONTH_FLAT_GLS`; the GRKS rule for it is `fixedAnnual`, which the engine does not implement, so it falls through to "October flat". A single month's accrual true-up sets the whole year. | clnd: engine 407,168 vs T12 471,448 vs the CY budget Monarch actually loaded 517,021. NOI overstated by 64k–110k on one property. Synthetic: October = 0 ⇒ taxes budgeted 0. | Confirmed · **Fatal** (per site) · High |
| 2 | **Category growth % inputs mostly do nothing.** `pctFor` ranks the GL's foundation-rule factor above `baseline.growthPct[pcode]`, and ~210 GLs carry a factor from the GRKS draft. The Assumptions dialog still shows ten category boxes. | Setting R&M, admin and insurance to +25%: cat 9 moved +2.9%, cat 13 +3.9%, cat 6 0%. | Confirmed · **Major** (trust) · High |
| 3 | **Leases that expire between the roll date and Jan 1 are modelled as month-to-month for the whole budget year.** `ltlModel` buckets `idx < 0` as MTM and resets one twelfth a month; `expirationsFromLeases` puts the same leases in **January**. With a 9/30 roll and a 2027 budget that is two months of expirations. | bcnd 109 of 539 leases ($10.5k/mo of a $51k gap), ecnd 108 of 352 ($13.3k of $37.5k), clnd 69 of 330. January "expirations": bcnd 126, ecnd 121, fhnd 96. Those drive LTL (income understated, my estimate $40–55k/yr at bcnd/ecnd), turn costs (February spike) and per-move-in fees. | Confirmed mechanism, $ estimated · **Major** · High |
| 4 | **Management fee % applied to a different base than it was measured on.** `mgmtPct` = template Q4 "actual %" (fee ÷ ManagementFeeActual income), applied to the full 5500 total income of the prior month. | clnd: 4.00% used, T12 effective rate on 5500 is 3.74%; fee budget 231,203 vs T12 209,977 (+10.1%) while income is +3.5%. ≈$15–20k expense overstatement per large site. | Confirmed delta, cause plausible · Major · High |
| 5 | **No sanity bound on template-derived GPR steps.** `pctNum` returns a bare number as a fraction; a "$15" typed in the % row (Joe's draft did this) becomes a ×16 step. The 2027 draft is already known to put $ in that row. | Synthetic: one "15" in March ⇒ annual GPR 16.2M on a 1.2M base. | Confirmed · Major · Medium |
| 6 | **The template's LeaseExpirations sheet is accepted as-is.** clnd's says 31 expirations for 341 units (2 in Sep, 29 in Oct). With no roll linked, LTL burns off almost entirely in October and 5152 deposit forfeitures become $6,805 per move-in. | clnd LTL −32,414 Sep → −6,195 Oct; 5152 `perTurn` amount 6,804.92 on 10.44 turns. | Confirmed · Major · Medium (only when no roll/UAD is linked) |
| 7 | **"T12 ÷ 12 flat only above $1,000" zeroes real spend.** 110 GLs carry `flatT12`; below the threshold the line stays at zero. Same rule on `last` shape: a GL that happened to be 0 in October budgets 0 (GRKS 4996 HAP voucher, $5,320 of income, → 0). | clnd 17 lines / $5,038; GRKS 28 lines / $10,891 plus $5,320 income. Small per site, always one direction (NOI up). | Confirmed · Minor–Major · High |

---

## 3. Full findings by layer

### 3.1 Premise and purpose
- **The success metric is "reproduce the template to the cent", not "produce a better budget".** The annual tests assert that the engine lands on the clnd template's cached cells and the GRKS RMC draft's cells. That proves fidelity to a spreadsheet whose own notes say "CONFIRM AMOUNT TO BUDGET WITH ACCOUNTANT" next to the rule the engine automates. Status: Confirmed · Major · High. *Early warning:* budgets that match the template exactly but not what accounting loads into Yardi (clnd 6116: template 407k, loaded 517k).
- **Alternative that could win:** keep Yardi's template as the engine and use the tool only for data assembly (T12 composition, rent roll, payroll) and exports. The parts of the tool that add real value (per-lease LTL, UAD expirations, payroll flow, Yardi CSV, portfolio workbook) do not depend on re-implementing the template's arithmetic. Status: Plausible · n/a.

### 3.2 Stakeholders, adoption, incentives
- **RMs will type over cells.** After finding #2 (category % does nothing) and #3/#6 (front-loaded turn costs), the rational RM response is to override. Overrides survive every regeneration (`mergeFresh`), so one season of overrides turns the engine into a one-time generator; the growth ties then report "no trailing-12 × factor lines left to move". Status: Plausible · Major · High. *Early warning:* override count per budget rising past ~30 (RRND already hit 138 in acquisition mode for a different reason).
- **Troy is the only person who can explain why a line landed where it did.** The driver chips help, but the precedence chain (`glGrowth` → rule factor → `TEMPLATE_GL_PCT` → category) is undocumented in the UI beyond a one-line footnote. Status: Confirmed · Major · High.

### 3.3 Financial / model assumptions (annual engine)
Ranked within the layer.

| What fails | Why / where | Status | Sev | Lik | Early warning | Mitigation |
|---|---|---|---|---|---|---|
| RE taxes = October × 12 (killer #1) | `LAST_MONTH_FLAT_GLS` has 6116; rule `fixedAnnual` is not in `RULE_SHAPE` so `ruleOf` returns null | Confirmed | Fatal | High | cat 8 Δ vs T12 ≠ 0 with no explanation | Default 6116 to T12 total (or CY budget), flag it as "confirm with accountant"; implement `fixedAnnual` as "typed annual ÷ 12" |
| Same "last month" rule on 6104, 6616–6619, 6630, 5018–5028, 5032–5034, 5040, 4995/4996 | one lumpy or zero month sets the year (GRKS 6104: T12 122 → budget 785; 4996 T12 5,320 → 0) | Confirmed | Major | High | any `LAST` chip whose October ≠ T12/12 by >25% | warn when `cal[last]` deviates from the T12 average by >25%; default HAP lines to T12 |
| Mgmt fee base mismatch (killer #4) | `feePct` from `ManagementFeeActual` applied to rollup 5500 of the prior month | Confirmed delta | Major | High | cat 7 growth ≫ income growth | derive the rate from T12 6112 ÷ T12 5500 unless the user types one; show both |
| LTL / expirations for leases ending before the budget start (killer #3) | `ltlModel` `idx < 0 → -1` (MTM bucket); `expirationsFromLeases` `k < 0 → 0` (January) | Confirmed | Major | High | January expirations ≫ any other month; LTL Jan ≈ full roll gap | treat lease ends between roll as-of and budget start as already turned (burn at month 0 with the renewal mix); show the roll's as-of date next to the LTL chip and refuse rolls older than 60 days before start without a warning |
| Renewal assignment "largest LTL renews first" keeps the deepest discounts | `ltlModel` sorts expiring by gap desc and renews the top `renewalPct` | Confirmed (design) | Minor–Major | High | LTL Σ consistently ≥ T12 even with GPR growth | document; offer random/average assignment |
| Template expirations accepted unvalidated (killer #6) | clnd 31 expirations / 341 units | Confirmed | Major | Medium | expirations total < 50% of units | warn when Σ expirations < 0.6 × units or > 1.2 × units |
| `perTurn` lines cannot change the annual total | `amt = T12 ÷ this year's turns` ⇒ budget = T12 exactly | Confirmed | Minor | High | 5152 budget == T12 to the cent | compute $/turn from LAST year's turns (template) or from the typed fee |
| Vacancy applies to 4994 only | `mk('5031', gpr.map(...))`; 4995/4996 flat | Confirmed | Minor | Medium | HAP sites: cat 3 Δ | include HAP lines in the vacancy base as the template does |
| A 100% HAP site (all rent on 4995/4996) gets no GPR line, no vacancy, no %-of-GPR lines | `gprBase = lastOf('4994')` = 0; `annualizeDead` returns early | Assumption to verify (are there such sites?) | Major | Low | 4994 absent from T12 | fall back to 4994+4995+4996 |
| 5035 delinquency ratio includes itself in the denominator | `detail.filter(code 4994..5035)` includes 5035 | Confirmed | Minor | High | delinquency Δ ≈ +5% at 0% growth | exclude 5035 (template row 41 is excluded there) |
| 5036 prior-period, 5032–5034 at T12 ratios to GPR | fine, but a year with an eviction surge or a model unit change is repeated | Plausible | Minor | Medium | | |
| Lumpy one-offs repeated in the same month | shape `actual` for `same` rules (GRKS snow 6934: 63% in one month) | Confirmed (design) | Minor | High | single month > 40% of a line | offer outlier smoothing like `shapeSmells` does for seller T12 |
| `flatT12` $1,000 threshold zeroes lines (killer #7) | `threshold && |T12| ≤ 1000 → return false` | Confirmed | Minor | High | many `manual` 0 lines with history | budget them flat anyway, or at least list them |
| Corporate rates are 2026 constants | `CORP_RATES` 285 / 390+93 / 7.86 / 24.76 hard-coded; UI shows them as editable per budget only | Assumption to verify for 2027 | Major | High | 6108 Δ vs CY budget on every site | one admin-level table per budget year |
| 6451 zeroed while 6310 carries the $43.14/unit allocation | matches the template (6451 formula is literally 0; actuals post ~$43/unit to 6451 and ~$15/unit to 6310) | Confirmed-consistent, **not a bug** | — | — | | note it in the chip so nobody "fixes" it |
| Utilities flat 5% (trash 7%) unless Conservice opt-in | design choice; Conservice forecast is per-GL per-month and is OFF by default | Confirmed (design) | Minor | Medium | | |
| Debt: no template ⇒ interest = last actual month flat | ignores amortization / IO roll-off (clnd IO ends 2028-11, GRKS amortizing) | Plausible | Minor | Medium | | use `MortgageDetail` when present |
| GPR base when the T12 is "N mo annualized" | `annualizeDead` fills the dead month with the live average, and if that is the last month, `lastOf('4994')` is an average, not the latest run-rate | Confirmed (synthetic) | Minor | Low | "annualized" badge + GPR base < October actual | |

### 3.4 Strategic / external
- **Yardi template drift is the import source and the export target.** The 2027 draft already moved 6331 to column D, added a MoveOuts sheet, added five GLs the seed chart lacks (5141, 6304, 6341, 6613, 6624) and relabelled 5160/5161. Postings on unknown GLs are dropped at parse (`keep`), so T12 totals quietly understate and those lines are never budgeted. Status: Confirmed for the mechanism (memory note + `keep` in `parseYardiBudgetTemplate` / `parseMonarchStatement`), $ unknown · Major · High. *Mitigation:* parse unknown GLs into an "unmapped" bucket shown in the tie-out.
- **Joe's edits vs Quentin's template.** The tool implements Troy's preferred method on several lines (turn costs on expirations + 1 month; concessions off T12 ratio) while the template and Joe's asks differ. Whoever signs off on budgets will compare to the template. Status: Plausible · Major · Medium.

### 3.5 Legal / compliance / data
- **A shared login password is written in plain text in a git-tracked file** (`HANDOFF.md`, "What & where"). Org policy requires login credentials be redacted; the repo is on GitHub. Not repeated here. Status: Confirmed · Major · High. *Mitigation:* remove from the doc, rotate the password, rewrite history or accept the leak.
- Payroll per-seat data is gated (`RM_PAY_USERS`), but the gate is an env allowlist with hard-coded defaults in `src/auth.ts`. Status: Confirmed · Minor · Medium.

### 3.6 Organisational / operational
- **Bus factor 1.** Deploy is `railway up` from one laptop; `seed/annual-rules.json` is regenerated by a script from one specific draft workbook; the rules encode one RMC's choices for 272 GLs as the portfolio-wide foundation. Status: Confirmed · Major · High.
- **Rules JSON is a snapshot of GRKS 2026, applied to every ND site.** Example: 5157 admin fee is `same` MROUND 50 with no factor; 6926 painting `wavg` MROUND 300; 110 GLs `flatT12` with factors 0–15% chosen for a 100-unit property. These outrank the engine's own template rules and the per-move-in logic (`if (ruleOf(gl)) continue` in the turn block). Status: Confirmed · Major · High.

### 3.7 System / architecture
- **Management fee is not a dependent pass.** Hand-editing 4994 or any income line (an override) leaves 6112 stale until Recalc; the CSV/XLSX export routes use `effectiveLines` without a recalc. Status: Confirmed by code · Minor · Medium. *Early warning:* 6112 ≠ fee% × prior-month income in an export.
- **Growth ties move lines that should not move.** `tie-growth` for `opex`/`noi` shifts every `baseline` line's factor, which includes `last`-shape lines (RE taxes, phones, HAP) and `flat` lines. An NOI target therefore changes the property-tax budget. Status: Confirmed by code · Major · Medium.
- **`trailing12` merges statements first-wins per cell with no book check.** A Cash-book export and an Accrual-book export for the same property compose into one T12; the linked statement wins only where it has data. Status: Plausible · Major · Low–Medium. *Mitigation:* refuse to compose across books.
- **Stale linked snapshot.** A newer statement/roll upload does not re-point existing budgets unless "relink" is ticked; the UI shows a ⚠ only inside the Data sources panel. Status: Confirmed · Minor · Medium.

### 3.8 Data
- `num()` parses "(1,234.00)" to **0**, not −1234 (`parseFloat("(1234.00)")` is NaN). xlsx exports carry numbers natively so this is dormant, but any text-formatted export or CSV path silently drops negatives. Status: Plausible · Minor · Low.
- `pctNum` bare numbers (killer #5). Status: Confirmed · Major · Medium.
- UAD parser: a lease with $0 resident rent (employee units) counts as occupied but has no lease, so it is absent from LTL and expirations. Status: Confirmed · Minor · Medium.
- Mid-month statement export: the partial month becomes the last actual month; the dead-month fill rescues the totals (verified), but `last`-shape lines then use an average rather than an actual, and the GPR base is the live average. Status: Confirmed · Minor · Medium.

### 3.9 Implementation / code-level (annual)

| File:line | Bug | Status | Sev |
|---|---|---|---|
| `shared/annual.ts` `LAST_MONTH_FLAT_GLS` + `baseline()` | 6116 October × 12 (killer #1); `fixedAnnual` rule method unimplemented | Confirmed | Fatal |
| `shared/annual.ts` `pctFor` | rule factor outranks `baseline.growthPct[pcode]` (killer #2) | Confirmed | Major |
| `shared/domain.ts` `ltlModel` / `shared/annual.ts` `expirationsFromLeases` | pre-start lease ends: MTM in one, January in the other (killer #3) | Confirmed | Major |
| `shared/annual.ts` 5035 block | denominator includes 5035 | Confirmed | Minor |
| `src/importers.ts` `pctNum` / `gprPct` | no bound on step size (killer #5) | Confirmed | Major |
| `shared/annual.ts` turn block | `amt = T12 ÷ this year's turns` ⇒ no sensitivity to turnover | Confirmed | Minor |
| `shared/annual.ts` wavg edge | Jan/Dec fall back to same-month MROUND 10 to mimic an Excel range limit — an artifact baked into the engine | Confirmed | Minor |
| `shared/annual.ts` `annualBaseline` MROUND | `Math.round(v/mult)*mult` rounds −2.5 toward +∞; Excel MROUND rounds away from zero | Confirmed | Minor |
| `src/routes.ts` `tie-growth` | `adjustable` includes `last`/`flat` baseline lines | Confirmed | Major |
| `src/routes.ts` export routes | no recalc of dependent lines (6112) before export | Confirmed | Minor |
| `src/importers.ts` `parseMonarchStatement` | `kind='budget'` only if a row's column A is exactly "Budget"; a mis-detected budget export would be composed into the T12 as actuals | Plausible | Major (if it happens) |

### 3.10 Acquisition mode (shorter)
- **NOI is forced to the UW number by scaling R&M / rehab / marketing / admin** (`tieNoiToUw`, on by default for acquisitions). The operating budget's maintenance lines are therefore a plug, and site teams will be measured against it monthly. Status: Confirmed (policy) · Major · High.
- Interest = loan × rate ÷ 360 × days with no amortization or IO roll-off; capital is typed. Status: Confirmed · Minor.
- Vacancy = UW 5% flat, concessions = UW % × GPR; seller T12 used for shapes only except utilities, where seller *levels* × 3% are the basis (a new owner's utility contracts and RUBS program will differ). Status: Plausible · Minor–Major.

### 3.11 Testing and verification
- 58 annual tests; the fixture-based ones assert equality with the template's cached cells and the RMC draft, i.e. they would **fail if killer #1 were fixed** (`sum(6116) ≈ 103,355.28` is RMC's typed number landing because October happened to equal T12/12 at GRKS). No test compares an engine budget to what Monarch actually loaded into Yardi (the CY budget statement is on file and shows clnd 6116 = 517,021). Status: Confirmed · Major · High.
- No test exercises a rent roll older than the budget start, a GPR step > 50%, a `last` month of zero, or two statements on different books.

### 3.12 Usability
- The Assumptions dialog shows category growth boxes that are inert for most GLs (killer #2) and a "Lease expirations by month" input prefilled from a template sheet that can be nonsense (killer #6). Status: Confirmed · Major · High.
- Driver chips say `LAST` but not "October was 21% below the T12 average". Status: Confirmed · Minor.

### 3.13 Performance — skipped (single-property regen is sub-second; nothing observed).

### 3.14 Deployment / maintenance / longevity
- `seed/annual-rules.json` and `CORP_RATES` are year-2026 artefacts with no year key; the 2027 template will need both regenerated and nobody but the builder knows the script. Status: Confirmed · Major · High.
- Chart of accounts is a seed file regenerated by a Python script from paths on one machine. Status: Confirmed · Minor · Medium.

### 3.15 Execution / timeline
- Budget season is now; the 2027 template is a draft; five chart GLs are unresolved; the rent roll on file is 9/30. Every one of those is on the critical path for killer #3 and §3.4. Status: Confirmed · Major · High.

### 3.16 Second-order effects
- Once one site's budget is caught with October × 12 taxes, every tool-generated number will be re-checked by hand, which is the exact cost the tool was built to remove. Status: Plausible · Major · Medium.
- Overrides lock in; "copy formulas" propagates one site's hand-tuned recipe to others without its reasons. Status: Plausible · Minor.

---

## 4. Pre-mortem (12 months out)

1. **Taxes (money/data).** Fifteen 2027 budgets went to Yardi in December with 6116 at October × 12. The accountant noticed in March when the first installment posted 40% over budget at three sites. Portfolio NOI budget was overstated by six figures; the CFO asked why a tool "tied to the cent" got taxes wrong, and the answer was that it tied to the wrong thing.
2. **Trust (people).** An RM set "Repairs & maintenance +10%" in Assumptions, saw cat 13 move 1%, and typed over forty cells. The next relink regenerated nothing because everything was overridden; the growth tie reported no lines to move. By February the budget was a spreadsheet with a login.
3. **Rent roll age (data).** The 9/30 roll was never refreshed. bcnd and ecnd carried an extra $50k of loss-to-lease each, February paint budgets were triple any other month, and the deposit-forfeiture line assumed 126 January move-outs. Leasing staff stopped reading the monthly variance report.
4. **Template drift (external).** The final 2027 template renamed two GLs and added five. The importer dropped the five, mislabelled parking vs carports, and read a $ increase as a 15% GPR step at one site. The exported CSV loaded fine; nothing in the tie-out flagged it because the reference T12 had dropped the same GLs.
5. **Bus factor (people).** Troy was out for three weeks in January. Nobody could regenerate `annual-rules.json` for 2027, nobody knew why category percentages did nothing, and the Railway deploy lived on one laptop. Budgets were finished in the Yardi template by hand.

## 5. Kill / redesign criteria

Stop and redesign the annual engine if any of these hold:
- An engine-generated 6116 differs from the CY budget Monarch loaded by more than 10% on more than three sites and the only fix is a manual override.
- After the rules JSON is regenerated from the 2027 template, more than 20% of GLs change method or factor (the "foundation" is then one RMC's annual mood, not a methodology).
- The 2027 Yardi template arrives with a structure the importer cannot parse without code changes within the budget week.
- Accounting insists budgets be reviewed in the Yardi template anyway (then the tool is an exporter, and the engine is cost without benefit).
- Override counts exceed ~40 lines on a majority of annual budgets after the first review round.

## 6. Open questions (answers would change the assessment)

1. Is the PriorFinancials MTD on the Cash or Accrual book? The parser hard-codes `book: 'Cash'`; the clnd 6116 pattern (43,085 × 9, then 33,931) looks like an accrual true-up. If Cash, the October rule is worse than shown.
2. What base is the ManagementFeeActual percentage measured on (collected rent? EGI? 5500)? That decides whether killer #4 is a basis bug or a rate bug.
3. Will the 2027 rent roll / UAD be refreshed in December before export? If yes, killer #3 shrinks to the December expirations only.
4. Are the 2027 corporate rates ($285 insurance, IT, legal, marketing) unchanged? Any change is a portfolio-wide delta on every site.
5. Are there ND sites with rent on 4995/4996 only (HAP contract) or with material postings in 5141/6304/6341/6613/6624?
6. Does accounting actually load the template's output, or a hand-adjusted version (clnd's CY budget says hand-adjusted)? If hand-adjusted, "reproduces the template" is the wrong tie-out target and the CY budget statement should be the default reference.
7. Who besides Troy can regenerate the rules, redeploy, and explain a chip? If nobody, the longevity findings are Fatal, not Major.
