/* The contracts register's repo file (Troy 2026-11-17: "a significantly better way to alter contract expenses per year that
   you can push data directly into"): data/contracts/<region>/<year>.csv, loaded into the register on every deploy.

   Columns (header row, any order, case-insensitive; blank cells = not set):
     property   site code (clnd, cwnd, ...)
     gl         the GL it books to (6918, 6808, ...)
     vendor     who it is with — with property + year + gl, the row's identity
     kind       monthly | annual | perUnit                       (default monthly)
     amount     $ per month (monthly), the invoice (annual), $ per unit (perUnit); per = total: the whole for the months
     per        month | total                                    (monthly only; default month)
     months     the months billed, 1-12, separated by ; or space  (monthly / perUnit; blank = every month)
     bill_month the invoice month 1-12                           (annual)
     step_month the month a price change starts 1-12             (optional)
     step_pct   the change, as a % (3 = +3%)                     (optional)
     mode       replace | add — replace the line's formula, or sit on top of it (default replace)
     note       free text
     whole_gl   yes = the file's rows are the whole GL for that property and year: contracts on that GL from the review
                workbook or carried over from a budget's own list are removed (rows added or changed on the page stay)
   The year comes from the file name. Pure: parsing and identity only; src/contracts.ts writes the register. */
import type { Contract } from './domain.js';

export interface RepoContractRow { property: string; year: number; gl: string; vendor: string; contract: Contract; note: string; line: number; wholeGl: boolean }

/** RFC-4180-ish CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], f = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += ch;
      continue;
    }
    if (ch === '"') { q = true; continue; }
    if (ch === ',') { row.push(f); f = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.some((x) => x.trim() !== '')) out.push(row);
      row = [];
      continue;
    }
    f += ch;
  }
  row.push(f);
  if (row.some((x) => x.trim() !== '')) out.push(row);
  return out;
}

const month = (v: string): number | null => { const n = Math.round(Number(String(v).trim())); return n >= 1 && n <= 12 ? n : null; };

/** The rows of one year's file; rows with problems come back in `errors` (line number + why), never half-loaded. */
export function parseContractsCsv(text: string, year: number): { rows: RepoContractRow[]; errors: string[] } {
  const g = parseCsv(text);
  const errors: string[] = [];
  if (!g.length) return { rows: [], errors };
  // "Bill Month" = bill_month, "Step %" = step_pct
  const head = g[0].map((h) => h.trim().toLowerCase().replace(/\s*%\s*/g, ' pct').trim().replace(/[\s-]+/g, '_'));
  const col = (name: string) => head.indexOf(name);
  for (const need of ['property', 'gl', 'vendor', 'amount']) if (col(need) < 0) errors.push(`header: no "${need}" column`);
  if (errors.length) return { rows: [], errors };
  const rows: RepoContractRow[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < g.length; r++) {
    const v = (name: string) => { const i = col(name); return i >= 0 ? String(g[r][i] ?? '').trim() : ''; };
    const line = r + 1;
    const property = v('property').toLowerCase(), gl = v('gl'), vendor = v('vendor');
    const kindRaw = (v('kind') || 'monthly').toLowerCase();
    const kind = kindRaw === 'annual' ? 'annual' : kindRaw === 'perunit' || kindRaw === 'per_unit' ? 'perUnit' : kindRaw === 'monthly' ? 'monthly' : null;
    const amount = Number(v('amount').replace(/[$,]/g, ''));
    if (!/^[a-z0-9]{2,8}$/.test(property)) { errors.push(`line ${line}: property "${v('property')}"`); continue; }
    if (!/^\d{4}$/.test(gl)) { errors.push(`line ${line}: gl "${gl}"`); continue; }
    if (!vendor) { errors.push(`line ${line}: no vendor`); continue; }
    if (!kind) { errors.push(`line ${line}: kind "${kindRaw}" (monthly, annual or perUnit)`); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { errors.push(`line ${line}: amount "${v('amount')}"`); continue; }
    const key = contractKey(property, year, gl, vendor);
    if (seen.has(key)) { errors.push(`line ${line}: ${property} ${gl} "${vendor}" twice`); continue; }
    seen.add(key);
    const monthsTxt = v('months');
    const months = monthsTxt ? monthsTxt.split(/[;\s|/]+/).map(month).filter((m): m is number => m != null) : [];
    const bill = month(v('bill_month'));
    const stepM = month(v('step_month'));
    const stepP = v('step_pct') === '' ? null : Number(v('step_pct').replace('%', '')) / 100;
    const per = (v('per') || 'month').toLowerCase() === 'total' ? 'total' : 'month';
    const mode = (v('mode') || 'replace').toLowerCase() === 'add' ? 'add' : 'replace';
    const contract: Contract = {
      vendor, gl, kind, amount: Math.round(amount * 100) / 100,
      ...(kind === 'monthly' ? { per } : {}),
      months: kind === 'annual' ? [] : [...new Set(months)].sort((a, b) => a - b),
      billMonth: kind === 'annual' ? (bill || 12) : null,
      stepMonth: stepM, stepPct: stepP != null && Number.isFinite(stepP) ? stepP : null,
      mode, source: `repo: data/contracts ${year}`,
    } as Contract;
    rows.push({ property, year, gl, vendor, contract, note: v('note'), line, wholeGl: /^(y|yes|true|1|x)$/i.test(v('whole_gl')) });
  }
  return { rows, errors };
}

/** A contract's identity across the page and the repo file: property + year + GL + vendor (case and spacing ignored). */
export function contractKey(property: string, year: number, gl: string, vendor: string): string {
  return `${String(property).toLowerCase()}:${year}:${gl}:${String(vendor).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}
/** A stable fingerprint of what a repo row says (a changed file row is reloaded; an unchanged one is left alone). */
export function contractHash(c: Contract, note = ''): string {
  const pick = { gl: c.gl, vendor: c.vendor, kind: c.kind, amount: c.amount, per: (c as any).per ?? null, months: c.months || [], billMonth: c.billMonth ?? null, stepMonth: c.stepMonth ?? null, stepPct: c.stepPct ?? null, mode: c.mode || 'replace', note };
  const s = JSON.stringify(pick);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
