/* First-boot seed: the Monarch chart of accounts (from seed/coa.json, generated
   off the real Yardi upload CSV + FHND budget workbook) and the known ND
   portfolios/properties. Idempotent — inserts only what is missing. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from './db.js';

interface SeedAcct {
  code: string; name: string; kind: string; section: string; pcode: string | null;
  csv_order: number | null; display_order: number; curve: string | null;
}

const PORTFOLIOS: { name: string; kind: string; props: [string, string, number, string][] }[] = [
  { name: 'Bismarck 4', kind: 'subject', props: [
    ['cwnd', 'Cottonwood Apartments', 268, 'Bismarck ND'],
    ['lhnd', 'Legacy Heights', 119, 'Bismarck ND'],
    ['nrnd', 'North Ridge', 68, 'Bismarck ND'],
    ['rrnd', 'River Ridge', 146, 'Bismarck ND'],
  ] },
  { name: 'Jamestown 2', kind: 'subject', props: [
    ['drnd', 'Deer Ridge Apartments', 163, 'Jamestown ND'],
    ['mwnd', 'The Meadows', 84, 'Jamestown ND'],
  ] },
  { name: 'Minot', kind: 'comp', props: [
    ['clnd', 'CLND', 341, 'Minot ND'],
    ['spnd', 'SPND', 196, 'Minot ND'],
    ['tcnd', 'TCND', 104, 'Minot ND'],
    ['tpnd', 'TPND', 71, 'Minot ND'],
    ['tpndc', 'TPND Commercial', 0, 'Minot ND'],
    ['wynd', 'The Wyatt', 276, 'Minot ND'],
  ] },
  { name: 'Williston', kind: 'subject', props: [
    ['bcnd', 'Bison Crossing', 558, 'Williston ND'],
    ['ecnd', 'Elk Crossing', 360, 'Williston ND'],
    ['fhnd', 'Fair Hills', 350, 'Williston ND'],
    ['phnd', 'Plantation at Hunters Run', 202, 'Williston ND'],
  ] },
];

export async function seedIfEmpty(): Promise<void> {
  const coaCount = (await query('select count(*)::int as n from gl_accounts')).rows[0].n;
  if (coaCount === 0) {
    const accts: SeedAcct[] = JSON.parse(readFileSync(join(process.cwd(), 'seed', 'coa.json'), 'utf8'));
    for (const a of accts) {
      await query(
        `insert into gl_accounts(code, name, kind, section, pcode, csv_order, display_order, curve)
         values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (code) do nothing`,
        [a.code, a.name, a.kind, a.section, a.pcode, a.csv_order, a.display_order, a.curve]
      );
    }
    console.log(`seeded ${accts.length} GL accounts`);
  }
  const propCount = (await query('select count(*)::int as n from properties')).rows[0].n;
  if (propCount === 0) {
    for (const pf of PORTFOLIOS) {
      const pid = (await query(
        'insert into portfolios(name, kind) values($1,$2) on conflict (name) do update set kind=excluded.kind returning id',
        [pf.name, pf.kind]
      )).rows[0].id;
      for (const [code, name, units, market] of pf.props) {
        await query(
          `insert into properties(code, name, units, market, portfolio_id, role)
           values($1,$2,$3,$4,$5,$6) on conflict (code) do nothing`,
          [code, name, units, market, pid, pf.kind === 'comp' ? 'comp' : 'subject']
        );
      }
    }
    console.log('seeded portfolios & properties');
  }
}
