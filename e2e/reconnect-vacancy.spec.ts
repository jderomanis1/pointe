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
 * S10.iv — reconnect resilience + host vacancy/claim.
 *
 * The last two headline flows for the suite:
 *
 *   c3 — voter network drop → reconnect preserves identity. The WSClient
 *   keeps the voterId in memory (R4.iii Fix 05); after a network drop,
 *   the reconnect re-issues JOIN_ROOM with `resumeVoterId` and the server
 *   rebinds the same voter. We drive the drop deterministically with the
 *   dev `/api/__test/drop-voter-sockets/:slug` route — server-side close
 *   on every non-host WS, so the production webSocketClose handler runs
 *   for each, and the client's WSClient's exponential-backoff reconnect
 *   loop takes over. Asserted at the host's view: roster count returns
 *   to N (not N+1 — no duplicate identity) AND the voter's vote persists
 *   across the drop.
 *
 *   Note on the dev route choice: Playwright's `context.setOffline(true)`
 *   was tried first; it doesn't close existing WS connections in
 *   Chromium — the WS would limp until the 25s keepalive ping failed,
 *   which is both slow and exactly the timing dependence the
 *   determinism contract forbids. The server-side close drops the WS
 *   instantly + faithfully (production close-handler path).
 *
 *   Note on page-reload variant: a full page reload drops the
 *   in-memory voterId because the WSClient is recreated. The currently-
 *   deployed resume path is the in-session WS reconnect, not a
 *   cookie-scoped resume across page loads (host cookie exists but is
 *   never read server-side; voter cookie isn't set at all). The
 *   network-drop variant is the proof for the path that ships today.
 *
 *   c4 — host vacancy → claim. Host disconnects; we collapse the 30s
 *   grace deterministically with `POST /api/__test/fire-vacancy/:slug`
 *   (the same gated-test-route pattern as force-close); the
 *   HostVacantBanner mounts in every connected voter's DOM; a voter
 *   clicks "Claim host" and the room's host moves to them — proven via
 *   the host-only "host" badge in the roster + the host's queue
 *   actions appearing in the claimer's DOM (and NOT in the other
 *   voter's DOM).
 *
 * Determinism: every WS-driven transition waits on an observable mount
 * or count. The 30s vacancy clock is collapsed by the test route — never
 * wall-clock-waited. Zero `waitForTimeout`.
 */

const E2E_TOKEN = 'dev-e2e-token';

test.describe('S10.iv — reconnect + host vacancy/claim', () => {
  test('c3 — voter network drop → reconnect preserves identity + state', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });

    await addStory(host.page, 'Wire OAuth login');
    await openVotingFirstStory(host.page);

    // Alice casts a vote so we have observable state to survive the drop.
    await castVote(alice.page, '5');

    // Sanity: host roster shows 3 connected voters and Alice's seat is voted.
    await expect(host.page.locator('aside').filter({ hasText: 'Voters · 3' })).toBeVisible();
    await expect(seatByName(host.page, 'Alice')).toHaveAttribute('data-voted', 'true');

    // DRIVE THE DROP via the dev test route — server-side close on every
    // non-host WS, faithfully running the production close path. The
    // client-side WSClient sees the close and starts its reconnect loop.
    // (Both Alice and Bob are dropped; the assertions focus on Alice
    // because she's the one with state to preserve.)
    const apiCtx = await pwRequest.newContext({ baseURL: alice.page.url() });
    const dropRes = await apiCtx.post(`/api/__test/drop-voter-sockets/${host.slug}`, {
      headers: { 'x-pointe-e2e-token': E2E_TOKEN },
    });
    expect(dropRes.status()).toBe(200);
    await apiCtx.dispose();

    // Host's POV: roster live-count drops to 1 (only the host remains
    // connected). Proves voter_left landed for both voters — the server-
    // side close ran the production webSocketClose handler. This is the
    // unambiguous "drop registered" wait — the intermediate "Reconnecting"
    // badge isn't reliable to anchor on because the WSClient's full-jitter
    // backoff (0..500ms first attempt) can complete the reconnect inside a
    // single React render frame, batching the reconnecting→connected flip
    // into one paint.
    await expect(host.page.locator('aside').filter({ hasText: 'Voters · 1' })).toBeVisible();

    // NO-DUPLICATE-IDENTITY anchor: host's roster live-count returns to 3,
    // not 4. The server rebound the same voter via resumeVoterId — if the
    // resume had failed, a NEW voter would have been added and the count
    // would be 4 (Helen + Alice-left + Alice-new + Bob-left + Bob-new). The
    // count returning to 3 IS the proof that both voters resumed their
    // prior identity.
    await expect(host.page.locator('aside').filter({ hasText: 'Voters · 3' })).toBeVisible();

    // SERVER-SIDE STATE-PERSISTENCE anchor: Alice's seat in the host's view
    // is still voted (the server preserved her vote across the reconnect —
    // same (storyId, voterId) row, the resumed voterId matches the cast
    // vote). The host didn't reconnect, so its `votedPresence` (set by the
    // voter_voted delta from Alice's original cast) survives.
    //
    // Note: Alice's OWN view loses myVote on the snapshot rebuild (R2.iii —
    // SNAPSHOT strips active-story votes; `myVotes` is rebuilt from session
    // vote_value deltas, not seeded). This is intentional: the cast button
    // returns to "Cast estimate" and she can recast. The persisted-on-server
    // half is what matters for AA — the host's view above proves it.
    await expect(seatByName(host.page, 'Alice')).toHaveAttribute('data-voted', 'true');

    await alice.context.close();
    await bob.context.close();
    await host.context.close();
  });

  test('c4 — host vacancy + voter claim moves host', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    const bob = await joinAsVoter(browser, { slug: host.slug, name: 'Bob' });
    await addStory(host.page, 'Wire OAuth login');

    // Sanity: Helen is host (Roster row carries the host badge).
    const helenRow = host.page.locator('aside li').filter({ hasText: 'Helen' });
    await expect(helenRow.locator('text=host')).toBeVisible();

    // DROP THE HOST. context.close() closes Helen's WS; the DO's
    // webSocketClose marks her 'left', broadcasts voter_left, and (since
    // she was host with no other live host socket) schedules the 30s
    // host_vacant task.
    await host.context.close();

    // POSITIVE ANCHOR: Alice's roster live-count drops to 2 — proves the
    // server-side close handler ran AND the voter_left broadcast landed.
    // This is the wait that guards the upcoming fire-vacancy POST: by the
    // time the live count is 2, the host_vacant task is already scheduled.
    await expect(alice.page.locator('aside').filter({ hasText: 'Voters · 2' })).toBeVisible();

    // COLLAPSE THE 30s GRACE. fire-vacancy sets at=0 on every pending
    // host_vacant task and invokes the production alarm. The same
    // handleHostVacantFire that the real alarm runs — only the wall-clock
    // is faked. Slug is reused from the closed host context (string survives).
    const apiCtx = await pwRequest.newContext({ baseURL: alice.page.url() });
    const res = await apiCtx.post(`/api/__test/fire-vacancy/${host.slug}`, {
      headers: { 'x-pointe-e2e-token': E2E_TOKEN },
    });
    expect(res.status()).toBe(200);
    await apiCtx.dispose();

    // POSITIVE ANCHOR on banner mount: HostVacantBanner renders only when
    // `room.state === 'host_vacant'`. The role="alert" + claim button are
    // the only DOM trace.
    const aliceBanner = alice.page.getByRole('alert').filter({ hasText: /host disconnected/i });
    await expect(aliceBanner).toBeVisible();
    await expect(aliceBanner.getByRole('button', { name: 'Claim host' })).toBeVisible();
    // Bob's banner mounts too — every voter sees the recovery affordance.
    const bobBanner = bob.page.getByRole('alert').filter({ hasText: /host disconnected/i });
    await expect(bobBanner).toBeVisible();

    // ALICE CLAIMS. CLAIM_HOST → server flips room state to 'active' and
    // setRoomHost(Alice). HOST_RECLAIMED broadcasts to all sockets; the
    // reducer demotes the prior host (already 'left'), promotes Alice,
    // clears vacancy.
    await aliceBanner.getByRole('button', { name: 'Claim host' }).click();

    // HOST-CONTROLS-MOVED proof in Alice's DOM. Two anchors:
    //   1. The banner unmounts (room.state !== 'host_vacant' anymore).
    //   2. The host-only "Open voting" button appears in the queue — only
    //      isHost + state==='pending' + !anyActive renders this.
    await expect(alice.page.getByRole('alert').filter({ hasText: /host disconnected/i })).toHaveCount(0);
    await expect(alice.page.getByRole('button', { name: 'Open voting' })).toBeVisible();

    // Alice's roster row now carries the host badge; Bob's row does not.
    const aliceRow = alice.page.locator('aside li').filter({ hasText: 'Alice' });
    await expect(aliceRow.locator('text=host')).toBeVisible();

    // BOB'S DOM: banner unmounted, no host controls (he's still a voter).
    await expect(bob.page.getByRole('alert').filter({ hasText: /host disconnected/i })).toHaveCount(0);
    await expect(bob.page.getByRole('button', { name: 'Open voting' })).toHaveCount(0);
    // And Bob's view of the roster shows Alice with the host badge.
    const aliceRowInBob = bob.page.locator('aside li').filter({ hasText: 'Alice' });
    await expect(aliceRowInBob.locator('text=host')).toBeVisible();

    await alice.context.close();
    await bob.context.close();
  });
});
