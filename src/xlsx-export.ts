/* Excel review workbook — styled to match the FHND/PHND budget workbook that
   everyone reads: 8pt grid, $-currency red-negative detail cells with the
   light-green input fill, bold accounting-format section totals with thin top
   borders, the row-3 KPI strip (9pt labels / 11pt values), frozen panes at the
   header, light-blue tab. Built with ExcelJS (SheetJS can't write styles).
   Sheets: Budget (PHNDBudget-style), Summary (SummaryPHND-style), Raw Data
   (org rule: show the work — formulas + raw inputs). */
import ExcelJS from 'exceljs';
import { summaryColumn, sumSummaryCols, applyT12Adjust, type SummaryCol } from '../shared/annual.js';
import { fillSummaryPanel, fillSchedule, PANEL_ROW, type ScheduleRow } from './xlsx-summary.js';
import { fillCachedResults, type CachedDiff } from './xlsx-calc.js';
import {
  CoaAccount, BudgetLine, UwSnapshotData, BudgetInputs, PCODES, PCODE_LABELS,
  sum, zero12, r2, Months, monthLabels, WAGE_GLS, rotate12, rollup,
} from '../shared/domain.js';

/* Budget-sheet columns (1-based), laid out like the FHND workbook: A code, B name, C notes (how the line is
   built), D increase factor (the input its month formulas read), E..P months (5..16), Q spacer, R annual,
   S spacer, T UW / T12, U comp / CY budget, V/W spacers, X $/unit, Y $/unit/mo, Z upload note */
const C = { code: 1, name: 2, notes: 3, factor: 4, m1: 5, annual: 18, uw: 20, comp: 21, perUnit: 24, perUnitMo: 25, note: 26 };
const INPUT_FONT = { size: 8, color: { argb: 'FF0000FF' } };   // org rule: blue font = an input

/* MONTH FORMULAS THAT SHOW THE MATH (Troy 2026-11-18: "the cell references to the hard coded values make it hard for
   anyone to adjust to understand what is happening. that tab is a reference point, so should be hidden and not
   referenced"). A month cell is written as the line's own arithmetic on this workbook's visible cells (the T12 sheet,
   the increase factor in column D, the income row, units in C3) — never a link to the Formulas sheet. Every such
   formula is worked out before the file is written and kept ONLY if it reproduces the tool's number to the cent;
   otherwise the cell gets the tool's number as a plain value (column C says how it was built). */
interface MonthCand { ws: ExcelJS.Worksheet; row: number; col: number; engine: number }
const candByWorkbook = new WeakMap<ExcelJS.Workbook, MonthCand[]>();
function settleMonthFormulas(wb: ExcelJS.Workbook): { kept: number; values: number } {
  const cands = candByWorkbook.get(wb) || [];
  if (!cands.length) return { kept: 0, values: 0 };
  // each formula is worked out on the tool's numbers for every other month cell it reads (pinned), so one line
  // falling back to a value never knocks out the lines built on it (the fee on income)
  const pinned = new Map<string, number>(cands.map((c) => [`${c.ws.name}!${c.row},${c.col}`, c.engine]));
  const bad = new Set<string>();
  fillCachedResults(wb, { recompute: true, pinned, onDiff: (d) => bad.add(`${d.sheet}!${d.cell}`) });
  const keptRows = new Map<ExcelJS.Worksheet, Set<number>>();
  let values = 0;
  for (const c of cands) {
    const cell = c.ws.getCell(c.row, c.col);
    const v: any = cell.value;
    const res = v && typeof v === 'object' ? (cell as any).model?.result : undefined;
    const off = bad.has(`${c.ws.name}!${cell.address}`) || typeof res !== 'number' || Math.abs(res - c.engine) > 0.005;
    if (off) { cell.value = c.engine; values++; continue; }
    if (!keptRows.has(c.ws)) keptRows.set(c.ws, new Set());
    keptRows.get(c.ws)!.add(c.row);
  }
  // an increase factor no month formula reads any more is not an input: clear it
  const rowsWithFactor = new Map<ExcelJS.Worksheet, Set<number>>();
  for (const c of cands) { if (!rowsWithFactor.has(c.ws)) rowsWithFactor.set(c.ws, new Set()); rowsWithFactor.get(c.ws)!.add(c.row); }
  for (const [ws, rows] of rowsWithFactor) for (const r of rows) {
    if (keptRows.get(ws)?.has(r)) continue;
    const f = ws.getCell(r, C.factor);
    f.value = null; f.font = { size: 8 }; f.numFmt = 'General';
  }
  return { kept: cands.length - values, values };
}

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
  base: { fill: 'FFE8ECF9', label: 'Own T12 × factor (template)' },
  corp: { fill: 'FFFFF4D6', label: 'Corporate rate / suggestion' },
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
    case 'baseline': case 'pctGpr': case 'recapture': case 'perTurn': return 'base';
    case 'suggested': case 'corpRate': case 'contract': return 'corp';
    case 'debtService': return 'int';
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

/** Hard-coded numbers: bold, in a colour no fill or other font uses (matches the app). */
const HARD_FONT = { size: 8, bold: true, color: { argb: 'FFC2185B' } };
/** Is month i of this line hard-coded? Typed cells when the line recorded them, else every non-zero month of a hand-fixed line.
    A smoothed line is not hard-coded: a formula still drives it. */
const isHardCell = (ln: BudgetLine | undefined, i: number): boolean => { if (!ln?.override) return false; const d = (ln.driver as any) || {}; const h = d.hard; return Array.isArray(h) ? h.includes(i) : d.smooth || d.method === 'smooth' ? false : !!ln.months[i]; };
/** Cells set by the ND 2027 Budget Review workbook (driver method 'review'): bold deep teal, as in the app, with an
    Excel note naming the review row(s) each one is tied to (Troy 2026-11-12). A cell typed over later is hard-coded. */
const REVIEW_FONT = { size: 8, bold: true, color: { argb: 'FF00796B' } };
// a REVIEW line (reclass / fee rate) carries rev.cells; a CONTRACT line filed from the review carries the row on each contract
const revOf = (ln: BudgetLine | undefined): { cells: Record<number, string[]>; rows: Record<string, any>; file?: string } | null => {
  const d = (ln?.driver as any) || {};
  if (d.method === 'review') return d.rev || null;
  if (d.method !== 'contract') return null;
  const cells: Record<number, string[]> = {}, rows: Record<string, any> = {}; let file: string | undefined;
  for (const x of d.items || []) { if (!x.review) continue; rows[x.review.rowId] = x.review; file = file || x.review.file; for (const i of x.months || []) { cells[i] = cells[i] || []; if (!cells[i].includes(x.review.rowId)) cells[i].push(x.review.rowId); } }
  return Object.keys(rows).length ? { cells, rows, file } : null;
};
const reviewRowsAt = (ln: BudgetLine | undefined, i: number): string[] | null => { const r = revOf(ln); return r && r.cells?.[i] ? r.cells[i] : null; };
const reviewNote = (ln: BudgetLine | undefined, i: number): string => {
  const d = { rev: revOf(ln) }; const ids = reviewRowsAt(ln, i) || [];
  return ids.map((id) => { const r = d.rev?.rows?.[id] || {}; return `${id} · ${r.action || ''} · ${r.item || ''}\n${r.firmness || ''}${r.basis ? ` — ${r.basis}` : ''}${r.source ? `\nSource: ${r.source}${r.contractsRow ? ` (Contracts row ${r.contractsRow})` : ''}` : ''}`; }).join('\n\n') + (d.rev?.file ? `\n\nFrom ${d.rev.file}` : '');
};
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* spec 1.6: what a plan-run acquisition's line actually is — the months the acquisition plan supplied (driver.y1), the
   n/12 split of Year 1 / Year 2, the UW trend, the pace move and where the months come from — not "Jan-Dec from the
   Year-1 budget; then <the formula the plan replaced>". */
function acqLabel(d: any): string {
  const a = d.acq || {};
  const after: number[] = Array.isArray(a.after) ? a.after : [];
  const y1 = (Array.isArray(d.y1) ? d.y1 : []).filter((i: number) => !after.includes(i));
  const span = (ix: number[]) => (ix.length ? `${MON3[ix[0]]}-${MON3[ix[ix.length - 1]]}` : '');
  const parts = [`acquisition plan (UW): ${span(y1)} = ${y1.length}/12 of Year 1`];
  if (after.length) parts.push(`${span(after)} = ${after.length}/12 of Year 1 on the UW Year-2 trend (${a.trend >= 0 ? '+' : ''}${((a.trend || 0) * 100).toFixed(1)}%)`);
  if (a.pace != null && Math.abs(a.pace - 1) >= 0.005 && a.fit) parts.push(`level moved ${Math.round(a.fit * 100)}% toward its pace since closing (${a.pace > 1 ? '+' : ''}${((a.pace - 1) * 100).toFixed(1)}%)`);
  parts.push(`months on ${a.turns ? 'the turn curve' : a.hist ? "the property's own history (posted + seller T12)" : "the Year-1 budget's pattern"}`);
  return parts.join('; ');
}
/** A line whose Year-1 months come from the property's Y1 budget says so ahead of its formula. `ctx` = the line's year
    total and the units, so a per-unit line can show the rate it actually came to (spec 1.6). */
function driverLabel(d: any, ctx: { total?: number; units?: number; gl?: string } = {}): string {
  let base = d?.reTax ? (d.reTax.branch === 'UW' ? `RE tax = UW book Taxes tab, Ryan PP Year 2 ($${Math.round(d.reTax.tax).toLocaleString('en-US')}), ÷ 12`
      : `RE tax from the bill: A $${Math.round(d.reTax.a || 0).toLocaleString('en-US')}${d.reTax.b != null ? ` / B (sale reassessed) $${Math.round(d.reTax.b).toLocaleString('en-US')}` : ''} — the higher (${d.reTax.branch}), ÷ 12`)
    : d?.accrual ? `RE tax: this year's cost $${Math.round(d.taxYear || d.accrual * 12).toLocaleString('en-US')} (accrual $${Math.round(d.accrual).toLocaleString('en-US')}/mo) × ${(1 + (d.pct || 0)).toFixed(3)}${d.taxNoInputs ? ' — no bill inputs on file: review' : ''}`
    : d?.acq ? acqLabel(d) : driverLabelBase(d);
  // insurance: the $/unit the line actually comes to (CWND / RRND carry a lender rate above the $275 guidance)
  if (ctx.gl === '6108' && ctx.units && ctx.total) base += `; = $${(Math.abs(ctx.total) / ctx.units).toFixed(2)}/unit for the year`;
  // 2027 notes pass: one-time items out of the T12, and the recurring-journal split
  if (d?.qShift) base += `; quarter shift: year total kept, dollars moved so NOI lands at ${(d.qShift.targets || []).map((t: number, i: number) => `Q${i + 1} ${(t * 100).toFixed(1)}%`).join(' / ')}${d.qShift.capped ? ' (stopped short at the floor)' : ''}`;
  if (d?.fitT12) base += `; months ${Math.round(d.fitT12 * 100)}% fitted to its own T12 (total unchanged)`;
  if (d?.shapeFrom) base += `; months on the ${String(d.shapeFrom).toUpperCase()} curve; total = own formula`;
  if (d?.oneTime) base += `; $${Math.round(d.oneTime).toLocaleString('en-US')} of one-time items taken out of the T12 first`;
  if (d?.giftCards) base += `; gift cards $${Number(d.giftCards.perEmployee).toLocaleString('en-US')} x ${d.giftCards.heads} employees allocated = $${Math.round(d.giftCards.amount).toLocaleString('en-US')} in ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(d.giftCards.month || 11) - 1]}`;
  if (d?.timing) base += d.timing.kind === 'quarters' ? '; the same each quarter' : `; one-time part $${Math.round(d.timing.amount || 0).toLocaleString('en-US')} in ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(d.timing.month || 1) - 1]}`;
  if (Array.isArray(d?.gapFill) && d.gapFill.length) base += `; T12 missed ${d.gapFill.map((m: number) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]).join(', ')} filled from the months either side`;
  if (d?.allocOut) base += `; ${Math.round(d.allocOut.pct * 10000) / 100}% to ${String(d.allocOut.to).toUpperCase()} by recurring journal ($${Math.round(d.allocOut.out).toLocaleString('en-US')} of $${Math.round(d.allocOut.gross).toLocaleString('en-US')})`;
  if (d?.smooth && d.method !== 'smooth') return `${base}; missed-bill smoothed x${d.smooth.passes || 0}, rounded to $${d.smooth.mult || 5}`;
  if (d?.acq || !Array.isArray(d?.y1) || !d.y1.length) return base;
  const span = `${MON3[d.y1[0]]}-${MON3[d.y1[d.y1.length - 1]]} from the Year-1 budget`;
  return d.method === 'manual' ? span : `${span}; then ${base}`;
}
function driverLabelBase(d: any): string {
  switch (d?.method) {
    case 'gpr': return d.hap ? `rent roll GPR less HAP $${Math.round(d.hap).toLocaleString('en-US')}/mo (GPR + HAP = rent roll GPR)` : 'rent roll GPR';
    case 'ltl': return 'LTL burnoff';
    case 'vacancy': return 'vacancy % of GPR';
    case 'catShare': return `UW cat ${d.pcode} share`;
    case 'perUnitComp': return `Minot $${d.perUnit}/unit`;
    case 'payrollModel': return 'payroll model wages';
    case 'burdenRatio': return d.from ? `${(d.ratio * 100).toFixed(1)}% of wages — ratio and monthly shape from ${String(d.from).toUpperCase()}` : `Minot ratio ${(d.ratio * 100).toFixed(1)}% of wages`;
    case 'mgmtPct': return d.firstYear && d.firstYear.months
      ? `${(Number(d.firstYear.pct) * 100).toFixed(2)}% of ${d.priorMonth ? 'prior-month ' : ''}income through ${d.firstYear.through || 'the first year'} (${d.firstYear.months} fee month${d.firstYear.months === 1 ? '' : 's'}), then ${(d.pct * 100).toFixed(2)}%`
      : `${(d.pct * 100).toFixed(2)}% of ${d.priorMonth ? 'prior-month ' : ''}income${Array.isArray(d.feeExtra) ? ` incl. ${String(d.feeExtraFrom || 'companion').toUpperCase()} income ($${Math.round(d.feeExtra.reduce((a: number, b: any) => a + (Number(b) || 0), 0)).toLocaleString('en-US')})` : ''}`;
    case 'interest': return 'loan interest';
    case 'sellerUtil': return 'seller statement level';
    case 'recovery': return `${(d.pct * 100).toFixed(1)}% recovery of prior-month billing`;
    case 'sellerLine': return `${d.basis === 'budget' ? 'CY budget' : 'seller'}: ${d.name || ''} × ${(d.pct || 0).toFixed(1)}%`;
    case 'charges': return 'rent-roll charges × 12';
    case 't3avg': return `T3 avg of ${d.srcName || 'comp'} × ${(d.pct || 0).toFixed(1)}% (MROUND 250)`;
    case 'wavg': return `1-2-1 wtd avg of ${d.basis === 'budget' ? 'CY budget ' : ''}${d.srcName || 'source'} × ${(d.pct || 0).toFixed(1)}%`;
    case 't12curve': return `${d.basis === 'budget' ? 'CY budget' : 'seller'} ${d.name || ''} ${d.basis === 'budget' ? '' : 'T12 '}total × ${(d.pct || 0).toFixed(1)}% on ${d.shape || 'flat'} curve`;
    case 'smooth': return `missed-bill smoothing ×${d.passes || 0}`;
    case 'review': return `ND 2027 Budget Review: ${Object.entries(d.rev?.rows || {}).map(([id, r]: any) => `${id} ${r.item} (${r.action}, ${r.firmness})`).join('; ')}`;
    case 'linkLine': return `= ${d.src || ''} × ${d.weight ?? 1}`;
    case 'setTotal': return `total set to ${Math.round(d.total || 0).toLocaleString()}`;
    case 'perOccupiedUnit': return `$${d.rate} per occupied unit per month (× ${d.units} units × occupancy${d.share ? ' × flat-fee share' : ''})`;
    case 'zero': return 'zeroed out';
    case 'imported': return `imported from draft${d.file ? ` (${d.file})` : ''}`;
    default: return annualDriverLabel(d);
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

export interface RefCol { key: string; label: string; period: string; byGl: Record<string, number>; totals: Record<string, number>; nMonths?: number }
export interface ReviewArgs {
  propertyCode: string; propertyName: string; year: number; units: number;
  coa: CoaAccount[]; lines: BudgetLine[]; inputs: BudgetInputs;
  uw: UwSnapshotData | null; compWeights?: Record<string, number> | null; compUnits?: number | null;
  compName?: string;
  /** ANNUAL budgets: no UW book — the reference columns are the property's
      trailing-12 actuals, the current-year budget and 4-months-annualized,
      plus the Yardi template facts. */
  annual?: boolean; refs?: RefCol[]; refLabel?: string; template?: any;
  /** ANNUAL: the payroll historicals laid out on the Payroll sheet — the
      trailing-12 actual and CY budget calendars by GL (Jan..Dec). */
  payrollHist?: { t12: Record<string, Months> | null; t12Label: string; budget: Record<string, Months> | null; budgetLabel: string } | null;
  /** ANNUAL: the budget-comps summary sheet — its column headers, the region the property sits in,
      and the NOI of the trailing-12 windows on file (oldest first; the last is the linked T12) */
  summaryLabels?: { t12: string; t4: string; draft: string };
  region?: string;
  noiTrend?: { label: string; noi: number | null }[];
  /** how the trailing-12 was built, printed under the Budget Comps title (spec 1.5) */
  t12Basis?: string;
  /** ANNUAL: the trailing-12's last month (the T12 sheet's month labels; "last month, flat" lines) */
  t12End?: { month: number; year: number } | null;
}
/** What a property's "Budget Comps" sheet holds, for the portfolio panel and the Schedule. */
interface CompsInfo { site: ReviewArgs; sheet: string; t12: SummaryCol | null; t4: SummaryCol | null; bud: SummaryCol; capital: number; units: number; cyBudgetNoi: number | null; cyBudgetMonths: number; cyBudgetLabel: string | null; cyRef: string | null; trendRefs: (string | null)[] }
const compsByWorkbook = new WeakMap<ExcelJS.Workbook, CompsInfo[]>();

/** Where a property's Payroll sheet keeps its rows (the portfolio's Payroll
    Summary references them). */
export interface PayrollSheetInfo {
  name: string; firstRow: number; lastRow: number; totalRow: number; wagesRow: number | null;
  rows: { code: string; name: string; budget: number; t12: number }[];
}
const INPUT = 'FFFFF2CC';   // typed-input cell (the ratio used)

/** Driver label additions for the annual (template) rules. */
function annualDriverLabel(d: any): string {
  switch (d?.method) {
    case 'baseline': {
      const shape = d.shape === 'last' ? '(last month, flat)' : d.shape === 'wavg' ? '(1-2-1 wtd)' : d.shape === 'flat' ? '(T12/12 flat)' : d.shape === 'avgnz' ? '(avg of active months)' : d.shape === 'curve' ? `(T12 on curve${d.fit ? `, fit ${Math.round(d.fit * 100)}% to T12 months` : ''})` : d.shape === 'turns' ? `(turnover curve: T12 on lease expirations, +1 mo lag${d.fit ? `, fit ${Math.round(d.fit * 100)}% to T12 months` : ''})` : '(same month)';
      const factor = d.pcts
        ? `Conservice forecast ${(Math.min(...d.pcts) * 100).toFixed(0)}–${(Math.max(...d.pcts) * 100).toFixed(0)}% by month`
        : `${(((d.pct || 0)) * 100).toFixed(1)}%`;
      return `${d.src === 'budget' ? 'CY budget' : 'PY actual'} ${shape} + ${factor}${d.mult ? ` → MROUND $${d.mult}` : ''}`;
    }
    case 'pctGpr': return `${((d.pct || 0) * 100).toFixed(2)}% of ${d.of === 'net' ? 'net rental income' : d.of === 'netgpr' ? 'net GPR' : 'GPR'} (${d.basis === 'last' ? 'last-month' : 'T12'} ratio)`;
    case 'suggested': return `corporate suggestion${d.note ? `: ${d.note}` : ''}`;
    case 'contract': return `${d.mode === 'add' ? 'formula + ' : ''}contracts: ${(d.items || []).map((x: any) => `${x.vendor || 'contract'} $${Math.round(x.annual).toLocaleString('en-US')}`).join(' + ')}`;
    case 'corpRate': return `corporate rate${d.perUnitYr ? ` $${d.perUnitYr}/unit/yr` : ''}${d.flatMo ? ` + $${d.flatMo}/mo` : ''}`;
    case 'debtService': return `Yardi amortization schedule — ${d.kind}${d.loan ? ` (${d.loan})` : ''}`;
    case 'perTurn': return `$${d.amount}/move-in × ${d.turns} projected move-ins`;
    case 'recapture': return `${((d.pct || 0) * 100).toFixed(1)}% recapture of the other concessions`;
    default: return '';
  }
}

export async function buildReviewWorkbook(args: ReviewArgs): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'nd-budget-tool';
  addReviewSheets(wb, args, '');
  settleMonthFormulas(wb);
  // every formula carries the value it computes (spec 1.1), and Excel recalculates everything on open
  { const diffs: CachedDiff[] = []; fillCachedResults(wb, { recompute: true, onDiff: (d) => diffs.push(d) });
    if (diffs.length) console.log(`[xlsx] ${diffs.length} formula value(s) written differently from what they compute — now stored as computed; e.g. ${diffs.slice(0, 6).map((d) => `${d.sheet}!${d.cell} ${String(d.stored)} → ${String(d.computed)}`).join('; ')}`); }
  (wb as any).calcProperties = { ...((wb as any).calcProperties || {}), fullCalcOnLoad: true };
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

/** All-sites workbook: every site's Budget/Summary/Raw Data tabs (prefixed
    "CWND Budget" …) plus a live Portfolio rollup tab referencing them. */
export async function buildPortfolioWorkbook(sites: ReviewArgs[], portfolioLabel: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'nd-budget-tool';
  // the budget-comps sheets for the whole set come first: the portfolio panel and the Schedule
  const anyComps = sites.some((s) => s.annual);
  const wsCompsP = anyComps ? wb.addWorksheet('Portfolio Comps', { properties: { tabColor: { argb: 'FF70AD47' } } }) : null;
  const wsSched = anyComps ? wb.addWorksheet('Schedule', { properties: { tabColor: { argb: 'FF70AD47' } }, views: [{ state: 'normal', showGridLines: false, zoomScale: 80 }] }) : null;
  const wsP = wb.addWorksheet('Portfolio', { properties: { tabColor: { argb: 'FFFFC000' } }, views: [{ state: 'frozen', ySplit: 4, xSplit: 2 }] });
  // the payroll rollup sits right behind the Portfolio tab (annual budgets only)
  const anyAnnual = sites.some((s) => s.annual);
  const wsPS = anyAnnual ? wb.addWorksheet('Payroll Summary', { properties: { tabColor: { argb: 'FFB4A0E0' } }, views: [{ state: 'frozen', ySplit: 3 }] }) : null;
  const payInfos: { site: ReviewArgs; info: PayrollSheetInfo }[] = [];
  for (const site of sites) {
    const info = addReviewSheets(wb, site, `${site.propertyCode.toUpperCase()} `);
    if (info) payInfos.push({ site, info });
  }
  if (wsPS) fillPayrollSummary(wsPS, payInfos, portfolioLabel, sites[0]?.year);
  // Portfolio Comps = the property panels added together (live sums); Schedule = one row per property, by region
  const comps = compsByWorkbook.get(wb) || [];
  if (wsCompsP && wsSched && comps.length) {
    const q = (sheet: string) => `'${sheet.replace(/'/g, "''")}'!`;
    const sumOf = (cell: string) => comps.map((c) => `${q(c.sheet)}${cell}`).join('+');
    const first = comps.find((c) => c.t12) || comps[0];
    fillSummaryPanel(wsCompsP, {
      title: `${portfolioLabel} Portfolio`,
      labels: first.site.summaryLabels || { t12: 'T12', t4: 'T4 Ann.', draft: 'Draft #1' },
      capital: comps.reduce((a, c) => a + c.capital, 0), units: comps.reduce((a, c) => a + c.units, 0),
      t12: sumSummaryCols(comps.map((c) => c.t12)), t4: sumSummaryCols(comps.map((c) => c.t4)), bud: sumSummaryCols(comps.map((c) => c.bud)),
      src: (col, key) => `+${sumOf(`${col}${PANEL_ROW[key]}`)}`,
    });
    const year = sites[0]?.year || 0;
    const regions = [...new Set(comps.map((c) => c.site.region || 'Other'))].sort();
    let top = 2;
    for (const rg of regions) {
      const set = comps.filter((c) => (c.site.region || 'Other') === rg).sort((a, b) => a.site.propertyCode.localeCompare(b.site.propertyCode));
      const withT = set.find((c) => (c.site.noiTrend || []).length) || set[0];
      const labels = (withT.site.noiTrend || []).map((t) => t.label);
      const cyLabel = (set.find((c) => c.cyBudgetLabel) || {}).cyBudgetLabel || `${year - 1} budget`;
      const part = set.filter((c) => c.cyBudgetMonths < 12);
      const cyHead = (/^\d{4} budget$/i.test(cyLabel) ? `NOI Growth over ${cyLabel.replace(/ budget$/i, '')}'s Budget` : `NOI Growth over the ${cyLabel.replace(/^budget /i, '')} Budget`)
        + (part.length ? ` (annualized, ${part.map((c) => `${c.site.propertyCode.toUpperCase()} ${c.cyBudgetMonths} mo`).join(', ')})` : '');
      const rows: ScheduleRow[] = set.map((c) => ({
        code: c.site.propertyCode, units: c.units, sheet: c.sheet,
        trend: labels.length ? labels.map((_, i) => (c.site.noiTrend || [])[i]?.noi ?? null) : [c.t12 ? c.t12.noi : null],
        noi: c.bud.noi, cyBudgetNoi: c.cyBudgetNoi, cyRef: c.cyRef, trendRefs: labels.length ? c.trendRefs : [], t4Income: c.t4 ? c.t4.income : null, budIncome: c.bud.income,
        taxInc: c.t12 ? r2(c.bud.tax - c.t12.tax) : null, feeInc: c.t12 ? r2(c.bud.fee - c.t12.fee) : null,
      }));
      top = fillSchedule(wsSched, top, rg, year, labels.length ? labels : ['T12'], cyHead, rows);
    }
  }

  // ----- Portfolio tab: same Summary rows, one column per site + Total -----
  wsP.getColumn(1).width = 3; wsP.getColumn(2).width = 34;
  sites.forEach((_, i) => { wsP.getColumn(3 + i).width = 14; });
  const totCol = 3 + sites.length;
  wsP.getColumn(totCol).width = 15;
  // analytics columns after the PORTFOLIO total: UW Y1, Δ vs UW, per unit, per unit/mo
  const uwColP = totCol + 1, dColP = totCol + 2, puColP = totCol + 3, pumColP = totCol + 4;
  [15, 13, 11, 13].forEach((w, i) => { wsP.getColumn(totCol + 1 + i).width = w; });
  wsP.getCell(1, 2).value = `${portfolioLabel} — ${anyAnnual ? `${sites[0]?.year || ''} Budget` : 'Year 1 Budget'} Portfolio Rollup`;
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
  // spec 1.3: on annual budgets column D of each site's Summary is its trailing-12, not a UW budget
  const t12End = (() => { const per = String(((sites.find((s) => s.annual)?.refs || []).find((r) => r.key === 'actual') || {}).period || ''); const m = per.match(/-\s*([A-Z][a-z]{2})\s+\d{4}/); return m ? m[1] : ''; })();
  const uwHead = anyAnnual ? `T12${t12End ? ` (${t12End})` : ''}` : 'Year 1 UW Budget';
  const dHead = anyAnnual ? 'Δ vs T12' : 'Δ vs UW';
  ([[uwColP, uwHead], [dColP, dHead], [puColP, 'Per Unit'], [pumColP, 'Per Unit / Month']] as [number, string][]).forEach(([col, t]) => {
    const c = wsP.getCell(4, col);
    c.value = t; c.font = f8b; c.alignment = { horizontal: 'right', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col === uwColP ? UWFILL : HEAD } };
    c.border = { bottom: { style: 'thin' } };
  });
  wsP.getCell(4, 2).value = 'Account Summary';
  wsP.getCell(4, 2).font = f8b;
  wsP.getCell(4, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
  wsP.getCell(4, 2).border = { bottom: { style: 'thin' } };
  // units row + summary rows 5..20 + debt 22..25 + capital 27 (same layout as site Summary)
  const LT0 = wsP.getColumn(totCol).letter;
  const LU = wsP.getColumn(uwColP).letter;
  const put = (r: number, label: string, srcCell: string, opts: { bold?: boolean; fmt?: string; noTotal?: boolean; uwCell?: string } = {}) => {
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
      // analytics: UW Y1 (sum of the site Summaries' D column), Δ, per unit, per unit/mo
      if (opts.uwCell) {
        const cu = wsP.getCell(r, uwColP);
        cu.value = { formula: sites.map((s) => `${sq(s)}${opts.uwCell}`).join('+') } as any;
        cu.numFmt = ACCT; cu.font = { size: 8.5, bold: !!opts.bold };
        cu.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: UWFILL } };
        const cd = wsP.getCell(r, dColP);
        cd.value = { formula: `${LT0}${r}-${LU}${r}` } as any;
        cd.numFmt = ACCT; cd.font = { size: 8.5, bold: !!opts.bold };
      }
      const cpu = wsP.getCell(r, puColP);
      cpu.value = { formula: `${LT0}${r}/$${LT0}$3` } as any;
      cpu.numFmt = PU; cpu.font = { size: 8.5, bold: !!opts.bold };
      const cpm = wsP.getCell(r, pumColP);
      cpm.value = { formula: `${LT0}${r}/$${LT0}$3/12` } as any;
      cpm.numFmt = PU; cpm.font = { size: 8.5, bold: !!opts.bold };
    }
    if (opts.bold) for (let c2 = 2; c2 <= pumColP; c2++) wsP.getCell(r, c2).border = { top: { style: 'thin' } };
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
  for (const [r, label, bold] of S_ROWS) put(r, label, `E${r}`, { bold, uwCell: `D${r}` });
  put(S_DEBT_START, 'Interest Expense', `E${S_DEBT_START}`);
  put(S_DEBT_START + 1, 'Principal', `E${S_DEBT_START + 1}`);
  put(S_DEBT_START + 2, 'Special Projects', `E${S_DEBT_START + 2}`);
  put(S_CASH_ROW, 'Cash Flow (NOI − debt service)', `E${S_CASH_ROW}`, { bold: true });
  put(S_CAP_ROW, 'Capital Contributions', `D${S_CAP_ROW}`, { fmt: CUR });
  // Y1 CoC per site + portfolio (CF / capital)
  const cocRow = S_CAP_ROW + 2;
  // the budget's own cash flow ÷ capital (each site's Summary column E): label it as the budget year's
  wsP.getCell(cocRow, 2).value = anyAnnual ? `${sites[0]?.year || ''} Budget Cash on Cash`.trim() : 'Y1 Cash on Cash';
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

  settleMonthFormulas(wb);
  // every formula carries the value it computes (spec 1.1), and Excel recalculates everything on open
  { const diffs: CachedDiff[] = []; fillCachedResults(wb, { recompute: true, onDiff: (d) => diffs.push(d) });
    if (diffs.length) console.log(`[xlsx] ${diffs.length} formula value(s) written differently from what they compute — now stored as computed; e.g. ${diffs.slice(0, 6).map((d) => `${d.sheet}!${d.cell} ${String(d.stored)} → ${String(d.computed)}`).join('; ')}`); }
  (wb as any).calcProperties = { ...((wb as any).calcProperties || {}), fullCalcOnLoad: true };
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

function addReviewSheets(wb: ExcelJS.Workbook, args: ReviewArgs, prefix: string): PayrollSheetInfo | null {
  const { coa, lines, inputs, uw, units } = args;
  // cross-sheet reference prefixes — prefixed tab names contain spaces, so quote
  /* THE YARDI TEMPLATE LAYOUT (Troy 2026-11-18: "way too many extra tabs ... make it closer to the budget export
     workbook. Add the summary items"): a property's own Budget Draft has the 2027 Yardi budget file's tabs — Budget
     Worksheet, Summary (its account summary, goal amounts, management fee, financing, expected returns), Payroll —
     plus Raw Data (org rule) and the hidden Formulas sheet. No Budget Comps or T12 tab. The all-sites workbook
     (prefixed tabs, no longer offered in the app) keeps the older layout its Portfolio tab reads. */
  const template = !prefix && !!args.annual;
  const budName = template ? 'Budget Worksheet' : `${prefix}Budget`;
  const BQ = `'${budName}'!`;
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
  // ANNUAL: the two reference columns are the trailing-12 actuals and the CY
  // budget (detail GLs + Monarch totals), in the UW / comp column slots
  const refs = args.annual ? (args.refs || []) : [];
  const refA = refs.find((r) => r.key === 'actual') || null;
  const refB = refs.find((r) => r.key === 'budget') || null;
  const refVal = (ref: RefCol | null, code: string, kind: string): number | undefined => {
    if (!ref) return undefined;
    const v = kind === 'detail' ? ref.byGl[code] : ref.totals[code];
    return v != null && v !== 0 ? v : undefined;
  };

  // the budget-comps summary (annual budgets): created first so it is the property's first tab;
  // filled at the end, once the Budget rows and the Raw Data sheet it reads exist
  const wsX = args.annual && !template ? wb.addWorksheet(`${prefix}Budget Comps`, { properties: { tabColor: { argb: 'FF70AD47' } } }) : null;

  /* ================= Budget sheet ================= */
  const ws = wb.addWorksheet(budName, {
    properties: { tabColor: { argb: 'FF00B0F0' }, defaultRowHeight: 12 },
    views: [{ state: 'frozen', xSplit: 4, ySplit: 6 }],
  });
  // Troy's own widths from his edited CLND draft (2026-11-16: "I also would like export to have the same changes made to
  // width of columns so that everything can actually be read") — the row-3 KPI values fit, and so does Cash on Cash in Q
  const widths = [8, 29.86, 24, 14, 12.43, 10.43, 13.71, 10.43, 10.86, 7.86, 11.57, 11.57, 11.57, 11.57, 11.57, 11.57, 11.57, 13, 1.43, 13, 13, 1.43, 1.43, 9.43, 9.43, 26];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  /* ROUND TRIP (Troy 2026-11-16: "When I export a budget, make changes, and then reupload it, it needs to upload formulas
     back into the system, not hard coded values. Also, the conditional formatting should bold and red any value in the
     workbook that is revised to a hard coded number"): every month a line's formula sets is written as a link to the
     Formulas sheet (the system's value, at the same row), so it stays a FORMULA in Excel; a number typed over it is not
     one, and the conditional format below turns it bold red. On re-upload the Formulas sheet is the baseline: only cells
     that differ from it become hard-coded cells; every other line stays on its formula. */
  const fxName = `${prefix}Formulas`;
  const FQ = `'${fxName.replace(/'/g, "''")}'!`;   // the hidden reference sheet: read by the upload and the "changed" format only

  /* ---- Payroll sheet (annual): every payroll GL in COA order, a TOTAL WAGES
     row under the last wage GL, a TOTAL row at the end. The Budget sheet's
     payroll rows are live references into it. ---- */
  const payGls = args.annual ? ordered.filter((a) => a.kind === 'detail' && a.pcode === '10') : [];
  const payName = `${prefix}Payroll`;
  const wsPay = payGls.length ? wb.addWorksheet(payName, { properties: { tabColor: { argb: 'FFB4A0E0' }, defaultRowHeight: 12 }, views: [{ state: 'frozen', xSplit: 2, ySplit: 5 }] }) : null;
  const PQ = prefix ? `'${payName}'!` : 'Payroll!';
  const PAY_FIRST = 6;
  const payRowOf = new Map<string, number>();
  let payWagesRow: number | null = null;
  let payTotalRow = PAY_FIRST;
  if (wsPay) {
    let pr = PAY_FIRST;
    const lastWage = [...payGls].reverse().find((a) => WAGE_GLS.includes(a.code));
    for (const a of payGls) {
      payRowOf.set(a.code, pr++);
      if (lastWage && a.code === lastWage.code) payWagesRow = pr++;
    }
    payTotalRow = pr;
  }
  const payColL = (i: number): string => (wsPay ? wsPay.getColumn(PC.m1 + i).letter : '');

  // r1: title
  ws.getCell(1, 2).value = args.propertyName;
  ws.getCell(1, 2).font = { size: 12, bold: true };
  ws.getCell(1, 3).value = `(${args.propertyCode})`;
  ws.getCell(1, 3).font = { size: 10, color: { argb: 'FF808080' } };
  ws.getCell(1, 5).value = args.annual ? `${args.year} Annual Budget · ${labels[0]} – ${labels[11]}${refA?.period ? ` · T12 actuals ${refA.period}` : ''}` : `Year 1 Budget · ${labels[0]} – ${labels[11]}`;
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
  kpi(16, 'Cash on Cash -', 'IF($C$4>0,(O3+$T$4)/$C$4,"")', PCT);
  {
    // the template's "Cash on Cash (w SP)", and a companion's NOI counted in cash on cash (TPNDC on TPND, Troy 2026-11-18)
    const rSP = rowOf.get('7500');
    const lab = ws.getCell(3, 18); lab.value = 'CoC after SP -'; lab.font = { size: 9, bold: true }; lab.alignment = { horizontal: 'right' };
    const v = ws.getCell(3, 20); v.value = { formula: `IF($C$4>0,(O3+$T$4-${rSP ? `R${rSP}` : '0'})/$C$4,"")` } as any; v.font = { size: 11, bold: true }; v.numFmt = PCT;
    const coNoi = Number((inputs as any).allocOut?.cocNoi) || 0;
    if (coNoi) {
      const to = String((inputs as any).allocOut?.to || 'companion').toUpperCase();
      const l4 = ws.getCell(4, 18); l4.value = `${to} NOI -`; l4.font = { size: 8, bold: true }; l4.alignment = { horizontal: 'right' };
      (l4 as any).note = `${to}'s NOI for the year, counted in cash on cash (the capital bought both). Typed under Journal split in the tool.`;
      const v4 = ws.getCell(4, 20); v4.value = coNoi; v4.numFmt = CUR; v4.font = INPUT_FONT;
    }
    // row 4: monthly averages under each KPI (the template's "monthly av ->")
    for (const [col, label] of [[4, 'monthly av ->'], [6, 'monthly av ->'], [8, 'monthly av ->'], [10, 'monthly av ->'], [12, 'monthly av ->'], [14, 'Monthly Av -->']] as [number, string][]) {
      const l = ws.getCell(4, col); l.value = label; l.font = { size: 8, italic: true, color: { argb: 'FF808080' } }; l.alignment = { horizontal: 'right' };
      const c4 = ws.getCell(4, col + 1); const L3 = ws.getColumn(col + 1).letter;
      c4.value = { formula: `${L3}3/12` } as any; c4.numFmt = CUR; c4.font = { size: 8 };
    }
  }
  ws.getCell(4, 2).value = 'Capital:';
  ws.getCell(4, 2).font = { size: 8, bold: true, color: { argb: 'FF505050' } };
  // capital lives on the Summary (D27 Capital Contributions) — single source
  // of truth, per Troy's edited draft
  ws.getCell(4, 3).value = { formula: template ? `${SQ}C${TS.cap}` : `${SQ}D${S_CAP_ROW}` } as any;
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
  { const hk = ws.getCell(5, C.m1 + Object.keys(DRIVER_FILLS).length); hk.value = '1,234 = hard-coded'; hk.font = { ...HARD_FONT, size: 7 }; hk.alignment = { horizontal: 'center' }; }
  { const hk = ws.getCell(5, C.m1 + Object.keys(DRIVER_FILLS).length + 1); hk.value = 'red = changed here'; hk.font = { size: 7, bold: true, color: { argb: 'FFFF0000' } }; hk.alignment = { horizontal: 'center' }; }
  { const ik = ws.getCell(5, C.m1 + Object.keys(DRIVER_FILLS).length + 2); ik.value = 'blue = input'; ik.font = { ...INPUT_FONT, size: 7 }; ik.alignment = { horizontal: 'center' }; }

  // r6 column headers
  const heads: [number, string][] = [
    [C.code, 'GL Code'], [C.name, 'GL Name'], [C.notes, 'Notes'], [C.factor, 'Increase Factor'],
    ...labels.map((m, i) => [C.m1 + i, m] as [number, string]),
    [C.annual, args.annual ? `Total ${args.year} Budget` : 'Total Year 1 Budget'],
    [C.uw, args.annual ? (refA ? `T12 Actuals${refA.period ? ` (${refA.period})` : ''}` : 'T12 Actuals') : 'Year 1 UW Budget'],
    [C.comp, args.annual ? (refB ? refB.label.replace(/^(\d{4}) budget$/i, '$1 Budget') : 'CY Budget') : `Minot Budget at ${units} units`],
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

  /* ---- the T12 sheet the month formulas read (annual): the history the tool built from, one-time items taken out,
     in the budget's month order, row for row with this sheet ---- */
  const startM = inputs.startMonth || 1;   // also read further down
  const rawName = `${prefix}Raw Data`;
  const TQ = `'${rawName.replace(/'/g, "''")}'!`;
  const T12C = { code: 8, name: 9, m1: 10, total: 22 };   // Raw Data H code, I name, J..U months, V total
  const t12L = (i: number): string => colLetter(T12C.m1 + ((i + 12) % 12));
  const t12Tot = colLetter(T12C.total);
  const t12Cal = args.annual && args.payrollHist?.t12 ? applyT12Adjust(args.payrollHist.t12, inputs.t12Adjust).actual : null;
  const hasT12 = (gl: string): boolean => !!t12Cal?.[gl]?.some((v) => v);
  const lastIdx = args.t12End?.month ? ((args.t12End.month - 1) - (startM - 1) + 12) % 12 : null;
  // January's fee runs on the current-year budget's December income (the generator and the final fee rebuild agree)
  const budCal = args.payrollHist?.budget || null;
  const decIncome = (() => {
    if (!budCal || !Object.keys(budCal).length) return null;
    const inc = rollup(new Map(Object.entries(budCal) as [string, Months][])).get('5500');
    const v = inc ? inc[(startM + 10) % 12] : 0;
    return v ? r2(v) : null;
  })();
  const cands: MonthCand[] = candByWorkbook.get(wb) || [];
  candByWorkbook.set(wb, cands);
  let driftUsed = 0;
  const rnd = (x: string, mult: number): string => (mult > 0 ? `ROUND((${x})/${mult},0)*${mult}` : `ROUND(${x},2)`);
  type Plan = { factor?: { value: number; fmt: string; formula?: string }; month: (i: number) => string | null };
  const planFor = (ln: BudgetLine, a: CoaAccount, r: number): Plan | null => {
    const d: any = ln.driver || {};
    const D = `$D${r}`;
    const sp = d.allocOut && Number(d.allocOut.pct) > 0 && Number(d.allocOut.pct) < 1 ? Number(d.allocOut.pct) : 0;
    const split = (f: string): string => (sp ? `ROUND(${f}*(1-${sp}),2)` : f);
    if (ln.override && (!d.method || d.method === 'manual')) return null;
    switch (d.method) {
      case 'baseline': {
        if (!hasT12(a.code) || d.pcts || d.src === 'budget' || d.accrual || d.reTax || d.folded) return null;
        const mult = Number(d.mult) || 0;
        let base: (i: number) => string;
        if (d.shape === 'flat') base = () => `${TQ}$${t12Tot}${r}/12`;
        else if (d.shape === 'last') { if (lastIdx == null) return null; const L = t12L(lastIdx); base = () => `${TQ}$${L}${r}`; }
        else if (!d.shape || d.shape === 'actual') base = (i) => `${TQ}${t12L(i)}${r}`;
        else if (d.shape === 'wavg') {
          // 1-2-1 weighted: twice the month plus the months either side, over 4 (the year wraps)
          const cell = (i: number) => `${TQ}${t12L(i)}${r}`;
          base = (i) => `(2*${cell(i)}+${cell(i - 1)}+${cell(i + 1)})/4`;
        } else return null;
        // RMC's Excel weighted average could not wrap: on a January-start budget its January and December are the
        // plain same month x factor to the $10 (the generator does the same)
        const wavgEdge = d.shape === 'wavg' && d.rule === 'wavg' && startM === 1;
        const drift = Number(d.drift) || 0;
        if (drift) driftUsed = drift;
        return {
          factor: { value: Number(d.pct) || 0, fmt: '0.0%' },
          month: (i) => {
            const f = wavgEdge && (i === 0 || i === 11) ? `ROUND(${TQ}${t12L(i)}${r}*(1+${D})/10,0)*10` : rnd(`${base(i)}*(1+${D})`, mult);
            return drift ? rnd(`${f}*${colL(C.m1 + i)}$2`, mult) : f;
          },
        };
      }
      case 'corpRate': {
        const pu = Number(d.perUnitYr) || 0, fm = Number(d.flatMo) || 0;
        if (pu) return { factor: { value: pu, fmt: '"$"#,##0.00' }, month: () => split(`ROUND($C$3*${D}/12${fm ? `+${fm}` : ''},2)`) };
        if (fm) return { factor: { value: fm, fmt: CUR }, month: () => split(`ROUND(${D},2)`) };
        return null;
      }
      case 'mgmtPct': {
        const inc = rowOf.get('5500');
        if (!inc || !d.priorMonth || !(Number(d.pct) > 0)) return null;
        const ex: number[] | null = Array.isArray(d.feeExtra) && d.feeExtra.length === 12 ? d.feeExtra.map((v: any) => Number(v) || 0) : null;
        const mr = Number(ln.round) || 0;
        const basis = (i: number): string => {
          const own = i === 0 ? (decIncome != null ? String(decIncome) : `${colL(C.m1)}${inc}`) : `${colL(C.m1 + i - 1)}${inc}`;
          const e = ex ? ex[i === 0 ? 0 : i - 1] : 0;
          return e ? `(${own}+${e})` : own;
        };
        return {
          factor: { value: Number(d.pct), fmt: '0.00%' },
          month: (i) => {
            let f = `ROUND(${basis(i)}*${D},0)`;
            if (sp) f = `ROUND(${f}*(1-${sp}),2)`;
            return mr > 0 ? `ROUND(${f}/${mr},0)*${mr}` : f;
          },
        };
      }
      case 'contract': {
        // the contract cost in that month x (1 + the % over contract), the split after (Troy 2026-11-18)
        if (d.mode === 'add') return null;
        const cost: number[] = Array.isArray(d.cost) && d.cost.length === 12 ? d.cost.map((v: any) => Number(v) || 0) : ln.months.map((v) => (Number(v) || 0) / (sp ? 1 - sp : 1));
        if (!Array.isArray(d.cost) && sp) return null;   // an older line without its cost: the value stands
        return { factor: { value: Number(d.pct) || 0, fmt: '0.00%' }, month: (i) => (cost[i] ? split(`ROUND(${r2(cost[i])}*(1+${D}),2)`) : null) };
      }
      case 'pctGpr': {
        const rG = rowOf.get('4994');
        if (d.of !== 'gpr' || !(Number(d.pct)) || !rG) return null;
        // the rate: a typed % as typed, else the T12 ratio worked out on the T12 sheet (the line's T12 over GPR's)
        const typed = inputs.pctGpr?.[a.code];
        const factor = typed != null ? { value: Number(typed), fmt: '0.000%' }
          : hasT12(a.code) && hasT12('4994') ? { value: 0, formula: `${TQ}$${t12Tot}${r}/${TQ}$${t12Tot}${rG}`, fmt: '0.000%' } : null;
        if (!factor) return null;
        return { factor, month: (i) => `ROUND(${colL(C.m1 + i)}${rG}*${D},2)` };
      }
      default: return null;
    }
  };

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
      const payRow = wsPay ? payRowOf.get(a.code) : undefined;
      ws.getCell(r, C.notes).value = (payRow ? '→ Payroll sheet' + (ln ? ' · ' : '') : '') + (ln ? driverLabel(ln.driver, { total: sum(ln.months), units, gl: a.code }) + (ln.override ? ' (manual)' : '') : '');
      ws.getCell(r, C.notes).font = { size: 7.5, italic: true, color: { argb: 'FF808080' } };
      const hasVals = ln && (ln.months.some((v) => v) || ln.override);
      const dFill = DRIVER_FILLS[driverKind(hasVals ? ln : undefined)].fill;
      const plan = ln && !payRow && hasVals ? planFor(ln, a, r) : null;
      if (plan?.factor) {
        const fc = ws.getCell(r, C.factor);
        // a typed rate is an input (blue); a rate worked out from the T12 is a formula you can type over
        fc.value = plan.factor.formula ? { formula: plan.factor.formula } as any : plan.factor.value;
        fc.numFmt = plan.factor.fmt; fc.font = plan.factor.formula ? { size: 8 } : INPUT_FONT; fc.alignment = { horizontal: 'right' };
      }
      (ln?.months || zero12()).forEach((v, i) => {
        const cell = ws.getCell(r, C.m1 + i);
        const f = v && ln && !payRow && !isHardCell(ln, i) && plan ? plan.month(i) : null;
        if (payRow) cell.value = { formula: `${PQ}${payColL(i)}${payRow}`, result: v || 0 } as any;
        else if (f) { cell.value = { formula: f, result: v } as any; cands.push({ ws, row: r, col: C.m1 + i, engine: v }); }
        else if (v) cell.value = v;
        cell.numFmt = CUR;
        // hard-coded (typed / fixed by hand): bold in the one colour nothing else uses
        cell.font = !payRow && isHardCell(ln, i) ? HARD_FONT : !payRow && reviewRowsAt(ln, i) ? REVIEW_FONT : f8;
        if (!payRow && !isHardCell(ln, i) && reviewRowsAt(ln, i)) (cell as any).note = reviewNote(ln, i);
        if (payRow) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DRIVER_FILLS.pay.fill } };
        else if (hasVals) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dFill } };
      });
      if (ln?.note) {
        ws.getCell(r, C.note).value = ln.note;
        ws.getCell(r, C.note).font = { size: 8, italic: true, color: { argb: 'FF505050' } };
      } else if (ln && args.annual) {
        // spec 1.6: a line that moves more than $25K against its T12 with no note says so (a flag; nothing changes)
        const t12 = refVal(refA, a.code, 'detail');
        const mv = t12 != null ? sum(ln.months) - t12 : null;
        if (mv != null && Math.abs(mv) > 25000) {
          ws.getCell(r, C.note).value = `REVIEW: ${mv > 0 ? '+' : '−'}$${Math.round(Math.abs(mv)).toLocaleString('en-US')} vs the T12 and no note`;
          ws.getCell(r, C.note).font = { size: 8, bold: true, color: { argb: 'FFC00000' } };
        }
      }
      if (args.compWeights && args.compUnits && args.compWeights[a.code]) {
        const cc = ws.getCell(r, C.comp);
        cc.value = r2((args.compWeights[a.code] / args.compUnits) * units);
        cc.numFmt = ACCT; cc.font = f8;
        cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COMPFILL } };
      }
      const rb = refVal(refB, a.code, 'detail');
      if (rb != null) {
        const cc = ws.getCell(r, C.comp);
        cc.value = rb; cc.numFmt = ACCT; cc.font = f8;
        cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COMPFILL } };
      }
      // zero detail rows are HIDDEN (not removed) — headers, totals and
      // section breaks all stay put; unhide in Excel to see the full chart
      const anyData = hasVals || !!ln?.note || uwCol[a.code] != null && uwCol[a.code] !== 0
        || !!(args.compWeights && args.compUnits && args.compWeights[a.code])
        || refVal(refA, a.code, 'detail') != null || rb != null;
      if (!anyData) ws.getRow(r).hidden = true;
    } else {
      // total row: month formulas
      for (let i = 0; i < 12; i++) {
        const col = C.m1 + i;
        const L = colL(col);
        let formula = '';
        if (rangeTotals[a.code]) {
          const rows = detailRowsIn(...rangeTotals[a.code]);
          if (rows.length) {
            const lo = Math.min(...rows), hi = Math.max(...rows);
            // a SUM(lo:hi) is only safe when nothing FOREIGN sits inside the
            // span (7491's old display_order dragged 7500's span across the
            // whole bottom of the sheet — interest, depreciation, principal)
            const members = new Set(rows);
            const foreign = ordered.some((x) => {
              const xr = rowOf.get(x.code)!;
              return xr > lo && xr < hi && !members.has(xr) && x.kind !== 'header';
            });
            formula = foreign ? rows.map((r3) => `${L}${r3}`).join('+') : `SUM(${L}${lo}:${L}${hi})`;
          }
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
    if (args.annual) {
      const ra = refVal(refA, a.code, a.kind);
      if (ra != null) {
        const uc = ws.getCell(r, C.uw);
        uc.value = ra; uc.numFmt = ACCT; uc.font = a.kind === 'total' ? f8b : f8;
        uc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: UWFILL } };
      }
      if (a.kind === 'total') {
        const rb = refVal(refB, a.code, 'total');
        if (rb != null) {
          const cc = ws.getCell(r, C.comp);
          cc.value = rb; cc.numFmt = ACCT; cc.font = f8b;
          cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COMPFILL } };
        }
      }
    }
  }

  // within-year cost drift (history-based expense lines cost a little more late in the year): the month factors
  // the drifted lines' formulas multiply by, off the one input in D4
  if (driftUsed) {
    const d4 = ws.getCell(2, C.factor);
    d4.value = driftUsed; d4.numFmt = '"drift "0.0%'; d4.font = { ...INPUT_FONT, size: 8 }; d4.alignment = { horizontal: 'right' };
    (d4 as any).note = 'Within-year cost drift: the drifted expense lines cost (1 + drift × (month position − ½)) of their level, so late months a little more than early ones. The month factors are in E2:P2.';
    for (let i = 0; i < 12; i++) {
      const c4 = ws.getCell(2, C.m1 + i);
      c4.value = { formula: `1+$D$2*(${i}/11-0.5)`, result: 1 + driftUsed * (i / 11 - 0.5) } as any;
      c4.numFmt = '0.0000'; c4.font = { size: 7, color: { argb: 'FF808080' } };
    }
  }

  const payInfo = wsPay ? fillPayrollSheet(wsPay, payName, args, payGls, payRowOf, payWagesRow, payTotalRow, byGl, labels, refA, refB) : null;

  /* ================= Summary sheet ================= */
  const wsS = wb.addWorksheet(`${prefix}Summary`, { properties: { tabColor: { argb: 'FF92D050' } }, views: [{ state: 'frozen', ySplit: template ? 8 : 4 }] });
  if (template) fillTemplateSummary(wsS, { args, BQ, rowOf, principalRows, budName, colL, monthCol: (i: number) => colL(C.m1 + i) });
  else {
  [3, 34, 2, 15, 15, 13, 11, 13, 11.6].forEach((w, i) => { wsS.getColumn(i + 1).width = w; });
  wsS.getCell(1, 2).value = args.annual ? `${args.propertyName} FY ${args.year} Budget Analysis` : `${args.propertyName} Year 1 Budget Analysis (${labels[0]} – ${labels[11]})`;
  wsS.getCell(1, 2).font = { size: 12, bold: true };
  wsS.getCell(2, 7).value = 'Unit Count';
  wsS.getCell(2, 7).font = f8b;
  wsS.getCell(2, 8).value = units;
  wsS.getCell(2, 8).font = { size: 10, bold: true };
  // annual Summary keeps the SAME rows/columns A-H (the Portfolio tab reads
  // them), with D = T12 actuals in the UW slot, and adds the template's
  // analysis columns to the right: CY budget, Δ, 4-mo annualized, % change
  const refA4 = args.annual ? (args.refs || []).find((r) => r.key === 'ann4') || null : null;
  const refBs = args.annual ? (args.refs || []).find((r) => r.key === 'budget') || null : null;
  const refAs = args.annual ? (args.refs || []).find((r) => r.key === 'actual') || null : null;
  if (args.annual) [13, 13, 13, 11].forEach((w, i) => { wsS.getColumn(9 + i).width = w; });
  const sHeads = args.annual
    ? ['', 'Account Summary', '', `Trailing 12${refAs?.period ? `\n(${refAs.period})` : ''}`, `${args.year} Budget`, 'Δ vs Trailing 12', 'Per Unit', 'Per Unit / Month', refBs ? refBs.label.replace(/^(\d{4}) budget$/i, '$1 Budget') : 'CY Budget', 'Δ vs CY Budget', '4 Months Annualized', '% Change vs T12']
    : ['', 'Account Summary', '', 'Year 1 UW Budget', 'Year 1 Budget', 'Δ vs UW', 'Per Unit', 'Per Unit / Month'];
  sHeads.forEach((t, i) => {
    if (!t) return;
    const cell = wsS.getCell(4, i + 1);
    cell.value = t;
    cell.font = { size: 8.5, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
    cell.border = { bottom: { style: 'thin' } };
    cell.alignment = { horizontal: i >= 3 ? 'right' : 'left', wrapText: true };
  });
  if (args.annual) wsS.getRow(4).height = 26;
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
    if (args.annual) {
      const t = (ref: RefCol | null) => (ref ? (ref.totals[code] ?? 0) : null);
      wsS.getCell(sr, 4).value = t(refAs) ?? 0;
      wsS.getCell(sr, 9).value = t(refBs) ?? 0;
      wsS.getCell(sr, 10).value = { formula: `E${sr}-I${sr}` } as any;
      wsS.getCell(sr, 11).value = t(refA4) ?? 0;
      wsS.getCell(sr, 12).value = { formula: `IF(D${sr}=0,"",(E${sr}-D${sr})/ABS(D${sr}))` } as any;
      for (const c2 of [9, 10, 11]) { const cell = wsS.getCell(sr, c2); cell.numFmt = ACCT; cell.font = font; }
      wsS.getCell(sr, 12).numFmt = PCT; wsS.getCell(sr, 12).font = font;
      wsS.getCell(sr, 9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COMPFILL } };
      wsS.getCell(sr, 4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: UWFILL } };
    }
    wsS.getCell(sr, 5).value = { formula: `${BQ}R${rowOf.get(code)}` } as any;
    wsS.getCell(sr, 6).value = { formula: `E${sr}-D${sr}` } as any;
    wsS.getCell(sr, 7).value = { formula: `E${sr}/$H$2` } as any;
    wsS.getCell(sr, 8).value = { formula: `E${sr}/$H$2/12` } as any;
    for (const c2 of [4, 5, 6]) { const cell = wsS.getCell(sr, c2); cell.numFmt = ACCT; cell.font = font; }
    for (const c2 of [7, 8]) { const cell = wsS.getCell(sr, c2); cell.numFmt = PU; cell.font = font; }
    if (bold) for (let c2 = 1; c2 <= (args.annual ? 12 : 8); c2++) wsS.getCell(sr, c2).border = { top: { style: 'thin' } };
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
  const refTot = (code: string): number => (refAs ? (refAs.totals[code] ?? refAs.byGl[code] ?? 0) : 0);
  const refPrincipal = refAs ? Math.abs(['3080', '3090', '3091'].reduce((a, c) => a + (refAs.byGl[c] || 0), 0)) : 0;
  const refDebt: (number | null)[] = args.annual ? [refTot('7315') || refTot('7300'), refPrincipal, refTot('7500'), null] : [];
  for (const [label, formula] of debtRows) {
    wsS.getCell(sr, 2).value = label;
    wsS.getCell(sr, 2).font = { size: 8.5 };
    const cell = wsS.getCell(sr, 5);
    cell.value = { formula: formula || `E${noiRowS}-E${debtStart}-E${debtStart + 1}` } as any;
    cell.numFmt = ACCT;
    cell.font = label.startsWith('Cash Flow') ? { size: 8.5, bold: true } : { size: 8.5 };
    if (args.annual) {
      const i = sr - debtStart;
      const dc = wsS.getCell(sr, 4);
      dc.value = refDebt[i] == null ? ({ formula: `D${noiRowS}-D${debtStart}-D${debtStart + 1}` } as any) : refDebt[i];
      dc.numFmt = ACCT; dc.font = cell.font;
      dc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: UWFILL } };
      const fc = wsS.getCell(sr, 6);
      fc.value = { formula: `E${sr}-D${sr}` } as any; fc.numFmt = ACCT; fc.font = cell.font;
    }
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
  // startM: the budget start month (set above, with the T12 sheet)
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
  }

  /* ================= Raw Data sheet ================= */
  const wsR = wb.addWorksheet(rawName);
  [26, 42, 12, 60].forEach((w, i) => { wsR.getColumn(i + 1).width = w; });
  /* the trailing-12 by month, row for row with the Budget Worksheet (columns H..V): what its month formulas read */
  if (t12Cal) {
    wsR.getColumn(T12C.code).width = 8; wsR.getColumn(T12C.name).width = 30;
    for (let i = 0; i < 12; i++) wsR.getColumn(T12C.m1 + i).width = 11;
    wsR.getColumn(T12C.total).width = 12;
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const end = args.t12End || null;
    const t = wsR.getCell(1, T12C.code); t.value = `Trailing-12 actuals by month${refA?.period ? ` (${refA.period})` : ''}`; t.font = { size: 10, bold: true };
    const n2 = wsR.getCell(2, T12C.code);
    n2.value = `In the budget's month order, row for row with the ${budName} sheet: a formula such as =${TQ}J20*(1+$D20) there reads this block.${(inputs.t12Adjust || []).length ? ' One-time items taken out of the T12 in the tool are out here too.' : ''}`;
    n2.font = { size: 8, italic: true, color: { argb: 'FF505050' } };
    const heads2: [number, string][] = [[T12C.code, 'GL Code'], [T12C.name, 'GL Name'], [T12C.total, 'T12 Total']];
    for (let i = 0; i < 12; i++) {
      const c = (startM - 1 + i) % 12;
      const yr = end ? (c <= end.month - 1 ? end.year : end.year - 1) : null;
      heads2.push([T12C.m1 + i, yr ? `${MON[c]}-${String(yr).slice(2)}` : MON[c]]);
    }
    for (const [col, text] of heads2) {
      const cell = wsR.getCell(6, col);
      cell.value = text; cell.font = { size: 8.5, bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
      cell.border = { bottom: { style: 'thin' } };
    }
    for (const a of ordered) {
      if (a.kind !== 'detail') continue;
      const cal = t12Cal[a.code];
      if (!cal || !cal.some((v) => v)) continue;
      const r = rowOf.get(a.code)!;
      wsR.getCell(r, T12C.code).value = a.code; wsR.getCell(r, T12C.code).font = { size: 8, color: { argb: 'FF808080' } };
      wsR.getCell(r, T12C.name).value = a.name; wsR.getCell(r, T12C.name).font = { size: 8 };
      rotate12(cal, startM).forEach((v, i) => { const cell = wsR.getCell(r, T12C.m1 + i); cell.value = v || 0; cell.numFmt = CUR; cell.font = { size: 8 }; });
      const tc = wsR.getCell(r, T12C.total);
      tc.value = { formula: `SUM(${colLetter(T12C.m1)}${r}:${colLetter(T12C.m1 + 11)}${r})`, result: r2(sum(cal)) } as any;
      tc.numFmt = CUR; tc.font = { size: 8, bold: true };
    }
  }
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
  const { actuals: rawActuals, ...inputsNoActuals } = inputs as any;
  flat(inputsNoActuals);
  rrw++;
  if (rawActuals && Object.keys(rawActuals).length) {
    rawRow(['Actualized months — closed months budgeted 1:1 to posted Cash actuals (partial-month rule)'], true);
    for (const [key, a] of Object.entries(rawActuals as Record<string, any>)) {
      rawRow([`${key} · ${a.period} · ${a.book}`, `source: ${a.source || ''}`, '', `applied ${String(a.appliedAt || '').slice(0, 10)}${a.appliedBy ? ' by ' + a.appliedBy : ''}`], true);
      rawRow(['gl', 'posted amount (budgeted 1:1)'], true);
      for (const [gl, v] of Object.entries(a.glMonths || {})) rawRow([gl, v]);
      const ex = [...(a.summary?.remapped || []), ...(a.summary?.excluded || []), ...(a.summary?.unmapped || [])];
      if (ex.length) {
        rawRow(['gl', 'name', 'posted amount', 'not carried 1:1 on its own account — why'], true);
        for (const e of ex) rawRow([e.gl, e.name, e.amount, e.to ? `${e.reason}` : e.reason]);
      }
      rrw++;
    }
  }
  if (args.annual) {
    const t = args.template;
    rawRow(['Annual budget — reference columns (the property\'s own statements)'], true);
    rawRow(['gl', ...(args.refs || []).map((r) => `${r.label}${r.period ? ` (${r.period})` : ''}`)], true);
    const gls = new Set<string>();
    for (const r of args.refs || []) for (const g of Object.keys(r.byGl)) gls.add(g);
    for (const g of [...gls].sort((a, b) => Number(a) - Number(b))) rawRow([g, ...(args.refs || []).map((r) => r.byGl[g] ?? '')]);
    rrw++;
    if (t) {
      rawRow(['Yardi budget template facts'], true);
      rawRow(['units', t.units]); rawRow(['capital', t.capital]); rawRow(['budget year', t.budgetYear]);
      rawRow(['last actual month', `${t.lastActual?.year}-${String(t.lastActual?.month).padStart(2, '0')}`]);
      rawRow(['renewal %', t.renewalPct ?? '']); rawRow(['mgmt fee actual %', t.mgmtFee?.actualPct ?? '']);
      rawRow(['mgmt fee matrix', JSON.stringify(t.mgmtFee?.matrix || {})]);
      rawRow(['lease expirations (Jan..Dec)', (t.leaseExpirations || []).join(', ')]);
      if (t.moveOuts) { rawRow(['PY scheduled move-outs (Jan..Dec)', t.moveOuts.scheduled.join(', ')]); rawRow(['PY unscheduled move-outs (Jan..Dec)', t.moveOuts.unscheduled.join(', ')]); }
      rawRow(['lease goals (Jan..Dec)', (t.leaseGoals || []).join(', ')]);
      rawRow(['debt — interest (Jan..Dec)', (t.debt?.interest || []).join(', ')]);
      rawRow(['debt — principal (Jan..Dec)', (t.debt?.principal || []).join(', ')]);
      for (const m of t.mortgage || []) rawRow([`loan ${m.loanCode}`, `${m.lender} ${m.program} · orig ${m.origBal} · rate ${m.rate} · IO end ${m.ioEnd || ''} · due ${m.dueDate || ''}`]);
      rawRow(['utility forecasts (gl → % by month)'], true);
      for (const [g, v] of Object.entries(t.utilForecast || {})) rawRow([g, (v as number[]).map((x) => `${Math.round(x * 1000) / 10}%`).join(', ')]);
      rawRow(['corporate suggestions (gl → $ by month)'], true);
      for (const [g, v] of Object.entries(t.suggestions || {})) rawRow([g, (v as number[]).join(', '), '', (t.suggestionNotes?.[g] || []).join('; ')]);
      rrw++;
    }
  } else {
    rawRow(['UW Year-1 by category (tie-out targets)'], true);
    rawRow(['pcode', 'label', 'UW Y1'], true);
    if (uw) {
      for (const p of PCODES) rawRow([p, PCODE_LABELS[p], uw.y1[p] ?? '']);
      rawRow(['', 'EGI', uw.egi]); rawRow(['', 'TOE', uw.toe]); rawRow(['', 'NOI', uw.noi]);
    }
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
  /* ================= Budget Comps sheet (the summary panel) ================= */
  if (wsX) {
    const monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
    const totalsOf = (code: string): number => {
      // a Monarch total = the sum of its detail range; the chain mirrors domain.rollup
      const RNG: Record<string, [number, number]> = { '5070': [4994, 5069], '5190': [5100, 5189], '6170': [6100, 6169], '6370': [6300, 6369], '6399': [6371, 6398], '6470': [6400, 6469], '6570': [6500, 6569], '6670': [6600, 6669], '6770': [6700, 6769], '6870': [6800, 6869], '6970': [6900, 6969], '7070': [7000, 7069] };
      const rg = RNG[code]; if (!rg) return 0;
      let acc = 0;
      for (const [gl, m] of monthsMap) { const n = parseInt(gl, 10); if (n >= rg[0] && n <= rg[1]) acc += sum(m); }
      return r2(acc);
    };
    const bud = summaryColumn(totalsOf, (g) => sum(monthsMap.get(g) || zero12()));
    const refCol = (key: string): SummaryCol | null => { const r = refs.find((x) => x.key === key); return r ? summaryColumn((c) => r.totals[c] || 0, (g) => r.byGl[g] || 0) : null; };
    const t12 = refCol('actual');
    let t4 = refCol('ann4');
    if (t4 && t12) t4 = { ...t4, interest: t12.interest, cashFlow: r2(t4.noi - t12.interest + t4.mtg1 + t4.mtg2) };
    const capital = Number(inputs.capital) || 0;
    // the T4-annualized inputs live on the Raw Data sheet (show the work); the panel reads them from there
    const RQ = `'${prefix}Raw Data'!`;
    rrw += 1;
    rawRow(['Budget Comps sheet — inputs', 'the last four posted months x 3 (annualized), by summary line; the Budget Comps sheet reads column B'], true);
    const t4Row: Record<string, number> = {};
    const T4KEYS: [string, string][] = [['rental', '5070 Total Rental Income'], ['other', '5190 Total Other Income'], ['fixedLess', '6170 Fixed Admin less RE taxes & mgmt fee'], ['tax', '6116 Real Estate Taxes'], ['fee', '6112 Management Fee'], ['admin', '6370 + 6399 Admin'], ['payroll', '6470 Payroll'], ['marketing', '6570 Marketing'], ['utilities', '6670 Utilities'], ['inHouse', '6770 In-House'], ['exterior', '6870 Exterior / CAM'], ['contract', '6970 Contract Services'], ['rehab', '7070 Rehab / Replace']];
    for (const [k, label] of T4KEYS) { t4Row[k] = rrw; rawRow([label, t4 ? (t4 as any)[k] : 0]); }
    // Schedule inputs: the current-year budget NOI and the trailing-12 NOI windows on file (the Schedule sheet reads column B)
    const cyb = refs.find((x) => x.key === 'budget');
    // spec 1.4: a CY budget covering only the months owned is annualized: NOI × 12 ÷ its months with NOI
    const cyN = cyb?.nMonths && cyb.nMonths < 12 ? cyb.nMonths : 12;
    const cyNoi = cyb ? r2((cyb.totals['7280'] || 0) * 12 / cyN) : null;
    let cyRef: string | null = null;
    if (cyNoi) { cyRef = `${RQ}B${rrw}`; rawRow([`NOI, ${cyb!.label}${cyN < 12 ? ` (annualized, ${cyN} mo × 12/${cyN})` : ''}`, cyNoi]); }
    const trendRefs: (string | null)[] = (args.noiTrend || []).map((t) => {
      if (t.noi == null) return null;
      const at = `${RQ}B${rrw}`; rawRow([`T12 NOI, window ending ${t.label}`, t.noi]); return at;
    });
    const rowB = (code: string) => rowOf.get(code);
    const ref = (col: number, code: string): string => (rowB(code) ? `${BQ}${colLetter(col)}${rowB(code)}` : '0');
    const fromBudget = (col: number, key: string): string | null => {
      switch (key) {
        case 'rental': return `+${ref(col, '5070')}`;
        case 'other': return `+${ref(col, '5190')}`;
        case 'fixedLess': return `${ref(col, '6170')}-${col === C.uw ? 'C' : 'E'}13-${col === C.uw ? 'C' : 'E'}14`;
        case 'tax': return `+${ref(col, '6116')}`;
        case 'fee': return `+${ref(col, '6112')}`;
        case 'admin': return `${ref(col, '6370')}+${ref(col, '6399')}`;
        case 'payroll': return `+${ref(col, '6470')}`;
        case 'marketing': return `+${ref(col, '6570')}`;
        case 'utilities': return `+${ref(col, '6670')}`;
        case 'inHouse': return `+${ref(col, '6770')}`;
        case 'exterior': return `+${ref(col, '6870')}`;
        case 'contract': return `+${ref(col, '6970')}`;
        case 'rehab': return `+${ref(col, '7070')}`;
        case 'interest': return `+${ref(col, '7300')}`;
        case 'mtg1': return `-ABS(${ref(col, '3080')})`;
        case 'mtg2': return `-ABS(${ref(col, '3090')})`;
        default: return null;
      }
    };
    fillSummaryPanel(wsX, {
      title: args.propertyCode.toUpperCase() + (args.propertyName && args.propertyName.toUpperCase() !== args.propertyCode.toUpperCase() ? ` — ${args.propertyName}` : ''),
      basis: args.t12Basis || '',
      labels: args.summaryLabels || { t12: 'T12', t4: 'T4 Ann.', draft: 'Draft #1' },
      capital, units, t12, t4, bud,
      src: (col, key) => {
        if (key === 'capital' || key === 'units') return col === 'C' ? null : '+C' + PANEL_ROW[key];
        if (col === 'C') return t12 ? fromBudget(C.uw, key) : null;
        if (col === 'E') return fromBudget(C.annual, key);
        // D: four months annualized from the Raw Data block; interest follows the T12, as in the workbook
        if (key === 'interest') return '+C28';
        if (key === 'mtg1' || key === 'mtg2') return null;
        return t4 && t4Row[key] ? `+${RQ}B${t4Row[key]}` : null;
      },
    });
    const list = compsByWorkbook.get(wb) || [];
    list.push({ site: args, sheet: `${prefix}Budget Comps`, t12, t4, bud, capital, units, cyBudgetNoi: cyNoi, cyBudgetMonths: cyN, cyBudgetLabel: cyb ? cyb.label : null, cyRef, trendRefs });
    compsByWorkbook.set(wb, list);
  }
  /* ================= Formulas sheet: the system's value of every line, row for row with the Budget sheet ================= */
  {
    const wsF = wb.addWorksheet(fxName, { properties: { tabColor: { argb: 'FFBFBFBF' }, defaultRowHeight: 12 }, views: [{ state: 'frozen', xSplit: 4, ySplit: 6 }] });
    widths.forEach((w, i) => { wsF.getColumn(i + 1).width = w; });
    wsF.getCell(1, 2).value = `${args.propertyName} — the system's formulas`;
    wsF.getCell(1, 2).font = { size: 12, bold: true };
    wsF.state = 'hidden';   // a reference point only: no Budget cell reads it (Troy 2026-11-18)
    wsF.getCell(2, 2).value = 'Hidden reference: what the tool had for every line when this file was exported. Nothing on the Budget sheet reads it. On upload, a Budget month that differs from it comes back as a hard-coded cell; while editing, such a month shows bold red. Leave it as it is.';
    wsF.getCell(2, 2).font = { size: 8, italic: true, color: { argb: 'FF505050' } };
    for (const [col, text] of [[C.code, 'GL Code'], [C.name, 'GL Name'], [C.notes, 'Formula'], ...labels.map((m, i) => [C.m1 + i, m] as [number, string]), [C.annual, 'Total']] as [number, string][]) {
      const cell = wsF.getCell(6, col);
      cell.value = text; cell.font = f8b;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
      cell.border = { bottom: { style: 'thin' } };
    }
    for (const a of ordered) {
      if (a.kind !== 'detail') continue;
      const ln = byGl.get(a.code);
      if (!ln || !ln.months.some((v) => v)) continue;
      const r = rowOf.get(a.code)!;
      wsF.getCell(r, C.code).value = a.code;
      wsF.getCell(r, C.code).font = { size: 8, color: { argb: 'FF808080' } };
      wsF.getCell(r, C.name).value = a.name;
      wsF.getCell(r, C.name).font = f8;
      wsF.getCell(r, C.notes).value = driverLabel(ln.driver, { total: sum(ln.months), units, gl: a.code }) + (ln.override ? ' (manual)' : '');
      wsF.getCell(r, C.notes).font = { size: 7.5, italic: true, color: { argb: 'FF808080' } };
      ln.months.forEach((v, i) => { const cell = wsF.getCell(r, C.m1 + i); cell.value = v || 0; cell.numFmt = CUR; cell.font = f8; });
      const t = wsF.getCell(r, C.annual);
      t.value = { formula: `SUM(${colL(C.m1)}${r}:${colL(C.m1 + 11)}${r})`, result: r2(sum(ln.months)) } as any;
      t.numFmt = CUR; t.font = f8;
    }
    // a detail month that no longer matches what the tool exported (typed over, or moved by a changed input): bold red.
    // Only the detail rows the hidden sheet carries are in the rule; totals and blanks are left as they are.
    for (const a of ordered) {
      if (a.kind !== 'detail') continue;
      const ln = byGl.get(a.code);
      if (!ln || !ln.months.some((v) => v)) continue;
      const r = rowOf.get(a.code)!;
      const tl = `${colL(C.m1)}${r}`;
      ws.addConditionalFormatting({
        ref: `${tl}:${colL(C.m1 + 11)}${r}`,
        rules: [{ type: 'expression', priority: 1, formulae: [`ABS(N(${tl})-N(${FQ}${tl}))>=0.01`], style: { font: { bold: true, color: { argb: 'FFFF0000' } } } } as any],
      });
    }
  }
  return payInfo;
}
/* The Summary tab in the 2027 Yardi budget file's layout (Troy 2026-11-18): the account summary by category with the
   4 months annualized, the trailing 12, the current-year budget and this budget, the increase over the trailing 12
   (per month and per unit per month) and % change rows; debt service, cash flow, capital and cash on cash (before
   and after special projects, a companion's NOI counted when one is typed); and the side panel — goal amounts, the
   management fee, financing and the expected returns by quarter. Every budget figure reads the Budget Worksheet. */
const TS = { head: 8, cap: 51 };
function fillTemplateSummary(ws: ExcelJS.Worksheet, o: { args: ReviewArgs; BQ: string; rowOf: Map<string, number>; principalRows: number[]; budName: string; colL: (n: number) => string; monthCol: (i: number) => string }): void {
  const { args, BQ, rowOf } = o;
  const refs = args.refs || [];
  const t4 = refs.find((r) => r.key === 'ann4') || null;
  const t12 = refs.find((r) => r.key === 'actual') || null;
  const cy = refs.find((r) => r.key === 'budget') || null;
  const inputs: any = args.inputs || {};
  [3, 36, 14, 14, 16, 14, 14, 14, 13, 2, 26, 14, 10].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const f85 = { size: 8.5 }, f85b = { size: 8.5, bold: true };
  const fill = (c: ExcelJS.Cell, argb: string) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; };
  ws.getCell(3, 2).value = `${args.propertyName} FY ${args.year} Budget Analysis`;
  ws.getCell(3, 2).font = { size: 12, bold: true };
  ws.getCell(3, 8).value = 'Unit Count:'; ws.getCell(3, 8).font = f85b; ws.getCell(3, 8).alignment = { horizontal: 'right' };
  ws.getCell(3, 9).value = args.units || 0; ws.getCell(3, 9).font = { size: 10, bold: true };
  ws.getCell(5, 2).value = args.year; ws.getCell(5, 2).font = f85b;
  const heads: [number, string][] = [
    [2, 'Account Summary'],
    [4, t4 ? `${t4.nMonths || 4} Months Annualized${t4.period ? `\n(${t4.period})` : ''}` : '4 Months Annualized'],
    [5, `Trailing 12${t12?.period ? `\n(${t12.period})` : ''}`],
    [6, cy ? cy.label.replace(/^(\d{4}) budget$/i, '$1 Budget') : 'CY Budget'],
    [7, `${args.year} Budget`],
    [8, 'Increase over trailing 12 (per month)'],
    [9, 'Increase -- per unit / per month'],
  ];
  for (const [col, t] of heads) {
    const c = ws.getCell(TS.head, col);
    c.value = t; c.font = f85b; fill(c, HEAD);
    c.border = { bottom: { style: 'thin' } };
    c.alignment = { horizontal: col >= 4 ? 'right' : 'left', wrapText: true, vertical: 'bottom' };
  }
  ws.getRow(TS.head).height = 36;
  const refOf = (ref: RefCol | null, codes: string[]): number | null => (ref ? r2(codes.reduce((a, c) => a + (ref.totals[c] ?? ref.byGl[c] ?? 0), 0)) : null);
  const budOf = (codes: string[]): string => codes.map((c) => (rowOf.get(c) ? `${BQ}R${rowOf.get(c)}` : '0')).join('+');
  const rowsAt: Record<string, number> = {};
  // one account row (+ its % change row under it)
  const account = (r: number, codes: string[], label: string, opts: { bold?: boolean; pctRow?: boolean; perUnit?: boolean; incr?: boolean } = {}) => {
    rowsAt[codes[0]] = r;
    ws.getCell(r, 1).value = codes[0]; ws.getCell(r, 1).font = { size: 8, color: { argb: 'FF808080' } };
    ws.getCell(r, 2).value = label; ws.getCell(r, 2).font = opts.bold ? f85b : f85;
    const vals: [number, number | null][] = [[4, refOf(t4, codes)], [5, refOf(t12, codes)], [6, refOf(cy, codes)]];
    for (const [col, v] of vals) { const c = ws.getCell(r, col); if (v != null) c.value = v; c.numFmt = ACCT; c.font = opts.bold ? f85b : f85; }
    fill(ws.getCell(r, 5), UWFILL); fill(ws.getCell(r, 6), COMPFILL);
    const g = ws.getCell(r, 7); g.value = { formula: budOf(codes) } as any; g.numFmt = ACCT; g.font = { ...(opts.bold ? f85b : f85), bold: true };
    if (opts.incr !== false) {
      const h = ws.getCell(r, 8); h.value = { formula: `(G${r}-E${r})/12` } as any; h.numFmt = ACCT; h.font = f85;
      const i = ws.getCell(r, 9); i.value = { formula: `IF($I$3>0,H${r}/$I$3,"")` } as any; i.numFmt = PU; i.font = f85;
    }
    if (opts.perUnit) { const h = ws.getCell(r, 8); h.value = { formula: `IF($I$3>0,G${r}/$I$3,"")` } as any; h.numFmt = PU; }
    if (opts.pctRow !== false) {
      ws.getCell(r + 1, 2).value = '          % Change'; ws.getCell(r + 1, 2).font = { size: 8, italic: true, color: { argb: 'FF808080' } };
      for (const col of [4, 5, 6]) {
        const L = String.fromCharCode(64 + col);
        const c = ws.getCell(r + 1, col);
        c.value = { formula: `IF(${L}${r}=0,"",(G${r}-${L}${r})/ABS(${L}${r}))` } as any; c.numFmt = PCT; c.font = { size: 8, italic: true };
      }
    }
  };
  account(9, ['5070'], 'Total Rental Income');
  account(11, ['5190'], 'Total Other Income');
  account(13, ['5500'], 'Total Income', { bold: true });
  ws.getCell(16, 2).value = 'EXPENSES:'; ws.getCell(16, 2).font = f85b;
  ws.getCell(16, 8).value = 'Per unit'; ws.getCell(16, 8).font = f85b; ws.getCell(16, 8).alignment = { horizontal: 'right' };
  const exp: [number, string[], string][] = [
    [17, ['6170'], 'Fixed Administrative'], [19, ['6370', '6399'], 'Administrative & Corporate Events'], [21, ['6470'], 'Payroll'],
    [23, ['6570'], 'Marketing'], [25, ['6670'], 'Utilities'], [27, ['6770'], 'In House Maintenance'], [29, ['6870'], 'Exterior/CAM Maintenance'],
    [31, ['6970'], 'Contract Services'], [33, ['7070'], 'Rehab / Replacement'],
  ];
  for (const [r, codes, label] of exp) account(r, codes, label, { perUnit: true, incr: false });
  // total expense = the category rows (the template's own sum)
  {
    const r = 35;
    ws.getCell(r, 2).value = ' Total Expense'; ws.getCell(r, 2).font = f85b;
    for (const col of [4, 5, 6, 7]) {
      const L = String.fromCharCode(64 + col);
      const c = ws.getCell(r, col);
      c.value = { formula: exp.map(([er]) => `${L}${er}`).join('+') } as any; c.numFmt = ACCT; c.font = f85b; c.border = { top: { style: 'thin' } };
    }
    const h = ws.getCell(r, 8); h.value = { formula: `IF($I$3>0,G${r}/$I$3,"")` } as any; h.numFmt = PU; h.font = f85b;
    ws.getCell(r + 1, 2).value = '          % Change'; ws.getCell(r + 1, 2).font = { size: 8, italic: true, color: { argb: 'FF808080' } };
    for (const col of [4, 5, 6]) { const L = String.fromCharCode(64 + col); const c = ws.getCell(r + 1, col); c.value = { formula: `IF(${L}${r}=0,"",($G$${r}-${L}${r})/ABS(${L}${r}))` } as any; c.numFmt = PCT; c.font = { size: 8, italic: true }; }
  }
  // NOI
  {
    const r = 38;
    ws.getCell(r, 1).value = '7280'; ws.getCell(r, 1).font = { size: 8, color: { argb: 'FF808080' } };
    ws.getCell(r, 2).value = 'NOI'; ws.getCell(r, 2).font = { size: 9, bold: true };
    for (const col of [4, 5, 6, 7]) { const L = String.fromCharCode(64 + col); const c = ws.getCell(r, col); c.value = { formula: `${L}13-${L}35` } as any; c.numFmt = ACCT; c.font = { size: 9, bold: true }; c.border = { top: { style: 'thin' }, bottom: { style: 'thin' } }; fill(c, GRAND); }
    ws.getCell(r + 1, 2).value = '          % Change'; ws.getCell(r + 1, 2).font = { size: 8, italic: true, color: { argb: 'FF808080' } };
    for (const col of [4, 5, 6]) { const L = String.fromCharCode(64 + col); const c = ws.getCell(r + 1, col); c.value = { formula: `IF(${L}${r}=0,"",($G$${r}-${L}${r})/ABS(${L}${r}))` } as any; c.numFmt = PCT; c.font = { size: 8, italic: true }; }
  }
  // special projects, asset management fee, debt service
  account(41, ['7500'], 'Special Projects', { pctRow: false, incr: false });
  if (rowOf.has('8930')) account(42, ['8930'], 'Asset Management Fee', { pctRow: false, incr: false });
  ws.getCell(44, 2).value = 'Annual Debt Service'; ws.getCell(44, 2).font = f85b;
  account(45, ['7315'], 'Interest', { pctRow: false, incr: false });
  // principal: the mortgage lines, shown as paid (negative), as the template
  const mort: [number, string, string][] = [[46, '3080', 'Mortgage 1'], [47, '3090', 'Mortgage 2'], [48, '3091', 'Mortgage 3']];
  for (const [r, code, label] of mort) {
    ws.getCell(r, 1).value = code; ws.getCell(r, 1).font = { size: 8, color: { argb: 'FF808080' } };
    ws.getCell(r, 2).value = label; ws.getCell(r, 2).font = f85;
    const val = (ref: RefCol | null): number | null => (ref ? -Math.abs(ref.byGl[code] || 0) : null);
    for (const [col, v] of [[4, val(t4)], [5, val(t12)], [6, val(cy)]] as [number, number | null][]) { const c = ws.getCell(r, col); if (v != null) c.value = v; c.numFmt = ACCT; c.font = f85; }
    const g = ws.getCell(r, 7); g.value = { formula: rowOf.get(code) ? `-ABS(${BQ}R${rowOf.get(code)})` : '0' } as any; g.numFmt = ACCT; g.font = f85b;
  }
  // cash flow, capital, cash on cash (a companion's NOI counted: TPNDC on TPND)
  const coNoi = Number(inputs.allocOut?.cocNoi) || 0;
  const coTo = String(inputs.allocOut?.to || 'companion').toUpperCase();
  {
    const r = 50;
    ws.getCell(r, 2).value = 'Cash Flow'; ws.getCell(r, 2).font = f85b;
    for (const col of [4, 5, 6, 7]) { const L = String.fromCharCode(64 + col); const c = ws.getCell(r, col); c.value = { formula: `${L}38-${L}45+${L}46+${L}47+${L}48` } as any; c.numFmt = ACCT; c.font = f85b; c.border = { top: { style: 'thin' } }; }
  }
  ws.getCell(TS.cap, 2).value = 'Capital Contributions'; ws.getCell(TS.cap, 2).font = f85;
  ws.getCell(TS.cap, 3).value = Number(inputs.capital) || 0; ws.getCell(TS.cap, 3).numFmt = CUR; ws.getCell(TS.cap, 3).font = INPUT_FONT;
  ws.getCell(TS.cap - 1, 3).value = coNoi ? `${coTo} NOI in CoC:` : null;
  if (coNoi) {
    ws.getCell(TS.cap - 1, 3).font = { size: 8, italic: true }; ws.getCell(TS.cap - 1, 3).alignment = { horizontal: 'right' };
    // the companion NOI for the budget year, beside capital (the Budget Worksheet's T4 holds the same input)
    ws.getCell(TS.cap + 3, 2).value = `${coTo} NOI (counted in cash on cash)`; ws.getCell(TS.cap + 3, 2).font = f85;
    const c = ws.getCell(TS.cap + 3, 7); c.value = { formula: `${BQ}T4` } as any; c.numFmt = ACCT; c.font = f85b;
  }
  const coRef = coNoi ? `+${BQ}$T$4` : '';
  for (const [r, label, sp] of [[52, 'COC Return', false], [53, 'COC after SP', true]] as [number, string, boolean][]) {
    ws.getCell(r, 2).value = label; ws.getCell(r, 2).font = f85b;
    for (const col of [4, 5, 6, 7]) {
      const L = String.fromCharCode(64 + col);
      const c = ws.getCell(r, col);
      // the companion's NOI goes on the budget column only (its history is not in this workbook)
      c.value = { formula: `IF($C$${TS.cap}>0,(${L}50${col === 7 ? coRef : ''}${sp ? `-${L}41` : ''})/$C$${TS.cap},"")` } as any;
      c.numFmt = PCT; c.font = col === 7 ? { size: 10, bold: true, color: { argb: RED } } : f85b;
    }
  }

  /* ---- the side panel ---- */
  const side = (r: number, label: string, formula: string | number | null, fmt = ACCT, opts: { bold?: boolean; pct?: string } = {}) => {
    const l = ws.getCell(r, 11); l.value = label; l.font = opts.bold ? f85b : f85;
    if (formula != null) { const c = ws.getCell(r, 12); c.value = typeof formula === 'number' ? formula : ({ formula } as any); c.numFmt = fmt; c.font = opts.bold ? f85b : f85; }
    if (opts.pct) { const c = ws.getCell(r, 13); c.value = { formula: opts.pct } as any; c.numFmt = PCT; c.font = f85b; }
  };
  const headS = (r: number, t: string) => { const c = ws.getCell(r, 11); c.value = t; c.font = { size: 9, bold: true }; fill(c, HEAD); fill(ws.getCell(r, 12), HEAD); fill(ws.getCell(r, 13), HEAD); };
  headS(8, 'GOAL AMOUNTS'); ws.getCell(8, 13).value = '% increase'; ws.getCell(8, 13).font = f85b;
  side(9, 'Trailing 12 Income', 'E13'); side(10, `${args.year} Budget`, 'G13', ACCT, { pct: 'IF(L9=0,"",(L10-L9)/ABS(L9))' });
  side(12, 'Trailing 12 Expenses', 'E35'); side(13, `${args.year} Budget`, 'G35', ACCT, { pct: 'IF(L12=0,"",(L13-L12)/ABS(L12))' });
  headS(15, 'NOI');
  side(16, 'T12 NOI', 'E38'); side(17, `${args.year} Budget`, 'G38', ACCT, { pct: 'IF(L16=0,"",(L17-L16)/ABS(L16))' });
  side(19, 'T12 (Minus SP)', 'L16-E41'); side(20, `${args.year} Budget (Minus SP)`, 'L17-G41', ACCT, { pct: 'IF(L19=0,"",(L20-L19)/ABS(L19))' });
  headS(22, 'MANAGEMENT FEE');
  const feeRow = rowOf.get('6112');
  side(23, 'Fee % of prior-month income', Number(inputs.mgmtPct) || 0, '0.00%');
  side(24, `${args.year} management fee`, feeRow ? `${BQ}R${feeRow}` : null);
  side(25, 'Fee % of budgeted income', feeRow && rowOf.get('5500') ? `IF(${BQ}R${rowOf.get('5500')}=0,"",${BQ}R${feeRow}/${BQ}R${rowOf.get('5500')})` : null, '0.00%');
  const fi = inputs.allocOut?.feeIncome;
  if (fi && Number(fi.monthly) > 0) side(26, `${coTo} income in the fee basis`, `${Number(fi.monthly)}*12`, ACCT);
  headS(33, 'FINANCING');
  side(34, 'Loan amount', Number(inputs.loan) || null, CUR);
  side(35, 'Interest rate', Number(inputs.rate) || null, '0.000%');
  side(36, 'Annual D.S. (interest + principal)', 'G45-G46-G47-G48');
  headS(47, `Expected Returns (${args.year} Budget)`);
  ws.getCell(47, 13).value = 'annualized'; ws.getCell(47, 13).font = f85b;
  const noiR = rowOf.get('7280'), intR = rowOf.get('7315');
  const sumQ = (rowN: number | undefined, q: number) => (rowN ? `SUM(${BQ}${o.monthCol(q * 3)}${rowN}:${BQ}${o.monthCol(q * 3 + 2)}${rowN})` : '0');
  const prinQ = (q: number) => o.principalRows.length ? o.principalRows.map((pr) => `ABS(${sumQ(pr, q)})`).join('+') : '0';
  for (let q = 0; q < 4; q++) {
    const r = 48 + q;
    const co = coNoi ? `+${BQ}$T$4/4` : '';
    side(r, `Q${q + 1} ${args.year}`, `${sumQ(noiR, q)}-${sumQ(intR, q)}-(${prinQ(q)})${co}`, ACCT, { pct: `IF($C$${TS.cap}>0,L${r}/($C$${TS.cap}/4),"")` });
  }
  side(52, `${args.year} Avg/Total`, 'SUM(L48:L51)', ACCT, { bold: true, pct: `IF($C$${TS.cap}>0,L52/$C$${TS.cap},"")` });
  if (coNoi) { ws.getCell(53, 11).value = `Quarters include ${coTo} NOI ÷ 4`; ws.getCell(53, 11).font = { size: 7.5, italic: true, color: { argb: 'FF808080' } }; }
}

const colLetter = (n: number): string => { let s = ''; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };

/* ================= Payroll sheet =================
   Troy 2026-11-03, modelled on the per-property tabs of the Payroll Budget
   Workbook: wage rows carry the payroll model's monthly wages (typed-over
   freely), every other payroll GL = "Ratio used" × that month's wages, and the
   ratio sits beside the historicals it comes from (T12 actual % of wages, CY
   budget % of wages) — default per the budget's burden basis, overwrite with a
   number or any formula (=AVERAGE(U7,V7)). Below: the historicals by month. */
const PC = { code: 1, name: 2, m1: 3, total: 15, t12: 16, bud: 17, diff: 18, pct: 19, rT12: 21, rBud: 22, used: 23, how: 24, fac0: 26 };   // fac0..fac0+11: each month's burden factor (spec 1.2)

function fillPayrollSheet(
  ws: ExcelJS.Worksheet, name: string, args: ReviewArgs, payGls: CoaAccount[], rowOf: Map<string, number>,
  wagesRow: number | null, totalRow: number, byGl: Map<string, BudgetLine>, labels: string[],
  refA: RefCol | null, refB: RefCol | null,
): PayrollSheetInfo {
  const L = (c: number): string => ws.getColumn(c).letter;
  const widths = [8, 34, ...Array(12).fill(10.5), 13, 13, 13, 12, 8.5, 2, 11, 11, 11, 52];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const basis: 't12' | 'budget' | 'mix' = args.inputs?.burdenBasis || 't12';
  const basisLabel = basis === 'budget' ? 'CY budget % of wages' : basis === 'mix' ? 'average of the T12 actual and CY budget % of wages' : 'T12 actual % of wages';
  const hist = args.payrollHist || null;
  const t12Label = hist?.t12Label || refA?.label || 'T12 actuals';
  const budLabel = hist?.budgetLabel || refB?.label || 'CY budget';
  const histTot = (cal: Record<string, Months> | null | undefined, code: string): number | undefined =>
    cal && cal[code] ? r2(sum(cal[code])) : undefined;
  const t12Of = (code: string): number => histTot(hist?.t12, code) ?? refA?.byGl[code] ?? 0;
  const budOf = (code: string): number => histTot(hist?.budget, code) ?? refB?.byGl[code] ?? 0;
  const wageSet = new Set(WAGE_GLS);
  const wageRows = payGls.filter((a) => wageSet.has(a.code)).map((a) => rowOf.get(a.code)!);
  const glRows = payGls.map((a) => rowOf.get(a.code)!);

  ws.getCell(1, 2).value = `${args.propertyName} (${args.propertyCode}) — ${args.year} Payroll`;
  ws.getCell(1, 2).font = { size: 12, bold: true };
  ws.getCell(2, 2).value = `Wage rows = the payroll model's monthly wages (type over them to change). Every other row = Ratio used (col ${L(PC.used)}) × that month's TOTAL WAGES; the ratio defaults to the ${basisLabel} shown beside it — type a % or any formula. The Budget sheet's payroll rows read from this sheet.`;
  ws.getCell(2, 2).font = { size: 8, italic: true, color: { argb: 'FF505050' } };
  ws.getCell(3, 2).value = 'Fill: lilac = payroll model / formula · yellow = ratio input · pink = manual override · bold magenta number = hard-coded (typed by hand)';
  ws.getCell(3, 2).font = { size: 7.5, italic: true, color: { argb: 'FF808080' } };

  const heads: [number, string][] = [
    [PC.code, 'GL Code'], [PC.name, 'GL Name'], ...labels.map((m, i) => [PC.m1 + i, m] as [number, string]),
    [PC.total, `${args.year} Budget Total`], [PC.t12, t12Label], [PC.bud, budLabel], [PC.diff, 'Difference vs T12'], [PC.pct, '% change'],
    [PC.rT12, 'T12 % of wages'], [PC.rBud, 'CY budget % of wages'], [PC.used, 'Ratio used'], [PC.how, 'How this row is built'],
  ];
  for (const [col, text] of heads) {
    const cell = ws.getCell(5, col);
    cell.value = text; cell.font = f8b;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col === PC.used ? INPUT : HEAD } };
    cell.border = { bottom: { style: 'thin' } };
    cell.alignment = { horizontal: col >= PC.m1 && col !== PC.how ? 'right' : 'left', wrapText: col >= PC.total };
  }

  const rows: PayrollSheetInfo['rows'] = [];
  // the budget's wages by month (the base every ratio row multiplies)
  const wagesMonths = Array.from({ length: 12 }, (_, i) => payGls.filter((a) => wageSet.has(a.code)).reduce((acc, a) => acc + ((byGl.get(a.code)?.months || zero12())[i] || 0), 0));
  ws.getCell(5, PC.fac0).value = 'month factor (its ratio ÷ the year\'s) →';
  ws.getCell(5, PC.fac0).font = { size: 7, italic: true, color: { argb: 'FFA0A0A0' } };
  const t12Wages = wageRows.length ? r2(payGls.filter((a) => wageSet.has(a.code)).reduce((acc, a) => acc + t12Of(a.code), 0)) : 0;
  const budWages = wageRows.length ? r2(payGls.filter((a) => wageSet.has(a.code)).reduce((acc, a) => acc + budOf(a.code), 0)) : 0;
  // the ratio the "Ratio used" cell computes (its formula reads the T12 / budget columns at full precision)
  const ratioT12 = (code: string) => (t12Wages ? t12Of(code) / t12Wages : 0);
  const ratioBud = (code: string) => (budWages ? budOf(code) / budWages : 0);
  const usedRatio = (code: string): number => basis === 'budget' ? ratioBud(code) : basis === 'mix' ? (ratioT12(code) + ratioBud(code)) / 2 : ratioT12(code);
  const money = (cell: ExcelJS.Cell, bold = false) => { cell.numFmt = CUR; cell.font = bold ? f8b : f8; };
  for (const a of payGls) {
    const r = rowOf.get(a.code)!;
    const ln = byGl.get(a.code);
    const d: any = ln?.driver || {};
    const months = ln?.months || zero12();
    const isWage = wageSet.has(a.code);
    // ratios borrowed from another property cannot be rebuilt from THIS sheet's T12 / budget columns: those rows are values
    const asFormula = !!wagesRow && !isWage && d.method === 'burdenRatio' && !ln?.override && !d.from;
    const kind = driverKind(ln && (months.some((v) => v) || ln.override) ? ln : undefined);
    const fill = asFormula || d.method === 'payrollModel' ? DRIVER_FILLS.pay.fill : ln && (months.some((v) => v) || ln.override) ? DRIVER_FILLS[kind].fill : null;
    ws.getCell(r, PC.code).value = a.code;
    ws.getCell(r, PC.code).font = { size: 8, color: { argb: 'FF808080' } };
    ws.getCell(r, PC.name).value = '    ' + a.name;
    ws.getCell(r, PC.name).font = f8;
    months.forEach((v, i) => {
      const cell = ws.getCell(r, PC.m1 + i);
      // spec 1.2: the engine prices each month on its own ratio (same-month burden since 11-09). The month's factor (its
      // ratio ÷ the year's) sits in the helper columns right of the notes, so the formula gives the engine's month to the
      // cent and typing a new Ratio used still moves every month
      if (asFormula) {
        // the ratio the "Ratio used" cell itself computes (full precision), not the engine's rounded one
        const w = wagesMonths[i] || 0, ratio = usedRatio(a.code) || Number(d.ratio) || 0;
        const fct = w && ratio ? (v || 0) / (ratio * w) : null;
        if (fct != null) {
          const fc = ws.getCell(r, PC.fac0 + i);
          fc.value = fct; fc.numFmt = '0.0000'; fc.font = { size: 7, color: { argb: 'FFA0A0A0' } };
          cell.value = { formula: `$${L(PC.used)}${r}*${L(PC.fac0 + i)}${r}*${L(PC.m1 + i)}${wagesRow}`, result: v || 0 } as any;
        } else if (v) cell.value = v;
      }
      else if (v) cell.value = v;
      money(cell);
      if (!asFormula && isHardCell(ln, i)) cell.font = HARD_FONT;
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    });
    const tot = r2(sum(months)), t12 = t12Of(a.code), bud = budOf(a.code);
    rows.push({ code: a.code, name: a.name, budget: tot, t12 });
    const cT = ws.getCell(r, PC.total); cT.value = { formula: `SUM(${L(PC.m1)}${r}:${L(PC.m1 + 11)}${r})`, result: tot } as any; money(cT, true);
    const cA = ws.getCell(r, PC.t12); if (t12) cA.value = t12; cA.numFmt = ACCT; cA.font = f8; cA.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: UWFILL } };
    const cB = ws.getCell(r, PC.bud); if (bud) cB.value = bud; cB.numFmt = ACCT; cB.font = f8; cB.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COMPFILL } };
    const cD = ws.getCell(r, PC.diff); cD.value = { formula: `${L(PC.total)}${r}-${L(PC.t12)}${r}`, result: r2(tot - t12) } as any; cD.numFmt = ACCT; cD.font = f8;
    const cP = ws.getCell(r, PC.pct); cP.value = { formula: `IF(${L(PC.t12)}${r}<>0,${L(PC.diff)}${r}/${L(PC.t12)}${r},"")`, result: t12 ? r2((tot - t12) / t12 * 10000) / 10000 : '' } as any; cP.numFmt = PCT; cP.font = f8;
    if (!isWage && wagesRow) {
      const cU = ws.getCell(r, PC.rT12);
      cU.value = { formula: `IF($${L(PC.t12)}$${wagesRow}<>0,${L(PC.t12)}${r}/$${L(PC.t12)}$${wagesRow},"")`, result: t12Wages ? Math.round(t12 / t12Wages * 100000) / 100000 : '' } as any;
      cU.numFmt = PCT; cU.font = f8;
      const cV = ws.getCell(r, PC.rBud);
      cV.value = { formula: `IF($${L(PC.bud)}$${wagesRow}<>0,${L(PC.bud)}${r}/$${L(PC.bud)}$${wagesRow},"")`, result: budWages ? Math.round(bud / budWages * 100000) / 100000 : '' } as any;
      cV.numFmt = PCT; cV.font = f8;
      if (asFormula) {
        const cW = ws.getCell(r, PC.used);
        const f = basis === 'budget' ? `${L(PC.rBud)}${r}` : basis === 'mix' ? `AVERAGE(${L(PC.rT12)}${r},${L(PC.rBud)}${r})` : `${L(PC.rT12)}${r}`;
        cW.value = { formula: f, result: d.ratio || 0 } as any;
        cW.numFmt = '0.00%'; cW.font = f8b;
        cW.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INPUT } };
        cW.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      }
    }
    const how = ws.getCell(r, PC.how);
    how.value = asFormula ? `Ratio used × TOTAL WAGES — defaults to the ${basisLabel}; type a % or a formula`
      : d.method === 'payrollModel' ? (d.roster ? 'Pay-rates roster wages — each raise prorated from its effective month (no March step); type over to change' : 'Payroll model wages, March raise step; type over to change')
      : ln ? driverLabel(d) + (ln.override ? ' (manual)' : '') : 'no history — nothing budgeted';
    how.font = { size: 7.5, italic: true, color: { argb: 'FF808080' } };
  }

  const sumOf = (col: number, rs: number[]): string => rs.map((r) => `${L(col)}${r}`).join('+');
  if (wagesRow) {
    ws.getCell(wagesRow, PC.name).value = `  TOTAL WAGES (ratio base: ${WAGE_GLS.join(', ')})`;
    ws.getCell(wagesRow, PC.name).font = f8b;
    for (let i = 0; i < 12; i++) {
      const c = ws.getCell(wagesRow, PC.m1 + i);
      c.value = { formula: sumOf(PC.m1 + i, wageRows), result: r2(wageRows.reduce((acc, wr) => acc + ((byGl.get(payGls.find((a) => rowOf.get(a.code) === wr)!.code)?.months || zero12())[i] || 0), 0)) } as any;
      c.numFmt = ACCT; c.font = f8b; c.border = { top: { style: 'thin' } };
    }
    const wTot = r2(rows.filter((x) => wageSet.has(x.code)).reduce((acc, x) => acc + x.budget, 0));
    const cT = ws.getCell(wagesRow, PC.total); cT.value = { formula: `SUM(${L(PC.m1)}${wagesRow}:${L(PC.m1 + 11)}${wagesRow})`, result: wTot } as any; cT.numFmt = ACCT; cT.font = f8b; cT.border = { top: { style: 'thin' } };
    const cA = ws.getCell(wagesRow, PC.t12); cA.value = { formula: sumOf(PC.t12, wageRows), result: t12Wages } as any; cA.numFmt = ACCT; cA.font = f8b; cA.border = { top: { style: 'thin' } };
    const cB = ws.getCell(wagesRow, PC.bud); cB.value = { formula: sumOf(PC.bud, wageRows), result: budWages } as any; cB.numFmt = ACCT; cB.font = f8b; cB.border = { top: { style: 'thin' } };
    ws.getCell(wagesRow, PC.how).value = 'the wages every ratio row multiplies';
    ws.getCell(wagesRow, PC.how).font = { size: 7.5, italic: true, color: { argb: 'FF808080' } };
  }
  // TOTAL PAYROLL EXPENSE: every GL row (the wages row is a subtotal, not an expense)
  ws.getCell(totalRow, PC.name).value = ' TOTAL PAYROLL EXPENSE';
  ws.getCell(totalRow, PC.name).font = f8b;
  const budTot = r2(rows.reduce((acc, x) => acc + x.budget, 0));
  const t12Tot = r2(rows.reduce((acc, x) => acc + x.t12, 0));
  const budBudTot = r2(payGls.reduce((acc, a) => acc + budOf(a.code), 0));
  for (let i = 0; i < 12; i++) {
    const c = ws.getCell(totalRow, PC.m1 + i);
    c.value = { formula: sumOf(PC.m1 + i, glRows), result: r2(payGls.reduce((acc, a) => acc + ((byGl.get(a.code)?.months || zero12())[i] || 0), 0)) } as any;
    c.numFmt = ACCT; c.font = f8b; c.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAND } };
  }
  const tot = (col: number, result: number) => { const c = ws.getCell(totalRow, col); c.value = { formula: sumOf(col, glRows), result } as any; c.numFmt = ACCT; c.font = f8b; c.border = { top: { style: 'thin' }, bottom: { style: 'thin' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAND } }; };
  tot(PC.total, budTot); tot(PC.t12, t12Tot); tot(PC.bud, budBudTot);
  const cD = ws.getCell(totalRow, PC.diff); cD.value = { formula: `${L(PC.total)}${totalRow}-${L(PC.t12)}${totalRow}`, result: r2(budTot - t12Tot) } as any; cD.numFmt = ACCT; cD.font = f8b;
  const cP = ws.getCell(totalRow, PC.pct); cP.value = { formula: `IF(${L(PC.t12)}${totalRow}<>0,${L(PC.diff)}${totalRow}/${L(PC.t12)}${totalRow},"")`, result: t12Tot ? r2((budTot - t12Tot) / t12Tot * 10000) / 10000 : '' } as any; cP.numFmt = PCT; cP.font = f8b;

  // largest movers, like the workbook's property tabs
  const first = PAY_FIRST_ROW, last = totalRow - 1;
  const rng = (col: number) => `$${L(col)}$${first}:$${L(col)}$${last}`;
  const movers = rows.map((x) => ({ ...x, diff: r2(x.budget - x.t12) }));
  const up = movers.reduce((m, x) => (x.diff > (m?.diff ?? -Infinity) ? x : m), null as any);
  const dn = movers.reduce((m, x) => (x.diff < (m?.diff ?? Infinity) ? x : m), null as any);
  const mv = (r: number, label: string, fn: 'MAX' | 'MIN', pick: any) => {
    ws.getCell(r, PC.total).value = label; ws.getCell(r, PC.total).font = f8b; ws.getCell(r, PC.total).alignment = { horizontal: 'right' };
    const cv = ws.getCell(r, PC.t12); cv.value = { formula: `${fn}(${rng(PC.diff)})`, result: pick?.diff ?? 0 } as any; cv.numFmt = ACCT; cv.font = f8b;
    const cn = ws.getCell(r, PC.bud); cn.value = { formula: `INDEX(${rng(PC.name)},MATCH(${fn}(${rng(PC.diff)}),${rng(PC.diff)},0))`, result: pick ? '    ' + pick.name : '' } as any; cn.font = f8;
  };
  mv(totalRow + 2, 'Largest increase', 'MAX', up);
  mv(totalRow + 3, 'Largest decrease', 'MIN', dn);

  // the historicals by calendar month, as the workbook keeps them under the budget
  let hr = totalRow + 6;
  const block = (cal: Record<string, Months> | null | undefined, label: string) => {
    if (!cal || !payGls.some((a) => cal[a.code] && cal[a.code].some((v) => v))) return;
    ws.getCell(hr, PC.name).value = `${label} — by calendar month (Jan..Dec; the months after the last actual are the prior year's)`;
    ws.getCell(hr, PC.name).font = f8b;
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    MON.forEach((m, i) => { const c = ws.getCell(hr, PC.m1 + i); c.value = m; c.font = f8b; c.alignment = { horizontal: 'right' }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } }; });
    ws.getCell(hr, PC.total).value = 'Total'; ws.getCell(hr, PC.total).font = f8b; ws.getCell(hr, PC.total).alignment = { horizontal: 'right' };
    hr++;
    const h0 = hr;
    for (const a of payGls) {
      const m = cal[a.code] || zero12();
      ws.getCell(hr, PC.code).value = a.code; ws.getCell(hr, PC.code).font = { size: 8, color: { argb: 'FF808080' } };
      ws.getCell(hr, PC.name).value = '    ' + a.name; ws.getCell(hr, PC.name).font = f8;
      m.forEach((v, i) => { const c = ws.getCell(hr, PC.m1 + i); if (v) c.value = v; c.numFmt = CUR; c.font = f8; });
      const cT = ws.getCell(hr, PC.total); cT.value = { formula: `SUM(${L(PC.m1)}${hr}:${L(PC.m1 + 11)}${hr})`, result: r2(sum(m)) } as any; cT.numFmt = CUR; cT.font = f8;
      hr++;
    }
    ws.getCell(hr, PC.name).value = ' TOTAL'; ws.getCell(hr, PC.name).font = f8b;
    for (let i = 0; i <= 12; i++) {
      const col = PC.m1 + i;
      const c = ws.getCell(hr, col);
      c.value = { formula: `SUM(${L(col)}${h0}:${L(col)}${hr - 1})`, result: r2(payGls.reduce((acc, a) => acc + (i < 12 ? ((cal[a.code] || zero12())[i] || 0) : sum(cal[a.code] || zero12())), 0)) } as any;
      c.numFmt = ACCT; c.font = f8b; c.border = { top: { style: 'thin' } };
    }
    hr += 3;
  };
  block(hist?.t12, t12Label);
  block(hist?.budget, budLabel);

  return { name, firstRow: first, lastRow: last, totalRow, wagesRow, rows };
}
const PAY_FIRST_ROW = 6;

/* ================= Payroll Summary (portfolio) =================
   One row per property, like the workbook's Summary tab: budget vs T12,
   difference, % change, and the GL that moved the most each way — every
   figure a live reference into that property's Payroll sheet. */
function fillPayrollSummary(ws: ExcelJS.Worksheet, infos: { site: ReviewArgs; info: PayrollSheetInfo }[], label: string, year?: number): void {
  [10, 15, 15, 14, 10, 2, 34, 13, 34, 13].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getCell(1, 1).value = `${label} — ${year || ''} Payroll budget vs trailing-12, by property`;
  ws.getCell(1, 1).font = { size: 12, bold: true };
  const heads = ['Property', `${year || ''} Budget`, 'T12 Actuals', 'Difference', '% change', '', 'Largest increase', '$', 'Largest decrease', '$'];
  heads.forEach((h, i) => {
    if (!h) return;
    const c = ws.getCell(3, i + 1);
    c.value = h; c.font = f8b; c.alignment = { horizontal: i >= 1 && i <= 4 || i === 7 || i === 9 ? 'right' : 'left' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
    c.border = { bottom: { style: 'thin' } };
  });
  let r = 4;
  const first = r;
  for (const { site, info } of infos) {
    const S = `'${info.name}'!`;
    const bud = r2(info.rows.reduce((a, x) => a + x.budget, 0)), t12 = r2(info.rows.reduce((a, x) => a + x.t12, 0));
    const movers = info.rows.map((x) => ({ ...x, diff: r2(x.budget - x.t12) }));
    const up = movers.reduce((m, x) => (x.diff > (m?.diff ?? -Infinity) ? x : m), null as any);
    const dn = movers.reduce((m, x) => (x.diff < (m?.diff ?? Infinity) ? x : m), null as any);
    const rng = (col: string) => `${S}$${col}$${info.firstRow}:$${col}$${info.lastRow}`;
    ws.getCell(r, 1).value = site.propertyCode.toUpperCase(); ws.getCell(r, 1).font = f8b;
    const put = (col: number, formula: string, result: any, fmt = ACCT, bold = false) => { const c = ws.getCell(r, col); c.value = { formula, result } as any; c.numFmt = fmt; c.font = bold ? f8b : f8; };
    put(2, `${S}$O$${info.totalRow}`, bud);
    put(3, `${S}$P$${info.totalRow}`, t12);
    put(4, `B${r}-C${r}`, r2(bud - t12));
    put(5, `IF(C${r}<>0,D${r}/C${r},"")`, t12 ? r2((bud - t12) / t12 * 10000) / 10000 : '', PCT);
    put(7, `INDEX(${rng('B')},MATCH(MAX(${rng('R')}),${rng('R')},0))`, up ? '    ' + up.name : '', '@');
    put(8, `MAX(${rng('R')})`, up?.diff ?? 0);
    put(9, `INDEX(${rng('B')},MATCH(MIN(${rng('R')}),${rng('R')},0))`, dn ? '    ' + dn.name : '', '@');
    put(10, `MIN(${rng('R')})`, dn?.diff ?? 0);
    r++;
  }
  const last = r - 1;
  ws.getCell(r, 1).value = 'TOTAL'; ws.getCell(r, 1).font = f8b;
  const bud = r2(infos.reduce((a, { info }) => a + info.rows.reduce((b, x) => b + x.budget, 0), 0));
  const t12 = r2(infos.reduce((a, { info }) => a + info.rows.reduce((b, x) => b + x.t12, 0), 0));
  const tot = (col: number, formula: string, result: any, fmt = ACCT) => { const c = ws.getCell(r, col); c.value = { formula, result } as any; c.numFmt = fmt; c.font = f8b; c.border = { top: { style: 'thin' }, bottom: { style: 'thin' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAND } }; };
  tot(2, `SUM(B${first}:B${last})`, bud); tot(3, `SUM(C${first}:C${last})`, t12); tot(4, `B${r}-C${r}`, r2(bud - t12));
  tot(5, `IF(C${r}<>0,D${r}/C${r},"")`, t12 ? r2((bud - t12) / t12 * 10000) / 10000 : '', PCT);
}
