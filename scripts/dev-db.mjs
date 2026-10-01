/* Local Postgres for development WITHOUT a system install: boots an embedded
   PostgreSQL (devDependency `embedded-postgres`) on the port in .env's
   DATABASE_URL (default 5432) with user postgres / postgres and creates the
   `budget_tool` database on first run. Data lives in .pgdata/ (gitignored).
   Usage:  node scripts/dev-db.mjs      (leave running; then `npm run dev`) */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';

const url = new URL(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/budget_tool');
const port = Number(url.port) || 5432;
const user = decodeURIComponent(url.username || 'postgres');
const password = decodeURIComponent(url.password || 'postgres');
const dbName = url.pathname.replace(/^\//, '') || 'budget_tool';
const dataDir = join(process.cwd(), '.pgdata');
const fresh = !existsSync(dataDir);

const pg = new EmbeddedPostgres({ databaseDir: dataDir, user, password, port, persistent: true });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(dbName);
console.log(`embedded postgres on :${port} · db ${dbName} · data ${dataDir}${fresh ? ' (initialised)' : ''}`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
