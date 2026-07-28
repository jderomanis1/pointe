/**
 * S10.i.c2 — prod-bundle exclusion proof.
 *
 * The load-bearing security property the dev/CI test routes rely on:
 * the prod binary literally cannot contain the test-route code, because
 * the production entry never imports it. Bundling-by-reachability drops
 * anything not reachable from that entry.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUTDIR = '.dist-prod';
let bundlePath = resolve(OUTDIR, 'worker.js');

/** Strings that, if present in the prod bundle, indicate test-route
 * leakage. None of these appear in any prod-reachable code today; this
 * is the contract the test enforces. */
const FORBIDDEN_SUBSTRINGS = [
  'maybeHandleTestRoute',
  'force-async-close',
  'inject-ai-ready',
  'fire-host-vacancy',
  'drop-voter-sockets',
  'POINTE_E2E_TOKEN',
  '/api/__test/',
];

describe('prod bundle excludes all dev/CI test code', () => {
  beforeAll(() => {
    execSync('pnpm exec wrangler deploy --dry-run --outdir=' + OUTDIR, {
      stdio: 'pipe',
      cwd: process.cwd(),
    });
    const emitted = readdirSync(resolve(OUTDIR)).filter((name) => name.endsWith('.js'));
    expect(emitted.length, 'expected exactly one production JavaScript bundle').toBe(1);
    bundlePath = resolve(OUTDIR, emitted[0]);
    expect(existsSync(bundlePath), `expected prod bundle at ${bundlePath}`).toBe(true);
  }, 60_000);

  it.each(FORBIDDEN_SUBSTRINGS)(
    'prod bundle does NOT contain "%s"',
    (needle) => {
      const bundle = readFileSync(bundlePath, 'utf8');
      expect(bundle.includes(needle), `forbidden string "${needle}" found in ${bundlePath}`).toBe(false);
    },
  );
});
