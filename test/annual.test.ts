import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateAnnualLines, regenerateAnnual, defaultAnnualInputs, tiltMonths, COST_DRIFT_DEFAULT, formulaSetFromBudget, applyFormulaSet, stmtCalendar, stmtLastMonth, stmtAnnualized, trailing12, annualizedFromCal,
  refFromCalendar, refColumn, annualBaseline, expirationsFromLeases, CORP_RATES, corpRatesFor, vacancyByMonth, budgetRefLabel, gprStepsForTarget, gprStepsSummary, lagMonths, TURN_EXPENSE_GLS, type TemplateData, type AnnualSources,
} from '../shared/annual.js';
import { sum, zero12, rollup, type CoaAccount, type Months, type BudgetLine } from '../shared/domain.js';
import { parseYardiBudgetTemplate, parseRentRoll, parseMonarchStatement, detectUploadKind } from '../src/importers.js';
import { loadAnnualRules } from '../src/annual-rules.js';

// The pre-drift inputs: existing tests check the template's / GRKS draft's own monthly cells, so
// they switch the within-year cost drift OFF. The drift is tested on its own at the end.
const baseInputs = (...a: Parameters<typeof defaultAnnualInputs>) => { const i = defaultAnnualInputs(...a); return { ...i, baseline: { ...i.baseline!, costDrift: 0 } }; };
const coaList: CoaAccount[] = JSON.parse(readFileSync(join(process.cwd(), 'seed', 'coa.json'), 'utf8'));
const detail = new Set(coaList.filter((a) => a.kind === 'detail').map((a) => a.code));
const fx = (name: string): string => join(process.cwd(), 'test', 'fixtures', name);
const have = (name: string): boolean => existsSync(fx(name));
const L = (lines: BudgetLine[], gl: string) => lines.find((l) => l.gl_code === gl)!;
const cal = (vals: number[]): Months => vals as Months;

/* a tiny property: 10 units, trailing-12 Nov-24..Oct-25 laid on the calendar */
function synthetic(): Record<string, Months> {
  return {
    '4994': cal(Array(12).fill(10000)),
    '5003': cal(Array(12).fill(-500)),
    '5031': cal(Array(12).fill(-400)),
    '5035': cal(Array(12).fill(-100)),
    '5036': cal(Array(12).fill(50)),
    '5019': cal(Array(12).fill(-60)),
    '5165': cal([100, 100, 110, 110, 120, 120, 130, 130, 120, 110, 100, 100]),
    '5170': cal(Array(12).fill(800)),
    '5105': cal(Array(12).fill(40)),
    '5135': cal(Array(12).fill(200)),       // T12 2,400 > 1,000 → flat
    '5151': cal(Array(12).fill(50)),        // T12 600 ≤ 1,000 → nothing
    '5110': cal([0, 0, 300, 0, 0, 600, 0, 0, 0, 0, 0, 0]),
    '6116': cal([900, 900, 900, 900, 900, 900, 900, 900, 900, 1000, 1000, 1000]),   // Oct = 1000
    '6302': cal(Array(12).fill(100)),
    '6604': cal([200, 190, 180, 150, 120, 110, 110, 120, 130, 160, 180, 200]),
    '6620': cal(Array(12).fill(300)),
    '6702': cal(Array(12).fill(50)),
    '6402': cal(Array(12).fill(2000)),
    '6418': cal(Array(12).fill(200)),
    '6408': cal([3000, 0, 0, 3000, 0, 0, 3000, 0, 0, 3000, 0, 0]),   // quarterly NOI bonus, Jan/Apr/Jul/Oct
    '6413': cal([600, 600, 600, 600, 600, 600, 600, 600, 600, 650, 650, 650]),   // employee rent: Oct = 650
    '6112': cal(Array(12).fill(400)),
    '7300': cal(Array(12).fill(1500)),
    '7321': cal(Array(12).fill(5000)),      // special projects — never carried forward
  };
}

describe('annualBaseline shapes', () => {
  const c = cal([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
  it('actual = same month × factor', () => {
    const m = annualBaseline(c, { pct: 0.05, shape: 'actual' });
    expect(m[0]).toBe(105); expect(m[11]).toBe(1260);
  });
  it('wavg is total-preserving 1-2-1 smoothing', () => {
    const m = annualBaseline(c, { pct: 0, shape: 'wavg' });
    expect(sum(m)).toBeCloseTo(sum(c), 1);
    expect(m[0]).toBe((2 * 100 + 1200 + 200) / 4);
  });
  it('last = the last actual month, flat; avgnz = mean of active months', () => {
    expect(annualBaseline(c, { pct: 0, shape: 'last', lastMonth: 10 })).toEqual(Array(12).fill(1000));
    expect(annualBaseline(cal([0, 0, 300, 0, 0, 600, 0, 0, 0, 0, 0, 0]), { pct: 0, shape: 'avgnz' })[5]).toBe(450);
  });
  it('per-month pct array (Conservice forecast) and MROUND', () => {
    const m = annualBaseline(c, { pcts: cal([0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5]), shape: 'actual', mult: 50 });
    expect(m[0]).toBe(100); expect(m[11]).toBe(1800); expect(m[1]).toBe(200);
  });
});

describe('generateAnnualLines — template rules on own history', () => {
  const actual = synthetic();
  const inputs = baseInputs(2026, 10, actual, null, coaList, null, 10);
  const src: AnnualSources = { actual, budget: null, lastMonth: 10 };
  const lines = generateAnnualLines(coaList, inputs, src);

  it('GPR = last actual month × monthly % changes (no rent roll)', () => {
    expect(L(lines, '4994').months[0]).toBe(10000);
    expect((L(lines, '4994').driver as any).method).toBe('gpr');
  });
  it('vacancy defaults to the last actual month % of GPR', () => {
    expect(inputs.vacancyPct[0]).toBeCloseTo(0.04, 4);
    expect(L(lines, '5031').months[3]).toBe(-400);
  });
  it('ordinary lines = same month × category factor (admin 5%, maintenance 5%, reims 5%, trash 7%)', () => {
    expect(L(lines, '6302').months[0]).toBe(105);
    expect(L(lines, '6702').months[0]).toBe(52.5);
    expect(L(lines, '5170').months[0]).toBe(840);
    expect(L(lines, '6620').months[0]).toBe(321);
    expect(L(lines, '5165').months[2]).toBe(110);          // other income 0%
  });
  it('real estate taxes = trailing-12 total ÷ 12 flat (never October × 12), no $1,000 threshold', () => {
    expect(L(lines, '6116').months).toEqual(Array(12).fill(925));          // (9 × 900 + 3 × 1,000) ÷ 12
    expect((L(lines, '6116').driver as any).shape).toBe('flat');
    const small = { ...actual, '6116': cal(Array(12).fill(50)) };          // T12 600 ≤ 1,000 still budgets
    expect(L(generateAnnualLines(coaList, inputs, { ...src, actual: small }), '6116').months[0]).toBe(50);
    // the GRKS rule for 6116 is `fixedAnnual` (RMC typed an annual) — same flat default, rule carried
    const withRule = L(generateAnnualLines(coaList, inputs, { ...src, rules: { '6116': { method: 'fixedAnnual' } } }), '6116');
    expect(withRule.months).toEqual(Array(12).fill(925));
    expect((withRule.driver as any).rule).toBe('fixedAnnual');
  });
  it('"October actual" lines are flat at the last actual month, and flag a last month far off the T12 average', () => {
    const a = { ...actual, '6618': cal([90, 90, 90, 90, 90, 90, 90, 90, 90, 100, 90, 90]), '6104': cal([223, 223, 223, 223, 223, 223, 223, 223, 223, 500, 223, 223]) };
    const l = generateAnnualLines(coaList, inputs, { ...src, actual: a });
    expect(L(l, '6618').months).toEqual(Array(12).fill(100));             // phones: October flat, 0% (within 25% of the average → no flag)
    expect((L(l, '6618').driver as any).shape).toBe('last');
    expect((L(l, '6618').driver as any).lastDev).toBeUndefined();
    expect(L(l, '6104').months[0]).toBe(525);                              // auto insurance: October 500 × 1.05 flat
    expect((L(l, '6104').driver as any).lastDev).toBeCloseTo(500 / (2953 / 12) - 1, 2);   // +103% vs the average → flagged
  });
  it('T12/12 flat only above $1,000; bad-debt recovery = average of active months', () => {
    expect(L(lines, '5135').months[0]).toBe(200);
    expect(sum(L(lines, '5151').months)).toBe(0);
    expect(L(lines, '5110').months[0]).toBe(450);
  });
  it('delinquency / prior-period collections / PEP run at their ratios', () => {
    expect((L(lines, '5035').driver as any).method).toBe('pctGpr');
    expect((L(lines, '5036').driver as any).of).toBe('netgpr');
    expect(L(lines, '5019').months[0]).toBe(-60);          // last-month ratio × same GPR
  });
  it('mgmt fee = actual % of the PRIOR month\'s income, whole dollars; LTL starts at the last actual month', () => {
    const inc = sum(L(lines, '4994').months) + sum(L(lines, '5003').months);
    expect(inputs.mgmtPct).toBeGreaterThan(0.03);
    expect(Number.isInteger(L(lines, '6112').months[0])).toBe(true);
    // 2027 template: the fee bills a month in arrears — Feb's fee is Jan's total income × %
    const incomeOf = (i: number) => rollup(new Map(lines.map((l) => [l.gl_code, l.months]))).get('5500')![i];
    expect(L(lines, '6112').months[1]).toBe(Math.round(incomeOf(0) * inputs.mgmtPct));
    expect(L(lines, '6112').months[11]).toBe(Math.round(incomeOf(10) * inputs.mgmtPct));
    expect((L(lines, '6112').driver as any).priorMonth).toBe(true);
    // with no current-year budget January runs on its own income; with one, on December's budgeted income
    expect(L(lines, '6112').months[0]).toBe(Math.round(incomeOf(0) * inputs.mgmtPct));
    const budget: Record<string, Months> = { '4994': cal([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50000]), '5170': cal([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1000]) };
    const withBud = generateAnnualLines(coaList, inputs, { actual, budget, lastMonth: 10 });
    expect(L(withBud, '6112').months[0]).toBe(Math.round(51000 * inputs.mgmtPct));
    expect(L(withBud, '6112').months[1]).toBe(L(lines, '6112').months[1]);
    expect(L(lines, '5003').months[0]).toBe(-500);
    expect(inc).toBeGreaterThan(0);
  });
  it('corporate rates: insurance $285/unit/yr, legal $7.86/unit/yr', () => {
    expect(L(lines, '6108').months[0]).toBe(Math.round((10 * 285) / 12 * 100) / 100);
    expect(L(lines, '6320').months[0]).toBe(Math.round((10 * 7.86) / 12 * 100) / 100);
    expect((L(lines, '6108').driver as any).method).toBe('corpRate');
  });
  it('6310 follows the budget year: units x 58.17 / 12 + 513 from 2027 (workbook rev2), the 2026 rate before; a typed rate wins', () => {
    const u = Number(inputs.units);
    const gen = (extra: Partial<typeof inputs>) => L(generateAnnualLines(coaList, { ...inputs, ...extra }, src), '6310').months[0];
    expect(gen({ year: 2027 })).toBe(Math.round(((u * 58.17) / 12 + 513) * 100) / 100);
    expect(gen({ year: 2026 })).toBe(Math.round(((u * 43.14) / 12 + 483) * 100) / 100);
    expect(gen({ year: 2027, corpRates: { '6310': { perUnitYr: 50, flatMo: 500 } } })).toBe(Math.round(((u * 50) / 12 + 500) * 100) / 100);
  });
  it('special projects are never carried forward; interest falls back to history when no schedule / loan', () => {
    expect(sum(L(lines, '7321').months)).toBe(0);
    expect(L(lines, '7300').months[0]).toBe(1500);
  });
  it('payroll: wages flat × (1 + raise); burden = prior-year % of wages × each month of wages, so it steps with the raise', () => {
    // no model: own T12 24,000 × 1.035 flat = 2,070/mo (never the lumpy same-month history)
    const w = L(lines, '6402');
    expect(w.months.every((v) => v === w.months[0])).toBe(true);
    expect(sum(w.months)).toBeCloseTo(24000 * 1.035, 0);
    // 6418 was 10% of wages last year → 10% of each month's wages
    const b = L(lines, '6418');
    expect((b.driver as any).method).toBe('burdenRatio');
    expect((b.driver as any).ratio).toBeCloseTo(0.1, 5);
    expect(sum(b.months)).toBeCloseTo(0.1 * sum(w.months), 0);
    b.months.forEach((v, i) => expect(v).toBeCloseTo(0.1 * w.months[i], 2));
    // a model (or a hand-typed wage line) changes wages → burden follows, month by month:
    // the model's March raise step shows in the burden too (Troy 2026-11-09: monthly, not annualized)
    const withModel = generateAnnualLines(coaList, inputs, { ...src, payrollWages: { '6402': 30000 } });
    const mw = L(withModel, '6402').months, mb = L(withModel, '6418').months;
    expect(sum(mw)).toBeGreaterThan(30000);   // March raise
    expect(mw[2]).toBeGreaterThan(mw[1]);
    mb.forEach((v, i) => expect(v).toBeCloseTo(0.1 * mw[i], 2));
    expect(mb[2]).toBeGreaterThan(mb[1]);
    expect(mb[0]).toBeCloseTo(0.1 * 2500, 2);
  });
  it('burden ratio is SAME-MONTH: a quarterly bonus keeps its Jan/Apr/Jul/Oct shape instead of smearing flat', () => {
    const b = L(lines, '6408'), w = L(lines, '6402');
    expect((b.driver as any).sameMonth).toBe(true);
    // Jan: 3000 / 2000 wages = 150% of that month's budgeted wages; Feb: 0%
    expect(b.months[0]).toBeCloseTo(1.5 * w.months[0], 2);
    expect(b.months[1]).toBe(0);
    expect(b.months.filter((v) => v > 0).length).toBe(4);
    expect([0, 3, 6, 9].every((i) => b.months[i] > 0)).toBe(true);
    // the annual ratio is still carried for the chip, and the ratios array is calendar-indexed
    expect((b.driver as any).ratio).toBeCloseTo(12000 / 24000, 5);
    expect((b.driver as any).ratios[3]).toBeCloseTo(1.5, 5);
    // a budget starting in October reads the calendar ratios rotated: month 0 = October's 150%
    const oct = generateAnnualLines(coaList, { ...inputs, startMonth: 10 } as any, src);
    const bo = L(oct, '6408'), wo = L(oct, '6402');
    expect(bo.months[0]).toBeCloseTo(1.5 * wo.months[0], 2);
    expect(bo.months[1]).toBe(0);
  });
  it('flat-fee utility billing: reimbursement income = last actual month, scaled to budgeted occupancy, flat (Troy 2026-11-09)', () => {
    // synthetic: 5170 = 800 in every month, October (last month) GPR 10,000 with vacancy 400 → 96% occupied
    const flat = generateAnnualLines(coaList, { ...inputs, utilities: { ...(inputs.utilities || {}), billing: 'flat' }, vacancyPct: Array(12).fill(0.05) as Months }, src);
    const u = L(flat, '5170');
    expect((u.driver as any).method).toBe('flatFee');
    expect((u.driver as any).occLast).toBeCloseTo(0.96, 4);
    // 800 × (1 − 5%) ÷ 96% = 791.67 in every month — ties to the vacancy assumption, no GPR growth
    u.months.forEach((v) => expect(v).toBeCloseTo(791.67, 2));
    // a steeper budgeted vacancy in one month lowers that month alone
    const vac = Array(12).fill(0.05) as Months; vac[5] = 0.10;
    const dip = L(generateAnnualLines(coaList, { ...inputs, utilities: { billing: 'flat' }, vacancyPct: vac }, src), '5170');
    expect(dip.months[5]).toBeCloseTo(750, 2);
    expect(dip.months[4]).toBeCloseTo(791.67, 2);
    // a typed per-GL % is a fee increase
    const up = L(generateAnnualLines(coaList, { ...inputs, utilities: { billing: 'flat' }, vacancyPct: Array(12).fill(0.05) as Months, baseline: { ...inputs.baseline!, glGrowth: { '5170': 0.1 } } }, src), '5170');
    expect(up.months[0]).toBeCloseTo(870.83, 2);
    // RUBS / default: history as before (same month × factor)
    expect((L(lines, '5170').driver as any).method).toBe('baseline');
    // site default (Troy 2026-11-09): BCND / PHND / FHND are flat-fee unless the budget says otherwise
    expect((L(generateAnnualLines(coaList, inputs, { ...src, propertyCode: 'bcnd' }), '5170').driver as any).method).toBe('flatFee');
    expect((L(generateAnnualLines(coaList, inputs, { ...src, propertyCode: 'clnd' }), '5170').driver as any).method).toBe('baseline');
    expect((L(generateAnnualLines(coaList, { ...inputs, utilities: { billing: 'rubs' } }, { ...src, propertyCode: 'fhnd' }), '5170').driver as any).method).toBe('baseline');
  });
  it('employee rent 6413 is not a % of wages: the last actual month carried flat, no raise', () => {
    const e = L(lines, '6413');
    expect((e.driver as any).method).toBe('baseline');
    expect((e.driver as any).shape).toBe('last');
    expect((e.driver as any).pct).toBe(0);
    expect(e.months.every((v) => v === 650)).toBe(true);
    // the row's shape menu can keep ANY payroll line off the ratio
    const shaped = generateAnnualLines(coaList, { ...inputs, baseline: { ...inputs.baseline!, glShape: { '6418': 'last' as const } } }, src);
    expect((L(shaped, '6418').driver as any).method).toBe('baseline');
    expect(L(shaped, '6418').months.every((v) => v === 207)).toBe(true);   // 200 × 1.035 raise default
  });
  it('loss to lease per lease: expired / MTM leases spread over the year, market growth deepens every lease still below market', () => {
    // 24 leases: 12 already expired (MTM), 12 expiring one per month; gap $100 each, market $1,000
    const leases = [
      ...Array.from({ length: 12 }, () => ({ m: 1000, r: 900, e: '2025-06-01' })),
      ...Array.from({ length: 12 }, (_, i) => ({ m: 1000, r: 900, e: `2026-${String(i + 1).padStart(2, '0')}-01` })),
    ];
    const noGrow = { ...inputs, ltl: { ...inputs.ltl, mode: 'leases' as const, renewalPct: 0, burnoffNew: 1, followGpr: false } };
    const l = L(generateAnnualLines(coaList, noGrow, { ...src, leases }), '5003');
    // January: 2 leases reset (1 MTM + 1 expiring) → 22 × 100 left; December → 0
    expect(l.months[0]).toBe(-2200);
    expect(l.months[11]).toBe(0);
    for (let i = 1; i < 12; i++) expect(l.months[i]).toBe(l.months[i - 1] + 200);
    // with 12% GPR growth in month 2 and "follows GPR": every lease's gap is measured against the
    // grown market ($1,120). The 20 not-yet-reset leases carry 100 + 120; the 2 that signed at
    // $1,000 in January are now $120 under market too; February's 2 resets go to market.
    const grow = { ...noGrow, ltl: { ...noGrow.ltl, followGpr: true }, gpr: { ...inputs.gpr, growthPct: [0, 0.12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as Months } };
    const l2 = L(generateAnnualLines(coaList, grow, { ...src, leases }), '5003');
    expect(l2.months[1]).toBeCloseTo(-(20 * 220) - (2 * 120), 0);
    // December: every lease has reset; only those that signed before the February increase are under market
    expect(l2.months[11]).toBeCloseTo(-(2 * 120), 0);
  });
  it('loss to lease: 100% renewal with 0% burnoff burns NOTHING — the gap holds all year, market step included (Troy 2026-11-09)', () => {
    const leases = [
      ...Array.from({ length: 12 }, () => ({ m: 1000, r: 900, e: '2025-06-01' })),
      ...Array.from({ length: 12 }, (_, i) => ({ m: 1000, r: 900, e: `2026-${String(i + 1).padStart(2, '0')}-01` })),
    ];
    const hold = { ...inputs, ltl: { ...inputs.ltl, mode: 'leases' as const, renewalPct: 1, burnoffRenew: 0, burnoffNew: 0.95, followGpr: true }, gpr: { ...inputs.gpr, growthPct: [0, 0.03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as Months } };
    const l = L(generateAnnualLines(coaList, hold, { ...src, leases }), '5003');
    expect(l.months[0]).toBe(-2400);                                   // 24 x $100
    // February: market +3% on all 24 occupied units ($30 each) and it STAYS there — no renewal gives any of it back
    for (let i = 1; i < 12; i++) expect(l.months[i]).toBeCloseTo(-2400 - 24 * 30, 0);
    // same leases at 50% burnoff on renewal: each reset halves that lease's whole gap, growth included
    const half = L(generateAnnualLines(coaList, { ...hold, ltl: { ...hold.ltl, burnoffRenew: 0.5 } }, { ...src, leases }), '5003');
    expect(half.months[11]).toBeCloseTo(-(2 * (50 + 30)) - (22 * 65), 0);   // January's 2 halved before the step, then +30; the other 22 halve 130
  });
  it('loss to lease: flat mode holds the last actual month with no burnoff (deepens only with GPR when asked)', () => {
    const flatIn = { ...inputs, ltl: { ...inputs.ltl, mode: 'flat' as const, followGpr: false } };
    const l = L(generateAnnualLines(coaList, flatIn, src), '5003');
    expect(l.months.every((v) => v === -500)).toBe(true);
    const follow = { ...inputs, ltl: { ...inputs.ltl, mode: 'flat' as const, followGpr: true }, gpr: { ...inputs.gpr, growthPct: Array(12).fill(0.01) as Months } };
    const l2 = L(generateAnnualLines(coaList, follow, src), '5003');
    expect(l2.months[0]).toBe(-500);
    expect(l2.months[11]).toBeLessThan(-500);
  });
  it('tie-out reference from the same history: budget at 0% factors reproduces its own T12 by category', () => {
    const flat = { ...inputs, baseline: { source: 'actual' as const, growthPct: { '*': 0 }, shape: 'actual' as const, mround: 0 } };
    const ref = refFromCalendar(coaList, actual, 10, 'T12');
    expect(ref.egi).toBeGreaterThan(0);
    expect(ref.y1['12']).toBe(sum(actual['6604']) + sum(actual['6620']));
    const col = refColumn(actual);
    expect(col.totals['5500']).toBe(ref.egi);
    expect(flat.baseline.growthPct['*']).toBe(0);
  });
  it('regenerateAnnual keeps overrides and notes', () => {
    const edited = lines.map((l) => (l.gl_code === '6302' ? { ...l, months: Array(12).fill(999) as Months, override: true, note: 'hand' } : l));
    const re = regenerateAnnual(edited, coaList, inputs, src);
    expect(L(re, '6302').months[0]).toBe(999);
    expect(L(re, '6302').note).toBe('hand');
    expect(L(re, '6702').months[0]).toBe(52.5);
  });
  it('per-GL shape + factor overrides win', () => {
    const inp2 = { ...inputs, baseline: { ...inputs.baseline!, glShape: { '6604': 'flat' as const }, glGrowth: { '6604': 0.1 } } };
    const l2 = generateAnnualLines(coaList, inp2, src);
    expect(L(l2, '6604').months.every((v) => v === L(l2, '6604').months[0])).toBe(true);
    expect(sum(L(l2, '6604').months)).toBeCloseTo(sum(actual['6604']) * 1.1, 1);
  });
});

describe('lease expirations and turnover-driven lines', () => {
  it('expirationsFromLeases counts lease ends by budget month; MTM/expired spread one twelfth a month; pre-start turns are not expirations', () => {
    const leases = [{ m: 1000, r: 900, e: '2026-03-15' }, { m: 1000, r: 900, e: '2025-12-01' }, { m: 1000, r: 900, e: null }, { m: 1000, r: 900, e: '2027-01-01' }];
    const e = expirationsFromLeases(leases, 2026);
    expect(e[2]).toBe(1); expect(e[0]).toBe(1); expect(e[1]).toBe(1); expect(sum(e)).toBe(3);   // no as-of: the Dec-25 and undated leases are MTM, round-robin
    const withRoll = expirationsFromLeases(leases, 2026, { asOf: '11/15/2025' });
    expect(withRoll[2]).toBe(1); expect(withRoll[0]).toBe(1); expect(withRoll[11]).toBe(1); expect(sum(withRoll)).toBe(3);   // Dec-25 ends after the roll → turned before January, up again Dec-26
  });
  it('a lease ending between the roll date and the budget start resets in month 0 with the renewal mix (not MTM all year)', () => {
    const actual = synthetic();
    const inputs = baseInputs(2026, 10, actual, null, coaList, null, 10);
    const noGrow = { ...inputs, ltl: { ...inputs.ltl, mode: 'leases' as const, renewalPct: 0, burnoffNew: 1, followGpr: false } };
    // 12 leases ending 15 Dec 2025 (gap $100 each), roll as of 30 Sep 2025, budget Jan 2026
    const leases = Array.from({ length: 12 }, () => ({ m: 1000, r: 900, e: '2025-12-15' }));
    const stale = L(generateAnnualLines(coaList, noGrow, { actual, budget: null, lastMonth: 10, leases }), '5003');
    expect(stale.months[0]).toBe(-1100);                                   // no as-of: treated as MTM, 1 resets a month
    const fresh = L(generateAnnualLines(coaList, noGrow, { actual, budget: null, lastMonth: 10, leases, rollAsOf: '2025-09-30' }), '5003');
    expect(fresh.months[0]).toBe(0);                                       // all 12 turned before January
    const expired = L(generateAnnualLines(coaList, noGrow, { actual, budget: null, lastMonth: 10, leases: leases.map((l) => ({ ...l, e: '2025-06-01' })), rollAsOf: '2025-09-30' }), '5003');
    expect(expired.months[0]).toBe(-1100);                                 // already expired at the roll → still MTM
  });
  it('application fees = last year $ ÷ this year move-ins × each month\'s move-ins', () => {
    const actual = synthetic();
    const inputs = { ...baseInputs(2026, 10, actual, null, coaList, null, 10), expirations: cal([0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
    inputs.ltl.renewalPct = 0.5;
    const lines = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10 });
    const l = L(lines, '5105');
    expect((l.driver as any).method).toBe('perTurn');
    expect(sum(l.months)).toBeCloseTo(480, 1);            // last year's 480 preserved
    expect(l.months[2]).toBeCloseTo(480, 1);              // all on the month with the turns
  });
});

describe('stmt helpers', () => {
  const stmt = { monthCal: [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], monthYear: [2024, 2024, 2025, 2025, 2025, 2025, 2025, 2025, 2025, 2025, 2025, 2025], rows: [{ gl: '6604', name: 'E', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], total: 78 }] };
  it('stmtCalendar lands each column on its calendar month', () => {
    const c = stmtCalendar(stmt);
    expect(c['6604'][10]).toBe(1); expect(c['6604'][0]).toBe(3); expect(c['6604'][9]).toBe(12);
  });
  it('stmtLastMonth = latest column by date; stmtAnnualized = last n × 12/n', () => {
    expect(stmtLastMonth(stmt)).toBe(10);
    expect(stmtAnnualized(stmt, 4)['6604']).toBe((9 + 10 + 11 + 12) * 3);
  });
  // Troy: "the model is trying to pull months that do not exist, instead of pulling last months of '25"
  const cy2026 = { monthCal: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], monthYear: Array(12).fill(2026), rows: [{ gl: '6604', name: 'E', months: [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 0, 0], total: 1055 }] };
  const cy2025 = { monthCal: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], monthYear: Array(12).fill(2025), rows: [{ gl: '6604', name: 'E', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], total: 78 }] };
  it('a calendar-year export with empty Nov–Dec: last actual month is October, not December', () => {
    expect(stmtLastMonth(cy2026)).toBe(10);
  });
  it('trailing12 composes Nov–Oct across statements and names what is missing', () => {
    const alone = trailing12([cy2026])!;
    expect(alone.lastMonth).toBe(10); expect(alone.period).toBe('Nov 2025-Oct 2026');
    expect(alone.missing).toEqual(['Nov 2025', 'Dec 2025']);
    expect(alone.cal['6604'][10]).toBe(0);                        // nothing covers Nov 2025 → zero, flagged
    const both = trailing12([cy2026, cy2025])!;
    expect(both.missing).toEqual([]);
    expect(both.cal['6604'][10]).toBe(11); expect(both.cal['6604'][11]).toBe(12);   // Nov/Dec 2025 from last year's export
    expect(both.cal['6604'][0]).toBe(101); expect(both.cal['6604'][9]).toBe(110);   // Jan–Oct 2026 from this year's
    expect(annualizedFromCal(both.cal, both.lastMonth, 4)['6604']).toBe((107 + 108 + 109 + 110) * 3);
    // the template's own Nov–Oct statement composes to itself
    const tpl = trailing12([stmt])!;
    expect(tpl.period).toBe('Nov 2024-Oct 2025'); expect(tpl.missing).toEqual([]); expect(tpl.cal['6604'][10]).toBe(1);
  });
  // Troy (ECND): the statement is Oct 2025–Sep 2026 but the property was taken
  // over in December — Oct/Nov 2025 have no rent and must not feed "same month"
  it('trailing12 treats months with no GPR as pre-acquisition: filled with the live-month average, labelled', () => {
    const ecnd = {
      monthCal: [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9], monthYear: [2025, 2025, 2025, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026],
      rows: [
        { gl: '4994', name: 'GPR', months: [0, 0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], total: 10000 },
        { gl: '6604', name: 'Electric', months: [0, 500000, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100], total: 501000 },   // Nov: a closing entry, not operations
      ],
    };
    const t = trailing12([ecnd])!;
    expect(t.dead).toEqual(['Oct 2025', 'Nov 2025']);
    expect(t.liveMonths).toBe(10);
    expect(t.period).toBe('Oct 2025-Sep 2026 · 10 mo annualized');
    expect(t.cal['4994'][9]).toBe(1000); expect(t.cal['4994'][10]).toBe(1000);           // Oct/Nov = live average
    expect(t.cal['6604'][10]).toBe(100);                                                 // the closing entry is gone
    expect(sum(t.cal['6604'])).toBe(1200);                                               // 10 live months annualized
    expect(sum(t.cal['4994'])).toBe(12000);
  });
});

describe('parseYardiBudgetTemplate — clnd 2026 template (real export)', () => {
  if (!have('yardi-template-clnd.xlsm')) { it.skip('fixture missing', () => {}); return; }
  const p = parseYardiBudgetTemplate(readFileSync(fx('yardi-template-clnd.xlsm')), detail);
  const t = p.template;
  it('never reads the pasted payroll roster — only the sheet NAME is reported as skipped', () => {
    expect(p.skippedSheets).toEqual(['Paste Payroll Here']);
    // nothing from that sheet: the parsed payload holds only the template tables + statements
    expect(Object.keys(p).sort()).toEqual(['actual', 'budget', 'skippedSheets', 'template']);
    expect(Object.keys(p.template)).not.toContain('payroll');
  });
  it('property facts, PY anchors and the last actual month', () => {
    expect(t.code).toBe('clnd'); expect(t.units).toBe(341); expect(t.capital).toBe(17400000); expect(t.budgetYear).toBe(2026);
    expect(t.lastActual).toEqual({ year: 2025, month: 10 });
    expect(t.pyYears).toEqual([2025, 2025, 2025, 2025, 2025, 2025, 2025, 2025, 2025, 2025, 2024, 2024]);
  });
  it('trailing-12 and CY budget statements come out of PriorFinancials', () => {
    expect(p.actual.period).toBe('Nov 2024-Oct 2025');
    expect(p.actual.gpr).toBeCloseTo(5340671.7, 1);
    expect(p.budget.period).toBe('Jan 2025-Dec 2025');
    expect(p.budget.rows.length).toBeGreaterThan(100);
    const e = p.actual.rows.find((r) => r.gl === '6604')!;
    expect(e.months[0]).toBeCloseTo(6907.86, 2);   // Jan-25
    expect(e.months[10]).toBeCloseTo(6015.57, 2);  // Nov-24
  });
  it('template tables: debt schedule, fee actual, Conservice forecast, suggestions, expirations, mortgage', () => {
    expect(t.debt.interest[0]).toBeCloseTo(120480.21, 2);
    expect(t.debt.principalGl).toBe('3080');
    expect(t.mgmtFee.actualPct).toBeCloseTo(0.04, 3);
    expect(Object.keys(t.mgmtFee.matrix).length).toBeGreaterThan(5);
    expect(t.utilForecast['6604'][0]).toBeCloseTo(0.05, 6);
    expect(t.suggestions['6102'][2]).toBeCloseTo(1708.19, 2);
    expect(t.softwareFixedMo).toBe(275);
    expect(t.leaseExpirations[9]).toBe(29);
    expect(t.renewalPct).toBeCloseTo(0.6631, 3);
    expect(t.mortgage[0].rate).toBeCloseTo(0.0525, 4);
  });
  it('the engine reproduces the template\'s own Budget Worksheet values', () => {
    const actual = stmtCalendar({ monthCal: p.actual.monthCal, monthYear: p.actual.monthYear, rows: p.actual.rows });
    const budget = stmtCalendar({ monthCal: p.budget.monthCal, rows: p.budget.rows });
    const inputs = baseInputs(2026, t.units, actual, null, coaList, t, 10);
    inputs.baseline!.useUtilForecast = true;   // the raw template applies Conservice's forecast (the GRKS foundation uses a flat factor)
    const lines = generateAnnualLines(coaList, inputs, { actual, budget, lastMonth: 10, template: t });
    expect(L(lines, '4994').months[0]).toBe(460704);                 // Oct actual
    expect(L(lines, '4994').months[1]).toBeCloseTo(463007.52, 2);    // × 1.005
    expect(L(lines, '6604').months[0]).toBeCloseTo(7253.25, 2);      // PY Jan × 1.05 (Conservice)
    expect(L(lines, '6604').months[1]).toBeCloseTo(7396.13, 2);
    expect(L(lines, '7300').months[0]).toBeCloseTo(120480.21, 2);    // amortization schedule
    expect(L(lines, '6331').months[0]).toBe(275);                    // fixed software cost
    expect(L(lines, '6108').months[0]).toBeCloseTo((341 * 285) / 12, 2);
    expect((L(lines, '6102').driver as any).method).toBe('suggested');
    const ref = refFromCalendar(coaList, actual, t.units, 'T12');
    expect(ref.egi).toBeGreaterThan(5_000_000);
  });
});

describe('parseYardiBudgetTemplate — GRKS RMC draft ties to its Summary', () => {
  if (!have('yardi-template-grks-draft.xlsm')) { it.skip('fixture missing', () => {}); return; }
  const p = parseYardiBudgetTemplate(readFileSync(fx('yardi-template-grks-draft.xlsm')), detail);
  it('trailing-12 income / expenses / NOI match the workbook Summary', () => {
    const actual = stmtCalendar({ monthCal: p.actual.monthCal, monthYear: p.actual.monthYear, rows: p.actual.rows });
    const ref = refFromCalendar(coaList, actual, p.template.units, 'T12');
    expect(ref.egi).toBeCloseTo(1580185.29, 1);
    expect(ref.toe).toBeCloseTo(821755.25, 1);
    expect(ref.noi).toBeCloseTo(758430.04, 1);
  });
  it('template-driven lines land where the RMC draft did', () => {
    const t = p.template;
    const actual = stmtCalendar({ monthCal: p.actual.monthCal, monthYear: p.actual.monthYear, rows: p.actual.rows });
    const inputs = baseInputs(2026, t.units, actual, null, coaList, t, 10);
    const lines = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10, template: t });
    expect(sum(L(lines, '4994').months)).toBeCloseTo(1493914.18, 1);
    expect(sum(L(lines, '6116').months)).toBeCloseTo(101838.76, 1);   // RE tax: T12 flat, not RMC's typed 103,355 (October × 12)
    expect(sum(L(lines, '6108').months)).toBe(28500);
    expect(sum(L(lines, '7300').months)).toBeCloseTo(234066.04, 1);
    expect(sum(L(lines, '3080').months)).toBeCloseTo(-100862.94, 1);
    expect(sum(L(lines, '6102').months)).toBeCloseTo(4373.76, 1);
  });
});

describe('foundation rules (seed/annual-rules.json, extracted from the GRKS draft)', () => {
  const rules = loadAnnualRules();
  it('cover the chart with the four history methods', () => {
    expect(Object.keys(rules).length).toBeGreaterThan(200);
    expect(rules['5103']).toMatchObject({ method: 'same', mround: 10 });
    expect(rules['6604']).toMatchObject({ method: 'wavg', mround: 250, factor: 0.05 });
    expect(rules['6702']).toMatchObject({ method: 'flatT12', factor: 0.1 });
    expect(rules['6309']).toMatchObject({ method: 'flatT12', noThreshold: true });
    expect(rules['6116'].method).toBe('fixedAnnual');
  });
  it('the engine applies them: shape, factor and MROUND per GL', () => {
    const actual = synthetic();
    actual['6702'] = cal(Array(12).fill(500));     // T12 6,000 > $1,000
    const inputs = baseInputs(2026, 10, actual, null, coaList, null, 10);
    const lines = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10, rules });
    expect(L(lines, '6702').months[0]).toBe(550);                    // flatT12 × 1.10 / 12
    expect((L(lines, '6702').driver as any).rule).toBe('flatT12');
    const e = L(lines, '6604');                                        // wavg × 1.05 → MROUND 250; Jan/Dec plain × factor MROUND 10 (RMC's edges)
    expect(e.months.slice(1, 11).every((v) => v % 250 === 0)).toBe(true);
    expect(e.months[0]).toBe(Math.round((200 * 1.05) / 10) * 10);
    expect(L(lines, '5165').months[0] % 50).toBe(0);                 // same, MROUND 50
    expect(L(lines, '6302').months[0]).toBe(110);                    // same × 1.05 → MROUND 10 (100 → 105 → 110)
  });
  if (have('yardi-template-grks-draft.xlsm')) {
    it('reproduce the GRKS draft\'s own cells where RMC left the formulas alone', () => {
      const p = parseYardiBudgetTemplate(readFileSync(fx('yardi-template-grks-draft.xlsm')), detail);
      const t = p.template;
      const actual = stmtCalendar({ monthCal: p.actual.monthCal, monthYear: p.actual.monthYear, rows: p.actual.rows });
      const inputs = baseInputs(2026, t.units, actual, null, coaList, t, 10);
      const lines = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10, template: t, rules });
      expect(L(lines, '6604').months[0]).toBe(800);                  // Jan: PY × 1.05 → MROUND 10 (RMC: 800)
      expect(sum(L(lines, '6702').months)).toBeCloseTo(2092.2, 0);   // flatT12 × 1.10 (RMC: 2,092)
      expect(L(lines, '5165').months[0]).toBe(1050);                 // PY Jan 1,030.65 → MROUND 50 (RMC: 1,050)
      // RE tax: trailing-12 total flat (101,839), NOT October × 12 (103,355 — RMC's typed annual
      // was a property decision; on clnd the same rule put 2026 taxes 110k under what was loaded)
      expect(sum(L(lines, '6116').months)).toBeCloseTo(101838.76, 1);
      expect((L(lines, '6116').driver as any).rule).toBe('fixedAnnual');
    });
    it('a typed category % outranks the per-GL foundation factors (the Assumptions boxes used to be inert)', () => {
      const p = parseYardiBudgetTemplate(readFileSync(fx('yardi-template-grks-draft.xlsm')), detail);
      const t = p.template;
      const actual = stmtCalendar({ monthCal: p.actual.monthCal, monthYear: p.actual.monthYear, rows: p.actual.rows });
      const inputs = baseInputs(2026, t.units, actual, null, coaList, t, 10);
      const src: AnnualSources = { actual, budget: null, lastMonth: 10, template: t, rules };
      const catOf = (ls: BudgetLine[], pc: string) => ls.reduce((a, l) => a + (coaList.find((x) => x.code === l.gl_code)?.pcode === pc ? sum(l.months) : 0), 0);
      const base = generateAnnualLines(coaList, inputs, src);
      const typed = generateAnnualLines(coaList, { ...inputs, baseline: { ...inputs.baseline!, growthPct: { '13': 0.25 } } }, src);
      expect(sum(L(typed, '6702').months)).toBeCloseTo(sum(L(base, '6702').months) * 1.25 / 1.10, 0);   // flatT12 rule 10% → typed 25%
      expect(catOf(typed, '13') / catOf(base, '13')).toBeGreaterThan(1.1);                              // the category really moves
      expect(catOf(typed, '9')).toBe(catOf(base, '9'));                                                 // other categories untouched
      // a GL's own typed factor still wins over the category
      const own = generateAnnualLines(coaList, { ...inputs, baseline: { ...inputs.baseline!, growthPct: { '13': 0.25 }, glGrowth: { '6702': 0 } } }, src);
      expect(sum(L(own, '6702').months)).toBeCloseTo(sum(L(base, '6702').months) / 1.10, 0);
    });
  }
});

describe('parseRentRoll — Yardi "Rent Roll with Lease Charges" (9/30/26, all ND)', () => {
  if (!have('rentroll-lease-charges.xlsx')) { it.skip('fixture missing', () => {}); return; }
  const props = parseRentRoll(readFileSync(fx('rentroll-lease-charges.xlsx')));
  it('parses all 15 properties and 3,305 units, market rent ties to the report total', () => {
    expect(props.length).toBe(15);
    expect(props.reduce((a, p) => a + p.units, 0)).toBe(3305);
    expect(props.reduce((a, p) => a + p.marketMonthly, 0)).toBeCloseTo(4714910, 0);
    expect(props.find((p) => p.code === 'phnd')!.units).toBe(202);
  });
  it('captures per-lease detail and recurring charge codes (occupied units only)', () => {
    const bc = props.find((p) => p.code === 'bcnd')!;
    expect(bc.leases!.length).toBe(539);
    expect(bc.charges!['ubutil']).toBe(42775);
    expect(bc.charges!['petfee']).toBe(1890);
    expect(bc.charges!['rent']).toBeUndefined();
  });
});

describe('parseMonarchStatement — 12 Month Budget export', () => {
  if (!have('minot4-12mo-budget.xlsx')) { it.skip('fixture missing', () => {}); return; }
  it('detects the Budget kind, months and detail rows', () => {
    const st = parseMonarchStatement(readFileSync(fx('minot4-12mo-budget.xlsx')), detail);
    expect(st.kind).toBe('budget');
    expect(st.monthCal).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(st.monthYear[0]).toBe(2026);
    expect(st.rows.some((r) => r.gl === '5004')).toBe(false);     // subtotal rows dropped
    expect(st.gpr).toBeCloseTo(12274765.85, 1);
  });
});

describe('CORP_RATES', () => {
  it('match the 2026 template constants', () => {
    expect(CORP_RATES['6108'].perUnitYr).toBe(285);
    expect(CORP_RATES['6310'].flatMo).toBe(483);
    expect(zero12().length).toBe(12);
  });
  it('6310 takes the 2027 workbook rev2 figures from 2027 on; earlier years keep the 2026 rate', () => {
    expect(corpRatesFor(2026)['6310']).toMatchObject({ perUnitYr: 43.14, flatMo: 483 });
    expect(corpRatesFor(2027)['6310']).toMatchObject({ perUnitYr: 58.17, flatMo: 513 });
    expect(corpRatesFor(2028)['6310'].perUnitYr).toBe(58.17);
    // the other corporate rates are untouched by the 2027 release
    for (const gl of ['6108', '6320', '6560']) expect(corpRatesFor(2027)[gl]).toEqual(CORP_RATES[gl]);
  });
});

/* The Data page takes any file and guesses what it is — every fixture on disk
   must come back as its own kind (the Yardi template must never be mistaken
   for a statement, the rent roll never for a comp set). */
describe('detectUploadKind — Data page auto-detect', () => {
  const cases: [string, string][] = [
    ['yardi-template-clnd.xlsm', 'yardi_template'],
    ['yardi-template-grks-draft.xlsm', 'yardi_template'],
    ['rentroll-lease-charges.xlsx', 'rent_roll'],
    ['rentroll-summary.xlsx', 'rent_roll'],
    ['rentroll-unit-level.xlsx', 'rent_roll'],
    ['minot4-12mo-budget.xlsx', 'statement'],
    ['comparison-minot4.xlsx', 'comparison'],
    ['comparison-northda-aug26.xlsx', 'comparison'],
    ['bismarck-uw.xlsx', 'uw_book'],
    ['jamestown-uw.xlsx', 'uw_book'],
    ['deerridge-t12.xlsx', 'seller_t12'],
  ];
  for (const [file, kind] of cases) {
    it(`${file} → ${kind}`, () => {
      if (!existsSync(fx(file))) return;
      expect(detectUploadKind(readFileSync(fx(file)))).toBe(kind);
    });
  }
});

describe('payroll flow (Troy 2026-11-03): roster wages carry their raises; burden from a mix of historicals', () => {
  const actual = synthetic();
  const inputs = baseInputs(2026, 10, actual, null, coaList, null, 10);
  const src: AnnualSources = { actual, budget: null, lastMonth: 10 };

  it('roster wages get NO second March step — the Pay-rates apply already prorated each raise', () => {
    const model = generateAnnualLines(coaList, inputs, { ...src, payrollWages: { '6402': 30000 } });
    expect(sum(L(model, '6402').months)).toBeGreaterThan(30000);             // the old model: + March raise
    const roster = generateAnnualLines(coaList, { ...inputs, wagesFromRoster: true }, { ...src, payrollWages: { '6402': 30000 } });
    const w = L(roster, '6402');
    expect(sum(w.months)).toBeCloseTo(30000, 0);
    expect(w.months.every((v) => Math.abs(v - 2500) < 0.01)).toBe(true);
    expect((w.driver as any).roster).toBe(true);
    // burden still follows the (un-stepped) wages
    expect(sum(L(roster, '6418').months)).toBeCloseTo(0.1 * 30000, 0);
  });

  it('LIVE Payroll-tab wages (the default source): no March step, no generic raise %, driver names the cycle and its draft state', () => {
    const wagesLive = { label: 'FY27 raises', effective: '2027-01', draft: true };
    // payrollRaisePct is set high on purpose: it must not touch roster wages
    const ls = generateAnnualLines(coaList, { ...inputs, payrollRaisePct: 0.5 }, { ...src, payrollWages: { '6402': 30000 }, wagesLive });
    const w = L(ls, '6402');
    expect(w.months.every((v) => Math.abs(v - 2500) < 0.01)).toBe(true);
    expect(w.driver).toMatchObject({ method: 'payrollModel', roster: true, live: true, cycle: 'FY27 raises', effective: '2027-01', draft: true });
    expect(sum(L(ls, '6418').months)).toBeCloseTo(0.1 * 30000, 0);            // burden follows the roster wages
    const fin = generateAnnualLines(coaList, inputs, { ...src, payrollWages: { '6402': 30000 }, wagesLive: { ...wagesLive, draft: false } });
    expect((L(fin, '6402').driver as any).draft).toBe(false);
  });

  it('payroll MODEL wages (no roster): the raise % is half in February and full from March', () => {
    const ls = generateAnnualLines(coaList, { ...inputs, payrollRaisePct: 0.04 }, { ...src, payrollWages: { '6402': 30000 } });
    const w = L(ls, '6402').months;
    expect(w[0]).toBeCloseTo(2500, 2);
    expect(w[1]).toBeCloseTo(2500 * 1.02, 2);
    expect(w.slice(2).every((v) => Math.abs(v - 2500 * 1.04) < 0.01)).toBe(true);
  });

  it('LIVE wages keep the raise step: months before the effective month stay at the old rate (never smeared flat)', () => {
    // raise effective April: Jan-Mar 2,400, Apr-Dec 2,500
    const monthly = { '6402': [2400, 2400, 2400, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500] as Months };
    const annual = 2400 * 3 + 2500 * 9;
    const wagesLive = { label: 'FY27', effective: '2027-04', draft: true, monthly };
    const ls = generateAnnualLines(coaList, inputs, { ...src, payrollWages: { '6402': annual }, wagesLive });
    expect(L(ls, '6402').months).toEqual(monthly['6402']);
    // burden follows each month's own wages, so it steps too
    const tax = L(ls, '6418').months;
    expect(tax[3]).toBeGreaterThan(tax[0]);
    // a wage total typed on the budget rides the same shape, scaled, and ties to the penny
    const typed = L(generateAnnualLines(coaList, inputs, { ...src, payrollWages: { '6402': annual * 1.1 }, wagesLive }), '6402').months;
    expect(sum(typed)).toBeCloseTo(annual * 1.1, 2);
    expect(typed[0]).toBeLessThan(typed[3]);
    expect(typed[0] / typed[3]).toBeCloseTo(2400 / 2500, 3);
  });

  it('a wage GL the roster books NOTHING to is a set zero — the trailing-12 fallback cannot refill it', () => {
    const a2 = { ...actual, '6407': cal(Array(12).fill(400)) };                 // rover wages in the history
    const base = { ...src, actual: a2 };
    // no roster: 6407 comes back from its own trailing-12
    expect(sum(L(generateAnnualLines(coaList, inputs, base), '6407').months)).toBeGreaterThan(4800);
    // roster books rovers to 6404 and reports 6407 = 0: it stays zero (no double count)
    const ls = generateAnnualLines(coaList, inputs, { ...base, payrollWages: { '6402': 30000, '6404': 20000, '6407': 0 }, wagesLive: { label: 'c', effective: '2027-01', draft: false } });
    expect(sum(L(ls, '6407').months)).toBe(0);
    expect((L(ls, '6407').driver as any).roster).toBe(true);
    // a plain payroll MODEL with a zero keeps the old behaviour (history fills the GL)
    expect(sum(L(generateAnnualLines(coaList, inputs, { ...base, payrollWages: { '6402': 30000, '6407': 0 } }), '6407').months)).toBeGreaterThan(4800);
  });

  it('burden basis: T12 actual ratio (default), CY budget ratio, or the average of the two', () => {
    const budget: Record<string, Months> = { '6402': cal(Array(12).fill(2000)), '6418': cal(Array(12).fill(300)) };   // 15% of wages in the CY budget
    const wages = { '6402': 30000 };
    const t12 = generateAnnualLines(coaList, { ...inputs, wagesFromRoster: true }, { ...src, budget, payrollWages: wages });
    const bud = generateAnnualLines(coaList, { ...inputs, wagesFromRoster: true, burdenBasis: 'budget' }, { ...src, budget, payrollWages: wages });
    const mix = generateAnnualLines(coaList, { ...inputs, wagesFromRoster: true, burdenBasis: 'mix' }, { ...src, budget, payrollWages: wages });
    const d = (ls: BudgetLine[]) => L(ls, '6418').driver as any;
    expect(d(t12).basis).toBe('t12'); expect(d(t12).ratio).toBeCloseTo(0.10, 5);
    expect(d(bud).basis).toBe('budget'); expect(d(bud).ratio).toBeCloseTo(0.15, 5);
    expect(d(mix).basis).toBe('mix'); expect(d(mix).ratio).toBeCloseTo(0.125, 5);
    expect(d(mix).t12Ratio).toBeCloseTo(0.10, 5); expect(d(mix).budgetRatio).toBeCloseTo(0.15, 5);
    expect(sum(L(mix, '6418').months)).toBeCloseTo(0.125 * 30000, 0);
    // a basis with no history on that side falls back to the other
    const budOnly = generateAnnualLines(coaList, { ...inputs, wagesFromRoster: true, burdenBasis: 'budget' }, { ...src, payrollWages: wages });
    expect(d(budOnly).ratio).toBeCloseTo(0.10, 5);
  });
});

describe('GPR increases in specific months (Troy 2026-11-03)', () => {
  it('a tie scales the month pattern instead of blanketing a uniform rate', () => {
    const steps = cal([0, 0, 0.03, 0, 0, 0, 0, 0, 0.02, 0, 0, 0]);
    const base = 10000;
    const annualOf = (s: Months) => { let c = base, t = 0; for (let i = 0; i < 12; i++) { c *= 1 + s[i]; t += c; } return t; };
    const target = annualOf(steps) * 1.02;
    const out = gprStepsForTarget(base, steps, target);
    expect(out.k).not.toBeNull();
    expect(out.growthPct.filter((v) => v).length).toBe(2);               // still March and September only
    expect(out.growthPct[2]).toBeGreaterThan(0.03); expect(out.growthPct[8]).toBeGreaterThan(0.02);
    expect(out.growthPct[2] / out.growthPct[8]).toBeCloseTo(1.5, 3);      // same proportions
    expect(annualOf(out.growthPct)).toBeCloseTo(target, 0);
    // no pattern on file → the old uniform rate
    const flat = gprStepsForTarget(base, zero12(), base * 12 * 1.02);
    expect(flat.g).not.toBeNull();
    expect(flat.growthPct.every((v) => v === flat.growthPct[0])).toBe(true);
  });
  it('summarises the steps for labels', () => {
    expect(gprStepsSummary(cal([0, 0, 0.03, 0, 0, 0, 0, 0, 0.02, 0, 0, 0]))).toBe('Mar +3%, Sep +2%');
    expect(gprStepsSummary(cal(Array(12).fill(0.005)))).toBe('0.50% every month');
    expect(gprStepsSummary(zero12())).toBe('no increases');
  });
});

describe('turn costs follow lease expirations with a one-month lag (Troy 2026-11-04)', () => {
  const actual = { ...synthetic(), '6926': cal(Array(12).fill(500)), '6728': cal(Array(12).fill(100)) };   // painting contractor 6,000/yr, paint 1,200/yr
  const inputs = baseInputs(2026, 10, actual, null, coaList, null, 10);
  // 24 leases: 12 end in March, 12 in September
  const leases = [...Array(12).fill({ m: 1000, r: 950, e: '2026-03-31' }), ...Array(12).fill({ m: 1000, r: 950, e: '2026-09-30' })];
  it('lagMonths shifts the curve forward and wraps December into January', () => {
    expect(lagMonths(cal([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]))).toEqual([2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('painting lands in April and October, the months after the expirations', () => {
    const lines = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10, leases });
    const p = L(lines, '6926');
    expect((p.driver as any).shape).toBe('turns');
    expect(sum(p.months)).toBeCloseTo(6000 * (1 + (p.driver as any).pct), 0);
    expect(p.months[3]).toBeGreaterThan(0); expect(p.months[9]).toBeGreaterThan(0);
    expect(p.months.filter((v) => v).length).toBe(2);
    expect(TURN_EXPENSE_GLS.has('6926') && TURN_EXPENSE_GLS.has('7006')).toBe(true);
    // a GL outside the turn set keeps its template shape
    expect((L(lines, '6604').driver as any).shape).not.toBe('turns');
  });
  it('rent-roll / UAD leases beat the template expirations; typed expirations beat both; no expirations → flat', () => {
    const tpl = { leaseExpirations: cal([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]) } as any;
    const fromLeases = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10, leases, template: tpl });
    expect(L(fromLeases, '6926').months.filter((v) => v).length).toBe(2);
    const typed = generateAnnualLines(coaList, { ...inputs, expirations: cal([0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0]) }, { actual, budget: null, lastMonth: 10, leases });
    expect(L(typed, '6926').months[6]).toBeGreaterThan(0); expect(L(typed, '6926').months.filter((v) => v).length).toBe(1);
    const none = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10 });
    expect((L(none, '6926').driver as any).shape).not.toBe('turns');
  });
});

describe('vacancy: an annual average on a carry-over curve (Troy 2026-11-09)', () => {
  const gpr = Array(12).fill(100000) as Months;
  // expirations by calendar month: heavy in summer
  const exp = [2, 2, 4, 6, 10, 14, 16, 12, 6, 4, 2, 2] as Months;
  const flat5 = Array(12).fill(0.05);
  const wmean = (p: number[], g: number[]) => p.reduce((a, v, i) => a + v * g[i], 0) / sum(g);

  it('the year always averages the input, whatever the starting point', () => {
    for (const startPct of [null, 0.02, 0.05, 0.09]) {
      const v = vacancyByMonth(flat5, exp, gpr, 1, { startPct, lastMonth: 10 });
      expect(v.shaped).toBe('expirations');
      expect(wmean(v.pcts, gpr)).toBeCloseTo(0.05, 5);
    }
  });
  it('not 1:1 with expirations: vacancy carries over, so the peak is later and far flatter than the expiration curve', () => {
    const v = vacancyByMonth(flat5, exp, gpr, 1, { startPct: 0.05, lastMonth: 10 });
    // expirations swing 8:1 (16 vs 2); vacancy must swing far less
    expect(Math.max(...v.pcts) / Math.min(...v.pcts)).toBeLessThan(3);
    // July's 16 expirations vacate in August and keep weighing on the following months:
    // the peak is August or later, never before
    expect(v.pcts.indexOf(Math.max(...v.pcts))).toBeGreaterThanOrEqual(7);
    // every month carries some vacancy — none drops to zero
    expect(Math.min(...v.pcts)).toBeGreaterThan(0.01);
  });
  it('starts from the last actual month: a high recent vacancy does not vanish by January', () => {
    const low = vacancyByMonth(flat5, exp, gpr, 1, { startPct: 0.03, lastMonth: 10 });
    const high = vacancyByMonth(flat5, exp, gpr, 1, { startPct: 0.10, lastMonth: 10 });
    expect(high.pcts[0]).toBeGreaterThan(low.pcts[0]);
    // 10% posted in October, 85% carried each winter month: January is still well above half of it
    expect(high.pcts[0]).toBeGreaterThan(0.05);
    expect(high.startPct).toBe(0.10);
  });
  it('with a normal starting point Q1 runs lighter than Q4 (winter fills slowly after the fall move-outs)', () => {
    const real = [10, 10, 13, 20, 35, 45, 42, 43, 39, 31, 24, 8] as Months;
    const v = vacancyByMonth(Array(12).fill(0.0229), real, gpr, 1, { startPct: 0.023, lastMonth: 10 });
    const q = (i: number) => (v.pcts[i] + v.pcts[i + 1] + v.pcts[i + 2]) / 3;
    expect(q(0)).toBeLessThan(q(9));
  });
  it('weight blends toward flat; 0 is flat; no expirations is flat; twelve typed values are kept', () => {
    const full = vacancyByMonth(flat5, exp, gpr, 1, { startPct: 0.05, lastMonth: 10 }).pcts;
    const half = vacancyByMonth(flat5, exp, gpr, 0.5, { startPct: 0.05, lastMonth: 10 }).pcts;
    expect(half[7]).toBeCloseTo((full[7] + 0.05) / 2, 5);
    expect(vacancyByMonth(flat5, exp, gpr, 0)).toMatchObject({ shaped: 'flat', pcts: flat5 });
    expect(vacancyByMonth(flat5, zero12(), gpr)).toMatchObject({ shaped: 'flat', pcts: flat5 });
    const typed = [0.03, 0.03, 0.04, 0.05, 0.06, 0.07, 0.07, 0.06, 0.05, 0.04, 0.03, 0.03];
    expect(vacancyByMonth(typed, exp, gpr)).toMatchObject({ shaped: 'typed', pcts: typed });
  });
  it('a partial expiration schedule (a few months only) never piles the year onto those months — flat', () => {
    const partial = [0, 0, 0, 0, 0, 0, 0, 0, 2, 29, 0, 0] as Months;
    expect(vacancyByMonth(flat5, partial, gpr)).toMatchObject({ shaped: 'flat', pcts: flat5 });
  });
  it('an average below what the carry-over alone leaves keeps the decay shape, scaled to the average', () => {
    const v = vacancyByMonth(Array(12).fill(0.005), exp, gpr, 1, { startPct: 0.10, lastMonth: 10 });
    expect(wmean(v.pcts, gpr)).toBeCloseTo(0.005, 5);
    expect(v.pcts[0]).toBeGreaterThan(v.pcts[11]);
  });
  it('rising GPR: the average is GPR-weighted, so vacancy $ ties to average x the year GPR', () => {
    const g = Array.from({ length: 12 }, (_, i) => 100000 + i * 1000) as Months;
    const v = vacancyByMonth(flat5, exp, g, 1, { startPct: 0.04, lastMonth: 10 });
    expect(v.pcts.reduce((a, p, i) => a + p * g[i], 0)).toBeCloseTo(0.05 * sum(g), 0);
  });
  it('engine: 5031 follows the curve from the last actual month and totals the average to the cent', () => {
    const actual = synthetic();
    const inputs = { ...baseInputs(2026, 10, actual, null, coaList, null, 10), vacancyPct: flat5 as Months, expirations: exp };
    const ls = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10 });
    const vacL = L(ls, '5031'), gprL = L(ls, '4994');
    expect((vacL.driver as any).shaped).toBe('expirations');
    expect(sum(vacL.months)).toBeCloseTo(-0.05 * sum(gprL.months), 2);
    expect(vacL.months.every((v) => v < 0)).toBe(true);
    const flat = L(generateAnnualLines(coaList, { ...inputs, vacancyExpWeight: 0 }, { actual, budget: null, lastMonth: 10 }), '5031');
    expect((flat.driver as any).shaped).toBe('flat');
    expect(sum(flat.months)).toBeCloseTo(sum(vacL.months), 0);
  });
});

describe('prior-period collections never exceed delinquency (Troy 2026-11-09)', () => {
  it('5036 is capped month by month at the budgeted 5035; an uncapped line is untouched', () => {
    const actual = synthetic();
    const f = (v: number) => cal(Array(12).fill(v));
    const inputs = baseInputs(2026, 10, actual, null, coaList, null, 10);
    // last year collected 800 a month of older balances against 300 of delinquency
    const over = generateAnnualLines(coaList, inputs, { actual: { ...actual, '5035': f(-300), '5036': f(800) }, budget: null, lastMonth: 10 });
    const dq = L(over, '5035').months, pp = L(over, '5036').months;
    expect(dq.some((v) => v < 0)).toBe(true);
    pp.forEach((v, i) => expect(v).toBeLessThanOrEqual(Math.abs(dq[i]) + 0.005));
    expect((L(over, '5036').driver as any).capped).toBe(true);
    expect((L(over, '5036').driver as any).uncapped).toBeGreaterThan(sum(pp));
    // collections below delinquency: nothing is capped
    const under = generateAnnualLines(coaList, inputs, { actual: { ...actual, '5035': f(-800), '5036': f(300) }, budget: null, lastMonth: 10 });
    expect((L(under, '5036').driver as any).capped).toBeUndefined();
    expect(sum(L(under, '5036').months)).toBeGreaterThan(0);
  });
});

describe('reviewability (2026-11-09): budget column label, dropped lines', () => {
  it('budgetRefLabel names the real window: a calendar year reads "2026 budget", a T12-window budget names its months', () => {
    expect(budgetRefLabel('Jan 2026-Dec 2026')).toBe('2026 budget');
    expect(budgetRefLabel('Nov 2025-Oct 2026')).toBe('budget Nov-25–Oct-26');     // was "2025 budget" on a 2027 budget
    expect(budgetRefLabel('')).toBe('CY budget');
  });
  it('a line the $1,000 rule drops stays at zero but carries a "dropped" driver with its T12; choosing a shape on the row budgets it', () => {
    const actual = { ...synthetic(), '6736': cal(Array(12).fill(50)) };   // $600 of windows a year
    const inputs = baseInputs(2026, 10, actual, null, coaList, null, 10);
    const rules = { '6736': { method: 'flatT12' as const, factor: 0.1 } };
    const l = L(generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10, rules }), '6736');
    expect(sum(l.months)).toBe(0);
    expect(l.driver).toMatchObject({ method: 'dropped', t12: 600, limit: 1000 });
    const picked = L(generateAnnualLines(coaList, { ...inputs, baseline: { ...inputs.baseline!, glShape: { '6736': 'flat' } } }, { actual, budget: null, lastMonth: 10, rules }), '6736');
    expect(sum(picked.months)).toBeCloseTo(660, 0);
  });
});

describe('within-year cost drift (Troy 2026-11-09): expense lines cost a little more late in the year', () => {
  it('tiltMonths: a straight-line tilt, December `drift` above January, year total unchanged to the cent', () => {
    const flat = Array(12).fill(1000) as Months;
    const t = tiltMonths(flat, 0.03);
    expect(sum(t)).toBeCloseTo(12000, 2);
    expect(t[0]).toBeCloseTo(985, 0);
    expect(t[11]).toBeCloseTo(1015, 0);
    for (let i = 1; i < 12; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
    // a seasonal line keeps its season and its total; only the balance shifts later
    const seasonal = [3000, 2500, 1500, 800, 400, 300, 300, 300, 500, 1200, 2200, 2900] as Months;
    const s2 = tiltMonths(seasonal, 0.03);
    expect(sum(s2)).toBeCloseTo(sum(seasonal), 2);
    expect(s2[0]).toBeLessThan(seasonal[0]);
    expect(s2[11]).toBeGreaterThan(seasonal[11]);
    expect(tiltMonths(flat, 0)).toEqual(flat);
  });
  it('engine: on by default (3%) for admin / marketing / utilities / R&M / rehab; totals match the no-drift budget', () => {
    const actual = { ...synthetic(), '6332': cal(Array(12).fill(400)), '6622': cal(Array(12).fill(3000)), '6920': cal(Array(12).fill(2000)) };
    const on = defaultAnnualInputs(2026, 10, actual, null, coaList, null, 10);
    const off = { ...on, baseline: { ...on.baseline!, costDrift: 0 } };
    expect(COST_DRIFT_DEFAULT).toBe(0.03);
    const a = generateAnnualLines(coaList, on, { actual, budget: null, lastMonth: 10 });
    const b = generateAnnualLines(coaList, off, { actual, budget: null, lastMonth: 10 });
    for (const gl of ['6332', '6622', '6920']) {
      const x = L(a, gl), y = L(b, gl);
      expect(sum(x.months)).toBeCloseTo(sum(y.months), 2);          // the year does not move
      expect(x.months[11]).toBeGreaterThan(x.months[0]);            // it lands later
      expect(x.months[11] / x.months[0]).toBeCloseTo(1.03 / 0.97 * 0.97 / 0.985 * 0.985 / 1, 1);   // roughly 3% end over start
      expect((x.driver as any).drift).toBe(0.03);
      expect((y.driver as any).drift).toBeUndefined();
    }
    // NOI for the year is identical with and without it
    const noi = (ls: BudgetLine[]) => sum(rollup(new Map(ls.map((l) => [l.gl_code, l.months]))).get('7280')!);
    expect(noi(a)).toBeCloseTo(noi(b), 0);
  });
  it('not applied to payroll, real estate taxes, corporate rates or contract-flat (last month) lines', () => {
    const actual = { ...synthetic(), '6116': cal(Array(12).fill(10000)), '6616': cal(Array(12).fill(300)) };
    const on = defaultAnnualInputs(2026, 10, actual, null, coaList, null, 10);
    const ls = generateAnnualLines(coaList, on, { actual, budget: null, lastMonth: 10 });
    for (const gl of ['6116', '6616', '6402', '6418', '6108']) {
      const l = L(ls, gl);
      if (!l || !sum(l.months)) continue;
      expect((l.driver as any).drift).toBeUndefined();
    }
    expect(new Set(L(ls, '6116').months).size).toBe(1);
  });
});

describe('saved formula sets (Troy 2026-11-09): the recipe of a budget, without its hard codes', () => {
  const actual = { ...synthetic(), '6332': cal(Array(12).fill(400)), '6622': cal(Array(12).fill(3000)), '6920': cal(Array(12).fill(2000)), '6736': cal(Array(12).fill(300)) };
  const src: AnnualSources = { actual, budget: null, lastMonth: 10 };
  const base = defaultAnnualInputs(2026, 10, actual, null, coaList, null, 10);
  // the SOURCE budget: its own per-GL choices, a category factor, and one hand-typed line
  const srcInputs = { ...base, rules: {}, baseline: { ...base.baseline!, growthPct: { '13': 0.08 }, costDrift: 0.02, glShape: { '6332': 'flat' as const, '6622': 'wavg' as const }, glGrowth: { '6332': 0.04 }, glMround: { '6622': 50 } }, ltl: { ...base.ltl, renewalPct: 0.9, burnoffRenew: 0.2 } };
  const built = generateAnnualLines(coaList, srcInputs, src).map((l) => (l.gl_code === '6736' ? { ...l, override: true, months: cal(Array(12).fill(999)), driver: { method: 'manual' } as any } : l));
  const set = formulaSetFromBudget(built, srcInputs);

  it('saves each history-based line as shape / factor / MROUND, and the formula settings', () => {
    expect(set.rules['6332']).toMatchObject({ method: 'flatT12', factor: 0.04, noThreshold: true });
    expect(set.rules['6622']).toMatchObject({ method: 'wavg', mround: 50 });
    expect(set.rules['6920']).toMatchObject({ method: 'same', factor: 0.08 });          // the category factor, resolved per line
    expect(set.settings.baseline).toMatchObject({ costDrift: 0.02, growthPct: { '13': 0.08 } });
    expect(set.settings.ltl).toMatchObject({ renewalPct: 0.9, burnoffRenew: 0.2 });
  });
  it('leaves out the hard codes: hand-typed lines, dollars, GPR, the vacancy average, expirations', () => {
    expect(set.rules['6736']).toBeUndefined();                       // typed by hand
    expect(set.rules['4994']).toBeUndefined();                       // engine lines carry no rule
    const flat = JSON.stringify(set);
    for (const k of ['baseMonthly', 'startMonthly', 'vacancyPct', 'expirations', 'corpRates', 'turnFees', 'units', 'capital', 'glShape']) expect(flat).not.toContain(k);
  });
  it('applied to another budget it reproduces the formulas on THAT property\'s history and keeps its own data', () => {
    const other = { ...actual, '6332': cal(Array(12).fill(1000)), '6622': cal(Array(12).fill(5000)) };
    const tBase = defaultAnnualInputs(2026, 20, other, null, coaList, null, 10);
    const target = applyFormulaSet({ ...tBase, vacancyPct: Array(12).fill(0.07) as Months, baseline: { ...tBase.baseline!, glShape: { '6920': 'last' as const } } }, set, { id: 7, name: 'CLND 2027' });
    expect(target.rulesFrom).toMatchObject({ id: 7, name: 'CLND 2027' });
    expect(target.vacancyPct![0]).toBe(0.07);                        // the target's own assumption stays
    expect(target.units).toBe(20);
    expect(target.baseline!.glShape).toEqual({});                    // its old per-line choices are replaced by the set
    expect(target.ltl!.renewalPct).toBe(0.9);
    const ls = generateAnnualLines(coaList, target, { actual: other, budget: null, lastMonth: 10, rules: target.rules as any });
    expect(sum(L(ls, '6332').months)).toBeCloseTo(12000 * 1.04, 0);  // flat x 4% on the TARGET's history
    expect((L(ls, '6332').driver as any).shape).toBe('flat');
    expect((L(ls, '6622').driver as any).shape).toBe('wavg');
    expect((L(ls, '6622').driver as any).mult).toBe(50);
    expect((L(ls, '6920').driver as any).pct).toBeCloseTo(0.08, 6);
  });
  it('a zero-out in the set stays zero on the target; "template defaults" is an empty rule set', () => {
    const z = formulaSetFromBudget(built.map((l) => (l.gl_code === '6920' ? { ...l, months: zero12(), driver: { method: 'zero' } as any } : l)), srcInputs);
    expect(z.rules['6920']).toEqual({ method: 'zero' });
    const t = applyFormulaSet(base, z, { id: 1, name: 'z' });
    const ls = generateAnnualLines(coaList, t, { ...src, rules: t.rules as any });
    expect(sum(L(ls, '6920').months)).toBe(0);
    expect((L(ls, '6920').driver as any).method).toBe('zero');
    const tpl = applyFormulaSet(base, { rules: {}, settings: {} }, { id: null, name: 'Template defaults' });
    expect(tpl.rules).toEqual({});
  });
});
