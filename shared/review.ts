/* ============================================================================
   BUDGET REVIEW CHECKLIST (Troy 2026-11-12, from the "Budget Review" workbook: "Some of these items will not
   apply to ND (Ex KC Healthy Homes). Either way, I would like the premise to be incorporated. Maybe add it as a
   different view").
   The workbook is a list of known patterns, one per GL — "January - high" vendor rebates, "April - 1x fee"
   accounting, "November - gift cards", "Same each quarter" bonuses, "$425/mo" consulting, "Make sure we have
   snow removal costs budgeted" — checked Y / N / n/a for every property, with a short note ("N (Dec not Nov)",
   "N, none last year", "Y, also high July"). Here each pattern is a RULE that is checked automatically against
   every budget and its trailing-12. Rules are kept per region (app_meta.review_rules); none saved = the
   region's defaults below, taken from that workbook. A rule limited to some properties is n/a elsewhere.
   Pure, no IO.
   ========================================================================== */

export type ReviewKind =
  | 'peak'           // `month` stands out: at least 1.5x the median of the other months (a one-time fee, dues, gift cards)
  | 'every'          // something budgeted in every month (a monthly revenue share, a bill that hits monthly)
  | 'quarterly'      // only in quarter months, three months apart (a quarterly revenue share)
  | 'quarterlySame'  // the four quarters carry the same amount
  | 'zero'           // nothing budgeted
  | 'present'        // something budgeted
  | 'monthlyAmount'  // `amount` every month
  | 'perUnitMonth'   // `amount` x units in `month` (Healthy Homes $20/unit in December)
  | 'pctOverT12'     // the year's total `pct` over the trailing-12 (RE taxes +3% over the bill)
  | 'notPositive'    // no month above zero (a contra-income line: concessions, vacancy)
  | 'nearT12'        // the year's total within `pct` of the trailing-12 either way (bad-debt recovery: no growth)
  | 'maxOverT12'     // the year's total at most `pct` over the trailing-12 (fixed-dollar fees: not grown at the rent rate)
  | 'monthlyAtLeast' // at least `amount` every month (the $275/mo software template line)
  | 'note';          // a reminder only, checked by eye

export interface ReviewRule {
  id: string;
  gl: string;
  /** what the reviewer is looking for, in the workbook's words */
  label: string;
  kind: ReviewKind;
  /** 1-12 (peak, perUnitMonth) */
  month?: number | null;
  /** $ (monthlyAmount: per month; perUnitMonth: per unit) */
  amount?: number | null;
  /** pctOverT12: the growth expected, as a fraction */
  pct?: number | null;
  /** property codes the rule applies to; empty = every property */
  props?: string[];
}
export const REVIEW_KINDS: { kind: ReviewKind; label: string; month?: boolean; amount?: boolean; pct?: boolean }[] = [
  { kind: 'peak', label: 'High in a month', month: true },
  { kind: 'every', label: 'Every month' },
  { kind: 'quarterly', label: 'Quarterly only' },
  { kind: 'quarterlySame', label: 'Same each quarter' },
  { kind: 'zero', label: 'Zero' },
  { kind: 'present', label: 'Budgeted (not zero)' },
  { kind: 'monthlyAmount', label: '$ every month', amount: true },
  { kind: 'perUnitMonth', label: '$ per unit in a month', month: true, amount: true },
  { kind: 'pctOverT12', label: '% over the T12', pct: true },
  { kind: 'notPositive', label: 'Never positive' },
  { kind: 'nearT12', label: 'About the T12 (± %)', pct: true },
  { kind: 'maxOverT12', label: 'At most % over the T12', pct: true },
  { kind: 'monthlyAtLeast', label: 'At least $ every month', amount: true },
  { kind: 'note', label: 'Reminder (check by eye)' },
];

/** The workbook's items that apply everywhere (both regions). */
const COMMON: ReviewRule[] = [
  { id: 'credit-zero', gl: '5156', label: 'Credit approval: zero', kind: 'zero' },
  { id: 'rebates-jan', gl: '5178', label: 'Vendor rebates: January high', kind: 'peak', month: 1 },
  { id: 'acct-apr', gl: '6102', label: 'Accounting fee: April 1x fee', kind: 'peak', month: 4 },
  { id: 'tax-3', gl: '6116', label: 'RE taxes: confirm the % increase over last year', kind: 'pctOverT12', pct: 0.03 },
  { id: 'consult-425', gl: '6310', label: 'Consulting service: $425/mo', kind: 'monthlyAmount', amount: 425 },
  { id: 'er-nov', gl: '6318', label: 'Employee relations: November gift cards', kind: 'peak', month: 11 },
  { id: 'dues-feb', gl: '6324', label: 'Licenses: February apartment association dues', kind: 'peak', month: 2 },
  { id: 'bonus-qtr', gl: '6408', label: 'Payroll bonuses: same each quarter', kind: 'quarterlySame' },
  { id: '401k-feb', gl: '6421', label: 'Payroll 401k: February employee match', kind: 'peak', month: 2 },
  { id: 'snow', gl: '6934', label: 'Snow removal: make sure it is budgeted', kind: 'present' },
  { id: 'sp-clocks', gl: '7325', label: 'SP general: time clocks in SP (small; no need to audit)', kind: 'note' },
];
/** Built-in rules per region. ND leaves out the KC-only items (Healthy Homes, the rover change, Zillow, the KC
    sites' monthly sewer / water); its cable revenue share is monthly (Minot), KC's quarterly. */
const ND_REVIEW: ReviewRule[] = [
  { id: 'conc-neg', gl: '5024', label: 'Concessions: entered by hand, never positive', kind: 'notPositive' },
  { id: 'vac-neg', gl: '5031', label: 'Vacancy: never positive', kind: 'notPositive' },
  { id: 'bdr-t12', gl: '5110', label: 'Bad debt recovery: about the T12 (no growth off an average)', kind: 'nearT12', pct: 0.05 },
  { id: 'fee-conv', gl: '5117', label: 'Convenience fee: fixed dollars, not grown at the rent rate', kind: 'maxOverT12', pct: 0.03 },
  { id: 'fee-ins', gl: '5126', label: 'Insurance non-compliance fee: fixed dollars, not grown at the rent rate', kind: 'maxOverT12', pct: 0.03 },
  { id: 'fee-nsf', gl: '5155', label: 'NSF fee: fixed dollars, not grown at the rent rate', kind: 'maxOverT12', pct: 0.03 },
  { id: 'fee-xfer', gl: '5168', label: 'Transfer fee: fixed dollars, not grown at the rent rate', kind: 'maxOverT12', pct: 0.03 },
  { id: 'fee-lt', gl: '5140', label: 'Lease termination fee: fixed dollars, not grown at the rent rate', kind: 'maxOverT12', pct: 0.03 },
  { id: 'pest-own', gl: '5158', label: 'Pest fee: its own line, $5 x occupied units (ND West)', kind: 'present', props: ['bcnd', 'ecnd', 'fhnd', 'phnd'] },
  { id: 'sw-275', gl: '6331', label: 'Computer software: at least the $275/mo template, plus site SaaS contracts', kind: 'monthlyAtLeast', amount: 275 },
  { id: 'sewer-every', gl: '6614', label: 'Sewer: hits every month', kind: 'every' },
  { id: 'water-every', gl: '6622', label: 'Water: hits every month', kind: 'every' },
  { id: 'fire-insp', gl: '6917', label: 'Fire inspection: the annual inspection is budgeted', kind: 'present' },
  { id: 'one-time', gl: '6365', label: 'One-time items backed out of the T12 and listed in the budget notes', kind: 'note' },
  { id: 'tax-bill', gl: '6116', label: 'RE taxes: the real bill from the property accountant, discounted one-time payment, no penalties', kind: 'note' },
  { id: 'lender', gl: '7325', label: 'Lender corrective items with 2027 deadlines budgeted', kind: 'note' },
];
export const DEFAULT_REVIEW_RULES: Record<'nd' | 'kc', ReviewRule[]> = {
  nd: [
    { id: 'cable', gl: '5115', label: 'Cable income: monthly revenue share (Minot; Midco 4% at BCND / ECND)', kind: 'every' },
    ...COMMON.filter((r) => r.id !== 'consult-425'),   // ND consulting is the corporate rate (the ND review sheet)
    ...ND_REVIEW,
  ],
  kc: [
    { id: 'cable', gl: '5115', label: 'Cable income: quarterly revenue share (KC)', kind: 'quarterly' },
    ...COMMON,
    { id: 'healthy-homes', gl: '6324', label: 'Licenses: December $20/unit for Healthy Homes (KC only)', kind: 'perUnitMonth', month: 12, amount: 20, props: ['pwmo', 'wlmo', 'fpmo', 'trmo'] },
    { id: 'rover', gl: '6407', label: "Payroll maint rover: decrease for Betty's with Eric gone", kind: 'note' },
  ],
};

/** Clean rules typed in Settings: known kinds only, GL four digits, numbers finite, codes lower-case. */
export function normalizeReviewRules(v: unknown): ReviewRule[] | null {
  if (!Array.isArray(v)) return null;
  const kinds = new Set(REVIEW_KINDS.map((k) => k.kind));
  const out: ReviewRule[] = [];
  v.forEach((r: any, i) => {
    if (!r || !/^\d{4}$/.test(String(r.gl || '').trim()) || !kinds.has(r.kind)) return;
    const num = (x: any) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
    const month = num(r.month);
    out.push({
      id: String(r.id || `r${i}`).slice(0, 40), gl: String(r.gl).trim(), label: String(r.label || '').slice(0, 160), kind: r.kind,
      month: month != null && month >= 1 && month <= 12 ? Math.round(month) : null, amount: num(r.amount), pct: num(r.pct),
      props: Array.isArray(r.props) ? r.props.map((c: any) => String(c).trim().toLowerCase()).filter(Boolean) : [],
    });
  });
  return out;
}

export interface ReviewResult { status: 'y' | 'n' | 'na' | 'info'; text: string }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const tot = (m: number[]) => m.reduce((a, v) => a + (v || 0), 0);
const med = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
/** One rule on one property. `months` = the budget by CALENDAR month (Jan..Dec); `t12` = the GL's trailing-12 by
    calendar month (null = nothing posted on it; undefined = no trailing-12 on file at all, e.g. an acquisition
    budget — then nothing is said about last year). */
export function reviewCell(rule: ReviewRule, p: { code: string; months: number[] | null; t12?: number[] | null; units: number; /** the year the % is over, in place of the T12 (RE taxes: the current accrual × 12) */ base?: number | null }): ReviewResult {
  if (rule.props && rule.props.length && !rule.props.includes(String(p.code).toLowerCase())) return { status: 'na', text: '' };
  if (rule.kind === 'note') return { status: 'info', text: 'check by eye' };
  const m = (p.months || Array(12).fill(0)).map((v) => Math.round((v || 0) * 100) / 100);
  const total = tot(m);
  const lastNone = p.t12 !== undefined && (!p.t12 || !p.t12.some((v) => Math.abs(v || 0) >= 1));
  const none = (s: string) => (lastNone ? (s ? `${s}, none last year` : 'none last year') : s);
  const nz = m.map((v, i) => (Math.abs(v) >= 1 ? i : -1)).filter((i) => i >= 0);
  switch (rule.kind) {
    case 'zero': return Math.abs(total) < 1 ? { status: 'y', text: '' } : { status: 'n', text: `${usd(total)} budgeted` };
    case 'present': return Math.abs(total) >= 1 ? { status: 'y', text: none('') } : { status: 'n', text: none('nothing budgeted') };
    case 'every': {
      if (!nz.length) return { status: 'n', text: none('nothing budgeted') };
      const miss = m.map((v, i) => (Math.abs(v) < 1 ? MON[i] : '')).filter(Boolean);
      return miss.length ? { status: 'n', text: `nothing in ${miss.join(', ')}` } : { status: 'y', text: none('') };
    }
    case 'quarterly': {
      if (!nz.length) return { status: 'n', text: none('nothing budgeted') };
      const ok = nz.length <= 4 && nz.every((i, k) => k === 0 || i - nz[k - 1] === 3);
      return ok ? { status: 'y', text: `${nz.map((i) => MON[i]).join(', ')}${lastNone ? ', none last year' : ''}` } : { status: 'n', text: `hits ${nz.length} months` };
    }
    case 'quarterlySame': {
      if (!nz.length) return { status: 'n', text: none('nothing budgeted') };
      const q = [0, 1, 2, 3].map((k) => m[k * 3] + m[k * 3 + 1] + m[k * 3 + 2]);
      const hi = Math.max(...q), lo = Math.min(...q);
      return hi - lo <= Math.max(5, Math.abs(hi) * 0.01) ? { status: 'y', text: none('') } : { status: 'n', text: `Q1-Q4 ${q.map(usd).join(' / ')}` };
    }
    case 'monthlyAmount': {
      const want = Number(rule.amount) || 0;
      const off = m.map((v, i) => (Math.abs(v - want) > 1 ? i : -1)).filter((i) => i >= 0);
      if (!off.length) return { status: 'y', text: none('') };
      if (!nz.length) return { status: 'n', text: none('nothing budgeted') };
      const vals = [...new Set(m.map((v) => Math.round(v)))];
      return { status: 'n', text: vals.length === 1 ? `${usd(vals[0])}/mo` : `${off.length} month${off.length === 1 ? '' : 's'} not ${usd(want)}` };
    }
    case 'perUnitMonth': {
      const i = (Number(rule.month) || 12) - 1;
      const want = (Number(rule.amount) || 0) * (p.units || 0);
      const got = m[i];
      if (!want) return { status: 'info', text: 'no unit count' };
      return Math.abs(got - want) <= Math.max(1, want * 0.02) ? { status: 'y', text: '' } : { status: 'n', text: `${usd(got)} in ${MON[i]} vs ${usd(want)}` };
    }
    case 'notPositive': {
      const pos = m.map((v, i) => (v > 0.5 ? MON[i] : '')).filter(Boolean);
      return pos.length ? { status: 'n', text: `positive in ${pos.join(', ')}` } : { status: 'y', text: '' };
    }
    case 'nearT12':
    case 'maxOverT12': {
      const last = p.t12 ? tot(p.t12) : 0;
      if (!last) return Math.abs(total) < 1 ? { status: 'y', text: none('') } : { status: 'info', text: 'no T12 to compare' };
      const g = total / last - 1, lim = Number(rule.pct) || 0;
      const txt = `${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}% vs T12`;
      const ok = rule.kind === 'nearT12' ? Math.abs(g) <= lim + 0.0005 : g <= lim + 0.0005;
      return { status: ok ? 'y' : 'n', text: txt };
    }
    case 'monthlyAtLeast': {
      const want = Number(rule.amount) || 0;
      const under = m.map((v, i) => (v < want - 0.5 ? i : -1)).filter((i) => i >= 0);
      return under.length ? { status: 'n', text: `under ${usd(want)} in ${under.length} month${under.length === 1 ? '' : 's'} (${usd(Math.min(...under.map((i) => m[i])))} low)` } : { status: 'y', text: '' };
    }
    case 'pctOverT12': {
      const last = p.base ? p.base : p.t12 ? tot(p.t12) : 0;
      if (!last) return { status: 'info', text: 'no T12 to compare' };
      const g = total / last - 1;
      const txt = `${g >= 0 ? '+' : ''}${(g * 100).toFixed(2)}%`;
      return Math.abs(g - (Number(rule.pct) || 0)) <= 0.0025 ? { status: 'y', text: txt } : { status: 'n', text: txt };
    }
    case 'peak': {
      const i = (Number(rule.month) || 1) - 1;
      if (!nz.length) return { status: 'n', text: none('nothing budgeted') };
      // "stands out": at least 1.5x the median of the other eleven months (zeros count: a once-a-year fee stands out)
      const others = m.filter((_, k) => k !== i);
      const base = med(others.map(Math.abs));
      const stands = (k: number) => Math.abs(m[k]) >= 1 && Math.abs(m[k]) >= 1.5 * base && Math.abs(m[k]) > base + 0.5;
      if (stands(i)) {
        // other months that stand out as much (the workbook's "also high July")
        const also = m.map((v, k) => (k !== i && Math.abs(v) >= 1.5 * base && Math.abs(v) >= 0.5 * Math.abs(m[i]) && Math.abs(v) > base + 0.5 ? MON[k] : '')).filter(Boolean);
        return { status: 'y', text: none(also.length ? `also high ${also.join(', ')}` : '') };
      }
      const top = m.reduce((b, v, k) => (Math.abs(v) > Math.abs(m[b]) ? k : b), 0);
      const flat = Math.max(...m.map(Math.abs)) - Math.min(...m.map(Math.abs)) <= Math.max(1, Math.abs(m[top]) * 0.01);
      return { status: 'n', text: flat ? `flat, no ${MON[i]} spike` : `${MON[top]} not ${MON[i]}` };
    }
  }
  return { status: 'info', text: '' };
}
