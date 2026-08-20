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
}

export type Driver =
  | { method: 'manual' }
  | { method: 'gpr' }
  | { method: 'ltl' }
  | { method: 'vacancy' }
  | { method: 'catShare'; pcode: string; share: number }     // share of a UW-tied category
  | { method: 'perUnitComp'; pcode: string; perUnit: number } // comp $/unit × subject units
  | { method: 'mgmtPct'; pct: number }
  | { method: 'interest'; loan: number; rate: number }
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
  ltl: { startMonthly: number; targetPct: number; rampMonths: number }; // negative $, pct of GPR (positive number)
  vacancyPct: Months;         // positive fractions, e.g. 0.05
  concessionPct: number;      // of GPR (positive fraction) — UW-derived
  rentalLossPct: number;      // TOTAL cat-3 % of GPR incl. vacancy — UW-derived
  mgmtPct: number;            // of total income — UW-derived (3% Y1)
  /** absolute UW Year-1 category totals for the abs-tied categories */
  uwAbs: Partial<Record<string, number>>;  // pcodes 4,5,6,8,9,10,11,12,13,14 → annual $
  /** per-category level basis: 'uw' (default — hard tie to uwAbs, comp-weighted)
      or 'perUnit' (each line = comp $/unit × subject units; UW shown as variance) */
  catBasis?: Partial<Record<string, 'uw' | 'perUnit'>>;
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
  const vac = Number(uw.assumptions['vacancyPct']) || 0.05;
  const uwAbs: Partial<Record<string, number>> = {};
  for (const p of ['4', '5', '6', '8', '9', '10', '11', '12', '13', '14']) uwAbs[p] = r2(uw.y1[p] || 0);
  const egi = uw.egi || 1;
  return {
    year, units: uw.units, capital: 0, loan: 0, rate: 0.06, startMonth: 1,
    gpr: { baseMonthly, growthPct: zero12() },
    ltl: { startMonthly: startLtl, targetPct: pctOf('loss'), rampMonths: 12 },
    vacancyPct: Array(12).fill(vac) as Months,
    concessionPct: pctOf('2'),
    rentalLossPct: pctOf('3'),
    mgmtPct: (uw.y1['7'] || 0) / egi,
    uwAbs,
  };
}

/** Weights for detail GLs of one category, from a comp set (abs $), with fallback. */
function categoryItems(pcode: string, coa: CoaAccount[], comps: CompWeights | null): { key: string; weight: number }[] {
  const members = coa.filter((a) => a.kind === 'detail' && a.pcode === pcode && a.csv_order != null);
  // byGl is signed — weights are magnitudes
  let items = members.map((a) => ({ key: a.code, weight: comps ? Math.abs(comps.byGl[a.code] || 0) : 0 }));
  if (!items.some((it) => it.weight > 0)) {
    const fb = CATEGORY_FALLBACK_GL[pcode];
    items = members.map((a) => ({ key: a.code, weight: a.code === fb ? 1 : 0 }));
    if (!items.some((it) => it.weight > 0) && items.length) items[0].weight = 1;
  }
  return items;
}

export function generateLines(coaList: CoaAccount[], inputs: BudgetInputs, uw: UwSnapshotData | null, comps: CompWeights | null, catShapes?: Record<string, Months> | null): BudgetLine[] {
  const lines = new Map<string, BudgetLine>();
  const mk = (gl: string, months: Months, driver: Driver, note = ''): void => {
    lines.set(gl, { gl_code: gl, months: months.map(r2), driver, override: false, note });
  };
  // start every uploadable detail GL at zero/manual
  for (const a of coaList) if (a.kind === 'detail') mk(a.code, zero12(), { method: 'manual' });

  const live = (i: number): boolean => i + 1 >= inputs.startMonth; // month index live in budget?

  /* ---- income ---- */
  const gpr = zero12();
  let cum = inputs.gpr.baseMonthly;
  for (let i = 0; i < 12; i++) {
    cum = i === 0 ? inputs.gpr.baseMonthly * (1 + (inputs.gpr.growthPct[0] || 0)) : cum * (1 + (inputs.gpr.growthPct[i] || 0));
    gpr[i] = live(i) ? r2(cum) : 0;
  }
  mk('4994', gpr, { method: 'gpr' });

  const gprAnnual = sum(gpr);

  // Loss to lease: linear ramp from startMonthly to targetPct×GPR over rampMonths
  const ltl = zero12();
  for (let i = 0; i < 12; i++) {
    if (!live(i)) continue;
    const k = i - (inputs.startMonth - 1);
    const t = inputs.ltl.rampMonths > 1 ? Math.min(1, k / (inputs.ltl.rampMonths - 1)) : 1;
    const target = -inputs.ltl.targetPct * gpr[i];
    ltl[i] = r2(inputs.ltl.startMonthly + (target - inputs.ltl.startMonthly) * t);
  }
  mk('5003', ltl, { method: 'ltl' });

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
  const liveWeights = (base: Months): Months => base.map((w, i) => (live(i) ? w : 0));
  const curveOf = (a: CoaAccount): Months => CURVES[a.curve || 'flat'] || CURVES.flat;
  const coaByCode = new Map(coaList.map((a) => [a.code, a]));
  const shapeFor = (gl: string, p: string): Months => {
    const glShape = comps?.glShapes?.[gl];
    if (glShape && glShape.some((v) => v > 0)) return glShape;
    if (catShapes && T12_SHAPE_PCODES.has(p) && catShapes[p]) return catShapes[p];
    return curveOf(coaByCode.get(gl)!);
  };

  for (const p of ['4', '5', '6', '8', '9', '10', '11', '12', '13', '14']) {
    const basis = inputs.catBasis?.[p] === 'perUnit' && comps?.units && inputs.units ? 'perUnit' : 'uw';
    if (basis === 'perUnit') {
      const members = coaList.filter((a) => a.kind === 'detail' && a.pcode === p && a.csv_order != null);
      for (const a of members) {
        const compVal = comps!.byGl[a.code] || 0;
        if (!compVal) continue;
        const annual = r2((compVal / comps!.units!) * inputs.units);
        if (!annual) continue;
        mk(a.code, spreadMonthly(annual, liveWeights(shapeFor(a.code, p))),
          { method: 'perUnitComp', pcode: p, perUnit: r2(compVal / comps!.units!) } as any);
      }
      continue;
    }
    const target = r2(inputs.uwAbs[p] || 0);
    if (!target) continue;
    const items = categoryItems(p, coaList, comps);
    const alloc = allocateWeighted(target, items);
    for (const [gl, amt] of Object.entries(alloc)) {
      if (!amt) continue;
      mk(gl, spreadMonthly(amt, liveWeights(shapeFor(gl, p))), { method: 'catShare', pcode: p, share: target ? amt / target : 0 });
    }
  }

  /* ---- management fee: % of total income, monthly ---- */
  const linesMonths = new Map<string, Months>();
  for (const [gl, ln] of lines) linesMonths.set(gl, ln.months);
  const totalIncome = rollup(linesMonths).get('5500') || zero12();
  mk('6112', totalIncome.map((v) => r2(v * inputs.mgmtPct)), { method: 'mgmtPct', pct: inputs.mgmtPct });

  /* ---- interest: loan × rate / 360 × days ---- */
  if (inputs.loan && inputs.rate) {
    const int = zero12();
    for (let i = 0; i < 12; i++) int[i] = live(i) ? r2((inputs.loan * inputs.rate / 360) * daysInMonth(inputs.year, i + 1)) : 0;
    mk('7300', int, { method: 'interest', loan: inputs.loan, rate: inputs.rate });
  }

  return [...lines.values()];
}

/** Re-generate all non-overridden lines; keep overrides untouched. */
export function regenerate(existing: BudgetLine[], coaList: CoaAccount[], inputs: BudgetInputs, uw: UwSnapshotData | null, comps: CompWeights | null, catShapes?: Record<string, Months> | null): BudgetLine[] {
  const fresh = new Map(generateLines(coaList, inputs, uw, comps, catShapes).map((l) => [l.gl_code, l]));
  const out: BudgetLine[] = [];
  const seen = new Set<string>();
  for (const old of existing) {
    seen.add(old.gl_code);
    if (old.override) { out.push(old); continue; }
    const f = fresh.get(old.gl_code);
    out.push(f ? { ...f, note: old.note } : old);
  }
  for (const [gl, f] of fresh) if (!seen.has(gl)) out.push(f);
  return out;
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
