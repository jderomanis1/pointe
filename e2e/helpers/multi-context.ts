import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * S10.ii.c1 — multi-context helpers. Every anti-anchoring flow needs the
 * same shape: one host context that creates a room + N voter contexts that
 * join by slug, each isolated (separate cookie jar = a distinct voter
 * identity over real WS).
 *
 * Determinism contract: every helper here waits on observable DOM state
 * before returning. No `waitForTimeout`. The point of these helpers is to
 * make the spec read like the AA invariants themselves — setup steps return
 * only when the next step is safe to run.
 */

export type RoomMode = 'sync' | 'async';

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

/**
 * Create a room as host. Drives the real CreatePage UI (name + mode +
 * submit), waits for the post-create URL, and blocks until the lobby is
 * ready (AddStory affordance visible). Returns the host page + the slug
 * the server assigned.
 */
export async function createHostRoom(
  browser: Browser,
  opts: { hostName: string; mode?: RoomMode },
): Promise<HostHandle> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Your name').fill(opts.hostName);
  if (opts.mode === 'async') {
    await page.getByRole('radio', { name: /Async window/i }).click();
  }
  await page.getByRole('button', { name: 'Create room' }).click();
  await page.waitForURL(/\/[a-z]+-[a-z]+-\d+$/);
  const slug = new URL(page.url()).pathname.replace(/^\//, '');
  // Lobby is ready when the host's AddStory input has mounted — proves WS
  // is connected (RoomShell only renders past `connection === 'connected'`).
  await expect(page.getByLabel('Story')).toBeVisible();
  return { page, context, slug };
}

/**
 * Join an existing room as a voter (or spectator). Fresh browser context
 * = isolated cookie jar = distinct voter identity on the server. Waits on
 * the RoomShell render before returning — `connection === 'connected'` + a
 * `room` in the store, surfaced as the roster header.
 */
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
  // Wait for the RoomShell — the StatusBadge flips to "Connected" only
  // when the WS handshake + JOIN_ROOM round-trip completed and the store
  // has `room` + `me`.
  await expect(page.getByText('Connected')).toBeVisible();
  return { page, context, name: opts.name };
}

/**
 * Host adds a story. Uses the AddStory form's labelled Input + the
 * "Add story" button. Waits until the story text appears in the
 * StoryQueue — the round-trip `story_added` DELTA has landed.
 */
export async function addStory(hostPage: Page, text: string): Promise<void> {
  await hostPage.getByLabel('Story').fill(text);
  await hostPage.getByRole('button', { name: 'Add story' }).click();
  // Observable: the story shows up in the queue.
  await expect(hostPage.getByText(text).first()).toBeVisible();
}

/**
 * Host opens voting on the queue's first eligible story. Waits on the
 * VotingStage's "Reveal votes" button — only mounted once a story is
 * `active` and the host can drive the round.
 */
export async function openVotingFirstStory(hostPage: Page): Promise<void> {
  await hostPage.getByRole('button', { name: 'Open voting' }).first().click();
  await expect(hostPage.getByRole('button', { name: 'Reveal votes' })).toBeVisible();
}

/**
 * Cast a vote as the given context. Picks the deck card by visible value
 * (the VoteCards radio group), then "Cast estimate". Waits on the button
 * label flipping to "Update vote" — proves the local store + VOTE_CAST
 * round-trip completed.
 */
export async function castVote(page: Page, value: string): Promise<void> {
  await page.getByRole('radio', { name: value, exact: true }).click();
  await page.getByRole('button', { name: 'Cast estimate' }).click();
  await expect(page.getByRole('button', { name: 'Update vote' })).toBeVisible();
}

/**
 * Locate a voter's active-mode seat in the given viewer's DOM, by display
 * name. The seat element is `<li data-testid="seat-${voterId}">` — we
 * filter by visible text since the voter id is server-assigned and the
 * caller knows the name. Filtering hits the smallest enclosing element.
 */
export function seatByName(viewer: Page, displayName: string) {
  return viewer.locator('[data-testid^="seat-"]').filter({ hasText: displayName });
}
