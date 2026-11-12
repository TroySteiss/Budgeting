/* Budget review checklist (shared/review.ts) — made-up months, patterns from the "Budget Review" workbook. */
import { describe, it, expect } from 'vitest';
import { reviewCell, normalizeReviewRules, DEFAULT_REVIEW_RULES, type ReviewRule } from '../shared/review.js';

const flat = (v: number) => Array(12).fill(v);
const at = (base: number, i: number, v: number) => flat(base).map((x, k) => (k === i ? v : x));
const m12neg = () => flat(-120);
const rule = (r: Partial<ReviewRule>): ReviewRule => ({ id: 'x', gl: '6318', label: '', kind: 'peak', ...r }) as ReviewRule;
const cell = (r: Partial<ReviewRule>, months: number[] | null, t12: number[] | null = flat(10), units = 100, code = 'clnd') => reviewCell(rule(r), { code, months, t12, units });

describe('budget review checklist', () => {
  it('a month that stands out passes; the wrong month says which; flat says so; "also high" is noted', () => {
    expect(cell({ kind: 'peak', month: 11 }, at(200, 10, 2000))).toEqual({ status: 'y', text: '' });
    expect(cell({ kind: 'peak', month: 11 }, at(200, 11, 2000))).toEqual({ status: 'n', text: 'Dec not Nov' });
    expect(cell({ kind: 'peak', month: 2 }, flat(300))).toEqual({ status: 'n', text: 'flat, no Feb spike' });
    const twoHigh = at(200, 10, 2000); twoHigh[6] = 1500;
    expect(cell({ kind: 'peak', month: 11 }, twoHigh)).toEqual({ status: 'y', text: 'also high Jul' });
    expect(cell({ kind: 'peak', month: 4 }, at(0, 3, 900))).toEqual({ status: 'y', text: '' });          // once-a-year fee
  });
  it('"none last year": nothing budgeted and nothing posted, or budgeted with no history', () => {
    expect(cell({ kind: 'peak', month: 2 }, flat(0), flat(0))).toEqual({ status: 'n', text: 'nothing budgeted, none last year' });
    expect(cell({ kind: 'peak', month: 2 }, at(0, 1, 500), null)).toEqual({ status: 'y', text: 'none last year' });
  });
  it('every month, quarterly only, same each quarter', () => {
    expect(cell({ kind: 'every' }, flat(50)).status).toBe('y');
    expect(cell({ kind: 'every' }, at(50, 2, 0))).toEqual({ status: 'n', text: 'nothing in Mar' });
    expect(cell({ kind: 'quarterly' }, [0, 0, 90, 0, 0, 90, 0, 0, 90, 0, 0, 90])).toEqual({ status: 'y', text: 'Mar, Jun, Sep, Dec' });
    expect(cell({ kind: 'quarterly' }, flat(30))).toEqual({ status: 'n', text: 'hits 12 months' });
    expect(cell({ kind: 'quarterlySame' }, [300, 0, 0, 300, 0, 0, 300, 0, 0, 300, 0, 0]).status).toBe('y');
    expect(cell({ kind: 'quarterlySame' }, [300, 0, 0, 300, 0, 0, 300, 0, 0, 900, 0, 0]).status).toBe('n');
  });
  it('zero, present, $ every month, $ per unit in a month, % over the T12', () => {
    expect(cell({ kind: 'zero' }, flat(0)).status).toBe('y');
    expect(cell({ kind: 'zero' }, at(0, 4, 120))).toEqual({ status: 'n', text: '$120 budgeted' });
    expect(cell({ kind: 'present' }, flat(0), flat(0))).toEqual({ status: 'n', text: 'nothing budgeted, none last year' });
    expect(cell({ kind: 'monthlyAmount', amount: 425 }, flat(425)).status).toBe('y');
    expect(cell({ kind: 'monthlyAmount', amount: 425 }, flat(400))).toEqual({ status: 'n', text: '$400/mo' });
    expect(cell({ kind: 'perUnitMonth', month: 12, amount: 20 }, at(50, 11, 2000), flat(10), 100).status).toBe('y');
    expect(cell({ kind: 'perUnitMonth', month: 12, amount: 20 }, flat(50), flat(10), 100)).toEqual({ status: 'n', text: '$50 in Dec vs $2,000' });
    expect(cell({ kind: 'pctOverT12', pct: 0.03 }, flat(103), flat(100))).toEqual({ status: 'y', text: '+3.00%' });
    expect(cell({ kind: 'pctOverT12', pct: 0.03 }, flat(105), flat(100))).toEqual({ status: 'n', text: '+5.00%' });
  });
  it('never positive, about the T12, at most % over the T12, at least $ every month (the ND review sheet)', () => {
    expect(cell({ kind: 'notPositive' }, m12neg())).toEqual({ status: 'y', text: '' });
    expect(cell({ kind: 'notPositive' }, at(-100, 6, 50))).toEqual({ status: 'n', text: 'positive in Jul' });
    expect(cell({ kind: 'nearT12', pct: 0.05 }, flat(171), flat(100))).toEqual({ status: 'n', text: '+71.0% vs T12' });   // the CLND bad-debt case
    expect(cell({ kind: 'nearT12', pct: 0.05 }, flat(97), flat(100)).status).toBe('y');
    expect(cell({ kind: 'maxOverT12', pct: 0.03 }, flat(111.6), flat(100))).toEqual({ status: 'n', text: '+11.6% vs T12' });   // BCND's fees
    expect(cell({ kind: 'maxOverT12', pct: 0.03 }, flat(90), flat(100)).status).toBe('y');            // flat or lower is fine
    expect(cell({ kind: 'monthlyAtLeast', amount: 275 }, flat(300)).status).toBe('y');
    expect(cell({ kind: 'monthlyAtLeast', amount: 275 }, at(275, 0, 0))).toEqual({ status: 'n', text: 'under $275 in 1 month ($0 low)' });
  });
  it('ND carries the review sheet\'s checks, gift cards included; ND consulting is the corporate rate, not $425', () => {
    const nd = DEFAULT_REVIEW_RULES.nd;
    expect(nd.find((r) => r.gl === '6318')).toMatchObject({ kind: 'peak', month: 11 });            // November gift cards
    expect(nd.map((r) => r.id)).toEqual(expect.arrayContaining(['conc-neg', 'vac-neg', 'bdr-t12', 'fee-conv', 'sw-275', 'sewer-every', 'water-every', 'fire-insp', 'pest-own']));
    expect(nd.some((r) => r.id === 'consult-425')).toBe(false);
    expect(DEFAULT_REVIEW_RULES.kc.some((r) => r.id === 'consult-425')).toBe(true);
    expect(nd.find((r) => r.id === 'pest-own')!.props).toEqual(['bcnd', 'ecnd', 'fhnd', 'phnd']);
  });
  it('a rule kept to some properties is n/a elsewhere; a reminder is checked by eye', () => {
    expect(cell({ kind: 'perUnitMonth', month: 12, amount: 20, props: ['pwmo'] }, flat(0), flat(0), 100, 'clnd')).toEqual({ status: 'na', text: '' });
    expect(cell({ kind: 'note' }, flat(0)).status).toBe('info');
  });
  it('ND defaults leave out the KC-only items; KC carries Healthy Homes on its four sites', () => {
    const nd = DEFAULT_REVIEW_RULES.nd.map((r) => r.id);
    expect(nd).not.toContain('healthy-homes');
    expect(nd).not.toContain('rover');
    expect(DEFAULT_REVIEW_RULES.nd.find((r) => r.gl === '5115')!.kind).toBe('every');
    expect(DEFAULT_REVIEW_RULES.kc.find((r) => r.gl === '5115')!.kind).toBe('quarterly');
    expect(DEFAULT_REVIEW_RULES.kc.find((r) => r.id === 'healthy-homes')!.props).toEqual(['pwmo', 'wlmo', 'fpmo', 'trmo']);
  });
  it('rules typed in Settings are cleaned: bad GLs and kinds dropped, numbers and codes tidied', () => {
    expect(normalizeReviewRules('x')).toBeNull();
    expect(normalizeReviewRules([{ gl: '63', kind: 'peak' }, { gl: '6318', kind: 'bogus' }])).toEqual([]);
    expect(normalizeReviewRules([{ id: 'a', gl: '6318', label: 'x', kind: 'peak', month: '11', amount: '', props: [' CLND '] }]))
      .toEqual([{ id: 'a', gl: '6318', label: 'x', kind: 'peak', month: 11, amount: null, pct: null, props: ['clnd'] }]);
  });
});
