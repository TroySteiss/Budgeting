/* Extract the per-GL budgeting rule from a completed Yardi budget template
   workbook (the GRKS 2026 RMC draft is the foundation) into seed/annual-rules.json.
   Each Budget Worksheet month formula is classified into one of the methods
   the annual engine (shared/annual.ts) implements:
     same      PY same month × (1+factor)                  [MROUND m / ROUNDUP to 10]
     wavg      (PY prev + 2×PY this + PY next)/4 × (1+f)   [MROUND m]   — the 1-2-1 weighted average
     flatT12   T12 × (1+f) / 12, flat (only when T12 > $1,000 unless noThreshold)
     last      last actual month (October), flat × (1+f)
     fixed     a typed annual amount / 12 or typed months  → not a rule (left to the engine default)
     pct…      ratio formulas (vacancy / delinquency / collections) → engine-specific, recorded as 'engine'
   Usage: node scripts/extract-annual-rules.mjs "<path to .xlsm>" [--write] */
import XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';

const path = process.argv[2] || 'test/fixtures/yardi-template-grks-draft.xlsm';
const write = process.argv.includes('--write');
const wb = XLSX.readFile(path, { cellFormula: true });
const ws = wb.Sheets['Budget Worksheet'];
const MONTH_COLS = 'EFGHIJKLMNOP'.split('');

function classify(f) {
  if (!f) return null;
  const s = f.replace(/\$/g, '').replace(/\s+/g, '');
  // ROUNDUP(MROUND(x,50),-1) is a no-op on a multiple of 50 — treat as MROUND 50.
  // Find MROUND's own last argument by walking the parentheses.
  let mround = 0;
  const mi = s.indexOf('MROUND(');
  if (mi >= 0) {
    let depth = 0, lastComma = -1;
    for (let i = mi + 6; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { const arg = s.slice(lastComma + 1, i); if (/^\d+$/.test(arg)) mround = Number(arg); break; } }
      else if (ch === ',' && depth === 1) lastComma = i;
    }
  }
  const roundup = false;
  const same = /SUMPRODUCT\(--\([A-P]1=Fins_Month\),--\(A\d+=Fins_AcctCode\),Fins_MtdActual\)/;
  const oct = /SUMPRODUCT\(--\(N1=Fins_Month\),--\(A\d+=Fins_AcctCode\),Fins_MtdActual\)/;
  if (/AVERAGE\(/.test(s) && same.test(s)) return { method: 'wavg', mround, roundup };
  if (/^IF\(S\d+>1000,S\d+\*\(1\+D\d+\)\/12,0\)$/.test(s)) return { method: 'flatT12', mround: 0, roundup: false };
  if (/^S\d+\*\(1\+D\d+\)\/12$/.test(s)) return { method: 'flatT12', mround: 0, roundup: false, noThreshold: true };
  if (/Loan_Interest|Loan_PrincipalPayment/.test(s)) return { method: 'debt' };
  if (/Suggested_Acct/.test(s)) return { method: 'suggested' };
  if (/C3\*|\*C3/.test(s) && !same.test(s)) return { method: 'corpRate' };
  if (/Payroll_Index|Paste Payroll/.test(s)) return { method: 'payroll' };
  if (oct.test(s) && !/[A-MOP]1=Fins_Month/.test(s.replace(/N1=Fins_Month/g, ''))) return { method: 'last', mround, roundup };
  if (same.test(s)) return { method: 'same', mround, roundup };
  if (/^\d+(\.\d+)?\/12$/.test(s)) return { method: 'fixedAnnual', annual: Number(s.split('/')[0]) };
  return { method: 'engine', formula: f.slice(0, 120) };
}

const rules = {};
const stats = {};
for (let r = 7; r <= 440; r++) {
  const gl = ws['A' + r]?.v;
  if (!gl || !/^\d{4}$/.test(String(gl))) continue;
  const name = String(ws['B' + r]?.v || '').trim();
  const D = ws['D' + r]?.v;
  const counts = new Map();
  let hard = 0;
  for (const col of MONTH_COLS) {
    const c = ws[col + r];
    if (!c) continue;
    if (c.f) { const k = JSON.stringify(classify(c.f)); counts.set(k, (counts.get(k) || 0) + 1); }
    else if (typeof c.v === 'number') hard++;
  }
  if (!counts.size) continue;
  // the dominant formula pattern wins; a row that is mostly typed numbers is 'fixed'
  const [bestK, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const best = JSON.parse(bestK);
  if (hard > n) continue;                       // RMC typed it — no rule to learn
  const rule = { method: best.method };
  if (best.mround) rule.mround = best.mround;
  if (best.roundup) rule.roundup = true;
  if (best.noThreshold) rule.noThreshold = true;
  if (typeof D === 'number' && D < 1 && D > -1 && ['same', 'wavg', 'flatT12', 'last'].includes(best.method)) rule.factor = Math.round(D * 10000) / 10000;
  if (best.method === 'last' && /renewal|burnoff/i.test(String(ws['C' + r]?.v || ''))) delete rule.factor;   // D is the renewal % there, not a factor
  rule.name = name;
  if (best.method === 'engine') rule.formula = best.formula;
  rules[String(gl)] = rule;
  stats[best.method] = (stats[best.method] || 0) + 1;
}
console.log('methods:', stats);
for (const [gl, r] of Object.entries(rules)) console.log(gl, r.name.padEnd(32).slice(0, 32), r.method.padEnd(11), r.mround ? `MROUND ${r.mround}${r.roundup ? ' ↑10' : ''}` : '', r.factor != null ? `× ${(1 + r.factor).toFixed(3)}` : '', r.noThreshold ? 'no $1k threshold' : '', r.formula ? `  [${r.formula}]` : '');
if (write) {
  writeFileSync('seed/annual-rules.json', JSON.stringify({ source: path.split(/[\\/]/).pop(), extracted: new Date().toISOString().slice(0, 10), rules }, null, 1) + '\n');
  console.log(`wrote seed/annual-rules.json (${Object.keys(rules).length} rules)`);
}
