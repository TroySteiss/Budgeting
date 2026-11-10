/* ============================================================================
   ANNUAL (NON-ACQUISITION) BUDGETS — the calendar-year operating budget for a
   property Monarch already runs. The methodology is Monarch's own Yardi
   budget template (budgetYSR<year>_budget_<id>.xlsm — "Budget Worksheet"):

     • every ordinary GL = the SAME CALENDAR MONTH of the trailing-12 actuals
       × (1 + increase factor)   [PriorFinancials: Jan–Oct of this year,
       Nov–Dec of last year]; factors: admin 5%, maintenance/rehab 5%,
       reims/websites 5%, trash 7% (CPI), utilities per the Conservice
       forecast table, other income 0%
     • "October actual" lines (last actual month, flat): HAP, RE taxes, auto
       insurance, phones/cable/internet, models/admin/down units, write-offs,
       fire concession
     • GPR: last actual month × monthly % changes; LTL: last actual month,
       deepened by market-rent growth, burned off by lease expirations ×
       renewal % × burnoff %; vacancy: October % × GPR; delinquency / prior
       period collections: trailing-12 ratios
     • corporate rules: insurance $/unit, IT + legal + marketing allocations
       per unit, accounting / third-party billing from BudgetSuggestions,
       mgmt fee = Q4 actual % × income (ROUND to $1), interest + principal
       straight off the Debt Service amortization schedule
     • payroll from the regional payroll model (wages + the property's own
       burden ratios), special projects entered per site

   Troy's acquisition-tool upgrades layer on top where the data exists: GPR
   anchored to the rent roll, per-lease LTL burnoff, rent-roll charges × 12,
   and the row tools (WAVG / MROUND / T12-on-curve) with the property's own
   statement as the source. NOTHING ties automatically — the tie-out shows Δ
   vs trailing-12 / CY budget / 4-months-annualized, every tie is a button.
   Pure functions, unit-tested; no DB, no IO.
   ========================================================================== */
import {
  type CoaAccount, type BudgetLine, type BudgetInputs, type Months, type Driver, type UwSnapshotData,
  type Lease, type CompWeights, type BaselineShape,
  zero12, r2, sum, rollup, spreadMonthly, rotate12, CURVES, WAGE_GLS, ltlMonths, ltlModel, chargeGlMonthly,
  mergeFresh, overriddenWages, calMonthOf, calYearOf, daysInMonth, dateKey, leaseEndIndex,
} from './domain.js';

/** Bump whenever a formula or default changes what a (re)calculation produces. A budget is
    stamped with it on every full build (budgets.calc_version); the editor flags a budget
    calculated on an older one, because stored lines only move on Recalc. */
export const ENGINE_VERSION = '2026-11-10a';

/** Header label for a budget statement used as a reference column: a calendar year reads
    "2026 budget"; anything else names its real window ("budget Nov-25–Oct-26") — the Yardi
    template's budget covers the trailing-12 window, not a calendar year, and used to be
    labelled with the first year it touched ("2025 budget" on a 2027 budget). */
export function budgetRefLabel(period: string | null | undefined): string {
  const m = String(period || '').match(/([A-Za-z]{3})[a-z]*\s+(\d{4})\s*[-–]\s*([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) { const y = String(period || '').match(/\d{4}/); return y ? `${y[0]} budget` : 'CY budget'; }
  const [, m1, y1, m2, y2] = m;
  if (/^jan$/i.test(m1) && /^dec$/i.test(m2) && y1 === y2) return `${y1} budget`;
  return `budget ${m1}-${y1.slice(2)}–${m2}-${y2.slice(2)}`;
}

/* ---------------- statements (own trailing-12 actuals / current budget) ---------------- */

export interface StmtRow { gl: string; name: string; months: number[]; total: number }
export interface StmtData { monthCal: number[]; monthYear?: number[]; rows: StmtRow[] }

/** Statement → calendar (Jan..Dec) series per GL. Columns may start at any
    month (Nov-24 … Oct-25): each lands on its calendar month. */
export function stmtCalendar(stmt: StmtData | null | undefined): Record<string, Months> {
  const out: Record<string, Months> = {};
  if (!stmt?.rows) return out;
  for (const r of stmt.rows) {
    const cal = zero12();
    (r.months || []).forEach((v, i) => { const c = ((stmt.monthCal?.[i] || i + 1) - 1 + 12) % 12; cal[c] = r2(cal[c] + (Number(v) || 0)); });
    if (cal.some((v) => v)) out[String(r.gl)] = cal;
  }
  return out;
}

/** The statement's LAST actual calendar month (1-12): the latest column by
    year+month. Defaults to October — the template's cut-off. */
export function stmtLastMonth(stmt: StmtData | null | undefined): number {
  if (!stmt?.monthCal?.length) return 10;
  // a calendar-year export (Jan–Dec 2026) carries EMPTY future columns —
  // the last actual month is the last column with anything posted
  const hasData = (i: number) => (stmt.rows || []).some((r) => Number(r.months?.[i]) || 0);
  let best = -1, bestCal = 10;
  stmt.monthCal.forEach((m, i) => {
    if (!hasData(i)) return;
    const key = (stmt.monthYear?.[i] || 0) * 12 + m;
    if (key > best) { best = key; bestCal = m; }
  });
  return bestCal;
}

/** The TRAILING TWELVE posted months across every actual statement on file for
    a property. A calendar-year 12 Month Statement exported in November has
    Jan–Oct posted and Nov–Dec empty: the last posted month sets the window
    (Nov last year … Oct this year) and the two prior-year months come from
    whichever other statement covers them (last year's export, the template's
    PriorFinancials). `missing` lists window months no statement covers — those
    stay zero and the UI says what to upload. The preferred statement wins
    where two cover the same month. */
export interface Trailing12 {
  cal: Record<string, Months>; lastMonth: number; lastYear: number; period: string;
  /** window months no statement covers (left zero) */
  missing: string[];
  /** window months with NO rent (pre-acquisition / not yet operating) — filled
      with each GL's average over the live months, so the T12 is annualized */
  dead: string[];
  /** months with operations in the window (12 when nothing is dead) */
  liveMonths: number;
  /** the first month(s) of operations after an acquisition, LEFT OUT of the history like the dead months */
  startup?: string[];
  /** months 2-3 of operations still in the history — start-up noise is likely; review them */
  early?: string[];
}
/** How many start-up months of a new acquisition are left out of its history by default. */
export const STARTUP_EXCLUDE_DEFAULT = 1;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function trailing12(stmts: (StmtData | null | undefined)[], opts: { excludeStartup?: number } = {}): Trailing12 | null {
  const list = stmts.filter((s): s is StmtData => !!s?.rows?.length && !!s.monthCal?.length);
  if (!list.length) return null;
  // (year*12+month) → gl → value, first statement in the list wins
  const cell = new Map<number, Map<string, number>>();
  const covered = new Set<number>();
  let last = -1;
  list.forEach((s) => {
    // a statement covers every column up to its LAST POSTED one; empty columns
    // after that are the future (a Jan–Dec export pulled in November), empty
    // columns before it are covered months with nothing posted (pre-acquisition)
    let sLast = -1;
    s.monthCal.forEach((m, i) => {
      const y = s.monthYear?.[i];
      if (y && s.rows.some((r) => Number(r.months?.[i]) || 0)) sLast = Math.max(sLast, y * 12 + (m - 1));
    });
    s.monthCal.forEach((m, i) => {
      const y = s.monthYear?.[i];
      if (!y) return;                       // undated columns can't be placed in a window
      const key = y * 12 + (m - 1);
      if (key > sLast) return;             // an empty future column is not data
      covered.add(key);
      if (key > last) last = key;
      if (!cell.has(key)) cell.set(key, new Map());
      const col = cell.get(key)!;
      for (const r of s.rows) { const gl = String(r.gl); if (!col.has(gl)) col.set(gl, Number(r.months?.[i]) || 0); }
    });
  });
  if (last < 0) {
    // no dated columns at all: fall back to the preferred statement's own calendar
    const s = list[0];
    return annualizeDead({ cal: stmtCalendar(s), lastMonth: stmtLastMonth(s), lastYear: 0, period: '', missing: [], dead: [], liveMonths: 12 }, 0, opts.excludeStartup);
  }
  const cal: Record<string, Months> = {};
  const missing: string[] = [];
  for (let k = last - 11; k <= last; k++) {
    const m = ((k % 12) + 12) % 12, y = Math.floor(k / 12);
    const col = cell.get(k);
    if (!col) { missing.push(`${MON[m]} ${y}`); continue; }
    for (const [gl, v] of col) { if (!cal[gl]) cal[gl] = zero12(); cal[gl][m] = r2(cal[gl][m] + v); }
  }
  for (const gl of Object.keys(cal)) if (!cal[gl].some((v) => v)) delete cal[gl];
  const first = last - 11;
  const period = `${MON[((first % 12) + 12) % 12]} ${Math.floor(first / 12)}-${MON[last % 12]} ${Math.floor(last / 12)}`;
  return annualizeDead({ cal, lastMonth: (last % 12) + 1, lastYear: Math.floor(last / 12), period, missing, dead: [], liveMonths: 12 }, first, opts.excludeStartup);
}

/** Troy (ECND, taken over Dec 2025): a window month with NO gross potential
    rent is a month the property was not operating — "same month last year"
    must not pull it. Each GL's dead months are filled with its average over the
    live months (so T12 totals are the live months annualized) and the months
    are named for the UI. Months nothing covers (`missing`) are left alone. */
function annualizeDead(t: Trailing12, firstKey: number, excludeStartup = STARTUP_EXCLUDE_DEFAULT): Trailing12 {
  const gpr = t.cal['4994'];
  if (!gpr || !gpr.some((v) => v)) return t;
  const missingIdx = new Set(t.missing.map((s) => MON.indexOf(s.slice(0, 3))));
  const deadIdx: number[] = [];
  for (let m = 0; m < 12; m++) if (!gpr[m] && !missingIdx.has(m)) deadIdx.push(m);
  if (!deadIdx.length) return t;
  const nameOf = (m: number): string => {
    let y = Math.floor(firstKey / 12);
    if (firstKey > 0) { for (let k = firstKey; k < firstKey + 12; k++) if (((k % 12) + 12) % 12 === m) { y = Math.floor(k / 12); break; } }
    return y ? `${MON[m]} ${y}` : MON[m];
  };
  /* START-UP MONTHS (Troy 2026-11-09: "for new acquisitions with only a partial year, we should
     be excluding the first month, and being very careful about the second and potentially even
     3rd month of ops"). When the window opens with pre-acquisition months, the live months in
     calendar order are months 1, 2, 3… of operations. The first `excludeStartup` of them
     (default 1: a partial month of rent, closing entries, catch-up bills) are LEFT OUT of the
     history exactly like the dead months; the ones still inside months 2-3 are named in
     `early` so the screen can say they are in and should be reviewed. At least two live months
     are always kept. */
  const startupIdx: number[] = [], earlyIdx: number[] = [];
  if (firstKey > 0) {
    const order = Array.from({ length: 12 }, (_, j) => (((firstKey + j) % 12) + 12) % 12);   // calendar index, oldest first
    const firstLivePos = order.findIndex((m) => !deadIdx.includes(m) && !missingIdx.has(m));
    const opensDead = firstLivePos > 0 && order.slice(0, firstLivePos).some((m) => deadIdx.includes(m));
    if (opensDead) {
      const ops = order.slice(firstLivePos).filter((m) => !deadIdx.includes(m) && !missingIdx.has(m));   // ops months 1..n
      const n = Math.max(0, Math.min(Math.round(excludeStartup) || 0, 3, ops.length - 2));
      startupIdx.push(...ops.slice(0, n));
      earlyIdx.push(...ops.slice(n, 3));                                 // months 2-3 of operations that remain in
    }
  }
  const out = new Set([...deadIdx, ...startupIdx]);                       // months filled with the average
  const live = 12 - out.size - missingIdx.size;
  if (live <= 0) return t;
  for (const gl of Object.keys(t.cal)) {
    const row = t.cal[gl];
    const liveSum = row.reduce((x, v, m) => (out.has(m) || missingIdx.has(m) ? x : x + v), 0);
    const avg = r2(liveSum / live);
    for (const m of out) row[m] = avg;
  }
  return { ...t, dead: deadIdx.map(nameOf), startup: startupIdx.map(nameOf), early: earlyIdx.map(nameOf), liveMonths: live, period: `${t.period} · ${live} mo annualized` };
}

/** "N months annualized" off a trailing-12 calendar: the last n months ending at lastMonth × 12/n. */
export function annualizedFromCal(cal: Record<string, Months>, lastMonth: number, n = 4): Record<string, number> {
  const out: Record<string, number> = {};
  const idx = Array.from({ length: n }, (_, j) => (((lastMonth - 1 - j) % 12) + 12) % 12);
  for (const [gl, m] of Object.entries(cal)) {
    const v = idx.reduce((a, i) => a + (m[i] || 0), 0) * (12 / n);
    if (v) out[gl] = r2(v);
  }
  return out;
}

/** "N months annualized": the last `n` statement columns × (12/n), per GL. */
export function stmtAnnualized(stmt: StmtData | null | undefined, n = 4): Record<string, number> {
  const out: Record<string, number> = {};
  if (!stmt?.rows?.length) return out;
  const idx = stmt.monthCal.map((m, i) => ({ i, key: (stmt.monthYear?.[i] || 0) * 12 + m })).sort((a, b) => a.key - b.key).slice(-n).map((x) => x.i);
  if (!idx.length) return out;
  for (const r of stmt.rows) {
    const v = idx.reduce((a, i) => a + (Number(r.months[i]) || 0), 0) * (12 / idx.length);
    if (v) out[String(r.gl)] = r2(v);
  }
  return out;
}

/** Reference totals — the annual budget's "UW": category totals by pcode from
    the statement's DETAIL lines, EGI/TOE/NOI as the same category sums the
    tie-out uses, and the actual vacancy % so the vacancy split compares
    like-for-like. */
export function refFromCalendar(coaList: CoaAccount[], cal: Record<string, Months | number>, units: number, label = ''): UwSnapshotData {
  const coa = new Map(coaList.map((a) => [a.code, a]));
  const y1: Record<string, number> = {};
  const tot = (v: Months | number): number => (Array.isArray(v) ? sum(v) : r2(v));
  for (const [gl, m] of Object.entries(cal)) {
    const a = coa.get(gl);
    if (!a || a.kind !== 'detail' || !a.pcode) continue;
    y1[a.pcode] = r2((y1[a.pcode] || 0) + tot(m));
  }
  const pick = (ps: string[]) => ps.reduce((a, p) => r2(a + (y1[p] || 0)), 0);
  const egi = pick(['1', 'loss', '2', '3', '4', '5']);
  const toe = pick(['6', '7', '8', '9', '10', '11', '12', '13', '14']);
  const gpr = y1['1'] || 0;
  const vac = cal['5031'] != null ? tot(cal['5031']) : 0;
  return { sheetName: label, units, y1, egi, toe, noi: r2(egi - toe), assumptions: { vacancyPct: gpr ? Math.round((Math.abs(vac) / gpr) * 10000) / 10000 : 0 } };
}

/** Annual $ per GL + every Monarch total row, for a reference column. */
export function refColumn(cal: Record<string, Months | number>): { byGl: Record<string, number>; totals: Record<string, number> } {
  const byGl: Record<string, number> = {};
  const monthsMap = new Map<string, Months>();
  for (const [gl, v] of Object.entries(cal)) {
    const m = Array.isArray(v) ? v : (Array(12).fill(r2(v / 12)) as Months);
    byGl[gl] = Array.isArray(v) ? sum(v) : r2(v);
    monthsMap.set(gl, m);
  }
  const totals: Record<string, number> = {};
  for (const [code, m] of rollup(monthsMap)) totals[code] = sum(m);
  return { byGl, totals };
}

/* ---------------- the Yardi budget template (everything but payroll) ---------------- */

export interface TemplateData {
  code: string; name: string; units: number; capital: number;
  acquisitionDate: string | null; budgetYear: number;
  lastActual: { year: number; month: number };          // Budget Worksheet N1 — the last actual month
  /** calendar month → the year the template's "PY actual" comes from (E1..P1) */
  pyYears: number[];
  debt: { interest: Months; principal: Months; principalGl: string; loans: string[] };
  mgmtFee: { actualPct: number | null; actualFee: number; actualIncome: number; matrix: Record<string, number>; override: number | null; notes: string };
  utilForecast: Record<string, Months>;                 // gl → % change per budget month
  suggestions: Record<string, Months>;                  // gl → $ per budget month
  suggestionNotes: Record<string, string[]>;
  leaseGoals: Months; leaseExpirations: Months;
  renewalPct: number | null; burnoffRenew: number | null; burnoffNew: number | null;
  gprPct: Months;                                       // "ENTER % CHANGE FOR GPR" row
  vacancyPct: number | null; delinqPct: number | null; priorPeriodPct: number | null;
  distHist: { date: string; type: string; pct: number; amount: number }[];
  mortgage: { loanCode: string; lender: string; program: string; origBal: number; rate: number; ioEnd: string | null; dueDate: string | null; amortYears: number | null }[];
  softwareFixedMo: number | null;                       // 6331 fixed monthly cost: column D of the row (2027 template, 0 = actuals) or "$275/month" in the note (2026)
  /** prior-year move-outs by calendar month (2027 template's MoveOuts sheet): scheduled = 60+ days'
      notice, unscheduled = under 60 days, month-to-month, skips and evictions */
  moveOuts: { scheduled: Months; unscheduled: Months } | null;
}

/* ---------------- template rules ---------------- */

/** Corporate per-unit / flat monthly rates (the 2026 template's constants). */
export const CORP_RATES: Record<string, { perUnitYr?: number; flatMo?: number; label: string }> = {
  '6108': { perUnitYr: 285, label: 'Insurance — corporate $285/unit/yr' },
  '6310': { perUnitYr: r2(9.18 + 16.55 + 11.17 + 6.24), flatMo: 390 + 93, label: 'IT $390/mo + $93/mo + $43.14/unit/yr corporate allocations' },
  '6320': { perUnitYr: 7.86, label: 'Legal department $7.86/unit/yr' },
  '6560': { perUnitYr: r2(18.87 + 5.89), label: 'Marketing salary allocations $24.76/unit/yr' },
};
/** 2027 changes to the corporate rates. Payroll Budget Workbook 2027 rev2 (Seth Russell,
    2026-11-09): 6451 is folded into 6310 "with the updated figures" — the paste-table row is
    units × (11.61 + 24.17 + 11.81 + 6.51 + 4.07) / 12 + 420 + 93. */
export const CORP_RATES_2027: typeof CORP_RATES = {
  '6310': { perUnitYr: r2(11.61 + 24.17 + 11.81 + 6.51 + 4.07), flatMo: 420 + 93, label: 'IT $420/mo + $93/mo + $58.17/unit/yr corporate allocations (2027 workbook rev2)' },
};
/** The corporate rates in force for a budget year: the 2026 constants, with the 2027
    release's changes from 2027 on. Earlier budgets keep the rates they were built on. */
export function corpRatesFor(year: number): typeof CORP_RATES {
  return Number(year) >= 2027 ? { ...CORP_RATES, ...CORP_RATES_2027 } : { ...CORP_RATES };
}
/** "Default is October actuals": the last actual month, flat for 12. */
export const LAST_MONTH_FLAT_GLS = new Set(['4995', '4996', '5018', '5020', '5021', '5023', '5024', '5025', '5028', '5032', '5033', '5034', '5040', '6104', '6601', '6602', '6616', '6617', '6618', '6619', '6630']);
/** A known ANNUAL amount budgeted flat — real estate taxes. The template's "October
    actual × 12" put clnd's 2026 taxes at 407k against a 471k trailing-12 and the 517k
    accounting loaded (one accrual true-up month set the year). Default = trailing-12
    total ÷ 12, no $1,000 threshold; the RMC's typed annual (rule `fixedAnnual`) is a
    property decision, so it lands here too. */
export const FIXED_ANNUAL_GLS = new Set(['6116']);
/** Payroll lines that are NOT a % of wages: the last actual month carried flat
    (Troy 2026-11-09: employee rent is what it is, not a ratio). A row's shape
    menu can do the same for any other payroll line. */
export const BURDEN_LAST_GLS = new Set(['6413']);
/** Sites that bill residents an in-house flat utility fee per occupied unit (Troy 2026-11-09,
    default on): BCND always; PHND and FHND since fall 2026 (off Conservice RUBS). A budget's
    utilities.billing, when set, wins. */
export const FLAT_FEE_PROPERTIES = new Set(['bcnd', 'phnd', 'fhnd']);
export function flatFeeBilling(inputs: { utilities?: { billing?: string } } | null | undefined, propertyCode: string | null | undefined): boolean {
  const b = inputs?.utilities?.billing;
  return b ? b === 'flat' : FLAT_FEE_PROPERTIES.has(String(propertyCode || '').toLowerCase());
}
/** A `last`-shape line whose last actual month is this far off its trailing-12 average
    gets `driver.lastDev` so the chip can warn (one odd month is setting the year). */
export const LAST_DEV_WARN = 0.25;
/** Per-GL increase factors the template hard-codes. */
export const TEMPLATE_GL_PCT: Record<string, number> = {
  '5158': 0.05, '5167': 0.05, '5169': 0.05, '5170': 0.05, '5171': 0.05, '5172': 0.05, '5174': 0.05,
  '6550': 0.05, '6555': 0.05, '6620': 0.07, '6621': 0.07, '6665': 0, '5178': 0, '5180': 0,
};
/** Per-category increase factors (template defaults; '*' for the rest). */
export const TEMPLATE_CAT_PCT: Record<string, number> = { '1': 0, loss: 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0.05, '10': 0, '11': 0, '12': 0, '13': 0.05, '14': 0.05, '*': 0 };
/** Turnover-driven income: $ per NEW MOVE-IN (expirations × (1 − renewal %)). */
export const TURN_GLS: Record<string, string> = { '5105': 'application fees', '5152': 'deposit forfeitures', '5157': 'move-in admin fees' };
/** Trailing-12 total / 12 flat (template: only when the T12 exceeds $1,000). */
export const FLAT_T12_GLS = new Set(['5135', '5151']);
/** Turn-related expense lines (Troy 2026-11-04): paint, carpet, blinds, locks, appliances,
    cleaning — budgeted on the lease-expiration curve with a ONE-MONTH lag for invoice
    processing (shape 'turns'), whenever the budget has expirations. */
export const TURN_EXPENSE_GLS = new Set(['6702', '6704', '6706', '6726', '6728', '6905', '6908', '6912', '6926', '7002', '7006', '7010', '7015']);
/** The expirations curve shifted one month forward: a lease ending in month i is a turn
    invoice in month i+1 (December's roll into January). */
export function lagMonths(m: Months, lag = 1): Months { return m.map((_, i) => m[(i - lag + 12) % 12]) as Months; }
/** Vacancy % by month (Troy 2026-11-09). The input is the ANNUAL AVERAGE; where it lands is a
    CARRY-OVER model, not a 1:1 copy of the expiration curve (first cut — "very extreme"):

      vacancy[m] = vacancy[m-1] x carry[m]  +  k x move-outs[m]

    - move-outs[m] = lease expirations of the month before (a lease ending in June is a vacant
      unit in July — the same one-month lag the turn costs use);
    - carry[m] (VACANCY_CARRY) = the share of last month's vacancy still vacant: units do not
      fill at once, so a heavy stretch compounds and spreads into the following months, and
      winter fills slowest (Q4 runs heavy, Q1 eases off instead of dropping);
    - the chain STARTS at the last actual month's vacancy % and runs forward through the months
      before the budget year ("if we just posted 23K, we are not at 7K by January");
    - k is solved so the GPR-weighted average of the year is exactly the input average.

    `weight` blends the curve with the flat average (1 = the curve, 0 = flat). Twelve DIFFERENT
    typed values are a by-month entry and are used as they are. With no expirations on file, or
    a partial schedule (fewer than nine months), the average applies flat. Calendar-year budgets. */
export const VACANCY_MIN_EXP_MONTHS = 9;
/** Share of a month's vacancy that is still vacant the next month, by CALENDAR month:
    winter (Nov–Feb) fills slowest, summer (May–Aug) fastest. Judgment values — tune here. */
export const VACANCY_CARRY: number[] = [0.85, 0.85, 0.75, 0.75, 0.65, 0.65, 0.65, 0.65, 0.75, 0.75, 0.85, 0.85];
export function vacancyByMonth(
  pcts: number[] | undefined | null, exp: Months, gpr: Months, weight = 1,
  opts: { startPct?: number | null; lastMonth?: number | null } = {}
): { pcts: Months; avg: number; shaped: 'expirations' | 'typed' | 'flat'; startPct?: number | null } {
  const p = Array.from({ length: 12 }, (_, i) => Number(pcts?.[i]) || 0) as Months;
  const avg = p[0];
  const gSum = sum(gpr);
  const wmean = (v: number[]) => (gSum ? v.reduce((a, x, i) => a + x * gpr[i], 0) / gSum : v.reduce((a, x) => a + x, 0) / 12);
  if (p.some((v) => Math.abs(v - avg) > 1e-9)) return { pcts: p, avg: wmean(p), shaped: 'typed' };
  const w = Math.min(1, Math.max(0, Number.isFinite(weight) ? weight : 1));
  const out = lagMonths(exp, 1);                                   // move-outs landing in each calendar month
  if (!avg || !w || !out.some((v) => v > 0) || out.filter((v) => v > 0).length < VACANCY_MIN_EXP_MONTHS) return { pcts: p, avg, shaped: 'flat' };
  const start = opts.startPct != null && opts.startPct >= 0 && Number.isFinite(opts.startPct) ? opts.startPct : null;
  const last = Math.min(12, Math.max(1, Math.round(opts.lastMonth || 12)));   // last actual calendar month (1-12)
  // one pass of the chain: `v0` after the last actual month, inflow scaled by k
  const run = (v0: number, k: number): number[] => {
    let v = v0;
    for (let c = last; c < 12; c++) v = v * VACANCY_CARRY[c] + k * out[c];       // the months between the last actual and January
    const yr: number[] = [];
    for (let c = 0; c < 12; c++) { v = v * VACANCY_CARRY[c] + k * out[c]; yr.push(v); }
    return yr;
  };
  // no starting point on file: the chain's own steady state (run it round until it repeats)
  const steady = (k: number): number[] => { let v = 0, yr: number[] = []; for (let n = 0; n < 6; n++) { yr = []; for (let c = 0; c < 12; c++) { v = v * VACANCY_CARRY[c] + k * out[c]; yr.push(v); } } return yr; };
  const A = start != null ? run(start, 0) : Array(12).fill(0);     // what the starting vacancy alone leaves behind
  const B = start != null ? run(0, 1) : steady(1);                 // what one unit of move-outs builds
  const mA = wmean(A), mB = wmean(B);
  let curve: number[];
  if (mB > 0 && avg >= mA) { const k = (avg - mA) / mB; curve = A.map((x, i) => x + k * B[i]); }
  else curve = mA > 0 ? A.map((x) => (x * avg) / mA) : Array(12).fill(avg);   // the average is below what the carry-over alone gives: keep its shape, scaled
  return { pcts: curve.map((v) => Math.round((avg * (1 - w) + w * v) * 1e6) / 1e6) as Months, avg, shaped: 'expirations', startPct: start };
}
/** WITHIN-YEAR COST DRIFT (Troy 2026-11-09: "apply a very small gradual increase to expense
    items, as things will tend to get more expensive over the course of the year. Should not be
    massive, but should make a difference in distribution"). A history-based expense line is
    tilted so its last month runs `drift` above its first, in a straight line, with the YEAR
    TOTAL UNCHANGED — the increase factor still sets the level; this only moves when it lands.
    Default 3% January to December (about -1.5% in January, +1.5% in December). */
export const COST_DRIFT_DEFAULT = 0.03;
/** Categories the drift applies to: admin, marketing, utilities, R&M, rehab. Not payroll
    (its raises have their own timing), taxes, insurance, the fee or anything contract-flat. */
export const COST_DRIFT_PCODES = new Set(['9', '11', '12', '13', '14']);
export function tiltMonths(months: Months, drift: number, mult = 0): Months {
  const total = sum(months);
  if (!drift || !total) return months;
  const tilted = months.map((v, i) => v * (1 + drift * (i / 11 - 0.5)));
  const k = total / (sum(tilted) || total);                     // keep the year where it was
  const out = tilted.map((v) => (mult > 0 ? Math.round((v * k) / mult) * mult : r2(v * k))) as Months;
  if (!(mult > 0)) { const d = r2(total - sum(out)); if (d) out[11] = r2(out[11] + d); }   // cent fix on the last month
  return out;
}
/** Average of the non-zero months, flat. */
export const AVG_NZ_GLS = new Set(['5110']);
/** Template zeroes these (corporate allocation credits; one-time concessions). */
export const TEMPLATE_ZERO_GLS = new Set(['6451']);
/** GLs that take the corporate BudgetSuggestions amounts by default:
    accounting (Yardi + CPA bills), third-party billing, donations (added to
    PY actuals). Other suggestions stay on file for the row tool. */
export const DEFAULT_SUGGESTION_GLS = ['6102', '6350', '6315'];
export const BASELINE_SKIP_SECTIONS = new Set(['special_projects', 'principal', 'below_noi']);

export const DEFAULT_BASELINE: NonNullable<BudgetInputs['baseline']> = { source: 'actual', growthPct: { ...TEMPLATE_CAT_PCT }, shape: 'actual', mround: 0 };

/* ---------------- one baseline line ---------------- */

/** A calendar series → the budget months on a shape, × (1+pct) (or a
    per-month pct array), rotated into budget order, MROUNDed when asked. */
export function annualBaseline(cal: Months, opts: { pct?: number; pcts?: Months | null; shape: BaselineShape; startMonth?: number; lastMonth?: number; curve?: Months | null; mult?: number; turns?: Months | null }): Months {
  const g = (i: number) => 1 + (opts.pcts ? (opts.pcts[i] || 0) : (opts.pct || 0));
  const start = opts.startMonth || 1;
  const last = (opts.lastMonth || 10) - 1;
  let m: Months;
  switch (opts.shape) {
    case 'wavg': m = cal.map((_, c) => ((2 * cal[c] + cal[(c + 11) % 12] + cal[(c + 1) % 12]) / 4) * g(c)) as Months; break;
    case 'flat': { const tot = cal.reduce((a, b) => a + b, 0); m = cal.map((_, c) => (tot / 12) * g(c)) as Months; break; }
    case 'curve': {
      const tot = r2(cal.reduce((a, b) => a + b, 0) * (1 + (opts.pct || 0)));
      m = spreadMonthly(tot, opts.curve && opts.curve.some((v) => v > 0) ? opts.curve : CURVES.flat);
      break;
    }
    case 'turns': {
      // T12 total × factor, spread by lease expirations lagged one month (calendar order);
      // with no expirations on file the line falls back to flat
      const tot = r2(cal.reduce((a, b) => a + b, 0) * (1 + (opts.pct || 0)));
      const w = opts.turns && opts.turns.some((v) => v > 0) ? opts.turns : CURVES.flat;
      const ws = w.reduce((a, b) => a + b, 0);
      m = w.map((v) => (ws ? (tot * v) / ws : tot / 12)) as Months;
      break;
    }
    case 'last': m = cal.map((_, c) => cal[last] * g(c)) as Months; break;
    case 'avgnz': { const nz = cal.filter((v) => v); const avg = nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0; m = cal.map((_, c) => avg * g(c)) as Months; break; }
    default: m = cal.map((v, c) => v * g(c)) as Months;
  }
  m = rotate12(m, start);
  const mult = opts.mult || 0;
  return m.map((v) => (mult > 0 ? Math.round(v / mult) * mult : r2(v))) as Months;
}

/** Lease expirations per budget month from unit-level leases. A lease ending between
    the roll's as-of date and the budget start turns BEFORE the year; its renewal
    comes up again twelve months on, so it counts in that month of the budget year.
    One already expired at the roll date, or with no end date, is month-to-month and
    is spread one twelfth a month, the same way `ltlModel` resets them (they used to
    all land in month 0: a 9/30 roll put 126 "January" expirations on bcnd). */
export function expirationsFromLeases(leases: Lease[], year: number, opts: { asOf?: string | null; startMonth?: number } = {}): Months {
  const out = zero12();
  const startMonth = opts.startMonth || 1;
  const startAbs = year * 12 + (startMonth - 1);
  const asOfKey = dateKey(opts.asOf);
  let mtm = 0;
  for (const l of leases) {
    const k = l.e ? leaseEndIndex(l.e, startAbs) : null;
    if (k == null) { out[mtm++ % 12]++; continue; }                        // no / unreadable end date → MTM
    if (k > 11) continue;                                                 // ends after the window
    if (k >= 0) { out[k]++; continue; }
    if (asOfKey != null && (dateKey(l.e) ?? -1) >= asOfKey) {             // turns before the year starts → up again a year later
      if (k + 12 >= 0 && k + 12 <= 11) out[k + 12]++;
      continue;
    }
    out[mtm++ % 12]++;                                                    // expired at the roll date → MTM
  }
  return out;
}

/* ---------------- GPR step pattern ---------------- */

/** GPR month steps that land an annual target (Troy 2026-11-03: increases go
    into SPECIFIC months, never blanketed). With a step pattern on file every
    step is scaled by one factor k (the months keep their places — a March +3%
    / September +2% pattern stays March / September); with no pattern the
    fallback is the old uniform monthly rate. Bisection on the annual sum. */
export function gprStepsForTarget(base: number, steps: Months | null | undefined, target: number): { growthPct: Months; k: number | null; g: number | null } {
  const cur = (steps && steps.some((v) => v) ? steps : null) as Months | null;
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  if (cur) {
    const annualAt = (k: number) => { let c = base, s = 0; for (let i = 0; i < 12; i++) { c *= Math.max(0.05, 1 + cur[i] * k); s += c; } return s; };
    let lo = -5, hi = 5;
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (annualAt(mid) < target) lo = mid; else hi = mid; }
    const k = (lo + hi) / 2;
    return { growthPct: cur.map((v) => r6(v * k)) as Months, k: Math.round(k * 1e4) / 1e4, g: null };
  }
  const annualAt = (g: number) => { let c = base, s = 0; for (let i = 0; i < 12; i++) { c *= 1 + g; s += c; } return s; };
  let lo = -0.5, hi = 0.5;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (annualAt(mid) < target) lo = mid; else hi = mid; }
  const g = r6((lo + hi) / 2);
  return { growthPct: Array(12).fill(g) as Months, k: null, g };
}

/** "Mar +3%, Sep +2%" — the steps a GPR series carries, for labels. */
export function gprStepsSummary(steps: Months | null | undefined): string {
  if (!steps || !steps.some((v) => v)) return 'no increases';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const nz = steps.map((v, i) => [v, i] as [number, number]).filter(([v]) => v);
  if (nz.length === 12 && nz.every(([v]) => Math.abs(v - nz[0][0]) < 1e-9)) return `${(nz[0][0] * 100).toFixed(2)}% every month`;
  return nz.map(([v, i]) => `${MON[i]} ${v > 0 ? '+' : ''}${(v * 100).toFixed(2).replace(/\.?0+$/, '')}%`).join(', ');
}

/* ---------------- generation ---------------- */

/** One GL's foundation rule, as extracted from the GRKS draft
    (seed/annual-rules.json): how its own history becomes the budget.
      same     PY same month × (1+factor), MROUND
      wavg     (PY prev + 2×this + next)/4 × (1+factor), MROUND  — the 1-2-1 weighted average
      flatT12  T12 × (1+factor) / 12 flat — only when the T12 exceeds $1,000 (unless noThreshold)
      last     last actual month, flat
    Other methods (engine / corpRate / suggested / debt / payroll) leave the
    engine's own logic in charge. */
export interface AnnualRule {
  /** 'custom' carries its shape in `shape` (turns, avgnz, curve — saved formula sets); 'zero' = this GL is zeroed on purpose */
  method: 'same' | 'wavg' | 'flatT12' | 'last' | 'engine' | 'corpRate' | 'suggested' | 'debt' | 'payroll' | 'fixedAnnual' | 'custom' | 'zero';
  shape?: BaselineShape; mround?: number; factor?: number; noThreshold?: boolean; name?: string;
}
const RULE_SHAPE: Partial<Record<AnnualRule['method'], BaselineShape>> = { same: 'actual', wavg: 'wavg', flatT12: 'flat', last: 'last', fixedAnnual: 'flat' };
const ruleShapeOf = (r: AnnualRule | null | undefined): BaselineShape | undefined => (r ? (r.shape ?? RULE_SHAPE[r.method]) : undefined);

/* ---------------- saved formula sets (Troy 2026-11-09) ----------------
   "We should not be using GRKS defaults. I need to be able to save all property formulas
   applied minus hard codes with a name. Instead of just picking something random, it should
   prompt to pick out a previous presave."

   A formula set is the RECIPE of a budget, with nothing property-specific in it:
     - per-GL rules: how each history-based line is built (shape, increase factor, MROUND), and
       the GLs zeroed on purpose;
     - the formula settings: category increase factors, cost drift, loss-to-lease method and
       renewal / burnoff %, the vacancy curve weight, the payroll burden basis, the wage source
       and fallback raise %.
   Left OUT (the "hard codes"): every hand-typed cell and total, any dollar amount (GPR base,
   LTL start, $ per move-in, corporate rates), GPR month steps, the vacancy average, lease
   expirations, and ratios typed for one property. A budget carries a COPY of the set it was
   given (`inputs.rules` + `inputs.rulesFrom`), so editing or deleting a set later never moves
   a budget silently. */
export interface FormulaSet {
  rules: Record<string, AnnualRule>;
  settings: {
    baseline?: Pick<NonNullable<BudgetInputs['baseline']>, 'source' | 'shape' | 'mround' | 'growthPct' | 'useUtilForecast' | 'costDrift'>;
    ltl?: { mode?: any; renewalPct?: number; burnoffRenew?: number; burnoffNew?: number; followGpr?: boolean };
    vacancyExpWeight?: number; burdenBasis?: 't12' | 'budget' | 'mix'; wageSource?: 'payroll' | 'manual'; payrollRaisePct?: number;
  };
}
const SHAPE_RULE: Partial<Record<BaselineShape, AnnualRule['method']>> = { actual: 'same', wavg: 'wavg', flat: 'flatT12', last: 'last' };
/** The recipe of a budget as it stands: every non-overridden history-based line's shape /
    factor / MROUND, the deliberate zero-outs, and the formula settings. Pure. */
export function formulaSetFromBudget(lines: BudgetLine[], inputs: BudgetInputs): FormulaSet {
  const rules: Record<string, AnnualRule> = {};
  const bl = inputs.baseline || ({} as NonNullable<BudgetInputs['baseline']>);
  for (const l of lines) {
    if (l.override) continue;                                        // a hand-typed line is a hard code
    const d = (l.driver || {}) as any;
    if (d.method === 'zero') { rules[l.gl_code] = { method: 'zero' }; continue; }
    if (d.method !== 'baseline') continue;                           // engine-driven lines (GPR, LTL, payroll, fee…) carry no per-GL rule
    const sh = d.shape as BaselineShape;
    const method = SHAPE_RULE[sh];
    const r: AnnualRule = method ? { method } : { method: 'custom', shape: sh };
    if (Number.isFinite(d.pct)) r.factor = Math.round(d.pct * 1e6) / 1e6;
    if (d.mult) r.mround = d.mult;
    // a flat line the user chose on the row is budgeted whatever its size; otherwise the
    // template's $1,000 rule still applies on the property the set is given to
    if (method === 'flatT12' && bl.glShape?.[l.gl_code]) r.noThreshold = true;
    rules[l.gl_code] = r;
  }
  const lt = inputs.ltl || ({} as any);
  const settings: FormulaSet['settings'] = {
    baseline: { source: bl.source || 'actual', shape: bl.shape || 'actual', mround: bl.mround || 0, growthPct: { ...(bl.growthPct || {}) }, ...(bl.useUtilForecast != null ? { useUtilForecast: bl.useUtilForecast } : {}), ...(bl.costDrift != null ? { costDrift: bl.costDrift } : {}) },
    ltl: { mode: lt.mode, renewalPct: lt.renewalPct, burnoffRenew: lt.burnoffRenew, burnoffNew: lt.burnoffNew, followGpr: lt.followGpr },
  };
  if (inputs.vacancyExpWeight != null) settings.vacancyExpWeight = inputs.vacancyExpWeight;
  if (inputs.burdenBasis) settings.burdenBasis = inputs.burdenBasis;
  if (inputs.wageSource) settings.wageSource = inputs.wageSource;
  if (inputs.payrollRaisePct != null) settings.payrollRaisePct = inputs.payrollRaisePct;
  return { rules, settings };
}
/** Give a budget a formula set: the set's rules and settings replace the budget's own per-GL
    shape / factor / MROUND choices. Dollars, GPR, vacancy average, expirations and every
    override on the budget are untouched. Pure — the caller regenerates. */
export function applyFormulaSet(inputs: BudgetInputs, set: FormulaSet, from: { id: number | string | null; name: string }): BudgetInputs {
  const st = set.settings || {};
  const clean = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined)) as Partial<T>;
  return {
    ...inputs,
    rules: { ...(set.rules || {}) },
    rulesFrom: { id: from.id, name: from.name, at: new Date().toISOString() },
    baseline: { ...DEFAULT_BASELINE, ...(inputs.baseline || {}), ...clean(st.baseline), glShape: {}, glGrowth: {}, glMround: {}, secGrowth: {} } as any,
    ltl: { ...(inputs.ltl || ({} as any)), ...clean(st.ltl) },
    ...(st.vacancyExpWeight != null ? { vacancyExpWeight: st.vacancyExpWeight } : {}),
    ...(st.burdenBasis ? { burdenBasis: st.burdenBasis } : {}),
    ...(st.wageSource ? { wageSource: st.wageSource } : {}),
    ...(st.payrollRaisePct != null ? { payrollRaisePct: st.payrollRaisePct } : {}),
  } as BudgetInputs;
}

export interface AnnualSources {
  actual: Record<string, Months> | null;    // trailing-12 posted actuals, calendar series by GL
  budget: Record<string, Months> | null;    // current-year budget as it sits in Yardi
  lastMonth?: number;                        // last actual calendar month (1-12), default 10
  template?: TemplateData | null;
  /** per-GL foundation rules (the GRKS draft's formulas); built-in template
      rules apply where a GL has none */
  rules?: Record<string, AnnualRule> | null;
  comps?: CompWeights | null;
  payrollWages?: Record<string, number> | null;
  /** set when `payrollWages` is the LIVE Pay-rates roster (the default wage source): the
      wages already carry each person's raise prorated from the cycle's effective month */
  wagesLive?: { label: string; effective: string; draft: boolean;
    /** the roster wages by CALENDAR month — old rate before the raise's effective month, raised from it on */
    monthly?: Record<string, Months> | null } | null;
  leases?: Lease[] | null;
  /** the rent roll's as-of date (ISO or M/D/YYYY): a lease ending between it and the
      budget start has already turned by month 0 (it is not month-to-month) */
  rollAsOf?: string | null;
  charges?: Record<string, number> | null;
  /** lowercase Yardi code — site defaults (FLAT_FEE_PROPERTIES) key off it */
  propertyCode?: string | null;
  /** when ownership began ('YYYY-MM': the Yardi template's acquisition date, else the start of
      the property's acquisition budget) and the first-year management fee % that budget ran on */
  acquisition?: { start?: string | null; firstYearPct?: number | null } | null;
}

/** FIRST-YEAR MANAGEMENT FEE (Troy 2026-11-09: "If Management fee is 3% for first year, it
    should be 3% for first 12 months. It should not use 4% flat from the start."). The first
    twelve months of ownership earn the first-year rate, the months after the regular rate.
    The fee bills a month in arrears, so the rate follows the month the INCOME was earned: the
    fee posted the month after ownership month 12 is still at the first-year rate.
    Returns each budget month's rate, and how many of them are first-year. */
export function mgmtFeeRates(year: number, startMonth: number, regular: number, first?: { pct?: number | null; start?: string | null } | null): { rates: Months; firstMonths: number; through: string | null } {
  const rates = Array(12).fill(regular) as Months;
  const m = /^(\d{4})-(\d{1,2})/.exec(String(first?.start || ''));
  const pct = first?.pct;
  if (!m || pct == null || !(pct > 0) || Math.abs(pct - regular) < 1e-9) return { rates, firstMonths: 0, through: null };
  const acq = Number(m[1]) * 12 + (Number(m[2]) - 1);            // first month of ownership
  const lastFirst = acq + 11;                                    // 12th month of ownership
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const incomeMonth = year * 12 + (startMonth - 1) + i - 1;     // the month this fee is billed on
    if (incomeMonth >= acq && incomeMonth <= lastFirst) { rates[i] = pct; n++; }
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return { rates, firstMonths: n, through: `${MON[lastFirst % 12]} ${Math.floor(lastFirst / 12)}` };
}

export function generateAnnualLines(coaList: CoaAccount[], inputs: BudgetInputs, src: AnnualSources): BudgetLine[] {
  const lines = new Map<string, BudgetLine>();
  const mk = (gl: string, months: Months, driver: Driver, note = ''): void => {
    lines.set(gl, { gl_code: gl, months: months.map(r2), driver, override: false, note });
  };
  for (const a of coaList) if (a.kind === 'detail') mk(a.code, zero12(), { method: 'manual' });
  const startMonth = inputs.startMonth || 1;
  const coaByCode = new Map(coaList.map((a) => [a.code, a]));
  const detail = coaList.filter((a) => a.kind === 'detail' && a.csv_order != null && a.active !== false);
  const tpl = src.template || null;
  const lastMonth = src.lastMonth || tpl?.lastActual.month || 10;
  const units = inputs.units || tpl?.units || 0;

  // category %s the user TYPED (blank box = each GL's own foundation factor); the
  // template defaults are only the floor under everything else
  const userPct: Record<string, number> = inputs.baseline?.growthPct || {};
  const bl = { ...DEFAULT_BASELINE, ...(inputs.baseline || {}), growthPct: { ...TEMPLATE_CAT_PCT, ...userPct } };
  const useBudget = bl.source === 'budget' && !!src.budget && Object.keys(src.budget).length > 0;
  const base: Record<string, Months> = useBudget ? src.budget! : (src.actual || {});
  const baseSrc: 'actual' | 'budget' = useBudget ? 'budget' : 'actual';
  const baseTotal = (gl: string): number => sum(base[gl] || zero12());
  const lastOf = (gl: string): number => (base[gl] || zero12())[lastMonth - 1] || 0;
  const rules = src.rules || {};
  const ruleOf = (gl: string): AnnualRule | null => { const r = rules[gl]; return r && ruleShapeOf(r) ? r : null; };
  // GLs a saved formula set zeroes on purpose: set first, so nothing below refills them
  for (const [gl, r] of Object.entries(rules)) if (r?.method === 'zero' && coaByCode.has(gl)) mk(gl, zero12(), { method: 'zero' });
  /** Precedence: the GL's own typed factor → a category % the user typed (it must
      move the whole category, or the Assumptions boxes are inert — the GRKS factors
      used to outrank them) → the GL's foundation rule → the template's per-GL %
      → the user's "everything else" → the template's category defaults. */
  // SECTION % (Troy 2026-11-10: "put an increase % into the column subcategory and have it flow
  // through… Should not overwrite overwritten formulas"): `baseline.secGrowth[section]`, typed on
  // a section header in the grid, is the increase for every history-based line of that
  // subsection (admin, utilities, in-house maintenance, exterior / CAM, contract services…). It
  // sits UNDER a % typed on the row itself and never touches a hand-typed line; it outranks the
  // category % and the formula set's own factor.
  const pctFor = (a: CoaAccount): number =>
    bl.glGrowth?.[a.code] ?? bl.secGrowth?.[a.section || ''] ?? userPct[a.pcode || ''] ?? ruleOf(a.code)?.factor ?? TEMPLATE_GL_PCT[a.code] ?? userPct['*'] ?? TEMPLATE_CAT_PCT[a.pcode || ''] ?? TEMPLATE_CAT_PCT['*'] ?? 0;
  const isSet = (gl: string): boolean => (lines.get(gl)?.driver as any)?.method !== 'manual';
  /** statement line × factor on a shape; false when the property has no history on the GL.
      Precedence: the budget's own per-GL overrides → the GL's foundation rule
      (GRKS draft) → the built-in template rules → the budget-wide defaults. */
  /* ---- lease expirations (calendar months): typed on the budget, else the rent roll /
     UAD leases, else the Yardi template's count (Troy 2026-11-04: the UAD is the source
     of expirations — it beats the template). The turn curve is the same series lagged
     one month for invoice processing. ---- */
  const exp: Months = (inputs.expirations && inputs.expirations.some((v) => v) ? inputs.expirations
    : src.leases?.length ? expirationsFromLeases(src.leases, inputs.year, { asOf: src.rollAsOf, startMonth })
    : tpl?.leaseExpirations?.some((v) => v) ? tpl.leaseExpirations : zero12()) as Months;
  const turnCurve: Months = lagMonths(exp, 1);
  const baseline = (a: CoaAccount, shape?: BaselineShape, pctOverride?: number): boolean => {
    const cal = base[a.code];
    if (!cal || !cal.some((v) => v)) return false;
    const rule = ruleOf(a.code);
    const pct = pctOverride ?? pctFor(a);
    // Conservice utility forecast: per-month % for the GL — opt-in (the GRKS
    // foundation used a flat factor); never when the GL has its own factor
    const fc = tpl?.utilForecast?.[a.code];
    const pcts = bl.useUtilForecast && fc && fc.some((v) => v) && bl.glGrowth?.[a.code] == null ? fc : null;
    const ruleShape = ruleShapeOf(rule);
    const sh: BaselineShape = bl.glShape?.[a.code] ?? shape ?? ruleShape ?? (LAST_MONTH_FLAT_GLS.has(a.code) ? 'last' : FIXED_ANNUAL_GLS.has(a.code) || FLAT_T12_GLS.has(a.code) ? 'flat' : AVG_NZ_GLS.has(a.code) ? 'avgnz' : TURN_EXPENSE_GLS.has(a.code) && turnCurve.some((v) => v > 0) ? 'turns' : bl.shape);
    // T12/12 flat only when the trailing-12 exceeds $1,000 (RMC's IF(T12>1000, …, 0))
    // …unless the user picked the shape on the row: that is a decision to budget the line
    const threshold = sh === 'flat' && !shape && !bl.glShape?.[a.code] && (rule ? rule.method === 'flatT12' && !rule.noThreshold : FLAT_T12_GLS.has(a.code));
    if (threshold && Math.abs(baseTotal(a.code)) <= 1000) {
      // dropped, not forgotten: the line stays at zero but says why and how much (the chip
      // reads "<$1K"; one click budgets it). It used to stay an unexplained blank.
      mk(a.code, zero12(), { method: 'dropped', t12: r2(baseTotal(a.code)), limit: 1000 } as any);
      return false;
    }
    const mult = bl.glMround?.[a.code] ?? (bl.mround || rule?.mround || 0);
    let months = annualBaseline(cal, { pct, pcts, shape: sh, startMonth, lastMonth, curve: CURVES[a.curve || 'flat'], mult, turns: turnCurve });
    if (rule?.method === 'wavg' && sh === 'wavg' && !bl.glShape?.[a.code] && startMonth === 1) {
      // RMC's Excel weighted average can't wrap the year: January and December
      // fall back to the plain same-month × factor, MROUND $10 (the GRKS cells)
      const edge = (c: number) => { const v = cal[c] * (1 + pct); return r2(Math.round(v / 10) * 10); };
      months = [edge(0), ...months.slice(1, 11), edge(11)] as Months;
    }
    // within-year cost drift: history-based expense lines cost a little more late in the year
    // than early (total unchanged). Not on contract-flat ("last month") or fixed-annual lines.
    // (a shape chosen on the row is taken literally — "flat" stays flat)
    const drift = COST_DRIFT_PCODES.has(a.pcode || '') && sh !== 'last' && !bl.glShape?.[a.code] && !FIXED_ANNUAL_GLS.has(a.code) && rule?.method !== 'fixedAnnual'
      ? (bl.costDrift ?? COST_DRIFT_DEFAULT) : 0;
    if (drift) months = tiltMonths(months, drift, mult);
    // a "last actual month" line whose last month is far off its own average: one odd
    // month (a tax true-up, a zero) is setting the whole year — flag it for the chip
    let lastDev: number | undefined;
    if (sh === 'last') {
      const avg = baseTotal(a.code) / 12;
      const lastV = cal[lastMonth - 1] || 0;
      if (avg && Math.abs(lastV - avg) > LAST_DEV_WARN * Math.abs(avg)) lastDev = Math.round((lastV / avg - 1) * 1000) / 1000;
    }
    mk(a.code, months, { method: 'baseline', src: baseSrc, pct, shape: sh, mult, base: baseTotal(a.code), ...(pcts ? { pcts } : {}), ...(rule ? { rule: rule.method } : {}), ...(sh === 'turns' ? { turns: exp.reduce((x, y) => x + y, 0) } : {}), ...(lastDev != null ? { lastDev } : {}), ...(drift ? { drift } : {}) } as any);
    return true;
  };

  /* ---- A SHAPE CHOSEN ON THE ROW WINS ON ANY LINE (Troy 2026-11-09: "Flat + growth over T12
     needs to be an option for all lines"). `baseline.glShape[gl]` used to work only on lines
     that were history-based anyway; GPR, loss to lease, vacancy, the % of GPR lines, payroll,
     the fee, corporate rates, charges and debt ignored it. Those lines are built here first,
     from the property's own history on the chosen shape × the row's growth %, and every engine
     formula below leaves a line that is already set alone. Lines with no history keep their
     engine formula. ---- */
  const userShaped = new Set<string>();
  for (const a of coaList) {
    if (a.kind !== 'detail' || !bl.glShape?.[a.code] || isSet(a.code)) continue;
    // growth: the % typed on the row; a payroll line with none typed takes the raise % (as before)
    const g = a.pcode === '10' && bl.glGrowth?.[a.code] == null ? (BURDEN_LAST_GLS.has(a.code) ? 0 : (inputs.payrollRaisePct ?? 0.035)) : undefined;
    if (baseline(a, undefined, g)) userShaped.add(a.code);
  }

  /* ---- GPR: rent roll market rents (Troy) or the last actual month (template) × monthly % changes ---- */
  const gprBase = inputs.gpr?.baseMonthly > 0 ? inputs.gpr.baseMonthly : lastOf('4994');
  const gpr = zero12();
  if (userShaped.has('4994')) {
    // GPR itself on a chosen shape: everything that reads GPR below reads these months
    lines.get('4994')!.months.forEach((v, i) => { gpr[i] = v; });
  } else if (gprBase > 0) {
    let cum = gprBase;
    for (let i = 0; i < 12; i++) {
      cum = i === 0 ? gprBase * (1 + (inputs.gpr?.growthPct?.[0] || 0)) : cum * (1 + (inputs.gpr?.growthPct?.[i] || 0));
      gpr[i] = r2(cum);
    }
    mk('4994', gpr, { method: 'gpr' });
  }
  const gprAnnual = sum(gpr);
  const baseGpr = baseTotal('4994');
  const lastGpr = lastOf('4994');

  /* ---- lease expirations → turnover ---- */
  const renew = inputs.ltl?.renewalPct ?? tpl?.renewalPct ?? 0.65;
  const turns = exp.map((e) => r2(e * (1 - renew)));
  const turnsTotal = turns.reduce((a, b) => a + b, 0);

  /* ---- loss to lease ---- */
  const ltl = inputs.ltl || ({} as BudgetInputs['ltl']);
  const followGpr = ltl.followGpr !== false;
  if (isSet('5003')) {
    // a shape chosen on the row: already built above
  } else if (ltl.mode === 'flat') {
    // Troy: hold the loss to lease — no burnoff. Start = typed $/mo, else the
    // rent roll's current gap, else the last actual month; market growth
    // still deepens it when "follows GPR" is on
    const model = src.leases && src.leases.length ? ltlModel(src.leases, inputs.year, startMonth, { ...ltl, renewalPct: 1, burnoffRenew: 0, burnoffNew: 0, asOf: src.rollAsOf }) : null;
    const L0 = ltl.startMonthly ? -Math.abs(ltl.startMonthly) : (model && model.months[0]) || lastOf('5003');
    // market growth deepens the gap on the occupied units' market (all units when the roll is summary-only)
    const deepen = (i: number) => (!followGpr || !gpr[0] ? 0 : model ? (gpr[i] / gpr[0] - 1) * model.occupiedMarket : gpr[i] - gpr[0]);
    mk('5003', gpr.map((v, i) => r2(Math.min(0, L0 - deepen(i)))) as Months, { method: 'ltl' });
  } else if (ltl.mode === 'ramp') {
    const out = zero12();
    for (let i = 0; i < 12; i++) {
      const t = (ltl.rampMonths || 12) > 1 ? Math.min(1, i / ((ltl.rampMonths || 12) - 1)) : 1;
      out[i] = r2((ltl.startMonthly || 0) + (-(ltl.targetPct || 0) * gpr[i] - (ltl.startMonthly || 0)) * t);
    }
    mk('5003', out, { method: 'ltl' });
  } else if (src.leases && src.leases.length) {
    // Troy: per-lease burnoff at each turnover. Market growth deepens every lease's gap (its
    // rent is fixed until it resets); a reset burns only the burnoff share of that gap. Before
    // 2026-11-09 a reset wiped the growth part entirely whatever the burnoff % — so at 100%
    // renewal / 0% burnoff the February step still "burned off" through the year.
    const model = ltlModel(src.leases, inputs.year, startMonth, { ...ltl, asOf: src.rollAsOf, growth: followGpr && gpr[0] ? gpr.map((v) => v / gpr[0]) : null });
    mk('5003', model.months.map((v) => r2(Math.min(0, v))) as Months, { method: 'ltl' });
  } else if (lastGpr || ltl.startMonthly) {
    // template: last actual month's LTL, deepened by the market-rent change,
    // burned off by that month's expirations × renewal % × burnoff shares
    const bR = ltl.burnoffRenew ?? tpl?.burnoffRenew ?? 0.75;
    const bN = ltl.burnoffNew ?? tpl?.burnoffNew ?? 1;
    const expTot = exp.reduce((a, b) => a + b, 0);
    const L0 = ltl.startMonthly ? -Math.abs(ltl.startMonthly) : lastOf('5003');
    const out = zero12();
    out[0] = r2(L0);
    let cumDelta = 0;
    for (let i = 1; i < 12; i++) {
      const delta = followGpr ? gpr[i] - gpr[i - 1] : 0;
      cumDelta += delta;
      const remaining = L0 - cumDelta;                          // deeper loss as market rises
      const share = expTot ? exp[i] / expTot : 0;
      const burn = -remaining * share * (bR * renew + bN * (1 - renew));
      out[i] = r2(out[i - 1] - delta + burn);
    }
    mk('5003', out.map((v) => Math.min(0, v)) as Months, { method: 'ltl' });
  }

  /* ---- vacancy: the input is the annual average % of GPR; lease expirations (+1 month)
     decide which months carry more or less of it (vacancyByMonth) ---- */
  // the chain starts from the last ACTUAL month's vacancy % (posted, not the budget base)
  const actLastGpr = (src.actual?.['4994'] || zero12())[lastMonth - 1] || 0;
  const vacStart = actLastGpr > 0 ? Math.abs((src.actual?.['5031'] || zero12())[lastMonth - 1] || 0) / actLastGpr : null;
  const vac = vacancyByMonth(inputs.vacancyPct, exp, gpr as Months, inputs.vacancyExpWeight ?? 1, { startPct: vacStart, lastMonth });
  const vacPct = vac.pcts;
  if (!isSet('5031')) {
    const months = gpr.map((v, i) => -r2(vacPct[i] * v)) as Months;
    if (vac.shaped === 'expirations') {
      // rounding: the year still totals average x GPR — the cent difference goes on the largest month
      const drift = r2(-r2(vac.avg * sum(gpr)) - sum(months));
      if (drift) { const bi = months.reduce((mi, v, i) => (Math.abs(v) > Math.abs(months[mi]) ? i : mi), 0); months[bi] = r2(months[bi] + drift); }
    }
    mk('5031', months, { method: 'vacancy', avg: Math.round(vac.avg * 1e6) / 1e6, shaped: vac.shaped, pcts: vacPct, weight: inputs.vacancyExpWeight ?? 1, ...(vac.startPct != null ? { startPct: Math.round(vac.startPct * 1e6) / 1e6 } : {}) } as any);
  }

  /* ---- concessions & other rental loss: TRAILING-12 ratio to GPR × GPR (Troy:
     "use T12 ratio" — the October ratio made a light month set the year) ---- */
  const ratioT12 = (gl: string) => (baseGpr ? baseTotal(gl) / baseGpr : 0);
  const pctGprLine = (a: CoaAccount): void => {
    const pct = inputs.pctGpr?.[a.code] ?? ratioT12(a.code);
    if (pct) mk(a.code, gpr.map((v) => r2(pct * v)), { method: 'pctGpr', pct: Math.round(pct * 1000000) / 1000000, of: 'gpr', basis: 't12' });
  };
  for (const a of detail) {
    if (a.pcode !== '2' || isSet(a.code) || a.code === '5022') continue;
    pctGprLine(a);
  }
  // 5022 concession recapture = T12 recapture ratio × the other concessions, each month
  if (coaByCode.has('5022')) {
    const others = detail.filter((a) => a.pcode === '2' && a.code !== '5022');
    const t12Others = others.reduce((s, a) => s + baseTotal(a.code), 0);
    const pct = inputs.pctGpr?.['5022'] ?? (t12Others ? -baseTotal('5022') / t12Others : 0);
    if (pct) {
      const m = zero12();
      for (let i = 0; i < 12; i++) m[i] = r2(-pct * others.reduce((s, a) => s + (lines.get(a.code)?.months[i] || 0), 0));
      mk('5022', m, { method: 'recapture', pct: Math.round(pct * 100000) / 100000 });
    }
  }
  // net GPR per month (4994..5003) for the ratio lines
  const netGpr = zero12();
  for (let i = 0; i < 12; i++) for (const gl of ['4994', '4995', '4996', '5003']) netGpr[i] = r2(netGpr[i] + (lines.get(gl)?.months[i] || 0));
  const concM = zero12();
  for (const a of detail) if (a.pcode === '2') a.code && lines.get(a.code)?.months.forEach((v, i) => { concM[i] = r2(concM[i] + v); });
  // 5032/5033/5034/5040: T12 ratio to GPR × GPR
  for (const gl of ['5032', '5033', '5034', '5040']) { const a = coaByCode.get(gl); if (a && !isSet(gl)) pctGprLine(a); }
  // 5035 current delinquency: T12 ratio to (GPR..5035) × net rental income so far
  {
    const a = coaByCode.get('5035');
    if (a && !isSet('5035')) {
      const denom = detail.filter((x) => Number(x.code) >= 4994 && Number(x.code) <= 5035).reduce((s, x) => s + baseTotal(x.code), 0);
      const pct = inputs.pctGpr?.['5035'] ?? (denom ? baseTotal('5035') / denom : 0);
      if (pct) {
        const m = zero12();
        for (let i = 0; i < 12; i++) {
          const net = netGpr[i] + concM[i] + ['5031', '5032', '5033', '5034'].reduce((s, g) => s + (lines.get(g)?.months[i] || 0), 0);
          m[i] = r2(pct * net);
        }
        mk('5035', m, { method: 'pctGpr', pct: Math.round(pct * 100000) / 100000, of: 'net', basis: 't12' });
      }
    }
  }
  // 5036 prior period collections (Troy 2026-11-09): "should be based on the previous month's
  // DQ. Higher DQ = higher potential collections in future months" — and never more than that
  // delinquency ("where would that money come from??"). Each month = collection rate × the
  // PREVIOUS month's budgeted delinquency (5035); January collects against the last actual
  // month's delinquency. Rate = the trailing-12's collections ÷ its delinquency, capped at 100%
  // (inputs.collectPct when typed). With no delinquency to collect against it falls back to the
  // old T12 ratio to net GPR.
  {
    const a = coaByCode.get('5036');
    if (a && !isSet('5036')) {
      const dq = lines.get('5035')?.months || zero12();
      const t12Dq = Math.abs(sum(src.actual?.['5035'] || zero12()));
      const t12Col = sum(src.actual?.['5036'] || zero12());
      const histRate = t12Dq > 0 && t12Col > 0 ? Math.min(1, t12Col / t12Dq) : null;
      const rate = inputs.collectPct != null ? Math.min(1, Math.max(0, inputs.collectPct)) : histRate;
      if (rate != null && dq.some((v) => v)) {
        const startDq = Math.abs((src.actual?.['5035'] || zero12())[lastMonth - 1] || 0) || Math.abs(dq[0]);
        const months = dq.map((_, i) => r2(rate * (i === 0 ? startDq : Math.abs(dq[i - 1])))) as Months;
        mk('5036', months, { method: 'collections', pct: Math.round(rate * 100000) / 100000, startDq: r2(startDq), ...(histRate != null && t12Col / t12Dq > 1 ? { capped: true, t12Rate: Math.round((t12Col / t12Dq) * 1000) / 1000 } : {}) } as any);
      } else {
        const denom = ['4994', '4995', '4996', '5003'].reduce((x, g) => x + baseTotal(g), 0);
        const pct = inputs.pctGpr?.['5036'] ?? (denom ? baseTotal('5036') / denom : 0);
        if (pct) mk('5036', netGpr.map((v) => r2(pct * v)), { method: 'pctGpr', pct: Math.round(pct * 100000) / 100000, of: 'netgpr', basis: 't12' });
      }
    }
  }
  // any other cat-3 GL with history: T12 ratio to GPR × GPR
  for (const a of detail) if (a.pcode === '3' && !isSet(a.code)) pctGprLine(a);

  /* ---- rent-roll charges (pet, garage, storage, utility billing…) × 12 (Troy) ---- */
  const chargeGls = src.charges ? chargeGlMonthly(src.charges) : {};
  for (const [gl, monthly] of Object.entries(chargeGls)) {
    if (!coaByCode.has(gl) || gl === '4994' || isSet(gl)) continue;
    mk(gl, Array(12).fill(r2(monthly)) as Months, { method: 'charges', codes: gl });
  }

  /* ---- turnover-driven income: $ per new move-in × projected move-ins ---- */
  if (turnsTotal > 0) {
    for (const [gl] of Object.entries(TURN_GLS)) {
      const a = coaByCode.get(gl);
      if (!a || isSet(gl) || ruleOf(gl)) continue;   // a foundation rule (GRKS: wavg) outranks the template's per-move-in formula
      // default $/turn keeps LAST YEAR's dollars at THIS year's turnover count
      const amt = inputs.turnFees?.[gl] ?? (baseTotal(gl) ? r2(baseTotal(gl) / turnsTotal) : 0);
      if (!amt) continue;
      mk(gl, turns.map((t) => r2(t * amt)), { method: 'perTurn', amount: amt, turns: r2(turnsTotal) });
    }
  }

  /* ---- corporate rules ---- */
  const corp = corpRatesFor(inputs.year) as Record<string, { perUnitYr?: number; flatMo?: number }>;
  for (const [gl, v] of Object.entries(inputs.corpRates || {})) corp[gl] = v;
  if (units > 0) {
    for (const [gl, rate] of Object.entries(corp)) {
      if (!coaByCode.has(gl) || isSet(gl) || (!rate.perUnitYr && !rate.flatMo)) continue;
      const mo = r2((units * (rate.perUnitYr || 0)) / 12 + (rate.flatMo || 0));
      mk(gl, Array(12).fill(mo) as Months, { method: 'corpRate', perUnitYr: rate.perUnitYr, flatMo: rate.flatMo });
    }
  }
  const sugg = tpl?.suggestions || {};
  const suggGls = inputs.suggestionGls || DEFAULT_SUGGESTION_GLS;
  for (const gl of suggGls) {
    const a = coaByCode.get(gl);
    const s = sugg[gl];
    if (!a || !s || !s.some((v) => v) || isSet(gl)) continue;
    const note = (tpl?.suggestionNotes?.[gl] || []).join('; ');
    if (gl === '6315') {
      // donations: PY actuals + the corporate line (Family Homestead in November)
      const cal = base[gl] || zero12();
      mk(gl, rotate12(cal, startMonth).map((v, i) => r2(v + s[i])), { method: 'suggested', note: `PY actuals + ${note}` });
    } else {
      const pct = gl === '6350' ? (bl.glGrowth?.[gl] ?? 0) : 0;
      mk(gl, s.map((v) => r2(v * (1 + pct))), { method: 'suggested', note });
    }
  }
  if (tpl?.softwareFixedMo && coaByCode.has('6331') && !isSet('6331')) {
    mk('6331', Array(12).fill(r2(tpl.softwareFixedMo)) as Months, { method: 'suggested', note: `fixed budgeted cost $${tpl.softwareFixedMo}/month` });
  }
  for (const gl of TEMPLATE_ZERO_GLS) if (coaByCode.has(gl) && !isSet(gl)) mk(gl, zero12(), { method: 'zero' });

  /* ---- payroll (Troy): wages FLAT by month — the payroll model's annual (March
     raise step) when a model is linked, else own trailing-12 × (1 + raise).
     Roster wages (the Pay-rates apply) already carry each person's raise
     prorated from its effective month, so they get NO second step.
     Every other payroll line = a historical % of wages × EACH MONTH's budgeted
     wages (Troy 2026-11-09: the ratio is monthly, not an annual total spread
     flat — so the lines step with the March raise) — the trailing-12 actual
     ratio, the CY budget ratio, or the average of the two (inputs.burdenBasis;
     Troy 2026-11-03 "a % of wages pulled from a mix of historicals") — so a
     change to wages (model, raise, or a hand-typed wage line) moves taxes /
     benefits / bonus / OT with it. Lines that aren't a function of wages
     (BURDEN_LAST_GLS, or a shape picked on the row) carry their own history. ---- */
  const wages = src.payrollWages;      // model wages, with hand-overridden wage lines folded in (overriddenWages)
  // Roster wages — the live Pay-rates link (the default, Troy 2026-11-09) or an applied
  // snapshot — carry their own raises: no March step, and the generic raise % is not used.
  const live = src.wagesLive || null;
  const rosterWages = inputs.wagesFromRoster === true || !!live;
  const raise = 1 + (inputs.payrollRaisePct ?? 0.035);
  const iMarch = (3 - startMonth + 12) % 12;
  const wagesMonthly = zero12();
  const addWages = (m: Months) => { for (let i = 0; i < 12; i++) wagesMonthly[i] = r2(wagesMonthly[i] + m[i]); };
  const rosterDriver = { method: 'payrollModel', ...(rosterWages ? { roster: true } : {}), ...(live ? { live: true, cycle: live.label, effective: live.effective, draft: live.draft } : {}) } as any;
  if (wages) {
    for (const [gl, annual] of Object.entries(wages)) {
      if (!coaByCode.has(gl)) continue;
      if (userShaped.has(gl)) continue;                             // built above on the row's own shape; added to the wage base below
      if (!annual) {
        // the roster is authoritative for every wage GL: one it books NOTHING to is a set
        // zero, so the trailing-12 fallback below cannot refill it (rovers and grounds are
        // booked to 6404 — a T12 6407 on top would count them twice)
        if (rosterWages && WAGE_GLS.includes(gl) && annual === 0) mk(gl, zero12(), rosterDriver);
        continue;
      }
      // LIVE roster wages keep their month-by-month shape: the old rate until the raise's
      // effective month, the raised rate from it on — never the year's total smeared flat
      // (Troy 2026-11-09: "equal across the year, including months prior to the increases").
      // A wage total typed / overridden on the budget rides the same shape, scaled.
      const shape = live?.monthly?.[gl] ? rotate12(live.monthly[gl], startMonth) : null;
      const shapeSum = shape ? sum(shape) : 0;
      let months: Months;
      if (shape && shapeSum) {
        const k = r2(annual) / shapeSum;
        months = shape.map((v) => r2(v * k)) as Months;
        const drift = r2(r2(annual) - sum(months));               // penny-fix on the last month
        if (drift) months[11] = r2(months[11] + drift);
      } else {
        // payroll MODEL wages (no roster): the raise % phases in the same way — half in February, all of it from March
        const iFeb = (2 - startMonth + 12) % 12;
        months = spreadMonthly(r2(annual), CURVES.flat).map((v, i) => (rosterWages ? v : i === iFeb && iFeb < iMarch ? r2(v * (1 + (raise - 1) / 2)) : i >= iMarch ? r2(v * raise) : v)) as Months;
      }
      addWages(months);
      mk(gl, months, rosterDriver);
    }
  }
  for (const gl of WAGE_GLS) {
    // wage GLs the model doesn't carry: own trailing-12 ÷ 12 flat × (1 + raise)
    const a = coaByCode.get(gl);
    if (!a) continue;
    if (userShaped.has(gl)) { addWages(lines.get(gl)!.months); continue; }   // the row's shape is the wage line; burden follows it
    if (isSet(gl)) continue;
    if (baseline(a, 'flat', bl.glGrowth?.[gl] ?? (raise - 1))) addWages(lines.get(gl)!.months);
  }
  const wagesTotal = sum(wagesMonthly);
  const burdenBasis: 't12' | 'budget' | 'mix' = inputs.burdenBasis || 't12';
  const ratioIn = (cal: Record<string, Months> | null | undefined, gl: string): number | null => {
    if (!cal) return null;
    const w = WAGE_GLS.reduce((acc, g) => acc + Math.abs(sum(cal[g] || zero12())), 0);
    const own = sum(cal[gl] || zero12());
    return w > 0 && own ? own / w : null;
  };
  /* SAME-MONTH ratio (Troy 2026-11-09, "the ratio is monthly, not annualized"):
     each calendar month's own % of wages, so quarterly NOI bonuses (Jan / Apr /
     Jul / Oct), summer leasing commissions and Q1 tax front-loading keep their
     shape instead of being smeared flat — a flat line guarantees a variance both
     ways every month. A month with no wages in the history falls back to the
     annual ratio. Returns calendar-indexed ratios (null = no wages that month). */
  const ratiosIn = (cal: Record<string, Months> | null | undefined, gl: string): (number | null)[] | null => {
    if (!cal) return null;
    const own = cal[gl] || zero12();
    if (!own.some((v) => v)) return null;
    return Array.from({ length: 12 }, (_, c) => {
      const w = WAGE_GLS.reduce((acc, g) => acc + Math.abs((cal[g] || zero12())[c]), 0);
      return w > 0 ? own[c] / w : null;
    });
  };
  const r5 = (v: number) => Math.round(v * 100000) / 100000;
  const pickRatio = <T,>(t12: T | null, bud: T | null, avg: (a: T, b: T) => T): T | null =>
    burdenBasis === 'budget' ? (bud ?? t12) : burdenBasis === 'mix' ? (t12 != null && bud != null ? avg(t12, bud) : (t12 ?? bud)) : (t12 ?? bud);
  for (const a of detail) {
    if (a.pcode !== '10' || WAGE_GLS.includes(a.code) || isSet(a.code)) continue;
    // not a % of wages: employee rent carries its last actual month flat (no
    // raise on it), and any payroll line whose row menu picked a shape keeps it
    const ownShape = bl.glShape?.[a.code] ?? (BURDEN_LAST_GLS.has(a.code) ? 'last' : undefined);
    if (ownShape && baseline(a, ownShape, bl.glGrowth?.[a.code] ?? (BURDEN_LAST_GLS.has(a.code) ? 0 : raise - 1))) continue;
    const t12Ratio = ratioIn(src.actual, a.code);
    const budgetRatio = ratioIn(src.budget, a.code);
    const ratio = pickRatio(t12Ratio, budgetRatio, (x, y) => (x + y) / 2);
    const t12M = ratiosIn(src.actual, a.code), budM = ratiosIn(src.budget, a.code);
    if (ratio != null && wagesTotal > 0) {
      const monthly = Array.from({ length: 12 }, (_, c) => pickRatio(t12M?.[c] ?? null, budM?.[c] ?? null, (x, y) => (x + y) / 2) ?? ratio);
      const months = wagesMonthly.map((w, i) => r2(monthly[(startMonth - 1 + i) % 12] * w)) as Months;
      mk(a.code, months, {
        method: 'burdenRatio', ratio: r5(ratio), basis: burdenBasis, sameMonth: true, ratios: monthly.map(r5),
        ...(t12Ratio != null ? { t12Ratio: r5(t12Ratio) } : {}), ...(budgetRatio != null ? { budgetRatio: r5(budgetRatio) } : {}),
      } as any);
    } else if (baseTotal(a.code)) baseline(a, 'flat', bl.glGrowth?.[a.code] ?? (raise - 1));
  }

  /* ---- utility reimbursements at a FLAT-FEE property (Troy 2026-11-09): residents pay an
     in-house flat utility fee per occupied unit (BCND; PHND / FHND since fall 2026 instead
     of Conservice RUBS), so the income is flat — the most recent actual month, scaled
     from that month's occupancy to each budget month's budgeted occupancy, so it ties
     to the vacancy assumption. No GPR link; a typed per-GL % is a fee increase. HAP
     utility allowance (5122) is not a fee and keeps its history. ---- */
  if (flatFeeBilling(inputs, src.propertyCode)) {
    const act = src.actual || {};
    const lastAct = (gl: string): number => (act[gl] || zero12())[lastMonth - 1] || 0;
    const lastGprA = lastAct('4994');
    const occLast = lastGprA > 0 ? Math.min(1, Math.max(0.5, 1 - Math.abs(lastAct('5031')) / lastGprA)) : 1;
    for (const a of detail) {
      if (a.pcode !== '4' || a.code === '5122' || isSet(a.code)) continue;
      if (!act[a.code] || !act[a.code].some((v) => v)) continue;
      const feeBase = lastAct(a.code);
      const pct = bl.glGrowth?.[a.code] ?? 0;
      const months = Array.from({ length: 12 }, (_, i) => r2(feeBase * (1 + pct) * (1 - (vacPct[i] || 0)) / occLast)) as Months;
      mk(a.code, months, { method: 'flatFee', base: feeBase, lastMonth, occLast: Math.round(occLast * 10000) / 10000, pct } as any);
    }
  }

  /* ---- everything else with history: PY same month × factor (template default) ---- */
  for (const a of detail) {
    if (isSet(a.code) || BASELINE_SKIP_SECTIONS.has(a.section)) continue;
    if (a.code === '6112' || a.code === '7300') continue;
    if (a.pcode === '1' && a.code !== '4994') { baseline(a, 'last', 0); continue; }
    // payroll (no model): trailing-12 ÷ 12 flat × (1 + raise) — never the lumpy
    // same-month history (a row's shape menu can still switch it back)
    if (a.pcode === '10') { baseline(a, 'flat', bl.glGrowth?.[a.code] ?? inputs.payrollRaisePct ?? 0.035); continue; }
    baseline(a);
  }

  /* ---- management fee: % of the PRIOR month's total income, rounded to the dollar
     (2027 template: the fee bills a month in arrears, so January runs on December's
     budgeted income; without a current-year budget January runs on its own income) ---- */
  const monthsMap = new Map<string, Months>();
  for (const [gl, ln] of lines) monthsMap.set(gl, ln.months);
  const totalIncome = rollup(monthsMap).get('5500') || zero12();
  const feePct = inputs.mgmtPct || tpl?.mgmtFee?.actualPct || 0;
  if (isSet('6112')) {
    // a shape chosen on the row: already built above
  } else if (feePct) {
    const prevCal = (startMonth + 10) % 12;                                   // calendar index of the month before the budget starts
    const budIncome = src.budget && Object.keys(src.budget).length ? rollup(new Map(Object.entries(src.budget) as [string, Months][])).get('5500') : null;
    const before = budIncome && budIncome[prevCal] ? budIncome[prevCal] : totalIncome[0];
    const basis = totalIncome.map((v, i) => (i === 0 ? before : totalIncome[i - 1])) as Months;
    // first twelve months of ownership at the first-year rate (typed on the budget, else the
    // property's acquisition budget), the regular rate after
    const fy = { pct: inputs.mgmtFirstYear?.pct !== undefined ? inputs.mgmtFirstYear.pct : src.acquisition?.firstYearPct, start: inputs.mgmtFirstYear?.start || src.acquisition?.start };
    const fr = mgmtFeeRates(inputs.year, startMonth, feePct, fy);
    mk('6112', basis.map((v, i) => Math.round(v * fr.rates[i])) as Months, { method: 'mgmtPct', pct: feePct, priorMonth: true, ...(fr.firstMonths ? { firstYear: { pct: fy.pct, months: fr.firstMonths, through: fr.through } } : {}) } as any);
  }
  else if (coaByCode.has('6112')) baseline(coaByCode.get('6112')!);

  /* ---- debt service: the Yardi amortization schedule; else loan × rate; else history ---- */
  if (isSet('7300')) {
    // a shape chosen on the row: already built above (principal still follows the schedule)
    const pGl = tpl?.debt?.principalGl || '3080';
    if (tpl?.debt && coaByCode.has(pGl) && !isSet(pGl) && tpl.debt.principal.some((v) => v)) mk(pGl, rotate12(tpl.debt.principal, startMonth), { method: 'debtService', kind: 'principal', loan: tpl.debt.loans.join('+') });
  } else if (tpl?.debt && tpl.debt.interest.some((v) => v)) {
    mk('7300', rotate12(tpl.debt.interest, startMonth), { method: 'debtService', kind: 'interest', loan: tpl.debt.loans.join('+') });
    const pGl = tpl.debt.principalGl || '3080';
    if (coaByCode.has(pGl) && tpl.debt.principal.some((v) => v)) mk(pGl, rotate12(tpl.debt.principal, startMonth), { method: 'debtService', kind: 'principal', loan: tpl.debt.loans.join('+') });
  } else if (inputs.loan && inputs.rate) {
    const int = zero12();
    for (let i = 0; i < 12; i++) int[i] = r2((inputs.loan * inputs.rate / 360) * daysInMonth(calYearOf(inputs.year, startMonth, i), calMonthOf(startMonth, i)));
    mk('7300', int, { method: 'interest', loan: inputs.loan, rate: inputs.rate });
  } else if (coaByCode.has('7300')) baseline(coaByCode.get('7300')!, 'last', 0);

  return [...lines.values()];
}

export function regenerateAnnual(existing: BudgetLine[], coaList: CoaAccount[], inputs: BudgetInputs, src: AnnualSources): BudgetLine[] {
  const effWages = overriddenWages(existing, src.payrollWages);
  return mergeFresh(existing, coaList, generateAnnualLines(coaList, inputs, { ...src, payrollWages: effWages }));
}

/** Default inputs for an annual budget — the template's own defaults where a
    template is linked (renewal %, burnoffs, GPR % changes, vacancy %, Q4 fee
    %, units, capital), the property's trailing-12 ratios otherwise, and the
    rent roll driving GPR when one is linked. Nothing ties. */
export function defaultAnnualInputs(year: number, units: number, actual: Record<string, Months> | null, rent: { marketMonthly: number; inPlaceMonthly: number; gapMonthly?: number } | null, coaList: CoaAccount[], tpl?: TemplateData | null, lastMonth?: number): BudgetInputs {
  const cal = actual || {};
  const last = (lastMonth || tpl?.lastActual.month || 10) - 1;
  const tot = (gl: string) => sum(cal[gl] || zero12());
  const lastOf = (gl: string) => (cal[gl] || zero12())[last] || 0;
  const coa = new Map(coaList.map((a) => [a.code, a]));
  const catTot = (p: string) => Object.entries(cal).reduce((a, [gl, m]) => (coa.get(gl)?.pcode === p ? r2(a + sum(m)) : a), 0);
  const gpr = tot('4994');
  const ratio = (v: number, lo = 0, hi = 1) => (gpr ? Math.min(hi, Math.max(lo, Math.abs(v) / gpr)) : 0);
  const income = ['1', 'loss', '2', '3', '4', '5'].reduce((a, p) => r2(a + catTot(p)), 0);
  const mgmt = tot('6112');
  // vacancy %: the TRAILING-12 ratio (Troy — not the template's October %)
  const vac = gpr ? ratio(tot('5031'), 0, 0.5) : 0.05;
  return {
    mode: 'annual',
    year, units: units || tpl?.units || 0, capital: tpl?.capital || 0, loan: 0, rate: 0, startMonth: 1,
    tieNoi: false, tieIncome: false,
    gpr: { baseMonthly: rent ? rent.marketMonthly : 0, growthPct: (tpl?.gprPct && tpl.gprPct.some((v) => v) ? tpl.gprPct : zero12()) as Months },
    ltl: {
      mode: 'leases', renewalPct: tpl?.renewalPct ?? 0.65, burnoffRenew: tpl?.burnoffRenew ?? 0.75, burnoffNew: tpl?.burnoffNew ?? 1, followGpr: true,
      // the loss to lease is on OCCUPIED units (market − rent per lease); market −
      // in-place over the whole roll would count the vacant units' market too
      startMonthly: rent ? -Math.max(0, r2(rent.gapMonthly ?? (rent.marketMonthly - rent.inPlaceMonthly))) : 0,
      targetPct: ratio(tot('5003'), 0, 0.3), rampMonths: 12,
    },
    vacancyPct: Array(12).fill(Math.round(vac * 10000) / 10000) as Months,
    concessionPct: ratio(catTot('2'), 0, 0.2),
    rentalLossPct: ratio(catTot('3'), 0, 0.5),
    mgmtPct: tpl?.mgmtFee?.actualPct ? Math.round(tpl.mgmtFee.actualPct * 10000) / 10000 : (income > 0 && mgmt > 0 ? Math.round((mgmt / income) * 10000) / 10000 : 0.04),
    utilities: { source: 'baseline', growthPct: 0.03, recoveryPct: null },
    // growthPct stays EMPTY: a category % is only set when the user types one (it then
    // outranks every GL's foundation factor in that category)
    baseline: { ...DEFAULT_BASELINE, growthPct: {} },
    refSource: 'actual',
    expirations: tpl?.leaseExpirations?.some((v) => v) ? tpl.leaseExpirations : null,
    uwAbs: {},
  };
}
