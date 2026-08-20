/* Upload the ND payroll model (property-level aggregates only) + the Minot 4
   12-month Statement (actuals comp set), then rebuild the six 2027 budgets
   with the payroll model linked. Run: node scripts/load-payroll.mjs [baseUrl] */
import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:3100') + '/api';
const PAYROLL_FILE = 'C:/Users/TroySteiss/Downloads/North Dakota Payroll - Ongoing (2).xlsx';
const STMT_FILE = 'C:/Users/TroySteiss/Downloads/12_Month_Statement_minot4_Cash.xlsx';
const PAYROLL_NAME = 'ND Payroll - Ongoing (Aug 2026)';
const STMT_NAME = 'Minot 4 12-Month Actuals Aug25-Jul26 (Cash)';
const BUDGET_COMP = 'Minot 4 12-Month Budget 2026 (Cash)';

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
async function uploadParse(kind, file) {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(file)]), file.split('/').pop());
  return call(`/uploads/parse?kind=${kind}`, { method: 'POST', body: fd });
}

await call('/login', { method: 'POST', body: { username: 'Troy Steiss', password: process.env.APP_PASSWORD || 'Monarch8!' } });
let st = await call('/state');

let payId = (st.payrollModels || []).find((p) => p.label === PAYROLL_NAME)?.id;
if (!payId) {
  const parsed = await uploadParse('payroll', PAYROLL_FILE);
  const applied = await call('/uploads/apply', { method: 'POST', body: { kind: 'payroll', filename: parsed.filename, payload: parsed, name: PAYROLL_NAME } });
  payId = applied.payrollModelId;
  console.log('payroll model saved id', payId, '(aggregates only; unmapped:', parsed.payroll.unmappedPositions.join(',') || 'none', ')');
} else console.log('payroll model exists id', payId);

if (!st.compSets.find((c) => c.name === STMT_NAME)) {
  const parsed = await uploadParse('comparison', STMT_FILE);
  await call('/uploads/apply', { method: 'POST', body: { kind: 'comparison', filename: parsed.filename, payload: parsed, name: STMT_NAME, units: 712 } });
  console.log('actuals comp set saved');
} else console.log('actuals comp set exists');

st = await call('/state');
const compId = st.compSets.find((c) => c.name === BUDGET_COMP)?.id || st.compSets[0]?.id;
for (const code of ['cwnd', 'drnd', 'lhnd', 'mwnd', 'nrnd', 'rrnd']) {
  const uw = st.uwSnapshots.find((u) => u.property_code === code);
  const rent = st.rentSnapshots.find((r) => r.property_code === code);
  const t12 = st.t12Snapshots.find((t) => t.property_code === code);
  if (!uw) { console.log('no uw for', code); continue; }
  const old = st.budgets.find((b) => b.property_code === code && b.year === 2027);
  if (old) await call(`/budgets/${old.id}`, { method: 'DELETE' });
  const bv = await call('/budgets', { method: 'POST', body: {
    propertyCode: code, year: 2027,
    uwSnapshotId: uw.id, compSetId: compId, rentSnapshotId: rent?.id || null,
    t12SnapshotId: t12?.id || null, payrollModelId: payId,
  } });
  const wages = bv.payrollWages ? Object.values(bv.payrollWages).reduce((a, b) => a + b, 0) : 0;
  console.log(`rebuilt ${code} — wages from model ${Math.round(wages)}, cat10 ${Math.round(bv.categoryTotals['10'])} vs uw ${Math.round(bv.uw.y1['10'])}, noi ${Math.round(bv.kpis.noi)}`);
}
console.log('done');
