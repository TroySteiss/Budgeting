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
import { parseStaffingReport, parsePayrollModel } from './importers.js';
import { loadBudget, buildLines, saveLines } from './routes.js';
import { maskPeople, hiddenAggregates, annualWagesByGl, seatMonthly, type StaffingPerson, type RaiseMap } from '../shared/payroll.js';
import { buildRaiseWorkbook, parseRaiseImport, type RaiseExportRow } from './payroll-xlsx.js';

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
payrollRouter.post('/staffing', requireAdmin, upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const parsed = parseStaffingReport(req.file.buffer);
  const known = new Set((await query(`select code from properties`)).rows.map((r: any) => r.code));
  // keep only people with an allocation at a property this tool budgets
  const people: StaffingPerson[] = [];
  for (const p of parsed.people) {
    const allocations = p.allocations.filter((a) => known.has(a.code));
    if (allocations.length) people.push({ ...p, allocations });
  }
  if (!people.length) return res.status(422).json({ error: 'No roster rows map to this tool’s properties' });
  const user = req.session.username || '';
  const label = String(req.body?.name || '').trim() || parsed.label || req.file.originalname;
  // uploads row carries COUNTS only; the roster lives in staffing_snapshots
  const perProperty: Record<string, number> = {};
  for (const p of people) for (const a of p.allocations) perProperty[a.code] = (perProperty[a.code] || 0) + 1;
  const uploadId = (await query(
    'insert into uploads(kind, filename, uploaded_by, payload) values($1,$2,$3,$4) returning id',
    ['staffing', req.file.originalname, user, JSON.stringify({ people: people.length, totalRows: parsed.totalRows, perProperty })]
  )).rows[0].id;
  const row = (await query(
    'insert into staffing_snapshots(upload_id, label, data) values($1,$2,$3) returning id',
    [uploadId, label, JSON.stringify({ people })]
  )).rows[0];
  // the same workbook usually carries the wage-aggregate model (Wages sheet) —
  // one drop refreshes BOTH, so nobody uploads the same file twice (Troy
  // 2026-10-30). Budgets keep whichever model they already point at.
  let payrollModelId: number | null = null;
  try {
    const pm = parsePayrollModel(req.file.buffer);
    payrollModelId = (await query(
      'insert into payroll_models(upload_id, label, data) values($1,$2,$3) returning id',
      [uploadId, label, JSON.stringify({ properties: pm.properties, unmappedPositions: pm.unmappedPositions, employeeRows: pm.employeeRows })]
    )).rows[0].id;
  } catch { /* no Wages-style sheet in this file — staffing only */ }
  logChange(user, 'upload staffing report', { filename: req.file.originalname, staffingSnapshotId: row.id, people: people.length, payrollModelId });
  res.json({
    ok: true, id: row.id, label, people: people.length, totalRows: parsed.totalRows,
    perProperty, skippedOffPortfolio: parsed.people.length - people.length,
    allocatedWithoutSplit: parsed.allocatedWithoutSplit, skippedNoProperty: parsed.skippedNoProperty,
    payrollModelId,
  });
}));

/* ---------------- cycles ---------------- */
async function loadSnapshotPeople(snapshotId: number): Promise<StaffingPerson[]> {
  const r = (await query('select data from staffing_snapshots where id=$1', [snapshotId])).rows[0];
  return (r?.data?.people as StaffingPerson[]) || [];
}
const regionOf = (p: { market?: string }): string => String(p.market || '').trim() || 'Other';

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

  const iterations = (await query(
    'select * from raise_iterations where cycle_id=$1 and region = any($2) order by region, num', [cycle.id, regions]
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
  const out = iterations.map((it) => {
    const em = byIter.get(it.id) || {};
    const raises: RaiseMap = {};
    for (const [k, v] of Object.entries(em)) raises[k] = v.pct;
    return {
      id: it.id, region: it.region, num: it.num, basedOn: it.based_on,
      createdBy: it.created_by, createdAt: it.created_at,
      finalizedBy: it.finalized_by, finalizedAt: it.finalized_at,
      propStatus: it.prop_status || {}, entries: em,
      // masked viewers get RM wages only as per-property aggregates, so their
      // totals reconcile without any per-seat figure
      hidden: rmPay ? null : hiddenAggregates(visPeople, raises, [...visCodes]),
    };
  });
  res.json({
    cycle, regions,
    properties: visibleProps,
    people: maskPeople(visPeople, rmPay),
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

/** The iteration's working set, scoped + masked exactly like GET /cycles/:id. */
async function scopedIterView(req: Request, iterId: number): Promise<{ error: string; code: number } | {
  it: any; cycle: any; user: string; admin: boolean; rmPay: boolean;
  visCodes: Set<string>; people: (StaffingPerson & { payHidden?: boolean })[]; rawPeople: StaffingPerson[];
  entries: Record<string, { pct: number; by: string; at: string }>;
}> {
  const it = await loadIteration(iterId);
  if (!it) return { error: 'No such iteration', code: 404 };
  const cycle = (await query('select * from raise_cycles where id=$1', [it.cycle_id])).rows[0];
  const user = req.session.username || '';
  const admin = isAdminUser(user);
  const people = await loadSnapshotPeople(it.staffing_snapshot_id);
  const props = (await query('select code, market from properties')).rows as any[];
  const sites: string[] = admin ? props.map((p) => p.code)
    : (((await query('select sites from app_users where key=$1', [normUser(user)])).rows[0]?.sites as string[]) || []);
  const siteSet = new Set(sites);
  const visCodes = new Set(props
    .filter((p) => regionOf(p) === it.region && siteSet.has(p.code) && people.some((x) => x.allocations.some((a) => a.code === p.code)))
    .map((p) => p.code));
  if (!visCodes.size) return { error: 'No properties assigned to you in this region', code: 403 };
  const entries: Record<string, { pct: number; by: string; at: string }> = {};
  for (const e of (await query('select person_key, raise_pct, updated_by, updated_at from raise_entries where iteration_id=$1', [it.id])).rows) {
    entries[e.person_key] = { pct: Number(e.raise_pct), by: e.updated_by, at: String(e.updated_at) };
  }
  const rawPeople = people.filter((p) => p.allocations.some((a) => visCodes.has(a.code)));
  return { it, cycle, user, admin, rmPay: canSeeRmPay(user), visCodes, people: maskPeople(rawPeople, canSeeRmPay(user)), rawPeople, entries };
}

payrollRouter.get('/iterations/:id/export.xlsx', h(async (req, res) => {
  const v = await scopedIterView(req, Number(req.params.id));
  if ('error' in v) return res.status(v.code).json({ error: v.error });
  const rows: RaiseExportRow[] = [];
  const allocations: any[] = [];
  for (const p of v.people) {
    const regA = p.allocations.filter((a) => v.visCodes.has(a.code));
    if (!regA.length) continue;
    const prim = [...regA].sort((a, b) => b.pct - a.pct)[0];
    const others = p.allocations.filter((a) => a.code !== prim.code);
    const e = v.entries[p.key];
    const masked = !!p.payHidden;
    rows.push({
      key: p.key, name: p.name, position: p.position,
      primCode: prim.code, primPct: prim.pct,
      splitNote: others.length ? `also ${others.map((x) => `${x.code.toUpperCase()} ${Math.round(x.pct * 100)}%`).join(' · ')}` : '',
      payMethod: p.payMethod,
      payRate: masked ? null : p.payRate,
      regionMoCur: masked ? null : regA.reduce((s, a) => s + seatMonthly(p.payMethod, p.payRate, a.pct), 0),
      raisePct: e ? e.pct : 0, by: e ? e.by : '', at: e ? e.at : '', rm: !!p.rm,
    });
    for (const a of regA) {
      allocations.push({
        key: p.key, name: p.name, position: p.position, payMethod: p.payMethod,
        payRate: masked ? null : p.payRate, monthlyBenefits: masked ? null : p.monthlyBenefits,
        status: p.status, startDate: p.startDate, code: a.code, pct: a.pct,
      });
    }
  }
  rows.sort((x, y) => x.primCode.localeCompare(y.primCode) || x.position.localeCompare(y.position) || x.name.localeCompare(y.name));
  let hidden: { curMo: number; newMo: number } | null = null;
  if (!v.rmPay) {
    const raises: RaiseMap = {};
    for (const [k, e] of Object.entries(v.entries)) raises[k] = e.pct;
    const agg = hiddenAggregates(v.rawPeople, raises, [...v.visCodes]);
    hidden = Object.values(agg).reduce((s, x) => ({ curMo: s.curMo + x.curMo, newMo: s.newMo + x.newMo }), { curMo: 0, newMo: 0 });
    if (!hidden.curMo) hidden = null;
  }
  const buf = await buildRaiseWorkbook({
    cycleLabel: v.cycle.label, effective: v.cycle.effective, region: v.it.region, iterNum: v.it.num,
    finalized: v.it.finalized_at ? { by: v.it.finalized_by, at: String(v.it.finalized_at) } : null,
    exportedBy: v.user, rows, hidden, allocations,
  });
  logChange(v.user, 'export raise workbook', { iterationId: v.it.id, region: v.it.region, rows: rows.length });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${v.it.region} Raises Iteration ${v.it.num} ${initialsOf(v.user)} ${mmddyyyy()}.xlsx"`);
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
  const pairs = parseRaiseImport(req.file.buffer);
  let applied = 0, unchanged = 0;
  const skipped: { name: string; reason: string }[] = [];
  for (const { key, pct } of pairs) {
    const person = byKey.get(key);
    if (!person) { skipped.push({ name: key, reason: 'unknown key' }); continue; }
    if (pct < -50 || pct > 100) { skipped.push({ name: person.name, reason: 'raise % out of range' }); continue; }
    if (person.rm && !canSeeRmPay(user)) { skipped.push({ name: person.name, reason: 'RM pay — allowlist only' }); continue; }
    if (!admin && !person.allocations.some((a) => sites.includes(a.code))) { skipped.push({ name: person.name, reason: 'not one of your properties' }); continue; }
    const cur = (await query('select raise_pct from raise_entries where iteration_id=$1 and person_key=$2', [it.id, key])).rows[0];
    if (cur && Math.abs(Number(cur.raise_pct) - pct) < 0.0001) { unchanged++; continue; }   // untouched rows keep their original author
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
  const raises: RaiseMap = {};
  for (const e of (await query('select person_key, raise_pct from raise_entries where iteration_id=$1', [it.id])).rows) {
    raises[e.person_key] = Number(e.raise_pct);
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
    const inputs = { ...(budget.inputs || {}), wages: { ...((budget.inputs || {}).wages || {}), ...wages } };
    await query('update budgets set inputs=$2, updated_at=now() where id=$1', [budget.id, JSON.stringify(inputs)]);
    const lb = (await loadBudget(budget.id))!;
    const built = buildLines(lb, lb.budget.inputs, lb.lines);
    await saveLines(budget.id, built.lines);
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
