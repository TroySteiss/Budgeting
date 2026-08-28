/* Excel review workbook — styled to match the FHND/PHND budget workbook that
   everyone reads: 8pt grid, $-currency red-negative detail cells with the
   light-green input fill, bold accounting-format section totals with thin top
   borders, the row-3 KPI strip (9pt labels / 11pt values), frozen panes at the
   header, light-blue tab. Built with ExcelJS (SheetJS can't write styles).
   Sheets: Budget (PHNDBudget-style), Summary (SummaryPHND-style), Raw Data
   (org rule: show the work — formulas + raw inputs). */
import ExcelJS from 'exceljs';
import {
  CoaAccount, BudgetLine, UwSnapshotData, BudgetInputs, PCODES, PCODE_LABELS,
  sum, zero12, r2, Months, monthLabels,
} from '../shared/domain.js';

/* Budget-sheet columns (1-based): A code, B name, C notes, D driver,
   E..P months (5..16), Q spacer, R annual, S spacer, T UW, U comp,
   V/W spacers, X $/unit, Y $/unit/mo, Z upload note */
const C = { code: 1, name: 2, notes: 3, driver: 4, m1: 5, annual: 18, uw: 20, comp: 21, perUnit: 24, perUnitMo: 25, note: 26 };

const CUR = '"$"#,##0_);[Red]("$"#,##0)';
const ACCT = '_(* #,##0_);_(* (#,##0);_(* "-"??_);_(@_)';
const PU = '#,##0.00';
const PCT = '0.00%';
const HEAD = 'FFF2F2F2';    // header row fill
const UWFILL = 'FFFFF2CC';  // UW column tint
const COMPFILL = 'FFDDEBF7';// Minot comp column tint
const GRAND = 'FFE3EBF7';   // grand-total row fill

/* Driver fills — same palette as the app grid, so the workbook shows what
   each row references (Troy: "colors pull through into the review workbook") */
const DRIVER_FILLS: Record<string, { fill: string; label: string }> = {
  rr: { fill: 'FFE3F1DE', label: 'Rent roll / income engine' },
  uw: { fill: 'FFFDF3D2', label: 'UW tie' },
  comp: { fill: 'FFDDEAF9', label: 'Minot comps' },
  pay: { fill: 'FFEBE2F8', label: 'Payroll model' },
  fee: { fill: 'FFDCF1EE', label: '% of income' },
  int: { fill: 'FFE9E9EC', label: 'Interest' },
  t12: { fill: 'FFFBE8D9', label: 'Seller stmt / recovery' },
  man: { fill: 'FFF6E3F2', label: 'Manual override' },
};
function driverKind(l: BudgetLine | undefined): string {
  if (!l) return 'man';
  const m = (l.driver as any)?.method;
  if (l.override && (!m || m === 'manual')) return 'man';
  switch (m) {
    case 'gpr': case 'ltl': case 'vacancy': case 'charges': return 'rr';
    case 'catShare': return 'uw';
    case 'perUnitComp': case 't3avg': return 'comp';
    case 'wavg': return (l!.driver as any)?.srcType === 'seller' ? 't12' : 'comp';
    case 'payrollModel': case 'burdenRatio': return 'pay';
    case 'mgmtPct': return 'fee';
    case 'interest': return 'int';
    case 'sellerUtil': case 'recovery': case 'sellerLine': case 't12curve': case 'smooth': return 't12';
    case 'linkLine': return 'fee';
    default: return 'man';
  }
}

const f8 = { size: 8 };
const f8b = { size: 8, bold: true };

/* Fixed Summary-sheet layout (matches Troy's edited draft, e.g.
   "CWND 2026 Budget Draft TS 08212026.xlsx"): 16 account rows 5..20, debt
   block 22..25, capital+CoC row 27, monthly CoC table headed at 29 with
   M1..M12 at 30..41 and the Y1 CoC foot at 42. */
const S_FIRST = 5;
const S_NOI_ROW = 20;
const S_DEBT_START = 22;
const S_CASH_ROW = 25;
const S_CAP_ROW = 27;
const S_TABLE_HEAD = 29;
const S_M1 = 30;
const S_FOOT = 42;
const CURC = '"$"#,##0.00_);[Red]("$"#,##0.00)';
const RED = 'FFFF0000';

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
    case 'sellerUtil': return 'seller statement level';
    case 'recovery': return `${(d.pct * 100).toFixed(1)}% recovery of prior-month billing`;
    case 'sellerLine': return `seller: ${d.name || ''} × ${(d.pct || 0).toFixed(1)}%`;
    case 'charges': return 'rent-roll charges × 12';
    case 't3avg': return `T3 avg of ${d.srcName || 'comp'} × ${(d.pct || 0).toFixed(1)}% (MROUND 250)`;
    case 'wavg': return `1-2-1 wtd avg of ${d.srcName || 'source'} × ${(d.pct || 0).toFixed(1)}%`;
    case 't12curve': return `seller ${d.name || ''} T12 total × ${(d.pct || 0).toFixed(1)}% on ${d.shape || 'flat'} curve`;
    case 'smooth': return `missed-bill smoothing ×${d.passes || 0}`;
    case 'linkLine': return `= ${d.src || ''} × ${d.weight ?? 1}`;
    case 'setTotal': return `total set to ${Math.round(d.total || 0).toLocaleString()}`;
    case 'zero': return 'zeroed out';
    case 'imported': return `imported from draft${d.file ? ` (${d.file})` : ''}`;
    default: return '';
  }
}

/** UW Year-1 $ placed on Budget-sheet rows, FHND-style. Split categories are
    apportioned across their Monarch sections by the budget of THAT CATEGORY's
    lines only, and section totals add the other categories they contain —
    Monarch's FIXED ADMIN section holds insurance (6), mgmt fee (7) and taxes
    (8) on top of its cat-9 lines, so its UW total must too. */
function uwColumnValues(uw: UwSnapshotData, catBudget: (pcode: string, range: [number, number]) => number): Record<string, number> {
  const y = uw.y1;
  const out: Record<string, number> = {
    '4994': y['1'] || 0, '5003': y['loss'] || 0, '5004': r2((y['1'] || 0) + (y['loss'] || 0)),
    '5029': y['2'] || 0, '5049': y['3'] || 0,
    '5190': r2((y['4'] || 0) + (y['5'] || 0)), '5500': uw.egi,
    '6108': y['6'] || 0, '6112': y['7'] || 0, '6116': y['8'] || 0,
    '6470': y['10'] || 0, '6570': y['11'] || 0, '6670': y['12'] || 0,
    '7070': y['14'] || 0, '7098': r2((y['13'] || 0) + (y['14'] || 0)),
    '7099': uw.toe, '7279': uw.toe, '7280': uw.noi,
  };
  const split = (pcode: string, uwTotal: number, sections: [string, [number, number]][]) => {
    const budgets = sections.map(([, range]) => Math.abs(catBudget(pcode, range)));
    const tot = budgets.reduce((a, b) => a + b, 0);
    sections.forEach(([code], i) => { out[code] = tot ? r2((uwTotal * budgets[i]) / tot) : (i === 0 ? uwTotal : 0); });
  };
  split('9', y['9'] || 0, [['6170', [6101, 6169]], ['6370', [6301, 6369]], ['6399', [6374, 6398]]]);
  split('13', y['13'] || 0, [['6770', [6701, 6769]], ['6870', [6801, 6869]], ['6970', [6901, 6969]]]);
  // FIXED ADMIN's UW total = its cat-9 slice + insurance + mgmt fee + taxes
  out['6170'] = r2((out['6170'] || 0) + (y['6'] || 0) + (y['7'] || 0) + (y['8'] || 0));
  return out;
}

export interface ReviewArgs {
  propertyCode: string; propertyName: string; year: number; units: number;
  coa: CoaAccount[]; lines: BudgetLine[]; inputs: BudgetInputs;
  uw: UwSnapshotData | null; compWeights?: Record<string, number> | null; compUnits?: number | null;
  compName?: string;
}

export async function buildReviewWorkbook(args: ReviewArgs): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'nd-budget-tool';
  addReviewSheets(wb, args, '');
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

/** All-sites workbook: every site's Budget/Summary/Raw Data tabs (prefixed
    "CWND Budget" …) plus a live Portfolio rollup tab referencing them. */
export async function buildPortfolioWorkbook(sites: ReviewArgs[], portfolioLabel: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'nd-budget-tool';
  const wsP = wb.addWorksheet('Portfolio', { properties: { tabColor: { argb: 'FFFFC000' } }, views: [{ state: 'frozen', ySplit: 4, xSplit: 2 }] });
  for (const site of sites) addReviewSheets(wb, site, `${site.propertyCode.toUpperCase()} `);

  // ----- Portfolio tab: same Summary rows, one column per site + Total -----
  wsP.getColumn(1).width = 3; wsP.getColumn(2).width = 34;
  sites.forEach((_, i) => { wsP.getColumn(3 + i).width = 14; });
  const totCol = 3 + sites.length;
  wsP.getColumn(totCol).width = 15;
  wsP.getCell(1, 2).value = `${portfolioLabel} — Year 1 Budget Portfolio Rollup`;
  wsP.getCell(1, 2).font = { size: 12, bold: true };
  const sq = (s: ReviewArgs) => `'${s.propertyCode.toUpperCase()} Summary'!`;
  // header
  sites.forEach((s, i) => {
    const c = wsP.getCell(4, 3 + i);
    c.value = s.propertyCode.toUpperCase();
    c.font = f8b; c.alignment = { horizontal: 'right' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
    c.border = { bottom: { style: 'thin' } };
  });
  const tc = wsP.getCell(4, totCol);
  tc.value = 'PORTFOLIO'; tc.font = f8b; tc.alignment = { horizontal: 'right' };
  tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAND } };
  tc.border = { bottom: { style: 'thin' } };
  wsP.getCell(4, 2).value = 'Account Summary';
  wsP.getCell(4, 2).font = f8b;
  wsP.getCell(4, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
  wsP.getCell(4, 2).border = { bottom: { style: 'thin' } };
  // units row + summary rows 5..20 + debt 22..25 + capital 27 (same layout as site Summary)
  const put = (r: number, label: string, srcCell: string, opts: { bold?: boolean; fmt?: string; noTotal?: boolean } = {}) => {
    wsP.getCell(r, 2).value = label;
    wsP.getCell(r, 2).font = { size: 8.5, bold: !!opts.bold };
    sites.forEach((s, i) => {
      const c = wsP.getCell(r, 3 + i);
      c.value = { formula: `${sq(s)}${srcCell}` } as any;
      c.numFmt = opts.fmt || ACCT; c.font = { size: 8.5, bold: !!opts.bold };
    });
    if (!opts.noTotal) {
      const c = wsP.getCell(r, totCol);
      const L0 = wsP.getColumn(3).letter, L1 = wsP.getColumn(totCol - 1).letter;
      c.value = { formula: `SUM(${L0}${r}:${L1}${r})` } as any;
      c.numFmt = opts.fmt || ACCT; c.font = { size: 8.5, bold: true };
    }
    if (opts.bold) for (let c2 = 2; c2 <= totCol; c2++) wsP.getCell(r, c2).border = { top: { style: 'thin' } };
  };
  wsP.getCell(3, 2).value = 'Units';
  wsP.getCell(3, 2).font = f8b;
  sites.forEach((s, i) => { const c = wsP.getCell(3, 3 + i); c.value = s.units; c.font = f8b; });
  wsP.getCell(3, totCol).value = sites.reduce((a, s) => a + s.units, 0);
  wsP.getCell(3, totCol).font = f8b;
  const S_ROWS: [number, string, boolean][] = [
    [5, 'TOTAL NET GROSS POTENTIAL RENT', false], [6, 'TOTAL RENTAL INCOME', false], [7, 'NET OTHER INCOME', false],
    [8, 'TOTAL INCOME', true], [9, 'TOTAL FIXED ADMINISTRATIVE', false], [10, 'TOTAL ADMINISTRATIVE', false],
    [11, 'TOTAL CORPORATE EVENTS', false], [12, 'TOTAL PAYROLL', false], [13, 'TOTAL MARKETING', false],
    [14, 'TOTAL UTILITIES', false], [15, 'TOTAL IN-HOUSE MAINT', false], [16, 'TOTAL EXTERIOR/CAM', false],
    [17, 'TOTAL CONTRACT SERVICES', false], [18, 'TOTAL REHAB/REPLACEMENT', false],
    [19, 'TOTAL OPERATING EXPENSES', true], [20, 'NET OPERATING INCOME', true],
  ];
  for (const [r, label, bold] of S_ROWS) put(r, label, `E${r}`, { bold });
  put(S_DEBT_START, 'Interest Expense', `E${S_DEBT_START}`);
  put(S_DEBT_START + 1, 'Principal', `E${S_DEBT_START + 1}`);
  put(S_DEBT_START + 2, 'Special Projects', `E${S_DEBT_START + 2}`);
  put(S_CASH_ROW, 'Cash Flow (NOI − debt service)', `E${S_CASH_ROW}`, { bold: true });
  put(S_CAP_ROW, 'Capital Contributions', `D${S_CAP_ROW}`, { fmt: CUR });
  // Y1 CoC per site + portfolio (CF / capital)
  const cocRow = S_CAP_ROW + 2;
  wsP.getCell(cocRow, 2).value = 'Y1 Cash on Cash';
  wsP.getCell(cocRow, 2).font = { size: 8.5, bold: true, color: { argb: RED } };
  sites.forEach((s, i) => {
    const L = wsP.getColumn(3 + i).letter;
    const c = wsP.getCell(cocRow, 3 + i);
    c.value = { formula: `IF(${L}${S_CAP_ROW}>0,${L}${S_CASH_ROW}/${L}${S_CAP_ROW},"")` } as any;
    c.numFmt = PCT; c.font = { size: 8.5, bold: true, color: { argb: RED } };
  });
  const LT = wsP.getColumn(totCol).letter;
  const cocT = wsP.getCell(cocRow, totCol);
  cocT.value = { formula: `IF(${LT}${S_CAP_ROW}>0,${LT}${S_CASH_ROW}/${LT}${S_CAP_ROW},"")` } as any;
  cocT.numFmt = PCT; cocT.font = { size: 11, bold: true, color: { argb: RED } };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

function addReviewSheets(wb: ExcelJS.Workbook, args: ReviewArgs, prefix: string): void {
  const { coa, lines, inputs, uw, units } = args;
  // cross-sheet reference prefixes — prefixed tab names contain spaces, so quote
  const BQ = prefix ? `'${prefix}Budget'!` : 'Budget!';
  const SQ = prefix ? `'${prefix}Summary'!` : 'Summary!';
  const byGl = new Map(lines.map((l) => [l.gl_code, l]));
  const ordered = [...coa].filter((a) => a.active).sort((a, b) => a.display_order - b.display_order);
  const labels = monthLabels(args.year, inputs.startMonth || 1);
  const coaByCode = new Map(coa.map((a) => [a.code, a]));
  const catBudget = (pcode: string, [lo, hi]: [number, number]): number => {
    let acc = 0;
    for (const l of lines) {
      const n = parseInt(l.gl_code, 10);
      if (n >= lo && n <= hi && coaByCode.get(l.gl_code)?.pcode === pcode) acc = r2(acc + sum(l.months));
    }
    return acc;
  };
  const uwCol = uw ? uwColumnValues(uw, catBudget) : {};

  /* ================= Budget sheet ================= */
  const ws = wb.addWorksheet(`${prefix}Budget`, {
    properties: { tabColor: { argb: 'FF00B0F0' }, defaultRowHeight: 12 },
    views: [{ state: 'frozen', xSplit: 4, ySplit: 6 }],
  });
  const widths = [8, 40, 16, 20, ...Array(12).fill(10.5), 1.5, 13, 1.5, 13, 13, 1.5, 1.5, 9.5, 9.5, 26];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // r1: title
  ws.getCell(1, 2).value = args.propertyName;
  ws.getCell(1, 2).font = { size: 12, bold: true };
  ws.getCell(1, 3).value = `(${args.propertyCode})`;
  ws.getCell(1, 3).font = { size: 10, color: { argb: 'FF808080' } };
  ws.getCell(1, 5).value = `Year 1 Budget · ${labels[0]} – ${labels[11]}`;
  ws.getCell(1, 5).font = { size: 10, bold: true, color: { argb: 'FF505050' } };

  // r3 KPI strip (FHND row 3: 9pt bold labels, 11pt bold $ values off the R column)
  const rowOf = new Map<string, number>();
  let rr = 7;
  for (const a of ordered) rowOf.set(a.code, rr++);
  const kpi = (col: number, label: string, formula: string, fmt = CUR) => {
    ws.getCell(3, col).value = label;
    ws.getCell(3, col).font = { size: 9, bold: true };
    ws.getCell(3, col).alignment = { horizontal: 'right' };
    ws.getCell(3, col + 1).value = { formula } as any;
    ws.getCell(3, col + 1).font = { size: 11, bold: true };
    ws.getCell(3, col + 1).numFmt = fmt;
  };
  ws.getCell(3, 2).value = 'Units:';
  ws.getCell(3, 2).font = { size: 8, bold: true, color: { argb: 'FF505050' } };
  ws.getCell(3, 3).value = units;
  ws.getCell(3, 3).font = { size: 11, bold: true };
  const principalRows = ['3080', '3090', '3091'].map((c) => rowOf.get(c)).filter(Boolean) as number[];
  kpi(4, 'Total Income -', `R${rowOf.get('5500')}`);
  kpi(6, 'Total Expense -', `R${rowOf.get('7279')}`);
  kpi(8, 'NOI -', `R${rowOf.get('7280')}`);
  kpi(10, 'Interest -', `R${rowOf.get('7315')}`);
  kpi(12, 'Principal -', principalRows.length ? `ABS(${principalRows.map((r) => `R${r}`).join('+')})` : '0');
  kpi(14, 'Cash Flow -', 'I3-K3-M3');
  kpi(16, 'Cash on Cash -', 'IF($C$4>0,O3/$C$4,"")', PCT);
  ws.getCell(4, 2).value = 'Capital:';
  ws.getCell(4, 2).font = { size: 8, bold: true, color: { argb: 'FF505050' } };
  // capital lives on the Summary (D27 Capital Contributions) — single source
  // of truth, per Troy's edited draft
  ws.getCell(4, 3).value = { formula: `${SQ}D${S_CAP_ROW}` } as any;
  ws.getCell(4, 3).font = f8b;
  ws.getCell(4, 3).numFmt = CUR;
  // row 5: formula-colour legend (mirrors the app's fills)
  ws.getCell(5, 2).value = 'Fill = formula source:';
  ws.getCell(5, 2).font = { size: 7.5, italic: true, color: { argb: 'FF808080' } };
  Object.values(DRIVER_FILLS).forEach((d, i) => {
    const cell = ws.getCell(5, C.m1 + i);
    cell.value = d.label;
    cell.font = { size: 7 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: d.fill } };
    cell.alignment = { horizontal: 'center' };
  });

  // r6 column headers
  const heads: [number, string][] = [
    [C.code, 'GL Code'], [C.name, 'GL Name'], [C.notes, 'Notes'], [C.driver, 'Driver'],
    ...labels.map((m, i) => [C.m1 + i, m] as [number, string]),
    [C.annual, 'Total Year 1 Budget'], [C.uw, 'Year 1 UW Budget'],
    [C.comp, `Minot Budget at ${units} units`],
    [C.perUnit, 'Total Per Unit'], [C.perUnitMo, 'Per Unit / Month'], [C.note, 'Notes for Budget Upload'],
  ];
  for (const [col, text] of heads) {
    const cell = ws.getCell(6, col);
    cell.value = text;
    cell.font = f8b;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
    cell.border = { bottom: { style: 'thin' } };
    cell.alignment = { horizontal: col >= C.m1 ? 'right' : 'left', wrapText: col >= C.annual };
  }

  const GRAND_TOTALS = new Set(['5500', '7099', '7279', '7280', '8200', '9000']);
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
  const colL = (n: number): string => ws.getColumn(n).letter;

  for (const a of ordered) {
    const r = rowOf.get(a.code)!;
    const row = ws.getRow(r);
    row.font = a.kind === 'detail' ? f8 : f8b;
    ws.getCell(r, C.code).value = a.code;
    ws.getCell(r, C.code).font = { size: 8, color: { argb: 'FF808080' } };
    ws.getCell(r, C.name).value = (a.kind === 'detail' ? '    ' : a.kind === 'total' ? '  ' : ' ') + a.name;
    ws.getCell(r, C.name).font = a.kind === 'detail' ? f8 : f8b;

    if (a.kind === 'header') continue;

    if (a.kind === 'detail') {
      const ln = byGl.get(a.code);
      ws.getCell(r, C.driver).value = ln ? driverLabel(ln.driver) + (ln.override ? ' (manual)' : '') : '';
      ws.getCell(r, C.driver).font = { size: 7.5, italic: true, color: { argb: 'FF808080' } };
      const hasVals = ln && (ln.months.some((v) => v) || ln.override);
      const dFill = DRIVER_FILLS[driverKind(hasVals ? ln : undefined)].fill;
      (ln?.months || zero12()).forEach((v, i) => {
        const cell = ws.getCell(r, C.m1 + i);
        if (v) cell.value = v;
        cell.numFmt = CUR;
        cell.font = f8;
        if (hasVals) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dFill } };
      });
      if (ln?.note) {
        ws.getCell(r, C.note).value = ln.note;
        ws.getCell(r, C.note).font = { size: 8, italic: true, color: { argb: 'FF505050' } };
      }
      if (args.compWeights && args.compUnits && args.compWeights[a.code]) {
        const cc = ws.getCell(r, C.comp);
        cc.value = r2((args.compWeights[a.code] / args.compUnits) * units);
        cc.numFmt = ACCT; cc.font = f8;
        cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COMPFILL } };
      }
    } else {
      // total row: month formulas
      for (let i = 0; i < 12; i++) {
        const col = C.m1 + i;
        const L = colL(col);
        let formula = '';
        if (rangeTotals[a.code]) {
          const rows = detailRowsIn(...rangeTotals[a.code]);
          if (rows.length) formula = `SUM(${L}${Math.min(...rows)}:${L}${Math.max(...rows)})`;
        } else if (compositeTotals[a.code]) {
          formula = compositeTotals[a.code].map((p) => `${L}${rowOf.get(p)}`).join('+');
        } else if (a.code === '7280') formula = `${L}${rowOf.get('5500')}-${L}${rowOf.get('7279')}`;
        else if (a.code === '8200') formula = `${L}${rowOf.get('7280')}-${L}${rowOf.get('7315')}-${L}${rowOf.get('7500')}`;
        else if (a.code === '9000') formula = `${L}${rowOf.get('8200')}-${L}${rowOf.get('8602')}-${L}${rowOf.get('8950')}`;
        const cell = ws.getCell(r, col);
        if (formula) cell.value = { formula } as any;
        cell.numFmt = ACCT;
        cell.font = f8b;
        cell.border = { top: { style: 'thin' } };
        if (GRAND_TOTALS.has(a.code)) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAND } };
          cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
        }
      }
    }
    // annual + per-unit + UW on every non-header row
    const annual = ws.getCell(r, C.annual);
    annual.value = { formula: `SUM(${colL(C.m1)}${r}:${colL(C.m1 + 11)}${r})` } as any;
    annual.numFmt = a.kind === 'total' ? ACCT : CUR;
    annual.font = a.kind === 'total' ? f8b : f8;
    if (a.kind === 'total') annual.border = { top: { style: 'thin' } };
    if (GRAND_TOTALS.has(a.code)) {
      annual.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAND } };
      annual.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
    }
    const pu = ws.getCell(r, C.perUnit);
    pu.value = { formula: units ? `R${r}/$C$3` : `R${r}` } as any;
    pu.numFmt = PU; pu.font = a.kind === 'total' ? f8b : f8;
    const pum = ws.getCell(r, C.perUnitMo);
    pum.value = { formula: units ? `R${r}/$C$3/12` : `R${r}/12` } as any;
    pum.numFmt = PU; pum.font = a.kind === 'total' ? f8b : f8;
    if (uwCol[a.code] != null && uwCol[a.code] !== 0) {
      const uc = ws.getCell(r, C.uw);
      uc.value = uwCol[a.code];
      uc.numFmt = ACCT; uc.font = f8b;
      uc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: UWFILL } };
    }
  }

  /* ================= Summary sheet ================= */
  const wsS = wb.addWorksheet(`${prefix}Summary`, { properties: { tabColor: { argb: 'FF92D050' } }, views: [{ state: 'frozen', ySplit: 4 }] });
  [3, 34, 2, 15, 15, 13, 11, 13, 11.6].forEach((w, i) => { wsS.getColumn(i + 1).width = w; });
  wsS.getCell(1, 2).value = `${args.propertyName} Year 1 Budget Analysis (${labels[0]} – ${labels[11]})`;
  wsS.getCell(1, 2).font = { size: 12, bold: true };
  wsS.getCell(2, 7).value = 'Unit Count';
  wsS.getCell(2, 7).font = f8b;
  wsS.getCell(2, 8).value = units;
  wsS.getCell(2, 8).font = { size: 10, bold: true };
  const sHeads = ['', 'Account Summary', '', 'Year 1 UW Budget', 'Year 1 Budget', 'Δ vs UW', 'Per Unit', 'Per Unit / Month'];
  sHeads.forEach((t, i) => {
    if (!t) return;
    const cell = wsS.getCell(4, i + 1);
    cell.value = t;
    cell.font = { size: 8.5, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
    cell.border = { bottom: { style: 'thin' } };
    cell.alignment = { horizontal: i >= 3 ? 'right' : 'left' };
  });
  const sumRows: [string, string][] = [
    ['5004', 'TOTAL NET GROSS POTENTIAL RENT'],
    ['5070', 'TOTAL RENTAL INCOME'], ['5190', 'NET OTHER INCOME'], ['5500', 'TOTAL INCOME'],
    ['6170', 'TOTAL FIXED ADMINISTRATIVE'], ['6370', 'TOTAL ADMINISTRATIVE'], ['6399', 'TOTAL CORPORATE EVENTS'],
    ['6470', 'TOTAL PAYROLL'], ['6570', 'TOTAL MARKETING'], ['6670', 'TOTAL UTILITIES'],
    ['6770', 'TOTAL IN-HOUSE MAINT'], ['6870', 'TOTAL EXTERIOR/CAM'], ['6970', 'TOTAL CONTRACT SERVICES'],
    ['7070', 'TOTAL REHAB/REPLACEMENT'], ['7099', 'TOTAL OPERATING EXPENSES'], ['7280', 'NET OPERATING INCOME'],
  ];
  const uwSummary: Record<string, number> = uw ? {
    '5004': r2((uw.y1['1'] || 0) + (uw.y1['loss'] || 0)),
    '5070': r2((uw.y1['1'] || 0) + (uw.y1['loss'] || 0) + (uw.y1['2'] || 0) + (uw.y1['3'] || 0)),
    '5190': r2((uw.y1['4'] || 0) + (uw.y1['5'] || 0)), '5500': uw.egi,
    '6170': uwCol['6170'] || 0, '6370': uwCol['6370'] || 0, '6399': uwCol['6399'] || 0,
    '6470': uw.y1['10'] || 0, '6570': uw.y1['11'] || 0, '6670': uw.y1['12'] || 0,
    '6770': uwCol['6770'] || 0, '6870': uwCol['6870'] || 0, '6970': uwCol['6970'] || 0,
    '7070': uw.y1['14'] || 0, '7099': uw.toe, '7280': uw.noi,
  } : {};
  const BOLD_SUM = new Set(['5500', '7099', '7280']);
  let sr = 5;
  for (const [code, label] of sumRows) {
    const bold = BOLD_SUM.has(code);
    const font = { size: 8.5, bold };
    wsS.getCell(sr, 1).value = code;
    wsS.getCell(sr, 1).font = { size: 8, color: { argb: 'FF808080' } };
    wsS.getCell(sr, 2).value = label;
    wsS.getCell(sr, 2).font = font;
    if (uw) { wsS.getCell(sr, 4).value = uwSummary[code]; }
    wsS.getCell(sr, 5).value = { formula: `${BQ}R${rowOf.get(code)}` } as any;
    wsS.getCell(sr, 6).value = { formula: `E${sr}-D${sr}` } as any;
    wsS.getCell(sr, 7).value = { formula: `E${sr}/$H$2` } as any;
    wsS.getCell(sr, 8).value = { formula: `E${sr}/$H$2/12` } as any;
    for (const c2 of [4, 5, 6]) { const cell = wsS.getCell(sr, c2); cell.numFmt = ACCT; cell.font = font; }
    for (const c2 of [7, 8]) { const cell = wsS.getCell(sr, c2); cell.numFmt = PU; cell.font = font; }
    if (bold) for (let c2 = 1; c2 <= 8; c2++) wsS.getCell(sr, c2).border = { top: { style: 'thin' } };
    sr++;
  }
  sr++;
  const debtRows: [string, string | null][] = [
    ['Interest Expense', `${BQ}R${rowOf.get('7315')}`],
    ['Principal', principalRows.length ? `ABS(${principalRows.map((r) => `${BQ}R${r}`).join('+')})` : '0'],
    ['Special Projects', `${BQ}R${rowOf.get('7500')}`],
    ['Cash Flow (NOI − debt service)', null],
  ];
  const noiRowS = 5 + sumRows.length - 1;
  const debtStart = sr;
  for (const [label, formula] of debtRows) {
    wsS.getCell(sr, 2).value = label;
    wsS.getCell(sr, 2).font = { size: 8.5 };
    const cell = wsS.getCell(sr, 5);
    cell.value = { formula: formula || `E${noiRowS}-E${debtStart}-E${debtStart + 1}` } as any;
    cell.numFmt = ACCT;
    cell.font = label.startsWith('Cash Flow') ? { size: 8.5, bold: true } : { size: 8.5 };
    sr++;
  }
  // capital + Y1 CoC beside it (Troy's draft: bold red, "Y1 CoC" tag)
  wsS.getCell(S_CAP_ROW, 2).value = 'Capital Contributions';
  wsS.getCell(S_CAP_ROW, 2).font = { size: 8.5 };
  wsS.getCell(S_CAP_ROW, 4).value = inputs.capital || 0;
  wsS.getCell(S_CAP_ROW, 4).numFmt = CUR;
  wsS.getCell(S_CAP_ROW, 5).value = { formula: `IF(D${S_CAP_ROW}>0,E${S_CASH_ROW}/D${S_CAP_ROW},"")` } as any;
  wsS.getCell(S_CAP_ROW, 5).numFmt = PCT;
  wsS.getCell(S_CAP_ROW, 5).font = { size: 11, bold: true, color: { argb: RED } };
  wsS.getCell(S_CAP_ROW, 6).value = 'Y1 CoC';
  wsS.getCell(S_CAP_ROW, 6).font = { size: 11, bold: true, color: { argb: RED } };

  /* monthly Cash-on-Cash table (Troy's draft): M1..M12 with NOI / Interest /
     Cash Flow / Return % / Running, calendar-year markers in col I, a medium
     border at the calendar-year break and a double border under M12. */
  const startM = inputs.startMonth || 1;
  const monthsInYr1 = startM > 1 ? 13 - startM : 12;
  const th = (col: number, t: string) => { const c2 = wsS.getCell(S_TABLE_HEAD, col); c2.value = t; c2.font = { bold: true }; };
  wsS.getCell(S_TABLE_HEAD, 2).value = 'Cash on Cash Return';
  wsS.getCell(S_TABLE_HEAD, 2).font = { size: 8.5, bold: true };
  th(4, 'NOI'); th(5, 'Interest'); th(6, 'Cash Flow'); th(7, 'Return %'); th(8, 'Running');
  const noiRow = rowOf.get('7280')!;
  const intRow = rowOf.get('7315')!;
  for (let i = 0; i < 12; i++) {
    const r = S_M1 + i;
    const mCol = colL(C.m1 + i);   // Budget-sheet month column letter
    wsS.getCell(r, 2).value = `M${i + 1}`;
    wsS.getCell(r, 2).font = { size: 8.5 };
    wsS.getCell(r, 4).value = { formula: `${BQ}${mCol}${noiRow}` } as any;
    wsS.getCell(r, 5).value = { formula: `${BQ}${mCol}${intRow}` } as any;
    wsS.getCell(r, 6).value = { formula: `D${r}-E${r}` } as any;
    wsS.getCell(r, 7).value = { formula: `F${r}/$D$${S_CAP_ROW}` } as any;
    wsS.getCell(r, 8).value = { formula: i === 0 ? `G${r}` : `G${r}+H${r - 1}` } as any;
    for (const c2 of [4, 5, 6]) wsS.getCell(r, c2).numFmt = CURC;
    for (const c2 of [7, 8]) wsS.getCell(r, c2).numFmt = PCT;
    // calendar-year markers
    if (i === 0) { wsS.getCell(r, 9).value = args.year; }
    if (startM > 1 && i === monthsInYr1) { wsS.getCell(r, 9).value = args.year + 1; }
    // borders: medium above M1, medium below the year break, double below M12
    const bd: any = {};
    if (i === 0) bd.top = { style: 'medium' };
    if (startM > 1 && i === monthsInYr1 - 1) bd.bottom = { style: 'medium' };
    if (i === 11) bd.bottom = { style: 'double' };
    if (bd.top || bd.bottom) for (let c2 = 2; c2 <= 8; c2++) wsS.getCell(r, c2).border = bd;
  }
  wsS.getCell(S_FOOT, 7).value = { formula: `SUM(G${S_M1}:G${S_M1 + 11})` } as any;
  wsS.getCell(S_FOOT, 7).numFmt = PCT;
  wsS.getCell(S_FOOT, 7).font = { size: 11, bold: true, color: { argb: RED } };
  wsS.getCell(S_FOOT, 8).value = 'Y1 CoC';
  wsS.getCell(S_FOOT, 8).font = { size: 11, bold: true, color: { argb: RED } };
  wsS.getCell(S_FOOT, 8).border = { bottom: { style: 'medium' } };

  /* ================= Raw Data sheet ================= */
  const wsR = wb.addWorksheet(`${prefix}Raw Data`);
  [26, 42, 12, 60].forEach((w, i) => { wsR.getColumn(i + 1).width = w; });
  let rrw = 1;
  const rawRow = (vals: any[], bold = false) => {
    vals.forEach((v, i) => { const cell = wsR.getCell(rrw, i + 1); cell.value = v; cell.font = { size: 8.5, bold }; });
    rrw++;
  };
  rawRow(['Generated inputs (budgets.inputs)'], true);
  rawRow(['key', 'value'], true);
  const flat = (obj: any, prefix = ''): void => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, `${prefix}${k}.`);
      else rawRow([`${prefix}${k}`, Array.isArray(v) ? (v as any[]).join(', ') : (v as any)]);
    }
  };
  flat(inputs);
  rrw++;
  rawRow(['UW Year-1 by category (tie-out targets)'], true);
  rawRow(['pcode', 'label', 'UW Y1'], true);
  if (uw) {
    for (const p of PCODES) rawRow([p, PCODE_LABELS[p], uw.y1[p] ?? '']);
    rawRow(['', 'EGI', uw.egi]); rawRow(['', 'TOE', uw.toe]); rawRow(['', 'NOI', uw.noi]);
  }
  rrw++;
  rawRow([`Comp set${args.compName ? `: ${args.compName}` : ''} (annual $, ${args.compUnits || '?'} units)`], true);
  rawRow(['gl', 'comp annual $', 'comp $/unit', `scaled to ${units} units`], true);
  if (args.compWeights && args.compUnits) {
    for (const [gl, v] of Object.entries(args.compWeights)) {
      if (!v) continue;
      rawRow([gl, v, r2(v / args.compUnits), r2((v / args.compUnits) * units)]);
    }
  }
  rrw++;
  rawRow(['Budget lines (raw)'], true);
  rawRow(['gl', 'annual', 'override', 'driver json'], true);
  for (const l of lines) {
    const t = sum(l.months);
    if (t || l.override) rawRow([l.gl_code, t, l.override ? 'Y' : '', JSON.stringify(l.driver)]);
  }
}
