import { defineConfig, devices } from '@playwright/test';

/**
 * S10.i — Playwright E2E harness foundation.
 *
 * Locked decisions (the S10 design beat):
 *   • Local stack: real workerd worker (via `wrangler dev --local`) + real
 *     served web (Vite) + Playwright against localhost. Same in CI.
 *   • Determinism discipline: NO `waitForTimeout`. Wait on observable state
 *     (an element, a text, a WS-driven DOM change). E2E is the flakiest
 *     class of test in the project — build it to never flake by construction.
 *   • Web client uses relative URLs (`/api/*`, `/api/rooms/<slug>/ws`); the
 *     Vite dev server proxies them to wrangler on 127.0.0.1:8787 (incl. WS
 *     upgrade via `ws: true`). Production hits the same paths against the
 *     deployed worker on the same origin — zero client-code env branching.
 *
 * `webServer`: Playwright launches the worker on 8787 + the web on 5173,
 * waits for readiness by polling `/api/health` (via the Vite proxy on 5173
 * — proves the proxy path is up, not just wrangler). Per-process timeouts
 * are conservative; CI cold-start can take longer than a local Mac.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // one stack instance shared across the suite
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // single-worker keeps the shared stack deterministic
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      name: 'worker',
      command: 'pnpm -F @pointe/worker dev:e2e',
      // Hit wrangler directly to confirm the worker is up before the web
      // dev server starts proxying. 60s cold-start tolerance for CI.
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      name: 'web',
      command: 'pnpm -F @pointe/web dev',
      // Wait on the proxy path — proves Vite is up AND the proxy to wrangler
      // is wired correctly (the production-shape path the suite uses).
      url: 'http://localhost:5173/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
