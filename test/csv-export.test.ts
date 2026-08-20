import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBudgetCsv } from '../src/csv-export.js';
import type { CoaAccount, BudgetLine } from '../shared/domain.js';

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
