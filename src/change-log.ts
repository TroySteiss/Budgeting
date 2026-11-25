/* CHANGE LOG (Troy 2026-11-24: "keep a log of changes under more, with notes about who made them, and if they came from
   an import. This should not slow down the tool, and can be done in batches. Admin only insight").

   - Writes never wait: `logChange` puts the entry on an in-memory queue, saved in one multi-row insert per region every
     few seconds (or sooner once the queue is long). Nothing a request does waits on the log.
   - Each entry is tagged with the budget(s) it touched (`budget_ids`) and `source` 'import' when it came from a file.
   - What moved: every request runs inside a change context (`withChangeCtx`, from each router's `h()`). `saveLines`
     reports the GLs whose months, note, formula or lock changed (`noteLineDiffs`), and the request's log entry for that
     budget carries them (GL, year before → after, months changed). Lines saved with no named action are logged under
     the request's last action, else as "lines saved".
   - Read back admin-only, 100 at a time (GET /budgets/:id/changes). */
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentRegion, inRegion, query } from './db.js';

type Region = ReturnType<typeof currentRegion>;
export type LineDiff = { gl: string; from: number; to: number; n: number; note?: string; m?: [string, string]; lock?: boolean };
interface Entry { region: Region; at: Date; username: string; action: string; detail: any; budgetIds: number[]; source: string; saved: boolean }
interface Ctx { username: string; lines: Map<number, Map<string, LineDiff>>; entries: Entry[] }

const queue: Entry[] = [];
let timer: NodeJS.Timeout | null = null;
const FLUSH_MS = 3000;
const SOON = 200;          // queue length that flushes early
const MAX_LINES = 80;      // line diffs kept per entry (the count is always kept)

const ctxStore = new AsyncLocalStorage<Ctx>();

/** Is this action a file coming in? (uploads, imported drafts, the review workbook, Yardi CSVs) */
export function sourceOf(action: string): string {
  return /import|upload|yardi csv|nd review apply|re-file/i.test(action) ? 'import' : '';
}

const idsOf = (b: any): number[] =>
  [...new Set((Array.isArray(b) ? b : b == null ? [] : [b]).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];

/* Actions whose detail `id` is the budget (the same list migration 021 tags older entries from). Other actions name
   their budgets in `budgets` / `ids` (contracts, recalculate many, review fix, copy formulas, exports). */
const BUDGET_ID_ACTIONS = new Set(['create budget', 'relink annual data', 'relink budget snapshots', 'update budget inputs', 'edit actualized month',
  'edit line', 'save point', 'restore save point', 'undo (restore snapshot)', 'apply formula set', 'review budget defaults',
  'clear defaults review', 'set standing MROUND', 'untie category from UW', 'tie category to UW (acquisition plan)',
  'tie growth target', 'quarter shift', 'quarter shift cleared', 'rebalance category', 'delete budget', 'budget summary email',
  'import draft workbook (review)', 'import review decisions', 'import review: month edited', 'actualize month',
  'release actualized month', 'actualize month (Yardi CSV)', 'ND review apply', 'ND review apply (new budget)',
  'ND review re-file contracts']);
export function budgetsOf(action: string, detail: any): number[] {
  const d = detail || {};
  const own = BUDGET_ID_ACTIONS.has(action) || /^tie (NOI|income) to /.test(action) ? [d.id] : [];
  const listed = [...(Array.isArray(d.budgets) ? d.budgets : []), ...(Array.isArray(d.ids) ? d.ids : [])].map((x: any) => (x && typeof x === 'object' ? x.id : x));
  return idsOf([...own, ...listed]);
}

function attach(entry: Entry, ctx: Ctx, ids: number[]): void {
  const lines: (LineDiff & { b?: number })[] = [];
  for (const id of ids) {
    const m = ctx.lines.get(id);
    if (!m) continue;
    for (const d of m.values()) lines.push(ids.length > 1 ? { ...d, b: id } : d);
    ctx.lines.delete(id);
  }
  if (!lines.length) return;
  const prev: any[] = entry.detail.lines || [];
  const all = [...prev, ...lines];
  entry.detail = { ...entry.detail, lines: all.slice(0, MAX_LINES), linesTotal: (entry.detail.linesTotal || prev.length) + lines.length };
}

function enqueue(e: Entry): void {
  queue.push(e);
  if (queue.length >= SOON) { void flushChangeLog(); return; }
  if (!timer) { timer = setTimeout(() => { void flushChangeLog(); }, FLUSH_MS); timer.unref?.(); }
}

/** Log an action. `budgets`: the budget id(s) it touched (the per-budget log reads these). Never throws, never waits. */
export function logChange(username: string, action: string, detail: any, budgets?: number | string | (number | string)[] | null): void {
  try {
    const ctx = ctxStore.getStore();
    const ids = budgets === undefined ? budgetsOf(action, detail) : idsOf(budgets);
    const e: Entry = { region: currentRegion(), at: new Date(), username: username || ctx?.username || '', action, detail: { ...(detail || {}) }, budgetIds: ids, source: sourceOf(action), saved: false };
    if (ctx) { attach(e, ctx, ids); ctx.entries.push(e); }
    enqueue(e);
  } catch { /* the log never breaks a request */ }
}

/** saveLines: the GLs this save changed on a budget (only inside a request). Two saves in one request merge. */
export function noteLineDiffs(budgetId: number, diffs: LineDiff[]): void {
  const ctx = ctxStore.getStore();
  if (!ctx || !diffs.length) return;
  let m = ctx.lines.get(budgetId);
  if (!m) { m = new Map(); ctx.lines.set(budgetId, m); }
  for (const d of diffs) {
    const was = m.get(d.gl);
    m.set(d.gl, was ? { ...d, from: was.from, n: Math.max(was.n, d.n), m: was.m && d.m ? [was.m[0], d.m[1]] : d.m || was.m } : d);
  }
}
/** Is a change context open? (saveLines only reads the old lines when one is) */
export const trackingChanges = (): boolean => !!ctxStore.getStore();

/** Lines saved but not claimed by a logged action go on the request's last entry for that budget (or its last
    entry at all), else their own "lines saved" entry. */
function finish(ctx: Ctx, fallback: string): void {
  for (const id of [...ctx.lines.keys()]) {
    const own = [...ctx.entries].reverse().find((e) => !e.saved && e.budgetIds.includes(id));
    if (own) { attach(own, ctx, [id]); continue; }
    const last = ctx.entries[ctx.entries.length - 1];
    const e: Entry = { region: currentRegion(), at: new Date(), username: ctx.username, action: last ? last.action : fallback, detail: last ? { via: last.action } : {}, budgetIds: [id], source: last ? last.source : '', saved: false };
    attach(e, ctx, [id]);
    enqueue(e);
  }
}

/** The fallback action for lines a request saved with nothing logged: its route, e.g. "lines saved (recalc)". */
export function changeLabel(req: { route?: { path?: string }; path: string }): string {
  const p = String(req.route?.path || req.path || '').replace(/^\/budgets\/:id\/?/, '').replace(/[-/:]+/g, ' ').trim();
  return `lines saved (${p || 'budget'})`;
}
/** Run a request inside a change context. */
export async function withChangeCtx<T>(username: string, fallback: string, fn: () => Promise<T>): Promise<T> {
  const ctx: Ctx = { username, lines: new Map(), entries: [] };
  return ctxStore.run(ctx, async () => {
    try { return await fn(); } finally { try { finish(ctx, fallback); } catch { /* never */ } }
  });
}

/** Save everything queued (one insert per region per 200 rows). Safe to call any time. */
export async function flushChangeLog(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const batch = queue.splice(0, queue.length);
  if (!batch.length) return;
  for (const e of batch) e.saved = true;
  const byRegion = new Map<Region, Entry[]>();
  for (const e of batch) { const a = byRegion.get(e.region) || []; a.push(e); byRegion.set(e.region, a); }
  await Promise.all([...byRegion].map(async ([r, list]) => {
    for (let k = 0; k < list.length; k += 200) {
      const params: any[] = [];
      const vals = list.slice(k, k + 200).map((e) => {
        const b = params.length;
        params.push(e.at, e.username, e.action, JSON.stringify(e.detail), e.budgetIds, e.source);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4}::jsonb,$${b + 5}::int[],$${b + 6})`;
      });
      await inRegion(r, () => query(`insert into change_log(at, username, action, detail, budget_ids, source) values ${vals.join(',')}`, params))
        .catch((err) => console.error('change log insert failed:', err?.message || err));
    }
  }));
}

/** Old vs new lines of one budget: the GLs whose months (≥ $0.50 in a month), note, formula or lock changed. */
export function diffLines(
  oldRows: { gl_code: string; months: any; note?: string; override?: boolean; method?: string | null }[],
  newRows: { gl_code: string; months: any; note?: string; override?: boolean; driver?: any }[],
): LineDiff[] {
  const num = (v: any) => Number(v) || 0;
  const arr = (m: any): number[] => (Array.isArray(m) ? m : typeof m === 'string' ? JSON.parse(m) : []).map(num);
  const olds = new Map(oldRows.map((r) => [r.gl_code, { m: arr(r.months), note: String(r.note || ''), ov: !!r.override, meth: String(r.method || '') }]));
  const news = new Map(newRows.map((r) => [r.gl_code, { m: arr(r.months), note: String(r.note || ''), ov: !!r.override, meth: String(r.driver?.method || '') }]));
  const out: LineDiff[] = [];
  for (const gl of new Set([...olds.keys(), ...news.keys()])) {
    const o = olds.get(gl), n = news.get(gl);
    const om = o?.m || [], nm = n?.m || [];
    let changed = 0;
    for (let i = 0; i < 12; i++) if (Math.abs(num(om[i]) - num(nm[i])) >= 0.5) changed++;
    const noteCh = (o?.note || '') !== (n?.note || '');
    const methCh = (o?.meth || '') !== (n?.meth || '');
    const lockCh = !!o?.ov !== !!n?.ov;
    if (!changed && !noteCh && !methCh && !lockCh) continue;
    const yr = (m: number[]) => Math.round(m.reduce((a, v) => a + num(v), 0));
    const d: LineDiff = { gl, from: yr(om), to: yr(nm), n: changed };
    if (noteCh) d.note = n?.note || '';
    if (methCh) d.m = [o?.meth || '', n?.meth || ''];
    if (lockCh) d.lock = !!n?.ov;
    out.push(d);
  }
  return out.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from) || a.gl.localeCompare(b.gl));
}
