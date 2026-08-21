import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUwBook, parseRentRoll, parseComparison, parseSellerT12 } from '../src/importers.js';
import { t12CategoryShapes } from '../shared/domain.js';

const fx = (name: string): Buffer => readFileSync(join(process.cwd(), 'test', 'fixtures', name));

describe('parseUwBook — Bismarck', () => {
  const sheets = parseUwBook(fx('bismarck-uw.xlsx'));

  it('finds the portfolio and 4 property sheets', () => {
    expect(sheets.length).toBe(5);
    expect(sheets.filter((s) => s.isPortfolio).length).toBe(1);
  });
  it('portfolio ties to known EGI/TOE/NOI', () => {
    const p = sheets.find((s) => s.isPortfolio)!;
    expect(p.data.egi).toBeCloseTo(11918258.14, 1);
    expect(p.data.toe).toBeCloseTo(4612425.47, 1);
    expect(p.data.noi).toBeCloseTo(7305832.67, 1);
  });
  it('handles the offset Cottonwood sheet', () => {
    const c = sheets.find((s) => /cottonwood/i.test(s.sheetName))!;
    expect(c.data.units).toBe(268);
    expect(c.data.egi).toBeCloseTo(5157026.18, 1);
    expect(c.data.noi).toBeCloseTo(3154039.68, 1);
  });
  it('per-property NOIs tie', () => {
    const noi = (name: RegExp) => sheets.find((s) => name.test(s.sheetName))!.data.noi;
    expect(noi(/legacy/i)).toBeCloseTo(1426163.17, 1);
    expect(noi(/north ridge/i)).toBeCloseTo(815590.6, 1);
    expect(noi(/river ridge/i)).toBeCloseTo(1910039.22, 1);
  });
  it('captures T12 panel with pcodes', () => {
    const c = sheets.find((s) => /legacy/i.test(s.sheetName))!;
    expect(c.data.t12!.length).toBeGreaterThan(20);
    expect(c.data.t12!.every((r) => /^\d{6}-\d{3}$/.test(r.gl))).toBe(true);
  });
});

describe('parseUwBook — Jamestown', () => {
  const sheets = parseUwBook(fx('jamestown-uw.xlsx'));
  it('portfolio NOI ties', () => {
    const p = sheets.find((s) => s.isPortfolio)!;
    expect(p.data.noi).toBeCloseTo(2945260.7, 1);
  });
  it('Deer Ridge units + NOI tie', () => {
    const d = sheets.find((s) => /deer ridge/i.test(s.sheetName))!;
    expect(d.data.units).toBe(163);
    expect(d.data.noi).toBeCloseTo(2017940.95, 1);
    expect(d.data.egi).toBeCloseTo(3316417.03, 1);
  });
  it('Deer Ridge picks up "Less:"-prefixed LTL and concessions', () => {
    const d = sheets.find((s) => /deer ridge/i.test(s.sheetName))!;
    expect(d.data.y1['loss']).toBeCloseTo(-80477.32, 1);
    expect(d.data.y1['2']).toBeCloseTo(-16095.46, 1);
    // income identity: GPR + loss + conc + rental loss + util + other = EGI
    const y = d.data.y1;
    const egi = y['1'] + y['loss'] + y['2'] + y['3'] + y['4'] + y['5'];
    expect(egi).toBeCloseTo(d.data.egi, 1);
  });
});

describe('parseRentRoll — Yardi summary', () => {
  const props = parseRentRoll(fx('rentroll-summary.xlsx'));
  it('parses all six properties', () => {
    expect(props.length).toBe(6);
    expect(props.reduce((a, p) => a + p.units, 0)).toBe(848);
  });
  it('cwnd market rent ties', () => {
    const c = props.find((p) => p.code === 'cwnd')!;
    expect(c.marketMonthly).toBeCloseTo(433530, 0);
    expect(c.units).toBe(268);
    expect(c.inPlaceMonthly).toBeCloseTo(383214, 0);
  });
});

describe('parseRentRoll — OneSite unit level', () => {
  it('rejects a non-rent-roll workbook', () => {
    expect(() => parseRentRoll(fx('fhnd-budget-workbook.xlsx'))).toThrow();
  });

  it('captures per-lease detail (market, rent, lease end) from a unit-level roll', () => {
    const XLSX = require('xlsx');
    const aoa = [
      ['OneSite Report'], ['RENT ROLL DETAIL'], ['As of Date: 09/01/2026'], [],
      ['Resh ID', 'Unit', 'Floorplan', 'SQFT', 'Unit/Lease Status', 'Lease Start', 'Lease End', 'Market + Addl.', 'Lease Rent', 'RENT', 'PETRENT', 'GARAGE', 'Total Billing'],
      ['1', 'A-101', '1x1', 700, 'Occupied', '2025-11-15 00:00', '2026-11-14 00:00', 1000, 900, 900, 35, 50, 985],
      ['2', 'A-102', '1x1', 700, 'Occupied', '2026-02-10 00:00', '2027-02-09 00:00', 1000, 1050, 1050, 0, 50, 1100],
      ['3', 'A-103', '1x1', 700, 'Vacant', '', '', 1000, 0, 0, 0, 0, 0],
      ['2b', 'A-102', '1x1', 700, 'Pending renewal', '2027-02-10 00:00', '2028-02-09 00:00', 0, 1100, 1100, 0, 50, 1150],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Report1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const [p] = parseRentRoll(buf);
    expect(p.units).toBe(3);
    expect(p.marketMonthly).toBe(3000);
    expect(p.inPlaceMonthly).toBe(1950);
    expect(p.leases!.length).toBe(2);           // occupied units only; the pending-renewal dup is ignored
    const a101 = p.leases!.find((l) => l.r === 900)!;
    expect(a101.m).toBe(1000);
    expect(a101.e).toContain('2026-11');
    // ancillary charge codes captured (occupied units only; base RENT and Total excluded)
    expect(p.charges).toEqual({ PETRENT: 35, GARAGE: 100 });
  });
});

describe('parseSellerT12 — Deer Ridge Jun-26', () => {
  const t = parseSellerT12(fx('deerridge-t12.xlsx'));
  it('captures the statement header', () => {
    expect(t.label.toLowerCase()).toContain('deer ridge');
    expect(t.period).toContain('Jun 2026');
    expect(t.monthCal).toEqual([7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6]); // Jul 2025 → Jun 2026
  });
  it('parses detail rows only (no -999/-000)', () => {
    expect(t.rows.length).toBeGreaterThan(30);
    expect(t.rows.every((r) => !r.gl.endsWith('-999') && !r.gl.endsWith('-000'))).toBe(true);
    const mkt = t.rows.find((r) => r.gl === '410100-020')!;
    expect(mkt.total).toBeCloseTo(3148515, 0);
    expect(mkt.months.reduce((a, b) => a + b, 0)).toBeCloseTo(3148515, 0);
  });
  it('produces category shapes via the UW T12 pcode mapping', () => {
    const uw = parseUwBook(fx('jamestown-uw.xlsx')).find((s) => /deer ridge/i.test(s.sheetName))!;
    const glToPcode: Record<string, string> = {};
    for (const r of uw.data.t12!) glToPcode[r.gl] = r.pcode;
    const shapes = t12CategoryShapes(t.rows, t.monthCal, glToPcode);
    // utilities must have a real winter-heavy shape summing to 1, in calendar order
    expect(shapes['12']).toBeTruthy();
    const s12 = shapes['12']!;
    expect(s12.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const winter = s12[0] + s12[1] + s12[11]; // Jan+Feb+Dec
    const summer = s12[5] + s12[6] + s12[7];  // Jun+Jul+Aug
    expect(winter).toBeGreaterThan(summer);
    // several other categories get shapes too
    expect(Object.keys(shapes).length).toBeGreaterThanOrEqual(5);
  });
});

describe('parseComparison — Minot 4 12-Month Budget (monthly variant)', () => {
  const c = parseComparison(fx('minot4-12mo-budget.xlsx'));
  it('detects the monthly layout', () => {
    expect(c.monthly).toBe(true);
    expect(c.monthCal).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(c.rows.length).toBeGreaterThan(80);
  });
  it('captures GPR with monthly values', () => {
    const gpr = c.rows.find((r) => r.gl === '4994')!;
    expect(gpr.total).toBeCloseTo(12274765.85, 1);
    expect(gpr.months!.length).toBe(12);
    expect(gpr.months!.reduce((a, b) => a + b, 0)).toBeCloseTo(gpr.total, 1);
  });
  it('snow removal has a winter-heavy shape', () => {
    const snow = c.rows.find((r) => r.gl === '6818' || r.gl === '6934');
    if (snow) {
      const m = snow.months!;
      const winter = m[0] + m[1] + m[10] + m[11];
      const summer = m[5] + m[6] + m[7];
      expect(Math.abs(winter)).toBeGreaterThan(Math.abs(summer));
    }
  });
});

describe('parseComparison — Minot 4', () => {
  const c = parseComparison(fx('comparison-minot4.xlsx'));
  it('finds the five property columns', () => {
    expect(c.properties).toEqual(['clnd', 'spnd', 'tcnd', 'tpnd', 'tpndc']);
  });
  it('has GL rows with totals', () => {
    expect(c.rows.length).toBeGreaterThan(100);
    const gpr = c.rows.find((r) => r.gl === '4994');
    expect(gpr).toBeTruthy();
    expect(gpr!.total).toBeGreaterThan(0);
  });
  it('captures period/book', () => {
    expect(c.period).toContain('2026');
    expect(c.book.toLowerCase()).toContain('cash');
  });
});
