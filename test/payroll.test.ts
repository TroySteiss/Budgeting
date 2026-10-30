/* Pay-rates domain + staffing-report parser. ALL DATA HERE IS SYNTHETIC —
   never paste real roster rows or rates into fixtures (org data policy). */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  seatMonthly, raisedMonthCount, annualWagesByGl, maskPeople, hiddenAggregates,
  positionGl, isRmPosition, marginalBurdenPct, type StaffingPerson,
} from '../shared/payroll.js';
import { parseStaffingReport, detectUploadKind } from '../src/importers.js';
import { buildRaiseWorkbook, parseRaiseImport, type RaiseExportRow } from '../src/payroll-xlsx.js';

const person = (over: Partial<StaffingPerson>): StaffingPerson => ({
  key: 'x1', name: 'A. Example', position: 'Maintenance Tech I', payMethod: 'Hourly',
  payRate: 20, monthlyBenefits: 450, startDate: '2021-05-01', status: 'FULL', oldPay: null,
  allocations: [{ code: 'spnd', pct: 1 }], rm: false, ...over,
});

describe('pay math', () => {
  it('seatMonthly: hourly 2080hrs/yr, salary /12, × allocation', () => {
    expect(seatMonthly('Hourly', 20, 1)).toBeCloseTo((20 * 2080) / 12, 2);
    expect(seatMonthly('Salary', 60000, 1)).toBe(5000);
    expect(seatMonthly('Salary', 60000, 0.5)).toBe(2500);
  });
  it('raisedMonthCount: proration from the effective month', () => {
    expect(raisedMonthCount('2027-01', 2027)).toBe(12);
    expect(raisedMonthCount('2027-04', 2027)).toBe(9);
    expect(raisedMonthCount('2027-12', 2027)).toBe(1);
    expect(raisedMonthCount('2026-07', 2027)).toBe(12);  // took effect last year
    expect(raisedMonthCount('2028-01', 2027)).toBe(0);   // not yet
    expect(raisedMonthCount('garbage', 2027)).toBe(12);  // unparseable = fully live
  });
  it('annualWagesByGl: GL mapping + proration + allocation share', () => {
    const people = [
      person({ key: 'a', position: 'Leasing Consultant', payMethod: 'Hourly', payRate: 18 }),        // 6402
      person({ key: 'b', position: 'Maintenance Tech I', payMethod: 'Hourly', payRate: 20 }),        // 6404
      person({ key: 'c', position: 'Maint Rover I', payMethod: 'Hourly', payRate: 24, allocations: [{ code: 'spnd', pct: 0.4 }, { code: 'wynd', pct: 0.6 }] }), // 6407
    ];
    // 4% raises effective Apr 2027 → 3 months old rate, 9 months new
    const { wages } = annualWagesByGl(people, 'spnd', { a: 4, b: 4, c: 4 }, '2027-04', 2027);
    const annual = (rate: number, alloc: number) => {
      const cur = seatMonthly('Hourly', rate, alloc);
      const nxt = seatMonthly('Hourly', rate * 1.04, alloc);
      return cur * 3 + nxt * 9;
    };
    expect(wages['6402']).toBeCloseTo(annual(18, 1), 1);
    expect(wages['6404']).toBeCloseTo(annual(20, 1), 1);
    expect(wages['6407']).toBeCloseTo(annual(24, 0.4), 1);
    // nothing lands in 6405 (landscaping is contracted work, not payroll)
    expect(wages['6405']).toBeUndefined();
    // no raise entry = 0%
    const flat = annualWagesByGl(people, 'spnd', {}, '2027-04', 2027).wages;
    expect(flat['6404']).toBeCloseTo(seatMonthly('Hourly', 20, 1) * 12, 1);
  });
  it('positionGl / isRmPosition / burden split', () => {
    expect(positionGl('Regional Property Mgr I').gl).toBe('6402');
    expect(isRmPosition('Regional Property Mgr I')).toBe(true);
    expect(isRmPosition('Property Manager II')).toBe(false);
    expect(positionGl('Underwater Basket Weaver').mapped).toBe(false);
    expect(marginalBurdenPct('Leasing Consultant')).toBeLessThan(marginalBurdenPct('Maintenance Tech I'));
  });
});

describe('RM masking', () => {
  const roster = [
    person({ key: 'pm', position: 'Property Manager I', payMethod: 'Salary', payRate: 60000 }),
    person({ key: 'rm', name: 'R. Regional', position: 'Regional Property Mgr I', payMethod: 'Salary', payRate: 90000, rm: true, allocations: [{ code: 'spnd', pct: 0.1 }, { code: 'wynd', pct: 0.1 }] }),
  ];
  it('maskPeople strips every pay figure off RM seats for non-allowlisted viewers', () => {
    const masked = maskPeople(roster, false);
    const rm = masked.find((p) => p.key === 'rm')!;
    expect(rm.payHidden).toBe(true);
    expect(rm.payRate).toBe(0);
    expect(rm.monthlyBenefits).toBe(0);
    expect(rm.name).toBe('R. Regional');            // the row itself stays
    expect(masked.find((p) => p.key === 'pm')!.payRate).toBe(60000);
    expect(maskPeople(roster, true).find((p) => p.key === 'rm')!.payRate).toBe(90000);
  });
  it('hiddenAggregates reconcile masked totals per property', () => {
    const agg = hiddenAggregates(roster, { rm: 5 }, ['spnd', 'wynd']);
    expect(agg.spnd.curMo).toBeCloseTo(seatMonthly('Salary', 90000, 0.1), 2);
    expect(agg.spnd.newMo).toBeCloseTo(seatMonthly('Salary', 90000 * 1.05, 0.1), 2);
    expect(agg.wynd.curMo).toBe(agg.spnd.curMo);
  });
});

describe('excel round trip (synthetic)', () => {
  const row = (over: Partial<RaiseExportRow>): RaiseExportRow => ({
    key: 'k1', name: 'A. Example', position: 'Maintenance Tech I', primCode: 'cwnd', primPct: 1,
    splitNote: '', payMethod: 'Hourly', payRate: 20, regionMoCur: 3466.67, raisePct: 3,
    by: 'TS', at: '2026-10-30', rm: false, ...over,
  });
  it('export → import returns every unmasked row with its raise %', async () => {
    const buf = await buildRaiseWorkbook({
      cycleLabel: 'FY27 raises', effective: '2027-01', region: 'Bismarck ND', iterNum: 2,
      finalized: null, exportedBy: 'Troy Steiss',
      rows: [
        row({ key: 'k1', raisePct: 3 }),
        row({ key: 'k2', name: 'B. Sample', position: 'Leasing', primCode: 'lhnd', raisePct: 4.5, splitNote: 'also CWND 40%' }),
        row({ key: 'rm1', name: 'R. Masked', position: 'Regional', payRate: null, regionMoCur: null, rm: true, raisePct: 0 }),
      ],
      hidden: { curMo: 900, newMo: 927 },
      allocations: [
        { key: 'k1', name: 'A. Example', position: 'Maintenance Tech I', payMethod: 'Hourly', payRate: 20, monthlyBenefits: 400, status: 'FULL', startDate: '2021-01-01', code: 'cwnd', pct: 1 },
      ],
    });
    const pairs = parseRaiseImport(buf);
    const byKey = Object.fromEntries(pairs.map((p) => [p.key, p.pct]));
    expect(byKey.k1).toBe(3);
    expect(byKey.k2).toBe(4.5);
    expect('rm1' in byKey).toBe(false);   // masked row exports no editable raise value... unless typed in
  });
  it('rejects a workbook without Key/Raise % columns', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Amount'], ['x', 1]]), 'Sheet1');
    expect(() => parseRaiseImport(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)).toThrow(/Key/);
  });
});

describe('staffing report parser (synthetic workbook)', () => {
  function syntheticWorkbook(): Buffer {
    const roster = [
      ['PrismID', 'EmployeeNumber', 'EmployeeName', 'DivisionCode', 'EmployerStartDate', 'PositionDescription', 'JobTitle', 'PayMethod', 'PayRate', 'MonthlyBenefits', 'PropertyCode', 'PropertyIfUnallocated', 'Employee Status', 'OldPay'],
      [101, 'E1', 'Alex Sample', 'SPND', 44197, 9001, 'Leasing Consultant', 'Hourly', 18.5, 400, 'SPND', 'SPND', 'FULL', 17.5],
      [102, 'E2', 'Blake Demo', 'WYND', 44562, 9002, 'Maintenance Tech I', 'Hourly', 21, 0, 'WYND', 'WYND', 'FULL', null],
      [103, 'E3', 'Casey Fake', 'SPND', 43831, 9003, 'Maint Rover I', 'Hourly', 24, 350, 'SPND', 'Allocated', 'FULL', null],
      [104, 'E4', 'Drew Mock', 'ND', 42000, 9004, 'Regional Property Mgr I', 'Salary', 95000, 900, 'SPND', 'Allocated', 'FULL', null],
      [null, null, null, null, null, null, null, null, null, null, null, null, null, null],
    ];
    const alloc = [
      ['Prism ID', 'Employee Name', 'Position', 'Split', 'Department', 'Property Code'],
      [103, 'Casey Fake', 'Maint Rover I', 0.4, 'South Pointe', 'spnd'],
      [103, 'Casey Fake', 'Maint Rover I', 0.6, 'Wyatt', 'wynd'],
      [104, 'Drew Mock', 'Regional Property Mgr I', 0.5, 'South Pointe', 'spnd'],
      [104, 'Drew Mock', 'Regional Property Mgr I', 0.5, 'Wyatt', 'wynd'],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(roster), 'Dictionary of Employees');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(alloc), 'Allocated Employee Data');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
  const buf = syntheticWorkbook();

  it('detects the kind', () => {
    expect(detectUploadKind(buf)).toBe('staffing');
  });
  it('parses the ND payroll Splits/Wages grid (the "Ongoing" workbook shape)', () => {
    const splits = [
      [null, 'Unit count', null, null, null, 341, 196, 276],
      [null, 'Jan - Dec 2026 Budgets'],
      [],
      [null, null, null, null, 'MIMG', 'CLND', 'SPND', 'WYND', 'Hourly', 'Annual', 'Check'],
      [null, 'Minot Support Staff', 'Regional', 'Robin Sample', 5000, 20000, 15000, 10000, 45, 50000, 0],
      [null, null, 'Leasing', 'Lee Demo', null, 37440, null, null, 18, 37440, 0],
      [null, null, 'Maintenance', 'Max Mock', null, null, 22880, 22880, 22, 45760, 0],
      [null, null, 'Count', 'Check row', null, 1, 1, 1],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(splits), 'Splits');
    const p = parseStaffingReport(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    expect(p.people).toHaveLength(3);
    const robin = p.people.find((x) => x.name === 'Robin Sample')!;
    expect(robin.rm).toBe(true);
    expect(robin.payMethod).toBe('Hourly');
    expect(robin.payRate).toBe(45);
    // allocation %s = per-property $ share of the row total (MIMG included in the base)
    expect(robin.allocations).toEqual([{ code: 'clnd', pct: 0.4 }, { code: 'spnd', pct: 0.3 }, { code: 'wynd', pct: 0.2 }]);
    const lee = p.people.find((x) => x.name === 'Lee Demo')!;
    expect(lee.allocations).toEqual([{ code: 'clnd', pct: 1 }]);
    expect(p.people.some((x) => /check/i.test(x.name))).toBe(false);
    expect(p.label).toContain('Splits');
  });
  it('parses roster, splits, RM flag, dates, pay methods', () => {
    const p = parseStaffingReport(buf);
    expect(p.people).toHaveLength(4);
    const alex = p.people.find((x) => x.name === 'Alex Sample')!;
    expect(alex.key).toBe('101');
    expect(alex.position).toBe('Leasing Consultant');
    expect(alex.payMethod).toBe('Hourly');
    expect(alex.payRate).toBe(18.5);
    expect(alex.oldPay).toBe(17.5);
    expect(alex.allocations).toEqual([{ code: 'spnd', pct: 1 }]);
    expect(alex.startDate).toBe('2021-01-01');                     // excel serial 44197
    const casey = p.people.find((x) => x.name === 'Casey Fake')!;  // split via alloc sheet
    expect(casey.allocations).toEqual([{ code: 'spnd', pct: 0.4 }, { code: 'wynd', pct: 0.6 }]);
    const drew = p.people.find((x) => x.name === 'Drew Mock')!;
    expect(drew.rm).toBe(true);
    expect(drew.payMethod).toBe('Salary');
    expect(drew.allocations.map((a) => a.code).sort()).toEqual(['spnd', 'wynd']);
  });
});
