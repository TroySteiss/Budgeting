/* Budget Tool SPA — no framework, mirrors the SP Tracker pattern.
   State flows: /api/state (lists) + /api/budgets/:id (editor payload). */
'use strict';

const S = {
  auth: null,          // {authed, username, isAdmin, appTitle}
  state: null,         // {coa, portfolios, properties, budgets, uwSnapshots, compSets, rentSnapshots}
  view: 'dash',        // dash | uploads | editor | settings
  bv: null,            // budget view payload {budget, lines, tieout, kpis, uw, compWeights}
  showZero: false,
  upload: { kind: 'yardi_template', files: [], parsed: null, busy: false, msg: '', err: '' },
  err: '',
  theme: localStorage.getItem('bt-theme') || 'light',
  hiddenCols: new Set(JSON.parse(localStorage.getItem('bt-hidecols') || '[]')),
  undo: { budgetId: null, stack: [] },   // snapshots of {lines, inputs} before each change
  showDist: localStorage.getItem('bt-dist') === '1',
  pendingRow: null,                      // in-progress row edit buffer {gl, months, dirty}
  gridScroll: null,
};

function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  localStorage.setItem('bt-theme', S.theme);
}

/* driver metadata: colour class + short tag + label for the formula a row uses */
function drvMeta(l) {
  const m = drvMetaBase(l);
  // hand-revised cells on a formula line keep the formula's identity — the
  // revision is dictated as a * on the tag, never demoted to MAN
  if (l && l.driver && l.driver.revised && m.tag !== 'MAN' && m.tag !== '—') {
    return { ...m, tag: m.tag + '*', label: m.label + ' — cells hand-revised' };
  }
  return m;
}
function drvMetaBase(l) {
  if (!l) return { cls: 'drv-none', tag: '—', label: 'No formula (zero)' };
  const method = (l.driver || {}).method;
  // an override with a named formula keeps its identity (T3, MINOT, …);
  // only free-typed cells show as MAN
  if (l.override && (!method || method === 'manual')) return { cls: 'drv-man', tag: 'MAN', label: 'Manual override' };
  switch (method) {
    case 't3avg': return { cls: 'drv-comp', tag: 'T3', label: `T3 avg of ${l.driver.srcName || 'this GL'} × ${(((l.driver || {}).pct || 0)).toFixed(1)}% → MROUND $250` };
    case 'wavg': return { cls: l.driver.srcType === 'seller' ? 'drv-t12' : 'drv-comp', tag: 'WAVG', label: `1-2-1 weighted distribution of ${l.driver.srcName || ''} × ${((l.driver.pct || 0)).toFixed(1)}%${l.driver.mult ? ` → MROUND $${l.driver.mult}` : ''}` };
    case 'gpr': return { cls: 'drv-rr', tag: 'RR', label: 'Rent roll — GPR growth' };
    case 'ltl': return { cls: 'drv-rr', tag: 'LTL', label: 'Rent roll — lease burnoff' };
    case 'vacancy': return { cls: 'drv-rr', tag: '%GPR', label: '% of GPR' };
    case 'catShare': return { cls: 'drv-uw', tag: 'UW', label: `UW category ${l.driver.pcode} share` };
    case 'perUnitComp': return { cls: 'drv-comp', tag: 'MINOT', label: `Minot $${l.driver.perUnit}/unit × units` };
    case 'payrollModel': return { cls: 'drv-pay', tag: 'PAY', label: 'Payroll model wages' };
    case 'burdenRatio': return { cls: 'drv-pay', tag: 'RATIO', label: `${((l.driver.ratio || 0) * 100).toFixed(1)}% of wages (${S.bv && S.bv.annual ? 'prior-year ratio × budgeted wages — moves with wages' : 'Minot ratio'})` };
    case 'mgmtPct': return { cls: 'drv-fee', tag: '%INC', label: `${((l.driver.pct || 0) * 100).toFixed(2)}% of income` };
    case 'interest': return { cls: 'drv-int', tag: 'INT', label: 'Interest (loan × rate × days)' };
    case 'sellerUtil': return { cls: 'drv-t12', tag: 'SLR', label: 'Seller statement level (× growth)' };
    case 'sellerLine': return { cls: 'drv-t12', tag: 'SLR', label: `Seller: ${l.driver.name || ''} × ${(l.driver.pct || 0).toFixed(1)}%` };
    case 'recovery': return { cls: 'drv-t12', tag: 'REC', label: `${((l.driver.pct || 0) * 100).toFixed(1)}% of prior-month ${l.driver.src ? `← ${l.driver.src}` : 'billing'}` };
    case 'charges': return { cls: 'drv-rr', tag: 'CHG', label: 'Rent-roll charges × 12' };
    case 'zero': return { cls: 'drv-int', tag: 'ZERO', label: 'Zeroed out — this GL carries nothing' };
    case 't12curve': return { cls: 'drv-t12', tag: 'T12C', label: `Seller ${l.driver.name || ''} T12 TOTAL × ${(l.driver.pct || 0).toFixed(1)}% on ${l.driver.shape === 'minot' ? 'the Minot' : l.driver.shape || 'flat'} curve${l.driver.mult ? ` → MROUND $${l.driver.mult}` : ''}` };
    case 'linkLine': return { cls: 'drv-fee', tag: 'LINK', label: `= ${l.driver.src || ''} ${l.driver.srcName || ''} × ${l.driver.weight ?? 1} — follows it live on every regeneration` };
    case 'yardiCsv': return { cls: 'drv-man', tag: 'YARDI', label: `Adopted from the Yardi budget CSV${l.driver.file ? ` (${l.driver.file})` : ''} — the month as it sits in Yardi` };
    case 'imported': return { cls: 'drv-man', tag: 'IMP', label: `Imported from draft workbook${l.driver.file ? ` (${l.driver.file})` : ''}` };
    case 'smooth': return { cls: 'drv-t12', tag: 'SMOOTH', label: `Missed-bill smoothing ×${l.driver.passes || 0}${l.driver.of ? ` of ${String(l.driver.of).toUpperCase()}${l.driver.srcName ? ' ' + l.driver.srcName : ''}` : ''} — spikes spread into surrounding months, total kept` };
    case 'setTotal': return { cls: 'drv-man', tag: 'TOTAL', label: `Total set to ${Math.round(l.driver.total || 0).toLocaleString()} — ${l.driver.of ? `${String(l.driver.of).toUpperCase()} distribution kept` : 'prior distribution kept'}` };
    /* ---- annual (template) rules ---- */
    case 'baseline': {
      const d = l.driver;
      const shape = { actual: 'same calendar month', wavg: '1-2-1 weighted distribution', flat: 'T12 ÷ 12 flat', curve: 'T12 total on the GL curve', last: 'last actual month, flat', avgnz: 'average of active months, flat' }[d.shape] || d.shape;
      const factor = d.pcts ? `+ Conservice forecast ${(Math.min(...d.pcts) * 100).toFixed(0)}–${(Math.max(...d.pcts) * 100).toFixed(0)}% by month` : `× ${(1 + (d.pct || 0)).toFixed(3)}`;
      const tag = d.src === 'budget' ? 'CYB' : d.shape === 'last' ? 'LAST' : d.pcts ? 'UTIL' : d.shape === 'wavg' ? 'WAVG' : d.shape === 'flat' ? 'T12/12' : 'T12';
      return { cls: 'drv-base', tag, label: `${d.src === 'budget' ? 'CY budget' : 'Own trailing-12 actual'} — ${shape} ${factor}${d.mult ? ` → MROUND $${d.mult}` : ''} · T12 ${Math.round(d.base || 0).toLocaleString()}${d.rule ? ' · GRKS foundation rule' : ''}` };
    }
    case 'pctGpr': return { cls: 'drv-base', tag: '%GPR', label: `${((l.driver.pct || 0) * 100).toFixed(2)}% of ${l.driver.of === 'net' ? 'net rental income' : l.driver.of === 'netgpr' ? 'net GPR' : 'GPR'} (${l.driver.basis === 'last' ? 'last-month' : 'trailing-12'} ratio)` };
    case 'recapture': return { cls: 'drv-base', tag: 'RECAP', label: `${((l.driver.pct || 0) * 100).toFixed(1)}% recapture of the other concession lines (T12 ratio)` };
    case 'perTurn': return { cls: 'drv-base', tag: 'TURN', label: `$${money(l.driver.amount)} per new move-in × ${money(l.driver.turns)} projected move-ins (expirations × (1 − renewal %))` };
    case 'suggested': return { cls: 'drv-corp', tag: 'CORP', label: `Corporate budget suggestion${l.driver.note ? ` — ${l.driver.note}` : ''}` };
    case 'corpRate': return { cls: 'drv-corp', tag: 'RATE', label: `Corporate rate${l.driver.perUnitYr ? ` $${l.driver.perUnitYr}/unit/yr` : ''}${l.driver.flatMo ? ` + $${l.driver.flatMo}/mo` : ''}` };
    case 'debtService': return { cls: 'drv-int', tag: 'DEBT', label: `Yardi amortization schedule — ${l.driver.kind}${l.driver.loan ? ` (${l.driver.loan})` : ''}` };
    default: return { cls: 'drv-none', tag: '—', label: 'No formula (zero / manual)' };
  }
}

function pushUndo() {
  if (!S.bv) return;
  if (S.undo.budgetId !== S.bv.budget.id) S.undo = { budgetId: S.bv.budget.id, stack: [] };
  S.undo.stack.push({
    lines: JSON.parse(JSON.stringify(S.bv.planLines || S.bv.lines)),   // the PLAN — actualized months overlay on read
    inputs: JSON.parse(JSON.stringify(S.bv.budget.inputs || {})),
  });
  if (S.undo.stack.length > 25) S.undo.stack.shift();
}

async function doUndo(budgetId) {
  const snap = S.undo.stack.pop();
  if (!snap) return;
  S.bv = await POST(`/budgets/${budgetId}/restore`, snap);
  render();
}

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const GET = (p) => api(p);
const POST = (p, body) => api(p, { method: 'POST', body });
const PUT = (p, body) => api(p, { method: 'PUT', body });
const DEL = (p) => api(p, { method: 'DELETE' });

/* ---------------- fmt ---------------- */
const money = (v, dp = 0) => v == null ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const money2 = (v) => money(v, 2);
const pctf = (v) => v == null ? '' : (v * 100).toFixed(1) + '%';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sumM = (m) => (m || []).reduce((a, b) => a + (Number(b) || 0), 0);

/* parse "5" or "5,5,4.5,..." into 12 fractions (input given in %) */
function parse12(text, fallback) {
  const parts = String(text || '').split(',').map((x) => parseFloat(x.trim())).filter((x) => Number.isFinite(x));
  if (!parts.length) return fallback;
  const vals = parts.length === 12 ? parts : Array(12).fill(parts[0]);
  return vals.map((v) => v / 100);
}
const show12 = (arr) => {
  if (!arr || !arr.length) return '';
  const pcts = arr.map((v) => +(v * 100).toFixed(3));
  return pcts.every((v) => v === pcts[0]) ? String(pcts[0]) : pcts.join(', ');
};

/* ---------------- boot ---------------- */
async function boot() {
  applyTheme();
  S.auth = await GET('/auth/status').catch(() => ({ authed: false }));
  if (S.auth.authed) S.state = await GET('/state');
  render();
}
async function refreshState() { S.state = await GET('/state'); }

/* ---------------- render root ---------------- */
function render() {
  const gw = document.querySelector('.gridwrap');
  if (gw) S.gridScroll = { top: gw.scrollTop, left: gw.scrollLeft };
  const app = document.getElementById('app');
  if (!S.auth || !S.auth.authed) { app.innerHTML = loginView(); wireLogin(); return; }
  app.innerHTML = `
    <div class="topbar">
      <span class="brand">${esc(S.auth.appTitle || 'Budget Tool')}</span>
      <nav>
        <button data-v="dash" class="${S.view === 'dash' ? 'on' : ''}">Budgets</button>
        ${S.view === 'editor' && S.bv ? `<span class="crumb">›</span><button data-v="editor" class="on">${esc(S.bv.budget.property_code)} ${S.bv.budget.year}</button>` : ''}
        <button data-v="uploads" class="${S.view === 'uploads' ? 'on' : ''}">Data</button>
        <button data-v="settings" class="${S.view === 'settings' ? 'on' : ''}">Settings</button>
      </nav>
      <span class="spacer"></span>
      <button class="theme" id="theme-toggle" title="Toggle dark mode">${S.theme === 'dark' ? '☀' : '🌙'}</button>
      <span class="who">${esc(S.auth.username)}${S.auth.isAdmin ? ' · admin' : ''}<button id="logout">Sign out</button></span>
    </div>
    <div class="wrap" id="main"></div>`;
  document.querySelectorAll('.topbar nav button').forEach((b) =>
    b.addEventListener('click', () => { S.view = b.dataset.v; render(); }));
  document.getElementById('logout').addEventListener('click', async () => { await POST('/logout'); location.reload(); });
  document.getElementById('theme-toggle').addEventListener('click', () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; applyTheme(); render(); });
  const main = document.getElementById('main');
  if (S.view === 'dash') renderDash(main);
  else if (S.view === 'uploads') renderUploads(main);
  else if (S.view === 'editor') renderEditor(main);
  else if (S.view === 'settings') renderSettings(main);
}

/* ---------------- login ---------------- */
function loginView() {
  return `<div class="wrap"><div class="card login">
    <h2>Budget Tool</h2>
    <div class="fld"><label>Name</label><input id="lu" autocomplete="username"></div>
    <div class="fld"><label>Password</label><input id="lp" type="password"></div>
    <div class="err" id="lerr"></div>
    <button class="btn" id="lgo">Sign in</button>
  </div></div>`;
}
function wireLogin() {
  const go = async () => {
    try {
      await POST('/login', { username: document.getElementById('lu').value, password: document.getElementById('lp').value });
      await boot();
    } catch (e) { document.getElementById('lerr').textContent = e.message; }
  };
  document.getElementById('lgo').addEventListener('click', go);
  document.getElementById('lp').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

/* A small popup menu anchored under a button. `html` is the body (buttons /
   labels), `wire(menu)` attaches handlers; any click inside that is not on a
   checkbox closes it. */
function popMenu(anchorBtn, html, wire) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.innerHTML = html;
  const r = anchorBtn.getBoundingClientRect();
  document.body.appendChild(menu);
  const w = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + window.scrollX}px`;
  menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  menu.addEventListener('click', (e) => { e.stopPropagation(); if (e.target.closest('button') && !e.target.closest('[data-keep]')) menu.remove(); });
  const close = () => { menu.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('click', close, { once: true }); document.addEventListener('keydown', onKey); }, 0);
  if (wire) wire(menu);
  return menu;
}

/* ---------------- dashboard ---------------- */
function renderDash(el) {
  const st = S.state;
  const props = new Map(st.properties.map((p) => [p.code, p]));
  const hasAcq = st.budgets.some((b) => b.budget_type !== 'annual');
  el.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:10px">
        <h2 style="margin:0">Budgets</h2>
        <div class="row">
          <button class="btn sub" id="dash-export" title="Exports for the ticked budgets (all if none ticked)">⬇ Export ▾</button>
          <button class="btn" id="newb">+ New budget</button>
        </div>
      </div>
      ${st.budgets.length ? `<table class="list"><tr><th><input type="checkbox" id="sel-all" title="Select all budgets"></th><th>Property</th><th>Budget</th><th>Income</th><th>OpEx</th><th>NOI</th><th title="NOI vs the budget's reference (T12 actuals / CY budget for annual, UW for acquisitions)">Δ NOI</th><th title="EGI vs the reference">Δ EGI</th>${hasAcq ? '<th>CoC</th>' : ''}<th>Status</th><th>Updated</th><th></th></tr>
        ${st.budgets.map((b) => {
          const d = b.dash || {};
          const varCell = (v) => (v == null ? '<td class="muted">—</td>' : `<td class="${Math.abs(v) < 1 ? '' : v > 0 ? '' : 'neg'}" style="${Math.abs(v) < 1 ? 'color:var(--good)' : ''}" title="vs ${esc(d.refLabel || 'UW')}">${Math.abs(v) < 1 ? 'tied' : money(v)}</td>`);
          const sm = d.startMonth > 1 ? `${MONTHS[d.startMonth - 1]}-${String(b.year).slice(2)} – ${MONTHS[(d.startMonth + 10) % 12]}-${String(b.year + 1).slice(2)}` : String(b.year);
          const ov = (d.overridesFormula || 0) + (d.overridesFixed || 0);
          return `<tr class="click" data-id="${b.id}">
          <td><input type="checkbox" data-sel="${b.id}"></td>
          <td><b>${esc(b.property_code)}</b> · ${esc(b.property_name)}</td>
          <td>${b.budget_type === 'annual' ? `<b>${sm}</b> <span class="muted">annual</span>` : `<b>${sm}</b> <span class="muted">acquisition · UW Y1</span>`}<div class="muted" style="font-size:11px">${ov ? `${ov} override${ov === 1 ? '' : 's'}` : 'no overrides'}${d.ltlMode === 'leases' ? ' · per-lease LTL' : ''}${d.savePoints ? ` · ${d.savePoints} save pt${d.savePoints === 1 ? '' : 's'}` : ''}</div></td>
          <td>${money(d.income)}</td><td>${money(d.expense)}</td><td><b>${money(d.noi)}</b></td>
          ${varCell(d.noiVar)}${varCell(d.egiVar)}
          ${hasAcq ? `<td>${d.coc != null ? (d.coc * 100).toFixed(1) + '%' : '—'}${d.capital ? `<div class="muted" style="font-size:10.5px">on ${money(d.capital)}</div>` : ''}</td>` : ''}
          <td>${esc(b.status)}</td>
          <td class="muted">${new Date(b.updated_at).toLocaleDateString()}</td>
          <td>${S.auth.isAdmin ? `<button class="rb" data-del="${b.id}" title="Delete this budget">🗑</button>` : ''}</td>
        </tr>`; }).join('')}</table>` : `<p class="muted">No budgets yet. Click <b>+ New budget</b> — for an annual budget you only need the property's Yardi budget template (budgetYSR…xlsm); it carries the trailing-12 actuals and the current-year budget. Add the rent roll for the GPR anchor and per-lease burnoff.</p>`}
    </div>
    <dialog id="newdlg"></dialog>
    <dialog class="assump" id="pm-dlg"></dialog>
    <dialog class="assump" id="actcsv-dlg"></dialog>`;

  el.querySelectorAll('tr.click').forEach((tr) => tr.addEventListener('click', async (e) => {
    if (e.target.dataset.del) return;
    await openBudget(Number(tr.dataset.id));
  }));
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this budget?')) return;
    await DEL(`/budgets/${b.dataset.del}`);
    await refreshState(); render();
  }));
  document.getElementById('newb').addEventListener('click', () => { S.nb = null; newBudgetDialog(); });
  const selectedIds = () => [...el.querySelectorAll('[data-sel]')].filter((c) => c.checked).map((c) => c.dataset.sel);
  el.querySelectorAll('[data-sel]').forEach((c) => c.addEventListener('click', (e) => e.stopPropagation()));
  const selAll = document.getElementById('sel-all');
  if (selAll) selAll.addEventListener('click', (e) => {
    e.stopPropagation();
    el.querySelectorAll('[data-sel]').forEach((c) => { c.checked = selAll.checked; });
  });
  document.getElementById('dash-export').addEventListener('click', (e) => {
    e.stopPropagation();
    const n = selectedIds().length;
    popMenu(e.currentTarget, `
      <div class="rm-head">${n ? `${n} ticked budget${n === 1 ? '' : 's'}` : 'All budgets'}</div>
      <button data-x="pf" title="One workbook: each site's Budget / Summary / Raw Data tabs plus a live Portfolio rollup tab — tick the 4 Bismarck sites for a Bismarck WB, the 2 Jamestown for a JT WB">⬇ Portfolio workbook</button>
      <button data-x="zip" title="ZIP of every export, sorted by report type: Yardi Uploads per year + Budget Drafts — each budget saved as an iteration">⬇ All exports (zip)</button>
      <button data-x="act" title="Partial-month rule off the budget as it sits in Yardi: upload the month-end Property Comparison (Cash) + each property's budget CSV — every CSV comes back with the closed month set 1:1 to what posted">✓ Actualize from Yardi CSVs…</button>`, (menu) => {
      menu.querySelector('[data-x="pf"]').addEventListener('click', () => { const ids = selectedIds(); window.open(`/api/export/portfolio.xlsx${ids.length ? `?ids=${ids.join(',')}` : ''}`, '_blank'); });
      menu.querySelector('[data-x="zip"]').addEventListener('click', () => { const ids = selectedIds(); const all = ids.length ? ids : st.budgets.map((b) => b.id); if (all.length) window.open(`/api/export/bundle.zip?ids=${all.join(',')}`, '_blank'); });
      menu.querySelector('[data-x="act"]').addEventListener('click', () => openActualizeCsv());
    });
  });
}

/* Everything on file, one table, grouped by property. A template's own two
   statements are implied by the template row (not listed twice). */
function dataOnFileHtml(st) {
  const tplUploads = new Set((st.templates || []).map((t) => t.upload_id));
  const fmtd = (d) => (d ? new Date(d).toLocaleDateString() : '');
  const rows = [];
  for (const t of st.templates || []) rows.push({ prop: t.property_code, kind: 'Yardi template', detail: `budget ${t.budget_year}${t.actual_period ? ` · T12 ${t.actual_period}` : ''}${t.budget_period ? ` · CY budget ${t.budget_period}` : ''}`, sub: t.label, added: t.created_at, del: `template:${t.id}` });
  for (const x of (st.stmtSnapshots || []).filter((x) => !tplUploads.has(x.upload_id))) rows.push({ prop: x.property_code, kind: x.kind === 'budget' ? 'CY budget statement' : 'T12 statement', detail: `${x.period || ''}${x.book ? ` · ${x.book}` : ''}`, sub: x.label, added: x.created_at, del: `stmt:${x.id}` });
  for (const r of st.rentSnapshots || []) rows.push({ prop: r.property_code, kind: 'Rent roll', detail: `${r.as_of ? fmtd(r.as_of) : ''} · ${r.units || '?'}u · mkt ${money(r.market_monthly)}/mo · in-place ${money(r.inplace_monthly)}/mo`, added: r.created_at, del: `rent:${r.id}` });
  for (const u of st.uwSnapshots || []) rows.push({ prop: u.property_code, kind: 'UW book', detail: `${u.units ?? ''}u · NOI ${money(u.noi)}`, sub: u.label, added: u.created_at, del: `uw:${u.id}` });
  for (const x of st.t12Snapshots || []) rows.push({ prop: x.property_code, kind: 'Seller T12', detail: `${x.period || ''}${x.book ? ` · ${x.book}` : ''}`, sub: x.label, added: x.created_at, del: `t12:${x.id}` });
  for (const p of st.payrollModels || []) rows.push({ prop: '', kind: 'Payroll model', detail: p.label, added: p.created_at, del: `payroll:${p.id}`, edit: p.id });
  for (const c of st.compSets || []) rows.push({ prop: '', kind: 'Comp set', detail: `${c.name}${c.period ? ` · ${c.period}` : ''}${c.book ? ` · ${c.book}` : ''}`, added: c.created_at, del: `comp:${c.id}` });
  if (!rows.length) return '<p class="muted">Nothing on file yet — drop a file above.</p>';
  rows.sort((a, b) => (a.prop || '~').localeCompare(b.prop || '~') || a.kind.localeCompare(b.kind) || new Date(b.added) - new Date(a.added));
  let last = null;
  return `<table class="list"><tr><th>Property</th><th>Data</th><th>Detail</th><th>Added</th><th></th></tr>
    ${rows.map((r) => { const first = r.prop !== last; last = r.prop; return `<tr>
      <td>${first ? `<b>${esc(r.prop || 'shared')}</b>` : ''}</td>
      <td>${esc(r.kind)}</td>
      <td>${esc(r.detail)}${r.sub ? `<div class="muted" style="font-size:10.5px">${esc(r.sub)}</div>` : ''}</td>
      <td class="muted">${fmtd(r.added)}</td>
      <td style="white-space:nowrap">${S.auth.isAdmin ? `${r.edit ? `<button class="rb" data-pmedit="${r.edit}" title="Edit the wage numbers in place — linked budgets regenerate">✎</button> ` : ''}<button class="rb" data-deld="${r.del}" title="Delete — budgets pointing at it re-point to the newest remaining upload and regenerate">🗑</button>` : ''}</td>
    </tr>`; }).join('')}</table>`;
}
function wireDataOnFile(el) {
  el.querySelectorAll('[data-deld]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const [kind, id] = b.dataset.deld.split(':');
    if (!confirm(`Delete this ${kind === 'payroll' ? 'payroll model' : kind + ' snapshot'}? Budgets pointing at it re-point to the newest remaining upload (or unlink if none is left) and regenerate.`)) return;
    const resp = await DEL(`/uploads/data/${kind}/${id}`);
    S.upload.msg = `Deleted · ${resp.repointed || 0} budget(s) re-pointed to the newest upload${(resp.unlinked || 0) > (resp.repointed || 0) ? `, ${resp.unlinked - resp.repointed} unlinked` : ''}`;
    await refreshState(); render();
  }));
  el.querySelectorAll('[data-pmedit]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openPayrollEditor(Number(b.dataset.pmedit)); }));
}

function newBudgetDialog() {
  const st = S.state;
  const dlg = document.getElementById('newdlg');
  const subjects = st.properties.filter((p) => p.role === 'subject');
  const yearNow = new Date().getFullYear() + 1;
  if (!S.newType) S.newType = (st.templates || []).length || !st.uwSnapshots.length ? 'annual' : 'new_acq';
  const annual = S.newType === 'annual';
  const nb = S.nb || (S.nb = {});           // selections survive the re-render after an inline upload
  const KIND_LABEL = { yardi_template: 'Yardi budget template (budgetYSR…xlsm)', rent_roll: 'rent roll', payroll: 'payroll model', statement: '12 Month Statement / Budget' };
  // a picker: select + an Upload button that parses, saves and selects the file right here
  const pick = (id, label, hint, uploadKind) => `
    <div class="fld" style="flex:1; min-width:240px"><label>${label}${hint ? ` <span class="muted">— ${hint}</span>` : ''}</label>
      <div class="row" style="gap:6px; flex-wrap:nowrap"><select id="${id}" style="flex:1; min-width:0"></select>${uploadKind ? `<button class="btn sub" data-up="${uploadKind}" data-for="${id}" title="Upload a ${KIND_LABEL[uploadKind]} and use it">⬆</button>` : ''}</div>
    </div>`;
  dlg.innerHTML = `
    <h2>New budget</h2>
    <div class="row" style="margin-bottom:10px; gap:16px">
      <label title="Calendar-year operating budget for a property Monarch already runs — levels from its own trailing-12 and the Yardi template rules; nothing ties automatically"><input type="radio" name="nb-type" value="annual" ${annual ? 'checked' : ''}> <b>Annual operating budget</b></label>
      <label title="UW Year 1 for a new acquisition: 12 ownership months from the start month, ties to the UW book"><input type="radio" name="nb-type" value="new_acq" ${!annual ? 'checked' : ''}> New acquisition (UW Year 1)</label>
    </div>
    ${annual ? `
    <div class="row">
      <div class="fld"><label>Property</label><select id="nb-prop">${subjects.map((p) => `<option value="${p.code}">${p.code} — ${esc(p.name)}</option>`).join('')}</select></div>
      <div class="fld"><label>Budget year</label><input id="nb-year" type="number" value="${nb.year || yearNow}" style="width:90px"></div>
    </div>
    <div class="row" style="margin-top:8px">
      ${pick('nb-py', 'Trailing-12 actuals by GL', 'the PY base — Yardi 12 Month Statement export, Nov–Oct', 'statement')}
      ${pick('nb-cyb', 'Current-year budget', 'optional comparison — 12 Month Budget export', 'statement')}
    </div>
    <div class="row" style="margin-top:8px">${pick('nb-tpl', 'Yardi budget template', 'optional — carries its own T12 + CY budget, debt schedule, Conservice forecasts; none pulls for 2027 yet', 'yardi_template')}</div>
    <p class="muted" id="nb-tplnote" style="font-size:11.5px; margin:4px 0 8px"></p>
    <div class="row">
      ${pick('nb-rent', 'Rent roll', 'GPR anchor, per-lease LTL, expirations, charges', 'rent_roll')}
      ${pick('nb-pay', 'Payroll model', 'wages', 'payroll')}
    </div>
    <p class="muted" style="font-size:11.5px; margin:10px 0 0">Every line starts as the same month last year × the GRKS foundation factor (admin 5%, maintenance 10%, reims 5%, utilities 5%), October-actual lines flat, GPR off the rent roll, vacancy at the October %, mgmt fee at the T12 %, debt off the template's schedule (else loan × rate in Assumptions, else the last actual month), payroll from the model. Nothing ties on its own — review the Δ columns.</p>` : `
    <div class="row">
      <div class="fld"><label>Property</label><select id="nb-prop">${subjects.map((p) => `<option value="${p.code}">${p.code} — ${esc(p.name)}</option>`).join('')}</select></div>
      <div class="fld"><label>Budget year</label><input id="nb-year" type="number" value="${nb.year || yearNow}" style="width:90px"></div>
    </div>
    <div class="row" style="margin-top:8px">
      ${pick('nb-uw', 'UW book', 'tie-out target', null)}
      ${pick('nb-rent', 'Rent roll', 'GPR anchor', 'rent_roll')}
    </div>
    <div class="row" style="margin-top:8px">
      ${pick('nb-comp', 'Comp set', 'line distribution', null)}
      ${pick('nb-t12', 'Seller T12', 'monthly shapes', null)}
      ${pick('nb-pay', 'Payroll model', 'wages', 'payroll')}
    </div>
    <p class="muted" style="font-size:11.5px; margin:8px 0 0">UW books, comp sets and seller statements are added on the Data page.</p>`}
    <div class="err" id="nb-err"></div>
    <div class="row" style="margin-top:12px; justify-content:flex-end">
      <button class="btn sub" id="nb-x">Cancel</button>
      <button class="btn" id="nb-go">Create &amp; generate</button>
    </div>
    <input type="file" id="nb-file" accept=".xlsx,.xls,.xlsm" style="display:none">`;
  const $ = (id) => dlg.querySelector('#' + id);
  const setSel = (id, opts, cur, fallback) => {
    const e = $(id); if (!e) return;
    e.innerHTML = `<option value="">— none —</option>` + opts;
    const want = cur != null && [...e.options].some((o) => o.value === String(cur)) ? String(cur) : (fallback != null ? String(fallback) : '');
    e.value = want;
  };
  const tplNote = () => {
    const n = $('nb-tplnote'); if (!n) return;
    const tpl = (st.templates || []).find((x) => String(x.id) === $('nb-tpl').value);
    const py = (st.stmtSnapshots || []).find((x) => String(x.id) === $('nb-py').value);
    n.textContent = tpl
      ? `The template carries the trailing-12 actuals${tpl.actual_period ? ` (${tpl.actual_period})` : ''} and the ${tpl.budget_year - 1} budget${tpl.budget_period ? ` (${tpl.budget_period})` : ''}${py ? ' — the statement picked above is used instead where it is set.' : '.'}`
      : py ? `Building off the ${py.period || ''} statement alone — GPR off the rent roll (or the October actual), expirations off the rent roll leases, debt from Assumptions (loan × rate) or the last actual month flat.`
      : 'Pick or upload the trailing-12 statement (⬆) — it is the PY base every line builds on.';
  };
  // a Nov–Oct statement budgets the year after its last month
  const yearFromPeriod = (period) => { const m = String(period || '').match(/(\d{4})\s*$/); return m ? Number(m[1]) + 1 : null; };
  const fillSnaps = () => {
    const code = $('nb-prop').value;
    const rents = st.rentSnapshots.filter((r) => r.property_code === code);
    setSel('nb-rent', rents.map((r) => `<option value="${r.id}">${r.as_of ? new Date(r.as_of).toLocaleDateString() : ''} · mkt ${money(r.market_monthly)}/mo${r.units ? ` · ${r.units}u` : ''}</option>`).join(''), nb.rent, rents[0]?.id);
    setSel('nb-pay', (st.payrollModels || []).map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join(''), nb.pay, (st.payrollModels || [])[0]?.id);
    if (annual) {
      const tpls = (st.templates || []).filter((x) => x.property_code === code);
      const pys = (st.stmtSnapshots || []).filter((x) => x.property_code === code && x.kind === 'actual');
      const cybs = (st.stmtSnapshots || []).filter((x) => x.property_code === code && x.kind === 'budget');
      // statements the template already carries are not offered twice
      const tplStmts = new Set(tpls.flatMap((x) => [x.py_stmt_id, x.cy_budget_stmt_id]).filter(Boolean).map(Number));
      const own = (list) => list.filter((x) => !tplStmts.has(Number(x.id)));
      setSel('nb-tpl', tpls.map((x) => `<option value="${x.id}">${esc(x.label)} (${x.budget_year})</option>`).join(''), nb.tpl, tpls[0]?.id);
      setSel('nb-py', own(pys).map((x) => `<option value="${x.id}">${esc(x.period || '')} · ${esc(x.label)}</option>`).join(''), nb.py, own(pys)[0]?.id);
      setSel('nb-cyb', own(cybs).map((x) => `<option value="${x.id}">${esc(x.period || '')} · ${esc(x.label)}</option>`).join(''), nb.cyb, own(cybs)[0]?.id);
      const tpl = tpls.find((x) => String(x.id) === $('nb-tpl').value);
      const py = pys.find((x) => String(x.id) === $('nb-py').value);
      if (!nb.year) $('nb-year').value = (tpl && tpl.budget_year) || (py && yearFromPeriod(py.period)) || yearNow;
      tplNote();
    } else {
      const uws = st.uwSnapshots.filter((u) => u.property_code === code);
      const t12s = (st.t12Snapshots || []).filter((x) => x.property_code === code);
      setSel('nb-uw', uws.map((u) => `<option value="${u.id}">${esc(u.label)} (NOI ${money(u.noi)})</option>`).join(''), nb.uw, uws[0]?.id);
      setSel('nb-t12', t12s.map((x) => `<option value="${x.id}">${esc(x.label)} (${esc(x.period)})</option>`).join(''), nb.t12, t12s[0]?.id);
      setSel('nb-comp', st.compSets.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join(''), nb.comp, null);
    }
  };
  // remember the form so an inline upload's re-render keeps what was chosen
  const remember = () => {
    const v = (id) => { const e = $(id); return e && e.value ? Number(e.value) : null; };
    Object.assign(nb, { prop: $('nb-prop').value, year: Number($('nb-year').value) || null, tpl: v('nb-tpl'), rent: v('nb-rent'), pay: v('nb-pay'), py: v('nb-py'), cyb: v('nb-cyb'), uw: v('nb-uw'), t12: v('nb-t12'), comp: v('nb-comp') });
  };
  // default to the property whose template was added most recently (annual) — the list is newest-first
  const firstSrc = annual ? [...(st.stmtSnapshots || []).filter((x) => x.kind === 'actual'), ...(st.templates || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).find((x) => subjects.some((p) => p.code === x.property_code)) : null;
  if (nb.prop && subjects.some((p) => p.code === nb.prop)) $('nb-prop').value = nb.prop;
  else if (firstSrc) $('nb-prop').value = firstSrc.property_code;
  fillSnaps();
  $('nb-prop').addEventListener('change', () => { nb.tpl = nb.rent = nb.py = nb.cyb = nb.uw = nb.t12 = null; nb.year = null; fillSnaps(); });
  if ($('nb-tpl')) $('nb-tpl').addEventListener('change', () => { const tpl = (st.templates || []).find((x) => String(x.id) === $('nb-tpl').value); if (tpl) $('nb-year').value = tpl.budget_year || yearNow; tplNote(); });
  if ($('nb-py')) $('nb-py').addEventListener('change', () => { const py = (st.stmtSnapshots || []).find((x) => String(x.id) === $('nb-py').value); const y = py && yearFromPeriod(py.period); if (y && !$('nb-tpl').value) $('nb-year').value = y; tplNote(); });
  dlg.querySelectorAll('input[name="nb-type"]').forEach((r) => r.addEventListener('change', () => { S.newType = r.value; S.nb = null; newBudgetDialog(); }));
  $('nb-x').addEventListener('click', () => dlg.close());
  // inline uploads: parse → save → re-render the dialog with the new file selected
  dlg.querySelectorAll('[data-up]').forEach((btn) => btn.addEventListener('click', () => {
    const file = $('nb-file');
    file.onchange = async () => {
      const f = file.files[0]; file.value = '';
      if (!f) return;
      remember();
      btn.disabled = true; btn.textContent = '…'; $('nb-err').textContent = '';
      try {
        const got = await dlgUpload(btn.dataset.up, f, nb.prop);
        await refreshState();
        if (got.propertyCode) nb.prop = got.propertyCode;
        if (got.templateId) { nb.tpl = got.templateId; nb.year = got.budgetYear || nb.year; }
        if (got.rentSnapshotId) nb.rent = got.rentSnapshotId;
        if (got.payrollModelId) nb.pay = got.payrollModelId;
        if (got.pyStmtId && btn.dataset.up === 'statement') nb.py = got.pyStmtId;
        if (got.cyBudgetStmtId && btn.dataset.up === 'statement') nb.cyb = got.cyBudgetStmtId;
        if (btn.dataset.up === 'statement' && !got.pyStmtId && !got.cyBudgetStmtId) got.warning = 'That file did not read as a 12 Month Statement or 12 Month Budget export.';
        newBudgetDialog();
        const err = got.warning ? got.warning : '';
        if (err) document.getElementById('newdlg').querySelector('#nb-err').textContent = err;
      } catch (e) { btn.disabled = false; btn.textContent = '⬆'; $('nb-err').textContent = e.message; }
    };
    file.click();
  }));
  $('nb-go').addEventListener('click', async () => {
    try {
      const v = (id) => { const e = $(id); return e ? (Number(e.value) || null) : null; };
      if (annual && !v('nb-tpl') && !v('nb-py')) throw new Error('Pick or upload the Yardi budget template (or a trailing-12 statement) first — it is the PY base every line builds on.');
      const bv = await POST('/budgets', {
        propertyCode: $('nb-prop').value,
        year: Number($('nb-year').value),
        budgetType: annual ? 'annual' : 'new_acq',
        uwSnapshotId: v('nb-uw'), compSetId: v('nb-comp'), rentSnapshotId: v('nb-rent'),
        t12SnapshotId: v('nb-t12'), payrollModelId: v('nb-pay'),
        templateId: v('nb-tpl'), pyStmtId: v('nb-py'), cyBudgetStmtId: v('nb-cyb'),
      });
      dlg.close(); S.nb = null;
      await refreshState();
      S.bv = bv; S.view = 'editor'; render();
    } catch (e) { $('nb-err').textContent = e.message; }
  });
  if (!dlg.open) dlg.showModal();
}

/* One-file upload from inside a dialog: parse, map to a property, save.
   Returns the ids created (propertyCode, templateId, pyStmtId, cyBudgetStmtId,
   rentSnapshotId, payrollModelId) so the caller can select them. */
async function dlgUpload(kind, file, currentProp) {
  const fd = new FormData();
  const known = (code) => code && S.state.properties.some((p) => p.code === code);
  if (kind === 'yardi_template' || kind === 'statement') {
    fd.append('files', file);
    const parsed = await api(`/uploads/parse-many?kind=${kind}`, { method: 'POST', body: fd });
    const f = parsed.files[0];
    if (f.error) throw new Error(f.error);
    let code = f.propertyGuess || guessProp(f.template?.name || f.statement?.label);
    if (kind === 'statement' && !code) code = currentProp;                 // untitled statement → the property being budgeted
    if (!code) throw new Error('Could not tell which property this file is for');
    const resp = await POST('/uploads/apply', { kind, filename: file.name, payload: parsed, mappings: [{ index: 0, propertyCode: code }], relink: false });
    const c = resp.created[0] || {};
    return { propertyCode: c.propertyCode || code, templateId: c.templateId, pyStmtId: c.pyStmtId, cyBudgetStmtId: c.cyBudgetStmtId, budgetYear: f.template?.budgetYear };
  }
  fd.append('file', file);
  const parsed = await api(`/uploads/parse?kind=${kind}`, { method: 'POST', body: fd });
  if (kind === 'rent_roll') {
    // the roll covers every property — save each one the chart knows, select the current one
    const mappings = parsed.properties.map((p) => ({ sourceCode: p.code, sourceName: p.name, propertyCode: known(p.code) ? p.code : guessProp(p.name) || null })).filter((m) => m.propertyCode);
    if (!mappings.length) throw new Error('No property in this rent roll matches the chart — upload it on the Data page to map by hand');
    const resp = await POST('/uploads/apply', { kind, filename: file.name, payload: parsed, mappings, relink: false });
    const mine = (resp.created || []).find((c) => c.propertyCode === currentProp);
    return { rentSnapshotId: mine?.id, warning: mine ? '' : `Rent roll saved for ${resp.created.length} propert${resp.created.length === 1 ? 'y' : 'ies'}, but ${currentProp} was not in it.` };
  }
  if (kind === 'payroll') {
    const resp = await POST('/uploads/apply', { kind, filename: file.name, payload: parsed, name: parsed.payroll?.label || file.name.replace(/\.xlsx?$/i, ''), relink: false });
    return { payrollModelId: resp.payrollModelId };
  }
  throw new Error(`Cannot upload a ${kind} here`);
}

async function openBudget(id) {
  S.bv = await GET(`/budgets/${id}`);
  S.view = 'editor';
  render();
}

/* ---------------- data (uploads) ---------------- */
const UPLOAD_KINDS = [
  ['yardi_template', 'Yardi budget template (budgetYSR…xlsm)'],
  ['rent_roll', 'Rent roll (Yardi summary, unit detail or lease charges)'],
  ['statement', 'Monarch 12 Month Statement / 12 Month Budget'],
  ['payroll', 'ND payroll model (wage aggregates)'],
  ['uw_book', 'UW book model (.xlsx)'],
  ['comparison', 'Property comparison (comp set)'],
  ['seller_t12', 'Seller T12 statement (monthly actuals)'],
];
function renderUploads(el) {
  const u = S.upload;
  const files = u.files || [];
  const multi = u.kind === 'yardi_template' || u.kind === 'statement';
  el.innerHTML = `
    <div class="card">
      <h2>Add data</h2>
      <div class="drop" id="drop" tabindex="0">
        <div><b>Drop files here</b> or <span class="link">choose files</span></div>
        <div class="muted" style="font-size:11.5px; margin-top:4px">Yardi budget templates · rent rolls · Monarch statements · payroll model · UW books · comp sets — the type is recognized from the file. Several templates or statements at once is fine.</div>
        <input type="file" id="up-file" accept=".xlsx,.xls,.xlsm" multiple style="display:none">
      </div>
      ${files.length ? `<div class="row" style="margin-top:10px; align-items:center">
        <span>${files.length === 1 ? esc(files[0].name) : `${files.length} files`}</span>
        <span class="muted">read as</span>
        <select id="up-kind">${UPLOAD_KINDS.map(([k, l]) => `<option value="${k}" ${u.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn sub" id="up-parse" ${u.busy ? 'disabled' : ''}>${u.busy ? 'Reading…' : 'Read again'}</button>
        <button class="rb" id="up-clear" title="Forget these files">✕</button>
      </div>` : ''}
      ${u.kind === 'yardi_template' && files.length ? '<p class="muted" style="font-size:11.5px">Everything in the template is read EXCEPT the pasted payroll roster (restricted — individual compensation never enters the tool). Each file saves the trailing-12 actuals, the current-year budget and the template facts (debt schedule, fee matrix, Conservice forecasts, corporate suggestions, lease expirations).</p>' : ''}
      ${u.err ? `<div class="err">${esc(u.err)}</div>` : ''}
      ${u.msg ? `<div class="ok">${esc(u.msg)}</div>` : ''}
      <div id="up-preview"></div>
    </div>
    <div class="card">
      <h2>On file</h2>
      ${dataOnFileHtml(S.state)}
    </div>
    <dialog class="assump" id="pm-dlg"></dialog>`;
  const drop = el.querySelector('#drop');
  const input = el.querySelector('#up-file');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); takeFiles([...e.dataTransfer.files]); });
  input.addEventListener('change', () => { takeFiles([...input.files]); input.value = ''; });
  const parse = async () => {
    const fs = S.upload.files || [];
    if (!fs.length) return;
    u.busy = true; u.err = ''; u.msg = ''; render();
    try {
      const fd = new FormData();
      if (u.kind === 'yardi_template' || u.kind === 'statement') {
        for (const f of fs) fd.append('files', f);
        u.parsed = await api(`/uploads/parse-many?kind=${u.kind}`, { method: 'POST', body: fd });
      } else {
        if (fs.length > 1) throw new Error(`A ${UPLOAD_KINDS.find((k) => k[0] === u.kind)[1]} is read one file at a time — drop the others separately`);
        fd.append('file', fs[0]);
        u.parsed = await api(`/uploads/parse?kind=${u.kind}`, { method: 'POST', body: fd });
      }
    } catch (e) { u.err = e.message; u.parsed = null; }
    u.busy = false; render();
  };
  async function takeFiles(fs) {
    if (!fs.length) return;
    u.files = fs; u.parsed = null; u.err = ''; u.msg = ''; u.busy = true; render();
    try {
      const fd = new FormData();
      for (const f of fs) fd.append('files', f);
      const det = await api('/uploads/detect', { method: 'POST', body: fd });
      const kinds = [...new Set(det.files.map((f) => f.kind).filter(Boolean))];
      if (kinds.length === 1 && det.files.every((f) => f.kind)) { u.kind = kinds[0]; await parse(); return; }
      u.busy = false;
      u.err = kinds.length > 1
        ? `These files are different types (${kinds.join(', ')}) — drop one type at a time.`
        : `Could not recognize ${det.files.filter((f) => !f.kind).map((f) => f.name || f.filename).join(', ')} — pick what it is and press Read again.`;
      render();
    } catch (e) { u.busy = false; u.err = e.message; render(); }
  }
  const kindSel = el.querySelector('#up-kind');
  if (kindSel) kindSel.addEventListener('change', (e) => { u.kind = e.target.value; u.parsed = null; u.err = ''; parse(); });
  const parseBtn = el.querySelector('#up-parse');
  if (parseBtn) parseBtn.addEventListener('click', parse);
  const clearBtn = el.querySelector('#up-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => { u.files = []; u.parsed = null; u.err = ''; u.msg = ''; render(); });
  if (u.parsed) renderUploadPreview(el.querySelector('#up-preview'), u.parsed);
  wireDataOnFile(el);
}

function propOptions(selected) {
  return `<option value="">— skip —</option>` + S.state.properties.map((p) =>
    `<option value="${p.code}" ${p.code === selected ? 'selected' : ''}>${p.code} — ${esc(p.name)}</option>`).join('');
}
function guessProp(text) {
  const t = String(text || '').toLowerCase();
  for (const p of S.state.properties) {
    if (t === p.code) return p.code;
    const words = String(p.name || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.length && words.every((w) => t.includes(w))) return p.code;
    if (t.includes(String(p.name || '').toLowerCase()) && p.name) return p.code;
  }
  for (const p of S.state.properties) {
    const first = String(p.name || '').toLowerCase().split(/\s+/)[0];
    if (first && first.length > 3 && t.includes(first)) return p.code;
  }
  return '';
}

function renderUploadPreview(el, parsed) {
  if (parsed.kind === 'yardi_template' || parsed.kind === 'statement') return renderAnnualUploadPreview(el, parsed);
  if (parsed.kind === 'uw_book') {
    el.innerHTML = `<h3>Sheets found — map each to a property</h3>
      <div class="mapping"><table class="list"><tr><th>Sheet</th><th>Units</th><th>UW EGI</th><th>UW NOI</th><th></th><th>Property</th></tr>
      ${parsed.sheets.map((s, i) => `<tr>
        <td>${esc(s.sheetName)}${s.isPortfolio ? '<span class="badge">portfolio</span>' : ''}</td>
        <td>${s.data.units || ''}</td><td>${money(s.data.egi)}</td><td>${money(s.data.noi)}</td><td></td>
        <td><select data-map="${i}">${propOptions(s.isPortfolio ? '' : guessProp(s.propertyGuess))}</select></td>
      </tr>`).join('')}</table></div>
      <div class="row" style="margin-top:10px"><button class="btn" id="up-apply">Save snapshots</button></div>`;
    el.querySelector('#up-apply').addEventListener('click', async () => {
      const mappings = [...el.querySelectorAll('[data-map]')].map((sel, i) => ({
        sheetName: parsed.sheets[Number(sel.dataset.map)].sheetName, propertyCode: sel.value || null,
      })).filter((m) => m.propertyCode);
      if (!mappings.length) { S.upload.err = 'Map at least one sheet to a property'; render(); return; }
      await POST('/uploads/apply', { kind: 'uw_book', filename: parsed.filename, payload: parsed, mappings });
      S.upload.msg = `Saved ${mappings.length} UW snapshot(s)`; S.upload.parsed = null;
      await refreshState(); render();
    });
  } else if (parsed.kind === 'rent_roll') {
    el.innerHTML = `<h3>Properties in this rent roll</h3>
      <div class="mapping"><table class="list"><tr><th>Source</th><th>Units</th><th>Leases</th><th>Market/mo</th><th>In-place/mo</th><th>As of</th><th>Property</th></tr>
      ${parsed.properties.map((p, i) => `<tr>
        <td>${esc(p.code || p.name)}</td><td>${p.units}</td>
        <td>${(p.leases || []).length ? `${p.leases.length} ✓` : '<span class="muted">summary</span>'}</td>
        <td>${money(p.marketMonthly)}</td><td>${money(p.inPlaceMonthly)}</td>
        <td>${esc(p.asOf || '')}</td>
        <td><select data-map="${i}">${propOptions(p.code && S.state.properties.some((x) => x.code === p.code) ? p.code : guessProp(p.name))}</select></td>
      </tr>`).join('')}</table></div>
      <div class="row" style="margin-top:10px">
        <label style="align-self:center" title="Point every existing budget of a mapped property at its new snapshot and regenerate — manual overrides and MROUNDs are kept; unit-level rolls switch LTL to the per-lease burnoff. GPR base and other inputs stay as-is.">
          <input type="checkbox" id="up-relink" checked> Relink existing budgets & regenerate</label>
        <button class="btn" id="up-apply">Save rent snapshots</button>
      </div>`;
    el.querySelector('#up-apply').addEventListener('click', async () => {
      const mappings = [...el.querySelectorAll('[data-map]')].map((sel) => {
        const src = parsed.properties[Number(sel.dataset.map)];
        return { sourceCode: src.code, sourceName: src.name, propertyCode: sel.value || null };
      }).filter((m) => m.propertyCode);
      if (!mappings.length) { S.upload.err = 'Map at least one row'; render(); return; }
      const relink = el.querySelector('#up-relink').checked;
      const resp = await POST('/uploads/apply', { kind: 'rent_roll', filename: parsed.filename, payload: parsed, mappings, relink });
      S.upload.msg = `Saved ${mappings.length} rent snapshot(s)${relink ? ` · relinked ${resp.relinked || 0} budget(s)` : ''}`; S.upload.parsed = null;
      await refreshState(); render();
    });
  } else if (parsed.kind === 'seller_t12') {
    const t = parsed.t12;
    el.innerHTML = `<h3>Seller T12 preview</h3>
      <p>${esc(t.label)} · ${esc(t.period)} · ${esc(t.book)} · ${t.rows.length} detail GL rows</p>
      <div class="row">
        <div class="fld"><label>Property</label><select id="t12-prop">${propOptions(guessProp(t.label))}</select></div>
        <button class="btn" id="up-apply">Save T12 snapshot</button>
      </div>
      <p class="muted">Monthly shapes from this statement drive seasonality for admin, payroll, marketing, utilities, insurance, taxes and utility/other income on budgets that link it.</p>`;
    el.querySelector('#up-apply').addEventListener('click', async () => {
      const code = el.querySelector('#t12-prop').value;
      if (!code) { S.upload.err = 'Pick a property'; render(); return; }
      await POST('/uploads/apply', { kind: 'seller_t12', filename: parsed.filename, payload: parsed, mappings: [{ propertyCode: code }] });
      S.upload.msg = 'T12 snapshot saved'; S.upload.parsed = null;
      await refreshState(); render();
    });
  } else if (parsed.kind === 'payroll') {
    const p = parsed.payroll;
    const subjects = S.state.properties.filter((x) => x.role === 'subject').map((x) => x.code);
    const rows = Object.entries(p.properties).filter(([code]) => subjects.includes(code));
    const gls = ['6402', '6404', '6405', '6407'];
    el.innerHTML = `<h3>Payroll model preview <span class="badge">property-level aggregates only</span></h3>
      <p>${p.employeeRows} roster rows aggregated. Individual compensation is never stored (org data policy).</p>
      ${p.unmappedPositions.length ? `<p class="err">Unmapped positions (defaulted to 6404): ${p.unmappedPositions.map(esc).join(', ')}</p>` : ''}
      <table class="list"><tr><th>Property</th><th>6402 Admin</th><th>6404 Maint</th><th>6405 Landscaping</th><th>6407 Rover</th><th>Total</th></tr>
      ${rows.map(([code, w]) => `<tr><td><b>${code}</b></td>${gls.map((g) => `<td>${money(w[g] || 0)}</td>`).join('')}<td><b>${money(gls.reduce((a, g) => a + (w[g] || 0), 0))}</b></td></tr>`).join('')}</table>
      <div class="row" style="margin-top:10px">
        <div class="fld"><label>Model name</label><input id="pm-name" value="${esc(parsed.filename.replace(/\.xlsx?$/i, ''))}" style="min-width:280px"></div>
        <label style="align-self:center" title="Point every budget of a property this model covers at the NEW model and regenerate — without this, budgets keep the old upload. Each budget's Data sources panel shows and can change which model it points at.">
          <input type="checkbox" id="pm-relink" checked> Relink existing budgets & regenerate</label>
        <button class="btn" id="up-apply">Save payroll model</button>
      </div>`;
    el.querySelector('#up-apply').addEventListener('click', async () => {
      const relink = el.querySelector('#pm-relink').checked;
      const resp = await POST('/uploads/apply', { kind: 'payroll', filename: parsed.filename, payload: parsed, name: el.querySelector('#pm-name').value, relink });
      S.upload.msg = `Payroll model saved${relink ? ` · relinked ${resp.relinked || 0} budget(s)` : ''}`; S.upload.parsed = null;
      await refreshState(); render();
    });
  } else if (parsed.kind === 'comparison') {
    const c = parsed.comparison;
    const guessUnits = c.properties
      .map((code) => S.state.properties.find((p) => p.code === code))
      .filter(Boolean).reduce((a, p) => a + (p.units || 0), 0);
    el.innerHTML = `<h3>Comp set preview ${c.monthly ? '<span class="badge">12-month budget — per-GL seasonality</span>' : ''}</h3>
      <p>${esc(c.label)} · ${esc(c.period)} · Book ${esc(c.book)} · ${c.monthly ? '' : `properties: <b>${c.properties.join(', ')}</b> · `}${c.rows.length} GL rows</p>
      <div class="row">
        <div class="fld"><label>Comp set name</label><input id="cs-name" value="${esc(c.label || parsed.filename)}" style="min-width:280px"></div>
        <div class="fld"><label>Total comp units (for $/unit basis)</label><input id="cs-units" value="${guessUnits || ''}" style="width:110px"></div>
        <button class="btn" id="up-apply">Save comp set</button>
      </div>
      ${c.monthly ? '<p class="muted">Line-level monthly shapes from this budget will drive seasonality; enter the comp portfolio\'s total units to enable the $/unit level basis.</p>' : ''}`;
    el.querySelector('#up-apply').addEventListener('click', async () => {
      await POST('/uploads/apply', {
        kind: 'comparison', filename: parsed.filename, payload: parsed,
        name: el.querySelector('#cs-name').value,
        units: Number(el.querySelector('#cs-units').value) || 0,
      });
      S.upload.msg = 'Comp set saved'; S.upload.parsed = null;
      await refreshState(); render();
    });
  }
}

/* ---------------- budget editor ---------------- */
function renderEditor(el) {
  const bv = S.bv;
  if (!bv) { el.innerHTML = '<p class="muted">No budget open.</p>'; return; }
  const b = bv.budget;
  const prop = S.state.properties.find((p) => p.code === b.property_code) || { name: b.property_code, units: 0 };
  const inp = b.inputs || {};
  const k = bv.kpis;
  const linesByGl = new Map(bv.lines.map((l) => [l.gl_code, l]));
  const totals = clientRollup(linesByGl);

  const labels = S.bv.monthLabels || MONTHS;
  const start = inp.startMonth || 1;
  const windowLabel = start > 1 ? `${labels[0]} – ${labels[11]}` : `${b.year}`;
  const acts = bv.actualMonths || [];
  el.innerHTML = `
    <div class="row" style="justify-content:space-between; margin-bottom:10px">
      <h2 style="margin:0">${esc(prop.name)} <span class="muted">(${esc(b.property_code)}) — ${bv.annual ? `${b.year} annual budget` : `Year 1 budget · ${windowLabel}`}</span>${bv.annual ? (() => { const t12 = (bv.refs || []).find((r) => r.key === 'actual'); return t12 ? ` <span class="badge" title="The property's own trailing-12 actuals drive every PY-based line; last actual month = ${MONTHS[(bv.lastMonth || 10) - 1]}">T12 ${esc(t12.period)}</span>${(bv.t12Missing || []).length ? ` <span class="badge" style="color:var(--bad)" title="No statement on file covers ${esc(bv.t12Missing.join(', '))} — those months are ZERO in the trailing-12, so every same-month line is zero there. Upload last year's 12 Month Statement (Data page or ⬆ in New budget) or export the statement for ${esc(t12.period)} directly.">⚠ T12 missing ${esc(bv.t12Missing.join(', '))}</span>` : ''}` : ' <span class="badge" style="color:var(--warn)" title="No trailing-12 statement linked — upload the Yardi budget template or a 12 Month Statement">⚠ no T12 statement</span>'; })() + (bv.template ? ` <span class="badge" title="Yardi budget template on file: debt schedule, fee matrix, Conservice utility forecasts, corporate suggestions, lease expirations">template ${esc(String(bv.template.budgetYear || ''))}</span>` : '') : ''}${acts.length ? ` <span class="badge" title="Closed months budgeted 1:1 to posted actuals">✓ actuals: ${acts.map((a) => esc(a.period)).join(', ')}</span>` : ''}</h2>
      <div class="row">
        <button class="btn sub" id="undo-btn" ${S.undo.budgetId === b.id && S.undo.stack.length ? '' : 'disabled'}>↶ Undo${S.undo.budgetId === b.id && S.undo.stack.length ? ` (${S.undo.stack.length})` : ''}</button>
        <button class="btn sub" id="recalc" title="Re-run every formula line on the current inputs (overrides kept)">↻ Recalc</button>
        <button class="btn sub" id="more-btn">⋯ More ▾</button>
        <button class="btn sub" id="ex-btn">⬇ Export ▾</button>
        <button class="btn" id="assump-open">⚙ Assumptions</button>
        <input type="file" id="imp-file" accept=".xlsx" style="display:none">
      </div>
    </div>
    <div class="kpis">
      ${kpiCard('Total income', k.income, prop.units)}
      ${kpiCard('Total expense', k.expense, prop.units)}
      ${kpiCard('NOI', k.noi, prop.units)}
      ${kpiCard('Interest', k.interest, prop.units)}
      ${kpiCard('Cash flow', k.cashFlow, prop.units)}
      <div class="kpi"><div class="lbl">Cash on cash</div><div class="val">${k.coc != null ? pctf(k.coc) : '—'}</div><div class="sub">${inp.capital ? 'on ' + money(inp.capital) : 'set capital'}</div></div>
    </div>
    <div class="editor${localStorage.getItem('bt-side') === '0' ? ' noside' : ''}">
      <div>
        <div class="legend">
          ${(() => {
            const used = new Set(bv.lines.filter((l) => l.months && l.months.some((v) => v)).map((l) => drvMeta(l).cls));
            if (acts.length) used.add('drv-act');
            const items = [['drv-rr', 'Rent roll / income'], ['drv-uw', 'UW tie'], ['drv-comp', 'Minot comps'], ['drv-pay', 'Payroll model'], ['drv-fee', '% of income'], ['drv-int', bv.annual ? 'Debt schedule / zero' : 'Interest'],
              ['drv-base', 'Own T12 × factor (foundation rule)'], ['drv-corp', 'Corporate rate / suggestion'], ['drv-t12', 'Seller stmt / recovery'], ['drv-man', 'Manual override'], ['drv-act', 'Posted actuals (locked month)']];
            return items.filter(([c]) => used.has(c)).map(([c, lb]) => `<span><span class="dot ${c}"></span>${lb}</span>`).join('');
          })()}
          <span class="muted">· click a row's chip to change its formula</span>
          ${(() => {
            const ov = bv.lines.filter((l) => l.override);
            if (!ov.length) return '';
            const fixed = ov.filter((l) => !l.driver || !l.driver.method || l.driver.method === 'manual' || l.driver.method === 'setTotal').length;
            return `<button class="rb" id="ovr-btn" title="Audit this budget's overridden lines — release old MROUND-locks back to live formulas">🔓 overrides: ${ov.length - fixed} formula · ${fixed} fixed</button>`;
          })()}
        </div>
        <div class="gridwrap">${gridHtml(bv, totals)}</div>
      </div>
      <div class="side">
        <div class="card">
          <h2>Monthly trend</h2>
          ${trendSvg(bv)}
        </div>
        <div class="card tie">
          <h2>${bv.annual ? `Compare to <select data-refsrc style="font-size:12px; margin-left:4px">
              <option value="actual" ${(inp.refSource || 'actual') === 'actual' ? 'selected' : ''}>Trailing-12 actuals</option>
              <option value="budget" ${inp.refSource === 'budget' ? 'selected' : ''} ${(bv.refs || []).some((r) => r.key === 'budget') ? '' : 'disabled'}>Current-year budget</option>
            </select>` : 'Tie-out vs UW'}</h2>
          ${acts.some((a) => a.index >= 0) ? `<p class="muted" style="margin:0 0 6px; font-size:11.5px">✓ ${acts.filter((a) => a.index >= 0).map((a) => esc(a.period)).join(', ')} locked to posted actuals — that month's actual-vs-plan gap shows here as variance.</p>` : ''}
          ${tieHtml(bv)}
        </div>
        <div class="card">
          <h2>Data sources</h2>
          <p class="muted" style="margin:0 0 6px; font-size:11.5px">Which uploads this budget points at. Change one → relink + regenerate (overrides kept).</p>
          ${dataLinksHtml(bv)}
        </div>
      </div>
    </div>
    <dialog class="assump" id="assump-dlg"></dialog>
    <dialog class="assump" id="round-dlg"></dialog>
    <dialog class="assump" id="copy-dlg"></dialog>
    <dialog class="assump" id="ovr-dlg"></dialog>
    <dialog class="assump" id="sp-dlg"></dialog>
    <dialog class="assump" id="act-dlg"></dialog>
    <dialog class="assump" id="actcsv-dlg"></dialog>`;

  // exports: cutoff (zero calendar months through) lives in the menu, remembered per session
  S.exCutoff = S.exCutoff || 0;
  const exportCsv = (yr) => window.open(`/api/budgets/${b.id}/export.csv?calYear=${yr}&cutoff=${S.exCutoff}`, '_blank');
  const exportAll = async () => {
    const urls = [
      `/api/budgets/${b.id}/export.csv?calYear=${b.year}&cutoff=${S.exCutoff}`,
      ...(start > 1 ? [`/api/budgets/${b.id}/export.csv?calYear=${b.year + 1}&cutoff=${S.exCutoff}`] : []),
      `/api/budgets/${b.id}/export.xlsx`,
    ];
    for (const u2 of urls) {
      const a = document.createElement('a');
      a.href = u2; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
      await new Promise((r) => setTimeout(r, 800));
    }
    S.bv = await GET(`/budgets/${b.id}`);   // pick up the export save point
    render();
  };
  document.getElementById('ex-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    popMenu(e.currentTarget, `
      <div class="rm-head">Export</div>
      <button data-x="all" title="The ${b.year} Yardi CSV${start > 1 ? `, the ${b.year + 1} Yardi CSV` : ''} and the Budget Draft workbook in one go — the budget is captured as a save point"><b>⬇ All exports</b></button>
      <button data-x="csv1">⬇ ${b.year} Yardi CSV${start > 1 ? ` (${labels[0]}–Dec)` : ''}</button>
      ${start > 1 ? `<button data-x="csv2">⬇ ${b.year + 1} Yardi CSV (Jan–${labels[11].split('-')[0]})</button>` : ''}
      <button data-x="xlsx">⬇ Review workbook (Budget Draft)</button>
      <label data-keep style="display:flex; gap:6px; align-items:center">CSV: zero months through <select data-cutoff style="font-size:12px"><option value="0">— none —</option>${MONTHS.slice(0, 11).map((m, i) => `<option value="${i + 1}" ${S.exCutoff === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <div class="rm-head" style="margin-top:4px">Bring back</div>
      <button data-x="imp" title="Upload an EDITED Budget Draft workbook — the current state is saved as its own iteration first, then every changed month imports as an override (IMP chip); Summary D27 updates capital">⬆ Import edited draft…</button>
      <button data-x="act" title="Partial-month rule: after a month closes, upload its Yardi Property Comparison (Cash) and that month is budgeted 1:1 to what posted — locked through recalcs and exports">✓ Actualize a closed month…${acts.length ? ` (${acts.length})` : ''}</button>`, (menu) => {
      menu.querySelector('[data-cutoff]').addEventListener('change', (ev) => { S.exCutoff = Number(ev.target.value) || 0; });
      menu.querySelector('[data-x="all"]').addEventListener('click', exportAll);
      menu.querySelector('[data-x="csv1"]').addEventListener('click', () => exportCsv(b.year));
      const c2 = menu.querySelector('[data-x="csv2"]'); if (c2) c2.addEventListener('click', () => exportCsv(b.year + 1));
      menu.querySelector('[data-x="xlsx"]').addEventListener('click', () => window.open(`/api/budgets/${b.id}/export.xlsx`, '_blank'));
      menu.querySelector('[data-x="imp"]').addEventListener('click', () => document.getElementById('imp-file').click());
      menu.querySelector('[data-x="act"]').addEventListener('click', () => openActualize(b));
    });
  });
  document.getElementById('more-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const anchor = e.currentTarget;
    const ov = bv.lines.filter((l) => l.override);
    const fixed = ov.filter((l) => !l.driver || !l.driver.method || l.driver.method === 'manual' || l.driver.method === 'setTotal').length;
    const sideOn = localStorage.getItem('bt-side') !== '0';
    popMenu(anchor, `
      <button data-x="sp" title="Named, permanent save points for this budget — capture the current iteration, restore any earlier one">⎘ Save points${(bv.savePoints || []).length ? ` (${bv.savePoints.length})` : ''}</button>
      <button data-x="round" title="Round selected lines' months to a multiple">⌁ MROUND lines…</button>
      <button data-x="copy" title="Replay another budget's named formulas here, re-evaluated on this property's own data">⧉ Copy formulas from another budget…</button>
      ${ov.length ? `<button data-x="ovr" title="Audit this budget's overridden lines — release old MROUND-locks back to live formulas">🔓 Overrides: ${ov.length - fixed} formula · ${fixed} fixed</button>` : ''}
      <div class="rm-head" style="margin-top:4px">View</div>
      <button data-x="cols">▦ Columns…</button>
      <button data-x="side">${sideOn ? '⏵ Hide side panel' : '⏴ Show side panel'}</button>
      <label><input type="checkbox" data-x="zero" ${S.showZero ? 'checked' : ''}> Show zero rows</label>
      <label title="Show each total row's monthly % of the year"><input type="checkbox" data-x="dist" ${S.showDist ? 'checked' : ''}> % distribution on totals</label>`, (menu) => {
      menu.querySelector('[data-x="sp"]').addEventListener('click', () => openSavePoints(b));
      menu.querySelector('[data-x="round"]').addEventListener('click', () => openRoundDialog(b));
      menu.querySelector('[data-x="copy"]').addEventListener('click', () => openCopyFormulas(b));
      const o = menu.querySelector('[data-x="ovr"]'); if (o) o.addEventListener('click', () => openOverridesAudit(b));
      menu.querySelector('[data-x="cols"]').addEventListener('click', () => setTimeout(() => openColsMenu(anchor, labels), 0));
      menu.querySelector('[data-x="side"]').addEventListener('click', () => { localStorage.setItem('bt-side', sideOn ? '0' : '1'); render(); });
      menu.querySelector('[data-x="zero"]').addEventListener('change', (ev) => { S.showZero = ev.target.checked; render(); });
      menu.querySelector('[data-x="dist"]').addEventListener('change', (ev) => { S.showDist = ev.target.checked; localStorage.setItem('bt-dist', S.showDist ? '1' : '0'); render(); });
    });
  });
  document.getElementById('imp-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!confirm(`Import "${f.name}" into this budget?\n\nThe current state is saved as its own iteration first; every month that differs in the workbook becomes an imported override.`)) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      S.bv = await POST(`/budgets/${b.id}/import-draft`, fd);
      const ir = S.bv.importResult || {};
      alert(`Imported: ${ir.changed || 0} line(s) updated${ir.capitalChanged ? ` · capital set to ${money(ir.capital)}` : ''}.\nPrior iteration saved under ⎘ Save points.`);
      render();
    } catch (e2) { alert('Import failed: ' + e2.message); }
    e.target.value = '';
  });
  document.getElementById('recalc').addEventListener('click', async () => { pushUndo(); S.bv = await POST(`/budgets/${b.id}/recalc`); render(); });
  document.getElementById('undo-btn').addEventListener('click', () => doUndo(b.id));
  // condensed section headers: click toggles, choice is locked in localStorage
  el.querySelectorAll('tr.header[data-sec]').forEach((tr) => tr.addEventListener('click', () => {
    const sec = tr.dataset.sec;
    if (S.gridCollapsed.has(sec)) S.gridCollapsed.delete(sec); else S.gridCollapsed.add(sec);
    localStorage.setItem('bt-collapse', JSON.stringify([...S.gridCollapsed]));
    S.gridScroll = { top: el.querySelector('.gridwrap').scrollTop, left: el.querySelector('.gridwrap').scrollLeft };
    render();
  }));
  // data-sources pickers: repoint a snapshot link, then regenerate (inputs:{}
  // forces the regen; overrides and MROUNDs are kept)
  el.querySelectorAll('[data-link]').forEach((sel) => sel.addEventListener('change', async () => {
    pushUndo();
    const body = { inputs: {} };
    body[sel.dataset.link] = sel.value ? Number(sel.value) : null;
    S.bv = await PUT(`/budgets/${b.id}`, body);
    render();
  }));
  // annual: which reference the tie-out compares to (+ typed targets)
  const refSel = el.querySelector('[data-refsrc]');
  if (refSel) refSel.addEventListener('change', async () => { pushUndo(); S.bv = await PUT(`/budgets/${b.id}`, { inputs: { refSource: refSel.value } }); render(); });
  el.querySelectorAll('[data-target]').forEach((box) => box.addEventListener('change', async () => {
    const t = { ...((S.bv.budget.inputs || {}).targets || {}) };
    const v = parseFloat(String(box.value).replace(/[$,]/g, ''));
    t[box.dataset.target] = Number.isFinite(v) ? v : null;
    pushUndo(); S.bv = await PUT(`/budgets/${b.id}`, { inputs: { targets: t } }); render();
  }));
  el.querySelectorAll('.trend-chip').forEach((chip) => chip.addEventListener('click', () => {
    const sel = trendSeriesSel();
    if (sel.has(chip.dataset.trend)) sel.delete(chip.dataset.trend); else sel.add(chip.dataset.trend);
    localStorage.setItem('bt-trend', JSON.stringify([...sel]));
    render();
  }));
  document.getElementById('assump-open').addEventListener('click', () => {
    const dlg = document.getElementById('assump-dlg');
    dlg.innerHTML = `
      <h2>Assumptions — ${esc(prop.name)} (${esc(b.property_code)}) ${b.year}</h2>
      ${inputsHtml(S.bv.budget.inputs || {})}
      <div class="err" id="assump-err"></div>
      <div class="foot">
        <span class="muted" style="align-self:center; margin-right:auto; font-size:11.5px">Apply recomputes every non-overridden line; manual cell edits (purple) are kept.</span>
        <button class="btn sub" id="assump-x">Cancel</button>
        <button class="btn" id="inp-apply">Apply & regenerate</button>
      </div>`;
    dlg.querySelector('#assump-x').addEventListener('click', () => dlg.close());
    dlg.querySelector('#inp-apply').addEventListener('click', async () => {
      const btn = dlg.querySelector('#inp-apply');
      btn.disabled = true; btn.textContent = 'Applying…';
      try {
        await applyInputs(b, dlg);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Apply & regenerate';
        const errEl = dlg.querySelector('#assump-err');
        if (errEl) errEl.textContent = 'Not saved: ' + e.message;
      }
    });
    dlg.showModal();
  });

  /* Month-cell editing is ROW-BUFFERED for fast tabbing: focus selects the
     cell's text (type to replace, no ctrl+a), Tab moves along the row with no
     server round-trip, and the row saves ONCE when focus leaves it (or on
     Enter). Hidden-column safe: the buffer starts from the line data. */
  const commitRow = async () => {
    const p = S.pendingRow;
    if (!p || !p.dirty) { S.pendingRow = null; return; }
    S.pendingRow = null;
    pushUndo();
    S.bv = await PUT(`/budgets/${b.id}/lines/${p.gl}`, { months: p.months });
    render();
  };
  const gridwrapEl = el.querySelector('.gridwrap');
  el.querySelectorAll('td.m input').forEach((box) => {
    box.addEventListener('focus', () => {
      box.select();
      const gl = box.dataset.gl;
      if (S.pendingRow && S.pendingRow.gl !== gl && S.pendingRow.dirty) commitRow();
      if (!S.pendingRow || S.pendingRow.gl !== gl) {
        const line = S.bv.lines.find((l) => l.gl_code === gl);
        S.pendingRow = { gl, months: (line ? line.months : Array(12).fill(0)).slice(), dirty: false };
      }
    });
    box.addEventListener('input', () => {
      const p = S.pendingRow;
      if (!p || p.gl !== box.dataset.gl) return;
      p.months[Number(box.dataset.i)] = parseFloat(String(box.value).replace(/,/g, '')) || 0;
      p.dirty = true;
    });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); box.blur(); commitRow(); } });
  });
  if (gridwrapEl) {
    gridwrapEl.addEventListener('focusout', (e) => {
      const t = e.target;
      if (!t || !t.matches || !t.matches('td.m input')) return;
      const to = e.relatedTarget;
      const sameRow = to && to.matches && to.matches('td.m input') && to.dataset.gl === t.dataset.gl;
      if (!sameRow) commitRow();
    });
    if (S.gridScroll) { gridwrapEl.scrollTop = S.gridScroll.top; gridwrapEl.scrollLeft = S.gridScroll.left; }
  }
  el.querySelectorAll('td.note input').forEach((box) => {
    box.addEventListener('change', async () => {
      S.bv = await PUT(`/budgets/${b.id}/lines/${box.dataset.gl}`, { note: box.value });
    });
  });
  /* Year-1 total editing: type a new annual total and the months rescale
     proportionally — the line's distribution flows backwards from the total. */
  el.querySelectorAll('td.ann input').forEach((box) => {
    box.addEventListener('focus', () => box.select());
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); box.blur(); } });
    box.addEventListener('change', async () => {
      const gl = box.dataset.ann;
      const target = parseFloat(String(box.value).replace(/[$,]/g, ''));
      if (!Number.isFinite(target)) { render(); return; }
      const line = S.bv.lines.find((l) => l.gl_code === gl);
      const old = line ? line.months.reduce((a, v) => a + v, 0) : 0;
      let months;
      if (Math.abs(old) > 0.005) {
        months = line.months.map((v) => Math.round((v * target / old) * 100) / 100);
      } else {
        months = Array(12).fill(Math.round((target / 12) * 100) / 100); // no shape to keep — spread flat
      }
      // penny-fix the largest month so the total is exact
      const drift = Math.round((target - months.reduce((a, v) => a + v, 0)) * 100) / 100;
      if (drift) {
        const bi = months.reduce((mi, v, i) => Math.abs(v) > Math.abs(months[mi]) ? i : mi, 0);
        months[bi] = Math.round((months[bi] + drift) * 100) / 100;
      }
      // keep the underlying formula's identity: "TOTAL on a WAVG shape", not a bare manual
      const prev = line && line.driver && line.driver.method && line.driver.method !== 'manual' ? line.driver : null;
      const driver = { method: 'setTotal', total: target };
      if (prev) {
        driver.of = prev.method === 'setTotal' ? (prev.of || null) : prev.method;
        if (prev.srcName || prev.name) driver.srcName = prev.srcName || prev.name;
      }
      pushUndo();
      S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { months, driver });
      render();
    });
  });
  el.querySelectorAll('[data-unlock]').forEach((btn) => btn.addEventListener('click', async () => {
    pushUndo();
    S.bv = await PUT(`/budgets/${b.id}/lines/${btn.dataset.unlock}`, { override: false });
    S.bv = await POST(`/budgets/${b.id}/recalc`);
    render();
  }));
  el.querySelectorAll('[data-tools]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openRowTools(b, btn.dataset.tools, btn);
  }));
  // inline formula params: change → patch inputs → regenerate
  el.querySelectorAll('input.fxp').forEach((box) => box.addEventListener('change', async () => {
    const gl = box.dataset.fxp;
    const line = S.bv.lines.find((l) => l.gl_code === gl);
    const prm = paramFor(gl, line, S.bv.budget.inputs || {});
    if (!prm) return;
    const v = parseFloat(String(box.value).replace(/,/g, ''));
    if (!Number.isFinite(v)) return;
    pushUndo();
    S.bv = await PUT(`/budgets/${b.id}`, { inputs: prm.patch(v) });
    render();
  }));
  // annual growth targets: typing saves the target; "tie" applies it
  const tieGrowth = async (key, pct) => { pushUndo(); S.bv = await POST(`/budgets/${b.id}/tie-growth`, { pcode: key, pct }); render(); };
  el.querySelectorAll('.tie [data-gt]').forEach((box) => box.addEventListener('change', async () => {
    const gtNew = { ...((S.bv.budget.inputs || {}).growthTargets || {}) };
    const v = parseFloat(String(box.value).replace(/[%\s]/g, ''));
    if (Number.isFinite(v)) gtNew[box.dataset.gt] = v / 100; else delete gtNew[box.dataset.gt];
    S.bv = await PUT(`/budgets/${b.id}`, { inputs: { growthTargets: gtNew } }); render();
  }));
  el.querySelectorAll('.tie [data-tie]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const box = el.querySelector(`.tie [data-gt="${btn.dataset.tie}"]`);
    const v = box ? parseFloat(String(box.value).replace(/[%\s]/g, '')) : NaN;
    tieGrowth(btn.dataset.tie, Number.isFinite(v) ? v / 100 : null).catch((err) => alert(err.message));
  }));
  const tieAll = el.querySelector('#tie-all');
  if (tieAll) tieAll.addEventListener('click', async (e) => {
    e.stopPropagation();
    const gtAll = (S.bv.budget.inputs || {}).growthTargets || {};
    const order = [...Object.keys(gtAll).filter((k) => k !== 'opex' && k !== 'noi'), ...['opex', 'noi'].filter((k) => gtAll[k] != null)];
    pushUndo();
    try { for (const k of order) if (gtAll[k] != null) S.bv = await POST(`/budgets/${b.id}/tie-growth`, { pcode: k, pct: gtAll[k] }); }
    catch (err) { alert(err.message); }
    render();
  });
  el.querySelectorAll('.tie .rb:not(.basis)').forEach((btn) => btn.addEventListener('click', async (e) => {
    if (btn.dataset.tie || btn.id === 'tie-all') return;
    if (btn.dataset.noi) { e.stopPropagation(); return openTieNoiMenu(b, btn); }
    if (btn.dataset.egi) { e.stopPropagation(); return openTieIncomeMenu(b, btn); }
    pushUndo();
    S.bv = await POST(`/budgets/${b.id}/rebalance`, { pcode: btn.dataset.p });
    render();
  }));
  el.querySelectorAll('.tie .rb.basis').forEach((btn) => btn.addEventListener('click', async () => {
    pushUndo();
    const p = btn.dataset.b;
    const cur = { ...((S.bv.budget.inputs || {}).catBasis || {}) };
    cur[p] = cur[p] === 'perUnit' ? 'uw' : 'perUnit';
    S.bv = await PUT(`/budgets/${b.id}`, { inputs: { catBasis: cur } });
    render();
  }));
}

function kpiCard(label, val, units) {
  return `<div class="kpi"><div class="lbl">${label}</div><div class="val ${val < 0 ? 'neg' : ''}">${money(val)}</div>
    <div class="sub">${units ? money(val / units) + ' /unit' : ''}</div></div>`;
}

/* client-side rollup for grid total rows (same ranges as shared/domain.ts) */
const RANGE_TOTALS = {
  5004: [4994, 5003], 5029: [5018, 5028], 5049: [5031, 5048], 5190: [5101, 5189],
  6170: [6101, 6169], 6370: [6301, 6369], 6399: [6374, 6398], 6470: [6401, 6469],
  6570: [6501, 6569], 6670: [6601, 6669], 6770: [6701, 6769], 6870: [6801, 6869],
  6970: [6901, 6969], 7070: [7001, 7069], 7315: [7300, 7314], 7500: [7321, 7499],
  8602: [8500, 8601], 8950: [8901, 8949],
};
function clientRollup(linesByGl) {
  const t = new Map();
  const z = () => Array(12).fill(0);
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const sumRange = (lo, hi) => {
    let acc = z();
    for (const [gl, l] of linesByGl) {
      const n = parseInt(gl, 10);
      if (n >= lo && n <= hi) acc = add(acc, l.months);
    }
    return acc;
  };
  for (const [code, [lo, hi]] of Object.entries(RANGE_TOTALS)) t.set(code, sumRange(lo, hi));
  const g = (c) => t.get(String(c)) || z();
  t.set('5070', add(add(g(5004), g(5029)), g(5049)));
  t.set('5500', add(g(5070), g(5190)));
  t.set('7098', add(add(g(6770), g(6870)), add(g(6970), g(7070))));
  t.set('7099', [g(6170), g(6370), g(6399), g(6470), g(6570), g(6670), g(7098)].reduce(add, z()));
  t.set('7279', g(7099));
  t.set('7280', sub(g(5500), g(7279)));
  t.set('8200', sub(sub(g(7280), g(7315)), g(7500)));
  t.set('9000', sub(sub(g(8200), g(8602)), g(8950)));
  return t;
}

function gridHtml(bv, totals) {
  const coa = S.state.coa;
  const linesByGl = new Map(bv.lines.map((l) => [l.gl_code, l]));
  const labels = bv.monthLabels || MONTHS;
  const hide = S.hiddenCols;
  const showM = (i) => !hide.has('m' + i);
  const monthIdx = Array.from({ length: 12 }, (_, i) => i).filter(showM);
  // annual: reference columns (T12 actuals, CY budget) beside the year total
  const refA = bv.annual ? (bv.refs || []).find((r) => r.key === 'actual') : null;
  const refB = bv.annual ? (bv.refs || []).find((r) => r.key === 'budget') : null;
  const cols = { fx: !hide.has('fx'), annual: !hide.has('annual'), ref1: !!refA && !hide.has('ref1'), ref2: !!refB && !hide.has('ref2'), punit: !hide.has('punit'), note: !hide.has('note') };
  const span = 2 + (cols.fx ? 1 : 0) + monthIdx.length + (cols.annual ? 1 : 0) + (cols.ref1 ? 1 : 0) + (cols.ref2 ? 1 : 0) + (cols.punit ? 1 : 0) + (cols.note ? 1 : 0);
  const actIdx = new Set((bv.actualMonths || []).filter((a) => a.index >= 0).map((a) => a.index));   // months locked to posted actuals (declared BEFORE the header row uses it)
  const refCell = (ref, code, kind) => {
    if (!ref) return '';
    const v = kind === 'total' ? ref.totals[code] : ref.byGl[code];
    return `<td class="ref ${v < 0 ? 'neg' : ''}">${v ? money(v) : ''}</td>`;
  };
  const refCells = (code, kind) => `${cols.ref1 ? refCell(refA, code, kind) : ''}${cols.ref2 ? refCell(refB, code, kind) : ''}`;
  const rows = [];
  rows.push(`<tr><th class="l">GL</th><th class="l" style="min-width:200px">Account</th>${cols.fx ? '<th>Fx</th>' : ''}${monthIdx.map((i) => `<th${actIdx.has(i) ? ' class="actcol" title="Locked to posted actuals — an edit here corrects the posted figure"' : ''}>${labels[i]}${actIdx.has(i) ? ' ✓' : ''}</th>`).join('')}${cols.annual ? `<th>${bv.annual ? bv.budget.year : 'Year 1'}</th>` : ''}${cols.ref1 ? `<th title="${esc(refA.period)}">T12</th>` : ''}${cols.ref2 ? `<th title="${esc(refB.period)}">${esc(refB.label.replace(/ budget$/i, ' bud'))}</th>` : ''}${cols.punit ? '<th>$/Unit</th>' : ''}${cols.note ? '<th class="l">Note</th>' : ''}</tr>`);
  const units = Number(bv.budget.inputs?.units) || 1;
  const GRAND = new Set(['5500', '7279', '7280', '8200', '9000']);
  // condensed (collapsed) sections — locked via localStorage across renders
  if (!S.gridCollapsed) S.gridCollapsed = new Set(JSON.parse(localStorage.getItem('bt-collapse') || '[]'));
  let secCollapsed = false;
  for (const a of coa) {
    if (!a.active) {
      // an inactive GL may only vanish when it carries NOTHING — a hidden row
      // with dollars would inflate totals invisibly (recalc zeroes it)
      const l0 = linesByGl.get(a.code);
      if (!(l0 && l0.months.some((v) => v))) continue;
    }
    // special projects: ALWAYS visible (even at zero — they're entered manually
    // per site) and every cell orange so the section reads as "fill me in"
    const sp = a.section === 'special_projects';
    if (a.kind === 'header') {
      secCollapsed = S.gridCollapsed.has(a.code);
      rows.push(`<tr class="header${sp ? ' sp' : ''}" data-sec="${a.code}" style="cursor:pointer" title="Click to condense / expand this section — stays condensed until you reopen it">
        <td class="code">${a.code}</td><td class="name" colspan="${span - 1}">${secCollapsed ? '▸' : '▾'} ${esc(a.name)}${secCollapsed ? ' <span class="badge">condensed — totals still shown</span>' : ''}</td></tr>`);
      continue;
    }
    if (a.kind === 'total') {
      const m = totals.get(a.code) || Array(12).fill(0);
      const ann = sumM(m);
      if (!S.showZero && !ann && !m.some((v) => v) && !sp) continue;
      rows.push(`<tr class="total ${GRAND.has(a.code) ? 'grand' : ''}${sp ? ' sp' : ''}"><td class="code">${a.code}</td><td class="name">${esc(a.name)}</td>
        ${cols.fx ? '<td></td>' : ''}
        ${monthIdx.map((i) => `<td class="${m[i] < 0 ? 'neg' : ''}">${money(m[i])}</td>`).join('')}
        ${cols.annual ? `<td class="${ann < 0 ? 'neg' : ''}"><b>${money(ann)}</b></td>` : ''}
        ${refCells(a.code, 'total')}
        ${cols.punit ? `<td>${money(ann / units)}</td>` : ''}
        ${cols.note ? '<td></td>' : ''}</tr>`);
      if (S.showDist && ann) {
        rows.push(`<tr class="dist"><td></td><td class="name">% of ${bv.annual ? bv.budget.year : 'Year 1'}</td>
          ${cols.fx ? '<td></td>' : ''}
          ${monthIdx.map((i) => `<td>${((m[i] / ann) * 100).toFixed(1)}%</td>`).join('')}
          ${cols.annual ? '<td>100%</td>' : ''}${cols.ref1 ? '<td></td>' : ''}${cols.ref2 ? '<td></td>' : ''}${cols.punit ? '<td></td>' : ''}${cols.note ? '<td></td>' : ''}</tr>`);
      }
      continue;
    }
    if (secCollapsed) continue;   // condensed section: detail rows hidden, totals stay
    const l = linesByGl.get(a.code);
    const m = l ? l.months : Array(12).fill(0);
    const ann = sumM(m);
    // annual: a GL with history (T12 / CY budget) but no budget stays visible — that's a decision to see
    const hasRef = (refA && refA.byGl[a.code]) || (refB && refB.byGl[a.code]);
    const isZero = !ann && !m.some((v) => v) && !(l && l.note) && !hasRef;
    if (isZero && !S.showZero && !sp) continue;
    const dm = drvMeta(l && (ann || l.override) ? l : null);
    const prm = cols.fx && l && !l.override ? paramFor(a.code, l, bv.budget.inputs || {}) : null;
    // seller-derived lines get a non-accrual flag when the billing looks bad
    const smell = sellerDerived(l) ? billingSmell(m) : null;
    const trCls = [sp ? 'sp' : '', smell ? 'badbills' : ''].filter(Boolean).join(' ');
    rows.push(`<tr${trCls ? ` class="${trCls}"` : ''}>
      <td class="code">${a.code}</td>
      <td class="name" title="${esc(a.name)} ${a.pcode ? '· cat ' + a.pcode : ''}">${esc(a.name)}${smell ? ` <span class="warnflag" title="Seller billing looks NON-ACCRUAL: ${esc(smell.join('; '))}. Likely bad bills — review, or smooth via WAVG / flat / Minot seasonal.">⚠</span>` : ''}${a.active === false ? ' <span class="badge" title="Deactivated GL still carrying dollars — Recalc zeroes it">inactive — recalc to zero</span>' : ''}${l && l.override ? ` <button class="rb" data-unlock="${a.code}" title="Clear manual override">🔓</button>` : ''}</td>
      ${cols.fx ? `<td style="white-space:nowrap"><button class="drv ${dm.cls}" data-tools="${a.code}" title="${esc(dm.label)} — click to change">${dm.tag}</button>${l && l.round ? `<span class="rnd" title="Standing MROUND to $${l.round} — re-applies on regeneration">≈${l.round}</span>` : ''}${prm ? `<input class="fxp" data-fxp="${a.code}" value="${prm.value}" title="${esc(prm.label)} — Enter applies & regenerates">` : ''}</td>` : ''}
      ${monthIdx.map((i) => `<td class="m ${actIdx.has(i) ? 'drv-act' : sp ? '' : dm.cls}"><input data-gl="${a.code}" data-i="${i}" value="${m[i] ? money2(m[i]) : ''}"></td>`).join('')}
      ${cols.annual ? `<td class="ann ${ann < 0 ? 'neg' : ''}"><input data-ann="${a.code}" value="${ann ? money2(ann) : ''}" title="${bv.annual ? bv.budget.year : 'Year 1'} total — type a new total and the months rescale proportionally (distribution kept)"></td>` : ''}
      ${refCells(a.code, 'detail')}
      ${cols.punit ? `<td>${ann ? money(ann / units) : ''}</td>` : ''}
      ${cols.note ? `<td class="note"><input data-gl="${a.code}" value="${esc(l ? l.note : '')}" placeholder="note"></td>` : ''}
    </tr>`);
  }
  return `<table class="grid">${rows.join('')}</table>`;
}

/* Inline SVG chart of monthly Income / Expense / NOI. Legend chips TOGGLE the
   series, and the y-axis is fitted tight to the visible values (not anchored
   at zero) so monthly variation is actually readable. */
function trendSeriesSel() {
  if (!S.trendSeries) S.trendSeries = new Set(JSON.parse(localStorage.getItem('bt-trend') || '["NOI"]'));
  return S.trendSeries;
}
function trendSvg(bv) {
  const mo = (bv.kpis && bv.kpis.monthly) || {};
  const ref = bv.refMonthly || null;
  const ALL = [
    { name: 'Income', vals: mo.income || [], ref: ref && ref.income, color: 'var(--good)' },
    { name: 'Expense', vals: mo.expense || [], ref: ref && ref.expense, color: 'var(--bad)' },
    { name: 'NOI', vals: mo.noi || [], ref: ref && ref.noi, color: 'var(--accent)' },
  ].filter((s) => s.vals.length === 12);
  if (!ALL.length) return '<p class="muted">No data.</p>';
  const sel = trendSeriesSel();
  const series = ALL.filter((s) => sel.has(s.name));
  const labels = bv.monthLabels || MONTHS;
  const W = 396, H = 150, padL = 44, padR = 8, padT = 10, padB = 20;
  let body = '';
  if (series.length) {
    // the axis always includes zero: a budget whose months all move together
    // (flat payroll, a growth tie) must visibly move, not be re-zoomed into
    // the same picture. The reference months (dashed) sit on the same scale.
    const all = series.flatMap((s) => [...s.vals, ...((s.ref && s.ref.length === 12) ? s.ref : [])]);
    let min = Math.min(0, ...all), max = Math.max(0, ...all);
    if (max - min < 1) max = min + 1;
    const span = max - min;
    max += span * 0.08; if (min < 0) min -= span * 0.08;
    const x = (i) => padL + (i * (W - padL - padR)) / 11;
    const y = (v) => padT + (H - padT - padB) * (1 - (v - min) / (max - min));
    const poly = (vals, color, dashed) => `<polyline fill="none" stroke="${color}" stroke-width="${dashed ? 1.2 : 2}" ${dashed ? 'stroke-dasharray="3 3" opacity=".6"' : ''} points="${vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`;
    const lines = series.map((s) =>
      (s.ref && s.ref.length === 12 ? poly(s.ref, s.color, true) + s.ref.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.6" fill="${s.color}" opacity=".6"><title>${s.name} ${ref.label} ${labels[i]}: ${money(v)}</title></circle>`).join('') : '') +
      poly(s.vals, s.color, false) +
      s.vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.4" fill="${s.color}"><title>${s.name} ${labels[i]}: ${money(v)}${s.ref && s.ref.length === 12 ? ` (${ref.label} ${money(s.ref[i])}, Δ ${money(v - s.ref[i])})` : ''}</title></circle>`).join('')
    ).join('');
    const fmtAxis = (v) => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v);
    const gridY = [0, (min + max) / 2, max - span * 0.08].filter((v, i, a) => a.indexOf(v) === i);
    const axis = gridY.map((v) =>
      `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="var(--line)" stroke-dasharray="2 4"/>` +
      `<text x="${padL - 4}" y="${y(v) + 3}" font-size="9" fill="var(--dim)" text-anchor="end">${fmtAxis(v)}</text>`).join('');
    const ticks = [0, 3, 6, 9, 11].map((i) => `<text x="${x(i)}" y="${H - 5}" font-size="9" fill="var(--dim)" text-anchor="middle">${labels[i]}</text>`).join('');
    body = `${axis}${lines}${ticks}`;
  } else {
    body = `<text x="${W / 2}" y="${H / 2}" font-size="11" fill="var(--dim)" text-anchor="middle">pick a series below</text>`;
  }
  const legend = ALL.map((s) => `
    <button class="trend-chip ${sel.has(s.name) ? 'on' : ''}" data-trend="${s.name}" style="--c:${s.color}">
      <span style="display:inline-block;width:10px;height:3px;background:${s.color};vertical-align:3px;margin-right:4px"></span>${s.name}</button>`).join('')
    + (ref ? `<span class="muted" style="font-size:10.5px">dashed = ${esc(ref.label)} by month</span>` : '');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; display:block">${body}</svg><div style="margin-top:5px">${legend}</div>`;
}

/* Inline formula parameter for a row: shown next to the Fx chip so e.g.
   vacancy % is adjustable without opening Assumptions. Returns null when the
   row's formula has no single adjustable number. */
function paramFor(gl, line, inp) {
  const m = line && line.driver ? line.driver.method : null;
  const pct = (v) => (v == null ? '' : +(v * 100).toFixed(2));
  /* ---- annual (template) rules ---- */
  if (m === 'baseline') {
    const bl = inp.baseline || {};
    return { label: 'increase factor %', value: pct(line.driver.pct || 0), patch: (v) => ({ baseline: { ...bl, glGrowth: { ...(bl.glGrowth || {}), [gl]: v / 100 } } }) };
  }
  if (m === 'pctGpr' || m === 'recapture') {
    return { label: m === 'recapture' ? 'recapture %' : `% of ${line.driver.of === 'net' ? 'net rent' : line.driver.of === 'netgpr' ? 'net GPR' : 'GPR'}`, value: +((line.driver.pct || 0) * 100).toFixed(3), patch: (v) => ({ pctGpr: { ...(inp.pctGpr || {}), [gl]: v / 100 } }) };
  }
  if (m === 'perTurn') {
    return { label: '$ per move-in', value: line.driver.amount || 0, patch: (v) => ({ turnFees: { ...(inp.turnFees || {}), [gl]: v } }) };
  }
  if (m === 'corpRate') {
    return { label: '$/unit/yr', value: line.driver.perUnitYr || 0, patch: (v) => ({ corpRates: { ...(inp.corpRates || {}), [gl]: { perUnitYr: v, flatMo: line.driver.flatMo || 0 } } }) };
  }
  if (gl === '4994' && m === 'gpr') {
    const g = (inp.gpr || {}).growthPct || [];
    return { label: 'growth %/mo', value: pct(g[1] || 0), patch: (v) => ({ gpr: { ...(inp.gpr || {}), growthPct: Array(12).fill(v / 100) } }) };
  }
  if (gl === '5003' && m === 'ltl') {
    return { label: 'renewal %', value: pct((inp.ltl || {}).renewalPct ?? 0.7), patch: (v) => ({ ltl: { ...(inp.ltl || {}), renewalPct: v / 100 } }) };
  }
  if (gl === '5031' && m === 'vacancy') {
    const vac = inp.vacancyPct || [];
    return { label: 'vacancy %', value: pct(vac[0] || 0), patch: (v) => ({ vacancyPct: Array(12).fill(v / 100) }) };
  }
  if (gl === '6112' && m === 'mgmtPct') {
    return { label: '% of income', value: pct(inp.mgmtPct || 0), patch: (v) => ({ mgmtPct: v / 100 }) };
  }
  if (m === 'sellerUtil') {
    return { label: 'growth %', value: pct((inp.utilities || {}).growthPct ?? 0.03), patch: (v) => ({ utilities: { ...(inp.utilities || {}), growthPct: v / 100 } }) };
  }
  if (m === 'payrollModel') {
    return { label: 'March raise %', value: pct(inp.payrollRaisePct ?? 0.035), patch: (v) => ({ payrollRaisePct: v / 100 }) };
  }
  if (m === 'recovery') {
    return { label: 'recovery %', value: pct(line.driver.pct || 0), patch: (v) => ({ utilities: { ...(inp.utilities || {}), recoveryPct: v / 100 } }) };
  }
  if (m === 'catShare' && line.driver.pcode === '2') {
    return { label: 'concessions % of GPR', value: pct(inp.concessionPct || 0), patch: (v) => ({ concessionPct: v / 100 }) };
  }
  if (m === 'catShare' && line.driver.pcode === '3') {
    return { label: 'rental loss % of GPR (total)', value: pct(inp.rentalLossPct || 0), patch: (v) => ({ rentalLossPct: v / 100 }) };
  }
  if (m === 'interest') {
    return { label: 'rate %', value: pct(inp.rate || 0), patch: (v) => ({ rate: v / 100 }) };
  }
  return null;
}

function openColsMenu(anchorBtn, labels) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  const item = (key, label) => `<label><input type="checkbox" data-col="${key}" ${S.hiddenCols.has(key) ? '' : 'checked'}> ${esc(label)}</label>`;
  menu.innerHTML = `
    <div class="rm-head">Show / hide columns</div>
    ${item('fx', 'Fx (formula chip)')}
    ${labels.map((lb, i) => item('m' + i, lb)).join('')}
    ${item('annual', S.bv && S.bv.annual ? `${S.bv.budget.year} total` : 'Year 1 total')}
    ${S.bv && S.bv.annual ? item('ref1', 'T12 actuals') + item('ref2', 'CY budget') : ''}
    ${item('punit', '$/Unit')}
    ${item('note', 'Note')}
    <button data-all="1" style="color:var(--accent)">Show all</button>`;
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${r.left + window.scrollX}px`;
  menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  const save = () => { localStorage.setItem('bt-hidecols', JSON.stringify([...S.hiddenCols])); render(); };
  menu.querySelectorAll('[data-col]').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) S.hiddenCols.delete(cb.dataset.col); else S.hiddenCols.add(cb.dataset.col);
    save();
  }));
  menu.querySelector('[data-all]').addEventListener('click', () => { S.hiddenCols.clear(); save(); });
}

/* ANNUAL tie card: growth targets per subtotal vs the reference. Nothing
   derives from an underwriting — each row shows the implied growth, takes a
   target %, and "tie" shifts that subtotal's growth factors to land there. */
function tieGrowthHtml(bv) {
  const inp = bv.budget.inputs || {};
  const refLabel = bv.refLabel || 'T12';
  const gt = inp.growthTargets || {};
  const t = bv.tieout;
  const refKey = inp.refSource === 'budget' ? 'budget' : 'actual';
  const refByGl = ((bv.refs || []).find((r) => r.key === refKey) || {}).byGl || {};
  const SHORT = {
    '1': 'Gross Potential Rent', loss: 'Loss to Lease', '2': 'Concessions', '3': 'Vacancy, Delinq & Other Loss',
    '4': 'Utility Income', '5': 'Other Income', '6': 'Insurance', '7': 'Mgmt Fee', '8': 'RE & PP Taxes',
    '9': 'Admin & Acct', '10': 'Payroll', '11': 'Marketing', '12': 'Utilities', '13': 'R&M', '14': 'Rehab / Reserves',
  };
  const byP = Object.fromEntries(t.rows.map((r) => [r.pcode, r]));
  const agg = (ps, label) => {
    const budget = ps.reduce((a, p) => a + ((byP[p] || {}).budget || 0), 0);
    const uw = ps.reduce((a, p) => a + ((byP[p] || {}).uw || 0), 0);
    return { pcode: label, label, budget, uw };
  };
  // growth of the SIGNED reference: a contra line shrinking 10% reads −10%, like its target
  const pctOf = (r) => (r.uw ? (r.budget - r.uw) / r.uw : null);
  const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
  // key: a pcode, 'opex' or 'noi' → takes a target; null → display only
  const row = (r, key, cls) => {
    const g = pctOf(r);
    const tgt = key != null && gt[key] != null ? gt[key] : null;
    const off = tgt != null && g != null ? Math.abs(g - tgt) : null;
    const vcls = off == null ? '' : off < 0.0015 ? 'good' : off > 0.01 ? 'bad' : '';
    return `<tr class="${cls || ''}"><td title="${esc(r.label)}">${esc(SHORT[r.pcode] || r.label)}</td>
      <td>${money(r.uw)}</td><td>${money(r.budget)}</td>
      <td class="var ${vcls}" title="Δ ${money(r.budget - r.uw)} vs ${esc(refLabel)}">${fmtPct(g)}</td>
      <td>${key != null ? `<input data-gt="${key}" value="${tgt != null ? (tgt * 100).toFixed(1) : ''}" placeholder="%" style="width:48px; font-size:11px; text-align:right" title="Growth target vs ${esc(refLabel)} (%)">` : ''}</td>
      <td>${key != null && tgt != null && (off == null || off >= 0.0015) ? `<button class="rb" data-tie="${key}" title="Shift this subtotal's growth factors so it lands at ${esc(refLabel)} ${fmtPct(tgt)}">tie</button>` : ''}</td></tr>`;
  };
  const cat = (p) => (byP[p] ? row(byP[p], p) : '');
  const nTargets = Object.keys(gt).filter((k) => gt[k] != null).length;
  return `<table>
    <tr><th>Subtotal</th><th>${esc(refLabel)}</th><th>Budget</th><th>Δ%</th><th>Target</th><th></th></tr>
    ${cat('1')}${byP.loss ? row(byP.loss, null) : ''}
    ${row(agg(['1', 'loss'], 'Net Gross Potential Rent'), null, 'sub')}
    ${cat('2')}${cat('3')}
    ${row(agg(['1', 'loss', '2', '3'], 'Total Rental Income'), null, 'sub')}
    ${cat('4')}${cat('5')}
    ${row(agg(['4', '5'], 'Total Other + Utility Inc'), null, 'sub')}
    ${row({ ...t.egi, label: 'Total Income (EGI)' }, null, 'big')}
    ${['6', '7', '8', '9', '10', '11', '12', '13', '14'].map((p) => (p === '7' ? (byP[p] ? row(byP[p], null) : '') : cat(p))).join('')}
    ${row({ ...t.toe, label: 'Total OpEx' }, 'opex', 'big')}
    ${row({ ...t.noi, label: 'NOI' }, 'noi', 'big')}
  </table>
  <div class="row" style="margin-top:6px; justify-content:space-between; align-items:center">
    <span class="muted" style="font-size:11px">Δ% = budget vs ${esc(refLabel)}. Type a target, then <b>tie</b>.</span>
    ${nTargets ? `<button class="rb" id="tie-all" title="Apply every target that is set — categories first, then OpEx, then NOI">tie all (${nTargets})</button>` : ''}
  </div>
  <p class="muted" style="font-size:11px"><b>Nothing derives from an underwriting.</b> “tie” shifts the trailing-12 × factor lines of that subtotal by one uniform number of points (MROUNDs kept), so the subtotal grows by the target; GPR solves its monthly %; concessions &amp; rental loss scale their % of GPR; loss to lease is set under Assumptions; mgmt fee follows income; a subtotal with no factor lines left (all overridden) rebalances proportionally. OpEx / NOI targets spread across every expense category but the fee.</p>`;
}

function tieHtml(bv) {
  if (!bv.uw) return bv.annual ? '<p class="muted">No statement linked — upload the Yardi budget template (or a 12 Month Statement) and point this budget at it under Data sources.</p>' : '<p class="muted">No UW snapshot linked — tie-out unavailable.</p>';
  if (bv.annual) return tieGrowthHtml(bv);
  const refLabel = bv.refLabel || 'UW Y1';
  const t = bv.tieout;
  const rebalanceable = new Set(['loss', '2', '3', '4', '5', '6', '8', '9', '10', '11', '12', '13', '14']);
  const basisable = new Set(['4', '5', '6', '8', '9', '10', '11', '12', '13', '14']);
  const catBasis = (bv.budget.inputs || {}).catBasis || {};
  const canPerUnit = !!bv.compUnits;
  const SHORT = {
    '1': 'Gross Potential Rent', loss: 'Loss to Lease', '2': 'Concessions', '3': 'Delinq & Other Loss',
    '4': 'Utility Income', '5': 'Other Income', '6': 'Insurance', '7': 'Mgmt Fee', '8': 'RE & PP Taxes',
    '9': 'Admin & Acct', '10': 'Payroll', '11': 'Marketing', '12': 'Utilities', '13': 'R&M', '14': 'Rehab / Reserves',
    'Effective Gross Income': 'Total Income (EGI)', 'Total Operating Expenses': 'Total OpEx', 'Net Operating Income': 'NOI',
  };
  const row = (r, big) => {
    const cls = Math.abs(r.variance) < 1 ? 'good' : (Math.abs(r.variance) / (Math.abs(r.uw) || 1) > 0.02 ? 'bad' : '');
    const basis = catBasis[r.pcode] === 'perUnit' ? 'perUnit' : 'uw';
    const basisCtl = !big && basisable.has(r.pcode) && canPerUnit
      ? `<button class="rb basis" data-b="${r.pcode}" title="Level basis — click to switch">${basis === 'perUnit' ? '$/unit' : 'UW'}</button>` : '';
    const isNoi = r.label === 'Net Operating Income';
    const noiCtl = isNoi && Math.abs(r.variance) >= 1 ? `<button class="rb" data-noi="1" title="Scale the flex categories (admin, marketing, R&M, rehab) so NOI equals ${esc(refLabel)} exactly">tie NOI</button>` : '';
    const isEgi = r.label === 'Effective Gross Income';
    const egiCtl = isEgi && Math.abs(r.variance) >= 1 ? `<button class="rb" data-egi="1" title="Adjust loss-to-lease so Total Income equals ${esc(refLabel)} exactly (GPR stays on the rent roll)">tie income</button>` : '';
    return `<tr class="${big ? 'big' : ''}"><td title="${esc(r.label)}">${esc(SHORT[big ? r.label : r.pcode] || r.label)}</td>
      <td>${money(r.budget)}</td><td>${money(r.uw)}</td>
      <td class="var ${cls}">${money(r.variance)}</td>
      <td>${noiCtl}${egiCtl}${basisCtl}${!big && rebalanceable.has(r.pcode) && Math.abs(r.variance) >= 1 ? `<button class="rb" data-p="${r.pcode}">tie</button>` : ''}</td></tr>`;
  };
  const INCOME = new Set(['1', 'loss', '2', '3', '4', '5']);
  const byP = Object.fromEntries(t.rows.map((r) => [r.pcode, r]));
  // UW-native subtotals: aggregate the category rows so they compare 1:1 with
  // the UW's own subtotal lines (e.g. Total Rental Income)
  const agg = (ps, label) => {
    const budget = ps.reduce((a, p) => a + ((byP[p] || {}).budget || 0), 0);
    const uw = ps.reduce((a, p) => a + ((byP[p] || {}).uw || 0), 0);
    return { pcode: label, label, budget, uw, variance: budget - uw, pct: uw ? (budget - uw) / Math.abs(uw) : null };
  };
  const gprRows = ['1', 'loss'].map((p) => byP[p]).filter(Boolean);
  // split cat 3 for display: Vacancy (5031) vs Delinquency & other rental loss.
  // UW-side split uses the UW's vacancy % assumption × UW GPR.
  const vacLine = bv.lines.find((l) => l.gl_code === '5031');
  const vacBudget = vacLine ? sumM(vacLine.months) : 0;
  const cat3 = byP['3'] || { budget: 0, uw: 0 };
  const uwVac = bv.uw ? -Math.abs((Number(bv.uw.assumptions?.vacancyPct) || 0) * (bv.uw.y1['1'] || 0)) : 0;
  const vacRow = { pcode: 'Vacancy', label: 'Vacancy', budget: vacBudget, uw: uwVac, variance: vacBudget - uwVac, pct: uwVac ? (vacBudget - uwVac) / Math.abs(uwVac) : null };
  const badRow = { pcode: '3', label: 'Delinquency & Other Loss', budget: cat3.budget - vacBudget, uw: cat3.uw - uwVac, variance: (cat3.budget - vacBudget) - (cat3.uw - uwVac), pct: null };
  const lossRows = [byP['2'], vacRow, badRow].filter(Boolean);
  const otherRows = ['4', '5'].map((p) => byP[p]).filter(Boolean);
  const expenseRows = t.rows.filter((r) => !INCOME.has(r.pcode));
  const subRow = (r) => row(r, false).replace('<tr class="">', '<tr class="sub">');
  return `<table>
    <tr><th>Category</th><th>Budget</th><th>${esc(refLabel)}</th><th>Δ</th><th></th></tr>
    ${gprRows.map((r) => row(r, false)).join('')}
    ${subRow(agg(['1', 'loss'], 'Net Gross Potential Rent'))}
    ${lossRows.map((r) => row(r, false)).join('')}
    ${subRow(agg(['1', 'loss', '2', '3'], 'Total Rental Income'))}
    ${otherRows.map((r) => row(r, false)).join('')}
    ${subRow(agg(['4', '5'], 'Total Other + Utility Inc'))}
    ${row(t.egi, true)}
    ${expenseRows.map((r) => row(r, false)).join('')}
    ${row(t.toe, true)}${row(t.noi, true)}
  </table>
  ${bv.annual
    ? `<p class="muted" style="font-size:11px"><b>Nothing ties automatically.</b> Every line follows the Yardi template rule (own trailing-12 × factor, October actual, corporate rate, debt schedule…) and this panel shows the Δ against <b>${esc(refLabel)}</b>. Category “tie” scales that category's non-overridden lines to match the reference total; “tie NOI” / “tie income” are explicit buttons. Switch the reference above to compare against the current-year budget or your own EGI/NOI targets.</p>`
    : `<p class="muted" style="font-size:11px"><b>NOI ties 100% to UW</b> — at generation and via “tie NOI”, the flex categories (admin, marketing, R&M, rehab) absorb the gap; other categories stay in line with their basis. Category “tie” scales that category's non-overridden lines to its own target. Basis buttons switch a category between <b>UW</b> and <b>Minot $/unit × units</b>. Payroll benefits/bonuses follow Minot ratios on the property's wage totals. GPR always anchors to the rent roll.</p>`}`;
}

function inputsHtml(inp) {
  if (S.bv && S.bv.annual) return annualInputsHtml(inp);
  const g = inp.gpr || {};
  const l = inp.ltl || {};
  return `
    <h3>Income · Year 1 starts at the start month and runs 12 months</h3>
    <div class="row">
      <div class="fld"><label>Start month (GPR anchors here)</label><select id="in-start">${MONTHS.map((m, i) => `<option value="${i + 1}" ${inp.startMonth === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <div class="fld"><label>GPR base $/mo</label><input id="in-gprbase" value="${g.baseMonthly ?? 0}" style="width:110px"></div>
      <div class="fld"><label>GPR growth %/mo (1 or 12 vals)</label><input id="in-gprgrow" value="${show12(g.growthPct || [])}" style="width:130px"></div>
    </div>
    <h3>Loss to lease ${S.bv && S.bv.leaseCount ? `<span class="badge">${S.bv.leaseCount} leases on file</span>` : '<span class="badge">no lease detail — upload a unit-level rent roll</span>'}</h3>
    <div class="row">
      <div class="fld"><label>Method</label><select id="in-ltlmode">
        <option value="leases" ${l.mode !== 'ramp' ? 'selected' : ''}>Lease burnoff (per turnover)</option>
        <option value="ramp" ${l.mode === 'ramp' ? 'selected' : ''}>Linear ramp</option>
      </select></div>
      <div class="fld"><label>Renewal rate %</label><input id="in-ltlrenew" value="${((l.renewalPct ?? 0.7) * 100).toFixed(0)}" style="width:70px" title="Share of expiring leases that renew. Largest-LTL leases renew first; GTL / low-LTL leases turn over."></div>
      <div class="fld"><label>Burnoff on renewal %</label><input id="in-ltlbr" value="${((l.burnoffRenew ?? 0.5) * 100).toFixed(0)}" style="width:70px" title="Share of a renewing lease's LTL captured at renewal"></div>
      <div class="fld"><label>Burnoff on move-in %</label><input id="in-ltlbn" value="${((l.burnoffNew ?? 1) * 100).toFixed(0)}" style="width:70px" title="Share of a turning lease's LTL captured on the new lease"></div>
    </div>
    <div class="row" style="margin-top:6px">
      <div class="fld"><label>Ramp: start $/mo (neg)</label><input id="in-ltlstart" value="${l.startMonthly ?? 0}" style="width:100px"></div>
      <div class="fld"><label>Ramp: target % of GPR</label><input id="in-ltlpct" value="${((l.targetPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
      <div class="fld"><label>Ramp months</label><input id="in-ltlramp" value="${l.rampMonths ?? 12}" style="width:70px"></div>
    </div>
    <div class="row" style="margin-top:6px">
      <div class="fld"><label>Vacancy % (1 or 12 vals)</label><input id="in-vac" value="${show12(inp.vacancyPct || [])}" style="width:120px"></div>
      <div class="fld"><label>Concessions %</label><input id="in-conc" value="${((inp.concessionPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
      <div class="fld"><label>Rental loss % (total)</label><input id="in-rloss" value="${((inp.rentalLossPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
    </div>
    <h3>Utilities ${S.bv && S.bv.hasSellerUtil ? '<span class="badge">seller statement on file</span>' : '<span class="badge">no seller T12 utility lines — falls back to UW</span>'}</h3>
    <div class="row">
      <div class="fld"><label>Source</label><select id="in-utsrc">
        <option value="seller" ${(inp.utilities || {}).source !== 'uw' ? 'selected' : ''}>Seller statements (× growth)</option>
        <option value="uw" ${(inp.utilities || {}).source === 'uw' ? 'selected' : ''}>UW allocation</option>
      </select></div>
      <div class="fld"><label>Growth %</label><input id="in-utgrow" value="${(((inp.utilities || {}).growthPct ?? 0.03) * 100).toFixed(1)}" style="width:70px"></div>
      <div class="fld"><label>Recovery % of prior-month billing</label><input id="in-utrec" value="${(inp.utilities || {}).recoveryPct != null ? ((inp.utilities.recoveryPct) * 100).toFixed(1) : ''}" placeholder="auto (seller ratio)" style="width:150px" title="Utility income = this % of last month's utility expense. Blank = derived from the seller's actual income/expense ratio."></div>
    </div>
    <h3>Fees & financing</h3>
    <div class="row">
      <div class="fld"><label>Mgmt fee % of income</label><input id="in-mgmt" value="${((inp.mgmtPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
      <div class="fld"><label>Units</label><input id="in-units" value="${inp.units ?? 0}" style="width:70px"></div>
      <div class="fld"><label>Loan $</label><input id="in-loan" value="${inp.loan ?? 0}" style="width:110px"></div>
      <div class="fld"><label>Rate %</label><input id="in-rate" value="${((inp.rate || 0) * 100).toFixed(2)}" style="width:70px"></div>
      <div class="fld"><label>Capital $ (CoC)</label><input id="in-cap" value="${inp.capital ?? 0}" style="width:110px"></div>
    </div>
    <h3>Ties to underwriting</h3>
    <div class="row">
      <label title="Adjust loss-to-lease so Total Income equals UW Year 1 EGI"><input type="checkbox" id="in-tieinc" ${inp.tieIncome !== false ? 'checked' : ''}> Tie income (via LTL)</label>
      <label title="Scale the flex categories (admin, marketing, R&M, rehab) so NOI equals UW Year 1 NOI"><input type="checkbox" id="in-tienoi" ${inp.tieNoi !== false ? 'checked' : ''}> Tie NOI (via flex cats)</label>
    </div>
    <h3>UW category targets ($/yr)</h3>
    <div class="row">
      ${['4', '5', '6', '8', '9', '10', '11', '12', '13', '14'].map((p) => `
        <div class="fld"><label>cat ${p}</label><input class="in-uwabs" data-p="${p}" value="${(inp.uwAbs || {})[p] ?? 0}" style="width:92px"></div>`).join('')}
    </div>`;
}

async function applyInputs(b, el) {
  if (S.bv && S.bv.annual) return applyAnnualInputs(b, el);
  const num = (id) => parseFloat(String(el.querySelector(id).value).replace(/,/g, '')) || 0;
  const uwAbs = {};
  el.querySelectorAll('.in-uwabs').forEach((x) => { uwAbs[x.dataset.p] = parseFloat(String(x.value).replace(/,/g, '')) || 0; });
  const inputs = {
    year: b.year,
    units: num('#in-units'),
    capital: num('#in-cap'),
    loan: num('#in-loan'),
    rate: num('#in-rate') / 100,
    startMonth: Number(el.querySelector('#in-start').value),
    gpr: { baseMonthly: num('#in-gprbase'), growthPct: parse12(el.querySelector('#in-gprgrow').value, Array(12).fill(0)) },
    ltl: {
      mode: el.querySelector('#in-ltlmode').value,
      renewalPct: num('#in-ltlrenew') / 100,
      burnoffRenew: num('#in-ltlbr') / 100,
      burnoffNew: num('#in-ltlbn') / 100,
      startMonthly: num('#in-ltlstart'), targetPct: num('#in-ltlpct') / 100, rampMonths: num('#in-ltlramp') || 12,
    },
    vacancyPct: parse12(el.querySelector('#in-vac').value, Array(12).fill(0.05)),
    concessionPct: num('#in-conc') / 100,
    rentalLossPct: num('#in-rloss') / 100,
    mgmtPct: num('#in-mgmt') / 100,
    tieIncome: el.querySelector('#in-tieinc').checked,
    tieNoi: el.querySelector('#in-tienoi').checked,
    utilities: {
      source: el.querySelector('#in-utsrc').value,
      growthPct: num('#in-utgrow') / 100,
      recoveryPct: String(el.querySelector('#in-utrec').value).trim() === '' ? null : num('#in-utrec') / 100,
    },
    uwAbs,
  };
  pushUndo();
  S.bv = await PUT(`/budgets/${b.id}`, { inputs });
  render();
}

/* Data-sources panel: shows the workbook/upload each budget POINTS AT and
   re-points it (PUT relink + regenerate). Newer uploads never take effect
   until the budget points at them — this is where you fix that. */
function dataLinksHtml(bv) {
  const st = S.state, b = bv.budget;
  const own = (list) => list.filter((x) => !x.property_code || x.property_code === b.property_code);
  const stale = (list, cur) => cur && list.length && Number(list[0].id) !== Number(cur); // list is newest-first
  // annual: the template's own two statements are implied — only list them
  // separately when the budget points somewhere else (a Monarch export)
  const tpl = (st.templates || []).find((x) => Number(x.id) === Number(b.template_id));
  const stmtsFromTpl = tpl && Number(tpl.py_stmt_id) === Number(b.py_stmt_id) && Number(tpl.cy_budget_stmt_id) === Number(b.cy_budget_stmt_id);
  const LINKS = bv.annual ? [
    { key: 'templateId', cur: b.template_id, label: 'Yardi budget template', list: own(st.templates || []), name: (x) => `${x.label} (${x.budget_year})`,
      note: stmtsFromTpl ? `T12 actuals${tpl.actual_period ? ` ${tpl.actual_period}` : ''} and CY budget come from this template` : '' },
    ...(stmtsFromTpl ? [] : [
      { key: 'pyStmtId', cur: b.py_stmt_id, label: 'Trailing-12 actuals', list: own((st.stmtSnapshots || []).filter((x) => x.kind === 'actual')), name: (x) => `${x.period || ''} · ${x.label}` },
      { key: 'cyBudgetStmtId', cur: b.cy_budget_stmt_id, label: 'Current-year budget', list: own((st.stmtSnapshots || []).filter((x) => x.kind === 'budget')), name: (x) => `${x.period || ''} · ${x.label}` },
    ]),
    { key: 'rentSnapshotId', cur: b.rent_snapshot_id, label: 'Rent roll (GPR anchor, per-lease LTL, charges)', list: own(st.rentSnapshots), name: (x) => `${x.as_of ? new Date(x.as_of).toLocaleDateString() : '#' + x.id} · ${x.units || '?'}u` },
    { key: 'payrollModelId', cur: b.payroll_model_id, label: `Payroll model${b.payroll_model_id && !bv.payrollWages ? ' <span class="warnflag" title="The linked model has NO wages for this property">⚠ no wages for this property</span>' : ''}`, list: st.payrollModels || [], name: (x) => x.label },
  ] : [
    { key: 'uwSnapshotId', cur: b.uw_snapshot_id, label: 'UW book', list: own(st.uwSnapshots), name: (x) => x.label },
    { key: 'rentSnapshotId', cur: b.rent_snapshot_id, label: 'Rent roll', list: own(st.rentSnapshots), name: (x) => `${x.as_of ? new Date(x.as_of).toLocaleDateString() : '#' + x.id} · ${x.units || '?'}u` },
    { key: 't12SnapshotId', cur: b.t12_snapshot_id, label: 'Seller T12', list: own(st.t12Snapshots || []), name: (x) => `${x.label} · ${x.period || ''}` },
    { key: 'compSetId', cur: b.comp_set_id, label: 'Comp set', list: st.compSets, name: (x) => x.name },
    { key: 'payrollModelId', cur: b.payroll_model_id, label: `Payroll model${b.payroll_model_id && !bv.payrollWages ? ' <span class="warnflag" title="The linked model has NO wages for this property — ✎ edit it on the Data page (add/fix this property\'s row)">⚠ no wages for this property</span>' : ''}`, list: st.payrollModels || [], name: (x) => x.label },
  ];
  return LINKS.map((L) => `
    <div class="fld" style="margin:0 0 6px">
      <label>${L.label}${stale(L.list, L.cur) ? ' <span class="warnflag" title="A newer upload exists — this budget still points at an older one">⚠ newer upload available</span>' : ''}</label>
      <select data-link="${L.key}" style="max-width:260px">
        <option value="">— none —</option>
        ${L.list.map((x) => `<option value="${x.id}" ${Number(L.cur) === Number(x.id) ? 'selected' : ''}>${esc(String(L.name(x) || '#' + x.id).slice(0, 44))}</option>`).join('')}
      </select>${L.note ? `<div class="muted" style="font-size:10.5px; margin-top:2px">${esc(L.note)}</div>` : ''}
    </div>`).join('') + (bv.annual ? '<p class="muted" style="font-size:10.5px; margin:4px 0 0">More files: Data page, or ⬆ in the New budget dialog.</p>' : '');
}

/* Non-accrual billing smell test: sellers that book bills as paid (no
   accruals) leave credits, missing months, and catch-up spikes in the
   monthly series — bad inputs for a budget line. Returns the issues found,
   or null when the series looks like clean monthly accruals. */
function billingSmell(months) {
  const nz = months.filter((v) => v);
  if (nz.length < 3) return null;
  const issues = [];
  if (nz.some((v) => v > 0) && nz.some((v) => v < 0)) issues.push('credit / negative month');
  const idx = months.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const gaps = months.slice(idx[0], idx[idx.length - 1] + 1).filter((v) => !v).length;
  if (gaps) issues.push(`${gaps} missing month${gaps > 1 ? 's' : ''} mid-stream`);
  const abs = nz.map(Math.abs).sort((a, b) => a - b);
  const med = abs[Math.floor(abs.length / 2)];
  if (med > 0 && abs[abs.length - 1] > 3 * med) issues.push(`${(abs[abs.length - 1] / med).toFixed(1)}× spike vs the median month`);
  // sawtooth: a big month right NEXT TO a tiny one is catch-up billing, not
  // seasonality — real seasonal series ramp gradually (gas's worst adjacent
  // step is ~1.7×). Two or more >2.5× whipsaws between adjacent months flag.
  let saw = 0;
  for (let i = 1; i < months.length; i++) {
    const a = Math.abs(months[i - 1]), b2 = Math.abs(months[i]);
    if (a && b2 && Math.max(a, b2) >= 300 && Math.max(a, b2) / Math.min(a, b2) > 2.5) saw++;
  }
  if (saw >= 2) issues.push(`sawtooth billing — ${saw} whipsaw month-to-month jumps`);
  return issues.length ? issues : null;
}
/* One-click missed-bill smoothing: repeated centered 1-2-1 passes pull each
   catch-up spike into its surrounding low months (a 3-month bill melts back
   over ~3 months) and soak up credit months. No wrap — month 0 and month 11
   are a real year boundary — reflective edges keep the annual total exact.
   Stops as soon as the series stops smelling like bad billing (max 12 passes). */
function smoothMonths(months) {
  let m = months.slice();
  const total = Math.round(m.reduce((a, v) => a + v, 0) * 100) / 100;
  let passes = 0;
  while (passes < 12) {
    const nz = m.filter((v) => v);
    const abs = nz.map(Math.abs).sort((a, b) => a - b);
    const med = abs.length ? abs[Math.floor(abs.length / 2)] : 0;
    const mixed = nz.some((v) => v > 0) && nz.some((v) => v < 0);
    let saw = false;
    for (let i = 1; i < 12; i++) {
      const a = Math.abs(m[i - 1]), b2 = Math.abs(m[i]);
      if (a && b2 && Math.max(a, b2) >= 300 && Math.max(a, b2) / Math.min(a, b2) > 2) saw = true;
    }
    const spiky = med > 0 && abs[abs.length - 1] > 1.75 * med;
    if (passes >= 2 && !mixed && !saw && !spiky) break;   // at least 2 passes, then stop when clean
    m = m.map((_, i) => {
      const prev = i > 0 ? m[i - 1] : m[0];               // reflective edges — total-preserving
      const next = i < 11 ? m[i + 1] : m[11];
      return (2 * m[i] + prev + next) / 4;
    });
    passes++;
  }
  m = m.map((v) => Math.round(v * 100) / 100);
  const drift = Math.round((total - m.reduce((a, v) => a + v, 0)) * 100) / 100;
  if (drift) {
    const bi = m.reduce((mi, v, i) => (Math.abs(v) > Math.abs(m[mi]) ? i : mi), 0);
    m[bi] = Math.round((m[bi] + drift) * 100) / 100;
  }
  return { months: m, passes };
}

function sellerDerived(l) {
  const d = l && l.driver;
  return !!d && (['sellerUtil', 'sellerLine', 'recovery', 't12curve'].includes(d.method) || (d.method === 'wavg' && d.srcType === 'seller'));
}

/* ---------------- formula recompute (shared: row tools + formula copier) ----------------
   Each helper re-evaluates one named formula against a budget view's OWN data
   sources (its seller T12, its comps at its unit count), so a formula recipe
   can be replayed on any property with that property's references. */
function fcSellerRows(bv) { return (bv.sellerT12 || []).filter((r) => r.months && r.months.some((v) => v)); }
function fcFindSeller(bv, name) {
  if (!name) return null;
  const want = String(name).trim().toLowerCase();
  const rows = fcSellerRows(bv);
  return rows.find((r) => r.name.trim().toLowerCase() === want)
      || rows.find((r) => r.name.trim().toLowerCase().startsWith(want))   // stored names are truncated
      || null;
}
function fcSellerCal(r) {
  const cal = Array(12).fill(0);
  r.months.forEach((v, i) => { cal[((r.monthCal && r.monthCal[i]) || i + 1) - 1] += v || 0; });
  return cal;
}
function fcSellerLine(bv, inp, row, pct) {
  const start = inp.startMonth || 1;
  const cal = fcSellerCal(row);
  return {
    months: Array.from({ length: 12 }, (_, i) => Math.round(cal[(start - 1 + i) % 12] * (1 + pct / 100) * 100) / 100),
    driver: { method: 'sellerLine', name: row.name.slice(0, 40), pct },
  };
}
function fcMinot(bv, inp, gl, pcode) {
  if (!bv.compWeights || !bv.compUnits || !bv.compWeights[gl]) return null;
  const start = inp.startMonth || 1;
  const annual = (bv.compWeights[gl] / bv.compUnits) * (inp.units || 0);
  const cal = (bv.compShapes && bv.compShapes[gl]) || Array(12).fill(1);
  const shape = cal.map((_, i) => cal[(start - 1 + i) % 12]);   // Jan-Dec → ownership order
  const wsum = shape.reduce((a, x) => a + x, 0) || 1;
  return {
    months: shape.map((w) => Math.round(((annual * w) / wsum) * 100) / 100),
    driver: { method: 'perUnitComp', pcode: pcode || '', perUnit: Math.round((bv.compWeights[gl] / bv.compUnits) * 100) / 100 },
  };
}
function fcT3avg(bv, inp, srcGl, pct) {
  if (!bv.compShapes || !bv.compShapes[srcGl] || !bv.compWeights || !bv.compWeights[srcGl] || !bv.compUnits) return null;
  const shape = bv.compShapes[srcGl];
  const wsum = shape.reduce((a, x) => a + x, 0) || 1;
  const monthly = shape.map((w) => (bv.compWeights[srcGl] * w) / wsum); // comp $ by calendar month
  const t3 = (monthly[9] + 2 * monthly[10] + monthly[11]) / 4;          // last 3, mid ×2
  const scaled = (t3 / bv.compUnits) * (inp.units || 0) * (1 + pct / 100);
  const rounded = Math.round(scaled / 250) * 250;
  const a = S.state.coa.find((x) => x.code === srcGl) || {};
  return { months: Array(12).fill(rounded), driver: { method: 't3avg', pct, src: srcGl, srcName: (a.name || srcGl).slice(0, 30) } };
}
/* WAVG source rows for a budget view: its own seller T12 lines (scale 1) +
   Minot comp lines (per-unit scaled to its units). */
function fcWavgRows(bv, inp, gl) {
  const coaByCode = new Map(S.state.coa.map((a) => [a.code, a]));
  const rows = [];
  for (const r of fcSellerRows(bv)) {
    rows.push({ srcType: 'seller', name: r.name, pcode: r.pcode, cal: fcSellerCal(r), scale: 1, total: r.total || fcSellerCal(r).reduce((a, x) => a + x, 0) });
  }
  for (const k of Object.keys(bv.compShapes || {})) {
    if (!bv.compWeights || !bv.compWeights[k] || !bv.compUnits) continue;
    const a = coaByCode.get(k) || {};
    const shape = bv.compShapes[k];
    const wsum = shape.reduce((x, y) => x + y, 0) || 1;
    const cal = shape.map((w) => (bv.compWeights[k] * w) / wsum);
    rows.push({ srcType: 'comp', glCode: k, name: `${k} ${a.name || ''}`, pcode: a.pcode, cal, scale: (inp.units || 0) / bv.compUnits, total: bv.compWeights[k], own: k === gl });
  }
  return rows;
}
/* T12-TOTAL-ON-A-CURVE (Troy's methodology for non-accrual seller lines):
   the seller's ANNUAL total is trustworthy even when the monthly timing is
   garbage (no accruals → credits/gaps/spikes), so take total × (1+g) and
   spread it on a CLEAN seasonal shape — the Minot per-GL shape, a named
   curve (snow/heat/…), or flat — rotated into ownership order. */
function fcT12Curve(bv, inp, row, pct, shapeKey, gl, mult, customWeights) {
  const start = inp.startMonth || 1;
  const annual = fcSellerCal(row).reduce((a, x) => a + x, 0) * (1 + pct / 100);
  let cal = null; // Jan-Dec weights
  if (shapeKey === 'minot') cal = bv.compShapes && bv.compShapes[gl];
  else if (shapeKey === 'custom') cal = customWeights;
  else if (shapeKey && shapeKey !== 'flat') cal = (S.state.curves || {})[shapeKey];
  if (!cal || !cal.some((v) => v > 0)) cal = Array(12).fill(1);
  const shape = cal.map((_, i) => Math.abs(cal[(start - 1 + i) % 12]));   // ownership order
  const wsum = shape.reduce((a, x) => a + x, 0) || 1;
  let months = shape.map((w) => Math.round(((annual * w) / wsum) * 100) / 100);
  if (mult) months = months.map((v) => Math.round(v / mult) * mult);
  else {
    // penny-fix the largest month so the year lands exactly on total × growth
    const drift = Math.round((Math.round(annual * 100) / 100 - months.reduce((a, v) => a + v, 0)) * 100) / 100;
    if (drift) {
      const bi = months.reduce((mi, v, i) => (Math.abs(v) > Math.abs(months[mi]) ? i : mi), 0);
      months[bi] = Math.round((months[bi] + drift) * 100) / 100;
    }
  }
  return { months, driver: { method: 't12curve', name: row.name.slice(0, 40), pct, shape: shapeKey, mult: mult || 0, weights: shapeKey === 'custom' ? customWeights : undefined } };
}

function fcWavg(bv, inp, row, pct, mult) {
  const start = inp.startMonth || 1;
  // centered 1-2-1 smoothing on the calendar series (wraps at year edges)
  const sm = row.cal.map((_, c) => (2 * row.cal[c] + row.cal[(c + 11) % 12] + row.cal[(c + 1) % 12]) / 4);
  const months = Array.from({ length: 12 }, (_, i) => {
    const v = sm[(start - 1 + i) % 12] * row.scale * (1 + pct / 100);
    return mult ? Math.round(v / mult) * mult : Math.round(v * 100) / 100;
  });
  return { months, driver: { method: 'wavg', pct, mult: mult || 0, srcType: row.srcType, srcName: row.name.slice(0, 30) } };
}

/* ---------------- row quick tools ---------------- */
function openRowTools(b, gl, anchorBtn) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const inp = S.bv.budget.inputs || {};
  const start = inp.startMonth || 1;
  const acc = S.state.coa.find((a) => a.code === gl) || {};
  const hasComp = S.bv.compWeights && S.bv.compUnits && S.bv.compWeights[gl];
  const line = S.bv.lines.find((l) => l.gl_code === gl);
  const dm = drvMeta(line && (sumM(line.months) || line.override) ? line : null);
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  const dot = (cls) => `<span class="dot ${cls}" style="margin-right:6px"></span>`;
  menu.innerHTML = `
    <div class="rm-head">${gl} ${esc(acc.name || '')}<br>
      <span class="drv ${dm.cls}" style="margin-top:3px; display:inline-block">${dm.tag}</span>
      <span style="margin-left:5px">${esc(dm.label)}</span></div>
    <button data-act="zero">${dot('drv-int')}Zero out row</button>
    <button data-act="flatAnnual">${dot('drv-man')}Flat — annual $ over the year…</button>
    <button data-act="flatMonthly">${dot('drv-man')}Flat — $ per month…</button>
    <button data-act="grow">${dot('drv-man')}Start $ /mo + growth %/mo…</button>
    ${hasComp ? `<button data-act="minot">${dot('drv-comp')}Minot $/unit × units (${money((S.bv.compWeights[gl] / S.bv.compUnits) * inp.units)}/yr, seasonal)</button>` : ''}
    ${hasComp && S.bv.compShapes && S.bv.compShapes[gl] ? `<button data-act="t3avg" title="Weighted average of the comp's last 3 months (1-2-1), per-unit scaled, × (1+growth), rounded to $250 — your MROUND formula">${dot('drv-comp')}T3 actuals avg × growth → MROUND $250…</button>` : ''}
    ${S.bv.annual ? `<button data-act="shape" title="Pick how this GL's own trailing-12 history becomes the budget: same month × factor (template), 1-2-1 weighted distribution, flat T12/12, last actual month flat, average of active months, or the T12 total on the GL's seasonal curve">${dot('drv-base')}Own T12 → shape × factor…</button>` : ''}
    ${S.bv.annual && acc.pcode && ['1', 'loss', '2', '3'].includes(acc.pcode) && gl !== '4994' ? `<button data-act="pctgpr" title="This line as a % of budget GPR">${dot('drv-base')}% of GPR…</button>` : ''}
    ${S.bv.annual && S.bv.template && S.bv.template.suggestions && S.bv.template.suggestions[gl] && S.bv.template.suggestions[gl].some((v) => v) ? `<button data-act="suggest" title="${esc((S.bv.template.suggestionNotes[gl] || []).join('; '))}">${dot('drv-corp')}Corporate suggestion (${money(S.bv.template.suggestions[gl].reduce((a, v) => a + v, 0))}/yr)…</button>` : ''}
    ${(S.bv.sellerT12 || []).length ? `<button data-act="seller" title="${S.bv.annual ? 'Match this GL to any line of the property\'s own trailing-12 statement and take its monthly actuals × growth' : 'Match this GL to a seller T12 line and take its monthly actuals × growth'}">${dot('drv-t12')}${S.bv.annual ? 'Own T12 actuals — match any line…' : 'Seller actuals — match a seller line…'}</button>` : ''}
    ${(S.bv.sellerT12 || []).length ? `<button data-act="t12curve" title="${S.bv.annual ? 'Take a statement line\'s T12 total × growth and spread it on a clean seasonal curve' : 'For non-accrual seller billing (credits/gaps/spikes): the ANNUAL total is still right even when the months are garbage. Takes the seller line\'s T12 total × growth and spreads it on a clean seasonal curve.'}">${dot('drv-t12')}${S.bv.annual ? 'T12 TOTAL → seasonal curve…' : 'Seller T12 TOTAL → seasonal curve… (bad bills)'}</button>` : ''}
    <button data-act="link" title="Set this GL equal to another budget line × a weight (e.g. sewer = water × 0.8). LIVE: re-follows the source on every regeneration.">${dot('drv-fee')}= another line × weight… (moves in conjunction)</button>
    ${line && line.months.some((v) => v) ? `<button data-act="smooth" title="One click for missed bills: pulls catch-up spikes into the surrounding low months and soaks up credit months, repeating until the series looks like real monthly billing. Annual total kept exactly.">${dot('drv-t12')}Smooth missed bills — spikes into surrounding months</button>` : ''}
    ${line && (line.driver || {}).method === 'recovery' ? `<button data-act="recmap" title="Pick exactly which utility expense lines this reimbursement recovers (recovery % × their prior month). Claims are exclusive — a line you take here is released by whichever reim had it.">${dot('drv-t12')}Edit what this reim recovers…</button>` : ''}
    ${((S.bv.sellerT12 || []).length || hasComp) ? `<button data-act="wavg" title="Troy's distribution formula: each month = (2×that month + prior + next)/4 of the source actuals, × (1+growth), MROUND to a multiple">${dot('drv-comp')}Weighted avg distribution (1-2-1) × growth → MROUND…</button>` : ''}
    <button data-act="reset">${dot('drv-uw')}Reset to engine formula (clear override)</button>`;
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${r.left + window.scrollX}px`;
  menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);

  const put = async (months, driver) => {
    pushUndo();
    S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, driver ? { months, driver } : { months });
    render();
  };

  menu.querySelectorAll('button[data-act]').forEach((mb) => mb.addEventListener('click', async (e) => {
    e.stopPropagation(); close();
    const act = mb.dataset.act;
    if (act === 'zero') return put(Array(12).fill(0), { method: 'zero' });
    if (act === 'shape') return openShapeMenu(b, gl, acc, anchorBtn, inp);
    if (act === 'pctgpr') {
      const cur = line && line.driver && line.driver.method === 'pctGpr' ? (line.driver.pct || 0) * 100 : 0;
      const v = parseFloat(String(prompt(`${gl} ${acc.name || ''} as a % of budget GPR (negative for contra-income, e.g. -1.5):`, cur ? cur.toFixed(3) : '') || '').replace(/,/g, ''));
      if (!Number.isFinite(v)) return;
      pushUndo();
      S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { override: false });
      S.bv = await PUT(`/budgets/${b.id}`, { inputs: { pctGpr: { ...(inp.pctGpr || {}), [gl]: v / 100 } } });
      render();
      return;
    }
    if (act === 'suggest') {
      const s = S.bv.template.suggestions[gl];
      return put(s.map((v) => Math.round(v * 100) / 100), { method: 'suggested', note: (S.bv.template.suggestionNotes[gl] || []).join('; ') });
    }
    if (act === 'flatAnnual') {
      const v = parseFloat(String(prompt('Annual amount ($) — spread evenly over the 12 months:') || '').replace(/,/g, ''));
      if (!Number.isFinite(v)) return;
      return put(Array(12).fill(Math.round((v / 12) * 100) / 100));
    }
    if (act === 'flatMonthly') {
      const v = parseFloat(String(prompt('Amount per month ($):') || '').replace(/,/g, ''));
      if (!Number.isFinite(v)) return;
      return put(Array(12).fill(v));
    }
    if (act === 'grow') {
      const base = parseFloat(String(prompt('Starting amount for the first month ($/mo):') || '').replace(/,/g, ''));
      if (!Number.isFinite(base)) return;
      const g = parseFloat(String(prompt('Growth % per month (e.g. 0.5):') || '').replace(/,/g, '')) || 0;
      let cur = base;
      return put(Array.from({ length: 12 }, () => {
        const val = Math.round(cur * 100) / 100;
        cur = cur * (1 + g / 100);
        return val;
      }));
    }
    if (act === 'minot') {
      const res = fcMinot(S.bv, inp, gl, acc.pcode);
      if (res) return put(res.months, res.driver);
      return;
    }
    if (act === 't3avg') {
      // Troy's formula: T3 weighted average of a PICKABLE comp line,
      // per-unit → subject units, × (1+increase), MROUND $250, flat.
      openCompT3Match(b, gl, acc, anchorBtn, put, inp);
      return;
    }
    if (act === 'seller') {
      openSellerMatch(b, gl, acc, anchorBtn, put);
      return;
    }
    if (act === 't12curve') {
      openT12CurveMatch(b, gl, acc, anchorBtn, put, inp);
      return;
    }
    if (act === 'link') {
      openLinkLineMatch(b, gl, acc, anchorBtn, put);
      return;
    }
    if (act === 'recmap') {
      openRecMapEditor(b, gl, acc, anchorBtn, line);
      return;
    }
    if (act === 'smooth') {
      const cur = line ? line.months : Array(12).fill(0);
      const res = smoothMonths(cur);
      const prev = line && line.driver && line.driver.method && line.driver.method !== 'manual' ? line.driver : null;
      return put(res.months, { method: 'smooth', passes: res.passes, of: prev ? prev.method : undefined, srcName: prev ? (prev.srcName || prev.name) : undefined });
    }
    if (act === 'wavg') {
      openWavgMatch(b, gl, acc, anchorBtn, put, inp);
      return;
    }
    if (act === 'reset') {
      pushUndo();
      S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { override: false });
      S.bv = await POST(`/budgets/${b.id}/recalc`);
      render();
    }
  }));
}

/* Seller-line matcher: browse the seller T12's lines (same-category first),
   pick one, grow it — the row takes the seller's monthly actuals, aligned to
   the ownership calendar. */
function openSellerMatch(b, gl, acc, anchorBtn, put) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const start = (S.bv.budget.inputs || {}).startMonth || 1;
  const rows = (S.bv.sellerT12 || []).filter((r) => r.months && r.months.some((v) => v));
  rows.sort((a, z) => {
    const am = a.pcode === acc.pcode ? 0 : 1, zm = z.pcode === acc.pcode ? 0 : 1;
    return am - zm || Math.abs(z.total) - Math.abs(a.total);
  });
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.style.maxHeight = '420px';
  menu.style.overflow = 'auto';
  menu.innerHTML = `
    <div class="rm-head">Match ${gl} ${esc(acc.name || '')} to a seller line</div>
    <div style="padding:4px 6px"><input id="sm-filter" placeholder="filter…" style="width:100%; border:1px solid var(--line); border-radius:6px; padding:4px 7px"></div>
    ${rows.map((r, i) => {
      const sm = billingSmell(fcSellerCal(r));
      return `<button data-sm="${i}" ${r.pcode === acc.pcode ? '' : 'style="opacity:.75"'}>
      ${esc(r.name.slice(0, 34))}${sm ? ` <span class="warnflag" title="Non-accrual pattern: ${esc(sm.join('; '))} — likely bad bills">⚠</span>` : ''} <span class="muted" style="float:right">${money(r.total)}${r.pcode === acc.pcode ? ' · suggested' : ''}</span></button>`;
    }).join('')}`;
  const rct = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rct.left + window.scrollX - 60)}px`;
  menu.style.top = `${rct.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  menu.querySelector('#sm-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    menu.querySelectorAll('button[data-sm]').forEach((btn) => {
      btn.style.display = btn.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  menu.querySelectorAll('button[data-sm]').forEach((btn) => btn.addEventListener('click', async () => {
    const r = rows[Number(btn.dataset.sm)];
    menu.remove();
    const g = parseFloat(String(prompt(`Growth % on "${r.name}" (0 = seller actuals as-is):`, '3') || '').replace(/,/g, ''));
    if (!Number.isFinite(g)) return;
    const res = fcSellerLine(S.bv, S.bv.budget.inputs || {}, r, g);
    await put(res.months, res.driver);
  }));
}

/* T12-total-on-a-curve picker: pick the seller line (its TOTAL is used, so
   even ⚠ non-accrual lines are fine here), then pick the seasonal shape. */
function openT12CurveMatch(b, gl, acc, anchorBtn, put, inp) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const rows = fcSellerRows(S.bv).slice().sort((a, z) => {
    const am = a.pcode === acc.pcode ? 0 : 1, zm = z.pcode === acc.pcode ? 0 : 1;
    return am - zm || Math.abs(z.total) - Math.abs(a.total);
  });
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.style.maxHeight = '420px';
  menu.style.overflow = 'auto';
  const rct = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rct.left + window.scrollX - 60)}px`;
  menu.style.top = `${rct.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);

  const pickShape = (row) => {
    const total = fcSellerCal(row).reduce((a, x) => a + x, 0);
    const shapes = [];
    if (S.bv.compShapes && S.bv.compShapes[gl]) shapes.push(['minot', `Minot shape for ${gl} (clean comp seasonality)`]);
    const own = (S.state.coa.find((x) => x.code === gl) || {}).curve;
    for (const k of Object.keys(S.state.curves || {})) {
      shapes.push([k, `${k} curve${k === own ? ' — this GL’s default' : ''}`]);
    }
    menu.innerHTML = `
      <div class="rm-head">Spread ${esc(row.name.slice(0, 30))} T12 total (${money(total)}) on:</div>
      ${shapes.map(([k, lbl]) => `<button data-sh="${k}">${lbl}</button>`).join('')}
      <button data-sh="smoothed" title="No shape to pick: the seller's own months, missed-bill smoothed (spikes into surrounding months), scaled to total × growth">smoothed seller months — spikes spread out, total kept</button>`;
    menu.querySelectorAll('button[data-sh]').forEach((btn) => btn.addEventListener('click', async () => {
      const shapeKey = btn.dataset.sh;
      menu.remove();
      let weights = null;
      if (shapeKey === 'smoothed') {
        // seller's own calendar series, smoothed → becomes the shape
        weights = smoothMonths(fcSellerCal(row)).months.map((v) => Math.max(0, v));
      }
      const g = parseFloat(String(prompt(`Growth % on the ${money(total)} T12 total:`, '3') || '').replace(/,/g, ''));
      if (!Number.isFinite(g)) return;
      const mult = parseFloat(String(prompt(`MROUND multiple ($, 0 = none) — annual lands at ≈ ${money(total * (1 + g / 100))}:`, '0') || '').replace(/,/g, ''));
      if (!Number.isFinite(mult) || mult < 0) return;
      const res = fcT12Curve(S.bv, inp, row, g, shapeKey === 'smoothed' ? 'custom' : shapeKey, gl, mult, weights);
      await put(res.months, res.driver);
    }));
  };

  menu.innerHTML = `
    <div class="rm-head">T12 total source for ${gl} ${esc(acc.name || '')} — the TOTAL is used, so ⚠ bad-bill lines are fine here</div>
    <div style="padding:4px 6px"><input id="tc-filter" placeholder="filter…" style="width:100%; border:1px solid var(--line); border-radius:6px; padding:4px 7px"></div>
    ${rows.map((r, i) => {
      const sm = billingSmell(fcSellerCal(r));
      return `<button data-tc="${i}" ${r.pcode === acc.pcode ? '' : 'style="opacity:.75"'}>
      ${esc(r.name.slice(0, 34))}${sm ? ` <span class="warnflag" title="Non-accrual months (${esc(sm.join('; '))}) — exactly what this tool is for; only the total is used">⚠</span>` : ''} <span class="muted" style="float:right">${money(r.total)}${r.pcode === acc.pcode ? ' · suggested' : ''}</span></button>`;
    }).join('')}`;
  menu.querySelector('#tc-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    menu.querySelectorAll('button[data-tc]').forEach((btn) => {
      btn.style.display = btn.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  menu.querySelectorAll('button[data-tc]').forEach((btn) => btn.addEventListener('click', () => pickShape(rows[Number(btn.dataset.tc)])));
}

/* Recovery-mapping editor: pick exactly which utility expense lines a
   reimbursement recovers. Saves to inputs.recMap (per budget) — claims are
   exclusive, custom mappings win over the default named claims. */
function openRecMapEditor(b, gl, acc, anchorBtn, line) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const coaByCode = new Map(S.state.coa.map((a) => [a.code, a]));
  // current claim from the chip's src ("6604+6608 (custom)" → codes)
  const cur = new Set(String((line.driver || {}).src || '').match(/\d{4}/g) || []);
  const cands = S.bv.lines
    .map((l) => ({ l, a: coaByCode.get(l.gl_code) }))
    .filter(({ a }) => a && a.kind === 'detail' && a.pcode === '12' && a.active !== false)
    .map(({ l, a }) => ({ gl: l.gl_code, name: a.name, annual: sumM(l.months) }))
    .sort((x, y) => Number(x.gl) - Number(y.gl));
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.style.maxHeight = '440px';
  menu.style.overflow = 'auto';
  menu.innerHTML = `
    <div class="rm-head">${gl} ${esc(acc.name || '')} recovers (% × prior month of):</div>
    ${cands.map((c, i) => `<label style="display:block; font-size:12.3px; padding:2px 8px">
      <input type="checkbox" data-rm="${c.gl}" ${cur.has(c.gl) ? 'checked' : ''}>
      ${c.gl} ${esc(c.name.slice(0, 26))} <span class="muted" style="float:right">${money(c.annual)}</span></label>`).join('')}
    <div style="padding:6px 8px; display:flex; gap:6px">
      <button class="btn sub" data-rmact="default" title="Remove the custom mapping — back to the named default claims">Default</button>
      <button class="btn" data-rmact="save" style="margin-left:auto">Save mapping</button>
    </div>`;
  const rct = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rct.left + window.scrollX - 60)}px`;
  menu.style.top = `${rct.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  const apply = async (recMap) => {
    menu.remove();
    pushUndo();
    S.bv = await PUT(`/budgets/${b.id}`, { inputs: { recMap } });
    render();
  };
  menu.querySelector('[data-rmact="save"]').addEventListener('click', () => {
    const picked = [...menu.querySelectorAll('[data-rm]')].filter((c) => c.checked).map((c) => c.dataset.rm);
    apply({ ...(S.bv.budget.inputs.recMap || {}), [gl]: picked });
  });
  menu.querySelector('[data-rmact="default"]').addEventListener('click', () => {
    const recMap = { ...(S.bv.budget.inputs.recMap || {}) };
    delete recMap[gl];
    apply(recMap);
  });
}

/* Link-line picker: set this GL = another budget line × weight, LIVE — the
   server re-follows the source on every regeneration (W/S move in conjunction). */
function openLinkLineMatch(b, gl, acc, anchorBtn, put) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const coaByCode = new Map(S.state.coa.map((a) => [a.code, a]));
  const thisLine = S.bv.lines.find((l) => l.gl_code === gl);
  const rows = S.bv.lines
    .filter((l) => l.gl_code !== gl && l.months.some((v) => v))
    .map((l) => {
      const a = coaByCode.get(l.gl_code) || {};
      return { gl: l.gl_code, name: a.name || '', pcode: a.pcode, annual: sumM(l.months) };
    })
    .sort((x, y) => {
      const xs = x.pcode === acc.pcode ? 0 : 1, ys = y.pcode === acc.pcode ? 0 : 1;
      return xs - ys || Math.abs(y.annual) - Math.abs(x.annual);
    });
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.style.maxHeight = '420px';
  menu.style.overflow = 'auto';
  menu.innerHTML = `
    <div class="rm-head">${gl} ${esc(acc.name || '')} = which line × weight?</div>
    <div style="padding:4px 6px"><input id="lk-filter" placeholder="filter…" style="width:100%; border:1px solid var(--line); border-radius:6px; padding:4px 7px"></div>
    ${rows.map((r, i) => `<button data-lk="${i}" ${r.pcode === acc.pcode ? '' : 'style="opacity:.75"'}>
      ${r.gl} ${esc(r.name.slice(0, 30))} <span class="muted" style="float:right">${money(r.annual)}${r.pcode === acc.pcode ? ' · same category' : ''}</span></button>`).join('')}`;
  const rct = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rct.left + window.scrollX - 60)}px`;
  menu.style.top = `${rct.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  menu.querySelector('#lk-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    menu.querySelectorAll('button[data-lk]').forEach((btn) => {
      btn.style.display = btn.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  menu.querySelectorAll('button[data-lk]').forEach((btn) => btn.addEventListener('click', async () => {
    const r = rows[Number(btn.dataset.lk)];
    menu.remove();
    const cur = thisLine ? sumM(thisLine.months) : 0;
    const suggest = cur && r.annual ? (Math.round((cur / r.annual) * 1000) / 1000).toString() : '1';
    const w = parseFloat(String(prompt(`Weight on ${r.gl} ${r.name} (this line = source × weight; live):`, suggest) || '').replace(/,/g, ''));
    if (!Number.isFinite(w)) return;
    const src = S.bv.lines.find((l) => l.gl_code === r.gl);
    const months = src.months.map((v) => Math.round(v * w * 100) / 100);
    await put(months, { method: 'linkLine', src: r.gl, srcName: r.name.slice(0, 30), weight: w });
  }));
}

/* T3 comp-line picker: choose WHICH Minot line feeds the T3 weighted average
   (defaults visually to the row's own GL, same-category lines suggested). */
function openCompT3Match(b, gl, acc, anchorBtn, put, inp) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const coaByCode = new Map(S.state.coa.map((a) => [a.code, a]));
  const rows = Object.keys(S.bv.compShapes || {})
    .filter((k) => S.bv.compWeights && S.bv.compWeights[k])
    .map((k) => {
      const a = coaByCode.get(k) || {};
      return { gl: k, name: a.name || k, pcode: a.pcode, annual: S.bv.compWeights[k] };
    })
    .sort((x, y) => {
      const xs = x.gl === gl ? -1 : x.pcode === acc.pcode ? 0 : 1;
      const ys = y.gl === gl ? -1 : y.pcode === acc.pcode ? 0 : 1;
      return xs - ys || Math.abs(y.annual) - Math.abs(x.annual);
    });
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.style.maxHeight = '420px';
  menu.style.overflow = 'auto';
  menu.innerHTML = `
    <div class="rm-head">T3 avg source for ${gl} ${esc(acc.name || '')}</div>
    <div style="padding:4px 6px"><input id="t3-filter" placeholder="filter…" style="width:100%; border:1px solid var(--line); border-radius:6px; padding:4px 7px"></div>
    ${rows.map((r, i) => `<button data-t3="${i}" ${r.pcode === acc.pcode || r.gl === gl ? '' : 'style="opacity:.75"'}>
      ${r.gl} ${esc(r.name.slice(0, 28))} <span class="muted" style="float:right">${money(r.annual)}${r.gl === gl ? ' · this GL' : r.pcode === acc.pcode ? ' · suggested' : ''}</span></button>`).join('')}`;
  const rct = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rct.left + window.scrollX - 60)}px`;
  menu.style.top = `${rct.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  menu.querySelector('#t3-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    menu.querySelectorAll('button[data-t3]').forEach((btn) => {
      btn.style.display = btn.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  menu.querySelectorAll('button[data-t3]').forEach((btn) => btn.addEventListener('click', async () => {
    const r = rows[Number(btn.dataset.t3)];
    menu.remove();
    const g = parseFloat(String(prompt(`Increase factor % on "${r.name}" (the (1+$D) in your formula):`, '3') || '').replace(/,/g, ''));
    if (!Number.isFinite(g)) return;
    const res = fcT3avg(S.bv, inp, r.gl, g);
    if (res) await put(res.months, res.driver);
  }));
}

/* Troy's weighted-average DISTRIBUTION formula, rewritten from Excel:
     budget[month] = MROUND( (2×act[month] + act[prev] + act[next]) / 4 × (1+g), mult )
   Source actuals are pickable — the property's own seller T12 lines or a Minot
   comp line (per-unit scaled to subject units). Year wraps for prev/next. */
function openWavgMatch(b, gl, acc, anchorBtn, put, inp) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const rows = fcWavgRows(S.bv, inp, gl);
  // the property's own SELLER actuals outrank the per-unit-scaled Minot comps —
  // picking a comp line thinking it was actuals silently shrank the total by
  // the unit ratio (e.g. $79K × 268/712u ≈ $30K)
  rows.sort((x, y) => {
    const rank = (r) => r.srcType === 'seller' && r.pcode === acc.pcode ? -2 : r.own ? -1 : r.pcode === acc.pcode ? 0 : 1;
    return rank(x) - rank(y) || Math.abs(y.total * y.scale) - Math.abs(x.total * x.scale);
  });
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.style.maxHeight = '420px';
  menu.style.overflow = 'auto';
  menu.innerHTML = `
    <div class="rm-head">Weighted avg (1-2-1) source for ${gl} ${esc(acc.name || '')}</div>
    <div style="padding:4px 6px"><input id="wa-filter" placeholder="filter…" style="width:100%; border:1px solid var(--line); border-radius:6px; padding:4px 7px"></div>
    ${rows.map((r, i) => {
      const sm = r.srcType === 'seller' ? billingSmell(r.cal) : null;
      return `<button data-wa="${i}" ${r.own || r.pcode === acc.pcode ? '' : 'style="opacity:.75"'}>
      <span class="badge" style="margin:0 4px 0 0">${r.srcType === 'seller' ? (S.bv.annual ? 'T12' : 'Seller') : 'Minot'}</span>${esc(r.name.slice(0, 30))}${sm && !S.bv.annual ? ` <span class="warnflag" title="Non-accrual pattern: ${esc(sm.join('; '))} — likely bad bills">⚠</span>` : ''}
      <span class="muted" style="float:right">${r.scale !== 1 ? `${money(r.total)} → ${money(r.total * r.scale)} at ${inp.units || 0}u` : money(r.total)}${r.own ? ' · this GL' : r.pcode === acc.pcode ? ' · suggested' : ''}</span></button>`;
    }).join('')}`;
  const rct = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rct.left + window.scrollX - 60)}px`;
  menu.style.top = `${rct.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  menu.querySelector('#wa-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    menu.querySelectorAll('button[data-wa]').forEach((btn) => {
      btn.style.display = btn.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  menu.querySelectorAll('button[data-wa]').forEach((btn) => btn.addEventListener('click', async () => {
    const r = rows[Number(btn.dataset.wa)];
    menu.remove();
    const g = parseFloat(String(prompt(`Increase factor % on "${r.name}" (the (1+$D)):`, '3') || '').replace(/,/g, ''));
    if (!Number.isFinite(g)) return;
    const estTotal = r.cal.reduce((a, x) => a + x, 0) * r.scale * (1 + g / 100);
    const mult = parseFloat(String(prompt(`MROUND multiple ($, 0 = no rounding) — annual total lands at ≈ ${money(estTotal)}${r.scale !== 1 ? ` (Minot ${money(r.total)} scaled to ${inp.units || 0} units)` : ''}:`, '250') || '').replace(/,/g, ''));
    if (!Number.isFinite(mult) || mult < 0) return;
    const res = fcWavg(S.bv, inp, r, g, mult);
    await put(res.months, res.driver);
  }));
}

/* Tie choosers: pick WHERE the gap goes instead of the app deciding. */
function openTieIncomeMenu(b, anchorBtn) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const gap = S.bv.tieout.egi.variance;
  const current = (S.bv.budget.inputs || {}).tieIncomeGl || '5003';
  const CANDIDATES = ['5003', '5031', '5035', '5036', '5040', '5020', '5021'];
  const linesByGl = new Map(S.bv.lines.map((l) => [l.gl_code, l]));
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.innerHTML = `
    <div class="rm-head">Income is ${gap > 0 ? 'over' : 'under'} UW by ${money(Math.abs(gap))} — absorb via:</div>
    ${CANDIDATES.map((gl) => {
      const a = S.state.coa.find((x) => x.code === gl);
      if (!a) return '';
      const l = linesByGl.get(gl);
      const cur = l ? sumM(l.months) : 0;
      const locked = l && l.override;
      return `<button data-tg="${gl}" ${locked ? 'disabled title="overridden — unlock first"' : ''}>
        ${gl === current ? '✓ ' : ''}${gl} ${esc(a.name.slice(0, 26))} <span class="muted" style="float:right">${money(cur)}</span></button>`;
    }).join('')}`;
  const rct = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rct.left + window.scrollX - 180)}px`;
  menu.style.top = `${rct.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  menu.querySelectorAll('button[data-tg]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation(); menu.remove();
    pushUndo();
    S.bv = await POST(`/budgets/${b.id}/tie-income`, { gl: btn.dataset.tg });
    render();
  }));
}

function openTieNoiMenu(b, anchorBtn) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const gap = S.bv.tieout.noi.variance;
  const sel = new Set((S.bv.budget.inputs || {}).noiFlexPcodes || ['9', '11', '13', '14']);
  const inclF = (S.bv.budget.inputs || {}).noiFlexFormulas === true;
  const CATS = [['6', 'Insurance'], ['8', 'RE & PP Taxes'], ['9', 'Admin & Acct'], ['10', 'Payroll'], ['11', 'Marketing'], ['12', 'Utilities'], ['13', 'R&M'], ['14', 'Rehab / Reserves']];
  // what CAN the tie actually move in each category?
  const SCALABLE = new Set(['wavg', 't3avg', 'sellerLine', 'perUnitComp', 't12curve', 'smooth']);
  const coaByCode = new Map(S.state.coa.map((a) => [a.code, a]));
  const room = {};
  for (const l of S.bv.lines) {
    const a = coaByCode.get(l.gl_code);
    if (!a || a.kind !== 'detail' || !a.pcode) continue;
    const ann = sumM(l.months);
    if (!ann) continue;
    const r = (room[a.pcode] = room[a.pcode] || { free: 0, formula: 0 });
    if (!l.override) r.free += ann;
    else if (SCALABLE.has((l.driver || {}).method)) r.formula += ann;
  }
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.innerHTML = `
    <div class="rm-head">NOI is ${gap > 0 ? 'over' : 'under'} UW by ${money(Math.abs(gap))} — scale these categories:</div>
    ${CATS.map(([p, label]) => {
      const r = room[p] || { free: 0, formula: 0 };
      return `<label><input type="checkbox" data-tf="${p}" ${sel.has(p) ? 'checked' : ''}> ${label}
        <span class="muted" style="float:right">${r.free ? money(r.free) : '<b style="color:var(--warn)">nothing free</b>'}${r.formula ? ` · fx ${money(r.formula)}` : ''}</span></label>`;
    }).join('')}
    <label title="Let the tie also scale WAVG/T3/Seller/T12C/Minot/Smooth-driven lines in the chosen categories. Manual cells, typed totals, zeros and linked lines are never touched. Scaled formula lines get a * (revised)."><input type="checkbox" data-tff="1" ${inclF ? 'checked' : ''}> <b>Also scale formula-driven lines</b> (copied budgets often have nothing else free)</label>
    <button data-go="1" style="color:var(--accent); font-weight:600">Tie NOI</button>`;
  const rct = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rct.left + window.scrollX - 180)}px`;
  menu.style.top = `${rct.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  menu.querySelector('[data-go]').addEventListener('click', async () => {
    const flex = [...menu.querySelectorAll('[data-tf]')].filter((c) => c.checked).map((c) => c.dataset.tf);
    const includeFormulas = menu.querySelector('[data-tff]').checked;
    menu.remove();
    if (!flex.length) return;
    pushUndo();
    S.bv = await POST(`/budgets/${b.id}/tie-noi`, { flexPcodes: flex, includeFormulas });
    render();
    const left = S.bv.tieout.noi.variance;
    if (Math.abs(left) >= 1) {
      alert(`NOI is still off UW by ${money(Math.abs(left))}.\n\nThe chosen categories don't have enough scalable dollars — everything else in them is manually overridden (or the tie would push lines negative). Options: tick "Also scale formula-driven lines", pick more categories, or unlock (🔓) lines in the flex categories.`);
    }
  });
}

/* Bulk MROUND dialog: pick a multiple, tick exactly which lines it applies
   to. Engine-allocated lines are pre-checked; the "specific" formulas (GPR,
   LTL, vacancy, mgmt fee, interest, wages, recovery, charges) are not. */
function openRoundDialog(b) {
  const dlg = document.getElementById('round-dlg');
  const coaByCode = new Map(S.state.coa.map((a) => [a.code, a]));
  const AUTO = new Set(['catShare', 'perUnitComp', 't3avg', 'sellerLine', 'sellerUtil', 'burdenRatio']);
  const cands = S.bv.lines
    .filter((l) => l.months.some((v) => v) || l.round)
    .map((l) => {
      const a = coaByCode.get(l.gl_code) || {};
      return { gl: l.gl_code, name: a.name || '', section: a.section || '', annual: sumM(l.months),
               suggested: AUTO.has((l.driver || {}).method) && !l.override, tag: drvMeta(l).tag, round: l.round || 0 };
    })
    .sort((x, y) => Number(x.gl) - Number(y.gl));
  const bySection = {};
  for (const c of cands) (bySection[c.section] = bySection[c.section] || []).push(c);
  dlg.innerHTML = `
    <h2>Bulk MROUND — standing rounding (not a lock)</h2>
    <p class="muted" style="margin:0 0 8px; font-size:12px">Sets a rounding multiple ON the selected lines: applies now and re-applies automatically whenever formulas regenerate. Lines stay live on their formulas. Multiple 0 clears rounding.</p>
    <div class="row">
      <div class="fld"><label>Multiple $ (0 = clear)</label><input id="rd-mult" value="250" style="width:90px"></div>
      ${[0, 100, 250, 300, 500, 1000].map((m) => `<button class="btn sub" data-preset="${m}">${m === 0 ? 'Clear' : '$' + m}</button>`).join('')}
      <span class="spacer" style="flex:1"></span>
      <button class="btn sub" id="rd-sugg">Suggested</button>
      <button class="btn sub" id="rd-rounded">Currently rounded</button>
      <button class="btn sub" id="rd-all">All</button>
      <button class="btn sub" id="rd-none">None</button>
    </div>
    <div style="max-height:46vh; overflow:auto; margin-top:10px; border:1px solid var(--line); border-radius:8px; padding:6px 10px">
      ${Object.entries(bySection).map(([sec, list]) => `
        <div style="margin:6px 0 2px"><label style="font-weight:650; font-size:12px; color:var(--dim); text-transform:uppercase">
          <input type="checkbox" data-sec="${esc(sec)}"> ${esc(sec.replace(/_/g, ' '))}</label></div>
        ${list.map((c) => `<label style="display:inline-block; width:49%; font-size:12.3px; padding:1px 0">
          <input type="checkbox" data-rd="${c.gl}" data-secof="${esc(c.section)}" data-sugg="${c.suggested ? 1 : 0}" data-rounded="${c.round ? 1 : 0}" ${c.suggested ? 'checked' : ''}>
          ${c.gl} ${esc(c.name.slice(0, 24))} <span class="muted">${money(c.annual)} · ${c.tag}${c.round ? ` · ≈$${c.round}` : ''}</span></label>`).join('')}`).join('')}
    </div>
    <div class="err" id="rd-err"></div>
    <div class="foot">
      <span class="muted" style="align-self:center; margin-right:auto; font-size:11.5px">Rounding drift shows as small tie-out variance — re-tie NOI if you want it exact.</span>
      <button class="btn sub" id="rd-x">Cancel</button>
      <button class="btn" id="rd-go">Apply</button>
    </div>`;
  const boxes = () => [...dlg.querySelectorAll('[data-rd]')];
  dlg.querySelectorAll('[data-preset]').forEach((p) => p.addEventListener('click', () => { dlg.querySelector('#rd-mult').value = p.dataset.preset; }));
  dlg.querySelector('#rd-sugg').addEventListener('click', () => boxes().forEach((c) => { c.checked = c.dataset.sugg === '1'; }));
  dlg.querySelector('#rd-rounded').addEventListener('click', () => boxes().forEach((c) => { c.checked = c.dataset.rounded === '1'; }));
  dlg.querySelector('#rd-all').addEventListener('click', () => boxes().forEach((c) => { c.checked = true; }));
  dlg.querySelector('#rd-none').addEventListener('click', () => boxes().forEach((c) => { c.checked = false; }));
  dlg.querySelectorAll('[data-sec]').forEach((s) => s.addEventListener('change', () => {
    boxes().filter((c) => c.dataset.secof === s.dataset.sec).forEach((c) => { c.checked = s.checked; });
  }));
  dlg.querySelector('#rd-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#rd-go').addEventListener('click', async () => {
    const multiple = parseFloat(String(dlg.querySelector('#rd-mult').value).replace(/,/g, ''));
    const gls = boxes().filter((c) => c.checked).map((c) => c.dataset.rd);
    if (!Number.isFinite(multiple) || multiple < 0) { dlg.querySelector('#rd-err').textContent = 'Enter a multiple ≥ 0 (0 clears)'; return; }
    if (!gls.length) { dlg.querySelector('#rd-err').textContent = 'Pick at least one line'; return; }
    try {
      pushUndo();
      S.bv = await POST(`/budgets/${b.id}/round`, { multiple, gls });
      render();
    } catch (e) { dlg.querySelector('#rd-err').textContent = e.message; }
  });
  dlg.showModal();
}

/* ---------------- save points (persisted iterations) ----------------
   Named server-side snapshots of the whole budget (lines + inputs). Restore
   brings one back verbatim; a "before restoring" point is captured first so
   a restore can itself be undone. */
function openSavePoints(b) {
  const dlg = document.getElementById('sp-dlg');
  const paint = () => {
    const sps = S.bv.savePoints || [];
    dlg.innerHTML = `
      <h2>Save points — ${sps.length} iteration${sps.length === 1 ? '' : 's'} kept</h2>
      <div class="row">
        <div class="fld" style="flex:1"><label>Name this iteration</label><input id="sp-name" placeholder="e.g. pre-utility rework · sent to review · v2" style="width:100%"></div>
        <button class="btn" id="sp-save" style="align-self:flex-end">⎘ Save current</button>
      </div>
      <div style="max-height:46vh; overflow:auto; margin-top:10px; border:1px solid var(--line); border-radius:8px">
        ${sps.length ? `<table class="list" style="width:100%"><tr><th>Save point</th><th>NOI</th><th>Income</th><th>OpEx</th><th>Overrides</th><th>By</th><th>When</th><th></th></tr>
          ${sps.map((s) => {
            const sm = s.summary || {};
            return `<tr><td>${esc(s.name)}</td>
              <td>${money(sm.noi)}</td><td>${money(sm.income)}</td><td>${money(sm.expense)}</td>
              <td class="muted">${sm.overrides ?? ''}</td>
              <td class="muted">${esc(s.created_by)}</td>
              <td class="muted">${new Date(s.created_at).toLocaleString()}</td>
              <td style="white-space:nowrap">
                <button class="rb" data-sprestore="${s.id}" title="Restore this iteration verbatim (current state is saved first)">⟲ restore</button>
                <button class="rb" data-spdel="${s.id}" title="Delete this save point">🗑</button>
              </td></tr>`;
          }).join('')}</table>` : '<p class="muted" style="padding:10px">No save points yet — capture one before big changes (copies, releases, re-links).</p>'}
      </div>
      <div class="err" id="sp-err"></div>
      <div class="foot"><button class="btn sub" id="sp-x">Close</button></div>`;
    // NOTE: no render() while the dialog is open — a full re-render would
    // replace the dialog element out from under us; the grid refreshes on Close
    dlg.querySelector('#sp-x').addEventListener('click', () => { dlg.close(); render(); });
    dlg.querySelector('#sp-save').addEventListener('click', async () => {
      try {
        S.bv = await POST(`/budgets/${b.id}/snapshots`, { name: dlg.querySelector('#sp-name').value });
        paint();
      } catch (e) { dlg.querySelector('#sp-err').textContent = e.message; }
    });
    dlg.querySelectorAll('[data-sprestore]').forEach((x) => x.addEventListener('click', async () => {
      if (!confirm('Restore this iteration? The current state is saved as its own point first.')) return;
      try {
        S.bv = await POST(`/budgets/${b.id}/snapshots/${x.dataset.sprestore}/restore`);
        S.undo = { budgetId: b.id, stack: [] };   // undo stack belongs to the old iteration
        paint();
      } catch (e) { dlg.querySelector('#sp-err').textContent = e.message; }
    }));
    dlg.querySelectorAll('[data-spdel]').forEach((x) => x.addEventListener('click', async () => {
      if (!confirm('Delete this save point permanently?')) return;
      try {
        S.bv = await DEL(`/budgets/${b.id}/snapshots/${x.dataset.spdel}`);
        paint();
      } catch (e) { dlg.querySelector('#sp-err').textContent = e.message; }
    }));
  };
  paint();
  dlg.showModal();
}

/* ---------------- overrides audit / lock release ----------------
   The old bulk-MROUND LOCKED lines (override=true, driver manual) instead of
   setting a standing multiple — those leftovers masquerade as manual work.
   This dialog lists every override, flags MAN lines whose months sit in exact
   $ multiples as likely round-locks, and releases them back to their live
   engine formula with the detected multiple as a standing MROUND. */
function detectLockMultiple(months) {
  const nz = months.filter((v) => v);
  if (!nz.length) return 0;
  for (const m of [1000, 500, 300, 250, 100]) {
    if (nz.every((v) => Math.abs(Math.round(v) - v) < 0.005 && Math.round(Math.abs(v)) % m === 0)) return m;
  }
  return 0;
}
function openOverridesAudit(b) {
  const dlg = document.getElementById('ovr-dlg');
  const coaByCode = new Map(S.state.coa.map((a) => [a.code, a]));
  const rows = S.bv.lines.filter((l) => l.override).map((l) => {
    const a = coaByCode.get(l.gl_code) || {};
    const dm = drvMeta(l);
    const isMan = !l.driver || !l.driver.method || l.driver.method === 'manual';
    const lockMult = isMan ? detectLockMultiple(l.months) : 0;
    const zeroed = !l.months.some((v) => v);
    return { gl: l.gl_code, name: a.name || '', dm, lockMult, zeroed, annual: sumM(l.months), round: l.round || 0 };
  }).sort((x, y) => Number(x.gl) - Number(y.gl));
  const locks = rows.filter((r) => r.lockMult).length;
  dlg.innerHTML = `
    <h2>Overridden lines — ${rows.length} on this budget</h2>
    <p class="muted" style="margin:0 0 8px; font-size:12px">MAN lines whose months all sit in exact $ multiples are usually leftovers of the old bulk-MROUND, which <b>locked</b> lines instead of setting a standing multiple. Releasing puts a line back on its live engine formula with the detected multiple as a standing MROUND — same rounded look, real formula. ${locks ? `<b>${locks} likely round-lock${locks > 1 ? 's' : ''} detected (pre-checked).</b>` : 'No round-locks detected.'}</p>
    <div class="row" style="margin:0 0 6px">
      <button class="btn sub" id="ov-all">All</button>
      <button class="btn sub" id="ov-locks">Round-locks only</button>
      <button class="btn sub" id="ov-none">None</button>
    </div>
    <div style="max-height:46vh; overflow:auto; border:1px solid var(--line); border-radius:8px; padding:6px 10px">
      ${rows.map((r, i) => `<label style="display:block; font-size:12.3px; padding:2px 0">
        <input type="checkbox" data-ov="${i}" data-lock="${r.lockMult ? 1 : 0}" data-zero="${r.zeroed ? 1 : 0}" ${r.lockMult ? 'checked' : ''}>
        ${r.gl} ${esc(r.name.slice(0, 32))} <span class="drv ${r.dm.cls}" style="margin:0 4px">${r.dm.tag}</span>
        <span class="muted">${money(r.annual)} · ${r.zeroed ? '<b>zeroed out — release would let the engine refill it</b> · ' : ''}${esc(r.dm.label.slice(0, 55))}${r.lockMult ? ` · <b>likely $${r.lockMult} round-lock</b>` : ''}${r.round ? ` · ≈$${r.round}` : ''}</span></label>`).join('')}
    </div>
    <div class="err" id="ov-err"></div>
    <div class="foot">
      <span class="muted" style="align-self:center; margin-right:auto; font-size:11.5px">Release = unlock + standing MROUND (where detected) + one recalc. Ties re-apply. One Undo reverses everything.</span>
      <button class="btn sub" id="ov-x">Close</button>
      <button class="btn" id="ov-go" ${rows.length ? '' : 'disabled'}>Release selected → live formulas</button>
    </div>`;
  const ovBoxes = () => [...dlg.querySelectorAll('[data-ov]')];
  // "All" deliberately skips zeroed-out lines — releasing one lets the engine
  // refill a GL that was silenced on purpose; tick those individually
  dlg.querySelector('#ov-all').addEventListener('click', () => ovBoxes().forEach((c) => { c.checked = c.dataset.zero !== '1'; }));
  dlg.querySelector('#ov-locks').addEventListener('click', () => ovBoxes().forEach((c) => { c.checked = c.dataset.lock === '1'; }));
  dlg.querySelector('#ov-none').addEventListener('click', () => ovBoxes().forEach((c) => { c.checked = false; }));
  dlg.querySelector('#ov-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#ov-go').addEventListener('click', async () => {
    const go = dlg.querySelector('#ov-go');
    const picked = [...dlg.querySelectorAll('[data-ov]')].filter((c) => c.checked).map((c) => rows[Number(c.dataset.ov)]);
    if (!picked.length) { dlg.querySelector('#ov-err').textContent = 'Pick at least one line'; return; }
    go.disabled = true;
    try {
      pushUndo();
      // standing MROUNDs first (grouped), so the recalc re-applies them
      const byMult = {};
      for (const r of picked) if (r.lockMult && !r.round) (byMult[r.lockMult] = byMult[r.lockMult] || []).push(r.gl);
      for (const [multiple, gls] of Object.entries(byMult)) {
        S.bv = await POST(`/budgets/${b.id}/round`, { multiple: Number(multiple), gls });
      }
      let n = 0;
      for (const r of picked) {
        go.textContent = `Releasing ${++n}/${picked.length}…`;
        S.bv = await PUT(`/budgets/${b.id}/lines/${r.gl}`, { override: false });
      }
      S.bv = await POST(`/budgets/${b.id}/recalc`);
      dlg.close();
      render();
    } catch (e) {
      dlg.querySelector('#ov-err').textContent = e.message;
      go.disabled = false; go.textContent = 'Release selected → live formulas';
    }
  });
  dlg.showModal();
}

/* ---------------- formula copier ----------------
   Replay another budget's named formulas (WAVG, T3, Seller line, Minot $/unit)
   onto THIS budget — every formula re-evaluates against this property's OWN
   data (its seller statement, comps scaled to its units), so nothing from the
   source property carries over. Fixed values (manual edits, typed totals,
   flats, zeros) are listed but never copied. */
function openCopyFormulas(b) {
  const dlg = document.getElementById('copy-dlg');
  const coaByCode = new Map(S.state.coa.map((a) => [a.code, a]));
  const sources = S.state.budgets.filter((x) => x.id !== b.id);
  if (!sources.length) { alert('No other budgets to copy from.'); return; }
  const RECOMPUTABLE = new Set(['wavg', 't3avg', 'sellerLine', 'perUnitComp', 't12curve', 'linkLine']);
  let plan = null;

  const buildPlan = async (srcId) => {
    const srcBv = await GET(`/budgets/${srcId}`);
    const tinp = S.bv.budget.inputs || {};
    const items = [];   // resolvable formulas
    const skipped = []; // fixed values + unresolvable
    for (const l of srcBv.lines) {
      const d = l.driver || {};
      const acc = coaByCode.get(l.gl_code) || {};
      const label = `${l.gl_code} ${acc.name || ''}`;
      if (!l.override) continue;                       // engine lines — the target's engine already is the "this property" version
      if (!RECOMPUTABLE.has(d.method)) {
        // a ZERO-OUT is structural, not a dollar value — it's the part of the
        // recipe that KILLS a GL's engine share (commercial rent etc.). Not
        // copying these left the target's engine shares alive and inflated
        // the category. Copy them.
        if (!l.months.some((v) => v)) {
          const tl = S.bv.lines.find((x) => x.gl_code === l.gl_code);
          items.push({
            gl: l.gl_code, label, months: Array(12).fill(0), driver: { method: 'zero' },
            fx: { cls: 'drv-int', tag: 'ZERO', label: 'Zero out (kills the engine share)' },
            newAnnual: 0,
            replaces: tl && tl.override ? 'replaces an override here' : '',
          });
        } else {
          skipped.push({ label, why: 'fixed value (manual / typed total / flat) — set it here directly' });
        }
        continue;
      }
      let res = null, why = '';
      if (d.method === 'perUnitComp') {
        res = fcMinot(S.bv, tinp, l.gl_code, d.pcode || acc.pcode);
        if (!res) why = 'no Minot comp data for this GL on this budget';
      } else if (d.method === 't3avg') {
        res = fcT3avg(S.bv, tinp, d.src || l.gl_code, d.pct || 0);
        if (!res) why = 'no Minot comp shape for the source GL on this budget';
      } else if (d.method === 'sellerLine') {
        const row = fcFindSeller(S.bv, d.name);
        if (row) res = fcSellerLine(S.bv, tinp, row, d.pct || 0);
        else why = `no seller line named "${d.name || '?'}" on this budget's T12`;
      } else if (d.method === 't12curve') {
        const row = fcFindSeller(S.bv, d.name);
        if (row) res = fcT12Curve(S.bv, tinp, row, d.pct || 0, d.shape, l.gl_code, d.mult || 0, d.weights || null);
        else why = `no seller line named "${d.name || '?'}" on this budget's T12`;
      } else if (d.method === 'linkLine') {
        // live on the server — seed months from the TARGET's own source line
        const src = S.bv.lines.find((x) => x.gl_code === d.src);
        if (src) res = { months: src.months.map((v) => Math.round(v * (d.weight || 1) * 100) / 100), driver: { method: 'linkLine', src: d.src, srcName: d.srcName || '', weight: d.weight ?? 1 } };
        else why = `no line ${d.src || '?'} on this budget`;
      } else if (d.method === 'wavg') {
        const rows = fcWavgRows(S.bv, tinp, l.gl_code);
        let row = null;
        if (d.srcType === 'seller') {
          const want = String(d.srcName || '').trim().toLowerCase();
          row = rows.find((r) => r.srcType === 'seller' && r.name.trim().toLowerCase() === want)
             || rows.find((r) => r.srcType === 'seller' && r.name.trim().toLowerCase().startsWith(want));
          if (!row) why = `no seller line named "${d.srcName || '?'}" on this budget's T12`;
        } else {
          const glCode = String(d.srcName || '').match(/^(\S+)/)?.[1];
          row = rows.find((r) => r.srcType === 'comp' && r.glCode === glCode);
          if (!row) why = `no Minot comp line ${glCode || '?'} on this budget`;
        }
        if (row) res = fcWavg(S.bv, tinp, row, d.pct || 0, d.mult || 0);
      }
      if (res) {
        const tl = S.bv.lines.find((x) => x.gl_code === l.gl_code);
        items.push({
          gl: l.gl_code, label, months: res.months, driver: res.driver,
          fx: drvMeta({ ...l, driver: res.driver, override: true }),
          newAnnual: res.months.reduce((a, v) => a + v, 0),
          replaces: tl && tl.override ? 'replaces an override here' : '',
        });
      } else skipped.push({ label, why });
    }
    // standing MROUND multiples on the source (engine lines included)
    const rounds = srcBv.lines.filter((l) => l.round > 0).map((l) => ({ gl: l.gl_code, multiple: l.round }));
    return { srcBv, items, skipped, rounds };
  };

  const paint = () => {
    const p = plan;
    dlg.innerHTML = `
      <h2>Copy formulas from another budget</h2>
      <p class="muted" style="margin:0 0 8px; font-size:12px">Replays the source's named formulas (WAVG, T3, Seller line, Minot $/unit) using <b>this property's own data</b> — its seller statement, comps at its unit count. Nothing references the source property. <b>Zero-outs copy too</b> — they're the part of the recipe that kills a GL's engine share (commercial rent etc.). Dollar values (manual edits, typed totals, flats) don't copy. Finishes with a recalc so ties, standing MROUNDs and inactive-GL exclusions land consistently.</p>
      <div class="row">
        <div class="fld"><label>Source budget</label>
          <select id="cf-src">${sources.map((x) => `<option value="${x.id}" ${p && p.srcBv.budget.id === x.id ? 'selected' : ''}>${esc(x.property_code)} ${x.year} — ${esc(x.label || '')}</option>`).join('')}</select></div>
      </div>
      ${!p ? '<p class="muted">Loading…</p>' : `
      <div style="max-height:40vh; overflow:auto; margin-top:8px; border:1px solid var(--line); border-radius:8px; padding:6px 10px">
        ${p.items.length ? p.items.map((it, i) => `<label style="display:block; font-size:12.3px; padding:2px 0">
          <input type="checkbox" data-cf="${i}" checked>
          ${esc(it.label.slice(0, 40))} <span class="drv ${it.fx.cls}" style="margin:0 4px">${it.fx.tag}</span>
          <span class="muted">${esc(it.fx.label.slice(0, 60))} → Year 1 ${money(it.newAnnual)}${it.replaces ? ' · ' + it.replaces : ''}</span></label>`).join('')
          : '<p class="muted">No transferable formulas on the source budget.</p>'}
        ${p.skipped.length ? `<div style="margin-top:8px; border-top:1px solid var(--line); padding-top:6px">
          <b style="font-size:11.5px; color:var(--dim)">NOT copied:</b>
          ${p.skipped.map((s) => `<div class="muted" style="font-size:11.5px">✗ ${esc(s.label.slice(0, 40))} — ${esc(s.why)}</div>`).join('')}</div>` : ''}
      </div>
      <div class="row" style="margin-top:8px">
        ${p.rounds.length ? `<label style="align-self:center"><input type="checkbox" id="cf-rounds" checked> Copy standing MROUND multiples (${p.rounds.length} lines)</label>` : ''}
      </div>`}
      <div class="err" id="cf-err"></div>
      <div class="foot">
        <span class="muted" style="align-self:center; margin-right:auto; font-size:11.5px">One Undo step reverses the whole copy.</span>
        <button class="btn sub" id="cf-x">Cancel</button>
        <button class="btn" id="cf-go" ${p && p.items.length ? '' : 'disabled'}>Apply</button>
      </div>`;
    dlg.querySelector('#cf-x').addEventListener('click', () => dlg.close());
    dlg.querySelector('#cf-src').addEventListener('change', async (e) => {
      plan = null; paint();
      plan = await buildPlan(Number(e.target.value)); paint();
    });
    const go = dlg.querySelector('#cf-go');
    if (go) go.addEventListener('click', async () => {
      const picked = [...dlg.querySelectorAll('[data-cf]')].filter((c) => c.checked).map((c) => plan.items[Number(c.dataset.cf)]);
      const doRounds = dlg.querySelector('#cf-rounds')?.checked && plan.rounds.length;
      if (!picked.length && !doRounds) { dlg.querySelector('#cf-err').textContent = 'Pick at least one formula'; return; }
      go.disabled = true;
      try {
        pushUndo();
        let n = 0;
        for (const it of picked) {
          go.textContent = `Applying ${++n}/${picked.length}…`;
          S.bv = await PUT(`/budgets/${b.id}/lines/${it.gl}`, { months: it.months, driver: it.driver });
        }
        if (doRounds) {
          // group by multiple — one round call per distinct multiple
          const byMult = {};
          for (const r of plan.rounds) (byMult[r.multiple] = byMult[r.multiple] || []).push(r.gl);
          for (const [multiple, gls] of Object.entries(byMult)) {
            S.bv = await POST(`/budgets/${b.id}/round`, { multiple: Number(multiple), gls });
          }
        }
        // land the budget consistent: regenerate engine lines (inactive GLs
        // zero out), re-apply ties and standing rounds
        go.textContent = 'Recalculating…';
        S.bv = await POST(`/budgets/${b.id}/recalc`);
        dlg.close();
        render();
      } catch (e2) {
        dlg.querySelector('#cf-err').textContent = e2.message;
        go.disabled = false; go.textContent = 'Apply';
      }
    });
  };

  paint();
  dlg.showModal();
  buildPlan(sources[0].id).then((p) => { plan = p; paint(); })
    .catch((e) => { dlg.querySelector('#cf-err').textContent = e.message; });
}

/* ---------------- payroll model editor ----------------
   Edit the model's per-property wage aggregates IN PLACE — when a re-upload
   or repoint isn't the fix, change the numbers here; every budget linked to
   this model regenerates (wage-line overrides in budgets are still kept). */
async function openPayrollEditor(id) {
  const dlg = document.getElementById('pm-dlg');
  const m = await GET(`/payroll-models/${id}`);
  const gls = [['6402', 'Admin'], ['6404', 'Maintenance'], ['6405', 'Landscaping'], ['6407', 'Rover']];
  const codes = Object.keys(m.properties || {}).sort();
  dlg.innerHTML = `
    <h2>Edit payroll model</h2>
    <div class="row"><div class="fld"><label>Model name</label><input id="pme-label" value="${esc(m.label || '')}" style="min-width:280px"></div></div>
    <div style="max-height:50vh; overflow:auto; margin-top:8px">
      <table class="list"><tr><th>Property</th>${gls.map(([g, l]) => `<th>${g} ${l}</th>`).join('')}<th>Total</th></tr>
      ${codes.map((c) => `<tr><td><b>${esc(c)}</b></td>
        ${gls.map(([g]) => `<td><input data-pme="${c}:${g}" value="${(m.properties[c] || {})[g] ?? 0}" style="width:92px; text-align:right"></td>`).join('')}
        <td class="pme-tot" data-tot="${c}"><b>${money(gls.reduce((a, [g]) => a + ((m.properties[c] || {})[g] || 0), 0))}</b></td></tr>`).join('')}</table>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn sub" id="pme-move65" title="Landscaping is contracted work, not payroll — folds every property's 6405 into 6404 and zeroes 6405 (in the fields; Save applies it)">6405 → 6404 (landscaping is not payroll)</button>
      <button class="btn sub" id="pme-addprop" title="Add a property row this model is missing (e.g. the parser didn't find it)">＋ Add property</button>
      <label style="align-self:center" title="Point EVERY budget at this model when saving — the recovery move when budgets got detached"><input type="checkbox" id="pme-linkall" checked> Link ALL budgets to this model</label>
    </div>
    <div class="err" id="pme-err"></div>
    <div class="foot">
      <span class="muted" style="align-self:center; margin-right:auto; font-size:11.5px">Saving regenerates every linked budget. Benefits/bonuses follow the new wage totals via the Minot ratios.</span>
      <button class="btn sub" id="pme-x">Cancel</button>
      <button class="btn" id="pme-go">Save & regenerate</button>
    </div>`;
  const recalcTot = () => {
    for (const c of codes) {
      const tot = gls.reduce((a, [g]) => a + (parseFloat(String(dlg.querySelector(`[data-pme="${c}:${g}"]`).value).replace(/,/g, '')) || 0), 0);
      dlg.querySelector(`[data-tot="${c}"]`).innerHTML = `<b>${money(tot)}</b>`;
    }
  };
  dlg.querySelectorAll('[data-pme]').forEach((x) => x.addEventListener('input', recalcTot));
  dlg.querySelector('#pme-move65').addEventListener('click', () => {
    for (const c of codes) {
      const from = dlg.querySelector(`[data-pme="${c}:6405"]`);
      const to = dlg.querySelector(`[data-pme="${c}:6404"]`);
      const v = parseFloat(String(from.value).replace(/,/g, '')) || 0;
      if (v) {
        to.value = String(Math.round(((parseFloat(String(to.value).replace(/,/g, '')) || 0) + v) * 100) / 100);
        from.value = '0';
      }
    }
    recalcTot();
  });
  dlg.querySelector('#pme-addprop').addEventListener('click', () => {
    const code = String(prompt('Property code to add (e.g. cwnd):', '') || '').trim().toLowerCase();
    if (!code || codes.includes(code)) return;
    codes.push(code);
    dlg.querySelector('table.list').insertAdjacentHTML('beforeend', `<tr><td><b>${esc(code)}</b></td>
      ${gls.map(([g]) => `<td><input data-pme="${code}:${g}" value="0" style="width:92px; text-align:right"></td>`).join('')}
      <td class="pme-tot" data-tot="${esc(code)}"><b>${money(0)}</b></td></tr>`);
    dlg.querySelectorAll(`[data-pme^="${code}:"]`).forEach((x) => x.addEventListener('input', recalcTot));
  });
  dlg.querySelector('#pme-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#pme-go').addEventListener('click', async () => {
    const properties = {};
    dlg.querySelectorAll('[data-pme]').forEach((x) => {
      const [c, g] = x.dataset.pme.split(':');
      (properties[c] = properties[c] || {})[g] = parseFloat(String(x.value).replace(/,/g, '')) || 0;
    });
    try {
      const resp = await PUT(`/payroll-models/${id}`, { label: dlg.querySelector('#pme-label').value, properties, linkAll: dlg.querySelector('#pme-linkall').checked });
      dlg.close();
      S.upload = S.upload || {}; S.upload.msg = `Payroll model saved · ${resp.regenerated || 0} budget(s) regenerated`;
      await refreshState(); render();
    } catch (e2) { dlg.querySelector('#pme-err').textContent = e2.message; }
  });
  dlg.showModal();
}

/* ---------------- settings ---------------- */
function renderSettings(el) {
  const st = S.state;
  const pf = new Map(st.portfolios.map((p) => [p.id, p.name]));
  el.innerHTML = `
    <div class="card">
      <h2>Properties</h2>
      <table class="list"><tr><th>Code</th><th>Name</th><th>Units</th><th>Market</th><th>Portfolio</th><th>Role</th></tr>
      ${st.properties.map((p) => `<tr><td><b>${p.code}</b></td><td>${esc(p.name)}</td>
        <td>${S.auth.isAdmin ? `<input data-units="${p.code}" value="${p.units}" style="width:60px">` : p.units}</td>
        <td>${esc(p.market)}</td><td>${esc(pf.get(p.portfolio_id) || '')}</td><td>${esc(p.role)}</td></tr>`).join('')}</table>
      ${S.auth.isAdmin ? '<p class="muted">Edit a unit count and press Enter to save.</p>' : ''}
    </div>
    <div class="card">
      <h2>Chart of accounts <span class="badge">${st.coa.length} accounts</span></h2>
      <div class="row"><div class="fld"><label>Filter</label><input id="coa-f" placeholder="code or name"></div></div>
      <div style="max-height:420px; overflow:auto; margin-top:8px">
        <table class="list" id="coa-t"><tr><th>Code</th><th>Name</th><th>Kind</th><th>Section</th><th>P-code</th><th>Curve</th><th>CSV#</th><th>Active</th></tr>
        ${st.coa.map((a) => `<tr data-row="${a.code} ${esc(a.name).toLowerCase()}" ${a.active === false ? 'style="opacity:.45"' : ''}><td>${a.code}</td><td>${esc(a.name)}</td><td class="muted">${a.kind}</td><td class="muted">${a.section}</td>
          <td>${S.auth.isAdmin && a.kind === 'detail' ? `<input data-pc="${a.code}" value="${a.pcode ?? ''}" style="width:44px">` : (a.pcode ?? '')}</td>
          <td>${S.auth.isAdmin && a.kind === 'detail' ? `<input data-cv="${a.code}" value="${a.curve ?? ''}" style="width:70px">` : (a.curve ?? '')}</td>
          <td class="muted">${a.csv_order ?? ''}</td>
          <td>${S.auth.isAdmin && a.kind === 'detail' ? `<input type="checkbox" data-ac="${a.code}" ${a.active !== false ? 'checked' : ''} title="Inactive GLs are hidden from the grid AND excluded from comp-weight category spreads (their share re-spreads over the active GLs; the category still ties). CSV exports still include them as zero rows.">` : (a.active !== false ? '✓' : '')}</td></tr>`).join('')}</table>
      </div>
      <p class="muted">Curves: flat, snow, winter, heat, electric, summer, turnover. P-codes: 1, loss, 2–14 (blank = below the line). Unchecking Active removes a GL from category spreads on the next recalc — use it for comp-set GLs the subjects can't earn (e.g. 5118 COMMERCIAL RENT).</p>
    </div>`;
  el.querySelector('#coa-f').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    el.querySelectorAll('#coa-t tr[data-row]').forEach((tr) => { tr.style.display = tr.dataset.row.includes(q) ? '' : 'none'; });
  });
  el.querySelectorAll('[data-units]').forEach((box) => box.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const p = st.properties.find((x) => x.code === box.dataset.units);
    await POST('/properties', { ...p, code: p.code, units: Number(box.value) || 0, portfolioId: p.portfolio_id });
    await refreshState(); render();
  }));
  const saveGl = async (box, field) => {
    await PUT(`/gl/${box.dataset.pc || box.dataset.cv}`, field === 'pcode' ? { pcode: box.value || null } : { curve: box.value || null });
    await refreshState();
  };
  el.querySelectorAll('[data-pc]').forEach((b2) => b2.addEventListener('change', () => saveGl(b2, 'pcode')));
  el.querySelectorAll('[data-cv]').forEach((b2) => b2.addEventListener('change', () => saveGl(b2, 'curve')));
  el.querySelectorAll('[data-ac]').forEach((b2) => b2.addEventListener('change', async () => {
    await PUT(`/gl/${b2.dataset.ac}`, { active: b2.checked });
    await refreshState(); render();
  }));
}

boot();


/* ---------------- actualize a closed month (partial-month rule) ----------------
   After a month closes, its Yardi Property Comparison (Cash) locks that month
   of the budget 1:1 to what posted. In-window months overlay the grid (✓
   column); a pre-start closing month (close mid-Aug, plan starts Sep) rides
   only in the calendar-year CSV. Plan formulas are untouched — release
   hands the month back to them. */
function openActualize(b, result) {
  const dlg = document.getElementById('act-dlg');
  if (!dlg) return;
  const acts = (S.bv && S.bv.actualMonths) || [];
  const labels = (S.bv && S.bv.monthLabels) || MONTHS;
  const code = String(b.property_code).toUpperCase();
  const exList = (title, arr, cls) => arr && arr.length ? `<div style="margin-top:6px"><b style="font-size:11.5px; color:var(--dim)">${title}</b>${arr.map((e) =>
    `<div style="font-size:11.5px"><span class="drv ${cls}" style="margin-right:4px">${esc(e.gl)}</span>${esc(e.name)} <b>${money2(e.amount)}</b>${e.to ? ` → budgeted on ${esc(e.to)}` : ''} <span class="muted">— ${esc(e.reason)}</span></div>`).join('')}</div>` : '';
  const summaryHtml = (a) => {
    const tot = Object.values(a.glMonths || {}).reduce((x, y) => x + y, 0);
    const s = a.summary || {};
    return `<div style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:8px">
      <b>✓ ${esc(a.period)}</b> · ${esc(a.book)} · ${a.index >= 0 ? `ownership month <b>${esc(labels[a.index])}</b> — column locked in the grid` : 'partial closing month before the ownership window — carried in the calendar-year Yardi CSV only'}
      <div class="muted" style="font-size:11.5px; margin-top:2px">${Object.keys(a.glMonths || {}).length} GL lines budgeted 1:1 (${s.mirrored || 0} mirrored${(s.remapped || []).length ? `, ${s.remapped.length} remapped` : ''}) · signed total ${money2(tot)} · ${s.subtotals || 0} report subtotal rows skipped · source ${esc(a.source || '')}</div>
      ${exList('Remapped', s.remapped, 'drv-rr')}
      ${exList('Not carried', s.excluded, 'drv-int')}
      ${exList('⚠ Unmapped — review', s.unmapped, 'drv-man')}
    </div>`;
  };
  dlg.innerHTML = `
    <h2>Actualize a closed month — ${esc(code)}</h2>
    <p class="muted" style="margin:0 0 8px; font-size:12px">Upload the Yardi <b>Property Comparison</b> for the closed month (Book = <b>Cash</b>, one period). Every upload-chart GL in that month is set 1:1 to what posted for ${esc(code)}; GLs with nothing posted go to zero. The month stays locked through every recalc and export — cells stay editable, an edit corrects the posted figure. Tenant rent posted to 5006 is budgeted on 4994; loan proceeds, depreciation/amortization and balance-sheet movements are never mirrored (listed, not dropped).</p>
    ${acts.length ? `<h3>Locked months</h3>${acts.map((a) => `<div class="row" style="justify-content:space-between; align-items:center; font-size:12.3px; padding:3px 0">
        <span>✓ <b>${esc(a.period)}</b> · ${esc(a.book)} · ${a.index >= 0 ? esc(labels[a.index]) : 'pre-start (CSV only)'} · ${Object.keys(a.glMonths || {}).length} lines · applied ${esc(String(a.appliedAt || '').slice(0, 10))}${a.appliedBy ? ' by ' + esc(a.appliedBy) : ''}</span>
        <span><button class="rb" data-actshow="${esc(a.key)}">details</button> <button class="rb" data-actrel="${esc(a.key)}" title="Unlock this month — the plan formulas take it back over">release</button></span></div>`).join('')}` : ''}
    <p class="muted" style="font-size:12px; margin:0 0 6px">Budget already uploaded to Yardi and edited there? <button class="rb" id="act-tocsv">✓ Actualize from Yardi CSVs…</button> instead — it revises the exported CSV in place, so nothing changed in Yardi is undone.</p>
    <h3>Upload (this budget's plan as the base)</h3>
    <div class="row"><input type="file" id="act-file" accept=".xlsx"><button class="btn" id="act-go">Apply</button></div>
    <div id="act-result">${result ? summaryHtml(result) : ''}</div>
    <div class="err" id="act-err"></div>
    <div class="foot">
      <span class="muted" style="align-self:center; margin-right:auto; font-size:11.5px">The current iteration is captured as a save point first; one Undo reverses it.</span>
      <button class="btn sub" id="act-x">Close</button>
    </div>`;
  dlg.querySelector('#act-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#act-tocsv').addEventListener('click', () => { dlg.close(); openActualizeCsv(); });
  dlg.querySelectorAll('[data-actshow]').forEach((x) => x.addEventListener('click', () => {
    const a = acts.find((y) => y.key === x.dataset.actshow);
    if (a) dlg.querySelector('#act-result').innerHTML = summaryHtml(a);
  }));
  dlg.querySelectorAll('[data-actrel]').forEach((x) => x.addEventListener('click', async () => {
    const a = acts.find((y) => y.key === x.dataset.actrel);
    if (!a || !confirm(`Release ${a.period}? The plan formulas take that month back over.`)) return;
    try {
      pushUndo();
      S.bv = await DEL(`/budgets/${b.id}/actualize/${encodeURIComponent(a.key)}`);
      render();
      openActualize(S.bv.budget);
    } catch (e) { S.undo.stack.pop(); dlg.querySelector('#act-err').textContent = e.message; }
  }));
  dlg.querySelector('#act-go').addEventListener('click', async () => {
    const f = dlg.querySelector('#act-file').files[0];
    const err = dlg.querySelector('#act-err');
    if (!f) { err.textContent = 'Choose the Property Comparison .xlsx first'; return; }
    const go = dlg.querySelector('#act-go'); go.disabled = true; err.textContent = '';
    const fd = new FormData(); fd.append('file', f);
    try {
      pushUndo();
      S.bv = await POST(`/budgets/${b.id}/actualize`, fd);
      const r = S.bv.actualizeResult;
      render();
      openActualize(S.bv.budget, r);
    } catch (e) { S.undo.stack.pop(); err.textContent = 'Actualize failed: ' + e.message; go.disabled = false; }
  });
  if (!dlg.open) dlg.showModal();
}


/* ---------------- actualize from Yardi budget CSVs (bulk, dashboard) ----------------
   Runs the partial-month rule off the budget AS IT SITS IN YARDI: each CSV
   (exported from Yardi, or the file last uploaded) comes back with the closed
   month set 1:1 to what posted and every other cell untouched. The property
   is read from each CSV's header; the matching budget records the month and,
   with "adopt", takes the CSV's other months as its plan. */
function openActualizeCsv(resp) {
  const dlg = document.getElementById('actcsv-dlg');
  if (!dlg) return;
  const exList = (title, arr, cls) => arr && arr.length ? `<div style="margin-top:4px"><b style="font-size:11px; color:var(--dim)">${title}</b> ${arr.map((e) =>
    `<span style="font-size:11px; margin-right:8px"><span class="drv ${cls}">${esc(e.gl)}</span> ${esc(e.name)} <b>${money2(e.amount)}</b>${e.to ? ` → ${esc(e.to)}` : ''}</span>`).join('')}</div>` : '';
  const resultsHtml = (rr) => `<h3>Result — ${esc(rr.period || '')}</h3>${(rr.results || []).map((r) => {
    const s = r.summary || {};
    return `<div style="border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-top:6px; font-size:12.3px">
      <b>${esc((r.code || '?').toUpperCase())}</b> <span class="muted">${esc(r.file)}</span><br>
      ${r.error ? `<span class="neg">✗ ${esc(r.error)}</span>` : `✓ ${r.glCount} GL lines set 1:1 (${s.mirrored || 0} mirrored${(s.remapped || []).length ? `, ${s.remapped.length} remapped` : ''}) · ${r.rewritten} rows kept verbatim${(r.appended || []).length ? ` · ${r.appended.length} row(s) appended (${r.appended.join(', ')})` : ''} → <b>${esc(r.filename)}</b>
        ${r.adopted ? `<div class="muted">adopted into budget #${r.budgetId}: ${r.adopted.changed} plan line(s) differed from the tool and now follow Yardi (YARDI chip)</div>` : r.budgetId ? `<div class="muted">recorded on budget #${r.budgetId} (plan not adopted)</div>` : ''}
        ${exList('Remapped', s.remapped, 'drv-rr')}${exList('Not carried', s.excluded, 'drv-int')}${exList('⚠ Unmapped — review', s.unmapped, 'drv-man')}`}
      ${(r.warnings || []).map((w) => `<div class="neg" style="font-size:11.5px">⚠ ${esc(w)}</div>`).join('')}
    </div>`; }).join('')}`;
  dlg.innerHTML = `
    <h2>Actualize a closed month from Yardi budget CSVs</h2>
    <p class="muted" style="margin:0 0 8px; font-size:12px">Runs the partial-month rule off the budget <b>as it sits in Yardi</b>. Export each property's budget from Yardi (or use the CSV you last uploaded), add the month-end <b>Property Comparison</b> (Book = Cash, one period), and every CSV comes back with that month set 1:1 to what posted — every other cell untouched, so anything changed in Yardi is kept. The property is read from each budget's header record — a Yardi export holding several budgets in one file (the six-site ND export) is handled per budget and re-emitted as one complete file. The matching budget in the tool records the month (a save point is captured first). Tenant rent on 5006 → 4994; loan proceeds, depreciation/amortization and balance-sheet rows are never mirrored (listed, not dropped).</p>
    <div class="row">
      <div class="fld"><label>Property Comparison (.xlsx)</label><input type="file" id="ac-cmp" accept=".xlsx"></div>
      <div class="fld"><label>Budget CSVs (one or more)</label><input type="file" id="ac-csv" accept=".csv" multiple></div>
    </div>
    <label style="display:block; margin-top:8px; font-size:12.3px"><input type="checkbox" id="ac-adopt" checked> Adopt each CSV into its budget — months that differ from the tool's plan become <b>YARDI</b> overrides, so a later export from the tool can't undo changes made in Yardi</label>
    <div id="ac-res">${resp ? resultsHtml(resp) : ''}</div>
    <div class="err" id="ac-err"></div>
    <div class="foot">
      <span class="muted" style="align-self:center; margin-right:auto; font-size:11.5px">Revised CSVs download automatically. Roll back a budget via ⎘ Save points.</span>
      <button class="btn sub" id="ac-x">Close</button>
      <button class="btn" id="ac-go">Run</button>
    </div>`;
  dlg.querySelector('#ac-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#ac-go').addEventListener('click', async () => {
    const cmp = dlg.querySelector('#ac-cmp').files[0];
    const csvs = [...dlg.querySelector('#ac-csv').files];
    const err = dlg.querySelector('#ac-err');
    if (!cmp) { err.textContent = 'Choose the Property Comparison .xlsx'; return; }
    if (!csvs.length) { err.textContent = 'Choose at least one budget CSV'; return; }
    const go = dlg.querySelector('#ac-go'); go.disabled = true; err.textContent = '';
    const fd = new FormData();
    fd.append('comparison', cmp);
    for (const f of csvs) fd.append('csv', f);
    fd.append('adopt', dlg.querySelector('#ac-adopt').checked ? '1' : '0');
    try {
      const out = await POST('/actualize-csv', fd);
      for (const r of out.files || []) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
        a.download = r.filename;
        document.body.appendChild(a); a.click(); a.remove();
        await new Promise((res) => setTimeout(res, 600));
      }
      S.state = await GET('/state');
      if (S.bv && (out.results || []).some((r) => r.budgetId === S.bv.budget.id)) S.bv = await GET(`/budgets/${S.bv.budget.id}`);
      render();
      openActualizeCsv(out);
    } catch (e) { err.textContent = 'Failed: ' + e.message; go.disabled = false; }
  });
  if (!dlg.open) dlg.showModal();
}


/* ============================================================================
   ANNUAL (non-acquisition) budgets — client pieces. The engine is
   shared/annual.ts (Yardi budget template rules on the property's own
   trailing-12); these are the assumptions dialog, the shape picker, and the
   template / statement upload preview.
   ========================================================================== */

const ANNUAL_CATS = [['4', 'Utility income (reims)'], ['5', 'Other income'], ['8', 'RE & PP taxes'], ['9', 'Admin & accounting'], ['10', 'Payroll (no model)'], ['11', 'Marketing'], ['12', 'Utilities (no forecast)'], ['13', 'Repairs & maintenance'], ['14', 'Rehab / replacement'], ['*', 'everything else']];
const SHAPE_LABELS = { actual: 'Same month × factor (template default)', wavg: '1-2-1 weighted distribution × factor', flat: 'T12 total ÷ 12, flat', curve: 'T12 total on the GL seasonal curve', last: 'Last actual month, flat', avgnz: 'Average of active months, flat' };

function annualInputsHtml(inp) {
  const g = inp.gpr || {};
  const l = inp.ltl || {};
  const bl = inp.baseline || {};
  const gp = bl.growthPct || {};
  const tpl = (S.bv && S.bv.template) || null;
  const exp = inp.expirations || (tpl && tpl.leaseExpirations) || [];
  const pct1 = (v) => (v == null ? '' : +(v * 100).toFixed(2));
  const corp = { 6108: { perUnitYr: 285 }, 6310: { perUnitYr: 43.14, flatMo: 483 }, 6320: { perUnitYr: 7.86 }, 6560: { perUnitYr: 24.76 }, ...(inp.corpRates || {}) };
  const refT12 = (S.bv.refs || []).find((r) => r.key === 'actual');
  return `
    <h3>Gross potential rent · ${g.baseMonthly > 0 ? 'rent roll market rents' : 'last actual month'} × monthly % changes</h3>
    <div class="row">
      <div class="fld"><label>GPR base $/mo (0 = last actual month's GPR)</label><input id="in-gprbase" value="${g.baseMonthly ?? 0}" style="width:120px"></div>
      <div class="fld"><label>% change by month (12 values, Jan..Dec — the template's "ENTER % CHANGE FOR GPR")</label><input id="in-gprgrow" value="${show12(g.growthPct || [])}" style="width:300px"></div>
    </div>
    <h3>Loss to lease ${S.bv.leaseCount ? `<span class="badge">${S.bv.leaseCount} leases on file — per-lease burnoff</span>` : '<span class="badge">template method: last actual month, burned off by lease expirations</span>'}</h3>
    <div class="row">
      <div class="fld"><label>Renewal %</label><input id="in-ltlrenew" value="${((l.renewalPct ?? (tpl && tpl.renewalPct) ?? 0.65) * 100).toFixed(1)}" style="width:70px"></div>
      <div class="fld"><label>Burnoff on renewal %</label><input id="in-ltlbr" value="${((l.burnoffRenew ?? 0.75) * 100).toFixed(0)}" style="width:70px"></div>
      <div class="fld"><label>Burnoff on move-in %</label><input id="in-ltlbn" value="${((l.burnoffNew ?? 1) * 100).toFixed(0)}" style="width:70px"></div>
      <label style="align-self:center" title="Market-rent growth deepens the loss to lease 1:1 (the template's 'change in market rent' row)"><input type="checkbox" id="in-ltlfollow" ${l.followGpr !== false ? 'checked' : ''}> LTL follows GPR growth</label>
      <div class="fld"><label>Method</label><select id="in-ltlmode"><option value="leases" ${l.mode !== 'ramp' && l.mode !== 'flat' ? 'selected' : ''}>Burnoff (per-lease / expirations)</option><option value="flat" ${l.mode === 'flat' ? 'selected' : ''}>Flat — hold it, no burnoff</option><option value="ramp" ${l.mode === 'ramp' ? 'selected' : ''}>Linear ramp</option></select></div>
    </div>
    <div class="row" style="margin-top:6px">
      <div class="fld"><label>Lease expirations by month (12 values — drives LTL burnoff, application / admin / deposit fees)${tpl ? ' · from the template' : ''}</label><input id="in-exp" value="${(exp || []).join(', ')}" style="width:330px" placeholder="from the rent roll"></div>
      <div class="fld"><label>Start $/mo (neg; 0 = rent roll gap / last actual) — flat &amp; ramp</label><input id="in-ltlstart" value="${l.startMonthly ?? 0}" style="width:100px"></div>
      <div class="fld"><label>Ramp: target % of GPR</label><input id="in-ltlpct" value="${((l.targetPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
    </div>
    <h3>Rental loss</h3>
    <div class="row">
      <div class="fld"><label>Vacancy % of GPR (1 or 12 values; default = last actual month's %)</label><input id="in-vac" value="${show12(inp.vacancyPct || [])}" style="width:220px"></div>
      <span class="muted" style="align-self:center; font-size:11.5px">Delinquency, prior-period collections and concessions run at their trailing-12 / last-month ratios — change one on its row (%GPR chip) or via “% of GPR…” in the row menu.</span>
    </div>
    <h3>Baseline — every other GL = own history × increase factor</h3>
    <div class="row">
      <div class="fld"><label>History</label><select id="in-blsrc"><option value="actual" ${bl.source !== 'budget' ? 'selected' : ''}>Trailing-12 actuals${refT12 ? ` (${esc(refT12.period)})` : ''}</option><option value="budget" ${bl.source === 'budget' ? 'selected' : ''}>Current-year budget</option></select></div>
      <div class="fld"><label>Shape</label><select id="in-blshape">${['actual', 'wavg', 'flat', 'curve'].map((k) => `<option value="${k}" ${(bl.shape || 'actual') === k ? 'selected' : ''}>${SHAPE_LABELS[k]}</option>`).join('')}</select></div>
      <div class="fld"><label>MROUND $ (0 = each GL's foundation multiple)</label><input id="in-blmround" value="${bl.mround || 0}" style="width:80px"></div>
      <label style="align-self:center" title="The Yardi template carries Conservice's per-GL per-month utility % forecasts. The GRKS foundation used a flat 5% instead; tick to apply the forecast where one exists."><input type="checkbox" id="in-blutil" ${bl.useUtilForecast ? 'checked' : ''}> Use Conservice utility forecasts</label>
    </div>
    <p class="muted" style="font-size:11px; margin:4px 0 0">Per-GL defaults follow the <b>GRKS 2026 draft's formulas</b> (the foundation): same-month × factor with MROUND $10/$50, the 1-2-1 weighted average for utilities and volatile fees (MROUND $25–$250), trailing-12 ÷ 12 flat for small/erratic lines (only when the T12 exceeds $1,000), October actual flat for taxes, phones and HAP. Shape and factor set here apply where the GL has no rule; a line's own chip input or “Own T12 → shape × factor…” wins over both.</p>
    <div class="row" style="margin-top:6px">
      ${ANNUAL_CATS.map(([p, label]) => `<div class="fld"><label>${label} %</label><input class="in-blpct" data-p="${p}" value="${pct1(gp[p] ?? 0)}" style="width:70px"></div>`).join('')}
    </div>
    <p class="muted" style="font-size:11px; margin:4px 0 0">Category % above is the fallback for GLs without a foundation rule. GRKS factors by section: other income 0%, reims 5%, admin 5%, maintenance / CAM / contract services 10%, rehab 15%, utilities 5% (trash 7%, internet 3%).</p>
    <h3>Turnover-driven income · $ per new move-in (blank = last year's $ ÷ this year's move-ins)</h3>
    <div class="row">
      ${[['5105', 'Application fees'], ['5152', 'Deposit forfeitures'], ['5157', 'Move-in admin fee']].map(([gl, label]) => `<div class="fld"><label>${gl} ${label}</label><input class="in-turn" data-gl="${gl}" value="${(inp.turnFees || {})[gl] ?? ''}" style="width:90px" placeholder="auto"></div>`).join('')}
    </div>
    <h3>Corporate rates</h3>
    <div class="row">
      <div class="fld"><label>6108 Insurance $/unit/yr</label><input class="in-corp" data-gl="6108" data-k="perUnitYr" value="${corp[6108].perUnitYr ?? ''}" style="width:80px"></div>
      <div class="fld"><label>6310 IT &amp; allocations $/unit/yr</label><input class="in-corp" data-gl="6310" data-k="perUnitYr" value="${corp[6310].perUnitYr ?? ''}" style="width:80px"></div>
      <div class="fld"><label>6310 flat $/mo</label><input class="in-corp" data-gl="6310" data-k="flatMo" value="${corp[6310].flatMo ?? ''}" style="width:80px"></div>
      <div class="fld"><label>6320 Legal $/unit/yr</label><input class="in-corp" data-gl="6320" data-k="perUnitYr" value="${corp[6320].perUnitYr ?? ''}" style="width:80px"></div>
      <div class="fld"><label>6560 Marketing alloc $/unit/yr</label><input class="in-corp" data-gl="6560" data-k="perUnitYr" value="${corp[6560].perUnitYr ?? ''}" style="width:80px"></div>
    </div>
    <h3>Fees, financing &amp; payroll</h3>
    <div class="row">
      <div class="fld"><label>Mgmt fee % of income${tpl && tpl.mgmtFee && tpl.mgmtFee.actualPct ? ` (Q4 actual ${(tpl.mgmtFee.actualPct * 100).toFixed(2)}%${Object.keys(tpl.mgmtFee.matrix || {}).length ? ` · tiers ${Object.entries(tpl.mgmtFee.matrix).map(([k, v]) => `${k} CoC→${(v * 100).toFixed(0)}%`).join(', ')}` : ''})` : ''}</label><input id="in-mgmt" value="${((inp.mgmtPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
      <div class="fld"><label>Units</label><input id="in-units" value="${inp.units ?? 0}" style="width:70px"></div>
      <div class="fld"><label>Capital $ (CoC)</label><input id="in-cap" value="${inp.capital ?? 0}" style="width:110px"></div>
      ${tpl && tpl.debt && tpl.debt.interest.some((v) => v) ? `<span class="muted" style="align-self:center; font-size:11.5px">Interest &amp; principal come from the Yardi amortization schedule (${esc((tpl.debt.loans || []).join(', '))}: interest ${money(tpl.debt.interest.reduce((a, b) => a + b, 0))}/yr).</span>` : `<div class="fld"><label>Loan $ (no schedule on file)</label><input id="in-loan" value="${inp.loan ?? 0}" style="width:110px"></div><div class="fld"><label>Rate %</label><input id="in-rate" value="${((inp.rate || 0) * 100).toFixed(2)}" style="width:70px"></div>`}
      <div class="fld"><label>Payroll raise % — wages flat × (1 + raise); model wages step up in March; taxes / benefits / bonus follow at the prior-year % of wages</label><input id="in-raise" value="${((inp.payrollRaisePct ?? 0.035) * 100).toFixed(1)}" style="width:70px"></div>
    </div>
    <h3>Ties to the reference (${esc(S.bv.refLabel || 'T12')}) — off by default</h3>
    <div class="row">
      <label title="Adjust loss-to-lease so Total Income equals the reference EGI at every regeneration"><input type="checkbox" id="in-tieinc" ${inp.tieIncome === true ? 'checked' : ''}> Tie income (via LTL)</label>
      <label title="Scale the flex categories (admin, marketing, R&M, rehab) so NOI equals the reference NOI at every regeneration"><input type="checkbox" id="in-tienoi" ${inp.tieNoi === true ? 'checked' : ''}> Tie NOI (via flex cats)</label>
    </div>`;
}

async function applyAnnualInputs(b, el) {
  const q = (id) => el.querySelector(id);
  const num = (id, dflt = 0) => { const e = q(id); if (!e) return dflt; const v = parseFloat(String(e.value).replace(/[$,]/g, '')); return Number.isFinite(v) ? v : dflt; };
  const cur = S.bv.budget.inputs || {};
  const growthPct = {};
  el.querySelectorAll('.in-blpct').forEach((x) => { const v = parseFloat(String(x.value).replace(/,/g, '')); if (Number.isFinite(v)) growthPct[x.dataset.p] = v / 100; });
  const turnFees = { ...(cur.turnFees || {}) };
  el.querySelectorAll('.in-turn').forEach((x) => { const v = parseFloat(String(x.value).replace(/[$,]/g, '')); if (Number.isFinite(v)) turnFees[x.dataset.gl] = v; else delete turnFees[x.dataset.gl]; });
  const corpRates = { ...(cur.corpRates || {}) };
  el.querySelectorAll('.in-corp').forEach((x) => { const v = parseFloat(String(x.value).replace(/[$,]/g, '')); corpRates[x.dataset.gl] = { ...(corpRates[x.dataset.gl] || {}), [x.dataset.k]: Number.isFinite(v) ? v : 0 }; });
  const expText = String(q('#in-exp').value || '').trim();
  const expVals = expText ? expText.split(',').map((s) => parseFloat(s.trim())).filter((v) => Number.isFinite(v)) : [];
  const inputs = {
    ...cur,
    mode: 'annual',
    year: b.year,
    units: num('#in-units'),
    capital: num('#in-cap'),
    loan: q('#in-loan') ? num('#in-loan') : (cur.loan || 0),
    rate: q('#in-rate') ? num('#in-rate') / 100 : (cur.rate || 0),
    startMonth: 1,
    gpr: { baseMonthly: num('#in-gprbase'), growthPct: parse12(q('#in-gprgrow').value, Array(12).fill(0)) },
    ltl: {
      ...(cur.ltl || {}),
      mode: q('#in-ltlmode').value,
      renewalPct: num('#in-ltlrenew') / 100, burnoffRenew: num('#in-ltlbr') / 100, burnoffNew: num('#in-ltlbn') / 100,
      followGpr: q('#in-ltlfollow').checked,
      startMonthly: num('#in-ltlstart'), targetPct: num('#in-ltlpct') / 100, rampMonths: 12,
    },
    expirations: expVals.length === 12 ? expVals : null,
    vacancyPct: parse12(q('#in-vac').value, cur.vacancyPct || Array(12).fill(0.05)),
    mgmtPct: num('#in-mgmt') / 100,
    payrollRaisePct: num('#in-raise') / 100,
    baseline: { ...(cur.baseline || {}), source: q('#in-blsrc').value, shape: q('#in-blshape').value, mround: num('#in-blmround'), growthPct, useUtilForecast: q('#in-blutil').checked },
    turnFees, corpRates,
    tieIncome: q('#in-tieinc').checked,
    tieNoi: q('#in-tienoi').checked,
  };
  pushUndo();
  S.bv = await PUT(`/budgets/${b.id}`, { inputs });
  render();
}

/* Per-line shape picker: how THIS GL's own history becomes its budget. Saves
   inputs.baseline.glShape / glGrowth so the line stays live on regeneration. */
function openShapeMenu(b, gl, acc, anchorBtn, inp) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const bl = inp.baseline || {};
  const curShape = (bl.glShape || {})[gl] || null;
  const line = S.bv.lines.find((l) => l.gl_code === gl);
  const curPct = (bl.glGrowth || {})[gl] ?? (line && line.driver && line.driver.method === 'baseline' ? line.driver.pct : null);
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.innerHTML = `
    <div class="rm-head">${gl} ${esc(acc.name || '')} — own history → budget</div>
    ${Object.entries(SHAPE_LABELS).map(([k, label]) => `<button data-sh="${k}">${curShape === k ? '✓ ' : ''}${label}</button>`).join('')}
    <button data-sh="" style="color:var(--dim)">Template default for this GL</button>`;
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.left + window.scrollX - 40)}px`;
  menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  menu.querySelectorAll('button[data-sh]').forEach((btn) => btn.addEventListener('click', async () => {
    const shape = btn.dataset.sh;
    menu.remove();
    const g = parseFloat(String(prompt(`Increase factor % on ${gl} ${acc.name || ''} (blank = keep ${curPct != null ? (curPct * 100).toFixed(1) + '%' : 'the category default'}):`, curPct != null ? (curPct * 100).toFixed(1) : '') || '').replace(/,/g, ''));
    const glShape = { ...(bl.glShape || {}) };
    if (shape) glShape[gl] = shape; else delete glShape[gl];
    const glGrowth = { ...(bl.glGrowth || {}) };
    if (Number.isFinite(g)) glGrowth[gl] = g / 100;
    pushUndo();
    if (line && line.override) S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { override: false });
    S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...bl, glShape, glGrowth } } });
    render();
  }));
}

/* Upload preview for the Yardi budget template / Monarch statements: one row
   per file, property guessed from the file, relink option. */
function renderAnnualUploadPreview(el, parsed) {
  const files = parsed.files || [];
  const isTpl = parsed.kind === 'yardi_template';
  el.innerHTML = `<h3>${isTpl ? 'Yardi budget templates' : 'Monarch statements'} — one per property</h3>
    <div class="mapping"><table class="list"><tr><th>File</th><th>${isTpl ? 'Template' : 'Statement'}</th><th>Period</th><th>Rows</th><th>GPR (T12)</th><th>${isTpl ? 'Units · capital · last actual' : 'Kind'}</th><th>Property</th></tr>
    ${files.map((f, i) => {
      if (f.error) return `<tr><td>${esc(f.filename)}</td><td colspan="6" class="neg">✗ ${esc(f.error)}</td></tr>`;
      const st = isTpl ? f.actual : f.statement;
      const t = f.template;
      const known = S.state.properties.some((p) => p.code === f.propertyGuess);
      return `<tr>
        <td>${esc(f.filename)}</td>
        <td>${esc(isTpl ? `${t.name} (${t.code}) · budget ${t.budgetYear}` : st.label)}${isTpl && (f.skippedSheets || []).length ? ` <span class="badge" title="Never read — restricted individual compensation">payroll sheet skipped</span>` : ''}</td>
        <td>${esc(st.period || '')}${isTpl ? `<div class="muted" style="font-size:10.5px">budget ${esc(f.budget.period || '')}</div>` : ''}</td>
        <td>${st.rows.length}</td><td>${money(st.gpr)}</td>
        <td>${isTpl ? `${t.units}u · ${money(t.capital)} · ${esc(String(t.lastActual.year))}-${String(t.lastActual.month).padStart(2, '0')}` : (st.kind === 'budget' ? 'CY budget' : 'actuals')}</td>
        <td><select data-map="${i}">${propOptions(known ? f.propertyGuess : guessProp(st.label))}${f.propertyGuess && !known ? `<option value="${esc(f.propertyGuess)}" selected>${esc(f.propertyGuess)} — NEW property (${esc(isTpl ? t.name : st.label)})</option>` : ''}</select></td>
      </tr>`; }).join('')}</table></div>
    <div class="row" style="margin-top:10px">
      <label style="align-self:center" title="Point every existing ANNUAL budget of a mapped property at the new data and regenerate — overrides and MROUNDs are kept"><input type="checkbox" id="up-relink" checked> Relink existing annual budgets &amp; regenerate</label>
      <button class="btn" id="up-apply">Save</button>
    </div>
    ${isTpl ? '<p class="muted" style="font-size:11.5px">Each template saves three things: the trailing-12 actuals statement, the current-year budget statement, and the template facts (debt schedule, fee matrix, Conservice utility forecasts, corporate suggestions, lease expirations, property info).</p>' : ''}`;
  el.querySelector('#up-apply').addEventListener('click', async () => {
    const mappings = [...el.querySelectorAll('[data-map]')].map((sel) => ({ index: Number(sel.dataset.map), propertyCode: sel.value || null })).filter((m) => m.propertyCode);
    if (!mappings.length) { S.upload.err = 'Map at least one file to a property'; render(); return; }
    const relink = el.querySelector('#up-relink').checked;
    try {
      const resp = await POST('/uploads/apply', { kind: parsed.kind, filename: files.map((f) => f.filename).join(', ').slice(0, 200), payload: parsed, mappings, relink });
      S.upload.msg = `Saved ${resp.created.length} ${isTpl ? 'template(s)' : 'statement(s)'}${relink ? ` · relinked ${resp.relinked || 0} budget(s)` : ''}`;
      S.upload.parsed = null;
    } catch (e) { S.upload.err = e.message; }
    await refreshState(); render();
  });
}
