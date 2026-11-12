/* ============================================================================
   ND 2027 BUDGET REVIEW -> APPLY (Troy 2026-11-12). The "ND 2027 Budget Review" workbook carries an Apply tab:
   one row per site + GL + item (contracts, KB rules, Troy's 11/12 corrections) with 2027 monthly dollars and an
   action, "for Claude Code to push into the budgets", and an Apply Rules tab saying how. Troy picked "upload +
   preview + apply": this plans the changes for ONE budget; the server shows the plan, Troy ticks what goes in,
   and the picked changes are written as hand-typed lines after a save point. Pure, no IO.

   Apply Rules (the workbook's own words, condensed):
     push = N or action = check  -> never changes a budget; listed for Troy.
     never payroll (6400-6470: it lives on the Payroll tab) and never an income line (reclass excepted).
     set       the GL's months = the sum of the site's push = Y set rows for that GL.
     at_least  a floor, never a reduction: the site's budget summed over compare_pool (e.g. 6917+6921) against the
               sum of the push = Y at_least rows in that pool; a shortfall is added to each row's GL in proportion
               to the row's monthly amounts.
     add       the row's months added to the GL.
     reclass   the GL's whole budget moves to target_gl (no NOI change) — ND West reimbursements into 5170.
     rate      6112 = rate x prior-month total income: here, the fee line's own prior-month base re-priced.
     history   a move of more than 25% vs the T12 still goes in, flagged with the T12 figure.
   Order: reclass, set, at_least (against the budget after the sets), add, rate.
   ========================================================================== */

import type { Contract, Months } from './domain.js';
import { contractLine } from './annual.js';

export type ApplyAction = 'set' | 'at_least' | 'add' | 'rate' | 'reclass' | 'check';
export interface ApplyRow {
  rowId: string; site: string; gl: string; glName: string; item: string; action: ApplyAction;
  /** GLs the at_least floor compares as one pool (compare_pool "6917+6921"); defaults to the row's GL */
  pool: string[];
  /** Jan..Dec 2027 (rates for action = rate) */
  months: number[];
  total: number; push: boolean;
  firmness: string; basis: string; source: string; contractsRow: string; historyNote: string; targetGl: string;
}
export interface ApplyChange {
  gl: string;
  oldMonths: number[]; newMonths: number[];
  rowIds: string[];
  /** what moved it: set / floor / add / reclass in / reclass out / rate */
  kinds: string[];
  notes: string[];
  /** worth a second look before it goes in (default unticked when `locked`) */
  flags: string[];
  /** the line was hand-typed (locked) before: replacing it is Troy's call, so it starts unticked */
  locked: boolean;
  /** which review rows set each month (budget-month index -> row ids): the grid marks exactly these cells and
      their hover names what each one is tied to (Troy 2026-11-12: "hover over these numbers and also see a note
      about what they are tied to") */
  cells: Record<number, string[]>;
  /** the GL is built from Contracts & known costs (set / add rows, and floor rows where the floor binds) rather than
      written as a locked line (Troy 2026-11-12: "You also did not push contract lines into the entire section made
      for contracts and known costs") */
  viaContracts?: boolean;
}
/** What a review row is, for the hover on the cells it set. */
export interface ApplyRowInfo { item: string; action: string; firmness: string; basis: string; source: string; contractsRow: string }
export interface ApplySkip { rowId: string; gl: string; item: string; action: string; total: number; why: string; basis: string; firmness: string }
export interface ApplyPlan { site: string; changes: ApplyChange[]; skipped: ApplySkip[]; floorsMet: { pool: string; budget: number; floor: number; rowIds: string[] }[]; rows: Record<string, ApplyRowInfo>;
  /** the contracts this plan files under Contracts & known costs, by GL (review contracts from an earlier apply on the
      same GL are replaced; contracts typed by hand stay) */
  contracts: Contract[] }

/** A review row as contracts: one per distinct monthly amount (snow $14,770 in Jan–Apr + Nov–Dec is one contract;
    a row whose amount changes mid-year is two), billed in the months it names. set / floor rows replace the line,
    add rows sit on top of it. The row travels with each contract for the cells' hover. */
export function rowContracts(r: ApplyRow, file?: string): Contract[] {
  const groups = new Map<number, number[]>();
  r.months.forEach((v, i) => { const a = r2(Number(v) || 0); if (a > 0) { if (!groups.has(a)) groups.set(a, []); groups.get(a)!.push(i + 1); } });
  const vendor = (r.item.split(/\s+[–—-]\s+/)[1] || r.item).slice(0, 80);
  let k = 0;
  return [...groups].map(([amount, months]) => ({
    id: `rv-${r.rowId}${groups.size > 1 ? `-${++k}` : ''}`, vendor, gl: r.gl, kind: 'monthly' as const, per: 'month' as const, amount, months,
    mode: r.action === 'add' ? 'add' as const : 'replace' as const,
    source: [r.firmness, r.source].filter(Boolean).join(' · ').slice(0, 300),
    review: { rowId: r.rowId, item: r.item, action: r.action, firmness: r.firmness, basis: r.basis, source: r.source, contractsRow: r.contractsRow, ...(file ? { file } : {}) },
  }));
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const sum = (m: number[]) => m.reduce((a, v) => a + (v || 0), 0);
const zero = () => Array(12).fill(0) as number[];
const isPayroll = (gl: string) => { const n = parseInt(gl, 10); return n >= 6400 && n <= 6470; };
const isIncome = (gl: string) => { const n = parseInt(gl, 10); return n < 6000; };
/** Troy 2026-11-12: "Trash and Pest are both separate GL from utilities reimbursement" — 5169 trash reimbursement and
    5158 pest fee stay on their own lines at every site (flat fee or rolling out); only the other reimbursements fold
    into 5170. A workbook reclass of either is not applied. */
export const NEVER_RECLASS = new Set(['5158', '5169']);

/** One budget's plan. `lines` = the budget's lines by GL, CALENDAR months Jan..Dec (2027 annual budgets start in
    January); `t12` = trailing-12 by GL (calendar) for the 25% history check; `fee` = the 6112 line's driver
    (mgmtPct: pct, firstYear { pct, months }) for a rate row. */
export function planApply(rows: ApplyRow[], b: {
  site: string;
  lines: Map<string, { months: number[]; override?: boolean; driver?: any }>;
  t12?: Record<string, number[]> | null;
  /** lines a set must not take below (Troy 2026-11-12: "CWND and RRND have elevated insurance rates in the model, so
      don't suggest changing things like that"): GL -> the site's own floor and why (the UW insurance $/unit × units) */
  floors?: Record<string, { annual: number; why: string }>;
  /** the budget's Contracts & known costs (inputs.contracts) */
  contracts?: Contract[] | null;
}): ApplyPlan {
  const site = b.site.toLowerCase();
  const mine = rows.filter((r) => r.site.toLowerCase() === site);
  const skipped: ApplySkip[] = [];
  const skip = (r: ApplyRow, why: string) => skipped.push({ rowId: r.rowId, gl: r.gl, item: r.item, action: r.action, total: r.total, why, basis: r.basis, firmness: r.firmness });
  // the working copy: every GL touched starts from the budget as it stands
  const cur = new Map<string, number[]>();
  const get = (gl: string) => { if (!cur.has(gl)) cur.set(gl, [...(b.lines.get(gl)?.months || zero())].map(Number)); return cur.get(gl)!; };
  const why = new Map<string, { rowIds: Set<string>; kinds: Set<string>; notes: string[]; cells: Map<number, Set<string>> }>();
  // `idx` = the months this row set on this GL
  const tag = (gl: string, r: ApplyRow, kind: string, note: string, idx: number[]) => {
    if (!why.has(gl)) why.set(gl, { rowIds: new Set(), kinds: new Set(), notes: [], cells: new Map() });
    const w = why.get(gl)!; w.rowIds.add(r.rowId); w.kinds.add(kind); w.notes.push(`${r.rowId} ${note}`);
    for (const i of idx) { if (!w.cells.has(i)) w.cells.set(i, new Set()); w.cells.get(i)!.add(r.rowId); }
  };
  const ALL = [...Array(12).keys()];
  const nz = (m: number[]) => ALL.filter((i) => Math.abs(Number(m[i]) || 0) >= 0.005);
  const live: ApplyRow[] = [];
  for (const r of mine) {
    if (!r.push) { skip(r, r.action === 'check' ? 'check only — for review' : 'push = N — needs confirmation'); continue; }
    if (r.action === 'check') { skip(r, 'check only — for review'); continue; }
    if (isPayroll(r.gl)) { skip(r, 'payroll — lives on the Payroll tab'); continue; }
    if (isIncome(r.gl) && r.action !== 'reclass') { skip(r, 'income line — the rules never push income (reclass excepted)'); continue; }
    if (r.action === 'reclass' && !/^\d{4}$/.test(r.targetGl || '')) { skip(r, 'reclass with no target GL'); continue; }
    if (r.action === 'reclass' && NEVER_RECLASS.has(r.gl)) { skip(r, `${r.gl === '5169' ? 'trash' : 'pest'} reimbursement stays on its own GL, not folded into ${r.targetGl}`); continue; }
    live.push(r);
  }
  // 1. reclass: the GL's whole budget moves to the target
  for (const r of live.filter((x) => x.action === 'reclass')) {
    const src = get(r.gl), tgt = get(r.targetGl);
    const moved = sum(src);
    if (!moved) { skip(r, `nothing budgeted on ${r.gl} to move`); continue; }
    const idx = nz(src);
    for (let i = 0; i < 12; i++) { tgt[i] = r2(tgt[i] + src[i]); src[i] = 0; }
    tag(r.gl, r, 'reclass out', `${r.item}: ${Math.round(moved).toLocaleString('en-US')} moved to ${r.targetGl}`, idx);
    tag(r.targetGl, r, 'reclass in', `${r.item}: ${Math.round(moved).toLocaleString('en-US')} from ${r.gl}`, idx);
  }
  // 2-4. CONTRACTS: set rows, floor rows where the floor binds, and add rows become contracts on their GL; the GL is
  // then built from all its contracts (hand-typed ones kept, earlier review ones replaced) by the engine's own helper
  const newContracts: Contract[] = [];
  const conGls = new Set<string>();
  const buildGl = (gl: string) => {
    const keep = (b.contracts || []).filter((c) => c && c.gl === gl && !c.review);
    const cs = [...keep, ...newContracts.filter((c) => c.gl === gl)];
    const prev = b.lines.get(gl);
    const cl = contractLine(cs, 0, 1, prev ? { months: prev.months as Months, driver: prev.driver } : null);
    cur.set(gl, [...cl.months]);
    conGls.add(gl);
  };
  // set: the site's set rows on a GL are its contracts (the line), unless that goes under a site floor
  const sets = new Map<string, ApplyRow[]>();
  for (const r of live.filter((x) => x.action === 'set')) { if (!sets.has(r.gl)) sets.set(r.gl, []); sets.get(r.gl)!.push(r); }
  for (const [gl, rs] of sets) {
    // a site-specific floor (the UW model's own rate): a set that would go under it is not applied
    const fl = b.floors?.[gl];
    const setTot = rs.reduce((a, r) => a + sum(r.months.map(Number)), 0);
    if (fl && setTot < fl.annual - 1) { for (const r of rs) skip(r, `${fl.why}: ${Math.round(setTot).toLocaleString('en-US')} would go under its ${Math.round(fl.annual).toLocaleString('en-US')}`); continue; }
    for (const r of rs) { newContracts.push(...rowContracts(r)); tag(gl, r, 'set', `${r.item} (${r.firmness}) → Contracts & known costs`, nz(r.months)); }
    buildGl(gl);
  }
  // at_least: a floor per compare pool — when the budget is under it, the pool's rows become the contracts on their
  // GLs; a pool already at or over its floor is left alone
  const floorsMet: ApplyPlan['floorsMet'] = [];
  const pools = new Map<string, ApplyRow[]>();
  for (const r of live.filter((x) => x.action === 'at_least')) { const k = (r.pool.length ? r.pool : [r.gl]).slice().sort().join('+'); if (!pools.has(k)) pools.set(k, []); pools.get(k)!.push(r); }
  for (const [k, rs] of pools) {
    const gls = k.split('+');
    const budget = r2(gls.reduce((a, gl) => a + sum(get(gl)), 0));
    const floor = r2(rs.reduce((a, r) => a + (Number(r.total) || sum(r.months)), 0));
    if (budget >= floor - 0.5) { floorsMet.push({ pool: k, budget, floor, rowIds: rs.map((r) => r.rowId) }); continue; }
    for (const r of rs) { newContracts.push(...rowContracts(r)); tag(r.gl, r, 'floor', `${r.item}: pool ${k} ${Math.round(budget).toLocaleString('en-US')} under the ${Math.round(floor).toLocaleString('en-US')} floor → Contracts & known costs (${r.firmness})`, nz(r.months)); }
    for (const gl of new Set(rs.map((r) => r.gl))) buildGl(gl);
  }
  // add: on top of the line's formula
  for (const r of live.filter((x) => x.action === 'add')) {
    newContracts.push(...rowContracts(r));
    tag(r.gl, r, 'add', `${r.item}: +${Math.round(sum(r.months)).toLocaleString('en-US')} (${r.firmness}) → Contracts & known costs`, nz(r.months));
    buildGl(r.gl);
  }
  // 5. rate: the fee line's own prior-month income base, re-priced at the row's monthly rates
  for (const r of live.filter((x) => x.action === 'rate')) {
    if (r.gl !== '6112') { skip(r, 'a rate row only prices the management fee (6112)'); continue; }
    const ln = b.lines.get('6112'); const d = ln?.driver || {};
    if (!ln || d.method !== 'mgmtPct' || !(Number(d.pct) > 0)) { skip(r, 'the fee line is not on its % of income formula — set the % under Assumptions'); continue; }
    const fy = d.firstYear && Array.isArray(d.firstYear.months) ? d.firstYear : null;
    const m = get('6112');
    for (let i = 0; i < 12; i++) {
      const rate = Number(r.months[i]);
      if (!(rate > 0)) continue;
      const oldRate = fy && fy.months.includes(i) ? Number(fy.pct) : Number(d.pct);
      if (!(oldRate > 0)) continue;
      m[i] = Math.round((Number(ln.months[i]) || 0) / oldRate * rate);
    }
    tag('6112', r, 'rate', `${r.item} (${r.firmness})`, ALL.filter((i) => Number(r.months[i]) > 0));
  }
  // the changes, with the history check
  const changes: ApplyChange[] = [];
  for (const [gl, w] of why) {
    const oldM = [...(b.lines.get(gl)?.months || zero())].map(Number), newM = get(gl);
    const delta = sum(newM) - sum(oldM);
    if (oldM.every((v, i) => Math.abs(v - newM[i]) < 0.005)) continue;
    const flags: string[] = [];
    const t = b.t12?.[gl] ? sum(b.t12[gl]) : null;
    const reclass = w.kinds.has('reclass in') || w.kinds.has('reclass out');
    if (!reclass && t != null && Math.abs(t) >= 1 && Math.abs(sum(newM) - t) / Math.abs(t) > 0.25) flags.push(`${sum(newM) > t ? '+' : ''}${Math.round(((sum(newM) - t) / Math.abs(t)) * 100)}% vs the T12 (${Math.round(t).toLocaleString('en-US')})`);
    if (!reclass && (t == null || Math.abs(t) < 1) && Math.abs(delta) >= 1) flags.push('nothing on this GL in the T12');
    const locked = !!b.lines.get(gl)?.override;
    if (locked) flags.push('replaces a hand-typed line');
    for (const r of mine) if (w.rowIds.has(r.rowId) && r.historyNote && !flags.includes(`history: ${r.historyNote}`)) flags.push(`history: ${r.historyNote}`);
    const cells: Record<number, string[]> = {};
    for (const [i, ids] of w.cells) cells[i] = [...ids];
    changes.push({ gl, oldMonths: oldM, newMonths: newM, rowIds: [...w.rowIds], kinds: [...w.kinds], notes: w.notes, flags, locked, cells, ...(conGls.has(gl) ? { viaContracts: true } : {}) });
  }
  changes.sort((a, b2) => a.gl.localeCompare(b2.gl));
  const info: Record<string, ApplyRowInfo> = {};
  for (const r of mine) info[r.rowId] = { item: r.item, action: r.action, firmness: r.firmness, basis: r.basis, source: r.source, contractsRow: r.contractsRow };
  return { site: b.site, changes, skipped, floorsMet, rows: info, contracts: newContracts };
}
