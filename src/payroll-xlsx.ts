/* Excel round trip for the pay-rates tab.
   EXPORT: one region-iteration as a workbook — a Raises sheet that mirrors the
   tab (each person once, grouped by primary site, live formulas for new rate /
   deltas / totals — org rule: show the work) plus a Raw Data sheet with every
   seat-allocation. The caller passes rows ALREADY viewer-scoped and RM-masked;
   nothing here widens access.
   IMPORT: reads Raise % by person Key back out of any sheet with those two
   columns, so an RM can fill the exported file and load it back. */
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { marginalBurdenPct } from '../shared/payroll.js';

export interface RaiseExportRow {
  key: string;
  name: string;
  position: string;
  groupLabel: string;        // the workbook's section ("Bismarck 4", …) — rows arrive sorted by it
  primCode: string;          // primary site (largest allocation in the region)
  primPct: number;           // 0..1
  splitNote: string;         // '' or the other sites
  payMethod: string;         // Hourly | Salary
  payRate: number | null;    // null = masked RM seat
  regionMoCur: number | null;// monthly wages across the region at the current rate
  raisePct: number;
  by: string;
  at: string;
  rm: boolean;
}

export interface RaiseExportArgs {
  cycleLabel: string;
  effective: string;
  region: string;
  iterNum: number;
  finalized: { by: string; at: string } | null;
  exportedBy: string;
  rows: RaiseExportRow[];    // sorted: primary site, position, name
  hidden: { curMo: number; newMo: number } | null;  // masked-RM region aggregate (masked viewers)
  allocations: { key: string; name: string; position: string; payMethod: string; payRate: number | null; monthlyBenefits: number | null; status: string; startDate: string | null; code: string; pct: number }[];
}

const CUR2 = '"$"#,##0.00_);[Red]("$"#,##0.00)';
const CUR0 = '"$"#,##0_);[Red]("$"#,##0)';
const INPUT = 'FFE2EFDA';   // the budget workbook's light-green input fill
const GRP = 'FFF2F2F2';
const TOT = 'FFE3EBF7';

export async function buildRaiseWorkbook(a: RaiseExportArgs): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Raises', { views: [{ state: 'frozen', ySplit: 5 }], properties: { tabColor: { argb: 'FF50645E' } } });
  ws.columns = [
    { header: '', width: 14 },  // A key
    { header: '', width: 24 },  // B position
    { header: '', width: 22 },  // C employee
    { header: '', width: 16 },  // D based at
    { header: '', width: 30 },  // E split
    { header: '', width: 8 },   // F type
    { header: '', width: 12 },  // G current rate
    { header: '', width: 13 },  // H wages/mo (region)
    { header: '', width: 9 },   // I burden %
    { header: '', width: 9 },   // J RAISE %
    { header: '', width: 12 },  // K new rate
    { header: '', width: 12 },  // L Δ wages/mo
    { header: '', width: 13 },  // M Δ burdened/yr
    { header: '', width: 22 },  // N last edit
  ];
  ws.getCell('A1').value = `${a.cycleLabel} — ${a.region} — Iteration ${a.iterNum}`;
  ws.getCell('A1').font = { bold: true, size: 13 };
  ws.getCell('A2').value = `Raises effective ${a.effective} · ${a.finalized ? `FINALIZED by ${a.finalized.by} ${a.finalized.at.slice(0, 10)} (read-only)` : 'draft'} · exported by ${a.exportedBy} ${new Date().toISOString().slice(0, 10)}`;
  ws.getCell('A2').font = { size: 9, color: { argb: 'FF696A6A' } };
  ws.getCell('A3').value = 'Type raise %s into the green column, save, and import the file back on the Payroll tab. Keep column A (Key) — it is how rows match. New rate / deltas / totals are live formulas.';
  ws.getCell('A3').font = { size: 9, italic: true, color: { argb: 'FF696A6A' } };

  const head = ['Key', 'Position', 'Employee', 'Based at', 'Also allocated', 'Type', 'Current rate', 'Wages/mo (region)', 'Burden est.', 'Raise %', 'New rate', 'Δ wages/mo', 'Δ burdened/yr', 'Last edit'];
  const hr = ws.getRow(5);
  head.forEach((t, i) => { const c = hr.getCell(i + 1); c.value = t; c.font = { bold: true, size: 9 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRP } }; });

  let r = 6;
  const dataRows: number[] = [];
  let totH = 0, totL = 0, totM = 0;
  let lastGroup = '';
  for (const row of a.rows) {
    if (row.groupLabel !== lastGroup) {
      lastGroup = row.groupLabel;
      const g = ws.getRow(r);
      g.getCell(2).value = row.groupLabel;
      g.getCell(2).font = { bold: true, size: 9 };
      for (let c = 1; c <= 14; c++) g.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRP } };
      r++;
    }
    const x = ws.getRow(r);
    x.getCell(1).value = row.key;
    x.getCell(1).font = { size: 8, color: { argb: 'FFA8A39B' } };
    x.getCell(2).value = row.position;
    x.getCell(3).value = row.name;
    x.getCell(4).value = `${row.primCode.toUpperCase()} ${Math.round(row.primPct * 100)}%`;
    x.getCell(5).value = row.splitNote;
    x.getCell(5).font = { size: 8, color: { argb: 'FF696A6A' } };
    x.getCell(6).value = row.payMethod;
    if (row.payRate == null) {
      x.getCell(7).value = '•••'; x.getCell(8).value = '•••'; x.getCell(11).value = 'TS/RC only';
      x.getCell(11).font = { size: 8, color: { argb: 'FF696A6A' } };
    } else {
      x.getCell(7).value = row.payRate;
      x.getCell(7).numFmt = row.payMethod === 'Hourly' ? CUR2 : CUR0;
      x.getCell(8).value = Math.round((row.regionMoCur || 0) * 100) / 100;
      x.getCell(8).numFmt = CUR0;
      x.getCell(9).value = marginalBurdenPct(row.position);
      x.getCell(9).numFmt = '0.0%';
      x.getCell(10).value = row.raisePct;
      x.getCell(11).value = { formula: `G${r}*(1+J${r}/100)`, result: row.payRate * (1 + row.raisePct / 100) };
      x.getCell(11).numFmt = row.payMethod === 'Hourly' ? CUR2 : CUR0;
      x.getCell(12).value = { formula: `H${r}*J${r}/100`, result: Math.round((row.regionMoCur || 0) * row.raisePct) / 100 };
      x.getCell(12).numFmt = CUR0;
      x.getCell(13).value = { formula: `L${r}*12*(1+I${r})`, result: ((row.regionMoCur || 0) * row.raisePct / 100) * 12 * (1 + marginalBurdenPct(row.position)) };
      x.getCell(13).numFmt = CUR0;
      totH += row.regionMoCur || 0;
      totL += (row.regionMoCur || 0) * row.raisePct / 100;
      totM += ((row.regionMoCur || 0) * row.raisePct / 100) * 12 * (1 + marginalBurdenPct(row.position));
      dataRows.push(r);
    }
    x.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INPUT } };
    x.getCell(14).value = row.by ? `${row.by} · ${String(row.at).slice(0, 10)}` : '';
    x.getCell(14).font = { size: 8, color: { argb: 'FF696A6A' } };
    r++;
  }
  if (a.hidden) {
    const x = ws.getRow(r);
    x.getCell(2).value = 'Masked RM allocations (aggregate)';
    x.getCell(2).font = { italic: true, size: 9 };
    x.getCell(8).value = a.hidden.curMo; x.getCell(8).numFmt = CUR0;
    x.getCell(12).value = Math.round((a.hidden.newMo - a.hidden.curMo) * 100) / 100; x.getCell(12).numFmt = CUR0;
    totH += a.hidden.curMo;
    totL += a.hidden.newMo - a.hidden.curMo;
    totM += (a.hidden.newMo - a.hidden.curMo) * 12 * 1.0945;
    dataRows.push(r);
    r++;
  }
  const t = ws.getRow(r);
  t.getCell(2).value = `${a.region} total`;
  t.font = { bold: true };
  const sumOf = (col: string) => dataRows.length ? `SUM(${dataRows.map((n) => `${col}${n}`).join(',')})` : '0';
  t.getCell(8).value = { formula: sumOf('H'), result: Math.round(totH * 100) / 100 };
  t.getCell(12).value = { formula: sumOf('L'), result: Math.round(totL * 100) / 100 };
  t.getCell(13).value = { formula: sumOf('M'), result: Math.round(totM * 100) / 100 };
  [8, 12, 13].forEach((c) => { t.getCell(c).numFmt = CUR0; });
  for (let c = 1; c <= 14; c++) t.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOT } };

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

/** Pull {key, pct} pairs out of any sheet that has Key and Raise % columns —
    the exported Raises sheet, or anything hand-built with those two headers.
    Values only (formulas read as their cached results); blanks are skipped. */
export function parseRaiseImport(buf: Buffer): { key: string; pct: number }[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  for (const name of wb.SheetNames) {
    const g = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, raw: true, defval: null }) as any[][];
    for (let r = 0; r < Math.min(g.length, 12); r++) {
      const hdr = (g[r] || []).map(normHdr);
      const keyCol = hdr.indexOf('key');
      const pctCol = hdr.findIndex((h) => h === 'raise%' || h === 'raisepct' || h === 'raisepercent' || h.startsWith('raise%'));
      if (keyCol < 0 || pctCol < 0) continue;
      const out: { key: string; pct: number }[] = [];
      for (let i = r + 1; i < g.length; i++) {
        const key = g[i]?.[keyCol] == null ? '' : String(g[i][keyCol]).trim();
        const pct = typeof g[i]?.[pctCol] === 'number' ? g[i][pctCol] : parseFloat(String(g[i]?.[pctCol] ?? ''));
        if (!key || !Number.isFinite(pct)) continue;
        out.push({ key, pct });
      }
      if (out.length) return out;
    }
  }
  throw new Error('No sheet with "Key" and "Raise %" columns found — import the exported Raises workbook (keep column A)');
}
