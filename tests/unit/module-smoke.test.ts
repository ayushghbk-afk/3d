// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Import smoke test.
 *
 * The editor is assembled from many small modules and a single bad top-level
 * statement (a missing DOM node, a circular import, a renamed export) only
 * shows up at runtime in the browser. Loading every module in jsdom catches
 * that class of breakage without a headless browser.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const SRC = join(process.cwd(), 'src');
const files = walk(SRC)
  .map((f) => relative(SRC, f).replace(/\\/g, '/'))
  // main.ts boots the whole app on import (needs a live router + Supabase);
  // pwa.ts registers a service worker. Both are entry points, not modules.
  .filter((f) => !f.startsWith('server/') && f !== 'main.ts' && f !== 'pwa.ts')
  .sort();

describe('every module imports cleanly', () => {
  it('found the source tree', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).not.toContain('main.ts');
  });

  for (const file of files) {
    it(`imports ${file}`, async () => {
      const mod = await import(`../../src/${file}`);
      expect(mod).toBeTruthy();
    });
  }
});
