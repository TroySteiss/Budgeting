/* Pay-rates tab — raise cycles behind their own gate.
   Everything here sits behind (1) the normal app login AND (2) the payroll
   password (PAYROLL_PASSWORD env), because staffing snapshots carry per-seat
   pay (Troy sign-off 2026-10-28). Regional-Manager pay is additionally masked
   server-side for everyone outside RM_PAY_USERS (auth.ts). Non-admin users
   are scoped to their app_users.sites property codes.
   Iteration chains are PER REGION (properties.market) within a cycle
   (Troy 2026-10-29): each region drafts, finalizes and starts its next
   iteration independently. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { query } from './db.js';
import { requireAuth, requireAdmin, isAdminUser, canSeeRmPay, normUser } from './auth.js';
import { parseStaffingReport, parsePayrollModel, parsePayrollDetail } from './importers.js';
import { loadBudget, buildLines, saveLines } from './routes.js';
import { maskPeople, hiddenAggregates, annualWagesByGl, seatMonthly, homeRegionsOf, applyStaffingDetail, normalizePayBasis, normalizeRmCorporateShare, type StaffingPerson, type RaiseMap, type DetailPerson } from '../shared/payroll.js';
import { loadSnapshotPeople, regionOf, marketOfCode, latestIterByRegion } from './payroll-data.js';
import { buildRaiseWorkbook, parseRaiseImport, type RaiseExportRow, type RaiseSheetSpec } from './payroll-xlsx.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
export const payrollRouter = Router();

const h = (fn: (req: Request, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const logChange = (username: string, action: string, detail: any): void => {
  query('insert into change_log(username, action, detail) values($1,$2,$3)', [username, action, JSON.stringify(detail)]).catch(() => {});
};

payrollRouter.use(requireAuth);

/* ---------------- the second gate ---------------- */
payrollRouter.post('/unlock', h(async (req, res) => {
  const expected = process.env.PAYROLL_PASSWORD || 'payroll';
  if (String(req.body?.password || '') !== expected) return res.status(401).json({ error: 'Incorrect payroll password' });
  req.session.payrollAuthed = true;
  res.json({ ok: true });
}));

function requirePayroll(req: Request, res: Response, next: NextFunction) {
  if (req.session?.payrollAuthed) return next();
  res.status(403).json({ error: 'payroll-locked' });
}

/* GET /state answers BEFORE the gate so the client knows whether to show the
   unlock card — it carries nothing but the locked flag until unlocked. */
payrollRouter.get('/state', h(async (req, res) => {
  if (!req.session?.payrollAuthed) return res.json({ unlocked: false });
  const user = req.session.username || '';
  const admin = isAdminUser(user);
  const [snapshots, cycles, props, me] = await Promise.all([
    query(`select s.id, s.label, s.created_at, u.uploaded_by, u.filename,
                  jsonb_array_length(coalesce(s.data->'people','[]'::jsonb)) as people
             from staffing_snapshots s left join uploads u on u.id=s.upload_id
            order by s.created_at desc`),
    query(`select c.id, c.label, c.effective, c.staffing_snapshot_id, c.created_by, c.created_at, s.label as snapshot_label
             from raise_cycles c left join staffing_snapshots s on s.id=c.staffing_snapshot_id
            order by c.created_at desc`),
    query(`select code, name, units, market from properties order by code`),
    query('select sites from app_users where key=$1', [normUser(user)]),
  ]);
  const sites: string[] = admin ? [] : ((me.rows[0]?.sites as string[]) || []);
  const users = admin ? (await query('select key, display, role, sites, last_seen from app_users order by display')).rows : [];
  res.json({
    unlocked: true, username: user, isAdmin: admin, canRmPay: canSeeRmPay(user),
    sites, snapshots: snapshots.rows, cycles: cycles.rows, properties: props.rows, users,
  });
}));

payrollRouter.use(requirePayroll);

/* ---------------- staffing report (admin) ----------------
   Parses AND stores in ONE step: the roster never rides a parse/apply round
   trip, so no response ever carries rates back out — only counts do. */
payrollRouter.post('/staffing', requireAdmin, upload.array('files', 4), h(async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  if (!files.length) return res.status(400).json({ error: 'No file' });
  // classify each file: the payroll DETAIL report (canonical titles +
  // booked-to GL → salaried-vs-hourly per position, Troy 2026-11-02) vs the
  // roster workbook. Detail alone enriches the LATEST snapshot.
  let parsed: ReturnType<typeof parseStaffingReport> | null = null;
  let rosterBuf: Buffer | null = null;
  const details: DetailPerson[] = [];
  const problems: string[] = [];
  for (const f of files) {
    try { details.push(...parsePayrollDetail(f.buffer)); continue; } catch { /* not the detail report */ }
    try { if (!parsed) { parsed = parseStaffingReport(f.buffer); rosterBuf = f.buffer; continue; } } catch (e: any) { problems.push(`${f.originalname}: ${e?.message || e}`); }
  }
  const user = req.session.username || '';
  const known = new Set((await query(`select code from properties`)).rows.map((r: any) => r.code));
  let people: StaffingPerson[] = [];
  let totalRows = 0, skippedNoProperty = 0;
  let allocatedWithoutSplit: string[] = [];
  let skippedOffPortfolio = 0;
  let label = String(req.body?.name || '').trim();
  if (parsed) {
    for (const p of parsed.people) {
      const allocations = p.allocations.filter((a) => known.has(a.code));
      if (allocations.length) people.push({ ...p, allocations });
    }
    if (!people.length) return res.status(422).json({ error: 'No roster rows map to this tool’s properties' });
    totalRows = parsed.totalRows;
    skippedNoProperty = parsed.skippedNoProperty;
    allocatedWithoutSplit = parsed.allocatedWithoutSplit;
    skippedOffPortfolio = parsed.people.length - people.length;
    label = label || parsed.label || files[0].originalname;
  } else if (details.length) {
    const last = (await query('select id, label, data from staffing_snapshots order by created_at desc limit 1')).rows[0];
    if (!last) return res.status(400).json({ error: 'Load the payroll workbook first — the detail report only cross-references it' });
    people = ((last.data?.people as StaffingPerson[]) || []).map((p) => ({ ...p }));
    totalRows = people.length;
    label = label || `${last.label} + detail`;
  } else {
    return res.status(422).json({ error: problems.join(' · ') || 'No recognizable staffing files' });
  }
  normalizePayBasis(people);           // the title rule holds whatever the source said
  normalizeRmCorporateShare(people);   // MI carries 30% of every RM — properties get 70%
  const enrich = details.length ? applyStaffingDetail(people, details) : { matched: 0, flippedToSalary: 0 };
  const salaried = people.filter((p) => p.payMethod === 'Salary').length;
  // uploads row carries COUNTS only; the roster lives in staffing_snapshots
  const perProperty: Record<string, number> = {};
  for (const p of people) for (const a of p.allocations) perProperty[a.code] = (perProperty[a.code] || 0) + 1;
  const filenames = files.map((f) => f.originalname).join(' + ');
  const uploadId = (await query(
    'insert into uploads(kind, filename, uploaded_by, payload) values($1,$2,$3,$4) returning id',
    ['staffing', filenames, user, JSON.stringify({ people: people.length, totalRows, perProperty, detailMatched: enrich.matched })]
  )).rows[0].id;
  const row = (await query(
    'insert into staffing_snapshots(upload_id, label, data) values($1,$2,$3) returning id',
    [uploadId, label, JSON.stringify({ people })]
  )).rows[0];
  // the same workbook usually carries the wage-aggregate model (Wages sheet) —
  // one drop refreshes BOTH, so nobody uploads the same file twice (Troy
  // 2026-10-30). Budgets keep whichever model they already point at.
  let payrollModelId: number | null = null;
  if (rosterBuf) {
    try {
      const pm = parsePayrollModel(rosterBuf);
      payrollModelId = (await query(
        'insert into payroll_models(upload_id, label, data) values($1,$2,$3) returning id',
        [uploadId, label, JSON.stringify({ properties: pm.properties, unmappedPositions: pm.unmappedPositions, employeeRows: pm.employeeRows })]
      )).rows[0].id;
    } catch { /* no Wages-style sheet in this file — staffing only */ }
  }
  logChange(user, 'upload staffing report', { filename: filenames, staffingSnapshotId: row.id, people: people.length, payrollModelId, detailMatched: enrich.matched, salaried });
  res.json({
    ok: true, id: row.id, label, people: people.length, totalRows,
    perProperty, skippedOffPortfolio,
    allocatedWithoutSplit, skippedNoProperty,
    payrollModelId,
    detailMatched: enrich.matched, flippedToSalary: enrich.flippedToSalary, salaried,
  });
}));

/* ---------------- cycles ---------------- */

payrollRouter.post('/cycles', requireAdmin, h(async (req, res) => {
  const { label, effective, staffingSnapshotId } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(String(effective || ''))) return res.status(400).json({ error: 'Effective month must be YYYY-MM' });
  const people = await loadSnapshotPeople(Number(staffingSnapshotId));
  if (!people.length) return res.status(400).json({ error: 'Pick a staffing snapshot' });
  const user = req.session.username || '';
  const cycle = (await query(
    'insert into raise_cycles(label, effective, staffing_snapshot_id, created_by) values($1,$2,$3,$4) returning *',
    [String(label || '').trim() || `Raises eff. ${effective}`, effective, Number(staffingSnapshotId), user]
  )).rows[0];
  // iteration #1 for every region the snapshot touches
  const props = (await query(`select code, market from properties`)).rows;
  const marketByCode = new Map(props.map((p: any) => [p.code, regionOf(p)]));
  const regions = [...new Set(people.flatMap((p) => p.allocations.map((a) => marketByCode.get(a.code))).filter(Boolean))] as string[];
  for (const region of regions) {
    await query('insert into raise_iterations(cycle_id, region, num, created_by) values($1,$2,1,$3)', [cycle.id, region, user]);
  }
  logChange(user, 'create raise cycle', { cycleId: cycle.id, effective, regions });
  res.json({ ok: true, cycle, regions });
}));

/** Repoint a cycle at a newer staffing snapshot (after re-dropping the
    workbook). Entries key by person, so raises carry over; people who left
    the roster simply stop rendering. */
payrollRouter.put('/cycles/:id', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  // the month the raises take effect (Troy 2026-11-09): budgets step their wages up from this
  // month, so it must be correctable after the cycle exists. Entries are untouched.
  if (req.body?.effective !== undefined) {
    const effective = String(req.body.effective || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(effective)) return res.status(400).json({ error: 'Effective month must be YYYY-MM' });
    const r = await query('update raise_cycles set effective=$2 where id=$1 returning id', [id, effective]);
    if (!r.rows.length) return res.status(404).json({ error: 'No such cycle' });
    logChange(req.session.username || '', 'set raise cycle effective month', { cycleId: id, effective });
    if (req.body?.staffingSnapshotId === undefined) return res.json({ ok: true, effective });
  }
  const snapId = Number(req.body?.staffingSnapshotId);
  const people = await loadSnapshotPeople(snapId);
  if (!people.length) return res.status(400).json({ error: 'No such staffing snapshot' });
  await query('update raise_cycles set staffing_snapshot_id=$2 where id=$1', [id, snapId]);
  logChange(req.session.username || '', 'repoint raise cycle staffing', { cycleId: id, staffingSnapshotId: snapId });
  res.json({ ok: true });
}));

payrollRouter.delete('/cycles/:id', requireAdmin, h(async (req, res) => {
  await query('delete from raise_cycles where id=$1', [Number(req.params.id)]);
  logChange(req.session.username || '', 'delete raise cycle', { cycleId: Number(req.params.id) });
  res.json({ ok: true });
}));

/* The whole working set for one cycle, scoped + masked for THIS viewer. */
payrollRouter.get('/cycles/:id', h(async (req, res) => {
  const cycle = (await query('select * from raise_cycles where id=$1', [Number(req.params.id)])).rows[0];
  if (!cycle) return res.status(404).json({ error: 'No such cycle' });
  const user = req.session.username || '';
  const admin = isAdminUser(user);
  const rmPay = canSeeRmPay(user);
  const people = await loadSnapshotPeople(cycle.staffing_snapshot_id);
  const props = (await query(`select code, name, units, market from properties order by code`)).rows as any[];
  const sites: string[] = admin ? props.map((p) => p.code)
    : (((await query('select sites from app_users where key=$1', [normUser(user)])).rows[0]?.sites as string[]) || []);
  const siteSet = new Set(sites);
  const touched = new Set(people.flatMap((p) => p.allocations.map((a) => a.code)));
  const visibleProps = props.filter((p) => touched.has(p.code) && siteSet.has(p.code));
  if (!visibleProps.length) return res.status(403).json({ error: admin ? 'No properties in this cycle' : 'No properties assigned to you — an admin sets your sites in the Payroll tab' });
  const visCodes = new Set(visibleProps.map((p) => p.code));
  const regions = [...new Set(visibleProps.map(regionOf))].sort();

  // iterations load for EVERY region: home regions outside the viewer's scope
  // still feed foreign raises, but only visible regions are exposed
  const iterations = (await query(
    'select * from raise_iterations where cycle_id=$1 order by region, num', [cycle.id]
  )).rows as any[];
  const entries = (await query(
    'select iteration_id, person_key, raise_pct, updated_by, updated_at from raise_entries where iteration_id = any($1)',
    [iterations.map((i) => i.id)]
  )).rows as any[];
  const byIter = new Map<number, Record<string, { pct: number; by: string; at: string }>>();
  for (const e of entries) {
    if (!byIter.has(e.iteration_id)) byIter.set(e.iteration_id, {});
    byIter.get(e.iteration_id)![e.person_key] = { pct: Number(e.raise_pct), by: e.updated_by, at: e.updated_at };
  }
  const visPeople = people.filter((p) => p.allocations.some((a) => visCodes.has(a.code)));
  // each person lives in ONE home region; another region's view reads their
  // raise from the home region's LATEST iteration (foreignRaises, read-only)
  const marketOf = await marketOfCode();
  const homes = homeRegionsOf(people, marketOf);
  const latestByRegion = new Map<string, any>();
  for (const it of iterations) {
    const cur = latestByRegion.get(it.region);
    if (!cur || it.num > cur.num) latestByRegion.set(it.region, it);
  }
  const homePct = (key: string): number => {
    const home = homes.get(key);
    const it = home ? latestByRegion.get(home) : null;
    const e = it ? (byIter.get(it.id) || {})[key] : null;
    return e ? e.pct : 0;
  };
  const out = iterations.filter((it) => regions.includes(it.region)).map((it) => {
    const em = byIter.get(it.id) || {};
    const raises: RaiseMap = {};
    const foreignRaises: RaiseMap = {};
    for (const p of visPeople) {
      if (!p.allocations.some((a) => marketOf(a.code) === it.region)) continue;
      if (homes.get(p.key) === it.region) raises[p.key] = em[p.key] ? em[p.key].pct : 0;
      else { foreignRaises[p.key] = homePct(p.key); raises[p.key] = foreignRaises[p.key]; }
    }
    return {
      id: it.id, region: it.region, num: it.num, basedOn: it.based_on,
      createdBy: it.created_by, createdAt: it.created_at,
      finalizedBy: it.finalized_by, finalizedAt: it.finalized_at,
      propStatus: it.prop_status || {}, entries: em, foreignRaises,
      // masked viewers get RM wages only as per-property aggregates, so their
      // totals reconcile without any per-seat figure
      hidden: rmPay ? null : hiddenAggregates(visPeople, raises, [...visCodes]),
    };
  });
  res.json({
    cycle, regions,
    properties: visibleProps,
    people: maskPeople(visPeople, rmPay).map((p) => ({ ...p, homeRegion: homes.get(p.key) || null })),
    iterations: out,
    viewer: { username: user, isAdmin: admin, canRmPay: rmPay },
  });
}));

/* ---------------- entries ---------------- */
async function loadIteration(id: number): Promise<any | null> {
  return (await query('select i.*, c.staffing_snapshot_id, c.effective from raise_iterations i join raise_cycles c on c.id=i.cycle_id where i.id=$1', [id])).rows[0] || null;
}

payrollRouter.put('/iterations/:id/entries', h(async (req, res) => {
  const it = await loadIteration(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'No such iteration' });
  if (it.finalized_at) return res.status(409).json({ error: `Iteration ${it.num} is finalized — start the next iteration to make changes` });
  const user = req.session.username || '';
  const admin = isAdminUser(user);
  const key = String(req.body?.key || '');
  const pct = Number(req.body?.pct);
  if (!Number.isFinite(pct) || pct < -50 || pct > 100) return res.status(400).json({ error: 'Raise % must be a number between -50 and 100' });
  const people = await loadSnapshotPeople(it.staffing_snapshot_id);
  const person = people.find((p) => p.key === key);
  if (!person) return res.status(404).json({ error: 'No such person in this cycle’s staffing snapshot' });
  if (person.rm && !canSeeRmPay(user)) return res.status(403).json({ error: 'Regional-Manager raises are limited to the RM-pay allowlist' });
  // one entry per person, held by their HOME region's chain (Troy 2026-10-30)
  const home = homeRegionsOf(people, await marketOfCode()).get(key);
  if (home && home !== it.region) return res.status(409).json({ error: `${person.name} belongs to ${home} — their raise is entered there` });
  if (!admin) {
    const sites = ((await query('select sites from app_users where key=$1', [normUser(user)])).rows[0]?.sites as string[]) || [];
    if (!person.allocations.some((a) => sites.includes(a.code))) return res.status(403).json({ error: 'This employee is not at one of your properties' });
  }
  await query(
    `insert into raise_entries(iteration_id, person_key, raise_pct, updated_by, updated_at) values($1,$2,$3,$4,now())
     on conflict (iteration_id, person_key) do update set raise_pct=excluded.raise_pct, updated_by=excluded.updated_by, updated_at=now()`,
    [it.id, key, pct, user]
  );
  logChange(user, 'raise entry', { iterationId: it.id, region: it.region, personKey: key, pct });
  res.json({ ok: true, by: user, at: new Date().toISOString() });
}));

payrollRouter.put('/iterations/:id/status', h(async (req, res) => {
  const it = await loadIteration(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'No such iteration' });
  if (it.finalized_at) return res.status(409).json({ error: 'Finalized — statuses are frozen' });
  const user = req.session.username || '';
  const admin = isAdminUser(user);
  const code = String(req.body?.property || '');
  const status = String(req.body?.status || '');
  if (!['not_started', 'in_progress', 'submitted', 'approved'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (status === 'approved' && !admin) return res.status(403).json({ error: 'Only an admin approves a property' });
  if (!admin) {
    const sites = ((await query('select sites from app_users where key=$1', [normUser(user)])).rows[0]?.sites as string[]) || [];
    if (!sites.includes(code)) return res.status(403).json({ error: 'Not one of your properties' });
  }
  const ps = { ...(it.prop_status || {}), [code]: { status, by: user, at: new Date().toISOString() } };
  await query('update raise_iterations set prop_status=$2 where id=$1', [it.id, JSON.stringify(ps)]);
  logChange(user, 'raise property status', { iterationId: it.id, property: code, status });
  res.json({ ok: true, propStatus: ps });
}));

/* ---------------- Excel round trip ---------------- */
const initialsOf = (u: string): string => u.split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 3);
const mmddyyyy = (): string => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${d.getFullYear()}`; };

/** Everything an export needs for a set of regions, viewer-scoped and
    RM-masked (pay never rides a file): person-once rows (home region, in
    workbook-section order), per-region masked aggregates, and the per-RM
    sheet grouping (each region's RM = the Regional with the biggest
    allocation there; regions sharing an RM share a sheet named by their
    first name — Troy's draft layout). `override` swaps one region's raises
    for a specific iteration's entries (the per-iteration export). */
async function assembleRaiseExport(cycle: any, user: string, wantRegions: string[] | null,
  override?: { region: string; entries: Record<string, { pct: number; by: string; at: string }> }) {
  const admin = isAdminUser(user);
  const people = await loadSnapshotPeople(cycle.staffing_snapshot_id);
  const props = (await query('select code, market from properties')).rows as any[];
  const sites: string[] = admin ? props.map((p: any) => p.code)
    : (((await query('select sites from app_users where key=$1', [normUser(user)])).rows[0]?.sites as string[]) || []);
  const siteSet = new Set(sites);
  const visCodes = new Set<string>(props.filter((p: any) => siteSet.has(p.code) && people.some((x) => x.allocations.some((a) => a.code === p.code))).map((p: any) => p.code));
  if (!visCodes.size) return null;
  const marketOf = await marketOfCode();
  let regions = [...new Set([...visCodes].map((c) => marketOf(c)).filter(Boolean) as string[])];
  if (wantRegions) regions = regions.filter((r) => wantRegions.includes(r));
  if (!regions.length) return null;
  const homes = homeRegionsOf(people, marketOf);
  // regions (and so the RM sheets) run in the WORKBOOK's order — Minot staff
  // first in the file means Holly's sheet first, like Troy's draft
  const firstOrd = new Map<string, number>();
  for (const p of people) {
    const home = homes.get(p.key);
    if (!home) continue;
    const o = p.ord ?? 0;
    if (!firstOrd.has(home) || o < firstOrd.get(home)!) firstOrd.set(home, o);
  }
  regions.sort((a, b) => (firstOrd.get(a) ?? 1e9) - (firstOrd.get(b) ?? 1e9) || a.localeCompare(b));
  const latest = await latestIterByRegion(cycle.id);
  const raiseInfo = (key: string, home: string): { pct: number; by: string; at: string } => {
    if (override && override.region === home) return override.entries[key] || { pct: 0, by: '', at: '' };
    return { pct: latest.get(home)?.entries[key] ?? 0, by: '', at: '' };
  };
  type XRow = RaiseExportRow & { _g: string | null; _o: number };
  const rows: XRow[] = [];
  const allocations: any[] = [];
  for (const p of maskPeople(people, false)) {      // RM pay masked in EVERY file
    const home = homes.get(p.key);
    if (!home || !regions.includes(home)) continue;
    const regA = p.allocations.filter((a) => visCodes.has(a.code));
    if (!regA.length) continue;
    const prim = [...regA].sort((a, b) => b.pct - a.pct)[0];
    const others = p.allocations.filter((a) => a.code !== prim.code);
    const masked = !!(p as any).payHidden;
    const ri = raiseInfo(p.key, home);
    rows.push({
      key: p.key, name: p.name, position: p.position, region: home,
      groupLabel: '', _g: p.group || null, _o: p.ord ?? 0,
      primCode: prim.code, primPct: prim.pct,
      splitNote: [
        others.length ? `also ${others.map((x) => `${x.code.toUpperCase()} ${Math.round(x.pct * 100)}%`).join(' · ')}` : '',
        p.rm ? 'MIMG corporate 30%' : '',
      ].filter(Boolean).join(' · '),
      payMethod: p.payMethod,
      payRate: masked ? null : p.payRate,
      regionMoCur: masked ? null : regA.reduce((s, a) => s + seatMonthly(p.payMethod, p.payRate, a.pct), 0),
      raisePct: ri.pct, by: ri.by, at: ri.at, rm: !!p.rm,
    });
    for (const a of regA) {
      allocations.push({
        key: p.key, name: p.name, position: p.position, payMethod: p.payMethod,
        payRate: masked ? null : p.payRate, monthlyBenefits: masked ? null : p.monthlyBenefits,
        status: p.status, startDate: p.startDate, code: a.code, pct: a.pct,
      });
    }
  }
  // order: region block → workbook section (or primary site) → workbook row
  const regionIdx = new Map(regions.map((r, i) => [r, i]));
  if (rows.some((x) => x._g)) {
    const minOrd = new Map<string, number>();
    for (const x of rows) {
      x.groupLabel = x._g || 'Other';
      const gk = `${x.region}|${x.groupLabel}`;
      if (!minOrd.has(gk) || x._o < minOrd.get(gk)!) minOrd.set(gk, x._o);
    }
    rows.sort((a, b) => (regionIdx.get(a.region)! - regionIdx.get(b.region)!)
      || (minOrd.get(`${a.region}|${a.groupLabel}`)! - minOrd.get(`${b.region}|${b.groupLabel}`)!) || (a._o - b._o));
  } else {
    for (const x of rows) x.groupLabel = x.primCode.toUpperCase();
    rows.sort((a, b) => (regionIdx.get(a.region)! - regionIdx.get(b.region)!)
      || a.primCode.localeCompare(b.primCode) || a.position.localeCompare(b.position) || a.name.localeCompare(b.name));
  }
  // per-region masked-RM aggregates (so every sheet's totals reconcile)
  const raises: RaiseMap = {};
  for (const p of people) { const home = homes.get(p.key); raises[p.key] = home ? raiseInfo(p.key, home).pct : 0; }
  const agg = hiddenAggregates(people, raises, [...visCodes]);
  const hiddenByRegion: Record<string, { curMo: number; newMo: number }> = {};
  for (const [code, v] of Object.entries(agg)) {
    const r = marketOf(code);
    if (!r || !regions.includes(r) || !v.curMo) continue;
    const t = hiddenByRegion[r] || { curMo: 0, newMo: 0 };
    hiddenByRegion[r] = { curMo: t.curMo + v.curMo, newMo: t.newMo + v.newMo };
  }
  // sheet per RM: the Regional with the largest allocation sum in each region
  const rmSum = new Map<string, Map<string, number>>();
  for (const p of people) {
    if (!p.rm) continue;
    for (const a of p.allocations) {
      const r = marketOf(a.code);
      if (!r) continue;
      if (!rmSum.has(r)) rmSum.set(r, new Map());
      const m = rmSum.get(r)!;
      m.set(p.key, (m.get(p.key) || 0) + a.pct);
    }
  }
  const sanitize = (s: string) => s.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Sheet';
  const sheets: RaiseSheetSpec[] = [];
  const byRm = new Map<string, RaiseSheetSpec>();
  const used = new Set<string>();
  for (const region of regions) {
    let rmKey = '';
    let best = 0;
    for (const [k, v] of rmSum.get(region) || []) if (v > best) { best = v; rmKey = k; }
    const owner = rmKey || region;
    if (byRm.has(owner)) { byRm.get(owner)!.regions.push(region); continue; }
    const rmName = rmKey ? (people.find((p) => p.key === rmKey)?.name.split(/\s+/)[0] || region) : region;
    let name = sanitize(rmName);
    while (used.has(name)) name = sanitize(name + ' 2');
    used.add(name);
    const spec = { name, regions: [region] };
    byRm.set(owner, spec);
    sheets.push(spec);
  }
  return { rows: rows as RaiseExportRow[], allocations, hiddenByRegion, sheets, regions };
}

payrollRouter.get('/iterations/:id/export.xlsx', h(async (req, res) => {
  const it = await loadIteration(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'No such iteration' });
  const cycle = (await query('select * from raise_cycles where id=$1', [it.cycle_id])).rows[0];
  const user = req.session.username || '';
  const entries: Record<string, { pct: number; by: string; at: string }> = {};
  for (const e of (await query('select person_key, raise_pct, updated_by, updated_at from raise_entries where iteration_id=$1', [it.id])).rows) {
    entries[e.person_key] = { pct: Number(e.raise_pct), by: e.updated_by, at: String(e.updated_at) };
  }
  const asm = await assembleRaiseExport(cycle, user, [it.region], { region: it.region, entries });
  if (!asm) return res.status(403).json({ error: 'No properties assigned to you in this region' });
  const buf = await buildRaiseWorkbook({
    cycleLabel: cycle.label, effective: cycle.effective,
    title: `${cycle.label} — ${it.region} — Iteration ${it.num}${it.finalized_at ? ` (FINALIZED by ${it.finalized_by})` : ' (draft)'}`,
    exportedBy: user, sheets: asm.sheets, rows: asm.rows, hiddenByRegion: asm.hiddenByRegion,
    combined: false, allocations: asm.allocations,
  });
  logChange(user, 'export raise workbook', { iterationId: it.id, region: it.region, rows: asm.rows.length });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${it.region} Raises Iteration ${it.num} ${initialsOf(user)} ${mmddyyyy()}.xlsx"`);
  res.send(buf);
}));

/** Edited Raise %s come back by person Key; same checks as single entries. */
payrollRouter.post('/iterations/:id/import', upload.single('file'), h(async (req, res) => {
  const it = await loadIteration(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'No such iteration' });
  if (it.finalized_at) return res.status(409).json({ error: `Iteration ${it.num} is finalized — start the next iteration, then import into it` });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const user = req.session.username || '';
  const admin = isAdminUser(user);
  const sites: string[] = admin ? [] : (((await query('select sites from app_users where key=$1', [normUser(user)])).rows[0]?.sites as string[]) || []);
  const people = await loadSnapshotPeople(it.staffing_snapshot_id);
  const byKey = new Map(people.map((p) => [p.key, p]));
  const homes = homeRegionsOf(people, await marketOfCode());
  const pairs = parseRaiseImport(req.file.buffer);
  let applied = 0, unchanged = 0;
  const skipped: { name: string; reason: string }[] = [];
  for (const { key, pct } of pairs) {
    const person = byKey.get(key);
    if (!person) { skipped.push({ name: key, reason: 'unknown key' }); continue; }
    if (pct < -50 || pct > 100) { skipped.push({ name: person.name, reason: 'raise % out of range' }); continue; }
    if (person.rm) { skipped.push({ name: person.name, reason: 'RM raises are entered in the app only' }); continue; }
    if (homes.get(key) && homes.get(key) !== it.region) { skipped.push({ name: person.name, reason: `belongs to ${homes.get(key)}` }); continue; }
    if (!admin && !person.allocations.some((a) => sites.includes(a.code))) { skipped.push({ name: person.name, reason: 'not one of your properties' }); continue; }
    const cur = (await query('select raise_pct from raise_entries where iteration_id=$1 and person_key=$2', [it.id, key])).rows[0];
    // untouched rows keep their original author — and "no entry yet" IS 0%
    if (Math.abs((cur ? Number(cur.raise_pct) : 0) - pct) < 0.0001) { unchanged++; continue; }
    await query(
      `insert into raise_entries(iteration_id, person_key, raise_pct, updated_by, updated_at) values($1,$2,$3,$4,now())
       on conflict (iteration_id, person_key) do update set raise_pct=excluded.raise_pct, updated_by=excluded.updated_by, updated_at=now()`,
      [it.id, key, pct, user]
    );
    applied++;
  }
  logChange(user, 'import raise workbook', { iterationId: it.id, region: it.region, applied, unchanged, skipped: skipped.length });
  res.json({ ok: true, applied, unchanged, skipped });
}));

/* ---- whole-cycle round trip (the "All regions" view): each person once, in
   their home region, raise read from that region's LATEST iteration ---- */
payrollRouter.get('/cycles/:id/export.xlsx', h(async (req, res) => {
  const cycle = (await query('select * from raise_cycles where id=$1', [Number(req.params.id)])).rows[0];
  if (!cycle) return res.status(404).json({ error: 'No such cycle' });
  const user = req.session.username || '';
  const asm = await assembleRaiseExport(cycle, user, null);
  if (!asm) return res.status(403).json({ error: 'No properties assigned to you' });
  const buf = await buildRaiseWorkbook({
    cycleLabel: cycle.label, effective: cycle.effective,
    title: `${cycle.label} — All regions (each region's latest iteration)`,
    exportedBy: user, sheets: asm.sheets, rows: asm.rows, hiddenByRegion: asm.hiddenByRegion,
    combined: true, allocations: asm.allocations,
  });
  logChange(user, 'export raise workbook (all regions)', { cycleId: cycle.id, rows: asm.rows.length });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${cycle.label} Raises ALL ${initialsOf(user)} ${mmddyyyy()}.xlsx"`);
  res.send(buf);
}));

payrollRouter.post('/cycles/:id/import', upload.single('file'), h(async (req, res) => {
  const cycle = (await query('select * from raise_cycles where id=$1', [Number(req.params.id)])).rows[0];
  if (!cycle) return res.status(404).json({ error: 'No such cycle' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const user = req.session.username || '';
  const admin = isAdminUser(user);
  const sites: string[] = admin ? [] : (((await query('select sites from app_users where key=$1', [normUser(user)])).rows[0]?.sites as string[]) || []);
  const people = await loadSnapshotPeople(cycle.staffing_snapshot_id);
  const byKey = new Map(people.map((p) => [p.key, p]));
  const homes = homeRegionsOf(people, await marketOfCode());
  const latest = await latestIterByRegion(cycle.id);
  const pairs = parseRaiseImport(req.file.buffer);
  let applied = 0, unchanged = 0;
  const skipped: { name: string; reason: string }[] = [];
  for (const { key, pct } of pairs) {
    const person = byKey.get(key);
    if (!person) { skipped.push({ name: key, reason: 'unknown key' }); continue; }
    if (pct < -50 || pct > 100) { skipped.push({ name: person.name, reason: 'raise % out of range' }); continue; }
    if (person.rm) { skipped.push({ name: person.name, reason: 'RM raises are entered in the app only' }); continue; }
    const home = homes.get(key);
    const target = home ? latest.get(home) : null;
    if (!target) { skipped.push({ name: person.name, reason: 'no iteration chain for their region' }); continue; }
    if (target.finalized) { skipped.push({ name: person.name, reason: `${home} iteration ${target.num} is finalized` }); continue; }
    if (!admin && !person.allocations.some((a) => sites.includes(a.code))) { skipped.push({ name: person.name, reason: 'not one of your properties' }); continue; }
    // untouched rows keep their original author — and "no entry yet" IS 0%
    if (Math.abs((target.entries[key] ?? 0) - pct) < 0.0001) { unchanged++; continue; }
    await query(
      `insert into raise_entries(iteration_id, person_key, raise_pct, updated_by, updated_at) values($1,$2,$3,$4,now())
       on conflict (iteration_id, person_key) do update set raise_pct=excluded.raise_pct, updated_by=excluded.updated_by, updated_at=now()`,
      [target.id, key, pct, user]
    );
    applied++;
  }
  logChange(user, 'import raise workbook (all regions)', { cycleId: cycle.id, applied, unchanged, skipped: skipped.length });
  res.json({ ok: true, applied, unchanged, skipped });
}));

/* ---------------- iteration lifecycle (admin) ---------------- */
payrollRouter.post('/iterations/:id/finalize', requireAdmin, h(async (req, res) => {
  const it = await loadIteration(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'No such iteration' });
  if (it.finalized_at) return res.status(409).json({ error: 'Already finalized' });
  const user = req.session.username || '';
  const row = (await query('update raise_iterations set finalized_by=$2, finalized_at=now() where id=$1 returning finalized_by, finalized_at', [it.id, user])).rows[0];
  logChange(user, 'finalize raise iteration', { iterationId: it.id, region: it.region, num: it.num });
  res.json({ ok: true, ...row });
}));

payrollRouter.post('/cycles/:id/regions/:region/iterations', requireAdmin, h(async (req, res) => {
  const cycleId = Number(req.params.id);
  const region = String(req.params.region);
  const user = req.session.username || '';
  const last = (await query('select * from raise_iterations where cycle_id=$1 and region=$2 order by num desc limit 1', [cycleId, region])).rows[0];
  if (!last) return res.status(404).json({ error: 'No iteration chain for this region' });
  if (!last.finalized_at) return res.status(409).json({ error: `Finalize iteration ${last.num} first` });
  const next = (await query(
    'insert into raise_iterations(cycle_id, region, num, based_on, created_by) values($1,$2,$3,$4,$5) returning *',
    [cycleId, region, last.num + 1, last.id, user]
  )).rows[0];
  await query(
    `insert into raise_entries(iteration_id, person_key, raise_pct, updated_by, updated_at)
     select $1, person_key, raise_pct, updated_by, updated_at from raise_entries where iteration_id=$2`,
    [next.id, last.id]
  );
  logChange(user, 'start raise iteration', { cycleId, region, num: next.num, basedOn: last.id });
  res.json({ ok: true, iteration: next });
}));

/* ---------------- apply to budgets (admin) ----------------
   Writes each property's wage GLs (annual $, raise prorated from the
   effective month) into its budget's inputs.wages and regenerates — taxes,
   benefits and bonuses follow the engine's own drivers from there. */
payrollRouter.post('/iterations/:id/apply', requireAdmin, h(async (req, res) => {
  const it = await loadIteration(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'No such iteration' });
  const user = req.session.username || '';
  const effYear = Number(String(it.effective).slice(0, 4));
  const year = Number(req.body?.year) || effYear;
  const people = await loadSnapshotPeople(it.staffing_snapshot_id);
  // home people take THIS iteration's entries; a foreign-home person's raise
  // comes from their own region's latest chain (one raise per person, ever)
  const homesA = homeRegionsOf(people, await marketOfCode());
  const latestA = await latestIterByRegion(it.cycle_id);
  const thisEntries: RaiseMap = {};
  for (const e of (await query('select person_key, raise_pct from raise_entries where iteration_id=$1', [it.id])).rows) {
    thisEntries[e.person_key] = Number(e.raise_pct);
  }
  const raises: RaiseMap = {};
  for (const p of people) {
    const home = homesA.get(p.key);
    raises[p.key] = home === it.region ? (thisEntries[p.key] ?? 0) : ((home && latestA.get(home)?.entries[p.key]) || 0);
  }
  const props = (await query(`select code, market from properties`)).rows as any[];
  const codes = props.filter((p) => regionOf(p) === it.region).map((p) => p.code);
  const applied: any[] = [];
  const skipped: any[] = [];
  for (const code of codes) {
    if (!people.some((p) => p.allocations.some((a) => a.code === code))) continue;
    const budget = (await query(
      `select id, inputs, budget_type from budgets where property_code=$1 and year=$2 order by updated_at desc limit 1`, [code, year]
    )).rows[0];
    if (!budget) { skipped.push({ code, reason: `no ${year} budget` }); continue; }
    const { wages, unmappedPositions } = annualWagesByGl(people, code, raises, it.effective, year);
    // the roster is AUTHORITATIVE for every wage GL: zero the ones it doesn't
    // produce (6405 always, 6407 since rovers are maint — Troy 2026-11-02) so
    // a stale payroll-model figure can't double-count underneath
    const base: Record<string, number> = { '6402': 0, '6404': 0, '6405': 0, '6407': 0 };
    // roster wages already carry each raise prorated from its effective month —
    // the engine must not add its March step on top (it did: a second 3.5%)
    const inputs = { ...(budget.inputs || {}), wages: { ...((budget.inputs || {}).wages || {}), ...base, ...wages }, wagesFromRoster: true };
    await query('update budgets set inputs=$2, updated_at=now() where id=$1', [budget.id, JSON.stringify(inputs)]);
    const lb = (await loadBudget(budget.id))!;
    const built = buildLines(lb, lb.budget.inputs, lb.lines);
    await saveLines(budget.id, built.lines, true);
    applied.push({ code, budgetId: budget.id, wages, unmappedPositions });
  }
  logChange(user, 'apply raises to budgets', { iterationId: it.id, region: it.region, year, applied: applied.map((a) => a.code), skipped });
  res.json({ ok: true, year, applied, skipped });
}));

/* ---------------- RM users & sites (admin) ---------------- */
payrollRouter.put('/users/:key/sites', requireAdmin, h(async (req, res) => {
  const sites = Array.isArray(req.body?.sites) ? req.body.sites.map((s: any) => String(s).toLowerCase()).filter(Boolean) : [];
  const r = await query('update app_users set sites=$2, updated_at=now() where key=$1 returning key, display, sites', [String(req.params.key), JSON.stringify(sites)]);
  if (!r.rows.length) return res.status(404).json({ error: 'No such user (they appear after their first sign-in)' });
  logChange(req.session.username || '', 'set payroll sites', { user: req.params.key, sites });
  res.json({ ok: true, user: r.rows[0] });
}));

payrollRouter.delete('/staffing/:id', requireAdmin, h(async (req, res) => {
  const used = (await query('select count(*)::int as n from raise_cycles where staffing_snapshot_id=$1', [Number(req.params.id)])).rows[0].n;
  if (used) return res.status(409).json({ error: `${used} raise cycle(s) still use this snapshot` });
  await query('delete from staffing_snapshots where id=$1', [Number(req.params.id)]);
  logChange(req.session.username || '', 'delete staffing snapshot', { id: Number(req.params.id) });
  res.json({ ok: true });
}));
