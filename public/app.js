/* Budget Tool SPA — no framework, mirrors the SP Tracker pattern.
   State flows: /api/state (lists) + /api/budgets/:id (editor payload). */
'use strict';

const S = {
  auth: null,          // {authed, username, isAdmin, appTitle}
  state: null,         // {coa, portfolios, properties, budgets, uwSnapshots, compSets, rentSnapshots}
  view: 'dash',        // dash | uploads | editor | settings
  bv: null,            // budget view payload {budget, lines, tieout, kpis, uw, compWeights}
  showZero: false,
  upload: { kind: 'uw_book', parsed: null, busy: false, msg: '', err: '' },
  err: '',
};

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
  S.auth = await GET('/auth/status').catch(() => ({ authed: false }));
  if (S.auth.authed) S.state = await GET('/state');
  render();
}
async function refreshState() { S.state = await GET('/state'); }

/* ---------------- render root ---------------- */
function render() {
  const app = document.getElementById('app');
  if (!S.auth || !S.auth.authed) { app.innerHTML = loginView(); wireLogin(); return; }
  app.innerHTML = `
    <div class="topbar">
      <span class="brand">${esc(S.auth.appTitle || 'Budget Tool')}</span>
      <nav>
        <button data-v="dash" class="${S.view === 'dash' ? 'on' : ''}">Budgets</button>
        <button data-v="uploads" class="${S.view === 'uploads' ? 'on' : ''}">Uploads</button>
        ${S.view === 'editor' ? '<button data-v="editor" class="on">Editor</button>' : ''}
        <button data-v="settings" class="${S.view === 'settings' ? 'on' : ''}">Settings</button>
      </nav>
      <span class="spacer"></span>
      <span class="who">${esc(S.auth.username)}${S.auth.isAdmin ? ' · admin' : ''}<button id="logout">Sign out</button></span>
    </div>
    <div class="wrap" id="main"></div>`;
  document.querySelectorAll('.topbar nav button').forEach((b) =>
    b.addEventListener('click', () => { S.view = b.dataset.v; render(); }));
  document.getElementById('logout').addEventListener('click', async () => { await POST('/logout'); location.reload(); });
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

/* ---------------- dashboard ---------------- */
function renderDash(el) {
  const st = S.state;
  const props = new Map(st.properties.map((p) => [p.code, p]));
  el.innerHTML = `
    <div class="card">
      <h2>Budgets <button class="btn" id="newb" style="float:right">+ New budget</button></h2>
      ${st.budgets.length ? `<table class="list"><tr><th>Property</th><th>Year</th><th>Label</th><th>Type</th><th>Status</th><th>Updated</th><th></th></tr>
        ${st.budgets.map((b) => `<tr class="click" data-id="${b.id}">
          <td><b>${esc(b.property_code)}</b> · ${esc(b.property_name)}</td>
          <td>${b.year}</td><td>${esc(b.label)}</td><td>${esc(b.budget_type)}</td><td>${esc(b.status)}</td>
          <td class="muted">${new Date(b.updated_at).toLocaleDateString()}</td>
          <td>${S.auth.isAdmin ? `<button class="btn danger" data-del="${b.id}">Delete</button>` : ''}</td>
        </tr>`).join('')}</table>` : '<p class="muted">No budgets yet. Upload a UW book, rent roll and comp set, then create one.</p>'}
    </div>
    <div class="card">
      <h2>Data on file</h2>
      <h3>UW snapshots</h3>
      ${st.uwSnapshots.length ? `<table class="list"><tr><th>Property</th><th>Label</th><th>Units</th><th>UW NOI</th><th>Added</th></tr>
        ${st.uwSnapshots.map((u) => `<tr><td>${esc(u.property_code)}</td><td>${esc(u.label)}</td><td>${u.units ?? ''}</td><td>${money(u.noi)}</td><td class="muted">${new Date(u.created_at).toLocaleDateString()}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}
      <h3>Rent snapshots</h3>
      ${st.rentSnapshots.length ? `<table class="list"><tr><th>Property</th><th>As of</th><th>Units</th><th>Market / mo</th><th>In-place / mo</th></tr>
        ${st.rentSnapshots.map((r) => `<tr><td>${esc(r.property_code)}</td><td>${r.as_of ? new Date(r.as_of).toLocaleDateString() : ''}</td><td>${r.units ?? ''}</td><td>${money(r.market_monthly)}</td><td>${money(r.inplace_monthly)}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}
      <h3>Seller T12s</h3>
      ${(st.t12Snapshots || []).length ? `<table class="list"><tr><th>Property</th><th>Statement</th><th>Period</th><th>Book</th></tr>
        ${st.t12Snapshots.map((t) => `<tr><td>${esc(t.property_code)}</td><td>${esc(t.label)}</td><td>${esc(t.period)}</td><td>${esc(t.book)}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}
      <h3>Payroll models</h3>
      ${(st.payrollModels || []).length ? `<table class="list"><tr><th>Model</th><th>Added</th></tr>
        ${st.payrollModels.map((p) => `<tr><td>${esc(p.label)}</td><td class="muted">${new Date(p.created_at).toLocaleDateString()}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}
      <h3>Comp sets</h3>
      ${st.compSets.length ? `<table class="list"><tr><th>Name</th><th>Period</th><th>Book</th><th>Added</th></tr>
        ${st.compSets.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.period)}</td><td>${esc(c.book)}</td><td class="muted">${new Date(c.created_at).toLocaleDateString()}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}
    </div>
    <dialog id="newdlg"></dialog>`;

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
  document.getElementById('newb').addEventListener('click', () => newBudgetDialog(props));
}

function newBudgetDialog() {
  const st = S.state;
  const dlg = document.getElementById('newdlg');
  const subjects = st.properties.filter((p) => p.role === 'subject');
  const yearNow = new Date().getFullYear() + 1;
  dlg.innerHTML = `
    <h2>New budget</h2>
    <div class="row">
      <div class="fld"><label>Property</label><select id="nb-prop">${subjects.map((p) => `<option value="${p.code}">${p.code} — ${esc(p.name)}</option>`).join('')}</select></div>
      <div class="fld"><label>Budget year</label><input id="nb-year" type="number" value="${yearNow}" style="width:90px"></div>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="fld"><label>UW snapshot (tie-out target)</label><select id="nb-uw"></select></div>
      <div class="fld"><label>Rent snapshot (GPR anchor)</label><select id="nb-rent"></select></div>
      <div class="fld"><label>Comp set (line distribution)</label><select id="nb-comp"><option value="">— none —</option>${st.compSets.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="fld"><label>Seller T12 (monthly shapes)</label><select id="nb-t12"></select></div>
      <div class="fld"><label>Payroll model (wages)</label><select id="nb-pay"><option value="">— none —</option>${(st.payrollModels || []).map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></div>
    </div>
    <div class="err" id="nb-err"></div>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="nb-go">Create & generate</button>
      <button class="btn sub" id="nb-x">Cancel</button>
    </div>`;
  const fillSnaps = () => {
    const code = dlg.querySelector('#nb-prop').value;
    const uws = st.uwSnapshots.filter((u) => u.property_code === code);
    const rents = st.rentSnapshots.filter((r) => r.property_code === code);
    const t12s = (st.t12Snapshots || []).filter((t) => t.property_code === code);
    dlg.querySelector('#nb-uw').innerHTML = `<option value="">— none —</option>` + uws.map((u) => `<option value="${u.id}">${esc(u.label)} (NOI ${money(u.noi)})</option>`).join('');
    dlg.querySelector('#nb-rent').innerHTML = `<option value="">— none —</option>` + rents.map((r) => `<option value="${r.id}">${r.as_of ? new Date(r.as_of).toLocaleDateString() : ''} · mkt ${money(r.market_monthly)}/mo</option>`).join('');
    dlg.querySelector('#nb-t12').innerHTML = `<option value="">— none —</option>` + t12s.map((t) => `<option value="${t.id}">${esc(t.label)} (${esc(t.period)})</option>`).join('');
    if (uws.length) dlg.querySelector('#nb-uw').value = uws[0].id;
    if (rents.length) dlg.querySelector('#nb-rent').value = rents[0].id;
    if (t12s.length) dlg.querySelector('#nb-t12').value = t12s[0].id;
    if ((st.payrollModels || []).length) dlg.querySelector('#nb-pay').value = st.payrollModels[0].id;
  };
  fillSnaps();
  dlg.querySelector('#nb-prop').addEventListener('change', fillSnaps);
  dlg.querySelector('#nb-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#nb-go').addEventListener('click', async () => {
    try {
      const bv = await POST('/budgets', {
        propertyCode: dlg.querySelector('#nb-prop').value,
        year: Number(dlg.querySelector('#nb-year').value),
        uwSnapshotId: Number(dlg.querySelector('#nb-uw').value) || null,
        compSetId: Number(dlg.querySelector('#nb-comp').value) || null,
        rentSnapshotId: Number(dlg.querySelector('#nb-rent').value) || null,
        t12SnapshotId: Number(dlg.querySelector('#nb-t12').value) || null,
        payrollModelId: Number(dlg.querySelector('#nb-pay').value) || null,
      });
      dlg.close();
      await refreshState();
      S.bv = bv; S.view = 'editor'; render();
    } catch (e) { dlg.querySelector('#nb-err').textContent = e.message; }
  });
  dlg.showModal();
}

async function openBudget(id) {
  S.bv = await GET(`/budgets/${id}`);
  S.view = 'editor';
  render();
}

/* ---------------- uploads ---------------- */
function renderUploads(el) {
  const u = S.upload;
  el.innerHTML = `
    <div class="card">
      <h2>Upload data</h2>
      <div class="row">
        <div class="fld"><label>What is this file?</label>
          <select id="up-kind">
            <option value="uw_book" ${u.kind === 'uw_book' ? 'selected' : ''}>UW book model (.xlsx)</option>
            <option value="rent_roll" ${u.kind === 'rent_roll' ? 'selected' : ''}>Rent roll (Yardi summary or OneSite detail)</option>
            <option value="comparison" ${u.kind === 'comparison' ? 'selected' : ''}>Property comparison (comp set)</option>
            <option value="seller_t12" ${u.kind === 'seller_t12' ? 'selected' : ''}>Seller T12 statement (monthly actuals)</option>
            <option value="payroll" ${u.kind === 'payroll' ? 'selected' : ''}>ND payroll model (wage aggregates)</option>
          </select></div>
        <div class="fld"><label>File</label><input type="file" id="up-file" accept=".xlsx,.xls,.xlsm"></div>
        <button class="btn" id="up-parse" ${u.busy ? 'disabled' : ''}>${u.busy ? 'Parsing…' : 'Parse'}</button>
      </div>
      ${u.err ? `<div class="err">${esc(u.err)}</div>` : ''}
      ${u.msg ? `<div class="ok">${esc(u.msg)}</div>` : ''}
      <div id="up-preview"></div>
    </div>`;
  el.querySelector('#up-kind').addEventListener('change', (e) => { u.kind = e.target.value; u.parsed = null; u.err = ''; u.msg = ''; render(); });
  el.querySelector('#up-parse').addEventListener('click', async () => {
    const f = el.querySelector('#up-file').files[0];
    if (!f) { u.err = 'Choose a file first'; render(); return; }
    u.busy = true; u.err = ''; u.msg = ''; render();
    try {
      const fd = new FormData();
      fd.append('file', f);
      u.parsed = await api(`/uploads/parse?kind=${u.kind}`, { method: 'POST', body: fd });
      u.err = '';
    } catch (e) { u.err = e.message; u.parsed = null; }
    u.busy = false; render();
  });
  if (u.parsed) renderUploadPreview(el.querySelector('#up-preview'), u.parsed);
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
      <div class="mapping"><table class="list"><tr><th>Source</th><th>Units</th><th>Market/mo</th><th>In-place/mo</th><th>As of</th><th>Property</th></tr>
      ${parsed.properties.map((p, i) => `<tr>
        <td>${esc(p.code || p.name)}</td><td>${p.units}</td><td>${money(p.marketMonthly)}</td><td>${money(p.inPlaceMonthly)}</td>
        <td>${esc(p.asOf || '')}</td>
        <td><select data-map="${i}">${propOptions(p.code && S.state.properties.some((x) => x.code === p.code) ? p.code : guessProp(p.name))}</select></td>
      </tr>`).join('')}</table></div>
      <div class="row" style="margin-top:10px"><button class="btn" id="up-apply">Save rent snapshots</button></div>`;
    el.querySelector('#up-apply').addEventListener('click', async () => {
      const mappings = [...el.querySelectorAll('[data-map]')].map((sel) => {
        const src = parsed.properties[Number(sel.dataset.map)];
        return { sourceCode: src.code, sourceName: src.name, propertyCode: sel.value || null };
      }).filter((m) => m.propertyCode);
      if (!mappings.length) { S.upload.err = 'Map at least one row'; render(); return; }
      await POST('/uploads/apply', { kind: 'rent_roll', filename: parsed.filename, payload: parsed, mappings });
      S.upload.msg = `Saved ${mappings.length} rent snapshot(s)`; S.upload.parsed = null;
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
        <button class="btn" id="up-apply">Save payroll model</button>
      </div>`;
    el.querySelector('#up-apply').addEventListener('click', async () => {
      await POST('/uploads/apply', { kind: 'payroll', filename: parsed.filename, payload: parsed, name: el.querySelector('#pm-name').value });
      S.upload.msg = 'Payroll model saved'; S.upload.parsed = null;
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

  el.innerHTML = `
    <div class="row" style="justify-content:space-between; margin-bottom:10px">
      <h2 style="margin:0">${esc(prop.name)} <span class="muted">(${esc(b.property_code)}) — ${b.year} budget</span></h2>
      <div class="row">
        <div class="fld"><label>Export CSV (zero months through)</label>
          <select id="ex-cutoff"><option value="0">Full year</option>${MONTHS.slice(0, 11).map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}</select></div>
        <button class="btn sub" id="ex-csv">⬇ Yardi CSV</button>
        <button class="btn sub" id="ex-xlsx">⬇ Review workbook</button>
        <button class="btn sub" id="recalc">↻ Recalc</button>
        <label style="align-self:center"><input type="checkbox" id="showzero" ${S.showZero ? 'checked' : ''}> show zero rows</label>
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
    <div class="editor">
      <div>
        <div class="gridwrap">${gridHtml(bv, totals)}</div>
      </div>
      <div class="side">
        <div class="card tie">
          <h2>Tie-out vs UW</h2>
          ${tieHtml(bv)}
        </div>
        <div class="card">
          <h2>Assumptions</h2>
          ${inputsHtml(inp)}
          <div class="row" style="margin-top:10px"><button class="btn" id="inp-apply">Apply & regenerate</button></div>
          <p class="muted" style="font-size:11.5px">Regeneration recomputes every non-overridden line. Manual cell edits (purple) are kept.</p>
        </div>
      </div>
    </div>`;

  document.getElementById('ex-csv').addEventListener('click', () => {
    const c = document.getElementById('ex-cutoff').value;
    window.open(`/api/budgets/${b.id}/export.csv?cutoff=${c}`, '_blank');
  });
  document.getElementById('ex-xlsx').addEventListener('click', () => window.open(`/api/budgets/${b.id}/export.xlsx`, '_blank'));
  document.getElementById('recalc').addEventListener('click', async () => { S.bv = await POST(`/budgets/${b.id}/recalc`); render(); });
  document.getElementById('showzero').addEventListener('change', (e) => { S.showZero = e.target.checked; render(); });
  document.getElementById('inp-apply').addEventListener('click', () => applyInputs(b, el));

  // month-cell + note editing
  el.querySelectorAll('td.m input').forEach((box) => {
    box.addEventListener('change', async () => {
      const gl = box.dataset.gl;
      const row = [...el.querySelectorAll(`td.m input[data-gl="${gl}"]`)];
      const months = row.map((x) => parseFloat(String(x.value).replace(/,/g, '')) || 0);
      S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { months });
      render();
    });
  });
  el.querySelectorAll('td.note input').forEach((box) => {
    box.addEventListener('change', async () => {
      S.bv = await PUT(`/budgets/${b.id}/lines/${box.dataset.gl}`, { note: box.value });
    });
  });
  el.querySelectorAll('[data-unlock]').forEach((btn) => btn.addEventListener('click', async () => {
    S.bv = await PUT(`/budgets/${b.id}/lines/${btn.dataset.unlock}`, { override: false });
    S.bv = await POST(`/budgets/${b.id}/recalc`);
    render();
  }));
  el.querySelectorAll('[data-tools]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openRowTools(b, btn.dataset.tools, btn);
  }));
  el.querySelectorAll('.tie .rb:not(.basis)').forEach((btn) => btn.addEventListener('click', async () => {
    S.bv = btn.dataset.noi
      ? await POST(`/budgets/${b.id}/tie-noi`)
      : btn.dataset.egi
        ? await POST(`/budgets/${b.id}/tie-income`)
        : await POST(`/budgets/${b.id}/rebalance`, { pcode: btn.dataset.p });
    render();
  }));
  el.querySelectorAll('.tie .rb.basis').forEach((btn) => btn.addEventListener('click', async () => {
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
  const uwByCat = bv.uw ? bv.uw.y1 : null;
  const rows = [];
  rows.push(`<tr><th>GL</th><th style="min-width:210px">Account</th>${MONTHS.map((m) => `<th>${m}</th>`).join('')}<th>Annual</th><th>$/Unit</th><th>Note</th></tr>`);
  const units = Number(bv.budget.inputs?.units) || 1;
  const GRAND = new Set(['5500', '7279', '7280', '8200', '9000']);
  for (const a of coa) {
    if (!a.active) continue;
    if (a.kind === 'header') {
      rows.push(`<tr class="header"><td class="code">${a.code}</td><td class="name" colspan="16">${esc(a.name)}</td></tr>`);
      continue;
    }
    if (a.kind === 'total') {
      const m = totals.get(a.code) || Array(12).fill(0);
      const ann = sumM(m);
      if (!S.showZero && !ann && !m.some((v) => v)) {
        rows.push(`<tr class="total zero ${S.showZero ? 'show' : ''}"></tr>`);
        continue;
      }
      rows.push(`<tr class="total ${GRAND.has(a.code) ? 'grand' : ''}"><td class="code">${a.code}</td><td class="name">${esc(a.name)}</td>
        ${m.map((v) => `<td class="${v < 0 ? 'neg' : ''}">${money(v)}</td>`).join('')}
        <td class="${ann < 0 ? 'neg' : ''}"><b>${money(ann)}</b></td><td>${money(ann / units)}</td><td></td></tr>`);
      continue;
    }
    const l = linesByGl.get(a.code);
    const m = l ? l.months : Array(12).fill(0);
    const ann = sumM(m);
    const isZero = !ann && !m.some((v) => v) && !(l && l.note);
    if (isZero && !S.showZero) continue;
    rows.push(`<tr>
      <td class="code">${a.code}</td>
      <td class="name" title="${esc(a.name)} ${a.pcode ? '· cat ' + a.pcode : ''}"><button class="rowtool" data-tools="${a.code}" title="Quick row tools">⋯</button> ${esc(a.name)}${l && l.override ? ` <button class="rb" data-unlock="${a.code}" title="Clear manual override">🔓</button>` : ''}</td>
      ${m.map((v, i) => `<td class="m"><input data-gl="${a.code}" data-i="${i}" value="${v ? money2(v) : ''}" class="${l && l.override ? 'ovr' : ''}"></td>`).join('')}
      <td class="${ann < 0 ? 'neg' : ''}"><b>${money(ann)}</b></td>
      <td>${ann ? money(ann / units) : ''}</td>
      <td class="note"><input data-gl="${a.code}" value="${esc(l ? l.note : '')}" placeholder="note"></td>
    </tr>`);
  }
  return `<table class="grid">${rows.join('')}</table>`;
}

function tieHtml(bv) {
  if (!bv.uw) return '<p class="muted">No UW snapshot linked — tie-out unavailable.</p>';
  const t = bv.tieout;
  const rebalanceable = new Set(['loss', '2', '3', '4', '5', '6', '8', '9', '10', '11', '12', '13', '14']);
  const basisable = new Set(['4', '5', '6', '8', '9', '10', '11', '12', '13', '14']);
  const catBasis = (bv.budget.inputs || {}).catBasis || {};
  const canPerUnit = !!bv.compUnits;
  const row = (r, big) => {
    const cls = Math.abs(r.variance) < 1 ? 'good' : (Math.abs(r.variance) / (Math.abs(r.uw) || 1) > 0.02 ? 'bad' : '');
    const basis = catBasis[r.pcode] === 'perUnit' ? 'perUnit' : 'uw';
    const basisCtl = !big && basisable.has(r.pcode) && canPerUnit
      ? `<button class="rb basis" data-b="${r.pcode}" title="Level basis — click to switch">${basis === 'perUnit' ? '$/unit' : 'UW'}</button>` : '';
    const isNoi = r.label === 'Net Operating Income';
    const noiCtl = isNoi && Math.abs(r.variance) >= 1 ? `<button class="rb" data-noi="1" title="Scale the flex categories (admin, marketing, R&M, rehab) so NOI equals UW exactly">tie NOI</button>` : '';
    const isEgi = r.label === 'Effective Gross Income';
    const egiCtl = isEgi && Math.abs(r.variance) >= 1 ? `<button class="rb" data-egi="1" title="Adjust loss-to-lease so Total Income equals UW exactly (GPR stays on the rent roll)">tie income</button>` : '';
    return `<tr class="${big ? 'big' : ''}"><td>${esc(r.label)}</td>
      <td>${money(r.budget)}</td><td>${money(r.uw)}</td>
      <td class="var ${cls}">${money(r.variance)}</td>
      <td>${noiCtl}${egiCtl}${basisCtl}${!big && rebalanceable.has(r.pcode) && Math.abs(r.variance) >= 1 ? `<button class="rb" data-p="${r.pcode}">tie</button>` : ''}</td></tr>`;
  };
  const stub = (bv.budget.inputs || {}).startMonth > 1;
  return `<table>
    <tr><th>Category</th><th>Budget</th><th>UW${stub ? ' (prorated)' : ' Y1'}</th><th>Δ</th><th></th></tr>
    ${t.rows.map((r) => row(r, false)).join('')}
    ${row(t.egi, true)}${row(t.toe, true)}${row(t.noi, true)}
  </table>
  <p class="muted" style="font-size:11px"><b>NOI ties 100% to UW</b> — at generation and via “tie NOI”, the flex categories (admin, marketing, R&M, rehab) absorb the gap; other categories stay in line with their basis. Category “tie” scales that category's non-overridden lines to its own target. Basis buttons switch a category between <b>UW</b> and <b>Minot $/unit × units</b>. Payroll benefits/bonuses follow Minot ratios on the property's wage totals. GPR always anchors to the rent roll.</p>`;
}

function inputsHtml(inp) {
  const g = inp.gpr || {};
  const l = inp.ltl || {};
  return `
    <div class="row">
      <div class="fld"><label>GPR base $/mo</label><input id="in-gprbase" value="${g.baseMonthly ?? 0}" style="width:110px"></div>
      <div class="fld"><label>GPR growth %/mo (1 or 12 vals)</label><input id="in-gprgrow" value="${show12(g.growthPct || [])}" style="width:130px"></div>
      <div class="fld"><label>Start month</label><select id="in-start">${MONTHS.map((m, i) => `<option value="${i + 1}" ${inp.startMonth === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    </div>
    <div class="row" style="margin-top:6px">
      <div class="fld"><label>LTL start $/mo (neg)</label><input id="in-ltlstart" value="${l.startMonthly ?? 0}" style="width:100px"></div>
      <div class="fld"><label>LTL target % of GPR</label><input id="in-ltlpct" value="${((l.targetPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
      <div class="fld"><label>Ramp months</label><input id="in-ltlramp" value="${l.rampMonths ?? 12}" style="width:70px"></div>
    </div>
    <div class="row" style="margin-top:6px">
      <div class="fld"><label>Vacancy % (1 or 12 vals)</label><input id="in-vac" value="${show12(inp.vacancyPct || [])}" style="width:120px"></div>
      <div class="fld"><label>Concessions %</label><input id="in-conc" value="${((inp.concessionPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
      <div class="fld"><label>Rental loss % (total)</label><input id="in-rloss" value="${((inp.rentalLossPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
    </div>
    <div class="row" style="margin-top:6px">
      <div class="fld"><label>Mgmt fee % of income</label><input id="in-mgmt" value="${((inp.mgmtPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
      <div class="fld"><label>Units</label><input id="in-units" value="${inp.units ?? 0}" style="width:70px"></div>
    </div>
    <div class="row" style="margin-top:6px">
      <div class="fld"><label>Loan $</label><input id="in-loan" value="${inp.loan ?? 0}" style="width:110px"></div>
      <div class="fld"><label>Rate %</label><input id="in-rate" value="${((inp.rate || 0) * 100).toFixed(2)}" style="width:70px"></div>
      <div class="fld"><label>Capital $ (CoC)</label><input id="in-cap" value="${inp.capital ?? 0}" style="width:110px"></div>
    </div>
    <div class="row" style="margin-top:6px">
      <label title="Adjust loss-to-lease so Total Income equals the (prorated) UW EGI"><input type="checkbox" id="in-tieinc" ${inp.tieIncome !== false ? 'checked' : ''}> Tie income (via LTL)</label>
      <label title="Scale the flex categories so NOI equals the (prorated) UW NOI"><input type="checkbox" id="in-tienoi" ${inp.tieNoi !== false ? 'checked' : ''}> Tie NOI (via flex cats)</label>
    </div>
    <h3>UW category targets ($/yr)</h3>
    <div class="row">
      ${['4', '5', '6', '8', '9', '10', '11', '12', '13', '14'].map((p) => `
        <div class="fld"><label>cat ${p}</label><input class="in-uwabs" data-p="${p}" value="${(inp.uwAbs || {})[p] ?? 0}" style="width:92px"></div>`).join('')}
    </div>`;
}

async function applyInputs(b, el) {
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
    ltl: { startMonthly: num('#in-ltlstart'), targetPct: num('#in-ltlpct') / 100, rampMonths: num('#in-ltlramp') || 12 },
    vacancyPct: parse12(el.querySelector('#in-vac').value, Array(12).fill(0.05)),
    concessionPct: num('#in-conc') / 100,
    rentalLossPct: num('#in-rloss') / 100,
    mgmtPct: num('#in-mgmt') / 100,
    tieIncome: el.querySelector('#in-tieinc').checked,
    tieNoi: el.querySelector('#in-tienoi').checked,
    uwAbs,
  };
  S.bv = await PUT(`/budgets/${b.id}`, { inputs });
  render();
}

/* ---------------- row quick tools ---------------- */
function openRowTools(b, gl, anchorBtn) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const inp = S.bv.budget.inputs || {};
  const start = inp.startMonth || 1;
  const liveMonths = 13 - start;
  const acc = S.state.coa.find((a) => a.code === gl) || {};
  const hasComp = S.bv.compWeights && S.bv.compUnits && S.bv.compWeights[gl];
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.innerHTML = `
    <div class="rm-head">${gl} ${esc(acc.name || '')}</div>
    <button data-act="zero">Zero out row</button>
    <button data-act="flatAnnual">Flat — annual $ over ${liveMonths} live months…</button>
    <button data-act="flatMonthly">Flat — $ per month…</button>
    <button data-act="grow">Start $ /mo + growth %/mo…</button>
    ${hasComp ? `<button data-act="minot">Minot $/unit × units (${money((S.bv.compWeights[gl] / S.bv.compUnits) * inp.units)}/yr, seasonal)</button>` : ''}
    <button data-act="reset">Reset to engine (clear override)</button>`;
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${r.left + window.scrollX}px`;
  menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);

  const put = async (months) => {
    S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { months });
    render();
  };
  const liveFill = (fn) => Array.from({ length: 12 }, (_, i) => (i + 1 >= start ? fn(i) : 0));

  menu.querySelectorAll('button[data-act]').forEach((mb) => mb.addEventListener('click', async (e) => {
    e.stopPropagation(); close();
    const act = mb.dataset.act;
    if (act === 'zero') return put(Array(12).fill(0));
    if (act === 'flatAnnual') {
      const v = parseFloat(String(prompt('Annual amount ($) — spread evenly over the live months:') || '').replace(/,/g, ''));
      if (!Number.isFinite(v)) return;
      return put(liveFill(() => Math.round((v / liveMonths) * 100) / 100));
    }
    if (act === 'flatMonthly') {
      const v = parseFloat(String(prompt('Amount per month ($):') || '').replace(/,/g, ''));
      if (!Number.isFinite(v)) return;
      return put(liveFill(() => v));
    }
    if (act === 'grow') {
      const base = parseFloat(String(prompt('Starting amount for the first live month ($/mo):') || '').replace(/,/g, ''));
      if (!Number.isFinite(base)) return;
      const g = parseFloat(String(prompt('Growth % per month (e.g. 0.5):') || '').replace(/,/g, '')) || 0;
      let cur = base;
      return put(liveFill((i) => {
        const val = Math.round(cur * 100) / 100;
        cur = cur * (1 + g / 100);
        return val;
      }));
    }
    if (act === 'minot') {
      const annual = (S.bv.compWeights[gl] / S.bv.compUnits) * (inp.units || 0);
      const shape = (S.bv.compShapes && S.bv.compShapes[gl]) || Array(12).fill(1);
      const liveShape = shape.map((w, i) => (i + 1 >= start ? w : 0));
      const wsum = shape.reduce((a, x) => a + x, 0) || 1;
      // full-year seasonal spread, truncated to live months (stub gets its seasonal share)
      return put(liveShape.map((w) => Math.round(((annual * w) / wsum) * 100) / 100));
    }
    if (act === 'reset') {
      S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { override: false });
      S.bv = await POST(`/budgets/${b.id}/recalc`);
      render();
    }
  }));
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
        <table class="list" id="coa-t"><tr><th>Code</th><th>Name</th><th>Kind</th><th>Section</th><th>P-code</th><th>Curve</th><th>CSV#</th></tr>
        ${st.coa.map((a) => `<tr data-row="${a.code} ${esc(a.name).toLowerCase()}"><td>${a.code}</td><td>${esc(a.name)}</td><td class="muted">${a.kind}</td><td class="muted">${a.section}</td>
          <td>${S.auth.isAdmin && a.kind === 'detail' ? `<input data-pc="${a.code}" value="${a.pcode ?? ''}" style="width:44px">` : (a.pcode ?? '')}</td>
          <td>${S.auth.isAdmin && a.kind === 'detail' ? `<input data-cv="${a.code}" value="${a.curve ?? ''}" style="width:70px">` : (a.curve ?? '')}</td>
          <td class="muted">${a.csv_order ?? ''}</td></tr>`).join('')}</table>
      </div>
      <p class="muted">Curves: flat, snow, heat, electric, summer, turnover. P-codes: 1, loss, 2–14 (blank = below the line).</p>
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
}

boot();
