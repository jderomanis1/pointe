# Keyboard-a11y manual checklist (5–10 minutes against prod)

**Status:** v1 gate companion to `e2e/keyboard.spec.ts` + `e2e/a11y.spec.ts`. The automated half catches structural a11y (axe) and keyboard *operation* (focusable, no traps, Enter/Space wired). This document is the human-only half — the things only an eye settles.

**When to run:** before a v1 release (and any time the design tokens, focus styles, or Tab order on the five key screens change). Target the deployed site, not the dev stack — the prod paint can drift from local on font-loading and color management.

**Where:** `https://pointe.team` in a Chromium-class browser. Run the whole list TWICE — once in light theme, once in dark (toggle bottom-right). The hot spots are theme-dependent.

**Hard rule of the gate:** ship blockers are anything that fails (1)–(5) below. Anything else is a v1.5 backlog item.

---

## Pre-flight

- [ ] Light theme on (the page-bg `--n-bg` is paper, not dark).
- [ ] A keyboard-only session — no mouse, no trackpad. (A second person can drive the mouse to seed state if needed — host vs voter contexts.)

## (1) Tab order matches visual / reading order

For each screen below, Tab from `<body>` to the page's last interactive element and confirm focus moves in the order the eye expects (left-to-right, top-to-bottom; primary action lands near the end of its group, not buried behind a secondary).

- [ ] **Join** — name input → role radiogroup (Voter selected, arrow to Spectator) → Join.
- [ ] **Lobby (host)** — theme toggle → add-story input → copy-link → (deck mode toggles if visible) → next stories' affordances.
- [ ] **Voting (voter)** — theme toggle → deck cards (1, 2, 3, 5, …) → confidence dots (1 → 5) → Cast estimate.
- [ ] **Reveal (host)** — theme toggle → Split → deck cards (re-vote available) → Commit estimate → Vote again → next-story input.
- [ ] **Async-review (host)** — theme toggle → expandable agreed strip (if any) → per-discuss-card affordances → Accept-all (if shown) → Discuss live.

Flag any "Tab jumped to the corner before doing the central thing" — that's a real failure.

## (2) Focus ring is actually visible — on every interactive element, both themes

The automated spec proves a focus style is **applied**. It cannot prove it is **visible** — that's a contrast judgment against the underlying surface.

For each of the five screens:

- [ ] Tab through every interactive element. The focus ring is unmistakable — you can point at it on first glance.
- [ ] Repeat in **dark theme**. Dark mode regressions are common (rings tuned for paper bg become muddy on charcoal).

### Known hot spots — pay extra attention here

- [ ] **Primary buttons (Join, Add story, Reveal, Commit, Accept-all, Discuss live, Open async).** They use `bg-accent` (oxblood) AND `ring-accent` (oxblood) — same color on same color. **Decision pending** (see §Decisions below): pick the mitigation, then re-run this row.
- [ ] **Selected deck cards in voting.** Selected = `bg-accent-tint` (pink) + `text-accent` (oxblood) + `border-accent`. The ring is oxblood-on-pink-tint — usually visible but worth eyeballing.
- [ ] **Selected mode toggle on create page.** Same shape as selected deck cards.
- [ ] **Theme toggle button.** Small button, dark mode is the failure mode if any.
- [ ] **Cards in async-review.** Tinted backgrounds; verify the ring reads at the card edge.

Any "I can't find the focus right now" → write down which element + theme + screen.

## (3) Focus lands sensibly after a transition

Trigger each transition by **keyboard only** (Enter on the primary that drives it), then immediately note where focus is:

- [ ] **After `Reveal` (host)** — focus should land on the next host action (Commit estimate is the visually-correct target). Currently dumps to `<body>`. **Decision pending.**
- [ ] **After async-close → review (host)** — focus should land on the first actionable element of the review screen (Accept-all if agreed, Discuss live otherwise). Currently dumps to `<body>`. **Decision pending.**
- [ ] **After story change (`Commit estimate` → next story)** — focus should land on the next story's primary input (the host's `Reveal votes`-or-`Open voting` button). Eyeball.

`<body>` is the worst-case landing — every Tab restart costs the user N keys to get back to where they were.

## (4) Overlays — open, escape, return focus

There is currently ONE overlay-like surface: the "What's CERU?" popover in the AI panel on the reveal screen (host only, after AI is requested).

- [ ] Open via keyboard (Tab to "What's CERU?", Enter). Focus moves into the popover (currently it does NOT — focus stays on the trigger). **Decision pending.**
- [ ] Press **Escape**. The popover closes (currently it does NOT — only the close X works). **Decision pending.**
- [ ] After close, focus returns to the trigger button (currently it does because focus never left). Confirm.

If the decision lands as "demote `role="dialog"` to a disclosure region" (Decision §3 below), the Escape requirement goes away — disclosure widgets don't need it.

## (5) No keyboard trap anywhere

By Tabbing through each screen end-to-end without using Shift+Tab or the mouse, the focus should never get stuck on one element. The locked `keyboard.spec.ts` checks this automatically per screen, but if a future commit adds a new overlay or menu the manual pass catches it on first review.

- [ ] **Roster popovers (if any).** None today; check if added.
- [ ] **Split form** (host, in voting). Tab through child inputs → Add another → Cancel → Split — escapable.
- [ ] **Confidence/deck radiogroups.** Tab progresses past the group; Shift+Tab returns. Arrow keys within the group are NOT implemented (Tab-each model) — that is the documented behavior, not a trap. See Decision §4.

---

## Decisions held for Joe (named here, not invented)

These came out of S10 keyboard recon as places where a "fix" requires a design or interaction call — not a mechanical close.

### §1 — Accent-on-accent focus ring on primary `<Button variant="primary">`

`apps/web/src/components/Button.tsx`. Currently `bg-accent` (oxblood) + `focus-visible:ring-2 focus-visible:ring-accent` (oxblood) — the ring is the same color as the button surface, drawn directly on the button edge with no offset. WCAG 2.4.7 (AA): focus visible. Hot spot. Two token-only mitigations:

- **A — Offset ring on the surface behind.** Add `focus-visible:ring-offset-2 focus-visible:ring-offset-bg` to `Button.BASE`. Ring sits 2 px outside the button on the page bg (`--color-bg`), so it's accent-on-bg, visible. Standard Tailwind pattern. Visual: framed button.
- **B — Switch primary's ring color to `--color-accent-ink` (white).** Inverse contrast inside the button edge. No offset. Visual: white halo on oxblood.

Both are token-only — no retoning, no new tokens. Pick the visual.

### §2 — Focus-on-transition targets

After `REVEAL_VOTES`, after async-close→review, after `COMMIT_STORY` → next story: focus currently dumps to `<body>`. Each transition needs a "sensible target" pick:

- After REVEAL: most-likely target is the host's **Commit estimate** (the next host action).
- After async-close→review: depends on the review path — **Accept-all** (agreed) or **Discuss live** (no-estimate).
- After story-change: most-likely target is the host's **Open voting** for the next story, OR the story-queue head row.

Mechanism is the same in each case: a `useEffect` keyed on the lifecycle change that calls `.focus()` on a `ref`-held target. Pick the targets and we wire them in a small follow-up. Once landed, `keyboard.spec.ts` grows an `expect(activeTag).toBe(…)` row per transition (currently it does not assert this; the file header is explicit about that).

### §3 — `CeruPopover` ARIA role

`apps/web/src/components/room/AiSuggestionPanel.tsx`. Has `role="dialog"` + `aria-label="What is CERU?"` but is rendered inline (no overlay, no backdrop, no focus-trap, no Escape, no focus-move on open). The `role="dialog"` sets an expectation the implementation doesn't meet. Two token-only fixes:

- **A — Demote to a disclosure pattern.** Remove `role="dialog"`; render the panel as a `<div role="region" aria-labelledby="ceru-heading">` with the trigger using `aria-expanded` + `aria-controls`. One-line ARIA change. Closest to current behavior; lowers the keyboard expectation rather than meeting it.
- **B — Keep `role="dialog"` and complete the pattern.** Add Escape handler, focus-trap, focus-move-into on open, focus-return on close. Standard non-modal-dialog kit (~30 lines, no new deps).

A is the lower-risk fix; B is the right call if the popover ever grows secondary actions.

### §4 — Confidence picker + Vote deck as `role="radiogroup"` interaction model

`ConfidencePicker.tsx` + `VoteCards.tsx`. Both use `role="radiogroup"` + child `role="radio"` buttons but with **Tab-each** navigation (every dot/card is a Tab stop) rather than the ARIA-documented **roving-tabindex + arrow-keys** pattern. WCAG-conformant either way (Tab-each is keyboard-operable); the deviation is from screen-reader expectations for the radiogroup role.

- **A — Keep Tab-each.** No change. Slightly more Tabs in the voting flow; no screen-reader confusion if a screen reader speaks each radio as a `radio` button individually.
- **B — Switch to roving-tabindex + arrow-key nav.** Standard ARIA pattern. Fewer Tabs through the deck; screen-reader users get "5 of 7" group nav.

Decision is a v1.5 polish if no AT user has complained; v1 ships A by default.

---

## What the automated keyboard spec proves vs. doesn't

| Item | Automated (`keyboard.spec.ts`) | Manual checklist |
|---|---|---|
| Primary action reachable via Tab | ✓ per screen | (cross-check on a smaller surface) |
| No hard trap (focus pins on one element) | ✓ per screen | (cross-check) |
| Focus indicator is APPLIED (outline or ring exists) | ✓ per screen | — |
| Focus indicator is **VISIBLE** (sufficient contrast vs. surface) | ✗ — visibility judgment | ✓ §(2), both themes |
| Enter / Space on primary triggers the effect | ✓ per screen | (cross-check) |
| Focus lands on a sensible target after a transition | ✗ — design call | ✓ §(3) |
| Overlay: focus-move / Escape / focus-return | ✗ — decision pending | ✓ §(4) |
| Tab order matches visual order | partial (we know the order; not "matches visual") | ✓ §(1) |

---

## Sign-off

Run the checklist? Paste this stub in the release-vehicle PR:

```
## Keyboard a11y manual checklist — vN release
- Light theme: PASS / FAIL (notes if any)
- Dark theme: PASS / FAIL (notes if any)
- Hot spots flagged: <none | screen + element>
- Decisions still pending: §1 / §2 / §3 / §4
- Run by: <name>, <date>
```

Decisions §1–§4 close out as small follow-up PRs whenever the design call lands. The locked `keyboard.spec.ts` carries forward the structural baseline so the manual pass shrinks to "did the visible-ring work hold up?" once the rings are locked.
