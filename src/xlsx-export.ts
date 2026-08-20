/* Excel review workbook — mirrors the FHND/PHND budget workbook layout:
   "Budget" sheet ≈ the PHNDBudget tab (row-3 KPI strip, GL rows in Monarch
   order, months E:P, R = Total Year 1 Budget, T = Year 1 UW Budget, U = Minot
   comp scaled to subject units, X/Y per-unit, Z = Notes for Budget Upload),
   "Summary" ≈ SummaryPHND (section totals vs UW down to CoC), plus "Raw Data"
   (org rule: show the work — formulas + the raw inputs). */
import * as XLSX from 'xlsx';
import {
  CoaAccount, BudgetLine, UwSnapshotData, BudgetInputs, PCODES, PCODE_LABELS,
  rollup, sum, zero12, r2, Months, monthLabels,
} from '../shared/domain.js';

const colLetter = (i: number): string => XLSX.utils.encode_col(i);

/* Budget-sheet columns (0-based): A code, B name, C notes, D driver,
   E..P months (4..15), Q spacer, R annual, S spacer, T UW, U comp,
   V spacer, W spacer, X $/unit, Y $/unit/mo, Z upload note */
const COL = { code: 0, name: 1, notes: 2, driver: 3, m0: 4, annual: 17, uw: 19, comp: 20, perUnit: 23, perUnitMo: 24, note: 25 };

function driverLabel(d: any): string {
  switch (d?.method) {
    case 'gpr': return 'rent roll GPR';
    case 'ltl': return 'LTL burnoff';
    case 'vacancy': return 'vacancy % of GPR';
    case 'catShare': return `UW cat ${d.pcode} share`;
    case 'perUnitComp': return `Minot $${d.perUnit}/unit`;
    case 'payrollModel': return 'payroll model wages';
    case 'burdenRatio': return `Minot ratio ${(d.ratio * 100).toFixed(1)}% of wages`;
    case 'mgmtPct': return `${(d.pct * 100).toFixed(2)}% of income`;
    case 'interest': return 'loan interest';
    default: return '';
  }
}

/** UW Year-1 $ placed on Budget-sheet rows, FHND-style. Split categories are
    apportioned across their Monarch sections by budget share. */
function uwColumnValues(uw: UwSnapshotData, catBudget: (codes: string[]) => number): Record<string, number> {
  const y = uw.y1;
  const out: Record<string, number> = {
    '4994': y['1'] || 0, '5003': y['loss'] || 0, '5029': y['2'] || 0, '5049': y['3'] || 0,
    '5190': r2((y['4'] || 0) + (y['5'] || 0)), '5500': uw.egi,
    '6108': y['6'] || 0, '6112': y['7'] || 0, '6116': y['8'] || 0,
    '6470': y['10'] || 0, '6570': y['11'] || 0, '6670': y['12'] || 0,
    '7070': y['14'] || 0, '7098': r2((y['13'] || 0) + (y['14'] || 0)),
    '7099': uw.toe, '7279': uw.toe, '7280': uw.noi,
  };
  const split = (uwTotal: number, sections: [string, [number, number]][]) => {
    const budgets = sections.map(([, range]) => Math.abs(catBudget([String(range[0]), String(range[1])])));
    const tot = budgets.reduce((a, b) => a + b, 0);
    sections.forEach(([code], i) => { out[code] = tot ? r2((uwTotal * budgets[i]) / tot) : (i === 0 ? uwTotal : 0); });
  };
  split(y['9'] || 0, [['6170', [6101, 6169]], ['6370', [6301, 6369]], ['6399', [6374, 6398]]]);
  split(y['13'] || 0, [['6770', [6701, 6769]], ['6870', [6801, 6869]], ['6970', [6901, 6969]]]);
  return out;
}

export function buildReviewWorkbook(args: {
  propertyCode: string; propertyName: string; year: number; units: number;
  coa: CoaAccount[]; lines: BudgetLine[]; inputs: BudgetInputs;
  uw: UwSnapshotData | null; compWeights?: Record<string, number> | null; compUnits?: number | null;
  compName?: string;
}): Buffer {
  const { coa, lines, inputs, uw, units } = args;
  const byGl = new Map(lines.map((l) => [l.gl_code, l]));
  const ordered = [...coa].filter((a) => a.active).sort((a, b) => a.display_order - b.display_order);
  const monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
  const totals = rollup(monthsMap);
  const catBudget = (range: string[]): number => {
    const lo = parseInt(range[0], 10), hi = parseInt(range[1], 10);
    let acc = 0;
    for (const [gl, m] of monthsMap) { const n = parseInt(gl, 10); if (n >= lo && n <= hi) acc = r2(acc + sum(m)); }
    return acc;
  };
  const uwCol = uw ? uwColumnValues(uw, catBudget) : {};

  /* ---------------- Budget sheet (PHNDBudget-style) ---------------- */
  const aoa: any[][] = [];
  const blank = (): any[] => [];
  aoa.push([null, args.propertyName, `(${args.propertyCode})`, null, `Budget Year ${args.year}`]);   // r1
  aoa.push(blank());                                                                                  // r2
  aoa.push([null, 'Units:', units, 'Total Income', null, 'Total Expense', null, 'NOI', null,
            'Interest', null, 'Principal', null, 'Cash Flow', null, 'Cash on Cash', null]);           // r3
  aoa.push([null, 'Capital:', inputs.capital || 0]);                                                  // r4
  aoa.push(blank());                                                                                  // r5
  aoa.push(['GL Code', 'GL Name', 'Notes', 'Driver',
            ...monthLabels(args.year, inputs.startMonth || 1), null,
            'Total Year 1 Budget', null, 'Year 1 UW Budget',
            `Minot Budget at ${units} units`, null, null, 'Total Per Unit', 'Total Per Unit Per Month',
            'Notes for Budget Upload']);                                                              // r6
  const headerRow = 6;
  const rowOf = new Map<string, number>();
  for (const a of ordered) {
    const r = aoa.length + 1;
    rowOf.set(a.code, r);
    const row: any[] = Array(26).fill(null);
    row[COL.code] = a.code;
    row[COL.name] = (a.kind === 'detail' ? '    ' : a.kind === 'total' ? '  ' : ' ') + a.name;
    if (a.kind === 'detail') {
      const ln = byGl.get(a.code);
      row[COL.driver] = ln ? driverLabel(ln.driver) + (ln.override ? ' (manual)' : '') : '';
      (ln?.months || zero12()).forEach((v, i) => { row[COL.m0 + i] = v || null; });
      row[COL.note] = ln?.note || null;
      if (args.compWeights && args.compUnits && args.compWeights[a.code]) {
        row[COL.comp] = r2((args.compWeights[a.code] / args.compUnits) * units);
      }
    }
    if (uwCol[a.code] != null && uwCol[a.code] !== 0) row[COL.uw] = uwCol[a.code];
    aoa.push(row);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const setF = (r: number, c: number, f: string, fmt?: string): void => {
    const addr = XLSX.utils.encode_cell({ r: r - 1, c });
    ws[addr] = { t: 'n', f, ...(fmt ? { z: fmt } : {}) };
  };

  // detail + total row formulas (annual, per-unit)
  for (const a of ordered) {
    const r = rowOf.get(a.code)!;
    if (a.kind === 'header') continue;
    setF(r, COL.annual, `SUM(E${r}:P${r})`, '#,##0');
    setF(r, COL.perUnit, units ? `R${r}/$C$3` : `R${r}`, '#,##0.00');
    setF(r, COL.perUnitMo, units ? `R${r}/$C$3/12` : `R${r}/12`, '#,##0.00');
  }
  // section totals: month-by-month formulas over detail rows
  const rangeTotals: Record<string, [number, number]> = {
    '5004': [4994, 5003], '5029': [5018, 5028], '5049': [5031, 5048], '5190': [5101, 5189],
    '6170': [6101, 6169], '6370': [6301, 6369], '6399': [6374, 6398], '6470': [6401, 6469],
    '6570': [6501, 6569], '6670': [6601, 6669], '6770': [6701, 6769], '6870': [6801, 6869],
    '6970': [6901, 6969], '7070': [7001, 7069], '7315': [7300, 7314], '7500': [7321, 7499],
    '8602': [8500, 8601], '8950': [8901, 8949],
  };
  const compositeTotals: Record<string, string[]> = {
    '5070': ['5004', '5029', '5049'], '5500': ['5070', '5190'],
    '7098': ['6770', '6870', '6970', '7070'],
    '7099': ['6170', '6370', '6399', '6470', '6570', '6670', '7098'], '7279': ['7099'],
  };
  const detailRowsIn = (lo: number, hi: number): number[] =>
    ordered.filter((a) => a.kind === 'detail' && parseInt(a.code, 10) >= lo && parseInt(a.code, 10) <= hi).map((a) => rowOf.get(a.code)!);
  for (let c = COL.m0; c <= COL.m0 + 11; c++) {
    const L = colLetter(c);
    for (const [code, [lo, hi]] of Object.entries(rangeTotals)) {
      const r = rowOf.get(code);
      if (!r) continue;
      const rows = detailRowsIn(lo, hi);
      if (rows.length) setF(r, c, `SUM(${L}${Math.min(...rows)}:${L}${Math.max(...rows)})`, '#,##0');
    }
    for (const [code, parts] of Object.entries(compositeTotals)) {
      const r = rowOf.get(code);
      if (!r) continue;
      setF(r, c, parts.map((p) => `${L}${rowOf.get(p)}`).join('+'), '#,##0');
    }
    const rNoi = rowOf.get('7280'), rInc = rowOf.get('5500'), rExp = rowOf.get('7279');
    if (rNoi && rInc && rExp) setF(rNoi, c, `${L}${rInc}-${L}${rExp}`, '#,##0');
    const r8200 = rowOf.get('8200'), r7315 = rowOf.get('7315'), r7500 = rowOf.get('7500');
    if (r8200 && rNoi && r7315 && r7500) setF(r8200, c, `${L}${rNoi}-${L}${r7315}-${L}${r7500}`, '#,##0');
    const r9000 = rowOf.get('9000'), r8602 = rowOf.get('8602'), r8950 = rowOf.get('8950');
    if (r9000 && r8200 && r8602 && r8950) setF(r9000, c, `${L}${r8200}-${L}${r8602}-${L}${r8950}`, '#,##0');
  }
  // KPI strip (row 3) — live formulas off the R column, like FHNDBudget row 3
  const principalRows = ['3080', '3090', '3091'].map((c) => rowOf.get(c)).filter(Boolean) as number[];
  const kpiRefs: [number, string][] = [
    [4, `R${rowOf.get('5500')}`], [6, `R${rowOf.get('7279')}`], [8, `R${rowOf.get('7280')}`],
    [10, `R${rowOf.get('7315')}`],
    [12, principalRows.length ? `ABS(${principalRows.map((r) => `R${r}`).join('+')})` : '0'],
    [14, `I3-K3-M3`],
  ];
  for (const [c, f] of kpiRefs) setF(3, c, f, '#,##0');
  setF(3, 16, `IF($C$4>0,O3/$C$4,"")`, '0.00%');
  ws['!cols'] = [
    { wch: 8 }, { wch: 38 }, { wch: 16 }, { wch: 22 },
    ...Array(12).fill({ wch: 10 }), { wch: 2 }, { wch: 14 }, { wch: 2 }, { wch: 14 },
    { wch: 14 }, { wch: 2 }, { wch: 2 }, { wch: 10 }, { wch: 10 }, { wch: 26 },
  ];
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: 25 } });

  /* ---------------- Summary sheet (SummaryPHND-style) ---------------- */
  const S: any[][] = [];
  S.push([null, `${args.propertyName} Year ${args.year} Budget Analysis`]);
  S.push([null, null, null, null, null, null, 'Unit Count', units]);
  S.push([]);
  S.push([null, 'Account Summary', null, 'Year 1 UW Budget', 'Year 1 Budget', 'Δ vs UW', 'Per Unit', 'Per Unit / Month']);
  const sumRows: [string, string][] = [
    ['5070', 'TOTAL RENTAL INCOME'], ['5190', 'NET OTHER INCOME'], ['5500', 'TOTAL INCOME'],
    ['6170', 'TOTAL FIXED ADMINISTRATIVE'], ['6370', 'TOTAL ADMINISTRATIVE'], ['6399', 'TOTAL CORPORATE EVENTS'],
    ['6470', 'TOTAL PAYROLL'], ['6570', 'TOTAL MARKETING'], ['6670', 'TOTAL UTILITIES'],
    ['6770', 'TOTAL IN-HOUSE MAINT'], ['6870', 'TOTAL EXTERIOR/CAM'], ['6970', 'TOTAL CONTRACT SERVICES'],
    ['7070', 'TOTAL REHAB/REPLACEMENT'], ['7099', 'TOTAL OPERATING EXPENSES'], ['7280', 'NET OPERATING INCOME'],
  ];
  const uwSummary: Record<string, number> = uw ? {
    '5070': r2((uw.y1['1'] || 0) + (uw.y1['loss'] || 0) + (uw.y1['2'] || 0) + (uw.y1['3'] || 0)),
    '5190': r2((uw.y1['4'] || 0) + (uw.y1['5'] || 0)), '5500': uw.egi,
    '6170': uwCol['6170'] || 0, '6370': uwCol['6370'] || 0, '6399': uwCol['6399'] || 0,
    '6470': uw.y1['10'] || 0, '6570': uw.y1['11'] || 0, '6670': uw.y1['12'] || 0,
    '6770': uwCol['6770'] || 0, '6870': uwCol['6870'] || 0, '6970': uwCol['6970'] || 0,
    '7070': uw.y1['14'] || 0, '7099': uw.toe, '7280': uw.noi,
  } : {};
  const sumStart = S.length + 1;
  for (const [code, label] of sumRows) S.push([code, label, null, uw ? uwSummary[code] : null]);
  S.push([]);
  const debtStart = S.length + 1;
  S.push([null, 'Interest Expense']);
  S.push([null, 'Principal']);
  S.push([null, 'Special Projects']);
  S.push([null, 'Cash Flow (NOI − debt service)']);
  S.push([]);
  S.push([null, 'Capital Contributions', null, inputs.capital || 0]);
  S.push([null, 'Cash on Cash Return']);
  const wsS = XLSX.utils.aoa_to_sheet(S);
  const setFS = (r: number, c: number, f: string, fmt?: string): void => {
    const addr = XLSX.utils.encode_cell({ r: r - 1, c });
    wsS[addr] = { t: 'n', f, ...(fmt ? { z: fmt } : {}) };
  };
  sumRows.forEach(([code], i) => {
    const r = sumStart + i;
    const bRow = rowOf.get(code);
    if (bRow) setFS(r, 4, `Budget!R${bRow}`, '#,##0');
    setFS(r, 5, `E${r}-D${r}`, '#,##0');
    setFS(r, 6, `E${r}/$H$2`, '#,##0.00');
    setFS(r, 7, `E${r}/$H$2/12`, '#,##0.00');
  });
  setFS(debtStart, 4, `Budget!R${rowOf.get('7315')}`, '#,##0');
  setFS(debtStart + 1, 4, principalRows.length ? `ABS(${principalRows.map((r) => `Budget!R${r}`).join('+')})` : '0', '#,##0');
  setFS(debtStart + 2, 4, `Budget!R${rowOf.get('7500')}`, '#,##0');
  setFS(debtStart + 3, 4, `E${sumStart + sumRows.length - 1}-E${debtStart}-E${debtStart + 1}`, '#,##0');
  setFS(debtStart + 6, 4, `IF(D${debtStart + 5}>0,E${debtStart + 3}/D${debtStart + 5},"")`, '0.00%');
  wsS['!cols'] = [{ wch: 7 }, { wch: 32 }, { wch: 2 }, { wch: 15 }, { wch: 15 }, { wch: 13 }, { wch: 11 }, { wch: 13 }];
  wsS['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: S.length - 1, c: 7 } });

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
  raw.push(['UW Year-1 by category (tie-out targets)']);
  raw.push(['pcode', 'label', 'UW Y1']);
  if (uw) for (const p of PCODES) raw.push([p, PCODE_LABELS[p], uw.y1[p] ?? '']);
  if (uw) { raw.push(['', 'EGI', uw.egi]); raw.push(['', 'TOE', uw.toe]); raw.push(['', 'NOI', uw.noi]); }
  raw.push([]);
  raw.push([`Comp set${args.compName ? `: ${args.compName}` : ''} (annual $, ${args.compUnits || '?'} units)`]);
  raw.push(['gl', 'comp annual $', 'comp $/unit', `scaled to ${units} units`]);
  if (args.compWeights && args.compUnits) {
    for (const [gl, v] of Object.entries(args.compWeights)) {
      if (!v) continue;
      raw.push([gl, v, r2(v / args.compUnits), r2((v / args.compUnits) * units)]);
    }
  }
  raw.push([]);
  raw.push(['Budget lines (raw)']);
  raw.push(['gl', 'annual', 'override', 'driver json']);
  for (const l of lines) {
    const t = sum(l.months);
    if (t || l.override) raw.push([l.gl_code, t, l.override ? 'Y' : '', JSON.stringify(l.driver)]);
  }
  const wsRaw = XLSX.utils.aoa_to_sheet(raw);
  wsRaw['!cols'] = [{ wch: 26 }, { wch: 40 }, { wch: 12 }, { wch: 60 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Budget');
  XLSX.utils.book_append_sheet(wb, wsS, 'Summary');
  XLSX.utils.book_append_sheet(wb, wsRaw, 'Raw Data');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
