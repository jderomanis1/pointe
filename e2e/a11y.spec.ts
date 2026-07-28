import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  castVote,
  createHostRoom,
  joinAsVoter,
} from './helpers/multi-context';

const AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectZeroAxeViolations(page: Page, screen: string): Promise<void> {
  const out = await new AxeBuilder({ page }).withTags(AA_TAGS).analyze();
  if (out.violations.length > 0) {
    const summary = out.violations.map(
      (violation) => `  ${violation.id} [${violation.impact}] × ${violation.nodes.length} — ${violation.help}\n    e.g. ${violation.nodes[0]?.target.join(' ')}`,
    ).join('\n');
    throw new Error(`axe AA violations on [${screen}]:\n${summary}`);
  }
  expect(out.violations).toHaveLength(0);
}

test.describe('live planning poker accessibility', () => {
  test('join screen has zero axe violations', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/${host.slug}`);
    await page.getByLabel('Your name').waitFor();
    await expectZeroAxeViolations(page, 'join');
    await page.getByLabel('Your name').focus();
    await expect(page.getByLabel('Your name')).toBeFocused();
    await context.close();
    await host.context.close();
  });

  test('open voting table has zero axe violations', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await expectZeroAxeViolations(alice.page, 'voting');
    const card = alice.page.getByRole('radio', { name: '5', exact: true });
    await card.focus();
    await expect(card).toBeFocused();
    await alice.context.close();
    await host.context.close();
  });

  test('revealed table and facilitator close action have zero axe violations', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await castVote(alice.page, '5');
    await host.page.getByRole('button', { name: 'Execute Reveal' }).click();
    const close = host.page.getByRole('button', { name: 'Vote again' });
    await close.waitFor();
    await expectZeroAxeViolations(host.page, 'reveal-and-close');
    await close.focus();
    await expect(close).toBeFocused();
    await alice.context.close();
    await host.context.close();
  });

  test('fresh round after close has zero axe violations', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await castVote(alice.page, '8');
    await host.page.getByRole('button', { name: 'Execute Reveal' }).click();
    await host.page.getByRole('button', { name: 'Vote again' }).click();
    await expect(host.page.getByRole('button', { name: 'Execute Reveal' })).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();
    await expectZeroAxeViolations(host.page, 'fresh-round');
    await alice.context.close();
    await host.context.close();
  });
});
