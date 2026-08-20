/* Yardi Voyager budget ETL CSV — byte-exact reproduction of the format in
   "PHND Revised Budget 06062026.csv" / "FHND Budget Revision 06062026.csv":
   - //Budget: header row + one header record (24 columns, comma-padded)
   - //BudgetDetail: header row + one row per uploadable GL, in canonical
     csv_order, INCLUDING all-zero rows (full 335-account chart every time)
   - Area=0, Description=0, Start/Expense Date = 1/1/<year>, amounts plain
     numbers (≤4dp, no separators), income +, contra −.
   Revision mode zeroes every month before the cutoff (Yardi keeps actuals). */
import type { CoaAccount, BudgetLine } from '../shared/domain.js';

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
