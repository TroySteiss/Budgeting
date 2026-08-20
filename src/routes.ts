import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { query, tx } from './db.js';
import { requireAuth, requireAdmin, login, logout, status } from './auth.js';
import { parseUwBook, parseRentRoll, parseComparison, parseSellerT12 } from './importers.js';
import { buildBudgetCsv } from './csv-export.js';
import { buildReviewWorkbook } from './xlsx-export.js';
import {
  CoaAccount, BudgetLine, BudgetInputs, UwSnapshotData, CompWeights, Months,
  generateLines, regenerate, rebalanceCategory, defaultInputs, computeTieout,
  kpis, categoryTotals, t12CategoryShapes, zero12, r2, sum,
} from '../shared/domain.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
export const router = Router();

/* async error wrapper → JSON 500 */
const h = (fn: (req: Request, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const logChange = (username: string, action: string, detail: any): void => {
  query('insert into change_log(username, action, detail) values($1,$2,$3)', [username, action, JSON.stringify(detail)]).catch(() => {});
};

/* ---------------- auth ---------------- */
router.post('/login', h(login as any));
router.post('/logout', logout);
router.get('/auth/status', h(status as any));
router.use(requireAuth);

/* ---------------- state ---------------- */
async function loadCoa(): Promise<CoaAccount[]> {
  return (await query<CoaAccount>('select code, name, kind, section, pcode, csv_order, display_order, curve, active from gl_accounts order by display_order')).rows;
}

router.get('/state', h(async (_req, res) => {
  const [coa, portfolios, properties, budgets, uws, comps, t12s, rents] = await Promise.all([
    loadCoa(),
    query('select * from portfolios order by name'),
    query('select * from properties order by code'),
    query(`select b.id, b.property_code, b.year, b.label, b.budget_type, b.status, b.updated_at,
                  b.uw_snapshot_id, b.comp_set_id, b.rent_snapshot_id, p.name as property_name
           from budgets b join properties p on p.code=b.property_code order by b.updated_at desc`),
    query(`select u.id, u.property_code, u.label, u.created_at,
                  (u.data->>'noi')::numeric as noi, (u.data->>'units')::int as units
           from uw_snapshots u order by u.created_at desc`),
    query('select id, name, period, book, created_at from comp_sets order by created_at desc'),
    query('select id, property_code, label, period, book, created_at from t12_snapshots order by created_at desc'),
    query(`select id, property_code, as_of, created_at,
                  (data->>'marketMonthly')::numeric as market_monthly,
                  (data->>'inPlaceMonthly')::numeric as inplace_monthly,
                  (data->>'units')::int as units
           from rent_snapshots order by created_at desc`),
  ]);
  res.json({
    coa, portfolios: portfolios.rows, properties: properties.rows,
    budgets: budgets.rows, uwSnapshots: uws.rows, compSets: comps.rows,
    t12Snapshots: t12s.rows, rentSnapshots: rents.rows,
  });
}));

/* ---------------- uploads ---------------- */
router.post('/uploads/parse', upload.single('file'), h(async (req, res) => {
  const kind = String(req.query.kind || req.body?.kind || '');
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const buf = req.file.buffer;
  if (kind === 'uw_book') {
    const sheets = parseUwBook(buf);
    if (!sheets.length) return res.status(422).json({ error: 'No UW pro forma sheets recognized in this workbook' });
    return res.json({ kind, filename: req.file.originalname, sheets });
  }
  if (kind === 'rent_roll') {
    const props = parseRentRoll(buf);
    return res.json({ kind, filename: req.file.originalname, properties: props });
  }
  if (kind === 'comparison') {
    const parsed = parseComparison(buf);
    return res.json({ kind, filename: req.file.originalname, comparison: parsed });
  }
  if (kind === 'seller_t12') {
    const parsed = parseSellerT12(buf);
    return res.json({ kind, filename: req.file.originalname, t12: parsed });
  }
  res.status(400).json({ error: `Unknown upload kind "${kind}"` });
}));

router.post('/uploads/apply', h(async (req, res) => {
  const { kind, filename, payload, mappings, name } = req.body || {};
  const user = req.session.username || '';
  const uploadId = (await query(
    'insert into uploads(kind, filename, uploaded_by, payload) values($1,$2,$3,$4) returning id',
    [kind, filename || '', user, JSON.stringify(payload || {})]
  )).rows[0].id;

  if (kind === 'uw_book') {
    // mappings: [{sheetName, propertyCode}] — sheets come from the parse payload
    const created: any[] = [];
    for (const m of mappings || []) {
      const sheet = (payload.sheets || []).find((x: any) => x.sheetName === m.sheetName);
      if (!sheet || !m.propertyCode) continue;
      const row = (await query(
        'insert into uw_snapshots(property_code, upload_id, label, data) values($1,$2,$3,$4) returning id',
        [m.propertyCode, uploadId, `${filename || 'UW'} — ${m.sheetName}`, JSON.stringify(sheet.data)]
      )).rows[0];
      created.push({ id: row.id, propertyCode: m.propertyCode });
    }
    logChange(user, 'upload uw_book', { filename, created });
    return res.json({ ok: true, uploadId, created });
  }
  if (kind === 'rent_roll') {
    const created: any[] = [];
    for (const m of mappings || []) {
      const p = (payload.properties || []).find((x: any) => (x.code && x.code === m.sourceCode) || x.name === m.sourceName);
      if (!p || !m.propertyCode) continue;
      const data = { units: p.units, marketMonthly: p.marketMonthly, inPlaceMonthly: p.inPlaceMonthly, occupiedUnits: p.occupiedUnits, source: p.source };
      const row = (await query(
        'insert into rent_snapshots(property_code, upload_id, as_of, data) values($1,$2,$3,$4) returning id',
        [m.propertyCode, uploadId, p.asOf ? new Date(p.asOf) : null, JSON.stringify(data)]
      )).rows[0];
      created.push({ id: row.id, propertyCode: m.propertyCode });
    }
    logChange(user, 'upload rent_roll', { filename, created });
    return res.json({ ok: true, uploadId, created });
  }
  if (kind === 'comparison') {
    const c = payload.comparison;
    if (!c) return res.status(400).json({ error: 'No comparison payload' });
    // comp-set units: explicit from the client, else summed from matched property codes
    let units = Number(req.body?.units) || 0;
    if (!units && Array.isArray(c.properties)) {
      const r = await query('select coalesce(sum(units),0)::int as u from properties where code = any($1)', [c.properties]);
      units = r.rows[0].u;
    }
    const row = (await query(
      'insert into comp_sets(name, upload_id, period, book, data) values($1,$2,$3,$4,$5) returning id',
      [name || c.label || filename || 'Comp set', uploadId, c.period || '', c.book || '',
       JSON.stringify({ properties: c.properties, rows: c.rows, monthly: !!c.monthly, monthCal: c.monthCal || null, units })]
    )).rows[0];
    logChange(user, 'upload comparison', { filename, compSetId: row.id, units });
    return res.json({ ok: true, uploadId, compSetId: row.id, units });
  }
  if (kind === 'seller_t12') {
    const t = payload.t12;
    const propertyCode = (mappings && mappings[0]?.propertyCode) || null;
    if (!t || !propertyCode) return res.status(400).json({ error: 'seller_t12 needs a parsed payload and a property mapping' });
    const row = (await query(
      'insert into t12_snapshots(property_code, upload_id, label, period, book, data) values($1,$2,$3,$4,$5,$6) returning id',
      [propertyCode, uploadId, t.label || filename || 'T12', t.period || '', t.book || '',
       JSON.stringify({ monthCal: t.monthCal, rows: t.rows })]
    )).rows[0];
    logChange(user, 'upload seller_t12', { filename, propertyCode, t12Id: row.id });
    return res.json({ ok: true, uploadId, t12Id: row.id });
  }
  res.status(400).json({ error: `Unknown upload kind "${kind}"` });
}));

/* ---------------- budgets ---------------- */
interface LoadedBudget {
  budget: any; lines: BudgetLine[]; coa: CoaAccount[]; coaMap: Map<string, CoaAccount>;
  uw: UwSnapshotData | null; comps: CompWeights | null; catShapes: Record<string, Months> | null;
}

async function loadBudget(id: number): Promise<LoadedBudget | null> {
  const budget = (await query('select * from budgets where id=$1', [id])).rows[0];
  if (!budget) return null;
  const [lineRows, coa] = await Promise.all([
    query('select gl_code, months, driver, override, note from budget_lines where budget_id=$1', [id]),
    loadCoa(),
  ]);
  const lines: BudgetLine[] = lineRows.rows.map((r: any) => ({
    gl_code: r.gl_code, months: r.months as Months, driver: r.driver, override: r.override, note: r.note,
  }));
  let uw: UwSnapshotData | null = null;
  if (budget.uw_snapshot_id) {
    const u = (await query('select data from uw_snapshots where id=$1', [budget.uw_snapshot_id])).rows[0];
    uw = u ? (u.data as UwSnapshotData) : null;
  }
  let comps: CompWeights | null = null;
  if (budget.comp_set_id) {
    const c = (await query('select data from comp_sets where id=$1', [budget.comp_set_id])).rows[0];
    if (c) {
      const byGl: Record<string, number> = {};
      const glShapes: Record<string, Months> = {};
      const monthCal: number[] = c.data.monthCal || [];
      for (const row of c.data.rows || []) {
        byGl[row.gl] = row.total || 0;                       // SIGNED comp totals
        if (c.data.monthly && Array.isArray(row.months)) {   // per-GL calendar shape
          const cal = Array(12).fill(0);
          row.months.forEach((v: number, i: number) => { cal[(monthCal[i] || i + 1) - 1] += Math.abs(v || 0); });
          const tot = cal.reduce((a: number, b: number) => a + b, 0);
          if (tot > 0) glShapes[row.gl] = cal.map((v: number) => v / tot);
        }
      }
      comps = { byGl, glShapes: c.data.monthly ? glShapes : undefined, units: Number(c.data.units) || undefined };
    }
  }
  // seller-T12 monthly shapes (seller GL → pcode map comes from the UW book's coded T12 panel)
  let catShapes: Record<string, Months> | null = null;
  if (budget.t12_snapshot_id && uw?.t12?.length) {
    const t = (await query('select data from t12_snapshots where id=$1', [budget.t12_snapshot_id])).rows[0];
    if (t?.data?.rows?.length) {
      const glToPcode: Record<string, string> = {};
      for (const r of uw.t12) glToPcode[r.gl] = r.pcode;
      catShapes = t12CategoryShapes(t.data.rows, t.data.monthCal || [], glToPcode);
    }
  }
  return { budget, lines, coa, coaMap: new Map(coa.map((a) => [a.code, a])), uw, comps, catShapes };
}

async function saveLines(budgetId: number, lines: BudgetLine[]): Promise<void> {
  await tx(async (c) => {
    await c.query('delete from budget_lines where budget_id=$1', [budgetId]);
    for (const l of lines) {
      await c.query(
        'insert into budget_lines(budget_id, gl_code, months, driver, override, note) values($1,$2,$3,$4,$5,$6)',
        [budgetId, l.gl_code, JSON.stringify(l.months), JSON.stringify(l.driver), l.override, l.note || '']
      );
    }
    await c.query('update budgets set updated_at=now() where id=$1', [budgetId]);
  });
}

function budgetView(lb: LoadedBudget) {
  const monthsMap = new Map(lb.lines.map((l) => [l.gl_code, l.months]));
  return {
    budget: lb.budget,
    lines: lb.lines,
    tieout: computeTieout(lb.lines, lb.coaMap, lb.uw),
    kpis: kpis(monthsMap, Number(lb.budget.inputs?.capital) || 0),
    categoryTotals: categoryTotals(lb.lines, lb.coaMap),
    uw: lb.uw,
    compWeights: lb.comps?.byGl || null,
    compUnits: lb.comps?.units || null,
  };
}

router.post('/budgets', h(async (req, res) => {
  const { propertyCode, year, label, uwSnapshotId, compSetId, rentSnapshotId, t12SnapshotId } = req.body || {};
  if (!propertyCode || !year) return res.status(400).json({ error: 'propertyCode and year are required' });
  const prop = (await query('select * from properties where code=$1', [propertyCode])).rows[0];
  if (!prop) return res.status(400).json({ error: `Unknown property ${propertyCode}` });

  let uw: UwSnapshotData | null = null;
  if (uwSnapshotId) uw = ((await query('select data from uw_snapshots where id=$1', [uwSnapshotId])).rows[0]?.data as UwSnapshotData) || null;
  let rent: { marketMonthly: number; inPlaceMonthly: number } | null = null;
  if (rentSnapshotId) {
    const r = (await query('select data from rent_snapshots where id=$1', [rentSnapshotId])).rows[0];
    if (r) rent = { marketMonthly: Number(r.data.marketMonthly) || 0, inPlaceMonthly: Number(r.data.inPlaceMonthly) || 0 };
  }

  const inputs: BudgetInputs = uw
    ? { ...defaultInputs(Number(year), uw, rent), units: uw.units || prop.units }
    : {
        year: Number(year), units: prop.units, capital: 0, loan: 0, rate: 0.06, startMonth: 1,
        gpr: { baseMonthly: rent ? rent.marketMonthly : 0, growthPct: zero12() },
        ltl: { startMonthly: rent ? -Math.max(0, r2(rent.marketMonthly - rent.inPlaceMonthly)) : 0, targetPct: 0.02, rampMonths: 12 },
        vacancyPct: Array(12).fill(0.05) as Months,
        concessionPct: 0.005, rentalLossPct: 0.07, mgmtPct: 0.04, uwAbs: {},
      };

  const id = (await query(
    `insert into budgets(property_code, year, label, budget_type, inputs, uw_snapshot_id, comp_set_id, rent_snapshot_id, t12_snapshot_id, created_by)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [propertyCode, year, label || `${propertyCode} ${year} Budget`, 'new_acq', JSON.stringify(inputs),
     uwSnapshotId || null, compSetId || null, rentSnapshotId || null, t12SnapshotId || null, req.session.username || '']
  )).rows[0].id;

  const lb = await loadBudget(id);
  const lines = generateLines(lb!.coa, inputs, lb!.uw, lb!.comps, lb!.catShapes);
  await saveLines(id, lines);
  logChange(req.session.username || '', 'create budget', { id, propertyCode, year });
  res.json(budgetView((await loadBudget(id))!));
}));

router.get('/budgets/:id', h(async (req, res) => {
  const lb = await loadBudget(Number(req.params.id));
  if (!lb) return res.status(404).json({ error: 'Not found' });
  res.json(budgetView(lb));
}));

router.put('/budgets/:id', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const { inputs, label, status: st } = req.body || {};
  if (label != null || st != null) {
    await query('update budgets set label=coalesce($2,label), status=coalesce($3,status), updated_at=now() where id=$1', [id, label ?? null, st ?? null]);
  }
  if (inputs) {
    const merged: BudgetInputs = { ...lb.budget.inputs, ...inputs };
    await query('update budgets set inputs=$2, updated_at=now() where id=$1', [id, JSON.stringify(merged)]);
    const lines = regenerate(lb.lines, lb.coa, merged, lb.uw, lb.comps, lb.catShapes);
    await saveLines(id, lines);
    logChange(req.session.username || '', 'update budget inputs', { id });
  }
  res.json(budgetView((await loadBudget(id))!));
}));

router.put('/budgets/:id/lines/:gl', h(async (req, res) => {
  const id = Number(req.params.id);
  const gl = String(req.params.gl);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const { months, note, override, driver } = req.body || {};
  const existing = lb.lines.find((l) => l.gl_code === gl);
  if (!existing) return res.status(404).json({ error: `No line for GL ${gl}` });
  if (months) {
    if (!Array.isArray(months) || months.length !== 12) return res.status(400).json({ error: 'months must be an array of 12 numbers' });
    existing.months = months.map((v: any) => r2(Number(v) || 0));
    existing.override = true;
    existing.driver = { method: 'manual' };
  }
  if (typeof override === 'boolean') existing.override = override;
  if (typeof note === 'string') existing.note = note;
  if (driver) existing.driver = driver;
  await query(
    'update budget_lines set months=$3, driver=$4, override=$5, note=$6 where budget_id=$1 and gl_code=$2',
    [id, gl, JSON.stringify(existing.months), JSON.stringify(existing.driver), existing.override, existing.note]
  );
  await query('update budgets set updated_at=now() where id=$1', [id]);
  logChange(req.session.username || '', 'edit line', { id, gl, annual: sum(existing.months) });
  res.json(budgetView((await loadBudget(id))!));
}));

router.post('/budgets/:id/recalc', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const lines = regenerate(lb.lines, lb.coa, lb.budget.inputs, lb.uw, lb.comps, lb.catShapes);
  await saveLines(id, lines);
  res.json(budgetView((await loadBudget(id))!));
}));

router.post('/budgets/:id/rebalance', h(async (req, res) => {
  const id = Number(req.params.id);
  const pcode = String(req.body?.pcode || '');
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const inputs: BudgetInputs = lb.budget.inputs;
  // target: abs categories tie to UW $; GPR-relative categories tie to pct × current GPR
  let target: number | null = null;
  const gprAnnual = sum(lb.lines.find((l) => l.gl_code === '4994')?.months || zero12());
  if (['4', '5', '6', '8', '9', '10', '11', '12', '13', '14'].includes(pcode)) {
    if (inputs.catBasis?.[pcode] === 'perUnit' && lb.comps?.units && inputs.units) {
      // per-unit basis: tie to comp $/unit × subject units across the category's detail GLs
      let compCat = 0;
      for (const [gl, v] of Object.entries(lb.comps.byGl)) {
        const acc = lb.coaMap.get(gl);
        if (acc?.kind === 'detail' && acc.pcode === pcode) compCat += v;
      }
      target = r2((compCat / lb.comps.units) * inputs.units);
    } else {
      target = r2(inputs.uwAbs?.[pcode] || 0);
    }
  }
  else if (pcode === '2') target = -r2(inputs.concessionPct * gprAnnual);
  else if (pcode === '3') target = -r2(inputs.rentalLossPct * gprAnnual);
  else if (pcode === 'loss') target = -r2(inputs.ltl.targetPct * gprAnnual);
  else if (pcode === '7') target = null; // mgmt fee is % of income — use recalc instead
  if (target == null) return res.status(400).json({ error: `Category ${pcode} cannot be rebalanced directly` });
  const lines = rebalanceCategory(lb.lines, lb.coaMap, pcode, target);
  await saveLines(id, lines);
  logChange(req.session.username || '', 'rebalance category', { id, pcode, target });
  res.json(budgetView((await loadBudget(id))!));
}));

router.delete('/budgets/:id', requireAdmin, h(async (req, res) => {
  await query('delete from budgets where id=$1', [Number(req.params.id)]);
  logChange(req.session.username || '', 'delete budget', { id: req.params.id });
  res.json({ ok: true });
}));

/* ---------------- exports ---------------- */
router.get('/budgets/:id/export.csv', h(async (req, res) => {
  const lb = await loadBudget(Number(req.params.id));
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const cutoff = Math.max(0, Math.min(11, Number(req.query.cutoff) || 0));
  const now = new Date();
  const mmddyyyy = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}`;
  const desc = String(req.query.desc || '') ||
    `${lb.budget.property_code} ${lb.budget.year} Budget ${cutoff ? 'Revision' : 'Upload'} ${mmddyyyy}`;
  const csv = buildBudgetCsv(lb.coa, lb.lines, {
    propertyId: lb.budget.property_code, year: lb.budget.year, description: desc, cutoffMonth: cutoff,
  });
  const fname = `${lb.budget.property_code.toUpperCase()} ${lb.budget.year} Budget ${cutoff ? 'Revision' : 'Upload'} ${mmddyyyy}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
}));

router.get('/budgets/:id/export.xlsx', h(async (req, res) => {
  const lb = await loadBudget(Number(req.params.id));
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const prop = (await query('select * from properties where code=$1', [lb.budget.property_code])).rows[0];
  const buf = buildReviewWorkbook({
    propertyCode: lb.budget.property_code, propertyName: prop?.name || lb.budget.property_code,
    year: lb.budget.year, units: Number(lb.budget.inputs?.units) || prop?.units || 0,
    coa: lb.coa, lines: lb.lines, inputs: lb.budget.inputs, uw: lb.uw,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${lb.budget.property_code.toUpperCase()} ${lb.budget.year} Budget Review.xlsx"`);
  res.send(buf);
}));

/* ---------------- admin: properties & COA ---------------- */
router.post('/properties', requireAdmin, h(async (req, res) => {
  const { code, name, units, market, portfolioId, role } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  await query(
    `insert into properties(code, name, units, market, portfolio_id, role) values($1,$2,$3,$4,$5,$6)
     on conflict (code) do update set name=excluded.name, units=excluded.units, market=excluded.market,
       portfolio_id=excluded.portfolio_id, role=excluded.role`,
    [String(code).toLowerCase(), name || '', Number(units) || 0, market || '', portfolioId || null, role || 'subject']
  );
  res.json({ ok: true });
}));

router.put('/gl/:code', requireAdmin, h(async (req, res) => {
  const { pcode, curve, active } = req.body || {};
  await query('update gl_accounts set pcode=coalesce($2,pcode), curve=coalesce($3,curve), active=coalesce($4,active) where code=$1',
    [req.params.code, pcode ?? null, curve ?? null, typeof active === 'boolean' ? active : null]);
  res.json({ ok: true });
}));

/* error handler */
export function apiErrors(err: any, _req: Request, res: Response, _next: NextFunction) {
  console.error(err);
  res.status(500).json({ error: err?.message || 'Server error' });
}
