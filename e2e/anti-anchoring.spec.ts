import { test, expect } from '@playwright/test';
import {
  castVote,
  createHostRoom,
  joinAsVoter,
  seatByName,
} from './helpers/multi-context';

test.describe('multi-user live planning poker', () => {
  test('two voters join one room over real WebSockets and appear in the facilitator roster', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });

    const roster = host.page.locator('section[aria-label="Team roster"]').filter({ hasText: 'Voters · 3' });
    await expect(roster).toBeVisible();
    await expect(roster.getByText('Helen')).toBeVisible();
    await expect(roster.getByText('Alice')).toBeVisible();
    await expect(roster.getByText('Bob')).toBeVisible();

    await alice.context.close();
    await bob.context.close();
    await host.context.close();
  });

  test("one voter's value stays hidden from peers until the facilitator reveals", async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });

    await castVote(alice.page, '5');

    const aliceSeatInBob = seatByName(bob.page, 'Alice');
    await expect(aliceSeatInBob).toHaveAttribute('data-voted', 'true');
    await expect(aliceSeatInBob).not.toContainText('5');
    await expect(seatByName(alice.page, 'Alice')).toHaveAttribute('data-voted', 'true');

    await host.page.getByRole('button', { name: 'Execute Reveal' }).click();
    await expect(seatByName(bob.page, 'Alice')).toHaveAttribute('data-revealed', 'true');
    await expect(seatByName(bob.page, 'Alice')).toContainText('5');

    await alice.context.close();
    await bob.context.close();
    await host.context.close();
  });

  test('closing the vote clears prior cards for every participant', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });

    await castVote(alice.page, '5');
    await castVote(bob.page, '8');
    await host.page.getByRole('button', { name: 'Execute Reveal' }).click();
    await host.page.getByRole('button', { name: 'Vote again' }).click();

    await expect(alice.page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();
    await expect(seatByName(host.page, 'Alice')).toHaveAttribute('data-voted', 'false');
    await expect(seatByName(host.page, 'Bob')).toHaveAttribute('data-voted', 'false');

    await alice.context.close();
    await bob.context.close();
    await host.context.close();
  });
});
