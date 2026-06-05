import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import {
  addStory,
  castAsyncVote,
  createHostRoom,
  joinAsVoter,
  openAsyncWindow,
  seatByName,
} from './helpers/multi-context';

/**
 * S10.iii — the full async close-review walk.
 *
 * The S9 pillar exercised end-to-end in real browsers: host opens an async
 * window, multiple voters drive the focused X+Y view, the window closes
 * (via the force-close test route), the review screen sorts the queue into
 * agreed vs need-discussion with the right shape per card, and the two host
 * actions clear it.
 *
 * Scope discipline: this proves the browser-level walk — the screens
 * transition on real WS deltas, the differentiation renders, and the host
 * actions work end-to-end. It does NOT re-prove the bucketing math, the
 * "whoever shows up" subset median, or the reclaim derivation — those are
 * unit-proven (S9.i/iii) and don't need re-litigating through a browser.
 *
 * Determinism: every WS-driven transition waits on an observable mount or
 * text. No `waitForTimeout`. The close and the re-open are server-pushed;
 * the only honest wait is on the pushed result landing in the DOM.
 *
 * Seeded distribution (fibonacci deck `['1','2','3','5','8','13','21']`):
 *   • split — Alice 5/3, Bob 5/3, Charlie 13/3 → outlier @ position 5 vs
 *     median position 3 → discuss via outlier.
 *   • lowconf — Alice 5/1, Bob 5/1, Charlie 5/2 → avgConf 1.33 < 2.5
 *     → discuss via lowConfidence (false consensus — same values, low conf).
 *   • agreed-A — all 5/3 → median '5', no outlier, avgConf 3.0.
 *   • agreed-B — all 3/3 → median '3', no outlier, avgConf 3.0.
 *
 * Net: 4 stories · 2 agreed · 2 need discussion.
 */

const E2E_TOKEN = 'dev-e2e-token';

type AsyncWalkSetup = {
  host: Awaited<ReturnType<typeof createHostRoom>>;
  alice: Awaited<ReturnType<typeof joinAsVoter>>;
  bob: Awaited<ReturnType<typeof joinAsVoter>>;
  charlie: Awaited<ReturnType<typeof joinAsVoter>>;
  splitText: string;
  lowConfText: string;
  agreedAText: string;
  agreedBText: string;
};

/**
 * Reusable setup: host + 3 voters on an async room, 4 stories seeded,
 * window opened. All 12 votes cast per the seeded distribution. Returns
 * with the room in the open-window state — the caller force-closes.
 *
 * Voters cast in parallel (Promise.all) — independent contexts, no shared
 * mutable state, so the WS round-trips interleave deterministically against
 * the server.
 */
async function setupAsyncWalk(browser: Parameters<typeof createHostRoom>[0]): Promise<AsyncWalkSetup> {
  const host = await createHostRoom(browser, { hostName: 'Helen', mode: 'async' });
  const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
  const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });
  const charlie = await joinAsVoter(browser, { slug: host.slug, name: 'Charlie' });

  const splitText = 'Wire OAuth login';
  const lowConfText = 'Add password reset';
  const agreedAText = 'Set up the staging env';
  const agreedBText = 'Bump pnpm to v10';

  await addStory(host.page, splitText);
  await addStory(host.page, lowConfText);
  await addStory(host.page, agreedAText);
  await addStory(host.page, agreedBText);

  await openAsyncWindow(host.page);

  // Each voter casts all 4 stories. Parallelism: contexts are independent.
  await Promise.all([
    castAllForAlice(alice.page),
    castAllForBob(bob.page),
    castAllForCharlie(charlie.page),
  ]);

  // Positive anchor: each voter reaches "You're all set" (done state).
  // This guarantees all 4 advances completed locally; the dot-committed
  // assertions below prove the server-echoed vote_value landed too.
  await expect(alice.page.locator('[data-slot="async-done"]')).toBeVisible();
  await expect(bob.page.locator('[data-slot="async-done"]')).toBeVisible();
  await expect(charlie.page.locator('[data-slot="async-done"]')).toBeVisible();

  // All 4 progress dots committed (myVotes echoed back) — proves the round-
  // trip on every cast, not just the local advance. Without this anchor the
  // force-close could race the last VOTE_CAST envelope.
  for (const voter of [alice, bob, charlie]) {
    for (let i = 0; i < 4; i++) {
      await expect(voter.page.locator(`[data-dot-index="${i}"][data-committed="true"]`)).toBeVisible();
    }
  }

  return { host, alice, bob, charlie, splitText, lowConfText, agreedAText, agreedBText };
}

async function castAllForAlice(page: Page): Promise<void> {
  // Story 1 (split): 5 @ confidence 3 (default).
  await castAsyncVote(page, { points: '5', confidence: 3 });
  // Story 2 (lowconf): 5 @ confidence 1.
  await castAsyncVote(page, { points: '5', confidence: 1 });
  // Story 3 (agreed-A): 5 @ confidence 3.
  await castAsyncVote(page, { points: '5', confidence: 3 });
  // Story 4 (agreed-B): 3 @ confidence 3.
  await castAsyncVote(page, { points: '3', confidence: 3 });
}

async function castAllForBob(page: Page): Promise<void> {
  await castAsyncVote(page, { points: '5', confidence: 3 });
  await castAsyncVote(page, { points: '5', confidence: 1 });
  await castAsyncVote(page, { points: '5', confidence: 3 });
  await castAsyncVote(page, { points: '3', confidence: 3 });
}

async function castAllForCharlie(page: Page): Promise<void> {
  // Story 1: 13 (the outlier — 13 is 2 deck positions from median '5').
  await castAsyncVote(page, { points: '13', confidence: 3 });
  // Story 2: 5 @ confidence 2 (still pulls avg below 2.5).
  await castAsyncVote(page, { points: '5', confidence: 2 });
  await castAsyncVote(page, { points: '5', confidence: 3 });
  await castAsyncVote(page, { points: '3', confidence: 3 });
}

async function forceClose(hostPage: Page, slug: string): Promise<void> {
  const apiCtx = await pwRequest.newContext({ baseURL: hostPage.url() });
  const res = await apiCtx.post(`/api/__test/close/${slug}`, {
    headers: { 'x-pointe-e2e-token': E2E_TOKEN },
  });
  expect(res.status()).toBe(200);
  await apiCtx.dispose();
}

test.describe('S10.iii — async close-review walk', () => {
  test('c1 — open → vote → force-close → review renders with bucket differentiation', async ({ browser }) => {
    const s = await setupAsyncWalk(browser);

    await forceClose(s.host.page, s.host.slug);

    // POSITIVE ANCHOR: the review screen mounts on the WS-driven
    // votes_revealed × N + async_window_closed batch → room.state = 'review'.
    const reviewScreen = s.host.page.locator('[data-slot="review-host-screen"]');
    await expect(reviewScreen).toBeVisible();

    // Summary distillation. 4 stories: 2 agreed (consensus + confident),
    // 2 need discussion (one outlier, one low-confidence).
    const summary = s.host.page.locator('[data-slot="review-summary"]');
    await expect(summary).toContainText(/4\s*stor(?:y|ies)/);
    await expect(summary).toContainText(/2\s*agreed/);
    await expect(summary).toContainText(/2\s*need discussion/);

    // Discuss list has exactly 2 cards.
    const discussCards = s.host.page.locator('[data-slot="discuss-card"]');
    await expect(discussCards).toHaveCount(2);

    // The visual heart of the pillar: the split-vote card and the
    // low-confidence card render DIFFERENT shapes. Pick each by the
    // story text (the title slugs are stable), then read off the
    // data-attrs the S9.iii frontend already exposes.
    const splitCard = discussCards.filter({ hasText: s.splitText });
    const lowConfCard = discussCards.filter({ hasText: s.lowConfText });

    // Split: outlier=true, low-confidence=false. Shows the vote spread,
    // no confidence band.
    await expect(splitCard).toHaveAttribute('data-has-outlier', 'true');
    await expect(splitCard).toHaveAttribute('data-low-confidence', 'false');
    await expect(splitCard.locator('[data-slot="vote-spread"]')).toBeVisible();
    await expect(splitCard.locator('[data-slot="confidence-band"]')).toHaveCount(0);
    // The outlier face is flagged warning.
    await expect(splitCard.locator('[data-vote-outlier="true"]')).toHaveCount(1);
    await expect(splitCard.locator('[data-slot="chip-split"]')).toBeVisible();

    // Low-confidence: outlier=false, low-confidence=true. Shows the
    // confidence band/meter, no vote spread.
    await expect(lowConfCard).toHaveAttribute('data-has-outlier', 'false');
    await expect(lowConfCard).toHaveAttribute('data-low-confidence', 'true');
    await expect(lowConfCard.locator('[data-slot="confidence-band"]')).toBeVisible();
    await expect(lowConfCard.locator('[data-slot="vote-spread"]')).toHaveCount(0);
    await expect(lowConfCard.locator('[data-slot="chip-low-confidence"]')).toBeVisible();

    // The agreed strip carries the count + Accept-all primary.
    await expect(s.host.page.locator('[data-slot="agreed-strip"]')).toBeVisible();
    await expect(s.host.page.locator('[data-slot="accept-all"]')).toContainText('Accept all 2');

    // Voter view (Alice): the read-only review screen renders too, with
    // the same agreed/discuss split. Confirms the review broadcast lands
    // on voter sockets and the projection is consistent.
    await expect(s.alice.page.locator('[data-slot="review-voter-screen"]')).toBeVisible();
    await expect(s.alice.page.locator('[data-slot="review-summary"]')).toContainText(/2\s*agreed/);

    await s.alice.context.close();
    await s.bob.context.close();
    await s.charlie.context.close();
    await s.host.context.close();
  });

  test('c2 — Accept-agreed commits the agreed pile, discuss list stays', async ({ browser }) => {
    const s = await setupAsyncWalk(browser);
    await forceClose(s.host.page, s.host.slug);
    await expect(s.host.page.locator('[data-slot="review-host-screen"]')).toBeVisible();

    // Sanity: 2 agreed pre-click.
    await expect(s.host.page.locator('[data-slot="accept-all"]')).toContainText('Accept all 2');

    // Fire ACCEPT_AGREED. Server batch-commits every revealed-non-flagged
    // story; broadcast carries N story_committed changes. Each agreed
    // story transitions revealed → committed and drops out of the bucket
    // derivation in ReviewHostScreen.
    await s.host.page.locator('[data-slot="accept-all"]').click();

    // POSITIVE ANCHOR: the agreed strip unmounts entirely (count is 0,
    // AgreedStrip returns null when `expandable === 0`).
    await expect(s.host.page.locator('[data-slot="agreed-strip"]')).toHaveCount(0);

    // The summary now reads "2 stories · 0 agreed · 2 need discussion".
    const summary = s.host.page.locator('[data-slot="review-summary"]');
    await expect(summary).toContainText(/2\s*stor(?:y|ies)/);
    await expect(summary).toContainText(/0\s*agreed/);
    await expect(summary).toContainText(/2\s*need discussion/);

    // The 2 discuss cards stay put — accept-agreed doesn't touch them.
    await expect(s.host.page.locator('[data-slot="discuss-card"]')).toHaveCount(2);

    // Voter view mirrors the change: voter-agreed-list unmounts, only the
    // need-discussion section remains.
    await expect(s.alice.page.locator('[data-slot="voter-agreed-list"]')).toHaveCount(0);
    await expect(s.alice.page.locator('[data-slot="voter-discuss-list"]')).toBeVisible();

    await s.alice.context.close();
    await s.bob.context.close();
    await s.charlie.context.close();
    await s.host.context.close();
  });

  test('c3 — Discuss live runs a sync re-vote, room review → active → review', async ({ browser }) => {
    const s = await setupAsyncWalk(browser);
    await forceClose(s.host.page, s.host.slug);
    await expect(s.host.page.locator('[data-slot="review-host-screen"]')).toBeVisible();

    // Pick Discuss live → on the split-vote card (the one with the outlier
    // — the natural candidate for a live re-vote).
    const splitCard = s.host.page.locator('[data-slot="discuss-card"]').filter({ hasText: s.splitText });
    await splitCard.locator('[data-slot="discuss-live"]').click();

    // POSITIVE ANCHOR on host: the review screen unmounts and VotingStage
    // takes over with the host's "Reveal votes" affordance. This proves
    // room_state_changed='active' landed AND `asyncWindowOpen` correctly
    // flipped off (the S10.iii reducer + DB fix: asyncWindow cleared at
    // close → discuss-live's active state mounts the SYNC VotingStage,
    // not AsyncHostMonitorView).
    await expect(s.host.page.locator('[data-slot="review-host-screen"]')).toHaveCount(0);
    await expect(s.host.page.getByRole('button', { name: 'Reveal votes' })).toBeVisible();

    // POSITIVE ANCHOR on voters: they drop into the sync active view (the
    // CastPanel's deck cards radio group). Not AsyncVoterView (whose
    // primary advance button is `[data-slot="async-primary"]`).
    await expect(s.alice.page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();
    await expect(s.bob.page.getByRole('button', { name: 'Cast estimate' })).toBeVisible();
    await expect(s.alice.page.locator('[data-slot="async-voter-view"]')).toHaveCount(0);

    // The voters who show up cast fresh votes. This is the "whoever shows
    // up" subset (all 3 are present here — the unit tests cover the
    // subset-of-present-voters median; we just need the live round to run
    // through the UI).
    //
    // Alice + Bob land on 5, Charlie revises to 8 (adjacent — not an
    // outlier this time). With 5/5/8 over the fibonacci deck at positions
    // 3/3/4 the median position is 3 → '5'.
    await castSyncVote(s.alice.page, '5');
    await castSyncVote(s.bob.page, '5');
    await castSyncVote(s.charlie.page, '8');

    // POSITIVE ANCHOR: Charlie's seat flips data-voted=true on the host's
    // view — proves the third VOTE_CAST round-trip landed before reveal.
    await expect(seatByName(s.host.page, 'Charlie')).toHaveAttribute('data-voted', 'true');

    // Host reveals, then commits the agreed median.
    await s.host.page.getByRole('button', { name: 'Reveal votes' }).click();
    await expect(s.host.page.locator('[data-slot="review-host-screen"]')).toHaveCount(0);
    // VotingStage is still mounted (revealed state); the CommitPanel
    // shows up with the "Commit" / suggested-estimate affordance.
    // The committed value flows from the host's pick — '5' (median).
    await s.host.page.getByRole('button', { name: 'Commit estimate' }).click();

    // POSITIVE ANCHOR: room flips active → review again (one discuss
    // story remains — the low-confidence one — so the review screen
    // re-mounts for both host and voters).
    await expect(s.host.page.locator('[data-slot="review-host-screen"]')).toBeVisible();
    await expect(s.alice.page.locator('[data-slot="review-voter-screen"]')).toBeVisible();

    // The split story is gone from the discuss list (committed); the
    // low-conf story remains.
    const remainingDiscuss = s.host.page.locator('[data-slot="discuss-card"]');
    await expect(remainingDiscuss).toHaveCount(1);
    await expect(remainingDiscuss).toContainText(s.lowConfText);

    // Summary line shows the new count: 3 stories left (2 agreed not yet
    // accepted + 1 still-to-discuss). Total reflects revealed-stories
    // only — the committed split story drops out of `rows` entirely.
    await expect(s.host.page.locator('[data-slot="review-summary"]')).toContainText(/3\s*stor(?:y|ies)/);
    await expect(s.host.page.locator('[data-slot="review-summary"]')).toContainText(/2\s*agreed/);
    await expect(s.host.page.locator('[data-slot="review-summary"]')).toContainText(/1\s*need discussion/);

    await s.alice.context.close();
    await s.bob.context.close();
    await s.charlie.context.close();
    await s.host.context.close();
  });
});

/**
 * Sync-mode vote helper, scoped to the discuss-live re-vote: the active
 * VotingStage's CastPanel. Same wait-on-label-flip pattern as the AA
 * vote-hiding spec.
 */
async function castSyncVote(page: Page, value: string): Promise<void> {
  await page.getByRole('radio', { name: value, exact: true }).click();
  await page.getByRole('button', { name: 'Cast estimate' }).click();
  await expect(page.getByRole('button', { name: 'Update vote' })).toBeVisible();
}
