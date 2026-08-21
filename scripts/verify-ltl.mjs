/* Local verification of the lease-burnoff LTL: synthetic unit-level rent roll
   → snapshot → throwaway budget → check 5003 follows per-lease burnoff, income
   still ties (scaled shape), then clean up. Run with dev server up. */
import * as XLSX from 'xlsx';

const BASE = 'http://localhost:3100/api';
let cookie = '';
async function call(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), cookie },
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setc = r.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}

// synthetic roll: 4 units — deep LTL expiring Nov, small LTL expiring Nov, GTL expiring Feb, LTL after window
const aoa = [
  ['OneSite Report'], ['RENT ROLL DETAIL'], ['As of Date: 09/01/2026'], [],
  ['Resh ID', 'Unit', 'Floorplan', 'SQFT', 'Unit/Lease Status', 'Lease Start', 'Lease End', 'Market + Addl.', 'Lease Rent'],
  ['1', 'A-101', '1x1', 700, 'Occupied', '2025-11-15', '2026-11-14', 1600, 1400],
  ['2', 'A-102', '1x1', 700, 'Occupied', '2025-11-20', '2026-11-19', 1600, 1550],
  ['3', 'A-103', '1x1', 700, 'Occupied', '2026-02-10', '2027-02-09', 1600, 1650],
  ['4', 'A-104', '1x1', 700, 'Occupied', '2027-01-01', '2027-12-31', 1600, 1300],
];
const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Report1');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

await call('/login', { method: 'POST', body: { username: 'Troy Steiss', password: 'Monarch7!' } });
const fd = new FormData();
fd.append('file', new Blob([buf]), 'synthetic-rr.xlsx');
const parsed = await call('/uploads/parse?kind=rent_roll', { method: 'POST', body: fd });
console.log('parsed:', JSON.stringify(parsed.properties[0].leases));
await call('/uploads/apply', { method: 'POST', body: { kind: 'rent_roll', filename: 'synthetic-rr.xlsx', payload: parsed, mappings: [{ sourceCode: null, sourceName: parsed.properties[0].name, propertyCode: 'drnd' }] } });
let st = await call('/state');
const snap = st.rentSnapshots[0]; // newest first
console.log('snapshot', snap.id, 'for', snap.property_code, 'market', snap.market_monthly);

const uw = st.uwSnapshots.find((u) => u.property_code === 'drnd');
const bv = await call('/budgets', { method: 'POST', body: { propertyCode: 'drnd', year: 2026, label: 'LTL TEST — delete me', uwSnapshotId: uw.id, rentSnapshotId: snap.id } });
const bv2 = await call(`/budgets/${bv.budget.id}`, { method: 'PUT', body: { inputs: { startMonth: 9, tieIncome: false, tieNoi: false, ltl: { mode: 'leases', renewalPct: 0.5, burnoffRenew: 0.5, burnoffNew: 1, startMonthly: 0, targetPct: 0, rampMonths: 12 } } } });
const ltl = bv2.lines.find((l) => l.gl_code === '5003');
console.log('LTL months (no tie):', ltl.months.join(', '));
// with income tie on: shape preserved, scaled
const bv3 = await call(`/budgets/${bv.budget.id}`, { method: 'PUT', body: { inputs: { tieIncome: true } } });
const ltl3 = bv3.lines.find((l) => l.gl_code === '5003');
console.log('LTL months (tied):  ', ltl3.months.map((v) => Math.round(v)).join(', '));
console.log('EGI Δ after tie:', Math.round(bv3.tieout.egi.variance), '| shape ratio m0/m2:', (ltl3.months[0] / ltl3.months[2]).toFixed(3), 'vs untied', (ltl.months[0] / ltl.months[2]).toFixed(3));
await call(`/budgets/${bv.budget.id}`, { method: 'DELETE' });
console.log('cleaned up test budget');
