/* Upload the Minot 4 12-Month Budget as the comp set (712 units) and rebuild
   each 2027 budget on it (keeping UW/rent/T12 links).
   Run: node scripts/load-minot-budget.mjs [baseUrl] */
import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:3100') + '/api';
const FILE = 'C:/Users/TroySteiss/Downloads/12_Month_Budget_minot4_Cash.xlsx';
const NAME = 'Minot 4 12-Month Budget 2026 (Cash)';
const UNITS = 712; // clnd 341 + spnd 196 + tcnd 104 + tpnd 71

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

let compId = st.compSets.find((c) => c.name === NAME)?.id;
if (!compId) {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(FILE)]), FILE.split('/').pop());
  const parsed = await call('/uploads/parse?kind=comparison', { method: 'POST', body: fd });
  if (!parsed.comparison.monthly) throw new Error('expected monthly comp set');
  const applied = await call('/uploads/apply', { method: 'POST', body: { kind: 'comparison', filename: parsed.filename, payload: parsed, name: NAME, units: UNITS } });
  compId = applied.compSetId;
  console.log('comp set saved id', compId, 'units', applied.units);
} else console.log('comp set exists id', compId);

st = await call('/state');
for (const code of ['cwnd', 'drnd', 'lhnd', 'mwnd', 'nrnd', 'rrnd']) {
  const uw = st.uwSnapshots.find((u) => u.property_code === code);
  const rent = st.rentSnapshots.find((r) => r.property_code === code);
  const t12 = st.t12Snapshots.find((t) => t.property_code === code);
  if (!uw) { console.log('no uw for', code); continue; }
  const old = st.budgets.find((b) => b.property_code === code && b.year === 2027);
  if (old) await call(`/budgets/${old.id}`, { method: 'DELETE' });
  const bv = await call('/budgets', { method: 'POST', body: {
    propertyCode: code, year: 2027,
    uwSnapshotId: uw.id, compSetId: compId, rentSnapshotId: rent?.id || null, t12SnapshotId: t12?.id || null,
  } });
  console.log(`rebuilt ${code} — noi ${bv.kpis.noi} vs uw ${Math.round(bv.tieout.noi.uw)} (comp units ${bv.compUnits})`);
}
console.log('done');
