/* The contracts register's repo file (Troy 2026-11-17: "a significantly better way to alter contract expenses per year
   that you can push data directly into"). Synthetic rows only. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, parseContractsCsv, contractKey, contractHash } from '../shared/contractsFile.js';

describe('contracts repo file', () => {
  it('reads quoted fields, CRLF, a BOM and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n1,2')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  });
  it('turns rows into contracts; the year comes from the file', () => {
    const csv = [
      'Property,GL,Vendor,Kind,Amount,Per,Months,Bill Month,Step Month,Step %,Mode,Note',
      'CLND,6818,Snow Pros,monthly,"14,770",month,1;2;3;4;11;12,,,,replace,season contract',
      'clnd,6916,Otis Elevator,annual,5200,,,7,,,,',
      'spnd,6918,Pest Co,perUnit,3.5,,,,4,3,add,',
    ].join('\n');
    const { rows, errors } = parseContractsCsv(csv, 2027);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ property: 'clnd', year: 2027, gl: '6818', vendor: 'Snow Pros', note: 'season contract' });
    expect(rows[0].contract).toMatchObject({ kind: 'monthly', per: 'month', amount: 14770, months: [1, 2, 3, 4, 11, 12], mode: 'replace' });
    expect(rows[1].contract).toMatchObject({ kind: 'annual', billMonth: 7, months: [] });
    expect(rows[2].contract).toMatchObject({ kind: 'perUnit', stepMonth: 4, stepPct: 0.03, mode: 'add' });
  });
  it('a bad row is skipped with its line number; the rest load', () => {
    const csv = 'property,gl,vendor,amount\nclnd,68,Bad GL,10\nclnd,6808,,10\nclnd,6808,Ken,0\nclnd,6808,Ken,10\nclnd,6808,ken,12';
    const { rows, errors } = parseContractsCsv(csv, 2027);
    expect(rows.map((r) => r.line)).toEqual([5]);
    expect(errors).toEqual(['line 2: gl "68"', 'line 3: no vendor', 'line 4: amount "0"', 'line 6: clnd 6808 "ken" twice']);
    expect(parseContractsCsv('gl,vendor\n6808,x', 2027).errors[0]).toMatch(/no "property" column/);
  });
  it('mode=remove takes a vendor off a GL: no amount needed, not a contract (ButterflyMX 6331 → 6324, Troy 2026-11-19)', () => {
    const { rows, removes, errors } = parseContractsCsv(['property,gl,vendor,amount,mode', 'cwnd,6331,ButterflyMX,,remove', 'cwnd,6324,ButterflyMX,8442,', 'cwnd,6331,butterflymx,,remove'].join('\n'), 2027);
    expect(rows.map((r) => r.gl)).toEqual(['6324']);
    expect(removes).toEqual([{ property: 'cwnd', year: 2027, gl: '6331', vendor: 'ButterflyMX', line: 2 }]);
    expect(errors).toEqual(['line 4: cwnd 6331 "butterflymx" twice']);
  });
  it('the ND 2027 file files ButterflyMX on 6324 and takes it off 6331 at the six ND East sites', () => {
    const { rows, removes } = parseContractsCsv(readFileSync(join(process.cwd(), 'data', 'contracts', 'nd', '2027.csv'), 'utf8'), 2027);
    const sites = ['cwnd', 'lhnd', 'nrnd', 'rrnd', 'drnd', 'mwnd'];
    for (const p of sites) {
      expect(rows.some((r) => r.property === p && r.gl === '6324' && r.vendor === 'ButterflyMX'), p).toBe(true);
      expect(removes.some((r) => r.property === p && r.gl === '6331' && r.vendor === 'ButterflyMX'), p).toBe(true);
    }
  });
  it('whole_gl marks the file as the whole GL for that property', () => {
    const { rows } = parseContractsCsv(['property,gl,vendor,amount,whole_gl', 'clnd,6924,A,10,yes', 'clnd,6808,B,10,', 'spnd,6924,C,10,No'].join('\n'), 2027);
    expect(rows.map((r) => r.wholeGl)).toEqual([true, false, false]);
  });
  it('every repo file in data/contracts parses cleanly', () => {
    const root = join(process.cwd(), 'data', 'contracts');
    for (const region of ['nd', 'kc']) {
      let files: string[] = [];
      try { files = readdirSync(join(root, region)).filter((f) => /^\d{4}\.csv$/.test(f)); } catch { continue; }
      for (const f of files) expect(parseContractsCsv(readFileSync(join(root, region, f), 'utf8'), Number(f.slice(0, 4))).errors, `${region}/${f}`).toEqual([]);
    }
  });
  it('identity ignores case and punctuation; the fingerprint follows the content', () => {
    expect(contractKey('CLND', 2027, '6808', "Ken's Gutters")).toBe(contractKey('clnd', 2027, '6808', 'kens gutters'.replace('kens', "ken's")));
    expect(contractKey('clnd', 2027, '6808', 'Ken  Gutters!')).toBe('clnd:2027:6808:ken-gutters');
    const c = { vendor: 'x', gl: '6808', kind: 'annual', amount: 10, billMonth: 3 } as any;
    expect(contractHash(c)).toBe(contractHash({ ...c }));
    expect(contractHash(c)).not.toBe(contractHash({ ...c, amount: 11 }));
  });
});
