import pg from 'pg';
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

export const pool = new pg.Pool({
  connectionString,
  ssl: wantSSL(connectionString) ? { rejectUnauthorized: false } : undefined,
});

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
  const r = await pool.query(text, params);
  return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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
