/* Create 2027 budgets for every subject property that has a UW snapshot and
   doesn't have a budget yet. Run against local or prod: node scripts/seed-budgets.mjs [baseUrl] */
const BASE = (process.argv[2] || 'http://localhost:3100') + '/api';
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
await call('/login', { method: 'POST', body: { username: 'Troy Steiss', password: process.env.APP_PASSWORD || 'northdakota' } });
const st = await call('/state');
const have = new Set(st.budgets.map((b) => b.property_code + ':' + b.year));
for (const u of st.uwSnapshots) {
  if (have.has(u.property_code + ':2027')) { console.log('skip', u.property_code); continue; }
  const rent = st.rentSnapshots.find((r) => r.property_code === u.property_code);
  const comp = st.compSets[0];
  const bv = await call('/budgets', { method: 'POST', body: {
    propertyCode: u.property_code, year: 2027,
    uwSnapshotId: u.id, compSetId: comp?.id || null, rentSnapshotId: rent?.id || null,
  } });
  console.log(`created ${u.property_code} 2027 — income ${bv.kpis.income} noi ${bv.kpis.noi} (uw noi ${bv.tieout.noi.uw})`);
  have.add(u.property_code + ':2027');
}
console.log('done');
