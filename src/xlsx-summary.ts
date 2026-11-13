/* The budget-comps summary in the Excel exports (Troy 2026-11-10: "What that summary REALLY
   needs to be in is the exports… I need the section I screenshotted to be in each workbook per
   property… Conditional formatting is COMPLETELY missing").

   Two sheets, both copied cell-for-cell from Troy's "Minot 2025 Budget Comps" workbook:
     - the PANEL (its per-property sheets / "Minot Avg."): T12 | T4 annualized | this budget, the
       GR% Over T12 column and the growth notes on the right — fills, bold labels, medium
       outline, double rules, accounting formats;
     - the SCHEDULE: one row per property with the NOI trend and growth columns, an Average row,
       and the workbook's 3-colour scale (green low, yellow median, red high) on every growth
       column.
   Every figure is a live formula with its cached result (org rule: show the work): the panel
   reads the property's own Budget sheet and a small input block on its Raw Data sheet; the
   portfolio panel adds the property panels; the Schedule reads the panels. */
import ExcelJS from 'exceljs';
import type { SummaryCol } from '../shared/annual.js';

const BLUE = 'FFDDEBF7';    // T12 column / growth over T12  (Office "Blue, Accent 5, Lighter 80%")
const GREEN = 'FFE2EFDA';   // T4 column / growth over T4   (Office "Green, Accent 6, Lighter 80%")
const ACCT = '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"??_);_(@_)';
const PCT1 = '0.0%';
const PCT2 = '0.00%';
const MED = { style: 'medium' } as const;
const DBL = { style: 'double' } as const;
const THIN = { style: 'thin' } as const;
const solid = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } }) as ExcelJS.Fill;

/** Where each summary row sits on the panel sheet (the workbook's own row numbers). */
export const PANEL_ROW = {
  capital: 5, units: 6, rental: 8, other: 9, income: 10, fixedLess: 12, tax: 13, fee: 14, admin: 15, payroll: 16, marketing: 17,
  utilities: 18, inHouse: 19, exterior: 20, contract: 21, rehab: 22, expense: 23, noi: 26, interest: 28, mtg1: 29, mtg2: 30, cashFlow: 32, ret: 34,
} as const;
type Key = keyof typeof PANEL_ROW;
type ColL = 'C' | 'D' | 'E';

export interface PanelSpec {
  title: string;
  /** how the T12 column was built (spec 1.5), printed under the title */
  basis?: string;
  labels: { t12: string; t4: string; draft: string };
  capital: number; units: number;
  /** cached results */
  t12: SummaryCol | null; t4: SummaryCol | null; bud: SummaryCol | null;
  /** the formula (no leading "=") behind an INPUT cell — null writes the cached value itself */
  src: (col: ColL, key: Key) => string | null;
}

const LINES: { r: number; code?: number; label: string; key: Key }[] = [
  { r: 8, code: 5070, label: 'Total Rental Income', key: 'rental' },
  { r: 9, code: 5190, label: 'Total Other Income', key: 'other' },
  { r: 12, code: 6170, label: 'Fixed Admin Less RE TAXES & MGMT FEE', key: 'fixedLess' },
  { r: 13, code: 6116, label: '     Real Estate Taxes', key: 'tax' },
  { r: 14, code: 6112, label: '     Management Fee', key: 'fee' },
  { r: 15, code: 6370, label: 'Admin', key: 'admin' },
  { r: 16, code: 6470, label: 'Payroll', key: 'payroll' },
  { r: 17, code: 6570, label: 'Marketing', key: 'marketing' },
  { r: 18, code: 6670, label: 'Utilities', key: 'utilities' },
  { r: 19, code: 6770, label: 'In-House', key: 'inHouse' },
  { r: 20, code: 6870, label: 'Exterior / CAM', key: 'exterior' },
  { r: 21, code: 6970, label: 'Contract Services', key: 'contract' },
  { r: 22, code: 7070, label: 'Rehab / Replace', key: 'rehab' },
];

export function fillSummaryPanel(ws: ExcelJS.Worksheet, spec: PanelSpec): void {
  ws.views = [{ state: 'normal', showGridLines: false, zoomScale: 90 }];
  [8.71, 35.14, 19.43, 18.57, 18.57, 11.57, 41.71].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const cols: Record<ColL, SummaryCol | null> = { C: spec.t12, D: spec.t4, E: spec.bud };
  const val = (c: ColL, k: Key): number | null => {
    if (k === 'capital') return spec.capital || null;
    if (k === 'units') return spec.units || null;
    const col = cols[c];
    if (!col) return null;
    if (k === 'ret') return spec.capital ? col.cashFlow / spec.capital : null;
    return (col as any)[k] ?? null;
  };
  const put = (addr: string, formula: string | null, result: number | string | null, numFmt?: string) => {
    const cell = ws.getCell(addr);
    if (formula) cell.value = { formula, result: result == null ? '' : result } as any;
    else if (result != null) cell.value = result as any;
    if (numFmt) cell.numFmt = numFmt;
    return cell;
  };
  const bold = { bold: true, name: 'Calibri', size: 11 };
  const gr = (a: number | null, b: number | null): number | string => (a != null && b ? (a - b) / b : '');

  // title + headers
  ws.getRow(1).height = 26.25;
  ws.getCell('B1').value = spec.title; ws.getCell('B1').font = { bold: true, size: 20, name: 'Calibri' };
  // how the T12 column was built (spec 1.5)
  if (spec.basis) { ws.getCell('B2').value = spec.basis; ws.getCell('B2').font = { italic: true, size: 9, name: 'Calibri', color: { argb: 'FF505050' } }; }
  ws.getRow(3).height = 45.75;
  const H: [string, string, 'center' | 'left'][] = [['C3', spec.labels.t12, 'center'], ['D3', spec.labels.t4, 'left'], ['E3', spec.labels.draft, 'center']];
  for (const [a, text, al] of H) { const c = ws.getCell(a); c.value = text; c.font = bold; c.alignment = { horizontal: al, wrapText: true }; }

  // the three-column outline: C left, D right, E right — rows 3..34
  for (let r = 3; r <= 34; r++) {
    ws.getCell(`C${r}`).border = { left: MED, ...(r === 3 ? { top: MED } : {}), ...(r === 34 ? { bottom: MED } : {}) };
    ws.getCell(`D${r}`).border = { right: MED, ...(r === 3 ? { top: MED } : {}), ...(r === 34 ? { bottom: MED } : {}) };
    ws.getCell(`E${r}`).border = { right: MED, ...(r === 3 ? { top: MED } : {}), ...(r === 34 ? { bottom: MED } : {}) };
  }
  const addBorder = (addr: string, b: Partial<ExcelJS.Borders>) => { const c = ws.getCell(addr); c.border = { ...(c.border || {}), ...b }; };

  // capital / units
  ws.getCell('B5').value = 'Capital Contributed'; ws.getCell('B5').font = bold;
  ws.getCell('B6').value = 'Unit Count'; ws.getCell('B6').font = bold;
  for (const c of ['C', 'D', 'E'] as ColL[]) {
    put(`${c}5`, spec.src(c, 'capital'), val(c, 'capital'), ACCT);
    put(`${c}6`, spec.src(c, 'units'), val(c, 'units'), '#,##0');
  }

  // GR% Over T12 header (F6:F7 merged)
  ws.mergeCells('F6:F7');
  const fh = ws.getCell('F6'); fh.value = 'GR% Over T12'; fh.font = bold; fh.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  fh.border = { top: MED, right: MED, bottom: MED };

  // the data rows: T12 on light blue, T4 on light green, the draft plain
  const fPct = (r: number) => put(`F${r}`, `IF(C${r}<>0,(E${r}-C${r})/C${r},"")`, gr(val('E', keyAt(r)), val('C', keyAt(r))), PCT1);
  const keyAt = (r: number): Key => (Object.entries(PANEL_ROW).find(([, v]) => v === r)![0]) as Key;
  for (const L of LINES) {
    ws.getCell(`A${L.r}`).value = L.code!;
    const b = ws.getCell(`B${L.r}`); b.value = L.label; b.font = bold;
    put(`C${L.r}`, spec.src('C', L.key), val('C', L.key), ACCT).fill = solid(BLUE);
    put(`D${L.r}`, spec.src('D', L.key), val('D', L.key), ACCT).fill = solid(GREEN);
    put(`E${L.r}`, spec.src('E', L.key), val('E', L.key), ACCT);
    const f = fPct(L.r); f.fill = solid(BLUE); f.alignment = { horizontal: 'center' };
  }
  // totals (no fill)
  const total = (r: number, label: string, key: Key, fC: string, fD: string, fE: string) => {
    const b = ws.getCell(`B${r}`); b.value = label; b.font = bold;
    put(`C${r}`, fC, val('C', key), ACCT); put(`D${r}`, fD, val('D', key), ACCT); put(`E${r}`, fE, val('E', key), ACCT);
    const f = fPct(r); f.fill = solid(BLUE); f.alignment = { horizontal: 'center' };
  };
  total(10, 'Total Income', 'income', '+C9+C8', '+D9+D8', '+SUM(E8:E9)');
  total(23, 'Total Expense ', 'expense', 'SUM(C12:C22)', 'SUM(D12:D22)', 'SUM(E12:E22)');
  total(26, 'NOI', 'noi', 'C10-C23', '+D10-D23', 'E10-E23');
  total(32, 'Cash Flow', 'cashFlow', 'C26-C28+C29+C30', 'D26-D28+D29+D30', 'E26-E28+E29+E30');
  // debt rows: T12 and T4 both on blue, no growth
  const debt = (r: number, code: number, label: string, key: Key) => {
    ws.getCell(`A${r}`).value = code;
    const b = ws.getCell(`B${r}`); b.value = label; b.font = bold;
    put(`C${r}`, spec.src('C', key), val('C', key) ?? 0, ACCT).fill = solid(BLUE);
    put(`D${r}`, spec.src('D', key), val('D', key) ?? 0, ACCT).fill = solid(BLUE);
    put(`E${r}`, spec.src('E', key), val('E', key) ?? 0, ACCT);
  };
  debt(28, 7300, 'Int Expense', 'interest');
  debt(29, 3080, '1st MTGE', 'mtg1');
  debt(30, 3090, '2nd MTGE', 'mtg2');
  // Return
  const rb = ws.getCell('B34'); rb.value = 'Return'; rb.font = bold;
  for (const c of ['C', 'D', 'E'] as ColL[]) { const x = put(`${c}34`, `IF(${c}5<>0,${c}32/${c}5,"")`, val(c, 'ret') ?? '', PCT2); x.font = bold; }

  // double rules: under Total Other Income and Rehab / Replace; over Total Expense
  for (const c of ['C', 'D', 'E']) { addBorder(`${c}9`, { bottom: DBL }); addBorder(`${c}22`, { bottom: DBL }); }
  addBorder('C23', { top: DBL }); addBorder('D23', { top: DBL });

  // the GR% column's outline, as in the workbook
  addBorder('F8', { top: MED, right: MED }); addBorder('F9', { bottom: MED, right: MED }); addBorder('F10', { top: MED, bottom: MED, right: MED });
  addBorder('F12', { top: MED, left: MED, right: MED });
  for (let r = 13; r <= 21; r++) addBorder(`F${r}`, { left: MED, right: MED });
  addBorder('F22', { bottom: MED, left: MED, right: MED });
  for (const r of [23, 26, 32]) addBorder(`F${r}`, { top: MED, bottom: MED, right: MED });

  // the growth notes down column G: a label, and its figure on the row below
  const C = spec.t12, D = spec.t4, E = spec.bud;
  const maint = (c: SummaryCol) => c.inHouse + c.exterior + c.contract + c.rehab;
  const note = (lr: number, text: string, vr: number, formula: string, result: number | string, fill: string, fmt = PCT1, center = false) => {
    const l = ws.getCell(`G${lr}`); l.value = text; l.border = { top: MED, left: MED, right: MED }; if (center) l.alignment = { horizontal: 'center' };
    const v = put(`G${vr}`, formula, result, fmt); v.fill = solid(fill); v.alignment = { horizontal: 'center' }; v.border = { bottom: MED, left: MED, right: MED };
  };
  note(7, 'Rental Income Growth over T4', 8, 'IF(D8<>0,(E8-D8)/D8,"")', E && D ? gr(E.rental, D.rental) : '', GREEN);
  note(9, 'Total Income Growth over T4', 10, 'IF(D10<>0,(E10-D10)/D10,"")', E && D ? gr(E.income, D.income) : '', GREEN);
  note(15, 'Payroll Growth over T4', 16, 'IF(D16<>0,(E16-D16)/D16,"")', E && D ? gr(E.payroll, D.payroll) : '', GREEN, PCT1, true);
  note(18, 'Maintenance Expense Growth over T4', 19, 'IF(SUM(D19:D22)<>0,(SUM(E19:E22)-SUM(D19:D22))/(SUM(D19:D22)),"")', E && D ? gr(maint(E), maint(D)) : '', GREEN, PCT1, true);
  note(22, 'Total Expense Growth net of MGMT and RE Tax', 23, 'IF(C23<>0,((E23-(E13-C13+E14-C14))-C23)/C23,"")', E && C && C.expense ? ((E.expense - (E.tax - C.tax + E.fee - C.fee)) - C.expense) / C.expense : '', GREEN, PCT1, true);
  note(25, 'Total NOI Growth over T4', 26, 'IF(D26<>0,(E26-D26)/D26,"")', E && D ? gr(E.noi, D.noi) : '', GREEN);
  note(31, 'NOI Growth Excluding RE Tax (T4)', 32, 'IF((D26+(D13-E13))<>0,(E26-(D26+(D13-E13)))/(D26+(D13-E13)),"")', E && D && (D.noi + (D.tax - E.tax)) ? (E.noi - (D.noi + (D.tax - E.tax))) / (D.noi + (D.tax - E.tax)) : '', GREEN);
  note(33, 'NOI Growth Excluding RE Tax & MGMT FEE (T12)', 34, 'IF(C26<>0,((E26+(E13-C13+E14-C14))-C26)/C26,"")', E && C && C.noi ? ((E.noi + (E.tax - C.tax + E.fee - C.fee)) - C.noi) / C.noi : '', BLUE, PCT2);
}

/* ---------------- the Schedule ---------------- */
export interface ScheduleRow {
  code: string; units: number;
  /** the property's panel sheet name (quoted reference built here) */
  sheet: string;
  /** NOI of the trailing-12 windows on file, oldest first (null = not on file) */
  trend: (number | null)[];
  noi: number | null; cyBudgetNoi: number | null; t4Income: number | null; budIncome: number | null;
  taxInc: number | null; feeInc: number | null;
  /** Raw Data cells holding the current-year budget NOI and each trend window's NOI (quoted references) */
  cyRef?: string | null; trendRefs?: (string | null)[];
}
/** One Schedule block (a region, or the whole portfolio) starting at `top`; returns the next free row. */
export function fillSchedule(ws: ExcelJS.Worksheet, top: number, heading: string, year: number, trendLabels: string[], cyHead: string, rows: ScheduleRow[]): number {
  const win = trendLabels.map((_, i) => i).filter((i) => rows.some((r) => r.trend[i] != null));
  // columns: B units, C property, then trend…, NOI budget, growth…, over budget, income over T4, RE tax inc, fee inc, adjusted…
  let c = 2;
  const col = { units: c++, prop: c++, trend: win.map(() => c++), noi: c++, g: win.map(() => c++), overBud: c++, incT4: c++, tax: c++, fee: c++, adj: win.map(() => c++) };
  const L = (n: number) => ws.getColumn(n).letter;
  ws.getColumn(1).width = 1.14;
  for (let i = 2; i < c; i++) ws.getColumn(i).width = i === col.prop ? 10.86 : 13.6;
  ws.getColumn(col.tax).hidden = true; ws.getColumn(col.fee).hidden = true;      // hidden in the workbook too; the adjusted growth reads them
  ws.getCell(top, 2).value = heading; ws.getCell(top, 2).font = { bold: true, size: 14, name: 'Calibri' };
  const hr = top + 1;
  ws.getRow(hr).height = 77.1;
  const head = (n: number, text: string) => {
    const cell = ws.getCell(hr, n); cell.value = text; cell.font = { bold: true, name: 'Calibri', size: 11 };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { top: MED, bottom: THIN, left: n === 2 ? MED : THIN, right: n === c - 1 ? MED : THIN };
  };
  head(col.units, 'Unit count'); head(col.prop, 'Property');
  win.forEach((i, k) => head(col.trend[k], `${trendLabels[i]} T12 NOI Trend`));
  head(col.noi, `${year} NOI Budget`);
  win.forEach((i, k) => head(col.g[k], `${trendLabels[i]} T12 NOI Growth`));
  head(col.overBud, cyHead); head(col.incT4, 'Income Growth over T4'); head(col.tax, 'RE Tax Increase'); head(col.fee, 'MGMT Fee Increase');
  win.forEach((i, k) => head(col.adj[k], `NOI Increase Tax and MGMT Fee Adjusted ${trendLabels[i]} T12`));

  const first = hr + 1, last = hr + rows.length;
  const cellAt = (r: number, n: number, value: any, fmt: string, bottom: Partial<ExcelJS.Border> = THIN) => {
    const cell = ws.getCell(r, n);
    cell.value = value; cell.numFmt = fmt; cell.alignment = { horizontal: 'center' };
    cell.border = { top: THIN, bottom, left: n === 2 ? MED : THIN, right: n === c - 1 ? MED : THIN };
    return cell;
  };
  const f = (formula: string, result: number | string | null) => ({ formula, result: result == null ? '' : result });
  rows.forEach((r, i) => {
    const row = first + i;
    const bottom = i === rows.length - 1 ? DBL : THIN;
    const Q = `'${r.sheet.replace(/'/g, "''")}'!`;
    cellAt(row, col.units, f(`+${Q}E6`, r.units), '#,##0', THIN);
    cellAt(row, col.prop, r.code.toUpperCase(), '@', bottom).fill = solid(GREEN);
    win.forEach((w, k) => {
      // the latest window is the panel's own T12 NOI; earlier windows are values from the statements on file
      const isLatest = w === trendLabels.length - 1;
      const tRef = (r.trendRefs || [])[w];
      cellAt(row, col.trend[k], isLatest && r.trend[w] != null ? f(`+${Q}C26`, r.trend[w]) : tRef ? f(`+${tRef}`, r.trend[w]) : r.trend[w], '#,##0', bottom);
    });
    cellAt(row, col.noi, f(`+${Q}E26`, r.noi), '#,##0', bottom);
    const N = `${L(col.noi)}${row}`;
    win.forEach((w, k) => { const T = `${L(col.trend[k])}${row}`; cellAt(row, col.g[k], f(`IFERROR((${N}-${T})/${T},"")`, r.trend[w] && r.noi != null ? (r.noi - r.trend[w]!) / r.trend[w]! : ''), PCT2, bottom); });
    const ob = r.cyBudgetNoi && r.noi != null ? (r.noi - r.cyBudgetNoi) / r.cyBudgetNoi : '';
    cellAt(row, col.overBud, r.cyRef ? f(`IFERROR((${N}-${r.cyRef})/${r.cyRef},"")`, ob) : ob, PCT2, bottom);
    cellAt(row, col.incT4, f(`IFERROR(${Q}G10,"")`, r.t4Income && r.budIncome != null ? (r.budIncome - r.t4Income) / r.t4Income : ''), PCT2, bottom);
    cellAt(row, col.tax, f(`+${Q}E13-${Q}C13`, r.taxInc), '#,##0', bottom);
    cellAt(row, col.fee, f(`+${Q}E14-${Q}C14`, r.feeInc), '#,##0', bottom);
    win.forEach((w, k) => {
      const T = `${L(col.trend[k])}${row}`;
      const res = r.trend[w] && r.noi != null && r.taxInc != null ? ((r.noi + r.taxInc + (r.feeInc || 0)) - r.trend[w]!) / r.trend[w]! : '';
      cellAt(row, col.adj[k], f(`IFERROR(((${N}+${L(col.tax)}${row}+${L(col.fee)}${row})-${T})/${T},"")`, res), PCT2, bottom);
    });
  });
  // Average row: sums for dollars, growth on the sums, averages for the two single-column growths
  const ar = last + 1;
  const rng = (n: number) => `${L(n)}${first}:${L(n)}${last}`;
  const sumRes = (g: (r: ScheduleRow) => number | null) => rows.reduce((a, r) => a + (g(r) || 0), 0);
  const avgRes = (g: (r: ScheduleRow) => number | null) => { const v = rows.map(g).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : ''; };
  cellAt(ar, col.units, f(`SUM(${rng(col.units)})`, sumRes((r) => r.units)), '#,##0', MED);
  cellAt(ar, col.prop, 'Average', '@', MED);
  const NOI = sumRes((r) => r.noi);
  win.forEach((w, k) => cellAt(ar, col.trend[k], f(`SUM(${rng(col.trend[k])})`, sumRes((r) => r.trend[w])), '#,##0', MED));
  cellAt(ar, col.noi, f(`SUM(${rng(col.noi)})`, NOI), '#,##0', MED);
  win.forEach((w, k) => {
    // only the properties that have this window count toward its growth
    const has = rows.filter((r) => r.trend[w] != null && r.noi != null);
    const T = has.reduce((a, r) => a + r.trend[w]!, 0), N2 = has.reduce((a, r) => a + r.noi!, 0);
    const tc = rng(col.trend[k]), nc = rng(col.noi);
    cellAt(ar, col.g[k], f(`IFERROR((SUMIF(${tc},"<>",${nc})-SUM(${tc}))/SUM(${tc}),"")`, T ? (N2 - T) / T : ''), PCT2, MED);
    const X = has.reduce((a, r) => a + (r.taxInc || 0) + (r.feeInc || 0), 0);
    cellAt(ar, col.adj[k], f(`IFERROR(((SUMIF(${tc},"<>",${nc})+SUMIF(${tc},"<>",${rng(col.tax)})+SUMIF(${tc},"<>",${rng(col.fee)}))-SUM(${tc}))/SUM(${tc}),"")`, T ? ((N2 + X) - T) / T : ''), PCT2, MED);
  });
  cellAt(ar, col.overBud, f(`IFERROR(AVERAGE(${rng(col.overBud)}),"")`, avgRes((r) => (r.cyBudgetNoi && r.noi != null ? (r.noi - r.cyBudgetNoi) / r.cyBudgetNoi : null))), PCT2, MED);
  cellAt(ar, col.incT4, f(`IFERROR(AVERAGE(${rng(col.incT4)}),"")`, avgRes((r) => (r.t4Income && r.budIncome != null ? (r.budIncome - r.t4Income) / r.t4Income : null))), PCT2, MED);
  cellAt(ar, col.tax, f(`SUM(${rng(col.tax)})`, sumRes((r) => r.taxInc)), '#,##0', MED);
  cellAt(ar, col.fee, f(`SUM(${rng(col.fee)})`, sumRes((r) => r.feeInc)), '#,##0', MED);

  // the workbook's conditional formatting: a 3-colour scale down each growth column, property rows only —
  // lowest green, the median yellow, highest red
  if (rows.length > 1) {
    for (const n of [...col.g, col.overBud, col.incT4, ...col.adj]) {
      ws.addConditionalFormatting({
        ref: rng(n),
        rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }], color: [{ argb: 'FF63BE7B' }, { argb: 'FFFFEB84' }, { argb: 'FFF8696B' }] } as any],
      });
    }
  }
  return ar + 3;
}
