import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBudgetCsv, reviseBudgetCsv } from '../src/csv-export.js';
import { parseBudgetCsv, parseComparisonActuals } from '../src/importers.js';
import { actualizeFromComparison, type CoaAccount, type BudgetLine } from '../shared/domain.js';

const coaList: CoaAccount[] = JSON.parse(readFileSync(join(process.cwd(), 'seed', 'coa.json'), 'utf8'));
const fixture = readFileSync(join(process.cwd(), 'test', 'fixtures', 'phnd-revision.csv'), 'utf8');

/** Re-parse the real PHND revision CSV into lines, rebuild it, compare. */
function parseFixture(): { lines: BudgetLine[]; description: string } {
  const rows = fixture.split(/\r?\n/).filter((r) => r.length);
  const header = rows[1].split(',');
  const description = header[4];
  const lines: BudgetLine[] = [];
  for (const row of rows.slice(3)) {
    const c = row.split(',');
    if (c.length < 24) continue;
    lines.push({
      gl_code: c[1],
      months: c.slice(12, 24).map((v) => parseFloat(v) || 0),
      driver: { method: 'manual' }, override: false, note: '',
    });
  }
  return { lines, description };
}

describe('buildBudgetCsv round-trip vs the real PHND revision file', () => {
  const { lines, description } = parseFixture();

  it('fixture has the full 335-account chart', () => {
    expect(lines.length).toBe(335);
  });

  it('rebuilds the file content byte-for-byte (modulo trailing newline)', () => {
    const out = buildBudgetCsv(coaList, lines, {
      propertyId: 'phnd', year: 2026, description, cutoffMonth: 0,
    });
    const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    expect(norm(out)).toBe(norm(fixture));
  });

  it('revision cutoff zeroes the early months', () => {
    const out = buildBudgetCsv(coaList, lines, { propertyId: 'phnd', year: 2026, description, cutoffMonth: 6 });
    const rows = out.split(/\r?\n/).filter((r) => r.length).slice(3);
    for (const row of rows) {
      const c = row.split(',');
      expect(c.slice(12, 18).every((v) => v === '0')).toBe(true);
    }
  });
});

describe('parseBudgetCsv — property comes from the file, tokens kept verbatim', () => {
  const yardi = parseBudgetCsv(readFileSync(join(process.cwd(), 'test', 'fixtures', 'rrnd-budget-yardi-export-2026.csv')));
  const tool = parseBudgetCsv(Buffer.from(fixture));

  it('reads the Yardi export header record', () => {
    expect(yardi.propertyId).toBe('rrnd');
    expect(yardi.year).toBe(2026);
    expect(yardi.book).toBe('Cash');
    expect(yardi.description).toBe('rrnd 2026 Budget Revision TS 08282026');
    expect(yardi.rows.length).toBe(335);
    expect(yardi.decimals).toBe(4);                                     // "0.0000" style amounts
    expect(yardi.rows.find((r) => r.gl === '4994')!.amounts[8]).toBe(260475);
    expect(yardi.rows.find((r) => r.gl === '5003')!.amounts[11]).toBeCloseTo(-15392.86, 2);
  });
  it('reads this tool\'s own export format too', () => {
    expect(tool.propertyId).toBe('phnd');
    expect(tool.decimals).toBeNull();
    expect(tool.rows.length).toBe(335);
  });
});

describe('reviseBudgetCsv — partial-month rule off the budget as it sits in Yardi', () => {
  const base = parseBudgetCsv(readFileSync(join(process.cwd(), 'test', 'fixtures', 'rrnd-budget-yardi-export-2026.csv')));
  const cmp = parseComparisonActuals(readFileSync(join(process.cwd(), 'test', 'fixtures', 'comparison-northda-aug26.xlsx')));
  const rows = cmp.rows.map((r) => ({ gl: r.gl, name: r.name, amount: r.actual.rrnd || 0 }));
  const { glMonths } = actualizeFromComparison(coaList, rows);
  const hand = readFileSync(join(process.cwd(), 'test', 'fixtures', 'rrnd-budget-revision-aug26-hand.csv'), 'utf8');

  it('reproduces Troy\'s hand-built revision byte-for-byte', () => {
    const out = reviseBudgetCsv(base, cmp.calMonth, glMonths, { stamp: 'TS 09102026' });
    expect(out.csv).toBe(hand);
    expect(out.rewritten).toBe(335);
    expect(out.appended).toEqual([]);
    expect(out.description).toBe('rrnd 2026 Budget Revision TS 09102026');
  });
  it('touches only the closed month — every other cell is verbatim', () => {
    const out = reviseBudgetCsv(base, 8, glMonths, { stamp: 'TS 09102026' });
    const a = out.csv.split('\r\n'), b = hand.split('\r\n');
    const orig = readFileSync(join(process.cwd(), 'test', 'fixtures', 'rrnd-budget-yardi-export-2026.csv'), 'utf8').split('\r\n');
    expect(a.length).toBe(orig.length);
    for (let i = 3; i < a.length; i++) {
      if (!a[i]) continue;
      const x = a[i].split(','), y = orig[i].split(',');
      for (let k = 0; k < x.length; k++) if (k !== 19) expect(x[k]).toBe(y[k]);
    }
    expect(a[1]).toBe(b[1]);
  });
  it('appends a row for a posted chart GL the file lacks, and restamps Upload → Revision', () => {
    const trimmed = { ...base, rows: base.rows.filter((r) => r.gl !== '7300'), description: 'rrnd 2026 Budget Upload TS 08282026' };
    const out = reviseBudgetCsv(trimmed, 8, glMonths, { stamp: 'TS 09102026' });
    expect(out.appended).toEqual(['7300']);
    const last = out.csv.trimEnd().split('\r\n').pop()!.split(',');
    expect(last[1]).toBe('7300');
    expect(last[19]).toBe('75656.0000');
    expect(last[20]).toBe('0.0000');
    expect(out.description).toBe('rrnd 2026 Budget Revision TS 09102026');
  });
});
