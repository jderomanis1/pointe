import { test, expect } from '@playwright/test';

test('landing renders the immediate live planning poker entry experience', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Join the room. Pick a card. Keep moving.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Session' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Join a session' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Async/i })).toHaveCount(0);
});
