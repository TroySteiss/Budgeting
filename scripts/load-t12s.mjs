/* Upload the six seller T12 statements, then rebuild each property's 2027
   budget with the T12 linked (preserving nothing — these are untouched
   generated budgets). Run: node scripts/load-t12s.mjs [baseUrl] */
import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:3100') + '/api';
const DIR = 'C:/Users/TroySteiss/Downloads/6. Operating Statements and Budgets';
const FILES = [
  ['cwnd', `${DIR}/Cottonwood/Cottonwood_Jun-26_T12.xlsx`],
  ['drnd', `${DIR}/Deer Ridge/DeerRidge_Jun-26_T12.xlsx`],
  ['lhnd', `${DIR}/Legacy Heights/LegacyHeights_Jun-26_T12.xlsx`],
  ['mwnd', `${DIR}/Meadows/Meadows_Jun-26_T12.xlsx`],
  ['nrnd', `${DIR}/Northridge/Northridge_Jun-26_T12.xlsx`],
  ['rrnd', `${DIR}/River Ridge/RiverRidge_Jun-26_T12.xlsx`],
];

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

await call('/login', { method: 'POST', body: { username: 'Troy Steiss', password: process.env.APP_PASSWORD || 'Monarch8!' } });
let st = await call('/state');

for (const [code, path] of FILES) {
  if ((st.t12Snapshots || []).some((t) => t.property_code === code)) { console.log('t12 exists', code); continue; }
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path)]), path.split('/').pop());
  const parsed = await call('/uploads/parse?kind=seller_t12', { method: 'POST', body: fd });
  await call('/uploads/apply', { kind: undefined, method: 'POST', body: { kind: 'seller_t12', filename: parsed.filename, payload: parsed, mappings: [{ propertyCode: code }] } });
  console.log('t12 saved', code, parsed.t12.period);
}

st = await call('/state');
for (const [code] of FILES) {
  const uw = st.uwSnapshots.find((u) => u.property_code === code);
  const rent = st.rentSnapshots.find((r) => r.property_code === code);
  const t12 = st.t12Snapshots.find((t) => t.property_code === code);
  const comp = st.compSets[0];
  if (!uw) { console.log('no uw for', code, '— skipped'); continue; }
  const old = st.budgets.find((b) => b.property_code === code && b.year === 2027);
  if (old) await call(`/budgets/${old.id}`, { method: 'DELETE' });
  const bv = await call('/budgets', { method: 'POST', body: {
    propertyCode: code, year: 2027,
    uwSnapshotId: uw.id, compSetId: comp?.id || null, rentSnapshotId: rent?.id || null, t12SnapshotId: t12?.id || null,
  } });
  console.log(`rebuilt ${code} 2027 (t12 ${t12 ? 'linked' : 'MISSING'}) — noi ${bv.kpis.noi} vs uw ${Math.round(bv.tieout.noi.uw)}`);
}
console.log('done');
