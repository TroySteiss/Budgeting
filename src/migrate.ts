import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pool, poolFor, REGIONS, REGION_KEYS, type Region } from './db.js';

const migrationsDir = join(process.cwd(), 'migrations');

/** Apply any pending migrations to one region's schema (its own _migrations table). */
async function migrateRegion(region: Region): Promise<void> {
  const { schema } = REGIONS[region];
  // the schema must exist before a pool pinned to it can create tables there
  if (schema !== 'public') await pool.query(`create schema if not exists ${schema}`);
  const p = poolFor(region);
  await p.query('create table if not exists _migrations (name text primary key, applied_at timestamptz default now())');
  const applied = new Set((await p.query('select name from _migrations')).rows.map((r) => r.name));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    console.log(`+ [${region}] applying ${f}`);
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('insert into _migrations(name) values($1)', [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`! [${region}] failed ${f}:`, e);
      throw e;
    } finally {
      client.release();
    }
  }
}

/** Apply pending migrations to every region. Uses the shared pools; does NOT close them. */
export async function runMigrations(): Promise<void> {
  for (const r of REGION_KEYS) await migrateRegion(r);
  console.log('migrations complete');
}

if (process.argv[1] && (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'))) {
  runMigrations()
    .then(() => Promise.all(REGION_KEYS.map((r) => poolFor(r).end())))
    .catch((e) => { console.error(e); process.exit(1); });
}
