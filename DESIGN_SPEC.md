# DESIGN_SPEC.md — Pointe.team (Paper & Press)

> **Design System & Component Specification v1.4 — CONSOLIDATED**
> **Supersedes:** DESIGN_SPEC v1.0 + ADDENDUM v1.1 (fully merged; do not reference prior documents)
> **Target Audience:** AI Code Generation Agents (Claude Code)
> **Aesthetic Archetype:** Paper & Press — Tactile Brutalist Editorial Print
> **Changelog v1.2:** Merged addendum components; resolved all contradictions; bumped `--text-tertiary` for WCAG AA; added Section 6 (Accessibility & Reduced Motion — engineering quality gate); standardized consensus microcopy; replaced emoji glyphs.
> **Changelog v1.3:** Section 3.9 correction — ConsensusStamp and Badge text on `--color-success-surface` must use `var(--color-success-on)`, not `var(--semantic-emerald)`. In light mode `--semantic-emerald` (`#059669`) on the emerald tint over `#F4F1EA` yields 2.98:1 (fails AA). `--color-success-on` is set to `#064E3B` in the light theme block (7.70:1) and inherits `#10B981` in dark (5.44:1). The accent emerald token is for borders only; the on-surface text token is theme-specific.
> **Changelog v1.4:** Systematic contrast audit — Section A added (Contrast-Verified Token Pairings). New token `--color-accent-on` (text on all `bg-accent-tint` surfaces). `--color-warning-on` / `--color-error-on` now have explicit values in both theme blocks (previous dark-only values cascaded incorrectly in light mode). Dark `--text-tertiary` bumped `#8A8A8A` → `#929292` (was 4.27:1 on surface-raised; now 4.86:1). Root cause: same-family color on its own tinted surface cannot self-contrast — all accent text now uses dedicated `-on` tokens per theme. Solid CTA button (`accent-ink` on `accent` fill, 3.44:1 dark) remains a known exception pending design decision (see Section A).

---

## 1. System Identity & Core Philosophy

### 1.1 Personality Statement
A refined, brutalist editorial print publication designed for craft-obsessed software teams who respect physical typography, tactile weight, and tangible ink over generic SaaS sheen.

### 1.2 The Emotional Register
**Tactile, rhythmic, and editorial.** Voting feels like placing physical, heavy-cardstock tokens on a matte drafting table, bringing calm focus and decisive speed to an otherwise noisy Zoom call or agile ritual.

### 1.3 What It Deliberately Avoids
* **No Glows or Glassmorphism:** Zero `backdrop-filter: blur()`, zero colored drop shadows, zero neon outer glows.
* **No Spring/Bounce Motion:** Motion is snappy, mechanical, and hard-edged. Deceleration easing (`--ease-mechanical`) is permitted; overshoot, rebound, and spring physics are not.
* **No Rounded Pills:** Maximum border-radius system-wide is **2px**. Most containers use `0px`.
* **No Floating Avatars or Playful Illustrations:** Presence is indexed in strict tabular print rosters. No emoji anywhere in the UI — text glyphs only (`[OBS]`, `[× OFFLINE]`, `●`, `○`, `★`).
* **No Generic SaaS Blue/Purple:** Palette is anchored in asphalt, newsprint, vermilion press ink, and editorial proofreading marks.

---

## 2. Token Architecture (CSS Custom Properties)

```css
:root {
  /* ==========================================
     COLOR SYSTEM — DARK MODE FIRST (Default)
     ========================================== */

  /* Surfaces & Canvas */
  --bg-canvas: #121212;            /* Dense Asphalt Charcoal */
  --surface-base: #1E1E1E;         /* Deep Charcoal Ink Surface */
  --surface-raised: #282828;       /* Elevated Cardstock / Hover Panel */
  --surface-overlay: #303030;      /* Modal / Overlay Background */

  /* Borders & Grid Rules */
  --border-hairline: #333333;      /* Subtle Grid Divider Marks */
  --border-strong: #E2E8F0;        /* Newspaper Off-White Frame Lines */
  --border-focus: #FF4500;         /* Active / Focused Highlight Frame */

  /* Typography & Ink */
  --text-primary: #ECEFF4;         /* Crisp Off-White Newsprint Text */
  --text-secondary: #A1A1AA;       /* Muted Editorial Caption Gray */
  --text-tertiary: #929292;        /* Subdued Index / Rule Color (v1.4: bumped from #8A8A8A — was 4.27:1 on surface-raised, fails AA; now 4.86:1) */
  --text-inverse: #121212;         /* Dark Ink Text for Light Backgrounds */

  /* Brand Primary & Accents */
  --accent-vermilion: #FF4500;     /* Electric Vermilion Press Ink */
  --accent-vermilion-hover: #E03E00;
  --accent-vermilion-subtle: rgba(255, 69, 0, 0.12);

  /* Semantic Ink Palette (Editorial Marks) */
  --semantic-emerald: #10B981;     /* Emerald Ink Stamp Green (Consensus) */
  --semantic-emerald-bg: rgba(16, 185, 129, 0.12);
  --semantic-amber: #D97706;       /* Ochre Editorial Warning (High Spread) */
  --semantic-amber-bg: rgba(217, 119, 6, 0.12);
  --semantic-crimson: #DC2626;     /* Crimson Proofreader Red (Outlier / Error) */
  --semantic-crimson-bg: rgba(220, 38, 38, 0.12);

  /* Focus & Accessibility */
  --focus-ring-outline: 2px solid var(--border-focus);
  --focus-ring-offset: 2px;

  /* Texture Overlay Data-URI (Subtle Newsprint / Asphalt Grain) */
  --bg-grain-uri: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.035'/%3E%3C/svg%3E");

  /* ==========================================
     TYPOGRAPHY & MEASURE
     ========================================== */
  --font-display: 'Instrument Serif', Georgia, serif;
  --font-body: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;

  /* Type Scale */
  --text-xs: 0.75rem;      /* 12px - Labels, Metadata, Table Headers */
  --text-sm: 0.875rem;     /* 14px - Body Secondary, Inputs, Tooltips */
  --text-base: 1rem;       /* 16px - Standard UI Body Text */
  --text-lg: 1.25rem;      /* 20px - Subheadings, Deck Titles */
  --text-xl: 1.75rem;      /* 28px - Section Headers */
  --text-display: 3.5rem;  /* 56px - Large Estimate Values */

  /* Line Heights */
  --lh-tight: 1.05;
  --lh-snug: 1.25;
  --lh-normal: 1.50;

  /* Letter Spacing */
  --tracking-tight: -0.02em;
  --tracking-normal: 0em;
  --tracking-wide: 0.08em;
  --tracking-caps: 0.12em;

  /* ==========================================
     SPACING & LAYOUT (STRICT 4px GRID)
     ========================================== */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-16: 64px;

  /* ==========================================
     RADII & SHADOWS (BRUTALIST TACTILE)
     ========================================== */
  --radius-none: 0px;
  --radius-sharp: 2px;     /* Maximum allowed radius system-wide */

  /* Hard Offset Shadows (No blur) */
  --shadow-hard-sm: 2px 2px 0px #000000;
  --shadow-hard-md: 4px 4px 0px #000000;
  --shadow-hard-lg: 6px 6px 0px #000000;
  --shadow-stamp: 0px 0px 0px 2px var(--semantic-emerald), 4px 4px 0px #000000;

  /* ==========================================
     TIMING & EASING (MECHANICAL & HARD)
     ========================================== */
  --ease-mechanical: cubic-bezier(0, 0, 0.2, 1);  /* Fast start, hard deceleration stop. NO overshoot. */
  --ease-snap: cubic-bezier(0.1, 0.9, 0.2, 1);    /* Micro-interactions only (hover lift). NO overshoot. */
  --duration-fast: 80ms;
  --duration-normal: 150ms;
  --duration-tumble: 300ms;
}

/* ==========================================
   LIGHT MODE OVERRIDES
   ========================================== */
[data-theme="light"] {
  --bg-canvas: #EAE6DF;            /* Warm Newsprint Off-White Paper */
  --surface-base: #F4F1EA;         /* Clean Cardstock Sheet */
  --surface-raised: #FFFFFF;
  --surface-overlay: #FFFFFF;

  --border-hairline: #D1CCC2;      /* Muted Pencil Guide Line */
  --border-strong: #121212;        /* Hard Black Print Rule */
  --border-focus: #D03800;         /* v1.2: matches light-mode vermilion for contrast */

  --text-primary: #121212;
  --text-secondary: #52525B;
  --text-tertiary: #5E5A54;        /* v1.2: bumped from #88837A for WCAG AA ~5:1 on light canvas */
  --text-inverse: #ECEFF4;

  --accent-vermilion: #D03800;     /* Deeper Press Ink for Contrast */
  --accent-vermilion-hover: #B02F00;
  --accent-vermilion-subtle: rgba(208, 56, 0, 0.08);

  --semantic-emerald: #059669;
  --semantic-emerald-bg: rgba(5, 150, 105, 0.10);
  --semantic-amber: #B45309;
  --semantic-amber-bg: rgba(180, 83, 9, 0.10);
  --semantic-crimson: #B91C1C;
  --semantic-crimson-bg: rgba(185, 28, 28, 0.10);

  --shadow-hard-sm: 2px 2px 0px #121212;
  --shadow-hard-md: 4px 4px 0px #121212;
  --shadow-hard-lg: 6px 6px 0px #121212;
  --shadow-stamp: 0px 0px 0px 2px var(--semantic-emerald), 4px 4px 0px #121212;
}
```

**Token usage rules:**
1. `--text-tertiary` may not be used for text below 12px. For readable metadata at small sizes, use `--text-secondary`.
2. Every color in components MUST reference a token. No raw hex in component CSS.
3. `--ease-snap` is restricted to hover/press micro-interactions. All structural motion (flips, collapses, slides) uses `--ease-mechanical` or `linear`.

---

## 3. Component Specifications & State Machines

### 3.1 The Estimate Card (`<PointeCard />`)

A heavy cardstock voting tile representing an estimate choice (e.g., `0`, `1`, `2`, `3`, `5`, `8`, `13`, `21`, `?`, coffee-break).

```
+--------------------------+
| 8                      8 | <- Instrument Serif corner indices
|                          |
|            8             | <- Huge Instrument Serif center (--text-display)
|                          |
| 8                      8 |
+--------------------------+
```

* **Default:** `background: var(--surface-base)`; `border: 1px solid var(--border-hairline)`; `color: var(--text-primary)`; `box-shadow: none`; `cursor: pointer`
* **Hover:** `transform: translateY(-2px)`; `border: 1px solid var(--text-primary)`; `box-shadow: var(--shadow-hard-sm)`; `transition: transform var(--duration-fast) var(--ease-snap)`
* **Active/Pressed:** `transform: translate(1px, 1px)`; `box-shadow: none`
* **Selected (voted by me):** `background: var(--surface-raised)`; `border: 2px solid var(--accent-vermilion)`; `color: var(--accent-vermilion)`; `box-shadow: var(--shadow-hard-md)`; ink dot `●` in top-right corner
* **Disabled/Locked:** `opacity: 0.4`; `cursor: not-allowed`; `border-style: dashed`
* **Focus-Visible:** `outline: var(--focus-ring-outline)`; `outline-offset: var(--focus-ring-offset)`

### 3.2 Table Deck & Card Back (`<TableDeck />`)

Face-down cards on the central board before reveal.

```
+--------------------------+
|//////////////////////////|
|//////////////////////////| <- Ink Cross-Hatch Pattern
|///////// POINTE /////////| <- Monospace Title Stamp
|//////////////////////////|
+--------------------------+
```

* `background-color: var(--surface-base)`
* `background-image: repeating-linear-gradient(45deg, var(--border-hairline) 0, var(--border-hairline) 1px, transparent 0, transparent 8px)`
* `border: 1px solid var(--border-strong)`

### 3.3 Participant Roster Table (`<ParticipantRoster />`)

Users are listed in a typographic print index — never floating avatars.

```
INDEX  PARTICIPANT          ROLE       STATUS         ESTIMATE
----------------------------------------------------------------
01     Alex Rivera          Voter      [ ● READY ]    --
02     Jordan Smith         Voter      [ ○ PENDING ]  --
03     Sam Chen             Observer   [ OBS ]        --
04     Morgan Lee           Voter      [ × OFFLINE ]  --
```

* **PENDING (not voted):** `color: var(--text-tertiary)`; text `○ PENDING`
* **READY (voted):** `color: var(--accent-vermilion)`; text `● READY`; single-frame 1px downward row nudge on vote arrival (ledger logging)
* **OBSERVER:** `color: var(--text-secondary)`; text glyph `[OBS]` in JetBrains Mono (no emoji)
* **DISCONNECTED:** `color: var(--text-tertiary)`; `font-style: italic`; text `[× OFFLINE]`; row opacity `0.45`

### 3.4 Primary Button (`<Button variant="primary" />`)

High-priority actions (`[ EXECUTE REVEAL ]`, `[ CREATE SESSION ]`).

* **Default:** `background: var(--accent-vermilion)`; `color: #FFFFFF`; `border: 1px solid var(--accent-vermilion)`; `font-family: var(--font-mono)`; `font-weight: 700`; `text-transform: uppercase`; `box-shadow: var(--shadow-hard-sm)`; `border-radius: var(--radius-sharp)`
* **Hover:** `background: var(--accent-vermilion-hover)`; `transform: translate(-1px, -1px)`; `box-shadow: var(--shadow-hard-md)`
* **Active/Pressed:** `background: var(--accent-vermilion-hover)`; `transform: translate(1px, 1px)`; `box-shadow: none`
* **Disabled:** `background: var(--surface-raised)`; `color: var(--text-tertiary)`; `border: 1px solid var(--border-hairline)`; `box-shadow: none`; `cursor: not-allowed`; `opacity: 0.6`
* **Focus-Visible:** `outline: var(--focus-ring-outline)`; `outline-offset: var(--focus-ring-offset)`

### 3.5 Secondary Button (`<Button variant="secondary" />`)

Structural actions (`[ COPY INVITE LINK ]`, `[ TOGGLE OBSERVER ]`).

* **Default:** `background: var(--surface-base)`; `color: var(--text-primary)`; `border: 1px solid var(--border-strong)`; `font-family: var(--font-mono)`; `font-weight: 600`; `text-transform: uppercase`; `box-shadow: var(--shadow-hard-sm)`; `border-radius: var(--radius-sharp)`
* **Hover:** `background: var(--surface-raised)`; `transform: translate(-1px, -1px)`; `box-shadow: var(--shadow-hard-md)`
* **Active/Pressed:** `transform: translate(1px, 1px)`; `box-shadow: none`
* **Disabled:** `background: var(--surface-base)`; `color: var(--text-tertiary)`; `border: 1px solid var(--border-hairline)`; `box-shadow: none`; `cursor: not-allowed`; `opacity: 0.5`
* **Focus-Visible:** `outline: var(--focus-ring-outline)`; `outline-offset: var(--focus-ring-offset)`

### 3.6 Ghost Button (`<Button variant="ghost" />`)

Low-emphasis actions (`[ LEAVE SESSION ]`, `[ TOGGLE THEME ]`).

* **Default:** `background: transparent`; `color: var(--text-secondary)`; `border: 1px solid transparent`; `font-family: var(--font-mono)`; `box-shadow: none`
* **Hover:** `color: var(--text-primary)`; `border: 1px solid var(--border-hairline)`; `background: var(--surface-raised)`
* **Active/Pressed:** `background: var(--surface-base)`; `color: var(--accent-vermilion)`
* **Disabled:** `color: var(--text-tertiary)`; `cursor: not-allowed`; `opacity: 0.4`
* **Focus-Visible:** `outline: var(--focus-ring-outline)`; `outline-offset: 0px`

### 3.7 Text Input (`<TextInput />`)

Display name entry and session creation inputs.

```
DISPLAY NAME                          <- Label (Mono Uppercase, --text-xs, --tracking-caps)
+---------------------------------+
| e.g. Alex Rivera                |   <- Placeholder / value
+---------------------------------+
! REQUIRED: NAME CANNOT BE BLANK      <- Error helper (--semantic-crimson, Mono 12px)
```

* **Default:** `background: var(--bg-canvas)`; `color: var(--text-primary)`; `border: 1px solid var(--border-strong)`; `font-family: var(--font-body)`; `border-radius: var(--radius-sharp)`; `padding: 10px 14px`
* **Placeholder:** `color: var(--text-tertiary)`; `font-style: italic`
* **Hover:** `border-color: var(--text-primary)`
* **Focus / Focus-Visible:** `outline: var(--focus-ring-outline)`; `outline-offset: 0px`; `background: var(--surface-base)`
* **Error (`[data-error="true"]`):** `border: 2px solid var(--semantic-crimson)`; `background: var(--semantic-crimson-bg)`; helper text below in JetBrains Mono 12px `--semantic-crimson`; input gets `aria-invalid="true"` and `aria-describedby` pointing to the helper text id
* **Disabled:** `background: var(--surface-base)`; `color: var(--text-tertiary)`; `border: 1px solid var(--border-hairline)`; `cursor: not-allowed`

### 3.8 Session Results Panel (`<SessionResultsPanel />`)

Post-reveal summary: statistics, typographic tally, outliers. No chart libraries.

```
===================================================================
SUMMARY // SESSION TALLY
===================================================================
AVERAGE: 5.6 PTS   |   CONSENSUS: NONE   |   TOTAL VOTES: 8
-------------------------------------------------------------------
03 PTS  [3]  |||               (Alex, Chris, Taylor)
05 PTS  [3]  |||               (Jordan, Sam, Casey)
13 PTS  [2]  ||  [OUTLIER]     (Morgan, Riley)
-------------------------------------------------------------------
```

* **Container:** `background: var(--surface-base)`; `border: 2px solid var(--border-strong)`
* **Stat values:** Instrument Serif; **labels:** JetBrains Mono uppercase
* **Tally marks:** `|` characters in JetBrains Mono bold
* **Outlier rule:** any vote ≥ 2 Fibonacci steps from the median gets tag `[OUTLIER]`: `color: var(--semantic-crimson)`; `background: var(--semantic-crimson-bg)`; `border: 1px solid var(--semantic-crimson)`; `padding: 2px 6px`

### 3.9 Consensus Stamp (`<ConsensusStamp />`)

Triggered on reveal when all non-observer participants share the exact same value.

* **Text (canonical, use everywhere):** `★ UNANIMOUS CONSENSUS: [X] PTS`
* `border: 3px solid var(--semantic-emerald)`; `color: var(--color-success-on)`; `background: var(--semantic-emerald-bg)`
* **v1.3 note:** Use `var(--color-success-on)` (not `var(--semantic-emerald)`) for stamp text — the accent token fails WCAG AA in light mode. `--color-success-on` is theme-specific: `#064E3B` (light, 7.70:1) / `#10B981` (dark, 5.44:1).
* `font-family: var(--font-mono)`; `font-weight: 800`; `text-transform: uppercase`
* **Rotation (canonical): `rotate(-3deg)`** — this value everywhere; `-12deg` references are void
* `box-shadow: var(--shadow-stamp)`; `padding: 16px 32px`

### 3.10 Variance Banner (`<VarianceBanner />`)

Triggered on reveal when spread is high (min/max ≥ 2 Fibonacci steps apart).

* Text: `NOTICE: VOTE SPREAD HIGH ([MIN] TO [MAX])`
* `border-left: 4px solid var(--semantic-amber)`; `background: var(--semantic-amber-bg)`; `color: var(--text-primary)`; `font-family: var(--font-mono)`; `padding: 12px 16px`

### 3.11 Toast (`<PointeToast />`)

System feedback (link copied, participant left).

```
+------------------------------------------------+
| [✓] LINK COPIED TO CLIPBOARD        [DISMISS]  |
+------------------------------------------------+
```

* `background: var(--text-primary)` (inverse relative to theme); `color: var(--text-inverse)`; `border: 1px solid var(--border-strong)`; `box-shadow: var(--shadow-hard-md)`; `font-family: var(--font-mono)`; `font-size: var(--text-sm)`; `padding: 12px 16px`; `border-radius: var(--radius-sharp)`
* Toast container uses `role="status"` (`aria-live="polite"`) so screen readers announce it
* **Dismiss button Focus-Visible:** `outline: 2px solid var(--accent-vermilion)`

---

## 4. Motion Choreography & Signature Mechanics

### 4.1 Signature Reveal: "The Mechanical Digital Count-Up Tumble"

When the host clicks Reveal, the sequence progresses strictly:

```
[Phase 1: Tumble Launch] -> [Phase 2: Digital Cycle] -> [Phase 3: Hard Slam] -> [Phase 4: Impact Shake] -> [Phase 5: Stamp]
      (0.00s - 0.10s)          (0.10s - 0.25s)             (0.25s)                (0.25s - 0.35s)           (0.35s+)
```

1. **Phase 1 — Mechanical Tumble (0.00–0.10s):** face-down card rotates Y-axis `0deg → 90deg` via `--ease-mechanical`. At `90deg`, cross-hatch back toggles off; face becomes visible.
2. **Phase 2 — Digital Random Cycle (0.10–0.25s):** while rotating `90deg → 0deg` face-forward, value text cycles random deck values every `25ms` (6 iterations) in JetBrains Mono. No motion blur.
3. **Phase 3 — Hard Slam Settle (0.25s):** value locks to true estimate; typography switches instantly to Instrument Serif; zero spring/rebound.
4. **Phase 4 — Micro-Impact Shake (0.25–0.35s):**
```css
@keyframes micro-shake {
  0%   { transform: translate(0, 0); }
  25%  { transform: translate(-1px, 1px); }
  50%  { transform: translate(1px, -1px); }
  75%  { transform: translate(-1px, 0); }
  100% { transform: translate(0, 0); }
}
```
5. **Phase 5 — Consensus Stamp Slam (0.35s+):** if consensus, `<ConsensusStamp />` slams `scale(1.4) → scale(1.0)` at `rotate(-3deg)` in exactly `80ms`. Zero spring.

### 4.2 Real-Time Presence Motion

* On vote lock: roster dot `○ → ●`; row gets single-frame 1px downward nudge and reset (physical ledger logging).

### 4.3 Roster Join: "Ledger Line Stamping"

1. New row collapses open `0px → 40px` height in `80ms`, linear.
2. Row contents slide `translateX(-8px) → translateX(0)` in `50ms` — zero fade.
3. Single-frame 1px downward nudge on the whole table (mechanical line feed).

### 4.4 Roster Leave / Disconnect: "Redaction Fade"

**State model note (confirmed 2025-07-22):** `ConnectionState = 'connected' | 'reconnecting' | 'left'`. `'reconnecting'` is a network drop (temporary); `'left'` is an explicit leave (permanent). These must be treated differently:

* **`reconnecting` (network drop):** Status switches instantly to `[× OFFLINE]`; text color → `var(--text-tertiary)`; row opacity → `0.45`. Row persists — no collapse. TableDeck slot persists at `0.45` opacity; if voter already played a card, the face-down tile stays full-hatch (vote still reveals).
* **`left` (explicit leave):** The 500ms Redaction Fade applies: status → `[× OFFLINE]`, then after `500ms` buffer, row collapses `40px → 0px` instantly. TableDeck slot is removed on `left`. Increment 6 must follow this same rule.

> The 500ms row collapse applies to explicit leaves (`'left'`) only. Reconnecting voters persist as `[× OFFLINE]` until they reconnect or explicitly leave.

---

## 5. Voice & Microcopy (Canonical Strings)

| Context / Trigger | Microcopy | Typography & Tone |
| --- | --- | --- |
| Header badge | `POINTE // SESSION #8492` | JetBrains Mono, all-caps, muted |
| Empty vote state | `SELECT AN ESTIMATE TILE TO LOCK VOTE` | Plus Jakarta Sans, 12px, tracking-caps |
| Vote locked | `VOTE RECORDED. AWAITING REVEAL SYNC.` | JetBrains Mono, vermilion accent |
| Reveal button (host) | `[ EXECUTE REVEAL ]` | JetBrains Mono, bold, solid frame |
| Reset button | `[ CLEAR LEDGER & RESTART ]` | JetBrains Mono, crimson on hover |
| Consensus stamp | `★ UNANIMOUS CONSENSUS: [X] PTS` | Serif + Mono, stamp border (canonical — no variants) |
| High spread | `NOTICE: VOTE SPREAD HIGH ([MIN] TO [MAX])` | JetBrains Mono, amber block |
| Copy link toast | `URL COPIED TO CLIPBOARD` | JetBrains Mono, inverse toast |
| Observer glyph | `[OBS]` | JetBrains Mono (no emoji) |
| Disconnected glyph | `[× OFFLINE]` | JetBrains Mono, italic |

---

## 6. Accessibility & Reduced Motion (Engineering Quality Gate — v1.2)

These are hard requirements, not suggestions. Every increment that touches these areas must implement them.

### 6.1 `prefers-reduced-motion`

```css
@media (prefers-reduced-motion: reduce) {
  /* Reveal: cards cut directly from back to face — no tumble, no count-up cycle, no shake */
  /* Stamp: appears at final scale/rotation instantly — no slam animation */
  /* Roster: rows appear/disappear instantly — no collapse or slide */
  /* Hover lifts and press translations are retained (discrete, non-vestibular) */
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

Implementation note: the count-up random cycle (25ms flashing values) MUST be fully disabled under reduced motion — show the true value immediately. This is the single most important reduced-motion rule in the app.

### 6.2 Contrast Compliance

* `--text-tertiary` is set to pass WCAG AA (≥4.5:1) on all surfaces in both themes (v1.4 dark: `#929292`, 5.36:1 / surface-base, 4.86:1 / surface-raised). Do not revert to `#8A8A8A` or `#666666`.
* `--text-tertiary` never below 12px.
* Verify vermilion-on-canvas combinations remain ≥4.5:1 when used for text (dark mode `#FF4500` on `#121212` ≈ 4.9:1 — passes; do not use vermilion text on `--surface-raised`).
* **On-tint text rule (v1.4):** Semantic accent colors (`--color-accent`, `--color-success`, `--color-warning`, `--color-error`) are for borders and fills only. Text placed on tinted surfaces (`bg-accent-tint`, `bg-success-surface`, `bg-warning-surface`, `bg-error-surface`) MUST use the dedicated `-on` token (`text-accent-on`, `text-success-on`, `text-warning-on`, `text-error-on`). Using the base accent token on its own tint fails AA — e.g., `text-accent` on `bg-accent-tint` yields 4.27:1 dark / 3.91:1 light.
* Every `-on` token is explicitly set in BOTH theme blocks in `tokens.css`. Do not rely on cascade for on-tokens.
* See Section A for the full verified pairing table.

### 6.3 Screen Reader Choreography

* The room table region uses `aria-live="polite"`.
* On reveal completion (after Phase 3), announce once: `"Votes revealed. Average [X]. [Consensus reached at Y points. | Vote spread high, N to M.]"` — do NOT announce each card individually.
* On vote lock: announce `"[Name] is ready."` at most once per participant per round.
* Consensus stamp is `role="status"`; decorative `★` is `aria-hidden="true"`.
* Estimate cards are `<button>` elements with `aria-pressed` for selected state; deck is a `role="radiogroup"`-equivalent pattern OR native buttons with `aria-pressed` — pick one and be consistent.

### 6.4 Keyboard Flow (Voting Loop)

1. `Tab` reaches the card hand; `Arrow` keys move between cards; `Enter`/`Space` locks vote.
2. Host controls (`[ EXECUTE REVEAL ]`, `[ CLEAR LEDGER & RESTART ]`) are next in tab order after the hand.
3. Focus is never lost on reveal — focus stays on the reveal button; results panel receives `tabindex="-1"` and is NOT auto-focused.
4. Toast dismiss reachable via keyboard; toast auto-dismiss ≥5s.

---

## 7. Implementation Checklist for AI Code Agent

1. [ ] **No border radii > 2px:** replace `rounded-md|lg|full` with `rounded-[2px]` or `rounded-none`.
2. [ ] **Fonts loaded:** Instrument Serif, Plus Jakarta Sans, JetBrains Mono via Google Fonts (self-host or font-display: swap).
3. [ ] **Token-only colors:** no `bg-gray-900`/`bg-slate-900` defaults; all colors via CSS variables above.
4. [ ] **Hard shadows only:** `shadow-[2px_2px_0px_#000]` patterns; zero blurred drop shadows.
5. [ ] **Reveal motion:** 25ms tick-cycle via `requestAnimationFrame` (preferred over `setInterval`); no spring physics anywhere.
6. [ ] **Light mode:** `data-theme="light"` on `<html>` maps canvas to `#EAE6DF`, ink to `#121212`.
7. [ ] **Reduced motion:** Section 6.1 implemented and verified with emulation.
8. [ ] **Focus-visible:** every interactive element per its component spec.
9. [ ] **SR announcements:** Section 6.3 verified with VoiceOver or NVDA pass.
10. [ ] **No emoji in UI:** text glyphs only.

---

## Section A — Contrast-Verified Token Pairings

Minimum WCAG AA: 4.5:1 normal text. Computed with sRGB linearization (WCAG 2.1 formula). Tint surfaces are alpha-blended over the named base. Values rounded to 2 dp.

| Foreground / Background | Dark · surface-base | Dark · surface-raised | Light · surface-base | Light · bg-canvas |
|-------------------------|--------------------|-----------------------|---------------------|-------------------|
| `text-tertiary` on solid surface<br>`#929292` (dk) · `#5E5A54` (lt) | 5.36:1 ✓ | 4.86:1 ✓ | 6.07:1 ✓ | 6.85:1 ✓ |
| `accent-on` on `accent-tint`<br>`#FF7000` (dk) · `#B02F00` (lt) | 5.30:1 ✓ | 4.82:1 ✓ | 5.10:1 ✓ | 4.65:1 ✓ |
| `warning-on` on `warning-surface`<br>`#F59E0B` (dk) · `#92400E` (lt) | 6.61:1 ✓ | 5.99:1 ✓ | 5.52:1 ✓ | 5.03:1 ✓ |
| `error-on` on `error-surface`<br>`#F87171` (dk) · `#991B1B` (lt) | 5.55:1 ✓ | 5.07:1 ✓ | 6.27:1 ✓ | 5.71:1 ✓ |
| `success-on` on `success-surface` _(v1.3 ref)_<br>`#10B981` (dk) · `#064E3B` (lt) | 5.44:1 ✓ | 4.92:1 ✓ | 7.70:1 ✓ | 7.02:1 ✓ |
| `accent-ink` on `accent` — solid CTA button<br>dk `#121212` / lt `#FFFFFF` on accent fill | 5.44:1 ✓ | 4.85:1 ✓ _(hover)_ | 4.94:1 ✓ | 6.46:1 ✓ _(hover)_ |

Note: for the CTA row, "surface-raised" = hover/active fill state, not a page surface. Dark hover bumped `#E03E00` → `#F04000` (was 4.33:1 with dark ink; now 4.85:1). Light uses white ink throughout.

**Before (failing values):** `text-accent` on `bg-accent-tint` was 4.27:1 dark / 3.91:1 light. `warning-on` (`var(--semantic-amber)`) was 4.46:1 dark. `error-on` (`var(--semantic-crimson)`) was 3.18:1 dark. `text-tertiary` `#8A8A8A` was 4.27:1 on dark surface-raised. CTA button `text-white` on `#FF4500` dark was 3.44:1. All fixed in v1.4.

**All pairs pass WCAG AA 4.5:1 as of v1.4.** No remaining exceptions.

**Maintenance rule:** When adding a new semantic color family, include a dedicated `-on` token for text on its tinted surface, set explicitly in both theme blocks, verified in both themes (all four surface columns). For solid fill elements (like CTA buttons), use `text-accent-ink` not `text-white` — the token is theme-specific (`#121212` dark / `#FFFFFF` light). Add a new row to this table before shipping.
