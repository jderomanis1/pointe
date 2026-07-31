import AxeBuilder from '@axe-core/playwright';
import { devices, expect, test, type Browser, type BrowserContextOptions, type Page, type TestInfo } from '@playwright/test';

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Create Session' }).click();
  await page.waitForURL(/\/[a-z]+-[a-z]+-\d+$/);
  await expect(page.getByText('Connected')).toBeVisible();
  return new URL(page.url()).pathname.slice(1);
}

async function joinRoom(
  browser: Browser,
  slug: string,
  name: string,
  options: BrowserContextOptions,
) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`/${slug}`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByText('Connected')).toBeVisible();
  return { context, page };
}

test('iPhone-width landing and room controls are usable', async ({ browser }, testInfo) => {
  const context = await browser.newContext(devices['iPhone 13']);
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Join the room. Pick a card. Keep moving.' })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  await screenshot(page, testInfo, 'iphone-landing');

  await createRoom(page, 'iPhone Host');
  const radios = page.getByRole('radio');
  await expect(radios).toHaveCount(7);
  for (const value of ['1', '2', '3', '5', '8', '13', '21']) {
    const card = page.getByRole('radio', { name: value, exact: true });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
  }
  await page.getByRole('radio', { name: '21', exact: true }).click();
  await page.getByRole('button', { name: 'Cast estimate' }).click();
  await expect(page.getByRole('button', { name: 'Update vote' })).toBeVisible();
  await page.getByRole('button', { name: 'Execute Reveal' }).click();
  await expect(page.getByText('21', { exact: true }).first()).toBeVisible();
  await screenshot(page, testInfo, 'iphone-single-player-revealed');

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  await context.close();
});

test('participant markup is escaped and never executed', async ({ browser }, testInfo) => {
  const hostContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const slug = await createRoom(hostPage, 'Security Host');
  const payload = '<img src=x onerror=window.__pointeXss=1>';
  const attacker = await joinRoom(browser, slug, payload, devices['Pixel 7']);

  await expect(hostPage.getByText(payload, { exact: true }).first()).toBeVisible();
  expect(await hostPage.getByText(payload, { exact: true }).count()).toBeGreaterThan(0);
  const executed = await hostPage.evaluate(() => Boolean(
    (globalThis as typeof globalThis & { __pointeXss?: number }).__pointeXss,
  ));
  expect(executed).toBe(false);
  expect(await hostPage.locator('img[src="x"]').count()).toBe(0);
  await screenshot(hostPage, testInfo, 'escaped-participant-name');

  await attacker.context.close();
  await hostContext.close();
});

test('cross-origin API access is not enabled and retired retro surfaces stay gone', async ({ request, page }, testInfo) => {
  const hostileOrigin = 'https://attacker.invalid';
  const health = await request.get('/api/health', { headers: { Origin: hostileOrigin } });
  expect(health.status()).toBe(200);
  expect(health.headers()['access-control-allow-origin']).not.toBe('*');
  expect(health.headers()['access-control-allow-origin']).not.toBe(hostileOrigin);

  const preflight = await request.fetch('/api/rooms', {
    method: 'OPTIONS',
    headers: {
      Origin: hostileOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  expect(preflight.headers()['access-control-allow-origin']).not.toBe('*');
  expect(preflight.headers()['access-control-allow-origin']).not.toBe(hostileOrigin);

  expect((await request.get('/api/retros/qa-probe-999999999')).status()).toBe(404);
  const sitemap = await request.get('/sitemap.xml');
  expect(await sitemap.text()).not.toContain('/retro');
  await page.goto('/retro');
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  await screenshot(page, testInfo, 'retro-not-found');
});
