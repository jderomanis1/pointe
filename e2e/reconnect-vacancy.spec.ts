import { test, expect, request as pwRequest } from '@playwright/test';
import {
  castVote,
  createHostRoom,
  joinAsVoter,
  seatByName,
} from './helpers/multi-context';

const E2E_TOKEN = 'dev-e2e-token';
const roster = (page: import('@playwright/test').Page) => page.locator('aside[aria-label="Team roster"]');

test.describe('live room resilience', () => {
  test('voter network drop reconnects with the same identity and vote', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });

    await castVote(alice.page, '5');
    await castVote(bob.page, '8');
    await expect(roster(host.page).filter({ hasText: 'Voters · 3' })).toBeVisible();
    await expect(seatByName(host.page, 'Alice')).toHaveAttribute('data-voted', 'true');
    await expect(seatByName(host.page, 'Bob')).toHaveAttribute('data-voted', 'true');

    const api = await pwRequest.newContext({ baseURL: alice.page.url() });
    const response = await api.post(`/api/__test/drop-voter-sockets/${host.slug}`, {
      headers: { 'x-pointe-e2e-token': E2E_TOKEN },
    });
    expect(response.status()).toBe(200);
    await api.dispose();

    await expect(roster(host.page).filter({ hasText: 'Voters · 1' })).toBeVisible();
    await expect(roster(host.page).filter({ hasText: 'Voters · 3' })).toBeVisible();
    await expect(seatByName(host.page, 'Alice')).toHaveAttribute('data-voted', 'true');
    await expect(alice.page.getByRole('button', { name: 'Update vote' })).toBeVisible();
    await expect(seatByName(alice.page, 'Alice')).toHaveAttribute('data-voted', 'true');
    await expect(alice.page.getByRole('radio', { name: '5', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(alice.page.getByRole('radio', { name: '8', exact: true })).toHaveAttribute('aria-checked', 'false');

    await alice.context.close();
    await bob.context.close();
    await host.context.close();
  });

  test('voter refresh resumes the same identity and retained vote', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });

    await castVote(alice.page, '5');
    await expect(roster(host.page).filter({ hasText: 'Voters · 2' })).toBeVisible();
    await expect(seatByName(host.page, 'Alice')).toHaveAttribute('data-voted', 'true');

    await alice.page.reload();

    await expect(alice.page.getByText('Connected')).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'Update vote' })).toBeVisible();
    await expect(alice.page.getByRole('radio', { name: '5', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(roster(host.page).filter({ hasText: 'Voters · 2' })).toBeVisible();
    await expect(roster(host.page).getByText('Alice')).toHaveCount(1);

    await alice.context.close();
    await host.context.close();
  });

  test('a voter can claim facilitation and receives the live round controls', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });

    const helenRow = roster(host.page).locator('li').filter({ hasText: 'Helen' });
    await expect(helenRow.getByText('host')).toBeVisible();
    await host.context.close();

    await expect(roster(alice.page).filter({ hasText: 'Voters · 2' })).toBeVisible();
    const api = await pwRequest.newContext({ baseURL: alice.page.url() });
    const response = await api.post(`/api/__test/fire-vacancy/${host.slug}`, {
      headers: { 'x-pointe-e2e-token': E2E_TOKEN },
    });
    expect(response.status()).toBe(200);
    await api.dispose();

    const aliceBanner = alice.page.getByRole('alert').filter({ hasText: /host disconnected/i });
    await expect(aliceBanner).toBeVisible();
    await expect(bob.page.getByRole('alert').filter({ hasText: /host disconnected/i })).toBeVisible();
    await aliceBanner.getByRole('button', { name: 'Claim host' }).click();

    await expect(alice.page.getByRole('alert').filter({ hasText: /host disconnected/i })).toHaveCount(0);
    await expect(alice.page.getByRole('button', { name: 'Execute Reveal' })).toBeVisible();
    const aliceRow = roster(alice.page).locator('li').filter({ hasText: 'Alice' });
    await expect(aliceRow.getByText('host')).toBeVisible();

    await expect(bob.page.getByRole('alert').filter({ hasText: /host disconnected/i })).toHaveCount(0);
    await expect(bob.page.getByRole('button', { name: 'Execute Reveal' })).toHaveCount(0);
    const aliceRowInBob = roster(bob.page).locator('li').filter({ hasText: 'Alice' });
    await expect(aliceRowInBob.getByText('host')).toBeVisible();

    await alice.context.close();
    await bob.context.close();
  });
});
