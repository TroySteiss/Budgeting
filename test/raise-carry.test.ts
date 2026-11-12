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
    expect(m.remap).toEqual([{ from: 'janedoe', to: '100234', name: 'Jane Doe', how: 'name' }]);
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

describe('raises follow the SEAT when the person changes (Troy 2026-11-12)', () => {
  const S = (key: string, name: string, position: string, allocs: [string, number][]): StaffingPerson =>
    ({ ...P(key, name), position, allocations: allocs.map(([code, pct]) => ({ code, pct })) });
  it('a new hire in the only matching seat takes the leaver’s raise', () => {
    const old = [S('ann', 'Ann Old', 'Leasing Agent', [['aaaa', 0.5], ['bbbb', 0.5]]), S('bo', 'Bo Stay', 'Maintenance Tech', [['aaaa', 1]])];
    const neu = [S('999', 'Cy New', 'Leasing Agent', [['bbbb', 0.5], ['aaaa', 0.5]]), S('bo', 'Bo Stay', 'Maintenance Tech', [['aaaa', 1]])];
    const m = matchRaiseKeys(old, neu, ['ann', 'bo']);
    expect(m.remap).toEqual([{ from: 'ann', to: '999', name: 'Ann Old', how: 'seat', newName: 'Cy New' }]);
    expect(m.orphans).toEqual([]);
  });
  it('an open seat whose key shifted follows its seat', () => {
    const old = [S('open-2', 'Open', 'Porter', [['aaaa', 1]])];
    const neu = [S('open-5', 'Open', 'Porter', [['aaaa', 1]])];
    expect(matchRaiseKeys(old, neu, ['open-2']).remap.map((r) => [r.from, r.to, r.how])).toEqual([['open-2', 'open-5', 'seat']]);
  });
  it('two identical seats are never paired by guess, and a person still on the roster is never a seat target', () => {
    const old = [S('a', 'Al One', 'Porter', [['aaaa', 1]]), S('b', 'Bea Two', 'Porter', [['aaaa', 1]]), S('c', 'Cal Three', 'Manager', [['aaaa', 1]])];
    const neu = [S('1', 'New One', 'Porter', [['aaaa', 1]]), S('2', 'New Two', 'Porter', [['aaaa', 1]]), S('d', 'Cal Three', 'Manager', [['aaaa', 1]]), S('e', 'Dee Four', 'Manager', [['aaaa', 1]])];
    const m = matchRaiseKeys(old, neu, ['a', 'b']);
    expect(m.remap).toEqual([]);
    expect(m.orphans.every((o) => /same seat/.test(o.why))).toBe(true);
  });
});

describe('Regional Manager pay is the FULL salary, not the properties’ 70% (Troy 2026-11-12, synthetic)', () => {
  it('the detail report’s check (property share only) never resets an RM’s rate; others still update', async () => {
    const { applyStaffingDetail, normalizeRmCorporateShare } = await import('../shared/payroll.js');
    const rm = { ...P('rm', 'Rae Manager'), position: 'Regional Property Manager', payMethod: 'Salary' as const, payRate: 100000, rm: true, allocations: [{ code: 'aaaa', pct: 0.5 }, { code: 'bbbb', pct: 0.5 }] };
    const pm = { ...P('pm', 'Pat Manager'), position: 'Property Manager', payMethod: 'Salary' as const, payRate: 50000 };
    applyStaffingDetail([rm, pm], [
      { name: 'Rae Manager', title: 'Regional Property Manager', gl: '6402', lastGross: 70000 / 26 },   // only the properties' 70% is on the property report
      { name: 'Pat Manager', title: 'Property Manager', gl: '6402', lastGross: 52000 / 26 },
    ]);
    normalizeRmCorporateShare([rm, pm]);
    expect(rm.payRate).toBe(100000);                                          // the raise is figured on this
    expect(rm.allocations.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(0.7);   // the 30% to MI is applied once, on the split
    expect(pm.payRate).toBe(52000);
  });
});

describe('open positions budget at 75% of full wages (Troy 2026-11-12, synthetic)', () => {
  it('an "Open" seat carries OPEN_SEAT_PCT of its wages, raise included; a filled seat is untouched', async () => {
    const { annualWagesByGl, monthlyWagesByGl, OPEN_SEAT_PCT, isOpenSeat } = await import('../shared/payroll.js');
    expect(OPEN_SEAT_PCT).toBe(0.75);
    expect(isOpenSeat('Open')).toBe(true); expect(isOpenSeat('Vacant - Porter')).toBe(true); expect(isOpenSeat('Openshaw, Kim')).toBe(false);
    const seat = (name: string) => ({ ...P(name.toLowerCase(), name), position: 'Maintenance Tech', payMethod: 'Salary' as const, payRate: 48000 });
    const full = annualWagesByGl([seat('Kim Filled')], 'aaaa', {}, '2027-01', 2027).wages;
    const open = annualWagesByGl([seat('Open')], 'aaaa', {}, '2027-01', 2027).wages;
    const gl = Object.keys(full)[0];
    expect(open[gl]).toBeCloseTo(full[gl] * 0.75, 0);
    const mo = monthlyWagesByGl([seat('Open')], 'aaaa', {}, '2027-01', 2027)[gl];
    expect(mo.reduce((a, v) => a + v, 0)).toBeCloseTo(open[gl], 0);
  });
});
