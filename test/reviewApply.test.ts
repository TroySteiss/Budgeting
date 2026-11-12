/* ND 2027 Budget Review -> Apply (shared/reviewApply.ts): the workbook's Apply Rules on one budget. */
import { describe, it, expect } from 'vitest';
import { planApply, type ApplyRow } from '../shared/reviewApply.js';

const m12 = (v: number) => Array(12).fill(v);
const winter = (v: number) => [v, v, v, v, 0, 0, 0, 0, 0, 0, v, v];
const row = (r: Partial<ApplyRow>): ApplyRow => ({ rowId: 'A1', site: 'BCND', gl: '6934', glName: '', item: 'x', action: 'set', pool: [], months: m12(0), total: 0, push: true, firmness: 'contract – executed', basis: '', source: '', contractsRow: '', historyNote: '', targetGl: '', ...r });
const lines = (o: Record<string, number[] | { months: number[]; override?: boolean; driver?: any }>) => new Map(Object.entries(o).map(([gl, v]) => [gl, Array.isArray(v) ? { months: v } : v]));
const tot = (m: number[]) => m.reduce((a, v) => a + v, 0);

describe('ND review apply plan', () => {
  it('set replaces the GL with the sum of the site\'s set rows; other sites\' rows are ignored', () => {
    const p = planApply([
      row({ rowId: 'A001', months: winter(14770), total: 88620 }),
      row({ rowId: 'A099', site: 'ECND', months: winter(1), total: 6 }),
    ], { site: 'bcnd', lines: lines({ '6934': m12(5000) }), t12: { '6934': m12(6000) } });
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ gl: '6934', rowIds: ['A001'], kinds: ['set'] });
    expect(p.changes[0].newMonths).toEqual(winter(14770));
    expect(p.changes[0].flags).toEqual([]);                              // 88,620 vs a 72,000 T12 = +23%: under the 25% line
    const far = planApply([row({ rowId: 'A001', months: winter(14770), total: 88620 })], { site: 'bcnd', lines: lines({ '6934': m12(5000) }), t12: { '6934': m12(4000) } });
    expect(far.changes[0].flags).toEqual(['+85% vs the T12 (48,000)']);  // over 25%: still planned, flagged
  });
  it('a floor only ever raises the pool, in proportion to the rows; a pool already above it is left alone', () => {
    const fire = [
      row({ rowId: 'F1', gl: '6917', action: 'at_least', pool: ['6917', '6921'], months: [0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 0, 0], total: 1000 }),
      row({ rowId: 'F2', gl: '6921', action: 'at_least', pool: ['6917', '6921'], months: m12(250), total: 3000 }),
    ];
    const low = planApply(fire, { site: 'BCND', lines: lines({ '6917': m12(0), '6921': m12(100) }), t12: null });   // pool 1,200 < 4,000
    const g17 = low.changes.find((c) => c.gl === '6917')!, g21 = low.changes.find((c) => c.gl === '6921')!;
    expect(tot(g17.newMonths) + tot(g21.newMonths)).toBeCloseTo(4000, 2);
    expect(tot(g17.newMonths)).toBeCloseTo(700, 2);                    // 2,800 shortfall × 1,000 / 4,000
    expect(g17.newMonths[7]).toBeCloseTo(700, 2);                      // on the row's own month
    const high = planApply(fire, { site: 'BCND', lines: lines({ '6917': m12(200), '6921': m12(200) }), t12: null });
    expect(high.changes).toHaveLength(0);
    expect(high.floorsMet).toEqual([{ pool: '6917+6921', budget: 4800, floor: 4000, rowIds: ['F1', 'F2'] }]);
  });
  it('reclass moves the whole GL to the target with no NOI change; add adds', () => {
    const p = planApply([
      row({ rowId: 'R1', gl: '5167', action: 'reclass', targetGl: '5170' }),
      row({ rowId: 'D1', gl: '6331', action: 'add', months: m12(507), total: 6084 }),
    ], { site: 'BCND', lines: lines({ '5167': m12(8000), '5170': m12(1000), '6331': m12(275) }), t12: { '6331': m12(275) } });
    expect(p.changes.find((c) => c.gl === '5167')!.newMonths).toEqual(m12(0));
    expect(p.changes.find((c) => c.gl === '5170')!.newMonths).toEqual(m12(9000));
    expect(p.changes.find((c) => c.gl === '5167')!.flags).toEqual([]);   // a reclass is not a history move
    expect(p.changes.find((c) => c.gl === '6331')!.newMonths).toEqual(m12(782));
    expect(p.changes.find((c) => c.gl === '6331')!.flags[0]).toMatch(/\+184% vs the T12/);
  });
  it('rate re-prices the fee on its own prior-month base; first-year months keep their own old rate', () => {
    const fee = { months: [3000, 3000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000], driver: { method: 'mgmtPct', pct: 0.04, firstYear: { pct: 0.03, months: [0, 1] } } };
    const p = planApply([row({ rowId: 'M1', gl: '6112', action: 'rate', months: m12(0.035) })], { site: 'BCND', lines: lines({ '6112': fee }), t12: null });
    expect(p.changes[0].newMonths).toEqual([3500, 3500, 3500, 3500, 3500, 3500, 3500, 3500, 3500, 3500, 3500, 3500]);
    const off = planApply([row({ rowId: 'M1', gl: '6112', action: 'rate', months: m12(0.035) })], { site: 'BCND', lines: lines({ '6112': { months: m12(10), driver: { method: 'manual' } } }), t12: null });
    expect(off.changes).toHaveLength(0);
    expect(off.skipped[0].why).toMatch(/not on its % of income formula/);
  });
  it('records which row set each month, and what each row is, for the hover on the cells', () => {
    const p = planApply([
      row({ rowId: 'G1', gl: '6808', months: [0, 0, 0, 7820, 0, 0, 0, 0, 0, 0, 0, 0], total: 7820, item: 'Gutters spring' }),
      row({ rowId: 'G2', gl: '6808', months: [0, 0, 0, 0, 0, 0, 0, 0, 0, 7820, 0, 0], total: 7820, item: 'Gutters fall', source: 'Kens.pdf', contractsRow: '12' }),
    ], { site: 'BCND', lines: lines({ '6808': [0, 0, 0, 0, 0, 610, 0, 0, 0, 0, 0, 0] }), t12: null });
    expect(p.changes[0].cells).toEqual({ 3: ['G1'], 5: ['G1', 'G2'], 9: ['G2'] });   // June's 610 was zeroed by the set
    expect(p.rows.G2).toMatchObject({ item: 'Gutters fall', action: 'set', source: 'Kens.pdf', contractsRow: '12' });
  });
  it('trash (5169) and pest (5158) stay on their own GLs; the other reimbursements still fold into 5170 (Troy 2026-11-12)', () => {
    const p = planApply([
      row({ rowId: 'T1', gl: '5169', action: 'reclass', targetGl: '5170' }),
      row({ rowId: 'P1', gl: '5158', action: 'reclass', targetGl: '5170' }),
      row({ rowId: 'S1', gl: '5167', action: 'reclass', targetGl: '5170' }),
    ], { site: 'BCND', lines: lines({ '5169': m12(800), '5158': m12(100), '5167': m12(50), '5170': m12(1000) }), t12: null });
    expect(p.changes.map((c) => c.gl).sort()).toEqual(['5167', '5170']);
    expect(p.changes.find((c) => c.gl === '5170')!.newMonths).toEqual(m12(1050));
    expect(p.skipped.map((k) => k.rowId)).toEqual(['T1', 'P1']);
    expect(p.skipped[0].why).toMatch(/trash reimbursement stays on its own GL/);
  });
  it('a set never takes a line under the site\'s own floor (the UW insurance rate: CWND / RRND, Troy 2026-11-12)', () => {
    const ins = row({ rowId: 'I1', site: 'CWND', gl: '6108', months: m12(73700 / 12), total: 73700 });
    const floors = { '6108': { annual: 360 * 268, why: 'the UW model carries $360/unit insurance for this site' } };
    const p = planApply([ins], { site: 'CWND', lines: lines({ '6108': m12(8040) }), t12: null, floors });
    expect(p.changes).toHaveLength(0);
    expect(p.skipped[0].why).toMatch(/^the UW model carries \$360\/unit insurance for this site: 73,700 would go under its 96,480/);
    const above = planApply([row({ rowId: 'I2', site: 'CWND', gl: '6108', months: m12(9000), total: 108000 })], { site: 'CWND', lines: lines({ '6108': m12(8040) }), t12: null, floors });
    expect(above.changes).toHaveLength(1);                               // a set at or above the floor still goes in
  });
  it('never pushes payroll, income (but reclass), push = N or check rows; a hand-typed line is flagged', () => {
    const p = planApply([
      row({ rowId: 'P1', gl: '6418', months: m12(1) }),
      row({ rowId: 'I1', gl: '5158', months: m12(1) }),
      row({ rowId: 'N1', gl: '6331', push: false, action: 'add', months: m12(1) }),
      row({ rowId: 'C1', gl: '6116', action: 'check', push: false }),
      row({ rowId: 'S1', gl: '6108', months: m12(100), historyNote: 'booked in 6110 before' }),
    ], { site: 'BCND', lines: lines({ '6108': { months: m12(90), override: true } }), t12: { '6108': m12(95) } });
    expect(p.skipped.map((s) => s.rowId)).toEqual(['P1', 'I1', 'N1', 'C1']);
    expect(p.changes[0]).toMatchObject({ gl: '6108', locked: true });
    expect(p.changes[0].flags).toEqual(['replaces a hand-typed line', 'history: booked in 6110 before']);
  });
});
