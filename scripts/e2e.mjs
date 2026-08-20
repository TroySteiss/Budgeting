/* End-to-end smoke: login → upload UW books + rent roll + comp set → create a
   Deer Ridge budget → check tie-out → pull both exports. Run with the dev
   server up: node scripts/e2e.mjs */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:3100/api';
let cookie = '';

async function call(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: {
      ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      cookie,
      ...(opts.headers || {}),
    },
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setc = r.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  if (path.includes('export')) return r;
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}

const fx = (n) => new Blob([readFileSync(join(process.cwd(), 'test', 'fixtures', n))]);

// 1. login
await call('/login', { method: 'POST', body: { username: 'Troy Steiss', password: 'northdakota' } });
console.log('logged in');

// 2. upload Jamestown UW
let fd = new FormData();
fd.append('file', fx('jamestown-uw.xlsx'), 'jamestown-uw.xlsx');
const jt = await call('/uploads/parse?kind=uw_book', { method: 'POST', body: fd });
console.log('jamestown sheets:', jt.sheets.map((s) => `${s.sheetName}${s.isPortfolio ? '*' : ''}`).join(', '));
await call('/uploads/apply', { method: 'POST', body: { kind: 'uw_book', filename: 'jamestown-uw.xlsx', payload: jt, mappings: [
  { sheetName: 'Deer Ridge - JT', propertyCode: 'drnd' },
  { sheetName: 'Meadows - JT', propertyCode: 'mwnd' },
] } });

// 3. upload Bismarck UW
fd = new FormData();
fd.append('file', fx('bismarck-uw.xlsx'), 'bismarck-uw.xlsx');
const bk = await call('/uploads/parse?kind=uw_book', { method: 'POST', body: fd });
await call('/uploads/apply', { method: 'POST', body: { kind: 'uw_book', filename: 'bismarck-uw.xlsx', payload: bk, mappings: [
  { sheetName: 'Legacy Heights - BK', propertyCode: 'lhnd' },
  { sheetName: 'North Ridge - BK', propertyCode: 'nrnd' },
  { sheetName: 'River Ridge - BK', propertyCode: 'rrnd' },
  { sheetName: 'Cottonwood - BK', propertyCode: 'cwnd' },
] } });
console.log('UW snapshots saved');

// 4. rent roll
fd = new FormData();
fd.append('file', fx('rentroll-summary.xlsx'), 'rentroll-summary.xlsx');
const rr = await call('/uploads/parse?kind=rent_roll', { method: 'POST', body: fd });
await call('/uploads/apply', { method: 'POST', body: { kind: 'rent_roll', filename: 'rentroll-summary.xlsx', payload: rr, mappings:
  rr.properties.map((p) => ({ sourceCode: p.code, sourceName: p.name, propertyCode: p.code })) } });
console.log('rent snapshots saved:', rr.properties.map((p) => p.code).join(', '));

// 5. comp set
fd = new FormData();
fd.append('file', fx('comparison-minot4.xlsx'), 'comparison-minot4.xlsx');
const cmp = await call('/uploads/parse?kind=comparison', { method: 'POST', body: fd });
await call('/uploads/apply', { method: 'POST', body: { kind: 'comparison', filename: 'comparison-minot4.xlsx', payload: cmp, name: 'Minot 4 (2026 Budget, Cash)' } });
console.log('comp set saved');

// 6. create Deer Ridge budget
const state = await call('/state');
const uwId = state.uwSnapshots.find((u) => u.property_code === 'drnd')?.id;
const rentId = state.rentSnapshots.find((r) => r.property_code === 'drnd')?.id;
const compId = state.compSets[0]?.id;
const bv = await call('/budgets', { method: 'POST', body: { propertyCode: 'drnd', year: 2027, uwSnapshotId: uwId, compSetId: compId, rentSnapshotId: rentId } });
console.log('budget created id', bv.budget.id);
console.log('KPIs:', JSON.stringify(bv.kpis, (k, v) => (k === 'monthly' ? undefined : v)));
console.log('tie-out:');
for (const r of [...bv.tieout.rows, bv.tieout.egi, bv.tieout.toe, bv.tieout.noi]) {
  console.log(`  ${r.label.padEnd(30)} budget ${String(r.budget).padStart(12)}  uw ${String(r.uw).padStart(12)}  var ${r.variance}`);
}

// 7. exports
const csvR = await call(`/budgets/${bv.budget.id}/export.csv?cutoff=0`);
const csv = await csvR.text();
writeFileSync(join(process.cwd(), 'scripts', 'e2e-out.csv'), csv);
console.log('csv rows:', csv.split('\n').length, 'first detail:', csv.split('\r\n')[3]);
const xR = await call(`/budgets/${bv.budget.id}/export.xlsx`);
const buf = Buffer.from(await xR.arrayBuffer());
writeFileSync(join(process.cwd(), 'scripts', 'e2e-out.xlsx'), buf);
console.log('xlsx bytes:', buf.length);
console.log('E2E OK');
