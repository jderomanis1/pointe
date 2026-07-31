import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export type HostHandle = {
  page: Page;
  context: BrowserContext;
  slug: string;
};

export type VoterHandle = {
  page: Page;
  context: BrowserContext;
  name: string;
};

/** Create a facilitator room and wait until the automatically opened vote is ready. */
export async function createHostRoom(
  browser: Browser,
  opts: { hostName: string; mode?: 'sync' | 'async' },
): Promise<HostHandle> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Your name').fill(opts.hostName);
  await page.getByRole('button', { name: 'Create Session' }).click();
  await page.waitForURL(/\/[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{24}$/);
  const slug = new URL(page.url()).pathname.replace(/^\//, '');
  await expect(page.getByRole('button', { name: 'Execute Reveal' })).toBeVisible();
  return { page, context, slug };
}

/** Join an existing room and wait for the active vote. */
export async function joinAsVoter(
  browser: Browser,
  opts: { slug: string; name: string; role?: 'voter' | 'spectator' },
): Promise<VoterHandle> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/${opts.slug}`);
  await page.getByLabel('Your name').fill(opts.name);
  if (opts.role === 'spectator') {
    await page.getByRole('radio', { name: /Spectator/i }).click();
  }
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByText('Connected')).toBeVisible();
  if (opts.role !== 'spectator') {
    await expect(page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();
  }
  return { page, context, name: opts.name };
}

/** Compatibility shim: the live-only product opens its round automatically. */
export async function addStory(hostPage: Page, _text: string): Promise<void> {
  await expect(hostPage.getByRole('button', { name: 'Execute Reveal' })).toBeVisible();
}

/** Compatibility shim: no manual open action exists in the live-only product. */
export async function openVotingFirstStory(hostPage: Page): Promise<void> {
  await expect(hostPage.getByRole('button', { name: 'Execute Reveal' })).toBeVisible();
}

export async function castVote(page: Page, value: string): Promise<void> {
  await page.getByRole('radio', { name: value, exact: true }).click();
  await page.getByRole('button', { name: 'Cast estimate' }).click();
  await expect(page.getByRole('button', { name: 'Update vote' })).toBeVisible();
}

export function seatByName(viewer: Page, displayName: string) {
  return viewer.locator('[data-testid^="seat-"]').filter({ hasText: displayName });
}
