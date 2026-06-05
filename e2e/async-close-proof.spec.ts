import { test, expect, request as pwRequest } from '@playwright/test';

/**
 * S10.i.c2 — the single-context proof flow.
 *
 * Drives the entire stack with one browser context (the host) + one call
 * to the dev-only test endpoint:
 *
 *   1. Host creates an async room via the CreatePage UI.
 *   2. Lands in the room (RoomShell). Adds one story via AddStory.
 *   3. Clicks "Open async voting" — sends OPEN_ASYNC over WS, the
 *      backend stamps async_window + transitions room → active, and
 *      AsyncHostMonitorView renders.
 *   4. POST /api/__test/close/<slug> with the dev token — fires the
 *      production async-close path on the DO (same code path as the
 *      real alarm; idempotent).
 *   5. Assert ReviewHostScreen renders (the agreed/discuss split).
 *
 * This one flow validates every harness piece: the stack boots, a real
 * browser drives the real UI, WS connects, the host opens a window,
 * the gated force-close hook fires the real close path, and the
 * post-close review screen renders. The multi-context (anti-anchoring)
 * and full-walk versions land in the next slice.
 *
 * Determinism: every wait is on observable DOM state — never
 * waitForTimeout. Each step blocks on its outcome before the next runs.
 */

const E2E_TOKEN = 'dev-e2e-token';

test('host async-window → force-close hook → review screen renders', async ({ page }) => {
  // 1. Create page → name + async toggle + submit.
  await page.goto('/');
  await page.getByLabel('Your name').fill('Alice');
  await page.getByRole('radio', { name: /Async window/i }).click();
  await page.getByRole('button', { name: 'Create room' }).click();

  // 2. Wait for the room URL + the post-join lobby. The slug is in the
  // header (`<span class="font-mono text-subhead">{slug}</span>`); read
  // it out so we can fire the test endpoint at it later.
  await page.waitForURL(/\/[a-z]+-[a-z]+-\d+$/);
  const url = new URL(page.url());
  const slug = url.pathname.replace(/^\//, '');
  expect(slug).toMatch(/^[a-z]+-[a-z]+-\d+$/);

  // The host's first lobby render shows the AddStory affordance.
  await expect(page.getByLabel('Story')).toBeVisible();

  // 3. Add a story. The AsyncOpenPanel only renders when there is at
  // least one story (server gates NO_PENDING_STORIES too).
  await page.getByLabel('Story').fill('Reset password');
  await page.getByRole('button', { name: 'Add story' }).click();
  // Wait on observable state — the AsyncOpenPanel appears.
  await expect(page.getByRole('button', { name: /Open async voting/i })).toBeVisible();

  // 4. Open the async window. Default duration is 24h.
  await page.getByRole('button', { name: /Open async voting/i }).click();

  // Host's during-window view (AsyncHostMonitorView) takes over. Wait
  // on its distinctive header text.
  await expect(page.getByText(/Async window/)).toBeVisible();
  await expect(page.getByText(/closes in/)).toBeVisible();

  // 5. Force the close via the dev-only test endpoint. Uses Playwright's
  // request fixture (clean context, talks straight to the worker via
  // the Vite proxy on baseURL).
  const apiCtx = await pwRequest.newContext({ baseURL: page.url() });
  const closeRes = await apiCtx.post(`/api/__test/close/${slug}`, {
    headers: { 'x-pointe-e2e-token': E2E_TOKEN },
  });
  expect(closeRes.status()).toBe(200);
  expect(await closeRes.json()).toEqual({ ok: true });

  // 6. The async-close alarm broadcasts a votes_revealed + an
  // async_window_closed change → the store flips room.state to 'review'
  // → RoomShell mounts ReviewHostScreen. Wait on the screen's
  // distinctive data-slot. NO waitForTimeout.
  await expect(page.locator('[data-slot="review-host-screen"]')).toBeVisible();

  // Sanity: the summary distillation reads the shape we expect (1 story
  // with no votes → no median → no-estimate bucket → "0 agreed").
  await expect(page.locator('[data-slot="review-summary"]')).toContainText(/1 story/);
});

test('test endpoint refuses without the token (403)', async ({ request }) => {
  // Use ANY existing or fictional slug — the token check happens before
  // the slug lookup, so even a bad path returns 403 if no token.
  const res = await request.post('/api/__test/close/fake-slug-99');
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
});

test('test endpoint refuses with the wrong token (403)', async ({ request }) => {
  const res = await request.post('/api/__test/close/fake-slug-99', {
    headers: { 'x-pointe-e2e-token': 'wrong-token' },
  });
  expect(res.status()).toBe(403);
});
