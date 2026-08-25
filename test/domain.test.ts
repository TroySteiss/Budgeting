import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  spreadMonthly, allocateWeighted, rollup, generateLines, rebalanceCategory,
  categoryTotals, computeTieout, defaultInputs, tieNoiToUw, tieIncomeToUw,
  calendarSlice, monthLabels, rotate12, ltlMonths, buildUtilityModel, chargeGlMonthly,
  applyRounding, regenerate, sum, zero12, CoaAccount, UwSnapshotData, Months, Lease, SellerUtilRow,
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

describe('standing MROUND (applyRounding)', () => {
  it('rounds only lines with a round set, without locking them', () => {
    const inputs = defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    let lines = generateLines(coaList, inputs, fakeUw, null);
    const target = lines.find((l) => coaMap.get(l.gl_code)?.pcode === '10' && sum(l.months) > 0)!;
    target.round = 250;
    lines = applyRounding(lines);
    const rounded = lines.find((l) => l.gl_code === target.gl_code)!;
    expect(rounded.months.every((v) => Math.abs(v % 250) < 0.001)).toBe(true);
    expect(rounded.override).toBe(false);                       // NOT a lock
    // survives regeneration: round carries over and re-applies
    let regen = regenerate(lines, coaList, inputs, fakeUw, null);
    regen = applyRounding(regen);
    const after = regen.find((l) => l.gl_code === target.gl_code)!;
    expect(after.round).toBe(250);
    expect(after.months.every((v) => Math.abs(v % 250) < 0.001)).toBe(true);
    expect(after.override).toBe(false);
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

describe('inactive GLs are excluded from comp-weight spreads', () => {
  it('deactivated commercial rent gets nothing; the category re-spreads and still ties', () => {
    const inputs = defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    // Minot-style cat-5 weights: commercial rent dwarfs the legit lines
    const comps = { byGl: { '5118': 1068118, '5165': 129270, '5160': 64690 }, units: 712 };
    const active = generateLines(coaList, inputs, fakeUw, comps);
    expect(sum(active.find((l) => l.gl_code === '5118')!.months)).toBeGreaterThan(0);
    const coaOff = coaList.map((a) => (a.code === '5118' ? { ...a, active: false } : a));
    const lines = generateLines(coaOff, inputs, fakeUw, comps);
    expect(sum(lines.find((l) => l.gl_code === '5118')!.months)).toBe(0);
    // full UW cat-5 target re-spreads over the active GLs — category still ties
    const cats = categoryTotals(lines, coaMap);
    expect(cats['5']).toBeCloseTo(fakeUw.y1['5'], 2);
    const pet = sum(lines.find((l) => l.gl_code === '5165')!.months);
    const park = sum(lines.find((l) => l.gl_code === '5160')!.months);
    expect(pet + park).toBeCloseTo(fakeUw.y1['5'], 2);
    expect(pet / park).toBeCloseTo(129270 / 64690, 1);
  });
});

describe('payroll model wages + Minot burden ratios', () => {
  it('benefits/bonuses follow Minot ratios on the subject wage total (not the UW category)', () => {
    const inputs = defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    const wages = { '6402': 80000, '6404': 70000 };            // subject wages 150,000
    // Minot: wages 712,000; payroll taxes 71,200 (10%); medical 35,600 (5%)
    const comps = { byGl: { '6402': 500000, '6404': 212000, '6418': 71200, '6422': 35600 }, units: 712 };
    const lines = generateLines(coaList, inputs, fakeUw, comps, null, wages);
    expect(sum(lines.find((l) => l.gl_code === '6402')!.months)).toBe(80000);
    expect(sum(lines.find((l) => l.gl_code === '6418')!.months)).toBeCloseTo(15000, 0); // 10% of 150k
    expect(sum(lines.find((l) => l.gl_code === '6422')!.months)).toBeCloseTo(7500, 0);  // 5% of 150k
    const cats = categoryTotals(lines, coaMap);
    expect(cats['10']).toBeCloseTo(172500, 0); // wages + burden — NOT forced to UW's 190,000
  });
  it('without comps the UW-remainder fallback still applies', () => {
    const inputs = defaultInputs(2027, fakeUw, null);
    const wages = { '6402': 80000, '6404': 70000, '6405': 5000 };
    const lines = generateLines(coaList, inputs, fakeUw, null, null, wages);
    const cats = categoryTotals(lines, coaMap);
    expect(cats['10']).toBeCloseTo(fakeUw.y1['10'], 2);
  });
});

describe('tieNoiToUw', () => {
  it('forces NOI to UW exactly by scaling the flex categories, keeping overrides', () => {
    const inputs = defaultInputs(2027, fakeUw, { marketMonthly: 98000, inPlaceMonthly: 95000 }); // income ≠ UW
    let lines = generateLines(coaList, inputs, fakeUw, null);
    // override one marketing line — it must survive untouched
    const idx = lines.findIndex((l) => coaMap.get(l.gl_code)?.pcode === '11' && sum(l.months) > 0);
    const frozen = sum(lines[idx].months);
    lines[idx] = { ...lines[idx], override: true };
    lines = tieNoiToUw(lines, coaMap, fakeUw.noi);
    const monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
    const noi = sum(rollup(monthsMap).get('7280')!);
    expect(noi).toBeCloseTo(fakeUw.noi, 2);
    expect(sum(lines[idx].months)).toBe(frozen);
    // non-flex categories untouched
    const cats = categoryTotals(lines, coaMap);
    expect(cats['12']).toBeCloseTo(fakeUw.y1['12'], 2);
    expect(cats['6']).toBeCloseTo(fakeUw.y1['6'], 2);
  });
  it('no-ops when NOI already ties', () => {
    const inputs = defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    let lines = generateLines(coaList, inputs, fakeUw, null);
    lines = tieNoiToUw(lines, coaMap, fakeUw.noi);
    const again = tieNoiToUw(lines, coaMap, fakeUw.noi);
    expect(JSON.stringify(again.map((l) => l.months))).toBe(JSON.stringify(lines.map((l) => l.months)));
  });
});

describe('buildUtilityModel — seller statement levels + recovery-lag income', () => {
  // seller statement Jul25–Jun26; ownership year Sep 2026 start
  const monthCal = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6];
  const rows: SellerUtilRow[] = [
    { name: 'Gas', pcode: '12', monthCal, months: [10, 10, 20, 50, 100, 150, 160, 150, 100, 50, 20, 10] },
    { name: 'Water/Sewer', pcode: '12', monthCal, months: Array(12).fill(100) },
    { name: 'RUBS-Water/Sewer', pcode: '4', monthCal, months: Array(12).fill(60) },
    { name: 'RUBS-Trash', pcode: '4', monthCal, months: Array(12).fill(20) },
  ];

  it('maps seller lines to the closest Monarch GL at the same calendar month × growth', () => {
    const m = buildUtilityModel(rows, 2026, 9, { growthPct: 0 });
    // ownership month 0 = September: seller Sep gas = 20
    expect(m.expense['6608'][0]).toBe(20);
    // December (ownership month 3): seller Dec gas = 150
    expect(m.expense['6608'][3]).toBe(150);
    expect(m.expense['6622'][0]).toBe(100);           // Water/Sewer → water GL
    expect(sum(m.expense['6608'])).toBe(830);         // full seller gas year
  });

  it('derives recovery % from the seller income/expense ratio and lags one month', () => {
    const m = buildUtilityModel(rows, 2026, 9, { growthPct: 0 });
    // seller: income 960/yr vs expense 830+1200=2030 → 47.29%
    expect(m.recoveryPct).toBeCloseTo(960 / 2030, 3);
    // month 1 (Oct) income = recovery × month 0 (Sep) expense (20+100=120)
    const incomeTot1 = Object.values(m.income).reduce((a, mo) => a + mo[1], 0);
    expect(incomeTot1).toBeCloseTo(m.recoveryPct * 120, 1);
    // month 0 recovers the pre-start month (August): gas 10 + water 100 = 110
    const incomeTot0 = Object.values(m.income).reduce((a, mo) => a + mo[0], 0);
    expect(incomeTot0).toBeCloseTo(m.recoveryPct * 110, 1);
    // income split by seller mix: water 60/80, trash 20/80
    expect(m.income['5174'][1] / m.income['5169'][1]).toBeCloseTo(3, 1);
  });

  it('explicit recovery % wins', () => {
    const m = buildUtilityModel(rows, 2026, 9, { growthPct: 0, recoveryPct: 0.8 });
    expect(m.recoveryPct).toBe(0.8);
  });
});

describe('chargeGlMonthly — rent-roll charge codes → other-income GLs', () => {
  it('maps pet/garage/parking/storage charges', () => {
    const out = chargeGlMonthly({ PETRENT: 1200, GARAGE: 800, PARKING: 300, STORAGE: 150, EMPDISC: -200 });
    expect(out['5165']).toBe(1200);
    expect(out['5160']).toBe(1100);   // garage + parking
    expect(out['5136']).toBe(150);
    expect(out['5121']).toBeUndefined();
  });
  it('charge-driven GLs land at charge × 12 and the cat-5 remainder shrinks', () => {
    const inputs = defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    const lines = generateLines(coaList, inputs, fakeUw, null, null, null, null, null, { PETRENT: 1000 });
    expect(sum(lines.find((l) => l.gl_code === '5165')!.months)).toBe(12000);
    const cats = categoryTotals(lines, coaMap);
    expect(cats['5']).toBeCloseTo(fakeUw.y1['5'], 2);  // still ties: 12,000 charges + 36,000 remainder
  });
});

describe('utilities integration in generateLines', () => {
  const monthCal = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6];
  const sellerUtil: SellerUtilRow[] = [
    { name: 'Electric', pcode: '12', monthCal, months: Array(12).fill(1000) },
    { name: 'RUBS-Water/Sewer', pcode: '4', monthCal, months: Array(12).fill(400) },
  ];
  it('cats 4 & 12 come from the seller model, not UW allocation', () => {
    const inputs = defaultInputs(2026, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    inputs.startMonth = 9;
    inputs.utilities = { source: 'seller', growthPct: 0, recoveryPct: null };
    const lines = generateLines(coaList, inputs, fakeUw, null, null, null, null, sellerUtil);
    expect(sum(lines.find((l) => l.gl_code === '6604')!.months)).toBe(12000);   // electric level from seller
    const cats = categoryTotals(lines, coaMap);
    expect(cats['12']).toBe(12000);                     // NOT the UW 110,000
    expect(cats['4']).toBeCloseTo(0.4 * 12000, 0);      // recovery 40% of billing
    const l = lines.find((x) => x.gl_code === '6604')!;
    expect((l.driver as any).method).toBe('sellerUtil');
  });
  it("source 'uw' falls back to the UW allocation", () => {
    const inputs = defaultInputs(2026, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    inputs.utilities = { source: 'uw' };
    const lines = generateLines(coaList, inputs, fakeUw, null, null, null, null, sellerUtil);
    const cats = categoryTotals(lines, coaMap);
    expect(cats['12']).toBeCloseTo(fakeUw.y1['12'], 2);
  });
});

describe('LTL without lease detail — rent-roll-anchored uniform-expiry burnoff', () => {
  it('starts at the actual rent-roll gap and burns 1/12 of leases per month', () => {
    const inputs = defaultInputs(2026, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 73526 }); // gap 26,474
    inputs.tieIncome = false;
    const lines = generateLines(coaList, inputs, fakeUw, null);   // no leases → uniform burnoff
    const ltl = lines.find((l) => l.gl_code === '5003')!;
    const blend = 0.7 * 0.5 + 0.3 * 1;   // .65 with defaults
    expect(ltl.months[0]).toBeCloseTo(-26474 * (1 - blend / 12), 0);
    expect(ltl.months[11]).toBeCloseTo(-26474 * (1 - blend), 0);  // 35% of the gap left after a year
  });
  it('an EXPLICIT LTL tie rescales the burnoff shape — monotone, never positive, nothing else touched', () => {
    const inputs = defaultInputs(2026, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 73526 });
    let lines = generateLines(coaList, inputs, fakeUw, null);   // tieIncome defaults OFF now
    const before = lines.find((l) => l.gl_code === '5003')!.months.slice();
    const vacBefore = sum(lines.find((l) => l.gl_code === '5031')!.months);
    lines = tieIncomeToUw(lines, coaMap, fakeUw.egi, '5003');
    const ltl = lines.find((l) => l.gl_code === '5003')!;
    expect(ltl.months.every((v) => v <= 0)).toBe(true);
    // burnoff stays monotone (|LTL| declining) — no growing-LTL artifacts
    for (let i = 1; i < 12; i++) expect(Math.abs(ltl.months[i])).toBeLessThanOrEqual(Math.abs(ltl.months[i - 1]) + 0.01);
    expect(sum(lines.find((l) => l.gl_code === '5031')!.months)).toBe(vacBefore);  // vacancy untouched
    const income = sum(rollup(new Map(lines.map((l) => [l.gl_code, l.months]))).get('5500')!);
    expect(income).toBeLessThanOrEqual(fakeUw.egi + 1);
    expect(before[0]).not.toBe(0); // sanity: there was a real burnoff to rescale
  });

  it('generation does NOT auto-tie income by default (LTL purely mechanical)', () => {
    const inputs = defaultInputs(2026, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 73526 });
    expect(inputs.tieIncome).toBe(false);
    const lines = generateLines(coaList, inputs, fakeUw, null);
    const ltl = lines.find((l) => l.gl_code === '5003')!;
    const blend = 0.7 * 0.5 + 0.3 * 1;
    // pure uniform-expiry burnoff of the rent-roll gap, untouched by any tie
    expect(ltl.months[0]).toBeCloseTo(-26474 * (1 - blend / 12), 0);
    for (let i = 1; i < 12; i++) expect(Math.abs(ltl.months[i])).toBeLessThan(Math.abs(ltl.months[i - 1]));
  });
  it('LTL never flips positive on a big tie — and NOTHING else is auto-adjusted', () => {
    // income far under UW → LTL alone cannot absorb; the leftover must stay
    // as visible variance, NOT silently pushed into vacancy or anywhere else
    const inputs = defaultInputs(2026, fakeUw, { marketMonthly: 90000, inPlaceMonthly: 87000 });
    inputs.tieIncome = false;
    let lines = generateLines(coaList, inputs, fakeUw, null);
    const vacBefore = sum(lines.find((l) => l.gl_code === '5031')!.months);
    lines = tieIncomeToUw(lines, coaMap, fakeUw.egi, '5003');
    const ltl = lines.find((l) => l.gl_code === '5003')!;
    expect(ltl.months.every((v) => v <= 0)).toBe(true);           // clamped — no fabricated GTL
    expect(sum(lines.find((l) => l.gl_code === '5031')!.months)).toBe(vacBefore);  // untouched
    const monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
    const income = sum(rollup(monthsMap).get('5500')!);
    expect(income).toBeLessThanOrEqual(fakeUw.egi + 1);           // never overshoots
  });

  it('tie via a different absorber (vacancy) leaves LTL alone', () => {
    const inputs = defaultInputs(2026, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    inputs.tieIncome = false;
    let lines = generateLines(coaList, inputs, fakeUw, null);
    const ltlBefore = sum(lines.find((l) => l.gl_code === '5003')!.months);
    lines = tieIncomeToUw(lines, coaMap, fakeUw.egi, '5031');
    expect(sum(lines.find((l) => l.gl_code === '5003')!.months)).toBe(ltlBefore);
    const monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
    expect(sum(rollup(monthsMap).get('5500')!)).toBeCloseTo(fakeUw.egi, 1);
  });
});

describe('ltlMonths — per-lease burnoff at turnover', () => {
  // ownership year Sep 2026 – Aug 2027
  const leases: Lease[] = [
    { m: 1000, r: 900, e: '2026-11-15' },   // LTL 100, expires Nov (month 2)
    { m: 1000, r: 950, e: '2026-11-20' },   // LTL 50,  expires Nov (month 2)
    { m: 1000, r: 1050, e: '2027-02-10' },  // GTL -50, expires Feb (month 5)
    { m: 1000, r: 800, e: '2027-12-01' },   // LTL 200, expires after the window — never burns
  ];

  it('burns half on renewals, all on move-ins, at each lease\'s turnover month', () => {
    const out = ltlMonths(leases, 2026, 9, { renewalPct: 0.5, burnoffRenew: 0.5, burnoffNew: 1 });
    // months 0-1: full gap = -(100+50-50+200) = -300
    expect(out[0]).toBe(-300);
    expect(out[1]).toBe(-300);
    // month 2: two leases expire; renewalPct .5 → 1 renews. LARGEST LTL (100) renews
    // and keeps half (50); the 50-LTL lease turns over and burns fully (0).
    // total = 50 + 0 - 50 + 200 = 200 → -200
    expect(out[2]).toBe(-200);
    expect(out[4]).toBe(-200);
    // month 5: the GTL lease expires alone; round(.5*1)=1 → renews, keeps half (-25)
    // total = 50 + 0 - 25 + 200 = 225 → -225 through the rest of the year
    expect(out[5]).toBe(-225);
    expect(out[11]).toBe(-225);
  });

  it('missing/expired lease ends turn over in month 0', () => {
    const out = ltlMonths([{ m: 1000, r: 900, e: null }, { m: 1000, r: 900, e: '2026-01-01' }], 2026, 9,
      { renewalPct: 0, burnoffRenew: 0.5, burnoffNew: 1 });
    expect(out[0]).toBe(0);   // both turn over immediately, burn 100%
  });

  it('renewal rate 100% keeps half of everything at expiry', () => {
    const out = ltlMonths([{ m: 1000, r: 800, e: '2026-10-01' }], 2026, 9, { renewalPct: 1, burnoffRenew: 0.5 });
    expect(out[0]).toBe(-200);
    expect(out[1]).toBe(-100);
    expect(out[11]).toBe(-100);
  });
});

describe('ownership year (UW Year 1, e.g. Aug 2026 – Jul 2027)', () => {
  const mkInputs = () => ({ ...defaultInputs(2026, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 }), startMonth: 8 });
  // cat-13 comps: snow removal (winter curve) + janitorial supplies (flat) split 50/50
  const comps = { byGl: { '6818': 60000, '6722': 60000 }, units: 712 };

  it('month 0 = the start month; the FULL Year-1 targets land in the 12 ownership months', () => {
    const inputs = mkInputs();
    const lines = generateLines(coaList, inputs, fakeUw, comps);
    const gpr = lines.find((l) => l.gl_code === '4994')!;
    expect(gpr.months[0]).toBeCloseTo(100000, 0);       // GPR anchors to the rent roll in August
    // snow removal: FULL 62,500 across the ownership year, on the rotated winter curve
    const snow = lines.find((l) => l.gl_code === '6818')!;
    expect(sum(snow.months)).toBeCloseTo(62500, 0);
    expect(snow.months[0]).toBe(0);                     // August (ownership month 0) = no snow
    expect(snow.months[4]).toBeCloseTo(12500, 0);       // December (ownership month 4) = winter weight
    expect(snow.months[6]).toBeCloseTo(12500, 0);       // February (ownership month 6)
    // every category carries its full UW Y1 total
    const cats = categoryTotals(lines, coaMap);
    expect(cats['12']).toBeCloseTo(fakeUw.y1['12'], 2);
    expect(cats['13']).toBeCloseTo(fakeUw.y1['13'], 2);
  });

  it('income ties to full UW EGI via LTL, and NOI ties to full UW NOI', () => {
    const inputs = mkInputs();
    let lines = generateLines(coaList, inputs, fakeUw, comps);
    lines = tieIncomeToUw(lines, coaMap, fakeUw.egi);
    let monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
    expect(sum(rollup(monthsMap).get('5500')!)).toBeCloseTo(fakeUw.egi, 1);
    lines = tieNoiToUw(lines, coaMap, fakeUw.noi);
    monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
    expect(sum(rollup(monthsMap).get('7280')!)).toBeCloseTo(fakeUw.noi, 1);
  });

  it('calendarSlice splits the plan into the two calendar-year uploads', () => {
    const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as Months; // Aug'26..Jul'27
    const y26 = calendarSlice(months, 2026, 8, 2026);
    const y27 = calendarSlice(months, 2026, 8, 2027);
    expect(y26).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5]);       // Aug–Dec 2026
    expect(y27).toEqual([6, 7, 8, 9, 10, 11, 12, 0, 0, 0, 0, 0]);    // Jan–Jul 2027
    // the two slices together carry the whole Year 1
    expect(sum(y26) + sum(y27)).toBe(sum(months));
  });

  it('monthLabels and rotate12 line up', () => {
    const labels = monthLabels(2026, 8);
    expect(labels[0]).toBe('Aug-26');
    expect(labels[4]).toBe('Dec-26');
    expect(labels[5]).toBe('Jan-27');
    expect(labels[11]).toBe('Jul-27');
    const cal = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as Months;
    expect(rotate12(cal, 8)[0]).toBe(8);                // ownership month 0 = August
    expect(monthLabels(2027, 1)[0]).toBe('Jan-27');     // full-calendar budgets unchanged
  });

  it('start month 1 behaves exactly like a calendar year', () => {
    const inputs = defaultInputs(2027, fakeUw, { marketMonthly: 100000, inPlaceMonthly: 97000 });
    const lines = generateLines(coaList, inputs, fakeUw, null);
    const cats = categoryTotals(lines, coaMap);
    for (const p of ['4', '5', '6', '8', '9', '10', '11', '12', '13', '14']) {
      expect(cats[p], `category ${p}`).toBeCloseTo(fakeUw.y1[p], 2);
    }
  });
});
