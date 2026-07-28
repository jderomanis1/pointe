import { test, expect } from '@playwright/test';

/**
 * Landing smoke. Proves the full stack boots and the primary low-friction
 * create/join experience renders before deeper room-flow tests begin.
 */
test('landing renders the planning poker entry experience', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Better estimates start with a better room.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Session' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Join a session' })).toBeVisible();
});
