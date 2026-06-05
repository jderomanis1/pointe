/**
 * S10.i.c2 — prod-bundle exclusion proof.
 *
 * The load-bearing security property the dev/CI test routes rely on:
 * the prod binary literally cannot contain the test-route code, because
 * the prod entry (`worker.ts`) never imports it. Bundling-by-reachability
 * (wrangler's esbuild) drops anything not reachable from the entry.
 *
 * This test asserts that fact against a freshly-built prod bundle. If
 * someone accidentally adds `import './testRoutes'` to `worker.ts`, or
 * adds a `/__test/` path to `room.ts`, this test fails — turning "can't
 * leak" from a hope into a verified invariant.
 *
 * Runs as a Node-config (not workers-pool) test because it spawns
 * wrangler and reads the resulting bundle from disk.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const OUTDIR = '.dist-prod';
const BUNDLE = resolve(OUTDIR, 'worker.js');

/** Strings that, if present in the prod bundle, indicate test-route
 *  leakage. None of these appear in any prod-reachable code today; this
 *  is the contract the test enforces. */
const FORBIDDEN_SUBSTRINGS = [
  'maybeHandleTestRoute',  // the testRoutes.ts export
  'force-async-close',     // the DevRoom internal route (S10.i)
  'inject-ai-ready',       // the DevRoom internal route (S10.ii)
  'POINTE_E2E_TOKEN',      // the dev-only env var name
  '/api/__test/',          // the test-route prefix
];

describe('prod bundle excludes all dev/CI test code', () => {
  beforeAll(() => {
    // Build the prod bundle (no upload, no network). Wrangler always
    // resolves `main` from wrangler.toml (NOT wrangler.dev.toml) on
    // `deploy` / `--dry-run`, so this exercises the production entry.
    execSync('pnpm exec wrangler deploy --dry-run --outdir=' + OUTDIR, {
      stdio: 'pipe',
      cwd: process.cwd(),
    });
    expect(existsSync(BUNDLE), `expected prod bundle at ${BUNDLE}`).toBe(true);
  }, 60_000);

  it.each(FORBIDDEN_SUBSTRINGS)(
    'prod bundle does NOT contain "%s"',
    (needle) => {
      const bundle = readFileSync(BUNDLE, 'utf8');
      expect(bundle.includes(needle), `forbidden string "${needle}" found in ${BUNDLE}`).toBe(false);
    },
  );
});
