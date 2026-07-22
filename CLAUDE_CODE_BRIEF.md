# CLAUDE_CODE_BRIEF.md — Pointe.team v1.0 Reskin (Paper & Press)

> **Mission:** Reskin the existing Pointe.team v1.0 screens to the Paper & Press design system.
> **Contract:** `DESIGN_SPEC.md` (v1.2 consolidated) in this repo is the single source of truth. Where existing code and the spec disagree on visuals, the spec wins. Where the spec is silent, match its philosophy (Section 1.3) and ask before inventing.
> **Scope guard:** This is a RESKIN + one layout change. Do NOT add features, screens, or state logic beyond what exists. v1.0 functionality mirrors pointingpoker.com: create session, join with name, vote, reveal, results, clear, observer role, shareable link.

## Ground Rules (Dev Formula)

1. **One component per increment, ≤150 lines of new/modified code each.** If bigger, decompose before writing.
2. **QE gate on every increment:** states verified (default/hover/active/disabled/focus-visible), responsive at 375/768/1280, reduced-motion path checked.
3. **Playwright:** update existing E2E selectors broken by the reskin in the same increment that breaks them — never batch selector fixes at the end. Add visual regression snapshots per screen as Increment tasks complete.
4. **No spring physics, no blur shadows, no radii >2px, no emoji, token-only colors** — run the Section 7 checklist grep before calling any increment done.
5. **Report status after every increment** using the simplified tracker: `[X/N] tasks done | active task | blockers`.

## Vision Statement

Pointe.team v1.0 is the planning poker app teams screenshot: a brutalist editorial print aesthetic where voting feels like heavy cardstock on a drafting table, cards reveal with a mechanical count-up tumble, and unanimous votes get a rubber stamp slammed across the board.

## Implementation Plan

Total tasks: 12 | Estimated increments: 12

1. [UI/UX] **Token foundation** — Add DESIGN_SPEC Section 2 tokens as global CSS custom properties; wire `data-theme` light/dark toggle; load the three fonts; apply grain overlay to canvas. Remove/override old theme values.
2. [Frontend] **Button system** — Implement primary/secondary/ghost variants per Sections 3.4–3.6; swap all existing buttons; update microcopy to Section 5 canonical strings.
3. [Frontend] **Text input** — Section 3.7 incl. error + aria-invalid wiring; apply to join screen and session creation.
4. [Frontend] **Estimate card (hand)** — Section 3.1 face states; keyboard flow per Section 6.4 (arrow keys + aria-pressed).
5. [Frontend] **Card back / table deck** — Section 3.2 cross-hatch face-down tiles.
6. [Frontend] **Participant roster table** — Section 3.3: REPLACES the existing avatar presence UI with the typographic index table. This is the one structural layout change. Include all four states (PENDING/READY/[OBS]/[× OFFLINE]).
7. [Frontend] **Reveal choreography** — Section 4.1 five-phase sequence via requestAnimationFrame; Section 6.1 reduced-motion cut-to-face path in the same increment.
8. [Frontend] **Consensus stamp + variance banner** — Sections 3.9/3.10; stamp slam per Phase 5; role="status".
9. [Frontend] **Session results panel** — Section 3.8 typographic tally + outlier tags (≥2 Fibonacci steps from median).
10. [Frontend] **Toast + roster motion** — Section 3.11 toast; Sections 4.3/4.4 join/leave ledger animations.
11. [QE] **Accessibility pass** — Full Section 6 verification: reduced-motion emulation, contrast spot-check, SR announcement script (6.3), keyboard loop (6.4).
12. [QE] **Visual regression + polish sweep** — Playwright snapshots (landing, join, room pre-reveal, room post-reveal, consensus, mobile room); Section 7 checklist grep across the codebase; light-mode sweep of every screen.

## Decision Gates (pause and ask Maddog)

- If the existing component tree makes the roster-table swap (Task 6) require touching WebSocket/state code beyond presentation, STOP and present options before proceeding.
- If any existing v1.0 feature appears to exceed pointingpoker.com scope, flag it for the strip-down list — do not silently remove it.

## Definition of Done (project)

- Every screen renders in both themes with zero non-token colors.
- Reveal sequence matches Section 4.1 timing within ±20ms.
- Reduced-motion path verified.
- Playwright suite green, including new visual snapshots.
- Section 7 checklist fully checked.
