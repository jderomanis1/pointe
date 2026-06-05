# Pointe — Security Model

**Status:** v1. SI-06 (rate limiting) implemented S7. SI-01–04 audited S7. SI-05 + AI per-room limit land S8 (they exist only when AI exists).

## 1. Rate limiting (SI-06)

Three external surfaces, keyed on `CF-Connecting-IP`. **Two mechanisms, matched to window length** — KV for the long, low-write hourly limits; a Durable Object atomic counter for the short, bursty WS handshake.

| Surface | Limit | Scope | Window | Mechanism |
|---|---|---|---|---|
| Room create (`POST /api/rooms`) | 20 | per-IP | 1 hour | KV fixed-window (`rl:create:<ip>:<floor(now/3600s)>`) |
| Slug lookup (`GET /api/rooms/:slug`) | 200 | per-IP | 1 hour | KV fixed-window (`rl:lookup:<ip>:<floor(now/3600s)>`) |
| WS handshake (`GET /api/rooms/:slug/ws`) | 30 | per-IP, **per-room** | 1 minute | DO atomic counter (`ws_handshake_rate` SQLite table) |

KV TTL = `2 × window` (covers in-flight slop at bucket boundaries), clamped to KV's 60s minimum.

### Why two mechanisms — KV for hours, DO for the minute

KV serves the long, low-write windows well. It is **structurally wrong for a sub-minute window**: KV reads are cached per edge location for at least 30 seconds (default 60 s, no `cacheTtl: 0`), and KV's documented write rate is 1/second per key under sustained load. A 60-second budget that depends on observing in-window increments cannot survive a read cache equal to or longer than the window — the read keeps serving the value from the start of the minute, increments never become visible, and the limit never trips. Cloudflare's documented answer for strong-consistency counters is a Durable Object. The WS upgrade is already DO-routed (the room DO is the upgrade target), so the counter lives inside the request path it gates — atomic, no cache, no new hop, no new DO class. A new SQLite table `ws_handshake_rate (ip, window_start, count)` self-cleans stale rows on every check.

The Workers `ratelimit` binding was considered first and rejected. Its counters are per-edge-location and async-updated; prod probing showed it allowed 35 sequential handshakes through without a 429. Designed for cheap throttling at large scale, not for the small-scale deterministic enforcement we need at v1. Documented to keep it from being re-introduced as an "optimization."

### Per-IP, per-room WS scope — deliberate

The DO counter is scoped per-IP **within a room** rather than per-IP globally. This maps to the real threat: one IP hammering one room's sockets. Multi-room handshake spam stays bounded by the working KV hourly limits (20 creates + 200 lookups per IP per hour — you can't open a flood of WS without first paying those budgets to obtain valid slugs). A legitimate user on a flaky network only ever hits a limit scoped to their own room session, never lockout across rooms. A future cross-DO IP counter is v1.5 work; v1 doesn't need it.

### IP forwarding is the trust boundary

The Worker — the only external entry — reads `CF-Connecting-IP` and **sets** (overrides) `X-Client-IP` on the request it forwards to the DO. The DO is only reachable via the Worker, so an inbound client `X-Client-IP` header cannot reach the DO; the test suite asserts the spoof-attempt is overridden by the trusted value. This is SI-01 discipline applied to IP attribution.

### KV non-atomic caveat (hourly surfaces only)

The KV counter is `get → check → put` and not atomic; a racing burst can slip 2–3 past an hourly cap. Fine: these are abuse ceilings, not exact accounting. The DO counter for the WS handshake is fully atomic, so the same caveat does NOT apply there.

### The WS limit is a reinterpretation (unchanged)

Spec originally said **"10 concurrent WS / IP"** — a *concurrency* cap. v1 implements a **handshake rate** (30/min/IP, per-room) instead. True concurrency capping needs per-IP open-socket counting across rooms with decrement-on-close, and a missed close strands the count and locks a legitimate IP out. The handshake rate catches the real abuse pattern (socket spam) without that fragility. **True concurrency capping is v1.5 work.** Deliberate, documented v1 choice.

The 30/min handshake value is a defensible start (~15× normal use); tunable post-launch. The per-hour numbers (20, 200) are locked from spec.

## 1.5. WebSocket lifecycle — platform mechanism

### Server-initiated closes do NOT auto-fire `webSocketClose` on the DO

Discovered S10.iv (the `drop-voter-sockets` test harness). When the
Durable Object itself initiates a WS close — `ws.close(code, reason)`
from a `private` method, an internal route, anywhere on the DO side —
the workerd runtime does **not** call `webSocketClose(...)` back on the
parent class. The close handler is the runtime's signal that the *peer*
disconnected; when the DO is the initiator, the runtime treats the
state as "DO already knows" and elides the callback.

Consequence — any current or future DO-initiated close must run socket
+ voter cleanup explicitly rather than rely on the close event firing:

- **`drop-voter-sockets` test route (S10.iv)** — already correct: closes
  each socket AND calls `this.webSocketClose(sock, ...)` directly to run
  the production `markGoneAndBroadcast` + `voter_left` path. Documented
  inline as the faithfulness contract.
- **`KICK_VOTER` (v1.5)** — when shipped, the handler must mirror the
  same shape: close the socket, then invoke the close handler (or
  factor `markGoneAndBroadcast` out so both paths share it without the
  webSocketClose dance).
- **`CLOSE_ROOM` (v1.5)** — same as above for every socket in the room.

Same shelf as the "KV unfit for sub-minute windows" finding: a platform
mechanism that's true regardless of when the dependent feature ships,
so it lives in spec, not a per-sprint carry-forward list.

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
