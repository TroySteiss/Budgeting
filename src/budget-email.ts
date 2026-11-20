/* THE BUDGET SUMMARY EMAIL (Troy 2026-11-19: "add an email button under more which downloads an EML file for the budget in
   the exact same type of template format Riley has used in the past"). Riley's "<Property> <Year> Budget Summary" emails to
   Andy Miller (Dec 2024 and Dec 2025: South Pointe 2026 is the model here) open with the return, then Income, Expenses,
   NOI and Special Projects bullets, each growth against the T12 and the T4, and attach the budget workbook.
   Every figure comes off the Summary sheet's columns (summaryColumn: T12, T4 annualized, the budget), so the email and the
   attached workbook agree. What the tool cannot know (cash at year end) is left as a yellow placeholder to fill in. Pure. */
import type { SummaryCol } from '../shared/annual.js';

export interface BudgetEmailInput {
  propName: string; propCode: string; city: string; year: number; units: number; capital: number;
  /** the T12's last month as Riley writes it: "Oct." */
  t12Mon: string;
  t12: SummaryCol | null; t4: SummaryCol | null; bud: SummaryCol;
  /** the budget's cash-on-cash (as the KPI tile) and the T12's */
  coc: number | null;
  /** the FY budget (the calendar year before this one): its NOI, annualized */
  fy: { year: number; noi: number } | null;
  /** the latest quarterly distribution before the budget starts */
  dist: { pct: number; label: string } | null;
  /** the fee: the budget's % (and by quarter when typed), the T12's effective % */
  fee: { pct: number; byQuarter?: ({ ret: number; pct: number | null } | null)[] | null };
  /** special-project lines with dollars in the budget */
  sp: { name: string; amount: number; note?: string | null }[];
  /** what the tax line is built on, in words, when known */
  taxBasis?: string | null;
  sender: { name: string; title: string; email: string } | null;
}

const pctTxt = (v: number, dp = 1): string => {
  const s = (Math.round(v * 100 * 10 ** dp) / 10 ** dp).toFixed(dp).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return `${s}%`;
};
const growth = (bud: number, ref: number | null | undefined): number | null => (ref ? (bud - ref) / Math.abs(ref) : null);
const kTxt = (v: number): string => {
  const a = Math.abs(v);
  if (a < 1000) return `$${Math.round(a)}`;
  if (a < 1e6) { const k = Math.round(a / 100) / 10; return `$${Number.isInteger(k) || k >= 100 ? Math.round(k) : k}k`; }
  return `$${(Math.round(a / 1e5) / 10)}M`;
};
const KTXT = (v: number): string => kTxt(v).replace(/k$/, 'K');
/** "growing 4.2%" / "decreasing 1.3%" / "flat" */
const moves = (g: number | null, up = 'growing', down = 'decreasing'): string => (g == null ? 'n/a' : Math.abs(g) < 0.0005 ? 'flat' : `${g > 0 ? up : down} ${pctTxt(Math.abs(g))}`);
const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const BUDGET_EMAIL_TO = [{ name: 'Andy Miller', email: 'amiller@monarchinvestment.com' }];
export const BUDGET_EMAIL_CC = [{ name: 'Riley Combs', email: 'rcombs@monarchinvestment.com' }, { name: 'Kara Garrison', email: 'kgarrison@monarchinvestment.com' },
  { name: 'Troy Steiss', email: 'tsteiss@monarchinvestment.com' }];

type Item = string | { text: string; sub: Item[] };
/** The email's bullets in SECTIONS (a blank line between sections, none inside one): plain items, a `{ text, sub }`
    nests; `[[...]]` marks a placeholder to fill in, `**...**` bold. Troy 2026-11-20: NOI moves up into the top section
    with the return, its growth over the T12 in bold; no accretion bullet. */
export function budgetEmailItems(d: BudgetEmailInput): Item[][] {
  const t12Lab = `${d.t12Mon} T12`.trim();
  const { bud, t12, t4 } = d;
  const vsBoth = (b: number, k: (c: SummaryCol) => number): string => {
    const g12 = t12 ? growth(b, k(t12)) : null, g4 = t4 ? growth(b, k(t4)) : null;
    return `${moves(g12)} over ${t12Lab}${g4 != null ? `, ${pctTxt(g4)} over T4` : ''}`;
  };
  const items: Item[] = [];
  const sections: Item[][] = [];

  // overall return, then NOI (the top section)
  const t12Ret = t12 && d.capital ? t12.cashFlow / d.capital : null;
  items.push(`Overall return is ${d.coc != null ? pctTxt(d.coc, 2) : '[[return]]'}${t12Ret != null ? ` vs. ${pctTxt(t12Ret, 2)} T12 actual return` : ''}${d.dist ? `${t12Ret != null ? ' and' : ' vs.'} ${pctTxt(d.dist.pct)} ${d.dist.label} distribution` : ''}.`);

  const noiAdj = (c: SummaryCol) => c.noi + c.tax + c.fee;
  const gN = t12 ? growth(bud.noi, t12.noi) : null, gNa = t12 ? growth(noiAdj(bud), noiAdj(t12)) : null;
  const gFy = d.fy && d.fy.noi ? growth(bud.noi, d.fy.noi) : null;
  items.push({ text: 'NOI', sub: [
    `${d.propCode.toUpperCase()}'s NOI is **${moves(gN)} over ${t12Lab}**${gNa != null ? `, ${pctTxt(gNa)} RE tax and management fee adjusted` : ''}${gFy != null ? ` and ${pctTxt(gFy)} ${gFy >= 0 ? 'over' : 'under'} ${d.fy!.year}'s budget` : ''}.`,
  ] });
  sections.push(items.splice(0));

  // income
  sections.push([{ text: 'Income', sub: [
    `Rental income is ${vsBoth(bud.rental, (c) => c.rental)}.`,
    `Total income is ${vsBoth(bud.income, (c) => c.income)}.`,
  ] }]);

  // expenses
  const adj = (c: SummaryCol) => c.expense - c.tax - c.fee;
  const gAdj = t12 ? growth(adj(bud), adj(t12)) : null;
  const ex: Item[] = [`Total expenses are ${moves(t12 ? growth(bud.expense, t12.expense) : null)} over ${t12Lab}${gAdj != null ? `, ${pctTxt(gAdj)} taxes and management fee adjusted` : ''}.`];
  if (bud.fee) {
    const gFee = t12 ? growth(bud.fee, t12.fee) : null;
    const t12Rate = t12 && t12.income ? t12.fee / t12.income : null;
    const q = (d.fee.byQuarter || []).filter((x): x is { ret: number; pct: number | null } => !!x && x.pct != null);
    const why = q.length
      ? `, with the fee following the projected returns (${(d.fee.byQuarter || []).map((x, i) => (x && x.pct != null ? `Q${i + 1} ${pctTxt(x.pct)}` : `Q${i + 1} ${pctTxt(d.fee.pct)}`)).join(', ')})`
      : t12Rate != null && Math.abs(d.fee.pct - t12Rate) >= 0.0025 ? `, due to going to a ${pctTxt(d.fee.pct)} management fee for all of ${d.year}` : '';
    ex.push(`The management fee is ${gFee == null ? `budgeted at ${pctTxt(d.fee.pct)} of income` : `${moves(gFee, 'increasing', 'decreasing')} YoY`}${why}.`);
  }
  if (bud.tax) ex.push(`Taxes are ${moves(t12 ? growth(bud.tax, t12.tax) : null, 'increasing', 'decreasing')} over ${t12Lab}${d.taxBasis ? ` (${d.taxBasis})` : ''}.`);
  if (bud.payroll) ex.push(`Payroll is ${moves(t12 ? growth(bud.payroll, t12.payroll) : null)}${d.units ? `, budgeted around ${kTxt(bud.payroll / d.units)}/door` : ''}.`);
  const mnt = (c: SummaryCol) => c.inHouse + c.exterior + c.contract + c.rehab;
  if (mnt(bud)) {
    const g12 = t12 ? growth(mnt(bud), mnt(t12)) : null, g4 = t4 ? growth(mnt(bud), mnt(t4)) : null;
    ex.push(`Total maintenance is budgeted at ${d.units ? `${kTxt(mnt(bud) / d.units)}/door` : KTXT(mnt(bud))}${g12 != null ? `, ${moves(g12, 'increasing', 'decreasing')} over ${t12Lab}` : ''}${g4 != null ? ` and ${moves(g4, 'increasing', 'decreasing')} over T4` : ''}.`);
  }
  sections.push([{ text: 'Expenses', sub: ex }]);

  // special projects
  const spTot = d.sp.reduce((a, x) => a + x.amount, 0);
  const named = d.sp.filter((x) => x.amount).sort((a, b) => b.amount - a.amount)
    .map((x) => `${(x.note && x.note.trim()) || x.name.replace(/^\s*SP\s+/i, '').toLowerCase()} (${KTXT(x.amount)})`);
  sections.push([{ text: 'Special Projects', sub: [
    spTot ? `${KTXT(spTot)} is tentatively budgeted in Special Projects.` : 'Nothing is budgeted in Special Projects yet: [[SP amount]].',
    named.length ? `These projects could include: ${named.join(', ')}.` : 'These projects could include: [[projects]].',
  ] }]);
  return sections;
}

/** The email: subject, HTML body (Outlook's own look: Calibri 11pt, nested bullets) and a plain-text copy. */
export function budgetEmail(d: BudgetEmailInput, opts: { imageCid?: string | null; imageWidth?: number } = {}): { subject: string; html: string; text: string } {
  const subject = `${d.propName} ${d.year} Budget Summary`;
  const sections = budgetEmailItems(d);
  const ph = (s: string, html: boolean) => (html
    ? s.replace(/\[\[(.+?)\]\]/g, (_, x) => `<span style="background:yellow;mso-highlight:yellow">${x}</span>`).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    : s.replace(/\[\[(.+?)\]\]/g, '[$1]').replace(/\*\*(.+?)\*\*/g, '$1'));
  const FONT = 'font-size:11.0pt;font-family:&quot;Calibri&quot;,sans-serif';
  const LI = `style="margin:0in;margin-bottom:.0001pt;line-height:normal;${FONT}"`;
  const UL = 'style="margin-top:0in;margin-bottom:0in"';
  const li = (it: Item): string => (typeof it === 'string'
    ? `<li ${LI}>${ph(esc(it), true)}</li>`
    : `<li ${LI}>${ph(esc(it.text), true)}<ul ${UL} type="circle">${it.sub.map(li).join('')}</ul></li>`);
  const intro = `Attached please find the ${d.year} budget analysis for ${d.propName}${d.city ? ` in ${d.city}` : ''}. I’ve listed a few notes/comments below regarding the budget.`;
  const sig = d.sender ? [d.sender.name, d.sender.title, 'Monarch Investment & Management Group', d.sender.email] : [];
  const P = (s: string) => `<p class="MsoNormal" style="margin:0in;margin-bottom:.0001pt;line-height:normal;${FONT}">${s}</p>`;
  const GAP = P('&nbsp;');
  const img = opts.imageCid ? `${GAP}${P(`<img src="cid:${opts.imageCid}" width="${opts.imageWidth || 760}" style="width:${(opts.imageWidth || 760) / 96}in" alt="${esc(subject)}">`)}` : '';
  const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body lang="EN-US"><div class="WordSection1">
${P('Andy-')}${GAP}${P(esc(intro))}${GAP}
${sections.map((sec) => `<ul ${UL} type="disc">${sec.map(li).join('')}</ul>`).join(GAP)}
${img}
${GAP}${sig.length ? `${P(`<b>${esc(sig[0])}</b>`)}${sig.slice(1, 3).map((s) => P(esc(s))).join('')}${P(`<a href="mailto:${esc(sig[3])}">${esc(sig[3])}</a>`)}` : ''}
</div></body></html>`;
  const tx = (it: Item, lvl: number): string => (typeof it === 'string'
    ? `${'    '.repeat(lvl)}${lvl ? 'o' : '•'} ${ph(it, false)}`
    : `${'    '.repeat(lvl)}${lvl ? 'o' : '•'} ${it.text}\n${it.sub.map((s) => tx(s, lvl + 1)).join('\n')}`);
  const text = ['Andy-', '', intro, '', sections.map((sec) => sec.map((it) => tx(it, 0)).join('\n')).join('\n\n'), '', ...sig].join('\n');
  return { subject, html, text };
}

/* ---- the .eml file: an UNSENT draft (X-Unsent: 1), so Outlook opens it ready to edit and send ---- */
const b64 = (buf: Buffer): string => buf.toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
const hdr = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const addr = (xs: { name: string; email: string }[]): string => xs.map((x) => `${hdr(x.name)} <${x.email}>`).join(', ');
export function toEml(m: { to: { name: string; email: string }[]; cc?: { name: string; email: string }[]; subject: string; html: string; text: string;
  attachment?: { filename: string; contentType: string; data: Buffer } | null; inline?: { cid: string; filename: string; contentType: string; data: Buffer } | null; boundary?: string }): string {
  const b1 = `=_mixed_${m.boundary || Date.now().toString(36)}`, b2 = `=_alt_${m.boundary || Date.now().toString(36)}`, b3 = `=_rel_${m.boundary || Date.now().toString(36)}`;
  const htmlPart = ['Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(m.html, 'utf8'))];
  const lines = [
    'X-Unsent: 1',
    `To: ${addr(m.to)}`,
    ...(m.cc && m.cc.length ? [`Cc: ${addr(m.cc)}`] : []),
    `Subject: ${hdr(m.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b1}"`,
    '',
    `--${b1}`,
    `Content-Type: multipart/alternative; boundary="${b2}"`,
    '',
    `--${b2}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.from(m.text, 'utf8')),
    `--${b2}`,
    ...(m.inline
      ? [`Content-Type: multipart/related; boundary="${b3}"; type="text/html"`, '', `--${b3}`, ...htmlPart, `--${b3}`,
        `Content-Type: ${m.inline.contentType}; name="${m.inline.filename}"`, `Content-ID: <${m.inline.cid}>`, `Content-Disposition: inline; filename="${m.inline.filename}"`,
        'Content-Transfer-Encoding: base64', '', b64(m.inline.data), `--${b3}--`]
      : htmlPart),
    `--${b2}--`,
  ];
  if (m.attachment) {
    const fn = m.attachment.filename.replace(/"/g, '');
    lines.push(`--${b1}`, `Content-Type: ${m.attachment.contentType}; name="${hdr(fn)}"`, `Content-Disposition: attachment; filename="${hdr(fn)}"`, 'Content-Transfer-Encoding: base64', '', b64(m.attachment.data));
  }
  lines.push(`--${b1}--`, '');
  return lines.join('\r\n');
}
