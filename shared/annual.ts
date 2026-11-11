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
  type Lease, type CompWeights, type BaselineShape, type T12Adjust, type Contract, type FeeSchedule,
  zero12, r2, sum, rollup, spreadMonthly, rotate12, CURVES, WAGE_GLS, ltlMonths, ltlModel, chargeGlMonthly,
  mergeFresh, overriddenWages, calMonthOf, calYearOf, daysInMonth, dateKey, leaseEndIndex, calendarSlice, foldCredits,
} from './domain.js';

/** Bump whenever a formula or default changes what a (re)calculation produces. A budget is
    stamped with it on every full build (budgets.calc_version); the editor flags a budget
    calculated on an older one, because stored lines only move on Recalc. */
export const ENGINE_VERSION = '2026-11-11a';

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
export function trailing12(stmts: (StmtData | null | undefined)[], opts: { excludeStartup?: number; back?: number } = {}): Trailing12 | null {
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
  // `back` > 0: the window that ended that many months BEFORE the last posted month (the
  // Summary tab's "Oct. / Nov. / Dec. T12 NOI Trend" columns). Only when every month of it is
  // on file — a partly covered earlier window is not reported.
  const back = Math.max(0, Math.round(opts.back || 0));
  if (back > 0) {
    last -= back;
    for (let k = last - 11; k <= last; k++) if (!cell.has(k)) return null;
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

/* ---------------- the Summary panel (Troy 2026-11-10) ----------------
   One column of the budget-comps summary Troy keeps in Excel ("Minot Avg." / the per-property
   sheets of "Minot 2025 Budget Comps"): the Monarch total rows it lists, in its order.
   `tot` reads a Monarch TOTAL row (5070, 6170…), `gl` a single GL. Pure. */
export interface SummaryCol {
  rental: number; other: number; income: number;
  fixedLess: number; tax: number; fee: number; admin: number; payroll: number; marketing: number; utilities: number;
  inHouse: number; exterior: number; contract: number; rehab: number; expense: number;
  noi: number; interest: number; mtg1: number; mtg2: number; cashFlow: number;
}
export function summaryColumn(tot: (code: string) => number, gl: (code: string) => number): SummaryCol {
  const n = (v: number) => r2(Number(v) || 0);
  const rental = n(tot('5070')), other = n(tot('5190'));
  const tax = n(gl('6116')), fee = n(gl('6112'));
  const fixedLess = n(tot('6170') - tax - fee);                  // "Fixed Admin Less RE TAXES & MGMT FEE"
  const admin = n(tot('6370') + tot('6399'));                    // admin + corporate events, as the workbook adds them
  const payroll = n(tot('6470')), marketing = n(tot('6570')), utilities = n(tot('6670'));
  const inHouse = n(tot('6770')), exterior = n(tot('6870')), contract = n(tot('6970')), rehab = n(tot('7070'));
  const income = n(rental + other);
  const expense = n(fixedLess + tax + fee + admin + payroll + marketing + utilities + inHouse + exterior + contract + rehab);
  const noi = n(income - expense);
  const interest = n(gl('7300'));
  const mtg1 = -Math.abs(n(gl('3080'))), mtg2 = -Math.abs(n(gl('3090')));   // principal reduces cash flow
  return { rental, other, income, fixedLess, tax, fee, admin, payroll, marketing, utilities, inHouse, exterior, contract, rehab, expense, noi, interest, mtg1, mtg2, cashFlow: n(noi - interest + mtg1 + mtg2) };
}
/** Add summary columns (a region's "Avg." sheet is the sum of its properties). */
export function sumSummaryCols(cols: (SummaryCol | null | undefined)[]): SummaryCol | null {
  const list = cols.filter((c): c is SummaryCol => !!c);
  if (!list.length) return null;
  const out = {} as any;
  for (const k of Object.keys(list[0]) as (keyof SummaryCol)[]) out[k] = r2(list.reduce((a, c) => a + (c[k] || 0), 0));
  return out as SummaryCol;
}
/** Default column headers for the summary, from the trailing-12 window's last month: "Oct. 26 T12", "Oct. T4 Ann." */
export function summaryLabels(lastMonth: number | null | undefined, lastYear: number | null | undefined, typed?: { t12?: string; t4?: string; draft?: string } | null): { t12: string; t4: string; draft: string } {
  const mon = lastMonth ? MON[(lastMonth - 1 + 12) % 12] : '';
  const yy = lastYear ? String(lastYear).slice(2) : '';
  return {
    t12: typed?.t12 || (mon ? `${mon}. ${yy} T12`.replace('  ', ' ') : 'T12'),
    t4: typed?.t4 || (mon ? `${mon}. T4 Ann.` : 'T4 Ann.'),
    draft: typed?.draft || 'Draft #1',
  };
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
  // Blanket insurance for the 2026-27 policy year (Nov 2026 - Oct 2027) is $275/door, down from
  // $285 (KB Sources/2027 Budget notes A1 Insurance, "[Stated - Insurance & Claims notes, as of
  // 2026-11-06]"). The 11/1/2027 renewal is not priced yet, so Nov-Dec carry the same rate.
  '6108': { perUnitYr: 275, label: 'Insurance — blanket $275/unit/yr (2026-27 policy year; Nov–Dec 2027 renewal not priced)' },
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
/** Real estate taxes grow 3% a year unless a % is typed on the row, the section or the category. */
export const RE_TAX_DEFAULT_PCT = 0.03;
/** Per-GL increase factors the template hard-codes. */
export const TEMPLATE_GL_PCT: Record<string, number> = {
  '5158': 0.05, '5167': 0.05, '5169': 0.05, '5170': 0.05, '5171': 0.05, '5172': 0.05, '5174': 0.05,
  '6550': 0.05, '6555': 0.05, '6620': 0.07, '6621': 0.07, '6665': 0, '5178': 0, '5180': 0,
  // REAL ESTATE TAXES (Troy 2026-11-10: "3% growth by default on RE taxes. It should not be $0")
  '6116': RE_TAX_DEFAULT_PCT,
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
export function annualBaseline(cal: Months, opts: { pct?: number; pcts?: Months | null; shape: BaselineShape; startMonth?: number; lastMonth?: number; curve?: Months | null; mult?: number; turns?: Months | null; fit?: number }): Months {
  const g = (i: number) => 1 + (opts.pcts ? (opts.pcts[i] || 0) : (opts.pct || 0));
  // FIT TO T12 (Troy 2026-11-11: "apply a turnover curve, and then fit it closer to T12 historical expenses"):
  // the curve's weights are blended with the GL's own trailing-12 months, `fit` (0..1) being the share taken
  // from history. 0 = the pure curve, 1 = the T12 months themselves. Credit months count as zero. Total unchanged.
  const fitted = (w: number[]): Months => {
    const f = Math.min(1, Math.max(0, opts.fit || 0));
    const sg = cal.reduce((a, b) => a + b, 0) >= 0 ? 1 : -1;
    const own = cal.map((v) => (v * sg > 0 ? v * sg : 0));
    const os = own.reduce((a, b) => a + b, 0), ws = w.reduce((a, b) => a + b, 0);
    if (!f || !os || !ws) return w as Months;
    return w.map((v, i) => ((1 - f) * v) / ws + (f * own[i]) / os) as Months;
  };
  const start = opts.startMonth || 1;
  const last = (opts.lastMonth || 10) - 1;
  let m: Months;
  switch (opts.shape) {
    case 'wavg': m = cal.map((_, c) => ((2 * cal[c] + cal[(c + 11) % 12] + cal[(c + 1) % 12]) / 4) * g(c)) as Months; break;
    case 'flat': { const tot = cal.reduce((a, b) => a + b, 0); m = cal.map((_, c) => (tot / 12) * g(c)) as Months; break; }
    case 'curve': {
      const tot = r2(cal.reduce((a, b) => a + b, 0) * (1 + (opts.pct || 0)));
      m = spreadMonthly(tot, fitted(opts.curve && opts.curve.some((v) => v > 0) ? opts.curve : CURVES.flat));
      break;
    }
    case 'turns': {
      // T12 total × factor, spread by lease expirations lagged one month (calendar order);
      // with no expirations on file the line falls back to flat
      const tot = r2(cal.reduce((a, b) => a + b, 0) * (1 + (opts.pct || 0)));
      const w = fitted(opts.turns && opts.turns.some((v) => v > 0) ? opts.turns : CURVES.flat);
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
  /** fit to T12 (0..1) for a curve shape: share of the monthly shape taken from the GL's own trailing-12 months */
  fit?: number;
}
const RULE_SHAPE: Partial<Record<AnnualRule['method'], BaselineShape>> = { same: 'actual', wavg: 'wavg', flatT12: 'flat', last: 'last', fixedAnnual: 'flat' };
export const ruleShapeOf = (r: AnnualRule | null | undefined): BaselineShape | undefined => (r ? (r.shape ?? RULE_SHAPE[r.method]) : undefined);

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
    vacancyExpWeight?: number; burdenBasis?: 't12' | 'budget' | 'mix'; burdenFrom?: string; wageSource?: 'payroll' | 'manual'; payrollRaisePct?: number;
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
    if (d.fit > 0) r.fit = d.fit;
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
  if (inputs.burdenFrom) settings.burdenFrom = inputs.burdenFrom;
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
    baseline: { ...DEFAULT_BASELINE, ...(inputs.baseline || {}), ...clean(st.baseline), glShape: {}, glGrowth: {}, glMround: {}, glFit: {}, secGrowth: {} } as any,
    ltl: { ...(inputs.ltl || ({} as any)), ...clean(st.ltl) },
    ...(st.vacancyExpWeight != null ? { vacancyExpWeight: st.vacancyExpWeight } : {}),
    ...(st.burdenBasis ? { burdenBasis: st.burdenBasis } : {}),
    ...(st.burdenFrom ? { burdenFrom: st.burdenFrom } : {}),
    ...(st.wageSource ? { wageSource: st.wageSource } : {}),
    ...(st.payrollRaisePct != null ? { payrollRaisePct: st.payrollRaisePct } : {}),
  } as BudgetInputs;
}

/* ---------------- one set of formula changes, given to other budgets (Troy 2026-11-10) ----------------
   "I need to be able to change entire sections of formulas for all templates at once w ease. For
   example, Contractor uses T12/12 ... which is how all of my budgets are set up." / "being able to
   selectively apply one set of changes to other templates".
   The formulas of the chosen GLs (whole sections of the source budget) are written into the
   target's rules; the target's own per-row shape / rounding choices on those GLs are dropped so
   the copied formula governs. Everything outside those GLs is untouched, and so is every dollar,
   every hand-typed line and every data input. The increase % travels only when asked: otherwise
   each line keeps the factor it already had on the target. Pure - the caller regenerates. */
/** What a budget hands over for whole sections: its own rule for every formula-driven GL there,
    plus - when every such line in a section is built the SAME way - that one formula for the
    section's other GLs (lines the source has no history on), so "the whole section" means the
    whole section on the receiving budget too. A section with mixed formulas hands over only its
    own lines. `fill` lists the GLs covered that second way. */
export function sectionFormulaSource(rules: Record<string, AnnualRule>, coaList: CoaAccount[], sections: string[]): { rules: Record<string, AnnualRule>; gls: string[]; fill: string[] } {
  const out: Record<string, AnnualRule> = {}; const gls: string[] = []; const fill: string[] = [];
  for (const sec of sections) {
    const detail = coaList.filter((a) => a.kind === 'detail' && a.section === sec);
    const own = detail.filter((a) => rules[a.code]);
    for (const a of own) { out[a.code] = rules[a.code]; gls.push(a.code); }
    const shaped = own.map((a) => rules[a.code]).filter((r) => r.method !== 'zero');
    const kinds = new Set(shaped.map((r) => `${r.method}|${r.shape || ''}`));
    if (kinds.size !== 1) continue;
    const one: AnnualRule = { method: shaped[0].method, ...(shaped[0].shape ? { shape: shaped[0].shape } : {}) };
    for (const a of detail) if (!rules[a.code]) { out[a.code] = one; gls.push(a.code); fill.push(a.code); }
  }
  return { rules: out, gls, fill };
}
/** Rule methods that leave the engine's own logic in charge of a GL (never replaced by a section fill). */
const ENGINE_RULE = new Set<AnnualRule['method']>(['engine', 'corpRate', 'suggested', 'debt', 'payroll', 'fixedAnnual', 'zero']);
/* ---------------- default formulas (Troy 2026-11-11) ----------------
   "If I am able to change default curves used, it is entirely too difficult to find. Note that those
   changes should flow through into anyone using default templates as well."
   ONE shared per-GL table (app_meta.default_rules), edited on the Default formulas screen. It applies to
   every budget that is not on a NAMED saved formula set: "Template defaults", the old GRKS default, or no
   set at all. A named set is a deliberate copy and is left alone. Above it: a formula picked on the budget
   itself (row / section / Formula for lines) and a formula copied into the budget. It never takes a GL the
   engine builds itself, and the line keeps its own increase % and rounding. */
/** The formula a history-based GL gets when no rule names one. */
export function builtinShape(code: string): BaselineShape {
  return LAST_MONTH_FLAT_GLS.has(code) ? 'last' : FIXED_ANNUAL_GLS.has(code) || FLAT_T12_GLS.has(code) ? 'flat' : AVG_NZ_GLS.has(code) ? 'avgnz' : TURN_EXPENSE_GLS.has(code) ? 'turns' : 'actual';
}
export const shapeRule = (sh: BaselineShape): AnnualRule => (SHAPE_RULE[sh] ? { method: SHAPE_RULE[sh]! } : { method: 'custom', shape: sh });
export function followsDefaults(inputs: BudgetInputs | null | undefined): boolean {
  const rf = inputs?.rulesFrom;
  return !rf || rf.id == null || rf.id === 'grks';
}
/** Is this GL's formula the engine's own business (corporate rate, fee, payroll, a deliberate zero)? */
export const isEngineRule = (r: AnnualRule | null | undefined): boolean => !!r && ENGINE_RULE.has(r.method);
export function effectiveRules(inputs: BudgetInputs, fallback: Record<string, AnnualRule> | null, defaults: Record<string, AnnualRule> | null | undefined): Record<string, AnnualRule> {
  const base = ((inputs.rules as Record<string, AnnualRule> | undefined) ?? fallback ?? {});
  if (!defaults || !Object.keys(defaults).length || !followsDefaults(inputs)) return base;
  const own = new Set(inputs.rulesOwn || []);
  const out: Record<string, AnnualRule> = { ...base };
  for (const [gl, r] of Object.entries(defaults)) {
    const prev = base[gl];
    if (own.has(gl) || !ruleShapeOf(r) || isEngineRule(prev)) continue;
    out[gl] = { method: r.method, ...(r.shape ? { shape: r.shape } : {}), ...(prev && Number.isFinite(prev.factor) ? { factor: prev.factor } : {}), ...(prev?.mround ? { mround: prev.mround } : {}), ...(r.fit ? { fit: r.fit } : {}) };
  }
  return out;
}

export function copyFormulas(
  target: BudgetInputs, src: { rules: Record<string, AnnualRule>; secGrowth?: Record<string, number> | null },
  gls: string[], sections: string[], opts: { pct?: boolean; fallbackRules?: Record<string, AnnualRule> | null; fill?: string[] } = {},
): { inputs: BudgetInputs; changed: string[] } {
  // a budget from before formula sets runs on the fallback table: keep it for every other GL
  const rules: Record<string, AnnualRule> = { ...((target.rules as Record<string, AnnualRule> | undefined) ?? opts.fallbackRules ?? {}) };
  const bl = { ...DEFAULT_BASELINE, ...(target.baseline || {}) } as any;
  const glShape = { ...(bl.glShape || {}) }, glMround = { ...(bl.glMround || {}) }, glGrowth = { ...(bl.glGrowth || {}) }, secGrowth = { ...(bl.secGrowth || {}) }, glFit = { ...(bl.glFit || {}) };
  const changed: string[] = []; const fillSet = new Set(opts.fill || []);
  for (const gl of gls) {
    const from = src.rules[gl]; if (!from) continue;
    const prev = rules[gl];
    // a section fill never takes over a GL the engine builds itself (corporate rate, fee, payroll...)
    if (fillSet.has(gl) && prev && ENGINE_RULE.has(prev.method)) continue;
    const next: AnnualRule = { ...from };
    if (!opts.pct) { delete next.factor; if (prev && Number.isFinite(prev.factor)) next.factor = prev.factor; }
    const had = glShape[gl] != null || glMround[gl] != null || glFit[gl] != null || (opts.pct && glGrowth[gl] != null);
    if (had || JSON.stringify(prev || null) !== JSON.stringify(next)) changed.push(gl);
    rules[gl] = next; delete glShape[gl]; delete glMround[gl]; delete glFit[gl]; if (opts.pct) delete glGrowth[gl];
  }
  if (opts.pct) for (const s of sections) { const v = src.secGrowth?.[s]; if (v != null) secGrowth[s] = v; else delete secGrowth[s]; }
  // these GLs now carry a formula given to this budget on purpose: the shared defaults stay off them
  const rulesOwn = [...new Set([...(target.rulesOwn || []), ...gls.filter((gl) => src.rules[gl] && rules[gl] && JSON.stringify(rules[gl]).length && !(fillSet.has(gl) && isEngineRule(rules[gl])))])].sort();
  return { inputs: { ...target, rules, rulesOwn, baseline: { ...bl, glShape, glMround, glGrowth, glFit, secGrowth } } as BudgetInputs, changed };
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
  /** PAYROLL RATIOS FROM ANOTHER PROPERTY (Troy 2026-11-10: "for payroll % allocations for non
      wage GLs, I need to have an option to take the % and monthly curve shape from another
      property"). When set (`inputs.burdenFrom`), the non-wage payroll lines take their % of
      wages — the annual ratio AND each calendar month's own ratio — from this property's
      statements instead of the budget's own. Wages stay the budget's own. */
  burdenSrc?: { code: string; actual: Record<string, Months> | null; budget: Record<string, Months> | null } | null;
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

/* ============================================================================
   2027 BUDGET NOTES PASS (Troy 2026-11-11, KB Sources/2027 Budget notes.md, agreed on all)
   ========================================================================== */

/** One-time items out of the trailing-12 (KB A4). Each entry takes `amount` OFF the posted figure
    of calendar month `month` (1-12) of `gl`, before ANY formula reads the history: shapes, growth,
    ratios to GPR / wages and the flat-fee base all see the normalized month. Returns the adjusted
    calendar and the total removed per GL (for the chips). Never applied unless typed. */
export function applyT12Adjust(actual: Record<string, Months> | null | undefined, adj: T12Adjust[] | null | undefined): { actual: Record<string, Months> | null; byGl: Record<string, number> } {
  const byGl: Record<string, number> = {};
  if (!actual || !adj || !adj.length) return { actual: actual || null, byGl };
  const out: Record<string, Months> = { ...actual };
  for (const a of adj) {
    const m = Math.round(Number(a?.month));
    const amt = Number(a?.amount);
    if (!a?.gl || !(m >= 1 && m <= 12) || !Number.isFinite(amt) || !amt) continue;
    const cur = (out[a.gl] || zero12()).slice() as Months;
    cur[m - 1] = r2(cur[m - 1] - amt);
    out[a.gl] = cur;
    byGl[a.gl] = r2((byGl[a.gl] || 0) + amt);
  }
  return { actual: out, byGl };
}

/** A contract's amounts in BUDGET-month order (index 0 = the budget's start month). */
export function contractMonths(c: Contract, units: number, startMonth = 1): Months {
  const out = zero12();
  const billed = (c.months && c.months.length ? c.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    .map((m) => Math.round(Number(m))).filter((m) => m >= 1 && m <= 12);
  const amt = Number(c.amount) || 0;
  if (!amt || !billed.length) return out;
  const step = (cal: number): number => (c.stepMonth && c.stepPct && cal >= Number(c.stepMonth) ? 1 + Number(c.stepPct) : 1);
  for (let i = 0; i < 12; i++) {
    const cal = calMonthOf(startMonth, i);                         // 1-12
    let v = 0;
    if (c.kind === 'annual') v = cal === Number(c.billMonth || 1) ? amt : 0;
    else if (!billed.includes(cal)) v = 0;
    else if (c.kind === 'perUnit') v = (amt * (units || 0)) / billed.length;
    else v = c.per === 'total' ? amt / billed.length : amt;
    out[i] = r2(v * step(cal));
  }
  return out;
}

/** Recurring journal splits by site (KB A1: "Every month, 41.11% of common electric, sewer, trash,
    water, insurance, management fee and RE tax moves to TPNDC... Budget on the same basis"). */
export const ALLOC_OUT_DEFAULTS: Record<string, { to: string; pct: number; gls: string[] }> = {
  tpnd: { to: 'tpndc', pct: 0.4111, gls: ['6604', '6614', '6620', '6622', '6108', '6112', '6116'] },
};
export function allocOutFor(inputs: Pick<BudgetInputs, 'allocOut'> | null | undefined, propertyCode: string | null | undefined): { to: string; pct: number; gls: string[] } | null {
  if (inputs && inputs.allocOut !== undefined) return inputs.allocOut && inputs.allocOut.pct > 0 ? inputs.allocOut : null;
  return ALLOC_OUT_DEFAULTS[String(propertyCode || '').toLowerCase()] || null;
}
/** Methods that build a line from something OTHER than the property's own posted history: those
    are the gross figures the allocation has to come off. */
export const ALLOC_ENGINE_METHODS = new Set(['corpRate', 'mgmtPct', 'contract', 'suggested']);

/** Flat-fee utility income from the package schedule (KB A5: FHND $85/$115/$145, PHND $73/$108/$133
    by bedroom; renewals switch to the flat fee at lease expiration). Per occupied unit, month m:
    share(m) x F + (1 - share(m)) x R, where F = the schedule's unit-weighted fee, R = what a unit
    still on RUBS paid in the last actual month (backed out of that month's income and onFlatPct),
    and share(m) = onFlatPct + (1 - onFlatPct) x (leases ending from `convertFrom` through m / leases).
    Returns the monthly total (budget-month order), or null when the schedule is incomplete. */
export function flatFeeFromSchedule(sch: FeeSchedule, opts: { lastIncome: number; occLast: number; units: number; vacPct: Months; leases?: Lease[] | null; year: number; startMonth?: number }): { months: Months; F: number; R: number; share: Months } | null {
  const beds = Object.keys(sch.fees || {}).filter((b) => Number(sch.fees[b]) > 0 && Number(sch.units?.[b]) > 0);
  const schedUnits = beds.reduce((a, b) => a + Number(sch.units[b]), 0);
  if (!beds.length || !schedUnits) return null;
  const F = beds.reduce((a, b) => a + Number(sch.fees[b]) * Number(sch.units[b]), 0) / schedUnits;
  const units = opts.units || schedUnits;
  const s0 = Math.min(1, Math.max(0, Number(sch.onFlatPct) || 0));
  const occupiedLast = units * (opts.occLast || 1);
  const L = occupiedLast > 0 ? opts.lastIncome / occupiedLast : 0;
  const R = s0 < 1 ? Math.max(0, (L - s0 * F) / (1 - s0)) : F;
  const startMonth = opts.startMonth || 1;
  const startAbs = opts.year * 12 + (startMonth - 1);
  const cf = /^(\d{4})-(\d{1,2})/.exec(String(sch.convertFrom || ''));
  const fromIdx = cf ? Number(cf[1]) * 12 + Number(cf[2]) - 1 - startAbs : -1;   // relative to month 0
  const leases = opts.leases || [];
  const idx = leases.map((l) => leaseEndIndex(l.e, startAbs)).filter((v): v is number => v != null);
  const share = zero12();
  const months = zero12();
  for (let i = 0; i < 12; i++) {
    const turned = leases.length ? idx.filter((k) => k >= fromIdx && k <= i).length / leases.length : 0;
    share[i] = Math.min(1, s0 + (1 - s0) * turned);
    const perUnit = share[i] * F + (1 - share[i]) * R;
    months[i] = r2(units * (1 - (opts.vacPct[i] || 0)) * perUnit);
  }
  return { months, F: r2(F), R: r2(R), share };
}

/* ============================================================================
   2027 BUDGET GUIDANCE (exec team, Troy 2026-11-11): "The ones we MUST more or less adhere to are
   rental income, total income, total expenses, and any specific changes called out. NOI targets
   are the most important of all." A scorecard only: nothing here changes a budget. Ranges are
   per region (app_meta.guidance) and start at the exec team's numbers.
   ========================================================================== */
export interface BudgetGuidance {
  incomeMin: number; incomeMax: number;         // total income vs October T12
  expenseMin: number; expenseMax: number;       // total expenses vs October T12
  spreadMax: number;                            // expense growth may exceed income growth by at most this
  noiMin: number;                               // NOI vs October T12
  noiVsCyBudget: boolean;                       // NOI must not be below the current (2026) budget
  marchVsLastMin: number; marchVsLastMax: number; // March rental income vs the last actual month's (October)
  insurancePerUnit: number;                     // 6108 $/unit/yr
  reTaxPct: number;                             // 6116 vs T12
  payrollMin: number; payrollMax: number;       // payroll category vs T12 (raises 3-4% on performing sites)
  spPctCapital: number;                         // SP as a share of capital, a starting point
}
export const DEFAULT_GUIDANCE: BudgetGuidance = {
  incomeMin: 0.03, incomeMax: 0.0325, expenseMin: 0.03, expenseMax: 0.035, spreadMax: 0.005,
  noiMin: 0.025, noiVsCyBudget: true, marchVsLastMin: 0.015, marchVsLastMax: 0.02,
  insurancePerUnit: 275, reTaxPct: 0.03, payrollMin: 0.03, payrollMax: 0.04, spPctCapital: 0.02,
};
export type GuideStatus = 'ok' | 'check' | 'bad' | 'info';
export interface GuideItem { key: string; label: string; value: string; target: string; status: GuideStatus; must?: boolean }
export interface GuideResult {
  growth: { rental: number | null; income: number | null; expense: number | null; noi: number | null; noiVsCy: number | null };
  items: GuideItem[];
  /** rental income (5070) by calendar quarter of the budget, and Q4 vs Q1 */
  quarters: number[]; q4VsQ1: number | null;
  flags: number; bad: number;
}
const g2 = (a: number, b: number | null | undefined): number | null => (b ? (a - b) / Math.abs(b) : null);
const pctTxt = (v: number | null, d = 1): string => { if (v == null) return '—'; const t = (v * 100).toFixed(d); return Number(t) === 0 ? `${(0).toFixed(d)}%` : `${v > 0 ? '+' : ''}${t}%`; };
const rng = (a: number, b: number): string => `${(a * 100).toFixed(a * 1000 % 10 ? 2 : 1)}–${(b * 100).toFixed(b * 1000 % 10 ? 2 : 1)}%`;
/** Budget lines (budget-month order) against the October T12 (calendar), the current-year budget
    (calendar), and the guidance ranges. Pure. */
export function guidanceCheck(a: {
  lines: BudgetLine[]; coaList: CoaAccount[]; t12: Record<string, Months> | null | undefined; cyBudget?: Record<string, Months> | null;
  lastMonth: number; startMonth?: number; units: number; capital: number; guidance?: Partial<BudgetGuidance> | null;
}): GuideResult | null {
  if (!a.t12 || !Object.keys(a.t12).length) return null;
  const G: BudgetGuidance = { ...DEFAULT_GUIDANCE, ...(a.guidance || {}) };
  const start = a.startMonth || 1;
  const bud = rollup(new Map(a.lines.map((l) => [l.gl_code, l.months])));
  const ref = rollup(new Map(Object.entries(a.t12)));
  const T = (m: Map<string, Months>, c: string) => sum(m.get(c) || zero12());
  const rental = g2(T(bud, '5070'), T(ref, '5070'));
  const income = g2(T(bud, '5500'), T(ref, '5500'));
  const expense = g2(T(bud, '7279'), T(ref, '7279'));
  const noi = g2(T(bud, '7280'), T(ref, '7280'));
  const cy = a.cyBudget && Object.keys(a.cyBudget).length ? rollup(new Map(Object.entries(a.cyBudget))) : null;
  const cyNoi = cy ? T(cy, '7280') : null;
  const noiVsCy = cyNoi ? g2(T(bud, '7280'), cyNoi) : null;
  const items: GuideItem[] = [];
  const add = (key: string, label: string, value: string, target: string, status: GuideStatus, must = false) => items.push({ key, label, value, target, status, must });
  const inR = (v: number | null, lo: number, hi: number): GuideStatus => (v == null ? 'info' : v >= lo - 1e-9 && v <= hi + 1e-9 ? 'ok' : 'check');

  // NOI first: the most important of all
  add('noi', 'NOI vs October T12', pctTxt(noi), `${pctTxt(G.noiMin)} or better`, noi == null ? 'info' : noi < 0 ? 'bad' : noi >= G.noiMin - 1e-9 ? 'ok' : 'check', true);
  if (G.noiVsCyBudget && cyNoi) add('noicy', 'NOI vs current (2026) budget', pctTxt(noiVsCy), 'not lower', noiVsCy != null && noiVsCy < -1e-9 ? 'bad' : 'ok', true);
  add('income', 'Total income vs October T12', pctTxt(income), rng(G.incomeMin, G.incomeMax), inR(income, G.incomeMin, G.incomeMax), true);
  add('expense', 'Total expenses vs October T12', pctTxt(expense), rng(G.expenseMin, G.expenseMax), inR(expense, G.expenseMin, G.expenseMax), true);
  if (income != null && expense != null) {
    const spread = expense - income;
    add('spread', 'Expense growth over income growth', `${spread > 0 ? '+' : ''}${(spread * 10000).toFixed(0)} bps`, `at most +${Math.round(G.spreadMax * 10000)} bps`, spread > G.spreadMax + 1e-9 ? 'check' : 'ok', true);
  }
  add('rental', 'Rental income vs October T12', pctTxt(rental), 'Q1 aggressive; no hockey stick', 'info', true);
  // March rental income vs the last actual month's (October)
  const lastRental = (ref.get('5070') || zero12())[a.lastMonth - 1] || 0;
  const iMar = (3 - start + 12) % 12;
  const marRental = (bud.get('5070') || zero12())[iMar] || 0;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (lastRental) {
    const v = g2(marRental, lastRental);
    add('march', `March rental income vs ${MON[a.lastMonth - 1]} actual`, pctTxt(v, 2), rng(G.marchVsLastMin, G.marchVsLastMax), inR(v, G.marchVsLastMin, G.marchVsLastMax), true);
  }
  // specific changes called out
  const line = (gl: string) => a.lines.find((l) => l.gl_code === gl);
  const ins = line('6108');
  if (ins && a.units) {
    const d: any = ins.driver || {};
    const gross = d.allocOut ? d.allocOut.gross : sum(ins.months);
    const perUnit = gross / a.units;
    add('ins', 'Insurance per unit', `$${perUnit.toFixed(2)}${d.allocOut ? ' (before the journal split)' : ''}`, `$${G.insurancePerUnit}`, Math.abs(perUnit - G.insurancePerUnit) <= 1 ? 'ok' : 'check');
  }
  const taxT12 = sum(a.t12['6116'] || zero12());
  if (taxT12) {
    const tl = line('6116'); const d: any = tl?.driver || {};
    const gross = d.allocOut ? d.allocOut.gross : sum(tl?.months || zero12());
    const v = g2(gross, taxT12);
    add('tax', 'RE taxes vs T12', pctTxt(v), `${pctTxt(G.reTaxPct)} unless documented`, v != null && v > G.reTaxPct + 0.0025 ? 'check' : 'ok');
  }
  const pay = (m: Map<string, Months>, ls: { gl: string; months: Months }[]) => ls.reduce((x, l) => { const acc = a.coaList.find((c) => c.code === l.gl); return acc?.pcode === '10' ? x + sum(l.months) : x; }, 0);
  const payB = pay(bud, a.lines.map((l) => ({ gl: l.gl_code, months: l.months })));
  const payT = pay(ref, Object.entries(a.t12).map(([gl, months]) => ({ gl, months })));
  if (payT) {
    const v = g2(payB, payT);
    add('payroll', 'Payroll vs T12', pctTxt(v), `${rng(G.payrollMin, G.payrollMax)} on performing sites; lower where NOI growth is low`, v != null && v > G.payrollMax + 1e-9 ? 'check' : 'ok');
  }
  const sp = T(bud, '7500');
  if (a.capital > 0) add('sp', 'Special projects', `$${Math.round(sp).toLocaleString('en-US')} (${pctTxt(sp / a.capital).replace('+', '')} of capital)`, `about ${pctTxt(G.spPctCapital).replace('+', '')} of capital, with detail`, sp ? 'info' : 'check');
  else add('sp', 'Special projects', `$${Math.round(sp).toLocaleString('en-US')}`, 'proposed spend with detail (no capital on file)', sp ? 'info' : 'check');

  // hockey stick: rental income by calendar quarter of the budget
  const rm = bud.get('5070') || zero12();
  const quarters = [0, 1, 2, 3].map((q) => r2([0, 1, 2].reduce((x, k) => x + (rm[(q * 3 + k - (start - 1) + 12) % 12] || 0), 0)));
  const q4VsQ1 = quarters[0] ? (quarters[3] - quarters[0]) / Math.abs(quarters[0]) : null;
  return {
    growth: { rental, income, expense, noi, noiVsCy },
    items, quarters, q4VsQ1,
    flags: items.filter((i) => i.status === 'check').length,
    bad: items.filter((i) => i.status === 'bad').length,
  };
}

export function generateAnnualLines(coaList: CoaAccount[], inputs: BudgetInputs, src: AnnualSources): BudgetLine[] {
  const lines = new Map<string, BudgetLine>();
  const mk = (gl: string, months: Months, driver: Driver, note = ''): void => {
    lines.set(gl, { gl_code: gl, months: months.map(r2), driver, override: false, note });
  };
  for (const a of coaList) if (a.kind === 'detail') mk(a.code, zero12(), { method: 'manual' });
  // one-time items out of the history first: everything below reads the normalized trailing-12
  const t12Adj = applyT12Adjust(src.actual, inputs.t12Adjust);
  if (Object.keys(t12Adj.byGl).length) src = { ...src, actual: t12Adj.actual };
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
  // RE taxes: a saved formula set recorded 0% only because 0% was the old default, nobody chose it.
  // That 0 does not hold the new 3% default back; a 0 typed on the row / section / category still does.
  const ruleFactor = (gl: string): number | undefined => { const f = ruleOf(gl)?.factor; return gl === '6116' && f === 0 ? undefined : f; };
  const pctFor = (a: CoaAccount): number =>
    bl.glGrowth?.[a.code] ?? bl.secGrowth?.[a.section || ''] ?? userPct[a.pcode || ''] ?? ruleFactor(a.code) ?? TEMPLATE_GL_PCT[a.code] ?? userPct['*'] ?? TEMPLATE_CAT_PCT[a.pcode || ''] ?? TEMPLATE_CAT_PCT['*'] ?? 0;
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
    const fit = sh === 'turns' || sh === 'curve' ? Math.min(1, Math.max(0, bl.glFit?.[a.code] ?? rule?.fit ?? 0)) : 0;
    let months = annualBaseline(cal, { pct, pcts, shape: sh, startMonth, lastMonth, curve: CURVES[a.curve || 'flat'], mult, turns: turnCurve, fit });
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
    // no negative budget months: an expense line is never negative; an income line keeps the side its
    // own total is on (contra lines - concessions, vacancy, write-offs - are negative by nature)
    const noNeg = foldCredits(months, parseInt(a.code, 10) >= 6000 || sum(months) >= 0 ? 1 : -1, mult);
    months = noNeg.months;
    // a "last actual month" line whose last month is far off its own average: one odd
    // month (a tax true-up, a zero) is setting the whole year — flag it for the chip
    let lastDev: number | undefined;
    if (sh === 'last') {
      const avg = baseTotal(a.code) / 12;
      const lastV = cal[lastMonth - 1] || 0;
      if (avg && Math.abs(lastV - avg) > LAST_DEV_WARN * Math.abs(avg)) lastDev = Math.round((lastV / avg - 1) * 1000) / 1000;
    }
    mk(a.code, months, { method: 'baseline', src: baseSrc, pct, shape: sh, mult, base: baseTotal(a.code), ...(pcts ? { pcts } : {}), ...(rule ? { rule: rule.method } : {}), ...(sh === 'turns' ? { turns: exp.reduce((x, y) => x + y, 0) } : {}), ...(fit ? { fit } : {}), ...(lastDev != null ? { lastDev } : {}), ...(drift ? { drift } : {}), ...(noNeg.folded ? { folded: noNeg.folded } : {}) } as any);
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
    // the history the ratios are read from: this property's own, or the one picked to borrow from
    const donor = src.burdenSrc || null;
    const rAct = donor ? donor.actual : src.actual, rBud = donor ? donor.budget : src.budget;
    const t12Ratio = ratioIn(rAct, a.code);
    const budgetRatio = ratioIn(rBud, a.code);
    const ratio = pickRatio(t12Ratio, budgetRatio, (x, y) => (x + y) / 2);
    const t12M = ratiosIn(rAct, a.code), budM = ratiosIn(rBud, a.code);
    if (ratio != null && wagesTotal > 0) {
      const monthly = Array.from({ length: 12 }, (_, c) => pickRatio(t12M?.[c] ?? null, budM?.[c] ?? null, (x, y) => (x + y) / 2) ?? ratio);
      const months = wagesMonthly.map((w, i) => r2(monthly[(startMonth - 1 + i) % 12] * w)) as Months;
      mk(a.code, months, {
        method: 'burdenRatio', ratio: r5(ratio), basis: burdenBasis, sameMonth: true, ratios: monthly.map(r5), ...(donor ? { from: donor.code } : {}),
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
    // the package schedule, when entered: the total from fee x occupied units as leases switch over,
    // split across the reimbursement GLs by the last actual month's mix (else the last-month rule below)
    const sch = inputs.utilities?.feeSchedule;
    const feeGls = detail.filter((a) => a.pcode === '4' && a.code !== '5122' && !isSet(a.code) && (act[a.code] || []).some((v) => v) && lastAct(a.code));
    const lastTot = feeGls.reduce((x, a) => x + lastAct(a.code), 0);
    const fs = sch && feeGls.length && lastTot > 0 ? flatFeeFromSchedule(sch, { lastIncome: lastTot, occLast, units, vacPct: vacPct as Months, leases: src.leases, year: inputs.year, startMonth }) : null;
    if (fs) {
      let left = fs.months.slice() as Months;
      feeGls.forEach((a, k) => {
        const w = lastAct(a.code) / lastTot;
        const m = k === feeGls.length - 1 ? left : fs.months.map((v) => r2(v * w)) as Months;
        if (k < feeGls.length - 1) left = left.map((v, i) => r2(v - m[i])) as Months;
        mk(a.code, m, { method: 'flatFee', schedule: true, F: fs.F, R: fs.R, share: fs.share.map((v) => Math.round(v * 1000) / 1000), weight: Math.round(w * 10000) / 10000, onFlatPct: sch!.onFlatPct, lastMonth } as any);
      });
    }
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

  /* ---- known contracts and recurring costs (inputs.contracts): set the line, or sit on top of its
     formula. Before the fee, so a contracted income line (a commercial lease) is in its basis. ---- */
  const byGlContracts = new Map<string, Contract[]>();
  for (const c of inputs.contracts || []) {
    if (!c || !c.gl || !coaByCode.has(c.gl) || !(Number(c.amount) > 0)) continue;
    if (!byGlContracts.has(c.gl)) byGlContracts.set(c.gl, []);
    byGlContracts.get(c.gl)!.push(c);
  }
  for (const [gl, cs] of byGlContracts) {
    const add = cs.every((c) => c.mode === 'add');
    const tot = zero12();
    const items = cs.map((c) => {
      const m = contractMonths(c, units, startMonth);
      m.forEach((v, i) => { tot[i] = r2(tot[i] + v); });
      return { vendor: c.vendor || '', annual: r2(sum(m)), kind: c.kind };
    });
    const prev = lines.get(gl);
    const months = add && prev ? prev.months.map((v, i) => r2(v + tot[i])) as Months : tot;
    mk(gl, months, { method: 'contract', mode: add ? 'add' : 'replace', items, ...(add && prev ? { base: prev.driver } : {}) } as any);
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

  /* ---- recurring journal split (TPND -> TPNDC): the property keeps (1 - pct) of the engine-built
     lines on the split GLs. Lines built from its own history already post net of the journal. ---- */
  const alloc = allocOutFor(inputs, src.propertyCode);
  if (alloc) {
    for (const gl of alloc.gls) {
      const ln = lines.get(gl);
      const method = (ln?.driver as any)?.method;
      if (!ln || !ALLOC_ENGINE_METHODS.has(method)) continue;
      const gross = sum(ln.months);
      ln.months = ln.months.map((v) => r2(v * (1 - alloc.pct))) as Months;
      ln.driver = { ...(ln.driver as any), allocOut: { to: alloc.to, pct: alloc.pct, gross: r2(gross), out: r2(gross - sum(ln.months)) } } as any;
    }
  }

  // every line whose history had one-time items taken out says how much
  for (const [gl, amt] of Object.entries(t12Adj.byGl)) {
    const ln = lines.get(gl);
    if (ln) ln.driver = { ...(ln.driver as any), oneTime: amt } as any;
  }

  return [...lines.values()];
}

/* ============================================================================
   YEAR-1 PLAN INSIDE THE ANNUAL BUDGET (Troy 2026-11-10: "We made Y1 Budgets for Bismarck and
   Jamestown. We need to incorporate those NOI's so that we have made promised returns by Y1.")
   A new acquisition's Y1 budget is 12 ownership months tied 100% to the UW Year-1 NOI
   (Aug-26..Jul-27 for an August close). Its calendar-year annual budget covers the tail of that
   window (Jan..Jul 2027). For those months every line that feeds NOI takes the Y1 plan's amount,
   so the two budgets never disagree and Year 1 as a whole still lands on the UW NOI. Months after
   Year 1 stay on the annual formulas. Lines below NOI (interest, principal, SP) are untouched.
   A locked (overridden) line is never moved: its difference shows in y1Check as variance.
   ========================================================================== */
export interface Y1Plan { year: number; startMonth: number; lines: { gl_code: string; months: Months }[] }
/** A detail GL that feeds NOI: income 4994-5189, operating expense 6101-7069 (the rollup's ranges). */
export const feedsNoi = (code: string): boolean => { const n = parseInt(code, 10); return Number.isFinite(n) && ((n >= 4994 && n <= 5189) || (n >= 6101 && n <= 7069)); };
const noiSign = (code: string): number => (parseInt(code, 10) < 6000 ? 1 : -1);
/** Calendar-month indexes (0 = Jan) of `calYear` that fall inside the plan's 12 ownership months. */
export function y1MonthsIn(plan: Pick<Y1Plan, 'year' | 'startMonth'>, calYear: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 12; i++) if (calYearOf(plan.year, plan.startMonth, i) === calYear) out.push(calMonthOf(plan.startMonth, i) - 1);
  return out.sort((a, b) => a - b);
}
/** Undo a previous overlay on lines the engine did not rebuild (a GL only the Y1 plan carried): zero
    the plan months and drop the marker. Rebuilt lines never carry the marker; locked lines are left. */
export function clearY1Plan(lines: BudgetLine[]): BudgetLine[] {
  return lines.map((l) => {
    const y1 = (l.driver as Driver).y1; if (!y1 || l.override) return l;
    const m = [...l.months] as Months; for (const i of y1) m[i] = 0;
    const { y1: _drop, ...driver } = l.driver as any;
    return { ...l, months: m, driver };
  });
}
/** Put the Y1 plan's amounts into the months of `calYear` that are still ownership Year 1. */
export function applyY1Plan(lines: BudgetLine[], coaList: CoaAccount[], plan: Y1Plan, calYear: number): BudgetLine[] {
  const idx = y1MonthsIn(plan, calYear); if (!idx.length) return lines;
  const slice = new Map<string, Months>();
  for (const l of plan.lines) if (feedsNoi(l.gl_code)) slice.set(l.gl_code, calendarSlice(l.months, plan.year, plan.startMonth, calYear));
  const coa = new Set(coaList.map((a) => a.code)); const seen = new Set<string>();
  const out = lines.map((l) => {
    seen.add(l.gl_code);
    if (!feedsNoi(l.gl_code) || l.override) return l;
    const s = slice.get(l.gl_code); const m = [...l.months] as Months; let touched = false;
    for (const i of idx) { const v = s ? s[i] : 0; if (v || m[i]) touched = true; m[i] = v; }
    return touched ? { ...l, months: m, driver: { ...(l.driver as any), y1: idx } as Driver } : l;
  });
  for (const [gl, s] of slice) {
    if (seen.has(gl) || !coa.has(gl) || !idx.some((i) => s[i])) continue;
    const m = zero12(); for (const i of idx) m[i] = s[i];
    out.push({ gl_code: gl, months: m, driver: { method: 'manual', y1: idx } as Driver, override: false, note: '' });
  }
  return out;
}
export interface Y1Check {
  /** calendar-month indexes of this budget's year inside ownership Year 1 */
  months: number[];
  /** the Y1 plan's NOI: all 12 ownership months, the part before this calendar year, the part inside it */
  planNoi: number; planBefore: number; planIn: number;
  /** this budget's NOI over the same months, and Year 1 as it now stands (planBefore + budgetIn) */
  budgetIn: number; y1Noi: number;
  uwNoi: number | null;
  /** y1Noi minus the UW Year-1 NOI (minus the plan's NOI when no UW is on file) */
  variance: number;
  /** locked lines that differ from the plan in those months */
  locked: { gl: string; diff: number }[];
}
export function y1Check(lines: BudgetLine[], plan: Y1Plan, calYear: number, uwNoi: number | null): Y1Check {
  const idx = y1MonthsIn(plan, calYear);
  const over = (ls: { gl_code: string; months: Months }[], pick: (m: Months, gl: string) => number) => r2(ls.reduce((a, l) => (feedsNoi(l.gl_code) ? a + noiSign(l.gl_code) * pick(l.months, l.gl_code) : a), 0));
  const planNoi = over(plan.lines, (m) => sum(m));
  const planIn = over(plan.lines, (m) => sum(calendarSlice(m, plan.year, plan.startMonth, calYear)));
  const budgetIn = over(lines, (m) => idx.reduce((a, i) => a + m[i], 0));
  const planBefore = r2(planNoi - planIn); const y1Noi = r2(planBefore + budgetIn);
  const byGl = new Map(plan.lines.map((l) => [l.gl_code, calendarSlice(l.months, plan.year, plan.startMonth, calYear)]));
  const locked = lines.filter((l) => l.override && feedsNoi(l.gl_code)).map((l) => { const s = byGl.get(l.gl_code); return { gl: l.gl_code, diff: r2(idx.reduce((a, i) => a + l.months[i] - (s ? s[i] : 0), 0)) }; }).filter((x) => x.diff);
  return { months: idx, planNoi, planBefore, planIn, budgetIn, y1Noi, uwNoi, variance: r2(y1Noi - (uwNoi ?? planNoi)), locked };
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
