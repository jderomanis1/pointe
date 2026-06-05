/**
 * S10 a11y-keyboard — the locked subset of the v1 keyboard gate.
 *
 * Pairs with axe-driven `a11y.spec.ts`. axe verifies STRUCTURAL a11y
 * (accessible names, roles, contrast, ARIA correctness). This file
 * verifies KEYBOARD OPERATION on the same five key screens:
 *   • reachability of the primary action(s) via Tab,
 *   • no hard keyboard trap (Tab past the last expected stop and focus
 *     keeps moving — body/wrap is fine; pinned to one element is not),
 *   • activation: Enter (and Space for `role="radio"` buttons) on the
 *     primary triggers the observable DOM effect,
 *   • a focus indicator IS APPLIED to interactive elements (via
 *     box-shadow ring or computed outline).
 *
 * **Honesty contract — what this file PROVES and what it does NOT.**
 * The indicator check confirms a focus style is APPLIED (catches the
 * classic regression: a future `outline:none` with no ring replacement).
 * It does NOT prove the ring is VISIBLE — that depends on the ring
 * color against the underlying surface (accent-on-accent is the
 * documented hot spot). Visible-and-sufficient-contrast is the manual
 * checklist's job. Do not report a green run here as "focus is
 * visible"; report it as "a focus style is present."
 *
 * Determinism contract: every wait is on observable DOM state.
 * No `waitForTimeout` / wall-clock. Uses the same multi-context helpers
 * as the rest of the E2E suite.
 *
 * Out of scope (v1.5): AAA, ARIA-landmark polish, screen-reader nuance,
 * arrow-key navigation inside radiogroups, focus-on-transition (where
 * focus lands after `REVEAL` / async-close→review — a design call held
 * separately).
 */
import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import {
  addStory,
  castAsyncVote,
  castVote,
  createHostRoom,
  joinAsVoter,
  openAsyncWindow,
  openVotingFirstStory,
} from './helpers/multi-context';

const E2E_TOKEN = 'dev-e2e-token';
const TRAP_PROBE_TABS = 12;

type WalkStop = {
  key: string;
  isInteractive: boolean;
  hasIndicator: boolean;
};

/**
 * Tab N times starting from `<body>`, recording per-step:
 *   • the active-element identity (tag|role|name|slot),
 *   • whether the stop is interactive (anything other than `<body>`),
 *   • whether a focus indicator is APPLIED — computed outline OR a
 *     non-`none` box-shadow (Tailwind's `ring-*` is shadow-based).
 *
 * Indicator probing happens INSIDE the keyboard-driven walk so Chromium's
 * `:focus-visible` heuristic fires — synthetic `.focus()` outside of a
 * keyboard sequence does NOT trigger `:focus-visible` reliably, which
 * would produce false-negative indicator readings.
 */
async function walkTabs(page: Page, steps: number): Promise<WalkStop[]> {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const stops: WalkStop[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { key: 'null', isInteractive: false, hasIndicator: false };
      const tag = el.tagName.toLowerCase();
      // Accessible name preference: aria-label → linked <label> →
      // textContent. Inputs typically lack textContent; the linked
      // <label> is what the user perceives as the field's name.
      let name = el.getAttribute('aria-label') ?? '';
      if (!name && 'labels' in el) {
        const labels = (el as HTMLInputElement).labels;
        if (labels && labels.length > 0) name = labels[0].textContent ?? '';
      }
      if (!name) name = el.textContent ?? '';
      name = name.trim().slice(0, 40);
      const role = el.getAttribute('role') ?? '';
      const id = el.id ?? '';
      const slot = el.getAttribute('data-slot') ?? el.getAttribute('data-testid') ?? id;
      const isInteractive = tag !== 'body';
      const cs = getComputedStyle(el);
      const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const hasShadow = cs.boxShadow !== 'none' && cs.boxShadow.length > 0;
      return { key: `${tag}|${role}|${name}|${slot}`, isInteractive, hasIndicator: hasOutline || hasShadow };
    });
    stops.push(stop);
  }
  return stops;
}

/**
 * Standard assertion set for a tab walk:
 *   • at least one interactive stop reached (sanity — no DOM-empty page),
 *   • no hard trap (no single key returned >3 times consecutively),
 *   • every interactive stop has SOME focus indicator applied.
 */
function assertWalkClean(stops: WalkStop[]): void {
  const interactive = stops.filter((s) => s.isInteractive);
  expect(interactive.length, 'at least one interactive stop reachable via Tab').toBeGreaterThan(0);

  // Hard trap detector — same key returned >3 times in a row.
  let lastKey = '';
  let run = 0;
  for (const s of stops) {
    if (s.key === lastKey) run += 1;
    else { run = 0; lastKey = s.key; }
    if (run > 3) {
      throw new Error(`Hard trap: focus pinned on "${s.key}" for ${run + 1} consecutive Tabs`);
    }
  }

  // Every interactive stop must carry a focus indicator. Names the
  // offender if a future change removes a ring without replacement.
  const noIndicator = interactive.filter((s) => !s.hasIndicator);
  expect(
    noIndicator.map((s) => s.key),
    'every interactive stop should carry a focus indicator (outline or ring)',
  ).toEqual([]);
}

test.describe('S10 a11y-keyboard — locked', () => {
  /**
   * JOIN — Tab reaches name input → role radio (group, single tab stop;
   * Spectator is arrow-key navigation per native HTML radio semantics) →
   * Join button. Enter on the submit button completes the join.
   */
  test('join — primary reachable, no trap, indicator present, Enter activates', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/${host.slug}`);
    await page.getByLabel('Your name').waitFor();

    // Reachability + no-trap + per-stop indicator presence.
    const stops = await walkTabs(page, TRAP_PROBE_TABS);
    assertWalkClean(stops);
    // The Join button is among the stops (named in the screen).
    expect(
      stops.some((s) => /\bJoin\b/.test(s.key) && s.isInteractive),
      'Join button reached during Tab walk',
    ).toBe(true);

    // Activation: fill the name, Tab through to Join (name → role radio
    // single stop → Join), press Enter — connection lands.
    await page.getByLabel('Your name').fill('Helen');
    await page.getByLabel('Your name').focus();
    await page.keyboard.press('Tab'); // → role radiogroup (single stop)
    await page.keyboard.press('Tab'); // → Join button
    await page.keyboard.press('Enter');
    await expect(page.getByText('Connected')).toBeVisible();

    await ctx.close();
    await host.context.close();
  });

  /**
   * LOBBY — host view. Add-story input + button is the primary action.
   * The button is disabled-until-text, which is why the bare walk only
   * hits the input; once text exists, Enter on the input submits.
   */
  test('lobby — Story input reachable, no trap, indicator present, Enter submits', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });

    const stops = await walkTabs(host.page, TRAP_PROBE_TABS);
    assertWalkClean(stops);
    expect(
      stops.some((s) => /Story/.test(s.key) && s.isInteractive),
      'Story input reached during Tab walk',
    ).toBe(true);

    // Activation: Enter on the input → form-submit → story added.
    await host.page.getByLabel('Story').fill('Wire OAuth');
    await host.page.getByLabel('Story').focus();
    await host.page.keyboard.press('Enter');
    await expect(host.page.getByText('Wire OAuth').first()).toBeVisible();

    await host.context.close();
  });

  /**
   * VOTING — voter view. Deck cards (`role="radio"`) and the Cast
   * button are the primaries. Space toggles a deck card; Enter on Cast
   * sends VOTE_CAST.
   *
   * Note on the radiogroup pattern: each radio is independently
   * Tab-reachable (current behavior). The ARIA-documented pattern is
   * roving-tabindex + arrow-key navigation; that is a deliberate
   * decision held in `/spec/a11y-keyboard-checklist.md` (Joe's call,
   * not an unambiguous WCAG failure — Tab-each is keyboard-operable).
   */
  test('voting — deck radios reachable, Space selects, Enter on Cast votes', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await addStory(host.page, 'Wire OAuth');
    await openVotingFirstStory(host.page);
    await alice.page.getByRole('button', { name: 'Cast estimate' }).waitFor();

    // Reachability + no-trap + per-stop indicator presence.
    const stops = await walkTabs(alice.page, 16);
    assertWalkClean(stops);
    // At least one deck radio reached.
    expect(
      stops.some((s) => /\|radio\|/.test(s.key) && /\b[1-9]\d?\b/.test(s.key)),
      'at least one deck radio reached during Tab walk',
    ).toBe(true);

    // Activation: focus a deck card, press Space — aria-checked flips.
    // `.focus()` establishes focus for activation (Enter/Space synthesize
    // a click on a focused button regardless of :focus-visible state).
    const deck5 = alice.page.getByRole('radio', { name: '5', exact: true });
    await deck5.focus();
    await alice.page.keyboard.press('Space');
    await expect(deck5).toHaveAttribute('aria-checked', 'true');

    // Activation: Enter on Cast estimate sends the vote.
    await alice.page.getByRole('button', { name: 'Cast estimate' }).focus();
    await alice.page.keyboard.press('Enter');
    await expect(alice.page.getByRole('button', { name: 'Update vote' })).toBeVisible();

    await alice.context.close();
    await host.context.close();
  });

  /**
   * REVEAL — host view. After REVEAL_VOTES the host sees Commit estimate
   * and Vote again. Both are Tab-reachable; Enter on Reveal triggered
   * the transition. The Reveal button itself is the test target.
   *
   * Focus-on-transition (where focus lands after REVEAL) is NOT
   * asserted here — it currently drops to body, which is a design call
   * surfaced for Joe (`/spec/a11y-keyboard-checklist.md`). When that
   * decision lands, this test can grow an `expect(activeTag).toBe(…)`
   * assertion against the chosen target.
   */
  test('reveal — Reveal/Commit reachable, Enter on Reveal transitions, focus lands on Commit', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await addStory(host.page, 'Wire OAuth');
    await openVotingFirstStory(host.page);
    await castVote(alice.page, '5');

    // Pre-reveal: Reveal button is reachable + activates.
    await host.page.getByRole('button', { name: 'Reveal votes' }).focus();
    await host.page.keyboard.press('Enter');
    await expect(host.page.getByRole('button', { name: 'Commit estimate' })).toBeVisible();

    // S10 a11y-keyboard §2 (resolved REVEAL→Commit only, host hot-path):
    // CommitPanel's mount-time `useEffect` moves focus to the Commit
    // estimate primary so the host's next action is already in hand.
    // Median pre-selected from the single vote (5) → button is enabled
    // → focus moves. Wait on the focus rather than asserting immediately
    // because the effect runs after React commits the panel.
    await expect(host.page.getByRole('button', { name: 'Commit estimate' })).toBeFocused();

    // Post-reveal walk: no trap, every interactive stop has an indicator,
    // and Commit estimate is reachable via Tab too (not just on focus-on-
    // transition).
    const stops = await walkTabs(host.page, TRAP_PROBE_TABS);
    assertWalkClean(stops);
    expect(
      stops.some((s) => /Commit estimate/.test(s.key)),
      'Commit estimate reached during Tab walk',
    ).toBe(true);

    await alice.context.close();
    await host.context.close();
  });

  /**
   * S10 a11y-keyboard §3 (resolved A): "What's CERU?" is a disclosure
   * (labelled region), NOT `role="dialog"`. Trigger advertises
   * `aria-expanded`; Enter on trigger toggles; Escape also closes.
   * No focus-trap / no focus-move-into asserted — those are modal
   * behaviours the demote deliberately leaves off.
   *
   * Seeds the AI panel with the dev-only `/api/__test/ai-ready/:slug`
   * route (same path the anti-anchoring spec uses) — dev/CI lack
   * ANTHROPIC_API_KEY so a real REQUEST_AI would resolve `failed`.
   */
  test('reveal — "What\'s CERU?" disclosure: trigger toggles, Escape closes', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await addStory(host.page, 'Wire OAuth');
    await openVotingFirstStory(host.page);

    const apiCtx = await pwRequest.newContext({ baseURL: host.page.url() });
    const aiRes = await apiCtx.post(`/api/__test/ai-ready/${host.slug}`, {
      headers: { 'x-pointe-e2e-token': E2E_TOKEN },
    });
    expect(aiRes.status()).toBe(200);
    await apiCtx.dispose();

    // Positive anchor: the host AI panel mounted (its <section>
    // carries aria-label="AI suggestion").
    await expect(host.page.locator('section[aria-label="AI suggestion"]')).toBeVisible();

    const trigger = host.page.getByRole('button', { name: /What.?s CERU/i });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Trigger Enter → aria-expanded=true, region is in the DOM.
    await trigger.focus();
    await host.page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(host.page.getByRole('region', { name: /What.?s CERU/i })).toBeVisible();

    // Trigger Enter again → aria-expanded=false (disclosure toggle).
    await trigger.focus();
    await host.page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(host.page.getByRole('region', { name: /What.?s CERU/i })).toHaveCount(0);

    // Re-open, then Escape closes (cheap nice-to-have, NOT a modal trap).
    await trigger.focus();
    await host.page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await host.page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(host.page.getByRole('region', { name: /What.?s CERU/i })).toHaveCount(0);

    await alice.context.close();
    await host.context.close();
  });

  /**
   * ASYNC-REVIEW — host view post async-close. The Discuss live primary
   * (no-estimate path: the seeded story had no votes, so the all-`?` /
   * no-estimate rule from S10.v.c2 routes it through Discuss live).
   * Accept-all + expandable agreed strip are exercised by the broader
   * S10.iii async-walk; here we lock the primary kbd path on this
   * screen state.
   */
  test('async-review — Discuss live reachable, indicator present, Enter activates', async ({ browser }) => {
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

    const stops = await walkTabs(host.page, TRAP_PROBE_TABS);
    assertWalkClean(stops);
    expect(
      stops.some((s) => /Discuss live|discuss-live/.test(s.key)),
      'Discuss live reached during Tab walk',
    ).toBe(true);

    // Activation: Enter on Discuss live → returns the story to discussion.
    // Observable signal: the review host screen unmounts (lifecycle moves
    // back to `active` for that story).
    await host.page.locator('[data-slot="discuss-live"]').first().focus();
    await host.page.keyboard.press('Enter');
    await expect(host.page.locator('[data-slot="review-host-screen"]')).toHaveCount(0);

    await alice.context.close();
    await host.context.close();
  });

  /**
   * S10 a11y-keyboard coverage add — the agreed-pile / Accept-all
   * keyboard walk. The original async-review test landed on the
   * no-estimate (Discuss live) path because no votes were cast.
   * Covered-by-construction (Accept-all is a real `<button>`) is
   * not the same as asserted; this test runs the actual keyboard
   * path on the agreed-pile data shape.
   *
   * Seed: 1 host + 1 voter, 1 story, voter casts 5 @ confidence 3.
   * After force-close that story is "agreed" (1 vote, no outlier,
   * not low-confidence). Review screen mounts the agreed-strip
   * with Accept-all 1.
   */
  test('async-review — agreed-pile / Accept-all reachable, indicator present, Enter commits', async ({ browser }) => {
    const host = await createHostRoom(browser, { hostName: 'Helen', mode: 'async' });
    const alice = await joinAsVoter(browser, { slug: host.slug, name: 'Alice' });
    await addStory(host.page, 'Wire OAuth');
    await openAsyncWindow(host.page);

    // Single agreed vote: 5 @ confidence 3 (default). After close this
    // is a 1-vote consensus, no outlier, avgConf 3.0 → agreed pile.
    await castAsyncVote(alice.page, { points: '5', confidence: 3 });
    await expect(alice.page.locator('[data-slot="async-done"]')).toBeVisible();

    const apiCtx = await pwRequest.newContext({ baseURL: host.page.url() });
    const res = await apiCtx.post(`/api/__test/close/${host.slug}`, {
      headers: { 'x-pointe-e2e-token': E2E_TOKEN },
    });
    expect(res.status()).toBe(200);
    await apiCtx.dispose();

    // Positive anchor: agreed strip mounts with Accept-all 1.
    const acceptAll = host.page.locator('[data-slot="accept-all"]');
    await expect(acceptAll).toContainText('Accept all 1');

    // Tab walk: no trap, indicator on every interactive stop, and the
    // Accept-all primary is reachable.
    const stops = await walkTabs(host.page, TRAP_PROBE_TABS);
    assertWalkClean(stops);
    expect(
      stops.some((s) => /Accept all|accept-all/.test(s.key)),
      'Accept-all reached during Tab walk',
    ).toBe(true);

    // Activation: focus Accept-all, press Enter — agreed strip
    // dismounts (the server commits the agreed story; the strip is
    // re-rendered with no agreed stories left, so the slot vanishes).
    await acceptAll.focus();
    await host.page.keyboard.press('Enter');
    await expect(host.page.locator('[data-slot="agreed-strip"]')).toHaveCount(0);

    await alice.context.close();
    await host.context.close();
  });
});
