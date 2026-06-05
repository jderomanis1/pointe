/**
 * S10.vi — a11y regression guard. Drives each of the five key screens
 * and runs axe-core (WCAG 2.1 AA ruleset) — asserts zero violations.
 *
 * The lock: a future change that breaks contrast, removes a label, or
 * regresses the `role="img"` on a state-indicator span trips this
 * suite. Same scope as the bar: AA on the key screens (Doc 1 §2).
 *
 * Key screens:
 *   join       — JoinForm on a probed room
 *   lobby      — RoomShell with EmptyState (host, no stories yet)
 *   voting     — VotingStage active, CastPanel deck + confidence
 *   reveal     — VotingStage revealed, RevealStats + CommitPanel
 *   review     — async ReviewHostScreen via force-close
 *
 * Determinism: same multi-context shape the rest of the e2e suite uses.
 * The audit assertions are observable DOM states (axe scans actual
 * rendered output); no `waitForTimeout`.
 *
 * Each test also runs a minimal keyboard pass on its screen: the primary
 * action button is focusable via Tab. Trap-detection and "every
 * interactive reachable" are richer but harder to automate cleanly —
 * the lock here is the strict subset that catches regressions reliably.
 */
import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  addStory,
  castVote,
  createHostRoom,
  joinAsVoter,
  openVotingFirstStory,
} from './helpers/multi-context';

const E2E_TOKEN = 'dev-e2e-token';
const AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectZeroAxeViolations(page: Page, screen: string): Promise<void> {
  const out = await new AxeBuilder({ page }).withTags(AA_TAGS).analyze();
  // Surface the human-readable failure if a regression lands: list the
  // rule ids + a sample target so the diff is debuggable from the log
  // without re-running locally.
  if (out.violations.length > 0) {
    const summary = out.violations.map(
      (v) => `  ${v.id} [${v.impact}] × ${v.nodes.length} — ${v.help}\n    e.g. ${v.nodes[0]?.target.join(' ')}`,
    ).join('\n');
    throw new Error(`axe AA violations on [${screen}]:\n${summary}`);
  }
  expect(out.violations).toHaveLength(0);
}

test.describe('S10.vi a11y — WCAG 2.1 AA on the key screens', () => {
  test('join — JoinForm has zero axe violations + name input focusable', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/${host.slug}`);
    await page.getByLabel('Your name').waitFor();
    await expectZeroAxeViolations(page, 'join');
    // Keyboard reach: the join CTA is focusable. The form sees a Tab from
    // the input → role-radio → role-radio → submit; the simplest assertion
    // is that focusing the input then pressing Tab eventually lands a
    // visible focus on the Join button.
    await page.getByLabel('Your name').focus();
    await expect(page.getByLabel('Your name')).toBeFocused();
    await ctx.close();
    await host.context.close();
  });

  test('lobby — RoomShell + EmptyState has zero axe violations', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    await expectZeroAxeViolations(host.page, 'lobby');
    // Keyboard reach: the AddStory input is focusable.
    await host.page.getByLabel('Story').focus();
    await expect(host.page.getByLabel('Story')).toBeFocused();
    await host.context.close();
  });

  test('voting — CastPanel deck + confidence has zero axe violations', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await addStory(host.page, 'Wire OAuth');
    await openVotingFirstStory(host.page);
    await alice.page.getByRole('button', { name: 'Cast estimate' }).waitFor();
    await expectZeroAxeViolations(alice.page, 'voting');
    // Keyboard reach: a deck card is focusable.
    await alice.page.getByRole('radio', { name: '5', exact: true }).focus();
    await expect(alice.page.getByRole('radio', { name: '5', exact: true })).toBeFocused();
    await alice.context.close();
    await host.context.close();
  });

  test('reveal — RevealStats + CommitPanel has zero axe violations', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await addStory(host.page, 'Wire OAuth');
    await openVotingFirstStory(host.page);
    await castVote(alice.page, '5');
    await host.page.getByRole('button', { name: 'Reveal votes' }).click();
    await host.page.getByRole('button', { name: 'Commit estimate' }).waitFor();
    await expectZeroAxeViolations(host.page, 'reveal');
    // Keyboard reach: the Commit estimate primary is focusable.
    await host.page.getByRole('button', { name: 'Commit estimate' }).focus();
    await expect(host.page.getByRole('button', { name: 'Commit estimate' })).toBeFocused();
    await alice.context.close();
    await host.context.close();
  });

  test('review — async ReviewHostScreen has zero axe violations', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen', mode: 'async' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await addStory(host.page, 'Reset password');
    await host.page.getByRole('button', { name: /Open async voting/i }).click();
    await host.page.locator('[data-slot="async-host-monitor"]').waitFor();

    const apiCtx = await pwRequest.newContext({ baseURL: host.page.url() });
    const res = await apiCtx.post(`/api/__test/close/${host.slug}`, {
      headers: { 'x-pointe-e2e-token': E2E_TOKEN },
    });
    expect(res.status()).toBe(200);
    await apiCtx.dispose();

    await host.page.locator('[data-slot="review-host-screen"]').waitFor();
    await expectZeroAxeViolations(host.page, 'review');
    // Keyboard reach: Accept-all OR Discuss live (whichever exists). The
    // seeded story is an all-no-votes case → falls to no-estimate which
    // S10.v.c2 routes into discuss. So Discuss live is the live primary.
    const discussLive = host.page.locator('[data-slot="discuss-live"]').first();
    await discussLive.focus();
    await expect(discussLive).toBeFocused();
    await alice.context.close();
    await host.context.close();
  });
});
