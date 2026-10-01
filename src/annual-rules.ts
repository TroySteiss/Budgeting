/* The per-GL foundation rules for annual budgets — extracted from the GRKS
   2026 RMC draft of the Yardi budget template (Troy, 2026-10-01: "those
   formulas will be the starting point for the foundation"). Regenerate with
   `node scripts/extract-annual-rules.mjs <draft.xlsm> --write`; the engine
   (shared/annual.ts) consults this table before its built-in template rules. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnnualRule } from '../shared/annual.js';

let cache: Record<string, AnnualRule> | null = null;

export function loadAnnualRules(): Record<string, AnnualRule> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'seed', 'annual-rules.json'), 'utf8'));
    cache = (raw.rules || {}) as Record<string, AnnualRule>;
  } catch {
    cache = {};
  }
  return cache;
}
