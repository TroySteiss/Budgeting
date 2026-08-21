/* Parsers for the four upload formats. All label-driven (never fixed row
   numbers — the Cottonwood UW sheet is offset +20 rows vs its siblings). */
import * as XLSX from 'xlsx';
import type { UwSnapshotData } from '../shared/domain.js';

type Grid = any[][];

function grids(buf: Buffer): { name: string; g: Grid }[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map((name) => ({
    name,
    g: XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, raw: true, defval: null }) as Grid,
  }));
}

const s = (v: any): string => (v == null ? '' : String(v).trim());
const low = (v: any): string => s(v).toLowerCase();
const num = (v: any): number => {
  if (typeof v === 'number') return v;
  const n = parseFloat(s(v).replace(/[$,%\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/* ========================= UW BOOK MODEL ========================= */

export interface UwParsedSheet {
  sheetName: string;
  isPortfolio: boolean;
  propertyGuess: string;
  data: UwSnapshotData;
}

/** Row-label → pcode/measure map for the pro forma panel (col B labels). */
const UW_ROWS: { key: string; match: (l: string) => boolean }[] = [
  { key: '1', match: (l) => l.startsWith('gross potential rent') },
  { key: 'loss', match: (l) => l.includes('loss to lease') },
  { key: '2', match: (l) => l.includes('concessions') },
  { key: '3', match: (l) => l.startsWith('rental loss') },
  { key: '4', match: (l) => l.includes('utility income') },
  { key: '5', match: (l) => l.includes('other income') },
  { key: 'egi', match: (l) => l.startsWith('effective gross income') },
  { key: '6', match: (l) => l === 'insurance' },
  { key: '7', match: (l) => l.startsWith('professional management') },
  { key: '8', match: (l) => l.startsWith('re taxes') || l.includes('pp taxes') },
  { key: '9', match: (l) => l.startsWith('administrative') },
  { key: '10', match: (l) => l.startsWith('payroll') },
  { key: '11', match: (l) => l === 'marketing' },
  { key: '12', match: (l) => l === 'utilities' },
  { key: '13', match: (l) => l.startsWith('repairs') },
  { key: '14', match: (l) => l.startsWith('capital imp') || l.includes('reserve for rep') },
  { key: 'toe', match: (l) => l.startsWith('total operating expenses') },
  { key: 'noi', match: (l) => l.startsWith('net operating income') },
];

export function parseUwBook(buf: Buffer): UwParsedSheet[] {
  const out: UwParsedSheet[] = [];
  for (const { name, g } of grids(buf)) {
    if (/^(gl codes|taxes|fee breakdown)$/i.test(name.trim())) continue;
    // find the pro forma anchor
    let gprRow = -1;
    for (let r = 0; r < Math.min(g.length, 120); r++) {
      if (low(g[r]?.[1]).startsWith('gross potential rent')) { gprRow = r; break; }
    }
    if (gprRow < 0) continue;

    const found: Record<string, { row: number; y1: number; t12: number; assumption: number }> = {};
    for (let r = gprRow - 2; r < Math.min(g.length, gprRow + 60); r++) {
      const label = low(g[r]?.[1]);
      if (!label) continue;
      for (const def of UW_ROWS) {
        if (found[def.key]) continue;
        // expense labels only match below EGI (utilities vs utility income, insurance, marketing)
        const isExpenseKey = !['1', 'loss', '2', '3', '4', '5', 'egi'].includes(def.key);
        if (isExpenseKey && !found['egi']) continue;
        if (def.match(label)) {
          found[def.key] = { row: r, y1: num(g[r]?.[7]), t12: num(g[r]?.[3]), assumption: num(g[r]?.[11]) };
          break;
        }
      }
    }
    if (!found['noi'] || !found['egi']) continue;

    // unit mix: rows between "UNIT MIX" and "Total/Average"
    let units = 0;
    const unitMix: { plan: string; units: number; sqft: number; street: number }[] = [];
    let mixStart = -1, totalRow = -1;
    for (let r = 0; r < gprRow; r++) {
      const b = low(g[r]?.[1]);
      const a = low(g[r]?.[0]);
      if (mixStart < 0 && (b.includes('unit mix') || a.includes('unit mix'))) mixStart = r + 1;
      if (b.startsWith('total/average') || b.startsWith('total / average')) { totalRow = r; break; }
    }
    if (totalRow > 0) {
      units = Math.round(num(g[totalRow]?.[2]));
      if (mixStart > 0) {
        for (let r = mixStart; r < totalRow; r++) {
          const plan = s(g[r]?.[1]);
          const u = num(g[r]?.[2]);
          if (plan && u > 0) unitMix.push({ plan, units: Math.round(u), sqft: num(g[r]?.[3]), street: num(g[r]?.[6]) });
        }
      }
    }

    // T12 panel: GL rows in cols AL..BB (37..53); pcode in col BA (52), T12 total AZ (51)
    const t12: { gl: string; name: string; total: number; pcode: string }[] = [];
    for (let r = 0; r < g.length; r++) {
      const gl = s(g[r]?.[37]);
      if (!/^\d{6}-\d{3}$/.test(gl)) continue;
      const pcode = s(g[r]?.[52]).toLowerCase();
      if (!pcode) continue;
      t12.push({ gl, name: s(g[r]?.[38]), total: num(g[r]?.[51]), pcode });
    }

    // years 2..6 for key rows (cols N,Q,S,U,W = 13,16,18,20,22)
    const years: Record<string, Record<string, number>> = {};
    const yearCols: [string, number][] = [['y2', 13], ['y3', 16], ['y4', 18], ['y5', 20], ['y6', 22]];
    for (const [yk, c] of yearCols) {
      years[yk] = {};
      for (const [k, v] of Object.entries(found)) years[yk][k] = num(g[v.row]?.[c]);
    }

    const y1: Record<string, number> = {};
    for (const [k, v] of Object.entries(found)) if (!['egi', 'toe', 'noi'].includes(k)) y1[k] = v.y1;

    const isPortfolio = g.slice(0, 12).some((row) => (row || []).some((c) => low(c).includes('portfolio')));
    const gpr1 = y1['1'] || 1;
    const data: UwSnapshotData = {
      sheetName: name,
      units,
      y1,
      years,
      egi: found['egi'].y1,
      toe: found['toe']?.y1 || 0,
      noi: found['noi'].y1,
      assumptions: {
        vacancyPct: found['3'] ? Math.abs(found['3'].assumption) || Math.abs(y1['3'] || 0) / gpr1 : 0.05,
        ltlPct: found['loss'] ? Math.abs(found['loss'].assumption) || Math.abs(y1['loss'] || 0) / gpr1 : 0,
        concPct: found['2'] ? Math.abs(found['2'].assumption) || Math.abs(y1['2'] || 0) / gpr1 : 0,
        mgmtPct: found['7'] ? found['7'].assumption || (found['egi'].y1 ? (y1['7'] || 0) / found['egi'].y1 : 0) : 0,
        gprAdjPct: found['1'] ? found['1'].assumption : 0,
        t12Gpr: found['1'] ? found['1'].t12 : 0,
      },
      unitMix,
      t12,
    };
    out.push({ sheetName: name, isPortfolio, propertyGuess: name.replace(/\s*-\s*(jt|bk)\s*$/i, '').trim(), data });
  }
  return out;
}

/* ========================= RENT ROLL ========================= */

export interface RentParsedProperty {
  code: string | null;      // yardi code when known (summary format)
  name: string;
  units: number;
  marketMonthly: number;
  inPlaceMonthly: number;
  occupiedUnits: number | null;
  asOf: string | null;
  source: 'summary' | 'unit_level';
  /** per-lease detail (unit-level rolls only): market, rent, lease end —
      powers the lease-level loss-to-lease burnoff */
  leases?: { m: number; r: number; e: string | null }[];
}

export function parseRentRoll(buf: Buffer): RentParsedProperty[] {
  const all = grids(buf);
  const g = all[0].g;

  // ---- Yardi multi-property summary ("Rent Roll" / "For Selected Properties") ----
  const isSummary = low(g[0]?.[0]) === 'rent roll' || all[0].name === 'Report1' && g.slice(0, 6).some((r) => low(r?.[0]).includes('for selected properties'));
  if (isSummary) {
    let asOf: string | null = null;
    for (const row of g.slice(0, 6)) {
      const m = s(row?.[0]).match(/as of\s*=\s*([\d/]+)/i);
      if (m) asOf = m[1];
    }
    // header row: first cell 'Property'
    let h = -1;
    for (let r = 0; r < Math.min(g.length, 12); r++) if (low(g[r]?.[0]) === 'property') { h = r; break; }
    if (h < 0) throw new Error('Summary rent roll: no "Property" header row found');
    // column positions by scanning header rows h..h+2
    const heads: string[] = [];
    const width = Math.max(...g.slice(h, h + 3).map((r) => (r || []).length));
    for (let c = 0; c < width; c++) {
      heads[c] = [g[h]?.[c], g[h + 1]?.[c], g[h + 2]?.[c]].map(low).filter(Boolean).join(' ');
    }
    const col = (want: string[]): number => heads.findIndex((hd) => want.every((w) => hd.includes(w)));
    const cUnits = col(['total', 'units']);
    const cMkt = heads.findIndex((hd) => hd.includes('market') && hd.includes('rent') && !hd.includes('average'));
    const cRes = heads.findIndex((hd) => hd.includes('resident') && hd.includes('rent') && !hd.includes('average'));
    const cName = col(['name']);
    const out: RentParsedProperty[] = [];
    for (let r = h + 1; r < g.length; r++) {
      const code = s(g[r]?.[0]);
      if (low(code) === 'total' || low(g[r]?.[cName]) === 'total') break;
      if (!code || !/^[a-z]{3,6}\d?$/i.test(code)) continue;
      out.push({
        code: code.toLowerCase(),
        name: s(g[r]?.[cName]),
        units: Math.round(num(g[r]?.[cUnits])),
        marketMonthly: num(g[r]?.[cMkt]),
        inPlaceMonthly: num(g[r]?.[cRes]),
        occupiedUnits: null,
        asOf,
        source: 'summary',
      });
    }
    if (!out.length) throw new Error('Summary rent roll: no property rows parsed');
    return out;
  }

  // ---- OneSite unit-level "RENT ROLL DETAIL" ----
  let h = -1;
  for (let r = 0; r < Math.min(g.length, 15); r++) {
    const cells = (g[r] || []).map(low);
    if (cells.includes('unit') && cells.some((c) => c.includes('market'))) { h = r; break; }
  }
  if (h < 0) throw new Error('Rent roll format not recognized (neither Yardi summary nor OneSite detail)');
  const heads = (g[h] || []).map(low);
  const cUnit = heads.indexOf('unit');
  const cStatus = heads.findIndex((c) => c.includes('status'));
  const cMkt = heads.findIndex((c) => c.includes('market'));
  const cLease = heads.findIndex((c) => c === 'lease rent' || c.includes('lease rent'));
  const cEnd = heads.findIndex((c) => c.includes('lease end'));
  let asOf: string | null = null;
  for (const row of g.slice(0, h)) {
    const m = s(row?.[0]).match(/as of date:\s*([\d/.-]+)/i);
    if (m) asOf = m[1];
  }
  const toIso = (v: any): string | null => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10); // excel serial
    const d = new Date(s(v).replace(/\s+\d{2}:\d{2}.*$/, ''));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  // one row per unit: prefer the current-lease row (market > 0); pending renewals carry market 0
  const perUnit = new Map<string, { market: number; lease: number; status: string; end: string | null }>();
  for (let r = h + 1; r < g.length; r++) {
    const unit = s(g[r]?.[cUnit]);
    if (!unit) continue;
    const market = num(g[r]?.[cMkt]);
    const lease = num(g[r]?.[cLease]);
    const status = low(g[r]?.[cStatus]);
    const end = cEnd >= 0 ? toIso(g[r]?.[cEnd]) : null;
    const prev = perUnit.get(unit);
    if (!prev || (prev.market <= 0 && market > 0)) perUnit.set(unit, { market, lease, status, end });
  }
  if (!perUnit.size) throw new Error('OneSite rent roll: no unit rows parsed');
  let market = 0, inPlace = 0, occ = 0;
  const leases: { m: number; r: number; e: string | null }[] = [];
  for (const u of perUnit.values()) {
    market += u.market;
    if (u.status.includes('occupied') || u.status.includes('notice')) {
      inPlace += u.lease;
      occ++;
      leases.push({ m: Math.round(u.market * 100) / 100, r: Math.round(u.lease * 100) / 100, e: u.end });
    }
  }
  return [{
    code: null,
    name: all[0].name,
    units: perUnit.size,
    marketMonthly: Math.round(market * 100) / 100,
    inPlaceMonthly: Math.round(inPlace * 100) / 100,
    occupiedUnits: occ,
    asOf,
    source: 'unit_level',
    leases,
  }];
}

/* ========================= ND PAYROLL MODEL ========================= */

/* Position → Monarch wage GL. Anything unrecognized lands in 6404 and is
   reported in unmappedPositions so the mapping can be extended. */
const POSITION_GL: [RegExp, string][] = [
  [/regional|lms|arm|bookkeep|office|leasing|apm|\bpm\b|manager|market/i, '6402'],
  [/ground|landscap/i, '6405'],
  [/rover/i, '6407'],
  [/supervisor|tech|housekeep|maint|janitor|porter/i, '6404'],
];

export interface PayrollModelParsed {
  label: string;
  /** property code (lowercase) → wage GL → allocated annual $ (aggregated). */
  properties: Record<string, Record<string, number>>;
  unmappedPositions: string[];
  employeeRows: number;
}

/** North Dakota Payroll workbook ('Wages' sheet): roster rows with per-property
    allocated annual wages. RESTRICTED-DATA GUARD: this parser aggregates to
    property totals by GL and returns ONLY those — no names, rates, or rows. */
export function parsePayrollModel(buf: Buffer): PayrollModelParsed {
  const all = grids(buf);
  const sheet = all.find((x) => /wages/i.test(x.name)) || all[0];
  const g = sheet.g;
  // header row: >=8 short uppercase property codes
  let h = -1;
  let cols: { c: number; code: string }[] = [];
  for (let r = 0; r < Math.min(g.length, 10); r++) {
    const found: { c: number; code: string }[] = [];
    for (let c = 1; c < (g[r] || []).length; c++) {
      const v = s(g[r]?.[c]);
      if (/^[A-Z]{4,6}$/.test(v) && !['MIMG', 'TOTAL', 'CHECK'].includes(v)) found.push({ c, code: v.toLowerCase() });
    }
    if (found.length >= 8) { h = r; cols = found; break; }
  }
  if (h < 0) throw new Error('Payroll model: property-code header row not found on the Wages sheet');
  const agg: Record<string, Record<string, number>> = {};
  const unmapped = new Set<string>();
  let employeeRows = 0;
  for (let r = h + 1; r < g.length; r++) {
    const position = s(g[r]?.[1]);
    if (!position || /count|check|total/i.test(position)) continue;
    const values = cols.map(({ c }) => num(g[r]?.[c]));
    if (!values.some((v) => v)) continue;
    employeeRows++;
    let gl = '';
    for (const [re, code] of POSITION_GL) if (re.test(position)) { gl = code; break; }
    if (!gl) { unmapped.add(position); gl = '6404'; }
    cols.forEach(({ code }, i) => {
      const v = values[i];
      if (!v) return;
      if (!agg[code]) agg[code] = {};
      agg[code][gl] = Math.round(((agg[code][gl] || 0) + v) * 100) / 100;
    });
  }
  if (!employeeRows) throw new Error('Payroll model: no roster rows parsed');
  return { label: s(g[0]?.[0]) || sheet.name, properties: agg, unmappedPositions: [...unmapped], employeeRows };
}

/* ========================= SELLER T12 STATEMENT ========================= */

export interface SellerT12Parsed {
  label: string;                 // e.g. "Deer Ridge (13880)"
  period: string;
  book: string;
  monthCal: number[];            // calendar month (1-12) for each of the 12 value columns
  rows: { gl: string; name: string; months: number[]; total: number }[];
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Seller 12-month statement export: rows = seller GLs (nnnnnn-nnn), cols = months.
    Skips -000 section headers and -999 subtotal rows — detail lines only. */
export function parseSellerT12(buf: Buffer): SellerT12Parsed {
  const g = grids(buf)[0].g;
  const label = s(g[0]?.[0]);
  let period = '', book = '';
  for (const row of g.slice(0, 6)) {
    const t = s(row?.[0]);
    if (/period\s*=/i.test(t)) period = t.replace(/.*period\s*=\s*/i, '').trim();
    if (/book\s*=/i.test(t)) book = t.replace(/.*book\s*=\s*/i, '').trim();
  }
  // month header row: >= 10 cells parsing as "Mon YYYY"
  let h = -1;
  let monthCols: number[] = [];
  let monthCal: number[] = [];
  for (let r = 0; r < Math.min(g.length, 10); r++) {
    const cols: number[] = [];
    const cal: number[] = [];
    for (let c = 1; c < (g[r] || []).length; c++) {
      const m = low(g[r]?.[c]).match(/^([a-z]{3})[a-z]*\s+\d{4}$/);
      if (m) {
        const mi = MONTH_NAMES.indexOf(m[1]);
        if (mi >= 0) { cols.push(c); cal.push(mi + 1); }
      }
    }
    if (cols.length >= 10) { h = r; monthCols = cols.slice(0, 12); monthCal = cal.slice(0, 12); break; }
  }
  if (h < 0) throw new Error('Seller T12: month header row not found');
  const totalCol = monthCols[monthCols.length - 1] + 1;
  const rows: SellerT12Parsed['rows'] = [];
  for (let r = h + 1; r < g.length; r++) {
    const gl = s(g[r]?.[0]);
    if (!/^\d{6}-\d{3}$/.test(gl)) continue;
    if (gl.endsWith('-999') || gl.endsWith('-000')) continue;   // subtotals / section headers
    const months = monthCols.map((c) => num(g[r]?.[c]));
    if (!months.some((v) => v)) continue;
    rows.push({ gl, name: s(g[r]?.[1]), months, total: num(g[r]?.[totalCol]) });
  }
  if (!rows.length) throw new Error('Seller T12: no detail GL rows parsed');
  return { label, period, book, monthCal, rows };
}

/* ========================= PROPERTY COMPARISON ========================= */

export interface ComparisonParsed {
  label: string;
  period: string;
  book: string;
  properties: string[];                       // yardi codes (annual comparison) or [label] (monthly budget)
  rows: { gl: string; name: string; values: number[]; total: number; months?: number[] }[];
  monthly?: boolean;                          // true = 12-month budget export (per-GL monthly shapes available)
  monthCal?: number[];
}

/** Comp-set upload: either a Property Comparison (per-property annual columns)
    or a 12 Month Budget export (monthly columns, Monarch GLs). Auto-detected. */
export function parseComparison(buf: Buffer): ComparisonParsed {
  const g = grids(buf)[0].g;
  const label = s(g[0]?.[0]);
  let period = '', book = '';
  for (const row of g.slice(0, 5)) {
    const t = s(row?.[0]);
    if (/period\s*=/i.test(t)) period = t.replace(/.*period\s*=\s*/i, '').trim();
    if (/book\s*=/i.test(t)) book = t.replace(/.*book\s*=\s*/i, '').split(';')[0].trim();
  }
  // 12-month variant: a header row of >=10 "Mon YYYY" cells
  for (let r = 0; r < Math.min(g.length, 10); r++) {
    const cols: number[] = [];
    const cal: number[] = [];
    for (let c = 1; c < (g[r] || []).length; c++) {
      const m = low(g[r]?.[c]).match(/^([a-z]{3})[a-z]*\s+\d{4}$/);
      if (m) {
        const mi = MONTH_NAMES.indexOf(m[1]);
        if (mi >= 0) { cols.push(c); cal.push(mi + 1); }
      }
    }
    if (cols.length >= 10) {
      const monthCols = cols.slice(0, 12);
      const totalCol = monthCols[monthCols.length - 1] + 1;
      const rows: ComparisonParsed['rows'] = [];
      for (let rr = r + 1; rr < g.length; rr++) {
        const gl = s(g[rr]?.[0]);
        if (!/^\d{3,4}$/.test(gl)) continue;
        const months = monthCols.map((c) => num(g[rr]?.[c]));
        if (!months.some((v) => v)) continue;
        const total = num(g[rr]?.[totalCol]) || months.reduce((a, b) => a + b, 0);
        rows.push({ gl, name: s(g[rr]?.[1]), values: [total], total, months });
      }
      if (!rows.length) throw new Error('12 Month Budget: no GL rows parsed');
      return { label, period, book, properties: [label], rows, monthly: true, monthCal: cal.slice(0, 12) };
    }
  }
  // property-code header row: >=2 short lowercase codes from col C on
  let h = -1;
  let codes: { c: number; code: string }[] = [];
  for (let r = 0; r < Math.min(g.length, 10); r++) {
    const found: { c: number; code: string }[] = [];
    for (let c = 2; c < (g[r] || []).length; c++) {
      const v = s(g[r]?.[c]);
      if (/^[a-z]{3,6}\d?$/i.test(v) && low(v) !== 'total') found.push({ c, code: v.toLowerCase() });
    }
    if (found.length >= 2) { h = r; codes = found; break; }
  }
  if (h < 0) throw new Error('Property Comparison: property-code header row not found');
  // Total column: header cell 'Total' on the same or next row
  let totalCol = -1;
  for (let c = 2; c < Math.max((g[h] || []).length, (g[h + 1] || []).length); c++) {
    if (low(g[h]?.[c]) === 'total' || low(g[h + 1]?.[c]) === 'total') totalCol = c;
  }
  const rows: ComparisonParsed['rows'] = [];
  for (let r = h + 1; r < g.length; r++) {
    const gl = s(g[r]?.[0]);
    if (!/^\d{3,4}$/.test(gl)) continue;
    const values = codes.map(({ c }) => num(g[r]?.[c]));
    const total = totalCol >= 0 ? num(g[r]?.[totalCol]) : values.reduce((a, b) => a + b, 0);
    rows.push({ gl, name: s(g[r]?.[1]), values, total });
  }
  if (!rows.length) throw new Error('Property Comparison: no GL rows parsed');
  return { label, period, book, properties: codes.map((x) => x.code), rows };
}
