/* Create the UW Year-1 budgets (ownership year, e.g. Aug 2026 – Jul 2027) for
   all six properties, linking every data layer. Exports: the 2026 revision CSV
   (Aug–Dec, replaces the seller budgets in Yardi) + the 2027 CSV (Jan–Jul).
   Run: node scripts/create-2026-stubs.mjs [baseUrl] [startMonth] */
const BASE = (process.argv[2] || 'http://localhost:3100') + '/api';
const START = Number(process.argv[3]) || 8;

let cookie = '';
async function call(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setc = r.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}

await call('/login', { method: 'POST', body: { username: 'Troy Steiss', password: process.env.APP_PASSWORD || 'Monarch7!' } });
const st = await call('/state');
const comp = st.compSets.find((c) => /12-month budget/i.test(c.name)) || st.compSets[0];
const pay = (st.payrollModels || [])[0];

for (const code of ['cwnd', 'drnd', 'lhnd', 'mwnd', 'nrnd', 'rrnd']) {
  const uw = st.uwSnapshots.find((u) => u.property_code === code);
  const rent = st.rentSnapshots.find((r) => r.property_code === code);
  const t12 = st.t12Snapshots.find((t) => t.property_code === code);
  if (!uw) { console.log('no uw for', code); continue; }
  const old = st.budgets.find((b) => b.property_code === code && b.year === 2026);
  if (old) await call(`/budgets/${old.id}`, { method: 'DELETE' });
  const bv = await call('/budgets', { method: 'POST', body: {
    propertyCode: code, year: 2026, label: `${code} Year 1 Budget`,
    uwSnapshotId: uw.id, compSetId: comp?.id || null, rentSnapshotId: rent?.id || null,
    t12SnapshotId: t12?.id || null, payrollModelId: pay?.id || null,
  } });
  const bv2 = await call(`/budgets/${bv.budget.id}`, { method: 'PUT', body: { inputs: { startMonth: START } } });
  const t = bv2.tieout;
  console.log(`${code} Y1 (${bv2.monthLabels[0]}–${bv2.monthLabels[11]}) — income ${Math.round(t.egi.budget)} vs UW ${Math.round(t.egi.uw)} (Δ${Math.round(t.egi.variance)}); NOI ${Math.round(t.noi.budget)} vs ${Math.round(t.noi.uw)} (Δ${Math.round(t.noi.variance)})`);
  console.log(`   monthly NOI: ${bv2.kpis.monthly.noi.map((v) => Math.round(v)).join(', ')}`);
}
console.log('done');
