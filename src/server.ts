import express from 'express';
import { join } from 'node:path';
import { runMigrations } from './migrate.js';
import { seedIfEmpty } from './seed-if-empty.js';
import { sessionMiddleware } from './auth.js';
import { router, apiErrors, recalcContractBudgets } from './routes.js';
import { syncRepoContracts } from './contracts.js';
import { REGIONS, inRegion, type Region } from './db.js';
import { payrollRouter } from './payroll.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(sessionMiddleware());
app.use('/api/payroll', payrollRouter);   // its own gate (payroll password) on top of the app login
app.use('/api', router);
app.use('/api', apiErrors);
app.get('/healthz', (_req, res) => res.json({ ok: true }));
// no-cache on app assets: browsers must revalidate so deploys take effect
// immediately (a stale cached app.js made edits look like they weren't saving)
app.use(express.static(join(process.cwd(), 'public'), {
  setHeaders: (res, path) => {
    if (/\.(js|css|html)$/.test(path)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('*', (_req, res) => res.sendFile(join(process.cwd(), 'public', 'index.html')));

const port = Number(process.env.PORT) || 3100;
/* the contracts register's repo file(s), data/contracts/<region>/<year>.csv, on every deploy (Troy 2026-11-17); the
   budgets of every property / year that changed are recalculated. A problem in the file is logged, never fatal. */
async function loadRepoContracts(): Promise<void> {
  for (const r of Object.keys(REGIONS) as Region[]) {
    try {
      await inRegion(r, async () => {
        const out = await syncRepoContracts(r);
        if (out.errors.length) console.warn(`[contracts] ${r}: ${out.errors.length} note(s) (rows skipped / page rows kept) — ${out.errors.slice(0, 8).join('; ')}`);
        if (out.changed.length) {
          const ids = await recalcContractBudgets(out.changed);
          console.log(`[contracts] ${r}: ${out.loaded} repo row(s); ${out.changed.length} property-year(s) changed, ${ids.length} budget(s) recalculated`);
        }
      });
    } catch (e) { console.warn(`[contracts] ${r}: repo file not loaded —`, (e as Error).message); }
  }
}
runMigrations()
  .then(seedIfEmpty)
  .then(loadRepoContracts)
  .then(() => app.listen(port, () => console.log(`budget-tool listening on :${port}`)))
  .catch((e) => { console.error('boot failed', e); process.exit(1); });
