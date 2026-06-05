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

- [ ] **Primary buttons (Join, Add story, Reveal, Commit, Accept-all, Discuss live, Open async).** §1 RESOLVED → A: `focus-visible:ring-offset-2 focus-visible:ring-offset-bg` on `Button.BASE`. Verify the **offset ring is visible** on the primary buttons in BOTH themes (a 2 px page-bg gap separates the accent ring from the accent fill). If light theme reads but dark theme is muddy, that's a decision to revisit, not a v1.5 deferral.
- [ ] **Selected deck cards in voting.** Selected = `bg-accent-tint` (pink) + `text-accent` (oxblood) + `border-accent`. The ring is oxblood-on-pink-tint — usually visible but worth eyeballing.
- [ ] **Selected mode toggle on create page.** Same shape as selected deck cards.
- [ ] **Theme toggle button.** Small button, dark mode is the failure mode if any.
- [ ] **Cards in async-review.** Tinted backgrounds; verify the ring reads at the card edge.

Any "I can't find the focus right now" → write down which element + theme + screen.

## (3) Focus lands sensibly after a transition

Trigger each transition by **keyboard only** (Enter on the primary that drives it), then immediately note where focus is:

- [ ] **After `Reveal` (host)** — §2 RESOLVED → focus lands on **Commit estimate**. Mechanism: `CommitPanel` mount-time `useEffect` keyed on `story.id`. Verify here that the visible focus ring lands on Commit estimate immediately after Reveal. Locked in `keyboard.spec.ts` via `expect(getByRole('button', { name: 'Commit estimate' })).toBeFocused()`.
- [ ] **After async-close → review (host)** — DEFERRED v1.5. Focus drops to `<body>` today; target depends on which review path (Accept-all if agreed, Discuss live otherwise) and that branching is the v1.5 piece. See "Deferred to v1.5" below.
- [ ] **After story change (`Commit estimate` → next story)** — DEFERRED v1.5. See "Deferred to v1.5" below.

`<body>` is the worst-case landing — every Tab restart costs the user N keys to get back to where they were. Two of the three transitions still land there in v1; that's a known v1 limitation, not a blocker.

## (4) Overlays — open, escape, return focus

There is currently ONE overlay-like surface: the "What's CERU?" popover in the AI panel on the reveal screen (host only, after AI is requested).

§3 RESOLVED → A: demoted to a labelled disclosure region (NOT `role="dialog"`). Trigger button carries `aria-expanded`/`aria-controls`; Escape closes as a cheap nice-to-have; the trigger toggles closed too. **No focus-trap, no forced focus-move-into** — those are modal behaviours we deliberately don't promise (a false ARIA promise is worse than silence).

- [ ] Tab to "What's CERU?", press Enter — the region opens (verify `aria-expanded=true` if you can inspect; otherwise: the explanatory copy renders).
- [ ] Press Enter on the trigger again — closes (the trigger is a toggle in the disclosure pattern).
- [ ] Re-open, press Escape — closes. Focus stays on / returns to the trigger (which is correct for a disclosure; the focus never left it on the keyboard path).

## (5) No keyboard trap anywhere

By Tabbing through each screen end-to-end without using Shift+Tab or the mouse, the focus should never get stuck on one element. The locked `keyboard.spec.ts` checks this automatically per screen, but if a future commit adds a new overlay or menu the manual pass catches it on first review.

- [ ] **Roster popovers (if any).** None today; check if added.
- [ ] **Split form** (host, in voting). Tab through child inputs → Add another → Cancel → Split — escapable.
- [ ] **Confidence/deck radiogroups.** Tab progresses past the group; Shift+Tab returns. Arrow keys within the group are NOT implemented (Tab-each model) — that is the documented behavior, not a trap. See Decision §4.

---

## Decisions — Joe's locked calls

Status of the four §-decisions surfaced by the S10 keyboard recon.

### §1 — Accent-on-accent focus ring on primary `<Button variant="primary">` — RESOLVED A

Landed: `focus-visible:ring-offset-2 focus-visible:ring-offset-bg` on `Button.BASE` in `apps/web/src/components/Button.tsx`. Ring sits 2 px outside the button on the page bg (`--color-bg`), so it's accent-on-bg regardless of the variant's fill. **Token-only**: `ring-offset-bg` resolves to `--color-bg` via Tailwind v4's `@theme inline` bridge in `styles/index.css`. No tokens retoned, no new tokens introduced. Same offset on secondary/ghost too — they were already-visible-on-bg; the consistent halo is a small visual win.

Manual-pass row §(2): "verify the offset ring is visible on the primary button, both themes." If dark theme reads muddy → revisit the option set (B was `ring-accent-ink`), don't paper over.

### §2 — Focus-on-transition — REVEAL→Commit RESOLVED; others DEFERRED v1.5

REVEAL→Commit (host hot-path) landed: `CommitPanel` mount-time `useEffect` keyed on `story.id` calls `.focus()` on a `ref`-held Commit button. Graceful no-op when Commit is disabled (zero-vote / no-numeric-median edge: the ref is wired but `btn.disabled` is true, so we skip — never focus a disabled element, never throw). Locked by `keyboard.spec.ts` (`expect(...).toBeFocused()` after Reveal).

async-close→review and story-change focus targets → v1.5 (see "Deferred to v1.5" below). Both still drop to `<body>`; behaviour is a known v1 limitation, not a blocker.

### §3 — `CeruPopover` ARIA role — RESOLVED A

Demoted from `role="dialog"` to a labelled disclosure region in `AiSuggestionPanel.tsx`:
- Trigger button: `aria-expanded={open}` + `aria-controls={popoverId}`. (Dropped `aria-haspopup="dialog"` — would re-imply the modal promise we demoted from.)
- Region: `role="region"` + `aria-labelledby={headingId}`. Heading is the inline `<span id=…>What's CERU?</span>`.
- Toggling: trigger click toggles; **Escape** also closes via a `useEffect` keydown listener that mounts only while open.
- **No focus-trap, no forced focus-move-into** — those are modal behaviours; the demote means we deliberately don't promise them.
- The X button stays as a redundant mouse/touch dismissal; on the keyboard, trigger-toggle and Escape are the two paths.

Locked by `keyboard.spec.ts` ("What's CERU?" disclosure test: trigger Enter → `aria-expanded=true`; trigger Enter again or Escape → `aria-expanded=false`) and by `AiSuggestionPanel.test.tsx` (5 assertions: open, X-close, toggle-close, Escape-close, aria-controls round-trip).

### §4 — Radiogroup interaction model — DEFERRED v1.5

Kept as Tab-each for v1. WCAG-conformant. See "Deferred to v1.5" below for the carry-forward.

---

## Deferred to v1.5

Durable in-repo list of post-v1 keyboard-a11y polish. Each item is well-scoped and known to not block the v1 manual checklist.

### §4 — Radiogroup roving-tabindex + arrow-keys

`ConfidencePicker.tsx` + `VoteCards.tsx`. Switch from the current Tab-each model to the ARIA-documented roving-tabindex + arrow-key navigation. Cuts Tab-count through the deck (currently 7 stops for the Fibonacci deck) and aligns screen-reader nav with the `role="radiogroup"` promise. No data-model change; one `tabIndex` per group + `onKeyDown` for arrows.

### §2 (rest) — async-close→review focus

After force-close of the async window the host lands on `ReviewHostScreen`. Two review paths:
- **Agreed pile present** → target = `[data-slot="accept-all"]`.
- **No agreed pile** (all-discuss or no-estimate) → target = the first `[data-slot="discuss-card"]` or `[data-slot="discuss-live"]`.

Mechanism: `useEffect` keyed on the room-state transition `'active' → 'review'`. Branch decision lives in `ReviewHostScreen` where the data is already computed.

### §2 (rest) — story-change focus

After `COMMIT_STORY` the room advances to the next story (or to review if the queue's empty). Target depends on what mounts next:
- Next story in lobby → host's `Open voting` button.
- All stories committed → review screen target per the §2 bullet above.

Mechanism: same as the others, keyed on the active-story id.

### Audit follow-ups (not blocking)

- The keyboard pass scope is the five key screens. If a new screen lands (e.g. host-side settings, voter-side spectator-switch), it joins `e2e/keyboard.spec.ts` + this checklist by the same pattern.
- If a real `aria-modal` modal lands (vs. the demoted disclosure), it needs the standard kit (Escape, focus-trap, focus-move-into, focus-return) — that's its own task and not part of v1.

---

## What the automated keyboard spec proves vs. doesn't

| Item | Automated (`keyboard.spec.ts`) | Manual checklist |
|---|---|---|
| Primary action reachable via Tab | ✓ per screen | (cross-check on a smaller surface) |
| No hard trap (focus pins on one element) | ✓ per screen | (cross-check) |
| Focus indicator is APPLIED (outline or ring exists) | ✓ per screen | — |
| Focus indicator is **VISIBLE** (sufficient contrast vs. surface) | ✗ — visibility judgment | ✓ §(2), both themes |
| Enter / Space on primary triggers the effect | ✓ per screen | (cross-check) |
| Focus lands on Commit estimate after REVEAL | ✓ (the one transition covered in v1) | ✓ §(3) cross-check |
| Focus lands sensibly after async-close→review / story-change | ✗ — v1.5 (see Deferred) | ✓ §(3), known to drop to body in v1 |
| Disclosure popover: open / toggle / Escape | ✓ "What's CERU?" | ✓ §(4) cross-check |
| Tab order matches visual order | partial (we know the order; not "matches visual") | ✓ §(1) |

---

## Sign-off

Run the checklist? Paste this stub in the release-vehicle PR:

```
## Keyboard a11y manual checklist — vN release
- Light theme: PASS / FAIL (notes if any)
- Dark theme: PASS / FAIL (notes if any)
- §1 offset ring visible on primary, both themes: YES / NO
- §3 disclosure pattern works (toggle + Escape): YES / NO
- §2 REVEAL→Commit focus lands: YES / NO
- Hot spots flagged: <none | screen + element>
- Run by: <name>, <date>
```

**The code side of the gate is done.** Decisions §1–§3 (in-scope for v1) are landed and locked by `keyboard.spec.ts` + `AiSuggestionPanel.test.tsx`. §2 (rest) and §4 are deferred — see "Deferred to v1.5". The gate closes on this manual hand-run.
