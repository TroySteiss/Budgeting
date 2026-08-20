/* Fidelity check: read FHNDBudget's monthly detail values (E:P) per GL, run
   them through shared/domain rollup(), compare with the workbook's own total
   rows. Run: node --import tsx scripts/verify-rollup-fhnd.mjs */
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { rollup } from '../shared/domain.ts';

const wb = XLSX.read(readFileSync('test/fixtures/fhnd-budget-workbook.xlsx'), { type: 'buffer' });
const g = XLSX.utils.sheet_to_json(wb.Sheets['FHNDBudget'], { header: 1, raw: true, defval: null });

const TOTALS = ['5004','5029','5049','5070','5190','5500','6170','6370','6470','6570','6670','6770','6870','6970','7070','7098','7099','7280','7315','7500','8200'];
const totalSet = new Set(TOTALS.concat(['6399','7279','8602','8950','9000']));
// only detail-kind codes may carry amounts — the workbook has values typed on
// some section-header rows (5100, 7000) that Yardi's own totals exclude
const coa = JSON.parse(readFileSync('seed/coa.json', 'utf8'));
const detail = new Set(coa.filter((a) => a.kind === 'detail').map((a) => a.code));
const lines = new Map();
const sheetTotals = new Map();
for (const row of g) {
  const code = String(row?.[0] ?? '').trim();
  if (!/^\d{4}$/.test(code)) continue;
  const months = row.slice(4, 16).map((v) => Number(v) || 0);
  if (totalSet.has(code)) { if (!sheetTotals.has(code)) sheetTotals.set(code, months); continue; }
  if (!detail.has(code)) continue;
  if (!lines.has(code)) lines.set(code, months);
}
const t = rollup(lines);
let worst = 0, bad = 0;
for (const code of TOTALS) {
  const mine = (t.get(code) || []).reduce((a, b) => a + b, 0);
  const theirs = (sheetTotals.get(code) || []).reduce((a, b) => a + b, 0);
  const diff = Math.abs(mine - theirs);
  worst = Math.max(worst, diff);
  const flag = diff > 1 ? '  <-- MISMATCH' : '';
  if (diff > 1) bad++;
  console.log(`${code}  mine ${mine.toFixed(2).padStart(14)}  sheet ${theirs.toFixed(2).padStart(14)}  diff ${diff.toFixed(2)}${flag}`);
}
console.log(bad ? `\n${bad} mismatches (worst ${worst.toFixed(2)})` : `\nALL TOTALS MATCH (worst drift ${worst.toFixed(4)})`);
