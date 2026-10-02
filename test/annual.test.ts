import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateAnnualLines, regenerateAnnual, defaultAnnualInputs, stmtCalendar, stmtLastMonth, stmtAnnualized, trailing12, annualizedFromCal,
  refFromCalendar, refColumn, annualBaseline, expirationsFromLeases, CORP_RATES, type TemplateData, type AnnualSources,
} from '../shared/annual.js';
import { sum, zero12, type CoaAccount, type Months, type BudgetLine } from '../shared/domain.js';
import { parseYardiBudgetTemplate, parseRentRoll, parseMonarchStatement, detectUploadKind } from '../src/importers.js';
import { loadAnnualRules } from '../src/annual-rules.js';

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
  const inputs = defaultAnnualInputs(2026, 10, actual, null, coaList, null, 10);
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
  it('"October actual" lines are flat at the last actual month', () => {
    expect(L(lines, '6116').months).toEqual(Array(12).fill(1000));
    expect((L(lines, '6116').driver as any).shape).toBe('last');
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
  it('mgmt fee = actual % of income, whole dollars; LTL starts at the last actual month', () => {
    const inc = sum(L(lines, '4994').months) + sum(L(lines, '5003').months);
    expect(inputs.mgmtPct).toBeGreaterThan(0.03);
    expect(Number.isInteger(L(lines, '6112').months[0])).toBe(true);
    expect(L(lines, '5003').months[0]).toBe(-500);
    expect(inc).toBeGreaterThan(0);
  });
  it('corporate rates: insurance $285/unit/yr, legal $7.86/unit/yr', () => {
    expect(L(lines, '6108').months[0]).toBe(Math.round((10 * 285) / 12 * 100) / 100);
    expect(L(lines, '6320').months[0]).toBe(Math.round((10 * 7.86) / 12 * 100) / 100);
    expect((L(lines, '6108').driver as any).method).toBe('corpRate');
  });
  it('special projects are never carried forward; interest falls back to history when no schedule / loan', () => {
    expect(sum(L(lines, '7321').months)).toBe(0);
    expect(L(lines, '7300').months[0]).toBe(1500);
  });
  it('payroll: wages flat × (1 + raise); burden = prior-year % of wages × budgeted wages, and it moves with wages', () => {
    // no model: own T12 24,000 × 1.035 flat = 2,070/mo (never the lumpy same-month history)
    const w = L(lines, '6402');
    expect(w.months.every((v) => v === w.months[0])).toBe(true);
    expect(sum(w.months)).toBeCloseTo(24000 * 1.035, 0);
    // 6418 was 10% of wages last year → 10% of this year's wages, flat
    const b = L(lines, '6418');
    expect((b.driver as any).method).toBe('burdenRatio');
    expect((b.driver as any).ratio).toBeCloseTo(0.1, 5);
    expect(sum(b.months)).toBeCloseTo(0.1 * sum(w.months), 0);
    expect(b.months.every((v) => Math.abs(v - b.months[0]) < 0.02)).toBe(true);
    // a model (or a hand-typed wage line) changes wages → burden follows
    const withModel = generateAnnualLines(coaList, inputs, { ...src, payrollWages: { '6402': 30000 } });
    expect(sum(L(withModel, '6402').months)).toBeGreaterThan(30000);   // March raise
    expect(sum(L(withModel, '6418').months)).toBeCloseTo(0.1 * sum(L(withModel, '6402').months), 0);
  });
  it('loss to lease per lease: expired / MTM leases spread over the year, growth deepens only un-reset leases', () => {
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
    // with 12% GPR growth in month 2 and "follows GPR": the deepening is 12% of the
    // OPEN leases' market (20 × 1,000 = 20,000 → 2,400), not 12% of the whole GPR
    const grow = { ...noGrow, ltl: { ...noGrow.ltl, followGpr: true }, gpr: { ...inputs.gpr, growthPct: [0, 0.12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as Months } };
    const l2 = L(generateAnnualLines(coaList, grow, { ...src, leases }), '5003');
    expect(l2.months[1]).toBeCloseTo(-2000 - 2400, 0);
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
  it('expirationsFromLeases counts lease ends by budget month; MTM/expired land in month 0', () => {
    const e = expirationsFromLeases([{ m: 1000, r: 900, e: '2026-03-15' }, { m: 1000, r: 900, e: '2025-12-01' }, { m: 1000, r: 900, e: null }, { m: 1000, r: 900, e: '2027-01-01' }], 2026);
    expect(e[2]).toBe(1); expect(e[0]).toBe(2); expect(sum(e)).toBe(3);
  });
  it('application fees = last year $ ÷ this year move-ins × each month\'s move-ins', () => {
    const actual = synthetic();
    const inputs = { ...defaultAnnualInputs(2026, 10, actual, null, coaList, null, 10), expirations: cal([0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
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
    const inputs = defaultAnnualInputs(2026, t.units, actual, null, coaList, t, 10);
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
    const inputs = defaultAnnualInputs(2026, t.units, actual, null, coaList, t, 10);
    const lines = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10, template: t });
    expect(sum(L(lines, '4994').months)).toBeCloseTo(1493914.18, 1);
    expect(sum(L(lines, '6116').months)).toBeCloseTo(103355.28, 1);
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
    const inputs = defaultAnnualInputs(2026, 10, actual, null, coaList, null, 10);
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
      const inputs = defaultAnnualInputs(2026, t.units, actual, null, coaList, t, 10);
      const lines = generateAnnualLines(coaList, inputs, { actual, budget: null, lastMonth: 10, template: t, rules });
      expect(L(lines, '6604').months[0]).toBe(800);                  // Jan: PY × 1.05 → MROUND 10 (RMC: 800)
      expect(sum(L(lines, '6702').months)).toBeCloseTo(2092.2, 0);   // flatT12 × 1.10 (RMC: 2,092)
      expect(L(lines, '5165').months[0]).toBe(1050);                 // PY Jan 1,030.65 → MROUND 50 (RMC: 1,050)
      expect(sum(L(lines, '6116').months)).toBeCloseTo(103355.28, 1); // RE tax: last actual flat (RMC typed 103,355)
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
