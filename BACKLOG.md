# BACKLOG.md — Post-Reskin / Out-of-Scope Items

Items explicitly outside the v1.0 reskin scope. Log here instead of silently dropping.

---

## Server-side reconnect grace window

**Summary:** Hold `connectionState` in a `'reconnecting'` state for N seconds before writing
`'left'` on socket drop; emit a `voter_connection` delta so peers can render the `[× OFFLINE]`
persistent dim state from DESIGN_SPEC Section 3.3.

**Audit findings (confirmed 2025-07-22):**

- `ConnectionState = 'connected' | 'reconnecting' | 'left'` is defined in
  `packages/shared/src/types.ts:23`, but `'reconnecting'` is never written to the DB by the
  worker. Only two call sites write voter connection state:
  - `apps/worker/src/operations.ts:100` — writes `'connected'` on `JOIN_ROOM` / resume.
  - `apps/worker/src/room.ts:487` — writes `'left'` unconditionally on socket close/error.
- `webSocketClose` and `webSocketError` in `room.ts:288–301` both call
  `markGoneAndBroadcast(ws)` immediately with no delay. The transition is instant:
  socket drop → `connection_state = 'left'` in DB → `voter_left` broadcast to all peers.
- The `voter_connection` delta (`{ kind: 'voter_connection'; voterId; connectionState }`) is
  defined in `packages/shared/src/types.ts:328` and handled in the web reducer
  (`apps/web/src/store/reducer.ts:210`), but the worker dispatcher never emits it — it is dead
  letter server-side. No call site in `apps/worker/src/` constructs a `voter_connection` delta.
- There is no alarm type for voter reconnection timeout. The only relevant alarm is
  `host_vacant` (30s grace for the host, `room.ts:324`), which does not apply to regular voters.
- `'reconnecting'` appears only in `apps/web/src/ws/client.ts:122` as a client-local
  `ConnectionStatus` during WebSocket backoff before retrying. Client backoff caps at
  `maxBackoffMs = 15_000 ms`.

**What this unlocks:**
- `TableDeck.tsx`: the `connectionState === 'reconnecting'` branch (opacity-45, full hatch for
  voted cards) is already implemented and tested — it is currently dead code.
- `ParticipantRoster.tsx`: `[× OFFLINE]` row state (Section 3.3) can render persistently once
  the server emits `voter_connection` with `'reconnecting'`.
- DESIGN_SPEC Section 4.4 Redaction Fade: the 500ms collapse currently applies to `'left'` only;
  with a grace window, a genuine network drop would show `[× OFFLINE]` for N seconds, then
  collapse on explicit `'left'` or on timeout-escalation to `'left'`.

**Scope:** Touches Durable Object / worker code (`room.ts`, `operations.ts`, `dispatcher.ts`,
alarm scheduler). Explicitly out of v1.0 reskin scope. Increment 10's 500ms client-side
flush (brief [× OFFLINE] flash on `voter_left` receipt) is the minimum presentational
approximation achievable without this server change.

---

## Branch protection / process hardening

Require CI status check on main. Document manual E2E dispatch (`workflow_dispatch` on `e2e.yml`) as the explicit pre-merge step for any PR touching UI or WebSocket code. (E2E is deliberately excluded from `pull_request` triggers — see `.github/workflows/e2e.yml` comment.)

---
