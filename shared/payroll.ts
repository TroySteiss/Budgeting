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
}

/* Position → Monarch wage GL. TWO BUCKETS (Troy 2026-11-02): office staff →
   6402 ADMIN GROSS WAGES, maintenance staff (rovers, housekeepers and grounds
   crews included) → 6404 MAINT GROSS WAGES. Nothing maps to 6405 landscaping
   (Troy 2026-08-21: landscaping is contracted work, not payroll) and nothing
   maps to 6407 any more — rovers are maintenance. Unrecognized titles land in
   6404 and are reported in unmappedPositions. */
export const POSITION_GL: [RegExp, string][] = [
  [/regional|lms|arm|bookkeep|office|leasing|apm|\bpm\b|manager|market/i, '6402'],
  [/rover|supervisor|tech|housekeep|maint|janitor|porter|ground|landscap/i, '6404'],
];
export function positionGl(position: string): { gl: string; mapped: boolean } {
  for (const [re, gl] of POSITION_GL) if (re.test(position)) return { gl, mapped: true };
  return { gl: '6404', mapped: false };
}

/** Regional-Manager-level positions: pay masked for everyone outside RM_PAY_USERS. */
export const isRmPosition = (position: string): boolean => /regional/i.test(String(position || ''));

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

/** Annual wages by wage GL for one property out of the roster + raises —
    pre-raise months at the old rate, from the effective month at the new.
    This is what lands in budgets.inputs.wages (annual $ per GL). */
export function annualWagesByGl(people: StaffingPerson[], code: string, raises: RaiseMap, effective: string, year: number): { wages: Record<string, number>; unmappedPositions: string[] } {
  const liveMonths = raisedMonthCount(effective, year);
  const wages: Record<string, number> = {};
  const unmapped = new Set<string>();
  for (const p of people) {
    const alloc = (p.allocations || []).find((a) => a.code === code);
    if (!alloc || !alloc.pct) continue;
    const { gl, mapped } = positionGl(p.position);
    if (!mapped) unmapped.add(p.position);
    const cur = seatMonthly(p.payMethod, p.payRate, alloc.pct);
    const next = seatMonthly(p.payMethod, newRate(p.payMethod, p.payRate, Number(raises[p.key]) || 0), alloc.pct);
    wages[gl] = r2((wages[gl] || 0) + cur * (12 - liveMonths) + next * liveMonths);
  }
  for (const gl of Object.keys(wages)) wages[gl] = r2(wages[gl]);
  return { wages, unmappedPositions: [...unmapped] };
}

/* Marginal burden on a wage change, for the grid's burdened-Δ column: employer
   FICA + an estimated SUTA/WC share by department. An ESTIMATE for deciding
   raises — budget taxes/benefits are generated by the engine, not by this. */
export const BURDEN_EST = { ficaPct: 7.65, sutaPct: 1.0, wcAdminPct: 0.8, wcMaintPct: 4.0 };
export function marginalBurdenPct(position: string): number {
  const { gl } = positionGl(position);
  const wc = gl === '6402' ? BURDEN_EST.wcAdminPct : BURDEN_EST.wcMaintPct;
  return (BURDEN_EST.ficaPct + BURDEN_EST.sutaPct + wc) / 100;
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
