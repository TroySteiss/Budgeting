import { describe, it, expect } from 'vitest';
import { budgetEmail, budgetEmailItems, toEml, BUDGET_EMAIL_TO, BUDGET_EMAIL_CC } from '../src/budget-email.js';
import type { SummaryCol } from '../shared/annual.js';

const col = (o: Partial<SummaryCol>): SummaryCol => {
  const c = { rental: 0, other: 0, income: 0, fixedLess: 0, tax: 0, fee: 0, admin: 0, payroll: 0, marketing: 0, utilities: 0, inHouse: 0, exterior: 0, contract: 0, rehab: 0, expense: 0, noi: 0, interest: 0, mtg1: 0, mtg2: 0, cashFlow: 0, ...o } as SummaryCol;
  return c;
};
const t12 = col({ rental: 1000000, other: 100000, income: 1100000, tax: 100000, fee: 40000, payroll: 200000, inHouse: 50000, exterior: 20000, contract: 20000, rehab: 10000, expense: 500000, noi: 600000, cashFlow: 300000 });
const t4 = col({ rental: 1020000, income: 1120000, inHouse: 52000, exterior: 20000, contract: 20000, rehab: 10000, noi: 610000 });
const bud = col({ rental: 1042000, other: 101000, income: 1143000, tax: 103000, fee: 45720, payroll: 204000, inHouse: 52000, exterior: 21000, contract: 21000, rehab: 10000, expense: 515000, noi: 628000, cashFlow: 330000 });
const base = { propName: 'South Pointe', propCode: 'spnd', city: 'Minot', year: 2027, units: 100, capital: 3000000, t12Mon: 'Oct.', t12, t4, bud, coc: 0.11, fy: { year: 2026, noi: 600000 }, dist: { pct: 0.08, label: 'Q3 2026' }, fee: { pct: 0.04 }, sp: [{ name: 'SP CONCRETE', amount: 40000 }, { name: 'SP ROOFING', amount: 20000, note: 'roof repairs, building 3' }], sender: null };

describe('budget summary email (Riley\'s template)', () => {
  it('writes the return, income, expense, NOI and SP bullets off the summary columns', () => {
    const flat = JSON.stringify(budgetEmailItems(base));
    expect(flat).toContain('Overall return is 11% vs. 10% T12 actual return and 8% Q3 2026 distribution.');
    expect(flat).toContain('Rental income is growing 4.2% over Oct. T12, 2.2% over T4.');
    expect(flat).toContain('Total expenses are growing 3% over Oct. T12, 1.7% taxes and management fee adjusted.');
    expect(flat).toContain('Payroll is growing 2%, budgeted around $2k/door.');
    expect(flat).toContain("SPND's NOI is **growing 4.7% over Oct. T12**");
    expect(flat).toContain("and 4.7% over 2026's budget");
    expect(flat).toContain('$60K is tentatively budgeted in Special Projects.');
    expect(flat).toContain('concrete ($40K), roof repairs, building 3 ($20K)');
  });
  it('a fee rate unlike the T12 says why; the cash at year end stays a yellow placeholder', () => {
    const m = budgetEmail(base);
    expect(m.subject).toBe('South Pointe 2027 Budget Summary');
    expect(m.text).toContain('due to going to a 4% management fee for all of 2027');   // T12 ran 3.64%
    const noSp = budgetEmail({ ...base, sp: [] });
    expect(noSp.html).toContain('<span style="background:yellow;mso-highlight:yellow">projects</span>');
    expect(m.text).not.toContain('accretion');
    expect(m.text).toContain('Attached please find the 2027 budget analysis for South Pointe in Minot.');
  });
  it('NOI sits in the top section with the return, its T12 growth in bold; Troy is copied', () => {
    const secs = budgetEmailItems(base);
    expect(secs[0].length).toBe(2);
    expect(JSON.stringify(secs[0][1])).toContain('NOI');
    expect(budgetEmail(base).html).toContain('<b>growing 4.7% over Oct. T12</b>');
    expect(BUDGET_EMAIL_CC.map((x) => x.email)).toContain('tsteiss@monarchinvestment.com');
  });
  it('the Summary picture rides inline under the text', () => {
    const m = budgetEmail(base, { imageCid: 'summary@budget' });
    expect(m.html.indexOf('cid:summary@budget')).toBeGreaterThan(m.html.indexOf('Special Projects'));
    const eml = toEml({ to: BUDGET_EMAIL_TO, subject: m.subject, html: m.html, text: m.text, inline: { cid: 'summary@budget', filename: 'summary.png', contentType: 'image/png', data: Buffer.from('png') }, boundary: 't' });
    expect(eml).toContain('Content-Type: multipart/related; boundary="=_rel_t"; type="text/html"');
    expect(eml).toContain('Content-ID: <summary@budget>');
  });
  it('the .eml is an unsent draft to Andy with the workbook attached', () => {
    const m = budgetEmail(base);
    const eml = toEml({ to: BUDGET_EMAIL_TO, subject: m.subject, html: m.html, text: m.text, attachment: { filename: 'South Pointe 2027 Budget Summary.xlsx', contentType: 'application/octet-stream', data: Buffer.from('xlsx') }, boundary: 't' });
    expect(eml.startsWith('X-Unsent: 1\r\nTo: Andy Miller <amiller@monarchinvestment.com>')).toBe(true);
    expect(eml).toContain('Content-Disposition: attachment; filename="South Pointe 2027 Budget Summary.xlsx"');
    expect(eml).toContain(Buffer.from('xlsx').toString('base64'));
    expect(eml.trimEnd().endsWith('--=_mixed_t--')).toBe(true);
  });
});
