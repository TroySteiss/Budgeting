/* Pay-rates (raise cycle) domain — pure functions, unit-tested.
   Per-seat rates are stored for this feature (Troy sign-off 2026-10-28); the
   math here is shared by the payroll routes and mirrored in app.js. */

export interface SeatAllocation { code: string; pct: number }          // pct 0..1
export interface StaffingPerson {
  key: string;                       // PrismID / employee number / normalized name
  name: string;
  position: string;
  payMethod: 'Hourly' | 'Salary';
  payRate: number;                   // $/hr (Hourly) or $/yr (Salary)
  monthlyBenefits: number;
  startDate: string | null;          // ISO date
  status: string;                    // FULL / PART / ...
  oldPay: number | null;             // prior rate when the report carries one
  allocations: SeatAllocation[];
  rm: boolean;                       // Regional-Manager position → pay masked outside RM_PAY_USERS
  /** The payroll workbook's own section label ("Minot Support Staff",
      "Bismarck 4", …) and row order — the tab and the Excel export group
      people exactly where the workbook puts them (Troy 2026-10-30). */
  group?: string | null;
  ord?: number;
  /** Explicit wage GL from the payroll detail report's Booked-To-GL column —
      beats the position mapping when present. */
  gl?: string | null;
}

/** One person out of the payroll DETAIL report: canonical title, the GL their
    pay actually books to, and the pay basis their CHECK HISTORY shows —
    salaried people draw the same gross every check with no overtime; hourly
    checks vary and carry OT. null = too few checks to tell. */
export interface DetailPerson {
  name: string;
  title: string;
  gl: string | null;
  /** gross of the MOST RECENT check — a salaried person's current pay
      (promotions included, Troy 2026-11-02): salary = lastGross × 26. */
  lastGross: number | null;
}

/** Monarch runs bi-weekly payroll (26 checks/yr — the budget instructions'
    accrual note), so a salaried annual = one check × 26. */
export const PAY_PERIODS_PER_YEAR = 26;

/** MI (corporate) covers 30% of every Regional Manager's pay (Troy
    2026-11-02): an RM's property allocations are rescaled to total exactly
    70%, keeping the mix — the corporate share is never budgeted at the
    properties. Applied on READ like the other rules, so no re-upload. */
export const RM_CORPORATE_SHARE = 0.30;
export function normalizeRmCorporateShare(people: StaffingPerson[]): number {
  const target = 1 - RM_CORPORATE_SHARE;
  let changed = 0;
  for (const p of people) {
    if (!p.rm || !p.allocations || !p.allocations.length) continue;
    const s = p.allocations.reduce((a, x) => a + x.pct, 0);
    if (!(s > 0) || Math.abs(s - target) < 0.001) continue;
    for (const a of p.allocations) a.pct = Math.round((a.pct / s) * target * 10000) / 10000;
    changed++;
  }
  return changed;
}

const nameTokens = (n: string): string[] => String(n || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
/** "Don Butterfield" ↔ "Donald Butterfield", middle names ignored: first
    tokens prefix-match either way, last tokens equal. */
export function sameName(a: string, b: string): boolean {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.length || !y.length) return false;
  if (x.join('') === y.join('')) return true;
  const firstOk = x[0] === y[0] || x[0].startsWith(y[0]) || y[0].startsWith(x[0]);
  return firstOk && x[x.length - 1] === y[y.length - 1];
}

/** Fold the detail report onto the roster: canonical title, booked-to GL,
    and the position-convention pay basis. A person flipping Hourly → Salary
    carries their annualized rate (hourly × 2080). Pure; returns counts. */
export function applyStaffingDetail(people: StaffingPerson[], details: DetailPerson[]): { matched: number; flippedToSalary: number } {
  let matched = 0, flipped = 0;
  for (const p of people) {
    const d = details.find((x) => sameName(x.name, p.name));
    if (!d) continue;
    matched++;
    if (d.title) p.position = d.title;
    if (d.gl) p.gl = d.gl;
    p.rm = isRmPosition(p.position);
    // the TITLE decides the basis (all PMs are Salary — Troy 2026-11-02); a
    // salaried person's CURRENT pay is their latest check × 26, so promotions
    // beat the workbook's stale annual
    const latestAnnual = d.lastGross && d.lastGross > 0 ? r2(d.lastGross * PAY_PERIODS_PER_YEAR) : null;
    if (isSalariedPosition(p.position)) {
      if (p.payMethod === 'Hourly') { p.payMethod = 'Salary'; p.payRate = latestAnnual ?? r2(p.payRate * 2080); flipped++; }
      else if (latestAnnual) p.payRate = latestAnnual;
    } else if (p.payMethod === 'Salary') {
      p.payMethod = 'Hourly'; p.payRate = r2(p.payRate / 2080);
    }
  }
  return { matched, flippedToSalary: flipped };
}

/* Position → Monarch wage GL. TWO BUCKETS (Troy 2026-11-02): office staff →
   6402 ADMIN GROSS WAGES, maintenance staff (rovers, housekeepers and grounds
   crews included) → 6404 MAINT GROSS WAGES. Nothing maps to 6405 landscaping
   (Troy 2026-08-21: landscaping is contracted work, not payroll) and nothing
   maps to 6407 any more — rovers are maintenance. Unrecognized titles land in
   6404 and are reported in unmappedPositions. */
export const POSITION_GL: [RegExp, string][] = [
  // 2027 HRIS titles abbreviate: "Dual Site Property Mgr", "Roving Asst Prop Mgr", "Asst Reg Property Mgr II"
  [/regional|\breg\b|lms|arm|bookkeep|office|leasing|apm|\bpm\b|manager|\bmgr\b|property|\bprop\b|dual ?site|market/i, '6402'],
  [/rover|supervisor|tech|housekeep|maint|janitor|porter|ground|landscap/i, '6404'],
];
export function positionGl(position: string): { gl: string; mapped: boolean } {
  for (const [re, gl] of POSITION_GL) if (re.test(position)) return { gl, mapped: true };
  return { gl: '6404', mapped: false };
}

/** Regional-Manager-level positions: pay masked for everyone outside RM_PAY_USERS. */
export const isRmPosition = (position: string): boolean => /regional|\breg\b(?=.*\bprop)/i.test(String(position || ''));   // "Asst Reg Property Mgr II" too

/** THE pay-basis rule (Troy 2026-11-02, final): ALL PMs are Salary — as are
    Regionals, Area/Dual-Site managers and the LMS; assistants and site staff
    are hourly. The title decides; check-history guessing was wrong (leave and
    partial periods make even salaried checks vary). */
export function isSalariedPosition(position: string): boolean {
  const t = String(position || '');
  if (/asst|assistant/i.test(t)) return false;
  return /regional|\blms\b|leasing marketing|dual ?site|area prop|property m(anage|g)r|property manager|\bpm\b/i.test(t);
}

/** Enforce the title rule on a roster IN PLACE — applied when snapshots are
    READ, so a fix never needs the reports re-uploaded (Troy 2026-11-02).
    Hourly→Salary annualizes ×2080 (exactly the workbook's ×40×52 formula);
    Salary→Hourly divides back. Idempotent. */
export function normalizePayBasis(people: StaffingPerson[]): number {
  let changed = 0;
  for (const p of people) {
    const shouldSalary = isSalariedPosition(p.position);
    if (shouldSalary && p.payMethod === 'Hourly') { p.payMethod = 'Salary'; p.payRate = r2(p.payRate * 2080); changed++; }
    else if (!shouldSalary && p.payMethod === 'Salary') { p.payMethod = 'Hourly'; p.payRate = r2(p.payRate / 2080); changed++; }
  }
  return changed;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Monthly wages for one seat at a given rate (2080 hrs/yr for hourly). */
export function seatMonthly(payMethod: string, rate: number, allocPct: number): number {
  const mo = payMethod === 'Hourly' ? (rate * 2080) / 12 : rate / 12;
  return r2(mo * allocPct);
}

/** A raised HOURLY rate lands on the nearest 25¢ (Troy 2026-11-02 — a 3%
    raise MROUNDs, and the adjusted % reflects it). Salaries keep the exact %. */
export const RATE_MROUND = 0.25;
export function newRate(payMethod: string, rate: number, raisePct: number): number {
  const raw = rate * (1 + (Number(raisePct) || 0) / 100);
  if (payMethod !== 'Hourly') return r2(raw);
  return Math.round(Math.round(raw / RATE_MROUND) * RATE_MROUND * 100) / 100;
}
/** The effective raise AFTER rounding — what the budget actually pays. */
export function adjustedPct(payMethod: string, rate: number, raisePct: number): number {
  if (!rate) return 0;
  return newRate(payMethod, rate, raisePct) / rate - 1;
}

export type RaiseMap = Record<string, number>;   // person key -> raise %

/** Months (0-based index within calendar year `year`) the raise is live. */
export function raisedMonthCount(effective: string, year: number): number {
  const m = /^(\d{4})-(\d{2})$/.exec(String(effective || ''));
  if (!m) return 12;
  const effY = Number(m[1]), effM = Number(m[2]);
  if (effY > year) return 0;
  if (effY < year) return 12;
  return Math.max(0, Math.min(12, 12 - (effM - 1)));
}

/** HOW A RAISE PHASES IN — the same every year (Troy 2026-11-09: "Half of the increase should
    hit in Feb, and then full increase in effect for March. Always."). By calendar month: the
    share of each person's increase that is in pay. January runs at the old rate. */
export const RAISE_PHASE: number[] = [0, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
/** The phase for budget `year` given the cycle's effective 'YYYY-MM': only the YEAR of the
    cycle matters — its raises phase in during that year (Feb half, Mar full), are fully in
    pay in later years and not at all in earlier ones. */
export function raisePhase(effective: string, year: number): number[] {
  const m = /^(\d{4})-(\d{2})$/.exec(String(effective || ''));
  if (!m) return Array(12).fill(1);
  const effY = Number(m[1]);
  return effY > year ? Array(12).fill(0) : effY < year ? Array(12).fill(1) : RAISE_PHASE.slice();
}

/** Annual wages by wage GL for one property out of the roster + raises —
    January at the old rate, half the increase in February, all of it from March (RAISE_PHASE).
    This is what lands in budgets.inputs.wages (annual $ per GL). */
export function annualWagesByGl(people: StaffingPerson[], code: string, raises: RaiseMap, effective: string, year: number): { wages: Record<string, number>; unmappedPositions: string[] } {
  const phase = raisePhase(effective, year);
  const wages: Record<string, number> = {};
  const unmapped = new Set<string>();
  for (const p of people) {
    const alloc = (p.allocations || []).find((a) => a.code === code);
    if (!alloc || !alloc.pct) continue;
    const fromMap = positionGl(p.position);
    const gl = p.gl || fromMap.gl;   // the detail report's booked-to GL wins
    if (!p.gl && !fromMap.mapped) unmapped.add(p.position);
    const cur = seatMonthly(p.payMethod, p.payRate, alloc.pct);
    const next = seatMonthly(p.payMethod, newRate(p.payMethod, p.payRate, Number(raises[p.key]) || 0), alloc.pct);
    wages[gl] = r2((wages[gl] || 0) + phase.reduce((a, f) => a + cur + f * (next - cur), 0));
  }
  for (const gl of Object.keys(wages)) wages[gl] = r2(wages[gl]);
  return { wages, unmappedPositions: [...unmapped] };
}

/** The same wages BY CALENDAR MONTH of `year` (Troy 2026-11-09: a raise must not show in the
    months before it takes effect): January at the old rate, February with half the increase, March on with all of
    it (RAISE_PHASE). Sums to `annualWagesByGl`. */
export function monthlyWagesByGl(people: StaffingPerson[], code: string, raises: RaiseMap, effective: string, year: number): Record<string, number[]> {
  const phase = raisePhase(effective, year);
  const out: Record<string, number[]> = {};
  for (const p of people) {
    const alloc = (p.allocations || []).find((a) => a.code === code);
    if (!alloc || !alloc.pct) continue;
    const gl = p.gl || positionGl(p.position).gl;
    const cur = seatMonthly(p.payMethod, p.payRate, alloc.pct);
    const next = seatMonthly(p.payMethod, newRate(p.payMethod, p.payRate, Number(raises[p.key]) || 0), alloc.pct);
    const m = out[gl] || (out[gl] = Array(12).fill(0));
    for (let i = 0; i < 12; i++) m[i] += cur + phase[i] * (next - cur);
  }
  for (const gl of Object.keys(out)) out[gl] = out[gl].map(r2);
  return out;
}

/* Marginal burden on a wage change, for the grid's burdened-Δ column: employer
   FICA + an estimated SUTA/WC share by department. An ESTIMATE for deciding
   raises — budget taxes/benefits are generated by the engine, not by this. */
// ND column of the 2027 Payroll Budget Workbook's Tax Table (Seth Russell, 2026-11-09):
// SS 6.2 + Medicare 1.45, SUTA 1.62 (to a $46,600 base), FUTA 0.6 (to $7,000), WC admin
// 0.535 / maintenance 1.605. Caps are ignored here — a marginal estimate for raise decisions.
export const BURDEN_EST = { ficaPct: 7.65, sutaPct: 1.62, futaPct: 0.6, wcAdminPct: 0.535, wcMaintPct: 1.605 };
export function marginalBurdenPct(position: string): number {
  const { gl } = positionGl(position);
  const wc = gl === '6402' ? BURDEN_EST.wcAdminPct : BURDEN_EST.wcMaintPct;
  return (BURDEN_EST.ficaPct + BURDEN_EST.sutaPct + BURDEN_EST.futaPct + wc) / 100;
}

/** Each person belongs to exactly ONE home region (Troy 2026-10-30 — a
    cross-region LMS was showing in four region views with four divergent
    entries). The home region is where their workbook SECTION's members hold
    the most allocation (so "Minot Support Staff" people are Minot even when
    their own split leans elsewhere); people without a section vote with their
    own allocations alone. */
export function homeRegionsOf(people: StaffingPerson[], regionOfCode: (code: string) => string | null): Map<string, string> {
  const argmax = (sums: Record<string, number>): string | null => {
    let best: string | null = null;
    for (const [r, v] of Object.entries(sums)) if (best == null || v > sums[best]) best = r;
    return best;
  };
  const groupSums = new Map<string, Record<string, number>>();
  const personSums = new Map<string, Record<string, number>>();
  for (const p of people) {
    const sums: Record<string, number> = {};
    for (const a of p.allocations || []) {
      const r = regionOfCode(a.code);
      if (r) sums[r] = (sums[r] || 0) + a.pct;
    }
    personSums.set(p.key, sums);
    if (p.group) {
      const g = groupSums.get(p.group) || {};
      for (const [r, v] of Object.entries(sums)) g[r] = (g[r] || 0) + v;
      groupSums.set(p.group, g);
    }
  }
  const out = new Map<string, string>();
  for (const p of people) {
    const viaGroup = p.group ? argmax(groupSums.get(p.group) || {}) : null;
    const home = viaGroup || argmax(personSums.get(p.key) || {});
    if (home) out.set(p.key, home);
  }
  return out;
}

/** Viewer-safe copy of the roster: RM seats keep name/position/allocations so
    rows and counts stay explainable, but every pay figure is stripped. */
export function maskPeople(people: StaffingPerson[], canSeeRmPay: boolean): (StaffingPerson & { payHidden?: boolean })[] {
  if (canSeeRmPay) return people;
  return people.map((p) => p.rm
    ? { ...p, payRate: 0, monthlyBenefits: 0, oldPay: null, payHidden: true }
    : p);
}

/** Per-property current/proposed monthly wages of the MASKED (RM) seats, so a
    masked viewer's property totals still reconcile without per-seat figures. */
export function hiddenAggregates(people: StaffingPerson[], raises: RaiseMap, codes: string[]): Record<string, { curMo: number; newMo: number }> {
  const out: Record<string, { curMo: number; newMo: number }> = {};
  for (const code of codes) out[code] = { curMo: 0, newMo: 0 };
  for (const p of people) {
    if (!p.rm) continue;
    for (const a of p.allocations || []) {
      if (!(a.code in out)) continue;
      out[a.code].curMo = r2(out[a.code].curMo + seatMonthly(p.payMethod, p.payRate, a.pct));
      out[a.code].newMo = r2(out[a.code].newMo + seatMonthly(p.payMethod, newRate(p.payMethod, p.payRate, Number(raises[p.key]) || 0), a.pct));
    }
  }
  return out;
}

/* ---------------- carrying raises onto a new roster (Troy 2026-11-12) ----------------
   "I am about to update payroll sheet ... I do not want to redo those [raises]."
   Raise entries are keyed by person (Prism ID, else employee number, else the normalized name). A
   re-dropped workbook can key the same person differently: a Prism ID added or dropped, the
   name-keyed grid format instead of the roster, a name typed "Last, First" or with a middle
   initial. Same key = carried as-is. Otherwise the person is re-matched by NAME (word order,
   punctuation and single-letter initials ignored) only when exactly one person on each side has
   that name and the new key holds no raise of its own. Anything else is reported, never guessed,
   and the entry is kept. Pure. */
export const personNameId = (name: string): string =>
  String(name || '').toLowerCase().replace(/[^a-z\s,]/g, '').split(/[\s,]+/).filter((t) => t.length > 1).sort().join(' ');

export interface RaiseKeyMatch {
  carried: string[];                                        // entry keys found on the new roster as-is
  remap: { from: string; to: string; name: string }[];      // re-matched by name
  orphans: { key: string; name: string | null; why: string }[];
}
export function matchRaiseKeys(oldPeople: StaffingPerson[], newPeople: StaffingPerson[], entryKeys: string[]): RaiseKeyMatch {
  const newKeys = new Set(newPeople.map((p) => p.key));
  const held = new Set(entryKeys);
  const oldBy = new Map(oldPeople.map((p) => [p.key, p]));
  const countIds = (ps: StaffingPerson[]) => { const m = new Map<string, number>(); for (const p of ps) { const id = personNameId(p.name); if (id) m.set(id, (m.get(id) || 0) + 1); } return m; };
  const oldIds = countIds(oldPeople), newIds = countIds(newPeople);
  const newById = new Map<string, StaffingPerson>();
  for (const p of newPeople) { const id = personNameId(p.name); if (id && newIds.get(id) === 1) newById.set(id, p); }
  const taken = new Set<string>();
  const out: RaiseKeyMatch = { carried: [], remap: [], orphans: [] };
  for (const key of [...new Set(entryKeys)].sort()) {
    if (newKeys.has(key)) { out.carried.push(key); continue; }
    const op = oldBy.get(key) || null;
    const name = op?.name || null;
    if (!op) { out.orphans.push({ key, name, why: 'not on the previous or the new roster' }); continue; }
    if (/^(vacant|open|tbd|new hire)\b/i.test(op.name.trim())) { out.orphans.push({ key, name, why: 'open seat: seats are not matched by name' }); continue; }
    const id = personNameId(op.name);
    if (!id || (oldIds.get(id) || 0) > 1) { out.orphans.push({ key, name, why: 'name shared with someone else on the previous roster' }); continue; }
    if ((newIds.get(id) || 0) > 1) { out.orphans.push({ key, name, why: 'name shared by more than one person on the new roster' }); continue; }
    const np = newById.get(id);
    if (!np) { out.orphans.push({ key, name, why: 'not on the new roster' }); continue; }
    if (held.has(np.key) || taken.has(np.key)) { out.orphans.push({ key, name, why: 'the new roster row already has a raise of its own' }); continue; }
    taken.add(np.key);
    out.remap.push({ from: key, to: np.key, name: op.name });
  }
  return out;
}

/** A raise WORKBOOK exported before the roster was re-dropped carries the old keys. A key the
    roster no longer has is matched by the row's Employee name, on the same terms as a re-point
    (exactly one person on the roster with that name, and no other row of the file already aimed
    at them). Unmatched keys pass through unchanged and are skipped as unknown. Pure. */
export function resolveRaiseKeys(pairs: { key: string; pct: number }[], names: Record<string, string>, people: StaffingPerson[]): { pairs: { key: string; pct: number; from?: string }[]; rekeyed: string[] } {
  const keys = new Set(people.map((p) => p.key));
  const count = new Map<string, number>();
  for (const p of people) { const id = personNameId(p.name); if (id) count.set(id, (count.get(id) || 0) + 1); }
  const byId = new Map<string, StaffingPerson>();
  for (const p of people) { const id = personNameId(p.name); if (id && count.get(id) === 1) byId.set(id, p); }
  const direct = new Set(pairs.map((x) => x.key).filter((k) => keys.has(k)));
  const taken = new Set<string>();
  const rekeyed: string[] = [];
  const out = pairs.map((x) => {
    if (keys.has(x.key)) return x;
    const nm = names[x.key];
    const p = nm ? byId.get(personNameId(nm)) : undefined;
    if (!p || direct.has(p.key) || taken.has(p.key)) return x;
    taken.add(p.key); rekeyed.push(p.name);
    return { key: p.key, pct: x.pct, from: x.key };
  });
  return { pairs: out, rekeyed: rekeyed.sort() };
}
