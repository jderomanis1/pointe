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

- **SI-01** Server is the sole source of identity — handlers trust only the socket's bound voterId, never a payload field.
- **SI-02** Role checks server-side on every privileged message.
- **SI-03** Voter cookie: HttpOnly, Secure, SameSite=Strict, scoped Path, Max-Age.
- **SI-04** Story text rendered as plain text (no `dangerouslySetInnerHTML`); external URLs `rel="noopener noreferrer"`.
- **SI-05** AI prompt-injection defense (S8): story text as user message, `externalUrl` never sent.
- **SI-06** Rate limiting at every external surface (§1).
