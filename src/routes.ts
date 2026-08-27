import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { query, tx } from './db.js';
import { requireAuth, requireAdmin, login, logout, status } from './auth.js';
import { parseUwBook, parseRentRoll, parseComparison, parseSellerT12, parsePayrollModel } from './importers.js';
import { buildBudgetCsv } from './csv-export.js';
import { buildReviewWorkbook } from './xlsx-export.js';
import {
  CoaAccount, BudgetLine, BudgetInputs, UwSnapshotData, CompWeights, Months,
  generateLines, regenerate, rebalanceCategory, defaultInputs, computeTieout,
  kpis, categoryTotals, t12CategoryShapes, tieNoiToUw, tieIncomeToUw, DEFAULT_NOI_FLEX,
  calendarSlice, monthLabels, applyRounding, zero12, r2, sum, CURVES, type Lease, type SellerUtilRow,
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
  const [coa, portfolios, properties, budgets, uws, comps, t12s, payrolls, rents] = await Promise.all([
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
    query('select id, label, created_at from payroll_models order by created_at desc'),
    query(`select id, property_code, as_of, created_at,
                  (data->>'marketMonthly')::numeric as market_monthly,
                  (data->>'inPlaceMonthly')::numeric as inplace_monthly,
                  (data->>'units')::int as units
           from rent_snapshots order by created_at desc`),
  ]);
  res.json({
    coa, portfolios: portfolios.rows, properties: properties.rows,
    budgets: budgets.rows, uwSnapshots: uws.rows, compSets: comps.rows,
    t12Snapshots: t12s.rows, payrollModels: payrolls.rows, rentSnapshots: rents.rows,
    curves: CURVES,   // named seasonal shapes (Jan-Dec weights) for client-side spread tools
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
  if (kind === 'payroll') {
    // importer returns property-level aggregates only — restricted individual
    // compensation never leaves the parser
    const parsed = parsePayrollModel(buf);
    return res.json({ kind, filename: req.file.originalname, payroll: parsed });
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
      const data = { units: p.units, marketMonthly: p.marketMonthly, inPlaceMonthly: p.inPlaceMonthly, occupiedUnits: p.occupiedUnits, source: p.source, leases: p.leases || null, charges: p.charges || null };
      const row = (await query(
        'insert into rent_snapshots(property_code, upload_id, as_of, data) values($1,$2,$3,$4) returning id',
        [m.propertyCode, uploadId, p.asOf ? new Date(p.asOf) : null, JSON.stringify(data)]
      )).rows[0];
      created.push({ id: row.id, propertyCode: m.propertyCode });
    }
    // opt-in: point existing budgets at the new snapshots and regenerate.
    // Inputs are untouched (GPR base stays); overrides/MROUNDs are kept by
    // buildLines — unit-level leases flip LTL to the per-lease burnoff.
    let relinked = 0;
    if (req.body?.relink) {
      for (const c of created) {
        const budgets = await query('select id from budgets where property_code=$1', [c.propertyCode]);
        for (const b of budgets.rows) {
          await query('update budgets set rent_snapshot_id=$2, updated_at=now() where id=$1', [b.id, c.id]);
          const lb = (await loadBudget(b.id))!;
          const built = buildLines(lb, lb.budget.inputs, lb.lines);
          await saveLines(b.id, built.lines);
          relinked++;
        }
      }
      if (relinked) logChange(user, 'relink budgets to new rent roll', { filename, relinked });
    }
    logChange(user, 'upload rent_roll', { filename, created });
    return res.json({ ok: true, uploadId, created, relinked });
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
  if (kind === 'payroll') {
    const p = payload.payroll;
    if (!p) return res.status(400).json({ error: 'No payroll payload' });
    // store ONLY the aggregates (uploads.payload also gets just the aggregates)
    const row = (await query(
      'insert into payroll_models(upload_id, label, data) values($1,$2,$3) returning id',
      [uploadId, name || p.label || filename || 'ND Payroll', JSON.stringify({ properties: p.properties, unmappedPositions: p.unmappedPositions, employeeRows: p.employeeRows })]
    )).rows[0];
    // opt-in: point every budget of a property the model covers at the NEW
    // model and regenerate — without this, budgets keep the stale model and a
    // re-upload changes nothing (per-budget wage adjustments in inputs.wages
    // survive: they overlay whichever model is linked)
    let relinked = 0;
    if (req.body?.relink) {
      const codes = Object.keys(p.properties || {});
      if (codes.length) {
        const budgets = await query('select id from budgets where property_code = any($1)', [codes]);
        for (const b of budgets.rows) {
          await query('update budgets set payroll_model_id=$2, updated_at=now() where id=$1', [b.id, row.id]);
          const lb = (await loadBudget(b.id))!;
          const built = buildLines(lb, lb.budget.inputs, lb.lines);
          await saveLines(b.id, built.lines);
          relinked++;
        }
      }
      if (relinked) logChange(user, 'relink budgets to new payroll model', { filename, relinked });
    }
    logChange(user, 'upload payroll model', { filename, payrollModelId: row.id });
    return res.json({ ok: true, uploadId, payrollModelId: row.id, relinked });
  }
  res.status(400).json({ error: `Unknown upload kind "${kind}"` });
}));

/* ---------------- budgets ---------------- */
interface LoadedBudget {
  budget: any; lines: BudgetLine[]; coa: CoaAccount[]; coaMap: Map<string, CoaAccount>;
  uw: UwSnapshotData | null; comps: CompWeights | null; catShapes: Record<string, Months> | null;
  payrollWages: Record<string, number> | null; leases: Lease[] | null;
  sellerUtil: SellerUtilRow[] | null; charges: Record<string, number> | null;
  sellerRows: any[] | null;
}

async function loadBudget(id: number): Promise<LoadedBudget | null> {
  const budget = (await query('select * from budgets where id=$1', [id])).rows[0];
  if (!budget) return null;
  const [lineRows, coa] = await Promise.all([
    query('select gl_code, months, driver, override, note, round from budget_lines where budget_id=$1', [id]),
    loadCoa(),
  ]);
  const lines: BudgetLine[] = lineRows.rows.map((r: any) => ({
    gl_code: r.gl_code, months: r.months as Months, driver: r.driver, override: r.override, note: r.note,
    round: Number(r.round) || 0,
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
  // seller-T12 monthly shapes + utility lines (seller GL → pcode map comes
  // from the UW book's coded T12 panel)
  let catShapes: Record<string, Months> | null = null;
  let sellerUtil: SellerUtilRow[] | null = null;
  let sellerRows: any[] | null = null;
  if (budget.t12_snapshot_id && uw?.t12?.length) {
    const t = (await query('select data from t12_snapshots where id=$1', [budget.t12_snapshot_id])).rows[0];
    if (t?.data?.rows?.length) {
      const glToPcode: Record<string, string> = {};
      const glToName: Record<string, string> = {};
      for (const r of uw.t12) { glToPcode[r.gl] = r.pcode; glToName[r.gl] = r.name; }
      catShapes = t12CategoryShapes(t.data.rows, t.data.monthCal || [], glToPcode);
      sellerUtil = (t.data.rows as any[])
        .filter((r) => glToPcode[r.gl] === '4' || glToPcode[r.gl] === '12')
        .map((r) => ({ name: r.name || glToName[r.gl] || '', months: r.months, monthCal: t.data.monthCal || [], pcode: glToPcode[r.gl] }));
      if (!sellerUtil.length) sellerUtil = null;
      sellerRows = (t.data.rows as any[]).map((r) => ({
        gl: r.gl, name: (r.name || glToName[r.gl] || '').trim(), months: r.months,
        monthCal: t.data.monthCal || [], pcode: glToPcode[r.gl] || null, total: r.total || 0,
      }));
    }
  }
  // payroll model: property-level wage aggregates for this budget's property
  let payrollWages: Record<string, number> | null = null;
  if (budget.payroll_model_id) {
    const pm = (await query('select data from payroll_models where id=$1', [budget.payroll_model_id])).rows[0];
    const wages = pm?.data?.properties?.[budget.property_code];
    if (wages && Object.keys(wages).length) payrollWages = wages;
  }
  // per-lease detail + ancillary charges from the linked rent snapshot
  let leases: Lease[] | null = null;
  let charges: Record<string, number> | null = null;
  if (budget.rent_snapshot_id) {
    const rs = (await query('select data from rent_snapshots where id=$1', [budget.rent_snapshot_id])).rows[0];
    if (Array.isArray(rs?.data?.leases) && rs.data.leases.length) leases = rs.data.leases;
    if (rs?.data?.charges && Object.keys(rs.data.charges).length) charges = rs.data.charges;
  }
  return { budget, lines, coa, coaMap: new Map(coa.map((a) => [a.code, a])), uw, comps, catShapes, payrollWages, leases, sellerUtil, charges, sellerRows };
}

async function saveLines(budgetId: number, lines: BudgetLine[]): Promise<void> {
  await tx(async (c) => {
    await c.query('delete from budget_lines where budget_id=$1', [budgetId]);
    for (const l of lines) {
      await c.query(
        'insert into budget_lines(budget_id, gl_code, months, driver, override, note, round) values($1,$2,$3,$4,$5,$6,$7)',
        [budgetId, l.gl_code, JSON.stringify(l.months), JSON.stringify(l.driver), l.override, l.note || '', l.round || 0]
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
    monthLabels: monthLabels(lb.budget.year, lb.budget.inputs?.startMonth || 1),
    kpis: kpis(monthsMap, Number(lb.budget.inputs?.capital) || 0),
    categoryTotals: categoryTotals(lb.lines, lb.coaMap),
    uw: lb.uw,
    compWeights: lb.comps?.byGl || null,
    compUnits: lb.comps?.units || null,
    compShapes: lb.comps?.glShapes || null,
    payrollWages: lb.payrollWages,
    leaseCount: lb.leases?.length || 0,
    hasSellerUtil: !!(lb.sellerUtil && lb.sellerUtil.length),
    charges: lb.charges,
    sellerT12: lb.sellerRows,
  };
}

/** Model wages + per-budget adjustments (inputs.wages) → effective wage map.
    An adjusted GL replaces the model's number; anything else keeps the model.
    Adjustments alone work too — wages are settable with no model linked. */
function effectiveWages(model: Record<string, number> | null, adj?: Record<string, number> | null): Record<string, number> | null {
  const merged: Record<string, number> = { ...(model || {}) };
  for (const [gl, v] of Object.entries(adj || {})) {
    if (v == null) continue;
    merged[gl] = r2(Number(v) || 0);
  }
  return Object.keys(merged).length ? merged : null;
}

/** Full generation pipeline: ownership-year plan (UW Year 1) → income tie
    (LTL) → NOI tie (flex). The whole 12-month window ties to UW Y1 in full. */
function buildLines(lb: LoadedBudget, inputs: BudgetInputs, existing?: BudgetLine[]): { lines: BudgetLine[] } {
  const wages = effectiveWages(lb.payrollWages, inputs.wages);
  let lines = existing
    ? regenerate(existing, lb.coa, inputs, lb.uw, lb.comps, lb.catShapes, wages, lb.leases, lb.sellerUtil, lb.charges)
    : generateLines(lb.coa, inputs, lb.uw, lb.comps, lb.catShapes, wages, lb.leases, lb.sellerUtil, lb.charges);
  // LIVE linked lines: a GL set equal to another line × weight (e.g. sewer =
  // water × 0.8) re-follows its source on every regeneration. Resolved before
  // ties (linked lines are overrides, so ties never rescale them) against the
  // source's pre-tie months; one level, no chain ordering guaranteed.
  lines = lines.map((l) => {
    const d = l.driver as any;
    if (l.override && d?.method === 'linkLine' && d.src) {
      const src = lines.find((x) => x.gl_code === d.src);
      if (src) return { ...l, months: src.months.map((v) => r2(v * (Number(d.weight) || 1))) };
    }
    return l;
  });
  // Utility recovery follows the BUDGETED cat-12 lines as they stand
  // (overrides like T12C/WAVG included) — and each reimbursement is tied to
  // its APPLICABLE utility: trash reim ← trash, gas reim ← gas, water reim ←
  // water+sewer, electric reim ← electric; the generic UTILITIES REIM takes
  // the unclaimed cat-12 remainder. Month 0 keeps the generated value (it
  // recovers the pre-start seller month).
  const recLines = lines.filter((l) => !l.override && (l.driver as any)?.method === 'recovery');
  if (recLines.length) {
    const pct = Number((recLines[0].driver as any).pct) || 0;
    const nameOf = (gl: string) => (lb.coaMap.get(gl)?.name || '').toLowerCase();
    const cat12Lines = lines.filter((l) => {
      const a = lb.coaMap.get(l.gl_code);
      return a && a.kind === 'detail' && a.pcode === '12' && a.active !== false;
    });
    const PAIRS: [RegExp, RegExp][] = [
      [/trash/, /trash|garbage|refuse/],
      [/gas/, /\bgas\b|\bgas[- ]/],
      [/water|sewer/, /water|sewer|storm/],
      [/elec/, /elec/],
    ];
    const claimed = new Set<string>();
    const baseFor = new Map<string, Months>();
    const generic: typeof recLines = [];
    for (const rl of recLines) {
      const pair = PAIRS.find(([re]) => re.test(nameOf(rl.gl_code)));
      const srcs = pair ? cat12Lines.filter((e) => pair[1].test(nameOf(e.gl_code))) : [];
      if (srcs.length) {
        const base = zero12();
        for (const s of srcs) { claimed.add(s.gl_code); s.months.forEach((v, i) => { base[i] = r2(base[i] + v); }); }
        baseFor.set(rl.gl_code, base);
      } else generic.push(rl);
    }
    if (generic.length) {
      const rem = zero12();
      for (const e of cat12Lines) if (!claimed.has(e.gl_code)) e.months.forEach((v, i) => { rem[i] = r2(rem[i] + v); });
      const tot = generic.reduce((a, l) => a + sum(l.months), 0);
      for (const rl of generic) {
        const share = tot ? sum(rl.months) / tot : 1 / generic.length;
        baseFor.set(rl.gl_code, rem.map((v) => r2(v * share)) as Months);
      }
    }
    for (const rl of recLines) {
      const base = baseFor.get(rl.gl_code);
      if (!base) continue;
      const m = rl.months.slice() as Months;
      for (let i = 1; i < 12; i++) m[i] = r2(pct * base[i - 1]);
      rl.months = m;
    }
  }
  if (lb.uw) {
    if (inputs.tieIncome !== false) lines = tieIncomeToUw(lines, lb.coaMap, lb.uw.egi, inputs.tieIncomeGl || '5003');
    if (inputs.tieNoi !== false) lines = tieNoiToUw(lines, lb.coaMap, lb.uw.noi, inputs.noiFlexPcodes || DEFAULT_NOI_FLEX);
  }
  // standing per-line MROUND re-applies as the final step (not a lock)
  lines = applyRounding(lines);
  return { lines };
}

router.post('/budgets', h(async (req, res) => {
  const { propertyCode, year, label, uwSnapshotId, compSetId, rentSnapshotId, t12SnapshotId, payrollModelId } = req.body || {};
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
    `insert into budgets(property_code, year, label, budget_type, inputs, uw_snapshot_id, comp_set_id, rent_snapshot_id, t12_snapshot_id, payroll_model_id, created_by)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [propertyCode, year, label || `${propertyCode} ${year} Budget`, 'new_acq', JSON.stringify(inputs),
     uwSnapshotId || null, compSetId || null, rentSnapshotId || null, t12SnapshotId || null, payrollModelId || null, req.session.username || '']
  )).rows[0].id;

  const lb = await loadBudget(id);
  const built = buildLines(lb!, inputs);
  await saveLines(id, built.lines);
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
  const { inputs, label, status: st, rentSnapshotId, uwSnapshotId, compSetId, t12SnapshotId, payrollModelId } = req.body || {};
  if (label != null || st != null) {
    await query('update budgets set label=coalesce($2,label), status=coalesce($3,status), updated_at=now() where id=$1', [id, label ?? null, st ?? null]);
  }
  // relink data snapshots (then regenerate below — pass inputs:{} to just relink+regen)
  if (rentSnapshotId !== undefined || uwSnapshotId !== undefined || compSetId !== undefined || t12SnapshotId !== undefined || payrollModelId !== undefined) {
    await query(
      `update budgets set
         rent_snapshot_id = case when $2::boolean then $3::int else rent_snapshot_id end,
         uw_snapshot_id   = case when $4::boolean then $5::int else uw_snapshot_id end,
         comp_set_id      = case when $6::boolean then $7::int else comp_set_id end,
         t12_snapshot_id  = case when $8::boolean then $9::int else t12_snapshot_id end,
         payroll_model_id = case when $10::boolean then $11::int else payroll_model_id end,
         updated_at = now()
       where id=$1`,
      [id, rentSnapshotId !== undefined, rentSnapshotId ?? null, uwSnapshotId !== undefined, uwSnapshotId ?? null,
       compSetId !== undefined, compSetId ?? null, t12SnapshotId !== undefined, t12SnapshotId ?? null,
       payrollModelId !== undefined, payrollModelId ?? null]
    );
    logChange(req.session.username || '', 'relink budget snapshots', { id });
  }
  if (inputs) {
    const lb2 = (await loadBudget(id))!;   // reload — snapshots may have been relinked above
    const merged: BudgetInputs = { ...lb2.budget.inputs, ...inputs };
    const built = buildLines(lb2, merged, lb2.lines);
    await query('update budgets set inputs=$2, updated_at=now() where id=$1', [id, JSON.stringify(merged)]);
    await saveLines(id, built.lines);
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
    if (existing.round && existing.round > 0) {
      existing.months = existing.months.map((v) => r2(Math.round(v / existing.round!) * existing.round!));
    }
    existing.override = true;
    // hand-editing cells on a formula line REVISES the formula, it doesn't
    // erase it — keep the driver identity and flag the revision. Only lines
    // with no formula history become plain manual.
    const prev = existing.driver || ({} as any);
    existing.driver = prev.method && prev.method !== 'manual' ? { ...prev, revised: true } : { method: 'manual' };
  }
  if (typeof override === 'boolean') existing.override = override;
  if (typeof note === 'string') existing.note = note;
  if (driver) existing.driver = driver;
  await query(
    'update budget_lines set months=$3, driver=$4, override=$5, note=$6, round=$7 where budget_id=$1 and gl_code=$2',
    [id, gl, JSON.stringify(existing.months), JSON.stringify(existing.driver), existing.override, existing.note, existing.round || 0]
  );
  await query('update budgets set updated_at=now() where id=$1', [id]);
  logChange(req.session.username || '', 'edit line', { id, gl, annual: sum(existing.months) });
  res.json(budgetView((await loadBudget(id))!));
}));

/* Undo support: restore a client-held snapshot of lines (+ inputs) verbatim —
   no regeneration, no ties; the snapshot is exactly what the user saw. */
router.post('/budgets/:id/restore', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const { lines, inputs } = req.body || {};
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines snapshot required' });
  const valid = new Set(lb.coa.map((a) => a.code));
  const restored: BudgetLine[] = [];
  for (const l of lines) {
    if (!l || !valid.has(String(l.gl_code)) || !Array.isArray(l.months) || l.months.length !== 12) continue;
    restored.push({
      gl_code: String(l.gl_code),
      months: l.months.map((v: any) => r2(Number(v) || 0)),
      driver: l.driver && typeof l.driver === 'object' ? l.driver : { method: 'manual' },
      override: !!l.override,
      note: typeof l.note === 'string' ? l.note : '',
      round: Number(l.round) || 0,
    });
  }
  if (!restored.length) return res.status(400).json({ error: 'no valid lines in snapshot' });
  if (inputs && typeof inputs === 'object') {
    await query('update budgets set inputs=$2, updated_at=now() where id=$1', [id, JSON.stringify(inputs)]);
  }
  await saveLines(id, restored);
  logChange(req.session.username || '', 'undo (restore snapshot)', { id, lines: restored.length });
  res.json(budgetView((await loadBudget(id))!));
}));

router.post('/budgets/:id/recalc', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const built = buildLines(lb, lb.budget.inputs, lb.lines);
  await saveLines(id, built.lines);
  res.json(budgetView((await loadBudget(id))!));
}));

router.post('/budgets/:id/tie-noi', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  if (!lb.uw) return res.status(400).json({ error: 'No UW snapshot linked' });
  // optional chooser: which categories flex — persisted for future ties/regens
  let flex: string[] = lb.budget.inputs?.noiFlexPcodes || DEFAULT_NOI_FLEX;
  if (Array.isArray(req.body?.flexPcodes) && req.body.flexPcodes.length) {
    flex = req.body.flexPcodes.map(String);
    await query('update budgets set inputs=$2 where id=$1', [id, JSON.stringify({ ...lb.budget.inputs, noiFlexPcodes: flex })]);
  }
  const lines = applyRounding(tieNoiToUw(lb.lines, lb.coaMap, lb.uw.noi, flex));
  await saveLines(id, lines);
  logChange(req.session.username || '', 'tie NOI to UW', { id, target: lb.uw.noi, flex });
  res.json(budgetView((await loadBudget(id))!));
}));

router.post('/budgets/:id/tie-income', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  if (!lb.uw) return res.status(400).json({ error: 'No UW snapshot linked' });
  // optional chooser: which contra-income line absorbs — persisted as the default
  let gl = lb.budget.inputs?.tieIncomeGl || '5003';
  if (typeof req.body?.gl === 'string' && req.body.gl) {
    gl = req.body.gl;
    await query('update budgets set inputs=$2 where id=$1', [id, JSON.stringify({ ...lb.budget.inputs, tieIncomeGl: gl })]);
  }
  const lines = applyRounding(tieIncomeToUw(lb.lines, lb.coaMap, lb.uw.egi, gl));
  await saveLines(id, lines);
  logChange(req.session.username || '', 'tie income to UW', { id, target: lb.uw.egi, gl });
  res.json(budgetView((await loadBudget(id))!));
}));

/* Bulk MROUND: sets a STANDING per-line rounding multiple — a modifier that
   applies immediately and re-applies after every regeneration / formula
   change. NOT a lock: lines stay live on their formulas. multiple=0 clears. */
router.post('/budgets/:id/round', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const multiple = Number(req.body?.multiple);
  const gls: string[] = Array.isArray(req.body?.gls) ? req.body.gls.map(String) : [];
  if (!Number.isFinite(multiple) || multiple < 0) return res.status(400).json({ error: 'multiple must be ≥ 0 (0 clears rounding)' });
  if (!gls.length) return res.status(400).json({ error: 'pick at least one line' });
  const glSet = new Set(gls);
  let touched = 0;
  let lines = lb.lines.map((l) => {
    if (!glSet.has(l.gl_code)) return l;
    touched++;
    return { ...l, round: multiple };
  });
  if (!touched) return res.status(400).json({ error: 'no matching lines' });
  if (multiple === 0) {
    // clearing: regenerate so non-overridden lines return to unrounded values
    await saveLines(id, lines);
    const lb2 = (await loadBudget(id))!;
    const built = buildLines(lb2, lb2.budget.inputs, lb2.lines);
    await saveLines(id, built.lines);
  } else {
    lines = applyRounding(lines);
    await saveLines(id, lines);
  }
  logChange(req.session.username || '', 'set standing MROUND', { id, multiple, lines: touched });
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
  const lines = applyRounding(rebalanceCategory(lb.lines, lb.coaMap, pcode, target));
  await saveLines(id, lines);
  logChange(req.session.username || '', 'rebalance category', { id, pcode, target });
  res.json(budgetView((await loadBudget(id))!));
}));

router.delete('/budgets/:id', requireAdmin, h(async (req, res) => {
  await query('delete from budgets where id=$1', [Number(req.params.id)]);
  logChange(req.session.username || '', 'delete budget', { id: req.params.id });
  res.json({ ok: true });
}));

/* Delete an uploaded snapshot / model. Budget links are FK 'on delete set
   null', so pointing budgets are unlinked automatically; each one is then
   regenerated so its lines stop reflecting the deleted data. */
const SNAPSHOT_KINDS: Record<string, { table: string; col: string }> = {
  uw: { table: 'uw_snapshots', col: 'uw_snapshot_id' },
  rent: { table: 'rent_snapshots', col: 'rent_snapshot_id' },
  t12: { table: 't12_snapshots', col: 't12_snapshot_id' },
  comp: { table: 'comp_sets', col: 'comp_set_id' },
  payroll: { table: 'payroll_models', col: 'payroll_model_id' },
};
/* Payroll model wage aggregates are EDITABLE — when a re-upload/repoint isn't
   the fix, edit the numbers in place; every budget linked to the model
   regenerates (line overrides are still respected by regenerate). */
router.get('/payroll-models/:id', h(async (req, res) => {
  const r = (await query('select id, label, data from payroll_models where id=$1', [Number(req.params.id)])).rows[0];
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ id: r.id, label: r.label, properties: r.data?.properties || {} });
}));
router.put('/payroll-models/:id', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  const r = (await query('select data from payroll_models where id=$1', [id])).rows[0];
  if (!r) return res.status(404).json({ error: 'Not found' });
  const { label, properties } = req.body || {};
  const data = { ...r.data };
  if (properties && typeof properties === 'object') {
    const clean: Record<string, Record<string, number>> = {};
    for (const [code, wages] of Object.entries(properties as Record<string, any>)) {
      clean[code] = {};
      for (const [gl, v] of Object.entries(wages || {})) clean[code][gl] = r2(Number(v) || 0);
    }
    data.properties = clean;
    data.editedAt = new Date().toISOString();
  }
  await query('update payroll_models set label=coalesce($2,label), data=$3 where id=$1', [id, label ?? null, JSON.stringify(data)]);
  // linkAll: point EVERY budget at this model — the recovery path when
  // budgets got detached and nothing points anywhere
  if (req.body?.linkAll) {
    await query('update budgets set payroll_model_id=$1, updated_at=now()', [id]);
  }
  const affected = (await query('select id from budgets where payroll_model_id=$1', [id])).rows.map((x: any) => x.id);
  for (const bid of affected) {
    const lb = (await loadBudget(bid))!;
    const built = buildLines(lb, lb.budget.inputs, lb.lines);
    await saveLines(bid, built.lines);
  }
  logChange(req.session.username || '', 'edit payroll model', { id, regenerated: affected.length, linkAll: !!req.body?.linkAll });
  res.json({ ok: true, regenerated: affected.length });
}));

router.delete('/uploads/data/:kind/:id', requireAdmin, h(async (req, res) => {
  const k = SNAPSHOT_KINDS[String(req.params.kind)];
  if (!k) return res.status(400).json({ error: `Unknown snapshot kind "${req.params.kind}"` });
  const id = Number(req.params.id);
  const affected = (await query(`select id, property_code from budgets where ${k.col}=$1`, [id])).rows;
  const del = await query(`delete from ${k.table} where id=$1`, [id]);
  if (!del.rowCount) return res.status(404).json({ error: 'Not found' });
  // budgets that pointed at the deleted row RE-POINT to the newest remaining
  // upload of the same kind by default (per property where applicable; for
  // payroll, the newest model that covers the property) — so deleting a stale
  // upload swaps budgets to the fresh one and keeps their payroll/rent/T12
  // formulas alive instead of reverting them to UW allocation.
  let repointed = 0;
  for (const b of affected) {
    let replacement: number | null = null;
    if (k.table === 'payroll_models') {
      const rows = await query('select id, data from payroll_models order by created_at desc');
      replacement = rows.rows.find((r: any) => r.data?.properties?.[b.property_code])?.id ?? rows.rows[0]?.id ?? null;
    } else if (k.table === 'comp_sets') {
      replacement = (await query('select id from comp_sets order by created_at desc limit 1')).rows[0]?.id ?? null;
    } else {
      replacement = (await query(`select id from ${k.table} where property_code=$1 order by created_at desc limit 1`, [b.property_code])).rows[0]?.id ?? null;
    }
    await query(`update budgets set ${k.col}=$2, updated_at=now() where id=$1`, [b.id, replacement]);
    if (replacement) repointed++;
    const lb = (await loadBudget(b.id))!;
    const built = buildLines(lb, lb.budget.inputs, lb.lines);
    await saveLines(b.id, built.lines);
  }
  logChange(req.session.username || '', `delete ${req.params.kind} snapshot`, { id, budgets: affected.length, repointed });
  res.json({ ok: true, unlinked: affected.length, repointed });
}));

/* ---------------- exports ---------------- */
router.get('/budgets/:id/export.csv', h(async (req, res) => {
  const lb = await loadBudget(Number(req.params.id));
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const start = lb.budget.inputs?.startMonth || 1;
  // an ownership-year budget uploads as calendar-year slices: ?calYear=<year|year+1>
  const calYear = Number(req.query.calYear) || lb.budget.year;
  if (calYear !== lb.budget.year && calYear !== lb.budget.year + 1) {
    return res.status(400).json({ error: `calYear must be ${lb.budget.year} or ${lb.budget.year + 1}` });
  }
  const cutoff = Math.max(0, Math.min(11, Number(req.query.cutoff) || 0));
  const sliced: BudgetLine[] = lb.lines.map((l) => ({
    ...l, months: calendarSlice(l.months, lb.budget.year, start, calYear),
  }));
  const now = new Date();
  const mmddyyyy = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}`;
  const isRevision = cutoff > 0 || (calYear === lb.budget.year && start > 1);
  const desc = String(req.query.desc || '') ||
    `${lb.budget.property_code} ${calYear} Budget ${isRevision ? 'Revision' : 'Upload'} ${mmddyyyy}`;
  const csv = buildBudgetCsv(lb.coa, sliced, {
    propertyId: lb.budget.property_code, year: calYear, description: desc, cutoffMonth: cutoff,
  });
  const fname = `${lb.budget.property_code.toUpperCase()} ${calYear} Budget ${isRevision ? 'Revision' : 'Upload'} ${mmddyyyy}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
}));

router.get('/budgets/:id/export.xlsx', h(async (req, res) => {
  const lb = await loadBudget(Number(req.params.id));
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const prop = (await query('select * from properties where code=$1', [lb.budget.property_code])).rows[0];
  let compName = '';
  if (lb.budget.comp_set_id) {
    compName = (await query('select name from comp_sets where id=$1', [lb.budget.comp_set_id])).rows[0]?.name || '';
  }
  const buf = await buildReviewWorkbook({
    propertyCode: lb.budget.property_code, propertyName: prop?.name || lb.budget.property_code,
    year: lb.budget.year, units: Number(lb.budget.inputs?.units) || prop?.units || 0,
    coa: lb.coa, lines: lb.lines, inputs: lb.budget.inputs, uw: lb.uw,
    compWeights: lb.comps?.byGl || null, compUnits: lb.comps?.units || null, compName,
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
