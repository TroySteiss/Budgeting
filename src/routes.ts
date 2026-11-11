import { rosterWagesFor, rosterCoverage, type RosterLink } from './payroll-data.js';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { query, tx } from './db.js';
import { requireAuth, requireAdmin, login, logout, status } from './auth.js';
import { parseUwBook, parseRentRoll, parseComparison, parseSellerT12, parsePayrollModel, parseReviewDraft, parseComparisonActuals, parseBudgetCsvBlocks, budgetCsvBlockText, parseMonarchStatement, parseYardiBudgetTemplate, parsePayrollTemplate, detectUploadKind, type BudgetCsvParsed } from './importers.js';
import {
  generateAnnualLines, regenerateAnnual, defaultAnnualInputs, applyY1Plan, clearY1Plan, y1Check, type Y1Plan, stmtCalendar, trailing12, annualizedFromCal,
  refFromCalendar, refColumn, ENGINE_VERSION, budgetRefLabel, formulaSetFromBudget, applyFormulaSet, summaryColumn, summaryLabels, type SummaryCol, type FormulaSet, type TemplateData, type StmtData, type AnnualSources, gprStepsForTarget, gprStepsSummary, FLAT_FEE_PROPERTIES } from '../shared/annual.js';
import { loadAnnualRules } from './annual-rules.js';
import { buildBudgetCsv, reviseBudgetCsv } from './csv-export.js';
import { buildReviewWorkbook, buildPortfolioWorkbook, type ReviewArgs } from './xlsx-export.js';
import {
  CoaAccount, BudgetLine, BudgetInputs, UwSnapshotData, CompWeights, Months,
  generateLines, regenerate, rebalanceCategory, defaultInputs, computeTieout, PCODES,
  kpis, categoryTotals, t12CategoryShapes, tieNoiToUw, tieIncomeToUw, DEFAULT_NOI_FLEX,
  calendarSlice, monthLabels, applyRounding, zero12, r2, sum, rollup, rotate12, CURVES, WAGE_GLS, type Lease, type SellerUtilRow,
  actualizeFromComparison, applyActuals, injectPreStartActuals, ownershipIndexOf, actualKey, parseActualKey, type ActualizedMonth,
  calYearOf, calMonthOf,
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
                  b.uw_snapshot_id, b.comp_set_id, b.rent_snapshot_id, b.payroll_model_id, b.t12_snapshot_id,
                  b.py_stmt_id, b.cy_budget_stmt_id, b.template_id,
                  b.inputs, p.name as property_name, p.units
           from budgets b join properties p on p.code=b.property_code order by b.updated_at desc`),
    query(`select u.id, u.property_code, u.label, u.created_at,
                  (u.data->>'noi')::numeric as noi, (u.data->>'egi')::numeric as egi, (u.data->>'units')::int as units
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
  // dashboard breakdown of each budget's CURRENT iteration: totals, ties vs
  // UW, override mix, save-point count — computed from the live lines
  const allLines = (await query('select budget_id, gl_code, months, override, driver from budget_lines')).rows;
  const spCounts = new Map((await query('select budget_id, count(*)::int as n from budget_snapshots group by 1')).rows.map((r: any) => [r.budget_id, r.n]));
  const byBudget = new Map<number, any[]>();
  for (const l of allLines) {
    if (!byBudget.has(l.budget_id)) byBudget.set(l.budget_id, []);
    byBudget.get(l.budget_id)!.push(l);
  }
  const uwById = new Map(uws.rows.map((u: any) => [u.id, u]));
  // annual budgets compare to their trailing-12 statement (or CY budget) — load the referenced statements once
  const refIds = [...new Set((budgets.rows as any[]).filter((b) => b.budget_type === 'annual').flatMap((b) => [b.py_stmt_id, b.cy_budget_stmt_id]).filter(Boolean))];
  const stmtById = new Map<number, any>();
  if (refIds.length) for (const r of (await query('select id, data from stmt_snapshots where id = any($1)', [refIds])).rows) stmtById.set(r.id, r.data);
  // every actual statement per property — the trailing-12 window is composed across them
  const actualsByProp = new Map<string, any[]>();
  if (refIds.length) for (const r of (await query(`select id, property_code, data from stmt_snapshots where kind='actual' order by created_at desc`)).rows) {
    if (!actualsByProp.has(r.property_code)) actualsByProp.set(r.property_code, []);
    actualsByProp.get(r.property_code)!.push(r);
  }
  const [stmts, templates] = await Promise.all([
    query('select id, property_code, upload_id, kind, label, period, book, created_at from stmt_snapshots order by created_at desc'),
    // each template carries the two statements parsed out of its PriorFinancials (same upload)
    query(`select t.id, t.property_code, t.upload_id, t.budget_year, t.label, t.created_at,
                  a.id as py_stmt_id, a.period as actual_period, b.id as cy_budget_stmt_id, b.period as budget_period
             from template_snapshots t
             left join lateral (select id, period from stmt_snapshots s where s.upload_id = t.upload_id and s.property_code = t.property_code and s.kind = 'actual' order by id limit 1) a on true
             left join lateral (select id, period from stmt_snapshots s where s.upload_id = t.upload_id and s.property_code = t.property_code and s.kind = 'budget' order by id limit 1) b on true
            order by t.created_at desc`),
  ]);
  for (const b of budgets.rows as any[]) {
    const ls = byBudget.get(b.id) || [];
    const monthsMap = new Map(ls.map((l: any) => [l.gl_code, l.months]));
    const k = kpis(monthsMap as any, Number(b.inputs?.capital) || 0);
    let uw: any = b.uw_snapshot_id ? uwById.get(b.uw_snapshot_id) : null;
    let refLabel = 'UW';
    if (b.budget_type === 'annual') {
      const useBudget = b.inputs?.refSource === 'budget';
      const sd = stmtById.get(useBudget ? b.cy_budget_stmt_id : b.py_stmt_id) || stmtById.get(b.py_stmt_id);
      if (sd && !(useBudget && stmtById.has(b.cy_budget_stmt_id))) {
        const own = actualsByProp.get(b.property_code) || [];
        const t12 = trailing12([sd, ...own.filter((r) => r.id !== b.py_stmt_id).map((r) => r.data)]);
        uw = t12 ? refFromCalendar(coa, t12.cal, Number(b.units) || 0) : null;
      } else uw = sd ? refFromCalendar(coa, stmtCalendar(sd), Number(b.units) || 0) : null;
      refLabel = sd ? (useBudget && stmtById.has(b.cy_budget_stmt_id) ? 'CY budget' : 'T12') : '—';
    }
    const ovF = ls.filter((l: any) => l.override && l.driver?.method && l.driver.method !== 'manual' && l.driver.method !== 'setTotal' && l.driver.method !== 'zero').length;
    const ovAll = ls.filter((l: any) => l.override).length;
    b.dash = {
      income: k.income, expense: k.expense, noi: k.noi, cashFlow: k.cashFlow, coc: k.coc,
      capital: Number(b.inputs?.capital) || 0,
      egiVar: uw?.egi != null ? r2(k.income - Number(uw.egi)) : null,
      noiVar: uw?.noi != null ? r2(k.noi - Number(uw.noi)) : null,
      overridesFormula: ovF, overridesFixed: ovAll - ovF,
      savePoints: spCounts.get(b.id) || 0,
      startMonth: Number(b.inputs?.startMonth) || 1,
      ltlMode: b.inputs?.ltl?.mode === 'ramp' ? 'ramp' : 'leases',
      refLabel,
    };
    delete b.inputs;   // keep /state light
  }
  res.json({
    coa, portfolios: portfolios.rows, properties: properties.rows,
    budgets: budgets.rows, uwSnapshots: uws.rows, compSets: comps.rows,
    t12Snapshots: t12s.rows, payrollModels: payrolls.rows, rentSnapshots: rents.rows,
    // which properties the Pay-rates tab feeds, per budget year (codes + draft flags only) — the dashboard's Payroll wages item
    rosterYears: await rosterCoverage().catch(() => ({})),
    stmtSnapshots: stmts.rows, templates: templates.rows,
    // saved formula sets (name + size only) — picked when a budget is started
    formulaSets: (await query(`select id, name, created_by, created_at, source, (select count(*)::int from jsonb_object_keys(coalesce(data->'rules','{}'::jsonb))) as rules from formula_sets order by created_at desc`)).rows,
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
  if (kind === 'statement' || kind === 'yardi_template' || kind === 'payroll_template') {
    const coa = await loadCoa();
    return res.json({ kind, files: parseAnnualFiles(kind, req.file.originalname, buf, coa) });
  }
  if (kind === 'staffing') {
    // individual pay never flows through the Data page — the Payroll tab's own
    // gated endpoint parses AND stores in one step (no roster in any response)
    return res.status(400).json({ error: 'This is a staffing report (individual pay) — load it from the Payroll tab, which sits behind the payroll sign-in.' });
  }
  res.status(400).json({ error: `Unknown upload kind "${kind}"` });
}));

/** Annual-mode data files: a Monarch 12 Month Statement / 12 Month Budget
    export, or the Yardi budget template workbook (one property each). */
function parseAnnualFiles(kind: string, filename: string, buf: Buffer, coa: CoaAccount[]): any[] {
  if (kind === 'payroll_template') {
    // one workbook may carry several property sheets; §1/§2 (individual pay) are never read
    return parsePayrollTemplate(buf).map((t) => ({ filename: `${filename} › ${t.sheet}`, statement: t, propertyGuess: t.propertyGuess }));
  }
  return [parseAnnualFile(kind, filename, buf, coa)];
}
function parseAnnualFile(kind: string, filename: string, buf: Buffer, coa: CoaAccount[]): any {
  const detail = new Set(coa.filter((a) => a.kind === 'detail').map((a) => a.code));
  if (kind === 'statement') {
    const st = parseMonarchStatement(buf, detail);
    return { filename, statement: st, propertyGuess: st.propertyGuess };
  }
  const t = parseYardiBudgetTemplate(buf, detail);
  // the parsed payload carries NO payroll roster data — that sheet is never read
  return { filename, template: t.template, actual: t.actual, budget: t.budget, skippedSheets: t.skippedSheets, propertyGuess: t.template.code };
}

/** Several annual-mode files in one go (one per property). A file that fails
    to parse is reported, not fatal. */
router.post('/uploads/parse-many', upload.array('files', 40), h(async (req, res) => {
  const kind = String(req.query.kind || req.body?.kind || '');
  const files = (req.files as Express.Multer.File[]) || [];
  if (!files.length) return res.status(400).json({ error: 'No files' });
  if (kind !== 'statement' && kind !== 'yardi_template' && kind !== 'payroll_template') return res.status(400).json({ error: `Unknown upload kind "${kind}"` });
  const coa = await loadCoa();
  const out: any[] = [];
  for (const f of files) {
    try { out.push(...parseAnnualFiles(kind, f.originalname, f.buffer, coa)); }
    catch (e: any) { out.push({ filename: f.originalname, error: e?.message || String(e) }); }
  }
  res.json({ kind, files: out });
}));

/** Guess each file's upload kind from its contents (Data page: drop any file). */
router.post('/uploads/detect', upload.array('files', 40), h(async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  if (!files.length) return res.status(400).json({ error: 'No files' });
  res.json({ files: files.map((f) => { try { return { filename: f.originalname, kind: detectUploadKind(f.buffer) }; } catch (e: any) { return { filename: f.originalname, kind: null, error: e?.message || String(e) }; } }) });
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
          await saveLines(b.id, built.lines, true);
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
          await saveLines(b.id, built.lines, true);
          relinked++;
        }
      }
      if (relinked) logChange(user, 'relink budgets to new payroll model', { filename, relinked });
    }
    logChange(user, 'upload payroll model', { filename, payrollModelId: row.id });
    return res.json({ ok: true, uploadId, payrollModelId: row.id, relinked });
  }
  if (kind === 'statement' || kind === 'yardi_template' || kind === 'payroll_template') {
    // mappings: [{index, propertyCode}] over payload.files; a property the
    // chart doesn't know yet (a non-ND site's template) is created on the fly
    const created: any[] = [];
    let relinked = 0;
    for (const m of mappings || []) {
      const f = (payload.files || [])[Number(m.index)];
      const code = String(m.propertyCode || '').toLowerCase();
      if (!f || f.error || !code) continue;
      const tplName = f.template?.name || f.statement?.label || code;
      const exists = (await query('select code, units from properties where code=$1', [code])).rows[0];
      if (kind === 'payroll_template') {
        // a tie-out reference for a property we budget: never creates a property, never relinks
        if (!exists) continue;
        const t = f.statement;
        const id = (await query(
          'insert into stmt_snapshots(property_code, upload_id, kind, label, period, book, data) values($1,$2,$3,$4,$5,$6,$7) returning id',
          [code, uploadId, 'payroll_template', `${t.label || f.filename} — payroll template ${t.year}`.trim(), t.period || '', '',
           JSON.stringify({ monthCal: t.monthCal, monthYear: t.monthYear, rows: t.rows, total: t.total, year: t.year, sheet: t.sheet })]
        )).rows[0].id;
        created.push({ propertyCode: code, payrollTemplateId: id, year: t.year });
        continue;
      }
      if (!exists) {
        await query(`insert into properties(code, name, units, market, role) values($1,$2,$3,'',$4) on conflict (code) do nothing`,
          [code, String(tplName).replace(/\s*\([^)]*\)\s*$/, ''), Number(f.template?.units) || 0, 'subject']);
      } else if (f.template?.units && !Number(exists.units)) {
        await query('update properties set units=$2 where code=$1', [code, Number(f.template.units)]);
      }
      const saveStmt = async (st: any): Promise<number> => (await query(
        'insert into stmt_snapshots(property_code, upload_id, kind, label, period, book, data) values($1,$2,$3,$4,$5,$6,$7) returning id',
        [code, uploadId, st.kind, `${st.label || f.filename} — ${st.kind === 'budget' ? 'budget' : 'actuals'} ${st.period || ''}`.trim(), st.period || '', st.book || '',
         JSON.stringify({ monthCal: st.monthCal, monthYear: st.monthYear || null, rows: st.rows })]
      )).rows[0].id;
      const ids: any = { propertyCode: code };
      if (kind === 'statement') {
        ids[f.statement.kind === 'budget' ? 'cyBudgetStmtId' : 'pyStmtId'] = await saveStmt(f.statement);
      } else {
        ids.pyStmtId = await saveStmt(f.actual);
        ids.cyBudgetStmtId = await saveStmt(f.budget);
        ids.templateId = (await query(
          'insert into template_snapshots(property_code, upload_id, budget_year, label, data) values($1,$2,$3,$4,$5) returning id',
          [code, uploadId, Number(f.template.budgetYear) || new Date().getFullYear() + 1, `${f.filename} — ${f.template.name || code} ${f.template.budgetYear || ''}`.trim(), JSON.stringify(f.template)]
        )).rows[0].id;
      }
      created.push(ids);
      // opt-in: point this property's ANNUAL budgets at the new data and regenerate (overrides kept)
      if (req.body?.relink) {
        const budgets = await query(`select id from budgets where property_code=$1 and budget_type='annual'`, [code]);
        for (const b of budgets.rows) {
          await query(
            `update budgets set py_stmt_id = coalesce($2, py_stmt_id), cy_budget_stmt_id = coalesce($3, cy_budget_stmt_id),
                                template_id = coalesce($4, template_id), updated_at = now() where id=$1`,
            [b.id, ids.pyStmtId ?? null, ids.cyBudgetStmtId ?? null, ids.templateId ?? null]
          );
          const lb = (await loadBudget(b.id))!;
          const built = buildLines(lb, lb.budget.inputs, lb.lines);
          await saveLines(b.id, built.lines, true);
          relinked++;
        }
      }
    }
    if (!created.length) return res.status(400).json({ error: 'Map at least one file to a property' });
    logChange(user, `upload ${kind}`, { filename, created, relinked });
    return res.json({ ok: true, uploadId, created, relinked });
  }
  res.status(400).json({ error: `Unknown upload kind "${kind}"` });
}));

/* ---------------- budgets ---------------- */
interface RefCol { key: string; label: string; period: string; byGl: Record<string, number>; totals: Record<string, number>;
  /** category totals (pcode → $) + EGI / TOE / NOI of this column — the tie card's comparison columns */
  cat?: { y1: Record<string, number>; egi: number; toe: number; noi: number } }
interface LoadedBudget {
  budget: any; lines: BudgetLine[]; coa: CoaAccount[]; coaMap: Map<string, CoaAccount>;
  uw: UwSnapshotData | null; comps: CompWeights | null; catShapes: Record<string, Months> | null;
  payrollWages: Record<string, number> | null; leases: Lease[] | null;
  /** the linked rent roll's as-of date (ISO) — leases ending between it and the budget start have already turned */
  rollAsOf: string | null;
  sellerUtil: SellerUtilRow[] | null; charges: Record<string, number> | null;
  savePoints?: any[];
  sellerRows: any[] | null;
  /* ---- annual (non-acquisition) mode ---- */
  annual: boolean;
  stmtActual: StmtData | null; stmtBudget: StmtData | null; template: TemplateData | null;
  actualCal: Record<string, Months> | null; budgetCal: Record<string, Months> | null; lastMonth: number; t12Missing: string[]; t12Dead: string[]; t12Startup: string[]; t12Early: string[];
  /** NOI of the T12 windows ending 2 / 1 / 0 months before the last posted month (null = not fully on file) */
  noiTrend: { back: number; label: string; noi: number | null }[]; t12End: { month: number; year: number } | null; t12Live: number;
  /** the tie-out reference (trailing-12 / CY budget / typed targets) — the annual budget's "UW" */
  ref: UwSnapshotData | null; refLabel: string;
  refs: RefCol[];
  /** the Pay-rates roster wages for this property + year (annual budgets) — the default wage source unless inputs.wageSource is 'manual' */
  rosterLink: RosterLink | null;
  /** annual: another property's statements, when the non-wage payroll ratios are borrowed from it (inputs.burdenFrom) */
  burdenSrc: { code: string; actual: Record<string, Months> | null; budget: Record<string, Months> | null; period: string; found: boolean } | null;
  /** annual: when ownership began + the acquisition budget's first-year management fee % */
  acquisition: { start: string | null; firstYearPct: number | null } | null;
  /** annual: the property's acquisition (UW Year-1) budget, when its 12 ownership months reach into this budget's year */
  y1Plan: (Y1Plan & { budgetId: number; uwNoi: number | null }) | null;
  /** the latest Payroll Budget Workbook sheet for this property + year (stmt kind 'payroll_template') — a reference, never an input */
  payrollTpl: { id: number; label: string; period: string; total: number; cal: Record<string, Months> } | null;
}

/** The tie-out reference: the UW snapshot for acquisitions, the chosen
    statement for annual budgets. */
const refOf = (lb: LoadedBudget): UwSnapshotData | null => (lb.annual ? lb.ref : lb.uw);

export async function loadBudget(id: number): Promise<LoadedBudget | null> {
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
  let rollAsOf: string | null = null;
  if (budget.rent_snapshot_id) {
    const rs = (await query('select data, as_of from rent_snapshots where id=$1', [budget.rent_snapshot_id])).rows[0];
    if (Array.isArray(rs?.data?.leases) && rs.data.leases.length) leases = rs.data.leases;
    if (rs?.data?.charges && Object.keys(rs.data.charges).length) charges = rs.data.charges;
    if (rs?.as_of) {
      const d = rs.as_of instanceof Date ? rs.as_of : new Date(rs.as_of);
      if (!isNaN(d.getTime())) rollAsOf = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  const savePoints = (await query(
    'select id, name, created_by, created_at, summary from budget_snapshots where budget_id=$1 order by created_at desc limit 50',
    [id]
  )).rows;
  const coaMap = new Map(coa.map((a) => [a.code, a]));

  /* ---- annual mode: own statements + the Yardi template ---- */
  const annual = budget.budget_type === 'annual' || budget.inputs?.mode === 'annual';
  let stmtActual: StmtData | null = null, stmtBudget: StmtData | null = null, template: TemplateData | null = null;
  let actualCal: Record<string, Months> | null = null, budgetCal: Record<string, Months> | null = null;
  let lastMonth = 10, ref: UwSnapshotData | null = null, refLabel = 'UW';
  let t12Missing: string[] = [], t12Dead: string[] = [], t12Live = 12, t12Startup: string[] = [], t12Early: string[] = [];
  const noiTrend: { back: number; label: string; noi: number | null }[] = [];
  let t12End: { month: number; year: number } | null = null;
  let payrollTpl: LoadedBudget['payrollTpl'] = null;
  // the default wage source for an annual budget: the Pay-rates tab's roster + raise entries
  // (Troy 2026-11-09). Aggregates by wage GL only; null = no cycle for the year / nobody booked here.
  // Always loaded for an annual budget; buildLines decides from the inputs it is GIVEN whether the
  // budget follows it (inputs.wageSource), so switching the source in one save works both ways.
  const rosterLink = annual ? await rosterWagesFor(String(budget.property_code), Number(budget.year)) : null;
  // payroll ratios borrowed from another property: its trailing-12 (composed from every actual
  // statement on file for it) and its latest budget statement. Property-level GL totals only.
  let burdenSrc: LoadedBudget['burdenSrc'] = null;
  const donorCode = String(budget.inputs?.burdenFrom || '').trim().toLowerCase();
  if (annual && donorCode && donorCode !== String(budget.property_code || '').toLowerCase()) {
    const rows = (await query(`select kind, data from stmt_snapshots where property_code=$1 and kind in ('actual','budget') order by created_at desc`, [donorCode])).rows as { kind: string; data: StmtData }[];
    const t = trailing12(rows.filter((r) => r.kind === 'actual').map((r) => r.data));
    const bud = rows.find((r) => r.kind === 'budget');
    burdenSrc = { code: donorCode, actual: t?.cal || null, budget: bud ? stmtCalendar(bud.data) : null, period: t?.period || '', found: !!t };
  }
  // when ownership began and the first-year management fee: the Yardi template's acquisition
  // date wins for the date; the rate comes from the property's own acquisition budget (UW Y1)
  let acquisition: { start: string | null; firstYearPct: number | null } | null = null;
  let y1Plan: LoadedBudget['y1Plan'] = null;
  if (annual) {
    const acqB = (await query(
      `select id, uw_snapshot_id, year, inputs->>'startMonth' as sm, inputs->>'mgmtPct' as pct from budgets
        where property_code=$1 and budget_type <> 'annual' and coalesce(inputs->>'mode','') <> 'annual' order by year desc, updated_at desc limit 1`, [budget.property_code]
    )).rows[0];
    const tplAcq = budget.template_id ? (await query(`select data->>'acquisitionDate' as d from template_snapshots where id=$1`, [budget.template_id])).rows[0]?.d : null;
    const start = tplAcq || (acqB ? `${acqB.year}-${String(Number(acqB.sm) || 1).padStart(2, '0')}` : null);
    const pct = acqB && Number(acqB.pct) > 0 ? Number(acqB.pct) : null;
    if (start || pct != null) acquisition = { start, firstYearPct: pct };
    // the Y1 plan itself: the months of this budget's year that are still ownership Year 1 take its amounts
    if (acqB) {
      const plan = { year: Number(acqB.year), startMonth: Number(acqB.sm) || 1 };
      if (plan.startMonth > 1 && plan.year + 1 === Number(budget.year)) {
        const pl = (await query('select gl_code, months from budget_lines where budget_id=$1', [acqB.id])).rows;
        const u = acqB.uw_snapshot_id ? (await query(`select data->>'noi' as noi from uw_snapshots where id=$1`, [acqB.uw_snapshot_id])).rows[0] : null;
        if (pl.length) y1Plan = { ...plan, budgetId: Number(acqB.id), uwNoi: u && u.noi != null && Number.isFinite(Number(u.noi)) ? Number(u.noi) : null, lines: pl.map((r: any) => ({ gl_code: r.gl_code, months: (r.months as any[]).map(Number) as Months })) };
      }
    }
  }
  const refs: RefCol[] = [];
  if (annual) {
    const stmtRows = await query('select id, kind, period, data from stmt_snapshots where id = any($1)', [[budget.py_stmt_id, budget.cy_budget_stmt_id].filter(Boolean)]);
    const sa = stmtRows.rows.find((r: any) => r.id === budget.py_stmt_id);
    const sb = stmtRows.rows.find((r: any) => r.id === budget.cy_budget_stmt_id);
    stmtActual = sa?.data || null; stmtBudget = sb?.data || null;
    if (budget.template_id) template = (await query('select data from template_snapshots where id=$1', [budget.template_id])).rows[0]?.data || null;
    // the trailing-12 window is composed across every actual statement on file
    // for the property (the linked one wins): a Jan–Dec export in November
    // carries empty Nov–Dec, and those come from last year's statement
    const t12 = stmtActual ? await composeT12(budget.property_code, budget.py_stmt_id, stmtActual, budget.inputs?.startupExclude) : null;
    actualCal = t12?.cal || null;
    t12Missing = t12?.missing || [];
    // NOI of the trailing-12 windows that ended 2, 1 and 0 months before the last posted month
    // (the Summary tab's trend columns) — only where every month of the window is on file
    if (stmtActual && t12) {
      for (const back of [2, 1, 0]) {
        const w = back === 0 ? t12 : await composeT12(budget.property_code, budget.py_stmt_id, stmtActual, budget.inputs?.startupExclude, back);
        const end = (t12.lastYear * 12 + (t12.lastMonth - 1)) - back;
        const label = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][((end % 12) + 12) % 12]}.`;
        noiTrend.push({ back, label, noi: w ? r2(refColumn(w.cal).totals['7280'] || 0) : null });
      }
      t12End = { month: t12.lastMonth, year: t12.lastYear };
    }
    t12Dead = t12?.dead || [];
    t12Startup = t12?.startup || [];
    t12Early = t12?.early || [];
    t12Live = t12?.liveMonths || 12;
    budgetCal = stmtBudget ? stmtCalendar(stmtBudget) : null;
    lastMonth = t12 ? t12.lastMonth : (template?.lastActual?.month || 10);
    const pt = (await query(
      `select id, label, period, data from stmt_snapshots where property_code=$1 and kind='payroll_template' and (data->>'year')::int = $2 order by created_at desc limit 1`,
      [budget.property_code, Number(budget.year)]
    )).rows[0];
    if (pt) {
      // calendar by GL, zero rows KEPT (a 0 on the template — 6450 allocations out — is a statement worth showing)
      const cal: Record<string, Months> = {};
      for (const r of (pt.data?.rows || []) as { gl: string; months: number[] }[]) {
        const m = zero12();
        (pt.data.monthCal as number[]).forEach((c: number, i: number) => { if (c >= 1 && c <= 12) m[c - 1] = r2(m[c - 1] + (r.months[i] || 0)); });
        cal[r.gl] = m;
      }
      payrollTpl = { id: pt.id, label: pt.label, period: pt.period, total: Number(pt.data?.total) || 0, cal };
    }
    const units = Number(budget.inputs?.units) || 0;
    const t12Label = t12 && t12.dead.length ? `T12 actuals (${t12.liveMonths} mo annualized)` : 'T12 actuals';
    if (actualCal && t12) refs.push({ key: 'actual', label: t12Label, period: t12.period || sa?.period || '', ...refColumn(actualCal) });
    // T3 annualized (Troy 2026-11-09): the last three actual months × 4, shown right after the T12
    // in the grid and on the compare card — a reference column, never an input
    if (actualCal && t12) {
      const a3 = annualizedFromCal(actualCal, t12.lastMonth, 3);
      if (Object.keys(a3).length) {
        const mo = [2, 1, 0].map((j) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(((t12.lastMonth - 1 - j) % 12) + 12) % 12]);
        const c = refFromCalendar(coa, a3, units, 'T3 annualized');
        refs.push({ key: 'ann3', label: 'T3 annualized', period: `${mo[0]}–${mo[2]} actuals × 4`, ...refColumn(a3), cat: { y1: c.y1, egi: c.egi, toe: c.toe, noi: c.noi } });
      }
    }
    if (budgetCal) refs.push({ key: 'budget', label: budgetRefLabel(sb?.period), period: sb?.period || '', ...refColumn(budgetCal) });
    if (actualCal && t12) { const a4 = annualizedFromCal(actualCal, t12.lastMonth, 4); if (Object.keys(a4).length) refs.push({ key: 'ann4', label: '4 mo annualized', period: '', ...refColumn(a4) }); }
    const src = budget.inputs?.refSource || 'actual';
    if (src === 'budget' && budgetCal) { ref = refFromCalendar(coa, budgetCal, units, 'CY budget'); refLabel = refs.find((r) => r.key === 'budget')?.label || 'CY budget'; }
    else if (actualCal) {
      ref = refFromCalendar(coa, actualCal, units, t12Label); refLabel = t12Label;
      if (src === 'target' && budget.inputs?.targets) {
        const t = budget.inputs.targets;
        if (t.egi != null) ref.egi = r2(Number(t.egi));
        if (t.noi != null) ref.noi = r2(Number(t.noi));
        ref.toe = r2(ref.egi - ref.noi);
        refLabel = 'targets';
      }
    }
    // the row tools (match a line, WAVG, T12-on-curve) take the property's OWN actuals as the source
    if (stmtActual?.rows?.length) {
      sellerRows = stmtActual.rows.map((r) => ({
        gl: r.gl, name: `${r.gl} ${(r.name || coaMap.get(r.gl)?.name || '').trim()}`, months: r.months,
        monthCal: stmtActual!.monthCal || [], pcode: coaMap.get(r.gl)?.pcode || null, total: r.total || 0,
      }));
    }
  }
  return { budget, lines, coa, coaMap, uw, comps, catShapes, payrollWages, leases, rollAsOf, sellerUtil, charges, sellerRows, savePoints, payrollTpl, rosterLink, acquisition, y1Plan, burdenSrc,
           annual, stmtActual, stmtBudget, template, actualCal, budgetCal, lastMonth, t12Missing, t12Dead, t12Live, t12Startup, t12Early, noiTrend, t12End, ref, refLabel, refs };
}

export async function saveLines(budgetId: number, lines: BudgetLine[], fullBuild = false): Promise<void> {
  await tx(async (c) => {
    await c.query('delete from budget_lines where budget_id=$1', [budgetId]);
    for (const l of lines) {
      await c.query(
        'insert into budget_lines(budget_id, gl_code, months, driver, override, note, round) values($1,$2,$3,$4,$5,$6,$7)',
        [budgetId, l.gl_code, JSON.stringify(l.months), JSON.stringify(l.driver), l.override, l.note || '', l.round || 0]
      );
    }
    await c.query('update budgets set updated_at=now() where id=$1', [budgetId]);
    // a FULL build (generate / regenerate / recalc) stamps the formula version it ran on;
    // single-line edits, restores and rounding leave the stamp alone
    if (fullBuild) await c.query('update budgets set calc_version=$2, calc_at=now() where id=$1', [budgetId, ENGINE_VERSION]);
  });
}

/** Lines as they READ and export: the stored plan with every actualized
    in-window month overlaid. budget_lines always hold the pure plan. */
function effectiveLines(lb: LoadedBudget): BudgetLine[] {
  return applyActuals(lb.lines, lb.coa, lb.budget.inputs?.actuals, Number(lb.budget.year), lb.budget.inputs?.startMonth || 1);
}

/** The Summary panel's data for one budget: the T12 column, the 4-months-annualized column and
    the budget itself, in the workbook's rows (shared/annual.ts summaryColumn). */
function summaryOf(lb: LoadedBudget, lines: BudgetLine[]) {
  const monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
  const totals = rollup(monthsMap);
  const bud = summaryColumn((c) => sum(totals.get(c) || zero12()), (g) => sum(monthsMap.get(g) || zero12()));
  const colOf = (key: string): SummaryCol | null => {
    const r = lb.refs.find((x) => x.key === key);
    return r ? summaryColumn((c) => r.totals[c] || 0, (g) => r.byGl[g] || 0) : null;
  };
  const t12 = colOf('actual');
  let t4 = colOf('ann4');
  // the workbook carries the T12's interest in the T4 column (interest is not annualized off four months)
  if (t4 && t12) t4 = { ...t4, interest: t12.interest, cashFlow: r2(t4.noi - t12.interest + t4.mtg1 + t4.mtg2) };
  const cyb = lb.refs.find((x) => x.key === 'budget');
  return {
    labels: summaryLabels(lb.t12End?.month, lb.t12End?.year, lb.budget.inputs?.summaryLabels),
    capital: Number(lb.budget.inputs?.capital) || 0,
    units: Number(lb.budget.inputs?.units) || 0,
    t12, t4, bud,
    noiTrend: lb.noiTrend,
    cyBudgetNoi: cyb ? r2(cyb.totals['7280'] || 0) : null,
    cyBudgetLabel: cyb ? cyb.label : null,
  };
}

function budgetView(lb: LoadedBudget) {
  const lines = effectiveLines(lb);
  const monthsMap = new Map(lines.map((l) => [l.gl_code, l.months]));
  const start = lb.budget.inputs?.startMonth || 1;
  const actualMonths = Object.entries((lb.budget.inputs?.actuals || {}) as Record<string, ActualizedMonth>).map(([key, a]) => {
    const { calYear, calMonth } = parseActualKey(key);
    return { key, index: ownershipIndexOf(Number(lb.budget.year), start, calYear, calMonth), ...a };
  });
  return {
    savePoints: lb.savePoints || [],
    budget: lb.budget,
    // the Summary panel (budget comps layout): T12 / T4 annualized / this budget
    summary: summaryOf(lb, lines),
    // the formula version in force now; budget.calc_version is the one this budget was last built on
    engineVersion: ENGINE_VERSION,
    lines,
    planLines: lb.lines,
    actualMonths,
    tieout: computeTieout(lines, lb.coaMap, refOf(lb)),
    monthLabels: monthLabels(lb.budget.year, start),
    kpis: kpis(monthsMap, Number(lb.budget.inputs?.capital) || 0),
    // annual: the reference's own months (T12 actuals or CY budget) for the trend chart
    refMonthly: (() => {
      if (!lb.annual) return null;
      const cal = lb.budget.inputs?.refSource === 'budget' ? lb.budgetCal : lb.actualCal;
      if (!cal) return null;
      const k = kpis(new Map(Object.entries(cal).map(([gl, m]) => [gl, rotate12(m, start)])), 0);
      return { label: lb.budget.inputs?.refSource === 'budget' ? 'CY budget' : 'T12', ...k.monthly };
    })(),
    categoryTotals: categoryTotals(lines, lb.coaMap),
    // annual: the property's own history by GL — the trailing-12 actuals and the CY budget,
    // laid on the budget's month order — for the per-GL history rows (Troy 2026-11-04)
    hist: lb.annual ? {
      t12: lb.actualCal ? { label: lb.refs.find((r) => r.key === 'actual')?.label || 'T12 actuals', period: lb.refs.find((r) => r.key === 'actual')?.period || '', cal: Object.fromEntries(Object.entries(lb.actualCal).map(([g, m]) => [g, rotate12(m, start)])) } : null,
      budget: lb.budgetCal ? { label: lb.refs.find((r) => r.key === 'budget')?.label || 'CY budget', period: lb.refs.find((r) => r.key === 'budget')?.period || '', cal: Object.fromEntries(Object.entries(lb.budgetCal).map(([g, m]) => [g, rotate12(m, start)])) } : null,
      // Seth's Payroll Budget Workbook sheet for this property/year: the payroll tie-out reference (Troy 2026-11-09)
      payroll: lb.payrollTpl ? { label: lb.payrollTpl.label, period: lb.payrollTpl.period, total: lb.payrollTpl.total, cal: Object.fromEntries(Object.entries(lb.payrollTpl.cal).map(([g, m]) => [g, rotate12(m, start)])) } : null,
    } : null,
    // the tie-out reference: UW book (acquisition) or trailing-12 / CY budget / targets (annual)
    uw: refOf(lb),
    refLabel: lb.annual ? lb.refLabel : 'UW Y1',
    annual: lb.annual,
    refs: lb.annual ? lb.refs : [],
    template: lb.template ? {
      units: lb.template.units, capital: lb.template.capital, budgetYear: lb.template.budgetYear, lastActual: lb.template.lastActual,
      leaseExpirations: lb.template.leaseExpirations, leaseGoals: lb.template.leaseGoals, renewalPct: lb.template.renewalPct,
      mgmtFee: lb.template.mgmtFee, debt: lb.template.debt, mortgage: lb.template.mortgage, distHist: lb.template.distHist,
      suggestions: lb.template.suggestions, suggestionNotes: lb.template.suggestionNotes, utilForecast: lb.template.utilForecast,
      softwareFixedMo: lb.template.softwareFixedMo, moveOuts: lb.template.moveOuts || null,
    } : null,
    lastMonth: lb.annual ? lb.lastMonth : null,
    flatFeeSite: lb.annual ? FLAT_FEE_PROPERTIES.has(String(lb.budget.property_code || '').toLowerCase()) : false,
    t12Missing: lb.annual ? lb.t12Missing : [],
    t12Dead: lb.annual ? lb.t12Dead : [],
    // new acquisition: start-up month(s) left out of the history, and months 2-3 of operations still in it
    t12Startup: lb.annual ? lb.t12Startup : [],
    t12Early: lb.annual ? lb.t12Early : [],
    t12Live: lb.annual ? lb.t12Live : 12,
    compWeights: lb.comps?.byGl || null,
    compUnits: lb.comps?.units || null,
    compShapes: lb.comps?.glShapes || null,
    payrollWages: lb.payrollWages,
    // which property the payroll ratios are borrowed from, and whether it has statements on file
    burdenSrc: lb.burdenSrc ? { code: lb.burdenSrc.code, period: lb.burdenSrc.period, found: lb.burdenSrc.found } : null,
    // ownership start + first-year management fee % on file (annual) — the Assumptions defaults
    acquisition: lb.acquisition,
    // Year-1 plan in this budget: which months it supplies and how Year 1 stands against the UW NOI
    y1Plan: lb.annual && lb.y1Plan ? { budgetId: lb.y1Plan.budgetId, year: lb.y1Plan.year, startMonth: lb.y1Plan.startMonth, on: lb.budget.inputs?.y1Plan !== false && (Number(lb.budget.inputs?.startMonth) || 1) === 1,
      ...y1Check(lb.lines, lb.y1Plan, Number(lb.budget.year), lb.y1Plan.uwNoi) } : null,
    // where the wages come from: the Pay-rates link (cycle, draft / finalized by region) or null
    rosterLink: lb.rosterLink ? { label: lb.rosterLink.label, effective: lb.rosterLink.effective, draft: lb.rosterLink.draft, regions: lb.rosterLink.regions, wages: lb.rosterLink.wages } : null,
    leaseCount: lb.leases?.length || 0,
    rollAsOf: lb.rollAsOf,
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

/** Dependent-line passes — everything computed FROM other budget lines, so it
    must re-run whenever any line changes (regenerate, recalc, AND single-line
    edits): 1) LIVE linked lines (GL = source × weight); 2) utility recovery —
    each reim recovers its APPLICABLE utility's prior-month budgeted expense
    via ordered EXCLUSIVE claims (valet→trash→sewer→water→gas→electric; each
    expense GL claimed once, no double-recovery), and the generic UTILITIES
    REIM takes ALL unclaimed cat-12 remainder (Troy: no exclusions — zero or
    deactivate a line to keep it out). Month 0 keeps the generated value (it
    recovers the pre-start seller month). */
function applyDependentPasses(lb: LoadedBudget, input: BudgetLine[], inputs?: BudgetInputs): BudgetLine[] {
  let lines = input.map((l) => {
    const d = l.driver as any;
    if (l.override && d?.method === 'linkLine' && d.src) {
      const src = input.find((x) => x.gl_code === d.src);
      if (src) return { ...l, months: src.months.map((v) => r2(v * (Number(d.weight) || 1))) as Months };
    }
    return l;
  });
  // burden (benefits/bonuses = Minot ratio × wages) follows the ACTUAL wage
  // lines as they stand — overrides, March raises, single-cell edits included
  const wagesNow = r2(WAGE_GLS.reduce((a, g) => {
    const l = lines.find((x) => x.gl_code === g);
    return a + (l ? sum(l.months) : 0);
  }, 0));
  if (wagesNow) {
    for (const l of lines) {
      const d = l.driver as any;
      if (l.override || d?.method !== 'burdenRatio' || !d.ratio) continue;
      const target = r2(Number(d.ratio) * wagesNow);
      const cur = sum(l.months);
      if (r2(cur) === target) continue;
      if (cur) l.months = l.months.map((v) => r2((v * target) / cur)) as Months;
      else l.months = Array(12).fill(r2(target / 12)) as Months;
      const drift = r2(target - sum(l.months));
      if (drift) {
        const bi = l.months.reduce((mi, v, i) => (Math.abs(v) > Math.abs(l.months[mi]) ? i : mi), 0);
        l.months[bi] = r2(l.months[bi] + drift);
      }
    }
  }
  const nameOf = (gl: string) => (lb.coaMap.get(gl)?.name || '').toLowerCase();
  // recovery candidates = EVERY active cat-4 REIM GL in the chart (not just
  // the ones the seller's income mix happened to populate) — SEWER REIM must
  // auto-claim sewer even when the old owner billed W/S together. pct comes
  // from any generated recovery line, else the budget's recovery setting.
  // 'baseline' (annual default: own history × growth) has no recovery pass
  const sellerMode = inputs?.utilities?.source !== 'uw' && inputs?.utilities?.source !== 'baseline';
  const genRec = lines.find((l) => !l.override && (l.driver as any)?.method === 'recovery');
  const pctRaw = genRec ? Number((genRec.driver as any).pct) : inputs?.utilities?.recoveryPct;
  const recLines = sellerMode && pctRaw != null && Number.isFinite(Number(pctRaw))
    ? lines.filter((l) => {
        if (l.override) return false;
        const a = lb.coaMap.get(l.gl_code);
        const n = nameOf(l.gl_code);
        // STREET REIM is not a utility recovery — never a candidate (Troy)
        return !!a && a.kind === 'detail' && a.pcode === '4' && a.active !== false && /reim/.test(n) && !/street/.test(n);
      })
    : [];
  if (recLines.length) {
    const pct = Number(pctRaw) || 0;
    const cat12Lines = lines.filter((l) => {
      const a = lb.coaMap.get(l.gl_code);
      return a && a.kind === 'detail' && a.pcode === '12' && a.active !== false;
    });
    // ordered + exclusive: sewer→SEWER REIM (always a candidate now);
    // valet→trash falls through the same way. Order prevents double-recovery.
    const CLAIMS: [RegExp, RegExp][] = [
      [/valet/, /valet/],
      [/trash/, /trash|garbage|refuse/],
      [/sewer|storm/, /sewer|storm/],
      [/water/, /water|sewer|storm/],
      // GAS REIM claims gas + COMMON-AREA electric (Troy: they bill together);
      // corp/vacant/commercial electric stays out
      [/gas/, /\bgas\b|\bgas[- ]|elec.*common\b/],
      [/\belec/, /elec/],   // a true ELECTRIC-named reim would claim what's left
    ];
    const claimed = new Set<string>();
    const assigned = new Set<string>();
    const baseFor = new Map<string, Months>();
    const srcDesc = new Map<string, string>();
    // per-budget CUSTOM mappings (inputs.recMap) claim first — explicit wins
    for (const [reimGl, srcGls] of Object.entries(inputs?.recMap || {})) {
      const rl = recLines.find((x) => x.gl_code === reimGl);
      if (!rl) continue;
      assigned.add(reimGl);
      const srcs = cat12Lines.filter((e) => (srcGls || []).includes(e.gl_code));
      if (!srcs.length) { srcDesc.set(reimGl, 'custom: nothing — zeroed'); continue; }
      const base = zero12();
      for (const s of srcs) { claimed.add(s.gl_code); s.months.forEach((v, i) => { base[i] = r2(base[i] + v); }); }
      baseFor.set(reimGl, base);
      srcDesc.set(reimGl, srcs.map((s) => s.gl_code).join('+') + ' (custom)');
    }
    for (const [rre, ere] of CLAIMS) {
      for (const rl of recLines) {
        if (assigned.has(rl.gl_code) || !rre.test(nameOf(rl.gl_code))) continue;
        const srcs = cat12Lines.filter((e) => !claimed.has(e.gl_code) && ere.test(nameOf(e.gl_code)));
        if (!srcs.length) continue;
        const base = zero12();
        for (const s of srcs) { claimed.add(s.gl_code); s.months.forEach((v, i) => { base[i] = r2(base[i] + v); }); }
        baseFor.set(rl.gl_code, base);
        srcDesc.set(rl.gl_code, srcs.map((s) => s.gl_code).join('+'));
        assigned.add(rl.gl_code);
      }
    }
    // Unmatched reims (incl. the generic UTILITIES REIM) do NOT sweep the
    // unclaimed remainder — Troy: no grabbing by default. They ZERO out;
    // assign one explicitly via '= line × weight' or a manual entry.
    // Month 0 recovers the pre-close month, which isn't budgeted — use the
    // claimed categories' OWN month-0 billing as its proxy (the old behavior
    // recovered a share of the seller's TOTAL billing there, which jacked up
    // month 1 once the rest of the row went per-category).
    for (const rl of recLines) {
      const base = baseFor.get(rl.gl_code);
      const wasRec = (rl.driver as any)?.method === 'recovery' || !!(rl.driver as any)?.src;
      if (!base) {
        // unmatched: zero a line the pass has ever driven; leave a never-used
        // reim GL completely untouched (no phantom REC chips on dead rows)
        if (wasRec || rl.months.some((v) => v)) {
          rl.months = zero12();
          rl.driver = { method: 'recovery', pct, src: 'no matched utility — zeroed (map it via “Edit what this reim recovers”)' } as any;
        }
        continue;
      }
      const m = zero12();
      m[0] = r2(pct * base[0]);
      for (let i = 1; i < 12; i++) m[i] = r2(pct * base[i - 1]);
      rl.months = m;
      // ALWAYS a proper recovery driver — chart-level reims the seller never
      // used were keeping their seeded 'manual' driver and showed NO formula
      rl.driver = { method: 'recovery', pct, src: srcDesc.get(rl.gl_code) || '' } as any;
    }
  }
  return lines;
}

/** Full generation pipeline: ownership-year plan (UW Year 1) → income tie
    (LTL) → NOI tie (flex). The whole 12-month window ties to UW Y1 in full. */
export function buildLines(lb: LoadedBudget, inputs: BudgetInputs, existing?: BudgetLine[]): { lines: BudgetLine[] } {
  // Wages: the live Pay-rates roster when the budget follows it (the annual default) — it
  // replaces the payroll model, and supersedes a snapshot an earlier Apply left in
  // inputs.wages (wagesFromRoster); a wage typed on the budget itself still wins.
  const live = lb.annual && inputs.wageSource !== 'manual' ? lb.rosterLink : null;
  const wages = live
    ? effectiveWages(live.wages, inputs.wagesFromRoster === true ? null : inputs.wages)
    : effectiveWages(lb.payrollWages, inputs.wages);
  let lines: BudgetLine[];
  if (lb.annual) {
    // ANNUAL: the property's own statements + the Yardi template rules (shared/annual.ts)
    const src: AnnualSources = { actual: lb.actualCal, budget: lb.budgetCal, lastMonth: lb.lastMonth, template: lb.template, rules: (inputs.rules as any) ?? loadAnnualRules(), comps: lb.comps, payrollWages: wages, wagesLive: live ? { label: live.label, effective: live.effective, draft: live.draft, monthly: live.monthly as Record<string, Months> } : null, leases: lb.leases, rollAsOf: lb.rollAsOf, charges: lb.charges, propertyCode: lb.budget.property_code, acquisition: lb.acquisition,
      burdenSrc: lb.burdenSrc && lb.burdenSrc.found && String(inputs.burdenFrom || '').toLowerCase() === lb.burdenSrc.code ? { code: lb.burdenSrc.code, actual: lb.burdenSrc.actual, budget: lb.burdenSrc.budget } : null };
    lines = existing ? regenerateAnnual(existing, lb.coa, inputs, src) : generateAnnualLines(lb.coa, inputs, src);
  } else {
    lines = existing
      ? regenerate(existing, lb.coa, inputs, lb.uw, lb.comps, lb.catShapes, wages, lb.leases, lb.sellerUtil, lb.charges, lb.rollAsOf)
      : generateLines(lb.coa, inputs, lb.uw, lb.comps, lb.catShapes, wages, lb.leases, lb.sellerUtil, lb.charges, lb.rollAsOf);
  }
  // YEAR-1 PLAN: the months still inside ownership Year 1 take the acquisition budget's amounts on every
  // line that feeds NOI. Once before the dependent passes (so fees / recoveries in the months after read
  // the right bases) and once after everything else (so those months end exactly on the plan).
  const y1 = lb.annual && lb.y1Plan && inputs.y1Plan !== false && (Number(inputs.startMonth) || 1) === 1 ? lb.y1Plan : null;
  if (lb.annual) lines = clearY1Plan(lines);
  if (y1) lines = applyY1Plan(lines, lb.coa, y1, Number(inputs.year));
  lines = applyDependentPasses(lb, lines, inputs);
  const ref = refOf(lb);
  if (ref) {
    // annual budgets never tie unless asked (defaults false in defaultAnnualInputs)
    if (inputs.tieIncome !== false && !(lb.annual && inputs.tieIncome !== true)) lines = tieIncomeToUw(lines, lb.coaMap, ref.egi, inputs.tieIncomeGl || '5003');
    if (inputs.tieNoi !== false && !(lb.annual && inputs.tieNoi !== true)) lines = tieNoiToUw(lines, lb.coaMap, ref.noi, inputs.noiFlexPcodes || DEFAULT_NOI_FLEX, inputs.noiFlexFormulas === true);
  }
  // standing per-line MROUND re-applies as the final step (not a lock)
  lines = applyRounding(lines);
  if (y1) lines = applyY1Plan(lines, lb.coa, y1, Number(inputs.year));
  return { lines };
}

/** The property's trailing-12 window across all of its actual statements, the linked one first. */
async function composeT12(propertyCode: string, preferredId: number | null, preferred: StmtData, excludeStartup?: number, back = 0) {
  const others = (await query(`select id, data from stmt_snapshots where property_code=$1 and kind='actual' and id <> coalesce($2, -1) order by created_at desc`, [propertyCode, preferredId])).rows;
  return trailing12([preferred, ...others.map((r: any) => r.data as StmtData)], { ...(excludeStartup != null ? { excludeStartup: Number(excludeStartup) } : {}), back });
}

/** The actuals + budget statements parsed out of a Yardi template's PriorFinancials (same upload). */
async function stmtsForTemplate(templateId: number): Promise<{ pyStmtId: number | null; cyBudgetStmtId: number | null }> {
  const t = (await query('select upload_id, property_code from template_snapshots where id=$1', [templateId])).rows[0];
  if (!t) return { pyStmtId: null, cyBudgetStmtId: null };
  const rows = (await query('select id, kind from stmt_snapshots where upload_id=$1 and property_code=$2 order by id', [t.upload_id, t.property_code])).rows;
  return { pyStmtId: rows.find((r) => r.kind === 'actual')?.id ?? null, cyBudgetStmtId: rows.find((r) => r.kind === 'budget')?.id ?? null };
}

router.post('/budgets', h(async (req, res) => {
  let { propertyCode, year, label, uwSnapshotId, compSetId, rentSnapshotId, t12SnapshotId, payrollModelId, budgetType, pyStmtId, cyBudgetStmtId, templateId, formulaSet } = req.body || {};
  if (!propertyCode || !year) return res.status(400).json({ error: 'propertyCode and year are required' });
  // the Yardi template carries its own trailing-12 + current-year budget — fill
  // those in from the template unless the caller pointed at other statements
  if (budgetType === 'annual' && templateId && (!pyStmtId || !cyBudgetStmtId)) {
    const sib = await stmtsForTemplate(Number(templateId));
    pyStmtId = pyStmtId || sib.pyStmtId; cyBudgetStmtId = cyBudgetStmtId || sib.cyBudgetStmtId;
  }
  const prop = (await query('select * from properties where code=$1', [propertyCode])).rows[0];
  if (!prop) return res.status(400).json({ error: `Unknown property ${propertyCode}` });
  const annual = budgetType === 'annual';

  let uw: UwSnapshotData | null = null;
  if (!annual && uwSnapshotId) uw = ((await query('select data from uw_snapshots where id=$1', [uwSnapshotId])).rows[0]?.data as UwSnapshotData) || null;
  let rent: { marketMonthly: number; inPlaceMonthly: number; gapMonthly?: number } | null = null;
  if (rentSnapshotId) {
    const r = (await query('select data from rent_snapshots where id=$1', [rentSnapshotId])).rows[0];
    if (r) {
      rent = { marketMonthly: Number(r.data.marketMonthly) || 0, inPlaceMonthly: Number(r.data.inPlaceMonthly) || 0 };
      // unit-level roll: the loss to lease is the occupied units' market − rent
      const ls: any[] = Array.isArray(r.data.leases) ? r.data.leases : [];
      if (ls.length) rent.gapMonthly = r2(ls.reduce((a, l) => a + (Number(l.m) || 0) - (Number(l.r) || 0), 0));
    }
  }

  let inputs: BudgetInputs;
  if (annual) {
    // defaults from the property's own trailing-12 + the Yardi template (when linked)
    const coa = await loadCoa();
    const sa = pyStmtId ? (await query('select data from stmt_snapshots where id=$1', [pyStmtId])).rows[0]?.data as StmtData | undefined : undefined;
    const tpl = templateId ? (await query('select data from template_snapshots where id=$1', [templateId])).rows[0]?.data as TemplateData | undefined : undefined;
    const t12 = sa ? await composeT12(propertyCode, Number(pyStmtId), sa) : null;
    inputs = defaultAnnualInputs(Number(year), Number(prop.units) || tpl?.units || 0, t12?.cal || null, rent, coa, tpl || null, t12 ? t12.lastMonth : tpl?.lastActual?.month);
    // the formula set the user PICKED for this budget (never a silent default)
    if (formulaSet != null && formulaSet !== '') inputs = await withFormulaSet(inputs, formulaSet);
  } else inputs = uw
    ? { ...defaultInputs(Number(year), uw, rent), units: uw.units || prop.units }
    : {
        year: Number(year), units: prop.units, capital: 0, loan: 0, rate: 0.06, startMonth: 1,
        gpr: { baseMonthly: rent ? rent.marketMonthly : 0, growthPct: zero12() },
        ltl: { startMonthly: rent ? -Math.max(0, r2(rent.marketMonthly - rent.inPlaceMonthly)) : 0, targetPct: 0.02, rampMonths: 12 },
        vacancyPct: Array(12).fill(0.05) as Months,
        concessionPct: 0.005, rentalLossPct: 0.07, mgmtPct: 0.04, uwAbs: {},
      };

  const id = (await query(
    `insert into budgets(property_code, year, label, budget_type, inputs, uw_snapshot_id, comp_set_id, rent_snapshot_id, t12_snapshot_id, payroll_model_id, created_by,
                         py_stmt_id, cy_budget_stmt_id, template_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [propertyCode, year, label || `${propertyCode} ${year} ${annual ? 'Annual ' : ''}Budget`, annual ? 'annual' : 'new_acq', JSON.stringify(inputs),
     annual ? null : (uwSnapshotId || null), compSetId || null, rentSnapshotId || null, annual ? null : (t12SnapshotId || null), payrollModelId || null, req.session.username || '',
     annual ? (pyStmtId || null) : null, annual ? (cyBudgetStmtId || null) : null, annual ? (templateId || null) : null]
  )).rows[0].id;

  const lb = await loadBudget(id);
  const built = buildLines(lb!, inputs);
  await saveLines(id, built.lines, true);
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
  let { inputs, label, status: st, rentSnapshotId, uwSnapshotId, compSetId, t12SnapshotId, payrollModelId, pyStmtId, cyBudgetStmtId, templateId } = req.body || {};
  // re-pointing at a template also re-points at the statements it carries (unless given explicitly)
  if (templateId && (pyStmtId === undefined || cyBudgetStmtId === undefined)) {
    const sib = await stmtsForTemplate(Number(templateId));
    if (pyStmtId === undefined && sib.pyStmtId) pyStmtId = sib.pyStmtId;
    if (cyBudgetStmtId === undefined && sib.cyBudgetStmtId) cyBudgetStmtId = sib.cyBudgetStmtId;
  }
  if (label != null || st != null) {
    await query('update budgets set label=coalesce($2,label), status=coalesce($3,status), updated_at=now() where id=$1', [id, label ?? null, st ?? null]);
  }
  if (pyStmtId !== undefined || cyBudgetStmtId !== undefined || templateId !== undefined) {
    await query(
      `update budgets set
         py_stmt_id        = case when $2::boolean then $3::int else py_stmt_id end,
         cy_budget_stmt_id = case when $4::boolean then $5::int else cy_budget_stmt_id end,
         template_id       = case when $6::boolean then $7::int else template_id end,
         updated_at = now()
       where id=$1`,
      [id, pyStmtId !== undefined, pyStmtId ?? null, cyBudgetStmtId !== undefined, cyBudgetStmtId ?? null, templateId !== undefined, templateId ?? null]
    );
    logChange(req.session.username || '', 'relink annual data', { id });
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
    const lb1 = (await loadBudget(id))!;   // reload — snapshots may have been relinked above
    const merged: BudgetInputs = { ...lb1.budget.inputs, ...inputs };
    // save the inputs FIRST and load again: some inputs change what is loaded (the start-up
    // months left out of the trailing-12), so the build must see the data as those inputs give it
    await query('update budgets set inputs=$2, updated_at=now() where id=$1', [id, JSON.stringify(merged)]);
    const lb2 = (await loadBudget(id))!;
    const built = buildLines(lb2, merged, lb2.lines);
    await saveLines(id, built.lines, true);
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
    const next = months.map((v: any) => r2(Number(v) || 0)) as Months;
    // The client edits the EFFECTIVE line (plan + actualized overlay). Work out
    // which months really changed against what it was shown.
    const acts: Record<string, ActualizedMonth> = lb.budget.inputs?.actuals || {};
    const actIdx = new Map<number, string>();
    for (const key of Object.keys(acts)) {
      const { calYear, calMonth } = parseActualKey(key);
      const ai = ownershipIndexOf(Number(lb.budget.year), lb.budget.inputs?.startMonth || 1, calYear, calMonth);
      if (ai >= 0) actIdx.set(ai, key);
    }
    const shown = effectiveLines(lb).find((l) => l.gl_code === gl)?.months || existing.months;
    const changed = next.map((v, i) => (Math.abs(v - (shown[i] || 0)) >= 0.005 ? i : -1)).filter((i) => i >= 0);
    if (changed.length && changed.every((i) => actIdx.has(i))) {
      // edit inside a locked month = correcting the POSTED figure. Store it on
      // the actualized month; the plan line keeps its formula, no override.
      for (const i of changed) {
        const a = acts[actIdx.get(i)!];
        if (next[i]) a.glMonths[gl] = next[i]; else delete a.glMonths[gl];
      }
      const inputs2 = { ...lb.budget.inputs, actuals: acts };
      await query('update budgets set inputs=$2, updated_at=now() where id=$1', [id, JSON.stringify(inputs2)]);
      if (typeof note === 'string') {
        existing.note = note;
        await query('update budget_lines set note=$3 where budget_id=$1 and gl_code=$2', [id, gl, existing.note]);
      }
      logChange(req.session.username || '', 'edit actualized month', { id, gl, months: changed });
      return res.json(budgetView((await loadBudget(id))!));
    }
    // plan edit: a locked month's shown value must not leak into the plan
    // unless the tool deliberately rewrote every month (flat fill etc.)
    const touchesActual = changed.some((i) => actIdx.has(i));
    existing.months = next.map((v, i) => (actIdx.has(i) && !touchesActual ? existing.months[i] : v)) as Months;
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
  // dependent lines (linked lines, utility recovery) re-follow the edit
  // IMMEDIATELY — dropping sewer from 40,000 to 100 must drop SEWER REIM now,
  // not at the next recalc
  const before = new Map(
    lb.lines
      .filter((l) => { const m2 = (l.driver as any)?.method; return m2 === 'recovery' || m2 === 'linkLine' || m2 === 'burdenRatio'; })
      .map((l) => [l.gl_code, JSON.stringify(l.months) + '|' + JSON.stringify(l.driver)])
  );
  if (before.size) {
    const passed = applyDependentPasses(lb, lb.lines, lb.budget.inputs);
    for (const l of passed) {
      const b4 = before.get(l.gl_code);
      if (b4 === undefined) continue;
      if (l.round && l.round > 0) l.months = l.months.map((v) => r2(Math.round(v / l.round!) * l.round!)) as Months;
      if (JSON.stringify(l.months) + '|' + JSON.stringify(l.driver) === b4) continue;
      await query(
        'update budget_lines set months=$3, driver=$4 where budget_id=$1 and gl_code=$2',
        [id, l.gl_code, JSON.stringify(l.months), JSON.stringify(l.driver)]
      );
    }
  }
  await query('update budgets set updated_at=now() where id=$1', [id]);
  logChange(req.session.username || '', 'edit line', { id, gl, annual: sum(existing.months) });
  res.json(budgetView((await loadBudget(id))!));
}));

/* ---------------- save points (persisted iterations) ---------------- */

function snapshotSummary(lb: LoadedBudget): Record<string, number> {
  const monthsMap = new Map(lb.lines.map((l) => [l.gl_code, l.months]));
  const k = kpis(monthsMap, Number(lb.budget.inputs?.capital) || 0);
  return { income: k.income, expense: k.expense, noi: k.noi, cashFlow: k.cashFlow,
           overrides: lb.lines.filter((l) => l.override).length };
}

async function captureSnapshot(lb: LoadedBudget, name: string, user: string): Promise<number> {
  const row = (await query(
    'insert into budget_snapshots(budget_id, name, created_by, inputs, lines, summary) values($1,$2,$3,$4,$5,$6) returning id',
    [lb.budget.id, name, user, JSON.stringify(lb.budget.inputs), JSON.stringify(lb.lines), JSON.stringify(snapshotSummary(lb))]
  )).rows[0];
  return row.id;
}

router.post('/budgets/:id/snapshots', h(async (req, res) => {
  const lb = await loadBudget(Number(req.params.id));
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body?.name || '').trim() || `Save point ${new Date().toLocaleString()}`;
  const sid = await captureSnapshot(lb, name, req.session.username || '');
  logChange(req.session.username || '', 'save point', { id: lb.budget.id, sid, name });
  res.json(budgetView((await loadBudget(lb.budget.id))!));
}));

router.post('/budgets/:id/snapshots/:sid/restore', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const snap = (await query('select * from budget_snapshots where id=$1 and budget_id=$2', [Number(req.params.sid), id])).rows[0];
  if (!snap) return res.status(404).json({ error: 'Save point not found' });
  // safety: capture the CURRENT state before rolling back
  await captureSnapshot(lb, `before restoring “${snap.name}”`, req.session.username || '');
  await query('update budgets set inputs=$2, updated_at=now() where id=$1', [id, JSON.stringify(snap.inputs)]);
  await saveLines(id, snap.lines as BudgetLine[]);
  logChange(req.session.username || '', 'restore save point', { id, sid: snap.id, name: snap.name });
  res.json(budgetView((await loadBudget(id))!));
}));

router.delete('/budgets/:id/snapshots/:sid', h(async (req, res) => {
  await query('delete from budget_snapshots where id=$1 and budget_id=$2', [Number(req.params.sid), Number(req.params.id)]);
  res.json(budgetView((await loadBudget(Number(req.params.id)))!));
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
  // the restored lines were built on whatever formula version the snapshot carried (unknown for
  // older snapshots) — never leave the stamp of the calculation that was just undone
  await query('update budgets set calc_version=$2 where id=$1', [id, typeof req.body?.calcVersion === 'string' ? req.body.calcVersion : null]);
  logChange(req.session.username || '', 'undo (restore snapshot)', { id, lines: restored.length });
  res.json(budgetView((await loadBudget(id))!));
}));

router.post('/budgets/:id/recalc', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const built = buildLines(lb, lb.budget.inputs, lb.lines);
  await saveLines(id, built.lines, true);
  res.json(budgetView((await loadBudget(id))!));
}));

/* ---------------- saved formula sets ----------------
   A named recipe saved from a budget (formulaSetFromBudget) and given to another one. */
async function withFormulaSet(inputs: BudgetInputs, pick: any): Promise<BudgetInputs> {
  if (pick === 'template') return applyFormulaSet(inputs, { rules: {}, settings: {} }, { id: null, name: 'Template defaults (no saved set)' });
  if (pick === 'grks') return applyFormulaSet(inputs, { rules: loadAnnualRules() as any, settings: {} }, { id: 'grks', name: 'GRKS 2026 draft (the old default)' });
  const row = (await query('select id, name, data from formula_sets where id=$1', [Number(pick)])).rows[0];
  if (!row) throw new Error('That formula set no longer exists');
  return applyFormulaSet(inputs, row.data as FormulaSet, { id: row.id, name: row.name });
}
router.get('/formula-sets', h(async (_req, res) => {
  res.json((await query(`select id, name, created_by, created_at, source, (select count(*)::int from jsonb_object_keys(coalesce(data->'rules','{}'::jsonb))) as rules from formula_sets order by created_at desc`)).rows);
}));
router.post('/formula-sets', h(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const lb = await loadBudget(Number(req.body?.budgetId));
  if (!name) return res.status(400).json({ error: 'Give the formula set a name' });
  if (!lb || !lb.annual) return res.status(400).json({ error: 'Formula sets are saved from an annual budget' });
  const set = formulaSetFromBudget(lb.lines, lb.budget.inputs || {});
  const source = `${lb.budget.property_code} ${lb.budget.year}`;
  const exists = (await query('select id from formula_sets where lower(name)=lower($1)', [name])).rows[0];
  if (exists && !req.body?.overwrite) return res.status(409).json({ error: `A formula set named "${name}" already exists`, exists: true });
  const row = exists
    ? (await query('update formula_sets set data=$2, source=$3, created_by=$4, created_at=now() where id=$1 returning id, name', [exists.id, JSON.stringify(set), source, req.session.username || ''])).rows[0]
    : (await query('insert into formula_sets(name, data, source, created_by) values($1,$2,$3,$4) returning id, name', [name, JSON.stringify(set), source, req.session.username || ''])).rows[0];
  logChange(req.session.username || '', 'save formula set', { id: row.id, name, from: source, rules: Object.keys(set.rules).length });
  res.json({ ok: true, id: row.id, name: row.name, rules: Object.keys(set.rules).length });
}));
router.delete('/formula-sets/:id', requireAdmin, h(async (req, res) => {
  await query('delete from formula_sets where id=$1', [Number(req.params.id)]);
  logChange(req.session.username || '', 'delete formula set', { id: Number(req.params.id) });
  res.json({ ok: true });
}));
/* Give an existing budget a saved formula set and regenerate. Overrides, dollars, GPR, the
   vacancy average and expirations stay; the budget's own per-GL shape / factor choices are
   replaced by the set's. */
router.post('/budgets/:id/formula-set', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  if (!lb.annual) return res.status(400).json({ error: 'Formula sets apply to annual budgets' });
  const inputs = await withFormulaSet(lb.budget.inputs || {}, req.body?.formulaSet);
  const built = buildLines({ ...lb, budget: { ...lb.budget, inputs } }, inputs, lb.lines);
  await query('update budgets set inputs=$2, updated_at=now() where id=$1', [id, JSON.stringify(inputs)]);
  await saveLines(id, built.lines, true);
  logChange(req.session.username || '', 'apply formula set', { id, set: inputs.rulesFrom });
  res.json(budgetView((await loadBudget(id))!));
}));

/* ---------------- Summary tab + panel headers ----------------
   GET /summary?year= : every property's latest budget for the year, with its summary columns —
   the "Schedule" table and the per-region "Avg." panel are assembled on the client. */
router.get('/summary', h(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear() + 1;
  const rows = (await query(
    `select distinct on (b.property_code) b.id, b.property_code, b.budget_type, b.status, b.updated_at, p.name, p.market, p.units
       from budgets b join properties p on p.code = b.property_code
      where b.year = $1 order by b.property_code, b.updated_at desc`, [year])).rows as any[];
  const out: any[] = [];
  for (const r of rows) {
    const lb = await loadBudget(r.id);
    if (!lb) continue;
    out.push({ id: r.id, code: r.property_code, name: r.name, region: String(r.market || '').trim() || 'Other', type: r.budget_type, status: r.status, updatedAt: r.updated_at,
               stale: lb.budget.calc_version !== ENGINE_VERSION, ...summaryOf(lb, effectiveLines(lb)), units: Number(lb.budget.inputs?.units) || Number(r.units) || 0 });
  }
  const years = (await query('select distinct year from budgets order by year desc')).rows.map((x: any) => Number(x.year));
  res.json({ year, years, properties: out });
}));
/* Rename the Summary panel's column headers ("Nov. 23 T12" …) — no recalculation. */
router.post('/budgets/:id/summary-labels', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const cur = { ...((lb.budget.inputs?.summaryLabels as any) || {}) };
  for (const k of ['t12', 't4', 'draft'] as const) {
    if (req.body?.[k] === undefined) continue;
    const v = String(req.body[k] || '').trim().slice(0, 40);
    if (v) cur[k] = v; else delete cur[k];
  }
  const inputs = { ...(lb.budget.inputs || {}), summaryLabels: Object.keys(cur).length ? cur : null };
  await query('update budgets set inputs=$2 where id=$1', [id, JSON.stringify(inputs)]);
  res.json(budgetView((await loadBudget(id))!));
}));

/* Sign-off on the defaults a budget is running on (Troy 2026-11-09, devil's advocate #4):
   records who reviewed them and a fingerprint of what they were, WITHOUT regenerating —
   the editor shows "changed since reviewed" when the fingerprint no longer matches. */
router.post('/budgets/:id/ack-defaults', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const hash = String(req.body?.hash || '').slice(0, 4000);
  const ack = req.body?.clear ? null : { by: req.session.username || '', at: new Date().toISOString(), hash };
  const inputs = { ...(lb.budget.inputs || {}), defaultsAck: ack };
  await query('update budgets set inputs=$2 where id=$1', [id, JSON.stringify(inputs)]);
  logChange(req.session.username || '', ack ? 'review budget defaults' : 'clear defaults review', { id });
  res.json(budgetView((await loadBudget(id))!));
}));

router.post('/budgets/:id/tie-noi', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const ref = refOf(lb);
  if (!ref) return res.status(400).json({ error: lb.annual ? 'No statement linked to compare to' : 'No UW snapshot linked' });
  // optional chooser: which categories flex — persisted for future ties/regens
  let flex: string[] = lb.budget.inputs?.noiFlexPcodes || DEFAULT_NOI_FLEX;
  let inclFormulas: boolean = lb.budget.inputs?.noiFlexFormulas === true;
  if (typeof req.body?.includeFormulas === 'boolean') inclFormulas = req.body.includeFormulas;
  if ((Array.isArray(req.body?.flexPcodes) && req.body.flexPcodes.length) || typeof req.body?.includeFormulas === 'boolean') {
    if (Array.isArray(req.body?.flexPcodes) && req.body.flexPcodes.length) flex = req.body.flexPcodes.map(String);
    await query('update budgets set inputs=$2 where id=$1', [id, JSON.stringify({ ...lb.budget.inputs, noiFlexPcodes: flex, noiFlexFormulas: inclFormulas })]);
  }
  const lines = applyRounding(tieNoiToUw(lb.lines, lb.coaMap, ref.noi, flex, inclFormulas));
  await saveLines(id, lines);
  logChange(req.session.username || '', `tie NOI to ${lb.refLabel}`, { id, target: ref.noi, flex });
  res.json(budgetView((await loadBudget(id))!));
}));

router.post('/budgets/:id/tie-income', h(async (req, res) => {
  const id = Number(req.params.id);
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const ref = refOf(lb);
  if (!ref) return res.status(400).json({ error: lb.annual ? 'No statement linked to compare to' : 'No UW snapshot linked' });
  // optional chooser: which contra-income line absorbs — persisted as the default
  let gl = lb.budget.inputs?.tieIncomeGl || '5003';
  if (typeof req.body?.gl === 'string' && req.body.gl) {
    gl = req.body.gl;
    await query('update budgets set inputs=$2 where id=$1', [id, JSON.stringify({ ...lb.budget.inputs, tieIncomeGl: gl })]);
  }
  const lines = applyRounding(tieIncomeToUw(lb.lines, lb.coaMap, ref.egi, gl));
  await saveLines(id, lines);
  logChange(req.session.username || '', `tie income to ${lb.refLabel}`, { id, target: ref.egi, gl });
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
    await saveLines(id, built.lines, true);
  } else {
    lines = applyRounding(lines);
    await saveLines(id, lines);
  }
  logChange(req.session.username || '', 'set standing MROUND', { id, multiple, lines: touched });
  res.json(budgetView((await loadBudget(id))!));
}));

/* ANNUAL growth-target tie. Troy: nothing derives from an underwriting — each
   subtotal gets a growth % vs the reference (T12 / CY budget) and "tie" moves
   the growth FACTORS of that subtotal's T12-based lines (uniform shift) until
   the subtotal lands on reference × (1 + target). GPR solves the uniform
   monthly % instead; a subtotal with no factor-driven lines falls back to a
   proportional rebalance. 'opex' spreads over every expense category but the
   management fee; 'noi' sets the opex total that yields the NOI target. */
const GROWTH_EXPENSE_PCODES = ['6', '8', '9', '10', '11', '12', '13', '14'];
router.post('/budgets/:id/tie-growth', h(async (req, res) => {
  const id = Number(req.params.id);
  const key = String(req.body?.pcode || '');
  const lb = await loadBudget(id);
  if (!lb) return res.status(404).json({ error: 'Not found' });
  if (!lb.annual) return res.status(400).json({ error: 'Growth targets are for annual budgets' });
  const ref = refOf(lb);
  if (!ref) return res.status(400).json({ error: 'No statement linked to compare to' });
  const inputs: BudgetInputs = JSON.parse(JSON.stringify(lb.budget.inputs));
  const targets = { ...(inputs.growthTargets || {}) };
  const pct = req.body?.pct != null && req.body.pct !== '' ? Number(req.body.pct) : targets[key];
  if (!Number.isFinite(pct)) return res.status(400).json({ error: `No growth target set for ${key}` });
  if (key === '7') return res.status(400).json({ error: 'Management fee follows income — set its % under Assumptions' });
  targets[key] = pct;
  inputs.growthTargets = targets;
  const user = req.session.username || '';

  // which detail lines move, and what their total must become
  let members: string[];
  let target: number;
  const catOf = (lines: BudgetLine[], ps: string[]) => lines.reduce((a, l) => { const acc = lb.coaMap.get(l.gl_code); return acc?.kind === 'detail' && ps.includes(acc.pcode || '') ? r2(a + sum(l.months)) : a; }, 0);
  if (key === 'opex') { members = GROWTH_EXPENSE_PCODES; target = r2(ref.toe * (1 + pct) - catOf(lb.lines, ['7'])); }
  else if (key === 'noi') {
    const tie = computeTieout(lb.lines, lb.coaMap, ref);
    members = GROWTH_EXPENSE_PCODES;
    target = r2(tie.egi.budget - ref.noi * (1 + pct) - catOf(lb.lines, ['7']));
  } else {
    if (!(PCODES as readonly string[]).includes(key)) return res.status(400).json({ error: `Unknown subtotal ${key}` });
    members = [key]; target = r2((ref.y1[key] || 0) * (1 + pct));
  }

  let lines = lb.lines;
  let how = '';
  if (key === 'loss') return res.status(400).json({ error: 'Loss to lease is its own model (rent roll burnoff / flat / ramp) — set it under Assumptions' });
  if (key === '2' || key === '3') {
    // contra-income: the lines are % of GPR (+ vacancy %, + flat October lines) —
    // scale every percentage by the same k so the subtotal lands exactly
    // (recapture rides on the other concessions and scales by itself)
    if (!catOf(lines, [key])) return res.status(400).json({ error: 'Nothing in this subtotal to scale' });
    let kTotal = 1;
    for (let pass = 0; pass < 4; pass++) {
      const cur = catOf(lines, [key]);
      if (!cur || Math.abs(target - cur) <= Math.max(1, Math.abs(target) * 0.0005)) break;
      const k = target / cur;
      kTotal *= k;
      const pg = { ...(inputs.pctGpr || {}) };
      const gg = { ...((inputs.baseline && inputs.baseline.glGrowth) || {}) };
      for (const l of lines) {
        const acc = lb.coaMap.get(l.gl_code);
        if (acc?.kind !== 'detail' || acc.pcode !== key || l.override) continue;
        const d: any = l.driver || {};
        if (d.method === 'pctGpr') pg[l.gl_code] = Math.round(d.pct * k * 1e6) / 1e6;
        else if (d.method === 'vacancy') inputs.vacancyPct = (inputs.vacancyPct || []).map((v) => Math.round(v * k * 1e6) / 1e6) as Months;
        else if (d.method === 'baseline') gg[l.gl_code] = Math.max(-0.95, Math.round(((1 + (d.pct || 0)) * k - 1) * 1e6) / 1e6);
      }
      inputs.pctGpr = pg;
      inputs.baseline = { ...(inputs.baseline || ({} as any)), glGrowth: gg };
      lines = buildLines({ ...lb, budget: { ...lb.budget, inputs } }, inputs, lines).lines;
    }
    how = `percentages scaled ×${kTotal.toFixed(4)}`;
  } else if (key === '1') {
    // GPR: base × Σ cumulative steps = target (bisection), pattern preserved
    const gprLine = lines.find((l) => l.gl_code === '4994');
    if (gprLine?.override) return res.status(400).json({ error: 'GPR is overridden — release it first' });
    const base = inputs.gpr?.baseMonthly > 0 ? inputs.gpr.baseMonthly : (lb.actualCal?.['4994'] || zero12())[(lb.lastMonth || 10) - 1] || 0;
    if (!base) return res.status(400).json({ error: 'No GPR base (rent roll or last actual month)' });
    // the month steps on file keep their places and scale together; only a
    // budget with NO steps falls back to a uniform monthly rate
    const solved = gprStepsForTarget(base, inputs.gpr?.growthPct as Months | undefined, target);
    inputs.gpr = { ...(inputs.gpr || { baseMonthly: 0, growthPct: zero12() }), growthPct: solved.growthPct };
    lines = buildLines({ ...lb, budget: { ...lb.budget, inputs } }, inputs, lines).lines;
    how = solved.k != null ? `GPR steps scaled ×${solved.k} — ${gprStepsSummary(solved.growthPct)}`
      : `GPR uniform monthly growth ${((solved.g || 0) * 100).toFixed(3)}% (no month steps were set — put increases in specific months under GPR to keep them there)`;
  } else {
    const isMember = (l: BudgetLine) => { const acc = lb.coaMap.get(l.gl_code); return acc?.kind === 'detail' && members.includes(acc.pcode || ''); };
    const adjustable = (l: BudgetLine) => { const d: any = l.driver; return isMember(l) && !l.override && d?.method === 'baseline' && d.src !== 'budget' && !d.pcts && sum(l.months) !== 0; };
    if (!lines.some(adjustable)) {
      if (members.length > 1) return res.status(400).json({ error: 'No trailing-12 × factor lines left to move in the expense categories' });
      lines = rebalanceCategory(lines, lb.coaMap, key, target);
      how = 'proportional rebalance (no factor-driven lines)';
    } else {
      // up to 4 passes: MROUND and the Jan/Dec edge rules make the response slightly non-linear
      let shiftTotal = 0;
      // secant steps: the first shift assumes only the factor lines move; the
      // measured response then sets the slope (burden lines ride on wages, MROUNDs
      // and the Jan/Dec edge rules make it non-linear) — lands in 2–3 passes
      let prevCur: number | null = null, prevDelta = 0;
      for (let pass = 0; pass < 10; pass++) {
        const cur = catOf(lines, members);
        if (Math.abs(target - cur) <= Math.max(1, Math.abs(target) * 0.0005)) break;
        const adj = lines.filter(adjustable);
        const pctOf = (l: BudgetLine): number => (l.driver as any)?.pct || 0;
        const effBase = adj.reduce((a, l) => a + sum(l.months) / (1 + pctOf(l)), 0);
        if (!effBase) break;
        const slope = prevCur != null && prevDelta && (cur - prevCur) / prevDelta > effBase * 0.2 ? (cur - prevCur) / prevDelta : effBase;
        const delta = (target - cur) / slope;
        prevCur = cur; prevDelta = delta;
        shiftTotal += delta;
        const gg = { ...((inputs.baseline && inputs.baseline.glGrowth) || {}) };
        for (const l of adj) gg[l.gl_code] = Math.max(-0.95, Math.round((pctOf(l) + delta) * 1e6) / 1e6);
        inputs.baseline = { ...(inputs.baseline || ({} as any)), glGrowth: gg };
        lines = buildLines({ ...lb, budget: { ...lb.budget, inputs } }, inputs, lines).lines;
      }
      how = `growth factors shifted ${(shiftTotal * 100).toFixed(2)} pts`;
    }
  }
  await query('update budgets set inputs=$2, updated_at=now() where id=$1', [id, JSON.stringify(inputs)]);
  await saveLines(id, lines, true);
  logChange(user, 'tie growth target', { id, pcode: key, pct, target, how });
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
  if (lb.annual) {
    // annual: "tie" a category = match the reference (T12 / CY budget) total
    const ref = refOf(lb);
    if (!ref) return res.status(400).json({ error: 'No statement linked to compare to' });
    if (pcode === '7') return res.status(400).json({ error: 'Management fee is % of income — use recalc instead' });
    target = r2(ref.y1[pcode] || 0);
  } else if (['4', '5', '6', '8', '9', '10', '11', '12', '13', '14'].includes(pcode)) {
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
const SNAPSHOT_KINDS: Record<string, { table: string; col: string; cols?: string[] }> = {
  uw: { table: 'uw_snapshots', col: 'uw_snapshot_id' },
  rent: { table: 'rent_snapshots', col: 'rent_snapshot_id' },
  t12: { table: 't12_snapshots', col: 't12_snapshot_id' },
  comp: { table: 'comp_sets', col: 'comp_set_id' },
  payroll: { table: 'payroll_models', col: 'payroll_model_id' },
  // annual mode: a statement may be a budget's trailing-12 OR its CY budget
  stmt: { table: 'stmt_snapshots', col: 'py_stmt_id', cols: ['py_stmt_id', 'cy_budget_stmt_id'] },
  template: { table: 'template_snapshots', col: 'template_id' },
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
    await saveLines(bid, built.lines, true);
  }
  logChange(req.session.username || '', 'edit payroll model', { id, regenerated: affected.length, linkAll: !!req.body?.linkAll });
  res.json({ ok: true, regenerated: affected.length });
}));

router.delete('/uploads/data/:kind/:id', requireAdmin, h(async (req, res) => {
  const k = SNAPSHOT_KINDS[String(req.params.kind)];
  if (!k) return res.status(400).json({ error: `Unknown snapshot kind "${req.params.kind}"` });
  const id = Number(req.params.id);
  const cols = k.cols || [k.col];
  const affected = (await query(`select id, property_code, ${cols.join(', ')} from budgets where ${cols.map((c) => `${c}=$1`).join(' or ')}`, [id])).rows;
  // which column(s) each budget used (stmt kind: actual vs budget statement)
  const stmtKind = k.table === 'stmt_snapshots' ? (await query('select kind from stmt_snapshots where id=$1', [id])).rows[0]?.kind : null;
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
    } else if (k.table === 'stmt_snapshots') {
      replacement = (await query(`select id from stmt_snapshots where property_code=$1 and kind=$2 order by created_at desc limit 1`, [b.property_code, stmtKind || 'actual'])).rows[0]?.id ?? null;
    } else {
      replacement = (await query(`select id from ${k.table} where property_code=$1 order by created_at desc limit 1`, [b.property_code])).rows[0]?.id ?? null;
    }
    const col = k.table === 'stmt_snapshots' ? (stmtKind === 'budget' ? 'cy_budget_stmt_id' : 'py_stmt_id') : k.col;
    await query(`update budgets set ${col}=$2, updated_at=now() where id=$1`, [b.id, replacement]);
    if (replacement) repointed++;
    const lb = (await loadBudget(b.id))!;
    const built = buildLines(lb, lb.budget.inputs, lb.lines);
    await saveLines(b.id, built.lines, true);
  }
  logChange(req.session.username || '', `delete ${req.params.kind} snapshot`, { id, budgets: affected.length, repointed });
  res.json({ ok: true, unlinked: affected.length, repointed });
}));

/* ---------------- exports ---------------- */

/** "Troy Steiss" → "TS" — exports carry the exporter's initials. */
const initialsOf = (user: string): string =>
  (user || '').trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase() || 'XX';
const mmddyyyy = (): string => {
  const n = new Date();
  return `${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}${n.getFullYear()}`;
};

/** Review-workbook arguments: acquisition budgets carry the UW book; annual
    budgets carry their reference columns (T12 actuals, CY budget, 4-mo
    annualized) and the template facts instead. */
function reviewArgs(lb: LoadedBudget, prop: any, compName: string): ReviewArgs {
  return {
    propertyCode: lb.budget.property_code, propertyName: prop?.name || lb.budget.property_code,
    year: lb.budget.year, units: Number(lb.budget.inputs?.units) || prop?.units || 0,
    coa: lb.coa, lines: effectiveLines(lb), inputs: lb.budget.inputs, uw: lb.annual ? null : lb.uw,
    compWeights: lb.annual ? null : (lb.comps?.byGl || null), compUnits: lb.annual ? null : (lb.comps?.units || null), compName,
    annual: lb.annual, refs: lb.annual ? lb.refs : [], refLabel: lb.refLabel, template: lb.template,
    payrollHist: lb.annual ? {
      t12: lb.actualCal, t12Label: lb.refs.find((r) => r.key === 'actual')?.label || 'T12 actuals',
      budget: lb.budgetCal, budgetLabel: lb.refs.find((r) => r.key === 'budget')?.label || 'CY budget',
    } : null,
    // the Budget Comps sheet: its column headers, the property's region, the T12 NOI windows on file
    summaryLabels: summaryLabels(lb.t12End?.month, lb.t12End?.year, lb.budget.inputs?.summaryLabels),
    region: String(prop?.market || '').trim() || 'Other',
    noiTrend: lb.noiTrend.map((t) => ({ label: t.label, noi: t.noi })),
  };
}

/** Every export captures the budget as a save point — one per budget per day
    per user (repeat exports of the same state don't stack up). */
async function captureExportPoint(lb: LoadedBudget, user: string): Promise<void> {
  const name = `exported ${initialsOf(user)} ${mmddyyyy()}`;
  const last = (await query(
    'select name, summary from budget_snapshots where budget_id=$1 order by created_at desc limit 1', [lb.budget.id]
  )).rows[0];
  if (last && last.name === name && JSON.stringify(last.summary) === JSON.stringify(snapshotSummary(lb))) return;
  await captureSnapshot(lb, name, user);
}

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
  let sliced: BudgetLine[] = effectiveLines(lb).map((l) => ({
    ...l, months: calendarSlice(l.months, lb.budget.year, start, calYear),
  }));
  // a closed partial month BEFORE the ownership window (close mid-Aug, start
  // Sep) rides along in its calendar column, 1:1 to what posted
  sliced = injectPreStartActuals(sliced, lb.coa, lb.budget.inputs?.actuals, lb.budget.year, start, calYear);
  const stamp = mmddyyyy();
  const ini = initialsOf(req.session.username || '');
  const isRevision = cutoff > 0 || (calYear === lb.budget.year && start > 1);
  const desc = String(req.query.desc || '') ||
    `${lb.budget.property_code} ${calYear} Budget ${isRevision ? 'Revision' : 'Upload'} ${ini} ${stamp}`;
  const csv = buildBudgetCsv(lb.coa, sliced, {
    propertyId: lb.budget.property_code, year: calYear, description: desc, cutoffMonth: cutoff,
  });
  const fname = `${lb.budget.property_code.toUpperCase()} ${calYear} Budget ${isRevision ? 'Revision' : 'Upload'} ${ini} ${stamp}.csv`;
  await captureExportPoint(lb, req.session.username || '');
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
  const buf = await buildReviewWorkbook(reviewArgs(lb, prop, compName));
  await captureExportPoint(lb, req.session.username || '');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  // Troy's naming convention: "CWND 2026 Budget Draft TS 08212026.xlsx"
  res.setHeader('Content-Disposition', `attachment; filename="${lb.budget.property_code.toUpperCase()} ${lb.budget.year} Budget Draft ${initialsOf(req.session.username || '')} ${mmddyyyy()}.xlsx"`);
  res.send(buf);
}));

/* Bundle: ALL exports for the selected budgets in one zip, organized by
   report type — "<year> Yardi Uploads/", "Budget Drafts/" — each subfolder
   holding every selected site's file under the standard names. */
router.get('/export/bundle.zip', h(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'ids required (comma-separated budget ids)' });
  const cutoff = Math.max(0, Math.min(11, Number(req.query.cutoff) || 0));
  const user = req.session.username || '';
  const ini = initialsOf(user);
  const stamp = mmddyyyy();
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const id of ids) {
    const lb = await loadBudget(id);
    if (!lb) continue;
    const code = lb.budget.property_code.toUpperCase();
    const start = lb.budget.inputs?.startMonth || 1;
    for (const calYear of start > 1 ? [lb.budget.year, lb.budget.year + 1] : [lb.budget.year]) {
      let sliced: BudgetLine[] = effectiveLines(lb).map((l) => ({ ...l, months: calendarSlice(l.months, lb.budget.year, start, calYear) }));
      sliced = injectPreStartActuals(sliced, lb.coa, lb.budget.inputs?.actuals, lb.budget.year, start, calYear);
      const isRevision = cutoff > 0 || (calYear === lb.budget.year && start > 1);
      const kind = isRevision ? 'Revision' : 'Upload';
      const csv = buildBudgetCsv(lb.coa, sliced, {
        propertyId: lb.budget.property_code, year: calYear,
        description: `${lb.budget.property_code} ${calYear} Budget ${kind} ${ini} ${stamp}`,
        cutoffMonth: calYear === lb.budget.year ? cutoff : 0,
      });
      zip.file(`${calYear} Yardi Uploads/${code} ${calYear} Budget ${kind} ${ini} ${stamp}.csv`, csv);
    }
    const prop = (await query('select * from properties where code=$1', [lb.budget.property_code])).rows[0];
    let compName = '';
    if (lb.budget.comp_set_id) compName = (await query('select name from comp_sets where id=$1', [lb.budget.comp_set_id])).rows[0]?.name || '';
    const wbBuf = await buildReviewWorkbook(reviewArgs(lb, prop, compName));
    zip.file(`Budget Drafts/${code} ${lb.budget.year} Budget Draft ${ini} ${stamp}.xlsx`, wbBuf);
    await captureExportPoint(lb, user);
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  logChange(user, 'bundle export', { ids, cutoff });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Budget Exports ${ini} ${stamp}.zip"`);
  res.send(buf);
}));

/* All-sites workbook: every budget's Budget/Summary/Raw Data tabs by site +
   a live Portfolio rollup tab. ?ids=1,2,3 exports just those budgets (e.g.
   the 4 Bismarck sites in one workbook, the 2 Jamestown in another);
   ?year= filters; default = every budget. */
router.get('/export/portfolio.xlsx', h(async (req, res) => {
  const year = Number(req.query.year) || null;
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const rows = ids.length
    ? (await query('select id from budgets where id = any($1) order by property_code', [ids])).rows
    : (await query(
        year ? 'select id from budgets where year=$1 order by property_code' : 'select id from budgets order by property_code',
        year ? [year] : []
      )).rows;
  if (!rows.length) return res.status(404).json({ error: 'No budgets to export' });
  // label = the shared portfolio name when the selection is one portfolio
  const pf = (await query(
    `select distinct coalesce(pf.name, '') as name
       from budgets b join properties p on p.code = b.property_code
       left join portfolios pf on pf.id = p.portfolio_id
      where b.id = any($1)`, [rows.map((r: any) => r.id)]
  )).rows.map((r: any) => r.name).filter(Boolean);
  const label = pf.length === 1 ? pf[0] : year ? `${year} Budgets` : 'Selected Budgets';
  const sites: ReviewArgs[] = [];
  for (const r of rows) {
    const lb = (await loadBudget(r.id))!;
    const prop = (await query('select * from properties where code=$1', [lb.budget.property_code])).rows[0];
    let compName = '';
    if (lb.budget.comp_set_id) compName = (await query('select name from comp_sets where id=$1', [lb.budget.comp_set_id])).rows[0]?.name || '';
    sites.push(reviewArgs(lb, prop, compName));
    await captureExportPoint(lb, req.session.username || '');
  }
  const buf = await buildPortfolioWorkbook(sites, label);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${label.toUpperCase()} Budget Draft ${initialsOf(req.session.username || '')} ${mmddyyyy()}.xlsx"`);
  res.send(buf);
}));

/* Import an EDITED review-workbook draft back into the budget: the prior
   state is captured as a save point, then every detail-GL month that differs
   from the workbook is written as an 'imported' override; Summary D27 updates
   capital. Dependent passes + ties reconcile via buildLines. */
router.post('/budgets/:id/import-draft', upload.single('file'), h(async (req, res) => {
  const lb = await loadBudget(Number(req.params.id));
  if (!lb) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const parsed = parseReviewDraft(req.file.buffer);
  if (parsed.code && parsed.code !== lb.budget.property_code) {
    return res.status(400).json({ error: `Draft is for ${parsed.code.toUpperCase()}, this budget is ${lb.budget.property_code.toUpperCase()}` });
  }
  const user = req.session.username || '';
  await captureSnapshot(lb, `before import ${req.file.originalname.slice(0, 40)}`, user);
  let changed = 0;
  for (const l of lb.lines) {
    const a = lb.coaMap.get(l.gl_code);
    if (!a || a.kind !== 'detail') continue;
    const m = parsed.glMonths[l.gl_code];
    if (!m) continue;
    if (l.months.every((v, i) => Math.abs(v - m[i]) < 0.01)) continue;
    l.months = m.map((v) => r2(v)) as Months;
    l.override = true;
    l.driver = { method: 'imported', file: req.file.originalname.slice(0, 40) } as any;
    changed++;
  }
  const inputs: BudgetInputs = { ...lb.budget.inputs };
  let capitalChanged = false;
  if (parsed.capital != null && Math.abs(parsed.capital - (Number(inputs.capital) || 0)) >= 1) {
    inputs.capital = parsed.capital;
    capitalChanged = true;
  }
  await query('update budgets set inputs=$2, updated_at=now() where id=$1', [lb.budget.id, JSON.stringify(inputs)]);
  const built = buildLines({ ...lb, budget: { ...lb.budget, inputs } }, inputs, lb.lines);
  await saveLines(lb.budget.id, built.lines, true);
  logChange(user, 'import draft workbook', { id: lb.budget.id, file: req.file.originalname, changed, capitalChanged });
  const view: any = budgetView((await loadBudget(lb.budget.id))!);
  view.importResult = { changed, capitalChanged, capital: parsed.capital };
  res.json(view);
}));

/* ---------------- actualize a closed month (partial-month rule) ----------------
   Troy: after the first partial month of ownership closes, that month is
   budgeted 1:1 to what posted (Cash book). The upload is the month-end Yardi
   Property Comparison; the budget picks its own property's Actual column.
   Result lives on inputs.actuals["YYYY-MM"] — plan lines are untouched. */
router.post('/budgets/:id/actualize', upload.single('file'), h(async (req, res) => {
  const lb = await loadBudget(Number(req.params.id));
  if (!lb) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const parsed = parseComparisonActuals(req.file.buffer);
  const code = String(lb.budget.property_code).toLowerCase();
  if (!parsed.properties.includes(code)) {
    return res.status(400).json({ error: `The report has no ${code.toUpperCase()} Actual column (found: ${parsed.properties.map((p) => p.toUpperCase()).join(', ') || 'none'})` });
  }
  if (parsed.book && !/cash/i.test(parsed.book)) {
    return res.status(400).json({ error: `Report book is "${parsed.book}" — budgets are compared on the Cash book; re-export the comparison with Book = Cash` });
  }
  const year = Number(lb.budget.year);
  const start = lb.budget.inputs?.startMonth || 1;
  const idx = ownershipIndexOf(year, start, parsed.calYear, parsed.calMonth);
  const preStart = idx < 0 && parsed.calYear === year && parsed.calMonth < start;
  if (idx < 0 && !preStart) {
    const lbl = monthLabels(year, start);
    return res.status(400).json({ error: `${parsed.period} is outside this budget (${lbl[0]} – ${lbl[11]}${start > 1 ? `, or the partial closing month before ${lbl[0]}` : ''})` });
  }
  const rows = parsed.rows.map((r) => ({ gl: r.gl, name: r.name, amount: r.actual[code] || 0 }));
  const { glMonths, summary } = actualizeFromComparison(lb.coa, rows);
  if (!summary.mirrored && !summary.remapped.length) {
    return res.status(400).json({ error: `No ${code.toUpperCase()} postings found for ${parsed.period}` });
  }
  const user = req.session.username || '';
  await captureSnapshot(lb, `before actualize ${parsed.period}`, user);
  const key = actualKey(parsed.calYear, parsed.calMonth);
  const entry: ActualizedMonth = {
    period: parsed.period, book: parsed.book || 'Cash', source: req.file.originalname.slice(0, 80),
    appliedAt: new Date().toISOString(), appliedBy: user, glMonths, summary,
  };
  const inputs: BudgetInputs = { ...lb.budget.inputs, actuals: { ...(lb.budget.inputs?.actuals || {}), [key]: entry } };
  await query('update budgets set inputs=$2, updated_at=now() where id=$1', [lb.budget.id, JSON.stringify(inputs)]);
  logChange(user, 'actualize month', {
    id: lb.budget.id, key, file: req.file.originalname, mirrored: summary.mirrored,
    remapped: summary.remapped.length, excluded: summary.excluded.length, unmapped: summary.unmapped.length,
  });
  const view: any = budgetView((await loadBudget(lb.budget.id))!);
  view.actualizeResult = { key, index: idx, preStart, ...entry };
  res.json(view);
}));

router.delete('/budgets/:id/actualize/:key', h(async (req, res) => {
  const lb = await loadBudget(Number(req.params.id));
  if (!lb) return res.status(404).json({ error: 'Not found' });
  const key = String(req.params.key);
  const acts: Record<string, ActualizedMonth> = { ...(lb.budget.inputs?.actuals || {}) };
  if (!acts[key]) return res.status(404).json({ error: `No actualized month ${key}` });
  const user = req.session.username || '';
  await captureSnapshot(lb, `before releasing actuals ${acts[key].period}`, user);
  delete acts[key];
  const inputs: BudgetInputs = { ...lb.budget.inputs, actuals: Object.keys(acts).length ? acts : null };
  await query('update budgets set inputs=$2, updated_at=now() where id=$1', [lb.budget.id, JSON.stringify(inputs)]);
  logChange(user, 'release actualized month', { id: lb.budget.id, key });
  res.json(budgetView((await loadBudget(lb.budget.id))!));
}));

/* Bulk: revise Yardi budget CSVs (as exported from Yardi, or the files last
   uploaded) so the closed month = posted actuals. A Yardi export can hold
   SEVERAL budgets in one file (one //Budget block per property) — each block
   is revised with ITS OWN property's postings, read from its header record,
   never from the UI, and the file is re-emitted complete and in order. Every
   other cell is kept verbatim, so changes made directly in Yardi are never
   undone. The matching budget in the tool (same property, that calendar year
   inside its window) records the actualized month; with adopt=1 its plan also
   takes that block's other months (YARDI overrides) so a later tool export
   can't undo Yardi-side edits. */
router.post('/actualize-csv', upload.fields([{ name: 'comparison', maxCount: 1 }, { name: 'csv', maxCount: 20 }]), h(async (req, res) => {
  const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
  const cmpFile = files.comparison?.[0];
  const csvFiles = files.csv || [];
  if (!cmpFile) return res.status(400).json({ error: 'The month-end Property Comparison (.xlsx) is required' });
  if (!csvFiles.length) return res.status(400).json({ error: 'At least one budget CSV is required' });
  const parsed = parseComparisonActuals(cmpFile.buffer);
  if (parsed.book && !/cash/i.test(parsed.book)) {
    return res.status(400).json({ error: `Report book is "${parsed.book}" — budgets are compared on the Cash book; re-export the comparison with Book = Cash` });
  }
  const adopt = String(req.body?.adopt || '') === '1';
  const user = req.session.username || '';
  const stamp = `${initialsOf(user)} ${mmddyyyy()}`;
  const coa = await loadCoa();
  const results: any[] = [];
  const outFiles: { filename: string; csv: string; codes: string[] }[] = [];
  for (const f of csvFiles) {
    let blocks: BudgetCsvParsed[];
    try { blocks = parseBudgetCsvBlocks(f.buffer); }
    catch (e: any) { results.push({ file: f.originalname, error: e?.message || String(e), warnings: [] }); continue; }
    const pieces: string[] = [];
    const codes: string[] = [];
    const fileResults: any[] = [];
    for (const base of blocks) {
      const code = base.propertyId;
      const r: any = { file: f.originalname, code, warnings: [] as string[] };
      try {
        if (!parsed.properties.includes(code)) throw new Error(`the comparison has no ${code.toUpperCase()} Actual column`);
        if (parsed.calYear !== base.year) throw new Error(`${parsed.period} is not in this budget's calendar year (${base.year})`);
        const rows = parsed.rows.map((x) => ({ gl: x.gl, name: x.name, amount: x.actual[code] || 0 }));
        const { glMonths, summary } = actualizeFromComparison(coa, rows);
        if (!summary.mirrored && !summary.remapped.length) throw new Error(`no ${code.toUpperCase()} postings for ${parsed.period}`);
        const rev = reviseBudgetCsv(base, parsed.calMonth, glMonths, { stamp });
        pieces.push(rev.csv);
        codes.push(code);
        Object.assign(r, {
          period: parsed.period, description: rev.description, rewritten: rev.rewritten, appended: rev.appended,
          summary, glCount: Object.keys(glMonths).length,
        });
        // record the month on the matching budget (the CSV year is the budget's
        // start year, or the following year for the Jan–… slice)
        const b = (await query(
          'select id from budgets where lower(property_code)=$1 and (year=$2 or year=$2-1) order by (year=$2) desc, updated_at desc limit 1',
          [code, base.year]
        )).rows[0];
        if (!b) { r.warnings.push(`no budget for ${code.toUpperCase()} covering ${base.year} in the tool — CSV revised, nothing recorded`); fileResults.push(r); continue; }
        const lb = (await loadBudget(b.id))!;
        r.budgetId = b.id;
        await captureSnapshot(lb, `before actualize ${parsed.period} (Yardi CSV)`, user);
        const key = actualKey(parsed.calYear, parsed.calMonth);
        const entry: ActualizedMonth = {
          period: parsed.period, book: parsed.book || 'Cash',
          source: `${cmpFile.originalname.slice(0, 60)} + ${f.originalname.slice(0, 60)} [${code}]`,
          appliedAt: new Date().toISOString(), appliedBy: user, glMonths, summary,
        };
        const inputs: BudgetInputs = { ...lb.budget.inputs, actuals: { ...(lb.budget.inputs?.actuals || {}), [key]: entry } };
        let adopted: { changed: number } | null = null;
        if (adopt) {
          const start = inputs.startMonth || 1;
          const byGl = new Map(base.rows.map((x) => [x.gl, x.amounts]));   // THIS block's rows only
          let changed = 0;
          for (const l of lb.lines) {
            const a = lb.coaMap.get(l.gl_code);
            if (!a || a.kind !== 'detail' || a.csv_order == null) continue;
            const am = byGl.get(l.gl_code);
            if (!am) continue;
            const next = [...l.months] as Months;
            let diff = false;
            for (let i = 0; i < 12; i++) {
              if (calYearOf(Number(lb.budget.year), start, i) !== base.year) continue;   // other calendar year: not in this CSV
              const cm = calMonthOf(start, i);
              if (cm === parsed.calMonth) continue;                                      // the actualized month is an overlay, never plan
              const v = r2(am[cm - 1] || 0);
              if (Math.abs(v - (l.months[i] || 0)) >= 0.005) { next[i] = v; diff = true; }
            }
            if (!diff) continue;
            l.months = next;
            l.override = true;
            l.driver = { method: 'yardiCsv', file: f.originalname.slice(0, 40) } as any;
            changed++;
          }
          adopted = { changed };
        }
        await query('update budgets set inputs=$2, updated_at=now() where id=$1', [b.id, JSON.stringify(inputs)]);
        const built = buildLines({ ...lb, budget: { ...lb.budget, inputs } }, inputs, lb.lines);
        await saveLines(b.id, built.lines, true);
        logChange(user, 'actualize month (Yardi CSV)', { id: b.id, key, file: f.originalname, adopted: adopted?.changed ?? null, appended: rev.appended.length });
        r.adopted = adopted;
      } catch (e: any) {
        r.error = e?.message || String(e);
        pieces.push(budgetCsvBlockText(base));   // keep the file complete: this budget goes out unchanged
        r.warnings.push('this budget was left unchanged in the output file');
      }
      fileResults.push(r);
    }
    if (pieces.length) {
      const year = blocks[0].year;
      const label = codes.length === 0 ? 'Budget' : codes.length <= 3 ? codes.map((c) => c.toUpperCase()).join('-') : `${codes.length} sites`;
      const filename = `${label} ${year} Budget Revision ${stamp}.csv`;
      outFiles.push({ filename, csv: pieces.join(''), codes });
      for (const r of fileResults) r.filename = filename;
    }
    results.push(...fileResults);
  }
  res.json({ period: parsed.period, book: parsed.book, results, files: outFiles.map(({ filename, csv, codes }) => ({ filename, csv, codes })) });
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
