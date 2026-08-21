/* ============================================================================
   nd-budget-tool domain: chart-of-accounts math, budget generation engines,
   UW tie-out. Pure functions only — no DB, no IO — so everything here is
   unit-testable and shared conceptually with the client.

   Money convention: all amounts are dollars (2dp), income positive,
   contra-income (loss to lease, concessions, vacancy, delinquency) negative,
   expenses positive. Matches the Yardi upload CSV and the FHND/PHND workbooks.
   ========================================================================== */

export interface CoaAccount {
  code: string;
  name: string;
  kind: 'detail' | 'header' | 'total';
  section: string;
  pcode: string | null;       // UW category: '1','loss','2'..'14'; null = below-the-line
  csv_order: number | null;   // position in Yardi upload CSV; null = not uploadable
  display_order: number;
  curve: string | null;       // monthly spread curve name
  active: boolean;
}

export type Months = number[]; // always length 12

export interface BudgetLine {
  gl_code: string;
  months: Months;
  driver: Driver;
  override: boolean;
  note: string;
  /** standing MROUND multiple (0/undefined = none) — applied after the
      formula computes, re-applies on every regeneration; NOT a lock */
  round?: number;
}

/** Apply each line's standing MROUND to its months (the final pipeline step —
    ties run first, so rounding drift shows as small honest variance). */
export function applyRounding(lines: BudgetLine[]): BudgetLine[] {
  return lines.map((l) => {
    if (!l.round || l.round <= 0) return l;
    return { ...l, months: l.months.map((v) => r2(Math.round(v / l.round!) * l.round!)) };
  });
}

export type Driver =
  | { method: 'manual' }
  | { method: 'gpr' }
  | { method: 'ltl' }
  | { method: 'vacancy' }
  | { method: 'catShare'; pcode: string; share: number }     // share of a UW-tied category
  | { method: 'perUnitComp'; pcode: string; perUnit: number } // comp $/unit × subject units
  | { method: 'payrollModel' }                                 // property-level wages from the ND payroll model
  | { method: 'burdenRatio'; ratio: number }                   // Minot benefit/bonus ratio × subject wage total
  | { method: 'mgmtPct'; pct: number }
  | { method: 'interest'; loan: number; rate: number }
  | { method: 'sellerUtil' }                                   // seller-statement utility level
  | { method: 'recovery'; pct: number }                        // % of prior-month utility billing
  | { method: 'charges'; codes: string }                       // rent-roll charge codes × 12
  | { method: 'zero' };

/** Everything the generator needs. Stored on budgets.inputs (jsonb). */
export interface BudgetInputs {
  year: number;
  units: number;
  capital: number;            // equity, for CoC
  loan: number;
  rate: number;               // interest rate, e.g. 0.06
  startMonth: number;         // 1..12 — first month the budget is "live" (1 = full year)
  gpr: { baseMonthly: number; growthPct: Months };  // monthly % change, compounding off base
  ltl: {
    /** 'leases' = per-lease burnoff at each lease's turnover month (needs a
        unit-level rent roll); 'ramp' = simple linear ramp fallback. */
    mode?: 'leases' | 'ramp';
    startMonthly: number; targetPct: number; rampMonths: number;   // ramp params
    renewalPct?: number;      // share of expiring leases that renew (default .70)
    burnoffRenew?: number;    // LTL share burned at a renewal (default .50 — "half")
    burnoffNew?: number;      // LTL share burned at a new move-in (default 1.00)
  };
  vacancyPct: Months;         // positive fractions, e.g. 0.05
  concessionPct: number;      // of GPR (positive fraction) — UW-derived
  rentalLossPct: number;      // TOTAL cat-3 % of GPR incl. vacancy — UW-derived
  mgmtPct: number;            // of total income — UW-derived (3% Y1)
  /** absolute UW Year-1 category totals for the abs-tied categories */
  uwAbs: Partial<Record<string, number>>;  // pcodes 4,5,6,8,9,10,11,12,13,14 → annual $
  /** per-category level basis: 'uw' (default — hard tie to uwAbs, comp-weighted)
      or 'perUnit' (each line = comp $/unit × subject units; UW shown as variance) */
  catBasis?: Partial<Record<string, 'uw' | 'perUnit'>>;
  /** NOI must tie 100% to UW: the gap is absorbed by scaling the non-overridden
      lines of the flex categories at (re)generation. Default true. */
  tieNoi?: boolean;
  /** Total Income ties to (prorated) UW EGI at generation — GPR stays on the
      rent roll, loss-to-lease absorbs the gap. Default true. */
  tieIncome?: boolean;
  /** which contra-income GL absorbs the income tie (default 5003 LTL) */
  tieIncomeGl?: string;
  /** categories that flex to absorb the NOI gap (default 9, 11, 13, 14) */
  noiFlexPcodes?: string[];
  /** utilities model: 'seller' = levels from the seller statements with
      recovery-lag income (default when a seller T12 is linked); 'uw' = UW
      allocation like other categories. */
  utilities?: { source?: 'seller' | 'uw'; growthPct?: number; recoveryPct?: number | null };
  /** legacy field from the (removed) stub-proration design — ignored. */
  uwProration?: Record<string, number>;
}

/* ============================================================================
   OWNERSHIP YEAR — a budget IS UW Year 1: 12 months starting at
   inputs.startMonth of inputs.year (Aug 2026 → Jul 2027 for an August close).
   Month index 0 = the start month. The full window ties to UW Y1 100%.
   Calendar-year Yardi uploads are SLICES of this plan (calendarSlice).
   ========================================================================== */

/** ownership month index → calendar month 1-12 */
export const calMonthOf = (startMonth: number, i: number): number => ((startMonth - 1 + i) % 12) + 1;
/** ownership month index → calendar year */
export const calYearOf = (year: number, startMonth: number, i: number): number => year + Math.floor((startMonth - 1 + i) / 12);
/** rotate a Jan-Dec calendar array into ownership-month order */
export const rotate12 = (arr: Months, startMonth: number): Months =>
  arr.map((_, i) => arr[(startMonth - 1 + i) % 12]);
/** "Aug-26" style labels for the 12 ownership months */
export function monthLabels(year: number, startMonth: number): string[] {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return Array.from({ length: 12 }, (_, i) => `${names[calMonthOf(startMonth, i) - 1]}-${String(calYearOf(year, startMonth, i)).slice(2)}`);
}

/* ---------------- utilities from seller statements ---------------- */

/** Seller utility line (from the T12 statement, pcode 4 or 12): name + one
    value per statement column + the calendar month of each column. */
export interface SellerUtilRow { name: string; months: number[]; monthCal: number[]; pcode: string }

/** Seller line name → closest Monarch GL. First keyword match wins. */
export const UTIL_EXPENSE_MAP: [RegExp, string][] = [
  [/electric/i, '6604'], [/gas/i, '6608'], [/water/i, '6622'], [/sewer|storm/i, '6614'],
  [/trash|garbage|waste/i, '6620'], [/phone|telephone|cell/i, '6618'],
  [/internet|cable|wifi/i, '6619'],
];
export const UTIL_INCOME_MAP: [RegExp, string][] = [
  [/water/i, '5174'], [/sewer|storm/i, '5167'], [/trash|valet|garbage|waste/i, '5169'],
  [/gas/i, '5171'], [/electric|vacant/i, '5170'],
];
const UTIL_EXPENSE_FALLBACK = '6665'; // OTHER UTILITY
const UTIL_INCOME_FALLBACK = '5170';  // UTILITIES REIM

/** Utility model per Troy (2026-08-21): expense levels come from the seller's
    actual statements — each seller line lands on its closest Monarch GL at the
    same calendar month × (1+growth). Utility INCOME = recoveryPct × the PRIOR
    month's total utility billing (RUBS bills in arrears), distributed across
    income GLs by the seller's own income mix. recoveryPct null → derived from
    the seller's actual income/expense ratio. */
export function buildUtilityModel(
  rows: SellerUtilRow[], year: number, startMonth: number,
  opts: { growthPct?: number; recoveryPct?: number | null } = {}
): { expense: Record<string, Months>; income: Record<string, Months>; recoveryPct: number; expenseTotal: Months } {
  const growth = 1 + (opts.growthPct ?? 0.03);
  // seller values by calendar month (Jan..Dec), summed onto their Monarch GL
  const calByGl: Record<string, Months> = {};
  const incomeMixByGl: Record<string, number> = {};
  let sellerExpTotal = 0, sellerIncTotal = 0;
  for (const row of rows) {
    const isExp = row.pcode === '12';
    if (!isExp && row.pcode !== '4') continue;
    const map = isExp ? UTIL_EXPENSE_MAP : UTIL_INCOME_MAP;
    let gl = isExp ? UTIL_EXPENSE_FALLBACK : UTIL_INCOME_FALLBACK;
    for (const [re, code] of map) if (re.test(row.name)) { gl = code; break; }
    const cal = zero12();
    row.months.forEach((v, i) => { cal[(row.monthCal[i] || i + 1) - 1] += v || 0; });
    if (isExp) {
      if (!calByGl[gl]) calByGl[gl] = zero12();
      cal.forEach((v, i) => { calByGl[gl][i] = r2(calByGl[gl][i] + v); });
      sellerExpTotal += cal.reduce((a, b) => a + b, 0);
    } else {
      const tot = cal.reduce((a, b) => a + b, 0);
      incomeMixByGl[gl] = (incomeMixByGl[gl] || 0) + Math.abs(tot);
      sellerIncTotal += tot;
    }
  }
  const recoveryPct = opts.recoveryPct ?? (sellerExpTotal > 0 ? Math.round((sellerIncTotal / sellerExpTotal) * 10000) / 10000 : 0);

  // expense: ownership month i = seller's same calendar month × growth
  const expense: Record<string, Months> = {};
  const expenseTotal = zero12();
  const calTotal = zero12();
  for (const [gl, cal] of Object.entries(calByGl)) {
    expense[gl] = zero12();
    for (let i = 0; i < 12; i++) {
      const c = calMonthOf(startMonth, i) - 1;
      expense[gl][i] = r2(Math.max(0, cal[c]) * growth);
      expenseTotal[i] = r2(expenseTotal[i] + expense[gl][i]);
    }
    cal.forEach((v, i) => { calTotal[i] += Math.max(0, v); });
  }
  // income: recovery % of the PRIOR month's billing (month 0 recovers the
  // calendar month before the start, from seller actuals × growth)
  const incomeTot = zero12();
  const priorCal = ((startMonth - 2) + 12) % 12;
  incomeTot[0] = r2(recoveryPct * r2(calTotal[priorCal] * growth));
  for (let i = 1; i < 12; i++) incomeTot[i] = r2(recoveryPct * expenseTotal[i - 1]);
  const mixSum = Object.values(incomeMixByGl).reduce((a, b) => a + b, 0);
  const income: Record<string, Months> = {};
  const mixEntries = mixSum > 0 ? Object.entries(incomeMixByGl) : [[UTIL_INCOME_FALLBACK, 1]] as [string, number][];
  const mixTotal = mixSum > 0 ? mixSum : 1;
  for (const [gl, w] of mixEntries) {
    income[gl] = incomeTot.map((v) => r2((v * w) / mixTotal));
  }
  return { expense, income, recoveryPct, expenseTotal };
}

/* ---------------- other income from rent-roll charge codes ---------------- */

/** Rent-roll charge code → Monarch other-income GL (first match wins). */
export const CHARGE_GL_MAP: [RegExp, string][] = [
  [/pet/i, '5165'], [/garage|park/i, '5160'], [/storage/i, '5136'],
  [/corpfurn|furn/i, '5121'], [/mtm|month/i, '5150'], [/stlp|short/i, '5151'],
];

/** charges: {PETRENT: monthly $, ...} → {gl: monthly $} for mapped codes. */
export function chargeGlMonthly(charges: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, v] of Object.entries(charges || {})) {
    if (!v) continue;
    for (const [re, gl] of CHARGE_GL_MAP) {
      if (re.test(code)) { out[gl] = r2((out[gl] || 0) + v); break; }
    }
  }
  return out;
}

/* ---------------- lease-level loss-to-lease burnoff ---------------- */

/** One lease off the unit-level rent roll: market rent, actual rent, lease end. */
export interface Lease { m: number; r: number; e?: string | null }

/** Monthly LOSS/GAIN TO LEASE (signed, loss negative) from per-lease burnoff:
    a lease's LTL changes only in its turnover month — renewals burn
    `burnoffRenew` of their gap (default half), new move-ins burn `burnoffNew`
    (default all). Which expiring leases renew is chosen by `renewalPct`,
    weighted so the LARGEST-LTL leases renew first (deep discounts renew;
    GTL / low-LTL leases are likelier to leave). Leases already expired or
    month-to-month at the start turn over in month 0; leases ending after the
    window never burn inside it. */
export function ltlMonths(
  leases: Lease[], year: number, startMonth: number,
  opts: { renewalPct?: number; burnoffRenew?: number; burnoffNew?: number } = {}
): Months {
  const renewalPct = opts.renewalPct ?? 0.7;
  const keepRenew = 1 - (opts.burnoffRenew ?? 0.5);
  const keepNew = 1 - (opts.burnoffNew ?? 1);
  const startAbs = year * 12 + (startMonth - 1);
  const items = leases.map((l) => {
    let expM = 0; // no/invalid end date = MTM → turns over in month 0
    if (l.e) {
      // parse the year-month directly — Date('YYYY-MM-DD') is UTC while the
      // getters are local, which shifts month-firsts back a month
      const iso = String(l.e).match(/^(\d{4})-(\d{1,2})/);
      let y = NaN, mo = NaN;
      if (iso) { y = +iso[1]; mo = +iso[2] - 1; }
      else {
        const d = new Date(l.e);
        if (!isNaN(d.getTime())) { y = d.getFullYear(); mo = d.getMonth(); }
      }
      if (!isNaN(y)) {
        const idx = y * 12 + mo - startAbs;
        expM = idx < 0 ? 0 : idx > 11 ? 99 : idx;
      }
    }
    return { ltl: r2((l.m || 0) - (l.r || 0)), expM };  // positive = loss to lease
  });
  const out = zero12();
  for (let m = 0; m < 12; m++) {
    const expiring = items.filter((it) => it.expM === m);
    if (expiring.length) {
      // largest LTL renews first
      expiring.sort((a, b) => b.ltl - a.ltl);
      const nRenew = Math.round(renewalPct * expiring.length);
      expiring.forEach((it, i) => { it.ltl = r2(it.ltl * (i < nRenew ? keepRenew : keepNew)); });
    }
    out[m] = r2(-items.reduce((a, it) => a + it.ltl, 0)) || 0;   // normalize -0
  }
  return out;
}

/** Slice the ownership-year plan into one CALENDAR year's Jan..Dec amounts.
    calYear must be inputs.year (first) or inputs.year+1 (second). */
export function calendarSlice(months: Months, year: number, startMonth: number, calYear: number): Months {
  const out = zero12();
  for (let i = 0; i < 12; i++) {
    if (calYearOf(year, startMonth, i) === calYear) out[calMonthOf(startMonth, i) - 1] = months[i];
  }
  return out;
}

export const PCODES = ['1', 'loss', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14'] as const;
export const PCODE_LABELS: Record<string, string> = {
  '1': 'Gross Potential Rent', loss: 'Loss to Lease', '2': 'Concessions',
  '3': 'Rental Loss (Vacancy etc.)', '4': 'Utility Income', '5': 'Other Income',
  '6': 'Insurance', '7': 'Management Fee', '8': 'RE & PP Taxes',
  '9': 'Admin & Accounting', '10': 'Payroll & Benefits', '11': 'Marketing',
  '12': 'Utilities', '13': 'Repairs & Maintenance', '14': 'Rehab / Reserves',
};
export const INCOME_PCODES = new Set(['1', 'loss', '2', '3', '4', '5']);

/* When a comp set has no usable weights for a category, everything lands on
   one sensible default GL instead of vanishing. */
export const CATEGORY_FALLBACK_GL: Record<string, string> = {
  '2': '5024', '3': '5035', '4': '5170', '5': '5130', '6': '6108', '8': '6116',
  '9': '6365', '10': '6402', '11': '6501', '12': '6620', '13': '6765', '14': '7002',
};

/* Categories whose monthly spread comes from seller-T12 actuals when a T12 is
   linked. 13 (R&M) and 14 (rehab) are deliberately excluded: they mix lines
   with opposite seasonality (snow vs turnover), so per-GL curves stay smarter
   than the category's blended actual shape. */
export const T12_SHAPE_PCODES = new Set(['4', '5', '6', '8', '9', '10', '11', '12']);

export interface T12Row { gl: string; name: string; months: number[]; total: number }

/** Per-category monthly weights (calendar order, Jan..Dec) from seller-T12
    actuals. glToPcode comes from the UW book's coded T12 panel. */
export function t12CategoryShapes(rows: T12Row[], monthCal: number[], glToPcode: Record<string, string>): Record<string, Months> {
  const acc: Record<string, Months> = {};
  for (const row of rows) {
    const p = glToPcode[row.gl];
    if (!p || !T12_SHAPE_PCODES.has(p)) continue;
    if (!acc[p]) acc[p] = zero12();
    row.months.forEach((v, i) => {
      const cal = (monthCal[i] || i + 1) - 1;
      acc[p][cal] += Math.abs(v);
    });
  }
  const out: Record<string, Months> = {};
  for (const [p, m] of Object.entries(acc)) {
    const tot = m.reduce((a, b) => a + b, 0);
    if (tot > 0) out[p] = m.map((v) => v / tot);
  }
  return out;
}

/* ---------------- seasonal spread curves (12 relative weights) ------------ */
export const CURVES: Record<string, Months> = {
  flat:     [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  snow:     [2, 2, 1.5, 0.5, 0, 0, 0, 0, 0, 0.5, 1.5, 2],
  heat:     [1.8, 1.7, 1.4, 1, 0.6, 0.4, 0.3, 0.3, 0.5, 0.9, 1.4, 1.7],
  electric: [1.2, 1.1, 1, 0.9, 0.9, 1.1, 1.2, 1.2, 1, 0.9, 1, 1.1],
  summer:   [0.2, 0.2, 0.5, 1, 1.5, 1.8, 1.8, 1.7, 1.4, 1, 0.5, 0.4],
  turnover: [0.7, 0.7, 0.8, 0.9, 1.1, 1.3, 1.4, 1.4, 1.2, 1, 0.8, 0.7],
};

/* ---------------- small numeric helpers ---------------- */
export const zero12 = (): Months => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
export const r2 = (v: number): number => Math.round(v * 100) / 100;
export const sum = (m: Months): number => r2(m.reduce((a, b) => a + b, 0));
export const addM = (a: Months, b: Months): Months => a.map((v, i) => r2(v + b[i]));
export const daysInMonth = (year: number, m1: number): number => new Date(year, m1, 0).getDate();

/** Spread an annual amount across 12 months by weights, penny-exact (largest remainder). */
export function spreadMonthly(annual: number, weights: Months): Months {
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (!wsum || !annual) return zero12();
  const cents = Math.round(annual * 100);
  const raw = weights.map((w) => (cents * w) / wsum);
  const base = raw.map(Math.floor);
  let rem = cents - base.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rem > 0; k = (k + 1) % 12, rem--) base[order[k].i] += 1;
  for (let k = 0; rem < 0; k = (k + 1) % 12, rem++) base[order[11 - k].i] -= 1;
  return base.map((c) => c / 100);
}

/** Split a total across items by weight, penny-exact. Returns amount per item key. */
export function allocateWeighted(total: number, items: { key: string; weight: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  const ws = items.map((it) => Math.max(0, it.weight));
  const wsum = ws.reduce((a, b) => a + b, 0);
  if (!items.length) return out;
  if (!wsum) { items.forEach((it) => (out[it.key] = 0)); return out; }
  const cents = Math.round(total * 100);
  const raw = ws.map((w) => (cents * w) / wsum);
  const base = raw.map(Math.floor);
  let rem = cents - base.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rem > 0; k = (k + 1) % items.length, rem--) base[order[k].i] += 1;
  for (let k = 0; rem < 0; k = (k + 1) % items.length, rem++) base[order[items.length - 1 - k].i] -= 1;
  items.forEach((it, i) => (out[it.key] = base[i] / 100));
  return out;
}

/* ============================================================================
   ROLLUP — compute every Monarch total row from detail lines.
   Section math mirrors FHNDBudget / the Yardi ysi_cf tree exactly.
   ========================================================================== */
const inRange = (code: string, lo: number, hi: number): boolean => {
  const n = parseInt(code, 10);
  return Number.isFinite(n) && n >= lo && n <= hi;
};

export function rollup(lines: Map<string, Months>): Map<string, Months> {
  const t = new Map<string, Months>();
  const sumRange = (lo: number, hi: number): Months => {
    let acc = zero12();
    for (const [code, m] of lines) if (inRange(code, lo, hi)) acc = addM(acc, m);
    return acc;
  };
  const g = (c: string): Months => t.get(c) || zero12();
  const subM = (a: Months, b: Months): Months => a.map((v, i) => r2(v - b[i]));

  // Ranges start just past each section's header code — header rows can never
  // carry amounts (the FHND workbook had values typed on 5100/7000 header rows;
  // Yardi's own section totals exclude them).
  t.set('5004', sumRange(4994, 5003));
  t.set('5029', sumRange(5018, 5028));
  t.set('5049', sumRange(5031, 5048));
  t.set('5070', addM(addM(g('5004'), g('5029')), g('5049')));
  t.set('5190', sumRange(5101, 5189));
  t.set('5500', addM(g('5070'), g('5190')));
  t.set('6170', sumRange(6101, 6169));
  t.set('6370', sumRange(6301, 6369));
  t.set('6399', sumRange(6374, 6398));
  t.set('6470', sumRange(6401, 6469));
  t.set('6570', sumRange(6501, 6569));
  t.set('6670', sumRange(6601, 6669));
  t.set('6770', sumRange(6701, 6769));
  t.set('6870', sumRange(6801, 6869));
  t.set('6970', sumRange(6901, 6969));
  t.set('7070', sumRange(7001, 7069));
  t.set('7098', addM(addM(g('6770'), g('6870')), addM(g('6970'), g('7070'))));
  t.set('7099', [g('6170'), g('6370'), g('6399'), g('6470'), g('6570'), g('6670'), g('7098')].reduce(addM, zero12()));
  t.set('7279', g('7099'));
  t.set('7280', subM(g('5500'), g('7279')));
  t.set('7315', sumRange(7300, 7314));
  t.set('7500', sumRange(7321, 7499));
  t.set('8200', subM(subM(g('7280'), g('7315')), g('7500')));
  t.set('8602', sumRange(8500, 8601));
  t.set('8950', sumRange(8901, 8949));
  t.set('9000', subM(subM(g('8200'), g('8602')), g('8950')));
  return t;
}

export interface Kpis {
  income: number; expense: number; noi: number; interest: number; sp: number;
  principal: number; cashFlow: number; coc: number | null; cocAfterSP: number | null;
  monthly: { income: Months; expense: Months; noi: Months; cashFlow: Months };
}

export function kpis(lines: Map<string, Months>, capital: number): Kpis {
  const t = rollup(lines);
  const g = (c: string): Months => t.get(c) || zero12();
  let principal = zero12();
  for (const [code, m] of lines) if (inRange(code, 3080, 3091)) principal = addM(principal, m);
  const principalAbs = Math.abs(sum(principal));
  const noi = sum(g('7280'));
  const interest = sum(g('7315'));
  const sp = sum(g('7500'));
  const cashFlow = r2(noi - interest - principalAbs);
  const cfM = g('7280').map((v, i) => r2(v - g('7315')[i] - Math.abs(principal[i])));
  return {
    income: sum(g('5500')), expense: sum(g('7279')), noi, interest, sp,
    principal: principalAbs, cashFlow,
    coc: capital ? r2((cashFlow / capital) * 10000) / 10000 : null,
    cocAfterSP: capital ? r2(((cashFlow - sp) / capital) * 10000) / 10000 : null,
    monthly: { income: g('5500'), expense: g('7279'), noi: g('7280'), cashFlow: cfM },
  };
}

/* ============================================================================
   TIE-OUT — budget rolled to P-code categories vs the UW snapshot.
   ========================================================================== */
export interface UwSnapshotData {
  sheetName?: string;
  units: number;
  y1: Record<string, number>;            // pcode → Year-1 $ (contra negative)
  years?: Record<string, Record<string, number>>; // y2..y6
  egi: number; toe: number; noi: number;
  assumptions: Record<string, number | string>;
  unitMix?: { plan: string; units: number; sqft: number; street: number }[];
  t12?: { gl: string; name: string; total: number; pcode: string }[];
}

export interface TieoutRow { pcode: string; label: string; budget: number; uw: number; variance: number; pct: number | null; }
export interface Tieout { rows: TieoutRow[]; egi: TieoutRow; toe: TieoutRow; noi: TieoutRow; }

export function categoryTotals(lines: BudgetLine[], coa: Map<string, CoaAccount>): Record<string, number> {
  const cat: Record<string, number> = {};
  for (const ln of lines) {
    const acc = coa.get(ln.gl_code);
    if (!acc || acc.kind !== 'detail' || !acc.pcode) continue;
    cat[acc.pcode] = r2((cat[acc.pcode] || 0) + sum(ln.months));
  }
  return cat;
}

export function computeTieout(lines: BudgetLine[], coa: Map<string, CoaAccount>, uw: UwSnapshotData | null): Tieout {
  const cat = categoryTotals(lines, coa);
  const rows: TieoutRow[] = PCODES.map((p) => {
    const budget = cat[p] || 0;
    const uwVal = uw ? (uw.y1[p] || 0) : 0;
    const variance = r2(budget - uwVal);
    return { pcode: p, label: PCODE_LABELS[p], budget, uw: uwVal, variance, pct: uwVal ? r2((variance / Math.abs(uwVal)) * 10000) / 10000 : null };
  });
  const pick = (ps: string[]) => ps.reduce((a, p) => r2(a + (cat[p] || 0)), 0);
  const pickUw = (ps: string[]) => (uw ? ps.reduce((a, p) => r2(a + (uw.y1[p] || 0)), 0) : 0);
  const mk = (label: string, budget: number, uwVal: number): TieoutRow => ({ pcode: label, label, budget, uw: uwVal, variance: r2(budget - uwVal), pct: uwVal ? r2(((budget - uwVal) / Math.abs(uwVal)) * 10000) / 10000 : null });
  const incomeP = ['1', 'loss', '2', '3', '4', '5'];
  const expenseP = ['6', '7', '8', '9', '10', '11', '12', '13', '14'];
  const egi = mk('Effective Gross Income', pick(incomeP), uw ? uw.egi : 0);
  const toe = mk('Total Operating Expenses', pick(expenseP), uw ? uw.toe : 0);
  const noi = mk('Net Operating Income', r2(egi.budget - toe.budget), uw ? uw.noi : 0);
  return { rows, egi, toe, noi };
}

/* ============================================================================
   GENERATION — build all detail lines from inputs + UW + comp weights.
   ========================================================================== */
export interface CompWeights {
  /** gl code → SIGNED annual $ across the comp set (weights take abs of this). */
  byGl: Record<string, number>;
  /** gl code → normalized monthly weights (12 Month Budget uploads only). */
  glShapes?: Record<string, Months>;
  /** total units across the comp set — enables the per-unit basis. */
  units?: number;
}

/** Default inputs derived from a UW snapshot (+ rent roll when available). */
export function defaultInputs(year: number, uw: UwSnapshotData, rent: { marketMonthly: number; inPlaceMonthly: number } | null): BudgetInputs {
  const gpr1 = uw.y1['1'] || 0;
  const pctOf = (p: string) => (gpr1 ? Math.abs(uw.y1[p] || 0) / gpr1 : 0);
  const baseMonthly = rent ? rent.marketMonthly : r2(gpr1 / 12);
  const startLtl = rent ? -Math.max(0, r2(rent.marketMonthly - rent.inPlaceMonthly)) : -r2((Math.abs(uw.y1['loss'] || 0)) / 12);
  const ltlDefaults = { mode: 'leases' as const, renewalPct: 0.7, burnoffRenew: 0.5, burnoffNew: 1 };
  // financing from the UW book: loan + rate drive interest; equity estimate
  // = price − loan via LTV (closing costs excluded — user refines capital)
  const loan = Number(uw.assumptions['loanAmount']) || 0;
  const rate = Number(uw.assumptions['interestRate']) || 0.06;
  const ltv = Number(uw.assumptions['ltv']) || 0;
  const capital = loan && ltv ? r2(loan / ltv - loan) : 0;
  const vac = Number(uw.assumptions['vacancyPct']) || 0.05;
  const uwAbs: Partial<Record<string, number>> = {};
  for (const p of ['4', '5', '6', '8', '9', '10', '11', '12', '13', '14']) uwAbs[p] = r2(uw.y1[p] || 0);
  const egi = uw.egi || 1;
  return {
    // tieIncome defaults OFF: LTL is purely mechanical (rent-roll burnoff) and
    // income variance stays visible until Troy places it via the chooser
    year, units: uw.units, capital, loan, rate, startMonth: 1, tieNoi: true, tieIncome: false,
    gpr: { baseMonthly, growthPct: zero12() },
    ltl: { ...ltlDefaults, startMonthly: startLtl, targetPct: pctOf('loss'), rampMonths: 12 },
    vacancyPct: Array(12).fill(vac) as Months,
    concessionPct: pctOf('2'),
    rentalLossPct: pctOf('3'),
    mgmtPct: (uw.y1['7'] || 0) / egi,
    utilities: { source: 'seller', growthPct: 0.03, recoveryPct: null },
    uwAbs,
  };
}

/** Weights for detail GLs of one category, from a comp set (abs $), with fallback. */
function categoryItems(pcode: string, coa: CoaAccount[], comps: CompWeights | null, exclude?: Set<string>): { key: string; weight: number }[] {
  const members = coa.filter((a) => a.kind === 'detail' && a.pcode === pcode && a.csv_order != null && !(exclude?.has(a.code)));
  // byGl is signed — weights are magnitudes
  let items = members.map((a) => ({ key: a.code, weight: comps ? Math.abs(comps.byGl[a.code] || 0) : 0 }));
  if (!items.some((it) => it.weight > 0)) {
    const fb = CATEGORY_FALLBACK_GL[pcode];
    items = members.map((a) => ({ key: a.code, weight: a.code === fb ? 1 : 0 }));
    if (!items.some((it) => it.weight > 0) && items.length) items[0].weight = 1;
  }
  return items;
}

export function generateLines(coaList: CoaAccount[], inputs: BudgetInputs, uw: UwSnapshotData | null, comps: CompWeights | null, catShapes?: Record<string, Months> | null, payrollWages?: Record<string, number> | null, leases?: Lease[] | null, sellerUtil?: SellerUtilRow[] | null, charges?: Record<string, number> | null): BudgetLine[] {
  /* THE 12 MONTHS ARE THE OWNERSHIP YEAR (UW Year 1): index 0 = the start
     month of inputs.year, wrapping into the next calendar year. Seasonal
     calendar shapes are rotated into ownership order. The whole window ties
     to UW Y1 in full — no proration, ever. */
  const lines = new Map<string, BudgetLine>();
  const mk = (gl: string, months: Months, driver: Driver, note = ''): void => {
    lines.set(gl, { gl_code: gl, months: months.map(r2), driver, override: false, note });
  };
  // start every uploadable detail GL at zero/manual
  for (const a of coaList) if (a.kind === 'detail') mk(a.code, zero12(), { method: 'manual' });

  const startMonth = inputs.startMonth || 1;

  /* ---- income ---- */
  const gpr = zero12();
  let cum = inputs.gpr.baseMonthly;
  for (let i = 0; i < 12; i++) {
    cum = i === 0 ? inputs.gpr.baseMonthly * (1 + (inputs.gpr.growthPct[0] || 0)) : cum * (1 + (inputs.gpr.growthPct[i] || 0));
    gpr[i] = r2(cum);
  }
  mk('4994', gpr, { method: 'gpr' });

  const gprAnnual = sum(gpr);

  // Loss to lease is ALWAYS rent-roll anchored: per-lease burnoff when a
  // unit-level roll is linked; otherwise a uniform-expiry burnoff of the
  // actual market-vs-in-place gap (1/12 of leases turn each month, renewals
  // burn burnoffRenew, move-ins burn burnoffNew). 'ramp' keeps the legacy
  // linear ramp to a % of GPR.
  if (inputs.ltl.mode !== 'ramp' && leases && leases.length) {
    mk('5003', ltlMonths(leases, inputs.year, startMonth, inputs.ltl), { method: 'ltl' });
  } else if (inputs.ltl.mode !== 'ramp') {
    const rp = inputs.ltl.renewalPct ?? 0.7;
    const blend = rp * (inputs.ltl.burnoffRenew ?? 0.5) + (1 - rp) * (inputs.ltl.burnoffNew ?? 1);
    const g0 = Math.abs(inputs.ltl.startMonthly || 0);   // starting gap from the rent roll
    const ltl = zero12();
    for (let i = 0; i < 12; i++) ltl[i] = -r2(Math.max(0, g0 * (1 - (blend * (i + 1)) / 12)));
    mk('5003', ltl, { method: 'ltl' });
  } else {
    const ltl = zero12();
    for (let i = 0; i < 12; i++) {
      const t = inputs.ltl.rampMonths > 1 ? Math.min(1, i / (inputs.ltl.rampMonths - 1)) : 1;
      const target = -inputs.ltl.targetPct * gpr[i];
      ltl[i] = r2(inputs.ltl.startMonthly + (target - inputs.ltl.startMonthly) * t);
    }
    mk('5003', ltl, { method: 'ltl' });
  }

  // Concessions: UW % of budget GPR, split across cat-2 GLs by comp weights
  const concTotal = -r2(inputs.concessionPct * gprAnnual);
  const concAlloc = allocateWeighted(concTotal, categoryItems('2', coaList, comps));
  for (const [gl, amt] of Object.entries(concAlloc)) {
    if (!amt) continue;
    mk(gl, spreadMonthly(amt, gpr.map((v) => (v > 0 ? v : 0))), { method: 'catShare', pcode: '2', share: concTotal ? amt / concTotal : 0 });
  }

  // Rental loss: vacancy is its own driver; the rest of the UW cat-3 % goes to bad debt GLs
  const vac = gpr.map((v, i) => -r2((inputs.vacancyPct[i] || 0) * v));
  mk('5031', vac, { method: 'vacancy' });
  const cat3Total = -r2(inputs.rentalLossPct * gprAnnual);
  const rest3 = r2(cat3Total - sum(vac));
  if (rest3 < 0) {
    const items = categoryItems('3', coaList, comps).filter((it) => it.key !== '5031');
    const alloc = allocateWeighted(rest3, items);
    for (const [gl, amt] of Object.entries(alloc)) {
      if (!amt) continue;
      mk(gl, spreadMonthly(amt, gpr.map((v) => (v > 0 ? v : 0))), { method: 'catShare', pcode: '3', share: rest3 ? amt / rest3 : 0 });
    }
  }

  /* ---- absolute categories (income 4 & 5, expenses 6, 8..14 minus specials) ----
     Basis per category: 'uw' = hard tie to the UW total, comp-weighted across GLs;
     'perUnit' = each GL at comp $/unit × subject units (UW becomes a variance). */
  const curveOf = (a: CoaAccount): Months => CURVES[a.curve || 'flat'] || CURVES.flat;
  const coaByCode = new Map(coaList.map((a) => [a.code, a]));
  // shapes are Jan-Dec calendar arrays → rotate into ownership-month order
  const shapeFor = (gl: string, p: string): Months => {
    const glShape = comps?.glShapes?.[gl];
    if (glShape && glShape.some((v) => v > 0)) return rotate12(glShape, startMonth);
    if (catShapes && T12_SHAPE_PCODES.has(p) && catShapes[p]) return rotate12(catShapes[p], startMonth);
    return rotate12(curveOf(coaByCode.get(gl)!), startMonth);
  };

  // Payroll model (category 10 only): wage GLs come straight from the regional
  // payroll model's property-level aggregates; the rest of the category (taxes,
  // benefits, fees) still follows the basis. Wage $ never comes from comps/UW.
  const modelWageGls = new Set(Object.keys(payrollWages || {}));
  let wagesTotal = 0;
  if (payrollWages) {
    for (const [gl, annual] of Object.entries(payrollWages)) {
      if (!annual) continue;
      wagesTotal = r2(wagesTotal + annual);
      mk(gl, spreadMonthly(r2(annual), rotate12((comps?.glShapes?.[gl]) || CURVES.flat, startMonth)),
        { method: 'payrollModel' } as any);
    }
  }

  /* Payroll benefits/bonuses (Troy's rule): every non-wage cat-10 GL follows
     Minot's ratio to wages — (comp GL $ / comp wage $) × subject wage total.
     Cat 10 is therefore NOT UW-tied when a payroll model + comps are linked;
     the NOI tie (below) absorbs the difference. */
  const WAGE_GLS = ['6402', '6404', '6405', '6407'];
  let cat10Done = false;
  if (payrollWages && comps) {
    const compWages = WAGE_GLS.reduce((a, g) => a + Math.abs(comps.byGl[g] || 0), 0);
    if (compWages > 0) {
      cat10Done = true;
      const members = coaList.filter((a) => a.kind === 'detail' && a.pcode === '10' && a.csv_order != null && !modelWageGls.has(a.code));
      for (const a of members) {
        const ratio = Math.abs(comps.byGl[a.code] || 0) / compWages;
        const annual = r2(ratio * wagesTotal);
        if (!annual) continue;
        mk(a.code, spreadMonthly(annual, shapeFor(a.code, '10')), { method: 'burdenRatio', ratio: Math.round(ratio * 100000) / 100000 } as any);
      }
    }
  }

  /* Utilities (Troy 2026-08-21): expense levels from the seller statements,
     each seller line on its closest Monarch GL; utility income = recovery % of
     the PRIOR month's billing. Cats 4 & 12 skip the UW allocation when active
     (UW stays visible as tie-out variance; the NOI tie absorbs). */
  let utilDone = false;
  if (inputs.utilities?.source !== 'uw' && sellerUtil && sellerUtil.length) {
    const model = buildUtilityModel(sellerUtil, inputs.year, startMonth, {
      growthPct: inputs.utilities?.growthPct ?? 0.03,
      recoveryPct: inputs.utilities?.recoveryPct ?? null,
    });
    if (Object.keys(model.expense).length) {
      utilDone = true;
      for (const [gl, months] of Object.entries(model.expense)) {
        if (coaByCode.has(gl)) mk(gl, months, { method: 'sellerUtil' } as any);
      }
      for (const [gl, months] of Object.entries(model.income)) {
        if (coaByCode.has(gl)) mk(gl, months, { method: 'recovery', pct: model.recoveryPct } as any);
      }
    }
  }

  /* Other income from actual rent-roll charges (pet rent, garage, parking,
     storage…): those GLs take charge × 12; the rest of cat 5 still follows
     its basis on the remaining target. */
  const chargeGls = charges ? chargeGlMonthly(charges) : {};
  let chargesTotal = 0;
  for (const [gl, monthly] of Object.entries(chargeGls)) {
    if (!coaByCode.has(gl)) continue;
    chargesTotal = r2(chargesTotal + monthly * 12);
    mk(gl, Array(12).fill(r2(monthly)) as Months, { method: 'charges', codes: gl } as any);
  }
  const chargeGlSet = new Set(Object.keys(chargeGls));

  for (const p of ['4', '5', '6', '8', '9', '10', '11', '12', '13', '14']) {
    if (p === '10' && cat10Done) continue;
    if ((p === '4' || p === '12') && utilDone) continue;
    const skipGls = p === '10' ? modelWageGls : p === '5' ? chargeGlSet : new Set<string>();
    const basis = inputs.catBasis?.[p] === 'perUnit' && comps?.units && inputs.units ? 'perUnit' : 'uw';
    if (basis === 'perUnit') {
      const members = coaList.filter((a) => a.kind === 'detail' && a.pcode === p && a.csv_order != null && !skipGls.has(a.code));
      for (const a of members) {
        const compVal = comps!.byGl[a.code] || 0;
        if (!compVal) continue;
        const annual = r2((compVal / comps!.units!) * inputs.units);
        if (!annual) continue;
        mk(a.code, spreadMonthly(annual, shapeFor(a.code, p)),
          { method: 'perUnitComp', pcode: p, perUnit: r2(compVal / comps!.units!) } as any);
      }
      continue;
    }
    let target = r2(inputs.uwAbs[p] || 0);
    if (p === '10' && payrollWages) target = Math.max(0, r2(target - wagesTotal)); // remainder after model wages
    if (p === '5' && chargesTotal) target = Math.max(0, r2(target - chargesTotal)); // remainder after charge-driven GLs
    if (!target) continue;
    const items = categoryItems(p, coaList, comps, skipGls);
    const alloc = allocateWeighted(target, items);
    for (const [gl, amt] of Object.entries(alloc)) {
      if (!amt) continue;
      mk(gl, spreadMonthly(amt, shapeFor(gl, p)), { method: 'catShare', pcode: p, share: target ? amt / target : 0 });
    }
  }

  /* ---- management fee: % of total income, monthly ---- */
  const linesMonths = new Map<string, Months>();
  for (const [gl, ln] of lines) linesMonths.set(gl, ln.months);
  const totalIncome = rollup(linesMonths).get('5500') || zero12();
  mk('6112', totalIncome.map((v) => r2(v * inputs.mgmtPct)), { method: 'mgmtPct', pct: inputs.mgmtPct });

  /* ---- interest: loan × rate / 360 × days (ownership months, calendar-aware) ---- */
  if (inputs.loan && inputs.rate) {
    const int = zero12();
    for (let i = 0; i < 12; i++) {
      int[i] = r2((inputs.loan * inputs.rate / 360) * daysInMonth(calYearOf(inputs.year, startMonth, i), calMonthOf(startMonth, i)));
    }
    mk('7300', int, { method: 'interest', loan: inputs.loan, rate: inputs.rate });
  }

  return [...lines.values()];
}

/** Re-generate all non-overridden lines; keep overrides untouched. */
export function regenerate(existing: BudgetLine[], coaList: CoaAccount[], inputs: BudgetInputs, uw: UwSnapshotData | null, comps: CompWeights | null, catShapes?: Record<string, Months> | null, payrollWages?: Record<string, number> | null, leases?: Lease[] | null, sellerUtil?: SellerUtilRow[] | null, charges?: Record<string, number> | null): BudgetLine[] {
  const fresh = new Map(generateLines(coaList, inputs, uw, comps, catShapes, payrollWages, leases, sellerUtil, charges).map((l) => [l.gl_code, l]));
  const out: BudgetLine[] = [];
  const seen = new Set<string>();
  for (const old of existing) {
    seen.add(old.gl_code);
    if (old.override) { out.push(old); continue; }
    const f = fresh.get(old.gl_code);
    out.push(f ? { ...f, note: old.note, round: old.round } : old);   // standing round survives
  }
  for (const [gl, f] of fresh) if (!seen.has(gl)) out.push(f);
  return out;
}

/** GLs that may absorb the income tie — contra-income lines by nature. */
export const INCOME_ABSORB_GLS = ['5003', '5031', '5035', '5036', '5040', '5020', '5021'];

/** Tie Total Income to UW Y1 EGI by adjusting ONE absorber line (Troy picks
    which — default loss-to-lease; vacancy, delinquency, write-offs and
    concessions are the alternatives). GPR stays anchored to the rent roll.
    When the absorber already has a modeled shape it is SCALED so the pattern
    survives; otherwise the gap is spread ∝ GPR. Skipped if it's overridden. */
export function tieIncomeToUw(lines: BudgetLine[], coa: Map<string, CoaAccount>, targetEgi: number, absorbGl = '5003'): BudgetLine[] {
  const line = lines.find((l) => l.gl_code === absorbGl);
  if (!line || line.override) return lines;
  const monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
  const income = sum(rollup(monthsMap).get('5500') || zero12());
  const gap = r2(targetEgi - income);
  if (Math.abs(gap) < 0.01) return lines;
  let newMonths: Months | null = null;
  const cur = sum(line.months);
  const newSum = r2(cur + gap);
  if (cur !== 0 && cur * newSum > 0) {
    // proportional rescale keeps the line's monthly pattern
    const f = newSum / cur;
    newMonths = line.months.map((v) => r2(v * f));
    const drift = r2(newSum - sum(newMonths));
    if (drift !== 0) {
      let idx = 11;
      for (let i = 11; i >= 0; i--) if (newMonths[i] !== 0) { idx = i; break; }
      newMonths[idx] = r2(newMonths[idx] + drift);
    }
  } else {
    const gpr = lines.find((l) => l.gl_code === '4994')?.months || zero12();
    const weights = gpr.map((v) => Math.max(0, v));
    if (!weights.some((w) => w > 0)) return lines;
    const adj = spreadMonthly(gap, weights);
    newMonths = line.months.map((v, i) => r2(v + adj[i]));
  }
  // absorbers are contra-income lines — never let a tie fabricate positive
  // income on them; an unabsorbable remainder stays as visible variance
  newMonths = newMonths.map((v) => Math.min(0, v));
  return lines.map((l) => (l.gl_code === absorbGl ? { ...l, months: newMonths! } : l));
}

export const DEFAULT_NOI_FLEX = ['9', '11', '13', '14'];

/** Force NOI to equal the UW NOI exactly by scaling the non-overridden lines of
    the flex categories. Overrides and every other category stay untouched; the
    scaled flex total gets a penny-fix so the tie is exact. If the gap exceeds
    the whole flex pool, flex is floored at zero and a residual variance remains. */
export function tieNoiToUw(lines: BudgetLine[], coa: Map<string, CoaAccount>, uwNoi: number, flexPcodes: string[] = DEFAULT_NOI_FLEX): BudgetLine[] {
  const monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
  const noi = sum(rollup(monthsMap).get('7280') || zero12());
  const gap = r2(uwNoi - noi);            // positive → lower expenses to raise NOI
  if (Math.abs(gap) < 0.01) return lines;
  const flex = lines.filter((l) => {
    const a = coa.get(l.gl_code);
    return a?.kind === 'detail' && a.pcode != null && flexPcodes.includes(a.pcode) && !l.override && sum(l.months) !== 0;
  });
  const flexSum = flex.reduce((a, l) => r2(a + sum(l.months)), 0);
  if (flexSum <= 0) return lines;
  const targetFlex = Math.max(0, r2(flexSum - gap));
  const f = targetFlex / flexSum;
  const scaled = new Map<string, Months>(flex.map((l) => [l.gl_code, l.months.map((v) => r2(v * f))]));
  let newSum = 0;
  for (const m of scaled.values()) newSum = r2(newSum + sum(m));
  const drift = r2(targetFlex - newSum);
  if (drift !== 0 && flex.length) {
    const host = flex.reduce((a, b) => (Math.abs(sum(scaled.get(a.gl_code)!)) >= Math.abs(sum(scaled.get(b.gl_code)!)) ? a : b));
    const m = scaled.get(host.gl_code)!.slice();
    let idx = 11;
    for (let i = 11; i >= 0; i--) if (m[i] !== 0) { idx = i; break; }
    m[idx] = r2(m[idx] + drift);
    scaled.set(host.gl_code, m);
  }
  return lines.map((l) => (scaled.has(l.gl_code) ? { ...l, months: scaled.get(l.gl_code)!, driver: l.driver } : l));
}

/** Scale the non-overridden lines of one category so its annual total hits `target`. */
export function rebalanceCategory(lines: BudgetLine[], coa: Map<string, CoaAccount>, pcode: string, target: number): BudgetLine[] {
  const members = lines.filter((l) => coa.get(l.gl_code)?.pcode === pcode && coa.get(l.gl_code)?.kind === 'detail');
  const fixed = members.filter((l) => l.override);
  const free = members.filter((l) => !l.override);
  const fixedSum = fixed.reduce((a, l) => r2(a + sum(l.months)), 0);
  const freeSum = free.reduce((a, l) => r2(a + sum(l.months)), 0);
  const want = r2(target - fixedSum);
  if (!free.length) return lines;
  const scaled = new Map<string, Months>();
  if (freeSum) {
    const f = want / freeSum;
    for (const l of free) scaled.set(l.gl_code, l.months.map((v) => r2(v * f)));
  } else {
    // nothing to scale from — dump the whole remainder on the fallback GL, flat
    const fb = CATEGORY_FALLBACK_GL[pcode] || free[0].gl_code;
    const host = free.find((l) => l.gl_code === fb) || free[0];
    scaled.set(host.gl_code, spreadMonthly(want, CURVES.flat));
  }
  // penny-fix: adjust the largest free line's last nonzero month so the category ties exactly
  let after = fixedSum;
  for (const l of free) after = r2(after + sum(scaled.get(l.gl_code) || l.months));
  let drift = r2(target - after);
  if (drift !== 0 && free.length) {
    const host = free.reduce((a, b) => (Math.abs(sum(scaled.get(a.gl_code) || a.months)) >= Math.abs(sum(scaled.get(b.gl_code) || b.months)) ? a : b));
    const m = (scaled.get(host.gl_code) || host.months).slice();
    let idx = 11;
    for (let i = 11; i >= 0; i--) if (m[i] !== 0) { idx = i; break; }
    m[idx] = r2(m[idx] + drift);
    scaled.set(host.gl_code, m);
  }
  return lines.map((l) => (scaled.has(l.gl_code) ? { ...l, months: scaled.get(l.gl_code)! } : l));
}
