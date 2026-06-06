/**
 * S11.i — hero asset capture (manual, not a gated test).
 *
 * Drives the real local stack (web on :5173 proxying the worker on :8787)
 * with Playwright to capture pristine, controlled hero screenshots for the
 * launch README. Neutral demo content only — generic story text, neutral
 * voter names (Alice/Bob/Mike/Dana). No real names, no jargon.
 *
 * Captures, light + dark:
 *   - voting state (deck + a selected card + confidence + Ask AI + seats)
 *   - reveal state (median + a surfaced outlier + the confidence readout)
 *
 * Run with the stack up:
 *   pnpm -F @pointe/worker dev:e2e        # :8787
 *   pnpm -F @pointe/web dev               # :5173
 *   node scripts/capture-hero.mjs
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const BASE = process.env.HERO_BASE ?? 'http://localhost:5173';
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, '..', 'docs');

const VIEWPORT = { width: 1280, height: 1040 };
const ctxOpts = { viewport: VIEWPORT, deviceScaleFactor: 2 };

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    localStorage.setItem('pointe:theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

async function shoot(page, name) {
  // Let fonts + the reveal stagger settle before the frame (screenshot only,
  // not an assertion — a short wall-clock settle is acceptable here).
  await page.waitForTimeout(700);
  const file = resolve(DOCS, name);
  await page.screenshot({ path: file, fullPage: true });
  console.log('  wrote', `docs/${name}`);
}

async function castVote(page, value, confidence) {
  await page.getByRole('radio', { name: value, exact: true }).click();
  await page.getByRole('radio', { name: `Confidence ${confidence}` }).click();
  await page.getByRole('button', { name: 'Cast estimate' }).click();
  await page.getByRole('button', { name: 'Update vote' }).waitFor({ state: 'visible' });
}

async function main() {
  const browser = await chromium.launch();

  // ---- host creates a sync room + a small, realistic queue ----------------
  const hostCtx = await browser.newContext(ctxOpts);
  const host = await hostCtx.newPage();
  await host.goto(`${BASE}/`);
  await host.getByLabel('Your name').fill('Alice');
  await host.getByRole('button', { name: 'Create room' }).click();
  await host.waitForURL(/\/[a-z]+-[a-z]+-\d+$/);
  const slug = new URL(host.url()).pathname.replace(/^\//, '');
  await host.getByLabel('Story').waitFor({ state: 'visible' });
  console.log('room', slug);

  const stories = [
    'Create UI specs for dashboard',
    'Add password reset flow',
    'Migrate settings page to the new layout',
  ];
  for (const text of stories) {
    await host.getByLabel('Story').fill(text);
    await host.getByRole('button', { name: 'Add story' }).click();
    await host.getByText(text).first().waitFor({ state: 'visible' });
  }

  await host.getByRole('button', { name: 'Open voting' }).first().click();
  await host.getByRole('button', { name: 'Reveal votes' }).waitFor({ state: 'visible' });

  // ---- three voters join + cast (Dana is the outlier) ---------------------
  const voterSpecs = [
    { name: 'Bob', points: '5', confidence: 4 },
    { name: 'Mike', points: '5', confidence: 3 },
    { name: 'Dana', points: '13', confidence: 2 },
  ];
  const voterPages = [];
  for (const v of voterSpecs) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${slug}`);
    await page.getByLabel('Your name').fill(v.name);
    await page.getByRole('button', { name: 'Join' }).click();
    await page.getByText('Connected').waitFor({ state: 'visible' });
    voterPages.push({ ctx, page, ...v });
  }
  for (const v of voterPages) await castVote(v.page, v.points, v.confidence);

  // Host (also a voter) selects a card + confidence WITHOUT casting — the
  // mid-vote moment: deck live, one card chosen, the cast affordance primed,
  // Ask AI present. Wait on the seats reflecting the 3 cast voters so the
  // roster/presence is settled before the frame.
  await host.getByRole('radio', { name: '5', exact: true }).click();
  await host.getByRole('radio', { name: 'Confidence 4' }).click();
  for (const v of voterPages) {
    await host.locator('[data-testid^="seat-"]').filter({ hasText: v.name }).waitFor({ state: 'visible' });
  }

  console.log('voting state:');
  await setTheme(host, 'light');
  await shoot(host, 'hero-voting-light.png');
  await setTheme(host, 'dark');
  await shoot(host, 'hero-voting-dark.png');

  // ---- host casts, then reveals → the payoff shot -------------------------
  await setTheme(host, 'light');
  await host.getByRole('button', { name: 'Cast estimate' }).click();
  await host.getByRole('button', { name: 'Update vote' }).waitFor({ state: 'visible' });
  await host.getByRole('button', { name: 'Reveal votes' }).click();
  // Observable reveal: the median label + the surfaced outlier are rendered.
  await host.getByText('median', { exact: true }).waitFor({ state: 'visible' });
  await host.getByText('Outliers').waitFor({ state: 'visible' });
  await host.getByText('Dana').first().waitFor({ state: 'visible' });

  console.log('reveal state:');
  await setTheme(host, 'light');
  await shoot(host, 'hero-reveal-light.png');
  await setTheme(host, 'dark');
  await shoot(host, 'hero-reveal-dark.png');

  for (const v of voterPages) await v.ctx.close();
  await hostCtx.close();
  await browser.close();
  console.log('done');
}

main().catch((err) => { console.error(err); process.exit(1); });
