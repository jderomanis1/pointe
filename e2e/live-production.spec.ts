import AxeBuilder from '@axe-core/playwright';
import { devices, expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

type BrowserSignals = {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  serverErrors: string[];
};

type Participant = {
  name: string;
  page: Page;
  context: BrowserContext;
};

function watchBrowser(page: Page): BrowserSignals {
  const signals: BrowserSignals = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    serverErrors: [],
  };

  page.on('console', (message) => {
    if (message.type() === 'error') signals.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => signals.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown failure';
    if (request.url().startsWith('https://pointe.team')) {
      signals.failedRequests.push(`${request.method()} ${request.url()} :: ${failure}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().startsWith('https://pointe.team') && response.status() >= 500) {
      signals.serverErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  return signals;
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect.soft(dimensions.content, `horizontal overflow: ${JSON.stringify(dimensions)}`)
    .toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function expectActionSize(page: Page, accessibleName: string): Promise<void> {
  const control = page.getByRole('button', { name: accessibleName });
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect.soft(box?.height ?? 0, `${accessibleName} should be at least 44px tall`).toBeGreaterThanOrEqual(44);
  expect.soft(box?.width ?? 0, `${accessibleName} should be at least 44px wide`).toBeGreaterThanOrEqual(44);
}

async function expectCleanBrowser(signals: BrowserSignals, testInfo: TestInfo): Promise<void> {
  await testInfo.attach('browser-signals.json', {
    body: Buffer.from(JSON.stringify(signals, null, 2)),
    contentType: 'application/json',
  });
  expect.soft(signals.pageErrors, 'uncaught browser errors').toEqual([]);
  expect.soft(signals.serverErrors, 'same-origin 5xx responses').toEqual([]);
  expect.soft(signals.failedRequests, 'same-origin failed requests').toEqual([]);
  expect.soft(signals.consoleErrors, 'browser console errors').toEqual([]);
}

async function createRoom(page: Page, hostName: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Your name').fill(hostName);
  await page.getByRole('button', { name: 'Create Session' }).click();
  await page.waitForURL(/\/[a-z]+-[a-z]+-\d+$/);
  await expect(page.getByText('Connected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute Reveal' })).toBeVisible();
  return new URL(page.url()).pathname.slice(1);
}

async function joinRoom(
  browser: Parameters<typeof test>[0] extends never ? never : any,
  slug: string,
  name: string,
  contextOptions: Record<string, unknown>,
): Promise<Participant> {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.goto(`/${slug}`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByText('Connected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();
  return { name, page, context };
}

async function castVote(page: Page, value: string): Promise<void> {
  await page.getByRole('radio', { name: value, exact: true }).click();
  await page.getByRole('button', { name: /Cast estimate|Update vote/ }).click();
  await expect(page.getByRole('button', { name: 'Update vote' })).toBeVisible();
}

function seat(page: Page, name: string) {
  return page.locator('[data-testid^="seat-"]').filter({ hasText: name });
}

async function runRound(
  host: Participant,
  voters: Participant[],
  values: string[],
  roundNumber: number,
  testInfo: TestInfo,
): Promise<void> {
  const participants = [host, ...voters];
  for (let index = 0; index < participants.length; index += 1) {
    await castVote(participants[index].page, values[index]);
  }

  for (const viewer of participants) {
    for (const participant of participants) {
      await expect(seat(viewer.page, participant.name)).toHaveAttribute('data-voted', 'true');
      await expect(seat(viewer.page, participant.name)).not.toContainText(values[participants.indexOf(participant)]);
    }
  }

  await host.page.getByRole('button', { name: 'Execute Reveal' }).click();
  await expect(host.page.getByRole('button', { name: 'Vote again' })).toBeVisible();

  for (const viewer of participants) {
    for (let index = 0; index < participants.length; index += 1) {
      await expect(seat(viewer.page, participants[index].name)).toHaveAttribute('data-revealed', 'true');
      await expect(seat(viewer.page, participants[index].name)).toContainText(values[index]);
    }
    await expectNoHorizontalOverflow(viewer.page);
  }

  await attachScreenshot(host.page, testInfo, `round-${roundNumber}-desktop-revealed`);
  await attachScreenshot(voters[0].page, testInfo, `round-${roundNumber}-iphone-revealed`);
  await attachScreenshot(voters[1].page, testInfo, `round-${roundNumber}-android-revealed`);
}

test.describe('production responsive UX/UI', () => {
  test('landing and room entry remain usable at each supported viewport', async ({ page }, testInfo) => {
    const signals = watchBrowser(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Join the room. Pick a card. Keep moving.' })).toBeVisible();
    await expectActionSize(page, 'Create Session');
    await expectNoHorizontalOverflow(page);

    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    await testInfo.attach('landing-accessibility.json', {
      body: Buffer.from(JSON.stringify(accessibility.violations, null, 2)),
      contentType: 'application/json',
    });
    expect.soft(accessibility.violations, 'WCAG A/AA landing violations').toEqual([]);

    await attachScreenshot(page, testInfo, `${testInfo.project.name}-landing`);

    await page.getByRole('tab', { name: 'Join a session' }).click();
    await expectNoHorizontalOverflow(page);
    await attachScreenshot(page, testInfo, `${testInfo.project.name}-join-tab`);

    await expectCleanBrowser(signals, testInfo);
  });
});

test.describe('production playability', () => {
  test('three mixed-device participants complete three consecutive rounds', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Run the multiplayer matrix once.');

    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const hostPage = await hostContext.newPage();
    const host: Participant = { name: 'QA Host', page: hostPage, context: hostContext };
    const hostSignals = watchBrowser(hostPage);
    const slug = await createRoom(hostPage, host.name);

    const alice = await joinRoom(browser, slug, 'Alice Mobile', devices['iPhone 13']);
    const bob = await joinRoom(browser, slug, 'Bob Mobile', devices['Pixel 7']);
    const aliceSignals = watchBrowser(alice.page);
    const bobSignals = watchBrowser(bob.page);

    await expect(hostPage.locator('aside[aria-label="Team roster"]')).toContainText('Voters · 3');
    await attachScreenshot(hostPage, testInfo, 'round-1-desktop-open');
    await attachScreenshot(alice.page, testInfo, 'round-1-iphone-open');
    await attachScreenshot(bob.page, testInfo, 'round-1-android-open');

    await runRound(host, [alice, bob], ['3', '5', '8'], 1, testInfo);
    await hostPage.getByRole('button', { name: 'Vote again' }).click();
    for (const participant of [host, alice, bob]) {
      await expect(participant.page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();
      for (const name of [host.name, alice.name, bob.name]) {
        await expect(seat(participant.page, name)).toHaveAttribute('data-voted', 'false');
      }
    }

    await runRound(host, [alice, bob], ['5', '8', '13'], 2, testInfo);
    await hostPage.getByRole('button', { name: 'Vote again' }).click();
    await runRound(host, [alice, bob], ['1', '2', '3'], 3, testInfo);

    await expectActionSize(alice.page, 'Update vote');
    await expectActionSize(bob.page, 'Update vote');
    await expectCleanBrowser(hostSignals, testInfo);
    await expectCleanBrowser(aliceSignals, testInfo);
    await expectCleanBrowser(bobSignals, testInfo);

    await alice.context.close();
    await bob.context.close();
    await host.context.close();
  });

  test('host survives an accidental refresh without losing control', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Run resilience once.');
    await createRoom(page, 'Refresh Host');
    await page.reload();
    await expect(page.getByText('Connected')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Execute Reveal' })).toBeVisible();
    await attachScreenshot(page, testInfo, 'host-after-refresh');
  });

  test('voter survives an accidental refresh without creating a duplicate seat', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Run resilience once.');
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const slug = await createRoom(hostPage, 'Refresh Test Host');
    const voter = await joinRoom(browser, slug, 'Refresh Voter', devices['iPhone 13']);
    await castVote(voter.page, '5');
    await voter.page.reload();
    await expect(voter.page.getByText('Connected')).toBeVisible();
    await expect(voter.page.getByRole('button', { name: 'Update vote' })).toBeVisible();
    await expect(hostPage.locator('aside[aria-label="Team roster"]')).toContainText('Voters · 2');
    await attachScreenshot(voter.page, testInfo, 'voter-after-refresh');
    await voter.context.close();
    await hostContext.close();
  });
});

test.describe('production security posture', () => {
  test('security headers, CORS, retired routes, and sitemap are hardened', async ({ request, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Run security probes once.');

    const homepage = await request.get('/');
    expect(homepage.status()).toBe(200);
    const headers = homepage.headers();
    const requiredHeaders = {
      'strict-transport-security': headers['strict-transport-security'],
      'content-security-policy': headers['content-security-policy'],
      'x-content-type-options': headers['x-content-type-options'],
      'referrer-policy': headers['referrer-policy'],
      'permissions-policy': headers['permissions-policy'],
      'frame-protection': headers['x-frame-options'] ?? (headers['content-security-policy']?.includes('frame-ancestors') ? 'CSP frame-ancestors' : undefined),
    };
    await testInfo.attach('security-headers.json', {
      body: Buffer.from(JSON.stringify({ headers, requiredHeaders }, null, 2)),
      contentType: 'application/json',
    });
    for (const [name, value] of Object.entries(requiredHeaders)) {
      expect.soft(value, `missing recommended ${name} response header`).toBeTruthy();
    }
    expect.soft(headers['x-content-type-options']?.toLowerCase()).toBe('nosniff');

    const hostileOrigin = 'https://attacker.invalid';
    const health = await request.get('/api/health', { headers: { Origin: hostileOrigin } });
    expect(health.status()).toBe(200);
    expect.soft(health.headers()['access-control-allow-origin']).not.toBe('*');
    expect.soft(health.headers()['access-control-allow-origin']).not.toBe(hostileOrigin);

    const preflight = await request.fetch('/api/rooms', {
      method: 'OPTIONS',
      headers: {
        Origin: hostileOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect.soft(preflight.headers()['access-control-allow-origin']).not.toBe('*');
    expect.soft(preflight.headers()['access-control-allow-origin']).not.toBe(hostileOrigin);

    const retiredApi = await request.get('/api/retros/qa-probe-999999999');
    expect(retiredApi.status()).toBe(404);

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).not.toContain('/retro');

    await page.goto('/retro');
    await expect(page.getByText(/retrospective|start · stop · continue/i)).toHaveCount(0);
    await attachScreenshot(page, testInfo, 'retired-retro-route');
  });

  test('participant names are rendered as inert text rather than executable markup', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Run XSS probe once.');
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const slug = await createRoom(hostPage, 'Security Host');
    const payload = '<img src=x onerror=window.__pointeXss=1>';
    const attacker = await joinRoom(browser, slug, payload, devices['Pixel 7']);

    await expect(hostPage.getByText(payload, { exact: true })).toBeVisible();
    const executed = await hostPage.evaluate(() => Boolean((window as typeof window & { __pointeXss?: number }).__pointeXss));
    expect(executed).toBe(false);
    expect(await hostPage.locator('img[src="x"]').count()).toBe(0);
    await attachScreenshot(hostPage, testInfo, 'xss-name-probe');

    await attacker.context.close();
    await hostContext.close();
  });
});
