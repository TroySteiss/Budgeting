import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateAnnualLines, regenerateAnnual, defaultAnnualInputs, tiltMonths, COST_DRIFT_DEFAULT, formulaSetFromBudget, applyFormulaSet, mgmtFeeRates, summaryColumn, sumSummaryCols, summaryLabels, stmtCalendar, stmtLastMonth, stmtAnnualized, trailing12, annualizedFromCal,
  refFromCalendar, refColumn, annualBaseline, expirationsFromLeases, CORP_RATES, corpRatesFor, vacancyByMonth, budgetRefLabel, gprStepsForTarget, gprStepsSummary, lagMonths, TURN_EXPENSE_GLS, applyT12Adjust, contractMonths, flatFeeFromSchedule, guidanceCheck, fitToT12, noiQuarters, qShiftTargets, normalizeGuidance, type TemplateData, type AnnualSources,
  refollowMgmtFee,
} from '../shared/annual.js';
import { sum, zero12, rollup, CURVES, type CoaAccount, type Months, type BudgetLine } from '../shared/domain.js';
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
    expect(L(lines, '6116').months).toEqual(Array(12).fill(952.75));       // (9 × 900 + 3 × 1,000) ÷ 12, × 1.03 (RE taxes grow 3% by default)
    expect((L(lines, '6116').driver as any).shape).toBe('flat');
    const small = { ...actual, '6116': cal(Array(12).fill(50)) };          // T12 600 ≤ 1,000 still budgets
    expect(L(generateAnnualLines(coaList, inputs, { ...src, actual: small }), '6116').months[0]).toBe(51.5);
    // the GRKS rule for 6116 is `fixedAnnual` (RMC typed an annual) — same flat default, rule carried
    const withRule = L(generateAnnualLines(coaList, inputs, { ...src, rules: { '6116': { method: 'fixedAnnual' } } }), '6116');
    expect(withRule.months).toEqual(Array(12).fill(952.75));
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
    expect((L(lines, '5036').driver as any).method).toBe('collections');   // a rate on the previous month's delinquency
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
    // January = the rent roll (24 × 100). MTM leases take months 0..10 (two in the first slot); a lease
    // re-prices the month after it ends, so February has 3 fewer, then 2 a month; the Dec-1 lease is
    // still on its rent in December
    expect(l.months[0]).toBe(-2400);
    expect(l.months[1]).toBe(-2100);
    for (let i = 2; i < 12; i++) expect(l.months[i]).toBe(l.months[i - 1] + 200);
    expect(l.months[11]).toBe(-100);
    // with 12% GPR growth in month 2 and "follows GPR": every lease's gap is measured against the
    // grown market ($1,120). The 21 not-yet-reset leases carry 100 + 120; January's 3 re-prices start
    // in February, so they sign into the grown market.
    const grow = { ...noGrow, ltl: { ...noGrow.ltl, followGpr: true }, gpr: { ...inputs.gpr, growthPct: [0, 0.12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as Months } };
    const l2 = L(generateAnnualLines(coaList, grow, { ...src, leases }), '5003');
    expect(l2.months[1]).toBeCloseTo(-(21 * 220), 0);
    // December: every lease but the Dec-1 one has re-priced at the grown market
    expect(l2.months[11]).toBeCloseTo(-220, 0);
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
    expect(half.months[11]).toBeCloseTo(-(23 * 65) - 130, 0);   // 23 re-price at the grown market, halving 130; the Dec-1 lease is still on its rent   // January's 2 halved before the step, then +30; the other 22 halve 130
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
  it('a lease ending between the roll date and the budget start re-prices first thing (from month 1; January stays the roll) with the renewal mix, not MTM all year', () => {
    const actual = synthetic();
    const inputs = baseInputs(2026, 10, actual, null, coaList, null, 10);
    const noGrow = { ...inputs, ltl: { ...inputs.ltl, mode: 'leases' as const, renewalPct: 0, burnoffNew: 1, followGpr: false } };
    // 12 leases ending 15 Dec 2025 (gap $100 each), roll as of 30 Sep 2025, budget Jan 2026
    const leases = Array.from({ length: 12 }, () => ({ m: 1000, r: 900, e: '2025-12-15' }));
    const stale = L(generateAnnualLines(coaList, noGrow, { actual, budget: null, lastMonth: 10, leases }), '5003');
    expect(stale.months[0]).toBe(-1200);                                   // January = the rent roll
    expect(stale.months[1]).toBe(-1000);                                   // no as-of: treated as MTM, 1 resets a month
    const fresh = L(generateAnnualLines(coaList, noGrow, { actual, budget: null, lastMonth: 10, leases, rollAsOf: '2025-09-30' }), '5003');
    expect(fresh.months[0]).toBe(-1200);                                   // January = the rent roll
    expect(fresh.months[1]).toBe(0);                                       // all 12 turned before January
    const expired = L(generateAnnualLines(coaList, noGrow, { actual, budget: null, lastMonth: 10, leases: leases.map((l) => ({ ...l, e: '2025-06-01' })), rollAsOf: '2025-09-30' }), '5003');
    expect(expired.months[1]).toBe(-1000);                                 // already expired at the roll → still MTM
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
    const t = trailing12([ecnd], { excludeStartup: 0 })!;      // the dead-month rule on its own (start-up months tested below)
    expect(t.dead).toEqual(['Oct 2025', 'Nov 2025']);
    expect(t.liveMonths).toBe(10);
    expect(t.period).toBe('Oct 2025-Sep 2026 · 10 mo annualized');
    expect(t.cal['4994'][9]).toBe(1000); expect(t.cal['4994'][10]).toBe(1000);           // Oct/Nov = live average
    expect(t.cal['6604'][10]).toBe(100);                                                 // the closing entry is gone
    expect(sum(t.cal['6604'])).toBe(1200);                                               // 10 live months annualized
    expect(sum(t.cal['4994'])).toBe(12000);
  });
});

describe('new acquisition start-up months (Troy 2026-11-09): the first month is left out; months 2-3 are flagged', () => {
  const stmt = (gprs: number[], elec: number[]) => ({
    monthCal: [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], monthYear: [2025, 2025, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026],
    rows: [{ gl: '4994', name: 'GPR', months: gprs, total: 0 }, { gl: '6604', name: 'Electric', months: elec, total: 0 }],
  });
  it('acquired mid-August: August (a partial month) is left out; September and October are the whole history and are flagged', () => {
    //                      Nov Dec Jan Feb Mar Apr May Jun Jul  Aug   Sep   Oct
    const s3 = stmt([0, 0, 0, 0, 0, 0, 0, 0, 0, 400, 1000, 1000], [0, 0, 0, 0, 0, 0, 0, 0, 0, 9000, 100, 120]);
    const t = trailing12([s3])!;
    expect(t.startup).toEqual(['Aug 2026']);
    expect(t.early).toEqual(['Sep 2026', 'Oct 2026']);
    expect(t.liveMonths).toBe(2);
    expect(t.period).toContain('2 mo annualized');
    // the partial rent month and the closing-month electric bill are gone: every month is the Sep/Oct average
    expect(t.cal['4994'].every((v) => v === 1000)).toBe(true);
    expect(sum(t.cal['6604'])).toBe(12 * 110);
    // the old behaviour (nothing left out) would have averaged the 9,000 in
    expect(sum(trailing12([s3], { excludeStartup: 0 })!.cal['6604'])).toBeGreaterThan(30000);
  });
  it('acquired last December: December is left out, January and February are flagged, the rest is trusted', () => {
    const s11 = stmt([0, 500, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], [0, 7000, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const t = trailing12([s11])!;
    expect(t.dead).toEqual(['Nov 2025']);
    expect(t.startup).toEqual(['Dec 2025']);
    expect(t.early).toEqual(['Jan 2026', 'Feb 2026']);
    expect(t.liveMonths).toBe(10);
    expect(sum(t.cal['6604'])).toBe(1200);
    // leaving two or three months out is a setting; at least two months always remain
    expect(trailing12([s11], { excludeStartup: 3 })!.startup).toEqual(['Dec 2025', 'Jan 2026', 'Feb 2026']);
    expect(trailing12([s11], { excludeStartup: 3 })!.early).toEqual([]);
  });
  it('a property with a full year of operations is untouched', () => {
    const full = stmt(Array(12).fill(1000), Array(12).fill(100));
    const t = trailing12([full])!;
    expect(t.startup || []).toEqual([]);
    expect(t.dead).toEqual([]);
    expect(t.liveMonths).toBe(12);
  });
  it('only two months of operations: nothing more can be left out', () => {
    const s2 = stmt([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 600, 1000], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 100]);
    const t = trailing12([s2])!;
    expect(t.startup).toEqual([]);
    expect(t.early).toEqual(['Sep 2026', 'Oct 2026']);
    expect(t.liveMonths).toBe(2);
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
    expect(sum(L(lines, '6116').months)).toBeCloseTo(101838.76 * 1.03, 0);   // RE tax: T12 flat × 1.03 (the 3% default), not RMC's typed 103,355 (October × 12)
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
      expect(sum(L(lines, '6116').months)).toBeCloseTo(101838.76 * 1.03, 0);   // × 1.03: the RE tax default
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
    for (const gl of ['6320', '6560']) expect(corpRatesFor(2027)[gl]).toEqual(CORP_RATES[gl]);
  });
  it('6108 insurance is the $275 blanket rate from 2027 on; 2026 keeps $285', () => {
    expect(corpRatesFor(2026)['6108'].perUnitYr).toBe(285);
    expect(corpRatesFor(2027)['6108'].perUnitYr).toBe(275);
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

describe('prior-period collections follow the previous month\'s delinquency (Troy 2026-11-09)', () => {
  const actual = synthetic();
  const f = (v: number) => cal(Array(12).fill(v));
  const inputs = baseInputs(2026, 10, actual, null, coaList, null, 10);

  it('each month = the collection rate x the PREVIOUS month\'s budgeted delinquency; January uses the last actual month', () => {
    // history: 800 of delinquency and 300 collected a month -> a 37.5% collection rate
    const ls = generateAnnualLines(coaList, inputs, { actual: { ...actual, '5035': f(-800), '5036': f(300) }, budget: null, lastMonth: 10 });
    const dq = L(ls, '5035').months, pp = L(ls, '5036').months, d = L(ls, '5036').driver as any;
    expect(d.method).toBe('collections');
    expect(d.pct).toBeCloseTo(0.375, 4);
    expect(pp[0]).toBeCloseTo(0.375 * 800, 1);                       // against October's actual delinquency
    for (let i = 1; i < 12; i++) expect(pp[i]).toBeCloseTo(0.375 * Math.abs(dq[i - 1]), 1);
  });
  it('higher delinquency one month means higher collections the NEXT month', () => {
    // loss to lease held (not following GPR), so a GPR step in June raises net rent and with it delinquency
    const held = { ...inputs, ltl: { ...inputs.ltl, mode: 'flat' as const, followGpr: false } };
    const base = generateAnnualLines(coaList, held, { actual: { ...actual, '5035': f(-800), '5036': f(300) }, budget: null, lastMonth: 10 });
    const stepped = generateAnnualLines(coaList, { ...held, gpr: { ...held.gpr, growthPct: [0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0] as Months } }, { actual: { ...actual, '5035': f(-800), '5036': f(300) }, budget: null, lastMonth: 10 });
    const dq = L(stepped, '5035').months, pp = L(stepped, '5036').months;
    const dq0 = L(base, '5035').months, pp0 = L(base, '5036').months;
    expect(Math.abs(dq[5])).toBeGreaterThan(Math.abs(dq0[5]) * 1.2);   // June delinquency is well above the no-step budget…
    expect(pp[6]).toBeGreaterThan(pp0[6] * 1.2);                       // …and July collections rise with it
    expect(pp[6] / pp0[6]).toBeCloseTo(Math.abs(dq[5]) / Math.abs(dq0[5]), 3);
  });
  it('never more than the delinquency it collects against: a trailing-12 that collected more is capped at 100%', () => {
    const ls = generateAnnualLines(coaList, inputs, { actual: { ...actual, '5035': f(-300), '5036': f(800) }, budget: null, lastMonth: 10 });
    const dq = L(ls, '5035').months, pp = L(ls, '5036').months, d = L(ls, '5036').driver as any;
    expect(d.pct).toBe(1);
    expect(d.capped).toBe(true);
    for (let i = 1; i < 12; i++) expect(pp[i]).toBeLessThanOrEqual(Math.abs(dq[i - 1]) + 0.005);
    expect(sum(pp)).toBeLessThanOrEqual(Math.abs(sum(dq)) + 300 + 0.01);
  });
  it('a typed collection rate wins; with no delinquency budgeted the old ratio to net GPR still applies', () => {
    const typed = generateAnnualLines(coaList, { ...inputs, collectPct: 0.5 }, { actual: { ...actual, '5035': f(-800), '5036': f(300) }, budget: null, lastMonth: 10 });
    expect((L(typed, '5036').driver as any).pct).toBe(0.5);
    const none = generateAnnualLines(coaList, inputs, { actual: { ...actual, '5035': f(0), '5036': f(300) }, budget: null, lastMonth: 10 });
    expect((L(none, '5036').driver as any).method).toBe('pctGpr');
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
  it('"Zero out row" (saved as an edited line) travels with the set; a zeroed row typed over does not', () => {
    const zr = built.map((l) => (l.gl_code === '6920' ? { ...l, override: true, months: zero12(), driver: { method: 'zero' } as any } : l));
    const z = formulaSetFromBudget(zr, srcInputs);
    expect(z.rules['6920']).toEqual({ method: 'zero' });
    const t = applyFormulaSet(base, z, { id: 1, name: 'z' });
    const ls = generateAnnualLines(coaList, t, { ...src, rules: t.rules as any });
    expect(sum(L(ls, '6920').months)).toBe(0);
    const typed = formulaSetFromBudget(built.map((l) => (l.gl_code === '6920' ? { ...l, override: true, months: cal(Array(12).fill(50)), driver: { method: 'zero', revised: true } as any } : l)), srcInputs);
    expect(typed.rules['6920']).toBeUndefined();
  });
  it('increase %s land as picked: a row % and a section % under a typed category % keep their own %', () => {
    const a6920 = coaList.find((a) => a.code === '6920')!;
    const sec = coaList.find((a) => a.code === '6332')!.section!;
    const inp = { ...srcInputs, baseline: { ...srcInputs.baseline!, glGrowth: { ...srcInputs.baseline!.glGrowth, '6920': 0.05 }, secGrowth: { [sec]: 0.06 }, growthPct: { [a6920.pcode!]: 0.08, [coaList.find((a) => a.code === '6332')!.pcode!]: 0.02 } } };
    const ls0 = generateAnnualLines(coaList, inp, src);
    const s2 = formulaSetFromBudget(ls0, inp);
    expect(s2.row!.glGrowth!['6920']).toBe(0.05);
    expect(s2.row!.secGrowth).toEqual({ [sec]: 0.06 });
    const t = applyFormulaSet(base, s2, { id: 2, name: 'pct' });
    const ls = generateAnnualLines(coaList, t, { ...src, rules: t.rules as any });
    expect((L(ls, '6920').driver as any).pct).toBeCloseTo(0.05, 6);        // not the 8% category
    const secLine = coaList.find((a) => a.section === sec && a.kind === 'detail' && a.code !== '6332' && L(ls0, a.code) && (L(ls0, a.code).driver as any)?.method === 'baseline');
    if (secLine) expect((L(ls, secLine.code).driver as any).pct).toBeCloseTo((L(ls0, secLine.code).driver as any).pct, 6);
    expect((L(ls, '6332').driver as any).pct).toBeCloseTo((L(ls0, '6332').driver as any).pct, 6);
  });
});

describe('first-year management fee (Troy 2026-11-09): 3% for the first 12 months of ownership, then the regular %', () => {
  it('mgmtFeeRates: the rate follows the month the income was earned (the fee bills in arrears)', () => {
    // ownership began Aug 2026 -> first 12 months Aug-26..Jul-27. In a 2027 budget the fees posted
    // Jan..Aug are on Dec-26..Jul-27 income (first year); Sep onward is the regular rate.
    const r = mgmtFeeRates(2027, 1, 0.04, { pct: 0.03, start: '2026-08' });
    expect(r.rates).toEqual([0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.04, 0.04, 0.04, 0.04]);
    expect(r.firstMonths).toBe(8);
    expect(r.through).toBe('Jul 2027');
    // ownership more than a year back, no first-year %, or the same % -> the regular rate all year
    expect(mgmtFeeRates(2027, 1, 0.04, { pct: 0.03, start: '2025-12' }).rates.every((v) => v === 0.04)).toBe(true);
    expect(mgmtFeeRates(2027, 1, 0.04, { pct: null, start: '2026-08' }).firstMonths).toBe(0);
    expect(mgmtFeeRates(2027, 1, 0.04, null).firstMonths).toBe(0);
    // bought in January of the budget year: January's fee is on December (before ownership) -> regular; Feb..Dec first year
    expect(mgmtFeeRates(2027, 1, 0.04, { pct: 0.03, start: '2027-01' }).rates).toEqual([0.04, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03]);
  });
  it('engine: 6112 uses 3% while the income month is inside the first year, 4% after; a typed first-year wins; none typed = flat', () => {
    const actual = synthetic();
    const inputs = { ...baseInputs(2027, 10, actual, null, coaList, null, 10), mgmtPct: 0.04 };
    const src: AnnualSources = { actual, budget: null, lastMonth: 10 };
    const incomeOf = (ls: BudgetLine[]) => rollup(new Map(ls.map((l) => [l.gl_code, l.months]))).get('5500')!;
    const a = generateAnnualLines(coaList, inputs, { ...src, acquisition: { start: '2026-08', firstYearPct: 0.03 } });
    const inc = incomeOf(a), fee = L(a, '6112');
    expect(fee.months[1]).toBe(Math.round(inc[0] * 0.03));           // Feb fee on Jan income: first year
    expect(fee.months[7]).toBe(Math.round(inc[6] * 0.03));           // Aug fee on Jul income: still first year
    expect(fee.months[8]).toBe(Math.round(inc[7] * 0.04));           // Sep fee on Aug income: regular
    expect((fee.driver as any).firstYear).toMatchObject({ pct: 0.03, months: 8, through: 'Jul 2027' });
    const flat = L(generateAnnualLines(coaList, inputs, src), '6112');
    expect(flat.months[1]).toBe(Math.round(inc[0] * 0.04));
    expect((flat.driver as any).firstYear).toBeUndefined();
    // typed on the budget: no first-year rate even though one is on file
    const off = L(generateAnnualLines(coaList, { ...inputs, mgmtFirstYear: { pct: null, start: '2026-08' } }, { ...src, acquisition: { start: '2026-08', firstYearPct: 0.03 } }), '6112');
    expect((off.driver as any).firstYear).toBeUndefined();
  });
});

describe('a shape chosen on the row works on ANY line (Troy 2026-11-09: "Flat + growth over T12 needs to be an option for all lines")', () => {
  const actual: Record<string, Months> = { ...synthetic(), '6332': cal(Array(12).fill(400)) };
  const base = baseInputs(2026, 10, actual, null, coaList, null, 10);
  const src: AnnualSources = { actual, budget: null, lastMonth: 10 };
  const flatOn = (gl: string, g: number, extra: Partial<AnnualSources> = {}) => {
    const inp = { ...base, baseline: { ...base.baseline!, glShape: { [gl]: 'flat' as const }, glGrowth: { [gl]: g } } };
    return generateAnnualLines(coaList, inp, { ...src, ...extra });
  };
  const t12 = (gl: string) => sum(actual[gl] || zero12());
  const isFlatAt = (l: BudgetLine, total: number) => {
    expect((l.driver as any).method).toBe('baseline');
    expect((l.driver as any).shape).toBe('flat');
    expect(sum(l.months)).toBeCloseTo(total, 0);
    expect(Math.max(...l.months) - Math.min(...l.months)).toBeLessThan(0.02);
  };

  it('engine-driven lines take it: GPR, loss to lease, vacancy, delinquency, the fee, a corporate-rate line, interest', () => {
    for (const gl of ['4994', '5003', '5031', '5035', '6112', '6108', '7300']) {
      if (!t12(gl)) continue;
      isFlatAt(L(flatOn(gl, 0.04), gl), t12(gl) * 1.04);
    }
    expect(t12('4994')).toBeGreaterThan(0);
    expect(t12('6112')).not.toBe(0);
  });
  it('GPR on a chosen shape is what the % of GPR lines and vacancy read', () => {
    const ls = flatOn('4994', 0.10);
    const gpr = L(ls, '4994').months;
    expect(gpr[0]).toBeCloseTo((t12('4994') / 12) * 1.10, 1);
    const vacPct = (base.vacancyPct || [])[0] || 0;
    expect(sum(L(ls, '5031').months)).toBeCloseTo(-vacPct * sum(gpr), 0);
  });
  it('a wage line on a chosen shape still drives the payroll burden lines', () => {
    const roster = { payrollWages: { '6402': 30000 }, wagesLive: { label: 'c', effective: '2026-01', draft: false } };
    const plain = generateAnnualLines(coaList, base, { ...src, ...roster });
    const shaped = flatOn('6402', 0, roster);
    isFlatAt(L(shaped, '6402'), t12('6402'));                         // the row's T12, not the roster's 30,000
    const ratio = sum(L(plain, '6418').months) / sum(L(plain, '6402').months);
    expect(sum(L(shaped, '6418').months) / sum(L(shaped, '6402').months)).toBeCloseTo(ratio, 3);
  });
  it('flat means flat: no cost drift on a line whose shape was chosen on the row; removing the choice restores the formula', () => {
    const drifting = { ...defaultAnnualInputs(2026, 10, actual, null, coaList, null, 10) };
    const auto = L(generateAnnualLines(coaList, drifting, src), '6332');
    expect((auto.driver as any).drift).toBe(0.03);
    const chosen = L(generateAnnualLines(coaList, { ...drifting, baseline: { ...drifting.baseline!, glShape: { '6332': 'flat' as const }, glGrowth: { '6332': 0.05 } } }, src), '6332');
    expect((chosen.driver as any).drift).toBeUndefined();
    isFlatAt(chosen, 4800 * 1.05);
    expect((L(generateAnnualLines(coaList, base, src), '4994').driver as any).method).toBe('gpr');
  });
});

describe('section increase % (Troy 2026-11-10): typed on a section header, flows to its lines, never over a row\'s own choice', () => {
  const actual: Record<string, Months> = { ...synthetic(), '6332': cal(Array(12).fill(400)), '6334': cal(Array(12).fill(200)), '6920': cal(Array(12).fill(2000)), '6728': cal(Array(12).fill(1000)) };
  const base = baseInputs(2026, 10, actual, null, coaList, null, 10);
  const src: AnnualSources = { actual, budget: null, lastMonth: 10 };
  const sectionOf = (gl: string) => coaList.find((a) => a.code === gl)!.section;
  const pctOf = (ls: BudgetLine[], gl: string) => (L(ls, gl).driver as any).pct;
  const withSec = (extra: object = {}) => ({ ...base, baseline: { ...base.baseline!, secGrowth: { [sectionOf('6332')]: 0.07 }, ...extra } });

  it('every history-based line of the section takes it; other sections are untouched', () => {
    expect(sectionOf('6332')).toBe(sectionOf('6334'));
    expect(sectionOf('6920')).not.toBe(sectionOf('6332'));
    const before = generateAnnualLines(coaList, base, src), after = generateAnnualLines(coaList, withSec(), src);
    expect(pctOf(after, '6332')).toBe(0.07);
    expect(pctOf(after, '6334')).toBe(0.07);
    expect(sum(L(after, '6332').months)).toBeCloseTo(4800 * 1.07, 0);
    expect(pctOf(after, '6920')).toBe(pctOf(before, '6920'));          // contract services: not this section
    expect(sum(L(after, '6728').months)).toBeCloseTo(sum(L(before, '6728').months), 2);
  });
  it('a % typed on the row wins over the section; the section wins over the category % and the formula set', () => {
    const rowTyped = generateAnnualLines(coaList, withSec({ glGrowth: { '6334': 0.02 } }), src);
    expect(pctOf(rowTyped, '6334')).toBe(0.02);                        // the row keeps its own
    expect(pctOf(rowTyped, '6332')).toBe(0.07);
    const cat = coaList.find((a) => a.code === '6332')!.pcode!;
    const overCat = generateAnnualLines(coaList, withSec({ growthPct: { [cat]: 0.01 } }), { ...src, rules: { '6332': { method: 'flatT12', factor: 0.25, noThreshold: true } } });
    expect(pctOf(overCat, '6332')).toBe(0.07);
  });
  it('a hand-typed line is not touched when the section % is applied on a recalculation', () => {
    const first = generateAnnualLines(coaList, base, src).map((l) => (l.gl_code === '6334' ? { ...l, override: true, months: cal(Array(12).fill(999)), driver: { method: 'manual' } as any } : l));
    const again = regenerateAnnual(first, coaList, withSec(), src);
    expect(L(again, '6334').months.every((v) => v === 999)).toBe(true);
    expect(L(again, '6334').override).toBe(true);
    expect(pctOf(again, '6332')).toBe(0.07);
  });
  it('a saved formula set carries the resulting per-line factors, and applying a set clears the target\'s own section %', () => {
    const built = generateAnnualLines(coaList, { ...withSec(), rules: {} }, src);
    const set = formulaSetFromBudget(built, { ...withSec(), rules: {} });
    expect(set.rules['6332'].factor).toBe(0.07);
    const target = applyFormulaSet({ ...withSec(), baseline: { ...withSec().baseline!, secGrowth: { other: 0.09 } } }, set, { id: 1, name: 's' });
    expect(target.baseline!.secGrowth).toEqual(withSec().baseline!.secGrowth);   // the set's, not the target's own
  });
});

describe('payroll ratios from another property (Troy 2026-11-10): the % of wages AND its monthly shape are borrowed; wages stay your own', () => {
  const f = (v: number) => cal(Array(12).fill(v));
  // this property: thin, flat history — taxes 10% of wages every month, no bonus line at all
  const own: Record<string, Months> = { ...synthetic(), '6402': f(2000), '6404': f(0), '6418': f(200), '6408': f(0) };
  // the donor: taxes 12% of wages, and a quarterly bonus (Jan / Apr / Jul / Oct) worth 25% of that month's wages
  const donorActual: Record<string, Months> = { '6402': f(5000), '6418': f(600), '6408': cal([1250, 0, 0, 1250, 0, 0, 1250, 0, 0, 1250, 0, 0]) };
  const inputs = baseInputs(2027, 10, own, null, coaList, null, 10);
  const roster = { payrollWages: { '6402': 36000 }, wagesLive: { label: 'c', effective: '2027-01', draft: false, monthly: { '6402': f(3000) } } };
  const src: AnnualSources = { actual: own, budget: null, lastMonth: 10, ...roster };
  const ownRun = generateAnnualLines(coaList, inputs, src);
  const borrowed = generateAnnualLines(coaList, inputs, { ...src, burdenSrc: { code: 'clnd', actual: donorActual, budget: null } });

  it('the ratio comes from the donor, applied to THIS property\'s wages', () => {
    expect(sum(L(ownRun, '6418').months)).toBeCloseTo(0.10 * 36000, 0);
    expect(sum(L(borrowed, '6418').months)).toBeCloseTo(0.12 * 36000, 0);
    expect(L(borrowed, '6418').driver).toMatchObject({ method: 'burdenRatio', from: 'clnd' });
    expect((L(ownRun, '6418').driver as any).from).toBeUndefined();
    expect(sum(L(borrowed, '6402').months)).toBeCloseTo(36000, 0);     // wages untouched
  });
  it('the monthly shape comes with it: the donor\'s quarterly bonus lands in the same months here', () => {
    expect(sum(L(ownRun, '6408').months)).toBe(0);                     // no bonus history of its own
    const b = L(borrowed, '6408').months;
    expect(b[0]).toBeCloseTo(0.25 * 3000, 0);                          // January: 25% of that month's wages
    expect(b[1]).toBe(0);
    expect([b[3], b[6], b[9]].every((v) => Math.abs(v - 750) < 0.5)).toBe(true);
    expect(sum(b)).toBeCloseTo(3000, 0);
  });
  it('a saved formula set carries the choice', () => {
    const set = formulaSetFromBudget(borrowed, { ...inputs, burdenFrom: 'clnd', rules: {} });
    expect(set.settings.burdenFrom).toBe('clnd');
    expect(applyFormulaSet(inputs, set, { id: 1, name: 's' }).burdenFrom).toBe('clnd');
  });
  // Troy 2026-11-12: "take the ratio from Minot or BCND/ECND ... for 401K contributions, as sites like Minot will have
  // annual spikes reflected, whereas FHND wont" — one line from a pooled group, the rest stay on their own history
  it('one line can borrow from a pooled group; the other lines keep this property\'s own ratios', () => {
    // the pooled donors: wages 5,000 + 3,000 a month; the bonus line spikes in January (annual true-up) at both
    const pooled = { '6402': f(8000), '6408': cal([4000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 400]) };
    const one = generateAnnualLines(coaList, inputs, { ...src, burdenGl: { '6408': { code: 'Minot ND', actual: pooled, budget: null } } });
    const b = L(one, '6408').months;
    expect(b[0]).toBeCloseTo(0.5 * 3000, 0);                            // January: 4,000 / 8,000 of that month's wages
    expect(b[11]).toBeCloseTo(0.05 * 3000, 0);
    expect(b.slice(1, 11).every((v) => v === 0)).toBe(true);
    expect(L(one, '6408').driver).toMatchObject({ method: 'burdenRatio', from: 'Minot ND' });
    expect(L(one, '6418').months).toEqual(L(ownRun, '6418').months);   // taxes: still this property's own 10%
    expect((L(one, '6418').driver as any).from).toBeUndefined();
    // the per-line pick wins over a whole-budget donor for that line only
    const both = generateAnnualLines(coaList, inputs, { ...src, burdenSrc: { code: 'clnd', actual: donorActual, budget: null }, burdenGl: { '6408': { code: 'Minot ND', actual: pooled, budget: null } } });
    expect((L(both, '6408').driver as any).from).toBe('Minot ND');
    expect((L(both, '6418').driver as any).from).toBe('clnd');
    const set = formulaSetFromBudget(one, { ...inputs, burdenFromGl: { '6408': ['clnd', 'tcnd'] }, rules: {} });
    expect(applyFormulaSet(inputs, set, { id: 1, name: 's' }).burdenFromGl).toEqual({ '6408': ['clnd', 'tcnd'] });
  });
});

describe('Summary panel (Troy 2026-11-10): the budget-comps rows, labels and T12 trend windows', () => {
  it('summaryColumn lays the Monarch totals out as the workbook does and ties to NOI', () => {
    // made-up round figures
    const T: Record<string, number> = { '5070': 900000, '5190': 100000, '6170': 180000, '6370': 20000, '6399': 1000, '6470': 120000, '6570': 15000, '6670': 70000, '6770': 14000, '6870': 2000, '6970': 60000, '7070': 30000 };
    const G: Record<string, number> = { '6116': 120000, '6112': 40000, '7300': 250000, '3080': 5000 };
    const c = summaryColumn((k) => T[k] || 0, (k) => G[k] || 0);
    expect(c.fixedLess).toBe(20000);                                   // fixed admin LESS taxes and the fee
    expect(c.admin).toBe(21000);                                       // admin + corporate events
    expect(c.income).toBe(1000000);
    expect(c.expense).toBe(512000);
    expect(c.noi).toBe(488000);
    expect(c.mtg1).toBe(-5000);                                        // principal reduces cash flow
    expect(c.cashFlow).toBe(488000 - 250000 - 5000);
    const twice = sumSummaryCols([c, c, null])!;
    expect(twice.noi).toBe(2 * c.noi);
    expect(sumSummaryCols([null])).toBeNull();
  });
  it('column headers default to the T12 window\'s last month and can be typed over', () => {
    expect(summaryLabels(10, 2026)).toEqual({ t12: 'Oct. 26 T12', t4: 'Oct. T4 Ann.', draft: 'Draft #1' });
    expect(summaryLabels(11, 2023, { t12: 'Nov. 23 T12', draft: 'Draft #2' })).toEqual({ t12: 'Nov. 23 T12', t4: 'Nov. T4 Ann.', draft: 'Draft #2' });
    expect(summaryLabels(null, null).t12).toBe('T12');
  });
  it('trailing12 { back } gives the window that ended earlier — only when every month of it is on file', () => {
    // 14 months on file: Sep 2025 .. Oct 2026, rent rising 100 a month
    const months = Array.from({ length: 14 }, (_, i) => 1000 + i * 100);
    const stmt = { monthCal: [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], monthYear: [2025, 2025, 2025, 2025, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026, 2026], rows: [{ gl: '4994', name: 'GPR', months, total: 0 }] };
    const now = trailing12([stmt])!, prev = trailing12([stmt], { back: 1 })!, prev2 = trailing12([stmt], { back: 2 })!;
    expect(now.period).toBe('Nov 2025-Oct 2026');
    expect(prev.period).toBe('Oct 2025-Sep 2026');
    expect(prev2.period).toBe('Sep 2025-Aug 2026');
    expect(sum(now.cal['4994'])).toBe(sum(months.slice(2)));
    expect(sum(prev.cal['4994'])).toBe(sum(months.slice(1, 13)));
    expect(sum(prev2.cal['4994'])).toBe(sum(months.slice(0, 12)));
    expect(trailing12([stmt], { back: 3 })).toBeNull();                // Aug 2025 is not on file
  });
});

/* Year-1 plan inside the annual budget — made-up figures. */
import { applyY1Plan, clearY1Plan, y1Check, y1MonthsIn, feedsNoi, acqCalendarPlan, postedSinceClosing, applyPlanSlice } from '../shared/annual.js';
describe('Year-1 plan in the annual budget', () => {
  const flat = (v: number) => Array(12).fill(v) as Months;
  const coa = ['4994', '5031', '5140', '6305', '6410', '7300'].map((code) => ({ code, name: code, pcode: '1', curve: 'flat', active: true })) as unknown as CoaAccount[];
  // ownership year Aug-26..Jul-27: index 0 = Aug-26, index 5 = Jan-27, index 11 = Jul-27
  const plan = { year: 2026, startMonth: 8, lines: [
    { gl_code: '4994', months: [100, 100, 100, 100, 100, 110, 110, 110, 110, 110, 110, 120] as Months },
    { gl_code: '5031', months: flat(-5) },
    { gl_code: '5140', months: flat(2) },      // income line the annual budget does not carry
    { gl_code: '6305', months: flat(30) },
    { gl_code: '7300', months: flat(40) },     // interest: below NOI, never taken
  ] };
  const line = (gl: string, m: Months, extra: Partial<BudgetLine> = {}): BudgetLine => ({ gl_code: gl, months: m, driver: { method: 'manual' }, override: false, note: '', ...extra });
  const annual = () => [line('4994', flat(125)), line('5031', flat(-6)), line('6305', flat(33)), line('6410', flat(4)), line('7300', flat(41))];

  it('knows which calendar months are still Year 1 and which GLs feed NOI', () => {
    expect(y1MonthsIn(plan, 2027)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(y1MonthsIn(plan, 2026)).toEqual([7, 8, 9, 10, 11]);
    expect(y1MonthsIn({ year: 2026, startMonth: 9 }, 2027)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(y1MonthsIn(plan, 2028)).toEqual([]);
    expect([feedsNoi('4994'), feedsNoi('5189'), feedsNoi('6101'), feedsNoi('7069'), feedsNoi('7300'), feedsNoi('3080'), feedsNoi('8500')]).toEqual([true, true, true, true, false, false, false]);
  });
  it('takes Jan-Jul from the plan on every line through NOI and leaves Aug-Dec and below-NOI lines alone', () => {
    const out = new Map(applyY1Plan(annual(), coa, plan, 2027).map((l) => [l.gl_code, l]));
    expect(out.get('4994')!.months).toEqual([110, 110, 110, 110, 110, 110, 120, 125, 125, 125, 125, 125]);
    expect(out.get('6305')!.months).toEqual([30, 30, 30, 30, 30, 30, 30, 33, 33, 33, 33, 33]);
    expect(out.get('6410')!.months).toEqual([0, 0, 0, 0, 0, 0, 0, 4, 4, 4, 4, 4]);       // not in the plan: nothing in Year 1
    expect(out.get('5140')!.months).toEqual([2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0]);       // only in the plan: added
    expect(out.get('7300')!.months).toEqual(flat(41));
    expect((out.get('4994')!.driver as any).y1).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect((out.get('7300')!.driver as any).y1).toBeUndefined();
  });
  it('Year 1 lands on the plan NOI, and a locked line shows as variance instead of moving', () => {
    const planNoi = (100 * 5 + 110 * 6 + 120) + 12 * (-5 + 2 - 30);
    const tied = y1Check(applyY1Plan(annual(), coa, plan, 2027), plan, 2027, planNoi);
    expect(tied.planNoi).toBe(planNoi);
    expect(tied.y1Noi).toBe(planNoi);
    expect(tied.variance).toBe(0);
    expect(tied.planBefore + tied.planIn).toBe(planNoi);
    const locked = annual(); locked[2] = line('6305', flat(33), { override: true });
    const chk = y1Check(applyY1Plan(locked, coa, plan, 2027), plan, 2027, planNoi);
    expect(chk.locked).toEqual([{ gl: '6305', diff: 21 }]);
    expect(chk.variance).toBe(-21);
    // not applied at all: the gap is the whole difference between the two budgets over Jan-Jul
    expect(y1Check(annual(), plan, 2027, planNoi).variance).toBe(7 * (125 - 6 - 33 - 4) - (110 * 6 + 120 + 7 * (-5 + 2 - 30)));
  });
  describe('the whole year from the acquisition plan (Troy 2026-11-12)', () => {
    // categories: 1 = GPR, 13 = R&M (6702 a turn GL), 12 = utilities
    const coa2 = [
      { code: '4994', pcode: '1' }, { code: '6702', pcode: '13' }, { code: '6720', pcode: '13' }, { code: '6620', pcode: '12' }, { code: '7300', pcode: '' },
    ].map((a) => ({ ...a, name: a.code, kind: 'detail', curve: 'flat', active: true })) as unknown as CoaAccount[];
    // Sep-26..Aug-27: index 0 = Sep-26, 4 = Jan-27, 11 = Aug-27
    const plan2 = { year: 2026, startMonth: 9, lines: [
      { gl_code: '4994', months: [100, 100, 100, 100, 110, 110, 110, 110, 110, 110, 110, 110] as Months },
      { gl_code: '6702', months: flat(20) },
      { gl_code: '6720', months: flat(30) },
      { gl_code: '6620', months: [50, 60, 70, 80, 90, 80, 70, 60, 50, 40, 40, 40] as Months },
      { gl_code: '7300', months: flat(40) },
    ] };
    const uw = { y1: { '1': 1280, '13': 600, '12': 730 }, years: { y2: { '1': 1280 * 1.04, '13': 600 * 1.03, '12': 730 } } };
    const noi = (m: Map<string, Months>, idx: number[]) => [...m].reduce((a, [gl, v]) => a + (gl < '6000' ? 1 : -1) * idx.reduce((x, i) => x + v[i], 0), 0);

    it('Jan-Aug come from the plan; Sep-Dec are the plan\'s Sep-Dec 2026 on the UW Year-2 trend; below-NOI lines are left out', () => {
      const ap = acqCalendarPlan({ plan: plan2, calYear: 2027, coaList: coa2, uw });
      expect(ap.y1Idx).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(ap.afterIdx).toEqual([8, 9, 10, 11]);
      expect(ap.trendFrom).toBe('uw');
      expect(ap.trend['1']).toBeCloseTo(0.04, 9);
      expect(ap.target.get('4994')).toEqual([110, 110, 110, 110, 110, 110, 110, 110, 104, 104, 104, 104]);
      expect(ap.target.get('6620')).toEqual([90, 80, 70, 60, 50, 40, 40, 40, 50, 60, 70, 80]);   // 0% trend: last fall again
      expect(ap.target.has('7300')).toBe(false);
      expect(ap.cal).toEqual(ap.target);                                                 // nothing posted: the plan as is
    });
    it('no UW Year-2 column: carried flat, and says so', () => {
      const ap = acqCalendarPlan({ plan: plan2, calYear: 2027, coaList: coa2, uw: { y1: uw.y1 } });
      expect(ap.trendFrom).toBe('none');
      expect(ap.target.get('4994')!.slice(8)).toEqual([100, 100, 100, 100]);
    });
    it('posted actuals move the GL mix inside a category; category totals per segment, Year-1 NOI and calendar NOI hold', () => {
      // since closing R&M posted 90% on 6702, 10% on 6720 (plan: 40 / 60)
      const posted = { '6702': 90, '6720': 10, '6620': 120, '4994': 200 };
      const base = acqCalendarPlan({ plan: plan2, calYear: 2027, coaList: coa2, uw });
      const ap = acqCalendarPlan({ plan: plan2, calYear: 2027, coaList: coa2, uw, posted, fit: 0.5 });
      const segSum = (m: Map<string, Months>, gls: string[], idx: number[]) => gls.reduce((a, gl) => a + idx.reduce((x, i) => x + (m.get(gl) || zero12())[i], 0), 0);
      for (const idx of [ap.y1Idx, ap.afterIdx]) expect(segSum(ap.cal, ['6702', '6720'], idx)).toBe(segSum(base.target, ['6702', '6720'], idx));
      // share of 6702 in Year-1 months: halfway between 40% planned and 90% posted = 65%
      expect(segSum(ap.cal, ['6702'], ap.y1Idx) / segSum(ap.cal, ['6702', '6720'], ap.y1Idx)).toBeCloseTo(0.65, 2);
      expect(noi(ap.cal, ap.y1Idx)).toBe(noi(base.target, ap.y1Idx));
      expect(noi(ap.cal, [...Array(12).keys()])).toBe(noi(base.target, [...Array(12).keys()]));
      expect(ap.fitted).toContain('13');
      for (const m of ap.cal.values()) for (const v of m) expect(Number.isInteger(v)).toBe(true);
    });
    it('turn lines follow the turn curve inside each segment; their segment totals do not move', () => {
      const turns = [0, 0, 0, 0, 10, 30, 30, 10, 0, 5, 5, 0] as Months;   // expirations + 1 month
      const ap = acqCalendarPlan({ plan: plan2, calYear: 2027, coaList: coa2, uw, turns, turnGls: new Set(['6702']) });
      const t = ap.cal.get('6702')!;
      expect(t.slice(0, 4)).toEqual([0, 0, 0, 0]);
      expect(t[5]).toBeGreaterThan(t[4]);
      expect(t.slice(0, 8).reduce((a, v) => a + v, 0)).toBe(8 * 20);
      expect(t.slice(8).reduce((a, v) => a + v, 0)).toBe(4 * Math.round(20 * 1.03));   // the trended months round month by month
      expect(ap.cal.get('6720')).toEqual(ap.target.get('6720'));       // not a turn GL: its own shape
      expect(ap.turnGls).toEqual(['6702']);
    });
    it('a GL posted but not planned joins its category; a fit of 0 keeps the plan\'s mix', () => {
      const ap = acqCalendarPlan({ plan: plan2, calYear: 2027, coaList: [...coa2, { code: '6730', pcode: '13', name: '6730', kind: 'detail', curve: 'flat', active: true } as any], uw, posted: { '6702': 40, '6720': 40, '6730': 20 }, fit: 1 });
      expect(ap.cal.get('6730')!.reduce((a, v) => a + v, 0)).toBeGreaterThan(0);
      const none = acqCalendarPlan({ plan: plan2, calYear: 2027, coaList: coa2, uw, posted: { '6702': 90, '6720': 10 }, fit: 0 });
      expect(none.cal).toEqual(none.target);
    });
    it('posted since closing: only the trailing-12 months on or after the ownership start', () => {
      const cal = { '6702': [1, 1, 1, 1, 1, 1, 1, 1, 5, 7, 1, 1] as Months };   // T12 Nov-25..Oct-26
      expect(postedSinceClosing(cal, { month: 10, year: 2026 }, '2026-09')).toEqual({ byGl: { '6702': 12 }, months: 2 });
      expect(postedSinceClosing(cal, { month: 10, year: 2026 }, '2026-09-15')).toEqual({ byGl: { '6702': 12 }, months: 2 });
      expect(postedSinceClosing(cal, { month: 10, year: 2026 }, '2027-01')).toBeNull();
      expect(postedSinceClosing(cal, { month: 10, year: 2026 }, null)).toBeNull();
    });
    it('the overlay takes every month, marks the lines, and never moves a locked one', () => {
      const ap = acqCalendarPlan({ plan: plan2, calYear: 2027, coaList: coa2, uw });
      const ls = [line('4994', flat(125)), line('6702', flat(7), { override: true }), line('7300', flat(41))];
      const out = new Map(applyPlanSlice(ls, coa2, ap.cal, [...Array(12).keys()], () => ({ after: ap.afterIdx })).map((l) => [l.gl_code, l]));
      expect(out.get('4994')!.months).toEqual(ap.cal.get('4994'));
      expect((out.get('4994')!.driver as any).acq).toEqual({ after: [8, 9, 10, 11] });
      expect(out.get('6702')!.months).toEqual(flat(7));
      expect(out.get('7300')!.months).toEqual(flat(41));
      expect(out.get('6720')!.months).toEqual(ap.cal.get('6720'));     // only the plan has it: added
    });
  });
  it('turning it off removes what only the plan had put there', () => {
    const on = applyY1Plan(annual(), coa, plan, 2027);
    const off = new Map(clearY1Plan(on).map((l) => [l.gl_code, l]));
    expect(off.get('5140')!.months).toEqual(zero12());
    expect((off.get('5140')!.driver as any).y1).toBeUndefined();
    // applying twice is the same as once
    expect(applyY1Plan(on, coa, plan, 2027)).toEqual(on);
  });
});

/* Section formulas copied to another budget. */
import { copyFormulas, sectionFormulaSource } from '../shared/annual.js';
describe('copying section formulas to another budget', () => {
  const acct = (code: string, section: string, kind = 'detail') => ({ code, name: code, kind, section, pcode: '13', curve: 'flat', active: true }) as unknown as CoaAccount;
  const coa = [acct('6900', 'contract_services', 'header'), acct('6908', 'contract_services'), acct('6910', 'contract_services'), acct('6912', 'contract_services'), acct('6914', 'contract_services'), acct('6702', 'in_house_maint'), acct('6704', 'in_house_maint')];
  const srcRules = { '6908': { method: 'wavg', factor: 0.05, mround: 25 }, '6910': { method: 'wavg', factor: 0.02 }, '6702': { method: 'same' }, '6704': { method: 'flatT12' } } as any;

  it('a section built one way hands that formula to its other GLs; a mixed section hands over only its own', () => {
    const one = sectionFormulaSource(srcRules, coa, ['contract_services']);
    expect(one.gls.sort()).toEqual(['6908', '6910', '6912', '6914']);
    expect(one.fill.sort()).toEqual(['6912', '6914']);
    expect(one.rules['6912']).toEqual({ method: 'wavg' });
    const mixed = sectionFormulaSource(srcRules, coa, ['in_house_maint']);
    expect(mixed.gls.sort()).toEqual(['6702', '6704']);
    expect(mixed.fill).toEqual([]);
  });
  it('changes only the chosen GLs, keeps each line\'s own % unless asked, and drops the row choices it replaces', () => {
    const target = {
      rules: { '6908': { method: 'flatT12', factor: 0.03 }, '6912': { method: 'corpRate' }, '6702': { method: 'flatT12' }, '6305': { method: 'last' } },
      baseline: { glShape: { '6910': 'flat', '6702': 'flat' }, glGrowth: { '6908': 0.1 }, glMround: { '6910': 50 }, secGrowth: { contract_services: 0.04, admin: 0.02 } },
    } as any;
    const src = sectionFormulaSource(srcRules, coa, ['contract_services']);
    const { inputs, changed } = copyFormulas(target, { rules: src.rules, secGrowth: { contract_services: 0.07 } }, src.gls, ['contract_services'], { fill: src.fill });
    const r = inputs.rules as any, bl = inputs.baseline as any;
    expect(r['6908']).toEqual({ method: 'wavg', mround: 25, factor: 0.03 });   // shape + rounding copied, the target's own factor kept
    expect(r['6910']).toEqual({ method: 'wavg' });                            // no factor on the target before: none now
    expect(r['6912']).toEqual({ method: 'corpRate' });                        // the engine builds this one: a fill never takes it
    expect(r['6914']).toEqual({ method: 'wavg' });                            // filled
    expect(r['6702']).toEqual({ method: 'flatT12' });                         // another section: untouched
    expect(r['6305']).toEqual({ method: 'last' });
    expect(bl.glShape).toEqual({ '6702': 'flat' });
    expect(bl.glMround).toEqual({});
    expect(bl.glGrowth).toEqual({ '6908': 0.1 });                             // % not asked for: the row's own % stays
    expect(bl.secGrowth).toEqual({ contract_services: 0.04, admin: 0.02 });
    expect(changed.sort()).toEqual(['6908', '6910', '6914']);
    expect(target.baseline.glShape['6910']).toBe('flat');                     // the input object is not mutated

    const withPct = copyFormulas(target, { rules: src.rules, secGrowth: { contract_services: 0.07 } }, src.gls, ['contract_services'], { fill: src.fill, pct: true }).inputs as any;
    expect(withPct.rules['6908']).toEqual({ method: 'wavg', factor: 0.05, mround: 25 });
    expect(withPct.baseline.glGrowth).toEqual({});
    expect(withPct.baseline.secGrowth).toEqual({ contract_services: 0.07, admin: 0.02 });
  });
  it('a budget from before formula sets keeps the fallback table for every other GL', () => {
    const src = sectionFormulaSource(srcRules, coa, ['contract_services']);
    const out = copyFormulas({ baseline: {} } as any, { rules: src.rules }, src.gls, ['contract_services'], { fill: src.fill, fallbackRules: { '6305': { method: 'last' }, '6908': { method: 'flatT12' } } as any }).inputs.rules as any;
    expect(out['6305']).toEqual({ method: 'last' });
    expect(out['6908'].method).toBe('wavg');
  });
});

describe('history-based lines never budget a negative month', () => {
  const coa = coaList;
  const bi = baseInputs(2027, 100, null, null, coa); const inputs = { ...bi, rules: {}, baseline: { ...bi.baseline, glShape: { '6630': 'actual', '5024': 'actual' }, glGrowth: { '6630': 0, '5024': 0 } } } as any;
  it('an expense with a credit month in its history: that month is zero, the total is kept; a contra line stays negative', () => {
    const actual = { '6630': [900, 900, -400, 900, 900, 900, 900, 900, 900, 900, 900, 900] as Months, '5024': [-300, -300, -300, 200, -300, -300, -300, -300, -300, -300, -300, -300] as Months };
    const lines = new Map(generateAnnualLines(coa, inputs, { actual, budget: null, lastMonth: 10, rules: {} }).map((l) => [l.gl_code, l]));
    const exp = lines.get('6630')!;
    expect(exp.months.every((v) => v >= 0)).toBe(true);
    expect(exp.months[2]).toBe(0);
    expect((exp.driver as any).folded).toBe(1);
    const plain = sum(generateAnnualLines(coa, inputs, { actual: { '6630': actual['6630'].map((v) => Math.abs(v) === 400 ? 0 : v) as Months }, budget: null, lastMonth: 10, rules: {} }).find((l) => l.gl_code === '6630')!.months);
    expect(sum(exp.months)).toBeLessThan(plain);                       // the credit still lowers the year
    const con = lines.get('5024')!;
    expect(con.months.every((v) => v <= 0)).toBe(true);
    expect(sum(con.months)).toBeLessThan(0);
  });
});

describe('real estate taxes grow 3% by default', () => {
  const actual = { '6116': Array(12).fill(10000) as Months };
  const inputs = { ...baseInputs(2027, 100, null, null, coaList), rules: {} } as any;
  const tax = (inp: any, rules: any = {}) => sum(generateAnnualLines(coaList, { ...inp, rules }, { actual, budget: null, lastMonth: 10, rules }).find((l) => l.gl_code === '6116')!.months);
  it('T12 x 1.03 with nothing typed, also when a saved set carries the old 0%', () => {
    expect(tax(inputs)).toBeCloseTo(123600, 0);
    expect(tax(inputs, { '6116': { method: 'fixedAnnual', factor: 0 } })).toBeCloseTo(123600, 0);
  });
  it('a % typed on the row wins, including 0', () => {
    expect(tax({ ...inputs, baseline: { ...inputs.baseline, glGrowth: { '6116': 0 } } })).toBeCloseTo(120000, 0);
    expect(tax({ ...inputs, baseline: { ...inputs.baseline, glGrowth: { '6116': 0.05 } } })).toBeCloseTo(126000, 0);
    expect(tax(inputs, { '6116': { method: 'fixedAnnual', factor: 0.04 } })).toBeCloseTo(124800, 0);
  });
});

import { effectiveRules, followsDefaults, shapeRule, builtinShape } from '../shared/annual.js';
describe('default formulas (shared table)', () => {
  const defaults = { '6905': shapeRule('turns'), '6310': shapeRule('turns'), '6908': shapeRule('flat') } as any;
  it('reach a budget on the defaults, never one on a named saved set', () => {
    expect(followsDefaults({} as any)).toBe(true);
    expect(followsDefaults({ rulesFrom: { id: null, name: 'Template defaults' } } as any)).toBe(true);
    expect(followsDefaults({ rulesFrom: { id: 'grks', name: 'GRKS' } } as any)).toBe(true);
    expect(followsDefaults({ rulesFrom: { id: 4, name: 'Mine' } } as any)).toBe(false);
    const named = { rules: { '6905': { method: 'last' } }, rulesFrom: { id: 4, name: 'Mine' } } as any;
    expect(effectiveRules(named, null, defaults)).toBe(named.rules);
  });
  it('keep the own increase % and rounding of the line, skip engine-built GLs and copied-in formulas', () => {
    const inp = { rules: { '6905': { method: 'flatT12', factor: 0.04, mround: 10 }, '6310': { method: 'corpRate' }, '6908': { method: 'last' } }, rulesOwn: ['6908'] } as any;
    const eff = effectiveRules(inp, null, defaults);
    expect(eff['6905']).toEqual({ method: 'custom', shape: 'turns', factor: 0.04, mround: 10 });
    expect(eff['6310']).toEqual({ method: 'corpRate' });
    expect(eff['6908']).toEqual({ method: 'last' });
    expect(effectiveRules({} as any, { '6905': { method: 'same' } } as any, defaults)['6905']).toEqual({ method: 'custom', shape: 'turns' });
    expect(builtinShape('6905')).toBe('turns');
  });
});

import { annualBaseline as abFit } from '../shared/annual.js';
describe('fit a curve to T12', () => {
  const cal = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 1300] as any;   // T12 = 2,400, December heavy
  const turns = [0, 0, 0, 0, 0, 12, 12, 0, 0, 0, 0, 0] as any;                          // all turns in Jun / Jul
  const tot = (m: number[]) => Math.round(m.reduce((a, v) => a + v, 0));
  it('0 = the pure curve, 100 = the T12 months, 50 = half way; the total never moves', () => {
    const f0 = abFit(cal, { shape: 'turns', turns, fit: 0 });
    const f50 = abFit(cal, { shape: 'turns', turns, fit: 0.5 });
    const f100 = abFit(cal, { shape: 'turns', turns, fit: 1 });
    expect(f0).toEqual(abFit(cal, { shape: 'turns', turns }));
    expect(f0[5]).toBe(1200); expect(f0[11]).toBe(0);
    expect(f100).toEqual(cal);
    expect(f50[5]).toBe(650); expect(f50[11]).toBe(650); expect(f50[0]).toBe(50);
    for (const m of [f0, f50, f100]) expect(tot(m)).toBe(2400);
  });
  it('a credit month in the history counts as zero, never a negative budget month', () => {
    const m = abFit([500, -200, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500] as any, { shape: 'turns', turns, fit: 1 });
    expect(m[1]).toBe(0); expect(m.every((v) => v >= 0)).toBe(true); expect(tot(m)).toBe(5300);
  });
});

/* 2027 Budget notes pass (Troy 2026-11-11): one-time T12 items, contracts, the flat-fee package
   schedule and the TPND -> TPNDC journal split. Synthetic property only. */
describe('2027 notes pass', () => {
  const actual = synthetic();
  const inputs = baseInputs(2027, 10, actual, null, coaList, null, 10);
  const src: AnnualSources = { actual, budget: null, lastMonth: 10 };
  const plain = generateAnnualLines(coaList, inputs, src);

  it('applyT12Adjust takes a one-time amount off one posted month and reports it per GL', () => {
    const r = applyT12Adjust(actual, [{ gl: '6302', month: 3, amount: 40, note: 'one-off' }, { gl: '6302', month: 4, amount: 10 }, { gl: '6302', month: 13, amount: 99 }]);
    expect(r.actual!['6302'][2]).toBe(60);
    expect(r.actual!['6302'][3]).toBe(90);
    expect(r.byGl['6302']).toBe(50);
    expect(actual['6302'][2]).toBe(100);                       // the source is not mutated
  });
  it('a one-time item moves only the month it sits in (same-month shape) and tags the chip', () => {
    const adj = generateAnnualLines(coaList, { ...inputs, t12Adjust: [{ gl: '6302', month: 3, amount: 40 }] }, src);
    const a = L(adj, '6302'), p = L(plain, '6302');
    expect(a.months[2]).toBeCloseTo(p.months[2] * 0.6, 2);
    expect(a.months[0]).toBe(p.months[0]);
    expect((a.driver as any).oneTime).toBe(40);
    expect((p.driver as any).oneTime).toBeUndefined();
  });
  it('contractMonths: monthly season, season total, annual invoice, per unit, escalator', () => {
    const snow = contractMonths({ vendor: 'Brandoz', gl: '6934', kind: 'monthly', amount: 60000, per: 'total', months: [11, 12, 1, 2, 3, 4] }, 10);
    expect(snow).toEqual([10000, 10000, 10000, 10000, 0, 0, 0, 0, 0, 0, 10000, 10000]);
    const inv = contractMonths({ vendor: 'ButterflyMX', gl: '6331', kind: 'annual', amount: 8040, billMonth: 12 }, 10);
    expect(sum(inv)).toBe(8040); expect(inv[11]).toBe(8040);
    const pu = contractMonths({ vendor: 'SmartRent', gl: '6331', kind: 'perUnit', amount: 60 }, 10);
    expect(pu[0]).toBe(50); expect(sum(pu)).toBe(600);
    const step = contractMonths({ vendor: 'Chevron', gl: '5118', kind: 'monthly', amount: 1000, stepMonth: 8, stepPct: 0.03 }, 10);
    expect(step[6]).toBe(1000); expect(step[7]).toBe(1030);
    // ownership-year order: a budget starting in September puts September in month 0
    expect(contractMonths({ vendor: 'x', gl: '6934', kind: 'annual', amount: 5, billMonth: 9 }, 0, 9)[0]).toBe(5);
  });
  it('contracts replace the line (default) or sit on top of its formula, and feed the fee basis', () => {
    const rep = generateAnnualLines(coaList, { ...inputs, contracts: [{ vendor: 'A', gl: '6620', kind: 'monthly', amount: 100 }, { vendor: 'B', gl: '6620', kind: 'annual', amount: 1200, billMonth: 6 }] }, src);
    const t = L(rep, '6620');
    expect((t.driver as any).method).toBe('contract');
    expect(sum(t.months)).toBe(2400);
    expect(t.months[5]).toBe(1300);
    const add = L(generateAnnualLines(coaList, { ...inputs, contracts: [{ vendor: 'A', gl: '6620', kind: 'monthly', amount: 100, mode: 'add' }] }, src), '6620');
    expect(sum(add.months)).toBeCloseTo(sum(L(plain, '6620').months) + 1200, 2);
    expect((add.driver as any).base.method).toBe('baseline');
    // an income contract raises total income, so the fee follows
    const inc = generateAnnualLines(coaList, { ...inputs, mgmtPct: 0.04, contracts: [{ vendor: 'Chevron', gl: '5118', kind: 'monthly', amount: 10000 }] }, src);
    const base = generateAnnualLines(coaList, { ...inputs, mgmtPct: 0.04 }, src);
    expect(L(inc, '6112').months[3] - L(base, '6112').months[3]).toBeCloseTo(400, 0);
  });
  it('TPND keeps 58.89% of engine-built split lines; history lines are already net', () => {
    const t = generateAnnualLines(coaList, inputs, { ...src, propertyCode: 'tpnd' });
    const c = generateAnnualLines(coaList, inputs, { ...src, propertyCode: 'clnd' });
    expect(L(t, '6108').months[0]).toBeCloseTo(L(c, '6108').months[0] * (1 - 0.4111), 2);
    expect((L(t, '6108').driver as any).allocOut.to).toBe('tpndc');
    expect(L(t, '6620').months).toEqual(L(c, '6620').months);      // trash from its own (net) history
    // turned off on the budget
    expect(L(generateAnnualLines(coaList, { ...inputs, allocOut: null }, { ...src, propertyCode: 'tpnd' }), '6108').months[0]).toBe(L(c, '6108').months[0]);
  });
  it('flatFeeFromSchedule: all on the fee = fee x occupied units; a RUBS remainder converts as leases end', () => {
    const vac = Array(12).fill(0.05) as Months;
    const all = flatFeeFromSchedule({ fees: { '1': 100, '2': 150 }, units: { '1': 5, '2': 5 }, onFlatPct: 1 }, { lastIncome: 900, occLast: 0.9, units: 10, vacPct: vac, year: 2027 })!;
    expect(all.F).toBe(125);
    expect(all.months[0]).toBeCloseTo(10 * 0.95 * 125, 2);
    // half on the fee at the last month: R backed out of 900 / 9 occupied = 100 per unit → R = 75
    const leases = [{ m: 1, r: 1, e: '2027-03-31' }, { m: 1, r: 1, e: '2027-03-31' }, { m: 1, r: 1, e: '2027-09-30' }, { m: 1, r: 1, e: '2028-01-31' }];
    const half = flatFeeFromSchedule({ fees: { '1': 100, '2': 150 }, units: { '1': 5, '2': 5 }, onFlatPct: 0.5, convertFrom: '2026-12' }, { lastIncome: 900, occLast: 0.9, units: 10, vacPct: vac, leases, year: 2027 })!;
    expect(half.R).toBe(75);
    expect(half.share[0]).toBe(0.5);
    expect(half.share[2]).toBe(0.75);                           // 2 of 4 leases ended by March
    expect(half.share[8]).toBe(0.875);
    expect(half.months[0]).toBeCloseTo(10 * 0.95 * 100, 2);
  });
  it('the engine splits the schedule total across reimbursement GLs by last month mix', () => {
    const fees = generateAnnualLines(coaList, { ...inputs, vacancyPct: Array(12).fill(0.05) as Months, utilities: { billing: 'flat', feeSchedule: { fees: { '1': 100 }, units: { '1': 10 }, onFlatPct: 1 } } }, src);
    const u = L(fees, '5170');
    expect((u.driver as any).schedule).toBe(true);
    expect(u.months[0]).toBeCloseTo(10 * 0.95 * 100, 2);       // 5170 is the only reimbursement GL with history
  });
  it('snowContract curve is flat Nov-Apr', () => {
    expect(CURVES.snowContract).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1]);
  });
});

/* 2027 exec-team guidance scorecard (Troy 2026-11-11). Synthetic property only. */
describe('guidanceCheck', () => {
  const actual = synthetic();
  const inputs = baseInputs(2027, 10, actual, null, coaList, null, 10);
  const lines = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10 });
  const scale = (ls: BudgetLine[], pick: (gl: string) => boolean, k: number) => ls.map((l) => (pick(l.gl_code) ? { ...l, months: l.months.map((v) => v * k) as Months } : l));
  it('reports income / expense / NOI growth against the T12 and the guidance ranges', () => {
    const r = guidanceCheck({ lines, coaList, t12: actual, lastMonth: 10, units: 10, capital: 0 })!;
    const T = (m: Record<string, Months>, c: string) => sum(rollup(new Map(Object.entries(m))).get(c) || zero12());
    const B = (c: string) => sum(rollup(new Map(lines.map((l) => [l.gl_code, l.months]))).get(c) || zero12());
    expect(r.growth.income).toBeCloseTo((B('5500') - T(actual, '5500')) / T(actual, '5500'), 6);
    expect(r.growth.noi).toBeCloseTo((B('7280') - T(actual, '7280')) / Math.abs(T(actual, '7280')), 6);
    expect(r.items[0].key).toBe('noi');                          // NOI first, the most important
    expect(r.items.filter((i) => i.must).map((i) => i.key)).toEqual(expect.arrayContaining(['noi', 'income', 'expense', 'spread', 'march']));
  });
  it('flags NOI below the current budget as bad, and an expense spread over 50 bps', () => {
    const cy = Object.fromEntries(Object.entries(actual).map(([g, m]) => [g, (Number(g) < 6000 ? m.map((v) => v * 1.5) : m) as Months]));
    const r = guidanceCheck({ lines, coaList, t12: actual, cyBudget: cy, lastMonth: 10, units: 10, capital: 0 })!;
    expect(r.items.find((i) => i.key === 'noicy')!.status).toBe('bad');
    const hot = guidanceCheck({ lines: scale(lines, (g) => g >= '6000' && g < '7100', 1.2), coaList, t12: actual, lastMonth: 10, units: 10, capital: 0 })!;
    expect(hot.items.find((i) => i.key === 'spread')!.status).toBe('check');
  });
  it('March rental income vs October, insurance per unit, SP vs capital, quarters', () => {
    const r = guidanceCheck({ lines, coaList, t12: actual, lastMonth: 10, units: 10, capital: 100000 })!;
    expect(r.items.find((i) => i.key === 'march')).toBeTruthy();
    expect(r.items.find((i) => i.key === 'ins')!.status).toBe('ok');   // 2027 rate is the guidance $275
    expect(r.items.find((i) => i.key === 'sp')!.status).toBe('check');  // nothing budgeted
    expect(r.quarters.length).toBe(4);
    expect(guidanceCheck({ lines, coaList, t12: null, lastMonth: 10, units: 10, capital: 0 })).toBeNull();
  });
});

/* Fit to T12 on ANY line (Troy 2026-11-11: "It should be usable for any GL and any category") */
describe('fit to T12 on any line', () => {
  const actual = synthetic();
  const inputs = baseInputs(2027, 10, actual, null, coaList, null, 10);
  const src: AnnualSources = { actual, budget: null, lastMonth: 10 };
  const withFit = (glFit: Record<string, number>, extra: any = {}) => generateAnnualLines(coaList, { ...inputs, ...extra, baseline: { ...inputs.baseline!, ...(extra.baseline || {}), glFit } }, src);
  it('fitToT12 keeps the total and moves the months toward the history', () => {
    const flat = Array(12).fill(100) as Months;
    const hist = cal([300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const half = fitToT12(flat, hist, 0.5)!;
    expect(sum(half)).toBeCloseTo(1200, 2);
    expect(half[0]).toBeCloseTo(650, 2);                        // 50 + 600
    expect(half[1]).toBeCloseTo(50, 2);
    expect(fitToT12(flat, hist, 1)![0]).toBeCloseTo(1200, 2);
    expect(fitToT12(flat, zero12(), 0.5)).toBeNull();           // no history: nothing to fit
  });
  it('works on a flat (T12 ÷ 12) line, keeping its year total', () => {
    const base = generateAnnualLines(coaList, { ...inputs, baseline: { ...inputs.baseline!, glShape: { '6604': 'flat' } } }, src);
    const fit = withFit({ '6604': 1 }, { baseline: { glShape: { '6604': 'flat' } } });
    const b = L(base, '6604'), f = L(fit, '6604');
    expect(sum(f.months)).toBeCloseTo(sum(b.months), 2);
    expect(f.months[0]).toBeGreaterThan(f.months[5]);           // January heavier than June, like its T12
    expect((f.driver as any).fitT12).toBe(1);
  });
  it('works on engine lines (% of GPR, corporate rate) and on income', () => {
    const base = generateAnnualLines(coaList, inputs, src);
    const fit = withFit({ '5035': 0.5, '6108': 0.5 });
    // 5035 delinquency is % of net rental income: total kept, months moved toward its T12 (flat here → unchanged shape)
    expect(sum(L(fit, '5035').months)).toBeCloseTo(sum(L(base, '5035').months), 2);
    // 6108 insurance has no T12 in the synthetic property: left alone
    expect(L(fit, '6108').months).toEqual(L(base, '6108').months);
    expect((L(fit, '6108').driver as any).fitT12).toBeUndefined();
  });
  it('a curve line keeps its own blend (no second fit), contracts are never fitted', () => {
    const c = withFit({ '6620': 0.5 }, { contracts: [{ vendor: 'x', gl: '6620', kind: 'monthly', amount: 100 }] });
    expect(L(c, '6620').months).toEqual(Array(12).fill(100));
  });
});

/* Quarter shift (Troy 2026-11-11): move NOI share between quarters on the lines picked; year totals kept. */
describe('quarter shift', () => {
  const actual = synthetic();
  const inputs = baseInputs(2027, 10, actual, null, coaList, null, 10);
  const src: AnnualSources = { actual, budget: null, lastMonth: 10 };
  const base = generateAnnualLines(coaList, { ...inputs, mgmtPct: 0.04 }, src);
  const N0 = noiQuarters(base);
  const yearNoi = N0.reduce((a, b) => a + b, 0);
  it('qShiftTargets: typed shares stand, blank quarters split the rest in proportion', () => {
    const t = qShiftTargets([0.2, null, null, 0.3], [25, 25, 25, 25])!;
    expect(t[0]).toBe(0.2); expect(t[3]).toBe(0.3);
    expect(t[1]).toBeCloseTo(0.25, 6); expect(t[2]).toBeCloseTo(0.25, 6);
    expect(qShiftTargets([0.2, 0.2, 0.2, 0.2], [1, 1, 1, 1])).toBeNull();   // all typed, not 100%
  });
  it('expense levers move NOI from Q1 into Q4; NOI for the year and each lever total unchanged', () => {
    const q1 = N0[0] / yearNoi - 0.01, q4 = N0[3] / yearNoi + 0.01;
    const sh = generateAnnualLines(coaList, { ...inputs, mgmtPct: 0.04, qShift: { targets: [q1, null, null, q4], gls: ['6302', '6604', '6620', '6702'] } }, src);
    const N1 = noiQuarters(sh);
    expect(N1.reduce((a, b) => a + b, 0)).toBeCloseTo(yearNoi, 0);
    expect(N1[0] / yearNoi).toBeCloseTo(q1, 3);
    expect(N1[3] / yearNoi).toBeCloseTo(q4, 3);
    for (const gl of ['6302', '6604', '6620', '6702']) expect(sum(L(sh, gl).months)).toBeCloseTo(sum(L(base, gl).months), 2);
    expect((L(sh, '6604').driver as any).qShift.capped).toBe(false);
    expect((L(sh, '6402').driver as any).qShift).toBeUndefined();   // not picked: untouched
    expect(L(sh, '6402').months).toEqual(L(base, '6402').months);
  });
  it('fixed-schedule lines never carry the shift, even when picked: RE taxes, insurance, payroll (Troy 2026-11-11)', () => {
    const q1 = N0[0] / yearNoi - 0.01, q4 = N0[3] / yearNoi + 0.01;
    const fixed = coaList.filter((a) => a.kind === 'detail' && ['6', '8', '10'].includes(String(a.pcode))).map((a) => a.code);
    const sh = generateAnnualLines(coaList, { ...inputs, mgmtPct: 0.04, qShift: { targets: [q1, null, null, q4], gls: ['6302', '6604', '6620', '6702', ...fixed] } }, src);
    let seen = 0;
    for (const gl of fixed) {
      const was = base.find((l) => l.gl_code === gl); const now = sh.find((l) => l.gl_code === gl);
      if (!was || !now || !sum(was.months)) continue;
      seen++;
      expect((now.driver as any).qShift).toBeUndefined();
      expect(now.months).toEqual(was.months);
    }
    expect(seen).toBeGreaterThan(0);
    expect((L(sh, '6604').driver as any).qShift).toBeTruthy();   // the shiftable lines still carry it
  });
  it('vacancy timing moves income; the fee follows; year NOI kept', () => {
    const q1 = N0[0] / yearNoi - 0.005;
    const sh = generateAnnualLines(coaList, { ...inputs, mgmtPct: 0.04, qShift: { targets: [q1, null, null, null], vacancy: true } }, src);
    const N1 = noiQuarters(sh);
    expect(sum(L(sh, '5031').months)).toBeCloseTo(sum(L(base, '5031').months), 2);
    expect(N1[0] / yearNoi).toBeCloseTo(q1, 3);
    expect(Math.abs(N1.reduce((a, b) => a + b, 0) - yearNoi)).toBeLessThan(Math.abs(yearNoi) * 0.001);
  });
  it('a shift too big for the picked lines stops at the floor and says so', () => {
    const sh = generateAnnualLines(coaList, { ...inputs, mgmtPct: 0.04, qShift: { targets: [0.05, null, null, 0.45], gls: ['6302'] } }, src);
    const d = L(sh, '6302').driver as any;
    expect(d.qShift.capped).toBe(true);
    const Q = [0, 1, 2, 3].map((q) => L(sh, '6302').months.slice(q * 3, q * 3 + 3).reduce((a, b) => a + b, 0));
    const Qb = [0, 1, 2, 3].map((q) => L(base, '6302').months.slice(q * 3, q * 3 + 3).reduce((a, b) => a + b, 0));
    for (let q = 0; q < 4; q++) expect(Q[q]).toBeGreaterThanOrEqual(Qb[q] * 0.5 - 0.05);
  });
});

/* HAP is rent (Troy 2026-11-11: "HAP + GPR should equal rent roll GPR… It should not be offset by LTL"). */
describe('HAP inside GPR', () => {
  const actual = { ...synthetic(), '4996': cal(Array(12).fill(700)) };
  const inputs = baseInputs(2027, 10, actual, null, coaList, null, 10);
  const roll = { ...inputs, gpr: { baseMonthly: 12000, growthPct: [0, 0, 0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0] as Months } };
  const leases = [{ m: 1200, r: 300, e: '2027-06-30', s: 800 }, { m: 1200, r: 1150, e: '2027-03-31' }];
  it('GPR off the rent roll: 4994 + 4996 = the rent roll GPR every month; LTL excludes HAP', () => {
    const ls = generateAnnualLines(coaList, roll, { actual, budget: null, lastMonth: 10, leases, charges: { subsidy: 800 } });
    const g = L(ls, '4994').months, h = L(ls, '4996').months;
    expect(h[0]).toBe(800);                                         // the roll's HAP charge
    expect(r2n(g[0] + h[0])).toBe(12000);
    expect(r2n(g[5] + h[5])).toBeCloseTo(12120, 2);                  // the market step, on the rent roll GPR
    expect((L(ls, '4994').driver as any).hap).toBe(800);
    expect(L(ls, '5003').months[0]).toBe(-(100 + 50));               // (1200−300−800) + (1200−1150)
  });
  it('GPR off the last actual month is already net of HAP: nothing comes out', () => {
    const ls = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10 });
    expect(L(ls, '4994').months[0]).toBe(10000);
    expect((L(ls, '4994').driver as any).hap).toBeUndefined();
  });
});
const r2n = (v: number) => Math.round(v * 100) / 100;

describe('LTL typed first month (template burnoff, no leases)', () => {
  const actual = synthetic();
  const inputs = baseInputs(2027, 10, actual, null, coaList, null, 10);
  it('starts at the typed month and runs on from it', () => {
    const base = L(generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10 }), '5003');
    const typed = L(generateAnnualLines(coaList, { ...inputs, ltl: { ...inputs.ltl, month0: -800 } }, { actual, budget: null, lastMonth: 10 }), '5003');
    expect(typed.months[0]).toBe(-800);
    expect(base.months[0]).toBe(-500);
    expect(typed.months[11]).not.toBe(base.months[11]);         // the rest of the year runs off the new start
    expect((typed.driver as any).method).toBe('ltl');           // still a live formula, not a typed row
  });
});

describe('guidance as single numbers', () => {
  it('old range settings become one number each (low end; payroll the middle)', () => {
    const g = normalizeGuidance({ incomeMin: 0.031, incomeMax: 0.04, payrollMin: 0.03, payrollMax: 0.04, noiMin: 0.02 });
    expect(g.incomePct).toBe(0.031); expect(g.payrollPct).toBeCloseTo(0.035, 6); expect(g.noiPct).toBe(0.02);
    expect(g.expensePct).toBe(0.03); expect(g.tolerance).toBe(0.0025);
  });
  it('income is a floor and expenses a ceiling (Troy 2026-11-12: "above rental income... green, not red. Reverse is true for expenses")', () => {
    const actual = synthetic();
    const inputs = baseInputs(2027, 10, actual, null, coaList, null, 10);
    const lines = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10 });
    const r = guidanceCheck({ lines, coaList, t12: actual, lastMonth: 10, units: 10, capital: 0, guidance: { incomePct: 0.5 } })!;
    expect(r.items.find((i) => i.key === 'income')!.status).toBe('check');          // below a 50% floor
    expect(r.items.find((i) => i.key === 'income')!.target).toBe('+50.0% or better');
    const growth = r.growth.income!, exp = r.growth.expense!;
    // income well ABOVE its number is on target (it used to be flagged for missing a ± band)
    const over = guidanceCheck({ lines, coaList, t12: actual, lastMonth: 10, units: 10, capital: 0, guidance: { incomePct: growth - 0.05 } })!;
    expect(over.items.find((i) => i.key === 'income')!.status).toBe('ok');
    // expenses well BELOW their number are on target; above it they are not
    const under = guidanceCheck({ lines, coaList, t12: actual, lastMonth: 10, units: 10, capital: 0, guidance: { expensePct: exp + 0.05 } })!;
    expect(under.items.find((i) => i.key === 'expense')!.status).toBe('ok');
    const above = guidanceCheck({ lines, coaList, t12: actual, lastMonth: 10, units: 10, capital: 0, guidance: { expensePct: exp - 0.05 } })!;
    expect(above.items.find((i) => i.key === 'expense')!.status).toBe('check');
  });
});

describe('quarter shift — phase in the expense increases', () => {
  const actual = synthetic();
  const inputs = baseInputs(2027, 10, actual, null, coaList, null, 10);
  const src: AnnualSources = { actual, budget: null, lastMonth: 10 };
  const base = generateAnnualLines(coaList, inputs, src);
  const N0 = noiQuarters(base); const yr = N0.reduce((a, b) => a + b, 0);
  it('a lighter Q1 increase lifts Q1 NOI; every line keeps its total and stays at or above its T12', () => {
    const q1 = N0[0] / yr + 0.002;
    const sh = generateAnnualLines(coaList, { ...inputs, qShift: { targets: [q1, null, null, null], increases: true } }, src);
    const N1 = noiQuarters(sh);
    expect(N1[0] / yr).toBeCloseTo(q1, 3);
    expect(N1.reduce((a, b) => a + b, 0)).toBeCloseTo(yr, 0);
    const moved = sh.filter((l) => (l.driver as any)?.qShift);
    expect(moved.length).toBeGreaterThan(0);
    for (const l of moved) {
      const b = L(base, l.gl_code);
      expect(sum(l.months)).toBeCloseTo(sum(b.months), 2);
      l.months.forEach((v, i) => expect(v).toBeGreaterThanOrEqual(Math.min(b.months[i], Math.max(0, actual[l.gl_code]?.[i] || 0)) - 0.01));
    }
  });
});

describe('refollowMgmtFee (fee follows a hand-edited income line)', () => {
  const inc = Array(12).fill(100000) as any;
  it('prior-month fee: each month re-applies its own rate to the new prior-month income', () => {
    const fee = [3000, 3000, 3000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000] as any; // Jan fixed by CY budget; first-year 3% then 4%
    const next = inc.slice(); next[2] = 110000;                    // March income up 10%
    const out = refollowMgmtFee(fee, inc, next as any, { priorMonth: true, month0Fixed: true });
    expect(out[3]).toBe(4400);                                     // April runs on March
    expect(out[2]).toBe(3000);                                     // March runs on February — unchanged
    expect(out.reduce((a: number, v: number) => a + v, 0)).toBe(fee.reduce((a: number, v: number) => a + v, 0) + 400);
  });
  it('January follows its own income only when there is no current-year budget', () => {
    const fee = Array(12).fill(4000) as any;
    const next = inc.slice(); next[0] = 120000;
    expect(refollowMgmtFee(fee, inc, next as any, { priorMonth: true, month0Fixed: true })[0]).toBe(4000);
    expect(refollowMgmtFee(fee, inc, next as any, { priorMonth: true, month0Fixed: false })[0]).toBe(4800);
  });
  it('same-month fee (acquisition budgets) follows that month', () => {
    const fee = Array(12).fill(3000) as any;
    const next = inc.slice(); next[5] = 90000;
    const out = refollowMgmtFee(fee, inc, next as any, { priorMonth: false, month0Fixed: false });
    expect(out[5]).toBe(2700); expect(out[6]).toBe(3000);
  });
});

describe('T12 fit travels with formula sets (Troy 2026-11-12)', () => {
  const m = Array(12).fill(100) as any;
  const lines: any[] = [
    { gl_code: '5019', months: m, override: false, driver: { method: 'pctGpr', pct: 0.001, fitT12: 0.5 } },
    { gl_code: '6920', months: m, override: false, driver: { method: 'baseline', shape: 'flat', pct: 0.03, fitT12: 0.25 } },
    { gl_code: '6112', months: m, override: false, driver: { method: 'mgmtPct', pct: 0.04 } },
    { gl_code: '6450', months: m, override: true, driver: { method: 'corpRate', fitT12: 0.4 } },
    { gl_code: '6910', months: m, override: false, driver: { method: 'contract', fitT12: 0.4 } },
  ];
  const inputs: any = { baseline: { glFit: { '5019': 0.5, '6920': 0.25 } } };
  it('a saved set keeps fit on engine lines and on the rule of history lines', () => {
    const set = formulaSetFromBudget(lines, inputs);
    expect(set.fit).toEqual({ '5019': 0.5 });            // overridden and contract lines never carry one
    expect(set.rules['6920'].fit).toBe(0.25);
  });
  it('applying the set puts the engine-line fit back on the budget', () => {
    const set = formulaSetFromBudget(lines, inputs);
    const out = applyFormulaSet({ baseline: { glFit: { '9999': 1 } } } as any, set, { id: 1, name: 'x' });
    expect((out.baseline as any).glFit).toEqual({ '5019': 0.5 });
  });
  it('a section copy hands engine-line fit to the target', () => {
    const out = copyFormulas({ rules: {}, baseline: { glFit: {} } } as any, { rules: {} }, [], ['contra'], { fit: { '5019': 0.5 } });
    expect((out.inputs.baseline as any).glFit['5019']).toBe(0.5);
    expect(out.changed).toContain('5019');
  });
});

describe('row picks travel with formula sets (Troy 2026-11-12)', () => {
  const m = Array(12).fill(100) as any;
  const lines: any[] = [
    { gl_code: '6410', months: m, override: false, driver: { method: 'baseline', shape: 'flat', pct: 0.05 } },
    { gl_code: '6420', months: m, override: true, driver: { method: 'manual' } },
  ];
  it('payroll raise / shape / MROUND picked on a row survive save → apply; hard-coded rows do not', () => {
    const set = formulaSetFromBudget(lines, { baseline: { glGrowth: { '6410': 0.05, '6420': 0.09 }, glShape: { '6410': 'flat' }, glMround: { '6410': 50 } } } as any);
    const out = applyFormulaSet({ baseline: { glGrowth: { '6410': 0.035 } } } as any, set, { id: 1, name: 'x' });
    const bl = out.baseline as any;
    expect(bl.glGrowth).toEqual({ '6410': 0.05 });
    expect(bl.glShape).toEqual({ '6410': 'flat' });
    expect(bl.glMround).toEqual({ '6410': 50 });
  });
});
