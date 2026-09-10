/* Yardi Voyager budget ETL CSV — byte-exact reproduction of the format in
   "PHND Revised Budget 06062026.csv" / "FHND Budget Revision 06062026.csv":
   - //Budget: header row + one header record (24 columns, comma-padded)
   - //BudgetDetail: header row + one row per uploadable GL, in canonical
     csv_order, INCLUDING all-zero rows (full 335-account chart every time)
   - Area=0, Description=0, Start/Expense Date = 1/1/<year>, amounts plain
     numbers (≤4dp, no separators), income +, contra −.
   Revision mode zeroes every month before the cutoff (Yardi keeps actuals). */
import type { CoaAccount, BudgetLine } from '../shared/domain.js';
import { splitCsvLine, type BudgetCsvParsed } from './importers.js';

const BUDGET_HEADER =
  '//Budget:BudgetNumber,Property Id,Book,Start Month,Budget Description,Domain,Domain Interval, Segment1, Segment2, Segment3, Segment4, Segment5, Segment6, Segment7, Segment8, Segment9, Segment10, Segment11, Segment12,,,,,';
const DETAIL_HEADER =
  '//BudgetDetail:LineNumber,Account,Tenant,Unit,Charge Code,Area,Start Date,End Date,Expense Date,Source,Description,Reference,Amount1,Amount2,Amount3,Amount4,Amount5,Amount6,Amount7,Amount8,Amount9,Amount10,Amount11,Amount12';

export interface CsvOptions {
  propertyId: string;        // lowercase yardi code
  year: number;
  description: string;       // e.g. "cwnd 2027 Budget Upload 01-15-2027"
  budgetNumber?: number;
  book?: string;
  cutoffMonth?: number;      // revision: zero out months 1..cutoffMonth (0 = none)
}

/** Format like the real files: plain number, up to 4dp, no trailing zeros. */
export function fmtAmount(v: number): string {
  if (!v) return '0';
  const r = Math.round(v * 10000) / 10000;
  if (Number.isInteger(r)) return String(r);
  return String(r);
}

export function buildBudgetCsv(coa: CoaAccount[], lines: BudgetLine[], opts: CsvOptions): string {
  const byGl = new Map(lines.map((l) => [l.gl_code, l]));
  const uploadable = coa
    .filter((a) => a.csv_order != null)
    .sort((a, b) => (a.csv_order! - b.csv_order!));
  const start = `1/1/${opts.year}`;
  const rows: string[] = [];
  rows.push(BUDGET_HEADER);
  rows.push([
    String(opts.budgetNumber ?? 1), opts.propertyId.toLowerCase(), opts.book ?? 'Cash', start,
    opts.description, '12', '1', ...Array(12).fill(''), ...Array(5).fill(''),
  ].join(','));
  rows.push(DETAIL_HEADER);
  const cutoff = opts.cutoffMonth ?? 0;
  uploadable.forEach((a, i) => {
    const ln = byGl.get(a.code);
    const months = (ln?.months || Array(12).fill(0)).map((v: number, mi: number) => (mi < cutoff ? 0 : v));
    rows.push([
      String(i + 1), a.code, '', '', '', '0', start, '', start, '', '0', '',
      ...months.map(fmtAmount),
    ].join(','));
  });
  return rows.join('\r\n') + '\r\n';
}

/* ---------------- revise an existing budget CSV (partial-month rule off Yardi) ----------------
   Re-issue a budget CSV — exported from Yardi, or the file last uploaded — with
   ONE calendar month replaced 1:1 by posted actuals. Every other cell, the row
   order and the file's own number formatting are preserved verbatim, so the
   revision runs off the budget AS IT SITS IN YARDI and undoes nothing changed
   there. Chart GLs that posted but have no row are appended. */
export interface ReviseResult { csv: string; rewritten: number; appended: string[]; description: string }

export function reviseBudgetCsv(base: BudgetCsvParsed, calMonth: number, glMonths: Record<string, number>, opts: { description?: string; stamp?: string } = {}): ReviseResult {
  if (calMonth < 1 || calMonth > 12) throw new Error(`reviseBudgetCsv: bad month ${calMonth}`);
  const col = 12 + (calMonth - 1);
  const fmt = (v: number): string => {
    if (base.decimals) { const p = 10 ** base.decimals; return (Math.round(v * p) / p).toFixed(base.decimals); }
    return fmtAmount(v);
  };
  const seen = new Set<string>();
  const body: string[] = [];
  for (const r of base.rows) {
    seen.add(r.gl);
    const t = [...r.tokens];
    t[col] = fmt(glMonths[r.gl] || 0);
    body.push(t.join(','));
  }
  const appended: string[] = [];
  const tmpl = base.rows[0].tokens;
  for (const [gl, v] of Object.entries(glMonths)) {
    if (!v || seen.has(gl)) continue;
    const t = [...tmpl];
    t[0] = String(base.rows.length + appended.length + 1);
    t[1] = gl;
    for (let k = 12; k < 24; k++) t[k] = fmt(0);
    t[col] = fmt(v);
    body.push(t.join(','));
    appended.push(gl);
  }
  // header record: restamp the description ("TS 08282026" → today's initials+date), Upload → Revision
  const pre = [...base.preamble];
  const rec = splitCsvLine(pre[base.headerIdx]);
  const quoted = /^\s*".*"\s*$/.test(rec[4] || '');
  let desc = opts.description ?? base.description;
  if (opts.description == null && opts.stamp) {
    desc = /\b[A-Z]{1,3} \d{8}\b/.test(desc) ? desc.replace(/\b[A-Z]{1,3} \d{8}\b/, opts.stamp) : `${desc} ${opts.stamp}`;
    desc = desc.replace(/\bUpload\b/, 'Revision');
  }
  rec[4] = quoted ? `"${desc}"` : desc;
  pre[base.headerIdx] = rec.join(',');
  return { csv: [...pre, ...body].join(base.eol) + base.eol, rewritten: base.rows.length, appended, description: desc };
}
