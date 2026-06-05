import { test, expect, request as pwRequest } from '@playwright/test';
import {
  addStory,
  castVote,
  createHostRoom,
  joinAsVoter,
  openVotingFirstStory,
  seatByName,
} from './helpers/multi-context';

/**
 * S10.ii — anti-anchoring at the DOM layer.
 *
 * The AA invariants have been proven at the protocol layer (S8.v / S9.i.c4).
 * This spec proves them at the rendered DOM — the only place a user
 * actually sees the values. Two invariants, one shared multi-context shape:
 *
 *   AA vote-hiding (pre-reveal): voter A's value is in A's own DOM, but
 *     NOT in voter B's DOM until the host clicks Reveal.
 *
 *   AA-1 AI invisibility: AI suggestion lives in host's DOM only, through
 *     the entire round (active + revealed), and lands in voter DOMs only
 *     after the host clicks "Share with the team".
 *
 * Determinism contract: every wait blocks on observable DOM state. No
 * `waitForTimeout`, no wall-clock. Each test's positive anchor (the
 * value/seat/panel appearing where it should) is the wait condition;
 * the negation (the value/panel absent where it must be) follows that
 * positive anchor — never before it, so the test never races the WS round-trip.
 *
 * Stack: real workerd worker (dev:e2e) + real Vite-served SPA + Playwright.
 * The AI-invisibility test uses the dev-only `POST /api/__test/ai-ready/:slug`
 * route because dev/CI lack ANTHROPIC_API_KEY (a real REQUEST_AI resolves
 * `failed` and can't be SHARE_AI'd). The route bypasses the Anthropic
 * call but re-uses the production storage + DELTA shape, so the AA-1
 * projection + share UI still exercise the real paths.
 */

const E2E_TOKEN = 'dev-e2e-token';

test.describe('multi-context pattern', () => {
  test('two voters join one room over real WS — host roster shows both', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });

    // Roster, sidebar — proves both join_room round-trips landed on the
    // host's WS. The Roster <aside> lists every connected voter row.
    const roster = host.page.locator('aside').filter({ hasText: 'Voters · 3' });
    await expect(roster).toBeVisible();
    await expect(roster.getByText('Helen')).toBeVisible();
    await expect(roster.getByText('Alice')).toBeVisible();
    await expect(roster.getByText('Bob')).toBeVisible();

    await alice.context.close();
    await bob.context.close();
    await host.context.close();
  });
});

test.describe('AA vote-hiding (pre-reveal)', () => {
  test("voter A's value is hidden in voter B's DOM until host reveals", async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });

    await addStory(host.page, 'Reset password');
    await openVotingFirstStory(host.page);

    // Alice casts "5". CastPanel locally updates myVotes; server broadcasts
    // a `vote_value` change to Alice (own caster-only) + a `voted` change
    // to everyone else (presence-only, no value).
    await castVote(alice.page, '5');

    // POSITIVE ANCHOR in Bob's DOM: Alice's seat flips data-voted="true".
    // This is the load-bearing wait — Bob can only assert "no value" after
    // we know the vote reached his WS / store / DOM.
    const aliceSeatInBob = seatByName(bob.page, 'Alice');
    await expect(aliceSeatInBob).toHaveAttribute('data-voted', 'true');

    // NEGATIVE ASSERTION: Alice's value is not in her seat in Bob's view.
    // Scoped to the seat element — Bob's own CastPanel renders "5" as a
    // deck card, so a page-wide grep would false-positive.
    await expect(aliceSeatInBob).not.toContainText('5');

    // Sanity that Alice DOES see her own value (the local-only echo).
    const aliceSeatInAlice = seatByName(alice.page, 'Alice');
    await expect(aliceSeatInAlice).toHaveAttribute('data-voted', 'true');

    // Host reveals. The reveal broadcast lands a `votes_revealed` change
    // with the full votes array → store moves the story to `revealed` and
    // VoterSeats flips to revealed mode (seats now show points).
    await host.page.getByRole('button', { name: 'Reveal votes' }).click();

    // POSITIVE INVERSION in Bob's DOM: Alice's seat is now in revealed
    // mode (the seat element carries data-revealed="true") AND contains
    // the value "5".
    await expect(seatByName(bob.page, 'Alice')).toHaveAttribute('data-revealed', 'true');
    await expect(seatByName(bob.page, 'Alice')).toContainText('5');

    await alice.context.close();
    await bob.context.close();
    await host.context.close();
  });
});

test.describe('AA-1 AI invisibility', () => {
  test("AI lives in host's DOM only; appears in voter DOM only after SHARE_AI", async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });

    await addStory(host.page, 'Reset password');
    await openVotingFirstStory(host.page);

    // Inject a deterministic ready AI suggestion server-side. The dev
    // route hits the DO directly, upserts the ai_suggestion row, and
    // emits the host-only `ai_updated` DELTA — same wire shape as a
    // real REQUEST_AI completion would produce.
    const apiCtx = await pwRequest.newContext({ baseURL: host.page.url() });
    const aiRes = await apiCtx.post(`/api/__test/ai-ready/${host.slug}`, {
      headers: { 'x-pointe-e2e-token': E2E_TOKEN },
    });
    expect(aiRes.status()).toBe(200);

    // POSITIVE ANCHOR on host: the AI suggestion panel mounts. AiSuggestionPanel
    // gives its <section> aria-label="AI suggestion" — wait on that.
    const hostAiPanel = host.page.locator('section[aria-label="AI suggestion"]');
    await expect(hostAiPanel).toBeVisible();
    await expect(hostAiPanel).toContainText('Suggested range');
    await expect(hostAiPanel).toContainText('Stubbed AI rationale for E2E.');

    // Anchor for Alice that "the round is live and she's in lock-step
    // with the host's view" — her CastPanel is rendered (the cast deck
    // radio group). Same WS, same store, fully up-to-date.
    await expect(alice.page.getByRole('radio', { name: '5', exact: true })).toBeVisible();

    // NEGATIVE ASSERTIONS on Alice's DOM (active phase): no AI trace.
    await expect(alice.page.locator('section[aria-label^="AI suggestion"]')).toHaveCount(0);
    await expect(alice.page.locator('[data-slot="ai-ask"]')).toHaveCount(0);
    await expect(alice.page.locator('body')).not.toContainText('Stubbed AI rationale for E2E.');
    await expect(alice.page.locator('body')).not.toContainText('Suggested range');

    // Alice casts a vote so reveal has something to reveal. Not strictly
    // required for AA-1 (the projection holds regardless), but keeps the
    // reveal stage realistic.
    await castVote(alice.page, '5');
    await expect(seatByName(host.page, 'Alice')).toHaveAttribute('data-voted', 'true');

    // Host reveals. AI-still-host-only is the second half of AA-1: the
    // `votes_revealed` change carries `ai` for hosts, stripped for voters.
    await host.page.getByRole('button', { name: 'Reveal votes' }).click();
    await expect(host.page.locator('section[aria-label="AI suggestion"]')).toBeVisible();

    // Wait for Alice's view to enter revealed mode (positive anchor on
    // her side) before the AA-1 negative assertion.
    await expect(seatByName(alice.page, 'Alice')).toHaveAttribute('data-revealed', 'true');

    // NEGATIVE ASSERTIONS on Alice's DOM (revealed phase, pre-share): still
    // no AI trace. This is the AA-1 capstone — `ai` was projected away
    // from her `votes_revealed` change, so the store's story.ai stays
    // undefined and VotingStage renders no panel.
    await expect(alice.page.locator('section[aria-label^="AI suggestion"]')).toHaveCount(0);
    await expect(alice.page.locator('body')).not.toContainText('Stubbed AI rationale for E2E.');

    // Host shares. SHARE_AI flips ai_suggestion.shared = 1 and broadcasts
    // an ai_shared change to all sockets → projector now lets voters
    // see the (full) suggestion via the story.ai store field.
    await host.page.getByRole('button', { name: 'Share with the team' }).click();

    // POSITIVE INVERSION on Alice's DOM: the AI panel mounts with the
    // rationale text the stub injected — proves the AI body arrived
    // intact across the share boundary.
    const aliceAiPanel = alice.page.locator('section[aria-label="AI suggestion"]');
    await expect(aliceAiPanel).toBeVisible();
    await expect(aliceAiPanel).toContainText('Stubbed AI rationale for E2E.');
    await expect(aliceAiPanel).toContainText('Suggested range');
    // The non-host viewer's shared label distinguishes it from the host.
    await expect(aliceAiPanel).toContainText('Shared by the host');

    await alice.context.close();
    await host.context.close();
  });
});
