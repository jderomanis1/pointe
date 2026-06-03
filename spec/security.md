# Pointe — Security Model

**Status:** v1. SI-06 (rate limiting) implemented S7. SI-01–04 audited S7. SI-05 + AI per-room limit land S8 (they exist only when AI exists).

## 1. Rate limiting (SI-06)

Three external surfaces, keyed on `CF-Connecting-IP`. **One uniform mechanism: KV fixed-window counter** under the `rl:` prefix of `POINTE_SLUGS`.

| Surface | Limit | Window | KV key shape |
|---|---|---|---|
| WS handshake (`GET /api/rooms/:slug/ws`) | 30 | 1 minute | `rl:ws:<ip>:<floor(now/60s)>` |
| Room create (`POST /api/rooms`) | 20 | 1 hour | `rl:create:<ip>:<floor(now/3600s)>` |
| Slug lookup (`GET /api/rooms/:slug`) | 200 | 1 hour | `rl:lookup:<ip>:<floor(now/3600s)>` |

TTL is `2 × window` (covers slop for in-flight requests crossing the boundary), clamped to KV's 60s minimum.

### Why one mechanism (and not the Workers `ratelimit` binding)

The binding was considered for the per-minute WS handshake and rejected. Its counters are per-edge-location and async-updated — designed for cheap throttling at scale, not for deterministic enforcement at small scale. Prod probing after the first deploy showed it allowed 35 sequential handshakes through without a single 429; consistent with "working but loose", and disqualifying for a verifiable security control. Switching all three surfaces to the same KV counter makes the mechanism uniform, unit-testable end-to-end, and prod-verifiable with the same sequential probe at every surface.

Documented to keep the binding from being re-introduced as an "optimization" later. v1.5 may revisit when the scale + observability story changes.

### KV-non-atomic caveat (applies uniformly)

The KV counter is `get → check → put` and not atomic; a racing burst can slip 2–3 past the cap. That's fine: this is an abuse ceiling, not exact accounting. A DO-backed counter would buy precision we don't need at the cost of a per-request hop. Fixed window (not sliding) accepts a ~2× boundary burst — fine for a ceiling. Counters reuse the `POINTE_SLUGS` KV namespace under the `rl:` prefix; slug ops are point get/put with no list, so no collision. A dedicated namespace is a future cleanup if ever needed.

### The WS limit is a reinterpretation (unchanged)

Spec originally said **"10 concurrent WS / IP"** — a *concurrency* cap. v1 implements a **handshake rate** (30/min/IP) instead. True concurrency capping needs per-IP open-socket counting *across* rooms, but each room is a separate Durable Object with no global view; a dedicated per-IP limiter DO would need decrement-on-close, and a missed close strands the count and locks a legitimate IP out. The handshake rate catches the real abuse pattern (socket spam) without that fragility. **True concurrency capping is v1.5 work.** This is a deliberate, documented v1 choice.

The 30/min handshake value is a defensible start (~15× normal use); tunable post-launch from real patterns, not a v1 fine-tune. The per-hour numbers (20, 200) are locked from spec.

## 2. Security invariants

Verified 2026-06-03. SI-01–04 audited with code evidence; non-host regression coverage added where it was missing. SI-05 lands with S8.

- **SI-01 — server is the sole source of identity.** ENFORCED.
  - `dispatcher.ts:93` seeds `ctx.voterId` from `getAttachment(ws)?.voterId ?? null` only. Every handler reads identity from `ctx.voterId`; no handler reads a payload field as the actor's identity. `TRANSFER_HOST`'s `newHostVoterId` payload field is the *target* of the transfer — the actor's authority is still `requireHost(ctx)` against the bound id.
- **SI-02 — role checks server-side on every privileged message.** ENFORCED.
  - Host-only handlers, each citing `requireHost(ctx)` ahead of any mutation: `ADD_STORY` (dispatcher.ts:155), `EDIT_STORY` (dispatcher.ts:181), `OPEN_VOTING` incl. revealed→active re-open (dispatcher.ts:206), `REVEAL_VOTES` (dispatcher.ts:284), `COMMIT_STORY` (dispatcher.ts:312), `SKIP_STORY` (dispatcher.ts:354), `SPLIT_STORY` (dispatcher.ts:331), `TRANSFER_HOST` (dispatcher.ts:488).
  - `VOTE_CAST` is voter-level with a spectator restriction at the operation layer (`operations.ts:432` throws `SPECTATOR_CANNOT_VOTE`).
  - `CLAIM_HOST` is deliberately state-gated rather than host-gated (dispatcher.ts:441–474): `NOT_JOINED` if the socket isn't bound, `state !== 'host_vacant'` short-circuits with a direct-reply `HOST_RECLAIMED` naming the actual host (first-valid-wins), and the claimer must exist via `getVoterById`. Per the host-lifecycle design, any connected, non-`left` participant may claim during vacancy; the connected check is implicit through the JOIN flow (a JOINed socket has `connection_state='connected'`).
  - `RECONNECT_PING` and `JOIN_ROOM` are correctly not host-gated.
  - **Gap found**: `EDIT_STORY` had no non-host regression test. Fixed in this commit (`dispatcher.test.ts:321+` — voter sender ⇒ `NOT_HOST`, story text unchanged, no broadcast, no dedupe row).
- **SI-03 — voter cookie properties.** ENFORCED.
  - `worker.ts:57–60` builds `pointe_session=<hostVoterId>; HttpOnly; Secure; SameSite=Strict; Path=/api/rooms/<slug>; Max-Age=86400`. Set at `worker.ts:122` on the `POST /api/rooms` 201 response. Attributes locked by `worker.test.ts` (SI-03 suite, 2 cases).
- **SI-04 — no injection surface.** ENFORCED.
  - Zero `dangerouslySetInnerHTML` in `apps/web/src/` (the two mentions are doc comments explaining their absence in `LongText.tsx` and `SplitForm.tsx`).
  - Rendered story fields: `text` and `description` through `<LongText/>` (escaped React strings), `externalId` through `{story.externalId}` (escaped). Escape-correctness locked by `Commit.test.tsx` (LongText `<img onerror=…>` test) and `Split.test.tsx` (form-input `<img onerror=…>` test).
  - **Note**: `Story.externalUrl` exists in `@pointe/shared` but **no UI renders it as a link today** — there are zero `<a>` tags in `apps/web/src/`. The "external URLs `rel="noopener noreferrer"`" clause is vacuously satisfied for v1; when a future iteration adds link rendering, that surface must carry the rel attributes (and a test).
- **SI-05** AI prompt-injection defense (S8): story text as user message, `externalUrl` never sent.
- **SI-06** Rate limiting at every external surface (§1).
