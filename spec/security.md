# Pointe — Security Model

**Status:** v1. SI-06 (rate limiting) implemented S7. SI-01–04 audited S7. SI-05 + AI per-room limit land S8 (they exist only when AI exists).

## 1. Rate limiting (SI-06)

Three external surfaces, keyed on `CF-Connecting-IP`:

| Surface | Limit | Mechanism |
|---|---|---|
| WS handshake (`GET /api/rooms/:slug/ws`) | 30 / min / IP | Workers `ratelimit` binding (`limit:30, period:60`) |
| Room create (`POST /api/rooms`) | 20 / hr / IP | KV fixed-window counter |
| Slug lookup (`GET /api/rooms/:slug`) | 200 / hr / IP | KV fixed-window counter |

### Why two mechanisms (deliberate, not accidental)

The `ratelimit` binding's window **must be 10 or 60 seconds** — nothing longer. It cannot express a per-hour limit. Forcing "20/hr" into a 60s window would silently become ~1/min and trip legitimate bursts. So:

- The binding handles the **per-minute** WS handshake (its strength: short-window flood control, platform-counted, no race).
- A **KV fixed-window counter** (`rl:<action>:<ip>:<floor(now/3600s)>`, 2 h TTL) handles the **per-hour** budgets, which the binding can't.

Tool-to-problem. Both live in git; both are unit-tested. KV (not a DO) by choice: no atomic increment means an attacker could slip 2–3 past an hour cap — irrelevant for an abuse ceiling; a DO's per-request hop isn't worth precision that doesn't matter at this scale. Fixed window (not sliding) accepts a ~2× hour-boundary burst — fine for a ceiling. Counters reuse the `POINTE_SLUGS` KV namespace under an `rl:` prefix (slug ops are point get/put, no list — no collision); a dedicated namespace is a future cleanup if ever needed.

### The WS limit is a reinterpretation

Spec originally said **"10 concurrent WS / IP"** — a *concurrency* cap. v1 implements a **handshake rate** (30/min/IP) instead. Reason: true concurrency capping needs per-IP open-socket counting *across* rooms, but each room is a separate Durable Object with no global view; a dedicated per-IP limiter DO would need decrement-on-close, and a missed close strands the count and locks a legitimate IP out. The handshake rate catches the real abuse pattern (socket spam) without that fragility. **True concurrency capping is v1.5 work.** This is a deliberate, documented v1 choice.

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
