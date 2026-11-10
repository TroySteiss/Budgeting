/* Excel round trip for the pay-rates tab — formatted to match Troy's own
   draft workbook (2026-11-02): ONE SHEET PER RM (named by first name, holding
   the region(s) that RM covers), a Combined sheet whose Raise % cells
   reference the RM sheets, and Raw Data. Raise % is the only input (green);
   New rate MROUNDs hourly rates to 25¢, Adj % shows the effective raise after
   rounding, Δs and annual wages are live formulas, and every totals row uses
   the WEIGHTED-average increase (Δ wages ÷ wages — weights fall out of the
   algebra). RM pay is masked in every file; masked slices ride as per-region
   aggregate rows so the totals reconcile. */
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { marginalBurdenPct, newRate, adjustedPct, RATE_MROUND } from '../shared/payroll.js';

export interface RaiseExportRow {
  key: string;
  name: string;
  position: string;
  region: string;            // home region — decides the sheet + regional totals
  groupLabel: string;        // the workbook's section ("Bismarck 4", …)
  primCode: string;
  primPct: number;
  splitNote: string;
  payMethod: string;         // Hourly | Salary
  payRate: number | null;    // null = masked RM seat
  regionMoCur: number | null;
  raisePct: number;
  by: string;
  at: string;
  rm: boolean;
}

export interface RaiseSheetSpec { name: string; regions: string[] }

export interface RaiseExportArgs {
  cycleLabel: string;
  effective: string;
  title: string;
  exportedBy: string;
  sheets: RaiseSheetSpec[];                                   // per-RM sheets, in order
  rows: RaiseExportRow[];                                     // ALL rows, pre-sorted (region block → section → ord)
  hiddenByRegion: Record<string, { curMo: number; newMo: number }>;
  combined: boolean;                                          // add the Combined sheet
  allocations: { key: string; name: string; position: string; payMethod: string; payRate: number | null; monthlyBenefits: number | null; status: string; startDate: string | null; code: string; pct: number }[];
}

/* Columns — A..K match Troy's draft exactly (Raise % stays the J input);
   L.. are the additions he asked for. */
const COLS = ['Key', 'Position', 'Employee', 'Based at', 'Also allocated', 'Type', 'Current rate', 'Wages/mo (region)', 'Burden est.', 'Raise %', 'New rate', 'Adj %', 'Δ wages/mo', 'Δ burdened/yr', 'Annual wages', 'New annual', 'Last edit'];
const C = { key: 1, pos: 2, emp: 3, based: 4, also: 5, type: 6, rate: 7, mo: 8, burden: 9, raise: 10, newRate: 11, adj: 12, dMo: 13, dYr: 14, annual: 15, newAnnual: 16, edit: 17 };
const L = (c: number): string => String.fromCharCode(64 + c);   // 1..17 → A..Q
const CUR2 = '"$"#,##0.00_);[Red]("$"#,##0.00)';
const CUR0 = '"$"#,##0_);[Red]("$"#,##0)';
const PCT2 = '0.00%';
const INPUT = 'FFE2EFDA';
const GRP = 'FFF2F2F2';
const SUBT = 'FFEEF1F0';
const TOT = 'FFE3EBF7';

interface Placed { sheet: string; row: number }

export async function buildRaiseWorkbook(a: RaiseExportArgs): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const placed = new Map<string, Placed>();   // key → its input cell's home (for Combined cross-refs)

  const headerArea = (ws: ExcelJS.Worksheet) => {
    ws.columns = [{ width: 14 }, { width: 24 }, { width: 22 }, { width: 16 }, { width: 30 }, { width: 8 }, { width: 12 }, { width: 13 }, { width: 9 }, { width: 9 }, { width: 12 }, { width: 9 }, { width: 12 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 22 }];
    ws.getCell('B1').value = a.title;
    ws.getCell('B1').font = { bold: true, size: 13 };
    ws.getCell('B2').value = `Raises effective ${a.effective} · exported by ${a.exportedBy} ${new Date().toISOString().slice(0, 10)}`;
    ws.getCell('B2').font = { size: 9, color: { argb: 'FF696A6A' } };
    ws.getCell('B3').value = `Type raise %s into the green column and import the file back on the Payroll tab (keep column A). Hourly new rates round to the nearest $${RATE_MROUND.toFixed(2)}; Adj % is the raise actually paid after rounding.`;
    ws.getCell('B3').font = { size: 9, italic: true, color: { argb: 'FF696A6A' } };
    const hr = ws.getRow(5);
    COLS.forEach((t, i) => { const c = hr.getCell(i + 1); c.value = t; c.font = { bold: true, size: 9 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRP } }; });
    ws.views = [{ state: 'frozen', ySplit: 5 }];
  };

  /* One data row. `raiseCell` = value (RM sheets) or a cross-sheet formula
     (Combined). Returns true when the row carries money (joins the SUMs). */
  const dataRow = (ws: ExcelJS.Worksheet, r: number, row: RaiseExportRow, raiseRef: string | null): boolean => {
    const x = ws.getRow(r);
    x.getCell(C.key).value = row.key;
    x.getCell(C.key).font = { size: 8, color: { argb: 'FFA8A39B' } };
    x.getCell(C.pos).value = row.position;
    x.getCell(C.emp).value = row.name;
    x.getCell(C.based).value = `${row.primCode.toUpperCase()} ${Math.round(row.primPct * 100)}%`;
    x.getCell(C.also).value = row.splitNote;
    x.getCell(C.also).font = { size: 8, color: { argb: 'FF696A6A' } };
    x.getCell(C.type).value = row.payMethod;
    x.getCell(C.edit).value = row.by ? `${row.by} · ${String(row.at).slice(0, 10)}` : '';
    x.getCell(C.edit).font = { size: 8, color: { argb: 'FF696A6A' } };
    if (row.payRate == null) {
      x.getCell(C.rate).value = '•••'; x.getCell(C.mo).value = '•••';
      x.getCell(C.newRate).value = 'TS/RC only';
      x.getCell(C.newRate).font = { size: 8, color: { argb: 'FF696A6A' } };
      x.getCell(C.raise).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRP } };
      return false;
    }
    const rateFmt = row.payMethod === 'Hourly' ? CUR2 : CUR0;
    x.getCell(C.rate).value = row.payRate;
    x.getCell(C.rate).numFmt = rateFmt;
    x.getCell(C.mo).value = Math.round((row.regionMoCur || 0) * 100) / 100;
    x.getCell(C.mo).numFmt = CUR0;
    x.getCell(C.burden).value = marginalBurdenPct(row.position);
    x.getCell(C.burden).numFmt = '0.0%';
    if (raiseRef) x.getCell(C.raise).value = { formula: raiseRef, result: row.raisePct };
    else x.getCell(C.raise).value = row.raisePct;
    x.getCell(C.raise).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INPUT } };
    const nr = newRate(row.payMethod, row.payRate, row.raisePct);
    const adj = adjustedPct(row.payMethod, row.payRate, row.raisePct);
    const mo = row.regionMoCur || 0;
    x.getCell(C.newRate).value = {
      formula: row.payMethod === 'Hourly' ? `MROUND(${L(C.rate)}${r}*(1+${L(C.raise)}${r}/100),${RATE_MROUND})` : `${L(C.rate)}${r}*(1+${L(C.raise)}${r}/100)`,
      result: nr,
    };
    x.getCell(C.newRate).numFmt = rateFmt;
    x.getCell(C.adj).value = { formula: `${L(C.newRate)}${r}/${L(C.rate)}${r}-1`, result: adj };
    x.getCell(C.adj).numFmt = PCT2;
    x.getCell(C.dMo).value = { formula: `${L(C.mo)}${r}*${L(C.adj)}${r}`, result: Math.round(mo * adj * 100) / 100 };
    x.getCell(C.dMo).numFmt = CUR0;
    x.getCell(C.dYr).value = { formula: `${L(C.dMo)}${r}*12*(1+${L(C.burden)}${r})`, result: Math.round(mo * adj * 12 * (1 + marginalBurdenPct(row.position)) * 100) / 100 };
    x.getCell(C.dYr).numFmt = CUR0;
    x.getCell(C.annual).value = { formula: `${L(C.mo)}${r}*12`, result: Math.round(mo * 12 * 100) / 100 };
    x.getCell(C.annual).numFmt = CUR0;
    x.getCell(C.newAnnual).value = { formula: `${L(C.annual)}${r}+${L(C.dMo)}${r}*12`, result: Math.round((mo * 12 + mo * adj * 12) * 100) / 100 };
    x.getCell(C.newAnnual).numFmt = CUR0;
    return true;
  };

  const maskedAggRow = (ws: ExcelJS.Worksheet, r: number, region: string, hid: { curMo: number; newMo: number }): void => {
    const x = ws.getRow(r);
    x.getCell(C.pos).value = `${region} — masked RM allocations (aggregate)`;
    x.getCell(C.pos).font = { italic: true, size: 9 };
    const d = hid.newMo - hid.curMo;
    x.getCell(C.mo).value = hid.curMo;
    x.getCell(C.dMo).value = Math.round(d * 100) / 100;
    x.getCell(C.dYr).value = Math.round(d * 12 * 1.0945 * 100) / 100;
    x.getCell(C.annual).value = Math.round(hid.curMo * 12 * 100) / 100;
    x.getCell(C.newAnnual).value = Math.round(hid.newMo * 12 * 100) / 100;
    [C.mo, C.dMo, C.dYr, C.annual, C.newAnnual].forEach((c) => { x.getCell(c).numFmt = CUR0; });
  };

  /* Totals row over an explicit list of money rows; the increase shown is the
     WEIGHTED average (Σ Δ wages ÷ Σ wages — each person weighted by pay).
     Every formula carries a cached result so the file previews before Excel
     recalculates. */
  const sumCache = (ws: ExcelJS.Worksheet, col: number, rowsList: number[]): number =>
    Math.round(rowsList.reduce((s, n) => {
      const v = ws.getRow(n).getCell(col).value as any;
      return s + (typeof v === 'number' ? v : (v && typeof v.result === 'number' ? v.result : 0));
    }, 0) * 100) / 100;
  const totalsRow = (ws: ExcelJS.Worksheet, r: number, label: string, moneyRows: number[], fill: string): void => {
    const x = ws.getRow(r);
    x.getCell(C.pos).value = label;
    x.font = { bold: true };
    const list = (c: number) => moneyRows.length ? `SUM(${moneyRows.map((n) => `${L(c)}${n}`).join(',')})` : '0';
    for (const c of [C.mo, C.dMo, C.dYr, C.annual, C.newAnnual]) {
      x.getCell(c).value = { formula: list(c), result: sumCache(ws, c, moneyRows) };
      x.getCell(c).numFmt = CUR0;
    }
    const moTot = sumCache(ws, C.mo, moneyRows);
    x.getCell(C.adj).value = { formula: moneyRows.length ? `${L(C.dMo)}${r}/${L(C.mo)}${r}` : '0', result: moTot ? sumCache(ws, C.dMo, moneyRows) / moTot : 0 };
    x.getCell(C.adj).numFmt = PCT2;
    x.getCell(C.raise).value = 'wtd avg →';
    x.getCell(C.raise).font = { bold: false, size: 8, color: { argb: 'FF696A6A' } };
    for (let c = 1; c <= COLS.length; c++) x.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  };

  /* lay one scope (an RM sheet, or Combined) */
  const laySheet = (ws: ExcelJS.Worksheet, rows: RaiseExportRow[], regions: string[], opts: { crossRef: boolean; grandLabel: string }) => {
    headerArea(ws);
    let r = 6;
    const allMoney: number[] = [];
    for (const region of regions) {
      const regionRows = rows.filter((x) => x.region === region);
      if (!regionRows.length) continue;
      const regionMoney: number[] = [];
      let lastGroup = '';
      for (const row of regionRows) {
        if (row.groupLabel !== lastGroup) {
          lastGroup = row.groupLabel;
          const g = ws.getRow(r);
          g.getCell(C.pos).value = row.groupLabel;
          g.getCell(C.pos).font = { bold: true, size: 9 };
          for (let c = 1; c <= COLS.length; c++) g.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRP } };
          r++;
        }
        const ref = opts.crossRef && placed.has(row.key) ? `'${placed.get(row.key)!.sheet}'!${L(C.raise)}${placed.get(row.key)!.row}` : null;
        const money = dataRow(ws, r, row, ref);
        if (!opts.crossRef) placed.set(row.key, { sheet: ws.name, row: r });
        if (money) regionMoney.push(r);
        r++;
      }
      const hid = a.hiddenByRegion[region];
      if (hid && hid.curMo) { maskedAggRow(ws, r, region, hid); regionMoney.push(r); r++; }
      allMoney.push(...regionMoney);
      // regional totals — on Combined always; on an RM sheet when it spans regions
      if (opts.crossRef || regions.length > 1) { totalsRow(ws, r, `${region} total`, regionMoney, SUBT); r++; }
    }
    totalsRow(ws, r, opts.grandLabel, allMoney, TOT);
    // the weighted-average header cell above the input column (Troy's J4/K4)
    const moAll = sumCache(ws, C.mo, allMoney);
    ws.getCell(`${L(C.raise)}4`).value = { formula: `${L(C.adj)}${r}`, result: moAll ? sumCache(ws, C.dMo, allMoney) / moAll : 0 };
    ws.getCell(`${L(C.raise)}4`).numFmt = PCT2;
    ws.getCell(`${L(C.raise)}4`).font = { bold: true };
    ws.getCell(`${L(C.newRate)}4`).value = 'wtd avg increase';
    ws.getCell(`${L(C.newRate)}4`).font = { size: 9, color: { argb: 'FF696A6A' } };
  };

  // Combined sits FIRST like Troy's draft — ExcelJS orders sheets by creation,
  // so create it up front and fill it once the RM sheets' cells are placed
  const combinedWs = a.combined ? wb.addWorksheet('Combined', { properties: { tabColor: { argb: 'FFD59038' } } }) : null;
  for (const spec of a.sheets) {
    const ws = wb.addWorksheet(spec.name, { properties: { tabColor: { argb: 'FF50645E' } } });
    laySheet(ws, a.rows.filter((x) => spec.regions.includes(x.region)), spec.regions, { crossRef: false, grandLabel: `${spec.name} total` });
  }
  if (combinedWs) {
    laySheet(combinedWs, a.rows, a.sheets.flatMap((s) => s.regions), { crossRef: true, grandLabel: 'All regions total' });
  }

  // Raw Data — every seat-allocation (org rule: the work behind the formulas)
  const raw = wb.addWorksheet('Raw Data');
  raw.columns = [
    { header: 'Key', width: 14 }, { header: 'Employee', width: 22 }, { header: 'Position', width: 24 },
    { header: 'Pay method', width: 10 }, { header: 'Pay rate', width: 11 }, { header: 'Benefits/mo', width: 11 },
    { header: 'Status', width: 8 }, { header: 'Start date', width: 11 },
    { header: 'Property', width: 9 }, { header: 'Allocation %', width: 11 },
    { header: 'Raise % (this iteration)', width: 18 },
  ];
  raw.getRow(1).font = { bold: true, size: 9 };
  const raiseByKey = new Map(a.rows.map((x) => [x.key, x.raisePct]));
  for (const al of a.allocations) {
    raw.addRow([al.key, al.name, al.position, al.payMethod, al.payRate ?? '•••', al.monthlyBenefits ?? '•••', al.status, al.startDate || '', al.code.toUpperCase(), al.pct, raiseByKey.get(al.key) ?? 0]);
  }
  raw.getColumn(10).numFmt = '0.0%';

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ---------------- import ---------------- */
const normHdr = (v: any): string => (v == null ? '' : String(v)).toLowerCase().replace(/[^a-z%]/g, '');

/** Pull {key, pct} out of EVERY sheet with Key and Raise % columns — the per-RM sheets and
    Combined both qualify. Precedence per person: a Raise % TYPED on a sheet, then a raise
    worked back from a TYPED New rate, then a formula's cached Raise % (Combined mirrors the RM
    sheets). Blanks and text are skipped.

    Two rules added 2026-11-10 after the first real round of RM files (Troy):
    - **A zero is "not filled in", not "set to 0%".** Every exported workbook carries 0 for
      everyone, and each RM fills only their own sheet — so importing Gail's file after
      Brittanee's used to write Brittanee's people back to 0. Zeros are now left out (counted in
      `zeroSkipped`); to put someone back to 0%, type it in the app.
    - **A New rate typed over its formula is read as a raise**: when Raise % is 0 / blank and the
      New rate cell holds a typed number, raise % = New rate ÷ Current rate − 1 (4 decimals).
      The 25-cent rounding on hourly rates still applies when the raise is used, so an hourly
      rate typed off the quarter lands on the nearest one. Counted in `fromNewRate`. */
export function parseRaiseImportDetailed(buf: Buffer): { pairs: { key: string; pct: number }[]; zeroSkipped: number; fromNewRate: number } {
  const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true });
  const typed = new Map<string, number>();     // Raise % typed, non-zero
  const derived = new Map<string, number>();   // from a typed New rate
  const cached = new Map<string, number>();    // Raise % formula result, non-zero
  const seen = new Set<string>();
  let found = false;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    // locate the header row
    let hdrRow = -1, keyCol = -1, pctCol = -1, newCol = -1, curCol = -1;
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 11); r++) {
      let k = -1, p = -1, n = -1, cu = -1;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        const h = normHdr(cell ? cell.v : null);
        if (h === 'key') k = c;
        if (h === 'raise%' || h === 'raisepct' || h === 'raisepercent') p = c;
        if (h === 'newrate') n = c;
        if (h === 'currentrate') cu = c;
      }
      if (k >= 0 && p >= 0) { hdrRow = r; keyCol = k; pctCol = p; newCol = n; curCol = cu; break; }
    }
    if (hdrRow < 0) continue;
    found = true;
    for (let r = hdrRow + 1; r <= range.e.r; r++) {
      const kc = ws[XLSX.utils.encode_cell({ r, c: keyCol })];
      const pc = ws[XLSX.utils.encode_cell({ r, c: pctCol })];
      const key = kc && kc.v != null ? String(kc.v).trim() : '';
      if (!key) continue;
      seen.add(key);
      const pct = pc && typeof pc.v === 'number' ? pc.v : parseFloat(String(pc && pc.v != null ? pc.v : ''));
      if (Number.isFinite(pct) && pct !== 0) {
        if (pc && pc.f) { if (!cached.has(key)) cached.set(key, pct); }
        else typed.set(key, pct);
        continue;
      }
      // Raise % is 0 / blank: was the New rate typed over its formula?
      if (newCol >= 0 && curCol >= 0) {
        const nc = ws[XLSX.utils.encode_cell({ r, c: newCol })], cc = ws[XLSX.utils.encode_cell({ r, c: curCol })];
        if (nc && !nc.f && typeof nc.v === 'number' && cc && typeof cc.v === 'number' && cc.v > 0) {
          const d = Math.round((nc.v / cc.v - 1) * 100 * 10000) / 10000;
          if (Math.abs(d) >= 0.005) derived.set(key, d);
        }
      }
    }
  }
  if (!found) throw new Error('No sheet with "Key" and "Raise %" columns found — import the exported workbook (keep column A)');
  if (!seen.size) throw new Error('No raise rows found under the Key / Raise % headers');
  const out = new Map(cached);
  for (const [k, v] of derived) out.set(k, v);
  for (const [k, v] of typed) out.set(k, v);
  let fromNewRate = 0;
  for (const k of derived.keys()) if (!typed.has(k)) fromNewRate++;
  return { pairs: [...out.entries()].map(([key, pct]) => ({ key, pct })), zeroSkipped: [...seen].filter((k) => !out.has(k)).length, fromNewRate };
}
/** The {key, pct} pairs alone (see parseRaiseImportDetailed). */
export function parseRaiseImport(buf: Buffer): { key: string; pct: number }[] {
  return parseRaiseImportDetailed(buf).pairs;
}
