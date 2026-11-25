import { describe, it, expect } from 'vitest';
import { diffLines, budgetsOf, sourceOf, changeLabel } from '../src/change-log.js';

const z = () => Array(12).fill(0);

describe('change log', () => {
  it('diffLines: months, note, formula and lock changes; cents and untouched lines are ignored', () => {
    const old = [
      { gl_code: '6309', months: [285, 286, 287, 288, 288, 289, 290, 291, 292, 293, 294, 295], note: '', override: false, method: 'baseline' },
      { gl_code: '6812', months: JSON.stringify(Array(12).fill(350)), note: '', override: false, method: 'baseline' },
      { gl_code: '6104', months: Array(12).fill(276), note: '', override: false, method: 'baseline' },
      { gl_code: '6102', months: Array(12).fill(100), note: 'x', override: false, method: 'suggested' },
    ];
    const next = [
      { gl_code: '6309', months: [285, 310, 287, 288, 288, 289, 290, 291, 292, 293, 294, 295], note: '', override: true, driver: { method: 'baseline' } },
      { gl_code: '6812', months: [...Array(4).fill(350), 5000, ...Array(7).fill(350)], note: 'annual', override: true, driver: { method: 'baseline' } },
      { gl_code: '6104', months: Array(12).fill(276.3), note: '', override: false, driver: { method: 'baseline' } },
      { gl_code: '6102', months: Array(12).fill(100), note: 'x', override: false, driver: { method: 'manual' } },
      { gl_code: '7001', months: z(), note: '', override: false, driver: { method: 'zero' } },
    ];
    const d = diffLines(old, next);
    expect(d.map((x) => x.gl)).toEqual(['6812', '6309', '6102', '7001']);   // biggest move first
    expect(d[0]).toEqual({ gl: '6812', from: 4200, to: 8850, n: 1, note: 'annual', lock: true });
    expect(d[1]).toMatchObject({ gl: '6309', n: 1, lock: true });
    expect(d[1].to - d[1].from).toBe(24);
    expect(d[2]).toEqual({ gl: '6102', from: 1200, to: 1200, n: 0, m: ['suggested', 'manual'] });
    expect(d[3]).toMatchObject({ gl: '7001', from: 0, to: 0, m: ['', 'zero'] });
  });
  it('budgetsOf: budget actions read detail.id; others name their budgets; non-budget ids are not budgets', () => {
    expect(budgetsOf('edit line', { id: 1, gl: '6309' })).toEqual([1]);
    expect(budgetsOf('tie NOI to UW', { id: '7' })).toEqual([7]);
    expect(budgetsOf('contract added', { id: 55, budgets: [3, 4] })).toEqual([3, 4]);
    expect(budgetsOf('recalculate many', { ids: [1, 2, 2] })).toEqual([1, 2]);
    expect(budgetsOf('save formula set', { id: 9 })).toEqual([]);
    expect(budgetsOf('delete staffing snapshot', { id: 9 })).toEqual([]);
  });
  it('sourceOf / changeLabel', () => {
    expect(sourceOf('import review decisions')).toBe('import');
    expect(sourceOf('actualize month (Yardi CSV)')).toBe('import');
    expect(sourceOf('ND review apply')).toBe('import');
    expect(sourceOf('upload rent_roll')).toBe('import');
    expect(sourceOf('edit line')).toBe('');
    expect(changeLabel({ route: { path: '/budgets/:id/recalc' }, path: '/budgets/1/recalc' })).toBe('lines saved (recalc)');
    expect(changeLabel({ route: { path: '/budgets/:id' }, path: '/budgets/1' })).toBe('lines saved (budget)');
  });
});
