/* Parsers for the four upload formats. All label-driven (never fixed row
   numbers — the Cottonwood UW sheet is offset +20 rows vs its siblings). */
import * as XLSX from 'xlsx';
import type { UwSnapshotData } from '../shared/domain.js';
import type { TemplateData } from '../shared/annual.js';

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
  const allSheets = grids(buf);
  for (const { name, g } of allSheets) {
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

    // financing block (labels in the X..AB zone; row offsets vary by sheet)
    let loanAmount = 0, interestRate = 0, ltv = 0;
    for (let r = 0; r < g.length; r++) {
      for (let c = 20; c < Math.min((g[r] || []).length, 32); c++) {
        const lbl = low(g[r]?.[c]);
        if (!lbl) continue;
        const val = num(g[r]?.[c + 2]) || num(g[r]?.[c + 1]);
        if (!loanAmount && lbl.startsWith('loan amount')) loanAmount = val;
        else if (!interestRate && lbl.startsWith('interest rate')) interestRate = val;
        else if (!ltv && lbl.startsWith('loan to value')) ltv = val;
      }
    }

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
        loanAmount, interestRate, ltv,
      },
      unitMix,
      t12,
    };
    out.push({ sheetName: name, isPortfolio, propertyGuess: name.replace(/\s*-\s*(jt|bk)\s*$/i, '').trim(), data });
  }

  // Fee Breakdown sheet: per-property TRUE capital ("Capital W/O PI + Costs"
  // column sums to Total Capital / Capital to close incl. fees+reserves) —
  // the loan/LTV estimate misses closing costs and immediate needs.
  const fee = allSheets.find((x) => /fee breakdown/i.test(x.name));
  if (fee) {
    const fg = fee.g;
    let h = -1, cCap = -1, cPrice = -1;
    for (let r = 0; r < Math.min(fg.length, 40); r++) {
      const cells = (fg[r] || []).map(low);
      if (cells[0] === 'property' && cells.some((c) => c.includes('capital'))) {
        h = r;
        cCap = cells.findIndex((c) => c.includes('capital'));
        cPrice = cells.findIndex((c) => c.includes('purchase price'));
        break;
      }
    }
    if (h >= 0 && cCap >= 0) {
      const norm = (v: string) => v.toLowerCase().replace(/[^a-z]/g, '');
      const perProp = new Map<string, { capital: number; price: number }>();
      let totalCap = 0;
      for (let r = h + 1; r < fg.length; r++) {
        const nm = s(fg[r]?.[0]);
        if (!nm || /^\d/.test(nm)) break;   // totals row starts with a number
        const capital = num(fg[r]?.[cCap]);
        if (!capital) continue;
        perProp.set(norm(nm), { capital, price: cPrice >= 0 ? num(fg[r]?.[cPrice]) : 0 });
        totalCap = Math.round((totalCap + capital) * 100) / 100;
      }
      // the per-property column is CASH to close — true CAPITAL raised adds
      // the Organize fee on top (Troy: "that is how much cash, not capital").
      // Bismarck: 26.0M cash + 3.25M organize = 29.25M capital (×1.125).
      let organize = 0;
      for (let r = 0; r < Math.min(fg.length, 30); r++) {
        if (!/^organize/i.test(s(fg[r]?.[0]))) continue;
        const nums = (fg[r] || []).filter((v: any) => typeof v === 'number' || (typeof v === 'string' && num(v) > 0)).map((v: any) => num(v));
        organize = Math.max(0, ...nums.filter((v: number) => v > 10000));
        if (!organize) {
          const rate = nums.find((v: number) => v > 0 && v < 1) || 0;
          const priceRow = fg.find((row: any[]) => /^purchase price/i.test(s(row?.[0])));
          organize = rate && priceRow ? Math.round(rate * num(priceRow[1])) : 0;
        }
        break;
      }
      const factor = totalCap > 0 ? (totalCap + organize) / totalCap : 1;
      for (const v of perProp.values()) v.capital = Math.round(v.capital * factor * 100) / 100;
      totalCap = Math.round(totalCap * factor * 100) / 100;
      for (const sheet of out) {
        if (sheet.isPortfolio) {
          if (totalCap) sheet.data.assumptions['capitalToClose'] = totalCap;
          continue;
        }
        const key = norm(sheet.propertyGuess);
        const hit = perProp.get(key)
          || [...perProp.entries()].find(([k]) => k.startsWith(key) || key.startsWith(k))?.[1];
        if (hit) {
          sheet.data.assumptions['capitalToClose'] = hit.capital;
          if (hit.price) sheet.data.assumptions['purchasePrice'] = hit.price;
        }
      }
    }
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
  /** ancillary charge-code monthly totals (PETRENT, GARAGE, PARKING, …) —
      powers charge-driven other income */
  charges?: Record<string, number>;
}

export function parseRentRoll(buf: Buffer): RentParsedProperty[] {
  const all = grids(buf);
  const g = all[0].g;

  // ---- Yardi "Rent Roll" / "For Selected Properties" (summary OR unit-level) ----
  const isYardi = low(g[0]?.[0]) === 'rent roll' || all[0].name === 'Report1' && g.slice(0, 6).some((r) => low(r?.[0]).includes('for selected properties'));
  if (isYardi) {
    let asOf: string | null = null;
    for (const row of g.slice(0, 6)) {
      const m = s(row?.[0]).match(/as of\s*=\s*([\d/]+)/i);
      if (m) asOf = m[1];
    }
    // header row: first cell 'Property' (summary) or 'Unit' (unit-level detail)
    let h = -1;
    for (let r = 0; r < Math.min(g.length, 12); r++) if (low(g[r]?.[0]) === 'property') { h = r; break; }
    if (h < 0) {
      const withCharges = /lease charges/i.test(s(g[0]?.[0]));
      for (let r = 0; r < Math.min(g.length, 12); r++) {
        if (low(g[r]?.[0]) === 'unit' && (g[r] || []).map(low).some((c) => c.includes('market'))) {
          return withCharges ? parseYardiLeaseCharges(g, r, asOf) : parseYardiUnitLevel(g, r, asOf);
        }
      }
      throw new Error('Yardi rent roll: neither a "Property" (summary) nor "Unit" (detail) header row found');
    }
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
  // ancillary charge-code columns: ALL-CAPS single-word headers after Lease
  // Rent (PETRENT, GARAGE, PARKING…) — base RENT and totals excluded
  const chargeCols: { c: number; code: string }[] = [];
  for (let c = Math.max(cLease, 0) + 1; c < (g[h] || []).length; c++) {
    const raw = s(g[h]?.[c]);
    if (/^[A-Z][A-Z0-9]{2,15}$/.test(raw) && raw !== 'RENT' && raw !== 'SQFT' && !/TOTAL/.test(raw)) {
      chargeCols.push({ c, code: raw });
    }
  }
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
  const perUnit = new Map<string, { market: number; lease: number; status: string; end: string | null; charges: number[] }>();
  for (let r = h + 1; r < g.length; r++) {
    const unit = s(g[r]?.[cUnit]);
    if (!unit) continue;
    const market = num(g[r]?.[cMkt]);
    const lease = num(g[r]?.[cLease]);
    const status = low(g[r]?.[cStatus]);
    const end = cEnd >= 0 ? toIso(g[r]?.[cEnd]) : null;
    const chargeVals = chargeCols.map(({ c }) => num(g[r]?.[c]));
    const prev = perUnit.get(unit);
    if (!prev || (prev.market <= 0 && market > 0)) perUnit.set(unit, { market, lease, status, end, charges: chargeVals });
  }
  if (!perUnit.size) throw new Error('OneSite rent roll: no unit rows parsed');
  let market = 0, inPlace = 0, occ = 0;
  const leases: { m: number; r: number; e: string | null }[] = [];
  const charges: Record<string, number> = {};
  for (const u of perUnit.values()) {
    market += u.market;
    if (u.status.includes('occupied') || u.status.includes('notice')) {
      inPlace += u.lease;
      occ++;
      leases.push({ m: Math.round(u.market * 100) / 100, r: Math.round(u.lease * 100) / 100, e: u.end });
      chargeCols.forEach(({ code }, i) => { charges[code] = Math.round(((charges[code] || 0) + (u.charges[i] || 0)) * 100) / 100; });
    }
  }
  for (const k of Object.keys(charges)) if (!charges[k]) delete charges[k];
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
    charges,
  }];
}

/** Yardi multi-property UNIT-LEVEL rent roll ("Rent Roll" / "For Selected
    Properties" with Unit/Unit Type/Market Rent/Actual Rent/Lease Expiration
    columns). Properties are delimited by "Current/Notice/Vacant Residents" /
    "Future Residents/Applicants" section markers and closed by a
    "Total | Property Name(code)" row. Occupied = resident id (t…); VACANT /
    MODEL / ADMIN rows count as units but carry no lease. Only
    Current/Notice/Vacant rows feed the totals (futures aren't in place yet). */
function parseYardiUnitLevel(g: Grid, h: number, asOf: string | null): RentParsedProperty[] {
  // two-line headers (h + h+1): "Market"/"Rent", "Lease"/"Expiration", …
  const width = Math.max(...g.slice(h, h + 2).map((r) => (r || []).length));
  const heads: string[] = [];
  for (let c = 0; c < width; c++) heads[c] = [g[h]?.[c], g[h + 1]?.[c]].map(low).filter(Boolean).join(' ');
  const cRes = heads.findIndex((c) => c === 'resident');
  const cName = heads.findIndex((c) => c === 'name');
  const cMkt = heads.findIndex((c) => c.includes('market'));
  const cAct = heads.findIndex((c) => c.includes('actual'));
  const cEnd = heads.findIndex((c) => c.includes('lease') && c.includes('expiration'));
  if (cMkt < 0 || cAct < 0 || cRes < 0) throw new Error('Yardi unit-level rent roll: Resident/Market/Actual columns not found');

  const toIso = (v: any): string | null => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10); // excel serial
    const d = new Date(s(v).replace(/\s+\d{2}:\d{2}.*$/, ''));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  const out: RentParsedProperty[] = [];
  let section: 'cur' | 'fut' | null = null;
  let units = 0, market = 0, inPlace = 0, occ = 0;
  let leases: { m: number; r: number; e: string | null }[] = [];
  const reset = () => { units = 0; market = 0; inPlace = 0; occ = 0; leases = []; section = null; };

  for (let r = h + 2; r < g.length; r++) {
    const a0 = s(g[r]?.[0]);
    const res = s(g[r]?.[cRes]);
    if (/^current\/notice/i.test(a0)) { section = 'cur'; continue; }
    if (/^future residents/i.test(a0)) { section = 'fut'; continue; }
    if (/^summary/i.test(a0)) break;
    if (res === 'Total') {
      // property total row: name cell reads "Property Name(code)"
      const nm = s(g[r]?.[cName]);
      const m = nm.match(/^(.*?)\(([a-z0-9]+)\)\s*$/i);
      if (m && units > 0) {
        out.push({
          code: m[2].toLowerCase(), name: m[1].trim(), units,
          marketMonthly: Math.round(market * 100) / 100,
          inPlaceMonthly: Math.round(inPlace * 100) / 100,
          occupiedUnits: occ, asOf, source: 'unit_level', leases,
        });
      }
      reset();
      section = 'cur';   // next property may start without a section marker (see parseYardiLeaseCharges)
      continue;
    }
    if (section !== 'cur' || !a0 || g[r]?.[cMkt] == null) continue;
    // one unit row in the Current/Notice/Vacant section
    units++;
    const mkt = num(g[r]?.[cMkt]);
    const act = num(g[r]?.[cAct]);
    market += mkt;
    if (/^t\d/i.test(res)) {
      occ++;
      inPlace += act;
      // $0-actual resident rows are in-flight move-ins/outs — not a real lease
      // gap, so they'd fake a full-market LTL; keep them out of the burnoff
      if (act > 0) leases.push({ m: Math.round(mkt * 100) / 100, r: Math.round(act * 100) / 100, e: cEnd >= 0 ? toIso(g[r]?.[cEnd]) : null });
    }
  }
  if (!out.length) throw new Error('Yardi unit-level rent roll: no property sections parsed');
  return out;
}

/** Yardi multi-property "Rent Roll with Lease Charges": one row per unit
    (Unit / Unit Type / Sq Ft / Resident / Name / Market Rent / Charge Code /
    Amount / deposits / Move In / Lease Expiration / Move Out / Balance) with
    the unit's recurring charges as continuation rows (code + amount) closed by
    a per-unit "Total" row. Properties are delimited by the same section
    markers as the plain unit-level roll and closed by "Total | Name(code)".
    Occupied = resident id (t…); VACANT/MODEL/ADMIN count as units. The 'rent'
    charge is the in-place rent; every other code is captured per property
    (monthly $, occupied units only) — the charge-driven other-income source
    the plain roll never had. Futures/applicants are skipped. */
function parseYardiLeaseCharges(g: Grid, h: number, asOf: string | null): RentParsedProperty[] {
  const width = Math.max(...g.slice(h, h + 2).map((r) => (r || []).length));
  const heads: string[] = [];
  for (let c = 0; c < width; c++) heads[c] = [g[h]?.[c], g[h + 1]?.[c]].map(low).filter(Boolean).join(' ');
  const cRes = heads.findIndex((c) => c === 'resident');
  const cName = heads.findIndex((c) => c === 'name');
  const cMkt = heads.findIndex((c) => c.includes('market'));
  const cCode = heads.findIndex((c) => c.includes('charge') && c.includes('code'));
  const cAmt = heads.findIndex((c) => c === 'amount');
  const cEnd = heads.findIndex((c) => c.includes('lease') && c.includes('expiration'));
  if (cMkt < 0 || cRes < 0 || cCode < 0 || cAmt < 0) throw new Error('Rent Roll with Lease Charges: Resident/Market Rent/Charge Code/Amount columns not found');
  const toIso = (v: any): string | null => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
    const d = new Date(s(v).replace(/\s+\d{2}:\d{2}.*$/, ''));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  const out: RentParsedProperty[] = [];
  let section: 'cur' | 'fut' | null = null;
  let units = 0, market = 0, inPlace = 0, occ = 0;
  let leases: { m: number; r: number; e: string | null }[] = [];
  let charges: Record<string, number> = {};
  // the unit block being read: its market, occupancy, lease end and charges so far
  let cur: { mkt: number; occupied: boolean; end: string | null; rent: number; other: Record<string, number> } | null = null;
  const closeUnit = () => {
    if (!cur) return;
    if (cur.occupied) {
      inPlace += cur.rent;
      occ++;
      if (cur.rent > 0) leases.push({ m: Math.round(cur.mkt * 100) / 100, r: Math.round(cur.rent * 100) / 100, e: cur.end });
      for (const [code, v] of Object.entries(cur.other)) charges[code] = Math.round(((charges[code] || 0) + v) * 100) / 100;
    }
    cur = null;
  };
  const reset = () => { units = 0; market = 0; inPlace = 0; occ = 0; leases = []; charges = {}; cur = null; section = null; };
  const addCharge = (codeRaw: any, amtRaw: any) => {
    if (!cur) return;
    const code = low(codeRaw);
    if (!code || code === 'total') return;
    const v = num(amtRaw);
    if (code === 'rent') cur.rent += v;
    else if (v) cur.other[code] = Math.round(((cur.other[code] || 0) + v) * 100) / 100;
  };
  for (let r = h + 2; r < g.length; r++) {
    const a0 = s(g[r]?.[0]);
    const res = s(g[r]?.[cRes]);
    if (/^current\/notice/i.test(a0)) { closeUnit(); section = 'cur'; continue; }
    if (/^future residents/i.test(a0)) { closeUnit(); section = 'fut'; continue; }
    if (/^summary/i.test(a0)) break;
    if (res === 'Total') {
      closeUnit();
      const nm = s(g[r]?.[cName]);
      const m = nm.match(/^(.*?)\(([a-z0-9]+)\)\s*$/i);
      if (m && units > 0) {
        for (const k of Object.keys(charges)) if (!charges[k]) delete charges[k];
        out.push({
          code: m[2].toLowerCase(), name: m[1].trim(), units,
          marketMonthly: Math.round(market * 100) / 100, inPlaceMonthly: Math.round(inPlace * 100) / 100,
          occupiedUnits: occ, asOf, source: 'unit_level', leases, charges,
        });
      }
      reset();
      // Yardi omits the "Current/Notice/Vacant Residents" marker when the
      // previous property had no Future section — the next property's unit
      // rows start right away (phnd in the 9/30/26 roll)
      section = 'cur';
      continue;
    }
    if (section !== 'cur') continue;
    if (a0 && g[r]?.[cMkt] != null && g[r]?.[cMkt] !== '') {
      // a new unit row
      closeUnit();
      units++;
      const mkt = num(g[r]?.[cMkt]);
      market += mkt;
      cur = { mkt, occupied: /^t\d/i.test(res), end: cEnd >= 0 ? toIso(g[r]?.[cEnd]) : null, rent: 0, other: {} };
      addCharge(g[r]?.[cCode], g[r]?.[cAmt]);
      continue;
    }
    if (!a0 && cur) {
      const code = low(g[r]?.[cCode]);
      if (code === 'total') { closeUnit(); continue; }
      addCharge(g[r]?.[cCode], g[r]?.[cAmt]);
    }
  }
  if (!out.length) throw new Error('Rent Roll with Lease Charges: no property sections parsed');
  return out;
}

/* ========================= REVIEW-DRAFT IMPORT ========================= */

/** Parse an edited review workbook ("CWND 2026 Budget Draft TS ….xlsx"):
    the Budget tab's detail-GL month cells (E..P; SheetJS returns cached
    values for formula cells, so hand-typed AND formula edits both come
    through) plus the Summary's Capital Contributions (D27). */
export function parseReviewDraft(buf: Buffer): { code: string | null; year: number | null; glMonths: Record<string, number[]>; capital: number | null } {
  const all = grids(buf);
  const bSheet = all.find((x) => x.name.trim().toLowerCase() === 'budget')
    || all.find((x) => / budget$/i.test(x.name.trim()));
  if (!bSheet) throw new Error('No "Budget" tab found — is this a review-workbook draft?');
  const g = bSheet.g;
  const code = (s(g[0]?.[2]).match(/\(([a-z0-9]{3,6})\)/i)?.[1] || '').toLowerCase() || null;
  // title reads "Year 1 Budget · Sep-26 – Aug-27" — the first month label's
  // 2-digit year is the budget year
  const ym = s(g[0]?.[4]).match(/[A-Za-z]{3}-(\d{2})\b/);
  const year = ym ? 2000 + Number(ym[1]) : null;
  const glMonths: Record<string, number[]> = {};
  for (let r = 6; r < g.length; r++) {
    const gl = s(g[r]?.[0]);
    if (!/^\d{4}$/.test(gl)) continue;
    glMonths[gl] = Array.from({ length: 12 }, (_, i) => {
      const v = g[r]?.[4 + i];
      return typeof v === 'number' ? Math.round(v * 100) / 100 : num(v);
    });
  }
  if (!Object.keys(glMonths).length) throw new Error('Budget tab has no GL rows');
  const sSheet = all.find((x) => x.name.trim().toLowerCase() === 'summary') || all.find((x) => / summary$/i.test(x.name.trim()));
  let capital: number | null = null;
  if (sSheet) {
    const v = sSheet.g[26]?.[3];   // Summary D27 = Capital Contributions
    if (typeof v === 'number' && v > 0) capital = Math.round(v * 100) / 100;
  }
  return { code, year, glMonths, capital };
}

/* ========================= ND PAYROLL MODEL ========================= */

/* Position → Monarch wage GL. Anything unrecognized lands in 6404 and is
   reported in unmappedPositions so the mapping can be extended.
   NOTHING maps to 6405 landscaping (Troy 2026-08-21): housekeepers and
   grounds crews are MAINTENANCE wages — landscaping is contracted work,
   not payroll. */
const POSITION_GL: [RegExp, string][] = [
  [/regional|lms|arm|bookkeep|office|leasing|apm|\bpm\b|manager|market/i, '6402'],
  [/rover/i, '6407'],
  [/supervisor|tech|housekeep|maint|janitor|porter|ground|landscap/i, '6404'],
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

/* ========================= MONARCH 12-MONTH STATEMENT / BUDGET ========================= */

export interface MonarchStmtParsed {
  label: string;                 // report title, e.g. "Fair Hills Apartments (fhnd)"
  propertyGuess: string | null;  // lowercase yardi code from the title's "(code)"
  kind: 'actual' | 'budget';     // "Statement (12 months)" → actual; "Budget" → budget
  period: string;
  book: string;
  monthCal: number[];            // calendar month 1-12 per value column
  monthYear: number[];           // calendar year per value column
  rows: { gl: string; name: string; months: number[]; total: number }[];
  gpr: number; egi: number; noi: number;   // headline figures off the report's own total rows (for the preview)
}

/** Yardi 12 Month Statement (posted actuals) or 12 Month Budget export for ONE
    Monarch property: Monarch 4-digit GLs down column A, 12 "Mon YYYY" columns,
    a Total column. Only DETAIL GL rows are kept (the report's own subtotal
    rows — TOTAL…, NET OPERATING INCOME… — are recomputed by the chart). The
    data layer for annual budgets. */
export function parseMonarchStatement(buf: Buffer, coaDetail?: Set<string>): MonarchStmtParsed {
  const g = grids(buf)[0].g;
  const label = s(g[0]?.[0]);
  const pg = label.match(/\(([a-z0-9]{3,6})\)\s*$/i);
  const propertyGuess = pg ? pg[1].toLowerCase() : null;
  let period = '', book = '';
  let kind: 'actual' | 'budget' = 'actual';
  for (const row of g.slice(0, 6)) {
    const t = s(row?.[0]);
    if (/period\s*=/i.test(t)) period = t.replace(/.*period\s*=\s*/i, '').trim();
    if (/book\s*=/i.test(t)) book = t.replace(/.*book\s*=\s*/i, '').split(';')[0].trim();
    if (/^budget$/i.test(t)) kind = 'budget';
  }
  let h = -1;
  let monthCols: number[] = [], monthCal: number[] = [], monthYear: number[] = [];
  for (let r = 0; r < Math.min(g.length, 10); r++) {
    const cols: number[] = [], cal: number[] = [], yrs: number[] = [];
    for (let c = 1; c < (g[r] || []).length; c++) {
      const m = low(g[r]?.[c]).match(/^([a-z]{3})[a-z]*\s+(\d{4})$/);
      if (m) {
        const mi = MONTH_NAMES.indexOf(m[1]);
        if (mi >= 0) { cols.push(c); cal.push(mi + 1); yrs.push(Number(m[2])); }
      }
    }
    if (cols.length >= 10) { h = r; monthCols = cols.slice(0, 12); monthCal = cal.slice(0, 12); monthYear = yrs.slice(0, 12); break; }
  }
  if (h < 0) throw new Error('Monarch statement: 12-month header row ("Jan 2026" …) not found — export the 12 Month Statement / 12 Month Budget, not the Property Comparison');
  const totalCol = monthCols[monthCols.length - 1] + 1;
  const rows: MonarchStmtParsed['rows'] = [];
  const totals: Record<string, number> = {};
  for (let r = h + 1; r < g.length; r++) {
    const gl = s(g[r]?.[0]);
    if (!/^\d{3,4}$/.test(gl)) continue;
    const name = s(g[r]?.[1]);
    const months = monthCols.map((c) => num(g[r]?.[c]));
    const total = num(g[r]?.[totalCol]) || months.reduce((a, b) => a + b, 0);
    totals[gl] = total;
    // the report's own subtotal rows: known total codes, or named like one
    const isTotal = coaDetail ? !coaDetail.has(gl) : /^\s*(total|net |sub-total)/i.test(name) || /^(5004|5029|5049|5070|5190|5500|6170|6370|6399|6470|6570|6670|6770|6870|6970|7070|7098|7099|7279|7280|7315|7500|8200|8602|8950|9000)$/.test(gl);
    if (isTotal) continue;
    if (!months.some((v) => v)) continue;
    rows.push({ gl, name, months, total });
  }
  if (!rows.length) throw new Error('Monarch statement: no detail GL rows parsed');
  return {
    label, propertyGuess, kind, period, book, monthCal, monthYear, rows,
    gpr: totals['4994'] || 0, egi: totals['5500'] || 0, noi: totals['7280'] || 0,
  };
}

/* ========================= YARDI BUDGET TEMPLATE (budgetYSR<year>_budget_<id>.xlsm) ========================= */

export interface TemplateParsed {
  template: TemplateData;
  actual: MonarchStmtParsed;     // trailing-12 posted actuals (PriorFinancials MTD, the template's PY months)
  budget: MonarchStmtParsed;     // the current year's budget (PriorFinancials MTDBudget, Jan–Dec)
  skippedSheets: string[];
}

const serialDate = (v: any): { y: number; m: number } | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400 * 1000)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; }
  const t = s(v);
  const mm = t.match(/^(\d{1,2})\/\d{1,2}\/(\d{2,4})/);
  if (mm) { let y = Number(mm[2]); if (y < 100) y += 2000; return { y, m: Number(mm[1]) }; }
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : { y: d.getFullYear(), m: d.getMonth() + 1 };
};
const pctNum = (v: any): number => {
  if (typeof v === 'number') return v;
  const t = s(v);
  if (!t) return 0;
  const n = parseFloat(t.replace(/[%,\s]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return /%/.test(t) ? n / 100 : n;
};

/** Monarch's Yardi budget template for ONE property. Reads PriorFinancials
    (monthly actual + budget per GL), PropertyInfo, Debt Service, ManFeeMatrix,
    ManagementFeeActual, Utility Change Forecasts, BudgetSuggestions,
    LeaseGoals, LeaseExpirations, DistHist, MortgageDetail and the Budget
    Worksheet's assumption cells (PY month anchors, GPR % changes, renewal %,
    burnoffs, vacancy / delinquency / collections %). RESTRICTED-DATA GUARD:
    "Paste Payroll Here" (the pasted roster — individual compensation) is never
    read; payroll comes from the regional payroll model instead. */
export function parseYardiBudgetTemplate(buf: Buffer, coaDetail?: Set<string>): TemplateParsed {
  const wb = XLSX.read(buf, { type: 'buffer', cellFormula: false });
  const skippedSheets = wb.SheetNames.filter((n) => /payroll/i.test(n));
  const sheet = (name: RegExp): any[][] | null => {
    const sn = wb.SheetNames.find((n) => name.test(n) && !/payroll/i.test(n));
    return sn ? (XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sn], { header: 1, raw: true, defval: null }) as any[][]) : null;
  };
  const bwName = wb.SheetNames.find((n) => /^budget worksheet$/i.test(n));
  if (!bwName) throw new Error('Yardi budget template: no "Budget Worksheet" sheet');
  const bw = wb.Sheets[bwName];
  const cell = (addr: string): any => { const c = bw[addr]; return c ? c.v : undefined; };
  const bwGrid = XLSX.utils.sheet_to_json<any[]>(bw, { header: 1, raw: true, defval: null }) as any[][];

  // property
  const pi = sheet(/^propertyinfo$/i);
  const pRow = pi?.[1] || [];
  const code = low(pRow[0]) || null;
  if (!code) throw new Error('Yardi budget template: PropertyInfo has no property code');
  const name = s(pRow[1]);
  const units = Math.round(num(pRow[2]));
  const capital = num(pRow[3]);
  const acq = serialDate(pRow[4]);
  const budgetYear = Math.round(num(pRow[5])) || 0;

  // Budget Worksheet row 1: the PY month anchors (E1..P1), last actual month (N1)
  const anchors: { y: number; m: number }[] = [];
  for (const col of 'EFGHIJKLMNOP'.split('')) { const d = serialDate(cell(`${col}1`)); if (d) anchors.push(d); }
  if (anchors.length !== 12) throw new Error('Yardi budget template: Budget Worksheet row 1 month anchors not found');
  const pyYears = Array(12).fill(0) as number[];
  for (const a of anchors) pyYears[a.m - 1] = a.y;
  const lastActual = serialDate(cell('N1')) || anchors[9];
  const curYear = anchors[0].y;                                   // E1 = Jan of the current year
  const year = budgetYear || curYear + 1;

  // assumption cells, found by GL label (rows shift between template versions)
  const rowOf = (gl: string): number => bwGrid.findIndex((r) => s(r?.[0]) === gl);
  const rowWhere = (col: number, re: RegExp): number => bwGrid.findIndex((r) => re.test(s(r?.[col])));
  const dOf = (r: number): any => (r >= 0 ? bwGrid[r]?.[3] : undefined);
  const gprRow = rowOf('4993');
  const gprPct = Array(12).fill(0) as number[];
  if (gprRow >= 0) for (let i = 0; i < 12; i++) gprPct[i] = pctNum(bwGrid[gprRow]?.[4 + i]);
  const renewRow = rowWhere(2, /renewal percentage/i);
  const renewalPct = renewRow >= 0 && dOf(renewRow) != null ? pctNum(dOf(renewRow)) : null;
  const bRow = rowWhere(2, /burnoff on renewals/i), nRow = rowWhere(2, /burnoff on new move/i);
  const burnoffRenew = bRow >= 0 && dOf(bRow) != null ? pctNum(dOf(bRow)) : null;
  const burnoffNew = nRow >= 0 && dOf(nRow) != null ? pctNum(dOf(nRow)) : null;
  const pctCell = (gl: string): number | null => { const r = rowOf(gl); const v = dOf(r); return r >= 0 && typeof v === 'number' ? v : null; };
  const vacancyPct = pctCell('5031');
  const delinqPct = pctCell('5035');
  const priorPeriodPct = pctCell('5036');
  const swRow = bwGrid.findIndex((r) => /computer software/i.test(s(r?.[1])) && /\$\s*[\d,.]+\s*\/\s*month/i.test(s(r?.[2])));
  const swM = swRow >= 0 ? s(bwGrid[swRow][2]).match(/\$\s*([\d,.]+)\s*\/\s*month/i) : null;
  const softwareFixedMo = swM ? num(swM[1]) : null;

  // PriorFinancials → actual (PY months) + budget (current year) statements
  const pf = sheet(/^priorfinancials$/i);
  if (!pf || pf.length < 2) throw new Error('Yardi budget template: PriorFinancials sheet missing or empty');
  const hdr = (pf[0] || []).map(low);
  const cAcct = hdr.findIndex((h) => h === 'account'), cName = hdr.findIndex((h) => h === 'acctname'),
    cMonth = hdr.findIndex((h) => h === 'month'), cMtd = hdr.findIndex((h) => h === 'mtd'), cMtdB = hdr.findIndex((h) => h === 'mtdbudget');
  if ([cAcct, cMonth, cMtd, cMtdB].some((c) => c < 0)) throw new Error('Yardi budget template: PriorFinancials columns (Account, Month, MTD, MTDBudget) not found');
  const act: Record<string, { name: string; months: number[] }> = {};
  const bud: Record<string, { name: string; months: number[] }> = {};
  const keep = (gl: string): boolean => (coaDetail ? coaDetail.has(gl) : /^\d{4}$/.test(gl) && Number(gl) >= 3000);
  for (const r of pf.slice(1)) {
    const gl = s(r?.[cAcct]);
    if (!gl || !keep(gl)) continue;
    const d = serialDate(r[cMonth]);
    if (!d) continue;
    const nm = s(r[cName]);
    if (d.y === pyYears[d.m - 1]) {
      (act[gl] ||= { name: nm, months: Array(12).fill(0) }).months[d.m - 1] += num(r[cMtd]);
    }
    if (d.y === curYear) {
      (bud[gl] ||= { name: nm, months: Array(12).fill(0) }).months[d.m - 1] += num(r[cMtdB]);
    }
  }
  const toStmt = (src: Record<string, { name: string; months: number[] }>, kind: 'actual' | 'budget', monthYear: number[], period: string): MonarchStmtParsed => {
    const rows = Object.entries(src)
      .map(([gl, v]) => ({ gl, name: v.name, months: v.months.map((x) => Math.round(x * 100) / 100), total: Math.round(v.months.reduce((a, b) => a + b, 0) * 100) / 100 }))
      .filter((r) => r.months.some((v) => v))
      .sort((a, b) => Number(a.gl) - Number(b.gl));
    const tot = (gl: string) => rows.find((r) => r.gl === gl)?.total || 0;
    return { label: `${name} (${code})`, propertyGuess: code, kind, period, book: 'Cash', monthCal: Array.from({ length: 12 }, (_, i) => i + 1), monthYear, rows, gpr: tot('4994'), egi: 0, noi: 0 };
  };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const order = anchors.slice().sort((a, b) => a.y * 12 + a.m - (b.y * 12 + b.m));
  const actual = toStmt(act, 'actual', pyYears, `${MON[order[0].m - 1]} ${order[0].y}-${MON[order[11].m - 1]} ${order[11].y}`);
  const budget = toStmt(bud, 'budget', Array(12).fill(curYear), `Jan ${curYear}-Dec ${curYear}`);

  // Debt Service: the budget year's months
  const ds = sheet(/^debt service$/i) || [];
  const interest = Array(12).fill(0) as number[], principal = Array(12).fill(0) as number[];
  const loans = new Set<string>();
  let principalGl = '3080';
  for (const r of ds.slice(1)) {
    const d = serialDate(r?.[2]);
    if (!d || d.y !== year) continue;
    loans.add(s(r[1]));
    interest[d.m - 1] += num(r[5]);
    principal[d.m - 1] += num(r[4]);
    if (s(r[7])) principalGl = s(r[7]);
  }
  // management fee matrix + actual
  const mf = sheet(/^manfeematrix$/i) || [];
  const matrix: Record<string, number> = {};
  let override: number | null = null, notes = '';
  if (mf.length >= 2) {
    (mf[0] || []).forEach((h: any, i: number) => {
      // headers are "5%" … "17%" — or the numbers 0.05 … 0.17 formatted as %
      const t = typeof h === 'number' && h > 0 && h < 1 ? `${Math.round(h * 100)}%` : s(h);
      if (/^\d+%$/.test(t)) matrix[t] = pctNum(mf[1][i]);
      else if (/^override$/i.test(t)) override = num(mf[1][i]) || null;
      else if (/overridenotes/i.test(t)) notes = s(mf[1][i]);
    });
  }
  const mfa = sheet(/^managementfeeactual$/i) || [];
  const mgmtFee = {
    actualPct: mfa[1] && typeof mfa[1][4] === 'number' ? mfa[1][4] : null,
    actualFee: mfa[1] ? num(mfa[1][2]) : 0, actualIncome: mfa[1] ? num(mfa[1][3]) : 0,
    matrix, override, notes,
  };
  // Conservice utility forecasts (gl, month → %)
  const uf = sheet(/^utility change forecasts$/i) || [];
  const utilForecast: Record<string, number[]> = {};
  for (const r of uf.slice(1)) {
    const gl = s(r?.[2]); const d = serialDate(r?.[1]);
    if (!gl || !d || d.y !== year) continue;
    (utilForecast[gl] ||= Array(12).fill(0))[d.m - 1] = pctNum(r[3]);
  }
  // corporate budget suggestions (gl, month → $, notes)
  const bs = sheet(/^budgetsuggestions$/i) || [];
  const suggestions: Record<string, number[]> = {};
  const suggestionNotes: Record<string, string[]> = {};
  for (const r of bs.slice(1)) {
    const gl = s(r?.[2]); const d = serialDate(r?.[1]);
    if (!gl || !d || d.y !== year) continue;
    (suggestions[gl] ||= Array(12).fill(0))[d.m - 1] = Math.round(((suggestions[gl]?.[d.m - 1] || 0) + num(r[3])) * 100) / 100;
    const note = s(r[4]);
    if (note && !(suggestionNotes[gl] ||= []).includes(note)) suggestionNotes[gl].push(note);
  }
  const row12 = (re: RegExp): number[] => { const g2 = sheet(re); const r = g2?.[1] || []; return Array.from({ length: 12 }, (_, i) => num(r[1 + i])); };
  const leaseGoals = row12(/^leasegoals$/i);
  const leaseExpirations = row12(/^leaseexpirations$/i);
  const dh = sheet(/^disthist$/i) || [];
  const distHist = dh.slice(1).filter((r) => r?.[0]).map((r) => { const d = serialDate(r[1]); return { date: d ? `${d.y}-${String(d.m).padStart(2, '0')}` : s(r[1]), type: s(r[2]), pct: num(r[3]), amount: num(r[4]) }; });
  const md = sheet(/^mortgagedetail$/i) || [];
  const mortgage = md.slice(1).filter((r) => r?.[0]).map((r) => {
    const io = serialDate(r[15]), due = serialDate(r[10]);
    return { loanCode: s(r[1]), lender: s(r[5]), program: s(r[6]), origBal: num(r[7]), rate: num(r[13]),
             ioEnd: io ? `${io.y}-${String(io.m).padStart(2, '0')}` : null, dueDate: due ? `${due.y}-${String(due.m).padStart(2, '0')}` : null,
             amortYears: num(r[11]) || null };
  });

  const template: TemplateData = {
    code, name, units, capital, acquisitionDate: acq ? `${acq.y}-${String(acq.m).padStart(2, '0')}` : null, budgetYear: year,
    lastActual: { year: lastActual.y, month: lastActual.m }, pyYears,
    debt: { interest: interest.map((v) => Math.round(v * 100) / 100), principal: principal.map((v) => Math.round(v * 100) / 100), principalGl, loans: [...loans] },
    mgmtFee, utilForecast, suggestions, suggestionNotes, leaseGoals, leaseExpirations,
    renewalPct, burnoffRenew, burnoffNew, gprPct, vacancyPct, delinqPct, priorPeriodPct, distHist, mortgage, softwareFixedMo,
  };
  return { template, actual, budget, skippedSheets };
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

/* ========================= COMPARISON — POSTED ACTUALS (one period) ========================= */

export interface ComparisonActualsParsed {
  label: string; period: string; book: string;
  calYear: number; calMonth: number;          // parsed from "Period = Aug 2026"
  properties: string[];                        // yardi codes that have an Actual column
  rows: { gl: string; name: string; actual: Record<string, number>; budget: Record<string, number> }[];
}

/** Yardi Property Comparison for ONE period with Actual/Budget column pairs
    per property (the month-end variance export: codes on one header row,
    " Actual"/" Budget" on the next). Feeds the actualize-month feature — the
    budget picks its own property's Actual column. */
export function parseComparisonActuals(buf: Buffer): ComparisonActualsParsed {
  const g = grids(buf)[0].g;
  const label = s(g[0]?.[0]);
  let period = '', book = '';
  for (const row of g.slice(0, 6)) {
    const t = s(row?.[0]);
    if (/period\s*=/i.test(t)) period = t.replace(/.*period\s*=\s*/i, '').trim();
    if (/book\s*=/i.test(t)) book = t.replace(/.*book\s*=\s*/i, '').split(';')[0].trim();
  }
  const pm = period.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/i);
  if (!pm) throw new Error(`Property Comparison: expected a single-month period ("Aug 2026"), got "${period || '?'}"`);
  const calMonth = MONTH_NAMES.indexOf(pm[1].toLowerCase()) + 1;
  const calYear = Number(pm[2]);
  if (!calMonth) throw new Error(`Property Comparison: unrecognised month in "${period}"`);
  // property-code header row + the Actual/Budget row right under it
  let h = -1;
  const cols: Record<string, { actual?: number; budget?: number }> = {};
  for (let r = 0; r < Math.min(g.length, 12) && h < 0; r++) {
    const kinds = (g[r + 1] || []).map((v: any) => low(v));
    if (!kinds.includes('actual')) continue;
    for (let c = 2; c < (g[r] || []).length; c++) {
      const code = low(g[r]?.[c]);
      const kind = kinds[c];
      if (!/^[a-z]{3,6}\d?$/.test(code) || code === 'total') continue;
      if (kind !== 'actual' && kind !== 'budget') continue;
      (cols[code] ||= {})[kind] = c;
    }
    if (Object.keys(cols).length) h = r;
  }
  if (h < 0) throw new Error('Property Comparison: property-code header with Actual/Budget columns not found');
  const properties = Object.keys(cols).filter((k) => cols[k].actual != null);
  const rows: ComparisonActualsParsed['rows'] = [];
  for (let r = h + 2; r < g.length; r++) {
    const gl = s(g[r]?.[0]);
    if (!/^\d{3,4}$/.test(gl)) continue;
    const actual: Record<string, number> = {}, budget: Record<string, number> = {};
    for (const p of properties) {
      actual[p] = num(g[r]?.[cols[p].actual!]);
      if (cols[p].budget != null) budget[p] = num(g[r]?.[cols[p].budget!]);
    }
    rows.push({ gl, name: s(g[r]?.[1]), actual, budget });
  }
  if (!rows.length) throw new Error('Property Comparison: no GL rows parsed');
  return { label, period, book, calYear, calMonth, properties, rows };
}

/* ========================= YARDI BUDGET CSV (ETL format — exported from Yardi, or a prior upload) ========================= */

export interface BudgetCsvParsed {
  propertyId: string;          // lowercase yardi code, FROM THE FILE's header record
  book: string;
  year: number;                // calendar year of the Start Month
  startMonth: string;          // as written, e.g. "1/1/2026"
  description: string;
  eol: string;
  preamble: string[];          // every line from this block's //Budget header through its //BudgetDetail header, verbatim
  headerIdx: number;           // index of the header RECORD within preamble
  rows: { gl: string; tokens: string[]; amounts: number[] }[];   // tokens verbatim (quotes kept), Amount1..12 numeric
  decimals: number | null;     // amount formatting seen in the file (4 → "0.0000"); null → plain numbers
}

/** Split one CSV line into raw tokens — quotes preserved, commas inside quotes kept. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; cur += ch; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
const unq = (t: string): string => t.trim().replace(/^"(.*)"$/, '$1');

function parseBudgetCsvBlock(lines: string[], eol: string): BudgetCsvParsed {
  const hb = lines.findIndex((l) => l.startsWith('//Budget:'));
  const hd = lines.findIndex((l) => l.startsWith('//BudgetDetail:'));
  if (hb < 0 || hd < 0 || hd < hb + 2) throw new Error('Budget CSV: expected a //Budget header, its record, then //BudgetDetail');
  const rec = splitCsvLine(lines[hb + 1]);
  const propertyId = unq(rec[1] || '').toLowerCase();
  const startMonth = unq(rec[3] || '');
  const ym = startMonth.match(/(\d{4})/);
  if (!propertyId || !ym) throw new Error('Budget CSV: the header record needs a Property Id and a Start Month');
  const rows: BudgetCsvParsed['rows'] = [];
  let decimals: number | null = null;
  for (const l of lines.slice(hd + 1)) {
    if (!l.trim() || l.startsWith('//')) continue;
    const tokens = splitCsvLine(l);
    if (tokens.length < 24) continue;
    const gl = unq(tokens[1]);
    if (!/^\d{3,4}$/.test(gl)) continue;
    if (decimals == null) { const m = tokens[12].trim().match(/\.(\d+)$/); decimals = m ? m[1].length : 0; }
    rows.push({ gl, tokens, amounts: tokens.slice(12, 24).map((t) => parseFloat(unq(t)) || 0) });
  }
  if (!rows.length) throw new Error(`Budget CSV: no //BudgetDetail rows found for ${propertyId}`);
  return {
    propertyId, book: unq(rec[2] || ''), year: Number(ym[1]), startMonth, description: unq(rec[4] || ''),
    eol, preamble: lines.slice(0, hd + 1), headerIdx: hb + 1, rows, decimals: decimals || null,
  };
}

/** A Yardi budget export may hold SEVERAL budgets back to back (one //Budget
    block per property — the ND six-site export is 6 × 338 lines). One parsed
    block per header, in file order, every token verbatim; each block's
    property comes from ITS OWN header record. */
export function parseBudgetCsvBlocks(buf: Buffer): BudgetCsvParsed[] {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const starts = lines.map((l, i) => (l.startsWith('//Budget:') ? i : -1)).filter((i) => i >= 0);
  if (!starts.length) throw new Error('Budget CSV: no //Budget header found');
  return starts.map((s, k) => parseBudgetCsvBlock(lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length), eol));
}

/** Single-budget convenience — refuses a multi-budget file so a caller can
    never mistake six budgets for one. */
export function parseBudgetCsv(buf: Buffer): BudgetCsvParsed {
  const blocks = parseBudgetCsvBlocks(buf);
  if (blocks.length > 1) throw new Error(`Budget CSV holds ${blocks.length} budgets (${blocks.map((b) => b.propertyId).join(', ')}) — use parseBudgetCsvBlocks`);
  return blocks[0];
}

/** A block re-emitted unchanged (used to keep a multi-budget file complete
    when one of its budgets could not be revised). */
export function budgetCsvBlockText(b: BudgetCsvParsed): string {
  return [...b.preamble, ...b.rows.map((r) => r.tokens.join(','))].join(b.eol) + b.eol;
}

/** Guess which upload a workbook is from its sheet names / title cells so the
    Data page can take any file without asking what it is first. Returns null
    when nothing recognisable is found (the user then picks the kind). */
export type UploadKind = 'uw_book' | 'rent_roll' | 'comparison' | 'seller_t12' | 'payroll' | 'yardi_template' | 'statement';
export function detectUploadKind(buf: Buffer): UploadKind | null {
  const wb = XLSX.read(buf, { type: 'buffer', sheetRows: 150 });
  const names = wb.SheetNames;
  if (names.some((n) => /^budget worksheet$/i.test(n)) && names.some((n) => /priorfinancials/i.test(n))) return 'yardi_template';
  if (names.some((n) => /^wages$/i.test(n))) return 'payroll';
  const first = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[names[0]], { header: 1, raw: true, defval: null }) as any[][];
  const head = first.slice(0, 8).map((r) => (r || []).map((v) => (v == null ? '' : String(v))).join(' ')).join('\n');
  if (/rent roll/i.test(head)) return 'rent_roll';
  if (/property comparison/i.test(head)) return 'comparison';
  const monthHeader = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i.test(head);
  if (monthHeader && /period\s*=/i.test(head) && /book\s*=/i.test(head)) {
    // a Yardi monthly statement: Monarch's own property (title "Name (code)",
    // letter code) vs a seller's export (numeric property id)
    const title = String(first[0]?.[0] ?? '');
    const code = title.match(/\(([^()]{1,12})\)\s*$/)?.[1] || '';
    return /^\d+$/.test(code) ? 'seller_t12' : 'statement';
  }
  // UW book: a sheet whose column B carries "Gross Potential Rent"
  for (const n of names) {
    const g = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[n], { header: 1, raw: true, defval: null }) as any[][];
    if (g.some((r) => /^gross potential rent/i.test(String(r?.[1] ?? '').trim()))) return 'uw_book';
  }
  if (monthHeader) return 'seller_t12';
  return null;
}
