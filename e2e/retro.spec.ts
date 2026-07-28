import { expect, test } from '@playwright/test';

test('retrospective supports private entry, shared review, observers, and closure', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto('/retro');
  await host.getByLabel('Your name').fill('Maya Facilitator');
  await host.getByRole('button', { name: 'Create Retrospective' }).click();
  await host.waitForURL(/\/retro\/[a-z]+-[a-z]+-\d+$/);
  await expect(host.getByRole('heading', { name: 'Think independently.' })).toBeVisible();

  const roomUrl = host.url();
  const participantContext = await browser.newContext();
  const participant = await participantContext.newPage();
  await participant.goto(roomUrl);
  await participant.getByLabel('Your name').fill('Jordan Participant');
  await participant.getByRole('button', { name: 'Join retrospective' }).click();
  await expect(participant.getByText('Participant mode')).toBeVisible();

  await host.getByLabel('Add a Start note').fill('Pair product and engineering before refinement.');
  await host.getByRole('button', { name: 'Add note' }).first().click();
  await expect(host.getByText('Pair product and engineering before refinement.')).toBeVisible();

  await participant.getByLabel('Add a Stop note').fill('Stop accepting stories without testable outcomes.');
  await participant.getByRole('button', { name: 'Add note' }).nth(1).click();
  await expect(participant.getByText('Stop accepting stories without testable outcomes.')).toBeVisible();
  await expect(host.getByText('Stop accepting stories without testable outcomes.')).toHaveCount(0);
  await expect(host.getByText('A teammate added a private entry.')).toBeVisible();

  await host.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(host.getByRole('heading', { name: 'Review the useful themes.' })).toBeVisible();
  await expect(participant.getByText('Stop accepting stories without testable outcomes.')).toBeVisible();
  await expect(host.getByText('Stop accepting stories without testable outcomes.')).toBeVisible();

  await host.getByRole('button', { name: 'Mark discussed' }).nth(1).click();
  await expect(host.getByText('1/2')).toBeVisible();

  const observerContext = await browser.newContext();
  const observer = await observerContext.newPage();
  await observer.goto(roomUrl);
  await observer.getByLabel('Your name').fill('Priya Observer');
  await observer.getByRole('radio', { name: /Observer/i }).click();
  await observer.getByRole('button', { name: 'Join retrospective' }).click();
  await expect(observer.getByText('Observer mode')).toBeVisible();
  await expect(observer.getByRole('button', { name: 'Add note' })).toHaveCount(0);
  await expect(observer.getByText('Stop accepting stories without testable outcomes.')).toBeVisible();

  await host.getByRole('button', { name: 'Close retro' }).click();
  await host.getByRole('button', { name: 'Confirm' }).click();
  await expect(host.getByText('This retrospective is closed and read-only.')).toBeVisible();
  await expect(participant.getByText('This retrospective is closed and read-only.')).toBeVisible();

  await observerContext.close();
  await participantContext.close();
  await hostContext.close();
});
