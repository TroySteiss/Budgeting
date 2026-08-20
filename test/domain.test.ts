import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  spreadMonthly, allocateWeighted, rollup, generateLines, rebalanceCategory,
  categoryTotals, computeTieout, defaultInputs, sum, zero12, CoaAccount, UwSnapshotData, Months,
} from '../shared/domain.js';

const coaList: CoaAccount[] = JSON.parse(readFileSync(join(process.cwd(), 'seed', 'coa.json'), 'utf8'));
const coaMap = new Map(coaList.map((a) => [a.code, a]));

describe('spreadMonthly', () => {
  it('is penny-exact for awkward totals', () => {
    const m = spreadMonthly(100.01, Array(12).fill(1));
    expect(sum(m)).toBe(100.01);
  });
  it('honors zero weights', () => {
    const m = spreadMonthly(1200, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(m[11]).toBe(1200);
    expect(sum(m)).toBe(1200);
  });
  it('handles negatives', () => {
    const m = spreadMonthly(-333.33, Array(12).fill(1));
    expect(sum(m)).toBe(-333.33);
  });
});

describe('allocateWeighted', () => {
  it('sums exactly to the total', () => {
    const out = allocateWeighted(1000.01, [{ key: 'a', weight: 1 }, { key: 'b', weight: 2 }, { key: 'c', weight: 3 }]);
    const tot = Object.values(out).reduce((x, y) => Math.round((x + y) * 100) / 100, 0);
    expect(tot).toBe(1000.01);
  });
});

describe('rollup', () => {
  it('computes the Monarch total chain', () => {
    const lines = new Map<string, Months>();
    const flat = (v: number): Months => Array(12).fill(v) as Months;
    lines.set('4994', flat(100000));
    lines.set('5003', flat(-2000));
    lines.set('5020', flat(-500));
    lines.set('5031', flat(-5000));
    lines.set('5170', flat(3000));
    lines.set('6108', flat(8000));
    lines.set('6402', flat(10000));
    lines.set('7300', flat(4000));
    const t = rollup(lines);
    expect(sum(t.get('5004')!)).toBe(12 * 98000);
    expect(sum(t.get('5070')!)).toBe(12 * (98000 - 500 - 5000));
    expect(sum(t.get('5500')!)).toBe(12 * (92500 + 3000));
    expect(sum(t.get('7099')!)).toBe(12 * 18000);
    expect(sum(t.get('7280')!)).toBe(12 * (95500 - 18000));
    expect(sum(t.get('8200')!)).toBe(12 * (77500 - 4000));
  });
});

const fakeUw: UwSnapshotData = {
  units: 100,
  y1: { '1': 1200000, loss: -24000, '2': -6000, '3': -84000, '4': 30000, '5': 48000,
        '6': 30000, '7': 35000, '8': 120000, '9': 36000, '10': 190000, '11': 18000, '12': 110000, '13': 125000, '14': 35000 },
  egi: 1164000, toe: 699000, noi: 465000,
  assumptions: { vacancyPct: 0.05 },
};

describe('generateLines + tie-out', () => {
  const inputs = defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
  const lines = generateLines(coaList, inputs, fakeUw, null);

  it('ties every absolute category to the UW total exactly', () => {
    const cats = categoryTotals(lines, coaMap);
    for (const p of ['4', '5', '6', '8', '9', '10', '11', '12', '13', '14']) {
      expect(cats[p], `category ${p}`).toBeCloseTo(fakeUw.y1[p], 2);
    }
  });
  it('GPR anchors to rent-roll market rents', () => {
    const gpr = lines.find((l) => l.gl_code === '4994')!;
    expect(sum(gpr.months)).toBe(1200000);
  });
  it('concessions and rental loss follow UW % of budget GPR', () => {
    const cats = categoryTotals(lines, coaMap);
    expect(cats['2']).toBeCloseTo(-(6000 / 1200000) * 1200000, 0);
    expect(cats['3']).toBeCloseTo(-(84000 / 1200000) * 1200000, 0);
  });
  it('management fee is % of total income', () => {
    const linesMap = new Map(lines.map((l) => [l.gl_code, l.months]));
    const income = sum(rollup(linesMap).get('5500')!);
    const fee = sum(lines.find((l) => l.gl_code === '6112')!.months);
    expect(fee).toBeCloseTo(income * inputs.mgmtPct, 0);
  });
  it('tieout NOI variance stays small pre-override', () => {
    const tie = computeTieout(lines, coaMap, fakeUw);
    // GPR/LTL anchor to the rent roll rather than UW, so small variance is expected — but not huge
    expect(Math.abs(tie.noi.variance)).toBeLessThan(20000);
  });
});

describe('rebalanceCategory', () => {
  it('scales a category back to target after an override', () => {
    const inputs = defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    let lines = generateLines(coaList, inputs, fakeUw, null);
    // override one payroll line upward
    const idx = lines.findIndex((l) => coaMap.get(l.gl_code)?.pcode === '10' && sum(l.months) > 0);
    lines[idx] = { ...lines[idx], months: lines[idx].months.map((v) => v + 1000), override: true };
    lines = rebalanceCategory(lines, coaMap, '10', fakeUw.y1['10']);
    const cats = categoryTotals(lines, coaMap);
    expect(cats['10']).toBeCloseTo(fakeUw.y1['10'], 2);
    expect(lines[idx].override).toBe(true);
  });
});

describe('per-unit comp basis', () => {
  it('sets category lines at comp $/unit × subject units and rebalance target follows', () => {
    const inputs = {
      ...defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 }),
      catBasis: { '10': 'perUnit' as const },
    };
    // comp: payroll GLs total 712,000 over 712 units = $1,000/unit → 100 units = 100,000
    const comps = { byGl: { '6402': 500000, '6404': 212000 }, units: 712 };
    const lines = generateLines(coaList, inputs, fakeUw, comps);
    const cats = categoryTotals(lines, coaMap);
    expect(cats['10']).toBeCloseTo((712000 / 712) * 100, 0);
    // other categories still hard-tie to UW
    expect(cats['12']).toBeCloseTo(fakeUw.y1['12'], 2);
  });
  it('per-GL monthly shapes from a monthly comp set drive the spread', () => {
    const shape = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]; // all in December
    const comps = { byGl: { '6402': 712000 }, units: 712, glShapes: { '6402': shape } };
    const inputs = { ...defaultInputs(2027, fakeUw, null), catBasis: { '10': 'perUnit' as const } };
    const lines = generateLines(coaList, inputs, fakeUw, comps);
    const l = lines.find((x) => x.gl_code === '6402')!;
    expect(l.months[11]).toBeCloseTo(sum(l.months), 2);
  });
});

describe('startMonth (mid-year budgets)', () => {
  it('zeroes months before the start month', () => {
    const inputs = { ...defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 }), startMonth: 5 };
    const lines = generateLines(coaList, inputs, fakeUw, null);
    const gpr = lines.find((l) => l.gl_code === '4994')!;
    expect(gpr.months.slice(0, 4).every((v) => v === 0)).toBe(true);
    expect(gpr.months[4]).toBeGreaterThan(0);
  });
});
