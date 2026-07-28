import { test, expect, type Page } from '@playwright/test';
import {
  castVote,
  createHostRoom,
  joinAsVoter,
} from './helpers/multi-context';

type WalkStop = {
  key: string;
  isInteractive: boolean;
  hasIndicator: boolean;
};

async function walkTabs(page: Page, steps: number): Promise<WalkStop[]> {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const stops: WalkStop[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element) return { key: 'null', isInteractive: false, hasIndicator: false };
      const tag = element.tagName.toLowerCase();
      let name = element.getAttribute('aria-label') ?? '';
      if (!name && 'labels' in element) {
        const labels = (element as HTMLInputElement).labels;
        if (labels?.length) name = labels[0].textContent ?? '';
      }
      if (!name) name = element.textContent ?? '';
      const style = getComputedStyle(element);
      const hasOutline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      const hasShadow = style.boxShadow !== 'none' && style.boxShadow.length > 0;
      return {
        key: `${tag}|${element.getAttribute('role') ?? ''}|${name.trim().slice(0, 50)}`,
        isInteractive: tag !== 'body',
        hasIndicator: hasOutline || hasShadow,
      };
    }));
  }
  return stops;
}

function assertWalkClean(stops: WalkStop[]): void {
  const interactive = stops.filter((stop) => stop.isInteractive);
  expect(interactive.length).toBeGreaterThan(0);
  expect(interactive.filter((stop) => !stop.hasIndicator).map((stop) => stop.key)).toEqual([]);

  let previous = '';
  let repeated = 0;
  for (const stop of stops) {
    if (stop.key === previous) repeated += 1;
    else { previous = stop.key; repeated = 0; }
    expect(repeated).toBeLessThanOrEqual(3);
  }
}

test.describe('live planning poker keyboard operation', () => {
  test('join form is reachable and Enter joins the room', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/${host.slug}`);
    await page.getByLabel('Your name').waitFor();

    assertWalkClean(await walkTabs(page, 12));
    await page.getByLabel('Your name').fill('Alice');
    await page.getByLabel('Your name').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Connected')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();

    await context.close();
    await host.context.close();
  });

  test('card hand supports keyboard selection and vote submission', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });

    assertWalkClean(await walkTabs(alice.page, 18));
    const card = alice.page.getByRole('radio', { name: '5', exact: true });
    await card.focus();
    await alice.page.keyboard.press('Space');
    await expect(card).toHaveAttribute('aria-checked', 'true');
    const cast = alice.page.getByRole('button', { name: 'Cast estimate' });
    await cast.focus();
    await alice.page.keyboard.press('Enter');
    await expect(alice.page.getByRole('button', { name: 'Update vote' })).toBeVisible();

    await alice.context.close();
    await host.context.close();
  });

  test('facilitator can reveal and focus moves to Close vote', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await castVote(alice.page, '5');

    const reveal = host.page.getByRole('button', { name: 'Execute Reveal' });
    await reveal.focus();
    await host.page.keyboard.press('Enter');
    const close = host.page.getByRole('button', { name: 'Vote again' });
    await expect(close).toBeVisible();
    await expect(close).toBeFocused();
    assertWalkClean(await walkTabs(host.page, 16));

    await alice.context.close();
    await host.context.close();
  });

  test('Close vote resets the cards and starts a fresh keyboard-operable round', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await castVote(alice.page, '8');
    await host.page.getByRole('button', { name: 'Execute Reveal' }).click();

    const close = host.page.getByRole('button', { name: 'Vote again' });
    await close.focus();
    await host.page.keyboard.press('Enter');
    await expect(host.page.getByRole('button', { name: 'Execute Reveal' })).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();
    const freshCard = alice.page.getByRole('radio', { name: '3', exact: true });
    await freshCard.focus();
    await expect(freshCard).toBeFocused();

    await alice.context.close();
    await host.context.close();
  });
});
