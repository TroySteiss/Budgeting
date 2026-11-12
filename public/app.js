/* Budget Tool SPA — no framework, mirrors the SP Tracker pattern.
   State flows: /api/state (lists) + /api/budgets/:id (editor payload). */
'use strict';

const REGIONS_UI = { nd: 'North Dakota', kc: 'KC East' };   // keys mirror REGIONS in src/db.ts
const S = {
  auth: null,          // {authed, username, isAdmin, appTitle}
  state: null,         // {coa, portfolios, properties, budgets, uwSnapshots, compSets, rentSnapshots}
  view: 'dash',        // dash | uploads | editor | settings
  bv: null,            // budget view payload {budget, lines, tieout, kpis, uw, compWeights}
  showZero: false,
  upload: { kind: 'yardi_template', files: [], parsed: null, busy: false, msg: '', err: '' },
  err: '',
  theme: localStorage.getItem('bt-theme') || 'light',
  // region (Troy 2026-11-11): North Dakota or KC East — fully separate data (its own DB schema).
  // Held per TAB and sent on every request, so two tabs on different regions never cross-write.
  region: REGIONS_UI[localStorage.getItem('bt-region')] ? localStorage.getItem('bt-region') : 'nd',
  hiddenCols: new Set(JSON.parse(localStorage.getItem('bt-hidecols') || '[]')),
  undo: { budgetId: null, stack: [] },   // snapshots of {lines, inputs} before each change
  showDist: localStorage.getItem('bt-dist') === '1',
  showQDist: localStorage.getItem('bt-qdist') === '1',   // the same % of the year, by quarter
  pendingRow: null,                      // in-progress row edit buffer {gl, months, dirty}
  gridScroll: null,
  // pay-rates tab: its own gate + working set (st = /payroll/state, cycle = /payroll/cycles/:id)
  pay: { st: null, cycle: null, cycleId: null, region: '*', iterId: null, compare: true, loading: false, err: '', msg: '', newCycle: false },
};

function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  localStorage.setItem('bt-theme', S.theme);
}

/* driver metadata: colour class + short tag + label for the formula a row uses */
function drvMeta(l) {
  const m = drvMetaCore(l);
  // smoothing sits ON TOP of the line's formula: the formula keeps its chip, SMOOTH is a second one
  const extra = [];
  if (l && l.driver && l.driver.smooth && l.driver.method !== 'smooth') {
    extra.push({ cls: 'drv-t12', tag: 'SMOOTH', label: `Missed-bill smoothing ×${l.driver.smooth.passes || 0} on top of this formula: spikes spread into the surrounding months, no negative months, every month rounded to $${l.driver.smooth.mult || 5}. The months are now fixed; 🔓 puts the line back on its formula.` });
  }
  if (l && l.driver && l.driver.qShift) { const q = l.driver.qShift; extra.push({ cls: 'drv-fee', tag: q.capped ? 'Q-SHIFT·cap' : 'Q-SHIFT', label: `Carries part of the quarter shift: its year total is unchanged, its dollars sit in other quarters so NOI lands at ${(q.targets || []).map((v, i) => `Q${i + 1} ${(v * 100).toFixed(1)}%`).join(' · ')}${q.capped ? ` — stopped at ${Math.round(q.lam * 100)}% of the shift (a quarter reached half its formula amount)` : ''}. More → Shift NOI between quarters…` }); }
  if (l && l.driver && l.driver.fitT12) extra.push({ fit: true, cls: 'drv-t12', tag: `FIT ${Math.round(l.driver.fitT12 * 100)}%`, label: `Months lean ${Math.round(l.driver.fitT12 * 100)}% toward this GL's own trailing-12 months (year total unchanged) — row menu or section header "fit to T12"` });
  // one-time items taken out of this GL's trailing-12 before the formula read it (More → One-time items)
  if (l && l.driver && l.driver.oneTime) extra.push({ cls: 'drv-t12', tag: '−1X', label: `$${money(l.driver.oneTime)} of one-time items taken out of the trailing-12 before this formula read it (More → One-time items out of the T12…)` });
  // the recurring-journal split (TPND → TPNDC)
  if (l && l.driver && l.driver.allocOut) { const a = l.driver.allocOut; extra.push({ cls: 'drv-corp', tag: `−${Math.round(a.pct * 10000) / 100}%`, label: `${Math.round(a.pct * 10000) / 100}% of this line moves to ${String(a.to).toUpperCase()} by recurring journal: $${money(a.gross)} gross, $${money(a.out)} to ${String(a.to).toUpperCase()} (Assumptions → journal split)` }); }
  return extra.length ? { ...m, extra } : m;
}
/* The chip a formula choice produces, shown BESIDE the choice wherever formulas are picked (Troy
   2026-11-11: "colored chips … next to different formula options when picking out, so that the
   code/color for each is more clear"). Same tag + colour as the grid's Fx chip. */
const SHAPE_CHIP = { actual: ['drv-base', 'SAME MO'], wavg: ['drv-base', 'WAVG'], flat: ['drv-base', 'T12/12'], curve: ['drv-base', 'CURVE'], avgnz: ['drv-base', 'AVG≠0'], last: ['drv-base', 'LAST'], turns: ['drv-base', 'TURNS'] };
const chipHtml = (cls, tag) => `<span class="drv ${cls} optchip">${esc(tag)}</span>`;
const shapeChip = (k) => (SHAPE_CHIP[k] ? chipHtml(SHAPE_CHIP[k][0], SHAPE_CHIP[k][1]) : '');
/** does this GL have a real seasonal curve (electric, heat, snow …)? With none, "seasonal curve" is just T12 ÷ 12 */
const glHasCurve = (gl) => { const a = ((S.state && S.state.coa) || []).find((x) => x.code === gl); return !!(a && a.curve && a.curve !== 'flat'); };
/* <select> options cannot hold a chip: they carry the tag and the chip's colours instead */
const _chipStyleCache = {};
function chipStyle(cls) {
  if (_chipStyleCache[cls] != null) return _chipStyleCache[cls];
  const el = document.createElement('span'); el.className = `drv ${cls}`; el.style.position = 'absolute'; el.style.visibility = 'hidden';
  document.body.appendChild(el);
  const cs = getComputedStyle(el); const st = `background-color:${cs.backgroundColor}; color:${cs.color}`;
  el.remove();
  return (_chipStyleCache[cls] = st);
}
const shapeOpt = (k, text, extra = '') => { const c = SHAPE_CHIP[k]; return `<option value="${k}" ${extra} ${c ? `style="${chipStyle(c[0])}"` : ''}>${c ? `${c[1]} · ` : ''}${text}</option>`; };
const drvExtraHtml = (dm) => (dm.extra || []).map((x) => `<span class="drv ${x.cls}" style="margin-left:3px" title="${esc(x.label)}">${x.tag}</span>`).join('');
function drvMetaCore(l) {
  const m = drvMetaBase(l);
  // hand-revised cells on a formula line keep the formula's identity — the
  // revision is dictated as a * on the tag, never demoted to MAN
  if (l && l.driver && l.driver.revised && m.tag !== 'MAN' && m.tag !== '—') {
    return { ...m, tag: m.tag + '*', label: m.label + ' — cells hand-revised' };
  }
  // months still inside ownership Year 1 come from the property's Y1 budget, the rest from the formula
  if (l && l.driver && Array.isArray(l.driver.y1) && l.driver.y1.length && !l.override) {
    const y = l.driver.y1, span = `${MONTHS[y[0]]}–${MONTHS[y[y.length - 1]]}`;
    return m.tag === 'MAN' || m.tag === '—' ? { ...m, cls: 'drv-fee', tag: 'Y1', label: `${span} from the Year-1 budget; nothing budgeted after` } : { ...m, tag: 'Y1+' + m.tag, label: `${span} from the Year-1 budget; then ${m.label}` };
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
    case 'wavg': return { cls: l.driver.srcType === 'seller' ? 'drv-t12' : 'drv-comp', tag: 'WAVG', label: `1-2-1 weighted distribution of ${l.driver.basis === 'budget' ? 'the current-year budget for ' : ''}${l.driver.srcName || ''} × ${((l.driver.pct || 0)).toFixed(1)}%${l.driver.mult ? ` → MROUND $${l.driver.mult}` : ''}` };
    case 'gpr': return { cls: 'drv-rr', tag: l.driver.hap ? 'ROLL−HAP' : 'ROLL', label: `GPR — steps: ${gprStepsSummary(((S.bv && S.bv.budget && S.bv.budget.inputs) || {}).gpr ? S.bv.budget.inputs.gpr.growthPct : null)}${l.driver.hap ? ` · the rent roll's GPR less HAP $${money(l.driver.hap)}/mo (4995 / 4996), so GPR + HAP = the rent roll GPR ($${money(l.driver.gross || 0)} for the year)` : ''}` };
    case 'ltl': {
      const lt = (S.bv && S.bv.budget && S.bv.budget.inputs && S.bv.budget.inputs.ltl) || {};
      const how = lt.mode === 'flat' ? 'held flat (no burnoff)' : lt.mode === 'ramp' ? 'ramp to a % of GPR' : (S.bv && S.bv.leaseCount) ? 'per-lease burnoff at each turnover' : 'burnoff on lease expirations';
      const d = l.driver || {};
      const hapTxt = d.hap ? ` · HAP $${money(d.hap)}/mo is rent, not loss to lease: it sits in GPR + HAP (4995 / 4996) and never burns; this line is only market − resident rent − HAP${d.hapEst ? " — HAP placed from the roll's subsidy total on the lowest-rent leases; re-upload the rent roll for each unit's own HAP" : ''}${d.hapUnplaced ? `; $${money(d.hapUnplaced)}/mo could not be matched to a lease` : ''}` : '';
      const m0Txt = lt.month0 != null ? ` · starts at the typed ${money(-Math.abs(lt.month0))} in the first month and runs on from there${d.k ? ` (every lease's gap scaled ×${d.k})` : ''} — clear it in the row's box (Month 1 $)` : '';
      return { cls: 'drv-rr', tag: `${d.hap ? 'LTL·HAP' : 'LTL'}${lt.month0 != null ? '·START' : ''}`, label: `Loss to lease — ${how}${m0Txt}${lt.followGpr !== false && lt.mode !== 'ramp' ? ', deepens with GPR growth' : ''} · renewal %, burnoff on renewal / move-in are the boxes to the right (method + "follows GPR" under Assumptions)${hapTxt}` };
    }
    case 'vacancy': {
      const d = l.driver;
      if (d.shaped === 'expirations') return { cls: 'drv-rr', tag: 'VAC·EXP', label: `Vacancy averages ${(d.avg * 100).toFixed(2)}% of GPR for the year. Month by month it carries over: ${d.startPct != null ? `it starts from the last actual month (${(d.startPct * 100).toFixed(1)}%), ` : ''}move-outs land the month after a lease expires and empty units fill gradually (slowest in winter) — ${(Math.min(...d.pcts) * 100).toFixed(1)}% to ${(Math.max(...d.pcts) * 100).toFixed(1)}%${d.weight != null && d.weight < 1 ? ` (${Math.round(d.weight * 100)}% weight on expirations)` : ''}` };
      if (d.shaped === 'typed') return { cls: 'drv-rr', tag: '%GPR', label: `Vacancy % of GPR typed month by month (averages ${(d.avg * 100).toFixed(2)}%)` };
      return { cls: 'drv-rr', tag: '%GPR', label: d.avg != null ? `Vacancy ${(d.avg * 100).toFixed(2)}% of GPR every month (set flat, or the lease expirations on file cover fewer than nine months)` : '% of GPR' };
    }
    case 'contract': {
      const d = l.driver, items = (d.items || []).map((x) => `${x.vendor || 'contract'} $${money(x.annual)}`).join(' + ');
      return { cls: 'drv-corp', tag: d.mode === 'add' ? 'CONTRACT+' : 'CONTRACT', label: `${d.mode === 'add' ? 'Formula plus known contracts' : 'Known contracts'}: ${items} (More → Contracts & known costs…)` };
    }
    case 'flatFee': if (l.driver.schedule) return { cls: 'drv-rr', tag: 'FEE SCHED', label: `Flat-fee package schedule: $${money(l.driver.F, 2)} per occupied unit on the fee, $${money(l.driver.R, 2)} on RUBS until each lease switches at expiration (${Math.round((l.driver.share[0] || 0) * 100)}% on the fee in the first month, ${Math.round((l.driver.share[11] || 0) * 100)}% by the last) × budgeted occupancy; this GL takes ${Math.round((l.driver.weight || 0) * 1000) / 10}% of it (last actual month's mix)` };
      return { cls: 'drv-rr', tag: 'FLAT FEE', label: `Flat utility fee per occupied unit — ${MONTHS[(l.driver.lastMonth || 1) - 1]} actual $${money(l.driver.base || 0)} × budgeted occupancy ÷ ${((l.driver.occLast || 1) * 100).toFixed(1)}% occupied that month (ties to the vacancy assumption)${l.driver.pct ? ` × ${(l.driver.pct * 100).toFixed(1)}% fee increase` : ''}` };
    case 'catShare': return { cls: 'drv-uw', tag: 'UW', label: `UW category ${l.driver.pcode} share` };
    case 'perUnitComp': return { cls: 'drv-comp', tag: 'MINOT', label: `Minot $${l.driver.perUnit}/unit × units` };
    case 'payrollModel': return { cls: 'drv-pay', tag: 'PAY', label: l.driver.live ? `Payroll tab wages — roster rates with each person's raise from "${l.driver.cycle || 'the raise cycle'}" — January at the current rate, half the increase in February, all of it from March${l.driver.draft ? ' · PRELIMINARY: raise entries are not finalized for every region feeding this property — Recalc picks up changes' : ' · finalized'}` : l.driver.roster ? 'Pay-rates roster wages (raises prorated — no March step)' : 'Payroll model wages', tag: l.driver.live && l.driver.draft ? 'PAY·prelim' : 'PAY' };
    case 'burdenRatio': { const bs = l.driver.basis === 'budget' ? 'CY budget ratio' : l.driver.basis === 'mix' ? 'avg of T12 actual & CY budget ratios' : 'T12 actual ratio';
      return { cls: 'drv-pay', tag: l.driver.from ? `%WAGES·${String(l.driver.from).toUpperCase()}` : '%WAGES', label: `${((l.driver.ratio || 0) * 100).toFixed(1)}% of wages (${S.bv && S.bv.annual ? `same-month ${bs} × that month's budgeted wages — keeps the quarterly / seasonal shape` : 'Minot ratio'})${l.driver.from ? ` — the % and the monthly shape are taken from ${String(l.driver.from).toUpperCase()}'s history, applied to this property's own wages` : ''}` }; }
    case 'mgmtPct': { const fy = l.driver.firstYear;
      return { cls: 'drv-fee', tag: fy ? '%INC·Y1' : '%INC', label: fy ? `Management fee: ${((fy.pct || 0) * 100).toFixed(2)}% for the first 12 months of ownership (income through ${fy.through}; ${fy.months} fee month${fy.months === 1 ? '' : 's'} of this budget), then ${((l.driver.pct || 0) * 100).toFixed(2)}% — on the prior month's income` : `${((l.driver.pct || 0) * 100).toFixed(2)}% of ${l.driver.priorMonth ? 'prior-month ' : ''}income` }; }
    case 'interest': return { cls: 'drv-int', tag: 'INT', label: 'Interest (loan × rate × days)' };
    case 'sellerUtil': return { cls: 'drv-t12', tag: 'SLR', label: 'Seller statement level (× growth)' };
    case 'sellerLine': return l.driver.basis === 'budget'
      ? { cls: 'drv-t12', tag: 'CY BUD', label: `Current-year budget by month: ${l.driver.name || ''} × ${(l.driver.pct || 0).toFixed(1)}%` }
      : { cls: 'drv-t12', tag: 'SLR', label: `${S.bv && S.bv.annual ? 'T12 actuals' : 'Seller'}: ${l.driver.name || ''} × ${(l.driver.pct || 0).toFixed(1)}%` };
    case 'recovery': return { cls: 'drv-t12', tag: 'REC', label: `${((l.driver.pct || 0) * 100).toFixed(1)}% of prior-month ${l.driver.src ? `← ${l.driver.src}` : 'billing'}` };
    case 'charges': return { cls: 'drv-rr', tag: 'CHG', label: 'Rent-roll charges × 12' };
    case 'zero': return { cls: 'drv-int', tag: 'ZERO', label: 'Zeroed out — this GL carries nothing' };
    case 'dropped': return { cls: 'drv-drop', tag: '<$1K', label: `NOT budgeted: the trailing-12 was $${money(l.driver.t12 || 0)}, and the template drops lines at or under $${money(l.driver.limit || 1000)}. Click to budget it at T12 ÷ 12` };
    case 't12curve': return { cls: 'drv-t12', tag: 'T12C', label: `${l.driver.basis === 'budget' ? 'Current-year budget' : S.bv && S.bv.annual ? 'Own' : 'Seller'} ${l.driver.name || ''} ${l.driver.basis === 'budget' ? '' : 'T12 '}TOTAL × ${(l.driver.pct || 0).toFixed(1)}% on ${l.driver.shape === 'minot' ? 'the Minot' : l.driver.shape || 'flat'} curve${l.driver.mult ? ` → MROUND $${l.driver.mult}` : ''}` };
    case 'linkLine': return { cls: 'drv-fee', tag: 'LINK', label: `= ${l.driver.src || ''} ${l.driver.srcName || ''} × ${l.driver.weight ?? 1} — follows it live on every regeneration` };
    case 'yardiCsv': return { cls: 'drv-man', tag: 'YARDI', label: `Adopted from the Yardi budget CSV${l.driver.file ? ` (${l.driver.file})` : ''} — the month as it sits in Yardi` };
    case 'imported': return { cls: 'drv-man', tag: 'IMP', label: `Imported from draft workbook${l.driver.file ? ` (${l.driver.file})` : ''}` };
    case 'smooth': return { cls: 'drv-t12', tag: 'SMOOTH', label: `Missed-bill smoothing ×${l.driver.passes || 0}${l.driver.of ? ` of ${String(l.driver.of).toUpperCase()}${l.driver.srcName ? ' ' + l.driver.srcName : ''}` : ''} — spikes spread into surrounding months, total kept` };
    case 'setTotal': return { cls: 'drv-man', tag: 'TOTAL', label: `Total set to ${Math.round(l.driver.total || 0).toLocaleString()} — ${l.driver.of ? `${String(l.driver.of).toUpperCase()} distribution kept` : 'prior distribution kept'}` };
    /* ---- annual (template) rules ---- */
    case 'baseline': {
      const d = l.driver;
      let shape = { actual: 'same calendar month', wavg: '1-2-1 weighted distribution', flat: 'T12 ÷ 12 flat', curve: `T12 total on the GL curve${d.fit ? `, fit ${Math.round(d.fit * 100)}% to its own T12 months` : ''}`, last: 'last actual month, flat', avgnz: 'average of active months, flat', turns: `turnover curve: T12 total on lease expirations + 1 mo lag${d.turns ? ` (${Math.round(d.turns)} expirations)` : ''}${d.fit ? `, fit ${Math.round(d.fit * 100)}% to its own T12 months` : ''}` }[d.shape] || d.shape;
      const factor = d.pcts ? `+ Conservice forecast ${(Math.min(...d.pcts) * 100).toFixed(0)}–${(Math.max(...d.pcts) * 100).toFixed(0)}% by month` : `× ${(1 + (d.pct || 0)).toFixed(3)}`;
      // a GL with no seasonal curve on "curve" is exactly T12 ÷ 12 — show it as that, not CURVE (Troy 2026-11-11)
      const flatCurve = d.shape === 'curve' && !glHasCurve(l.gl_code);
      if (flatCurve) shape = `T12 ÷ 12 flat (this GL has no seasonal curve)${d.fit ? `, fit ${Math.round(d.fit * 100)}% to its own T12 months` : ''}`;
      const tag = d.src === 'budget' ? 'CYB' : d.pcts ? 'UTIL' : flatCurve ? SHAPE_CHIP.flat[1] : (SHAPE_CHIP[d.shape] || SHAPE_CHIP.actual)[1];
      const foldTxt = d.folded ? ` · ${d.folded} credit month${d.folded === 1 ? '' : 's'} in the history folded into the other months (no negative budget months; total kept)` : '';
      const lastWarn = d.lastDev != null ? ` · ⚠ last actual month is ${d.lastDev > 0 ? '+' : ''}${Math.round(d.lastDev * 100)}% vs the T12 average — one month is setting the year (shape menu: T12 ÷ 12 flat)` : '';
      return { cls: 'drv-base', tag: d.lastDev != null ? '⚠LAST' : tag, label: `${d.src === 'budget' ? 'CY budget' : 'Own trailing-12 actual'} — ${shape} ${factor}${d.mult ? ` → MROUND $${d.mult}` : ''} · T12 ${Math.round(d.base || 0).toLocaleString()}${foldTxt}${d.drift ? ` · tilted ${(d.drift * 100).toFixed(1)}% January to December (costs drift up through the year; year total unchanged)` : ''}${d.rule ? ' · default shape and factor from the 2026 GRKS draft (not set for this property)' : ''}${lastWarn}` };
    }
    case 'pctGpr': return { cls: 'drv-base', tag: l.driver.of === 'net' ? '%NET RENT' : l.driver.of === 'netgpr' ? '%NET GPR' : '%GPR', label: `${((l.driver.pct || 0) * 100).toFixed(2)}% of ${l.driver.of === 'net' ? 'net rental income' : l.driver.of === 'netgpr' ? 'net GPR' : 'GPR'} (${l.driver.basis === 'last' ? 'last-month' : 'trailing-12'} ratio)${l.driver.capped ? ` — CAPPED at each month's budgeted delinquency (the ratio alone gave ${money(l.driver.uncapped || 0)} for the year; collections cannot exceed what is delinquent)` : ''}` };
    case 'collections': return { cls: 'drv-base', tag: '%PRIOR DQ', label: `${((l.driver.pct || 0) * 100).toFixed(1)}% of the PREVIOUS month's delinquency is collected (January collects against the last actual month's $${money(l.driver.startDq || 0)}). Higher delinquency one month means higher collections the next; it can never exceed that delinquency${l.driver.capped ? ` — the trailing-12 collected ${((l.driver.t12Rate || 0) * 100).toFixed(0)}% of its delinquency (older balances), capped here at 100%` : ''}` };
    case 'recapture': return { cls: 'drv-base', tag: 'RECAP', label: `${((l.driver.pct || 0) * 100).toFixed(1)}% recapture of the other concession lines (T12 ratio)` };
    case 'perTurn': return { cls: 'drv-base', tag: 'T12·TURNS', label: `Last year's dollars placed on the months with projected move-ins (${money(l.driver.turns)} of them, $${money(l.driver.amount)} each). The YEAR total stays at the trailing-12 unless a $ per move-in is typed — it does not move with the renewal %` };
    case 'suggested': return { cls: 'drv-corp', tag: 'CORP', label: `Corporate budget suggestion${l.driver.note ? ` — ${l.driver.note}` : ''}` };
    case 'corpRate': return { cls: 'drv-corp', tag: '$/UNIT', label: `Corporate rate${l.driver.perUnitYr ? ` $${l.driver.perUnitYr}/unit/yr` : ''}${l.driver.flatMo ? ` + $${l.driver.flatMo}/mo` : ''}` };
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
    calcVersion: S.bv.budget.calc_version || null,   // so Undo also puts back which formula version the lines were built on
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
/* the tab's region rides on every call (X-Region) and on every download link (?region=) */
const rUrl = (u) => u + (u.includes('?') ? '&' : '?') + 'region=' + S.region;
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    headers: { 'X-Region': S.region, ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
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
const fmtd = (d) => (d ? new Date(d).toLocaleDateString() : '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sumM = (m) => (m || []).reduce((a, b) => a + (Number(b) || 0), 0);
/* Blended increase of a year total over its trailing-12, as text. Signed reference, like the
   compare card: a contra line shrinking 10% reads -10%. No T12 to compare to reads "new". */
function t12PctText(total, t12) {
  if (!t12) return Math.abs(total) >= 0.5 ? 'new' : '';
  const g = (total - t12) / t12;
  return `${g > 0 ? '+' : ''}${(g * 100).toFixed(1)}%`;
}
/* live: while a row is being typed, show what its total now comes out to vs the T12 */
function liveT12Pct(gl, total) {
  const td = document.querySelector(`td[data-t12pct="${gl}"]`);
  if (!td) return;
  td.textContent = t12PctText(total, Number(td.dataset.t12) || 0);
  td.classList.add('man', 'live');
}

/* Corporate rate defaults by budget year — mirrors corpRatesFor() in shared/annual.ts, keep in step.
   2027+: 6310 = $58.17/unit/yr + $513/mo (Payroll Budget Workbook 2027 rev2, 6451 folded in);
   6108 insurance = $275/unit/yr (2026-27 blanket policy year). */
function corpDefaults(year) {
  return { 6108: { perUnitYr: Number(year) >= 2027 ? 275 : 285 }, 6310: Number(year) >= 2027 ? { perUnitYr: 58.17, flatMo: 513 } : { perUnitYr: 43.14, flatMo: 483 }, 6320: { perUnitYr: 7.86 }, 6560: { perUnitYr: 24.76 } };
}

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
  document.body.dataset.region = S.region;
  S.auth = await GET('/auth/status').catch(() => ({ authed: false }));
  if (S.auth.authed) S.state = await GET('/state');
  render();
}
async function refreshState() { S.state = await GET('/state'); }

/* Switch the tab to another region: drop everything loaded from the old one (open budget,
   undo stack, payroll working set, summary, upload preview) and reload its lists. */
async function switchRegion(r) {
  if (!REGIONS_UI[r] || r === S.region) return;
  if (S.pendingRow && S.pendingRow.dirty && !confirm('You have an unsaved row edit. Switch region and discard it?')) return;
  S.region = r;
  try { localStorage.setItem('bt-region', r); } catch {}
  document.body.dataset.region = r;
  S.view = 'dash'; S.bv = null; S.pendingRow = null; S.sum = null; S.revRules = null; S.err = '';
  S.undo = { budgetId: null, stack: [] };
  S.upload = { kind: 'yardi_template', files: [], parsed: null, busy: false, msg: '', err: '' };
  S.pay = { st: null, cycle: null, cycleId: null, region: '*', iterId: null, compare: true, loading: false, err: '', msg: '', newCycle: false };
  S.state = await GET('/state');
  render();
}

/* ---------------- render root ---------------- */
// Right-hand pane width: drag the grip on its left edge; remembered per browser.
const SIDE_W_DEFAULT = 400;
function sideWidthMax() { return Math.max(320, Math.round(window.innerWidth * 0.7)); }
function sideWidth() {
  let w = SIDE_W_DEFAULT;
  try { w = Number(localStorage.getItem('bt-side-w')) || SIDE_W_DEFAULT; } catch { /* storage blocked */ }
  return Math.min(Math.max(w, 300), sideWidthMax());
}
document.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest && e.target.closest('.editor .sidegrip');
  if (!grip || e.button !== 0) return;
  const ed = grip.closest('.editor');
  const side = ed.querySelector('.side');
  const startX = e.clientX, startW = side.getBoundingClientRect().width;
  let w = startW;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  ed.classList.add('resizing');
  const move = (ev) => {
    w = Math.min(Math.max(startW + (startX - ev.clientX), 300), sideWidthMax());
    ed.style.setProperty('--side-w', `${Math.round(w)}px`);
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    ed.classList.remove('resizing');
    try { localStorage.setItem('bt-side-w', String(Math.round(w))); } catch { /* storage blocked */ }
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});
document.addEventListener('dblclick', (e) => {
  const grip = e.target.closest && e.target.closest('.editor .sidegrip');
  if (!grip) return;
  try { localStorage.removeItem('bt-side-w'); } catch { /* storage blocked */ }
  grip.closest('.editor').style.setProperty('--side-w', `${SIDE_W_DEFAULT}px`);
});

function render() {
  const gw = document.querySelector('.gridwrap');
  if (gw) S.gridScroll = { top: gw.scrollTop, left: gw.scrollLeft };
  const app = document.getElementById('app');
  // the WHOLE app wears the Monarch skin (Troy 2026-10-30) — body.monarch is
  // set in index.html; the old chrome only survives underneath as fallbacks
  if (!S.auth || !S.auth.authed) { app.innerHTML = loginView(); wireLogin(); return; }
  app.innerHTML = `
    <div class="topbar">
      <span class="brand">${esc(S.auth.appTitle || 'Budget Tool')}</span>
      <span class="region-toggle" role="group" aria-label="Region" title="Each region's budgets, data, payroll and settings are kept fully separate">
        ${Object.entries(REGIONS_UI).map(([k, label]) => `<button data-region="${k}" class="${S.region === k ? 'on' : ''}" aria-pressed="${S.region === k}">${esc(label)}</button>`).join('')}
      </span>
      <nav>
        <button data-v="dash" class="${S.view === 'dash' ? 'on' : ''}">Budgets</button>
        ${S.view === 'editor' && S.bv ? `<span class="crumb">›</span><button data-v="editor" class="on">${esc(S.bv.budget.property_code)} ${S.bv.budget.year}</button>` : ''}
        <button data-v="summary" class="${S.view === 'summary' ? 'on' : ''}" title="Every budget for the year, by region, in the budget-comps layout">Summary</button>
        <button data-v="uploads" class="${S.view === 'uploads' ? 'on' : ''}">Data</button>
        <button data-v="payroll" class="${S.view === 'payroll' ? 'on' : ''}">Payroll</button>
        <button data-v="settings" class="${S.view === 'settings' ? 'on' : ''}">Settings</button>
      </nav>
      <span class="spacer"></span>
      <button class="theme" id="theme-toggle" title="Toggle dark mode">${S.theme === 'dark' ? '☀' : '🌙'}</button>
      <span class="who">${esc(S.auth.username)}${S.auth.isAdmin ? ' · admin' : ''}<button id="logout">Sign out</button></span>
    </div>
    <div class="wrap${S.view === 'editor' || S.view === 'payroll' || S.view === 'summary' ? ' wide' : ''}" id="main"></div>`;
  document.querySelectorAll('.topbar nav button').forEach((b) =>
    b.addEventListener('click', () => { S.view = b.dataset.v; if (S.view === 'summary') S.sum = null;   /* always reload: budgets may have changed */ render(); }));
  document.getElementById('logout').addEventListener('click', async () => { await POST('/logout'); location.reload(); });
  document.querySelectorAll('.region-toggle button').forEach((b) => b.addEventListener('click', () => switchRegion(b.dataset.region)));
  document.getElementById('theme-toggle').addEventListener('click', () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; applyTheme(); render(); });
  const main = document.getElementById('main');
  if (S.view === 'dash') renderDash(main);
  else if (S.view === 'uploads') renderUploads(main);
  else if (S.view === 'summary') renderSummary(main);
  else if (S.view === 'editor') { renderEditor(main); editorViewToggle(main); }
  else if (S.view === 'payroll') renderPayroll(main);
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
function guideDashCell(gd) {
  if (!gd) return '<td class="muted">—</td>';
  const p = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
  const cls = gd.bad ? 'gbad' : gd.flags ? 'gchk' : 'gok';
  return `<td class="gdash ${cls}" title="${esc((gd.miss || []).join(' · ') || 'on target')}"><b>NOI ${p(gd.growth.noi)}</b><div class="muted" style="font-size:10.5px">inc ${p(gd.growth.income)} · exp ${p(gd.growth.expense)}${gd.bad || gd.flags ? ` · ${gd.bad + gd.flags} to look at` : ''}</div></td>`;
}
function renderDash(el) {
  const st = S.state;
  const props = new Map(st.properties.map((p) => [p.code, p]));
  const hasAcq = st.budgets.some((b) => b.budget_type !== 'annual');
  const hasGuide = st.budgets.some((b) => b.dash && b.dash.guide);
  const pl = propertyListHtml(st);
  el.innerHTML = `
    ${pl.html}
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:10px">
        <h2 style="margin:0">Budgets</h2>
        <div class="row">
          <button class="btn sub" id="dash-dform" title="The formula and seasonal curve every line uses by default, for all budgets on the defaults. One pick sets a whole section.">ƒ Default formulas</button>
          <button class="btn sub" id="dash-export" title="Exports for the ticked budgets (all if none ticked)">⬇ Export ▾</button>
          <button class="btn" id="newb">+ New budget</button>
        </div>
      </div>
      ${st.budgets.length ? `<table class="list"><tr><th><input type="checkbox" id="sel-all" title="Select all budgets"></th><th>Property</th><th>Budget</th><th>Income</th><th>OpEx</th><th>NOI</th><th title="NOI vs the budget's reference (T12 actuals / CY budget for annual, UW for acquisitions)">Δ NOI</th><th title="EGI vs the reference">Δ EGI</th>${hasGuide ? '<th title="2027 guidance: growth vs the October T12 — income / expenses / NOI. Red = off (NOI down, or below the current budget); amber = outside a range.">Guidance</th>' : ''}${hasAcq ? '<th>CoC</th>' : ''}<th>Status</th><th>Updated</th><th></th></tr>
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
          ${hasGuide ? guideDashCell(d.guide) : ''}
          ${hasAcq ? `<td>${d.coc != null ? (d.coc * 100).toFixed(1) + '%' : '—'}${d.capital ? `<div class="muted" style="font-size:10.5px">on ${money(d.capital)}</div>` : ''}</td>` : ''}
          <td>${esc(b.status)}</td>
          <td class="muted">${new Date(b.updated_at).toLocaleDateString()}</td>
          <td>${S.auth.isAdmin ? `<button class="rb" data-del="${b.id}" title="Delete this budget">🗑</button>` : ''}</td>
        </tr>`; }).join('')}</table>` : `<p class="muted">No budgets yet. Click <b>+ New budget</b> — for an annual budget you only need the property's Yardi budget template (budgetYSR…xlsm); it carries the trailing-12 actuals and the current-year budget. Add the rent roll for the GPR anchor and per-lease burnoff.</p>`}
    </div>
    <dialog id="newdlg"></dialog>
    <dialog class="assump" id="pm-dlg"></dialog>
    <dialog class="assump" id="actcsv-dlg"></dialog>`;

  wirePropertyList(el, pl);
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
  document.getElementById('dash-dform').addEventListener('click', () => openDefaultFormulas());
  document.getElementById('dash-export').addEventListener('click', (e) => {
    e.stopPropagation();
    const n = selectedIds().length;
    popMenu(e.currentTarget, `
      <div class="rm-head">${n ? `${n} ticked budget${n === 1 ? '' : 's'}` : 'All budgets'}</div>
      <button data-x="pf" title="One workbook: each site's Budget / Summary / Raw Data tabs plus a live Portfolio rollup tab — tick the 4 Bismarck sites for a Bismarck WB, the 2 Jamestown for a JT WB">⬇ Portfolio workbook</button>
      <button data-x="zip" title="ZIP of every export, sorted by report type: Yardi Uploads per year + Budget Drafts — each budget saved as an iteration">⬇ All exports (zip)</button>
      <button data-x="recalc" title="Re-run every formula on the ticked budgets (all of them when none is ticked), so a changed default or formula reaches each one. Shows NOI before and after per budget first; hand-typed lines stay; each budget gets a save point.">↻ Recalculate…</button>
      <button data-x="act" title="Partial-month rule off the budget as it sits in Yardi: upload the month-end Property Comparison (Cash) + each property's budget CSV — every CSV comes back with the closed month set 1:1 to what posted">✓ Actualize from Yardi CSVs…</button>`, (menu) => {
      menu.querySelector('[data-x="recalc"]').addEventListener('click', () => { const ids = selectedIds(); openRecalcMany(ids.length ? ids.map(Number) : st.budgets.map((x) => x.id)); });
      menu.querySelector('[data-x="pf"]').addEventListener('click', () => { const ids = selectedIds(); window.open(rUrl(`/api/export/portfolio.xlsx${ids.length ? `?ids=${ids.join(',')}` : ''}`), '_blank'); });
      menu.querySelector('[data-x="zip"]').addEventListener('click', () => { const ids = selectedIds(); const all = ids.length ? ids : st.budgets.map((b) => b.id); if (all.length) window.open(rUrl(`/api/export/bundle.zip?ids=${all.join(',')}`), '_blank'); });
      menu.querySelector('[data-x="act"]').addEventListener('click', () => openActualizeCsv());
    });
  });
}

/* ---- Properties list (Troy 2026-11-03): every property, the budget for the
   chosen year or "Not started", and — click in — which reports are on file and
   which are missing. With a current Yardi template on file that ONE file is the requirement (it
   carries the trailing-12 and the CY budget — Troy 2026-11-11: "Why do I still need to upload the T12
   statement and T12 Budget when the budget template has them?"); without one, the two statements
   are required. A rent roll and the payroll roster are recommended. ---- */
function propertyReports(st, code, budget, year) {
  // a report counts for `year` only when it is current: a trailing-12 that ends in the
  // year before the budget (or a template built for that budget year) — last year's
  // files are "stale", not "on file"
  const yearOf = (period) => { const m = String(period || '').match(/(\d{4})(?!.*\d{4})/); return m ? Number(m[1]) : null; };
  const current = (period) => { const y = yearOf(period); return y == null ? true : y >= (year || new Date().getFullYear() + 1) - 1; };
  const tpls = (st.templates || []).filter((x) => x.property_code === code);
  const stmts = (st.stmtSnapshots || []).filter((x) => x.property_code === code);
  const rents = (st.rentSnapshots || []).filter((x) => x.property_code === code);
  const fmtd = (d) => (d ? new Date(d).toLocaleDateString() : '');
  const newest = (arr) => arr.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const tplCur = tpls.filter((x) => !year || Number(x.budget_year) === year);
  const tpl = newest(tplCur) || newest(tpls), act = newest(stmts.filter((x) => x.kind === 'actual' && current(x.period))) || newest(stmts.filter((x) => x.kind === 'actual')), bud = newest(stmts.filter((x) => x.kind === 'budget' && current(x.period))) || newest(stmts.filter((x) => x.kind === 'budget')), rent = newest(rents);
  const tplOk = !!tpl && (!year || Number(tpl.budget_year) === year);
  const actOk = !!act && current(act.period), budOk = !!bud && current(bud.period);
  const stale = (x, what) => `stale — have ${x.period || what}, need the ${what} for ${year}`;
  const inp = (budget && budget.inputs) || {};
  // Payroll wages: an annual budget follows the Payroll tab by default — on file when a raise
  // cycle effective in the budget year books staff to this property (st.rosterYears), unless
  // the budget opted out (wageSource 'manual'). Else an applied roster / linked payroll model.
  const cov = (st.rosterYears || {})[String((budget && budget.year) || year)];
  const covHere = cov && cov.codes && cov.codes[code] ? cov.codes[code] : null;
  const followsTab = !!covHere && (!budget || budget.budget_type === 'annual') && inp.wageSource !== 'manual';
  const payOk = followsTab || (!!budget && (inp.wagesFromRoster === true || !!budget.payroll_model_id));
  function payItem() {
    return { key: 'payroll', label: 'Payroll wages', need: 'recommended', ok: payOk,
      sub: followsTab ? `${budget ? 'follows' : 'will follow'} the Payroll tab · ${cov.label} · ${covHere.draft ? 'draft raises' : 'raises finalized'}`
        : payOk ? (inp.wagesFromRoster ? 'Pay-rates roster applied' : 'payroll model linked')
        : inp.wageSource === 'manual' ? 'set to its own history in Assumptions — trailing-12 wages × the raise %'
        : `no raise cycle effective in ${(budget && budget.year) || year} books staff here — Payroll tab → start the cycle (until then: trailing-12 wages × the raise %)` };
  }
  // the template carries both statements: with a current template on file it is ONE item, not three
  if (tplOk && tpl.actual_period) return [
    { key: 'template', label: 'Yardi budget template', need: 'required', ok: true,
      sub: `budget ${tpl.budget_year} · T12 ${tpl.actual_period}${tpl.budget_period ? ` · budget ${tpl.budget_period}` : ''} · ${fmtd(tpl.created_at)}` },
    { key: 'rent', label: 'Rent roll', need: 'recommended', ok: !!rent,
      sub: rent ? `${rent.as_of ? fmtd(rent.as_of) : ''} · ${rent.units || '?'} units` : 'unit-level — per-lease loss to lease and market rents' },
    payItem(),
  ];
  return [
    { key: 'actual', label: 'Trailing-12 actual statement', need: 'required', ok: actOk || (tplOk && !!tpl.actual_period),
      sub: actOk ? `${act.period || ''} · ${fmtd(act.created_at)}` : tplOk && tpl.actual_period ? `from the Yardi template · ${tpl.actual_period}` : act ? stale(act, '12 months') : 'Property Comparison (Cash), 12 months — or the Yardi template' },
    { key: 'budget', label: 'Current-year budget statement', need: 'required', ok: budOk || (tplOk && !!tpl.budget_period),
      sub: budOk ? `${bud.period || ''} · ${fmtd(bud.created_at)}` : tplOk && tpl.budget_period ? `from the Yardi template · ${tpl.budget_period}` : bud ? stale(bud, 'current-year budget') : 'the reference column every tie compares to' },
    { key: 'template', label: 'Yardi budget template', need: 'recommended', ok: tplOk,
      sub: tplOk ? `budget ${tpl.budget_year} · ${fmtd(tpl.created_at)}` : tpl ? `have the ${tpl.budget_year} template — the ${year} one carries this year's T12, budget, expirations, debt and suggestions` : 'budgetYSR…xlsm — carries the T12 and current-year budget (then neither statement is needed)' },
    { key: 'rent', label: 'Rent roll', need: 'recommended', ok: !!rent,
      sub: rent ? `${rent.as_of ? fmtd(rent.as_of) : ''} · ${rent.units || '?'} units` : 'unit-level — per-lease loss to lease and market rents' },
    payItem(),
  ];
}
function propertyListHtml(st) {
  // every subject property, plus any comp that already owns a budget. The role is an admin
  // setting (Settings → Properties); the Minot sites are subjects since migration 010.
  const budgeted = new Set(st.budgets.map((b) => b.property_code));
  const subjects = st.properties.filter((p) => p.role === 'subject' || budgeted.has(p.code)).sort((a, b) => (a.market || '').localeCompare(b.market || '') || a.code.localeCompare(b.code));
  if (!subjects.length) return { html: '', rows: [] };
  const years = [...new Set(st.budgets.map((b) => b.year))].sort((a, b) => b - a);
  const nextYear = new Date().getFullYear() + 1;
  if (!years.includes(nextYear)) years.unshift(nextYear);
  const year = S.dashYear && years.includes(S.dashYear) ? S.dashYear : years[0];
  S.dashYear = year;
  const rows = subjects.map((p) => {
    const mine = st.budgets.filter((b) => b.property_code === p.code);
    const b = mine.filter((x) => x.year === year).sort((x, y) => new Date(y.updated_at) - new Date(x.updated_at))[0] || null;
    const others = [...new Set(mine.filter((x) => x.year !== year).map((x) => x.year))].sort((a, c) => c - a);
    const reports = propertyReports(st, p.code, b, year);
    const missingReq = reports.filter((r) => r.need === 'required' && !r.ok);
    const missingRec = reports.filter((r) => r.need === 'recommended' && !r.ok);
    return { p, b, others, reports, missingReq, missingRec };
  });
  const notStarted = rows.filter((r) => !r.b).length;
  const html = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:10px">
        <h2 style="margin:0">Properties <span class="badge">${rows.length}</span>${notStarted ? ` <span class="pill none" style="margin-left:6px">${notStarted} not started for ${year}</span>` : ''}</h2>
        <div class="row" style="align-items:center; gap:8px"><label class="muted" style="font-size:12px">Budget year</label><select id="dash-year">${years.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
      </div>
      <table class="list plist"><tr><th>Property</th><th>Units</th><th>Region</th><th>${year} budget</th><th>Reports</th><th>Updated</th><th></th></tr>
        ${rows.map(({ p, b, others, missingReq, missingRec }) => {
          const reps = missingReq.length ? `<span class="pill miss">${missingReq.length} required missing</span>` : missingRec.length ? `<span class="pill rec">${missingRec.length} recommended missing</span>` : '<span class="pill ok">all on file</span>';
          const stat = b ? `<span class="pill ok">${esc(b.status || 'draft')}</span>${b.budget_type === 'annual' ? '' : ' <span class="muted">acquisition</span>'}`
            : `<span class="pill none">Not started</span>${others.length ? ` <span class="muted" style="font-size:11px">has ${others.join(', ')}</span>` : ''}`;
          return `<tr class="pclick" data-p="${esc(p.code)}" title="click for the reports on file">
            <td><b>${esc(p.code)}</b> · ${esc(p.name)}</td><td>${p.units || ''}</td><td class="muted">${esc(p.market || '')}</td>
            <td class="st">${stat}</td><td class="st">${reps}</td><td class="muted">${b ? new Date(b.updated_at).toLocaleDateString() : ''}</td>
            <td class="go">${b ? `<button class="btn sm" data-rowopen="${b.id}" title="Open the ${year} budget">Open</button>` : `<button class="btn sub sm" data-rowstart="${esc(p.code)}" title="Start the ${year} budget for ${esc(p.code)}">+ Start</button>`}</td></tr>
            <tr class="pdetail" data-pd="${esc(p.code)}" hidden><td colspan="7"></td></tr>`;
        }).join('')}
      </table>
    </div>`;
  return { html, rows, year };
}
function wirePropertyList(el, pl) {
  const sel = el.querySelector('#dash-year');
  if (sel) sel.addEventListener('change', () => { S.dashYear = Number(sel.value); render(); });
  // straight into the budget from the row (Troy 2026-11-09) — no need to unfold the property first
  el.querySelectorAll('[data-rowopen]').forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); await openBudget(Number(b.dataset.rowopen)); }));
  el.querySelectorAll('[data-rowstart]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); S.nb = { prop: b.dataset.rowstart, year: pl.year }; S.newType = 'annual'; newBudgetDialog(); }));
  el.querySelectorAll('tr.pclick').forEach((tr) => tr.addEventListener('click', () => {
    const code = tr.dataset.p;
    const det = el.querySelector(`tr.pdetail[data-pd="${code}"]`);
    const open = !det.hidden;
    el.querySelectorAll('tr.pdetail').forEach((d) => { d.hidden = true; });
    if (open) return;
    const r = pl.rows.find((x) => x.p.code === code);
    const icon = (x) => (x.ok ? '<span class="pill ok">✓ on file</span>' : x.need === 'required' ? '<span class="pill miss">✗ missing</span>' : '<span class="pill rec">◦ recommended</span>');
    det.firstElementChild.innerHTML = `
      <div class="row" style="justify-content:space-between; align-items:center">
        <div><b>${esc(r.p.name)}</b> — ${r.b ? `${pl.year} budget <span class="pill ok">${esc(r.b.status || 'draft')}</span>` : `<span class="pill none">Not started for ${pl.year}</span>`}
          ${r.missingReq.length ? `<span class="muted" style="margin-left:8px">needs ${r.missingReq.map((x) => x.label.toLowerCase()).join(' and ')} before a budget can be built</span>` : ''}</div>
        <div class="row" style="gap:6px">
          ${r.b ? `<button class="btn" data-open="${r.b.id}">Open budget</button>` : `<button class="btn" data-start="${esc(code)}" ${r.missingReq.length ? 'title="upload the missing reports first — the dialog can take them inline"' : ''}>+ Start ${pl.year} budget</button>`}
          <button class="btn sub" data-data="${esc(code)}">Upload data</button>
        </div>
      </div>
      <div class="reports">${r.reports.map((x) => `<div class="rep">${icon(x)}<span><b>${esc(x.label)}</b><div class="sub">${esc(x.sub)}</div></span></div>`).join('')}</div>`;
    det.hidden = false;
    det.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); await openBudget(Number(b.dataset.open)); }));
    det.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); S.nb = { prop: b.dataset.start, year: pl.year }; S.newType = 'annual'; newBudgetDialog(); }));
    det.querySelectorAll('[data-data]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); S.view = 'uploads'; render(); }));
  }));
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
  const KIND_LABEL = { yardi_template: 'Yardi budget template (budgetYSR…xlsm)', rent_roll: 'rent roll', payroll: 'payroll model', statement: '12 Month Statement / Budget', payroll_template: 'payroll template sheet' };
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
      <div class="fld" style="flex:1; min-width:260px"><label title="How each history-based line is built: its shape, increase factor and rounding, plus the formula settings. Saved from a finished budget with More → Save formulas as…. Nothing is assumed — pick one.">Formula set <span class="muted">— which saved formulas this budget starts on</span></label>
        <select id="nb-fset">${formulaSetOptions(nb.fset)}</select></div>
    </div>
    <div class="row" style="margin-top:8px">${pick('nb-tpl', 'Yardi budget template', 'the one file you need — budgetYSR…xlsm carries the trailing-12 actuals AND the current-year budget, plus debt, expirations and corporate suggestions', 'yardi_template')}</div>
    <p class="muted" id="nb-tplnote" style="font-size:11.5px; margin:4px 0 8px"></p>
    <details id="nb-stmts" ${nb.py || nb.cyb ? 'open' : ''} style="margin:0 0 8px"><summary class="muted" style="font-size:12px; cursor:pointer">No template? Use separate Yardi statements instead</summary>
      <div class="row" style="margin-top:6px">
        ${pick('nb-py', 'Trailing-12 actuals by GL', 'only without a template — Yardi 12 Month Statement export, Nov–Oct', 'statement')}
        ${pick('nb-cyb', 'Current-year budget', 'only without a template — 12 Month Budget export', 'statement')}
      </div>
      <p class="muted" style="font-size:11px; margin:4px 0 0">A statement picked here replaces the template's own for that column. Leave both at — none — when the template is picked.</p>
    </details>
    <div class="row">
      ${pick('nb-rent', 'Rent roll / UAD', 'GPR anchor, per-lease LTL, lease expirations (turn costs follow them +1 mo)', 'rent_roll')}
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
      : 'Pick or upload the Yardi budget template (⬆) — it carries the trailing-12 and the current-year budget.';
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
      // separate statements are a fallback for a property with no template: never pre-picked when one
      // exists (a picked statement replaces the template's own T12 / budget — Troy 2026-11-11)
      const noTpl = !tpls.length;
      setSel('nb-py', own(pys).map((x) => `<option value="${x.id}">${esc(x.period || '')} · ${esc(x.label)}</option>`).join(''), nb.py, noTpl ? own(pys)[0]?.id : null);
      setSel('nb-cyb', own(cybs).map((x) => `<option value="${x.id}">${esc(x.period || '')} · ${esc(x.label)}</option>`).join(''), nb.cyb, noTpl ? own(cybs)[0]?.id : null);
      if (noTpl && $('nb-stmts')) $('nb-stmts').open = true;
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
  if ($('nb-fset')) $('nb-fset').addEventListener('change', (e) => { nb.fset = e.target.value; });   // survives the re-render after an inline upload
  $('nb-go').addEventListener('click', async () => {
    try {
      const v = (id) => { const e = $(id); return e ? (Number(e.value) || null) : null; };
      if (annual && !v('nb-tpl') && !v('nb-py')) throw new Error('Pick or upload the Yardi budget template first — it carries the trailing-12 and the current-year budget.');
      const fset = annual && $('nb-fset') ? $('nb-fset').value : null;
      if (annual && !fset) throw new Error('Pick a formula set — a saved one, or the template defaults. Nothing is assumed for you.');
      const bv = await POST('/budgets', {
        propertyCode: $('nb-prop').value,
        year: Number($('nb-year').value),
        budgetType: annual ? 'annual' : 'new_acq',
        uwSnapshotId: v('nb-uw'), compSetId: v('nb-comp'), rentSnapshotId: v('nb-rent'),
        t12SnapshotId: v('nb-t12'), payrollModelId: v('nb-pay'),
        templateId: v('nb-tpl'), pyStmtId: v('nb-py'), cyBudgetStmtId: v('nb-cyb'),
        formulaSet: fset,
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
  ['rent_roll', 'Rent roll (Yardi summary, unit detail, lease charges) or Unit Availability Details'],
  ['statement', 'Monarch 12 Month Statement / 12 Month Budget'],
  ['payroll_template', 'Payroll Budget Workbook — a property payroll sheet (tie-out reference)'],
  ['payroll', 'ND payroll model (wage aggregates)'],
  ['uw_book', 'UW book model (.xlsx)'],
  ['comparison', 'Property comparison (comp set)'],
  ['seller_t12', 'Seller T12 statement (monthly actuals)'],
];
function renderUploads(el) {
  const u = S.upload;
  const files = u.files || [];
  const multi = u.kind === 'yardi_template' || u.kind === 'statement' || u.kind === 'payroll_template';
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
      if (u.kind === 'yardi_template' || u.kind === 'statement' || u.kind === 'payroll_template') {
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
  if (parsed.kind === 'yardi_template' || parsed.kind === 'statement' || parsed.kind === 'payroll_template') return renderAnnualUploadPreview(el, parsed);
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
      <div>
        <h2 style="margin:0">${esc(prop.name)} <span class="muted">(${esc(b.property_code)}) — ${bv.annual ? `${b.year} annual budget` : `Year 1 budget · ${windowLabel}`}</span></h2>
        <div class="meta">${bv.annual ? (() => { const t12 = (bv.refs || []).find((r) => r.key === 'actual'); return t12 ? ` <span class="badge" title="The property's own trailing-12 actuals drive every PY-based line; last actual month = ${MONTHS[(bv.lastMonth || 10) - 1]}">T12 ${esc(t12.period)}</span>${(bv.t12Missing || []).length ? ` <span class="badge" style="color:var(--bad)" title="No statement on file covers ${esc(bv.t12Missing.join(', '))} — those months are ZERO in the trailing-12, so every same-month line is zero there. Upload last year's 12 Month Statement (Data page or ⬆ in New budget) or export the statement for ${esc(t12.period)} directly.">⚠ T12 missing ${esc(bv.t12Missing.join(', '))}</span>` : ''}${(bv.t12Dead || []).length ? ` <span class="badge" style="color:var(--warn)" title="${esc(bv.t12Dead.join(', '))} had no rent — the property was not operating (pre-acquisition). Those months are filled with each line's average over the ${bv.t12Live} live months, so the T12 column, the same-month rules and the chart all read as ${bv.t12Live} months annualized.">${bv.t12Live} mo annualized · ${esc(bv.t12Dead.join(', '))} pre-acquisition</span>` : ''}${(bv.t12Startup || []).length ? ` <span class="badge" style="color:var(--warn)" title="New acquisition: the first month${bv.t12Startup.length > 1 ? 's' : ''} of operations (${esc(bv.t12Startup.join(', '))}) ${bv.t12Startup.length > 1 ? 'are' : 'is'} LEFT OUT of the history — a partial month of rent, closing entries and catch-up bills. Filled with each line's average over the remaining months, like the pre-acquisition months. Change how many are left out under Assumptions.">start-up ${esc(bv.t12Startup.join(', '))} left out</span>` : ''}${(bv.t12Early || []).length ? ` <span class="badge" style="color:var(--bad)" title="${esc(bv.t12Early.join(' and '))} ${bv.t12Early.length > 1 ? 'are months' : 'is month'} 2-3 of operations and still IN the history${bv.t12Live <= 3 ? ` — and the whole history is only ${bv.t12Live} month${bv.t12Live === 1 ? '' : 's'}, annualized` : ''}. Early months often carry start-up noise (missing bills, one-time costs, light staffing). Check the lines against them before trusting the budget; leave them out too under Assumptions if they look off.">⚠ review ${esc(bv.t12Early.join(', '))} (month 2-3 of operations)</span>` : ''}` : ' <span class="badge" style="color:var(--warn)" title="No trailing-12 statement linked — upload the Yardi budget template or a 12 Month Statement">⚠ no T12 statement</span>'; })() + (bv.template ? ` <span class="badge" title="Yardi budget template on file: debt schedule, fee matrix, Conservice utility forecasts, corporate suggestions, lease expirations">template ${esc(String(bv.template.budgetYear || ''))}</span>` : '') : ''}${acts.length ? ` <span class="badge" title="Closed months budgeted 1:1 to posted actuals">✓ actuals: ${acts.map((a) => esc(a.period)).join(', ')}</span>` : ''}</div>
      </div>
      <div class="row">
        <button class="btn sub" id="undo-btn" ${S.undo.budgetId === b.id && S.undo.stack.length ? '' : 'disabled'}>↶ Undo${S.undo.budgetId === b.id && S.undo.stack.length ? ` (${S.undo.stack.length})` : ''}</button>
        <button class="btn sub" id="recalc" title="Re-run every formula line on the current inputs (overrides kept)">↻ Recalc</button>
        <button class="btn sub" id="more-btn">⋯ More ▾</button>
        <button class="btn sub" id="ex-btn">⬇ Export ▾</button>
        <button class="btn" id="assump-open">⚙ Assumptions</button>
        <input type="file" id="imp-file" accept=".xlsx" style="display:none">
      </div>
    </div>
    ${staleBannerHtml(bv)}
    <div class="kpis">
      ${kpiCard('Total income', k.income, prop.units)}
      ${kpiCard('Total expense', k.expense, prop.units)}
      ${kpiCard('NOI', k.noi, prop.units)}
      ${kpiCard('Interest', k.interest, prop.units)}
      ${kpiCard(k.sp ? 'Cash flow before SP' : 'Cash flow · no SP budgeted', k.cashFlow, prop.units)}
      <div class="kpi" title="(NOI − interest − principal) ÷ capital. Special projects are NOT deducted${k.sp ? '' : ' and none are budgeted yet'}${k.principal ? '' : '; no principal is budgeted'}."><div class="lbl">Cash on cash${k.sp ? ' before SP' : ''}</div><div class="val">${k.coc != null ? pctf(k.coc) : '—'}</div><div class="sub">${inp.capital ? 'on ' + money(inp.capital) : 'set capital'}</div></div>
    </div>
    <div class="editor${localStorage.getItem('bt-side') === '0' ? ' noside' : ''}" style="--side-w:${sideWidth()}px">
      <div>
        <div class="legend">
          ${(() => {
            const used = new Set(bv.lines.filter((l) => l.months && l.months.some((v) => v)).map((l) => drvMeta(l).cls));
            if (acts.length) used.add('drv-act');
            const items = [['drv-rr', 'Rent roll / income'], ['drv-uw', 'UW tie'], ['drv-comp', 'Minot comps'], ['drv-pay', 'Payroll tab / model'], ['drv-fee', '% of income'], ['drv-int', bv.annual ? 'Debt schedule / zero' : 'Interest'],
              ['drv-base', "This property's own history"], ['drv-corp', 'Corporate rate / suggestion'], ['drv-t12', 'Seller stmt / recovery'], ['drv-man', 'Manual override'], ['drv-act', 'Posted actuals (locked month)']];
            return items.filter(([c]) => used.has(c)).map(([c, lb]) => `<span><span class="dot ${c}"></span>${lb}</span>`).join('');
          })()}
          <span class="muted">· click a row's chip to change its formula</span>
          <button class="chip" id="tag-key" title="What every chip on the grid means">? chip key</button>
          ${defaultsChipHtml(bv)}
          ${droppedChipHtml(bv)}
          ${bv.hist && (bv.hist.t12 || bv.hist.budget) ? `<button class="chip hist-all" id="hist-all" title="Unfold the prior trailing-12 and current-year budget by month under every GL — reference rows, not part of the budget">${S.histAll ? '▾ hide history' : '▸ history under every GL'}</button>` : ''}
    ${bv.hist && bv.hist.payroll ? (() => { const tpl = Object.values(bv.hist.payroll.cal).reduce((a, m) => a + m.reduce((x, y) => x + y, 0), 0); const bud = (bv.categoryTotals && bv.categoryTotals['10']) ?? null; const d = bud == null ? null : bud - tpl; return `<button class="chip paytie-chip" id="paytie-open" title="${esc(bv.hist.payroll.label)} — Seth's payroll template for this property: budget payroll ${money(bud)} vs template ${money(tpl)}. Click to unfold the template under every payroll GL (reference rows; the budget is not changed).">payroll template Δ ${d == null ? '' : `${d >= 0 ? '+' : ''}${money(d)}`}${tpl && d != null ? ` (${((d / Math.abs(tpl)) * 100).toFixed(1)}%)` : ''}</button>`; })() : ''}
          ${(() => {
            const ov = bv.lines.filter((l) => l.override);
            if (!ov.length) return '';
            const fixed = ov.filter((l) => !l.driver || !l.driver.method || l.driver.method === 'manual' || l.driver.method === 'setTotal').length;
            return `<button class="rb" id="ovr-btn" title="Audit this budget's overridden lines — release old MROUND-locks back to live formulas">🔓 overrides: ${ov.length - fixed} formula · ${fixed} fixed</button>`;
          })()}
        </div>
        <div class="gridwrap">${gridHtml(bv, totals)}</div>
      </div>
      <div class="sidegrip" title="Drag to widen or narrow this pane · double-click to reset"></div>
      <div class="side">
        <div class="card">
          <h2>Monthly trend</h2>
          ${trendSvg(bv)}
        </div>
        <div class="card tie">
          <h2>${bv.annual ? `Compare to <select data-refsrc style="font-size:12px; margin-left:4px">
              ${(() => { const u = (bv.refs || []).find((r) => r.key === 'uw'); return u ? `<option value="uw" ${bv.refKey === 'uw' ? 'selected' : ''} title="${esc(u.period)}">${esc(u.label)} (Year-1 plan + UW trend)</option>` : ''; })()}
              <option value="actual" ${bv.refKey === 'actual' || bv.refKey === 'target' ? 'selected' : ''}>Trailing-12 actuals</option>
              <option value="budget" ${bv.refKey === 'budget' ? 'selected' : ''} ${(bv.refs || []).some((r) => r.key === 'budget') ? '' : 'disabled'}>${esc((((bv.refs || []).find((r) => r.key === 'budget') || {}).label || 'Current-year budget').replace(/^budget /i, 'Budget '))}</option>
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
  const exportCsv = (yr) => { if (okToExport(S.bv)) window.open(rUrl(`/api/budgets/${b.id}/export.csv?calYear=${yr}&cutoff=${S.exCutoff}`), '_blank'); };
  const exportAll = async () => {
    if (!okToExport(S.bv)) return;
    const urls = [
      `/api/budgets/${b.id}/export.csv?calYear=${b.year}&cutoff=${S.exCutoff}`,
      ...(start > 1 ? [`/api/budgets/${b.id}/export.csv?calYear=${b.year + 1}&cutoff=${S.exCutoff}`] : []),
      `/api/budgets/${b.id}/export.xlsx`,
    ];
    for (const u2 of urls) {
      const a = document.createElement('a');
      a.href = rUrl(u2); a.download = '';
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
      menu.querySelector('[data-x="xlsx"]').addEventListener('click', () => window.open(rUrl(`/api/budgets/${b.id}/export.xlsx`), '_blank'));
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
      ${bv.annual ? `<button data-x="dform" title="The formula and seasonal curve every line uses by default, for ALL budgets on the defaults (this one ${bv.followsDefaults ? 'is' : 'is on a named saved set, so it is not'} among them). One pick sets a whole section.">ƒ Default formulas (all budgets)…</button>` : ''}
      ${bv.annual ? `<button data-x="bshape" title="Pick one formula (turn curve, 1-2-1 weighted, T12 ÷ 12…) and tick the lines it applies to, across any sections">∿ Formula for lines…</button>` : ''}
      ${bv.annual ? `<button data-x="fsave" title="Save every formula on this budget — each line's shape, increase factor and rounding, the zero-outs and the formula settings — under a name, to start other budgets from. Hand-typed cells and dollar amounts are NOT saved.">★ Save formulas as…</button>
      <button data-x="fapply" title="Give this budget a saved formula set. Its own per-line shape / factor choices are replaced by the set's; overrides, dollars, GPR and the vacancy average stay.">☆ Apply a saved formula set…</button>` : ''}
      ${bv.annual ? `<div class="rm-head" style="margin-top:4px">Known costs</div>
      <button data-x="contracts" title="Signed contracts and recurring costs (snow, elevators, SmartRent, annual invoices, a commercial lease…). A line with a contract on it takes the contract amounts instead of its history.">✎ Contracts & known costs…${((bv.budget.inputs || {}).contracts || []).length ? ` (${bv.budget.inputs.contracts.length})` : ''}</button>
      <button data-x="onetime" title="Take one-time items (an unreversed accrual, a one-off repair, a catch-up bill) out of the trailing-12 before the formulas read it">✂ One-time items out of the T12…${((bv.budget.inputs || {}).t12Adjust || []).length ? ` (${bv.budget.inputs.t12Adjust.length})` : ''}</button>
      <button data-x="feesched" title="Flat-fee utility package by bedroom count: reimbursement income from fee × occupied units, with RUBS leases switching at expiration">⌂ Flat-fee package schedule…</button>
      <button data-x="split" title="Recurring journal split to a companion property (TPND → TPNDC 41.11%)">⇄ Journal split to another property…</button>
      <button data-x="qshift" title="Move NOI share between quarters on the lines you pick (aggressive Q4, conservative Q1…); the year's NOI stays the same. Also on the NOI row's % by quarter.">◫ Shift NOI between quarters…${(bv.budget.inputs || {}).qShift ? ' ✓' : ''}</button>` : ''}
      ${bv.annual ? `<button data-x="fpush" title="Give the way this budget builds whole sections (e.g. Contract Services) to the other budgets you pick. Only those sections change there; preview first.">⇉ Copy section formulas to other budgets…</button>` : ''}
      <button data-x="copy" title="Replay another budget's named formulas here, re-evaluated on this property's own data">⧉ Copy formulas from another budget…</button>
      ${ov.length ? `<button data-x="ovr" title="Audit this budget's overridden lines — release old MROUND-locks back to live formulas">🔓 Overrides: ${ov.length - fixed} formula · ${fixed} fixed</button>` : ''}
      <div class="rm-head" style="margin-top:4px">View</div>
      <button data-x="cols">▦ Columns…</button>
      <button data-x="side">${sideOn ? '⏵ Hide side panel' : '⏴ Show side panel'}</button>
      <label><input type="checkbox" data-x="zero" ${S.showZero ? 'checked' : ''}> Show zero rows</label>
      <label title="Show each total row's monthly % of the year"><input type="checkbox" data-x="dist" ${S.showDist ? 'checked' : ''}> % distribution on totals — by month</label>
      <label title="Show each total row's quarterly % of the year"><input type="checkbox" data-x="qdist" ${S.showQDist ? 'checked' : ''}> % distribution on totals — by quarter</label>`, (menu) => {
      menu.querySelector('[data-x="sp"]').addEventListener('click', () => openSavePoints(b));
      menu.querySelector('[data-x="round"]').addEventListener('click', () => openRoundDialog(b));
      { const bs = menu.querySelector('[data-x="bshape"]'); if (bs) bs.addEventListener('click', () => openBulkFormula(b)); }
      { const dfm = menu.querySelector('[data-x="dform"]'); if (dfm) dfm.addEventListener('click', () => openDefaultFormulas()); }
      menu.querySelector('[data-x="copy"]').addEventListener('click', () => openCopyFormulas(b));
      { const fs1 = menu.querySelector('[data-x="fsave"]'); if (fs1) fs1.addEventListener('click', () => saveFormulaSet(b)); }
      { const fs2 = menu.querySelector('[data-x="fapply"]'); if (fs2) fs2.addEventListener('click', () => openApplyFormulaSet(b)); }
      { const fs3 = menu.querySelector('[data-x="fpush"]'); if (fs3) fs3.addEventListener('click', () => openCopyFormulasOut(b)); }
      { const c1 = menu.querySelector('[data-x="contracts"]'); if (c1) c1.addEventListener('click', () => openContracts(b)); }
      { const c2 = menu.querySelector('[data-x="onetime"]'); if (c2) c2.addEventListener('click', () => openOneTime(b)); }
      { const c3 = menu.querySelector('[data-x="feesched"]'); if (c3) c3.addEventListener('click', () => openFeeSchedule(b)); }
      { const c4 = menu.querySelector('[data-x="split"]'); if (c4) c4.addEventListener('click', () => openAllocSplit(b)); }
      { const c5 = menu.querySelector('[data-x="qshift"]'); if (c5) c5.addEventListener('click', () => openQShift(b, (((bv.budget.inputs || {}).qShift) || {}).targets || [null, null, null, null])); }
      const o = menu.querySelector('[data-x="ovr"]'); if (o) o.addEventListener('click', () => openOverridesAudit(b));
      menu.querySelector('[data-x="cols"]').addEventListener('click', () => setTimeout(() => openColsMenu(anchor, labels), 0));
      menu.querySelector('[data-x="side"]').addEventListener('click', () => { localStorage.setItem('bt-side', sideOn ? '0' : '1'); render(); });
      menu.querySelector('[data-x="zero"]').addEventListener('change', (ev) => { S.showZero = ev.target.checked; render(); });
      menu.querySelector('[data-x="dist"]').addEventListener('change', (ev) => { S.showDist = ev.target.checked; localStorage.setItem('bt-dist', S.showDist ? '1' : '0'); render(); });
      menu.querySelector('[data-x="qdist"]').addEventListener('change', (ev) => { S.showQDist = ev.target.checked; localStorage.setItem('bt-qdist', S.showQDist ? '1' : '0'); render(); });
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
  { const sr = document.getElementById('stale-recalc'); if (sr) sr.addEventListener('click', async () => { pushUndo(); S.bv = await POST(`/budgets/${b.id}/recalc`); render(); }); }
  { const tk = document.getElementById('tag-key'); if (tk) tk.addEventListener('click', openTagKey); }
  // quarter shift: the NOI row's share boxes → the lever picker with a preview
  const qsTargets = () => [0, 1, 2, 3].map((q) => { const box = el.querySelector(`input.qs-in[data-qs="${q}"]`); const v = box ? parseFloat(String(box.value).replace(/[%\s]/g, '')) : NaN; return Number.isFinite(v) ? v / 100 : null; });
  { const qo = document.getElementById('qs-open'); if (qo) qo.addEventListener('click', (e) => { e.stopPropagation(); openQShift(b, qsTargets()); }); }
  el.querySelectorAll('input.qs-in').forEach((box) => {
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openQShift(b, qsTargets()); } });
  });
  // section increase %: stays out of the header row's collapse click; Enter / leaving the box applies
  el.querySelectorAll('input.secpct-in').forEach((box) => {
    box.parentElement.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('focus', () => box.select());
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); box.blur(); } });
    box.addEventListener('change', async () => {
      const bl = (S.bv.budget.inputs || {}).baseline || {};
      const secGrowth = { ...(bl.secGrowth || {}) };
      const raw = String(box.value || '').trim();
      const v = parseFloat(raw.replace(/[%,]/g, ''));
      if (raw === '') delete secGrowth[box.dataset.secpct];
      else if (Number.isFinite(v)) secGrowth[box.dataset.secpct] = v / 100;
      else { render(); return; }
      pushUndo();
      S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...bl, secGrowth } } });
      render();
    });
  });
  el.querySelectorAll('input.secfit-in').forEach((box) => {
    box.parentElement.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('focus', () => box.select());
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); box.blur(); } });
    box.addEventListener('change', async () => {
      const raw = String(box.value || '').trim();
      const v = raw === '' ? 0 : parseFloat(raw.replace(/[%,]/g, ''));
      if (!Number.isFinite(v) || v < 0 || v > 100) { alert('Fit to T12 is a % from 0 (the pure curve) to 100 (the T12 months themselves).'); render(); return; }
      const gls = secFitLines(box.dataset.secfit).map((l) => l.gl_code);
      if (!gls.length) return;
      await setFit(b, gls, v);
      toastMsg(`${gls.length} curve line${gls.length === 1 ? '' : 's'} fit ${v}% to T12`);
    });
  });
  el.querySelectorAll('select.secshape-in').forEach((sel) => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => { const v = sel.value; if (v) setSectionShape(b, sel.dataset.secshape, v); });
  });
  { const dop = document.getElementById('dropped-open'); if (dop) dop.addEventListener('click', () => openDroppedDialog(b)); }
  { const dfo = document.getElementById('defaults-open'); if (dfo) dfo.addEventListener('click', () => openDefaultsDialog(b)); }
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
    wireGprCum(dlg, 'in-gprstep');   // live cumulative % under the GPR month grid
    // Enter in a category % box hops to the next one (Troy 2026-11-09) — Apply still applies
    const blp = [...dlg.querySelectorAll('.in-blpct')];
    blp.forEach((x, i) => x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const n = blp[i + 1]; if (n) { n.focus(); n.select(); } } }));
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

  /* Cells DISPLAY whole dollars (Troy 2026-11-09: no decimals); the stored months keep
     their cents. Showing a rounded figure never edits or locks a line — only a typed
     change marks the row dirty, and the untouched months are saved from the line data.
     Month-cell editing is ROW-BUFFERED for fast tabbing: focus selects the
     cell's text (type to replace, no ctrl+a), Tab moves along the row with no
     server round-trip, and the row saves ONCE when focus leaves it (or on
     Enter). Hidden-column safe: the buffer starts from the line data. */
  const commitRow = async () => {
    const p = S.pendingRow;
    if (!p || !p.dirty) { S.pendingRow = null; return; }
    S.pendingRow = null;
    pushUndo();
    // 5003 on its formula, only the FIRST month typed: that is where loss to lease starts, and every
    // later month runs on from it (Troy 2026-11-11) — saved as ltl.month0, the row stays live
    const ln = (S.bv.lines || []).find((l) => l.gl_code === p.gl);
    const changed = ln ? p.months.map((v, i) => Math.abs((Number(v) || 0) - (Number(ln.months[i]) || 0)) >= 0.5).reduce((a, c, i) => (c ? [...a, i] : a), []) : [];
    if (p.gl === '5003' && ln && !ln.override && ln.driver && ln.driver.method === 'ltl' && changed.length === 1 && changed[0] === 0) {
      const lt = (S.bv.budget.inputs || {}).ltl || {};
      S.bv = await PUT(`/budgets/${b.id}`, { inputs: { ltl: { ...lt, month0: -Math.abs(Number(p.months[0]) || 0) } } });
      render();
      return;
    }
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
      liveT12Pct(p.gl, sumM(p.months));
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
    box.addEventListener('input', () => { const v = parseFloat(String(box.value).replace(/[$,]/g, '')); if (Number.isFinite(v)) liveT12Pct(box.dataset.ann, v); });
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
  el.querySelectorAll('button[data-steps]').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); openGprSteps(b, btn); }));
  el.querySelectorAll('button[data-fitgl]').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); openFitChip(b, btn.dataset.fitgl, btn); }));
  el.querySelectorAll('button[data-multi]').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); openMultiParams(b, btn.dataset.multi, btn); }));
  // per-GL history: click the account name to unfold / fold its reference rows
  el.querySelectorAll('td.name[data-hist]').forEach((td) => td.addEventListener('click', (e) => {
    e.stopPropagation();
    const code = td.dataset.hist;
    if (S.histAll) { S.histAll = false; S.histOpenSet = new Set([code]); }
    else if (S.histOpenSet.has(code)) S.histOpenSet.delete(code); else S.histOpenSet.add(code);
    localStorage.setItem('bt-hist', JSON.stringify([...S.histOpenSet]));
    render();
  }));
  const payTieBtn = el.querySelector('#paytie-open');
  if (payTieBtn) payTieBtn.addEventListener('click', (e) => { e.stopPropagation(); const codes = Object.keys((S.bv.hist && S.bv.hist.payroll && S.bv.hist.payroll.cal) || {}); const allOpen = codes.every((c) => S.histOpenSet.has(c)); S.histAll = false; if (allOpen) codes.forEach((c) => S.histOpenSet.delete(c)); else codes.forEach((c) => S.histOpenSet.add(c)); localStorage.setItem('bt-hist', JSON.stringify([...S.histOpenSet])); render(); });
  const histAllBtn = el.querySelector('#hist-all');
  if (histAllBtn) histAllBtn.addEventListener('click', (e) => { e.stopPropagation(); S.histAll = !S.histAll; if (!S.histAll) { S.histOpenSet = new Set(); localStorage.setItem('bt-hist', '[]'); } render(); });
  // inline formula params: change → patch inputs → regenerate
  // Enter on an assumption box applies it and lands on the NEXT row's box (Troy 2026-11-09:
  // walk the column without reaching for the mouse); an unchanged value just moves on
  const focusFxpAfter = (gl) => {
    const boxes = [...document.querySelectorAll('input.fxp[data-fxp]')];
    const i = boxes.findIndex((x) => x.dataset.fxp === gl);
    const nx = i >= 0 ? boxes[i + 1] : null;
    if (nx) { nx.focus(); nx.select(); nx.scrollIntoView({ block: 'nearest' }); }
  };
  el.querySelectorAll('input.fxp').forEach((box) => {
    box.addEventListener('focus', () => box.select());
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (box.value === box.defaultValue) { focusFxpAfter(box.dataset.fxp); return; }
      S.fxpNext = box.dataset.fxp;
      box.blur();   // fires change → PUT → render → focus the next box
    });
    box.addEventListener('change', async () => {
      const gl = box.dataset.fxp;
      const goNext = S.fxpNext === gl; S.fxpNext = null;
      const line = S.bv.lines.find((l) => l.gl_code === gl);
      const p = paramFor(gl, line, S.bv.budget.inputs || {});
      if (!p || p.multi || p.steps) return;
      const v = parseFloat(String(box.value).replace(/[$,%\s]/g, ''));
      if (!Number.isFinite(v)) return;
      pushUndo();
      S.bv = await PUT(`/budgets/${b.id}`, { inputs: p.patch(v) });
      render();
      if (goNext) focusFxpAfter(gl);
    });
  });
  // annual growth targets: typing saves the target; "tie" applies it
  // tie basis (Troy 2026-11-12): T12 targets in growthTargets, T3 targets in growthTargetsT3; the server turns a
  // T3 target into the same dollar subtotal. Only offered when the budget has a T3 annualized.
  const hasT3 = () => (S.bv.refs || []).some((r) => r.key === 'ann3');
  const tieBasis = () => ((S.bv.budget.inputs || {}).tieBasis === 't3' && hasT3() ? 't3' : 't12');
  const tmapKey = () => (tieBasis() === 't3' ? 'growthTargetsT3' : 'growthTargets');
  const tieGrowth = async (key, pct) => { pushUndo(); S.bv = await POST(`/budgets/${b.id}/tie-growth`, { pcode: key, pct, basis: tieBasis() }); render(); };
  el.querySelectorAll('.tie [data-tbasis]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btn.dataset.tbasis === tieBasis()) return;
    try { S.bv = await POST(`/budgets/${b.id}/tie-basis`, { basis: btn.dataset.tbasis }); render(); } catch (err) { alert(err.message); }
  }));
  el.querySelectorAll('.tie [data-gt]').forEach((box) => box.addEventListener('change', async () => {
    const mk = tmapKey();
    const gtNew = { ...((S.bv.budget.inputs || {})[mk] || {}) };
    const v = parseFloat(String(box.value).replace(/[%\s]/g, ''));
    if (Number.isFinite(v)) gtNew[box.dataset.gt] = v / 100; else delete gtNew[box.dataset.gt];
    // saved without recalculating: a target moves nothing until "tie"
    S.bv = await POST(`/budgets/${b.id}/targets`, { [mk]: gtNew }); render();
  }));
  el.querySelectorAll('.tie [data-tie]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = btn.dataset.tie;
    const box = el.querySelector(`.tie [data-gt="${key}"]`);
    const v = box ? parseFloat(String(box.value).replace(/[%\s]/g, '')) : NaN;
    // a typed number wins; an empty box ties to the guidance number the button carries
    const pct = Number.isFinite(v) ? v / 100 : btn.dataset.pct != null && btn.dataset.pct !== '' ? Number(btn.dataset.pct) : null;
    if (key === 'rental' || key === 'income') {
      // the income totals: Troy picks what moves (never chosen for him)
      const last = ((S.bv.budget.inputs || {}).tieLevers || {})[key];
      popMenu(btn, `<div class="rm-head">Move which lever?</div>
        <button data-lv="vacancy" title="Scale the monthly vacancy % (shape kept); rental income moves almost dollar for dollar">Vacancy %${last === 'vacancy' ? ' (last used)' : ''}</button>
        <button data-lv="gpr" title="Solve the market-rent steps. Loss to lease follows GPR, so most of a market-rent change lands there and the target may be out of reach">GPR (market rent)${last === 'gpr' ? ' (last used)' : ''}</button>`, (menu) => {
        menu.querySelectorAll('[data-lv]').forEach((b2) => b2.addEventListener('click', async () => {
          pushUndo();
          try { S.bv = await POST(`/budgets/${b.id}/tie-growth`, { pcode: key, pct, lever: b2.dataset.lv, basis: tieBasis() }); render(); } catch (err) { S.undo.stack.pop(); alert(err.message); }
        }));
      });
      return;
    }
    tieGrowth(key, pct).catch((err) => alert(err.message));
  }));
  { const fb = el.querySelector('#fill-targets'); if (fb) fb.addEventListener('click', async (e) => {
    e.stopPropagation();
    const fill = guidanceFill(S.bv);
    if (!Object.keys(fill).length) return;
    pushUndo();
    S.bv = await POST(`/budgets/${b.id}/targets`, { growthTargets: { ...((S.bv.budget.inputs || {}).growthTargets || {}), ...fill } });
    render();
  }); }
  const tieAll = el.querySelector('#tie-all');
  if (tieAll) tieAll.addEventListener('click', async (e) => {
    e.stopPropagation();
    const basis = tieBasis();
    const gtAll = (S.bv.budget.inputs || {})[tmapKey()] || {};
    // categories, then the income totals (they move GPR), then OpEx, then NOI last
    const late = ['rental', 'income', 'opex', 'noi'];
    const order = [...Object.keys(gtAll).filter((k) => !late.includes(k)), ...late.filter((k) => gtAll[k] != null)];
    pushUndo();
    const lv = (S.bv.budget.inputs || {}).tieLevers || {};
    const skipped = order.filter((k) => (k === 'rental' || k === 'income') && !lv[k]);
    try { for (const k of order) if (gtAll[k] != null && !skipped.includes(k)) S.bv = await POST(`/budgets/${b.id}/tie-growth`, { pcode: k, pct: gtAll[k], basis, ...(lv[k] ? { lever: lv[k] } : {}) }); }
    catch (err) { alert(err.message); }
    if (skipped.length) alert(`Skipped ${skipped.map((k) => (k === 'rental' ? 'Total Rental Income' : 'Total Income')).join(' and ')}: tie it on its own once to pick the lever (vacancy % or GPR).`);
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
  const refT3 = bv.annual ? (bv.refs || []).find((r) => r.key === 'ann3') : null;   // last 3 actual months × 4, right after the T12
  const cols = { fx: !hide.has('fx'), annual: !hide.has('annual'), refpct: !!refA && !hide.has('refpct'), ref1: !!refA && !hide.has('ref1'), ref3: !!refT3 && !hide.has('ref3'), ref2: !!refB && !hide.has('ref2'), punit: !hide.has('punit'), note: !hide.has('note') };
  const nRef = (cols.refpct ? 1 : 0) + (cols.ref1 ? 1 : 0) + (cols.ref3 ? 1 : 0) + (cols.ref2 ? 1 : 0);
  const refBlank = '<td></td>'.repeat(nRef);   // the reference columns on rows that have no reference figure
  const span = 2 + (cols.fx ? 1 : 0) + monthIdx.length + (cols.annual ? 1 : 0) + nRef + (cols.punit ? 1 : 0) + (cols.note ? 1 : 0);
  const actIdx = new Set((bv.actualMonths || []).filter((a) => a.index >= 0).map((a) => a.index));   // months locked to posted actuals (declared BEFORE the header row uses it)
  const refCell = (ref, code, kind) => {
    if (!ref) return '';
    const v = kind === 'total' ? ref.totals[code] : ref.byGl[code];
    return `<td class="ref ${v < 0 ? 'neg' : ''}">${v ? money(v) : ''}</td>`;
  };
  // blended increase over the T12 (Troy 2026-11-09): the line's year total vs its trailing-12,
  // right beside the total — so a hand-typed line shows what % it comes out to. The cell carries
  // its T12 so it can update live while a row is being typed (see the month / total handlers).
  const pctCell = (code, kind, ann, manual) => {
    const v = (kind === 'total' ? refA.totals[code] : refA.byGl[code]) || 0;
    return `<td class="ref t12pct${manual ? ' man' : ''}" ${kind === 'total' ? '' : `data-t12pct="${code}"`} data-t12="${v}" title="${kind === 'total' ? 'Subtotal' : 'Line'} total vs its trailing-12 actual of ${money(v)}${manual ? ' — this line is hand-adjusted' : ''}">${t12PctText(ann, v)}</td>`;
  };
  const refCells = (code, kind, ann, manual) => `${cols.refpct ? pctCell(code, kind, ann, manual) : ''}${cols.ref1 ? refCell(refA, code, kind) : ''}${cols.ref3 ? refCell(refT3, code, kind) : ''}${cols.ref2 ? refCell(refB, code, kind) : ''}`;
  // per-GL history (Troy 2026-11-04): the prior trailing-12 and the current-year budget by
  // month, unfolded under a GL on click — reference rows, never part of the budget
  if (!S.histOpenSet) S.histOpenSet = new Set(JSON.parse(localStorage.getItem('bt-hist') || '[]'));
  const histFor = (code) => {
    const h = bv.hist; if (!h) return [];
    const out = [];
    for (const src of [h.t12, h.budget]) { if (src && src.cal[code] && src.cal[code].some((v) => v)) out.push({ label: src.label, period: src.period, months: src.cal[code] }); }
    // Seth's payroll template: shown on every payroll GL it carries, zeros included (a zero there is a statement too)
    if (h.payroll && h.payroll.cal[code]) out.push({ label: h.payroll.label, period: h.payroll.period, months: h.payroll.cal[code], tpl: true });
    return out;
  };
  // payroll tie-out: the tool's payroll lines vs the template sheet, by month and in total
  const payTie = (() => {
    const p = bv.hist && bv.hist.payroll; if (!p) return null;
    const tplM = Array(12).fill(0);
    for (const m of Object.values(p.cal)) for (let i = 0; i < 12; i++) tplM[i] += m[i] || 0;
    const budM = totals.get('6470') || Array(12).fill(0);
    return { tplM, budM, deltaM: budM.map((v, i) => v - tplM[i]), tpl: sumM(tplM), bud: sumM(budM) };
  })();
  const histOpen = (code) => S.histAll || S.histOpenSet.has(code);
  const rows = [];
  rows.push(`<tr><th class="l">GL</th><th class="l" style="min-width:200px">Account</th>${cols.fx ? '<th>Fx</th>' : ''}${monthIdx.map((i) => `<th${actIdx.has(i) ? ' class="actcol" title="Locked to posted actuals — an edit here corrects the posted figure"' : ''}>${labels[i]}${actIdx.has(i) ? ' ✓' : ''}</th>`).join('')}${cols.annual ? `<th>${bv.annual ? bv.budget.year : 'Year 1'}</th>` : ''}${cols.refpct ? `<th title="Blended increase: the ${bv.budget.year} total vs the trailing-12 actual (${esc(refA.period)})">Δ% T12</th>` : ''}${cols.ref1 ? `<th title="${esc(refA.period)}">T12</th>` : ''}${cols.ref3 ? `<th title="T3 annualized — ${esc(refT3.period)}">T3 ann</th>` : ''}${cols.ref2 ? `<th title="${esc(refB.period)}">${esc(refB.label.replace(/^budget /i, 'Bud ').replace(/ budget$/i, ' bud'))}</th>` : ''}${cols.punit ? '<th>$/Unit</th>' : ''}${cols.note ? '<th class="l">Note</th>' : ''}</tr>`);
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
        <td class="code">${a.code}</td><td class="name" colspan="${span - 1}">${secCollapsed ? '▸' : '▾'} ${esc(a.name)}${secCollapsed ? ' <span class="badge">condensed — totals still shown</span>' : ''}${secPctBoxHtml(bv, a, linesByGl)}</td></tr>`);
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
        ${refCells(a.code, 'total', ann, false)}
        ${cols.punit ? `<td>${money(ann / units)}</td>` : ''}
        ${cols.note ? '<td></td>' : ''}</tr>`);
      if (a.code === '6470' && payTie) {
        const d = payTie.bud - payTie.tpl;
        rows.push(`<tr class="hist paytie" title="Seth's Payroll Budget Workbook sheet for this property — reference only, never part of the budget">
          <td class="code"></td><td class="name"><span class="histtag">reference</span>${esc(bv.hist.payroll.label)} <span class="muted">${esc(bv.hist.payroll.period)}</span></td>
          ${cols.fx ? '<td></td>' : ''}${monthIdx.map((i) => `<td>${money(payTie.tplM[i])}</td>`).join('')}
          ${cols.annual ? `<td>${money(payTie.tpl)}</td>` : ''}${refBlank}${cols.punit ? `<td>${money(payTie.tpl / units)}</td>` : ''}${cols.note ? '<td></td>' : ''}</tr>`);
        rows.push(`<tr class="hist paytie delta" title="Budget minus the payroll template, by month">
          <td class="code"></td><td class="name"><span class="histtag">Δ</span>budget − template <span class="muted">${payTie.tpl ? `${d >= 0 ? '+' : ''}${((d / Math.abs(payTie.tpl)) * 100).toFixed(1)}%` : ''}</span></td>
          ${cols.fx ? '<td></td>' : ''}${monthIdx.map((i) => `<td class="${payTie.deltaM[i] < 0 ? 'neg' : ''}">${money(payTie.deltaM[i])}</td>`).join('')}
          ${cols.annual ? `<td class="${d < 0 ? 'neg' : ''}"><b>${money(d)}</b></td>` : ''}${refBlank}${cols.punit ? `<td>${money(d / units)}</td>` : ''}${cols.note ? '<td></td>' : ''}</tr>`);
      }
      if (S.showDist && ann) {
        rows.push(`<tr class="dist"><td></td><td class="name">% of ${bv.annual ? bv.budget.year : 'Year 1'}</td>
          ${cols.fx ? '<td></td>' : ''}
          ${monthIdx.map((i) => `<td>${((m[i] / ann) * 100).toFixed(1)}%</td>`).join('')}
          ${cols.annual ? '<td>100%</td>' : ''}${refBlank}${cols.punit ? '<td></td>' : ''}${cols.note ? '<td></td>' : ''}</tr>`);
      }
      // the same share of the year by QUARTER: one cell across each quarter's visible months
      // (the % is always the whole quarter's, hidden months included)
      if (S.showQDist && ann) {
        const calYear = labels === MONTHS || /^Jan/i.test(labels[0]);
        // NOI (annual): each quarter's share is a box — type the share it should carry, then "shift…"
        const noiQ = a.code === '7280' && bv.annual;
        const qsT = noiQ ? (((bv.budget.inputs || {}).qShift || {}).targets || []) : [];
        rows.push(`<tr class="dist qdist${noiQ ? ' qshift' : ''}"><td></td><td class="name">% of ${bv.annual ? bv.budget.year : 'Year 1'} by quarter${noiQ ? ` <button class="rb" id="qs-open" title="Move NOI share between quarters on the lines you pick; the year's NOI stays the same">${(bv.budget.inputs || {}).qShift ? 'shift ✓…' : 'shift…'}</button>` : ''}</td>
          ${cols.fx ? '<td></td>' : ''}
          ${[0, 1, 2, 3].map((q) => {
            const vis = monthIdx.filter((i) => Math.floor(i / 3) === q).length;
            if (!vis) return '';
            const qs = m[q * 3] + m[q * 3 + 1] + m[q * 3 + 2];
            const nm = calYear ? `Q${q + 1}` : `${labels[q * 3]}–${labels[q * 3 + 2]}`;
            if (noiQ) return `<td colspan="${vis}" class="q" title="${nm}: ${money(qs)} of ${money(ann)}. Type the share of the year's NOI this quarter should carry (blank = absorbs the rest), then shift…">${nm} · <input class="qs-in" data-qs="${q}" value="${qsT[q] != null ? +(qsT[q] * 100).toFixed(2) : ''}" placeholder="${((qs / ann) * 100).toFixed(1)}">%</td>`;
            return `<td colspan="${vis}" class="q" title="${nm}: ${money(qs)} of ${money(ann)}">${nm} · ${((qs / ann) * 100).toFixed(1)}%</td>`;
          }).join('')}
          ${cols.annual ? '<td>100%</td>' : ''}${refBlank}${cols.punit ? '<td></td>' : ''}${cols.note ? '<td></td>' : ''}</tr>`);
      }
      continue;
    }
    if (secCollapsed) continue;   // condensed section: detail rows hidden, totals stay
    const l = linesByGl.get(a.code);
    const m = l ? l.months : Array(12).fill(0);
    const ann = sumM(m);
    // annual: a GL with history (T12 / CY budget) but no budget stays visible — that's a decision to see
    const hasRef = (refA && refA.byGl[a.code]) || (refB && refB.byGl[a.code]) || (bv.hist && bv.hist.payroll && bv.hist.payroll.cal[a.code]);   // a payroll-template row (even a 0) keeps the GL visible
    const isZero = !ann && !m.some((v) => v) && !(l && l.note) && !hasRef;
    if (isZero && !S.showZero && !sp) continue;
    const isDropped = !!(l && l.driver && l.driver.method === 'dropped');
    const dm = drvMeta(l && (ann || l.override || isDropped) ? l : null);
    // hard-coded CELLS: the months typed by hand when the line recorded them; every non-zero month when a tool
    // rewrote the whole line (typed total, Smooth, import) or the line was fixed before cells were recorded
    // (a smoothed line is NOT hard-coded: its formula still drives it, only typed cells on it are marked)
    const hardSet = l && l.override ? (Array.isArray((l.driver || {}).hard) ? new Set(l.driver.hard) : (l.driver || {}).smooth || (l.driver || {}).method === 'smooth' ? new Set() : 'all') : null;
    const isHard = (i) => !!hardSet && (hardSet === 'all' ? !!m[i] : hardSet.has(i));
    const hard = hardSet === 'all';
    const prm = cols.fx && l && !l.override ? paramFor(a.code, l, bv.budget.inputs || {}) : null;
    // seller-derived lines get a non-accrual flag when the billing looks bad
    const smell = sellerDerived(l) ? billingSmell(m) : null;
    const trCls = [sp ? 'sp' : '', smell ? 'badbills' : ''].filter(Boolean).join(' ');
    rows.push(`<tr${trCls ? ` class="${trCls}"` : ''}>
      <td class="code">${a.code}</td>
      <td class="name${histFor(a.code).length ? ' hashist' : ''}" ${histFor(a.code).length ? `data-hist="${a.code}"` : ''} title="${esc(a.name)} ${a.pcode ? '· cat ' + a.pcode : ''}${histFor(a.code).length ? ' — click for the prior T12 / CY budget by month' : ''}">${histFor(a.code).length ? `<span class="hx">${histOpen(a.code) ? '▾' : '▸'}</span>` : ''}${esc(a.name)}${smell ? ` <span class="warnflag" title="Seller billing looks NON-ACCRUAL: ${esc(smell.join('; '))}. Likely bad bills — review, or smooth via WAVG / flat / Minot seasonal.">⚠</span>` : ''}${a.active === false ? ' <span class="badge" title="Deactivated GL still carrying dollars — Recalc zeroes it">inactive — recalc to zero</span>' : ''}${l && l.override ? ` <button class="rb" data-unlock="${a.code}" title="Clear manual override">🔓</button>` : ''}</td>
      ${cols.fx ? `<td style="white-space:nowrap"><button class="drv ${dm.cls}" data-tools="${a.code}" title="${esc(dm.label)} — click to change">${dm.tag}</button>${drvExtraHtml({ extra: (dm.extra || []).filter((x) => !x.fit) })}${fitChipHtml(a.code, l)}${l && l.round ? `<span class="rnd" title="Standing MROUND to $${l.round} — re-applies on regeneration">≈${l.round}</span>` : ''}${prm ? (prm.steps ? `<button class="fxp fxp-steps" data-steps="${a.code}" title="${esc(prm.label)} — click to place increases in specific months">${esc(prm.value)}</button>` : prm.multi ? `<button class="fxp fxp-steps" data-multi="${a.code}" title="${esc(prm.title || '')} — click to edit every input">${esc(prm.summary)}</button>` : `<input class="fxp" data-fxp="${a.code}" value="${prm.value}" title="${esc(prm.label)} — Enter applies & regenerates">${/%/.test(prm.label) ? '<span class="fxu" title="percent">%</span>' : ''}`) : ''}</td>` : ''}
      ${monthIdx.map((i) => `<td class="m ${actIdx.has(i) ? 'drv-act' : sp ? '' : dm.cls}${isHard(i) && !actIdx.has(i) ? ' hard' : ''}"${isHard(i) && !actIdx.has(i) ? ' title="Hard-coded: this cell was typed or fixed by hand. 🔓 in the row tools puts the line back on its formula."' : ''}><input data-gl="${a.code}" data-i="${i}" value="${m[i] ? money(Math.round(m[i]) || 0) : ''}"></td>`).join('')}
      ${cols.annual ? `<td class="ann ${ann < 0 ? 'neg' : ''}${hard && ann ? ' hard' : ''}"><input data-ann="${a.code}" value="${ann ? money(Math.round(ann) || 0) : ''}" title="${bv.annual ? bv.budget.year : 'Year 1'} total — type a new total and the months rescale proportionally (distribution kept)"></td>` : ''}
      ${refCells(a.code, 'detail', ann, !!(l && l.override))}
      ${cols.punit ? `<td>${ann ? money(ann / units) : ''}</td>` : ''}
      ${cols.note ? `<td class="note"><input data-gl="${a.code}" value="${esc(l ? l.note : '')}" placeholder="note"></td>` : ''}
    </tr>`);
    if (histOpen(a.code)) for (const h of histFor(a.code)) {
      const hs = sumM(h.months);
      rows.push(`<tr class="hist" data-histrow="${a.code}" title="Reference only — ${esc(h.label)}${h.period ? ` (${esc(h.period)})` : ''} — not part of the ${bv.budget.year} budget">
        <td class="code"></td><td class="name"><span class="histtag">reference</span>${esc(h.label)}${h.period ? ` <span class="muted">${esc(h.period)}</span>` : ''}</td>
        ${cols.fx ? '<td></td>' : ''}
        ${monthIdx.map((i) => `<td class="${h.months[i] < 0 ? 'neg' : ''}">${h.months[i] ? money(h.months[i]) : ''}</td>`).join('')}
        ${cols.annual ? `<td class="${hs < 0 ? 'neg' : ''}">${money(hs)}</td>` : ''}${refBlank}
        ${cols.punit ? `<td>${money(hs / units)}</td>` : ''}${cols.note ? '<td></td>' : ''}</tr>`);
    }
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
    // the axis is fitted to the plotted values on round gridlines — it does NOT start at
    // zero (Troy 2026-11-09), so month-to-month movement fills the chart. The labelled
    // gridlines carry the level; the reference months (dashed) sit on the same scale.
    // prior-year T12s (dropped in on the Data page): dotted NOI lines, one colour each (Troy 2026-11-11)
    // …and now for every selected series, not just NOI (Troy 2026-11-12: "all years … whatever items are selected")
    const all = series.flatMap((s) => [...s.vals, ...((s.ref && s.ref.length === 12) ? s.ref : []), ...trendPriorFor(bv, s).flatMap((p) => p.vals)]);
    const lo = Math.min(...all), hi = Math.max(...all);
    const rough = Math.max(hi - lo, Math.abs(hi) * 0.02, 1) / 4;       // a flat line still gets a sensible band
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= rough);
    let min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step;
    if (max === min) max = min + step;
    if (lo - min < step * 0.1) min -= step / 2;                        // keep the lines off the frame
    if (max - hi < step * 0.1) max += step / 2;
    const gridY = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) gridY.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    const x = (i) => padL + (i * (W - padL - padR)) / 11;
    const y = (v) => padT + (H - padT - padB) * (1 - (v - min) / (max - min));
    const poly = (vals, color, dashed) => `<polyline fill="none" stroke="${color}" stroke-width="${dashed ? 1.2 : 2}" ${dashed ? 'stroke-dasharray="3 3" opacity=".6"' : ''} points="${vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`;
    const lines = series.map((s) =>
      (s.ref && s.ref.length === 12 ? poly(s.ref, s.color, true) + s.ref.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.6" fill="${s.color}" opacity=".6"><title>${s.name} ${ref.label} ${labels[i]}: ${money(v)}</title></circle>`).join('') : '') +
      poly(s.vals, s.color, false) +
      s.vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.4" fill="${s.color}"><title>${s.name} ${labels[i]}: ${money(v)}${s.ref && s.ref.length === 12 ? ` (${ref.label} ${money(s.ref[i])}, Δ ${money(v - s.ref[i])})` : ''}</title></circle>`).join('')
    ).join('') + series.flatMap((s) => trendPriorFor(bv, s).map((p) => `<polyline fill="none" stroke="${p.color}" stroke-width="1.4" stroke-dasharray="1.5 3" stroke-linecap="round" points="${p.vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`
      + p.vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.5" fill="${p.color}"><title>${s.name} ${p.label} ${labels[i]}: ${money(v)}</title></circle>`).join(''))).join('');
    // labels carry just enough precision to tell neighbouring gridlines apart
    const top = Math.max(Math.abs(min), Math.abs(max));
    const fmtAxis = (v) => {
      if (top >= 1e6) return (v / 1e6).toFixed(step >= 1e5 ? 1 : step >= 1e4 ? 2 : 3) + 'M';
      if (top >= 1000) return (v / 1000).toFixed(step >= 1000 ? 0 : step >= 100 ? 1 : 2) + 'k';
      return String(Math.round(v));
    };
    const axis = gridY.map((v) =>
      `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="var(--line)" ${v === 0 ? '' : 'stroke-dasharray="2 4"'}/>` +
      `<text x="${padL - 4}" y="${y(v) + 3}" font-size="9" fill="var(--dim)" text-anchor="end">${fmtAxis(v)}</text>`).join('');
    const ticks = [0, 3, 6, 9, 11].map((i) => `<text x="${x(i)}" y="${H - 5}" font-size="9" fill="var(--dim)" text-anchor="middle">${labels[i]}</text>`).join('');
    body = `${axis}${lines}${ticks}`;
  } else {
    body = `<text x="${W / 2}" y="${H / 2}" font-size="11" fill="var(--dim)" text-anchor="middle">pick a series below</text>`;
  }
  const legend = ALL.map((s) => `
    <button class="trend-chip ${sel.has(s.name) ? 'on' : ''}" data-trend="${s.name}" style="--c:${s.color}">
      <span style="display:inline-block;width:10px;height:3px;background:${s.color};vertical-align:3px;margin-right:4px"></span>${s.name}</button>`).join('')
    + (ref ? `<span class="muted" style="font-size:10.5px">dashed = ${esc(ref.label)} by month</span>` : '')
    + (series.length ? trendPriors(bv).map((p) => ` <span style="font-size:10.5px; color:${p.color}">⋯ ${esc(p.label)}</span>`).join('') : '');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; display:block">${body}</svg><div style="margin-top:5px">${legend}</div>${trendQuarterHtml(bv, series, labels)}`;
}
/* prior-year trailing-12s (Data page drops), one colour each; `trendPriorFor` = one series' months from each */
const PRIOR_COLORS = ['#8e44ad', '#e67e22', '#16a085'];
const trendPriors = (bv) => ((bv.summary && bv.summary.priorT12) || []).slice(0, 3).map((p, k) => ({ ...p, color: PRIOR_COLORS[k] }));
const trendPriorFor = (bv, s) => trendPriors(bv).map((p) => ({ label: p.label, color: p.color, vals: p[s.name.toLowerCase()] || [] })).filter((p) => p.vals.length === 12);
/* QUARTERLY BREAKDOWN under the chart (Troy 2026-11-12): every year on the chart — this budget, the reference
   (T12 / CY budget) and the prior-year T12s — for each series picked in the legend. Each cell is the quarter's
   dollars and its share of that year; quarters follow the budget's own months (Q1 = its first three). */
function trendQuarterHtml(bv, series, labels) {
  if (!series.length) return '';
  const ref = bv.refMonthly || null;
  const q = (m) => [0, 1, 2, 3].map((k) => (m[k * 3] || 0) + (m[k * 3 + 1] || 0) + (m[k * 3 + 2] || 0));
  const k$ = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${(v / 1e3).toFixed(1)}k`);
  const yr = bv.annual ? `${bv.budget.year} budget` : 'Budget';
  const row = (label, color, m, dashed) => {
    const Q = q(m); const Y = Q.reduce((a, b) => a + b, 0);
    return `<tr><td class="ql"><span class="qsw" style="border-top:2px ${dashed ? 'dashed' : 'solid'} ${color}"></span>${esc(label)}</td>${Q.map((v, i) => `<td title="${esc(label)} Q${i + 1}: ${money(v)}${Y ? ` · ${(v / Y * 100).toFixed(1)}% of the year` : ''}">${k$(v)}<div class="qp">${Y ? (v / Y * 100).toFixed(1) + '%' : '—'}</div></td>`).join('')}<td class="qy">${k$(Y)}</td></tr>`;
  };
  const qh = [0, 1, 2, 3].map((k) => `<th title="${esc(labels[k * 3] || '')}–${esc(labels[k * 3 + 2] || '')}">Q${k + 1}</th>`).join('');
  return `<table class="qtrend"><tr><th></th>${qh}<th>Year</th></tr>${series.map((s) => `<tr class="qs"><td colspan="6" style="color:${s.color}">${s.name}</td></tr>`
    + row(yr, s.color, s.vals, false)
    + (s.ref && s.ref.length === 12 ? row(ref.label, s.color, s.ref, true) : '')
    + trendPriorFor(bv, s).map((p) => row(p.label, p.color, p.vals, true)).join('')).join('')}</table>`;
}

/* ---- GPR increases in SPECIFIC months (Troy 2026-11-03: "not blanketed") ----
   growthPct[i] is the % change applied IN calendar month i (compounding), so a
   3% raise in March and 2% in September is [0,0,.03,0,0,0,0,0,.02,0,0,0]. */
const GPR_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function gprStepsSummary(steps) {
  if (!steps || !steps.some((v) => v)) return 'no increases';
  const nz = steps.map((v, i) => [v, i]).filter(([v]) => v);
  if (nz.length === 12 && nz.every(([v]) => Math.abs(v - nz[0][0]) < 1e-9)) return `${(nz[0][0] * 100).toFixed(2)}% every month`;
  return nz.map(([v, i]) => `${GPR_MON[i]} ${v > 0 ? '+' : ''}${(v * 100).toFixed(2).replace(/\.?0+$/, '')}%`).join(', ');
}
function gprStepsGrid(steps, cls) {
  const s = steps || [];
  let cum = 1;
  return `<div class="msteps">${GPR_MON.map((m, i) => { cum *= 1 + (s[i] || 0); return `<div class="ms"><label>${m}</label><input class="${cls}" data-i="${i}" value="${s[i] ? +(s[i] * 100).toFixed(3) : ''}" placeholder="–"><span class="cum" data-cum="${i}" title="cumulative vs the base">${((cum - 1) * 100).toFixed(1)}%</span></div>`; }).join('')}</div>`;
}
function readGprSteps(root, cls, fallback) {
  const boxes = [...root.querySelectorAll(`.${cls}`)];
  if (!boxes.length) return fallback || Array(12).fill(0);
  const out = Array(12).fill(0);
  boxes.forEach((x) => { const v = parseFloat(String(x.value).replace(/[%,\s]/g, '')); if (Number.isFinite(v)) out[+x.dataset.i] = v / 100; });
  return out;
}
function wireGprCum(root, cls) {
  const upd = () => { const s = readGprSteps(root, cls, []); let cum = 1; s.forEach((v, i) => { cum *= 1 + v; const c = root.querySelector(`[data-cum="${i}"]`); if (c) c.textContent = `${((cum - 1) * 100).toFixed(1)}%`; }); };
  root.querySelectorAll(`.${cls}`).forEach((x) => x.addEventListener('input', upd));
}
/* the 4994 row's popover: the same grid, applied on Save */
function openGprSteps(b, anchorBtn) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const inp = S.bv.budget.inputs || {};
  const g = inp.gpr || {};
  const menu = document.createElement('div');
  menu.className = 'rowmenu gpr';
  menu.innerHTML = `
    <div class="rm-head">4994 GPR — % increase applied IN each month (compounds). Leave a month blank for no change.</div>
    ${gprStepsGrid(g.growthPct || [], 'pop-gprstep')}
    <div class="rm-foot"><span class="muted" id="pop-gprsum">${esc(gprStepsSummary(g.growthPct))}</span>
      <span><button class="inline" data-act="clear">Clear</button> <button class="primary" data-act="save">Save &amp; regenerate</button></span></div>`;
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - 700))}px`;
  menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  wireGprCum(menu, 'pop-gprstep');
  menu.querySelectorAll('.pop-gprstep').forEach((x) => x.addEventListener('input', () => { menu.querySelector('#pop-gprsum').textContent = gprStepsSummary(readGprSteps(menu, 'pop-gprstep', [])); }));
  menu.querySelector('[data-act="clear"]').addEventListener('click', () => { menu.querySelectorAll('.pop-gprstep').forEach((x) => { x.value = ''; }); wireGprCum(menu, 'pop-gprstep'); menu.querySelectorAll('.pop-gprstep')[0].dispatchEvent(new Event('input')); });
  menu.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const steps = readGprSteps(menu, 'pop-gprstep', []);
    pushUndo();
    S.bv = await PUT(`/budgets/${b.id}`, { inputs: { gpr: { ...g, growthPct: steps } } });
    close(); render();
  });
}

/* A formula with several inputs (LTL renewal % + burnoffs, corporate rate,
   interest) gets the GPR treatment: the chip shows a summary, clicking it
   opens a popover with one labelled box per input and Save & regenerate.
   Only boxes that were changed are saved, so untouched inputs keep whatever
   the budget already had (incl. "unset → engine default"). */
function openMultiParams(b, gl, anchorBtn) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const inputs = S.bv.budget.inputs || {};
  const line = S.bv.lines.find((l) => l.gl_code === gl);
  const prm = paramFor(gl, line, inputs);
  if (!prm || !prm.multi) return;
  const menu = document.createElement('div');
  menu.className = 'rowmenu gpr multi';
  menu.innerHTML = `
    <div class="rm-head">${esc(prm.title || '')}</div>
    <div class="mfields">${prm.multi.map((p) => `<div class="mf"><label>${esc(p.short)}</label>
      <span class="mfin"><input class="pop-multi" data-k="${p.k}" value="${p.value}"><span class="unit">${esc(p.unit || '')}</span></span>
      <span class="hint">${esc(p.label)}</span></div>`).join('')}</div>
    <div class="rm-foot"><span class="muted">${esc(prm.summary)}</span>
      <span><button class="inline" data-act="x">Cancel</button> <button class="primary" data-act="save">Save &amp; regenerate</button></span></div>`;
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - 560))}px`;
  menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  const first = menu.querySelector('input.pop-multi');
  if (first) { first.focus(); first.select(); }
  const save = async () => {
    // fold the changed boxes into one patch: each patch is built against the
    // inputs as updated so far, so the last one carries every change
    let cur = inputs, patch = {};
    for (const box of menu.querySelectorAll('input.pop-multi')) {
      const p0 = prm.multi.find((x) => x.k === box.dataset.k);
      const v = parseFloat(String(box.value).replace(/[$,%\s]/g, ''));
      if (!p0 || !Number.isFinite(v) || String(box.value).trim() === String(p0.value)) continue;
      const p = paramFor(gl, line, cur).multi.find((x) => x.k === box.dataset.k);
      const d = p.patch(v);
      patch = { ...patch, ...d };
      cur = { ...cur, ...d };
    }
    if (!Object.keys(patch).length) { close(); return; }
    pushUndo();
    S.bv = await PUT(`/budgets/${b.id}`, { inputs: patch });
    close(); render();
  };
  menu.querySelector('[data-act="x"]').addEventListener('click', close);
  menu.querySelector('[data-act="save"]').addEventListener('click', () => save().catch((err) => alert(err.message)));
  menu.querySelectorAll('input.pop-multi').forEach((x) => x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save().catch((err) => alert(err.message)); } if (e.key === 'Escape') close(); }));
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
    const cur = { perUnitYr: line.driver.perUnitYr || 0, flatMo: line.driver.flatMo || 0 };
    const rate = (k) => (v) => ({ corpRates: { ...(inp.corpRates || {}), [gl]: { ...cur, [k]: v } } });
    return { title: `${gl} — corporate rate: $ per unit per year ÷ 12, plus a flat $ per month.`, summary: `${money(cur.perUnitYr)}/unit/yr + ${money(cur.flatMo)}/mo`, multi: [
      { k: 'perUnitYr', short: '$ per unit per year', unit: '$', label: 'Spread evenly over the 12 months', value: cur.perUnitYr, patch: rate('perUnitYr') },
      { k: 'flatMo', short: 'Flat $ per month', unit: '$', label: 'Added on top every month', value: cur.flatMo, patch: rate('flatMo') },
    ] };
  }
  if (gl === '4994' && m === 'gpr') {
    const g = (inp.gpr || {}).growthPct || [];
    return { label: 'GPR % increases by month', value: gprStepsSummary(g), steps: true };
  }
  if (gl === '5003' && m === 'ltl') {
    // every LTL input on the row (Troy 2026-11-09: no trip to Assumptions when a formula has several)
    const lt = inp.ltl || {};
    const ltlPatch = (k, scale) => (v) => ({ ltl: { ...lt, [k]: scale ? v / scale : v } });
    const m0Box = { k: 'month0', short: 'Month 1 $', unit: '$', label: 'Loss to lease in the first month (negative). The formula runs on from it. 0 = the formula\'s own start', value: lt.month0 ?? 0, patch: (v) => ({ ltl: { ...lt, month0: v ? -Math.abs(v) : null } }) };
    if (lt.mode === 'flat') return { title: '5003 Loss to lease — held flat all year.', summary: `flat ${money(lt.startMonthly ?? 0)}/mo`, multi: [
      { k: 'startMonthly', short: 'Start $/mo', unit: '$', label: 'Monthly loss to lease, negative (0 = rent roll gap / last actual month)', value: lt.startMonthly ?? 0, patch: ltlPatch('startMonthly') },
      m0Box,
    ] };
    if (lt.mode === 'ramp') return { title: '5003 Loss to lease — ramps from a start $ toward a target % of GPR.', summary: `ramp ${money(lt.startMonthly ?? 0)} → ${pct(lt.targetPct ?? 0)}% over ${lt.rampMonths ?? 12} mo`, multi: [
      { k: 'startMonthly', short: 'Start $/mo', unit: '$', label: 'Ramp start, negative', value: lt.startMonthly ?? 0, patch: ltlPatch('startMonthly') },
      { k: 'targetPct', short: 'Target % of GPR', unit: '%', label: 'Where the ramp ends', value: pct(lt.targetPct ?? 0), patch: ltlPatch('targetPct', 100) },
      { k: 'rampMonths', short: 'Ramp months', unit: 'mo', label: 'Months from start to target', value: lt.rampMonths ?? 12, patch: ltlPatch('rampMonths') },
      m0Box,
    ] };
    const annual = S.bv && S.bv.annual;
    const rp = lt.renewalPct ?? (annual ? 0.65 : 0.7), br = lt.burnoffRenew ?? (annual ? 0.75 : 0.5), bn = lt.burnoffNew ?? 1;
    return {
      title: '5003 Loss to lease — each expiring lease either renews (renewal %) or turns; the gap to market burns off by the matching % and deepens with GPR growth.',
      summary: `renew ${pct(rp)}% · burnoff ${pct(br)}% / ${pct(bn)}%${lt.month0 != null ? ` · starts ${money(lt.month0)}` : ''}`,
      multi: [
        { k: 'renewalPct', short: 'Renewal %', unit: '%', label: 'Share of expiring leases that renew (the rest turn over)', value: pct(rp), patch: ltlPatch('renewalPct', 100) },
        { k: 'burnoffRenew', short: 'LTL burnoff — renewal', unit: '%', label: '% of that lease\'s gap to market closed at renewal', value: pct(br), patch: ltlPatch('burnoffRenew', 100) },
        { k: 'burnoffNew', short: 'LTL burnoff — move-in', unit: '%', label: '% of the gap closed when the unit turns to a new resident', value: pct(bn), patch: ltlPatch('burnoffNew', 100) },
        m0Box,
      ] };
  }
  if (m === 'flatFee') {
    const bl = inp.baseline || {};
    return { label: 'fee increase % (on the last actual month)', value: pct(line.driver.pct || 0), patch: (v) => ({ baseline: { ...bl, glGrowth: { ...(bl.glGrowth || {}), [gl]: v / 100 } } }) };
  }
  if (gl === '5036' && m === 'collections') {
    return { label: "% of the previous month's delinquency collected", value: +(((line.driver.pct || 0) * 100).toFixed(2)), patch: (v) => ({ collectPct: Math.min(100, Math.max(0, v)) / 100 }) };
  }
  if (gl === '5031' && m === 'vacancy') {
    const vac = inp.vacancyPct || [];
    // the box is the ANNUAL AVERAGE; the months follow lease expirations (engine: vacancyByMonth)
    const d = line.driver || {};
    return { label: d.shaped === 'expirations' ? 'average vacancy % for the year — the months follow move-outs and carry-over from the last actual month' : 'vacancy % (annual average)', value: pct(d.avg != null ? d.avg : (vac[0] || 0)), patch: (v) => ({ vacancyPct: Array(12).fill(v / 100) }) };
  }
  if (gl === '6112' && m === 'mgmtPct') {
    return { label: '% of prior-month income', value: pct(inp.mgmtPct || 0), patch: (v) => ({ mgmtPct: v / 100 }) };
  }
  if (m === 'sellerUtil') {
    return { label: 'growth %', value: pct((inp.utilities || {}).growthPct ?? 0.03), patch: (v) => ({ utilities: { ...(inp.utilities || {}), growthPct: v / 100 } }) };
  }
  if (m === 'payrollModel') {
    if (inp.wagesFromRoster || line.driver.roster) return null;   // roster wages carry their own raises (Payroll tab)
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
    return { title: `${gl} — interest = loan × rate ÷ 360 × days in the month.`, summary: `${money(inp.loan || 0)} @ ${pct(inp.rate || 0)}%`, multi: [
      { k: 'loan', short: 'Loan balance', unit: '$', label: 'Principal the interest accrues on', value: inp.loan || 0, patch: (v) => ({ loan: v }) },
      { k: 'rate', short: 'Interest rate', unit: '%', label: 'Annual rate, actual/360', value: pct(inp.rate || 0), patch: (v) => ({ rate: v / 100 }) },
    ] };
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
    ${S.bv && S.bv.annual ? item('refpct', 'Δ% vs T12') + item('ref1', 'T12 actuals') + item('ref3', 'T3 annualized') + item('ref2', 'CY budget') : ''}
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


/* ============================================================================
   REVIEWABILITY (Troy 2026-11-09, devil's advocate day-one fixes): say what a
   chip means, show lines the template dropped, flag a budget calculated on older
   formulas, list the defaults a budget is running on, and check before export.
   ========================================================================== */
const TAG_KEY = [
  ['ROLL', 'Gross potential rent from the rent roll market rents, with the month steps typed on the row.'],
  ['LTL', 'Loss to lease: each lease keeps its rent until it resets; a reset burns the burnoff % of its gap.'],
  ['VAC·EXP', 'Vacancy: an annual average. It starts at the last actual month, move-outs land a month after expirations, and empty units fill gradually.'],
  ['%GPR', 'A % of gross potential rent (the trailing-12 ratio unless typed).'],
  ['%NET RENT', 'A % of net rental income (GPR less loss to lease, concessions and vacancy).'],
  ['%NET GPR', 'A % of net GPR (GPR, HAP and loss to lease).'],
  ['RECAP', 'Concession recapture: a % of the other concession lines.'],
  ['%PRIOR DQ', "Prior-period collections: a % of the PREVIOUS month's delinquency."],
  ['SAME MO', 'The same calendar month of the trailing-12 × the increase factor.'],
  ['WAVG', '1-2-1 weighted average of the month before, the month and the month after × the factor.'],
  ['T12/12', 'The trailing-12 total ÷ 12, the same every month × the factor.'],
  ['LAST', 'The last actual month, the same every month. ⚠LAST = that month is far off the average.'],
  ['TURNS', 'The trailing-12 total placed on lease expirations, one month later.'],
  ['T12·TURNS', "Last year's dollars placed on the months with projected move-ins; the year total stays at the T12."],
  ['<$1K', 'NOT budgeted: the trailing-12 was at or under $1,000 and the template drops it. Click to budget it.'],
  ['CHG', 'Rent-roll charges (pet, garage, storage…) × 12.'],
  ['FLAT FEE', 'Flat utility fee per occupied unit: last actual month × budgeted occupancy.'],
  ['CORP', "Corporate budget suggestion from the Yardi template."],
  ['$/UNIT', 'Corporate rate: $ per unit per year ÷ 12, plus a flat $ per month.'],
  ['%INC', "Management fee: % of the prior month's total income."],
  ['PAY', 'Wages from the Payroll tab roster (or a payroll model). PAY·prelim = raise entries are not finalized.'],
  ['%WAGES', "A payroll line as a % of that month's budgeted wages (same-month historical ratio)."],
  ['DEBT', 'Interest / principal from the Yardi amortization schedule.'],
  ['ZERO', 'Zeroed on purpose.'],

  ['+ SMOOTH', 'A second chip: missed-bill smoothing applied on top of the line formula (months fixed, rounded to $5).'],
  ['MAN', 'Typed by hand; formulas do not touch it until it is unlocked.'],
  ['TOTAL', 'A year total typed by hand, spread on the previous shape.'],
  ['—', 'No formula and no dollars.'],
  ['tag*', 'A formula line whose cells were then revised by hand.'],
];
function openTagKey() {
  let dlg = document.getElementById('tagkey-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'tagkey-dlg'; document.body.appendChild(dlg); }
  dlg.innerHTML = `<h2>Chip key</h2>
    <table class="list" style="font-size:12.5px">${TAG_KEY.map(([t, d]) => `<tr><td style="white-space:nowrap"><span class="drv" style="background:var(--soft)">${esc(t)}</span></td><td>${esc(d)}</td></tr>`).join('')}</table>
    <p style="font-size:12.5px; margin:10px 0 0"><span class="hardkey">1,234</span> — a cell in bold in this colour is <b>hard-coded</b>: typed by hand. When a whole line was fixed at once (a typed total, an import) every month of it is marked. A smoothed line is not marked: its formula still drives it.</p>
    <div class="row" style="justify-content:flex-end; margin-top:10px"><button class="btn" id="tagkey-x">Close</button></div>`;
  dlg.querySelector('#tagkey-x').addEventListener('click', () => dlg.close());
  dlg.showModal();
}


/* ---- saved formula sets (Troy 2026-11-09): a named recipe saved from a budget and PICKED
   when another is started — never a silent default ---- */
function formulaSetOptions(cur) {
  const sets = (S.state && S.state.formulaSets) || [];
  const opt = (v, label) => `<option value="${esc(String(v))}" ${String(cur || '') === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  return `<option value="">— pick a formula set —</option>`
    + sets.map((x) => opt(x.id, `${x.name} · ${x.rules} lines · from ${x.source || '?'} · ${new Date(x.created_at).toLocaleDateString()}`)).join('')
    + `<option disabled>──────────</option>`
    + opt('template', 'Template defaults only (no saved set)')
    + opt('grks', 'GRKS 2026 draft (the old default)');
}
/* a deliberate zero-out ("Zero out row" saves it as an edited line) — it travels in saved sets and section copies */
const zeroedLine = (l) => !!l && !!l.driver && l.driver.method === 'zero' && !l.driver.revised && (l.months || []).every((v) => !Number(v));
async function saveFormulaSet(b) {
  const lines = (S.bv.lines || []).filter((l) => (!l.override && l.driver && l.driver.method === 'baseline') || zeroedLine(l));
  const hard = (S.bv.lines || []).filter((l) => l.override && !zeroedLine(l)).length;
  const name = (prompt(`Save this budget's formulas under a name.\n\nSaved: ${lines.length} line formulas (shape, increase factor, rounding, zero-outs) and the formula settings (category factors, cost drift, loss-to-lease renewal / burnoff, vacancy curve, payroll basis).\nNOT saved: ${hard} hand-typed line${hard === 1 ? '' : 's'}, any dollar amount, GPR steps, the vacancy average, expirations.\n\nName:`, `${b.property_code.toUpperCase()} ${b.year}`) || '').trim();
  if (!name) return;
  try {
    let r;
    try { r = await POST('/formula-sets', { name, budgetId: b.id }); }
    catch (e) {
      if (!/already exists/.test(e.message) || !confirm(`${e.message}. Replace it with this budget's formulas?`)) throw e;
      r = await POST('/formula-sets', { name, budgetId: b.id, overwrite: true });
    }
    await refreshState();
    alert(`Saved "${r.name}" — ${r.rules} line formulas. It is now a choice when a budget is started, and under More → Apply a saved formula set….`);
  } catch (e) { alert(e.message); }
}
function openApplyFormulaSet(b) {
  let dlg = document.getElementById('fset-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'fset-dlg'; document.body.appendChild(dlg); }
  const cur = (S.bv.budget.inputs || {}).rulesFrom || null;
  const sets = (S.state && S.state.formulaSets) || [];
  dlg.innerHTML = `<h2>Apply a saved formula set</h2>
    <p class="muted" style="font-size:12px; margin:0 0 8px">This budget is on: <b>${cur ? esc(cur.name) : 'no chosen set (the old GRKS default)'}</b>. Applying a set replaces this budget's per-line shape / increase factor / rounding choices and its formula settings with the set's, then recalculates. <b>Kept:</b> hand-typed lines, dollars, GPR, the vacancy average, expirations. One Undo reverses it.</p>
    <select id="fs-pick" style="width:100%">${formulaSetOptions('')}</select>
    ${S.auth && S.auth.isAdmin && sets.length ? `<div style="margin-top:8px; font-size:12px" class="muted">Saved sets: ${sets.map((x) => `${esc(x.name)} <button class="rb" data-fsdel="${x.id}" title="Delete this saved set — budgets already on it keep their copy">🗑</button>`).join(' · ')}</div>` : ''}
    <div class="err" id="fs-err"></div>
    <div class="row" style="justify-content:flex-end; margin-top:10px"><button class="btn sub" id="fs-x">Cancel</button> <button class="btn" id="fs-go">Apply &amp; recalculate</button></div>`;
  dlg.querySelector('#fs-x').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-fsdel]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Delete this saved formula set? Budgets already on it keep their own copy.')) return;
    await DEL(`/formula-sets/${btn.dataset.fsdel}`); await refreshState(); dlg.close(); openApplyFormulaSet(b);
  }));
  dlg.querySelector('#fs-go').addEventListener('click', async () => {
    const v = dlg.querySelector('#fs-pick').value;
    if (!v) { dlg.querySelector('#fs-err').textContent = 'Pick a formula set.'; return; }
    try { pushUndo(); S.bv = await POST(`/budgets/${b.id}/formula-set`, { formulaSet: v }); dlg.close(); render(); }
    catch (e) { dlg.querySelector('#fs-err').textContent = e.message; }
  });
  dlg.showModal();
}

/* ---- section increase % (Troy 2026-11-10): one box on a section header sets the increase for
   every history-based line under it. A row with its own % and any hand-typed line keep theirs. ---- */
const SEC_PCT_SECTIONS = new Set(['other_income', 'fixed_admin', 'admin', 'corporate_events', 'marketing', 'utilities', 'in_house_maint', 'exterior_cam', 'contract_services', 'rehab_replacement']);
function secPctBoxHtml(bv, hdr, linesByGl) {
  if (!bv.annual || !SEC_PCT_SECTIONS.has(hdr.section)) return '';
  const bl = (bv.budget.inputs || {}).baseline || {};
  const own = bl.glGrowth || {}, shaped = bl.glShape || {};
  let follow = 0, keep = 0; const shapesNow = new Set();
  for (const a of S.state.coa) {
    if (a.kind !== 'detail' || a.section !== hdr.section) continue;
    const l = linesByGl.get(a.code);
    if (!l || !l.driver) continue;
    if (l.override) { if (l.months.some((v) => v)) keep++; continue; }
    if (l.driver.method !== 'baseline') { if (l.months.some((v) => v)) keep++; continue; }   // corporate rate, fee, suggestion… their own formula
    if (own[a.code] != null) keep++; else follow++;
    shapesNow.add(l.driver.shape || '');
  }
  if (!follow && !keep) return '';
  const cur = (bl.secGrowth || {})[hdr.section];
  return ` <span class="secpct" title="Increase % for every history-based line in ${esc(hdr.name)}: ${follow} line${follow === 1 ? '' : 's'} follow it${keep ? `; ${keep} keep their own (a % typed on the row, a hand-typed line, or a line with its own formula)` : ''}. Blank = each line's usual factor. Enter applies and recalculates.">increase <input class="secpct-in" data-secpct="${esc(hdr.section)}" value="${cur != null ? +(cur * 100).toFixed(2) : ''}" placeholder="—"> % <span class="muted">· ${follow} line${follow === 1 ? '' : 's'}${keep ? `, ${keep} keep their own` : ''}</span>${secShapeHtml(hdr, shapesNow)}${secFitHtml(hdr)}</span>`;
}

/* ---- section formula (Troy 2026-11-10): one pick on a section header sets how every history-based
   line under it is built (e.g. Contractor off "T12 / 12"). Hand-typed lines and lines with their own
   formula (corporate rate, fee, suggestion) are not touched. ---- */
/* ONE flat option (Troy 2026-11-11: "way too many options for flatlining, please cut all but main one"):
   "Average of active months" and "Last actual month, flat" are no longer offered anywhere. Lines already on
   them keep working and are labelled "(retired)" so nothing moves unasked. */
const SEC_SHAPES = [['actual', 'Same month last year'], ['wavg', '1-2-1 weighted months'], ['flat', 'T12 ÷ 12, flat'], ['curve', 'T12 on the seasonal curve'], ['turns', 'Turnover curve (lease expirations + 1 month)']];
const RETIRED_SHAPES = [['avgnz', 'Average of active months (retired)'], ['last', 'Last actual month, flat (retired)']];
const shapeLabel = (k) => ([...SEC_SHAPES, ...RETIRED_SHAPES].find((x) => x[0] === k) || [k, k])[1];
function secShapeHtml(hdr, shapesNow) {
  const now = [...shapesNow].filter(Boolean);
  if (!now.length) return '';
  const one = now.length === 1 ? now[0] : null;
  return `<select class="secshape-in" data-secshape="${esc(hdr.section)}" title="How every history-based line in ${esc(hdr.name)} is built. Picking one sets it on all of them and recalculates; hand-typed lines and lines with their own formula keep theirs. Then More → Copy section formulas to other budgets… to give the same change to other properties.">
    <option value="" selected>${one ? `formula: ${SHAPE_CHIP[one] ? SHAPE_CHIP[one][1] + ' · ' : ''}` + esc(shapeLabel(one)) : 'formula: mixed'}</option>
    ${SEC_SHAPES.filter((x) => x[0] !== one).map(([k, t]) => shapeOpt(k, `set all to: ${t}`)).join('')}
    <option value="__clear">clear row choices (back to the default)</option>
    <option value="__defaults">change the DEFAULT for every budget…</option></select>`;
}
/* FIT TO T12 (Troy 2026-11-11): lines on a curve (turnover / seasonal) can lean toward their own T12 months.
   One box on the section header sets it for every curve line under it; 0 / blank = the pure curve, 100 = the
   T12 months themselves. The year total does not change, only where it lands. */
const FIT_SHAPES = new Set(['turns', 'curve']);
/* fit works on ANY line with its own T12 (Troy 2026-11-11) — not contracts, debt, zero / dropped / typed lines */
const FIT_SKIP = new Set(['manual', 'zero', 'dropped', 'contract', 'debtService', 'interest']);
const hasT12 = (gl) => { const h = S.bv && S.bv.hist && S.bv.hist.t12; return !!(h && h.cal[gl] && h.cal[gl].some((v) => v)); };
const fitOfLine = (l) => (l && l.driver ? (l.driver.fit || l.driver.fitT12 || 0) : 0);
/* A FIT chip on every line that can lean toward its own T12 (Troy 2026-11-11: "I need a chip to individually fit
   a line to T12 curve"). Faint "FIT" = off; "FIT n%" = set. Click → 0 / 25 / 50 / 75 / 100 or a typed %. Same
   setting as the row menu's "Fit to T12 %…" and the section box (baseline.glFit); the year total never moves. */
const fitEligible = (gl, l) => !!(l && hasT12(gl) && !(l.driver && FIT_SKIP.has(l.driver.method) && !l.override));
const fitPctOf = (gl, l) => Math.round((((((S.bv && S.bv.budget && S.bv.budget.inputs) || {}).baseline || {}).glFit || {})[gl] ?? fitOfLine(l)) * 100);
function fitChipHtml(gl, l) {
  if (!fitEligible(gl, l)) return '';
  const p = fitPctOf(gl, l);
  return `<button class="drv drv-t12 fitchip${p ? '' : ' off'}" data-fitgl="${esc(gl)}" style="margin-left:3px" title="Fit to T12: lean this line's months ${p ? `${p}% ` : ''}toward its own trailing-12 months — the year total does not change. Click to set.">${p ? `FIT ${p}%` : 'FIT'}</button>`;
}
async function setLineFit(b, gl, pct) {
  const bl = ((S.bv.budget.inputs || {}).baseline) || {};
  const line = S.bv.lines.find((x) => x.gl_code === gl);
  pushUndo();
  if (line && line.override) S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { override: false });
  S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...bl, glFit: { ...(bl.glFit || {}), [gl]: pct / 100 } } } });
  render();
}
function openFitChip(b, gl, anchorBtn) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const line = S.bv.lines.find((x) => x.gl_code === gl);
  const acc = (S.state.coa || []).find((a) => a.code === gl) || {};
  const cur = fitPctOf(gl, line);
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  menu.innerHTML = `<div class="rm-head">${esc(gl)} ${esc(acc.name || '')} — fit to T12</div>
    <div class="muted" style="font-size:11px; padding:0 8px 4px; max-width:260px">How far the months lean toward this GL's own trailing-12 months. 0 = the formula's months, 100 = the T12 months. The year total does not change.</div>
    <div class="fitrow" style="display:flex; gap:4px; padding:2px 8px 6px; flex-wrap:wrap">${[0, 25, 50, 75, 100].map((v) => `<button data-fv="${v}"${v === cur ? ' class="on"' : ''}>${v}%</button>`).join('')}</div>
    <div class="fitrow" style="display:flex; gap:4px; align-items:center; padding:0 8px 6px"><input data-fin value="${cur}" style="width:54px; text-align:right"> % <button class="primary" data-fapply>Apply</button></div>`;
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.left + window.scrollX - 40)}px`;
  menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  const go = (v) => { if (!(Number.isFinite(v) && v >= 0 && v <= 100)) { alert('Fit to T12 is a % from 0 to 100.'); return; } menu.remove(); setLineFit(b, gl, v).catch((err) => alert(err.message)); };
  menu.querySelectorAll('[data-fv]').forEach((x) => x.addEventListener('click', () => go(Number(x.dataset.fv))));
  const inp = menu.querySelector('[data-fin]');
  menu.querySelector('[data-fapply]').addEventListener('click', () => go(parseFloat(String(inp.value).replace(/[%,]/g, ''))));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(parseFloat(String(inp.value).replace(/[%,]/g, ''))); });
  inp.focus(); inp.select();
}
function secFitLines(section) {
  const lines = new Map((S.bv.lines || []).map((l) => [l.gl_code, l]));
  return S.state.coa.filter((a) => a.kind === 'detail' && a.section === section).map((a) => lines.get(a.code))
    .filter((l) => l && !l.override && l.driver && !FIT_SKIP.has(l.driver.method) && hasT12(l.gl_code));
}
function secFitHtml(hdr) {
  const ls = secFitLines(hdr.section);
  if (!ls.length) return '';
  const vals = new Set(ls.map((l) => Math.round(fitOfLine(l) * 100)));
  const cur = vals.size === 1 ? [...vals][0] : null;
  return ` <span class="secfit" title="Fit to T12: how far the ${ls.length} line${ls.length === 1 ? '' : 's'} in ${esc(hdr.name)} lean toward their OWN trailing-12 months, whatever formula builds them. 0 = the formula's own months, 50 = half and half, 100 = the T12 months themselves. Each line's year total stays the same; only the months move. Enter applies.">fit to T12 <input class="secfit-in" data-secfit="${esc(hdr.section)}" value="${cur == null ? '' : cur || ''}" placeholder="${cur == null ? 'mixed' : '0'}" style="width:42px; text-align:right; border:1px solid var(--line); border-radius:5px; padding:1px 4px; font-size:11.5px"> %</span>`;
}
async function setFit(b, gls, pctVal) {
  const bl = (S.bv.budget.inputs || {}).baseline || {};
  const glFit = { ...(bl.glFit || {}) };
  for (const gl of gls) { if (pctVal > 0) glFit[gl] = Math.min(1, pctVal / 100); else glFit[gl] = 0; }
  pushUndo();
  S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...bl, glFit } } });
  render();
}
async function setSectionShape(b, section, shape) {
  if (shape === '__defaults') { render(); return openDefaultFormulas(section); }
  const inp = S.bv.budget.inputs || {}, bl = inp.baseline || {};
  const lines = new Map((S.bv.lines || []).map((l) => [l.gl_code, l]));
  const glShape = { ...(bl.glShape || {}) }; let n = 0, skipped = 0;
  for (const a of S.state.coa) {
    if (a.kind !== 'detail' || a.section !== section) continue;
    const l = lines.get(a.code);
    if (!l || l.override || !l.driver || !['baseline', 'dropped'].includes(l.driver.method)) { if (l && l.months.some((v) => v)) skipped++; continue; }
    if (shape === '__clear') { if (glShape[a.code] != null) { delete glShape[a.code]; n++; } } else { glShape[a.code] = shape; n++; }
  }
  // never a silent nothing: say why no line took it
  if (!n) { alert(shape === '__clear' ? 'No line in this section has a formula picked on this budget.' : `No line in this section could take that formula: ${skipped} line${skipped === 1 ? ' is' : 's are'} hand-typed or built by their own formula (corporate rate, fee, suggestion). Release a hand-typed line first (row menu: Reset to engine formula).`); render(); return; }
  if (shape === 'turns' && !budgetHasExpirations()) alert('This budget has no lease expirations yet (rent roll, typed expirations or the Yardi template). The turnover curve has nothing to follow, so these lines stay flat until expirations are loaded.');
  pushUndo();
  S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...bl, glShape } } });
  render();
  toastMsg(`${n} line${n === 1 ? '' : 's'} set${skipped ? `, ${skipped} hand-typed / own-formula left alone` : ''}`);
}
function budgetHasExpirations() {
  return (S.bv.lines || []).some((l) => l.driver && l.driver.shape === 'turns' && l.driver.turns > 0) || ((S.bv.budget.inputs || {}).expirations || []).some((v) => v) || (S.bv.leaseCount || 0) > 0 || ((S.bv.template || {}).leaseExpirations || []).some((v) => v);
}
function toastMsg(text) {
  let t = document.getElementById('toast-msg');
  if (!t) { t = document.createElement('div'); t.id = 'toast-msg'; t.style.cssText = 'position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background:#1f2937; color:#fff; padding:8px 14px; border-radius:8px; font-size:13px; z-index:9999; box-shadow:0 4px 14px rgba(0,0,0,.25)'; document.body.appendChild(t); }
  t.textContent = text; t.style.display = 'block';
  clearTimeout(toastMsg.h); toastMsg.h = setTimeout(() => { t.style.display = 'none'; }, 4000);
}

/* ---- DEFAULT FORMULAS (Troy 2026-11-11: "If I am able to change default curves used, it is entirely too
   difficult to find... those changes should flow through into anyone using default templates as well").
   One screen, opened from the dashboard, the budget toolbar, the More menu and every section's formula
   pick. Per GL: the default formula and the seasonal curve; one pick per section sets them all. Saved for
   everyone; budgets not on a named saved set take it at their next recalculation (offered right after). ---- */
async function openDefaultFormulas(focusSection) {
  let dlg = document.getElementById('dform-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'dform-dlg'; dlg.style.width = 'min(980px, 96vw)'; document.body.appendChild(dlg); }
  dlg.innerHTML = '<h2>Default formulas</h2><span class="muted">Loading…</span>'; dlg.showModal();
  let d;
  try { d = await GET('/default-formulas'); } catch (e) { dlg.innerHTML = `<h2>Default formulas</h2><div class="err">${esc(e.message)}</div><div class="foot"><button class="btn sub" id="df-x">Close</button></div>`; dlg.querySelector('#df-x').addEventListener('click', () => dlg.close()); return; }
  const admin = !!(S.auth && S.auth.isAdmin);
  const label = shapeLabel;
  const secs = [];
  for (const r of d.rows) { let s = secs.find((x) => x.key === r.section); if (!s) { s = { key: r.section, name: r.sectionName, rows: [] }; secs.push(s); } s.rows.push(r); }
  const dis = admin ? '' : 'disabled';
  const codes = (list) => list.map((x) => `${esc(String(x.code).toUpperCase())} ${x.year}`).join(', ');
  dlg.innerHTML = `<h2>Default formulas <span class="muted" style="font-weight:400; font-size:13px">— how each line is built when nobody picked otherwise</span></h2>
    <p class="muted" style="font-size:12px; margin:0 0 8px">Shared by everyone. <b>Applies to ${d.follow.length} budget${d.follow.length === 1 ? '' : 's'}</b> on the defaults${d.follow.length ? ` (${codes(d.follow)})` : ''} and to every budget started on them later. A formula picked on a budget itself (row, section or Formula for lines) still wins there, and hand-typed lines never move.${d.named.length ? ` <b>Not touched:</b> ${d.named.length} budget${d.named.length === 1 ? '' : 's'} on a named saved set (${d.named.map((x) => `${esc(String(x.code).toUpperCase())} ${x.year}`).join(', ')}).` : ''} ${admin ? 'Saving shows each budget\'s NOI before and after; nothing recalculates until you confirm.' : 'Only an admin can change these.'}</p>
    <div class="row" style="margin-bottom:6px"><input id="df-q" placeholder="find a line or section…" style="flex:1; border:1px solid var(--line); border-radius:6px; padding:5px 8px">
      <span class="muted" style="font-size:12px">Seasonal curve is used by “T12 on the seasonal curve”.</span></div>
    <div id="df-body" style="max-height:56vh; overflow:auto; border:1px solid var(--line); border-radius:8px; padding:4px 10px">
      ${secs.map((s) => `<div class="df-sec" data-sec="${esc(s.key)}">
        <div style="display:flex; align-items:center; gap:8px; margin:10px 0 4px; position:sticky; top:0; background:var(--card, #fff); padding:3px 0"><b style="text-transform:uppercase; font-size:12px; color:var(--dim)">${esc(s.name)}</b> <span class="muted" style="font-size:11.5px">${s.rows.length} lines</span>
          <select data-secset="${esc(s.key)}" ${dis} style="margin-left:auto"><option value="">set the whole section to…</option>${SEC_SHAPES.map(([k, t]) => shapeOpt(k, t)).join('')}<option value="__none">not set (built-in)</option></select></div>
        <table class="list" style="margin:0">${s.rows.map((r) => `<tr data-row="${r.gl}" data-find="${esc((r.gl + ' ' + r.name + ' ' + s.name).toLowerCase())}"><td style="width:46%">${r.gl} ${esc(r.name)}</td>
          <td><select data-df="${r.gl}" data-was="${r.shape || ''}" ${dis}><option value="" ${r.shape ? '' : 'selected'}>not set — built-in: ${label(r.builtin)}${r.grks && r.grks !== r.builtin ? ` (old GRKS budgets: ${label(r.grks)})` : ''}</option>${[...SEC_SHAPES, ...RETIRED_SHAPES.filter((x) => x[0] === r.shape)].map(([k, t]) => shapeOpt(k, t, r.shape === k ? 'selected' : '')).join('')}</select></td>
          <td style="width:130px"><select data-cv="${r.gl}" data-was="${esc(r.curve)}" ${dis} title="The seasonal curve of this GL">${d.curves.map((c) => `<option value="${c}" ${r.curve === c ? 'selected' : ''}>${c} curve</option>`).join('')}</select></td></tr>`).join('')}</table></div>`).join('')}
    </div>
    <div class="err" id="df-err"></div>
    <div class="foot"><span class="muted" id="df-n" style="margin-right:auto; font-size:12px"></span><button class="btn sub" id="df-x">Close</button>${admin ? ' <button class="btn" id="df-go">Save defaults</button>' : ''}</div>`;
  const q = (s) => dlg.querySelector(s);
  const changed = () => ({
    shapes: Object.fromEntries([...dlg.querySelectorAll('[data-df]')].filter((x) => x.value !== x.dataset.was).map((x) => [x.dataset.df, x.value])),
    curves: Object.fromEntries([...dlg.querySelectorAll('[data-cv]')].filter((x) => x.value !== x.dataset.was).map((x) => [x.dataset.cv, x.value])),
  });
  const count = () => { const c = changed(); const n = Object.keys(c.shapes).length + Object.keys(c.curves).length; q('#df-n').textContent = n ? `${n} change${n === 1 ? '' : 's'} not saved yet` : ''; dlg.querySelectorAll('[data-df],[data-cv]').forEach((x) => { x.style.fontWeight = x.value !== x.dataset.was ? '700' : ''; }); };
  dlg.querySelectorAll('[data-df],[data-cv]').forEach((x) => x.addEventListener('change', count));
  dlg.querySelectorAll('[data-secset]').forEach((sel) => sel.addEventListener('change', () => {
    const v = sel.value; if (!v) return;
    dlg.querySelectorAll(`.df-sec[data-sec="${sel.dataset.secset}"] [data-df]`).forEach((x) => { if (x.closest('tr').style.display !== 'none') x.value = v === '__none' ? '' : v; });
    sel.value = ''; count();
  }));
  q('#df-q').addEventListener('input', (e) => {
    const w = e.target.value.trim().toLowerCase();
    dlg.querySelectorAll('[data-row]').forEach((tr) => { tr.style.display = !w || tr.dataset.find.includes(w) ? '' : 'none'; });
    dlg.querySelectorAll('.df-sec').forEach((sec) => { sec.style.display = [...sec.querySelectorAll('[data-row]')].some((tr) => tr.style.display !== 'none') ? '' : 'none'; });
  });
  q('#df-x').addEventListener('click', () => dlg.close());
  if (focusSection) { const t = dlg.querySelector(`.df-sec[data-sec="${focusSection}"]`); if (t) t.scrollIntoView({ block: 'start' }); }
  const go = q('#df-go');
  if (go) go.addEventListener('click', async () => {
    const c = changed();
    if (!Object.keys(c.shapes).length && !Object.keys(c.curves).length) { q('#df-err').textContent = 'Nothing changed.'; return; }
    go.disabled = true;
    try {
      const r = await PUT('/default-formulas', c);
      await refreshState();
      dlg.close();
      const ids = (r.follow || []).map((x) => x.id);
      if (ids.length) openRecalcMany(ids);
      else alert('Saved. No budget is on the defaults right now; budgets started on them later will use this.');
    } catch (e) { q('#df-err').textContent = e.message; go.disabled = false; }
  });
}

/* ---- recalculate many budgets at once (dashboard): preview NOI before / after, then apply ---- */
async function openRecalcMany(ids) {
  let dlg = document.getElementById('recalc-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'recalc-dlg'; dlg.style.width = 'min(820px, 94vw)'; document.body.appendChild(dlg); }
  const coaName = new Map(S.state.coa.map((a) => [a.code, a.name]));
  const d = (v) => (Math.abs(v) < 0.5 ? '—' : (v > 0 ? '+' : '−') + money(Math.abs(v)));
  const paint = (r, done) => {
    dlg.innerHTML = `<h2>Recalculate ${ids.length} budget${ids.length === 1 ? '' : 's'}</h2>
      <p class="muted" style="font-size:12px; margin:0 0 8px">${done ? 'Done. Each budget that changed has a save point named "Before recalculating all".' : 'Preview: nothing is saved yet. Every formula is re-run on the current defaults and inputs; hand-typed lines stay as they are.'}</p>
      ${r ? `<div style="max-height:52vh; overflow:auto"><table class="list"><tr><th>Budget</th><th>Lines that move</th><th>NOI before</th><th>NOI after</th><th>Change</th><th>Biggest moves</th></tr>
        ${r.budgets.map((x) => `<tr><td>${esc(x.code)} ${x.year}${x.type === 'annual' ? '' : ' <span class="muted">Y1</span>'}</td><td>${x.lines}</td><td>${money(x.noiBefore)}</td><td>${money(x.noiAfter)}</td><td>${d(x.noiAfter - x.noiBefore)}</td><td class="muted" style="font-size:11.5px">${x.top.map((t) => `${t.gl} ${esc(String(coaName.get(t.gl) || '').slice(0, 18))} ${d(t.d)}`).join(' · ')}</td></tr>`).join('')}</table></div>` : '<span class="muted">Working…</span>'}
      <div class="err" id="rc-err"></div>
      <div class="row" style="justify-content:flex-end; margin-top:10px"><button class="btn sub" id="rc-x">Close</button>${r && !done ? ' <button class="btn" id="rc-go">Recalculate &amp; save</button>' : ''}</div>`;
    dlg.querySelector('#rc-x').addEventListener('click', () => dlg.close());
    const go = dlg.querySelector('#rc-go');
    if (go) go.addEventListener('click', async () => {
      go.disabled = true;
      try { const res = await POST('/budgets-recalc', { ids }); await refreshState(); render(); paint(res, true); }
      catch (e) { dlg.querySelector('#rc-err').textContent = e.message; go.disabled = false; }
    });
  };
  paint(null, false); dlg.showModal();
  try { paint(await POST('/budgets-recalc', { ids, dryRun: true }), false); }
  catch (e) { paint(null, false); dlg.querySelector('#rc-err').textContent = e.message; }
}

/* ---- one formula for many lines at once (Troy 2026-11-10: "I also can't apply a turn curve in bulk") ----
   Pick the formula, tick the lines (any sections). Writes baseline.glShape for each; hand-typed lines are not offered. */
const TURN_GLS = new Set(['6702', '6704', '6706', '6726', '6728', '6905', '6908', '6912', '6926', '7002', '7006', '7010', '7015']);
function openBulkFormula(b) {
  let dlg = document.getElementById('bshape-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'bshape-dlg'; dlg.style.width = 'min(860px, 94vw)'; document.body.appendChild(dlg); }
  const coaByCode = new Map(S.state.coa.map((a) => [a.code, a]));
  const bl = (S.bv.budget.inputs || {}).baseline || {};
  const cands = S.bv.lines
    .filter((l) => !l.override && l.driver && (l.driver.method === 'baseline' || l.driver.method === 'dropped' || (bl.glShape || {})[l.gl_code]) && Number(l.gl_code) >= 5100)
    .map((l) => { const a = coaByCode.get(l.gl_code) || {}; return { gl: l.gl_code, name: a.name || '', section: a.section || '', annual: sumM(l.months), tag: drvMeta(l).tag, turn: TURN_GLS.has(l.gl_code), shape: l.driver.shape || '' }; })
    .sort((x, y) => Number(x.gl) - Number(y.gl));
  const bySection = {};
  for (const c of cands) (bySection[c.section] = bySection[c.section] || []).push(c);
  const hasExp = (S.bv.lines || []).some((l) => l.driver && l.driver.shape === 'turns') || ((S.bv.budget.inputs || {}).expirations || []).some((v) => v) || (S.bv.leaseCount || 0) > 0 || ((S.bv.template || {}).leaseExpirations || []).some((v) => v);
  dlg.innerHTML = `
    <h2>Formula for lines</h2>
    <p class="muted" style="margin:0 0 8px; font-size:12px">Sets how the ticked lines are built from their own history, then recalculates. Each line keeps its increase %. Hand-typed lines are not listed. One Undo reverses it.</p>
    <div class="row">
      <div class="fld"><label>Formula</label><select id="bs-shape">${SEC_SHAPES.map(([k, t]) => shapeOpt(k, t, k === 'turns' ? 'selected' : '')).join('')}<option value="__clear">clear row choices (back to the formula set)</option></select></div>
      <div class="fld"><label title="How far the ticked lines lean toward their own trailing-12 months, with any formula. 0 = the formula's own months, 100 = the T12 months. Year totals do not change.">Fit to T12 %</label><input id="bs-fit" value="" placeholder="0" style="width:70px"></div>
      <span class="spacer" style="flex:1"></span>
      <button class="btn sub" id="bs-turn" title="The turn-cost lines: cleaning, painting, carpet, make-ready, appliance and flooring replacement">Turn lines</button>
      <button class="btn sub" id="bs-all">All</button>
      <button class="btn sub" id="bs-none">None</button>
    </div>
    ${hasExp ? '' : '<div class="err" style="margin-top:6px">No lease expirations on this budget yet (rent roll, typed expirations or the Yardi template): the turn curve has nothing to follow and those lines would fall back to flat.</div>'}
    <div style="max-height:46vh; overflow:auto; margin-top:10px; border:1px solid var(--line); border-radius:8px; padding:6px 10px">
      ${Object.entries(bySection).map(([sec, list]) => `
        <div style="margin:6px 0 2px"><label style="font-weight:650; font-size:12px; color:var(--dim); text-transform:uppercase"><input type="checkbox" data-sec="${esc(sec)}"> ${esc(sec.replace(/_/g, ' '))}</label></div>
        ${list.map((c) => `<label style="display:inline-block; width:49%; font-size:12.3px; padding:1px 0"><input type="checkbox" data-bs="${c.gl}" data-secof="${esc(c.section)}" data-turn="${c.turn ? 1 : 0}"> ${c.gl} ${esc(c.name.slice(0, 24))} <span class="muted">${money(c.annual)} · ${c.tag}</span></label>`).join('')}`).join('') || '<span class="muted">No history-based lines.</span>'}
    </div>
    <div class="err" id="bs-err"></div>
    <div class="foot"><button class="btn sub" id="bs-x">Cancel</button> <button class="btn" id="bs-go">Apply &amp; recalculate</button></div>`;
  const boxes = () => [...dlg.querySelectorAll('[data-bs]')];
  dlg.querySelector('#bs-turn').addEventListener('click', () => boxes().forEach((c) => { c.checked = c.dataset.turn === '1'; }));
  dlg.querySelector('#bs-all').addEventListener('click', () => boxes().forEach((c) => { c.checked = true; }));
  dlg.querySelector('#bs-none').addEventListener('click', () => boxes().forEach((c) => { c.checked = false; }));
  dlg.querySelectorAll('[data-sec]').forEach((s) => s.addEventListener('change', () => boxes().filter((c) => c.dataset.secof === s.dataset.sec).forEach((c) => { c.checked = s.checked; })));
  dlg.querySelector('#bs-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#bs-go').addEventListener('click', async () => {
    const shape = dlg.querySelector('#bs-shape').value;
    const gls = boxes().filter((c) => c.checked).map((c) => c.dataset.bs);
    if (!gls.length) { dlg.querySelector('#bs-err').textContent = 'Tick at least one line.'; return; }
    const cur = (S.bv.budget.inputs || {}).baseline || {};
    const glShape = { ...(cur.glShape || {}) };
    const fitRaw = String(dlg.querySelector('#bs-fit').value || '').trim();
    const fitV = fitRaw === '' ? null : parseFloat(fitRaw.replace(/[%,]/g, ''));
    if (fitV != null && (!Number.isFinite(fitV) || fitV < 0 || fitV > 100)) { dlg.querySelector('#bs-err').textContent = 'Fit to T12 is a % from 0 to 100.'; return; }
    const glFit = { ...(cur.glFit || {}) };
    for (const gl of gls) { if (shape === '__clear') { delete glShape[gl]; delete glFit[gl]; } else { glShape[gl] = shape; if (fitV != null) glFit[gl] = fitV / 100; } }
    try { pushUndo(); S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...cur, glShape, glFit } } }); dlg.close(); render(); }
    catch (e) { dlg.querySelector('#bs-err').textContent = e.message; }
  });
  dlg.showModal();
}

/* ---- copy the formulas of whole sections to other budgets / saved formula sets ---- */
function openCopyFormulasOut(b) {
  let dlg = document.getElementById('fpush-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'fpush-dlg'; document.body.appendChild(dlg); }
  const bv = S.bv, coa = S.state.coa, lines = new Map((bv.lines || []).map((l) => [l.gl_code, l]));
  const secs = [];
  for (const a of coa) {
    if (a.kind !== 'detail') continue;
    const l = lines.get(a.code);
    if (!l || !l.driver || !(zeroedLine(l) || (!l.override && ['baseline', 'zero'].includes(l.driver.method)))) continue;
    let s = secs.find((x) => x.key === a.section);
    if (!s) { const h = coa.find((x) => x.kind === 'header' && x.section === a.section); s = { key: a.section, name: h ? h.name : String(a.section).replace(/_/g, ' '), n: 0, shapes: new Set() }; secs.push(s); }
    s.n++; if (l.driver.shape) s.shapes.add(l.driver.shape);
  }
  const shapeTxt = (s) => [...s.shapes].map(shapeLabel).join(', ');
  const others = ((S.state && S.state.budgets) || []).filter((x) => x.budget_type === 'annual' && x.id !== b.id).sort((x, y) => (y.year - x.year) || String(x.property_code).localeCompare(String(y.property_code)));
  const sets = (S.state && S.state.formulaSets) || [];
  dlg.innerHTML = `<h2>Copy section formulas to other budgets</h2>
    <p class="muted" style="font-size:12px; margin:0 0 10px">Gives the way <b>${esc(String(b.property_code).toUpperCase())} ${b.year}</b> builds the lines in the sections you tick to the budgets you tick, then recalculates each one on its own history. <b>Only those sections move.</b> Hand-typed lines, dollars and everything else on the other budgets stay. Each budget gets a save point first.</p>
    <div class="cols">
      <div><h4>Sections from this budget</h4><div class="pick" id="fp-secs">${secs.map((s) => `<label title="${esc(shapeTxt(s))}"><input type="checkbox" value="${esc(s.key)}"> ${esc(s.name)} <span class="muted">· ${s.n} line${s.n === 1 ? '' : 's'}${s.shapes.size === 1 ? ' · ' + esc(shapeTxt(s)) : s.shapes.size > 1 ? ' · mixed' : ''}</span></label>`).join('') || '<span class="muted">No formula-driven lines.</span>'}</div>
        <label style="display:block; margin-top:8px; font-size:12.5px" title="Off: each line keeps the increase % it already has on the other budget. On: the % from this budget comes along, including a % typed on these section headers."><input type="checkbox" id="fp-pct"> Also copy the increase %</label></div>
      <div><h4>To these budgets <span class="muted" style="font-weight:400">— <a href="#" id="fp-all">all ${b.year}</a> · <a href="#" id="fp-none">none</a></span></h4><div class="pick" id="fp-buds">${others.map((x) => `<label><input type="checkbox" value="${x.id}" data-year="${x.year}"> ${esc(String(x.property_code).toUpperCase())} ${x.year}${x.label ? ' <span class="muted">· ' + esc(x.label) + '</span>' : ''}</label>`).join('') || '<span class="muted">No other annual budgets.</span>'}</div>
        ${sets.length ? `<h4 style="margin-top:8px">And these saved formula sets <span class="muted" style="font-weight:400">— for budgets started later</span></h4><div class="pick" id="fp-sets" style="max-height:90px">${sets.map((x) => `<label><input type="checkbox" value="${x.id}"> ${esc(x.name)}</label>`).join('')}</div>` : ''}</div>
    </div>
    <div id="fp-out" style="margin-top:10px; font-size:12.5px"></div>
    <div class="err" id="fp-err"></div>
    <div class="row" style="justify-content:flex-end; margin-top:10px"><button class="btn sub" id="fp-x">Close</button> <button class="btn sub" id="fp-prev">Preview</button> <button class="btn" id="fp-go">Apply &amp; recalculate</button></div>`;
  const q = (s) => dlg.querySelector(s), vals = (s) => [...dlg.querySelectorAll(s + ' input:checked')].map((i) => i.value);
  const setAll = (on, year) => dlg.querySelectorAll('#fp-buds input').forEach((i) => { i.checked = on && (!year || Number(i.dataset.year) === Number(year)); });
  q('#fp-all').addEventListener('click', (e) => { e.preventDefault(); setAll(true, b.year); });
  q('#fp-none').addEventListener('click', (e) => { e.preventDefault(); setAll(false); });
  q('#fp-x').addEventListener('click', () => dlg.close());
  const run = async (dryRun) => {
    q('#fp-err').textContent = '';
    const body = { sections: vals('#fp-secs'), budgetIds: vals('#fp-buds').map(Number), setIds: sets.length ? vals('#fp-sets').map(Number) : [], pct: q('#fp-pct').checked, dryRun };
    if (!body.sections.length) { q('#fp-err').textContent = 'Tick at least one section.'; return; }
    if (!body.budgetIds.length && !body.setIds.length) { q('#fp-err').textContent = 'Tick at least one budget or saved formula set.'; return; }
    if (!dryRun && !confirm(`Change ${body.budgetIds.length} budget${body.budgetIds.length === 1 ? '' : 's'}${body.setIds.length ? ` and ${body.setIds.length} saved set${body.setIds.length === 1 ? '' : 's'}` : ''}? Each budget gets a save point first.`)) return;
    q('#fp-out').innerHTML = '<span class="muted">Working…</span>';
    try {
      const r = await POST(`/budgets/${b.id}/copy-formulas`, body);
      const d = (v) => (Math.abs(v) < 0.5 ? '—' : (v > 0 ? '+' : '−') + money(Math.abs(v)));
      q('#fp-out').innerHTML = `<b>${dryRun ? 'Preview — nothing saved yet' : 'Done'}</b> · ${r.gls} line formulas from ${esc(r.from)}
        ${r.budgets.length ? `<table class="list" style="margin-top:6px"><tr><th>Budget</th><th>Formulas changed</th><th>Lines that move</th><th>NOI before</th><th>NOI after</th><th>Change</th><th></th></tr>
          ${r.budgets.map((x) => x.skipped ? `<tr><td>${esc(x.code)} ${x.year}</td><td colspan="6" class="muted">skipped — ${esc(x.skipped)}</td></tr>` : `<tr><td>${esc(x.code)} ${x.year}</td><td>${x.formulas}</td><td>${x.lines}</td><td>${money(x.noiBefore)}</td><td>${money(x.noiAfter)}</td><td>${d(x.noiAfter - x.noiBefore)}</td><td class="muted">${[x.locked ? `${x.locked} hand-typed line${x.locked === 1 ? '' : 's'} left alone` : '', x.stale ? 'was due a recalculation, so the change includes that' : ''].filter(Boolean).join('; ')}</td></tr>`).join('')}</table>` : ''}
        ${r.sets.length ? `<div style="margin-top:6px">Saved sets: ${r.sets.map((x) => `${esc(x.name)} (${x.formulas} formula${x.formulas === 1 ? '' : 's'})`).join(' · ')}</div>` : ''}`;
      if (!dryRun) await refreshState();
    } catch (e) { q('#fp-out').innerHTML = ''; q('#fp-err').textContent = e.message; }
  };
  q('#fp-prev').addEventListener('click', () => run(true));
  q('#fp-go').addEventListener('click', () => run(false));
  dlg.showModal();
}

/* the trailing-12 total on file for a GL (annual budgets) */
function rowT12(gl) { return ((((S.bv || {}).refs || []).find((r) => r.key === 'actual') || {}).byGl || {})[gl] || 0; }

/* ---- lines the template dropped (T12 at or under $1,000) ---- */
function droppedLines(bv) { return (bv.lines || []).filter((l) => !l.override && l.driver && l.driver.method === 'dropped'); }
function droppedChipHtml(bv) {
  const dr = droppedLines(bv);
  if (!dr.length) return '';
  const tot = dr.reduce((a, l) => a + Math.abs(l.driver.t12 || 0), 0);
  return `<button class="chip dropped-chip" id="dropped-open" title="Lines with trailing-12 history at or under $1,000 — the template's rule budgets them at ZERO. Click to see them and budget the ones you want.">${dr.length} lines dropped under $1K · $${money(tot)} of T12</button>`;
}
async function budgetDroppedLines(b, gls) {
  const inp = S.bv.budget.inputs || {};
  const bl = inp.baseline || {};
  const glShape = { ...(bl.glShape || {}) };
  for (const gl of gls) glShape[gl] = 'flat';
  pushUndo();
  S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...bl, glShape } } });
  render();
}
function openDroppedDialog(b) {
  const dr = droppedLines(S.bv);
  const name = (gl) => ((S.state.coa.find((a) => a.code === gl) || {}).name || '');
  let dlg = document.getElementById('dropped-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'dropped-dlg'; document.body.appendChild(dlg); }
  dlg.innerHTML = `<h2>Lines dropped under $1,000</h2>
    <p class="muted" style="font-size:12px; margin:0 0 8px">Monarch's template only budgets a "T12 ÷ 12" line when its trailing-12 is over $1,000. These had history under that, so they are at <b>zero</b>. Tick the ones to budget at their trailing-12 ÷ 12 (with the line's usual increase factor). Nothing changes unless you tick it.</p>
    <div style="max-height:340px; overflow:auto"><table class="list" style="font-size:12.5px">
      <tr><th></th><th>GL</th><th>Account</th><th style="text-align:right">T12</th></tr>
      ${dr.map((l) => `<tr><td><input type="checkbox" data-dgl="${l.gl_code}"></td><td>${l.gl_code}</td><td>${esc(name(l.gl_code))}</td><td style="text-align:right">${money(l.driver.t12 || 0)}</td></tr>`).join('')}
    </table></div>
    <div class="row" style="justify-content:space-between; margin-top:10px">
      <label><input type="checkbox" id="dr-all"> all ${dr.length}</label>
      <span><button class="btn sub" id="dr-x">Close</button> <button class="btn" id="dr-go">Budget the ticked lines</button></span>
    </div>`;
  dlg.querySelector('#dr-all').addEventListener('change', (e) => dlg.querySelectorAll('[data-dgl]').forEach((c) => { c.checked = e.target.checked; }));
  dlg.querySelector('#dr-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#dr-go').addEventListener('click', async () => {
    const gls = [...dlg.querySelectorAll('[data-dgl]:checked')].map((c) => c.dataset.dgl);
    dlg.close();
    if (gls.length) await budgetDroppedLines(b, gls);
  });
  dlg.showModal();
}

/* ---- calculated on older formulas? ---- */
function staleCalc(bv) { return !!bv.engineVersion && bv.budget.calc_version !== bv.engineVersion; }
function staleBannerHtml(bv) {
  if (!staleCalc(bv)) return '';
  const when = bv.budget.calc_at ? `last calculated ${new Date(bv.budget.calc_at).toLocaleString()}` : 'calculated before formula versions were tracked';
  return `<div class="stalebar" title="Stored lines only move when a budget is recalculated. Formulas or defaults have changed since this one was built, so some lines would come out different today.">
    ⚠ This budget was ${when}, on older formulas. Overrides are kept. <button class="btn sm" id="stale-recalc">↻ Recalc now</button></div>`;
}

/* ---- the defaults this budget is running on ---- */
function defaultsInUse(bv) {
  if (!bv.annual) return [];
  const inp = bv.budget.inputs || {};
  const tpl = bv.template || {};
  const lines = new Map((bv.lines || []).map((l) => [l.gl_code, l]));
  const t12 = ((bv.refs || []).find((r) => r.key === 'actual') || {}).byGl || {};
  const tot = (gl) => sumM((lines.get(gl) || {}).months || []);
  const pc = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
  const out = [];
  const add = (key, label, value, isDefault, warn) => out.push({ key, label, value, isDefault, warn: warn || '' });
  // growth
  const gp = (inp.baseline || {}).growthPct || {};
  const typed = [...Object.entries(gp).filter(([, v]) => v != null), ...Object.entries((inp.baseline || {}).secGrowth || {}).map(([k, v]) => [k.replace(/_/g, ' '), v])];
  const rf = inp.rulesFrom || null;
  add('fset', 'Formula set', rf ? `${rf.name}${rf.at ? ` · given ${new Date(rf.at).toLocaleDateString()}` : ''}` : 'none picked — running on the 2026 GRKS draft rules, the old silent default (More → Apply a saved formula set…)', !rf || rf.id === 'grks', !rf ? 'no formula set was chosen for this property' : '');
  add('growth', 'Increase factors', typed.length ? `typed: ${typed.map(([k, v]) => `cat ${k} ${pc(v, 1)}`).join(', ')}; the rest per GL from the formula set` : rf && rf.id !== 'grks' ? `per GL, from "${rf.name}"` : rf && rf.id == null ? 'template defaults: admin +5%, R&M +5%, rehab +5%, trash +7%, the rest 0%' : 'per GL, from the 2026 GRKS draft: admin +5%, supplies & contractors +10%, rehab +15%, utilities +5%, trash +7%, other income 0%', !typed.length && (!rf || rf.id === 'grks' || rf.id == null));
  if ((bv.t12Dead || []).length || (bv.t12Startup || []).length) add('startup', 'New-acquisition history', `${bv.t12Live} month${bv.t12Live === 1 ? '' : 's'} of operations annualized${(bv.t12Startup || []).length ? `; ${bv.t12Startup.join(', ')} left out as start-up` : '; no start-up month left out'}`, inp.startupExclude == null, (bv.t12Early || []).length ? `${bv.t12Early.join(' and ')} (month 2-3 of operations) are in the history — review` : '');
  if (bv.y1Plan) {
    const y = bv.y1Plan, span = y.months.length ? `${MONTHS[y.months[0]]}–${MONTHS[y.months[y.months.length - 1]]}` : '';
    const a = y.acq, after = a && a.afterIdx.length ? `${MONTHS[a.afterIdx[0]]}–${MONTHS[a.afterIdx[a.afterIdx.length - 1]]}` : '';
    add('y1plan', 'Year-1 plan', y.on
      ? `the whole year from the Year-1 budget: ${span} its amounts${after ? `, ${after} its same months a year earlier × the UW Year-2 trend${a.trendFrom === 'uw' ? '' : ' (no Year-2 column in the UW book: held flat)'}` : ''}; rows fitted ${Math.round((a ? a.fit : 0) * 100)}% to ${a ? a.postedMonths : 0} posted month${a && a.postedMonths === 1 ? '' : 's'} within each category, turn lines on the turn curve. Year 1 NOI ${money(y.y1Noi)} vs ${y.uwNoi != null ? 'UW ' + money(y.uwNoi) : 'plan ' + money(y.planNoi)} (${Math.abs(y.variance) < 1 ? 'ties' : (y.variance > 0 ? '+' : '−') + money(Math.abs(y.variance))})${y.locked.length ? `; ${y.locked.length} locked line${y.locked.length === 1 ? '' : 's'} differ from the plan` : ''}`
      : `off — ${span} run on this budget's own formulas. Year 1 NOI would be ${money(y.y1Noi)} vs ${y.uwNoi != null ? 'UW ' + money(y.uwNoi) : 'plan ' + money(y.planNoi)} (${(y.variance > 0 ? '+' : '−') + money(Math.abs(y.variance))})`,
      inp.y1Plan == null, !y.on || Math.abs(y.variance) >= 1 ? 'Year 1 does not land on the underwriting NOI' : '');
  }
  const drift = (inp.baseline || {}).costDrift;
  add('drift', 'Cost drift in the year', (drift ?? 0.03) ? `${pc(drift ?? 0.03, 1)} January to December on history-based expense lines; year totals unchanged` : 'off', drift == null);
  // LTL
  const l = inp.ltl || {};
  const dR = tpl.renewalPct ?? 0.65, dBR = 0.75, dBN = 1;
  const ltlDefault = Math.abs((l.renewalPct ?? dR) - dR) < 1e-9 && Math.abs((l.burnoffRenew ?? dBR) - dBR) < 1e-9 && Math.abs((l.burnoffNew ?? dBN) - dBN) < 1e-9;
  add('ltl', 'Loss to lease', l.mode === 'flat' ? 'held flat' : l.mode === 'ramp' ? 'ramp' : `renew ${pc(l.renewalPct ?? dR, 0)}, burnoff ${pc(l.burnoffRenew ?? dBR, 0)} on renewal / ${pc(l.burnoffNew ?? dBN, 0)} on move-in`, ltlDefault && (l.mode || 'leases') === 'leases');
  if (t12['5003']) out[out.length - 1].value += ` — year ${money(tot('5003'))} vs T12 ${money(t12['5003'])}`;
  // vacancy
  const vl = lines.get('5031') || {};
  const vAvg = (inp.vacancyPct || [])[0] || 0;
  const t12Vac = t12['4994'] ? Math.abs(t12['5031'] || 0) / t12['4994'] : null;
  add('vac', 'Vacancy', vl.override ? `typed by hand on the row (${money(tot('5031'))}); the average and the expirations shape are off` : `${pc(vAvg, 2)} annual average${t12Vac != null ? ` (T12 was ${pc(t12Vac, 2)})` : ''}, ${Math.round((inp.vacancyExpWeight ?? 1) * 100)}% on the move-out / carry-over curve`, !vl.override && t12Vac != null && Math.abs(vAvg - t12Vac) < 0.0006 && inp.vacancyExpWeight == null);
  // GPR base vs last posted
  const lastM = (bv.lastMonth || 10) - 1;
  const lastGpr = ((((bv.hist || {}).t12 || {}).cal || {})['4994'] || [])[lastM] || 0;
  const jan = ((lines.get('4994') || {}).months || [])[0] || 0;
  if (jan && lastGpr) add('gpr', 'GPR starting point', `${money(jan)} in ${(bv.monthLabels || MONTHS)[0]} vs ${money(lastGpr)} posted in the last actual month (${jan >= lastGpr ? '+' : ''}${pc(jan / lastGpr - 1, 1)})`, true, Math.abs(jan / lastGpr - 1) > 0.015 ? 'starts more than 1.5% away from what last posted' : '');
  // wages
  const w = lines.get('6402') || lines.get('6404') || {};
  const wd = w.driver || {};
  add('wages', 'Wages', wd.live ? `Payroll tab roster, every seat filled all year${wd.draft ? ' · raise entries NOT final' : ''}; half the raise in Feb, all from Mar` : inp.wageSource === 'manual' ? `own history × ${pc(inp.payrollRaisePct ?? 0.035, 1)}` : `no roster for this year: trailing-12 × ${pc(inp.payrollRaisePct ?? 0.035, 1)}`, !inp.wageSource, wd.draft ? 'raise entries are not finalized' : '');
  if (inp.burdenFrom && String(inp.burdenFrom).toLowerCase() !== String(bv.budget.property_code).toLowerCase()) add('burdenfrom', 'Payroll ratios', `non-wage payroll lines take their % of wages and monthly shape from ${String(inp.burdenFrom).toUpperCase()}${bv.burdenSrc && bv.burdenSrc.period ? ` (${bv.burdenSrc.period})` : ''}`, false, bv.burdenSrc && !bv.burdenSrc.found ? `no statements on file for ${String(inp.burdenFrom).toUpperCase()} — using this property's own` : '');
  // management fee + tier check
  const fee = inp.mgmtPct || 0;
  let tierWarn = '';
  const mx = (tpl.mgmtFee || {}).matrix || {};
  const coc = (bv.kpis || {}).coc;
  if (coc != null && Object.keys(mx).length) {
    const steps = Object.entries(mx).map(([k, v]) => [parseFloat(k) / 100, v]).filter(([k]) => Number.isFinite(k)).sort((a, c) => a[0] - c[0]);
    let tier = null; for (const [k, v] of steps) if (coc + 1e-9 >= k) tier = v;
    if (tier != null && Math.abs(tier - fee) > 0.0005) tierWarn = `the template's tier table reads ${pc(tier, 0)} at ${pc(coc, 1)} cash-on-cash — verify`;
  }
  const fy = ((lines.get('6112') || {}).driver || {}).firstYear;
  add('fee', 'Management fee', fy ? `${pc(fy.pct, 2)} for the first 12 months of ownership (income through ${fy.through}), then ${pc(fee, 2)} — on prior-month income` : `${pc(fee, 2)} of prior-month income, flat all year`, !(inp.mgmtFirstYear), tierWarn);
  // corporate rates
  const cd = corpDefaults(bv.budget.year), cr = inp.corpRates || {};
  add('corp', 'Corporate rates', `insurance $${(cr[6108] || cd[6108]).perUnitYr}/unit · 6310 $${(cr[6310] || cd[6310]).perUnitYr}/unit + $${(cr[6310] || cd[6310]).flatMo}/mo · legal $${(cr[6320] || cd[6320]).perUnitYr} · marketing $${(cr[6560] || cd[6560]).perUnitYr}`, !Object.keys(cr).length,
    t12['6310'] && tot('6310') > 1.25 * t12['6310'] ? `6310 budgets ${money(tot('6310'))} vs ${money(t12['6310'])} posted` : '');
  // taxes
  if (t12['6116']) add('tax', 'Real estate taxes', `${money(tot('6116'))} (T12 ${money(t12['6116'])}, ${t12['6116'] ? pc(tot('6116') / t12['6116'] - 1, 1) : ''})`, Math.abs(tot('6116') - t12['6116']) < 1);
  // dropped
  const dr = droppedLines(bv);
  if (dr.length) add('dropped', 'Lines dropped under $1,000', `${dr.length} lines, $${money(dr.reduce((a, x) => a + Math.abs(x.driver.t12 || 0), 0))} of T12 budgeted at zero`, true);
  // special projects
  const spT12 = Object.entries(t12).filter(([c]) => +c > 7315 && +c < 7500).reduce((a, [, v]) => a + v, 0);
  const sp = (bv.kpis || {}).sp || 0;
  // required lines (Settings → Required budget lines): a zero one is flagged here and before export
  for (const r of missingRequired(bv)) add('req' + r.gl, `Required: ${r.gl} ${r.name}`, 'nothing budgeted', false, r.why || 'required on every budget');
  const ncon = (inp.contracts || []).length, nadj = (inp.t12Adjust || []).length;
  if (ncon) add('contracts', 'Known contracts', `${ncon} on ${new Set(inp.contracts.map((c) => c.gl)).size} GLs, $${money(inp.contracts.reduce((a, c) => a + contractAnnual(c, bv), 0))} a year`, false);
  if (nadj) add('onetime', 'One-time items out of the T12', `${nadj} items, $${money(inp.t12Adjust.reduce((a, x) => a + (Number(x.amount) || 0), 0))} removed`, false);
  if (bv.allocOut) add('alloc', 'Journal split', `${Math.round(bv.allocOut.pct * 10000) / 100}% of ${bv.allocOut.gls.join(', ')} to ${String(bv.allocOut.to).toUpperCase()} (engine-built lines; history lines already post net)`, inp.allocOut === undefined);
  add('sp', 'Special projects', `${money(sp)} budgeted${spT12 ? ` (T12 posted ${money(spT12)})` : ''} — cash flow and cash-on-cash are before special projects${(bv.kpis || {}).principal ? '' : ' and principal'}`, !sp, !sp && Math.abs(spT12) > 1000 ? 'none entered' : '');
  return out;
}
const defaultsHash = (items) => items.map((x) => `${x.key}=${x.value}`).join('|');
/* One quiet chip on the legend row; the list itself opens in a dialog on click. */
function defaultsChipHtml(bv) {
  const items = defaultsInUse(bv);
  if (!items.length) return '';
  const nWarn = items.filter((x) => x.warn).length;
  const ack = (bv.budget.inputs || {}).defaultsAck || null;
  const current = !!ack && ack.hash === defaultsHash(items);
  return `<button class="chip${nWarn ? ' dropped-chip' : ''}" id="defaults-open" title="What decided the numbers where nobody typed one — formula set, increase factors, loss to lease, vacancy, wages, fee, corporate rates. Click to see the list${current ? ' (reviewed)' : ''}.">defaults${nWarn ? ` · ${nWarn} to check` : ''}${current ? ' ✓' : ''}</button>`;
}
function openDefaultsDialog(b) {
  let dlg = document.getElementById('defaults-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'defaults-dlg'; document.body.appendChild(dlg); }
  const draw = () => {
    dlg.innerHTML = `${defaultsCardHtml(S.bv)}<div class="row" style="justify-content:flex-end; margin-top:8px"><button class="btn sub" id="dfl-x">Close</button></div>`;
    dlg.querySelector('#dfl-x').addEventListener('click', () => dlg.close());
    const ak = dlg.querySelector('#ack-defaults');
    if (ak) ak.addEventListener('click', async () => { S.bv = await POST(`/budgets/${b.id}/ack-defaults`, { hash: defaultsHash(defaultsInUse(S.bv)) }); draw(); render(); });
  };
  draw();
  dlg.showModal();
}
function defaultsCardHtml(bv) {
  const items = defaultsInUse(bv);
  if (!items.length) return '';
  const ack = (bv.budget.inputs || {}).defaultsAck || null;
  const current = !!ack && ack.hash === defaultsHash(items);
  const nDef = items.filter((x) => x.isDefault).length, nWarn = items.filter((x) => x.warn).length;
  return `<div class="card defaults">
    <h2>Defaults in use <span class="badge">${nDef} not set for this property</span>${nWarn ? ` <span class="pill miss">${nWarn} to check</span>` : ''}</h2>
    <p class="muted" style="margin:0 0 6px; font-size:11.5px">What decided the numbers where nobody typed one. <span class="dflt">default</span> = nobody chose it for this property.</p>
    <table class="dfl">${items.map((x) => `<tr><td class="k">${esc(x.label)} ${x.isDefault ? '<span class="dflt">default</span>' : '<span class="set">set</span>'}</td><td>${esc(x.value)}${x.warn ? `<div class="warn">⚠ ${esc(x.warn)}</div>` : ''}</td></tr>`).join('')}</table>
    <div class="row" style="margin-top:8px; justify-content:space-between; align-items:center">
      <span class="muted" style="font-size:11.5px">${current ? `✓ reviewed by ${esc(ack.by)} · ${new Date(ack.at).toLocaleDateString()}` : ack ? `⚠ changed since ${esc(ack.by)} reviewed them on ${new Date(ack.at).toLocaleDateString()}` : 'not reviewed yet'}</span>
      ${current ? '' : '<button class="btn sm" id="ack-defaults" title="Record that you have looked at these and accept them for this property. Nothing is recalculated.">I have reviewed these</button>'}
    </div></div>`;
}

/* ---- 2027 notes pass (Troy 2026-11-11): required lines, contracts, one-time items, fee schedule ---- */
function missingRequired(bv) {
  if (!bv || !bv.annual) return [];
  const req = (S.state && S.state.requiredLines) || [];
  const coa = new Map(((S.state && S.state.coa) || []).map((a) => [a.code, a]));
  return req.filter((r) => { const l = (bv.lines || []).find((x) => x.gl_code === r.gl); return !l || !l.months.some((v) => Math.abs(v) >= 0.5); })
    .map((r) => ({ ...r, name: (coa.get(r.gl) || {}).name || '' }));
}
/* mirrors contractMonths() in shared/annual.ts (calendar-year view), keep in step */
function contractCal(c, units) {
  const billed = (c.months && c.months.length ? c.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map(Number);
  const amt = Number(c.amount) || 0;
  return Array.from({ length: 12 }, (_, i) => {
    const cal = i + 1;
    let v = 0;
    if (c.kind === 'annual') v = cal === Number(c.billMonth || 1) ? amt : 0;
    else if (!billed.includes(cal)) v = 0;
    else if (c.kind === 'perUnit') v = (amt * (units || 0)) / billed.length;
    else v = c.per === 'total' ? amt / billed.length : amt;
    return v * (c.stepMonth && c.stepPct && cal >= Number(c.stepMonth) ? 1 + Number(c.stepPct) : 1);
  });
}
const contractAnnual = (c, bv) => sumM(contractCal(c, Number(((bv || S.bv).budget.inputs || {}).units) || 0));
function glDatalist() {
  return `<datalist id="gl-dl">${((S.state && S.state.coa) || []).filter((a) => a.kind === 'detail').map((a) => `<option value="${a.code}">${esc(a.name)}</option>`).join('')}</datalist>`;
}
const glName = (gl) => (((S.state && S.state.coa) || []).find((a) => a.code === gl) || {}).name || '';
/* wage GLs (mirrors WAGE_GLS in shared/domain.ts): a payroll line that is not one of these is a % of wages */
const BUDGET_WAGE_GLS = ['6402', '6404', '6405', '6407'];
/* One payroll line's % of wages from other properties (Troy 2026-11-12: "take the ratio from Minot or BCND/ECND to
   calculate the FHND pre-acquisition months for 401K contributions, as sites like Minot will have annual spikes
   reflected, whereas FHND wont"). Properties grouped by region; ticking a region ticks all of its properties.
   Several = pooled (their wages and this GL added month by month). Saves inputs.burdenFromGl[gl] and recalculates;
   a shape picked on the row for this GL is dropped so the ratio governs. */
function openBurdenFrom(b, gl, acc) {
  const dlg = ensureDlg('bfrom-dlg');
  const inp = S.bv.budget.inputs || {};
  const own = String(b.property_code).toLowerCase();
  const cur = new Set(((inp.burdenFromGl || {})[gl] || []).map((c) => String(c).toLowerCase()));
  const withStmt = new Set((S.state.stmtSnapshots || []).filter((x) => x.kind === 'actual').map((x) => String(x.property_code).toLowerCase()));
  const props = (S.state.properties || []).filter((p) => String(p.code).toLowerCase() !== own);
  const regions = [...new Set(props.map((p) => p.market || 'Other'))].sort();
  const src = (S.bv.burdenGlSrc || {})[gl];
  dlg.innerHTML = `<h2>${esc(gl)} ${esc(acc.name || '')}: % of wages from other properties</h2>
    <p class="muted" style="font-size:12px; margin:0 0 8px">This line = the picked properties' ${esc(gl)} as a % of their wages, month by month (so an annual true-up or a quarterly bonus lands in the same month here), × this property's own budgeted wages. Several properties are pooled. Only this line changes; the other payroll lines keep their own ratios. Properties with no actual statement on file can't be used.</p>
    ${src && src.missing && src.missing.length ? `<p class="err" style="font-size:12px">No statements on file for ${esc(src.missing.join(', ').toUpperCase())} — left out of the pool.</p>` : ''}
    <div style="max-height:52vh; overflow:auto; border:1px solid var(--line); border-radius:6px; padding:6px 10px">
      ${regions.map((rg) => {
        const ps = props.filter((p) => (p.market || 'Other') === rg);
        const usable = ps.filter((p) => withStmt.has(String(p.code).toLowerCase()));
        return `<div style="margin:6px 0">
          <label style="font-weight:700"><input type="checkbox" data-bfreg="${esc(rg)}" ${usable.length && usable.every((p) => cur.has(String(p.code).toLowerCase())) ? 'checked' : ''} ${usable.length ? '' : 'disabled'}> ${esc(rg)} <span class="muted" style="font-weight:400">(all ${usable.length})</span></label>
          <div style="display:flex; flex-wrap:wrap; gap:4px 14px; margin:3px 0 0 22px">${ps.map((p) => { const c = String(p.code).toLowerCase(), ok = withStmt.has(c); return `<label title="${ok ? '' : 'no actual statement on file'}" class="${ok ? '' : 'muted'}"><input type="checkbox" data-bfp="${esc(c)}" data-bfr="${esc(rg)}" ${cur.has(c) ? 'checked' : ''} ${ok ? '' : 'disabled'}> ${esc(c.toUpperCase())}${p.name && p.name.toLowerCase() !== c ? ` · ${esc(p.name)}` : ''}</label>`; }).join('')}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="row" style="justify-content:space-between; margin-top:10px">
      <span>${cur.size ? '<button class="btn sub" id="bf-own">Use this property\'s own history</button>' : ''}</span>
      <span><button class="btn sub" id="bf-x">Cancel</button> <button class="btn" id="bf-save">Save &amp; recalculate</button></span>
    </div>`;
  dlg.querySelectorAll('[data-bfreg]').forEach((rb) => rb.addEventListener('change', () => {
    dlg.querySelectorAll(`[data-bfr="${CSS.escape(rb.dataset.bfreg)}"]:not(:disabled)`).forEach((c) => { c.checked = rb.checked; });
  }));
  dlg.querySelectorAll('[data-bfp]').forEach((c) => c.addEventListener('change', () => {
    const rb = dlg.querySelector(`[data-bfreg="${CSS.escape(c.dataset.bfr)}"]`);
    const all = [...dlg.querySelectorAll(`[data-bfr="${CSS.escape(c.dataset.bfr)}"]:not(:disabled)`)];
    if (rb) rb.checked = all.length > 0 && all.every((x) => x.checked);
  }));
  const save = async (codes) => {
    const map = { ...(inp.burdenFromGl || {}) };
    if (codes.length) map[gl] = codes; else delete map[gl];
    const bl = inp.baseline || {};
    const glShape = { ...(bl.glShape || {}) }; delete glShape[gl];   // the ratio governs this line, not a row shape
    dlg.close();
    try { await saveInputs(b, { burdenFromGl: map, baseline: { ...bl, glShape } }); } catch (e) { alert(e.message); }
  };
  dlg.querySelector('#bf-x').addEventListener('click', () => dlg.close());
  { const o = dlg.querySelector('#bf-own'); if (o) o.addEventListener('click', () => save([])); }
  dlg.querySelector('#bf-save').addEventListener('click', () => {
    const codes = [...dlg.querySelectorAll('[data-bfp]:checked')].map((c) => c.dataset.bfp);
    if (!codes.length) { alert('Tick at least one property, or use this property\'s own history.'); return; }
    save(codes);
  });
  dlg.showModal();
}
function ensureDlg(id) {
  let dlg = document.getElementById(id);
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = id; document.body.appendChild(dlg); }
  return dlg;
}
async function saveInputs(b, patch) {
  pushUndo();
  S.bv = await PUT(`/budgets/${b.id}`, { inputs: patch });
  render();
}

/* Contracts & known costs: each row sets (or adds to) one GL. */
function openContracts(b) {
  const dlg = ensureDlg('contracts-dlg');
  const units = Number((S.bv.budget.inputs || {}).units) || 0;
  let rows = JSON.parse(JSON.stringify((S.bv.budget.inputs || {}).contracts || []));
  const blank = () => ({ id: String(Date.now()), vendor: '', gl: '', kind: 'monthly', amount: 0, per: 'month', months: [], billMonth: 12, stepMonth: null, stepPct: null, mode: 'replace', source: '' });
  const monthsBox = (r, i) => `<span class="mbox">${MONTHS.map((m, k) => `<label title="${m}"><input type="checkbox" data-mo="${i}:${k + 1}" ${(r.months || []).includes(k + 1) ? 'checked' : ''}>${m[0]}</label>`).join('')}</span>`;
  const draw = () => {
    dlg.innerHTML = `<h2>Contracts & known costs</h2>
      <p class="muted" style="font-size:12px; margin:0 0 8px">A GL with a contract takes the contract amounts instead of its history (<b>replace</b>), or the contract on top of its formula (<b>add</b>). Amounts are positive for income and expense. No months ticked = every month. Snow: <b>monthly</b>, <b>season total</b>, Nov–Apr ticked. Months still inside an acquisition's Year 1 keep the Year-1 plan.</p>
      ${glDatalist()}
      <div style="max-height:60vh; overflow:auto"><table class="list contracts">
        <tr><th>Vendor</th><th>GL</th><th>How it bills</th><th>Amount</th><th>Months billed / invoice month</th><th>Step from · %</th><th>Line</th><th>Source</th><th>Year</th><th></th></tr>
        ${rows.map((r, i) => `<tr>
          <td><input data-f="vendor" data-i="${i}" value="${esc(r.vendor)}" style="width:110px"></td>
          <td><input data-f="gl" data-i="${i}" value="${esc(r.gl)}" list="gl-dl" style="width:58px" title="${esc(glName(r.gl))}"><div class="muted" style="font-size:10.5px; max-width:110px">${esc(glName(r.gl))}</div></td>
          <td><select data-f="kind" data-i="${i}"><option value="monthly" ${r.kind === 'monthly' ? 'selected' : ''}>monthly</option><option value="annual" ${r.kind === 'annual' ? 'selected' : ''}>annual invoice</option><option value="perUnit" ${r.kind === 'perUnit' ? 'selected' : ''}>$/unit/yr</option></select>
            ${r.kind === 'monthly' ? `<select data-f="per" data-i="${i}"><option value="month" ${r.per !== 'total' ? 'selected' : ''}>per month</option><option value="total" ${r.per === 'total' ? 'selected' : ''}>season total</option></select>` : ''}</td>
          <td><input data-f="amount" data-i="${i}" value="${r.amount || ''}" style="width:84px; text-align:right"></td>
          <td>${r.kind === 'annual' ? `<select data-f="billMonth" data-i="${i}">${MONTHS.map((m, k) => `<option value="${k + 1}" ${Number(r.billMonth) === k + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select>` : monthsBox(r, i)}</td>
          <td><select data-f="stepMonth" data-i="${i}"><option value="">—</option>${MONTHS.map((m, k) => `<option value="${k + 1}" ${Number(r.stepMonth) === k + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select>
            <input data-f="stepPct" data-i="${i}" value="${r.stepPct != null && r.stepPct !== '' ? +(r.stepPct * 100).toFixed(3) : ''}" placeholder="%" style="width:40px"></td>
          <td><select data-f="mode" data-i="${i}"><option value="replace" ${r.mode !== 'add' ? 'selected' : ''}>replace</option><option value="add" ${r.mode === 'add' ? 'selected' : ''}>add</option></select></td>
          <td><input data-f="source" data-i="${i}" value="${esc(r.source || '')}" placeholder="file / note" style="width:130px"></td>
          <td class="num">${money(sumM(contractCal(r, units)))}</td>
          <td><button class="btn sub sm" data-del="${i}" title="Remove">✕</button></td></tr>`).join('')}
      </table></div>
      <div class="row" style="justify-content:space-between; margin-top:8px">
        <button class="btn sub" id="ct-add">+ Contract</button>
        <span><button class="btn sub" id="ct-x">Cancel</button> <button class="btn" id="ct-save">Save & recalculate</button></span>
      </div>`;
    dlg.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => {
      const r = rows[Number(el.dataset.i)], f = el.dataset.f;
      if (f === 'amount') r.amount = Number(String(el.value).replace(/[$,]/g, '')) || 0;
      else if (f === 'stepPct') r.stepPct = el.value === '' ? null : (Number(el.value) || 0) / 100;
      else if (f === 'stepMonth' || f === 'billMonth') r[f] = el.value === '' ? null : Number(el.value);
      else r[f] = el.value.trim();
      draw();
    }));
    dlg.querySelectorAll('[data-mo]').forEach((el) => el.addEventListener('change', () => {
      const [i, m] = el.dataset.mo.split(':').map(Number);
      const set = new Set(rows[i].months || []);
      if (el.checked) set.add(m); else set.delete(m);
      rows[i].months = [...set].sort((a, c) => a - c);
      draw();
    }));
    dlg.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => { rows.splice(Number(el.dataset.del), 1); draw(); }));
    dlg.querySelector('#ct-add').addEventListener('click', () => { rows.push(blank()); draw(); });
    dlg.querySelector('#ct-x').addEventListener('click', () => dlg.close());
    dlg.querySelector('#ct-save').addEventListener('click', async () => {
      const bad = rows.filter((r) => !glName(r.gl) || !(Number(r.amount) > 0));
      if (bad.length && !confirm(`${bad.length} row(s) have no valid GL or amount and will be ignored. Save anyway?`)) return;
      dlg.close();
      await saveInputs(b, { contracts: rows });
    });
  };
  draw();
  dlg.showModal();
}

/* One-time items out of the trailing-12: GL, calendar month, amount removed, note. */
function openOneTime(b) {
  const dlg = ensureDlg('onetime-dlg');
  const start = Number((S.bv.budget.inputs || {}).startMonth) || 1;
  const t12 = (S.bv.hist && S.bv.hist.t12 && S.bv.hist.t12.cal) || {};
  const posted = (gl, cal) => { const m = t12[gl]; return m ? m[(cal - start + 12) % 12] : null; };   // hist is in budget-month order
  let rows = JSON.parse(JSON.stringify((S.bv.budget.inputs || {}).t12Adjust || []));
  const draw = () => {
    dlg.innerHTML = `<h2>One-time items out of the T12</h2>
      <p class="muted" style="font-size:12px; margin:0 0 8px">Each row takes the amount OFF that month's posted figure before any formula reads the history (shapes, growth, % of GPR / wages). The grid's T12 column still shows what posted; the line gets a −1X chip. Use the posted sign: an expense one-timer is positive.</p>
      ${glDatalist()}
      <table class="list">
        <tr><th>GL</th><th>Month</th><th class="num">Posted</th><th class="num">Remove</th><th class="num">Left</th><th>Why</th><th></th></tr>
        ${rows.map((r, i) => { const p = posted(r.gl, Number(r.month)); return `<tr>
          <td><input data-f="gl" data-i="${i}" value="${esc(r.gl)}" list="gl-dl" style="width:58px"><div class="muted" style="font-size:10.5px">${esc(glName(r.gl))}</div></td>
          <td><select data-f="month" data-i="${i}">${MONTHS.map((m, k) => `<option value="${k + 1}" ${Number(r.month) === k + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></td>
          <td class="num">${p == null ? '—' : money(p)}</td>
          <td><input data-f="amount" data-i="${i}" value="${r.amount || ''}" style="width:84px; text-align:right"></td>
          <td class="num">${p == null ? '' : money(p - (Number(r.amount) || 0))}</td>
          <td><input data-f="note" data-i="${i}" value="${esc(r.note || '')}" placeholder="e.g. CS utility finals" style="width:220px"></td>
          <td><button class="btn sub sm" data-del="${i}">✕</button></td></tr>`; }).join('')}
      </table>
      <div class="row" style="justify-content:space-between; margin-top:8px">
        <button class="btn sub" id="ot-add">+ Item</button>
        <span><button class="btn sub" id="ot-x">Cancel</button> <button class="btn" id="ot-save">Save & recalculate</button></span>
      </div>`;
    dlg.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => {
      const r = rows[Number(el.dataset.i)], f = el.dataset.f;
      r[f] = f === 'amount' ? Number(String(el.value).replace(/[$,]/g, '')) || 0 : f === 'month' ? Number(el.value) : el.value.trim();
      draw();
    }));
    dlg.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => { rows.splice(Number(el.dataset.del), 1); draw(); }));
    dlg.querySelector('#ot-add').addEventListener('click', () => { rows.push({ gl: '', month: (Number(S.bv.lastMonth) || 10), amount: 0, note: '' }); draw(); });
    dlg.querySelector('#ot-x').addEventListener('click', () => dlg.close());
    dlg.querySelector('#ot-save').addEventListener('click', async () => {
      dlg.close();
      await saveInputs(b, { t12Adjust: rows.filter((r) => glName(r.gl) && Number(r.amount)) });
    });
  };
  draw();
  dlg.showModal();
}

/* Flat-fee package schedule (utilities.feeSchedule). */
function openFeeSchedule(b) {
  const dlg = ensureDlg('feesched-dlg');
  const ut = (S.bv.budget.inputs || {}).utilities || {};
  const sch = JSON.parse(JSON.stringify(ut.feeSchedule || { fees: {}, units: {}, onFlatPct: 0, convertFrom: `${Number(S.bv.budget.year) - 1}-12` }));
  const flatOn = ut.billing ? ut.billing === 'flat' : !!S.bv.flatFeeSite;
  const beds = ['0', '1', '2', '3', '4'];
  dlg.innerHTML = `<h2>Flat-fee package schedule</h2>
    <p class="muted" style="font-size:12px; margin:0 0 8px">Reimbursement income = package fee × occupied units. Units still on RUBS pay what they paid in the last actual month until their lease expires (from the switch month on), then move to the fee. Split across the reimbursement GLs by the last actual month's mix. ${flatOn ? '' : '<b>This budget is not on flat-fee billing</b> — saving turns it on.'}</p>
    <table class="list"><tr><th>Bedrooms</th><th class="num">Package $/mo</th><th class="num">Units</th></tr>
      ${beds.map((k) => `<tr><td>${k === '0' ? 'Studio' : k + ' BR'}</td><td><input data-fee="${k}" value="${sch.fees[k] || ''}" style="width:70px; text-align:right"></td><td><input data-units="${k}" value="${sch.units[k] || ''}" style="width:60px; text-align:right"></td></tr>`).join('')}
    </table>
    <div class="row" style="gap:14px; margin-top:8px">
      <div class="fld"><label>Share of occupied units already on the fee (last actual month)</label><input id="fs-on" value="${+(Number(sch.onFlatPct || 0) * 100).toFixed(1)}" style="width:60px"> %</div>
      <div class="fld"><label>Leases switch at expiration from</label><input id="fs-from" type="month" value="${esc(sch.convertFrom || '')}"></div>
    </div>
    <div class="row" style="justify-content:space-between; margin-top:10px">
      <button class="btn sub" id="fs-clear" title="Back to the last-actual-month rule">Remove schedule</button>
      <span><button class="btn sub" id="fs-x">Cancel</button> <button class="btn" id="fs-save">Save & recalculate</button></span>
    </div>`;
  dlg.querySelector('#fs-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#fs-clear').addEventListener('click', async () => { dlg.close(); await saveInputs(b, { utilities: { ...ut, feeSchedule: null } }); });
  dlg.querySelector('#fs-save').addEventListener('click', async () => {
    const fees = {}, units = {};
    dlg.querySelectorAll('[data-fee]').forEach((el) => { const v = Number(el.value) || 0; if (v) fees[el.dataset.fee] = v; });
    dlg.querySelectorAll('[data-units]').forEach((el) => { const v = Number(el.value) || 0; if (v) units[el.dataset.units] = v; });
    const next = { fees, units, onFlatPct: Math.min(1, Math.max(0, (Number(dlg.querySelector('#fs-on').value) || 0) / 100)), convertFrom: dlg.querySelector('#fs-from').value || null };
    dlg.close();
    await saveInputs(b, { utilities: { ...ut, billing: 'flat', feeSchedule: next } });
  });
  dlg.showModal();
}

/* Quarter shift (Troy 2026-11-11): the NOI share each quarter should carry + the lines that carry it. */
function openQShift(b, targets) {
  const dlg = ensureDlg('qshift-dlg');
  const inp = S.bv.budget.inputs || {};
  const cur = inp.qShift || null;
  const coa = new Map(((S.state && S.state.coa) || []).map((a) => [a.code, a]));
  const lineBy = new Map((S.bv.lines || []).map((l) => [l.gl_code, l]));
  // never levers (mirrors qShiftLeverOk, shared/annual.ts): insurance, the fee, RE & PP taxes and payroll follow
  // a schedule; corporate rates / suggestions are corporate's; contracts, debt and typed lines were already out
  const SKIP = new Set(['manual', 'zero', 'dropped', 'contract', 'debtService', 'interest', 'mgmtPct', 'corpRate', 'suggested']);
  const FIXED_P = new Set(['6', '7', '8', '10']);
  // the lines that can carry it: operating expense GLs with dollars whose timing is a choice
  const cands = (S.bv.lines || []).filter((l) => { const n = Number(l.gl_code); return n >= 6101 && n <= 7069 && l.gl_code !== '6112' && !FIXED_P.has(String((coa.get(l.gl_code) || {}).pcode)) && !l.override && l.driver && !SKIP.has(l.driver.method) && sumM(l.months) > 0 && l.months.every((v) => v >= 0); })
    .map((l) => ({ gl: l.gl_code, name: (coa.get(l.gl_code) || {}).name || '', section: (coa.get(l.gl_code) || {}).section || '', annual: sumM(l.months) }))
    .sort((x, y) => Number(x.gl) - Number(y.gl));
  const bySec = {};
  for (const c of cands) (bySec[c.section] = bySec[c.section] || []).push(c);
  const picked = new Set((cur && cur.gls) || []);
  let vac = !!(cur && cur.vacancy);
  let inc = !!(cur && cur.increases);
  const t12 = (S.bv.hist && S.bv.hist.t12 && S.bv.hist.t12.cal) || {};   // budget-month order
  const qOf = (m) => [0, 1, 2, 3].map((q) => (m[q * 3] || 0) + (m[q * 3 + 1] || 0) + (m[q * 3 + 2] || 0));
  // the NOI change each quarter needs (mirrors qShiftTargets in shared/annual.ts)
  const needQ = () => {
    const N = nowQ.reduce((a, b) => a + b, 0); if (!N) return [0, 0, 0, 0];
    const free = [0, 1, 2, 3].filter((q) => t[q] == null);
    const setSum = t.reduce((a, v) => a + (v ?? 0), 0);
    const freeNow = free.reduce((a, q) => a + nowQ[q], 0);
    const sh = t.map((v, q) => (v != null ? v : freeNow ? (1 - setSum) * nowQ[q] / freeNow : (1 - setSum) / (free.length || 1)));
    return sh.map((v, q) => v * N - nowQ[q]);
  };
  /* RECOMMEND (Troy 2026-11-11: "look at expenses that are furthest dollar amounts below and above historical
     data, and recommend shifting those items"): each line's quarters against its own T12 quarters (scaled to
     the line's year); a quarter that needs MORE NOI favours lines budgeted ABOVE their history there, one that
     needs less favours lines BELOW it. Ticks the best until they cover the move one and a half times. */
  const recommend = () => {
    const d = needQ(); const need = d.reduce((a, v) => a + Math.max(0, v), 0);
    if (!need) return 0;
    const scored = cands.map((c) => {
      const l = lineBy.get(c.gl); const h = t12[c.gl]; if (!l || !h || !h.some((v) => v)) return null;
      const B = qOf(l.months), H = qOf(h), A = B.reduce((a, b) => a + b, 0), Ht = H.reduce((a, b) => a + b, 0);
      if (!A || !Ht) return null;
      const dev = B.map((v, q) => v - H[q] * (A / Ht));
      const score = dev.reduce((a, v, q) => a + (d[q] > 0 ? Math.max(0, v) : d[q] < 0 ? Math.max(0, -v) : 0), 0);
      return score > 1 ? { gl: c.gl, score } : null;
    }).filter(Boolean).sort((x, y) => y.score - x.score);
    picked.clear();
    let cov = 0;
    for (const x of scored) { if (cov >= need * 1.5 || picked.size >= 25) break; picked.add(x.gl); cov += x.score; }
    return picked.size;
  };
  // the increase over T12 sitting in Q1 across the history-based expense lines (the phase-in preset)
  const q1Increase = () => cands.reduce((a, c) => { const l = lineBy.get(c.gl), h = t12[c.gl]; if (!l || !h || !l.driver || l.driver.method !== 'baseline') return a; return a + [0, 1, 2].reduce((x, i) => x + Math.max(0, (l.months[i] || 0) - Math.max(0, h[i] || 0)), 0); }, 0);
  let t = [0, 1, 2, 3].map((q) => (targets[q] != null ? targets[q] : null));
  let rep = null, err = '';
  // NOI by quarter as it stands (the editor's own monthly NOI) until a preview comes back
  const nm = ((S.bv.kpis || {}).monthly || {}).noi || [];
  const nowQ = [0, 1, 2, 3].map((q) => (nm[q * 3] || 0) + (nm[q * 3 + 1] || 0) + (nm[q * 3 + 2] || 0));
  const q4 = (arr) => (arr || []).map((v) => money(v));
  const draw = () => {
    const before = rep ? rep.before : nowQ, after = rep ? rep.after : null;
    const tot = (a) => (a || []).reduce((x, y) => x + y, 0);
    dlg.innerHTML = `<h2>Shift NOI between quarters</h2>
      <p class="muted" style="font-size:12px; margin:0 0 8px">Type the share of the year's NOI a quarter should carry (blank quarters absorb the rest). Pick the lines that carry it: their dollars move between quarters, their year totals stay, and the year's NOI does not change. No quarter of a picked line drops below half its formula amount. Kept as a rule, so Recalc keeps the shares.</p>
      <div class="row" style="gap:10px">${[0, 1, 2, 3].map((q) => `<div class="fld"><label>Q${q + 1} share of NOI (%)</label><input data-tq="${q}" value="${t[q] != null ? +(t[q] * 100).toFixed(2) : ''}" placeholder="${before ? ((before[q] / tot(before)) * 100).toFixed(1) : '—'}" style="width:70px; text-align:right"></div>`).join('')}</div>
      <div class="row" style="gap:8px; margin:6px 0">
        <button class="btn sub sm" id="qs-rec" title="Tick the expense lines whose quarters sit furthest above / below their own T12, in the direction this shift needs, then preview">★ Recommend lines</button>
        <button class="btn sub sm" id="qs-phase" title="One click: take half of the Q1 expense increase over T12 and spread it over Q2–Q4 (Q1 NOI up, the year unchanged), then preview">Phase in: half of Q1's increase</button>
      </div>
      <div style="margin:4px 0"><label title="The lever is only each history-based expense line's increase over its own T12 month: Q1 can carry less of the increase, later quarters more. The T12 part never moves; no month goes below its T12"><input type="checkbox" id="qs-inc" ${inc ? 'checked' : ''}> <b>Phase in the expense increases</b> <span class="muted">— move only the increase over T12 between quarters</span></label></div>
      <div style="margin:4px 0 4px"><label title="The same annual vacancy average, landing in other quarters: moves rental income (and the fee with it)"><input type="checkbox" id="qs-vac" ${vac ? 'checked' : ''}> <b>Vacancy timing</b> <span class="muted">— same annual vacancy, more of it in some quarters</span></label></div>
      <div style="max-height:34vh; overflow:auto; border:1px solid var(--line); border-radius:8px; padding:6px 10px">
        ${Object.entries(bySec).map(([sec, list]) => `<div style="margin:6px 0 2px"><label style="font-weight:650; font-size:12px; color:var(--dim); text-transform:uppercase"><input type="checkbox" data-qsec="${esc(sec)}" ${list.every((c) => picked.has(c.gl)) ? 'checked' : ''}> ${esc(sec.replace(/_/g, ' '))}</label></div>
          ${list.map((c) => `<label style="display:flex; gap:6px; font-size:12px; padding-left:16px"><input type="checkbox" data-qgl="${c.gl}" ${picked.has(c.gl) ? 'checked' : ''}> <span style="width:44px">${c.gl}</span> <span style="flex:1">${esc(c.name)}</span> <span class="muted">${money(c.annual)}</span></label>`).join('')}`).join('') || '<p class="muted">No expense lines can carry a shift (typed, contract or empty).</p>'}
      </div>
      ${rep ? `<table class="list" style="margin-top:8px"><tr><th></th>${[0, 1, 2, 3].map((q) => `<th class="num">Q${q + 1}</th>`).join('')}<th class="num">Year</th></tr>
        <tr><td>NOI now</td>${q4(before).map((v, q) => `<td class="num">${v}<div class="muted" style="font-size:10.5px">${((before[q] / tot(before)) * 100).toFixed(1)}%</div></td>`).join('')}<td class="num">${money(tot(before))}</td></tr>
        <tr><td><b>After</b></td>${q4(after).map((v, q) => `<td class="num"><b>${v}</b><div class="muted" style="font-size:10.5px">${((after[q] / tot(after)) * 100).toFixed(1)}%</div></td>`).join('')}<td class="num">${money(tot(after))}</td></tr>
      </table>
      ${rep.capped ? `<div class="err">The picked lines carry only ${Math.round((rep.lam || 0) * 100)}% of this shift before a quarter reaches half its formula amount. Pick more lines (or vacancy timing) or ask for less.</div>` : !rep.landed ? '<div class="err">The shift does not fully land: typed lines or Year-1 plan months hold part of those quarters in place.</div>' : ''}
      ${(rep.moved || []).length ? `<details style="margin-top:4px"><summary class="muted" style="font-size:12px; cursor:pointer">What moves (${rep.moved.length} lines)</summary><table class="list">${rep.moved.map((m) => `<tr><td>${m.gl}</td><td>${esc(m.name)}</td>${m.after.map((v, q) => `<td class="num">${money(v)}<div class="muted" style="font-size:10px">${v - m.before[q] >= 0 ? '+' : ''}${money(v - m.before[q])}</div></td>`).join('')}</tr>`).join('')}</table></details>` : ''}` : ''}
      <div class="err" style="margin-top:6px">${esc(err)}</div>
      <div class="row" style="justify-content:space-between; margin-top:8px">
        <span>${cur ? '<button class="btn sub" id="qs-clear" title="Remove the shift: every line goes back to its own formula months">Remove shift</button>' : ''}</span>
        <span><button class="btn sub" id="qs-x">Close</button> <button class="btn sub" id="qs-prev">Preview</button> <button class="btn" id="qs-apply" ${rep && !rep.capped && rep.landed ? '' : 'disabled title="Preview first"'}>Apply</button></span>
      </div>`;
    dlg.querySelectorAll('[data-tq]').forEach((box) => box.addEventListener('change', () => { const v = parseFloat(String(box.value).replace(/[%\s]/g, '')); t[Number(box.dataset.tq)] = Number.isFinite(v) ? v / 100 : null; rep = null; draw(); }));
    dlg.querySelector('#qs-vac').addEventListener('change', (e) => { vac = e.target.checked; rep = null; draw(); });
    dlg.querySelector('#qs-inc').addEventListener('change', (e) => { inc = e.target.checked; rep = null; draw(); });
    dlg.querySelector('#qs-rec').addEventListener('click', async () => {
      if (!t.some((v) => v != null)) { err = 'Type the share for at least one quarter first (or use the phase-in button).'; draw(); return; }
      const n = recommend(); err = n ? '' : 'No expense line sits above / below its T12 in the direction this shift needs.';
      rep = null; draw(); if (n) await preview();
    });
    dlg.querySelector('#qs-phase').addEventListener('click', async () => {
      const N = nowQ.reduce((a, b) => a + b, 0), i1 = q1Increase();
      if (!N || !i1) { err = 'No expense increase over T12 sits in Q1 to phase in.'; draw(); return; }
      t = [Math.round(((nowQ[0] + i1 / 2) / N) * 1e6) / 1e6, null, null, null];
      inc = true; picked.clear(); err = ''; rep = null; draw(); await preview();
    });
    dlg.querySelectorAll('[data-qgl]').forEach((cb) => cb.addEventListener('change', () => { if (cb.checked) picked.add(cb.dataset.qgl); else picked.delete(cb.dataset.qgl); rep = null; draw(); }));
    dlg.querySelectorAll('[data-qsec]').forEach((cb) => cb.addEventListener('change', () => { for (const c of bySec[cb.dataset.qsec] || []) { if (cb.checked) picked.add(c.gl); else picked.delete(c.gl); } rep = null; draw(); }));
    dlg.querySelector('#qs-x').addEventListener('click', () => dlg.close());
    dlg.querySelector('#qs-prev').addEventListener('click', preview);
    dlg.querySelector('#qs-apply').addEventListener('click', async () => {
      try { pushUndo(); const r = await POST(`/budgets/${b.id}/qshift`, { ...body(), apply: true }); S.bv = r.view; dlg.close(); render(); }
      catch (e2) { S.undo.stack.pop(); err = e2.message; draw(); }
    });
    { const c = dlg.querySelector('#qs-clear'); if (c) c.addEventListener('click', async () => { pushUndo(); const r = await POST(`/budgets/${b.id}/qshift`, { clear: true, apply: true }); S.bv = r.view; dlg.close(); render(); }); }
  };
  const body = () => ({ targets: t, gls: [...picked], vacancy: vac, increases: inc });
  async function preview() {
    err = '';
    try { rep = (await POST(`/budgets/${b.id}/qshift`, body())).report; } catch (e2) { err = e2.message; rep = null; }
    draw();
  }
  draw();
  if (!dlg.open) dlg.showModal();
  // shares typed on the NOI row and nothing picked yet: recommend and preview straight away
  if (t.some((v) => v != null) && !picked.size && !vac && !inc && recommend()) { draw(); preview(); }
}

/* Recurring journal split (TPND → TPNDC). Off / site default / custom. */
function openAllocSplit(b) {
  const dlg = ensureDlg('split-dlg');
  const inp = S.bv.budget.inputs || {};
  const cur = S.bv.allocOut || { to: '', pct: 0, gls: [] };
  dlg.innerHTML = `<h2>Journal split to another property</h2>
    <p class="muted" style="font-size:12px; margin:0 0 8px">A share of these GLs moves to a companion property by recurring journal every month (TPND → TPNDC 41.11%: common electric, sewer, trash, water, insurance, management fee, RE tax). The split comes off lines the engine builds from scratch (corporate rate, fee, contracts); lines built from this property's own history already post net of the journal. ${S.bv.allocOutSite ? `Site default: ${Math.round(S.bv.allocOutSite.pct * 10000) / 100}% to ${S.bv.allocOutSite.to.toUpperCase()}.` : ''}</p>
    <div class="row" style="gap:12px">
      <div class="fld"><label>To property</label><input id="sp-to" value="${esc(cur.to || '')}" style="width:80px"></div>
      <div class="fld"><label>Share moved %</label><input id="sp-pct" value="${cur.pct ? +(cur.pct * 100).toFixed(4) : ''}" style="width:70px"></div>
      <div class="fld"><label>GLs (comma separated)</label><input id="sp-gls" value="${esc((cur.gls || []).join(', '))}" style="width:260px"></div>
    </div>
    <div class="row" style="justify-content:space-between; margin-top:10px">
      <span>${inp.allocOut !== undefined ? '<button class="btn sub" id="sp-def" title="Forget this budget\'s own setting">Use site default</button>' : ''} <button class="btn sub" id="sp-off">Turn off</button></span>
      <span><button class="btn sub" id="sp-x">Cancel</button> <button class="btn" id="sp-save">Save & recalculate</button></span>
    </div>`;
  dlg.querySelector('#sp-x').addEventListener('click', () => dlg.close());
  dlg.querySelector('#sp-off').addEventListener('click', async () => { dlg.close(); await saveInputs(b, { allocOut: null }); });
  { const d = dlg.querySelector('#sp-def'); if (d) d.addEventListener('click', async () => { dlg.close(); const next = { ...(S.bv.budget.inputs || {}) }; delete next.allocOut; pushUndo(); S.bv = await POST(`/budgets/${b.id}/restore`, { lines: S.bv.planLines || S.bv.lines, inputs: next }); S.bv = await POST(`/budgets/${b.id}/recalc`); render(); }); }
  dlg.querySelector('#sp-save').addEventListener('click', async () => {
    const to = dlg.querySelector('#sp-to').value.trim().toLowerCase();
    const pct = (Number(dlg.querySelector('#sp-pct').value) || 0) / 100;
    const gls = dlg.querySelector('#sp-gls').value.split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^\d{4}$/.test(x));
    if (!to || !(pct > 0 && pct < 1) || !gls.length) { alert('Enter a property, a share between 0 and 100%, and at least one GL.'); return; }
    dlg.close();
    await saveInputs(b, { allocOut: { to, pct, gls } });
  });
  dlg.showModal();
}

/* ---- before a Yardi export: say what is unfinished ---- */
function exportIssues(bv) {
  const issues = [];
  if (staleCalc(bv)) issues.push('It was calculated on older formulas (Recalc first).');
  if ((bv.lines || []).some((l) => l.driver && l.driver.draft)) issues.push('Wages use raise entries that are NOT finalized on the Payroll tab.');
  if (bv.annual && bv.guide) for (const it of bv.guide.items) if (it.must && (it.status === 'bad' || it.status === 'check')) issues.push(`Guidance — ${it.label}: ${it.value} (target ${it.target}).`);
  if (bv.annual) {
    const items = defaultsInUse(bv);
    const ack = (bv.budget.inputs || {}).defaultsAck || null;
    if (!ack) issues.push('The defaults in use have not been reviewed.');
    else if (ack.hash !== defaultsHash(items)) issues.push('The defaults in use changed after they were reviewed.');
    for (const x of items) if (x.warn && (x.key === 'fee' || x.key === 'sp' || x.key === 'startup' || x.key.startsWith('req'))) issues.push(`${x.label}: ${x.warn}.`);
  }
  return issues;
}
function okToExport(bv) {
  const issues = exportIssues(bv);
  return !issues.length || confirm(`Before this goes to Yardi:\n\n• ${issues.join('\n• ')}\n\nExport anyway?`);
}

/* ANNUAL tie card: growth targets per subtotal vs the reference. Nothing
   derives from an underwriting — each row shows the implied growth, takes a
   target %, and "tie" shifts that subtotal's growth factors to land there. */
/* the guidance checks that have no row in the tie card (Troy 2026-11-11: guidance goes WHERE THE
   TARGETS ARE, not in a separate pane) — one line each, only the ones that are off or worth seeing */
/* guidance direction (Troy 2026-11-12, the 2027 memo): income targets are floors, expense targets ceilings */
const GUIDE_EPS = 0.0005;   // rounding only: a line that shows as the target counts as on it (mirrors shared/annual.ts)
const GUIDE_INCOME_KEYS = new Set(['rental', 'income', 'egi', '1', 'ngpr', '4', '5', 'oth', 'noi']);
// expense / payroll CEILINGS (the memo's top of range; Settings -> Budget guidance), never under the target number
const expenseCeil = (G) => Math.max(G.expensePct, G.expenseMax ?? G.expensePct);
const payrollCeil = (G) => Math.max(G.payrollPct, G.payrollMax ?? G.payrollPct);
function guideNotesHtml(bv) {
  const g = bv.guide; if (!g) return '';
  const own = new Set(['noi', 'income', 'expense', 'rental', 'tax', 'payroll']);   // shown on their rows
  const icon = { ok: '<span class="gd ok">✓</span>', check: '<span class="gd check">!</span>', bad: '<span class="gd bad">✕</span>', info: '<span class="gd info">·</span>' };
  const items = g.items.filter((it) => !own.has(it.key));
  const q = g.quarters || [];
  return `<div class="gnotes">${items.map((it) => `<div class="gn ${it.status}" title="target ${esc(it.target)}">${icon[it.status] || ''} ${esc(it.label)}: <b>${esc(it.value)}</b> <span class="muted">(${esc(it.target)})</span></div>`).join('')}
    ${q.length === 4 ? `<div class="gn info" title="Rental income by quarter: Q1 should be aggressive; keep Q3 / Q4 achievable (no hockey stick)">${icon.info} Rental income Q1–Q4: ${q.map((v) => money(v)).join(' · ')}${g.q4VsQ1 != null ? ` <span class="muted">(Q4 ${g.q4VsQ1 > 0 ? '+' : ''}${(g.q4VsQ1 * 100).toFixed(1)}% vs Q1)</span>` : ''}</div>` : ''}
  </div>`;
}
/* the guidance numbers for the EMPTY target boxes (mirrors GT in tieGrowthHtml) */
function guidanceFill(bv) {
  const G = bv.guidance, inp = bv.budget.inputs || {};
  if (!G || bv.refKey === 'budget' || bv.refKey === 'uw') return {};
  const gt = inp.growthTargets || {};
  const byP = Object.fromEntries((bv.tieout.rows || []).map((r) => [r.pcode, r]));
  const refByGl = ((bv.refs || []).find((r) => r.key === 'actual') || {}).byGl || {};
  const r6 = (byP['6'] || {}).uw || 0, units = Number(inp.units) || 0;
  const insT = r6 && units ? ((G.insurancePerUnit * units) + (r6 - (refByGl['6108'] || 0))) / r6 - 1 : null;
  const GT = { rental: G.incomePct, income: G.incomePct, '4': G.incomePct, '5': G.incomePct, ...(insT != null ? { '6': insT } : {}), '8': G.reTaxPct, '10': G.payrollPct, '9': G.expensePct, '11': G.expensePct, '12': G.expensePct, '13': G.expensePct, '14': G.expensePct, opex: G.expensePct };
  const out = {};
  for (const [k, v] of Object.entries(GT)) if (gt[k] == null && (['rental', 'income', 'opex'].includes(k) || byP[k])) out[k] = Math.round(v * 100000) / 100000;
  return out;
}
function tieGrowthHtml(bv) {
  const inp = bv.budget.inputs || {};
  const refLabel = bv.refLabel || 'T12';
  const t = bv.tieout;
  const refKey = bv.refKey === 'budget' || bv.refKey === 'uw' ? bv.refKey : 'actual';
  const refByGl = ((bv.refs || []).find((r) => r.key === refKey) || {}).byGl || {};
  const SHORT = {
    '1': 'Gross Potential Rent', loss: 'Loss to Lease', '2': 'Concessions', '3': 'Vacancy, Delinq & Other Loss',
    '4': 'Utility Income', '5': 'Other Income', '6': 'Insurance', '7': 'Mgmt Fee', '8': 'RE & PP Taxes',
    '9': 'Admin & Acct', '10': 'Payroll', '11': 'Marketing', '12': 'Utilities', '13': 'R&M', '14': 'Rehab / Reserves',
  };
  const byP = Object.fromEntries(t.rows.map((r) => [r.pcode, r]));
  const t3 = ((bv.refs || []).find((r) => r.key === 'ann3') || {}).cat || null;
  // TIE BASIS (Troy 2026-11-12: "Need an option of which to tie to, T3 or T12. It can be a toggle"): on T3 the
  // Target column is growth over the T3 annualized, with its own saved targets (growthTargetsT3). Guidance is
  // growth over the October T12, so on T3 the boxes carry no guidance numbers (the Δ% T12 colours stay).
  const basisT3 = inp.tieBasis === 't3' && !!t3;
  const gt = (basisT3 ? inp.growthTargetsT3 : inp.growthTargets) || {};
  const agg =(ps, label) => {
    const budget = ps.reduce((a, p) => a + ((byP[p] || {}).budget || 0), 0);
    const uw = ps.reduce((a, p) => a + ((byP[p] || {}).uw || 0), 0);
    return { pcode: label, label, budget, uw, t3: t3 ? ps.reduce((a, p) => a + (t3.y1[p] || 0), 0) : null };
  };
  // T3 annualized (last 3 actual months × 4) beside the reference — display only, ties still use the reference
  const t3ref = (bv.refs || []).find((r) => r.key === 'ann3');
  const t3Of = (r) => (r.t3 !== undefined ? r.t3 : t3 ? (t3.y1[r.pcode] || 0) : null);
  const t3Cell = (r) => {
    if (!t3) return '';
    const v = t3Of(r);
    const g = v ? (r.budget - v) / v : null;
    return `<td class="t3" title="T3 annualized (${esc(t3ref.period)}) — budget is ${g == null ? '—' : `${g > 0 ? '+' : ''}${(g * 100).toFixed(1)}%`} vs it (Δ ${money(r.budget - (v || 0))})">${money(v)}</td>`;
  };
  // Δ% over the T3 annualized (Troy 2026-11-12: "Add column to comparison pane for delta over T3"): growth of the
  // signed T3, like the Δ% beside it. Display only — guidance and ties stay on the T12.
  const t3DeltaCell = (r, cls = '') => {
    if (!t3) return '';
    const v = t3Of(r);
    const g = v ? (r.budget - v) / v : null;
    return `<td class="t3d ${cls}" title="Budget vs T3 annualized (${esc(t3ref.period)}): Δ ${money(r.budget - (v || 0))}">${fmtPct(g)}</td>`;
  };
  // growth of the SIGNED reference: a contra line shrinking 10% reads −10%, like its target
  const pctOf = (r) => (r.uw ? (r.budget - r.uw) / r.uw : null);
  const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
  // the exec team's guidance (Settings → Budget guidance) lives in the target column: an empty box
  // shows the guidance range, and Δ% is coloured against it until a target is typed. Guidance is
  // growth over the October T12, so it only applies while the card compares to the T12.
  const G = bv.guidance || null;
  const useG = !!(G && bv.guide && bv.refKey !== 'budget' && bv.refKey !== 'uw');
  // UW for the calendar year (a new acquisition, Troy 2026-11-12: "making sure targets align to UW"): every row's
  // number is 0% over UW. Income rows green at or above it, expense and loss rows at or below; an empty box ties to it.
  const useU = bv.refKey === 'uw';
  // the Year-1 plan is laid over every unlocked NOI line last, so a tie here could not move anything (the server
  // refuses too): no tie buttons while the plan runs the year
  const canTie = !(bv.y1Plan && bv.y1Plan.on);
  const p1 = (v) => +(v * 100).toFixed(2);
  // ONE number per row (Troy 2026-11-11): what an empty box would be filled with
  const tol = G ? (G.tolerance ?? 0.0025) : 0.0025;
  const insT = (() => {   // insurance: the $/unit rate as a % over the T12 category (other pcode-6 lines held)
    const r6 = (byP['6'] || {}).uw || 0, g6108 = refByGl['6108'] || 0, units = Number(inp.units) || 0;
    return useG && r6 && units ? ((G.insurancePerUnit * units) + (r6 - g6108)) / r6 - 1 : null;
  })();
  const GT = useG ? {
    rental: G.incomePct, income: G.incomePct, '4': G.incomePct, '5': G.incomePct,
    ...(insT != null ? { '6': insT } : {}), '8': G.reTaxPct, '10': G.payrollPct,
    '9': G.expensePct, '11': G.expensePct, '12': G.expensePct, '13': G.expensePct, '14': G.expensePct,
    opex: G.expensePct,
  } : useU ? Object.fromEntries(['rental', 'income', '1', '2', '3', '4', '5', '6', '8', '9', '10', '11', '12', '13', '14', 'opex'].map((k) => [k, 0])) : {};
  // DIRECTION (Troy 2026-11-12, the 2027 memo): an income number is a floor (above it = green), an expense
  // number a ceiling (below it = green). GUIDE_EPS only absorbs rounding.
  const ceilOf = (k, v) => (!useG ? v : k === '10' ? payrollCeil(G) : ['9', '11', '12', '13', '14', 'opex'].includes(k) ? expenseCeil(G) : v);
  const GR = useG || useU ? Object.fromEntries(Object.entries(GT).map(([k, v]) => [k, GUIDE_INCOME_KEYS.has(k) ? [v - GUIDE_EPS, null] : [null, ceilOf(k, v) + GUIDE_EPS]])) : {};
  if (useG) GR.noi = [G.noiPct, null];
  if (useU) GR.noi = [-GUIDE_EPS, null];
  const gText = (k) => (k === 'noi' && useG ? `≥${p1(G.noiPct)}` : k === 'noi' && useU ? '≥0' : GT[k] != null ? `${p1(GT[k])}` : '');
  const gWhy = { income: 'total income', rental: 'rental income, as total income', opex: 'total expenses', noi: 'NOI (most important) — at least', '4': 'as total income', '5': 'as total income', '6': `insurance at $${G ? G.insurancePerUnit : 275}/unit`, '8': 'RE taxes: over actuals unless documented', '10': 'payroll on performing sites, lower where NOI growth is low', '9': 'as total expenses', '11': 'as total expenses', '12': 'as total expenses', '13': 'as total expenses', '14': 'as total expenses' };
  const fillable = basisT3 || !useG ? [] : Object.keys(GT).filter((k) => gt[k] == null && byKeyExists(k));
  const basisName = basisT3 ? 'T3 annualized' : refLabel;
  function byKeyExists(k) { return ['rental', 'income', 'opex'].includes(k) || !!byP[k]; }
  // key: a pcode, 'opex' or 'noi' → takes a target; null → display only
  // rows with no number of their own get the DERIVED guidance the Summary tab uses (sumGuide): GPR / net GPR /
  // other + utility at the income floor, loss to lease / concessions / vacancy no bigger a share of GPR, the fee no
  // faster than income (Troy 2026-11-12: "If there is not a direct category number, you should easily be able to derive one")
  const cardR = { cat: { '1': byP['1'] ? { ref: byP['1'].uw, bud: byP['1'].budget } : null, egi: { ref: t.egi.uw, bud: t.egi.budget } } };
  const row = (r, key, cls, dk) => {
    const g = pctOf(r);
    const v3 = t3 ? t3Of(r) : null;
    const g3 = v3 ? (r.budget - v3) / v3 : null;
    const gB = basisT3 ? g3 : g;   // growth on the basis the target is typed on
    const tgt = key != null && gt[key] != null ? gt[key] : null;
    const off = tgt != null && gB != null ? Math.abs(gB - tgt) : null;
    const offCls = off != null ? (off < 0.0015 ? 'good' : off > 0.01 ? 'bad' : '') : null;
    const gr = key != null ? GR[key] : null;
    const dg = useG && !gr ? sumGuide(G, dk || key, { ref: r.uw, bud: r.budget }, cardR) : null;
    const gIn = gr && g != null ? (gr[0] == null || g >= gr[0] - 1e-9) && (gr[1] == null || g <= gr[1] + 1e-9) : dg ? dg.ok : null;
    // a typed target colours the Δ% of its own basis; the Δ% T12 otherwise shows the guidance
    const vcls = !basisT3 && offCls != null ? offCls : gIn == null ? '' : gIn ? 'good' : 'bad';
    const v3cls = basisT3 && offCls != null ? offCls : '';
    const gBox = gr && !basisT3;   // the guidance number sits in an empty box only on the T12 basis
    const ph = gBox ? gText(key) : '%';
    const tip = `Growth target vs ${basisName} (%)${gBox ? (useU ? ` — empty = 0%, on the underwriting; type a number to use your own` : ` — exec-team guidance ${gText(key)}% (${gWhy[key]}); type a number to use your own`) : ''}`;
    // tie works off the typed target, or — with the box empty — the guidance number already in it (Troy 2026-11-11:
    // "why do I need to enter a target when we already have targets"). Offered only when the row is outside it.
    // NOI guidance is a floor (≥), not a point, so NOI still ties only to a typed number.
    const gPt = !basisT3 && key != null && tgt == null && GT[key] != null && gIn === false ? GT[key] : null;
    const tieTo = !canTie ? null : tgt != null ? (off == null || off >= 0.0015 ? tgt : null) : gPt;
    const tieBtn = tieTo != null ? `<button class="rb" data-tie="${key}" data-pct="${tieTo}" title="Shift this subtotal's growth factors so it lands at ${esc(basisName)} ${fmtPct(tieTo)}${tgt == null ? (useU ? ' (on UW)' : ' (the guidance)') : ''}">tie</button>` : '';
    const ub = uwBasisParts(bv, dk || key, r, { uwRef: useU, gpr: (byP['1'] || {}).budget || 0, egi: t.egi.budget || 0 });
    return `<tr class="${cls || ''}"><td title="${esc(r.label)}">${esc(SHORT[r.pcode] || r.label)}${ub.label}</td>
      <td>${money(r.uw)}</td>${t3Cell(r)}<td>${money(r.budget)}</td>
      <td class="var ${vcls}" title="Δ ${money(r.budget - r.uw)} vs ${esc(refLabel)}${dg ? ` · guidance: ${esc(dg.text)}` : ''}">${fmtPct(g)}</td>${t3DeltaCell(r, v3cls)}${ub.cell}
      <td class="tgt">${key != null ? `<input data-gt="${key}" value="${tgt != null ? (tgt * 100).toFixed(1) : ''}" placeholder="${esc(ph)}" class="${gBox ? 'gph' : ''}" style="width:${gr ? 58 : 48}px; font-size:11px; text-align:right" title="${esc(tip)}">` : ''}${tieBtn}</td></tr>`;
  };
  const cat = (p) => (byP[p] ? row(byP[p], p) : '');
  const nTargets = Object.keys(gt).filter((k) => gt[k] != null).length;
  const refShort = bv.refKey === 'budget' ? 'CY bud' : bv.refKey === 'uw' ? 'UW' : 'T12';
  return `<div class="tiewrap"><table${t3 ? ' class="t3"' : ''}>
    <tr><th>Subtotal</th><th title="${esc(refLabel)}">${refShort}</th>${t3 ? `<th title="T3 annualized — ${esc(t3ref.period)}">T3 ann</th>` : ''}<th>Budget</th><th title="Budget vs ${esc(refLabel)}">Δ%${t3 ? ` ${refShort}` : ''}</th>${t3 ? `<th title="Budget vs T3 annualized — ${esc(t3ref.period)}">Δ% T3</th>` : ''}${bv.uwBasis && bv.uwBasis.posted ? `<th title="${esc(bv.uwBasis.postedLabel)}, annualized — red where it runs worse than the UW target">Posted</th>` : ''}<th title="Growth target over the ${esc(basisName)}">Target${t3 ? ` vs ${basisT3 ? 'T3' : refShort}` : ''}</th></tr>
    ${cat('1')}${byP.loss ? row(byP.loss, null, '', 'loss') : ''}
    ${row(agg(['1', 'loss'], 'Net Gross Potential Rent'), null, 'sub', 'ngpr')}
    ${cat('2')}${cat('3')}
    ${row(agg(['1', 'loss', '2', '3'], 'Total Rental Income'), 'rental', 'sub')}
    ${cat('4')}${cat('5')}
    ${row(agg(['4', '5'], 'Total Other + Utility Inc'), null, 'sub', 'oth')}
    ${row({ ...t.egi, label: 'Total Income (EGI)', t3: t3 ? t3.egi : null }, 'income', 'big')}
    ${['6', '7', '8', '9', '10', '11', '12', '13', '14'].map((p) => (p === '7' ? (byP[p] ? row(byP[p], null, '', '7') : '') : cat(p))).join('')}
    ${row({ ...t.toe, label: 'Total OpEx', t3: t3 ? t3.toe : null }, 'opex', 'big')}
    ${row({ ...t.noi, label: 'NOI', t3: t3 ? t3.noi : null }, 'noi', 'big')}
  </table></div>
  ${useG ? guideNotesHtml(bv) : ''}
  <div class="row" style="margin-top:6px; justify-content:space-between; align-items:center">
    ${t3 ? `<span class="tbasis" title="What the Target column ties to. ${esc(refShort)}: growth over the ${esc(refLabel)} (the guidance numbers sit in the empty boxes). T3: growth over the last three actual months × 4 (${esc(t3ref.period)}); its targets are kept separately, so switching never changes the other basis's numbers.">Tie to <button data-tbasis="t12" class="${basisT3 ? '' : 'on'}">${esc(refShort)}</button><button data-tbasis="t3" class="${basisT3 ? 'on' : ''}">T3</button></span>` : ''}
    <span class="muted" style="font-size:11px">Δ% = budget vs ${esc(refLabel)}.${basisT3 ? ' <b>Targets are growth over the T3 annualized</b>: a typed target colours the Δ% T3; Δ% T12 keeps the guidance colours.' : ''}${useU && !basisT3 ? ` Δ% is the budget against UW for ${esc(String(bv.budget.year))} (the Year-1 plan, then the UW Year-2 trend): green on or above it for income and NOI, on or under it for expenses and losses; an empty box ties to 0%, on the underwriting. The memo's guidance is growth over the T12 — pick Trailing-12 actuals to see it.` : ''}${useG && !basisT3 ? ` Grey number in an empty box = the guidance; Δ% is green at or above it on income rows, at or below it on expense rows (NOI at least ${p1(G.noiPct)}%), red the wrong side. <b>fill blank</b> puts those numbers in the empty boxes.` : ''} <b>tie</b> lands a row on its target — the number you typed${basisT3 ? '' : ', or the guidance when the box is empty'}.</span>
    ${fillable.length ? `<button class="rb" id="fill-targets" title="Put the guidance number in every EMPTY target box (${fillable.length}): income lines ${p1(G.incomePct)}%, expense categories ${p1(G.expensePct)}%, RE taxes ${p1(G.reTaxPct)}%, payroll ${p1(G.payrollPct)}%, insurance at $${G.insurancePerUnit}/unit. Typed boxes and NOI are left alone. Nothing ties until you press tie.">fill ${fillable.length} blank</button>` : ''}
    ${nTargets && canTie ? `<button class="rb" id="tie-all" title="Apply every target that is set — categories first, then rental income / total income (they move GPR), then OpEx, then NOI">tie all (${nTargets})</button>` : ''}
  </div>
  <p class="muted" style="font-size:11px"><b>Nothing derives from an underwriting.</b> “tie” shifts the trailing-12 × factor lines of that subtotal by one uniform number of points (MROUNDs kept), so the subtotal grows by the target; GPR solves its monthly %; concessions &amp; rental loss scale their % of GPR; loss to lease is set under Assumptions; mgmt fee follows income; <b>Total Rental Income / Total Income</b> move the lever you pick — vacancy % or GPR (other income is held; a target the lever cannot reach is refused, nothing changes); a subtotal with no factor lines left (all overridden) rebalances proportionally. OpEx / NOI targets spread across every expense category but the fee.</p>`;
}

/* UW basis vs actuals on the compare card (Troy 2026-11-12, the 06.30.2026 UW books): under each category, how the
   UW built it ("UW $1,900/u → +3%", "3.25% GPR", "3% EGI → 4% EGI", "Ryan est. → +5.4%"), and a "Posted" column =
   what has posted since closing, annualized, coloured against the UW target on that row (expense above it / income
   below it by more than 2% = red). The hover shows the same measure for UW, budget and posted ($/unit, % of GPR,
   % of EGI). Only for a new acquisition's budgets with a UW basis on file (bv.uwBasis). */
const UWB_SUM = { ngpr: ['1', 'loss'], rental: ['1', 'loss', '2', '3'], oth: ['4', '5'], income: ['1', 'loss', '2', '3', '4', '5'], opex: ['6', '7', '8', '9', '10', '11', '12', '13', '14'] };
function uwBasisParts(bv, key, r, opts = {}) {
  const U = bv.uwBasis;
  if (!U || !key) return { label: '', cell: U && U.posted ? '<td class="muted">—</td>' : '' };
  const B = (U.basis || {})[key];
  const p1 = (v) => `${+(v * 100).toFixed(2)}%`;
  const fmt = (b, y2) => !b ? '' : b.kind === 'estimate' ? 'Ryan est.' : b.kind === 'perUnit' ? `$${money(b.value)}/u` : b.kind === 'pctGpr' ? `${p1(b.value)} GPR` : b.kind === 'pctEgi' ? `${p1(b.value)} EGI` : `${b.value >= 0 ? '+' : ''}${p1(b.value)}${y2 ? '' : ' on T12'}`;
  const y1t = B ? fmt(B.y1, false) : '', y2t = B && U.yearSplit && U.yearSplit.y1 < 12 ? fmt(B.y2, true) : '';
  const label = y1t || y2t ? `<div class="uwb" title="How the UW built this category${y2t ? ': Year 1, then Year 2' : ''}${B && B.t12 ? ` · seller T12 ${money(B.t12)}` : ''}">UW ${esc(y1t)}${y2t ? ` → ${esc(y2t)}` : ''}</div>` : '';
  if (!U.posted) return { label, cell: '' };
  if (opts.noPosted) return { label, cell: '<td class="muted">—</td>' };
  // posted, annualized, for a category or a subtotal; NOI = income less expenses
  const P = U.posted;
  const sumOf = (ps) => ps.reduce((a, p) => a + (P[p] || 0), 0);
  const posted = key === 'noi' ? sumOf(UWB_SUM.income) - sumOf(UWB_SUM.opex) : UWB_SUM[key] ? sumOf(UWB_SUM[key]) : (P[key] ?? null);
  if (posted == null || (!posted && !r.uw)) return { label, cell: '<td class="muted">—</td>' };
  const expense = ['6', '7', '8', '9', '10', '11', '12', '13', '14', 'opex'].includes(key);
  const ref = r.uw || 0, uwRef = !!opts.uwRef;
  const off = ref ? (posted - ref) / Math.abs(ref) : null;
  // signed like the rows: income above / expense below / a loss less negative = better
  const worse = off == null || !uwRef ? null : expense ? off > 0.02 : off < -0.02;
  // the UW's own measure for the hover: $/unit, % of GPR, % of EGI
  const units = U.units || 0, gprB = opts.gpr || 0, egiB = opts.egi || 0, gprP = P['1'] || 0, egiP = sumOf(UWB_SUM.income);
  const meas = (v, gpr, egi) => !B || !B.y1 ? '' : B.y1.kind === 'perUnit' && units ? `$${money(Math.abs(v) / units)}/u` : B.y1.kind === 'pctGpr' && gpr ? p1(Math.abs(v) / gpr) + ' GPR' : B.y1.kind === 'pctEgi' && egi ? p1(v / egi) + ' EGI' : '';
  const tip = `Posted, annualized: ${U.postedLabel} × ${+(12 / (U.postedMonths || 12)).toFixed(2)} = ${money(posted)}${meas(posted, gprP, egiP) ? ` (${meas(posted, gprP, egiP)})` : ''}`
    + `\nBudget: ${money(r.budget)}${meas(r.budget, gprB, egiB) ? ` (${meas(r.budget, gprB, egiB)})` : ''}`
    + `\n${uwRef ? 'UW target' : 'Reference'}: ${money(ref)}${y1t ? ` — UW built it as ${y1t}${y2t ? `, then ${y2t}` : ''}` : ''}`
    + (off != null ? `\nPosted run-rate is ${off >= 0 ? '+' : ''}${(off * 100).toFixed(1)}% vs ${uwRef ? 'UW' : 'the reference'}` : '')
    + (U.postedMonths < 3 ? `\nOnly ${U.postedMonths} month${U.postedMonths === 1 ? '' : 's'} posted: read with care` : '');
  return { label, cell: `<td class="posted ${worse == null ? '' : worse ? 'bad' : 'good'}" title="${esc(tip)}">${money(posted)}</td>` };
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
    // UW basis vs actuals: the subtotal / category this row is (the Vacancy split shows category 3's basis only)
    const KEYOF = { 'Effective Gross Income': 'income', 'Total Operating Expenses': 'opex', 'Net Operating Income': 'noi', 'Net Gross Potential Rent': 'ngpr', 'Total Rental Income': 'rental', 'Total Other + Utility Inc': 'oth' };
    const bk = KEYOF[r.label] || (r.pcode === 'Vacancy' ? '3' : r.label === 'Delinquency & Other Loss' ? null : r.pcode);
    const ub = uwBasisParts(bv, bk, r, { uwRef: true, noPosted: r.pcode === 'Vacancy', gpr: (byP['1'] || {}).budget || 0, egi: t.egi.budget || 0 });
    return `<tr class="${big ? 'big' : ''}"><td title="${esc(r.label)}">${esc(SHORT[big ? r.label : r.pcode] || r.label)}${ub.label}</td>
      <td>${money(r.budget)}</td><td>${money(r.uw)}</td>
      <td class="var ${cls}">${money(r.variance)}</td>${ub.cell}
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
    <tr><th>Category</th><th>Budget</th><th>${esc(refLabel)}</th><th>Δ</th>${bv.uwBasis && bv.uwBasis.posted ? `<th title="${esc(bv.uwBasis.postedLabel)}, annualized — red where it runs worse than the UW">Posted</th>` : ''}<th></th></tr>
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
      <div class="fld"><label>GPR base $/mo${S.bv && S.bv.rollMarket > 0 ? ' · rent roll' : ''}</label><input id="in-gprbase" value="${g.baseMonthly ?? 0}" style="width:110px"${S.bv && S.bv.rollMarket > 0 ? ' readonly title="The linked rent roll&#39;s market total. To use a different number for a month, hard-code that cell on the GPR row."' : ''}></div>
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
      <div class="fld"><label>Mgmt fee % of prior-month income</label><input id="in-mgmt" value="${((inp.mgmtPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
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
function smoothMonths(months, opt) {
  if (opt && opt.gl) return smoothGentle(months, opt);
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
  if (opt && opt.gl) {
    // a budget line: no month against the line's sign (an expense is never negative), then MROUND $5
    const sign = Number(opt.gl) >= 6000 || total >= 0 ? 1 : -1;
    if (m.some((v) => v * sign < 0)) {
      if (total * sign <= 0) m = m.map(() => 0);
      else { const keep = m.map((v) => (v * sign > 0 ? v : 0)); const k = total / keep.reduce((a, v) => a + v, 0); m = keep.map((v) => v * k); }
    }
    const mult = opt.round || 5;
    m = m.map((v) => Math.round(v / mult) * mult);
  }
  return { months: m, passes };
}

/* GENTLE smoothing for a budget line (Troy 2026-11-11: "Smooth tool also is too aggressive for many
   adjustments"). The old pass ran 1-2-1 over EVERY month at least twice, flattening seasonality that was
   real. Now only the months that are actually wrong move:
     1. a month against the line's sign (a credit on an expense) is taken out of the nearest high month;
     2. a spike (more than 1.5x the typical month AND 1.5x both months beside it) gives its EXCESS to the low months within three months
        of it, nearest first and the months before it first (a catch-up bill follows the missed ones),
        filling each only up to the typical month. What does not fit stays in the spike;
     3. a sudden drop (a run of 1-3 months under 35% of the typical month and of the months either side) is
        filled back to the level beside it, taken from every other month in proportion.
   Months that were already ordinary are not touched. When nothing qualifies the line is left alone unless
   the user says yes to one half-strength 1-2-1 pass. Total kept, then MROUND $5. */
function smoothGentle(months, opt) {
  const total = Math.round(months.reduce((a, v) => a + v, 0) * 100) / 100;
  const sign = Number(opt.gl) >= 6000 || total >= 0 ? 1 : -1;
  let w = months.map((v) => v * sign);
  const pos = w.filter((v) => v > 0).sort((a, b) => a - b);
  const med = pos.length ? pos[Math.floor((pos.length - 1) / 2)] : 0;
  let moved = 0;
  const near = (i, d) => [i - d, i + d].filter((j) => j >= 0 && j < 12);
  // 1. credits
  for (let i = 0; i < 12; i++) {
    if (!(w[i] < 0)) continue;
    let need = -w[i]; w[i] = 0;
    for (const floor of [med, 0]) for (let d = 1; d < 12 && need > 0.005; d++) for (const j of near(i, d)) {
      const take = Math.min(need, Math.max(0, w[j] - floor));
      if (take > 0) { w[j] -= take; need -= take; moved += take; }
    }
    if (need > 0.005) w[i] = -need;   // the whole line is a credit: left for the sign guard below
  }
  // 2. spikes
  if (med > 0) for (let i = 0; i < 12; i++) {
    // a spike stands out from the months NEXT to it too: the top of a seasonal run is not one
    const nb = Math.max(w[(i + 11) % 12], w[(i + 1) % 12]);
    if (!(w[i] > 1.5 * med && w[i] - med >= 50 && w[i] > 1.5 * nb)) continue;
    let excess = w[i] - med;
    for (let d = 1; d <= 3 && excess > 0.005; d++) for (const j of near(i, d)) {
      const give = Math.min(excess, Math.max(0, med - w[j]));
      if (give > 0) { w[j] += give; w[i] -= give; excess -= give; moved += give; }
    }
  }
  // 3. drops (Troy 2026-11-12: "Smoothing only looks for spikes, not massive drops"): a run of at most
  //    three months that falls off a cliff — each under 35% of the typical month AND under 35% of the
  //    average of the months on either side of the run, which themselves sit at half the typical month or
  //    more — is filled back to the level around it (never above the typical month). A real seasonal low
  //    tapers in (its neighbours are in between), and a long off-season (snow in summer) is more than
  //    three months, so neither qualifies. The fill comes out of every other month in proportion, so the
  //    year total and the rest of the line's shape are kept.
  if (med > 0) {
    const dip = Array(12).fill(false);
    const deep = (v) => v < 0.35 * med && med - v >= 50;
    for (let i = 0; i < 12;) {
      if (!deep(w[i])) { i++; continue; }
      let j = i; while (j + 1 < 12 && deep(w[j + 1])) j++;
      const sides = [i - 1, j + 1].filter((k) => k >= 0 && k < 12).map((k) => w[k]);
      const level = sides.length ? sides.reduce((a, v) => a + v, 0) / sides.length : 0;
      const sharp = j - i < 3 && sides.length && level >= 0.5 * med && Math.max(...w.slice(i, j + 1)) < 0.35 * level;
      if (sharp) for (let k = i; k <= j; k++) dip[k] = Math.min(med, level);
      i = j + 1;
    }
    const add = dip.reduce((a, t, k) => a + (t ? t - w[k] : 0), 0);
    const rest = w.reduce((a, v, k) => a + (dip[k] ? 0 : Math.max(0, v)), 0);
    if (add > 0 && rest > add) {
      const k2 = (rest - add) / rest;
      w = w.map((v, k) => (dip[k] ? dip[k] : v > 0 ? v * k2 : v));
      moved += add;
    }
  }
  // nothing was wrong enough: one soft pass (half way to a 1-2-1), reflective edges keep the total
  const soft = moved < 1;
  if (soft) w = w.map((v, i) => 0.5 * v + 0.5 * ((2 * v + (i > 0 ? w[i - 1] : w[0]) + (i < 11 ? w[i + 1] : w[11])) / 4));
  let m = w.map((v) => v * sign);
  if (m.some((v) => v * sign < 0)) {
    if (total * sign <= 0) m = m.map(() => 0);
    else { const keep = m.map((v) => (v * sign > 0 ? v : 0)); const k = total / keep.reduce((a, v) => a + v, 0); m = keep.map((v) => v * k); }
  }
  const mult = opt.round || 5;
  return { months: m.map((v) => Math.round(v / mult) * mult), passes: 1, soft };
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
/* The GL's own CURRENT-YEAR BUDGET by month as a source row (Troy 2026-11-11: "The budget template has T12
   data in it... Same with budget numbers"). It comes off the Yardi template with the T12; nothing to pick. */
function fcBudgetRow(bv, gl) {
  const m = bv.hist && bv.hist.budget && bv.hist.budget.cal && bv.hist.budget.cal[gl];
  if (!m || !m.some((v) => v)) return null;
  const start = ((bv.budget || {}).inputs || {}).startMonth || 1;
  const a = S.state.coa.find((x) => x.code === gl) || {};
  return { gl, basis: 'budget', name: `${gl} ${a.name || ''}`.trim(), months: m.slice(), monthCal: m.map((_, i) => ((start - 1 + i) % 12) + 1), pcode: a.pcode || null, total: m.reduce((x, y) => x + (y || 0), 0) };
}
/* Annual budgets: a GL-based option reads the row's OWN GL. Its trailing-12 first; a GL with no T12 offers its
   own current-year budget (one yes/no, never a list). Returns the row, false = declined (do nothing), or null =
   nothing of its own on the template / Shift-click / acquisition budget -> the caller opens the picker. */
function fcOwnSource(bv, gl, rows) {
  if (!bv.annual || S.pickOther) return null;
  const own = rows.find((r) => String(r.gl) === String(gl));
  if (own) return own;
  const bud = fcBudgetRow(bv, gl);
  if (!bud) return null;
  return confirm(`${gl} has no trailing-12 actuals on the template.\n\nUse its current-year budget (${money(bud.total)}) as the source instead?`) ? bud : false;
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
    driver: { method: 'sellerLine', name: row.name.slice(0, 40), pct, ...(row.basis ? { basis: row.basis } : {}) },
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
    rows.push({ srcType: 'seller', name: r.name, pcode: r.pcode, cal: fcSellerCal(r), scale: 1, total: r.total || fcSellerCal(r).reduce((a, x) => a + x, 0), own: !!bv.annual && String(r.gl) === String(gl) });
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
  return { months, driver: { method: 't12curve', name: row.name.slice(0, 40), pct, shape: shapeKey, mult: mult || 0, weights: shapeKey === 'custom' ? customWeights : undefined, ...(row.basis ? { basis: row.basis } : {}) } };
}

function fcWavg(bv, inp, row, pct, mult) {
  const start = inp.startMonth || 1;
  // centered 1-2-1 smoothing on the calendar series (wraps at year edges)
  const sm = row.cal.map((_, c) => (2 * row.cal[c] + row.cal[(c + 11) % 12] + row.cal[(c + 1) % 12]) / 4);
  const months = Array.from({ length: 12 }, (_, i) => {
    const v = sm[(start - 1 + i) % 12] * row.scale * (1 + pct / 100);
    return mult ? Math.round(v / mult) * mult : Math.round(v * 100) / 100;
  });
  return { months, driver: { method: 'wavg', pct, mult: mult || 0, srcType: row.srcType, srcName: row.name.slice(0, 30), ...(row.basis ? { basis: row.basis } : {}) } };
}

/* ---------------- row quick tools ---------------- */
function openRowTools(b, gl, anchorBtn) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const inp = S.bv.budget.inputs || {};
  const start = inp.startMonth || 1;
  const acc = S.state.coa.find((a) => a.code === gl) || {};
  const hasComp = S.bv.compWeights && S.bv.compUnits && S.bv.compWeights[gl];
  const line = S.bv.lines.find((l) => l.gl_code === gl);
  const dm = drvMeta(line && (sumM(line.months) || line.override || (line.driver || {}).method === 'dropped') ? line : null);
  const menu = document.createElement('div');
  menu.className = 'rowmenu';
  // the chip each tool leaves on the row — same tag and colour as the grid (Troy 2026-11-11)
  const TOOL_CHIP = { undrop: ['drv-base', 'T12/12'], flatGrow: ['drv-base', 'T12/12'], ownFormula: ['drv-uw', 'OWN'], zero: ['drv-int', 'ZERO'], flatAnnual: ['drv-man', 'MAN'], flatMonthly: ['drv-man', 'MAN'], grow: ['drv-man', 'MAN'], minot: ['drv-comp', 'MINOT'], t3avg: ['drv-comp', 'T3'], shape: ['drv-base', 'SHAPE'], pctgpr: ['drv-base', '%GPR'], suggest: ['drv-corp', 'CORP'], seller: ['drv-t12', 'SLR'], ownBudget: ['drv-t12', 'CY BUD'], t12curve: ['drv-t12', 'T12C'], link: ['drv-fee', 'LINK'], smooth: ['drv-t12', 'SMOOTH'], recmap: ['drv-t12', 'REC'], wavg: ['drv-comp', 'WAVG'], reset: ['drv-uw', 'ENGINE'], burdenFrom: ['drv-pay', '%WAGES'] };
  const dot = (cls, act) => { const c = act && TOOL_CHIP[act]; return c ? `${chipHtml(c[0], c[1])} ` : `<span class="dot ${cls}" style="margin-right:6px"></span>`; };
  menu.innerHTML = `
    <div class="rm-head">${gl} ${esc(acc.name || '')}<br>
      <span class="drv ${dm.cls}" style="margin-top:3px; display:inline-block">${dm.tag}</span>${drvExtraHtml(dm)}
      <span style="margin-left:5px">${esc(dm.label)}</span></div>
    ${line && (line.driver || {}).method === 'dropped' ? `<button data-act="undrop" title="The template dropped this line because its trailing-12 is at or under $1,000. This budgets it at T12 ÷ 12 with the line's usual increase factor."><b>${dot('drv-base', 'undrop')}Budget this line — T12 ÷ 12 ($${money(line.driver.t12 || 0)} a year before the factor)</b></button>` : ''}
    ${S.bv.annual && rowT12(gl) ? `<button data-act="flatGrow" title="This line = its trailing-12 total ÷ 12, the same every month, × (1 + the growth % you type). Works on ANY line with history — rent, loss to lease, vacancy, payroll, the fee, corporate lines included. It replaces the line's own formula until you put it back."><b>${dot('drv-base', 'flatGrow')}Flat + growth over T12… (T12 ${money(rowT12(gl))})</b></button>` : ''}
    ${S.bv.annual && ((inp.baseline || {}).glShape || {})[gl] ? `<button data-act="ownFormula" title="Drop the shape chosen on this row; the line goes back to its usual formula">${dot('drv-uw', 'ownFormula')}Back to this line's own formula</button>` : ''}
    <button data-act="zero">${dot('drv-int', 'zero')}Zero out row</button>
    ${S.bv.annual ? '' : `<button data-act="flatAnnual">${dot('drv-man', 'flatAnnual')}Flat — annual $ over the year…</button>
    <button data-act="flatMonthly">${dot('drv-man', 'flatMonthly')}Flat — $ per month…</button>
    <button data-act="grow">${dot('drv-man', 'grow')}Start $ /mo + growth %/mo…</button>`}
    ${hasComp ? `<button data-act="minot">${dot('drv-comp', 'minot')}Minot $/unit × units (${money((S.bv.compWeights[gl] / S.bv.compUnits) * inp.units)}/yr, seasonal)</button>` : ''}
    ${hasComp && S.bv.compShapes && S.bv.compShapes[gl] ? `<button data-act="t3avg" title="Weighted average of the comp's last 3 months (1-2-1), per-unit scaled, × (1+growth), rounded to $250 — your MROUND formula">${dot('drv-comp', 't3avg')}T3 actuals avg × growth → MROUND $250…</button>` : ''}
    ${S.bv.annual ? `<button data-act="shape" title="Pick how this GL's own trailing-12 history becomes the budget: same month × factor (template), 1-2-1 weighted distribution, the turnover curve, or the T12 total on the GL's seasonal curve (GLs that have one). Flat is the first item of this menu: Flat + growth over T12">${dot('drv-base', 'shape')}Own T12 → shape × factor…</button>` : ''}
    ${S.bv.annual && acc.pcode && ['1', 'loss', '2', '3'].includes(acc.pcode) && gl !== '4994' ? `<button data-act="pctgpr" title="This line as a % of budget GPR">${dot('drv-base', 'pctgpr')}% of GPR…</button>` : ''}
    ${S.bv.annual && S.bv.template && S.bv.template.suggestions && S.bv.template.suggestions[gl] && S.bv.template.suggestions[gl].some((v) => v) ? `<button data-act="suggest" title="${esc((S.bv.template.suggestionNotes[gl] || []).join('; '))}">${dot('drv-corp', 'suggest')}Corporate suggestion (${money(S.bv.template.suggestions[gl].reduce((a, v) => a + v, 0))}/yr)…</button>` : ''}
    ${(S.bv.sellerT12 || []).length ? `<button data-act="seller" title="${S.bv.annual ? 'This GL\'s own trailing-12 months × growth. No GL to pick: the row is the GL. Shift-click to take another statement line instead. A GL with no T12 offers its own current-year budget.' : 'Match this GL to a seller T12 line and take its monthly actuals × growth'}">${dot('drv-t12', 'seller')}${S.bv.annual ? 'Own T12 actuals × growth (this GL)' : 'Seller actuals — match a seller line…'}</button>` : ''}
    ${S.bv.annual && fcBudgetRow(S.bv, gl) ? `<button data-act="ownBudget" title="This GL's own current-year budget, month by month, × growth. It is read from the Yardi template along with the T12: no GL to pick.">${dot('drv-t12', 'ownBudget')}CY budget × growth (this GL · ${money(fcBudgetRow(S.bv, gl).total)})</button>` : ''}
    ${(S.bv.sellerT12 || []).length && !(S.bv.annual && !glHasCurve(gl)) ? `<button data-act="t12curve" title="${S.bv.annual ? 'Take a statement line\'s T12 total × growth and spread it on a clean seasonal curve' : 'For non-accrual seller billing (credits/gaps/spikes): the ANNUAL total is still right even when the months are garbage. Takes the seller line\'s T12 total × growth and spreads it on a clean seasonal curve.'}">${dot('drv-t12', 't12curve')}${S.bv.annual ? 'T12 TOTAL → seasonal curve… (this GL)' : 'Seller T12 TOTAL → seasonal curve… (bad bills)'}</button>` : ''}
    ${S.bv.annual && acc.pcode === '10' && !BUDGET_WAGE_GLS.includes(gl) && gl !== '6413' ? `<button data-act="burdenFrom" title="Take this line's % of wages and its monthly shape (annual true-ups, quarterly bonuses) from other properties — one, several pooled, or a whole region — applied to this property's own wages. Only this line; the others keep their own ratios.">${dot('drv-pay', 'burdenFrom')}% of wages from other properties…${((S.bv.budget.inputs || {}).burdenFromGl || {})[gl] ? ` <span class="muted">(${esc(((S.bv.burdenGlSrc || {})[gl] || {}).code || ((S.bv.budget.inputs || {}).burdenFromGl[gl] || []).join('+').toUpperCase())})</span>` : ''}</button>` : ''}
    <button data-act="link" title="Set this GL equal to another budget line × a weight (e.g. sewer = water × 0.8). LIVE: re-follows the source on every regeneration.">${dot('drv-fee', 'link')}= another line × weight… (moves in conjunction)</button>
    ${line && line.months.some((v) => v) ? `<button data-act="smooth" title="Gentle: only the months that are wrong move. A spike gives its excess to the low months next to it and a credit month is netted against the nearest high month; ordinary months are not touched. A line with nothing wrong is left alone unless you ask for a light pass. No negative months; every month rounded to $5, so the total can move by a few dollars. The line keeps its formula chip and gains a SMOOTH chip.">${dot('drv-t12', 'smooth')}Smooth missed bills — spikes into surrounding months</button>` : ''}
    ${line && (line.driver || {}).method === 'recovery' ? `<button data-act="recmap" title="Pick exactly which utility expense lines this reimbursement recovers (recovery % × their prior month). Claims are exclusive — a line you take here is released by whichever reim had it.">${dot('drv-t12', 'recmap')}Edit what this reim recovers…</button>` : ''}
    ${((S.bv.sellerT12 || []).length || hasComp) ? `<button data-act="wavg" title="Troy's distribution formula: each month = (2×that month + prior + next)/4 of the source actuals, × (1+growth), MROUND to a multiple">${dot('drv-comp', 'wavg')}Weighted avg distribution (1-2-1) × growth → MROUND…</button>` : ''}
    <button data-act="reset">${dot('drv-uw', 'reset')}Reset to engine formula (clear override)</button>`;
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
    S.pickOther = !!e.shiftKey;   // Shift-click a GL-based option = pick ANOTHER line instead of this row's own
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
    if (act === 'ownBudget') {
      const r = fcBudgetRow(S.bv, gl);
      if (!r) return;
      const g = parseFloat(String(prompt(`Growth % on the ${money(r.total)} current-year budget for ${gl} ${acc.name || ''} (0 = the budget as-is):`, '3') || '').replace(/,/g, ''));
      if (!Number.isFinite(g)) return;
      const res = fcSellerLine(S.bv, inp, r, g);
      return put(res.months, res.driver);
    }
    if (act === 'seller') {
      openSellerMatch(b, gl, acc, anchorBtn, put);
      return;
    }
    if (act === 't12curve') {
      openT12CurveMatch(b, gl, acc, anchorBtn, put, inp);
      return;
    }
    if (act === 'burdenFrom') { openBurdenFrom(b, gl, acc); return; }
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
      const res = smoothMonths(cur, { gl, round: 5 });
      // nothing on the line looks wrong: leave it alone unless asked
      if (res.soft && !confirm(`${gl} ${acc.name || ''}
No spike or credit month stands out on this line, so Smooth would leave it as it is.

Apply a light overall smoothing anyway? (each month moves half way toward the average of itself and its neighbours)`)) return;
      const prev = line && line.driver && line.driver.method && line.driver.method !== 'manual' ? line.driver : null;
      // the formula keeps its chip; smoothing rides along as a second one
      if (prev && prev.method !== 'smooth') { const { hard: _typed, ...p2 } = prev; return put(res.months, { ...p2, smooth: { passes: ((prev.smooth || {}).passes || 0) + res.passes, mult: 5 } }); }
      return put(res.months, { method: 'smooth', passes: ((prev || {}).passes || 0) + res.passes, mult: 5, of: prev ? prev.of : undefined, srcName: prev ? prev.srcName : undefined });
    }
    if (act === 'undrop') { await budgetDroppedLines(b, [gl]); return; }
    if (act === 'flatGrow' || act === 'ownFormula') {
      const bl = inp.baseline || {};
      const glShape = { ...(bl.glShape || {}) }, glGrowth = { ...(bl.glGrowth || {}) };
      if (act === 'flatGrow') {
        const cur = glGrowth[gl] != null ? glGrowth[gl] * 100 : 3;
        const t12 = rowT12(gl);
        const ans = prompt(`${gl} ${acc.name || ''}\nFlat + growth over T12: every month = T12 ${money(t12)} ÷ 12 × (1 + growth).\n\nGrowth % over the trailing-12 (0 = hold it flat):`, String(+cur.toFixed(2)));
        if (ans == null) return;
        const g = parseFloat(String(ans).replace(/[%,]/g, ''));
        if (!Number.isFinite(g)) return;
        glShape[gl] = 'flat'; glGrowth[gl] = g / 100;
      } else { delete glShape[gl]; delete glGrowth[gl]; }
      pushUndo();
      if (line && line.override) S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { override: false });
      S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...bl, glShape, glGrowth } } });
      render();
      return;
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
  const isOwn = (r) => String(r.gl) === String(gl);
  rows.sort((a, z) => {
    const am = isOwn(a) ? -1 : a.pcode === acc.pcode ? 0 : 1, zm = isOwn(z) ? -1 : z.pcode === acc.pcode ? 0 : 1;
    return am - zm || Math.abs(z.total) - Math.abs(a.total);
  });
  const applyRow = async (r) => {
    const g = parseFloat(String(prompt(`Growth % on "${r.name}"${r.basis === 'budget' ? ' current-year budget' : ''} (0 = ${r.basis === 'budget' ? 'the budget' : 'actuals'} as-is):`, '3') || '').replace(/,/g, ''));
    if (!Number.isFinite(g)) return;
    const res = fcSellerLine(S.bv, S.bv.budget.inputs || {}, r, g);
    await put(res.months, res.driver);
  };
  // Troy 2026-11-11: "I still am having to repick the GL when I pick an option that is GL based". The row
  // already IS the GL: its own statement line is the source, no picker. Shift-click the option to pick another line.
  const ownRow = fcOwnSource(S.bv, gl, rows);
  if (ownRow === false) return;
  if (ownRow) { applyRow(ownRow); return; }
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
    menu.remove();
    await applyRow(rows[Number(btn.dataset.sm)]);
  }));
}

/* T12-total-on-a-curve picker: pick the seller line (its TOTAL is used, so
   even ⚠ non-accrual lines are fine here), then pick the seasonal shape. */
function openT12CurveMatch(b, gl, acc, anchorBtn, put, inp) {
  document.querySelectorAll('.rowmenu').forEach((m) => m.remove());
  const isOwn = (r) => String(r.gl) === String(gl);
  const rows = fcSellerRows(S.bv).slice().sort((a, z) => {
    const am = isOwn(a) ? -1 : a.pcode === acc.pcode ? 0 : 1, zm = isOwn(z) ? -1 : z.pcode === acc.pcode ? 0 : 1;
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
      <div class="rm-head">Spread ${esc(row.name.slice(0, 30))} ${row.basis === 'budget' ? 'current-year budget' : 'T12'} total (${money(total)}) on:</div>
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

  // the row's own statement line is the source: straight to the curve choice (Shift-click the option to pick another line)
  { const ownRow = fcOwnSource(S.bv, gl, rows); if (ownRow === false) { menu.remove(); return; } if (ownRow) { pickShape(ownRow); return; } }
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
  const applyWavg = async (r) => {
    const g = parseFloat(String(prompt(`Increase factor % on "${r.name}" (the (1+$D)):`, '3') || '').replace(/,/g, ''));
    if (!Number.isFinite(g)) return;
    const estTotal = r.cal.reduce((a, x) => a + x, 0) * r.scale * (1 + g / 100);
    const mult = parseFloat(String(prompt(`MROUND multiple ($, 0 = no rounding) — annual total lands at ≈ ${money(estTotal)}${r.scale !== 1 ? ` (Minot ${money(r.total)} scaled to ${inp.units || 0} units)` : ''}:`, '250') || '').replace(/,/g, ''));
    if (!Number.isFinite(mult) || mult < 0) return;
    const res = fcWavg(S.bv, inp, r, g, mult);
    await put(res.months, res.driver);
  };
  // Troy 2026-11-09: "the WAVG should not need to ask what GL it should be tied to — it already
  // has the GL". When this GL has its own history that IS the source; the picker only opens
  // for a GL with no history of its own (it then has to borrow another line's shape).
  // (annual budgets only: the row's own statement line. An acquisition budget still picks between the seller's lines and the Minot comps.)
  let ownRow = S.bv.annual && !S.pickOther ? rows.find((r) => r.own && r.srcType === 'seller') : null;
  if (!ownRow && S.bv.annual && !S.pickOther) {
    // no T12 for this GL: its own current-year budget (also on the template), after a yes
    const bud = fcOwnSource(S.bv, gl, []);
    if (bud === false) return;
    if (bud) ownRow = { srcType: 'seller', basis: 'budget', name: bud.name, pcode: bud.pcode, cal: fcSellerCal(bud), scale: 1, total: bud.total, own: true };
  }
  if (ownRow) { applyWavg(ownRow); return; }
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
    await applyWavg(r);
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
        const row = d.basis === 'budget' ? fcBudgetRow(S.bv, l.gl_code) : fcFindSeller(S.bv, d.name);
        if (row) res = fcSellerLine(S.bv, tinp, row, d.pct || 0);
        else why = d.basis === 'budget' ? 'no current-year budget for this GL on this budget' : `no seller line named "${d.name || '?'}" on this budget's T12`;
      } else if (d.method === 't12curve') {
        const row = d.basis === 'budget' ? fcBudgetRow(S.bv, l.gl_code) : fcFindSeller(S.bv, d.name);
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
        if (d.basis === 'budget') {
          const bud = fcBudgetRow(S.bv, l.gl_code);
          if (bud) row = { srcType: 'seller', basis: 'budget', name: bud.name, pcode: bud.pcode, cal: fcSellerCal(bud), scale: 1, total: bud.total, own: true };
          else why = 'no current-year budget for this GL on this budget';
        } else if (d.srcType === 'seller') {
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
/* ---------------- payroll (pay rates) ----------------
   Its own gate (payroll password) on top of the app login. Mirrors
   shared/payroll.ts math; RM pay is masked SERVER-side — this view only
   renders what the API already decided the viewer may see. Iteration chains
   are per REGION (property market). */
const payMo = (method, rate, pct) => Math.round((method === 'Hourly' ? (rate * 2080) / 12 : rate / 12) * pct * 100) / 100;
/* mirrors shared/payroll newRate: a raised HOURLY rate lands on the nearest
   25¢ (Troy 2026-11-02); the adjusted % is what the budget actually pays */
const payNewRate = (method, rate, pct) => method === 'Hourly'
  ? Math.round(Math.round((rate * (1 + pct / 100)) / 0.25) * 0.25 * 100) / 100
  : Math.round(rate * (1 + pct / 100) * 100) / 100;
const payAdjPct = (method, rate, pct) => (rate ? payNewRate(method, rate, pct) / rate - 1 : 0);
const payBurden = (position) => (7.65 + 1.0 + (/regional|lms|arm|bookkeep|office|leasing|apm|\bpm\b|manager|market/i.test(position) ? 0.8 : 4.0)) / 100;
const payRateStr = (method, rate) => method === 'Hourly' ? `$${Number(rate).toFixed(2)}/hr` : `$${money(rate)}/yr`;
const paySigned = (v) => `${v < 0 ? '−' : '+'}$${money(Math.abs(v))}`;
const PAY_STATUSES = [['not_started', 'Not started'], ['in_progress', 'In progress'], ['submitted', 'Submitted'], ['approved', 'Approved']];

async function loadPayState() {
  S.pay.loading = true; render();
  try {
    S.pay.st = await GET('/payroll/state');
    if (S.pay.st.unlocked) {
      if (!S.pay.cycleId && S.pay.st.cycles.length) S.pay.cycleId = S.pay.st.cycles[0].id;
      if (S.pay.cycleId) await loadPayCycle(S.pay.cycleId);
    }
  } catch (e) { S.pay.err = e.message; }
  S.pay.loading = false; render();
}
async function loadPayCycle(id) {
  S.pay.cycleId = id; S.pay.err = '';
  try {
    S.pay.cycle = await GET(`/payroll/cycles/${id}`);
    // the tab opens on All regions (Troy 2026-11-10); a region picked by hand is kept while it exists
    if (S.pay.region !== '*' && !S.pay.cycle.regions.includes(S.pay.region)) S.pay.region = '*';
    S.pay.iterId = null;   // re-defaults to the region's latest
  } catch (e) { S.pay.cycle = null; S.pay.err = e.message; }
}
const payIters = () => (S.pay.cycle ? S.pay.cycle.iterations.filter((i) => i.region === S.pay.region) : []);
function payIter() {
  const its = payIters();
  return its.find((i) => i.id === S.pay.iterId) || its[its.length - 1] || null;
}

function renderPayroll(el) {
  const P = S.pay;
  if (!P.st && !P.loading) { loadPayState(); return; }
  if (P.loading && !P.st) { el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>'; return; }
  if (!P.st.unlocked) {
    el.innerHTML = `<div class="card login">
      <h2>Payroll — pay rates</h2>
      <p class="muted" style="font-size:12.5px">This area holds individual pay and sits behind its own password, separate from the app sign-in.</p>
      <div class="fld"><label>Payroll password</label><input id="pp" type="password"></div>
      <div class="err" id="pperr">${esc(P.err || '')}</div>
      <button class="btn" id="ppgo">Unlock</button>
    </div>`;
    const go = async () => {
      try { await POST('/payroll/unlock', { password: el.querySelector('#pp').value }); P.err = ''; P.st = null; render(); }
      catch (e) { el.querySelector('#pperr').textContent = e.message; }
    };
    el.querySelector('#ppgo').addEventListener('click', go);
    el.querySelector('#pp').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return;
  }
  const st = P.st;
  const c = P.cycle;
  el.innerHTML = `
    ${payHeaderHtml(st)}
    ${P.err ? `<div class="card"><div class="err">${esc(P.err)}</div></div>` : ''}
    ${c ? payCycleHtml(c) : (st.cycles.length ? '' : '<div class="card"><p class="muted">No raise cycles yet — an admin creates one from a staffing report above.</p></div>')}
    ${st.isAdmin ? payAdminHtml(st) : ''}`;
  wirePayHeader(el, st);
  if (c) wirePayCycle(el, c);
  if (st.isAdmin) wirePayAdmin(el, st);
}

function payHeaderHtml(st) {
  const P = S.pay;
  return `<div class="card">
    <div class="row" style="align-items:center; gap:10px; flex-wrap:wrap">
      <h2 style="margin:0">Pay rates</h2>
      <span class="paylock" title="This area has its own password; Regional-Manager pay is visible only to the RM-pay allowlist">🔒 payroll area</span>
      ${st.canRmPay ? '<span class="paylock">RM pay visible</span>' : '<span class="paylock" title="Regional-Manager rows show with pay masked">RM pay hidden</span>'}
      <span class="spacer"></span>
      ${st.cycles.length ? `<label class="muted" style="font-size:12px">Cycle</label>
      <select id="pay-cycle">${st.cycles.map((x) => `<option value="${x.id}" ${x.id === P.cycleId ? 'selected' : ''}>${esc(x.label)} · eff. ${esc(x.effective)}</option>`).join('')}</select>` : ''}
      ${st.isAdmin && P.cycleId && st.snapshots.length && (st.cycles.find((x) => x.id === P.cycleId) || {}).staffing_snapshot_id !== st.snapshots[0].id
        ? `<button class="btn sub" id="pay-relink-snap" title="Point this cycle at the newest staffing report — raises carry over (rows match by person)">↻ Use latest staffing</button>` : ''}
      ${st.isAdmin ? `<button class="btn sub" id="pay-newcycle">＋ New cycle</button>` : ''}
    </div>
    ${P.newCycle && st.isAdmin ? `<div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap; align-items:flex-end">
      <div class="fld"><label>Label</label><input id="nc-label" placeholder="FY27 raises" style="min-width:180px"></div>
      <div class="fld"><label>Effective (YYYY-MM)</label><input id="nc-eff" value="${new Date().getFullYear() + 1}-01" style="width:110px"></div>
      <div class="fld"><label>Staffing report</label><select id="nc-snap">${st.snapshots.map((s) => `<option value="${s.id}">${esc(s.label)} · ${s.people} people · ${fmtd(s.created_at)}</option>`).join('')}</select></div>
      <button class="btn" id="nc-go" ${st.snapshots.length ? '' : 'disabled title="Load a staffing report first"'}>Create</button>
      <button class="btn sub" id="nc-x">Cancel</button>
    </div>` : ''}
    ${P.msg ? `<div class="ok">${esc(P.msg)}</div>` : ''}
  </div>`;
}
function wirePayHeader(el, st) {
  const sel = el.querySelector('#pay-cycle');
  if (sel) sel.addEventListener('change', async () => { await loadPayCycle(Number(sel.value)); render(); });
  const nb = el.querySelector('#pay-newcycle');
  if (nb) nb.addEventListener('click', () => { S.pay.newCycle = !S.pay.newCycle; render(); });
  const rl = el.querySelector('#pay-relink-snap');
  if (rl) rl.addEventListener('click', async () => {
    try {
      // preview first: how every raise carries onto the new roster; nothing moves until confirmed
      const snapId = st.snapshots[0].id;
      const pv = await PUT(`/payroll/cycles/${S.pay.cycleId}`, { staffingSnapshotId: snapId, dryRun: true });
      const lines = [`Point this cycle at "${st.snapshots[0].label}"?`, '', `${pv.carried} raise(s) carry over as-is (same person key).`];
      if (pv.rematched.length) lines.push('', `${pv.rematched.length} re-matched by name (their key changed in the new sheet):`, ...pv.rematched.map((n) => `  • ${n}`));
      if ((pv.seatMatched || []).length) lines.push('', `${pv.seatMatched.length} follow their SEAT (same position and property split, different person on the new sheet):`, ...pv.seatMatched.map((m) => `  • ${m.from} → ${m.to}`));
      const cp = pv.moved.filter((m) => m.copied), nc = pv.moved.filter((m) => !m.copied);
      if (cp.length) lines.push('', `${cp.length} moved home region; their raise is copied into the new region's open iteration:`, ...cp.map((m) => `  • ${m.name} (${m.from} → ${m.to})`));
      if (nc.length) lines.push('', `${nc.length} moved home region but CANNOT be copied:`, ...nc.map((m) => `  • ${m.name}: ${m.why}`));
      if (pv.orphaned.length) lines.push('', `${pv.orphaned.length} raise(s) match no one on the new sheet. They are KEPT (not deleted) and come back if you re-point to the old sheet:`, ...pv.orphaned.map((o) => `  • ${o.name}: ${o.why}`));
      if (!confirm(lines.join('\n'))) return;
      const r = await PUT(`/payroll/cycles/${S.pay.cycleId}`, { staffingSnapshotId: snapId });
      S.pay.msg = `Cycle now reads the latest staffing report · ${r.carried} raise(s) carried${r.rematched.length ? ` · ${r.rematched.length} re-matched by name` : ''}${(r.seatMatched || []).length ? ` · ${r.seatMatched.length} followed their seat` : ''}${cp.length ? ` · ${cp.length} copied to a new home region` : ''}${r.orphaned.length ? ` · ${r.orphaned.length} unmatched (kept): ${r.orphaned.map((o) => o.name).join(', ')}` : ''}`;
      S.pay.st = null; render();
    } catch (e) { S.pay.err = e.message; render(); }
  });
  const go = el.querySelector('#nc-go');
  if (go) go.addEventListener('click', async () => {
    try {
      const r = await POST('/payroll/cycles', {
        label: el.querySelector('#nc-label').value, effective: el.querySelector('#nc-eff').value.trim(),
        staffingSnapshotId: Number(el.querySelector('#nc-snap').value),
      });
      S.pay.newCycle = false; S.pay.msg = `Cycle created (regions: ${r.regions.join(', ')})`; S.pay.st = null; S.pay.cycleId = r.cycle.id; render();
    } catch (e) { S.pay.err = e.message; render(); }
  });
  const nx = el.querySelector('#nc-x');
  if (nx) nx.addEventListener('click', () => { S.pay.newCycle = false; render(); });
}

/* one property's wage totals (guardrail cards). `raises` = person key → pct,
   already merged across regions; `hid` = the masked-RM aggregate for the code. */
function payPropCalc(c, code, raises, hid) {
  let curMo = 0, newMo = 0, dYrB = 0;
  for (const p of c.people) {
    const a = (p.allocations || []).find((x) => x.code === code);
    if (!a || p.payHidden) continue;
    const pct = raises[p.key] || 0;
    const cur = payMo(p.payMethod, p.payRate, a.pct);
    const nxt = payMo(p.payMethod, payNewRate(p.payMethod, p.payRate, pct), a.pct);
    curMo += cur; newMo += nxt;
    dYrB += (nxt - cur) * 12 * (1 + payBurden(p.position));
  }
  if (hid) { curMo += hid.curMo; newMo += hid.newMo; dYrB += (hid.newMo - hid.curMo) * 12 * (1 + 0.0945); }
  return { curMo, newMo, dYrB, pct: curMo ? (newMo - curMo) / curMo : 0 };
}

/* every person's CURRENT raise = their home region's latest iteration */
function payMergedRaises(c) {
  const latest = {};
  for (const i of c.iterations) { const cur = latest[i.region]; if (!cur || i.num > cur.num) latest[i.region] = i; }
  const out = {};
  for (const p of c.people) {
    const it = latest[p.homeRegion];
    if (!it) continue;
    const e = it.entries[p.key];
    out[p.key] = { pct: e ? Number(e.pct) : 0, by: e ? e.by : '', at: e ? e.at : '', iterId: it.id, locked: !!it.finalizedAt };
  }
  return out;
}

/* EACH PERSON ONCE, in their HOME region only (Troy 2026-10-30 — a
   cross-region LMS was repeating in four region views). region '*' = the
   All-regions view: everyone, edits routed to each person's home chain. */
function payPersonRows(c, visCodes, iter, prior, merged, region) {
  const all = region === '*';
  const rows = [];
  for (const p of c.people) {
    if (all ? !p.homeRegion : p.homeRegion !== region) continue;
    const inVis = (p.allocations || []).filter((a) => visCodes.has(a.code));
    const regA = inVis.length ? inVis : (p.allocations || []);
    if (!regA.length) continue;
    const prim = [...regA].sort((a, b) => b.pct - a.pct)[0];
    let pct, by, at, iterId, locked;
    if (all) {
      const m = merged[p.key] || { pct: 0, by: '', at: '', iterId: null, locked: true };
      pct = m.pct; by = m.by; at = m.at; iterId = m.iterId; locked = m.locked;
    } else {
      const e = iter ? iter.entries[p.key] : null;
      pct = e ? Number(e.pct) : 0; by = e ? e.by : ''; at = e ? e.at : '';
      iterId = iter ? iter.id : null; locked = !iter || !!iter.finalizedAt;
    }
    const priorPct = (!all && prior) ? (prior.entries[p.key] ? Number(prior.entries[p.key].pct) : 0) : null;
    const others = (p.allocations || []).filter((a) => a.code !== prim.code);
    const splitTip = [
      others.length ? `also ${others.map((x) => `${x.code.toUpperCase()} ${Math.round(x.pct * 100)}%`).join(' · ')}` : '',
      p.rm ? 'MIMG corporate 30%' : '',   // MI covers 30% of every RM's pay
    ].filter(Boolean).join(' · ');
    const row = { p, pct, prim, splitN: others.length, splitTip, by, at, iterId, locked, priorPct, hidden: !!p.payHidden };
    if (!p.payHidden) {
      const nr = payNewRate(p.payMethod, p.payRate, pct);
      let cur = 0, nxt = 0;
      for (const a of regA) { cur += payMo(p.payMethod, p.payRate, a.pct); nxt += payMo(p.payMethod, nr, a.pct); }
      row.newRate = nr;
      row.adj = payAdjPct(p.payMethod, p.payRate, pct);
      row.curMo = cur;
      row.dMo = nxt - cur;
      row.dYrB = (nxt - cur) * 12 * (1 + payBurden(p.position));
    }
    rows.push(row);
  }
  // group exactly like the payroll workbook when its section labels exist
  // (Minot Support Staff / Bismarck 4 / …, in the workbook's own row order);
  // fall back to primary-site grouping for rosters without sections
  const useGroups = rows.some((r) => r.p.group);
  for (const r of rows) {
    r.gkey = useGroups ? (r.p.group || 'Other') : r.prim.code;
    r.glabel = useGroups ? (r.p.group || 'Other') : '';
  }
  if (useGroups) {
    const minOrd = {};
    for (const r of rows) { const o = r.p.ord ?? 0; if (!(r.gkey in minOrd) || o < minOrd[r.gkey]) minOrd[r.gkey] = o; }
    rows.sort((x, y) => (minOrd[x.gkey] - minOrd[y.gkey]) || ((x.p.ord ?? 0) - (y.p.ord ?? 0)));
  } else {
    rows.sort((x, y) => x.prim.code.localeCompare(y.prim.code) || (x.p.position || '').localeCompare(y.p.position || '') || (x.p.name || '').localeCompare(y.p.name || ''));
  }
  return rows;
}

/* budgeted rental-income growth for the guardrail, from /state's dash block */
function payIncomeGrowth(code, year) {
  const b = (S.state?.budgets || []).find((x) => x.property_code === code && x.year === year);
  if (!b || !b.dash || b.dash.egiVar == null || !b.dash.income) return null;
  const ref = b.dash.income - b.dash.egiVar;
  return ref > 0 ? b.dash.income / ref - 1 : null;
}

function payCycleHtml(c) {
  const P = S.pay;
  const all = P.region === '*';
  const its = all ? [] : payIters();
  const iter = all ? null : payIter();
  const prior = iter ? its.find((i) => i.num === iter.num - 1) : null;
  const year = Number(String(c.cycle.effective).slice(0, 4));
  const props = all ? c.properties : c.properties.filter((p) => (String(p.market || '').trim() || 'Other') === P.region);
  const locked = all ? false : (!iter || !!iter.finalizedAt);   // the All view locks per row
  const merged = payMergedRaises(c);
  // card math: every allocated person counts — home people from the selected
  // iteration, foreign-home people from their own region's latest chain
  const raises = {};
  const hiddenByCode = {};
  if (all) {
    for (const [k, m] of Object.entries(merged)) raises[k] = m.pct;
    const latest = {};
    for (const i of c.iterations) { const cur = latest[i.region]; if (!cur || i.num > cur.num) latest[i.region] = i; }
    for (const i of Object.values(latest)) Object.assign(hiddenByCode, i.hidden || {});
  } else if (iter) {
    for (const p of c.people) {
      if (p.homeRegion === P.region) raises[p.key] = iter.entries[p.key] ? Number(iter.entries[p.key].pct) : 0;
      else if (iter.foreignRaises && p.key in iter.foreignRaises) raises[p.key] = Number(iter.foreignRaises[p.key]);
    }
    Object.assign(hiddenByCode, iter.hidden || {});
  }
  const calc = Object.fromEntries(props.map((p) => [p.code, payPropCalc(c, p.code, raises, hiddenByCode[p.code])]));
  const totCur = props.reduce((a, p) => a + calc[p.code].curMo, 0);
  const totNew = props.reduce((a, p) => a + calc[p.code].newMo, 0);
  const totDyr = props.reduce((a, p) => a + calc[p.code].dYrB, 0);
  const totPct = totCur ? (totNew - totCur) / totCur : 0;
  // three tiers, mockup semantics: red = beats the property's budgeted income
  // growth, amber = above the 3–4% guidance, green = within it
  const payTier = (pct, growth) => (growth != null && pct > growth + 0.0001) ? 'bad' : pct > 0.0401 ? 'warn' : 'good';
  const TIER_LABEL = { bad: 'exceeds income growth', warn: 'above 4% guidance', good: 'within guidance' };
  for (const p of props) calc[p.code].tier = payTier(calc[p.code].pct, payIncomeGrowth(p.code, year));
  const statusHtml = (code) => {
    if (all) return '';   // statuses live on each region's own chain
    const stat = iter && iter.propStatus && iter.propStatus[code];
    return `<div style="display:flex; align-items:center; gap:6px; margin-top:4px">
      <select class="pay-stat" data-code="${code}" ${locked ? 'disabled' : ''}>
        ${PAY_STATUSES.map(([v, l]) => `<option value="${v}" ${stat && stat.status === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      ${stat ? `<span class="muted" style="font-size:11px">${esc(stat.by)} · ${fmtd(stat.at)}</span>` : ''}
    </div>`;
  };
  const cardHtml = (title, pct, cur, nxt, dyr, growth, units, status) => `
    <div class="paycard ${payTier(pct, growth)}">
      <div class="pc-top"><span>${esc(title)}</span><span class="pc-badge">${TIER_LABEL[payTier(pct, growth)]}</span></div>
      <div class="pc-big">${(pct * 100 >= 0 ? '+' : '')}${(pct * 100).toFixed(1)}%</div>
      <div class="muted">${paySigned(dyr)}/yr burdened · wages $${money(cur)} → $${money(nxt)}/mo · $${money(cur * 12)} → $${money(nxt * 12)}/yr</div>
      <div class="muted">${growth != null ? `rental income growth +${(growth * 100).toFixed(1)}%` : `no ${year} budget linked`}${units ? ` · wages $${money((nxt * 12) / units)}/unit/yr` : ''}</div>
      ${status || ''}
    </div>`;
  return `<div class="card">
    <div class="row" style="align-items:center; gap:8px; flex-wrap:wrap">
      <button class="paypill payreg ${all ? 'on' : ''}" data-reg="*" title="Everyone, once — edits land on each person's home-region chain">All regions</button>
      ${c.regions.map((r) => `<button class="paypill payreg ${!all && r === P.region ? 'on' : ''}" data-reg="${esc(r)}">${esc(r)}</button>`).join('')}
      <span class="spacer"></span>
      ${its.map((i) => `<button class="paypill payit ${iter && i.id === iter.id ? 'on' : ''}" data-it="${i.id}">Iteration ${i.num}${i.finalizedAt ? ' ✓' : ''}</button>`).join('')}
      ${prior ? `<label class="muted" style="font-size:12px"><input type="checkbox" id="pay-cmp" ${P.compare ? 'checked' : ''}> changes vs #${prior.num}</label>` : ''}
    </div>
    ${all ? `<p class="muted" style="font-size:12px; margin:8px 0 0">
      Every region at its latest iteration · each person once, in their home region · edits save to that region's chain (a ✓-finalized region is read-only here) · raises effective ${esc(c.cycle.effective)}
    </p>` : ''}
    ${iter ? `<p class="muted" style="font-size:12px; margin:8px 0 0">
      Iteration ${iter.num} · started by ${esc(iter.createdBy)} ${fmtd(iter.createdAt)}${iter.basedOn ? ` · based on #${iter.num - 1}` : ''}
      ${iter.finalizedAt ? ` · <b>finalized by ${esc(iter.finalizedBy)} ${fmtd(iter.finalizedAt)}</b> — read-only` : ' · draft'}
      · raises effective ${esc(c.cycle.effective)} · burden est. FICA+SUTA+WC
    </p>` : ''}
    <div class="paycards">
      ${cardHtml(`${all ? 'All regions' : P.region} · ${props.length} properties`, totPct, totCur, totNew, totDyr, null, props.reduce((a, p) => a + (p.units || 0), 0), '')}
      ${props.map((p) => cardHtml(p.code.toUpperCase(), calc[p.code].pct, calc[p.code].curMo, calc[p.code].newMo, calc[p.code].dYrB, payIncomeGrowth(p.code, year), p.units, statusHtml(p.code))).join('')}
    </div>
    ${all ? (() => {
      // every region's latest iteration and whether it is final; admins finalize the drafts from here
      const latest = {};
      for (const i of c.iterations) { const cur = latest[i.region]; if (!cur || i.num > cur.num) latest[i.region] = i; }
      const list = Object.values(latest).sort((a, b) => String(a.region).localeCompare(String(b.region)));
      const drafts = list.filter((i) => !i.finalizedAt);
      return `<div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap; align-items:center">
        ${list.map((i) => `<span class="paypill" style="cursor:default" title="${i.finalizedAt ? `finalized by ${esc(i.finalizedBy || '')} ${fmtd(i.finalizedAt)}` : 'draft — entries can still change'}">${esc(i.region)} · iteration ${i.num} ${i.finalizedAt ? '✓ final' : 'draft'}</span>`).join('')}
        ${c.viewer.isAdmin && drafts.length ? `<button class="btn paygold" id="pay-final-all" title="Locks every raise entry in each region's draft iteration. A region that is already final is left alone.">Finalize ${drafts.length === list.length ? 'all' : 'the'} ${drafts.length} draft region${drafts.length === 1 ? '' : 's'}</button>` : ''}
        ${!drafts.length && list.length ? '<span class="muted" style="font-size:12px">every region is final</span>' : ''}
      </div>`;
    })() : ''}
    ${c.viewer.isAdmin && iter ? `<div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap">
      ${!iter.finalizedAt ? `<button class="btn paygold" id="pay-final">Finalize iteration ${iter.num} (${esc(P.region)})</button>` : ''}
      ${iter.finalizedAt && iter.id === its[its.length - 1].id ? `<button class="btn paygreen" id="pay-next">Start iteration ${iter.num + 1} from #${iter.num}</button>` : ''}
      ${iter.finalizedAt ? `<button class="btn sub" id="pay-apply" title="Write each property's wage GLs (annual $, raise prorated from the effective month) into its ${year} budget's inputs and regenerate — taxes, benefits and bonuses follow the engine">Apply to ${year} budgets</button>` : ''}
    </div>` : ''}
  </div>
  ${payRegionTableHtml(c, props, iter, prior, locked, { totCur, totNew, totPct, totDyr }, merged)}`;
}

/* ONE table: every person exactly once, in their home region, grouped by the
   payroll workbook's sections. Region '*' covers everyone at once. */
function payRegionTableHtml(c, props, iter, prior, locked, tot, merged) {
  const P = S.pay;
  const all = P.region === '*';
  const visCodes = new Set(props.map((p) => p.code));
  const nameOf = new Map(props.map((p) => [p.code, p.name || p.code]));
  const rows = payPersonRows(c, visCodes, iter, P.compare ? prior : null, merged, P.region);
  const body = [];
  let lastKey = null;
  for (const r of rows) {
    if (r.gkey !== lastKey) {
      lastKey = r.gkey;
      const n = rows.filter((x) => x.gkey === lastKey).length;
      const label = r.glabel ? esc(r.glabel) : `${lastKey.toUpperCase()} — ${esc(nameOf.get(lastKey) || '')}`;
      body.push(`<tr class="paygrp"><td colspan="11">${label} · ${n}</td></tr>`);
    }
    body.push(payRowHtml(r));
  }
  const xUrl = all ? rUrl(`/api/payroll/cycles/${c.cycle.id}/export.xlsx`) : (iter ? rUrl(`/api/payroll/iterations/${iter.id}/export.xlsx`) : '');
  return `<div class="card paysec">
    <div class="payhead">
      <b>${all ? 'All regions' : esc(P.region)}</b><span class="muted">${rows.length} people · each listed once, in their home region · sections match the payroll workbook · ⇄ marks a split (hover for the full allocation)</span>
      <span class="spacer"></span>
      ${xUrl ? `<a class="paypill sm" href="${xUrl}" title="Excel workbook — live formulas, Raw Data sheet, importable back. RM pay is always masked in files.">⬇ Excel</a>` : ''}
      ${(all || !locked) ? `<button class="paypill sm" id="pay-ximp" title="Load raise %s from an edited export (matches rows by the Key column; each lands on that person's home-region chain)">⬆ Import raises</button>
        <input type="file" id="pay-ximp-file" accept=".xlsx,.xlsm" style="display:none">
        <span class="muted" style="font-size:12px">Set all:</span>
        <button class="paypill sm pay-setall" data-v="3">3%</button>
        <button class="paypill sm pay-setall" data-v="4">4%</button>
        <button class="paypill sm pay-setall" data-v="0">0%</button>` : ''}
    </div>
    <div class="paytblwrap"><table class="paytbl">
      <tr><th>Position</th><th>Employee</th><th>Based at</th><th>Type</th><th class="num">Current</th><th class="num">Raise %</th><th class="num" title="Hourly rates round to the nearest 25¢">New rate</th><th class="num" title="The raise actually paid after 25¢ rounding">Adj %</th><th class="num">Δ wages/mo</th><th class="num">Δ burdened/yr</th><th>By</th></tr>
      ${body.join('')}
      <tr class="paysub"><td colspan="4">${all ? 'All regions' : esc(P.region)} total (all allocations${rows.some((r) => r.hidden) ? ', masked rows included' : ''}) · annual $${money(tot.totCur * 12)} → $${money(tot.totNew * 12)}</td>
        <td class="num">$${money(tot.totCur)}/mo</td>
        <td class="num muted" style="font-size:11px">wtd avg →</td>
        <td class="num">$${money(tot.totNew)}/mo</td>
        <td class="num">${(tot.totPct * 100 >= 0 ? '+' : '')}${(tot.totPct * 100).toFixed(2)}%</td>
        <td class="num">${paySigned(tot.totNew - tot.totCur)}</td>
        <td class="num">${paySigned(tot.totDyr)}</td><td></td></tr>
    </table></div>
  </div>`;
}
function payRowHtml(r) {
  const p = r.p;
  const canEdit = !r.locked && r.iterId != null;
  const based = `${r.prim.code.toUpperCase()} ${Math.round(r.prim.pct * 100)}%${r.splitTip ? ` <span class="muted" title="${esc(r.splitTip)}" style="cursor:help">⇄${r.splitN ? ` +${r.splitN}` : ''}</span>` : ''}`;
  const meta = [p.startDate ? `hired ${String(p.startDate).slice(0, 4)}` : '', p.oldPay ? `prior ${payRateStr(p.payMethod, p.oldPay)}` : '', p.status !== 'FULL' ? p.status : ''].filter(Boolean).join(' · ');
  if (r.hidden) {
    return `<tr><td><b>${esc(p.position)}</b></td><td>${esc(p.name)}</td><td class="muted">${based}</td><td class="muted">${p.payMethod}</td>
      <td class="num muted">•••</td>
      <td class="num"><span class="muted" style="font-size:11px" title="Regional-Manager pay — RM-pay allowlist only">🔒 TS/RC only</span></td>
      <td class="num muted">•••</td><td class="num muted">•••</td><td class="num muted">•••</td><td class="num muted">•••</td>
      <td class="muted" style="font-size:11.5px">${esc(r.by || '')}</td></tr>`;
  }
  const was = r.priorPct != null && Math.abs(r.pct - r.priorPct) > 0.001 ? ` <span class="paywas">was ${r.priorPct}%</span>` : '';
  return `<tr><td><b>${esc(p.position)}</b></td>
    <td>${esc(p.name)}${meta ? ` <span class="muted" style="font-size:11px">· ${esc(meta)}</span>` : ''}</td>
    <td class="muted">${based}</td>
    <td class="muted">${p.payMethod}</td>
    <td class="num">${payRateStr(p.payMethod, p.payRate)}</td>
    <td class="num"><input class="payin" data-key="${esc(p.key)}" data-iter="${r.iterId ?? ''}" value="${r.pct}" inputmode="decimal" ${canEdit ? '' : 'disabled'} ${!canEdit && r.locked ? 'title="This region’s iteration is finalized"' : ''} aria-label="Raise % for ${esc(p.name)}">${was}</td>
    <td class="num"><b>${payRateStr(p.payMethod, r.newRate)}</b></td>
    <td class="num muted">${(r.adj * 100).toFixed(2)}%</td>
    <td class="num">${paySigned(r.dMo)}</td>
    <td class="num">${paySigned(r.dYrB)}</td>
    <td class="muted" style="font-size:11.5px; white-space:nowrap">${r.by ? `${esc(r.by)} · ${fmtd(r.at)}` : ''}</td></tr>`;
}

function wirePayCycle(el, c) {
  const P = S.pay;
  el.querySelectorAll('.payreg').forEach((b) => b.addEventListener('click', () => { P.region = b.dataset.reg; P.iterId = null; render(); }));
  el.querySelectorAll('.payit').forEach((b) => b.addEventListener('click', () => { P.iterId = Number(b.dataset.it); render(); }));
  const cmp = el.querySelector('#pay-cmp');
  if (cmp) cmp.addEventListener('change', () => { P.compare = cmp.checked; render(); });
  const all = P.region === '*';
  const iter = all ? null : payIter();
  // every save names its iteration: the selected one in a region view, each
  // person's home-region latest in the All view (the input carries it)
  const saveEntry = async (iterId, key, pct) => {
    const r = await PUT(`/payroll/iterations/${iterId}/entries`, { key, pct });
    const it2 = c.iterations.find((i) => i.id === iterId);
    if (it2) it2.entries[key] = { pct, by: r.by, at: r.at };
  };
  el.querySelectorAll('.payin').forEach((inp) => inp.addEventListener('change', async () => {
    const iterId = Number(inp.dataset.iter);
    const pct = parseFloat(inp.value);
    if (!Number.isFinite(pct)) {
      const it2 = c.iterations.find((i) => i.id === iterId);
      inp.value = (it2 && it2.entries[inp.dataset.key] ? it2.entries[inp.dataset.key].pct : 0);
      return;
    }
    try { await saveEntry(iterId, inp.dataset.key, pct); render(); }
    catch (e) { P.err = e.message; render(); }
  }));
  el.querySelectorAll('.pay-setall').forEach((b) => b.addEventListener('click', async () => {
    const v = Number(b.dataset.v);
    const props = all ? c.properties : c.properties.filter((p) => (String(p.market || '').trim() || 'Other') === P.region);
    const rows = payPersonRows(c, new Set(props.map((p) => p.code)), iter, null, payMergedRaises(c), P.region);
    try {
      for (const r of rows) {
        if (r.hidden || r.locked || r.iterId == null || (r.p.rm && !c.viewer.canRmPay)) continue;
        await saveEntry(r.iterId, r.p.key, v);
      }
      render();
    } catch (e) { P.err = e.message; render(); }
  }));
  el.querySelectorAll('.pay-stat').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      const r = await PUT(`/payroll/iterations/${iter.id}/status`, { property: sel.dataset.code, status: sel.value });
      iter.propStatus = r.propStatus; render();
    } catch (e) { P.err = e.message; render(); }
  }));
  const ximp = el.querySelector('#pay-ximp');
  if (ximp) {
    const file = el.querySelector('#pay-ximp-file');
    ximp.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      const fd = new FormData(); fd.append('file', f);
      try {
        const r = await api(all ? `/payroll/cycles/${c.cycle.id}/import` : `/payroll/iterations/${iter.id}/import`, { method: 'POST', body: fd });
        P.msg = `Imported ${r.applied} raise(s)${r.unchanged ? ` · ${r.unchanged} unchanged` : ''}${r.fromNewRate ? ` · ${r.fromNewRate} worked back from a typed New rate` : ''}${r.zeroSkipped ? ` · ${r.zeroSkipped} left as they were (0 or blank in the file)` : ''}`
          + (r.rekeyed && r.rekeyed.length ? ` · ${r.rekeyed.length} matched by name to the current roster: ${r.rekeyed.slice(0, 6).join(', ')}${r.rekeyed.length > 6 ? '…' : ''}` : '')
          + (r.skipped.length ? ` · skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}` : '');
        await loadPayCycle(c.cycle.id); render();
      } catch (e) { P.err = e.message; render(); }
    });
  }
  const finAll = el.querySelector('#pay-final-all');
  if (finAll) finAll.addEventListener('click', async () => {
    const latest = {};
    for (const i of c.iterations) { const cur = latest[i.region]; if (!cur || i.num > cur.num) latest[i.region] = i; }
    const drafts = Object.values(latest).filter((i) => !i.finalizedAt);
    if (!confirm(`Finalize ${drafts.map((i) => `${i.region} iteration ${i.num}`).join(', ')}?\n\nEvery raise entry in those iterations locks. To change one afterwards, start that region's next iteration.`)) return;
    try {
      const r = await POST(`/payroll/cycles/${c.cycle.id}/finalize-all`, {});
      P.err = ''; P.msg = r.finalized.length ? `Finalized ${r.finalized.map((x) => `${x.region} #${x.num}`).join(', ')} — recalc the budgets to drop the "prelim" flag` : 'Every region was already final';
      await loadPayCycle(c.cycle.id); render();
    } catch (e) { P.err = e.message; render(); }
  });
  const fin = el.querySelector('#pay-final');
  if (fin) fin.addEventListener('click', async () => {
    if (!confirm(`Finalize ${P.region} iteration ${iter.num}? Every raise entry locks; the next iteration starts from this one.`)) return;
    try { const r = await POST(`/payroll/iterations/${iter.id}/finalize`, {}); iter.finalizedBy = r.finalized_by; iter.finalizedAt = r.finalized_at; render(); }
    catch (e) { P.err = e.message; render(); }
  });
  const nxt = el.querySelector('#pay-next');
  if (nxt) nxt.addEventListener('click', async () => {
    try { await POST(`/payroll/cycles/${c.cycle.id}/regions/${encodeURIComponent(P.region)}/iterations`, {}); await loadPayCycle(c.cycle.id); render(); }
    catch (e) { P.err = e.message; render(); }
  });
  const ap = el.querySelector('#pay-apply');
  if (ap) ap.addEventListener('click', async () => {
    try {
      const r = await POST(`/payroll/iterations/${iter.id}/apply`, {});
      P.msg = `Applied to ${r.applied.length} budget(s): ${r.applied.map((a) => a.code.toUpperCase()).join(', ') || '—'}`
        + (r.skipped.length ? ` · skipped ${r.skipped.map((s) => `${s.code.toUpperCase()} (${s.reason})`).join(', ')}` : '');
      await refreshState(); render();
    } catch (e) { P.err = e.message; render(); }
  });
}

/* admin: staffing report upload + RM site scoping */
function payAdminHtml(st) {
  return `<div class="card">
    <h2>Staffing data <span class="badge">admin</span></h2>
    <p class="muted" style="font-size:12px">Drop the files you already have — <b>"North Dakota Payroll - Ongoing"</b> (names, rates, property splits) and, together or later on its own, the <b>payroll detail report</b> ("_PayrollReports_Detail_…"), which cross-references canonical titles, salaried-vs-hourly per position, and each person's booked-to wage GL. One drop also refreshes the wage-aggregate model. Stored in one step behind this gate; properties the tool doesn't track are dropped.</p>
    <div class="row" style="align-items:center; gap:8px">
      <input type="file" id="pay-file" accept=".xlsx,.xls,.xlsb,.xlsm" multiple>
      <button class="btn" id="pay-upload">Load staffing files</button>
    </div>
    ${st.snapshots.length ? `<table class="list" style="margin-top:10px"><tr><th>Report</th><th>People</th><th>Loaded</th><th></th></tr>
      ${st.snapshots.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.people}</td><td>${fmtd(s.created_at)} · ${esc(s.uploaded_by || '')}</td>
        <td><button class="rb pay-delsnap" data-id="${s.id}" title="Delete (refused while a cycle uses it)">✕</button></td></tr>`).join('')}</table>` : ''}
    <h2 style="margin-top:18px">Regional managers & sites <span class="badge">admin</span></h2>
    <p class="muted" style="font-size:12px">A non-admin sees only the properties listed on their row (comma-separated codes). Users appear after their first sign-in. RM pay stays masked for everyone outside RM_PAY_USERS regardless of sites.</p>
    <table class="list"><tr><th>User</th><th>Sites</th><th></th></tr>
      ${(st.users || []).map((u) => `<tr><td>${esc(u.display || u.key)}</td>
        <td><input class="pay-sites" data-key="${esc(u.key)}" value="${esc((u.sites || []).join(', '))}" placeholder="spnd, wynd, clnd" style="min-width:220px"></td>
        <td><button class="rb pay-savesites" data-key="${esc(u.key)}">Save</button></td></tr>`).join('')}
    </table>
  </div>`;
}
function wirePayAdmin(el, st) {
  const up = el.querySelector('#pay-upload');
  if (up) up.addEventListener('click', async () => {
    const fs = [...el.querySelector('#pay-file').files];
    if (!fs.length) { S.pay.err = 'Pick the staffing file(s) first'; render(); return; }
    const fd = new FormData();
    for (const f of fs) fd.append('files', f);
    try {
      const r = await api('/payroll/staffing', { method: 'POST', body: fd });
      S.pay.msg = `Loaded ${r.people} people across ${Object.keys(r.perProperty).length} properties (${r.salaried} salaried · ${r.skippedOffPortfolio} off-portfolio rows skipped)`
        + (r.detailMatched ? ` · detail report matched ${r.detailMatched}${r.flippedToSalary ? `, ${r.flippedToSalary} flipped to salary` : ''}` : '')
        + (r.allocatedWithoutSplit.length ? ` · no split rows for: ${r.allocatedWithoutSplit.slice(0, 5).join(', ')}${r.allocatedWithoutSplit.length > 5 ? '…' : ''}` : '');
      S.pay.st = null; render();
    } catch (e) { S.pay.err = e.message; render(); }
  });
  el.querySelectorAll('.pay-delsnap').forEach((b) => b.addEventListener('click', async () => {
    try { await DEL(`/payroll/staffing/${b.dataset.id}`); S.pay.st = null; render(); }
    catch (e) { S.pay.err = e.message; render(); }
  }));
  el.querySelectorAll('.pay-savesites').forEach((b) => b.addEventListener('click', async () => {
    const inp = el.querySelector(`.pay-sites[data-key="${b.dataset.key}"]`);
    const sites = inp.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    try { await PUT(`/payroll/users/${encodeURIComponent(b.dataset.key)}/sites`, { sites }); S.pay.msg = 'Sites saved'; S.pay.st = null; render(); }
    catch (e) { S.pay.err = e.message; render(); }
  }));
}

/* ---- Settings -> Budget review checklist (Troy 2026-11-12, the "Budget Review" workbook): this region's rules, one
   per known pattern; the Summary tab's Review view checks every budget against them. Loaded on first view of
   Settings (GET /review-rules); admins edit, add, remove, or go back to the built-in rules. ---- */
function reviewRulesSettingsHtml() {
  if (!S.revRules) { GET('/review-rules').then((r) => { S.revRules = r; render(); }).catch(() => {}); return '<div class="card"><h2>Budget review checklist</h2><p class="muted">Loading…</p></div>'; }
  const R = S.revRules, admin = S.auth.isAdmin;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const kindOf = (k) => R.kinds.find((x) => x.kind === k) || {};
  const row = (r, i) => {
    const k = kindOf(r.kind);
    if (!admin) return `<tr><td><b>${esc(r.gl)}</b></td><td>${esc(r.label)}</td><td>${esc(k.label || r.kind)}${k.month && r.month ? ` · ${MON[r.month - 1]}` : ''}${k.amount && r.amount != null ? ` · $${r.amount}` : ''}${k.pct && r.pct != null ? ` · ${+(r.pct * 100).toFixed(2)}%` : ''}</td><td>${esc((r.props || []).join(', ').toUpperCase()) || 'all'}</td></tr>`;
    return `<tr data-rvi="${i}">
      <td><input data-rf="gl" value="${esc(r.gl)}" style="width:52px"></td>
      <td><input data-rf="label" value="${esc(r.label)}" style="width:100%; min-width:220px"></td>
      <td><select data-rf="kind">${R.kinds.map((x) => `<option value="${x.kind}" ${x.kind === r.kind ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></td>
      <td><select data-rf="month" ${k.month ? '' : 'disabled'}><option value=""></option>${MON.map((m, j) => `<option value="${j + 1}" ${r.month === j + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></td>
      <td><input data-rf="amount" value="${r.amount ?? ''}" ${k.amount ? '' : 'disabled'} style="width:62px; text-align:right" placeholder="$"></td>
      <td><input data-rf="pct" value="${r.pct != null ? +(r.pct * 100).toFixed(3) : ''}" ${k.pct ? '' : 'disabled'} style="width:52px; text-align:right" placeholder="%"></td>
      <td><input data-rf="props" value="${esc((r.props || []).join(', ').toUpperCase())}" placeholder="all" style="width:120px" title="Property codes the rule applies to, comma separated; blank = every property"></td>
      <td><button class="rb" data-rvdel="${i}" title="Remove this rule">✕</button></td></tr>`;
  };
  return `<div class="card">
    <h2>Budget review checklist <span class="badge">${R.rules.length}</span>${R.isDefault ? ' <span class="badge">built-in</span>' : ''}</h2>
    <p class="muted" style="margin:0 0 6px">Known patterns every budget in this region is checked against on the Summary tab's <b>Review</b> view (from the budget review workbook): a month that should stand out, every month, quarterly, the same each quarter, zero, budgeted, a $ every month, $ per unit in a month, a % over the T12, or a reminder. Properties: blank = all; list codes to keep a rule to some (e.g. Healthy Homes on the KC sites). A checklist only: nothing is changed by it.</p>
    <div style="overflow-x:auto"><table class="list rvset">
      <tr><th>GL</th><th>What to look for</th><th>Check</th><th>Month</th><th>$</th><th>%</th><th>Properties</th>${admin ? '<th></th>' : ''}</tr>
      ${R.rules.map(row).join('')}
    </table></div>
    ${admin ? `<div class="row" style="justify-content:space-between; margin-top:6px">
      <span><button class="btn sub sm" id="rv-add">+ Add rule</button> ${R.isDefault ? '' : `<button class="btn sub sm" id="rv-reset" title="Forget this region's own list and use the built-in rules again">Use built-in rules</button>`}</span>
      <button class="btn sm" id="rv-save">Save</button></div>` : ''}
  </div>`;
}
function wireReviewRules(el) {
  const R = S.revRules; if (!R || !S.auth.isAdmin) return;
  // read the table back into rules (keeps edits when a row is added or removed before saving)
  const read = () => [...el.querySelectorAll('tr[data-rvi]')].map((tr) => {
    const v = (f) => { const x = tr.querySelector(`[data-rf="${f}"]`); return x ? x.value.trim() : ''; };
    const r = R.rules[Number(tr.dataset.rvi)] || {};
    return { id: r.id || `r${Date.now().toString(36)}${tr.dataset.rvi}`, gl: v('gl'), label: v('label'), kind: v('kind'),
      month: v('month') ? Number(v('month')) : null, amount: v('amount') === '' ? null : Number(v('amount').replace(/[$,]/g, '')),
      pct: v('pct') === '' ? null : Number(v('pct').replace(/%/g, '')) / 100, props: v('props').split(/[\s,]+/).map((c) => c.toLowerCase()).filter(Boolean) };
  });
  el.querySelectorAll('tr[data-rvi] [data-rf="kind"]').forEach((sel) => sel.addEventListener('change', () => { R.rules = read(); render(); }));
  el.querySelectorAll('[data-rvdel]').forEach((b) => b.addEventListener('click', () => { const rs = read(); rs.splice(Number(b.dataset.rvdel), 1); R.rules = rs; render(); }));
  { const a = el.querySelector('#rv-add'); if (a) a.addEventListener('click', () => { R.rules = [...read(), { id: `r${Date.now().toString(36)}`, gl: '', label: '', kind: 'peak', month: 1, amount: null, pct: null, props: [] }]; render(); }); }
  { const x = el.querySelector('#rv-reset'); if (x) x.addEventListener('click', async () => { if (!confirm("Go back to the built-in review rules for this region? This region's own list is forgotten.")) return; S.revRules = { ...R, ...(await PUT('/review-rules', { reset: true })) }; S.sum = null; render(); }); }
  { const sv = el.querySelector('#rv-save'); if (sv) sv.addEventListener('click', async () => {
    const rs = read();
    if (rs.some((r) => !/^\d{4}$/.test(r.gl))) { alert('Every rule needs a four-digit GL.'); return; }
    try { S.revRules = { ...R, ...(await PUT('/review-rules', { rules: rs })) }; S.sum = null; render(); } catch (e) { alert(e.message); }
  }); }
}

/* the region's budget guidance ranges (exec team 2027 guidance by default) */
const GUIDANCE_FIELDS = [
  ['incomePct', 'Total income growth', true], ['expensePct', 'Total expense growth', true],
  ['noiPct', 'NOI growth, at least', true], ['spreadMax', 'Expense growth over income growth, at most', true],
  ['marchVsLastPct', 'March rental income vs October, at least', true],
  ['insurancePerUnit', 'Insurance $/unit/yr', false], ['reTaxPct', 'RE taxes over actuals', true],
  ['payrollPct', 'Payroll growth', true],
  ['expenseMax', 'Expense growth, at most (green at or under)', true], ['payrollMax', 'Payroll growth, at most (green at or under)', true],
  ['spPctCapital', 'SP as a share of capital', true],
  ['tolerance', 'A tie lands within ±', true],
];
function guidanceSettingsHtml(st) {
  const g = st.guidance || {};
  const box = ([k, label, pct]) => `<div class="fld"><label>${esc(label)}</label>${S.auth.isAdmin ? `<input data-gdk="${k}" ${pct ? 'data-pct="1"' : ''} value="${g[k] == null ? '' : pct ? +(g[k] * 100).toFixed(3) : g[k]}" style="width:70px; text-align:right">${pct ? ' %' : ''}` : `<b>${g[k] == null ? '—' : pct ? (g[k] * 100).toFixed(2) + '%' : g[k]}</b>`}</div>`;
  return `<div class="card">
    <h2>Budget guidance</h2>
    <p class="muted" style="margin:0 0 6px">The exec team's targets every annual budget in this region is scored against (the 2027 guidance to start): growth vs the October T12. A scorecard only — nothing is changed by it. Misses on the must-hold lines show before a Yardi export.</p>
    <div class="row" style="flex-wrap:wrap; gap:10px">${GUIDANCE_FIELDS.map(box).join('')}
      <div class="fld"><label>NOI not below the current budget</label>${S.auth.isAdmin ? `<input type="checkbox" data-gdk="noiVsCyBudget" ${g.noiVsCyBudget !== false ? 'checked' : ''}>` : `<b>${g.noiVsCyBudget !== false ? 'yes' : 'no'}</b>`}</div></div>
    ${S.auth.isAdmin ? '<div class="row" style="justify-content:flex-end; margin-top:6px"><button class="btn sm" id="gd-save">Save</button></div>' : ''}
  </div>`;
}
function renderSettings(el) {
  const st = S.state;
  const pf = new Map(st.portfolios.map((p) => [p.id, p.name]));
  el.innerHTML = `
    <div class="card">
      <h2>Properties</h2>
      <table class="list"><tr><th>Code</th><th>Name</th><th>Units</th><th>Market</th><th>Portfolio</th><th>Role</th></tr>
      ${st.properties.map((p) => `<tr><td><b>${p.code}</b></td><td>${S.auth.isAdmin ? `<input data-pname="${p.code}" value="${esc(p.name)}" style="width:190px">` : esc(p.name)}</td>
        <td>${S.auth.isAdmin ? `<input data-units="${p.code}" value="${p.units}" style="width:60px">` : p.units}</td>
        <td>${esc(p.market)}</td><td>${esc(pf.get(p.portfolio_id) || '')}</td>
        <td>${S.auth.isAdmin ? `<select data-role="${p.code}" title="subject = budgeted here: listed on the dashboard and in the New budget dialog. comp = comparison data only."><option value="subject" ${p.role === 'subject' ? 'selected' : ''}>subject</option><option value="comp" ${p.role === 'comp' ? 'selected' : ''}>comp</option></select>` : esc(p.role)}</td></tr>`).join('')}</table>
      ${S.auth.isAdmin ? '<p class="muted">Edit a name or unit count and press Enter to save. Role saves when picked: a <b>subject</b> is budgeted here (dashboard list, New budget dialog); a <b>comp</b> is comparison data only. Changing it never touches comp sets or existing budgets.</p>' : ''}
    </div>
    ${guidanceSettingsHtml(st)}
    ${reviewRulesSettingsHtml()}
    <div class="card">
      <h2>Required budget lines <span class="badge">${(st.requiredLines || []).length}</span></h2>
      <p class="muted" style="margin:0 0 6px">GLs every annual budget in this region must carry. A budget with one at zero is flagged under <b>Defaults in use</b> and before a Yardi export. One per line: <code>GL — why</code>.</p>
      ${S.auth.isAdmin ? `<textarea id="req-lines" rows="4" style="width:100%; font-family:inherit">${esc((st.requiredLines || []).map((r) => `${r.gl} — ${r.why}`).join('\n'))}</textarea>
      <div class="row" style="justify-content:flex-end; margin-top:6px"><button class="btn sm" id="req-save">Save</button></div>` : `<ul>${(st.requiredLines || []).map((r) => `<li>${esc(r.gl)} — ${esc(r.why)}</li>`).join('') || '<li class="muted">none</li>'}</ul>`}
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
      <p class="muted">Curves: flat, snow, snowContract (Nov–Apr flat), winter, heat, electric, summer, turnover. P-codes: 1, loss, 2–14 (blank = below the line). Unchecking Active removes a GL from category spreads on the next recalc — use it for comp-set GLs the subjects can't earn (e.g. 5118 COMMERCIAL RENT).</p>
    </div>`;
  el.querySelector('#coa-f').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    el.querySelectorAll('#coa-t tr[data-row]').forEach((tr) => { tr.style.display = tr.dataset.row.includes(q) ? '' : 'none'; });
  });
  el.querySelectorAll('[data-pname]').forEach((box) => box.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const p = st.properties.find((x) => x.code === box.dataset.pname);
    await POST('/properties', { ...p, code: p.code, name: box.value.trim(), portfolioId: p.portfolio_id });
    await refreshState(); render();
  }));
  wireReviewRules(el);
  { const gs = el.querySelector('#gd-save'); if (gs) gs.addEventListener('click', async () => {
    const out = {};
    el.querySelectorAll('[data-gdk]').forEach((box) => {
      const k = box.dataset.gdk;
      if (box.type === 'checkbox') out[k] = box.checked;
      else if (box.value.trim() !== '') out[k] = box.dataset.pct ? Number(box.value) / 100 : Number(box.value);
    });
    await PUT('/guidance', { guidance: out });
    await refreshState(); render();
  }); }
  { const rs = el.querySelector('#req-save'); if (rs) rs.addEventListener('click', async () => {
    const lines = el.querySelector('#req-lines').value.split('\n').map((t) => t.trim()).filter(Boolean)
      .map((t) => { const m = t.match(/^(\d{4})\s*(?:[—–:-]\s*)?(.*)$/); return m ? { gl: m[1], why: m[2] } : null; }).filter(Boolean);
    await PUT('/required-lines', { lines });
    await refreshState(); render();
  }); }
  el.querySelectorAll('[data-units]').forEach((box) => box.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const p = st.properties.find((x) => x.code === box.dataset.units);
    await POST('/properties', { ...p, code: p.code, units: Number(box.value) || 0, portfolioId: p.portfolio_id });
    await refreshState(); render();
  }));
  el.querySelectorAll('select[data-role]').forEach((sel) => sel.addEventListener('change', async () => {
    const p = st.properties.find((x) => x.code === sel.dataset.role);
    await POST('/properties', { ...p, code: p.code, portfolioId: p.portfolio_id, role: sel.value });
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
/* Prior-year move-outs from the 2027 template's MoveOuts sheet, shown under the expirations
   input as a reference (NOT an input): scheduled = 60+ days' notice, unscheduled = under 60
   days, month-to-month, skips and evictions. The ratio to expirations flags heavy months
   the way the template does (red over 40%, amber 30-40%). */
function moveOutsHtml(tpl, exp) {
  const mo = tpl && tpl.moveOuts;
  if (!mo) return '';
  const sch = mo.scheduled || [], un = mo.unscheduled || [];
  const cells = MONTHS.map((m, i) => {
    const tot = (sch[i] || 0) + (un[i] || 0), e = (exp || [])[i] || 0, r = e ? tot / e : null;
    const col = r == null ? '' : r > 0.4 ? 'var(--bad)' : r >= 0.3 ? 'var(--warn)' : 'var(--ok)';
    return `<td title="${m}: ${sch[i] || 0} scheduled + ${un[i] || 0} unscheduled = ${tot} move-outs${e ? ` · ${Math.round(r * 100)}% of ${e} expirations` : ''}" style="text-align:right;padding:1px 6px;${col ? `color:${col};font-weight:600` : ''}">${tot}</td>`;
  }).join('');
  const sum = (a) => a.reduce((s, v) => s + (v || 0), 0);
  return `<div class="fld" style="grid-column:1/-1"><label>PY move-outs (template MoveOuts sheet, reference only): ${sum(sch)} scheduled + ${sum(un)} unscheduled = ${sum(sch) + sum(un)} · colour = move-outs ÷ expirations (red over 40%, amber 30-40%)</label>
    <table style="font-size:11.5px;border-collapse:collapse"><tr>${MONTHS.map((m) => `<th style="text-align:right;font-weight:500;color:var(--muted);padding:1px 6px">${m}</th>`).join('')}</tr><tr>${cells}</tr></table></div>`;
}
const SHAPE_LABELS = { turns: 'Turnover curve: T12 total on lease expirations, +1 month lag', actual: 'Same month × factor (template default)', wavg: '1-2-1 weighted distribution × factor', flat: 'T12 total ÷ 12, flat', curve: 'T12 total on the GL seasonal curve' };

function annualInputsHtml(inp) {
  const g = inp.gpr || {};
  const l = inp.ltl || {};
  const bl = inp.baseline || {};
  const gp = bl.growthPct || {};
  const tpl = (S.bv && S.bv.template) || null;
  const exp = inp.expirations || (tpl && tpl.leaseExpirations) || [];
  const pct1 = (v) => (v == null ? '' : +(v * 100).toFixed(2));
  const corp = { ...corpDefaults(S.bv.budget.year), ...(inp.corpRates || {}) };
  const refT12 = (S.bv.refs || []).find((r) => r.key === 'actual');
  return `
    <h3>Gross potential rent · ${g.baseMonthly > 0 ? 'rent roll market rents' : 'last actual month'} × monthly % changes</h3>
    <div class="row">
      <div class="fld"><label>${S.bv && S.bv.rollMarket > 0 ? `GPR base $/mo — the rent roll${S.bv.rollAsOf ? ` as of ${esc(S.bv.rollAsOf)}` : ''} (hard-code a GPR cell to override a month)` : 'GPR base $/mo (0 = last actual month&#39;s GPR)'}</label><input id="in-gprbase" value="${g.baseMonthly ?? 0}" style="width:120px"${S.bv && S.bv.rollMarket > 0 ? ' readonly title="Always the linked rent roll&#39;s market total, all units"' : ''}></div>
      <div class="fld"><label>% increase applied IN each month (compounds; leave a month blank for no change — e.g. 3 in Mar, 2 in Sep)</label>${gprStepsGrid(g.growthPct || [], 'in-gprstep')}</div>
    </div>
    <h3>Loss to lease ${S.bv.leaseCount ? `<span class="badge">${S.bv.leaseCount} leases on file — per-lease burnoff${S.bv.rollAsOf ? ` · roll as of ${esc(S.bv.rollAsOf)} (leases ending before the budget start have already turned)` : ''}</span>` : '<span class="badge">template method: last actual month, burned off by lease expirations</span>'}</h3>
    <div class="row">
      <div class="fld"><label>Renewal %</label><input id="in-ltlrenew" value="${((l.renewalPct ?? (tpl && tpl.renewalPct) ?? 0.65) * 100).toFixed(1)}" style="width:70px"></div>
      <div class="fld"><label>Burnoff on renewal %</label><input id="in-ltlbr" value="${((l.burnoffRenew ?? 0.75) * 100).toFixed(0)}" style="width:70px"></div>
      <div class="fld"><label>Burnoff on move-in %</label><input id="in-ltlbn" value="${((l.burnoffNew ?? 1) * 100).toFixed(0)}" style="width:70px"></div>
      <label style="align-self:center" title="Market-rent growth deepens the loss to lease 1:1 (the template's 'change in market rent' row)"><input type="checkbox" id="in-ltlfollow" ${l.followGpr !== false ? 'checked' : ''}> LTL follows GPR growth</label>
      <div class="fld"><label>Method</label><select id="in-ltlmode"><option value="leases" ${l.mode !== 'ramp' && l.mode !== 'flat' ? 'selected' : ''}>Burnoff (per-lease / expirations)</option><option value="flat" ${l.mode === 'flat' ? 'selected' : ''}>Flat — hold it, no burnoff</option><option value="ramp" ${l.mode === 'ramp' ? 'selected' : ''}>Linear ramp</option></select></div>
    </div>
    <div class="row" style="margin-top:6px">
      <div class="fld"><label>Lease expirations by month (12 values — drives LTL burnoff, application / admin / deposit fees)${tpl ? ' · from the template' : ''}</label><input id="in-exp" value="${(exp || []).join(', ')}" style="width:330px" placeholder="from the rent roll"></div>
      ${moveOutsHtml(tpl, exp)}
      <div class="fld"><label>Start $/mo (neg; 0 = rent roll gap / last actual) — flat &amp; ramp</label><input id="in-ltlstart" value="${l.startMonthly ?? 0}" style="width:100px"></div>
      <div class="fld"><label>Ramp: target % of GPR</label><input id="in-ltlpct" value="${((l.targetPct || 0) * 100).toFixed(2)}" style="width:80px"></div>
    </div>
    <h3>Rental loss</h3>
    <div class="row">
      <div class="fld"><label>Vacancy % of GPR — the <b>annual average</b> (one value). Twelve values = typed month by month, used as they are.</label><input id="in-vac" value="${show12(inp.vacancyPct || [])}" style="width:220px"></div>
      <div class="fld"><label title="100 = the carry-over curve: vacancy starts at the last actual month's level, move-outs land the month after a lease expires, and empty units fill gradually (slowest in winter). 0 = the average every month; in between blends the two. The year's vacancy $ equals the average either way.">Vacancy follows move-outs &amp; carry-over %</label><input id="in-vacw" value="${Math.round(((inp.vacancyExpWeight ?? 1)) * 100)}" style="width:70px"></div>
      <span class="muted" style="align-self:center; font-size:11.5px">Delinquency, prior-period collections and concessions run at their trailing-12 / last-month ratios — change one on its row (%GPR chip) or via “% of GPR…” in the row menu.</span>
    </div>
    <h3>Baseline — every other GL = own history × increase factor</h3>
    <div class="row">
      <div class="fld"><label>History</label><select id="in-blsrc"><option value="actual" ${bl.source !== 'budget' ? 'selected' : ''}>Trailing-12 actuals${refT12 ? ` (${esc(refT12.period)})` : ''}</option><option value="budget" ${bl.source === 'budget' ? 'selected' : ''}>Current-year budget</option></select></div>
      <div class="fld"><label>Shape</label><select id="in-blshape">${['actual', 'wavg', 'flat', 'curve'].map((k) => `<option value="${k}" ${(bl.shape || 'actual') === k ? 'selected' : ''}>${SHAPE_LABELS[k]}</option>`).join('')}</select></div>
      <div class="fld"><label>MROUND $ (0 = each GL's foundation multiple)</label><input id="in-blmround" value="${bl.mround || 0}" style="width:80px"></div>
      ${(S.bv.t12Dead || []).length || (S.bv.t12Startup || []).length ? `<div class="fld"><label title="A new acquisition's first months are not a clean picture: a partial month of rent, closing entries, catch-up bills. The months left out are filled with each line's average over the months that remain. Default: the first month. At least two months are always kept.">Start-up months left out of the history${(S.bv.t12Startup || []).length ? ` <span class="muted">— now: ${esc(S.bv.t12Startup.join(', '))}</span>` : ''}</label><select id="in-startup">${[0, 1, 2, 3].map((n) => `<option value="${n}" ${(inp.startupExclude ?? 1) === n ? 'selected' : ''}>${n === 0 ? 'none' : n === 1 ? 'the first month (default)' : `the first ${n} months`}</option>`).join('')}</select></div>` : ''}
      ${S.bv.y1Plan ? (() => { const y = S.bv.y1Plan, span = y.months.length ? `${MONTHS[y.months[0]]}–${MONTHS[y.months[y.months.length - 1]]}` : ''; return `<div class="fld"><label title="This property's Year-1 (acquisition) budget ties to the underwriting NOI and its 12 ownership months run into this year. With this on, the WHOLE year runs off that budget: ${span} are its amounts (Year 1 lands on the underwriting), and the months after carry its same months a year earlier on the UW book's Year-2 trend by category. Inside each category the rows are fitted to what has posted since closing (the fit % beside this) and turn lines follow the turn curve; category totals stay on UW. Interest, principal and SP are not touched; locked lines are not moved.">Year-1 plan (${span}${y.acq && y.acq.afterIdx.length ? ` + ${MONTHS[y.acq.afterIdx[0]]}–${MONTHS[y.acq.afterIdx[y.acq.afterIdx.length - 1]]} on the UW trend` : ''}) <span class="muted">— Year 1 NOI ${money(y.y1Noi)} vs ${y.uwNoi != null ? 'UW ' + money(y.uwNoi) : 'plan ' + money(y.planNoi)}</span></label><select id="in-y1plan"><option value="1" ${inp.y1Plan !== false ? 'selected' : ''}>the whole year from the Year-1 budget</option><option value="0" ${inp.y1Plan === false ? 'selected' : ''}>this budget's own formulas</option></select></div>${y.on && y.acq ? `<div class="fld"><label title="How far the months posted since closing (${y.acq.postedMonths} on file${y.acq.start ? `, ownership from ${esc(y.acq.start)}` : ''}) move each category's mix of GLs away from the Year-1 budget's: 0% = the budget's mix, 100% = the posted mix. Category totals do not move, so NOI stays on UW.">Fit rows to posted actuals <span class="muted">(${y.acq.postedMonths} mo posted)</span></label><input id="in-acqfit" value="${Math.round((inp.acqFit ?? y.acq.fit) * 100)}" style="width:52px; text-align:right"> %</div>` : ''}`; })() : ''}
      <div class="fld"><label title="History-based expense lines (admin, marketing, utilities, R&M, rehab) are tilted so December runs this much above January, in a straight line. The YEAR TOTAL does not change — only when the dollars land. 0 = off. Not applied to payroll, taxes, insurance, the fee or contract-flat lines.">Cost drift within the year % (Jan → Dec)</label><input id="in-drift" value="${+(((bl.costDrift ?? 0.03)) * 100).toFixed(2)}" style="width:70px"></div>
      <label style="align-self:center" title="The Yardi template carries Conservice's per-GL per-month utility % forecasts. The GRKS foundation used a flat 5% instead; tick to apply the forecast where one exists."><input type="checkbox" id="in-blutil" ${bl.useUtilForecast ? 'checked' : ''}> Use Conservice utility forecasts</label>
    </div>
    <p class="muted" style="font-size:11px; margin:4px 0 0">Per-GL defaults follow the <b>GRKS 2026 draft's formulas</b> (the foundation): same-month × factor with MROUND $10/$50, the 1-2-1 weighted average for utilities and volatile fees (MROUND $25–$250), trailing-12 ÷ 12 flat for small/erratic lines (only when the T12 exceeds $1,000), October actual flat for taxes, phones and HAP. Shape and factor set here apply where the GL has no rule; a line's own chip input or “Own T12 → shape × factor…” wins over both.</p>
    <div class="row" style="margin-top:6px">
      ${ANNUAL_CATS.map(([p, label]) => `<div class="fld"><label>${label} %</label><input class="in-blpct" data-p="${p}" value="${gp[p] == null ? '' : pct1(gp[p])}" placeholder="per GL" title="Blank = each GL keeps its own foundation factor. A typed % applies to EVERY trailing-12 × factor line in the category (it outranks the per-GL factors; a GL's own typed factor still wins)." style="width:70px"></div>`).join('')}
    </div>
    <p class="muted" style="font-size:11px; margin:4px 0 0"><b>Blank = each GL's own foundation factor.</b> A typed category % moves every trailing-12 × factor line in that category (clear it to go back). GRKS factors by section: other income 0%, reims 5%, admin 5%, maintenance / CAM / contract services 10%, rehab 15%, utilities 5% (trash 7%, internet 3%).</p>
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
      ${(() => {
        const acq = S.bv.acquisition || {}, fy = inp.mgmtFirstYear || null;
        const pct = fy && fy.pct !== undefined ? fy.pct : acq.firstYearPct;
        const start = (fy && fy.start) || acq.start || '';
        return `<div class="fld"><label title="The first 12 months of ownership earn this rate; the months after earn the regular % to the left. The fee bills a month in arrears, so the rate follows the month the income was earned. Blank = no first-year rate.${acq.firstYearPct != null ? ' On file from the acquisition budget: ' + (acq.firstYearPct * 100).toFixed(2) + '%.' : ''}">First-year fee % <span class="muted">— first 12 months of ownership</span></label><input id="in-mgmt1" value="${pct != null && pct > 0 ? +(pct * 100).toFixed(2) : ''}" placeholder="none" style="width:70px"></div>
      <div class="fld"><label title="The first month of ownership (YYYY-MM).${acq.start ? ' On file: ' + acq.start + '.' : ''}">Ownership began</label><input id="in-acq" value="${esc(start)}" placeholder="YYYY-MM" style="width:90px"></div>`;
      })()}
      <div class="fld"><label>Units</label><input id="in-units" value="${inp.units ?? 0}" style="width:70px"></div>
      <div class="fld"><label>Capital $ (CoC)</label><input id="in-cap" value="${inp.capital ?? 0}" style="width:110px"></div>
      ${tpl && tpl.debt && tpl.debt.interest.some((v) => v) ? `<span class="muted" style="align-self:center; font-size:11.5px">Interest &amp; principal come from the Yardi amortization schedule (${esc((tpl.debt.loans || []).join(', '))}: interest ${money(tpl.debt.interest.reduce((a, b) => a + b, 0))}/yr).</span>` : `<div class="fld"><label>Loan $ (no schedule on file)</label><input id="in-loan" value="${inp.loan ?? 0}" style="width:110px"></div><div class="fld"><label>Rate %</label><input id="in-rate" value="${((inp.rate || 0) * 100).toFixed(2)}" style="width:70px"></div>`}
      ${(() => {
        const rl = S.bv.rosterLink, manual = inp.wageSource === 'manual';
        const stat = rl ? `"${esc(rl.label)}", effective ${esc(rl.effective)} — ${rl.regions.map((r) => `${esc(r.region)} ${r.num == null ? 'no iteration yet (0% raise)' : `iteration ${r.num} ${r.finalized ? 'finalized' : 'draft'}`}`).join(', ')}`
          : `no raise cycle effective in ${S.bv.budget.year} books staff to this property — using the fallback until one does`;
        return `<div class="fld"><label>Wages come from <span class="muted">— ${stat}</span></label><select id="in-wagesrc" title="Payroll tab: wage lines = the roster's current rates with each person's raise from the raise cycle (latest entries, drafts included), phased in the same way every year: half the increase in February, all of it from March. Fallback / own history: the payroll model if one is linked, else trailing-12 wages × the raise % below.">
          <option value="payroll" ${manual ? '' : 'selected'}>Payroll tab — roster + its raise % (default)</option>
          <option value="manual" ${manual ? 'selected' : ''}>This budget's own history × the raise % below</option></select></div>`;
      })()}
      <div class="fld"><label>Fallback raise % — used only when wages are NOT on the Payroll tab: wages flat × (1 + raise), model wages step up in March${S.bv.rosterLink && inp.wageSource !== 'manual' ? ' <b>(not in use on this budget — raises come from the Payroll tab)</b>' : ''}</label><input id="in-raise" value="${((inp.payrollRaisePct ?? 0.035) * 100).toFixed(1)}" style="width:70px"></div>
      <div class="fld"><label>Utility reimbursements (5164–5174)</label><select id="in-utilbill" title="Flat fee: residents pay an in-house flat utility fee per occupied unit (BCND; PHND / FHND since fall 2026), so the income is the most recent actual month scaled to each month's budgeted occupancy — flat, no GPR link. RUBS / history: each GL's own trailing-12 × factor (Conservice billing)."><option value="rubs" ${((inp.utilities && inp.utilities.billing) || (S.bv.flatFeeSite ? 'flat' : 'rubs')) === 'flat' ? '' : 'selected'}>RUBS / history (T12 × factor)${S.bv.flatFeeSite ? '' : ' — site default'}</option><option value="flat" ${((inp.utilities && inp.utilities.billing) || (S.bv.flatFeeSite ? 'flat' : 'rubs')) === 'flat' ? 'selected' : ''}>Flat fee — last month × budgeted occupancy${S.bv.flatFeeSite ? ' — site default' : ''}</option></select></div>
      <div class="fld"><label>Other payroll lines (taxes, benefits, bonus, OT …) = % of wages from</label><select id="in-burden"><option value="t12" ${(inp.burdenBasis || 't12') === 't12' ? 'selected' : ''}>T12 actual ratio</option><option value="budget" ${inp.burdenBasis === 'budget' ? 'selected' : ''}>CY budget ratio</option><option value="mix" ${inp.burdenBasis === 'mix' ? 'selected' : ''}>Average of T12 actual &amp; CY budget</option></select></div>
      ${(() => {
        const own = String(S.bv.budget.property_code || '').toLowerCase();
        const have = [...new Set(((S.state && S.state.stmtSnapshots) || []).filter((x) => x.kind === 'actual').map((x) => String(x.property_code).toLowerCase()))].filter((c) => c !== own).sort();
        const cur = String(inp.burdenFrom || '').toLowerCase();
        const bs = S.bv.burdenSrc;
        const nameOf = (c) => ((S.state.properties.find((p) => p.code === c) || {}).name || '');
        return `<div class="fld"><label title="Where the % of wages and its month-by-month shape come from for taxes, benefits, bonus, overtime and the other non-wage payroll lines. Borrowing from another property is for a site whose own history is thin or unusual (a new acquisition). Wages always stay this property's own; employee rent and any line with its own shape are not affected.">…ratio and monthly shape taken from${cur && bs && !bs.found ? ` <span style="color:var(--bad)">— no statements on file for ${esc(cur.toUpperCase())}; using this property's own</span>` : ''}</label><select id="in-burdenfrom"><option value="">this property's own history</option>${have.map((c) => `<option value="${esc(c)}" ${cur === c ? 'selected' : ''}>${esc(c.toUpperCase())}${nameOf(c) ? ' — ' + esc(nameOf(c)) : ''}</option>`).join('')}</select></div>`;
      })()}
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
  // a box left at the year's default is NOT saved onto the budget — it keeps following the
  // engine's rate (a pinned default is how a 2027 budget would have kept the 2026 6310 rate)
  const corpDef = corpDefaults(S.bv.budget.year);
  for (const [gl, v] of Object.entries(corpRates)) {
    const d = corpDef[gl];
    if (d && (Number(v.perUnitYr) || 0) === (d.perUnitYr || 0) && (Number(v.flatMo) || 0) === (d.flatMo || 0)) delete corpRates[gl];
  }
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
    gpr: { baseMonthly: num('#in-gprbase'), growthPct: readGprSteps(el, 'in-gprstep', (cur.gpr || {}).growthPct) },
    ltl: {
      ...(cur.ltl || {}),
      mode: q('#in-ltlmode').value,
      renewalPct: num('#in-ltlrenew') / 100, burnoffRenew: num('#in-ltlbr') / 100, burnoffNew: num('#in-ltlbn') / 100,
      followGpr: q('#in-ltlfollow').checked,
      startMonthly: num('#in-ltlstart'), targetPct: num('#in-ltlpct') / 100, rampMonths: 12,
    },
    expirations: expVals.length === 12 ? expVals : null,
    vacancyPct: parse12(q('#in-vac').value, cur.vacancyPct || Array(12).fill(0.05)),
    vacancyExpWeight: q('#in-vacw') ? Math.min(1, Math.max(0, num('#in-vacw', 100) / 100)) : (cur.vacancyExpWeight ?? 1),
    mgmtPct: num('#in-mgmt') / 100,
    // first-year fee: only stored when it differs from what is on file (the acquisition budget /
    // the template's acquisition date), so an untouched box keeps following those
    mgmtFirstYear: (() => {
      if (!q('#in-mgmt1')) return cur.mgmtFirstYear;
      const acq = S.bv.acquisition || {};
      const raw = String(q('#in-mgmt1').value || '').trim();
      const pct = raw === '' ? null : Math.max(0, parseFloat(raw.replace(/[%,]/g, '')) || 0) / 100;
      const start = String(q('#in-acq').value || '').trim() || null;
      const same = Math.abs((pct || 0) - (acq.firstYearPct || 0)) < 1e-9 && (start || null) === (acq.start || null);
      return same ? null : { pct, start };
    })(),
    payrollRaisePct: num('#in-raise') / 100,
    wageSource: q('#in-wagesrc') ? q('#in-wagesrc').value : (cur.wageSource || 'payroll'),
    ...(q('#in-startup') ? { startupExclude: Number(q('#in-startup').value) } : {}),
    burdenBasis: q('#in-burden') ? q('#in-burden').value : (cur.burdenBasis || 't12'),
    ...(q('#in-burdenfrom') ? { burdenFrom: q('#in-burdenfrom').value || null } : {}),
    ...(q('#in-y1plan') ? { y1Plan: q('#in-y1plan').value === '0' ? false : (cur.y1Plan === false ? true : cur.y1Plan) } : {}),
    // posted-actuals fit for a new acquisition's whole-year plan: stored only when it differs from what is in force
    ...(() => { const el = q('#in-acqfit'); if (!el) return {}; const v = parseFloat(String(el.value).replace(/[%\s]/g, '')); if (!Number.isFinite(v)) return {}; const f = Math.min(1, Math.max(0, v / 100)); const now = cur.acqFit ?? ((S.bv.y1Plan || {}).acq || {}).fit; return Math.abs(f - now) > 1e-9 ? { acqFit: f } : {}; })(),
    utilities: { ...(cur.utilities || {}), billing: q('#in-utilbill') ? q('#in-utilbill').value : ((cur.utilities || {}).billing || 'rubs') },
    baseline: { ...(cur.baseline || {}), source: q('#in-blsrc').value, shape: q('#in-blshape').value, mround: num('#in-blmround'), costDrift: q('#in-drift') ? Math.max(0, num('#in-drift', 3)) / 100 : (cur.baseline || {}).costDrift, growthPct, useUtilForecast: q('#in-blutil').checked },
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
    ${Object.entries(SHAPE_LABELS).filter(([k]) => (k !== 'curve' || glHasCurve(gl)) && (k !== 'flat' || curShape === 'flat')).map(([k, label]) => `<button data-sh="${k}">${shapeChip(k)} ${curShape === k ? '✓ ' : ''}${label}</button>`).join('')}
    ${RETIRED_SHAPES.filter(([k]) => k === curShape).map(([k, t]) => `<button data-sh="${k}" disabled title="No longer offered; this line keeps it until you pick another">${shapeChip(k)} ✓ ${t}</button>`).join('')}
    <button data-sh="" style="color:var(--dim)">Template default for this GL</button>
    ${hasT12(gl) && !(line && line.driver && FIT_SKIP.has(line.driver.method) && !line.override) ? `<div class="rm-head" style="margin-top:4px">Monthly spread</div><button data-fit="1" title="Lean this line's months toward its own trailing-12 months; the year total does not change">Fit to T12 %… <span class="muted">(now ${Math.round(((bl.glFit || {})[gl] ?? fitOfLine(line)) * 100)}%)</span></button>` : ''}`;
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.left + window.scrollX - 40)}px`;
  menu.style.top = `${r.bottom + window.scrollY + 2}px`;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  { const fb = menu.querySelector('button[data-fit]'); if (fb) fb.addEventListener('click', async () => {
    menu.remove();
    const cur = Math.round(((bl.glFit || {})[gl] ?? fitOfLine(line)) * 100);
    const f = parseFloat(String(prompt(`Fit to T12 % for ${gl} ${acc.name || ''}\n0 = the formula's own months, 50 = half and half, 100 = its trailing-12 months. The year total does not change.`, String(cur)) || '').replace(/[%,]/g, ''));
    if (!(Number.isFinite(f) && f >= 0 && f <= 100)) return;
    pushUndo();
    if (line && line.override) S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { override: false });
    S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...bl, glFit: { ...(bl.glFit || {}), [gl]: f / 100 } } } });
    render();
  }); }
  menu.querySelectorAll('button[data-sh]').forEach((btn) => btn.addEventListener('click', async () => {
    const shape = btn.dataset.sh;
    menu.remove();
    const g = parseFloat(String(prompt(`Increase factor % on ${gl} ${acc.name || ''} (blank = keep ${curPct != null ? (curPct * 100).toFixed(1) + '%' : 'the category default'}):`, curPct != null ? (curPct * 100).toFixed(1) : '') || '').replace(/,/g, ''));
    const glShape = { ...(bl.glShape || {}) };
    if (shape) glShape[gl] = shape; else delete glShape[gl];
    const glGrowth = { ...(bl.glGrowth || {}) };
    if (Number.isFinite(g)) glGrowth[gl] = g / 100;
    const glFit = { ...(bl.glFit || {}) };
    if (FIT_SHAPES.has(shape)) {
      const curFit = Math.round(((bl.glFit || {})[gl] ?? ((line && line.driver && line.driver.fit) || 0)) * 100);
      const f = parseFloat(String(prompt(`Fit to T12 % for ${gl} ${acc.name || ''}\n0 = the pure curve, 50 = half curve / half its own T12 months, 100 = the T12 months themselves. The year total does not change.`, String(curFit)) || '').replace(/[%,]/g, ''));
      if (Number.isFinite(f) && f >= 0 && f <= 100) glFit[gl] = f / 100;
    }
    pushUndo();
    if (line && line.override) S.bv = await PUT(`/budgets/${b.id}/lines/${gl}`, { override: false });
    S.bv = await PUT(`/budgets/${b.id}`, { inputs: { baseline: { ...bl, glShape, glGrowth, glFit } } });
    render();
  }));
}

/* Upload preview for the Yardi budget template / Monarch statements: one row
   per file, property guessed from the file, relink option. */
function renderAnnualUploadPreview(el, parsed) {
  const files = parsed.files || [];
  const isTpl = parsed.kind === 'yardi_template';
  const isPay = parsed.kind === 'payroll_template';
  el.innerHTML = `<h3>${isTpl ? 'Yardi budget templates' : isPay ? 'Payroll Budget Workbook — property payroll sheets' : 'Monarch statements'} — one per property</h3>
    ${isPay ? '<p class="muted" style="font-size:11.5px">Only the GL × month table (§3, the paste table) is read — the employee sections are never read. Saved as a reference: it shows under each payroll GL and ties out against the budget\'s own payroll lines; it never changes a line.</p>' : ''}
    <div class="mapping"><table class="list"><tr><th>File</th><th>${isTpl ? 'Template' : isPay ? 'Sheet' : 'Statement'}</th><th>Period</th><th>Rows</th><th>${isPay ? 'Payroll total' : 'GPR (T12)'}</th><th>${isTpl ? 'Units · capital · last actual' : 'Kind'}</th><th>Property</th></tr>
    ${files.map((f, i) => {
      if (f.error) return `<tr><td>${esc(f.filename)}</td><td colspan="6" class="neg">✗ ${esc(f.error)}</td></tr>`;
      const st = isTpl ? f.actual : f.statement;
      const t = f.template;
      const known = S.state.properties.some((p) => p.code === f.propertyGuess);
      return `<tr>
        <td>${esc(f.filename)}</td>
        <td>${esc(isTpl ? `${t.name} (${t.code}) · budget ${t.budgetYear}` : st.label)}${isTpl && (f.skippedSheets || []).length ? ` <span class="badge" title="Never read — restricted individual compensation">payroll sheet skipped</span>` : ''}</td>
        <td>${esc(st.period || '')}${isTpl ? `<div class="muted" style="font-size:10.5px">budget ${esc(f.budget.period || '')}</div>` : ''}</td>
        <td>${st.rows.length}</td><td>${money(isPay ? st.total : st.gpr)}</td>
        <td>${isTpl ? `${t.units}u · ${money(t.capital)} · ${esc(String(t.lastActual.year))}-${String(t.lastActual.month).padStart(2, '0')}` : isPay ? `FY ${st.year} payroll template` : (st.kind === 'budget' ? 'CY budget' : 'actuals')}</td>
        <td><select data-map="${i}">${propOptions(known ? f.propertyGuess : guessProp(st.label))}${f.propertyGuess && !known && !isPay ? `<option value="${esc(f.propertyGuess)}" selected>${esc(f.propertyGuess)} — NEW property (${esc(isTpl ? t.name : st.label)})</option>` : ''}</select></td>
      </tr>`; }).join('')}</table></div>
    <div class="row" style="margin-top:10px">
      ${isPay ? '' : '<label style="align-self:center" title="Point every existing ANNUAL budget of a mapped property at the new data and regenerate — overrides and MROUNDs are kept"><input type="checkbox" id="up-relink" checked> Relink existing annual budgets &amp; regenerate</label>'}
      <button class="btn" id="up-apply">Save</button>
    </div>
    ${isTpl ? '<p class="muted" style="font-size:11.5px">Each template saves three things: the trailing-12 actuals statement, the current-year budget statement, and the template facts (debt schedule, fee matrix, Conservice utility forecasts, corporate suggestions, lease expirations, property info).</p>' : ''}`;
  el.querySelector('#up-apply').addEventListener('click', async () => {
    const mappings = [...el.querySelectorAll('[data-map]')].map((sel) => ({ index: Number(sel.dataset.map), propertyCode: sel.value || null })).filter((m) => m.propertyCode);
    if (!mappings.length) { S.upload.err = 'Map at least one file to a property'; render(); return; }
    const relink = isPay ? false : el.querySelector('#up-relink').checked;
    try {
      const resp = await POST('/uploads/apply', { kind: parsed.kind, filename: files.map((f) => f.filename).join(', ').slice(0, 200), payload: parsed, mappings, relink });
      S.upload.msg = `Saved ${resp.created.length} ${isTpl ? 'template(s)' : isPay ? 'payroll template sheet(s) — open the budget: reference rows under the payroll GLs and the tie-out chip' : 'statement(s)'}${relink ? ` · relinked ${resp.relinked || 0} budget(s)` : ''}`;
      S.upload.parsed = null;
    } catch (e) { S.upload.err = e.message; }
    await refreshState(); render();
  });
}

/* ============================================================================
   SUMMARY (Troy 2026-11-10) — the budget-comps layout Troy keeps in Excel
   ("Minot 2025 Budget Comps": the per-property / "Minot Avg." panel and the
   "Schedule" table), reproduced on screen with the workbook's own fills, bold
   rows and borders. Light-blue = the T12 column and growth over T12; light-green
   = the T4-annualized column and growth over T4. The panel keeps the workbook's
   colours in dark mode too.
   ========================================================================== */
const xsGr = (a, b) => (b ? (a - b) / b : null);
const xsPct = (v, dp = 1) => (v == null || !Number.isFinite(v) ? '' : `${(v * 100).toFixed(dp)}%`);
/* accounting format: "$" hard left, the number hard right, negatives in parentheses, zero as "-" */
function xsAcct(v) {
  if (v == null) return '';
  const n = Math.round(v);
  const body = n === 0 ? '-' : n < 0 ? `(${Math.abs(n).toLocaleString('en-US')})` : n.toLocaleString('en-US');
  return `<span class="xs-d">$</span><span class="xs-n">${body}</span>`;
}
const xsNum = (v) => (v == null ? '' : Math.round(v).toLocaleString('en-US'));

/* One summary panel. `s` = { labels, capital, units, t12, t4, bud }; `opts.budgetId` makes the
   three column headers editable (they are saved on that budget, no recalculation). */
function summaryPanelHtml(title, s, opts = {}) {
  const C = s.t12, D = s.t4, E = s.bud;
  const v = (col, k) => (col ? col[k] : null);
  const cap = s.capital || 0;
  const ret = (col) => (col && cap ? col.cashFlow / cap : null);
  const maint = (col) => (col ? col.inHouse + col.exterior + col.contract + col.rehab : null);
  // right-hand notes: label on one row, the green / blue figure on the next (the workbook's column G)
  const G = {};
  const note = (labelRow, text, valueRow, value, cls, dp = 1) => { G[labelRow] = `<td class="xs-g xs-glabel">${esc(text)}</td>`; G[valueRow] = `<td class="xs-g xs-gval ${cls}">${xsPct(value, dp)}</td>`; };
  note(7, 'Rental Income Growth over T4', 8, E && D ? xsGr(E.rental, D.rental) : null, 'xs-green');
  note(9, 'Total Income Growth over T4', 10, E && D ? xsGr(E.income, D.income) : null, 'xs-green');
  note(15, 'Payroll Growth over T4', 16, E && D ? xsGr(E.payroll, D.payroll) : null, 'xs-green');
  note(18, 'Maintenance Expense Growth over T4', 19, E && D ? xsGr(maint(E), maint(D)) : null, 'xs-green');
  note(22, 'Total Expense Growth net of MGMT and RE Tax', 23, E && C && C.expense ? ((E.expense - (E.tax - C.tax + E.fee - C.fee)) - C.expense) / C.expense : null, 'xs-green');
  note(25, 'Total NOI Growth over T4', 26, E && D ? xsGr(E.noi, D.noi) : null, 'xs-green');
  note(31, 'NOI Growth Excluding RE Tax (T4)', 32, E && D && (D.noi + (D.tax - E.tax)) ? (E.noi - (D.noi + (D.tax - E.tax))) / (D.noi + (D.tax - E.tax)) : null, 'xs-green');
  note(33, 'NOI Growth Excluding RE Tax & MGMT FEE (T12)', 34, E && C && C.noi ? ((E.noi + (E.tax - C.tax + E.fee - C.fee)) - C.noi) / C.noi : null, 'xs-blue', 2);
  const g = (r) => G[r] || '<td class="xs-g"></td>';
  const fpct = (k, extra = '') => `<td class="xs-f xs-blue ${extra}">${xsPct(E && C ? xsGr(E[k], C[k]) : null)}</td>`;
  // a data row: T12 on light blue, T4 on light green, the draft plain
  const line = (r, code, label, k, o = {}) => `<tr class="${o.tr || ''}">
    <td class="xs-a">${code || ''}</td><td class="xs-b">${label}</td>
    <td class="xs-c ${o.plain ? '' : 'xs-blue'} ${o.dbl ? 'xs-dbl' : ''} ${o.dtop ? 'xs-dtop' : ''}">${xsAcct(v(C, k))}</td>
    <td class="xs-d2 ${o.plain ? '' : o.dBlue ? 'xs-blue' : 'xs-green'} ${o.dbl ? 'xs-dbl' : ''} ${o.dtop ? 'xs-dtop' : ''}">${o.noD ? '' : xsAcct(v(D, k))}</td>
    <td class="xs-e ${o.dbl ? 'xs-dbl' : ''}">${xsAcct(v(E, k))}</td>
    ${o.noF ? '<td class="xs-f0"></td>' : fpct(k, o.f || '')}${g(r)}</tr>`;
  const blank = (r) => `<tr class="xs-blank"><td class="xs-a"></td><td class="xs-b"></td><td class="xs-c"></td><td class="xs-d2"></td><td class="xs-e"></td><td class="xs-f0"></td>${g(r)}</tr>`;
  const hdr = (k, cls) => `<td class="${cls} xs-h" ${opts.budgetId ? `data-xslabel="${k}" title="Click to rename this column header — for example the T12 you are comparing to"` : ''}>${esc(s.labels[k])}</td>`;
  return `<div class="xsum"><table>
    <tr><td class="xs-a"></td><td class="xs-b xs-title" colspan="6">${esc(title)}</td></tr>
    <tr class="xs-blank"><td colspan="7"></td></tr>
    <tr class="xs-hrow"><td class="xs-a"></td><td class="xs-b"></td>${hdr('t12', 'xs-c')}${hdr('t4', 'xs-d2 xs-left')}${hdr('draft', 'xs-e')}<td class="xs-f0"></td><td class="xs-g"></td></tr>
    <tr class="xs-blank"><td class="xs-a"></td><td class="xs-b"></td><td class="xs-c"></td><td class="xs-d2"></td><td class="xs-e"></td><td class="xs-f0"></td><td class="xs-g"></td></tr>
    <tr><td class="xs-a"></td><td class="xs-b">Capital Contributed</td><td class="xs-c">${xsAcct(cap || null)}</td><td class="xs-d2">${xsAcct(cap || null)}</td><td class="xs-e">${xsAcct(cap || null)}</td><td class="xs-f0"></td><td class="xs-g"></td></tr>
    <tr><td class="xs-a"></td><td class="xs-b">Unit Count</td><td class="xs-c xs-r">${xsNum(s.units)}</td><td class="xs-d2 xs-r">${xsNum(s.units)}</td><td class="xs-e xs-r">${xsNum(s.units)}</td><td class="xs-f xs-fhead" rowspan="2">GR% Over T12</td><td class="xs-g"></td></tr>
    <tr class="xs-blank"><td class="xs-a"></td><td class="xs-b"></td><td class="xs-c"></td><td class="xs-d2"></td><td class="xs-e"></td>${g(7)}</tr>
    ${line(8, '5070', 'Total Rental Income', 'rental', { f: 'xs-ftop' })}
    ${line(9, '5190', 'Total Other Income', 'other', { dbl: true, f: 'xs-fbot' })}
    ${line(10, '', 'Total Income', 'income', { plain: true, f: 'xs-fbox' })}
    ${blank(11)}
    ${line(12, '6170', 'Fixed Admin Less RE TAXES &amp; MGMT FEE', 'fixedLess', { f: 'xs-ftop xs-fl' })}
    ${line(13, '6116', '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Real Estate Taxes', 'tax', { f: 'xs-fl' })}
    ${line(14, '6112', '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Management Fee', 'fee', { f: 'xs-fl' })}
    ${line(15, '6370', 'Admin', 'admin', { f: 'xs-fl' })}
    ${line(16, '6470', 'Payroll', 'payroll', { f: 'xs-fl' })}
    ${line(17, '6570', 'Marketing', 'marketing', { f: 'xs-fl' })}
    ${line(18, '6670', 'Utilities', 'utilities', { f: 'xs-fl' })}
    ${line(19, '6770', 'In-House', 'inHouse', { f: 'xs-fl' })}
    ${line(20, '6870', 'Exterior / CAM', 'exterior', { f: 'xs-fl' })}
    ${line(21, '6970', 'Contract Services', 'contract', { f: 'xs-fl' })}
    ${line(22, '7070', 'Rehab / Replace', 'rehab', { dbl: true, f: 'xs-fl xs-fbot' })}
    ${line(23, '', 'Total Expense', 'expense', { plain: true, dtop: true, f: 'xs-fbox' })}
    ${blank(24)}
    ${blank(25)}
    ${line(26, '', 'NOI', 'noi', { plain: true, f: 'xs-fbox' })}
    ${blank(27)}
    ${line(28, '7300', 'Int Expense', 'interest', { dBlue: true, noF: true })}
    ${line(29, '3080', '1st MTGE', 'mtg1', { dBlue: true, noF: true })}
    ${line(30, '3090', '2nd MTGE', 'mtg2', { dBlue: true, noF: true })}
    ${blank(31)}
    ${line(32, '', 'Cash Flow', 'cashFlow', { plain: true, f: 'xs-fbox' })}
    ${blank(33)}
    <tr class="xs-ret"><td class="xs-a"></td><td class="xs-b">Return</td><td class="xs-c xs-bold xs-r">${xsPct(ret(C), 2)}</td><td class="xs-d2 xs-bold xs-r">${xsPct(ret(D), 2)}</td><td class="xs-e xs-bold xs-r">${xsPct(ret(E), 2)}</td><td class="xs-f0"></td>${g(34)}</tr>
  </table></div>`;
}
function wireSummaryLabels(root, budgetId, after) {
  root.querySelectorAll('[data-xslabel]').forEach((td) => td.addEventListener('click', async () => {
    const k = td.dataset.xslabel;
    const v = prompt(`Column header (${k === 't12' ? 'the trailing-12 you are comparing to, e.g. "Nov. 23 T12"' : k === 't4' ? 'the 4-month annualized column, e.g. "Nov. T4 Ann."' : 'this budget, e.g. "Draft #2"'}).\nLeave blank to go back to the automatic header:`, td.textContent.trim());
    if (v == null) return;
    const bv = await POST(`/budgets/${budgetId}/summary-labels`, { [k]: v });
    if (after) after(bv);
  }));
}

/* ---- in a budget: Grid | Summary switch ---- */
function editorViewToggle(main) {
  if (!S.bv) return;
  if (!S.edView) S.edView = localStorage.getItem('bt-edview') || 'grid';
  const bar = main.querySelector('#undo-btn');
  if (bar && !main.querySelector('.edseg')) {
    const seg = document.createElement('span');
    seg.className = 'edseg';
    seg.innerHTML = `<button data-ev="grid" class="${S.edView === 'grid' ? 'on' : ''}" title="The month-by-month budget grid">Grid</button><button data-ev="summary" class="${S.edView === 'summary' ? 'on' : ''}" title="The budget-comps summary: T12, T4 annualized and this budget side by side">Summary</button>`;
    bar.parentElement.insertBefore(seg, bar);
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { S.edView = b.dataset.ev; localStorage.setItem('bt-edview', S.edView); render(); }));
  }
  if (S.edView !== 'summary') return;
  const ed = main.querySelector('.editor');
  if (!ed) return;
  const b = S.bv.budget;
  const prop = (S.state.properties.find((p) => p.code === b.property_code) || {});
  const holder = document.createElement('div');
  holder.className = 'xsum-holder';
  holder.innerHTML = S.bv.summary
    ? `${summaryPanelHtml(String(b.property_code).toUpperCase() + (prop.name && prop.name.toUpperCase() !== String(b.property_code).toUpperCase() ? ` — ${prop.name}` : ''), S.bv.summary, { budgetId: b.id })}
       <p class="muted" style="font-size:11.5px; margin:8px 0 0">Click a column header to rename it. Blue = the trailing-12 and growth over it; green = the last four months annualized and growth over that. ${S.bv.summary.t12 ? '' : 'No trailing-12 statement is linked to this budget, so only the budget column is filled.'}</p>`
    : '<p class="muted">No summary for this budget.</p>';
  ed.replaceWith(holder);
  // the legend row above the grid belongs to the grid view
  main.querySelectorAll('.legend').forEach((x) => { x.style.display = 'none'; });
  wireSummaryLabels(holder, b.id, (bv) => { S.bv = bv; render(); });
}

/* ---- the Summary tab (Troy 2026-11-12: "should look more like the 'Budgets' [list]. It should have all of
   the items we look at in the property level 'compare to' section, with conditional formatting based off of
   the budget guidance sheet. I do not want different panes, I just want different subtotals for each region
   that act as separators"). ONE table: the dashboard Budgets columns, then every compare-card subtotal for
   each property's latest budget of the year. A subtotal row closes each region (properties.market), and an
   all-properties total closes the table. Numbers come from GET /summary (`compareOf` in routes.ts: the same
   computeTieout as the compare card, always vs the T12 for annual budgets, UW Year 1 for acquisitions). ---- */
async function loadSummary(year) {
  S.sum = { ...(S.sum || {}), loading: true, err: '' };
  try { S.sum = { data: await GET(`/summary${year ? `?year=${year}` : ''}`), loading: false, err: '' }; }
  catch (e) { S.sum = { data: null, loading: false, err: e.message }; }
  render();
}
/* the compare card's rows, in its order. `of` = a subtotal of other rows; `d` = income detail (shown when opened) */
const SUM_COLS = [
  { k: '1', h: 'GPR', t: 'Gross Potential Rent', d: true },
  { k: 'loss', h: 'LTL', t: 'Loss to Lease', d: true },
  { k: 'ngpr', h: 'Net GPR', t: 'Net Gross Potential Rent', of: ['1', 'loss'], d: true },
  { k: '2', h: 'Conc.', t: 'Concessions', d: true },
  { k: '3', h: 'Vac / loss', t: 'Vacancy, Delinq & Other Loss', d: true },
  { k: 'rental', h: 'Rental inc', t: 'Total Rental Income', of: ['1', 'loss', '2', '3'] },
  { k: '4', h: 'Util inc', t: 'Utility Income', d: true },
  { k: '5', h: 'Other inc', t: 'Other Income', d: true },
  { k: 'oth', h: 'Other + util', t: 'Total Other + Utility Income', of: ['4', '5'] },
  { k: 'egi', h: 'Total inc', t: 'Total Income (EGI)', big: true },
  { k: '6', h: 'Insur.', t: 'Insurance' },
  { k: '7', h: 'Mgmt fee', t: 'Management Fee' },
  { k: '8', h: 'RE tax', t: 'RE & PP Taxes' },
  { k: '9', h: 'Admin', t: 'Admin & Acct' },
  { k: '10', h: 'Payroll', t: 'Payroll' },
  { k: '11', h: 'Mktg', t: 'Marketing' },
  { k: '12', h: 'Utilities', t: 'Utilities' },
  { k: '13', h: 'R&M', t: 'R&M' },
  { k: '14', h: 'Rehab', t: 'Rehab / Reserves' },
  { k: 'toe', h: 'OpEx', t: 'Total OpEx', big: true },
  { k: 'noi', h: 'NOI', t: 'NOI', big: true },
];
function sumVal(cat, c) {
  if (!cat) return null;
  const parts = c.of || [c.k];
  if (!parts.some((p) => cat[p])) return null;
  return parts.reduce((a, p) => ({ ref: a.ref + ((cat[p] || {}).ref || 0), bud: a.bud + ((cat[p] || {}).bud || 0) }), { ref: 0, bud: 0 });
}
/* The 2027 guidance memo on one compare cell (Troy 2026-11-12: "If we are above rental income, it should be
   green, not red. Reverse is true for expenses... If there is not a direct category number, you should easily
   be able to derive one"). Income numbers are FLOORS, expense numbers CEILINGS (Settings -> Budget guidance):
     rental income, total income             at least the income %            (memo 2: 3.0-3.25% over Oct T12)
     GPR, net GPR, utility / other income    at least the income %            (derived: they make up income)
     loss to lease, concessions, vacancy     share of GPR no worse than T12   (derived: contra lines of rental income)
     mgmt fee                                no faster than this row's income (derived: the fee is a % of income)
     insurance                               at most $275/unit, as % over the T12 category (memo 3)
     RE taxes, payroll                       at most their own %              (memo 3)
     admin, marketing, utilities, R&M, rehab at most the expense %            (derived: total expense target)
     OpEx                                    at most the expense % AND at most income growth + 50 bps (memo 3 *)
     NOI                                     at least the NOI %               (memo 4)
   `v` = { ref, bud } for the cell, `r` = the row (its summed categories). Returns { ok, text } or null. */
function sumGuide(G, key, v, r) {
  if (!G || !v || !v.ref) return null;
  const P = (x) => `${+(x * 100).toFixed(2)}%`;
  const cat = (r && r.cat) || {};
  const gOf = (k) => (cat[k] && cat[k].ref ? (cat[k].bud - cat[k].ref) / Math.abs(cat[k].ref) : null);
  const g = (v.bud - v.ref) / Math.abs(v.ref);
  const floor = (t, why) => ({ ok: g >= t - GUIDE_EPS, text: `${P(t)} or better (${why})` });
  const ceil = (t, why) => ({ ok: g <= t + GUIDE_EPS, text: `${P(t)} or less (${why})` });
  switch (key) {
    case 'noi': return floor(G.noiPct, 'NOI over the October T12');
    case 'rental': return floor(G.incomePct, 'rental income over the October T12');
    case 'egi': return floor(G.incomePct, 'total income over the October T12');
    case '1': case 'ngpr': case '4': case '5': case 'oth': return floor(G.incomePct, 'derived from the income target');
    case 'loss': case '2': case '3': {
      const gp = cat['1'];
      if (!gp || !gp.ref || !gp.bud) return null;
      const sr = Math.abs(v.ref) / gp.ref, sb = Math.abs(v.bud) / gp.bud;
      return { ok: sb <= sr + GUIDE_EPS / 5, text: `${P(sb)} of GPR vs ${P(sr)} on the T12 (derived: no bigger share of GPR than the T12)` };
    }
    case '7': { const gi = gOf('egi'); return gi == null ? null : { ok: g <= gi + GUIDE_EPS, text: `${P(gi)} or less (derived: the fee should grow no faster than this income)` }; }
    case '6': {
      const c = r && r.ctx;
      if (!c || !c.r6 || !c.units) return null;
      return ceil((G.insurancePerUnit * c.units + (c.r6 - (c.g6108 || 0))) / c.r6 - 1, `insurance at $${G.insurancePerUnit}/unit`);
    }
    case '8': return ceil(G.reTaxPct, 'RE taxes, unless documented');
    case '10': return ceil(payrollCeil(G), 'payroll');
    case '9': case '11': case '12': case '13': case '14': return ceil(expenseCeil(G), 'derived from the total expense ceiling');
    case 'toe': {
      const gi = gOf('egi');
      const cap = gi == null ? expenseCeil(G) : Math.min(expenseCeil(G), gi + G.spreadMax);
      return ceil(cap, gi != null && cap < expenseCeil(G) ? `income grew ${P(gi)}, and expenses may run at most ${Math.round(G.spreadMax * 10000)} bps over it` : `total expenses; also at most ${Math.round(G.spreadMax * 10000)} bps over income growth`);
    }
    default: return null;
  }
}
function renderSummary(el) {
  if (!S.sum || (!S.sum.data && !S.sum.loading && !S.sum.err)) { loadSummary(S.dashYear); el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>'; return; }
  if (S.sum.loading && !S.sum.data) { el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>'; return; }
  if (S.sum.err) { el.innerHTML = `<div class="card"><p class="err">${esc(S.sum.err)}</p></div>`; return; }
  const d = S.sum.data, G = d.guidance || null;
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } return null; };
  // two views of the same budgets: the numbers, and the review checklist (Troy 2026-11-12, "Budget Review" workbook)
  if (!S.sumView) S.sumView = store('bt-sumview') || 'numbers';
  const viewSeg = `<span class="edseg"><button data-sumview="numbers" class="${S.sumView === 'numbers' ? 'on' : ''}" title="Every property's budget against the T12 / UW, with the guidance colours">Numbers</button><button data-sumview="review" class="${S.sumView === 'review' ? 'on' : ''}" title="The budget review checklist: each known pattern (January rebates, April accounting fee, November gift cards, bonuses each quarter, snow removal...) checked on every budget">Review</button></span>`;
  const wireView = () => el.querySelectorAll('[data-sumview]').forEach((b) => b.addEventListener('click', () => { S.sumView = b.dataset.sumview; store('bt-sumview', S.sumView); render(); }));
  if (S.sumView === 'review') { renderReview(el, d, viewSeg); wireView(); return; }
  if (!S.sumMode) S.sumMode = store('bt-summode') || 'pct';
  if (S.sumDetail == null) S.sumDetail = store('bt-sumdetail') === '1';
  const mode = S.sumMode;
  const cols = SUM_COLS.filter((c) => S.sumDetail || !c.d);
  const pct = (v, dp = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(dp)}%`);
  // growth of the SIGNED reference, as on the compare card: a contra line whose loss grows reads +, like its card row
  const gr = (bud, ref) => (ref ? (bud - ref) / ref : null);
  const regions = [...new Set(d.properties.map((p) => p.region))].sort();

  /* one row's figures: a property, or the sum of several */
  function rowData(props) {
    const has = props.filter((p) => p.cmp && p.cmp.hasRef);
    // a subtotal adds like with like: the T12-based (annual) budgets when there are any, else the UW-based ones
    const kind = has.some((p) => p.cmp.refKind === 'T12') ? 'T12' : 'UW';
    const inc = has.filter((p) => p.cmp.refKind === kind);
    const cat = {};
    for (const p of inc) for (const [k, v] of Object.entries(p.cmp.cat)) { cat[k] = cat[k] || { ref: 0, bud: 0 }; cat[k].ref += v.ref; cat[k].bud += v.bud; }
    const sumOf = (f, list = props) => list.reduce((a, p) => a + (f(p) || 0), 0);
    const cyHas = props.filter((p) => p.cyBudgetNoi != null && p.cmp);
    const cap = sumOf((p) => p.cmp && p.cmp.capital);
    return {
      kind, n: props.length, nRef: inc.length, cat: inc.length ? cat : null,
      ctx: { units: sumOf((p) => p.units, inc), r6: (cat['6'] || {}).ref || 0, g6108: sumOf((p) => p.cmp.ins6108, inc) },
      income: sumOf((p) => p.cmp && p.cmp.income), expense: sumOf((p) => p.cmp && p.cmp.expense), noi: sumOf((p) => p.cmp && p.cmp.noi),
      noiVar: inc.length ? cat.noi.bud - cat.noi.ref : null, egiVar: inc.length ? cat.egi.bud - cat.egi.ref : null,
      overCy: cyHas.length ? gr(sumOf((p) => p.cmp.noi, cyHas), sumOf((p) => p.cyBudgetNoi, cyHas)) : null,
      coc: cap ? sumOf((p) => p.cmp && p.cmp.coc != null ? p.cmp.coc * p.cmp.capital : 0) / cap : null,
      units: sumOf((p) => p.units),
    };
  }
  function cmpCells(r, useGuide) {
    return cols.map((c, i) => {
      const v = sumVal(r.cat, c);
      if (!v) return `<td class="${i === 0 ? 'cmp1' : ''} muted">—</td>`;
      const g = gr(v.bud, v.ref);
      const rg = useGuide ? sumGuide(G, c.k, v, r) : null;
      const inn = rg ? rg.ok : null;
      const shown = mode === 'pct' ? pct(g) : mode === 'dlr' ? money(v.bud - v.ref) : mode === 'bud' ? money(v.bud) : money(v.ref);
      const tip = `${c.t}: ${r.kind === 'T12' ? 'T12' : 'UW Y1'} ${money(v.ref)} → budget ${money(v.bud)} (Δ ${money(v.bud - v.ref)}, ${pct(g)})${rg ? ` · guidance: ${rg.text}, ${inn ? 'met' : 'missed'}` : ''}`;
      return `<td class="${i === 0 ? 'cmp1' : ''} ${c.big ? 'big' : ''} ${inn == null ? '' : inn ? 'gin' : 'gout'}" title="${esc(tip)}">${shown}</td>`;
    }).join('');
  }
  const varCell = (v, kind) => (v == null ? '<td class="muted">—</td>' : `<td class="${Math.abs(v) < 1 ? 'tied' : v < 0 ? 'neg' : ''}" title="vs ${kind === 'T12' ? 'the T12' : 'UW Year 1'}">${Math.abs(v) < 1 ? 'tied' : money(v)}</td>`);
  const cyCell = (v) => (v == null ? '<td class="muted">—</td>' : `<td class="${v < -GUIDE_EPS ? 'gout' : 'gin'}" title="${v < -GUIDE_EPS ? 'Below the current-year budget NOI (the memo: budgets set lower than the 2026 budget are unlikely to be approved)' : 'NOI at or above the current-year budget'}">${pct(v)}</td>`);
  const guideCell = (r) => {
    if (r.kind !== 'T12' || !r.cat) return '<td class="muted">—</td>';
    const gi = gr(r.cat.egi.bud, r.cat.egi.ref), ge = gr(r.cat.toe.bud, r.cat.toe.ref), gn = gr(r.cat.noi.bud, r.cat.noi.ref);
    const low = gn != null && G && gn < G.noiPct - 1e-9;
    return `<td class="gdash ${gn != null && gn < 0 ? 'gbad' : low ? 'gchk' : 'gok'} l"><b>NOI ${pct(gn)}</b><div class="muted" style="font-size:10.5px">inc ${pct(gi)} · exp ${pct(ge)}${r.n > 1 && r.nRef < r.n ? ` · ${r.nRef} of ${r.n}` : ''}</div></td>`;
  };
  function propRow(p) {
    const r = rowData([p]), c = p.cmp || {};
    const sm = c.startMonth > 1 ? `${MONTHS[c.startMonth - 1]}-${String(d.year).slice(2)} – ${MONTHS[(c.startMonth + 10) % 12]}-${String(d.year + 1).slice(2)}` : String(d.year);
    const ov = c.overrides || 0;
    const annual = p.type === 'annual';
    return `<tr class="click" data-sumopen="${p.id}">
      <td class="l stick"><b>${esc(p.code)}</b> · ${esc(p.name || '')}${p.stale ? ' <span class="sch-stale" title="Calculated on older formulas: recalc it">⚠</span>' : ''}<div class="muted" style="font-size:10.5px">${p.units ? `${xsNum(p.units)} units` : ''}</div></td>
      <td class="l"><b>${sm}</b> <span class="muted">${annual ? 'annual' : 'acquisition · UW Y1'}</span><div class="muted" style="font-size:10.5px">${ov ? `${ov} override${ov === 1 ? '' : 's'}` : 'no overrides'}${c.ltlMode === 'leases' ? ' · per-lease LTL' : ''}${c.savePoints ? ` · ${c.savePoints} save pt${c.savePoints === 1 ? '' : 's'}` : ''}</div></td>
      <td>${money(r.income)}</td><td>${money(r.expense)}</td><td><b>${money(r.noi)}</b></td>
      ${varCell(r.noiVar, r.kind)}${varCell(r.egiVar, r.kind)}${annual ? guideCell(r) : '<td class="muted">—</td>'}
      ${cmpCells(r, annual && r.kind === 'T12')}
      ${cyCell(r.overCy)}
      <td>${c.coc != null && c.capital ? `${(c.coc * 100).toFixed(1)}%<div class="muted" style="font-size:10.5px">on ${money(c.capital)}</div>` : '—'}</td>
      <td class="l">${esc(p.status || '')}</td><td class="muted">${p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : ''}</td></tr>`;
  }
  function subRow(label, props, cls) {
    const r = rowData(props);
    return `<tr class="${cls}">
      <td class="l stick">${esc(label)} <span class="muted" style="font-weight:400">· ${props.length} budget${props.length === 1 ? '' : 's'}</span><div class="muted" style="font-size:10.5px; font-weight:400">${xsNum(r.units)} units</div></td>
      <td class="l muted" style="font-weight:400; font-size:11px">${r.cat && r.nRef < r.n ? `compare columns: ${r.nRef} of ${r.n} (${r.kind === 'T12' ? 'T12-based' : 'UW-based'})` : ''}</td>
      <td>${money(r.income)}</td><td>${money(r.expense)}</td><td>${money(r.noi)}</td>
      ${varCell(r.noiVar, r.kind)}${varCell(r.egiVar, r.kind)}${guideCell(r)}
      ${cmpCells(r, r.kind === 'T12')}
      ${cyCell(r.overCy)}
      <td>${r.coc != null ? `${(r.coc * 100).toFixed(1)}%` : '—'}</td><td></td><td></td></tr>`;
  }
  const body = regions.map((rg) => {
    const props = d.properties.filter((p) => p.region === rg).sort((a, b) => a.code.localeCompare(b.code));
    return props.map(propRow).join('') + subRow(`${rg} subtotal`, props, 'sub');
  }).join('') + (regions.length > 1 ? subRow('All properties', d.properties, 'grand') : '');
  const modeBtn = (m, label, tip) => `<button data-summode="${m}" class="${mode === m ? 'on' : ''}" title="${esc(tip)}">${label}</button>`;
  const pp = (v) => `${+(v * 100).toFixed(2)}%`;
  const gTxt = G ? `income lines ${pp(G.incomePct)} or better; NOI ${pp(G.noiPct)} or better and not below the current-year budget; expense categories ${pp(expenseCeil(G))} or less, RE taxes ${pp(G.reTaxPct)} or less, payroll ${pp(payrollCeil(G))} or less, insurance $${G.insurancePerUnit}/unit or less; OpEx ${pp(expenseCeil(G))} or less and no more than ${Math.round(G.spreadMax * 10000)} bps over income growth; loss to lease, concessions and vacancy no bigger a share of GPR than the T12; the fee no faster than income` : '';
  const modeName = { pct: 'growth', dlr: 'Δ $', bud: 'budget $', ref: 'T12 / UW $' }[mode];
  el.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap">
        <h2 style="margin:0">Summary <span class="badge">${d.properties.length} budgets</span></h2>
        <div class="row" style="align-items:center; gap:8px; flex-wrap:wrap">
          ${viewSeg}
          <span class="edseg">${modeBtn('pct', 'Δ %', 'Growth of each subtotal over the T12 (UW Year 1 for acquisitions)')}${modeBtn('dlr', 'Δ $', 'Budget minus the T12 / UW, in dollars')}${modeBtn('bud', 'Budget $', 'The budget subtotal')}${modeBtn('ref', 'T12 $', 'The T12 (UW Year 1 for acquisitions) subtotal')}</span>
          <button class="btn sub sm" id="sum-detail" title="Show or hide GPR, loss to lease, concessions, vacancy, utility and other income">${S.sumDetail ? '▾ Hide' : '▸ Show'} income detail</button>
          <label class="muted" style="font-size:12px">Budget year</label><select id="sum-year">${[...new Set([d.year, ...d.years])].sort((a, b) => b - a).map((y) => `<option value="${y}" ${y === d.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
          <button class="btn sub sm" id="sum-refresh" title="Reload from the budgets as they stand now">↻ Refresh</button>
        </div>
      </div>
      ${d.properties.length ? `<div class="sumwrap"><table class="sumtbl">
        <tr class="grp"><th class="l stick"></th><th colspan="7"></th><th class="cmp1 c" colspan="${cols.length}">Compare to T12 <span style="text-transform:none; font-weight:400">(acquisitions: UW Year 1) · ${modeName}</span></th><th colspan="4"></th></tr>
        <tr><th class="l stick">Property</th><th class="l">Budget</th><th>Income</th><th>OpEx</th><th>NOI</th><th title="NOI vs the T12 (UW Year 1 for acquisitions)">Δ NOI</th><th title="Total income vs the T12 (UW Year 1 for acquisitions)">Δ EGI</th><th class="l" title="Exec-team guidance: growth over the T12">Guidance</th>
          ${cols.map((c, i) => `<th class="${i === 0 ? 'cmp1' : ''}" title="${esc(c.t)}">${esc(c.h)}</th>`).join('')}
          <th title="NOI over the current-year budget (the guidance: never below it)">NOI vs CY bud</th><th>CoC</th><th class="l">Status</th><th class="l">Updated</th></tr>
        ${body}
      </table></div>
      <p class="muted" style="font-size:11.5px; margin:8px 0 0">Each property's latest ${d.year} budget. The compare columns are the compare card's subtotals with the same math, always against the trailing-12 for annual budgets (the guidance is growth over the T12, whatever a budget's own compare card is set to) and against UW Year 1 for acquisitions. <span class="gin-key">Green</span> = meets the 2027 guidance memo, <span class="gout-key">red</span> = misses it${gTxt ? `: ${esc(gTxt)}` : ''}. Hover a cell for the exact target and why. The colours stay on in every view. Numbers typed in a budget's own target boxes are not used here. A region subtotal adds its properties' dollars, and its growth is on those sums. Hover a cell for the T12 and budget dollars; click a property to open it.</p>`
      : `<p class="muted">No ${d.year} budgets yet.</p>`}
    </div>`;
  el.querySelector('#sum-year').addEventListener('change', (e) => loadSummary(Number(e.target.value)));
  el.querySelector('#sum-refresh').addEventListener('click', () => loadSummary(d.year));
  el.querySelector('#sum-detail').addEventListener('click', () => { S.sumDetail = !S.sumDetail; store('bt-sumdetail', S.sumDetail ? '1' : '0'); render(); });
  el.querySelectorAll('[data-summode]').forEach((b) => b.addEventListener('click', () => { S.sumMode = b.dataset.summode; store('bt-summode', S.sumMode); render(); }));
  el.querySelectorAll('[data-sumopen]').forEach((tr) => tr.addEventListener('click', async () => { await openBudget(Number(tr.dataset.sumopen)); }));
  wireView();
}

/* ---- the Review view (Troy 2026-11-12, the "Budget Review" workbook: "I would like the premise to be incorporated.
   Maybe add it as a different view"): one row per checklist rule, one column per property (grouped by region, like
   the workbook's columns by manager), Y / N / n/a with the workbook's kind of note ("Dec not Nov", "none last
   year", "also high Jul"). Checked by the server (shared/review.ts) on each budget and its trailing-12. Rules are
   edited under Settings -> Budget review checklist. ---- */
function renderReview(el, d, viewSeg) {
  const regions = [...new Set(d.properties.map((p) => p.region))].sort();
  const props = regions.flatMap((rg) => d.properties.filter((p) => p.region === rg).sort((a, b) => a.code.localeCompare(b.code)));
  const rules = d.reviewRules || [];
  const sym = { y: 'Y', n: 'N', na: 'n/a', info: '·' };
  const cellHtml = (res, p, r) => {
    if (!res) return '<td class="muted">—</td>';
    const tip = `${String(p.code).toUpperCase()} · ${r.gl} ${r.label}${res.text ? `: ${res.text}` : ''}`;
    return `<td class="rv rv-${res.status}" title="${esc(tip)}"><b>${sym[res.status] || ''}</b>${res.text ? `<div class="rvn">${esc(res.text)}</div>` : ''}</td>`;
  };
  const misses = props.map((p) => (p.review || []).filter((x) => x && x.status === 'n').length);
  el.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap">
        <h2 style="margin:0">Summary <span class="badge">${d.properties.length} budgets</span></h2>
        <div class="row" style="align-items:center; gap:8px; flex-wrap:wrap">
          ${viewSeg}
          <label class="muted" style="font-size:12px">Budget year</label><select id="sum-year">${[...new Set([d.year, ...d.years])].sort((a, b) => b - a).map((y) => `<option value="${y}" ${y === d.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
          <button class="btn sub sm" id="sum-refresh" title="Reload from the budgets as they stand now">↻ Refresh</button>
        </div>
      </div>
      ${props.length && rules.length ? `<div class="sumwrap"><table class="sumtbl rvtbl">
        <tr class="grp"><th class="l stick"></th>${regions.map((rg) => { const n = props.filter((p) => p.region === rg).length; return `<th class="c rvgrp" colspan="${n}">${esc(rg)}</th>`; }).join('')}</tr>
        <tr><th class="l stick">Check</th>${props.map((p) => `<th class="c" title="${esc(p.name || '')}"><span class="rvp" data-sumopen="${p.id}">${esc(String(p.code).toUpperCase())}</span><div class="muted" style="text-transform:none; font-weight:400">${p.units ? `${xsNum(p.units)} u` : ''}</div></th>`).join('')}</tr>
        ${rules.map((r, i) => `<tr><td class="l stick rvrule"><b>${esc(r.gl)}</b> ${esc(r.label)}${r.props && r.props.length ? ` <span class="muted">(${esc(r.props.join(', ').toUpperCase())})</span>` : ''}</td>${props.map((p) => cellHtml((p.review || [])[i], p, r)).join('')}</tr>`).join('')}
        <tr class="sub"><td class="l stick">To look at</td>${misses.map((n) => `<td class="c ${n ? 'rv-n' : 'rv-y'}">${n || '✓'}</td>`).join('')}</tr>
      </table></div>
      <p class="muted" style="font-size:11.5px; margin:8px 0 0">Each row is a known pattern from the budget review workbook, checked on every property's latest ${d.year} budget (by calendar month) against its own trailing-12. <span class="gin-key">Y</span> = the budget follows it, <span class="gout-key">N</span> = it does not (the note says how), n/a = the rule is kept to other properties, · = a reminder to check by eye. "None last year" = the trailing-12 has nothing on that GL. Hover a cell for the detail; click a property to open it. ${d.reviewDefault ? 'These are the built-in rules for this region' : 'This region\'s own rules'}: edit them under Settings → Budget review checklist.</p>`
      : `<p class="muted">${props.length ? 'No review rules for this region: add them under Settings → Budget review checklist.' : `No ${d.year} budgets yet.`}</p>`}
    </div>`;
  el.querySelector('#sum-year').addEventListener('change', (e) => loadSummary(Number(e.target.value)));
  el.querySelector('#sum-refresh').addEventListener('click', () => loadSummary(d.year));
  el.querySelectorAll('[data-sumopen]').forEach((x) => x.addEventListener('click', async () => { await openBudget(Number(x.dataset.sumopen)); }));
}
