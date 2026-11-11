import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import 'dotenv/config';

// Numerics come back from pg as strings by default; coerce numeric to number.
pg.types.setTypeParser(1700, (v) => (v == null ? null : parseFloat(v)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');

function wantSSL(conn: string): boolean {
  if (process.env.PGSSL === 'false') return false;
  if (process.env.PGSSL === 'true') return true;
  try {
    const host = new URL(conn).hostname;
    return !(host === 'localhost' || host === '127.0.0.1' || host === '::1');
  } catch {
    return false;
  }
}

/* ---------------- regions (Troy 2026-11-11) ----------------
   One app, one login, fully separate data per region. Each region is its own
   Postgres SCHEMA with the whole table set: North Dakota keeps the original
   `public` schema (nothing moved), KC East lives in `kc`. A region's pool pins
   search_path to ONLY its schema, so a query can never fall through to the
   other region's tables. Every request names its region (X-Region header, or
   ?region= on download links); no region means 'nd' (the original app). */
export const REGIONS = {
  nd: { label: 'North Dakota', short: 'ND', schema: 'public' },
  kc: { label: 'KC East', short: 'KC East', schema: 'kc' },
} as const;
export type Region = keyof typeof REGIONS;
export const REGION_KEYS = Object.keys(REGIONS) as Region[];
export const isRegion = (r: unknown): r is Region => typeof r === 'string' && r in REGIONS;

const ssl = wantSSL(connectionString) ? { rejectUnauthorized: false } : undefined;
const pools = new Map<Region, pg.Pool>();
export function poolFor(r: Region): pg.Pool {
  let p = pools.get(r);
  if (!p) {
    const schema = REGIONS[r].schema;
    p = new pg.Pool({ connectionString, ssl, ...(schema === 'public' ? {} : { options: `-c search_path=${schema}` }) });
    pools.set(r, p);
  }
  return p;
}
/** The original (North Dakota, `public` schema) pool: the session store and boot use it. */
export const pool = poolFor('nd');

const regionStore = new AsyncLocalStorage<Region>();
export const currentRegion = (): Region => regionStore.getStore() || 'nd';
export function inRegion<T>(r: Region, fn: () => T): T { return regionStore.run(r, fn); }
/** The region a request is for: X-Region header, else ?region=, else 'nd'. Unknown values → 'nd'. */
export function regionOfRequest(req: { get(name: string): string | undefined; query?: any }): Region {
  const raw = String(req.get('x-region') || req.query?.region || '').toLowerCase();
  return isRegion(raw) ? raw : 'nd';
}

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
  const r = await poolFor(currentRegion()).query(text, params);
  return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await poolFor(currentRegion()).connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
