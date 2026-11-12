/* The build (package.json "build") hands esbuild every source file BY NAME, without bundling: a new module left
   off that list is missing from dist/ and the server dies on import at boot (Railway: "failed network
   healthcheck"). That happened 2026-11-12 with shared/review.ts and shared/reviewApply.ts. This keeps the list
   complete: every .ts under src/ and shared/ must be on it. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('production build list', () => {
  it('names every source file under src/ and shared/', () => {
    const root = process.cwd();
    const build: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.build;
    const listed = new Set(build.split(/\s+/).filter((t) => t.endsWith('.ts')));
    const files = ['src', 'shared'].flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).map((f) => `${d}/${f}`));
    expect(files.filter((f) => !listed.has(f))).toEqual([]);
  });
});
