/* The contracts register (migration 019; Troy 2026-11-17). One row per contract per property per budget year, in the
   region's schema. Every budget reads its property's contracts for its year from here (loadBudget sets
   budget.inputs.contracts from it), and every path that used to write a budget's list writes here instead:
   - the Contracts page and its row API (one row at a time: add, change, remove);
   - the per-budget Contracts dialog and the review workbook (a budget's whole list: `syncContractList`);
   - the repo file data/contracts/<region>/<year>.csv, loaded on every deploy (`syncRepoContracts`).
   A row changed on the page after the file loaded it keeps the page's version (`ui_edited`). */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { query } from './db.js';
import type { Contract } from '../shared/domain.js';
import { parseContractsCsv, contractKey, contractHash } from '../shared/contractsFile.js';

export interface RegisterRow { id: string; property_code: string; year: number; gl: string; vendor: string; data: Contract & { note?: string }; origin: string; ui_edited: boolean; updated_by: string; updated_at: string }

const clean = (c: any): Contract & { note?: string } => {
  const kind = c.kind === 'annual' || c.kind === 'perUnit' ? c.kind : 'monthly';
  const months = Array.isArray(c.months) ? [...new Set(c.months.map((m: any) => Math.round(Number(m))).filter((m: number) => m >= 1 && m <= 12))].sort((a: any, b: any) => a - b) : [];
  const n = (v: any) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    vendor: String(c.vendor || '').trim().slice(0, 120), gl: String(c.gl || '').trim(), kind, amount: Math.round((Number(c.amount) || 0) * 100) / 100,
    ...(kind === 'monthly' ? { per: c.per === 'total' ? 'total' : 'month' } : {}),
    months: kind === 'annual' ? [] : months as number[],
    billMonth: kind === 'annual' ? (n(c.billMonth) && n(c.billMonth)! >= 1 && n(c.billMonth)! <= 12 ? n(c.billMonth) : 12) : null,
    stepMonth: n(c.stepMonth), stepPct: n(c.stepPct),
    mode: c.mode === 'add' ? 'add' : 'replace',
    source: String(c.source || '').slice(0, 200),
    ...(c.review ? { review: c.review } : {}),
    ...(c.note ? { note: String(c.note).slice(0, 500) } : {}),
  } as any;
};
const newId = (property: string, year: number) => `${property.toLowerCase()}:${year}:c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A property's contracts for a year, as the engine reads them (id = the register row's id). */
export async function contractsFor(property: string, year: number): Promise<Contract[]> {
  const rows = (await query(`select id, data from contracts where lower(property_code)=lower($1) and year=$2 order by gl, vendor, id`, [property, year])).rows as { id: string; data: any }[];
  return rows.map((r) => ({ ...r.data, id: r.id }));
}
export async function contractsForYear(year: number): Promise<RegisterRow[]> {
  return (await query(`select id, property_code, year, gl, vendor, data, origin, ui_edited, updated_by, updated_at from contracts where year=$1 order by property_code, gl, vendor, id`, [year])).rows as RegisterRow[];
}
export async function contractYears(): Promise<number[]> {
  return (await query(`select distinct year from contracts order by year desc`)).rows.map((r: any) => Number(r.year));
}
export async function getContract(id: string): Promise<RegisterRow | null> {
  return ((await query(`select id, property_code, year, gl, vendor, data, origin, ui_edited, updated_by, updated_at from contracts where id=$1`, [id])).rows[0] as RegisterRow) || null;
}

/** One row from the page / the API: create (no id) or change. Returns the row. */
export async function saveContract(input: { id?: string | null; property: string; year: number; contract: any }, user: string): Promise<RegisterRow> {
  const property = String(input.property || '').toLowerCase().trim();
  const year = Number(input.year);
  const c = clean(input.contract || {});
  if (!/^[a-z0-9]{2,8}$/.test(property)) throw new Error('Pick a property');
  if (!(year >= 2000 && year <= 2100)) throw new Error('Pick a budget year');
  if (!/^\d{4}$/.test(c.gl)) throw new Error('Pick a GL');
  if (!(c.amount > 0)) throw new Error('Type an amount above zero');
  if (input.id) {
    const r = await query(`update contracts set property_code=$2, year=$3, gl=$4, vendor=$5, data=$6, ui_edited=true, updated_by=$7, updated_at=now() where id=$1 returning id`,
      [input.id, property, year, c.gl, c.vendor, JSON.stringify(c), user]);
    if (!r.rowCount) throw new Error('That contract no longer exists');
    return (await getContract(input.id))!;
  }
  const id = newId(property, year);
  await query(`insert into contracts (id, property_code, year, gl, vendor, data, origin, updated_by) values ($1,$2,$3,$4,$5,$6,'ui',$7)`,
    [id, property, year, c.gl, c.vendor, JSON.stringify(c), user]);
  return (await getContract(id))!;
}
export async function deleteContract(id: string): Promise<RegisterRow | null> {
  const row = await getContract(id);
  if (row) await query(`delete from contracts where id=$1`, [id]);
  return row;
}

/** A budget's whole list (the per-budget dialog, the review workbook): the register for that property and year becomes
    exactly this list — rows kept by id, new ones added, missing ones removed. */
export async function syncContractList(property: string, year: number, list: any[], user: string, origin: 'ui' | 'review'): Promise<void> {
  const prop = String(property).toLowerCase();
  const cur = new Map((await query(`select id from contracts where lower(property_code)=$1 and year=$2`, [prop, year])).rows.map((r: any) => [r.id, true]));
  const keep = new Set<string>();
  for (const raw of list || []) {
    if (!raw || !/^\d{4}$/.test(String(raw.gl || '').trim()) || !(Number(raw.amount) > 0)) continue;
    const c = clean(raw);
    const id = raw.id && cur.has(String(raw.id)) ? String(raw.id) : raw.id && String(raw.id).startsWith(`${prop}:${year}:`) ? String(raw.id) : `${prop}:${year}:${String(raw.id || '').replace(/[^A-Za-z0-9_-]/g, '') || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)}`;
    keep.add(id);
    const rowOrigin = c.review ? 'review' : origin;
    await query(`insert into contracts (id, property_code, year, gl, vendor, data, origin, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8)
                 on conflict (id) do update set gl=excluded.gl, vendor=excluded.vendor, data=excluded.data, updated_by=excluded.updated_by, updated_at=now(),
                   ui_edited = contracts.ui_edited or ($7 = 'ui' and contracts.data is distinct from excluded.data)`,
      [id, prop, year, c.gl, c.vendor, JSON.stringify(c), rowOrigin, user]);
  }
  for (const id of cur.keys()) if (!keep.has(id)) await query(`delete from contracts where id=$1`, [id]);
}

/** The repo file(s) for a region, on boot: add / update the file's rows; a row changed on the page since keeps the page's
    version; a row the file loaded and no longer lists is removed (unless it was changed on the page). Returns which
    property / years changed (their budgets are recalculated) and the file's problems. */
export async function syncRepoContracts(region: string, dir = join(process.cwd(), 'data', 'contracts')): Promise<{ changed: { property: string; year: number }[]; loaded: number; errors: string[] }> {
  const folder = join(dir, region);
  const changed = new Map<string, { property: string; year: number }>();
  const errors: string[] = [];
  let loaded = 0;
  if (!existsSync(folder)) return { changed: [], loaded, errors };
  for (const f of readdirSync(folder).filter((x) => /^\d{4}\.csv$/i.test(x)).sort()) {
    const year = Number(f.slice(0, 4));
    const { rows, removes, errors: errs } = parseContractsCsv(readFileSync(join(folder, f), 'utf8'), year);
    errors.push(...errs.map((e) => `${region}/${f} ${e}`));
    const inFile = new Set<string>();
    for (const r of rows) {
      const key = contractKey(r.property, year, r.gl, r.vendor);
      inFile.add(key);
      const c = { ...r.contract, ...(r.note ? { note: r.note } : {}) };
      const hash = contractHash(r.contract, r.note);
      // a row with the same identity: the repo's own, or one typed before (migrated / page) — matched on property, year,
      // GL and vendor
      const ex = (await query(`select id, origin, repo_hash, ui_edited from contracts where lower(property_code)=$1 and year=$2 and gl=$3 and trim(both '-' from lower(regexp_replace(vendor, '[^A-Za-z0-9]+', '-', 'g'))) = $4 order by (origin='repo') desc limit 1`,
        [r.property, year, r.gl, key.split(':').slice(3).join(':')])).rows[0] as any;
      if (ex && ex.ui_edited) continue;                                    // changed on the page: the page wins
      if (ex && ex.repo_hash === hash) { loaded++; continue; }             // already loaded as is
      if (ex) await query(`update contracts set data=$2, vendor=$3, origin='repo', repo_hash=$4, updated_by='repo', updated_at=now() where id=$1`, [ex.id, JSON.stringify(c), r.vendor, hash]);
      else await query(`insert into contracts (id, property_code, year, gl, vendor, data, origin, repo_hash, updated_by) values ($1,$2,$3,$4,$5,$6,'repo',$7,'repo')`,
        [`r:${key}`, r.property, year, r.gl, r.vendor, JSON.stringify(c), hash]);
      changed.set(`${r.property}:${year}`, { property: r.property, year });
      loaded++;
    }
    // whole_gl: the file's rows are the whole GL for that property and year. Contracts on it from the review workbook or
    // carried over from a budget's own list are removed; rows added or changed on the page stay (and are reported).
    const whole = new Map<string, { property: string; gl: string }>();
    for (const r of rows) if (r.wholeGl) whole.set(`${r.property}:${r.gl}`, { property: r.property, gl: r.gl });
    for (const w of whole.values()) {
      const others = (await query(`select id, vendor, origin, ui_edited from contracts where lower(property_code)=$1 and year=$2 and gl=$3 and origin <> 'repo'`, [w.property, year, w.gl])).rows as any[];
      for (const o of others) {
        if (o.origin === 'ui' || o.ui_edited) { errors.push(`${region}/${f} ${w.property} ${w.gl}: kept "${o.vendor}" (added or changed on the page) next to the file's rows`); continue; }
        await query(`delete from contracts where id=$1`, [o.id]);
        changed.set(`${w.property}:${year}`, { property: w.property, year });
      }
    }
    // mode=remove: that vendor off that GL — a contract from the review workbook or a budget's own list (ButterflyMX
    // filed on 6324, so the review's 6331 copy goes: Troy 2026-11-19); rows added or changed on the page stay
    for (const rm of removes) {
      const hits = (await query(`select id, vendor, origin, ui_edited from contracts where lower(property_code)=$1 and year=$2 and gl=$3 and origin <> 'repo' and trim(both '-' from lower(regexp_replace(vendor, '[^A-Za-z0-9]+', '-', 'g'))) = $4`,
        [rm.property, year, rm.gl, contractKey(rm.property, year, rm.gl, rm.vendor).split(':').slice(3).join(':')])).rows as any[];
      for (const o of hits) {
        if (o.origin === 'ui' || o.ui_edited) { errors.push(`${region}/${f} line ${rm.line}: kept ${rm.property} ${rm.gl} "${o.vendor}" (added or changed on the page)`); continue; }
        await query(`delete from contracts where id=$1`, [o.id]);
        changed.set(`${rm.property}:${year}`, { property: rm.property, year });
      }
    }
    // the file's own rows it no longer lists (never one changed on the page)
    const gone = (await query(`select id, property_code, gl, vendor from contracts where origin='repo' and year=$1 and not ui_edited`, [year])).rows as any[];
    for (const g of gone) {
      if (inFile.has(contractKey(g.property_code, year, g.gl, g.vendor))) continue;
      await query(`delete from contracts where id=$1`, [g.id]);
      changed.set(`${String(g.property_code).toLowerCase()}:${year}`, { property: String(g.property_code).toLowerCase(), year });
    }
  }
  return { changed: [...changed.values()], loaded, errors };
}
