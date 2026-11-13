/* Stored values for workbook formulas.

   ExcelJS writes a formula without a value unless one is supplied, and Excel does not calculate a
   workbook opened in Protected View (every file downloaded from the app opens that way) or shown in
   a previewer (Outlook, Teams, SharePoint) — so a formula with no stored value shows as an empty
   box until "Enable Editing" is clicked. `fillCachedResults` works out every formula that has no
   stored value, using the small set of functions the exports write, and stores the result beside
   the formula. The formulas stay live; a formula it cannot read is left exactly as it was. */
import type ExcelJS from 'exceljs';

type Err = { error: string };
type Scalar = number | string | boolean | null | Err;
interface Range { cells: Scalar[][] }
type Val = Scalar | Range;

const isErr = (v: unknown): v is Err => !!v && typeof v === 'object' && 'error' in (v as any);
const isRange = (v: unknown): v is Range => !!v && typeof v === 'object' && 'cells' in (v as any);
const err = (code: string): Err => ({ error: code });
class Unsupported extends Error {}

const colNum = (letters: string): number => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'op'; v: string } | { t: 'name'; v: string } | { t: 'ref'; sheet: string | null; col: number; row: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const refRe = /^\$?([A-Z]{1,3})\$?(\d+)(?![A-Za-z0-9_(])/;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ') { i++; continue; }
    if (ch === '"') {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= src.length) throw new Unsupported('string');
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
        s += src[j++];
      }
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (ch === "'") {                                   // 'Sheet name'!A1
      let j = i + 1, name = '';
      for (;;) {
        if (j >= src.length) throw new Unsupported('sheet');
        if (src[j] === "'") { if (src[j + 1] === "'") { name += "'"; j += 2; continue; } break; }
        name += src[j++];
      }
      if (src[j + 1] !== '!') throw new Unsupported('sheet');
      const m = refRe.exec(src.slice(j + 2));
      if (!m) throw new Unsupported('sheet ref');
      out.push({ t: 'ref', sheet: name, col: colNum(m[1]), row: +m[2] }); i = j + 2 + m[0].length; continue;
    }
    const rest = src.slice(i);
    let m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest);
    if (m) { out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
    m = /^([A-Za-z_][A-Za-z0-9_.]*)!/.exec(rest);       // Sheet!A1
    if (m) {
      const r = refRe.exec(rest.slice(m[0].length));
      if (!r) throw new Unsupported('sheet ref');
      out.push({ t: 'ref', sheet: m[1], col: colNum(r[1]), row: +r[2] }); i += m[0].length + r[0].length; continue;
    }
    m = refRe.exec(rest);
    if (m) { out.push({ t: 'ref', sheet: null, col: colNum(m[1]), row: +m[2] }); i += m[0].length; continue; }
    m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    if (m) { out.push({ t: 'name', v: m[0].toUpperCase() }); i += m[0].length; continue; }
    m = /^(<>|<=|>=|[-+*\/^&=<>(),:%])/.exec(rest);
    if (m) { out.push({ t: 'op', v: m[0] }); i += m[0].length; continue; }
    throw new Unsupported(`char ${ch}`);
  }
  return out;
}

/** A formula whose stored value differs from what the formula itself computes (the recompute pass). */
export interface CachedDiff { sheet: string; cell: string; stored: unknown; computed: unknown }
/** Works out and stores a value for every formula in the workbook that has none. Returns how many it filled.
    `recompute` (Troy 2026-11-13 change spec 1.1: "Anything that opens the file without recalculating ... must see the same
    numbers Excel will"): EVERY formula is worked out from its own inputs and that result stored, whatever value it was
    written with; `onDiff` hears each one whose stored value was different. A formula it cannot read keeps its stored value. */
export function fillCachedResults(wb: ExcelJS.Workbook, opts: { recompute?: boolean; onDiff?: (d: CachedDiff) => void } = {}): number {
  const recompute = !!opts.recompute;
  const sheets = new Map<string, ExcelJS.Worksheet>();
  for (const ws of wb.worksheets) sheets.set(ws.name.toLowerCase(), ws);
  const memo = new Map<string, Scalar>();
  const busy = new Set<string>();

  // ExcelJS's `cell.value` leaves out a stored result of 0 or "" — the cell's model has it
  const stored = (cell: ExcelJS.Cell): any => (cell as any).model?.result;
  const cellValue = (ws: ExcelJS.Worksheet, row: number, col: number): Scalar => {
    const r = ws.findRow(row); const cell = r ? r.findCell(col) : undefined;
    if (!cell) return null;
    const v: any = cell.value;
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    if (v instanceof Date) throw new Unsupported('date');
    if (typeof v === 'object' && (v.formula != null || v.sharedFormula != null)) {
      const have = stored(cell);
      if (!recompute && have !== undefined && have !== null) { if (have instanceof Date) throw new Unsupported('date'); return have; }
      const key = `${ws.id}!${row},${col}`;
      if (memo.has(key)) return memo.get(key)!;
      if (v.formula == null) { if (recompute && have != null && !(have instanceof Date)) return have; throw new Unsupported('shared formula'); }
      if (busy.has(key)) throw new Unsupported('circular');
      busy.add(key);
      try { const res = evaluate(String(v.formula), ws); memo.set(key, res); return res; }
      catch (e) {
        // recompute: a formula this reader cannot work out keeps the value it was written with
        if (recompute && e instanceof Unsupported && have !== undefined && have !== null && !(have instanceof Date)) { memo.set(key, have); return have; }
        throw e;
      } finally { busy.delete(key); }
    }
    if (typeof v === 'object' && Array.isArray(v.richText)) return v.richText.map((p: any) => p.text).join('');
    if (typeof v === 'object' && 'error' in v) return v as Err;
    if (typeof v === 'object' && 'text' in v) return String(v.text);
    throw new Unsupported('value');
  };

  const num = (v: Scalar): number | Err => {
    if (isErr(v)) return v;
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const s = v.trim();
    if (s !== '' && Number.isFinite(Number(s))) return Number(s);
    return err('#VALUE!');
  };
  const scalar = (v: Val): Scalar => (isRange(v) ? (v.cells.length === 1 && v.cells[0].length === 1 ? v.cells[0][0] : err('#VALUE!')) : v);
  const flat = (v: Val): Scalar[] => (isRange(v) ? v.cells.flat() : [v]);

  const criterion = (crit: Scalar): ((x: Scalar) => boolean) => {
    if (typeof crit === 'number') return (x) => typeof x === 'number' && x === crit;
    const s = String(crit ?? '');
    const m = /^(<>|<=|>=|=|<|>)?(.*)$/.exec(s)!;
    const op = m[1] || '=', rhs = m[2];
    if (rhs === '') return op === '<>' ? (x) => x != null && x !== '' : (x) => x == null || x === '';
    const n = Number(rhs);
    if (Number.isFinite(n)) {
      return (x) => {
        if (typeof x !== 'number') return op === '<>';
        return op === '=' ? x === n : op === '<>' ? x !== n : op === '<' ? x < n : op === '>' ? x > n : op === '<=' ? x <= n : x >= n;
      };
    }
    const t = rhs.toLowerCase();
    return (x) => { const eq = typeof x === 'string' && x.toLowerCase() === t; return op === '<>' ? !eq : op === '=' ? eq : false; };
  };

  function evaluate(src: string, home: ExcelJS.Worksheet): Scalar {
    const toks = tokenize(src.replace(/^=/, ''));
    let p = 0;
    const peek = (): Tok | undefined => toks[p];
    const isOp = (v: string): boolean => { const t = toks[p]; return !!t && t.t === 'op' && t.v === v; };
    const eat = (v: string): void => { if (!isOp(v)) throw new Unsupported(`expected ${v}`); p++; };
    const sheetOf = (name: string | null): ExcelJS.Worksheet => {
      if (name == null) return home;
      const ws = sheets.get(name.toLowerCase());
      if (!ws) throw new Unsupported(`sheet ${name}`);
      return ws;
    };
    const arith = (a: Val, b: Val, f: (x: number, y: number) => number | Err): Scalar => {
      const x = num(scalar(a)); if (isErr(x)) return x;
      const y = num(scalar(b)); if (isErr(y)) return y;
      return f(x, y);
    };
    const compare = (a: Scalar, b: Scalar, op: string): Scalar => {
      if (isErr(a)) return a; if (isErr(b)) return b;
      const rank = (v: Scalar) => (typeof v === 'number' || v == null ? 0 : typeof v === 'string' ? 1 : 2);
      let c: number;
      const x: any = a == null ? (typeof b === 'string' ? '' : 0) : a, y: any = b == null ? (typeof a === 'string' ? '' : 0) : b;
      if (rank(x) !== rank(y)) c = rank(x) - rank(y);
      else if (typeof x === 'string') c = x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0;
      else c = Number(x) - Number(y);
      return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    };

    const parseCmp = (): Val => {
      let a = parseCat();
      for (;;) {
        const t = peek();
        if (t && t.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) { p++; const b = parseCat(); a = compare(scalar(a), scalar(b), t.v); } else return a;
      }
    };
    const parseCat = (): Val => {
      let a = parseAdd();
      while (isOp('&')) {
        p++; const b = parseAdd();
        const x = scalar(a), y = scalar(b);
        if (isErr(x)) a = x; else if (isErr(y)) a = y;
        else { const s = (v: Scalar) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v)); a = s(x) + s(y); }
      }
      return a;
    };
    const parseAdd = (): Val => {
      let a = parseMul();
      for (;;) {
        if (isOp('+')) { p++; const b = parseMul(); a = arith(a, b, (x, y) => x + y); }
        else if (isOp('-')) { p++; const b = parseMul(); a = arith(a, b, (x, y) => x - y); }
        else return a;
      }
    };
    const parseMul = (): Val => {
      let a = parseUnary();
      for (;;) {
        if (isOp('*')) { p++; const b = parseUnary(); a = arith(a, b, (x, y) => x * y); }
        else if (isOp('/')) { p++; const b = parseUnary(); a = arith(a, b, (x, y) => (y === 0 ? err('#DIV/0!') : x / y)); }
        else return a;
      }
    };
    const parseUnary = (): Val => {
      if (isOp('-')) { p++; const v = parseUnary(); return arith(0, v, (_x, y) => -y); }
      if (isOp('+')) { p++; return parseUnary(); }
      return parsePow();
    };
    const parsePow = (): Val => {
      let a = parsePost();
      while (isOp('^')) { p++; const b = parseUnary(); a = arith(a, b, (x, y) => Math.pow(x, y)); }
      return a;
    };
    const parsePost = (): Val => {
      let a = parsePrimary();
      while (isOp('%')) { p++; a = arith(a, 100, (x, y) => x / y); }
      return a;
    };
    const parsePrimary = (): Val => {
      const t = peek();
      if (!t) throw new Unsupported('end');
      if (t.t === 'num') { p++; return t.v; }
      if (t.t === 'str') { p++; return t.v; }
      if (t.t === 'op' && t.v === '(') { p++; const v = parseCmp(); eat(')'); return v; }
      if (t.t === 'ref') {
        p++;
        const ws = sheetOf(t.sheet);
        if (isOp(':')) {
          p++;
          const u = peek();
          if (!u || u.t !== 'ref' || (u.sheet != null && u.sheet !== t.sheet)) throw new Unsupported('range');
          p++;
          const r0 = Math.min(t.row, u.row), r1 = Math.max(t.row, u.row), c0 = Math.min(t.col, u.col), c1 = Math.max(t.col, u.col);
          if ((r1 - r0 + 1) * (c1 - c0 + 1) > 200000) throw new Unsupported('range size');
          const cells: Scalar[][] = [];
          for (let r = r0; r <= r1; r++) { const line: Scalar[] = []; for (let c = c0; c <= c1; c++) line.push(cellValue(ws, r, c)); cells.push(line); }
          return { cells };
        }
        return cellValue(ws, t.row, t.col);
      }
      if (t.t === 'name') {
        p++;
        if (t.v === 'TRUE' && !isOp('(')) return true;
        if (t.v === 'FALSE' && !isOp('(')) return false;
        eat('(');
        return callFn(t.v);
      }
      throw new Unsupported('token');
    };
    /** skips one argument without evaluating it (the branch of IF / IFERROR that is not taken) */
    const skipArg = (): void => {
      let depth = 0;
      for (; p < toks.length; p++) {
        const t = toks[p];
        if (t.t !== 'op') continue;
        if (t.v === '(') depth++;
        else if (t.v === ')') { if (depth === 0) return; depth--; }
        else if (t.v === ',' && depth === 0) return;
      }
      throw new Unsupported('args');
    };
    const args = (): Val[] => {
      const out: Val[] = [];
      if (isOp(')')) { p++; return out; }
      for (;;) { out.push(parseCmp()); if (isOp(',')) { p++; continue; } eat(')'); return out; }
    };
    const numbersOf = (list: Val[]): number[] | Err => {
      const out: number[] = [];
      for (const a of list) {
        if (isRange(a)) { for (const v of a.cells.flat()) { if (isErr(v)) return v; if (typeof v === 'number') out.push(v); } }
        else { if (a == null) continue; const n = num(a); if (isErr(n)) return n; out.push(n); }
      }
      return out;
    };
    const callFn = (name: string): Val => {
      switch (name) {
        case 'IF': {
          const c = scalar(parseCmp());
          let yes: Val = true, no: Val = false;
          const truthy = isErr(c) ? null : typeof c === 'string' ? (() => { throw new Unsupported('IF text'); })() : !!c;
          if (isOp(',')) { p++; if (truthy === true) yes = parseCmp(); else skipArg(); }
          if (isOp(',')) { p++; if (truthy === false) no = parseCmp(); else skipArg(); }
          eat(')');
          return isErr(c) ? c : truthy ? yes : no;
        }
        case 'IFERROR': {
          const v = scalar(parseCmp());
          eat(',');
          if (isErr(v)) { const alt = parseCmp(); eat(')'); return alt; }
          skipArg(); eat(')');
          return v;
        }
        case 'SUM': { const n = numbersOf(args()); return isErr(n) ? n : n.reduce((a, b) => a + b, 0); }
        case 'AVERAGE': { const n = numbersOf(args()); return isErr(n) ? n : n.length ? n.reduce((a, b) => a + b, 0) / n.length : err('#DIV/0!'); }
        case 'MAX': { const n = numbersOf(args()); return isErr(n) ? n : n.length ? Math.max(...n) : 0; }
        case 'MIN': { const n = numbersOf(args()); return isErr(n) ? n : n.length ? Math.min(...n) : 0; }
        case 'ABS': { const a = args(); if (a.length !== 1) throw new Unsupported('ABS'); return arith(a[0], 0, (x) => Math.abs(x)); }
        case 'ROUND': { const a = args(); if (a.length !== 2) throw new Unsupported('ROUND'); return arith(a[0], a[1], (x, d) => { const k = Math.pow(10, d); return Math.sign(x) * Math.round(Math.abs(x) * k + 1e-9) / k; }); }
        case 'SUMIF': {
          const a = args();
          if (a.length < 2 || !isRange(a[0])) throw new Unsupported('SUMIF');
          const test = criterion(scalar(a[1]));
          const keys = flat(a[0]), vals = a.length > 2 ? flat(a[2]) : keys;
          let total = 0;
          for (let i = 0; i < keys.length; i++) { if (!test(keys[i])) continue; const v = vals[i]; if (isErr(v)) return v; if (typeof v === 'number') total += v; }
          return total;
        }
        case 'MATCH': {
          const a = args();
          if (a.length !== 3 || !isRange(a[1]) || scalar(a[2]) !== 0) throw new Unsupported('MATCH');
          const want = scalar(a[0]); if (isErr(want)) return want;
          const list = flat(a[1]);
          const at = list.findIndex((v) => (typeof v === 'number' && typeof want === 'number' ? v === want : typeof v === 'string' && typeof want === 'string' ? v.toLowerCase() === want.toLowerCase() : false));
          return at < 0 ? err('#N/A') : at + 1;
        }
        case 'INDEX': {
          const a = args();
          if (a.length !== 2 || !isRange(a[0])) throw new Unsupported('INDEX');
          const n = num(scalar(a[1])); if (isErr(n)) return n;
          const list = flat(a[0]);
          if (a[0].cells.length > 1 && a[0].cells[0].length > 1) throw new Unsupported('INDEX 2D');
          return n < 1 || n > list.length ? err('#REF!') : list[n - 1];
        }
        default: throw new Unsupported(`function ${name}`);
      }
    };

    const v = scalar(parseCmp());
    if (p !== toks.length) throw new Unsupported('trailing');
    return v;
  }

  let filled = 0;
  for (const ws of wb.worksheets) {
    ws.eachRow((row, r) => {
      row.eachCell((cell, c) => {
        const v: any = cell.value;
        if (!v || typeof v !== 'object' || v.formula == null) return;
        const have = stored(cell);
        if (!recompute && have !== undefined && have !== null) return;
        try {
          let res = cellValue(ws, r, c);
          if (res == null) res = 0;                                   // a reference to an empty cell shows 0
          if (typeof res === 'number' && !Number.isFinite(res)) return;
          if (recompute && opts.onDiff && have !== undefined && have !== null) {
            // a blank written for an empty input that computes 0 is not a real difference
            const blank = (x: unknown) => x === '' || x === 0;
            const differs = typeof res === 'number' && typeof have === 'number' ? Math.abs(res - have) > 0.005 : !(blank(res) && blank(have)) && JSON.stringify(res) !== JSON.stringify(have);
            if (differs) opts.onDiff({ sheet: ws.name, cell: cell.address, stored: have, computed: res });
          }
          cell.value = { ...v, result: res } as any;
          filled++;
        } catch (e) {
          if (!(e instanceof Unsupported)) throw e;                    // unreadable formula: leave it as it was
        }
      });
    });
  }
  return filled;
}
