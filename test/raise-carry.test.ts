import { describe, it, expect } from 'vitest';
import { matchRaiseKeys, resolveRaiseKeys, personNameId, type StaffingPerson } from '../shared/payroll.js';

// synthetic people only — no real roster data
const P = (key: string, name: string, code = 'aaaa'): StaffingPerson => ({
  key, name, position: 'Leasing', payMethod: 'Hourly', payRate: 1, monthlyBenefits: 0, startDate: null,
  status: 'FULL', oldPay: null, allocations: [{ code, pct: 1 }], rm: false,
});

describe('carrying raises onto a re-dropped payroll sheet (Troy 2026-11-12)', () => {
  it('name id ignores order, commas, case and middle initials', () => {
    expect(personNameId('Doe, Jane Q.')).toBe(personNameId('jane doe'));
  });
  it('same key carries; a changed key is re-matched by a unique name', () => {
    const old = [P('janedoe', 'Jane Doe'), P('bobroe', 'Bob Roe')];
    const neu = [P('100234', 'Doe, Jane'), P('bobroe', 'Bob Roe')];
    const m = matchRaiseKeys(old, neu, ['janedoe', 'bobroe']);
    expect(m.carried).toEqual(['bobroe']);
    expect(m.remap).toEqual([{ from: 'janedoe', to: '100234', name: 'Jane Doe' }]);
    expect(m.orphans).toEqual([]);
  });
  it('never guesses: shared names, open seats, people who left and rows with their own raise stay unmatched', () => {
    const old = [P('alsmith', 'Al Smith'), P('alsmith-2', 'Al Smith'), P('vacant', 'Vacant'), P('gone', 'Gone Person'), P('kimlee', 'Kim Lee')];
    const neu = [P('1', 'Al Smith'), P('2', 'Vacant'), P('3', 'Kim Lee')];
    const m = matchRaiseKeys(old, neu, ['alsmith', 'vacant', 'gone', 'kimlee', '3']);
    expect(m.remap).toEqual([]);
    expect(m.carried).toEqual(['3']);
    expect(m.orphans.map((o) => o.key).sort()).toEqual(['alsmith', 'gone', 'kimlee', 'vacant']);
  });
  it('a raise workbook with old keys imports onto the new roster by Employee name', () => {
    const neu = [P('100234', 'Jane Doe'), P('bobroe', 'Bob Roe')];
    const r = resolveRaiseKeys([{ key: 'janedoe', pct: 3 }, { key: 'bobroe', pct: 2 }, { key: 'nobody', pct: 4 }],
      { janedoe: 'Doe, Jane', bobroe: 'Bob Roe', nobody: 'No Body' }, neu);
    expect(r.pairs.map((x) => x.key)).toEqual(['100234', 'bobroe', 'nobody']);
    expect(r.rekeyed).toEqual(['Jane Doe']);
  });
  it('a name match never overwrites a row the file already sets by its own key', () => {
    const neu = [P('100234', 'Jane Doe')];
    const r = resolveRaiseKeys([{ key: 'janedoe', pct: 3 }, { key: '100234', pct: 5 }], { janedoe: 'Jane Doe' }, neu);
    expect(r.pairs.map((x) => x.key)).toEqual(['janedoe', '100234']);
    expect(r.rekeyed).toEqual([]);
  });
});
