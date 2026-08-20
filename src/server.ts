import express from 'express';
import { join } from 'node:path';
import { runMigrations } from './migrate.js';
import { seedIfEmpty } from './seed-if-empty.js';
import { sessionMiddleware } from './auth.js';
import { router, apiErrors } from './routes.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(sessionMiddleware());
app.use('/api', router);
app.use('/api', apiErrors);
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.static(join(process.cwd(), 'public')));
app.get('*', (_req, res) => res.sendFile(join(process.cwd(), 'public', 'index.html')));

const port = Number(process.env.PORT) || 3100;
runMigrations()
  .then(seedIfEmpty)
  .then(() => app.listen(port, () => console.log(`budget-tool listening on :${port}`)))
  .catch((e) => { console.error('boot failed', e); process.exit(1); });
