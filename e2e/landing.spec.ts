import { test, expect } from '@playwright/test';

/**
 * S10.i — landing smoke. Proves the entire stack boots end-to-end:
 *   • wrangler dev serves /api/health,
 *   • Vite serves the SPA + proxies /api → wrangler,
 *   • Playwright loads localhost:5173,
 *   • the React landing page renders.
 *
 * This is the trip-wire that catches "harness broken" before any flow
 * test runs. If this fails the next slice's flows can't possibly pass.
 *
 * Waits on observable state — the heading rendering — not on time. The
 * Playwright config's webServer block has already polled /api/health for
 * us, so by the time this test runs, the stack is up.
 */
test('landing renders ("Pointe" heading visible) — stack boots end-to-end', async ({ page }) => {
  await page.goto('/');
  // The CreatePage renders <h1>Pointe</h1>. Assert by role+name so the
  // selector tracks the semantic shape, not a brittle class.
  await expect(page.getByRole('heading', { name: 'Pointe' })).toBeVisible();
});
