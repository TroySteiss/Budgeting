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
const resultOf = (c: ExcelJS.Cell): any => (c.value && typeof c.value === 'object' && 'result' in (c.value as any)) ? (c.value as any).result : c.value;

describe('Payroll sheet → Budget sheet', () => {
  it('wage rows are inputs, burden rows are Ratio used × TOTAL WAGES, and the Budget sheet reads every payroll row from the Payroll sheet', async () => {
    const a = args('tst');
    const wb = await load(await buildReviewWorkbook(a));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Budget', 'Payroll', 'Summary', 'Raw Data']);
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
    expect(formulaOf(pay.getCell(rB, 3))).toBe(`$W${rB}*C${wagesRow}`);
    expect(resultOf(pay.getCell(rB, 3))).toBeCloseTo(0.1 * 4000, 1);
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
    expect(names.slice(0, 2)).toEqual(['Portfolio', 'Payroll Summary']);
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
