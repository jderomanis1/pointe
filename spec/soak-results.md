# S10 — 10-Voter Concurrency Soak — Results

**Status:** one-time sanity check, **NOT a CI gate.** Run by hand with
`pnpm soak` against a running local stack (`pnpm -F @pointe/worker dev:e2e`).
Gate-excluded from both the per-push gate and the nightly e2e.

**Date:** 2026-06-06 · **Branch:** `s10-soak` (off `main` `54f56e3`)

## What this verifies

Does the Room DO survive a realistic full refinement session **at capacity** —
10 voters casting **simultaneously**, reveal stats computing correctly under
that load, no lost votes, no message-ordering corruption, AA-1 holding under
concurrency, DO healthy across the whole session.

This is a **concurrency** check, not a network/edge check, so it runs on the
**local stack**. Worker-level behaviour is byte-identical between local stack
and prod; localhost-vs-edge is irrelevant to "can this code survive
concurrency." Prod-specific concerns (edge, WAF) are already covered by the
smoke + SI-06 tests.

**Posture:** protocol-level — the SUT is the DO/worker, driven as raw WS
protocol clients (node `ws`), not browser contexts (that's e2e's job). The
script (`scripts/soak.mjs`) reuses the worker's own `computeRevealStats` /
`resolveDeck` from `@pointe/shared` as a stats oracle, cross-checked against
independent hand-coded expectations per story.

## Step 1 — Recon

### 1.1 WS-concurrency-limit mechanism — **in-worker, but no override needed**

The SI-06 WS limit is enforced **in-worker** — a Durable Object atomic counter
(`ws_handshake_rate` SQLite table, `checkWsHandshakeRate` in
`apps/worker/src/rateLimit.ts`). **But it is a per-IP / per-room HANDSHAKE
RATE of 30/min (`RL_WS_PER_MIN`), not a concurrency cap.** The spec's original
"10 concurrent WS / IP" line was deliberately reinterpreted as a handshake
rate — true concurrency capping (per-IP open-socket counting with
decrement-on-close) is documented as v1.5 work (see `/spec/security.md` §1,
"The WS limit is a reinterpretation").

Consequence for the soak: the 11 handshakes (host + 10 voters) from one IP in
one room within a minute are well under 30 → the limit is **not tripped**, so
**no dev override is needed** (this is the in-worker case, but the in-worker
limit simply isn't reached at this scale — unlike the create cap, no
`RL_WS_PER_MIN_OVERRIDE` was added, because none is required and prod
shouldn't carry an unused override). Each re-run creates a fresh room → a
fresh DO → a fresh per-room counter, so re-runs don't accumulate against the
window either.

**Empirically confirmed:** every one of the 11 WS upgrades in each run
returned `101 Switching Protocols` — zero `429`s in the wrangler log.

(The create-per-hour **KV** cap is bumped to 500 in `wrangler.dev.toml`
via the existing `RL_CREATE_PER_HOUR_OVERRIDE`; a single soak run creates one
room, far under even the prod cap of 20.)

### 1.2 Create-limit guard test — **was ABSENT → added**

No unit test pinned the spec-locked create cap to `20` when
`RL_CREATE_PER_HOUR_OVERRIDE` is unset / non-numeric. Because CI and e2e both
run with the override at `500`, the `20` default was otherwise exercised by
nothing — it could silently drift open in prod and no test would notice.

Added (`apps/worker/test/rateLimit.test.ts`): `createPerHour` is now exported
and pinned —
- unset → `20`
- `"abc"` (non-numeric) → `20`
- `""` (empty) → `20`
- `"0"` / `"-5"` (non-positive) → `20`
- `"500"` (valid) → `500` (honours the dev/CI bump)

## Step 2 — The soak

1 room, **sync mode** (sync's "everyone votes on the active story at once" is
the worst-case DO contention — the burst we want to stress). Host + 10 voters
(11 WS, 1 IP). Host adds 12 stories (capacity-planning session size). For each
story: `OPEN_VOTING` → all 10 voters `VOTE_CAST` concurrently (`Promise.all` —
fire the burst, don't serialize) → **wait on the DO reflecting all 10**
(host observes 10 distinct `voter_voted`) → `REVEAL_VOTES` → read reveal stats
→ `COMMIT_STORY` → next.

**Determinism contract:** the concurrent cast is `Promise.all`'d, but every
wait is on observable state (the DO reflecting N votes / a reveal landing),
never wall-clock. Timeouts exist only as a failure failsafe.

Seeded distributions across the 12 stories (median / outliers / avg-confidence
all non-trivial and independently asserted):

| # | distribution | median | outliers | lowConf | non-numeric |
|---|---|---|---|---|---|
| 1 | tight consensus 5 / high conf | 5 | 0 | N | 0 |
| 2 | tight consensus 3 / conf 4 | 3 | 0 | N | 0 |
| 3 | wide spread (6×5, 2×1, 2×21) | 5 | 4 | N | 0 |
| 4 | low-confidence consensus on 8 | 8 | 0 | **Y** | 0 |
| 5 | low-confidence spread 8/13 | 8 | 0 | **Y** | 0 |
| 6 | non-numeric mix (8×5 + 2×`?`) | 5 | 0 | N | **2** |
| 7 | single high outlier (9×3 + 1×21) | 3 | 1 | N | 0 |
| 8 | bimodal 2/13 (median on un-voted card) | 5 | 10 | N | 0 |
| 9 | tight consensus 21 / high conf | 21 | 0 | N | 0 |
| 10 | asymmetric tail (7×5, 2×8, 1×13) | 5 | 1 | N | 0 |
| 11 | low-confidence consensus on 2 | 2 | 0 | **Y** | 0 |
| 12 | mixed realistic (4×5, 3×8, 2×3, 1×13) | 5 | 1 | N | 0 |

## Assertions — results

**All held.** 353 assertions per run, green across repeated runs.

- **No lost votes** — all 10 votes registered on every one of the 12 stories
  under the concurrent burst (`votes.length === 10` at every reveal).
- **Stats correct under load** — median / outlier-count / avg-confidence /
  lowConfidence / non-numeric count matched the seeded distribution on every
  story (independent hand-coded expectations AND the `computeRevealStats`
  oracle agreed with the server).
- **No ordering corruption** — no `votes_revealed` ever observed before all 10
  votes landed; reveal is gated on the DO reflecting all 10.
- **AA-1 under load** — **0 leaks.** With 10 concurrent casts per story, the
  host saw `0` `vote_value` pre-reveal and each voter saw **exactly one**
  `vote_value` (its own cast, matching value), never another voter's — across
  all 12 stories.
- **Idempotency under load** — re-firing voter 0's exact envelope `id` with a
  mutated payload (story 1) was deduped: no new broadcast, stored vote
  unchanged (5-min `processed_message` window).
- **DO health** — responsive across all 12 stories; **zero** `ERROR` server
  messages to any socket; **zero** exceptions/errors in the wrangler log;
  clean teardown.

## Timing (representative run)

```
total loop: ~1.05 s over 12 stories
cast→all-10 latency:  min 30  avg 34  max 41  ms
reveal latency:       min  9  avg 10  max 11  ms
per-story duration:   min 60  avg 66  max 73  ms
drift story 1→12 (story duration): 72ms → 61ms  (no upward drift)
```

No latency drift story-to-story — the DO stays responsive from story 1 through
story 12. (An occasional single-story spike to ~200ms was seen on one run, a
scheduling/GC blip well within the failsafe; it did not recur or compound.)

## Issues surfaced

None. The DO survived the full at-capacity session cleanly. One loose thread
closed: the missing create-limit guard test (Step 1.2).

## How to re-run

```
pnpm -F @pointe/worker dev:e2e     # terminal 1: local stack on :8787
pnpm soak                          # terminal 2: the soak (exits 0 on pass)
```
