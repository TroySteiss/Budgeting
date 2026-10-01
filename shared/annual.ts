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
  zero12, r2, sum, rollup, spreadMonthly, rotate12, CURVES, WAGE_GLS, ltlMonths, chargeGlMonthly,
  mergeFresh, overriddenWages, calMonthOf, calYearOf, daysInMonth,
} from './domain.js';

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
  let best = -1, bestCal = 10;
  stmt.monthCal.forEach((m, i) => {
    const key = (stmt.monthYear?.[i] || 0) * 12 + m;
    if (key > best) { best = key; bestCal = m; }
  });
  return bestCal;
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
  softwareFixedMo: number | null;                       // "Fixed Budgeted Cost $275/month" (6331)
}

/* ---------------- template rules ---------------- */

/** Corporate per-unit / flat monthly rates (the 2026 template's constants). */
export const CORP_RATES: Record<string, { perUnitYr?: number; flatMo?: number; label: string }> = {
  '6108': { perUnitYr: 285, label: 'Insurance — corporate $285/unit/yr' },
  '6310': { perUnitYr: r2(9.18 + 16.55 + 11.17 + 6.24), flatMo: 390 + 93, label: 'IT $390/mo + $93/mo + $43.14/unit/yr corporate allocations' },
  '6320': { perUnitYr: 7.86, label: 'Legal department $7.86/unit/yr' },
  '6560': { perUnitYr: r2(18.87 + 5.89), label: 'Marketing salary allocations $24.76/unit/yr' },
};
/** "Default is October actuals": the last actual month, flat for 12. */
export const LAST_MONTH_FLAT_GLS = new Set(['4995', '4996', '5018', '5020', '5021', '5023', '5024', '5025', '5028', '5032', '5033', '5034', '5040', '6104', '6116', '6601', '6602', '6616', '6617', '6618', '6619', '6630']);
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
export function annualBaseline(cal: Months, opts: { pct?: number; pcts?: Months | null; shape: BaselineShape; startMonth?: number; lastMonth?: number; curve?: Months | null; mult?: number }): Months {
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
    case 'last': m = cal.map((_, c) => cal[last] * g(c)) as Months; break;
    case 'avgnz': { const nz = cal.filter((v) => v); const avg = nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0; m = cal.map((_, c) => avg * g(c)) as Months; break; }
    default: m = cal.map((v, c) => v * g(c)) as Months;
  }
  m = rotate12(m, start);
  const mult = opts.mult || 0;
  return m.map((v) => (mult > 0 ? Math.round(v / mult) * mult : r2(v))) as Months;
}

/** Lease expirations per calendar month from unit-level leases: expired /
    month-to-month leases count in month 0 (they turn right away). */
export function expirationsFromLeases(leases: Lease[], year: number): Months {
  const out = zero12();
  for (const l of leases) {
    let idx = 0;
    if (l.e) {
      const iso = String(l.e).match(/^(\d{4})-(\d{1,2})/);
      let y = NaN, mo = NaN;
      if (iso) { y = +iso[1]; mo = +iso[2] - 1; } else { const d = new Date(l.e); if (!isNaN(d.getTime())) { y = d.getFullYear(); mo = d.getMonth(); } }
      if (!isNaN(y)) { const k = (y - year) * 12 + mo; idx = k < 0 ? 0 : k > 11 ? -1 : k; }
    }
    if (idx >= 0) out[idx]++;
  }
  return out;
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
export interface AnnualRule { method: 'same' | 'wavg' | 'flatT12' | 'last' | 'engine' | 'corpRate' | 'suggested' | 'debt' | 'payroll' | 'fixedAnnual'; mround?: number; factor?: number; noThreshold?: boolean; name?: string }
const RULE_SHAPE: Partial<Record<AnnualRule['method'], BaselineShape>> = { same: 'actual', wavg: 'wavg', flatT12: 'flat', last: 'last' };

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
  leases?: Lease[] | null;
  charges?: Record<string, number> | null;
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

  const bl = { ...DEFAULT_BASELINE, ...(inputs.baseline || {}), growthPct: { ...TEMPLATE_CAT_PCT, ...(inputs.baseline?.growthPct || {}) } };
  const useBudget = bl.source === 'budget' && !!src.budget && Object.keys(src.budget).length > 0;
  const base: Record<string, Months> = useBudget ? src.budget! : (src.actual || {});
  const baseSrc: 'actual' | 'budget' = useBudget ? 'budget' : 'actual';
  const baseTotal = (gl: string): number => sum(base[gl] || zero12());
  const lastOf = (gl: string): number => (base[gl] || zero12())[lastMonth - 1] || 0;
  const rules = src.rules || {};
  const ruleOf = (gl: string): AnnualRule | null => { const r = rules[gl]; return r && RULE_SHAPE[r.method] ? r : null; };
  const pctFor = (a: CoaAccount): number =>
    bl.glGrowth?.[a.code] ?? ruleOf(a.code)?.factor ?? TEMPLATE_GL_PCT[a.code] ?? bl.growthPct?.[a.pcode || ''] ?? bl.growthPct?.['*'] ?? 0;
  const isSet = (gl: string): boolean => (lines.get(gl)?.driver as any)?.method !== 'manual';
  /** statement line × factor on a shape; false when the property has no history on the GL.
      Precedence: the budget's own per-GL overrides → the GL's foundation rule
      (GRKS draft) → the built-in template rules → the budget-wide defaults. */
  const baseline = (a: CoaAccount, shape?: BaselineShape, pctOverride?: number): boolean => {
    const cal = base[a.code];
    if (!cal || !cal.some((v) => v)) return false;
    const rule = ruleOf(a.code);
    const pct = pctOverride ?? pctFor(a);
    // Conservice utility forecast: per-month % for the GL — opt-in (the GRKS
    // foundation used a flat factor); never when the GL has its own factor
    const fc = tpl?.utilForecast?.[a.code];
    const pcts = bl.useUtilForecast && fc && fc.some((v) => v) && bl.glGrowth?.[a.code] == null ? fc : null;
    const ruleShape = rule ? RULE_SHAPE[rule.method] : undefined;
    const sh: BaselineShape = bl.glShape?.[a.code] ?? shape ?? ruleShape ?? (LAST_MONTH_FLAT_GLS.has(a.code) ? 'last' : FLAT_T12_GLS.has(a.code) ? 'flat' : AVG_NZ_GLS.has(a.code) ? 'avgnz' : bl.shape);
    // T12/12 flat only when the trailing-12 exceeds $1,000 (RMC's IF(T12>1000, …, 0))
    const threshold = sh === 'flat' && !shape && (rule ? rule.method === 'flatT12' && !rule.noThreshold : FLAT_T12_GLS.has(a.code));
    if (threshold && Math.abs(baseTotal(a.code)) <= 1000) return false;
    const mult = bl.glMround?.[a.code] ?? (bl.mround || rule?.mround || 0);
    let months = annualBaseline(cal, { pct, pcts, shape: sh, startMonth, lastMonth, curve: CURVES[a.curve || 'flat'], mult });
    if (rule?.method === 'wavg' && sh === 'wavg' && !bl.glShape?.[a.code] && startMonth === 1) {
      // RMC's Excel weighted average can't wrap the year: January and December
      // fall back to the plain same-month × factor, MROUND $10 (the GRKS cells)
      const edge = (c: number) => { const v = cal[c] * (1 + pct); return r2(Math.round(v / 10) * 10); };
      months = [edge(0), ...months.slice(1, 11), edge(11)] as Months;
    }
    mk(a.code, months, { method: 'baseline', src: baseSrc, pct, shape: sh, mult, base: baseTotal(a.code), ...(pcts ? { pcts } : {}), ...(rule ? { rule: rule.method } : {}) });
    return true;
  };

  /* ---- GPR: rent roll market rents (Troy) or the last actual month (template) × monthly % changes ---- */
  const gprBase = inputs.gpr?.baseMonthly > 0 ? inputs.gpr.baseMonthly : lastOf('4994');
  const gpr = zero12();
  if (gprBase > 0) {
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
  const exp: Months = (inputs.expirations && inputs.expirations.some((v) => v) ? inputs.expirations
    : tpl?.leaseExpirations?.some((v) => v) ? tpl.leaseExpirations
    : src.leases?.length ? expirationsFromLeases(src.leases, inputs.year) : zero12()) as Months;
  const renew = inputs.ltl?.renewalPct ?? tpl?.renewalPct ?? 0.65;
  const turns = exp.map((e) => r2(e * (1 - renew)));
  const turnsTotal = turns.reduce((a, b) => a + b, 0);

  /* ---- loss to lease ---- */
  const ltl = inputs.ltl || ({} as BudgetInputs['ltl']);
  const followGpr = ltl.followGpr !== false;
  if (ltl.mode === 'ramp') {
    const out = zero12();
    for (let i = 0; i < 12; i++) {
      const t = (ltl.rampMonths || 12) > 1 ? Math.min(1, i / ((ltl.rampMonths || 12) - 1)) : 1;
      out[i] = r2((ltl.startMonthly || 0) + (-(ltl.targetPct || 0) * gpr[i] - (ltl.startMonthly || 0)) * t);
    }
    mk('5003', out, { method: 'ltl' });
  } else if (src.leases && src.leases.length) {
    // Troy: per-lease burnoff at each turnover; market growth deepens the gap
    const m = ltlMonths(src.leases, inputs.year, startMonth, ltl);
    mk('5003', m.map((v, i) => r2(v - (followGpr ? gpr[i] - gpr[0] : 0))), { method: 'ltl' });
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

  /* ---- vacancy: % of GPR (default the last actual month's %) ---- */
  mk('5031', gpr.map((v, i) => -r2((inputs.vacancyPct?.[i] || 0) * v)), { method: 'vacancy' });

  /* ---- concessions & other rental loss ---- */
  const ratioLast = (gl: string) => (lastGpr ? lastOf(gl) / lastGpr : 0);
  // 5019 PEP grows with GPR: last-month ratio × GPR
  for (const gl of ['5019']) {
    const a = coaByCode.get(gl);
    if (!a) continue;
    const pct = inputs.pctGpr?.[gl] ?? ratioLast(gl);
    if (pct) mk(gl, gpr.map((v) => r2(pct * v)), { method: 'pctGpr', pct: Math.round(pct * 100000) / 100000, of: 'gpr', basis: 'last' });
  }
  // the "October actual" concession lines (flat) + summer storage (PY months)
  for (const a of detail) {
    if (a.pcode !== '2' || isSet(a.code) || a.code === '5022') continue;
    if (inputs.pctGpr?.[a.code] != null) {
      const pct = inputs.pctGpr[a.code];
      mk(a.code, gpr.map((v) => r2(pct * v)), { method: 'pctGpr', pct, of: 'gpr', basis: 'last' });
      continue;
    }
    baseline(a, LAST_MONTH_FLAT_GLS.has(a.code) ? 'last' : 'actual', 0);
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
  // 5032/5033/5034/5040: last actual month flat
  for (const gl of ['5032', '5033', '5034', '5040']) { const a = coaByCode.get(gl); if (a && !isSet(gl)) baseline(a, 'last', 0); }
  // 5035 current delinquency: T12 ratio to (GPR..5035) × net rental income so far
  {
    const a = coaByCode.get('5035');
    if (a) {
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
  // 5036 prior period collections: T12 ratio to net GPR × net GPR
  {
    const a = coaByCode.get('5036');
    if (a) {
      const denom = ['4994', '4995', '4996', '5003'].reduce((s, g) => s + baseTotal(g), 0);
      const pct = inputs.pctGpr?.['5036'] ?? (denom ? baseTotal('5036') / denom : 0);
      if (pct) mk('5036', netGpr.map((v) => r2(pct * v)), { method: 'pctGpr', pct: Math.round(pct * 100000) / 100000, of: 'netgpr', basis: 't12' });
    }
  }
  // any other cat-3 GL with history: PY actual
  for (const a of detail) if (a.pcode === '3' && !isSet(a.code)) baseline(a);

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
  const corp = { ...CORP_RATES } as Record<string, { perUnitYr?: number; flatMo?: number }>;
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

  /* ---- payroll: model wages (March raise) + burden at the property's own
     benefit/wage ratios; no model → own history ---- */
  const wages = src.payrollWages;
  if (wages && Object.values(wages).some((v) => v)) {
    const raise = 1 + (inputs.payrollRaisePct ?? 0.035);
    const iMarch = (3 - startMonth + 12) % 12;
    let wagesTotal = 0;
    for (const [gl, annual] of Object.entries(wages)) {
      if (!annual || !coaByCode.has(gl)) continue;
      const own = base[gl];
      const shape = own && own.some((v) => v > 0) ? (own.map((v) => Math.max(0, v)) as Months) : CURVES.flat;
      const months = spreadMonthly(r2(annual), rotate12(shape, startMonth)).map((v, i) => (i >= iMarch ? r2(v * raise) : v)) as Months;
      wagesTotal = r2(wagesTotal + sum(months));
      mk(gl, months, { method: 'payrollModel' } as any);
    }
    const baseWages = WAGE_GLS.reduce((a, g) => a + Math.abs(baseTotal(g)), 0);
    for (const a of detail) {
      if (a.pcode !== '10' || WAGE_GLS.includes(a.code) || isSet(a.code)) continue;
      const own = baseTotal(a.code);
      if (!own) continue;
      if (baseWages > 0 && wagesTotal > 0) {
        const ratio = own / baseWages;
        const cal = base[a.code]!;
        mk(a.code, spreadMonthly(r2(ratio * wagesTotal), rotate12(cal.map((v) => Math.max(0, v)) as Months, startMonth)),
          { method: 'burdenRatio', ratio: Math.round(ratio * 100000) / 100000 } as any);
      } else baseline(a);
    }
  }

  /* ---- everything else with history: PY same month × factor (template default) ---- */
  for (const a of detail) {
    if (isSet(a.code) || BASELINE_SKIP_SECTIONS.has(a.section)) continue;
    if (a.code === '6112' || a.code === '7300') continue;
    if (a.pcode === '1' && a.code !== '4994') { baseline(a, 'last', 0); continue; }
    baseline(a);
  }

  /* ---- management fee: % of total income, rounded to the dollar (template) ---- */
  const monthsMap = new Map<string, Months>();
  for (const [gl, ln] of lines) monthsMap.set(gl, ln.months);
  const totalIncome = rollup(monthsMap).get('5500') || zero12();
  const feePct = inputs.mgmtPct || tpl?.mgmtFee?.actualPct || 0;
  if (feePct) mk('6112', totalIncome.map((v) => Math.round(v * feePct)), { method: 'mgmtPct', pct: feePct });
  else if (coaByCode.has('6112')) baseline(coaByCode.get('6112')!);

  /* ---- debt service: the Yardi amortization schedule; else loan × rate; else history ---- */
  if (tpl?.debt && tpl.debt.interest.some((v) => v)) {
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
export function defaultAnnualInputs(year: number, units: number, actual: Record<string, Months> | null, rent: { marketMonthly: number; inPlaceMonthly: number } | null, coaList: CoaAccount[], tpl?: TemplateData | null, lastMonth?: number): BudgetInputs {
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
  // vacancy %: the template's "October vacancy %" (last actual month), T12 fallback
  const vacLast = lastOf('4994') ? Math.min(0.5, Math.abs(lastOf('5031')) / lastOf('4994')) : 0;
  const vac = tpl?.vacancyPct != null ? Math.abs(tpl.vacancyPct) : vacLast || (gpr ? ratio(tot('5031'), 0, 0.5) : 0.05);
  return {
    mode: 'annual',
    year, units: units || tpl?.units || 0, capital: tpl?.capital || 0, loan: 0, rate: 0, startMonth: 1,
    tieNoi: false, tieIncome: false,
    gpr: { baseMonthly: rent ? rent.marketMonthly : 0, growthPct: (tpl?.gprPct && tpl.gprPct.some((v) => v) ? tpl.gprPct : zero12()) as Months },
    ltl: {
      mode: 'leases', renewalPct: tpl?.renewalPct ?? 0.65, burnoffRenew: tpl?.burnoffRenew ?? 0.75, burnoffNew: tpl?.burnoffNew ?? 1, followGpr: true,
      startMonthly: rent ? -Math.max(0, r2(rent.marketMonthly - rent.inPlaceMonthly)) : 0,
      targetPct: ratio(tot('5003'), 0, 0.3), rampMonths: 12,
    },
    vacancyPct: Array(12).fill(Math.round(vac * 10000) / 10000) as Months,
    concessionPct: ratio(catTot('2'), 0, 0.2),
    rentalLossPct: ratio(catTot('3'), 0, 0.5),
    mgmtPct: tpl?.mgmtFee?.actualPct ? Math.round(tpl.mgmtFee.actualPct * 10000) / 10000 : (income > 0 && mgmt > 0 ? Math.round((mgmt / income) * 10000) / 10000 : 0.04),
    utilities: { source: 'baseline', growthPct: 0.03, recoveryPct: null },
    baseline: { ...DEFAULT_BASELINE, growthPct: { ...TEMPLATE_CAT_PCT } },
    refSource: 'actual',
    expirations: tpl?.leaseExpirations?.some((v) => v) ? tpl.leaseExpirations : null,
    uwAbs: {},
  };
}
