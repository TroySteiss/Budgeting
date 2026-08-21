/* Set loan/rate/capital on the six budgets from the UW books' financing
   blocks (interest then budgets automatically).
   Run: node --import tsx scripts/set-financing.mjs [baseUrl] */
import { readFileSync } from 'node:fs';
import { parseUwBook } from '../src/importers.ts';

const BASE = (process.argv[2] || 'http://localhost:3100') + '/api';
const MAP = { 'Deer Ridge': 'drnd', 'Meadows': 'mwnd', 'Legacy Heights': 'lhnd', 'North Ridge': 'nrnd', 'River Ridge': 'rrnd', 'Cottonwood': 'cwnd' };

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

const fin = {};
for (const f of ['jamestown-uw.xlsx', 'bismarck-uw.xlsx']) {
  for (const s of parseUwBook(readFileSync(`test/fixtures/${f}`))) {
    if (s.isPortfolio) continue;
    const code = Object.entries(MAP).find(([name]) => s.sheetName.toLowerCase().includes(name.toLowerCase()))?.[1];
    if (!code) continue;
    const a = s.data.assumptions;
    fin[code] = { loan: Number(a.loanAmount) || 0, rate: Number(a.interestRate) || 0.06, ltv: Number(a.ltv) || 0 };
  }
}
console.log('financing from UW books:', JSON.stringify(fin));

await call('/login', { method: 'POST', body: { username: 'Troy Steiss', password: process.env.APP_PASSWORD || 'Monarch7!' } });
const st = await call('/state');
for (const b of st.budgets.filter((x) => x.year === 2026)) {
  const f = fin[b.property_code];
  if (!f || !f.loan) { console.log('no financing for', b.property_code); continue; }
  const capital = f.ltv ? Math.round((f.loan / f.ltv - f.loan) * 100) / 100 : 0;
  const bv = await call(`/budgets/${b.id}`, { method: 'PUT', body: { inputs: { loan: f.loan, rate: f.rate, capital } } });
  const int = bv.lines.find((l) => l.gl_code === '7300');
  console.log(`${b.property_code} loan ${f.loan} @ ${(f.rate * 100).toFixed(2)}% cap~${capital} → interest ${Math.round(int.months.reduce((a, x) => a + x, 0))}, CF ${Math.round(bv.kpis.cashFlow)}, CoC ${bv.kpis.coc != null ? (bv.kpis.coc * 100).toFixed(2) + '%' : '—'}`);
}
console.log('done');
