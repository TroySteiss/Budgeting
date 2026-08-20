/* Excel review workbook (org rule: show the work — live formulas + raw data).
   Sheets: Budget (GL × months grid with formulas), Summary (P-code rollup vs
   UW), Raw Data (inputs + snapshots the budget was generated from). */
import * as XLSX from 'xlsx';
import { CoaAccount, BudgetLine, UwSnapshotData, BudgetInputs, PCODES, PCODE_LABELS, computeTieout, sum } from '../shared/domain.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const colLetter = (i: number): string => XLSX.utils.encode_col(i);

export function buildReviewWorkbook(args: {
  propertyCode: string; propertyName: string; year: number; units: number;
  coa: CoaAccount[]; lines: BudgetLine[]; inputs: BudgetInputs;
  uw: UwSnapshotData | null; uwByGlCategory?: Record<string, number>;
}): Buffer {
  const { coa, lines, inputs, uw } = args;
  const byGl = new Map(lines.map((l) => [l.gl_code, l]));
  const ordered = [...coa].filter((a) => a.active).sort((a, b) => a.display_order - b.display_order);

  /* ---------------- Budget sheet ---------------- */
  // Columns: A code, B name, C note, D..O months, P annual, Q $/unit, R $/unit/mo, S UW Y1 (category share n/a — detail rows blank), T pcode
  const aoa: any[][] = [];
  aoa.push([`${args.propertyName} (${args.propertyCode})`, `Budget Year ${args.year}`, `Units: ${args.units}`]);
  aoa.push([]);
  aoa.push(['GL Code', 'GL Name', 'Note', ...MONTHS, 'Annual', '$/Unit', '$/Unit/Mo', 'P-Code']);
  const headerRow = 3; // 1-based row of the column header
  const rowOf = new Map<string, number>(); // code -> 1-based sheet row
  for (const a of ordered) {
    const r = aoa.length + 1;
    rowOf.set(a.code, r);
    if (a.kind === 'detail') {
      const ln = byGl.get(a.code);
      aoa.push([a.code, a.name, ln?.note || '', ...(ln?.months || Array(12).fill(0)), null, null, null, a.pcode || '']);
    } else {
      aoa.push([a.code, a.name, '', ...Array(12).fill(null), null, null, null, '']);
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const setF = (r: number, c: number, f: string): void => {
    const addr = XLSX.utils.encode_cell({ r: r - 1, c });
    ws[addr] = { t: 'n', f };
  };
  // annual + per-unit formulas on every detail row
  for (const a of ordered) {
    const r = rowOf.get(a.code)!;
    if (a.kind === 'header') continue;
    setF(r, 15, `SUM(D${r}:O${r})`);                    // P annual
    setF(r, 16, args.units ? `P${r}/${args.units}` : `P${r}`);   // Q $/unit
    setF(r, 17, args.units ? `P${r}/${args.units}/12` : `P${r}/12`); // R $/unit/mo
  }
  // total rows: month-by-month formulas
  const rangeTotals: Record<string, [number, number]> = {
    '5004': [4994, 5003], '5029': [5018, 5028], '5049': [5031, 5048], '5190': [5100, 5189],
    '6170': [6100, 6169], '6370': [6300, 6369], '6399': [6372, 6398], '6470': [6400, 6469],
    '6570': [6500, 6569], '6670': [6600, 6669], '6770': [6700, 6769], '6870': [6800, 6869],
    '6970': [6900, 6969], '7070': [7000, 7069], '7315': [7300, 7314], '7500': [7321, 7499],
    '8602': [8500, 8601], '8950': [8901, 8949],
  };
  const compositeTotals: Record<string, string[]> = {
    '5070': ['5004', '5029', '5049'],
    '5500': ['5070', '5190'],
    '7098': ['6770', '6870', '6970', '7070'],
    '7099': ['6170', '6370', '6399', '6470', '6570', '6670', '7098'],
    '7279': ['7099'],
  };
  const detailRowsIn = (lo: number, hi: number): number[] =>
    ordered.filter((a) => a.kind === 'detail' && parseInt(a.code, 10) >= lo && parseInt(a.code, 10) <= hi).map((a) => rowOf.get(a.code)!);
  for (let c = 3; c <= 15; c++) { // D..O months + P annual (annual totals also from month sums? keep SUM(D:O) set above)
    const L = colLetter(c);
    for (const [code, [lo, hi]] of Object.entries(rangeTotals)) {
      const r = rowOf.get(code);
      if (!r) continue;
      const rows = detailRowsIn(lo, hi);
      if (!rows.length) continue;
      const lo_ = Math.min(...rows), hi_ = Math.max(...rows);
      if (c <= 14) setF(r, c, `SUM(${L}${lo_}:${L}${hi_})`);
    }
    for (const [code, parts] of Object.entries(compositeTotals)) {
      const r = rowOf.get(code);
      if (!r) continue;
      const refs = parts.map((p) => `${L}${rowOf.get(p)}`).filter((x) => !x.includes('undefined'));
      if (refs.length && c <= 14) setF(r, c, refs.join('+'));
    }
    if (c <= 14) {
      const rNoi = rowOf.get('7280'), rInc = rowOf.get('5500'), rExp = rowOf.get('7279');
      if (rNoi && rInc && rExp) setF(rNoi, c, `${L}${rInc}-${L}${rExp}`);
      const r8200 = rowOf.get('8200'), r7315 = rowOf.get('7315'), r7500 = rowOf.get('7500');
      if (r8200 && rNoi && r7315 && r7500) setF(r8200, c, `${L}${rNoi}-${L}${r7315}-${L}${r7500}`);
      const r9000 = rowOf.get('9000'), r8602 = rowOf.get('8602'), r8950 = rowOf.get('8950');
      if (r9000 && r8200 && r8602 && r8950) setF(r9000, c, `${L}${r8200}-${L}${r8602}-${L}${r8950}`);
    }
  }
  ws['!cols'] = [{ wch: 8 }, { wch: 38 }, { wch: 24 }, ...Array(12).fill({ wch: 11 }), { wch: 13 }, { wch: 9 }, { wch: 10 }, { wch: 7 }];
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: 18 } });

  /* ---------------- Summary sheet ---------------- */
  const coaMap = new Map(coa.map((a) => [a.code, a]));
  const tie = computeTieout(lines, coaMap, uw);
  const sm: any[][] = [];
  sm.push([`${args.propertyName} — ${args.year} Budget vs Underwriting`]);
  sm.push([]);
  sm.push(['Category', 'Budget', 'UW Year 1', 'Variance', 'Var %', 'Budget $/Unit']);
  for (const row of tie.rows) {
    sm.push([row.label, row.budget, row.uw, row.variance, row.pct, args.units ? Math.round((row.budget / args.units) * 100) / 100 : null]);
  }
  sm.push([]);
  for (const row of [tie.egi, tie.toe, tie.noi]) {
    sm.push([row.label, row.budget, row.uw, row.variance, row.pct, args.units ? Math.round((row.budget / args.units) * 100) / 100 : null]);
  }
  const wsSum = XLSX.utils.aoa_to_sheet(sm);
  wsSum['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 13 }, { wch: 9 }, { wch: 13 }];

  /* ---------------- Raw Data sheet ---------------- */
  const raw: any[][] = [];
  raw.push(['Generated inputs (budgets.inputs)']);
  raw.push(['key', 'value']);
  const flat = (obj: any, prefix = ''): void => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, `${prefix}${k}.`);
      else raw.push([`${prefix}${k}`, Array.isArray(v) ? (v as any[]).join(', ') : (v as any)]);
    }
  };
  flat(inputs);
  raw.push([]);
  raw.push(['UW Year-1 by category']);
  raw.push(['pcode', 'label', 'UW Y1']);
  if (uw) for (const p of PCODES) raw.push([p, PCODE_LABELS[p], uw.y1[p] ?? '']);
  if (uw) { raw.push(['', 'EGI', uw.egi]); raw.push(['', 'TOE', uw.toe]); raw.push(['', 'NOI', uw.noi]); }
  raw.push([]);
  raw.push(['Budget lines (raw)']);
  raw.push(['gl', 'annual', 'override', 'driver']);
  for (const l of lines) {
    const t = sum(l.months);
    if (t || l.override) raw.push([l.gl_code, t, l.override ? 'Y' : '', JSON.stringify(l.driver)]);
  }
  const wsRaw = XLSX.utils.aoa_to_sheet(raw);
  wsRaw['!cols'] = [{ wch: 26 }, { wch: 40 }, { wch: 10 }, { wch: 60 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Budget');
  XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');
  XLSX.utils.book_append_sheet(wb, wsRaw, 'Raw Data');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
