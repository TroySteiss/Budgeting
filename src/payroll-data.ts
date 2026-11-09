/* Pay-rates data access shared by the payroll routes (src/payroll.ts) and the budget
   loader (src/routes.ts). Kept apart from both so neither imports the other for it.

   RESTRICTED DATA: the roster (names, rates) is read here but `rosterWagesFor` returns
   ONLY property-level annual wages by wage GL plus cycle metadata — nothing per person
   ever leaves this module through it. */
import { query } from './db.js';
import { annualWagesByGl, monthlyWagesByGl, homeRegionsOf, normalizePayBasis, normalizeRmCorporateShare, type StaffingPerson, type RaiseMap } from '../shared/payroll.js';

export async function loadSnapshotPeople(snapshotId: number): Promise<StaffingPerson[]> {
  const r = (await query('select data from staffing_snapshots where id=$1', [snapshotId])).rows[0];
  const people = ((r?.data?.people as StaffingPerson[]) || []).map((p) => ({ ...p }));
  // enforce the rules on READ (all PMs are Salary; MI covers 30% of every
  // RM's pay — Troy 2026-11-02), so rule fixes reach snapshots that are
  // already loaded without any re-upload
  normalizePayBasis(people);
  normalizeRmCorporateShare(people);
  return people;
}
export const regionOf = (p: { market?: string }): string => String(p.market || '').trim() || 'Other';

/** code → region lookup over EVERY property (home regions must be stable,
    never viewer-scoped). */
export async function marketOfCode(): Promise<(code: string) => string | null> {
  const m = new Map((await query('select code, market from properties')).rows.map((p: any) => [p.code, regionOf(p)]));
  return (code: string) => m.get(code) || null;
}

/** Each region's LATEST iteration of a cycle, with its raise entries — what a
    foreign-home person's raise reads as from any other region's view. */
export async function latestIterByRegion(cycleId: number): Promise<Map<string, { id: number; num: number; finalized: boolean; entries: Record<string, number> }>> {
  const iters = (await query('select id, region, num, finalized_at from raise_iterations where cycle_id=$1 order by region, num', [cycleId])).rows as any[];
  const latest = new Map<string, { id: number; num: number; finalized: boolean; entries: Record<string, number> }>();
  for (const it of iters) latest.set(it.region, { id: it.id, num: it.num, finalized: !!it.finalized_at, entries: {} });
  const ids = [...latest.values()].map((x) => x.id);
  if (ids.length) {
    const byId = new Map([...latest.values()].map((x) => [x.id, x]));
    for (const e of (await query('select iteration_id, person_key, raise_pct from raise_entries where iteration_id = any($1)', [ids])).rows) {
      const t = byId.get(e.iteration_id);
      if (t) t.entries[e.person_key] = Number(e.raise_pct);
    }
  }
  return latest;
}

/** What a budget needs from the Pay-rates tab: wages by wage GL and where they came from. */
export interface RosterLink {
  /** annual $ by wage GL — all four wage GLs present (0 where the roster books nothing) */
  wages: Record<string, number>;
  /** the same wages by CALENDAR month of the budget year: old rate until the cycle's effective month, raised rate from it on */
  monthly: Record<string, number[]>;
  cycleId: number; label: string; effective: string;
  /** true while any region feeding this property is still on a draft (un-finalized) iteration */
  draft: boolean;
  /** the regions whose raise entries feed this property, with their latest iteration */
  regions: { region: string; num: number | null; finalized: boolean }[];
}

/** THE DEFAULT WAGE SOURCE for an annual budget (Troy 2026-11-09: "wages should be coming
    off of the Payroll tab, with the raise % tied to the payroll sheet by default").
    The latest raise cycle effective in the budget's year supplies the roster and each
    person's raise — from their home region's LATEST iteration, drafts included — prorated
    from the cycle's effective month. Null when no cycle is effective that year or the
    roster books nobody to the property: the budget then falls back to its payroll model /
    own trailing-12 wages. Nothing is written; the caller decides what to do with it. */
export async function rosterWagesFor(code: string, year: number): Promise<RosterLink | null> {
  const cycle = (await query(
    `select id, label, effective, staffing_snapshot_id from raise_cycles
      where staffing_snapshot_id is not null and left(effective, 4) = $1 order by id desc limit 1`, [String(year)]
  )).rows[0];
  if (!cycle) return null;
  const people = await loadSnapshotPeople(cycle.staffing_snapshot_id);
  const here = people.filter((p) => (p.allocations || []).some((a) => a.code === code && a.pct));
  if (!here.length) return null;
  // homes are voted over the FULL roster (a property-scoped subset skews the vote)
  const homes = homeRegionsOf(people, await marketOfCode());
  const latest = await latestIterByRegion(cycle.id);
  const raises: RaiseMap = {};
  const feeding = new Set<string>();
  for (const p of here) {
    const home = homes.get(p.key) || '';
    feeding.add(home);
    raises[p.key] = (home && latest.get(home)?.entries[p.key]) || 0;
  }
  const { wages } = annualWagesByGl(people, code, raises, cycle.effective, year);
  const regions = [...feeding].sort().map((region) => ({ region, num: latest.get(region)?.num ?? null, finalized: !!latest.get(region)?.finalized }));
  return {
    // the roster is authoritative for every wage GL: the ones it books nothing to are zero
    wages: { '6402': 0, '6404': 0, '6405': 0, '6407': 0, ...wages },
    monthly: monthlyWagesByGl(people, code, raises, cycle.effective, year),
    cycleId: cycle.id, label: cycle.label, effective: cycle.effective,
    draft: regions.some((r) => !r.finalized), regions,
  };
}

/** Which properties the Pay-rates tab can feed, per budget year — for the dashboard's
    "Payroll wages" report item. Per year: the cycle `rosterWagesFor` would use, and each
    property code the roster books staff to, with whether a feeding region is still on a
    draft iteration. Codes and flags only — no pay data. */
export interface RosterCoverage { label: string; effective: string; codes: Record<string, { draft: boolean }> }
export async function rosterCoverage(): Promise<Record<string, RosterCoverage>> {
  const cycles = (await query(
    `select distinct on (left(effective, 4)) id, label, effective, staffing_snapshot_id from raise_cycles
      where staffing_snapshot_id is not null and effective ~ '^[0-9]{4}-[0-9]{2}$' order by left(effective, 4), id desc`
  )).rows as any[];
  if (!cycles.length) return {};
  const market = await marketOfCode();
  const out: Record<string, RosterCoverage> = {};
  for (const c of cycles) {
    const people = await loadSnapshotPeople(c.staffing_snapshot_id);
    const homes = homeRegionsOf(people, market);
    const latest = await latestIterByRegion(c.id);
    const codes: Record<string, { draft: boolean }> = {};
    for (const p of people) {
      const home = homes.get(p.key) || '';
      const draft = !latest.get(home)?.finalized;
      for (const a of p.allocations || []) {
        if (!a.code || !a.pct) continue;
        codes[a.code] = { draft: (codes[a.code]?.draft || false) || draft };
      }
    }
    out[String(c.effective).slice(0, 4)] = { label: c.label, effective: c.effective, codes };
  }
  return out;
}
