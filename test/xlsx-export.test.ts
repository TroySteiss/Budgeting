/* Excel export — the Payroll sheet flows into each property's Budget sheet
   (Troy 2026-11-03): wage rows are inputs, every other payroll GL is
   "Ratio used × TOTAL WAGES", the Budget sheet's payroll rows are live
   references, and the portfolio carries a Payroll Summary. Synthetic data only. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { generateAnnualLines, defaultAnnualInputs, refColumn, type AnnualSources } from '../shared/annual.js';
import { sum, type CoaAccount, type Months } from '../shared/domain.js';
import { buildReviewWorkbook, buildPortfolioWorkbook, type ReviewArgs } from '../src/xlsx-export.js';
import { fillCachedResults } from '../src/xlsx-calc.js';

// the seed chart has no `active` flag (the database sets it) — the export only lays out active accounts
const coaList: CoaAccount[] = JSON.parse(readFileSync(join(process.cwd(), 'seed', 'coa.json'), 'utf8')).map((a: any) => ({ active: true, ...a }));
const cal = (vals: number[]): Months => vals as Months;
const actual: Record<string, Months> = {
  '4994': cal(Array(12).fill(10000)), '5031': cal(Array(12).fill(-400)), '6116': cal(Array(12).fill(900)),
  '6402': cal(Array(12).fill(2000)), '6404': cal(Array(12).fill(1000)), '6418': cal(Array(12).fill(300)), '6422': cal(Array(12).fill(150)),
  '6604': cal(Array(12).fill(200)), '7300': cal(Array(12).fill(1500)),
};
const budgetCal: Record<string, Months> = { '6402': cal(Array(12).fill(2100)), '6404': cal(Array(12).fill(900)), '6418': cal(Array(12).fill(450)) };

function args(code: string, basis: 't12' | 'budget' | 'mix' = 't12'): ReviewArgs {
  const inputs = { ...defaultAnnualInputs(2026, 10, actual, null, coaList, null, 10), wagesFromRoster: true, burdenBasis: basis };
  const src: AnnualSources = { actual, budget: budgetCal, lastMonth: 10, payrollWages: { '6402': 36000, '6404': 12000 } };
  const lines = generateAnnualLines(coaList, inputs, src);
  return {
    propertyCode: code, propertyName: `Test ${code}`, year: 2026, units: 10, coa: coaList, lines, inputs, uw: null, annual: true,
    refs: [{ key: 'actual', label: 'T12 actuals', period: 'Nov 2024-Oct 2025', ...refColumn(actual) }, { key: 'budget', label: '2025 budget', period: '2025', ...refColumn(budgetCal) }],
    payrollHist: { t12: actual, t12Label: 'T12 actuals', budget: budgetCal, budgetLabel: '2025 budget' },
  };
}
async function load(buf: Buffer): Promise<ExcelJS.Workbook> { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as any); return wb; }
const rowOfCode = (ws: ExcelJS.Worksheet, code: string): number => {
  let found = 0;
  ws.eachRow((row, n) => { if (!found && String(row.getCell(1).value) === code) found = n; });
  return found;
};
const formulaOf = (c: ExcelJS.Cell): string => (c.value && typeof c.value === 'object' && 'formula' in (c.value as any)) ? String((c.value as any).formula) : '';
const resultOf = (c: ExcelJS.Cell): any => (c.value && typeof c.value === 'object' && 'formula' in (c.value as any)) ? (c as any).model.result : c.value;

describe('Payroll sheet → Budget sheet', () => {
  it('wage rows are inputs, burden rows are Ratio used × TOTAL WAGES, and the Budget sheet reads every payroll row from the Payroll sheet', async () => {
    const a = args('tst');
    const wb = await load(await buildReviewWorkbook(a));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Budget Comps', 'Budget', 'Payroll', 'Summary', 'Raw Data']);   // the comps summary is the first tab
    const pay = wb.getWorksheet('Payroll')!, bud = wb.getWorksheet('Budget')!;
    const rW = rowOfCode(pay, '6402'), rB = rowOfCode(pay, '6418'), rM = rowOfCode(pay, '6404');
    expect(rW && rB && rM).toBeTruthy();
    // roster wages flat, no March step: 36,000 / 12
    expect(resultOf(pay.getCell(rW, 3))).toBeCloseTo(3000, 2);
    expect(formulaOf(pay.getCell(rW, 3))).toBe('');
    // TOTAL WAGES row sits right under the last wage GL (6407 in the chart) and adds every wage row
    let wagesRow = 0;
    pay.eachRow((row, n) => { if (!wagesRow && n > 5 && String(row.getCell(2).value || '').includes('TOTAL WAGES')) wagesRow = n; });
    expect(wagesRow).toBe(rowOfCode(pay, '6407') + 1);
    expect(formulaOf(pay.getCell(wagesRow, 3))).toBe(['6402', '6404', '6405', '6407'].map((g) => `C${rowOfCode(pay, g)}`).join('+'));
    // 6418: T12 ratio 3,600 / 36,000 = 10% → Ratio used (W) = T12 % of wages (U); months = $W × wages
    expect(formulaOf(pay.getCell(rB, 23))).toBe(`U${rB}`);
    expect(resultOf(pay.getCell(rB, 23))).toBeCloseTo(0.1, 4);
    // spec 1.2: each month = Ratio used × that month's factor (col Z on: its ratio ÷ the year's) × wages — the engine's month
    expect(formulaOf(pay.getCell(rB, 3))).toBe(`$W${rB}*Z${rB}*C${wagesRow}`);
    expect(resultOf(pay.getCell(rB, 3))).toBeCloseTo(400, 1);                       // the engine's January, to the cent
    expect(Number(pay.getCell(rB, 26).value)).toBeCloseTo(400 / (0.1 * 4000), 6);
    expect(formulaOf(pay.getCell(rB, 21))).toBe(`IF($P$${wagesRow}<>0,P${rB}/$P$${wagesRow},"")`);
    expect(resultOf(pay.getCell(rB, 16))).toBeCloseTo(3600, 1);     // T12 actuals column
    expect(resultOf(pay.getCell(rB, 17))).toBeCloseTo(5400, 1);     // CY budget column
    // the Budget sheet's payroll rows are references into the Payroll sheet
    const bW = rowOfCode(bud, '6402'), bB = rowOfCode(bud, '6418');
    expect(formulaOf(bud.getCell(bW, 5))).toBe(`Payroll!C${rW}`);
    expect(formulaOf(bud.getCell(bB, 9))).toBe(`Payroll!G${rB}`);
    expect(resultOf(bud.getCell(bB, 5))).toBeCloseTo(400, 1);
    expect(String(bud.getCell(bB, 4).value)).toContain('→ Payroll sheet');
    // a non-payroll row is untouched (plain value)
    const b6604 = rowOfCode(bud, '6604');
    expect(formulaOf(bud.getCell(b6604, 5))).toBe('');
    // the historicals sit below the budget block
    let histHead = 0;
    pay.eachRow((row, n) => { if (!histHead && String(row.getCell(2).value || '').startsWith('T12 actuals — by calendar month')) histHead = n; });
    expect(histHead).toBeGreaterThan(rB);
    expect(resultOf(pay.getCell(histHead + 1, 3))).toBeDefined();
  });

  it("the ratio defaults follow the budget's burden basis", async () => {
    const mixWb = await load(await buildReviewWorkbook(args('mix', 'mix')));
    const pay = mixWb.getWorksheet('Payroll')!;
    const rB = rowOfCode(pay, '6418');
    expect(formulaOf(pay.getCell(rB, 23))).toBe(`AVERAGE(U${rB},V${rB})`);
    expect(resultOf(pay.getCell(rB, 23))).toBeCloseTo((0.1 + 0.15) / 2, 4);
    const budWb = await load(await buildReviewWorkbook(args('bud', 'budget')));
    expect(formulaOf(budWb.getWorksheet('Payroll')!.getCell(rB, 23))).toBe(`V${rB}`);
  });

  it('portfolio: a Payroll Summary behind the Portfolio tab, one live row per property', async () => {
    const wb = await load(await buildPortfolioWorkbook([args('aaa'), args('bbb')], 'Test portfolio'));
    const names = wb.worksheets.map((w) => w.name);
    expect(names.slice(0, 4)).toEqual(['Portfolio Comps', 'Schedule', 'Portfolio', 'Payroll Summary']);   // comps panel + Schedule lead the portfolio workbook
    expect(names).toContain('AAA Payroll');
    const ps = wb.getWorksheet('Payroll Summary')!;
    expect(String(ps.getCell(4, 1).value)).toBe('AAA');
    expect(formulaOf(ps.getCell(4, 2))).toMatch(/^'AAA Payroll'!\$O\$\d+$/);
    expect(formulaOf(ps.getCell(5, 3))).toMatch(/^'BBB Payroll'!\$P\$\d+$/);
    expect(formulaOf(ps.getCell(4, 7))).toMatch(/^INDEX\('AAA Payroll'!\$B\$\d+:\$B\$\d+,MATCH\(MAX/);
    expect(formulaOf(ps.getCell(6, 2))).toBe('SUM(B4:B5)');
    const a = args('aaa');
    const payTot = a.lines.filter((l) => coaList.find((c) => c.code === l.gl_code)?.pcode === '10').reduce((s2, l) => s2 + sum(l.months), 0);
    expect(resultOf(ps.getCell(4, 2))).toBeCloseTo(payTot, 0);
    // the AAA Budget sheet's payroll rows point at the prefixed Payroll sheet
    const bud = wb.getWorksheet('AAA Budget')!;
    expect(formulaOf(bud.getCell(rowOfCode(bud, '6402'), 5))).toMatch(/^'AAA Payroll'!C\d+$/);
  });
});

describe('Budget Comps sheet (the budget-comps summary panel) and the Schedule', () => {
  const withTrend = (code: string, region: string, k: number): ReviewArgs => {
    const a = args(code);
    const noi = refColumn(actual).totals['7280'];
    return { ...a, region, summaryLabels: { t12: 'Oct. 25 T12', t4: 'Oct. T4 Ann.', draft: 'Draft #1' },
      refs: [...(a.refs || []), { key: 'ann4', label: '4 mo annualized', period: '', ...refColumn(Object.fromEntries(Object.entries(actual).map(([g, m]) => [g, m[0] * 12 * k]))) }],
      noiTrend: [{ label: 'Aug.', noi: null }, { label: 'Sep.', noi: Math.round(noi * 0.98) }, { label: 'Oct.', noi }] };
  };
  it('every line is a live formula into the Budget sheet / Raw Data and its cached result matches the budget', async () => {
    const a = withTrend('tst', 'Minot ND', 1.02);
    const wb = await load(await buildReviewWorkbook(a));
    const x = wb.getWorksheet('Budget Comps')!, bud = wb.getWorksheet('Budget')!;
    expect(String(x.getCell('C3').value)).toBe('Oct. 25 T12');
    const r5070 = rowOfCode(bud, '5070'), r6116 = rowOfCode(bud, '6116'), r6470 = rowOfCode(bud, '6470');
    expect(formulaOf(x.getCell('C8'))).toBe(`+Budget!T${r5070}`);          // T12 actuals column
    expect(formulaOf(x.getCell('E8'))).toBe(`+Budget!R${r5070}`);          // the budget's annual column
    expect(formulaOf(x.getCell('E13'))).toBe(`+Budget!R${r6116}`);
    expect(formulaOf(x.getCell('E16'))).toBe(`+Budget!R${r6470}`);
    expect(formulaOf(x.getCell('D8'))).toMatch(/^\+'Raw Data'!B\d+$/);     // four months annualized
    expect(resultOf(x.getCell('C8'))).toBeCloseTo(resultOf(bud.getCell(r5070, 20)), 2);
    expect(resultOf(x.getCell('E8'))).toBeCloseTo(resultOf(bud.getCell(r5070, 18)), 2);
    // NOI = income - expense, and it equals the budget's own NOI line
    expect(formulaOf(x.getCell('E26'))).toBe('E10-E23');
    expect(resultOf(x.getCell('E26'))).toBeCloseTo(resultOf(bud.getCell(rowOfCode(bud, '7280'), 18)), 0);
    expect(resultOf(x.getCell('C26'))).toBeCloseTo(refColumn(actual).totals['7280'], 0);
    // the workbook's fills: blue T12, green T4
    expect((x.getCell('C8').fill as any).fgColor.argb).toBe('FFDDEBF7');
    expect((x.getCell('D8').fill as any).fgColor.argb).toBe('FFE2EFDA');
    // the import of an edited draft still finds the Budget sheet, not this one
    expect(/(^| )budget$/i.test('Budget Comps')).toBe(false);
  });
  it('portfolio: a panel per property, a summed Portfolio Comps panel and a Schedule per region with the colour scale', async () => {
    const wb = await load(await buildPortfolioWorkbook([withTrend('aaa', 'Minot ND', 1.02), withTrend('bbb', 'Minot ND', 1.05), withTrend('ccc', 'Williston ND', 1)], 'Test'));
    expect(wb.getWorksheet('AAA Budget Comps')).toBeTruthy();
    expect(wb.getWorksheet('CCC Budget Comps')).toBeTruthy();
    const pc = wb.getWorksheet('Portfolio Comps')!;
    expect(formulaOf(pc.getCell('E8'))).toBe("+'AAA Budget Comps'!E8+'BBB Budget Comps'!E8+'CCC Budget Comps'!E8");
    expect(resultOf(pc.getCell('E26'))).toBeCloseTo(3 * resultOf(wb.getWorksheet('AAA Budget Comps')!.getCell('E26')), 0);
    const sch = wb.getWorksheet('Schedule')!;
    expect(String(sch.getCell('B2').value)).toBe('Minot ND');
    // the Aug. window is on file for nobody, so it is not a column: Sep., Oct., then the NOI budget
    expect(String(sch.getCell('D3').value)).toBe('Sep. T12 NOI Trend');
    expect(String(sch.getCell('E3').value)).toBe('Oct. T12 NOI Trend');
    expect(formulaOf(sch.getCell('D4'))).toMatch(/^\+'AAA Raw Data'!B\d+$/);
    expect(formulaOf(sch.getCell('E4'))).toBe("+'AAA Budget Comps'!C26");
    expect(formulaOf(sch.getCell('F4'))).toBe("+'AAA Budget Comps'!E26");
    expect(formulaOf(sch.getCell('I4'))).toMatch(/^IFERROR\(\(F4-'AAA Raw Data'!B\d+\)\/'AAA Raw Data'!B\d+,""\)$/);   // growth over the current-year budget
    expect(String(sch.getCell('C6').value)).toBe('Average');
    const cfs = (sch as any).conditionalFormattings as any[];
    const minot = cfs.filter((c) => /^[A-Z]+4:[A-Z]+5$/.test(c.ref));
    expect(minot.map((c) => c.ref)).toEqual(['G4:G5', 'H4:H5', 'I4:I5', 'J4:J5', 'M4:M5', 'N4:N5']);
    expect(minot[0].rules[0].type).toBe('colorScale');
    expect(minot[0].rules[0].color.map((c: any) => c.argb)).toEqual(['FF63BE7B', 'FFFFEB84', 'FFF8696B']);
    // a one-property region has nothing to scale
    expect(String(sch.getCell('B9').value)).toBe('Williston ND');
    expect(cfs.length).toBe(6);
  });
});

describe('stored formula values (nothing blank before "Enable Editing")', () => {
  it('works out the functions the exports write', () => {
    const wb = new ExcelJS.Workbook();
    const a = wb.addWorksheet('A B'), b = wb.addWorksheet('Calc');
    a.getCell('A1').value = 10; a.getCell('A2').value = 30; a.getCell('B1').value = 'x'; a.getCell('B2').value = 'y';
    const f = (addr: string, formula: string) => { b.getCell(addr).value = { formula } as any; };
    f('A1', "SUM('A B'!A1:A2)"); f('A2', 'A1/4-ABS(-2)'); f('A3', 'IF(A9<>0,A1/A9,"")'); f('A4', 'IFERROR(A1/A9,"n/a")');
    f('A5', "INDEX('A B'!$B$1:$B$2,MATCH(MAX('A B'!$A$1:$A$2),'A B'!$A$1:$A$2,0))"); f('A6', 'AVERAGE(A1,A2)+MIN(A1:A2)');
    f('A7', "SUMIF('A B'!A1:A3,\"<>\",'A B'!A1:A3)"); f('A8', 'A1/A9'); f('B1', 'NOSUCHFN(A1)'); f('B2', '-A1*50%');
    fillCachedResults(wb);
    const r = (addr: string) => (b.getCell(addr) as any).model.result;   // cell.value hides a stored 0 or ""
    expect(r('A1')).toBe(40); expect(r('A2')).toBe(8); expect(r('A3')).toBe(''); expect(r('A4')).toBe('n/a');
    expect(r('A5')).toBe('y'); expect(r('A6')).toBe(32); expect(r('A7')).toBe(40);
    expect(r('A8')).toEqual({ error: '#DIV/0!' });
    expect(r('B1')).toBeUndefined();          // a function it does not know is left alone
    expect(r('B2')).toBe(-20);
  });
  it('every formula in the property and portfolio workbooks carries a value', async () => {
    // read the sheet XML itself: ExcelJS hides a stored 0 or "" when it loads a file back
    const JSZip = (await import('jszip')).default;
    for (const buf of [await buildReviewWorkbook(args('tst')), await buildPortfolioWorkbook([args('aaa'), args('bbb')], 'Test')]) {
      const zip = await JSZip.loadAsync(buf);
      let formulas = 0;
      const missing: string[] = [];
      for (const name of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
        const xml = await zip.files[name].async('string');
        for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(.*?)<\/c>/g)) {
          if (!m[2].includes('<f')) continue;
          formulas++;
          if (!/<v[ >\/]/.test(m[2])) missing.push(`${name} ${m[1]}`);
        }
      }
      expect(formulas).toBeGreaterThan(1000);
      expect(missing).toEqual([]);
    }
  });
});

describe('hard-coded numbers stand out in the workbook', () => {
  it('a typed cell is bold in the hard-code colour; the other cells of that line and formula lines are not', async () => {
    const a = args('tst');
    const hand = a.lines.find((l) => !['6402', '6404', '6405', '6407'].includes(l.gl_code) && Number(l.gl_code) > 6500 && Number(l.gl_code) < 6700 && l.months.some((v) => v))!;
    const live = a.lines.find((l) => l !== hand && Number(l.gl_code) > 6500 && Number(l.gl_code) < 6700 && l.months.every((v) => v))!;
    hand.override = true;
    const typed = hand.months.findIndex((v) => v), other = hand.months.findIndex((v, i) => v && i !== typed);
    hand.driver = { ...(hand.driver as any), hard: [typed] };
    const wb = await load(await buildReviewWorkbook(a));
    const bud = wb.getWorksheet('Budget')!;
    const firstMonth = (gl: string, months: number[]) => bud.getCell(rowOfCode(bud, gl), 5 + months.findIndex((v) => v));
    const fh = firstMonth(hand.gl_code, hand.months).font!, fl = firstMonth(live.gl_code, live.months).font!;
    expect(fh.bold).toBe(true);
    expect(fh.color?.argb).toBe('FFC2185B');
    expect(!!fl.bold).toBe(false);
    // per CELL: another month of the same line is not marked
    if (other >= 0) expect(!!bud.getCell(rowOfCode(bud, hand.gl_code), 5 + other).font?.bold).toBe(false);
    // a hand-fixed line with no record of cells (a typed total, Smooth, an import): every month is marked
    delete (hand.driver as any).hard;
    const wb2 = await load(await buildReviewWorkbook(a)); const bud2 = wb2.getWorksheet('Budget')!;
    if (other >= 0) expect(bud2.getCell(rowOfCode(bud2, hand.gl_code), 5 + other).font?.bold).toBe(true);
    // a smoothed line is formula-driven, not hard-coded: nothing marked
    hand.driver = { ...(hand.driver as any), smooth: { passes: 2, mult: 5 } };
    const wb3 = await load(await buildReviewWorkbook(a)); const bud3 = wb3.getWorksheet('Budget')!;
    expect(!!bud3.getCell(rowOfCode(bud3, hand.gl_code), 5 + typed).font?.bold).toBe(false);
    expect(fl.color?.argb).not.toBe('FFC2185B');
  });
});
