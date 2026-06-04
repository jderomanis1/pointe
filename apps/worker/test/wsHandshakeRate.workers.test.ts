/**
 * SI-06 WS handshake rate — re-verified against REAL Cloudflare DO SQLite.
 *
 * This file holds the standing regression that catches the prior
 * SELECT-then-`.one()` shape (zero rows + `.one()` = throw on real DO
 * SQLite). The upsert-returning shape sidesteps it; the integration
 * "first call in a fresh window" test below is the trip-wire.
 *
 * S9 fix (pre-existing minute-rollover flake): the trip-at-31 + per-IP
 * independence assertions are now driven by the pure
 * `checkWsHandshakeRate(sql, { ip, now })` helper through
 * `runInDurableObject`, with a deterministic `now` pinned to a single
 * window. The DO `room.fetch('/ws')` wrapper is exercised by the
 * boundary-robust integration smoke test (single handshake → 101; the
 * zero-row regression check). Replaces the prior 31-stub.fetch loop
 * whose result depended on where in the wall-clock minute it ran — that
 * is the S7 rate-limit saga's lesson resurfacing: a counter test whose
 * assertion depends on wall-clock alignment is untrustworthy CI.
 *
 * S8.ii.b note retained for context: the temporary X-RL-* diagnostic
 * headers have been removed from the production response (SI-06 is
 * verified enforcing). Tests read `ws_handshake_rate` directly via
 * `runInDurableObject` for the count when an assertion needs it. Status
 * code (101 vs 429) covers the rate-trip end-to-end.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import { checkWsHandshakeRate, MINUTE_MS, RL_WS_PER_MIN } from '../src/rateLimit';

const ROOM = (env as { ROOM: DurableObjectNamespace }).ROOM;

function wsReq(ip: string): Request {
  return new Request('https://do/ws', {
    headers: { Upgrade: 'websocket', 'X-Client-IP': ip },
  });
}

/** Force schema init by hitting /state once. Cheap, idempotent. */
async function ensureRoom(stub: DurableObjectStub): Promise<void> {
  // /init demands a real room body; /state just runs initSchema then returns
  // ROOM_NOT_FOUND, which is fine — the table we care about exists by then.
  const res = await stub.fetch(new Request('https://do/state'));
  await res.arrayBuffer(); // consume body — pool requirement
}

describe('WS handshake rate — integration: zero-row regression (deterministic, single handshake)', () => {
  it('first call in a fresh window does not throw (zero-row case) and counts to 1', async () => {
    // This is the exact case the prior SELECT-then-INSERT pattern blew up
    // on: zero rows + .one() = throw in real DO SQLite. The upsert-returning
    // shape sidesteps the SELECT, so the first call must succeed and persist
    // count=1. If this regresses, future bugs of this shape are caught.
    //
    // Deterministic — a single handshake within a minute can't span a
    // boundary. The 31-handshake loop that DID span boundaries is now a
    // unit test against the pure helper (below).
    const id = ROOM.idFromName('rate-fresh-window');
    const stub = ROOM.get(id);
    await ensureRoom(stub);

    const res = await stub.fetch(wsReq('10.0.0.1'));
    await res.arrayBuffer();
    expect(res.status).toBe(101);

    // Confirm via the real ctx.storage.sql — no mock between us and the row.
    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ ip: string; count: number }>(
          `SELECT ip, count FROM ws_handshake_rate WHERE ip = '10.0.0.1'`,
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(1);
    });
  });
});

// ---- Unit: trip-at-31 against the pure helper (deterministic, single window) ----

describe('checkWsHandshakeRate — trip logic (pure helper, fixed `now`)', () => {
  /**
   * The trip truth: 30 increments in window W → all within limit; the 31st
   * within W → over limit. The fix injects `now` so all 31 calls land in the
   * SAME window regardless of when CI runs. No wall-clock dependency.
   */
  it('trips at exactly the 31st handshake within ONE window (count climbs 1..30 untripped, 31 tripped)', async () => {
    const id = ROOM.idFromName('rate-helper-trip');
    const stub = ROOM.get(id);
    await ensureRoom(stub);

    // Pick an arbitrary window-aligned time. Math.floor zeroes any sub-minute
    // remainder; the choice is irrelevant — what matters is all 31 calls use it.
    const W = Math.floor(1_700_000_000_000 / MINUTE_MS) * MINUTE_MS;

    await runInDurableObject(stub, async (_inst, state) => {
      for (let i = 1; i <= RL_WS_PER_MIN; i++) {
        const r = checkWsHandshakeRate(state.storage.sql, { ip: '1.2.3.4', now: W });
        expect(r.count).toBe(i);
        expect(r.tripped).toBe(false);
      }
      // The 31st — over limit.
      const r31 = checkWsHandshakeRate(state.storage.sql, { ip: '1.2.3.4', now: W });
      expect(r31.count).toBe(31);
      expect(r31.tripped).toBe(true);
      expect(r31.windowStart).toBe(W);
    });
  });

  it('two different IPs are independent (per-IP scope is structural, fixed `now`)', async () => {
    const id = ROOM.idFromName('rate-helper-per-ip');
    const stub = ROOM.get(id);
    await ensureRoom(stub);
    const W = Math.floor(1_700_000_000_000 / MINUTE_MS) * MINUTE_MS;

    await runInDurableObject(stub, async (_inst, state) => {
      // Burn 1.1.1.1's budget.
      for (let i = 0; i < RL_WS_PER_MIN; i++) {
        checkWsHandshakeRate(state.storage.sql, { ip: '1.1.1.1', now: W });
      }
      const overA = checkWsHandshakeRate(state.storage.sql, { ip: '1.1.1.1', now: W });
      expect(overA.tripped).toBe(true);

      // 2.2.2.2 has full budget — independent bucket.
      const okB = checkWsHandshakeRate(state.storage.sql, { ip: '2.2.2.2', now: W });
      expect(okB.tripped).toBe(false);
      expect(okB.count).toBe(1);
    });
  });
});

// ---- The across-boundary determinism demonstration ----

/**
 * The exact case that flaked PR #23: the burst straddles a window boundary
 * (`Math.floor(now / 60_000) * 60_000` ticks over) and the impl's stale-row
 * DELETE nukes the count, so what was iteration 31 in the OLD window is
 * iteration 1 in the NEW window — `tripped: false`. With the pure helper
 * and a controlled `now`, we demonstrate this is correct production
 * behavior AND verify it doesn't sabotage the trip-at-31 truth: the truth
 * is about staying within a single window, not "31 calls trips no matter
 * what". The integration test that pretended otherwise is gone.
 *
 * This test passes because the helper makes the rollover a first-class
 * observable: the windowStart returned by the helper changes, and the
 * caller sees a fresh count.
 */
describe('checkWsHandshakeRate — across-boundary determinism (the flake, made non-flaky)', () => {
  it('30 increments at window W, then a 31st at W+60_000 → counter RESETS to 1 (correct production behavior)', async () => {
    const id = ROOM.idFromName('rate-helper-rollover-mid-burst');
    const stub = ROOM.get(id);
    await ensureRoom(stub);
    const W = Math.floor(1_700_000_000_000 / MINUTE_MS) * MINUTE_MS;
    const NEXT = W + MINUTE_MS;

    await runInDurableObject(stub, async (_inst, state) => {
      for (let i = 1; i <= RL_WS_PER_MIN; i++) {
        const r = checkWsHandshakeRate(state.storage.sql, { ip: '1.2.3.4', now: W });
        expect(r.count).toBe(i);
        expect(r.windowStart).toBe(W);
      }
      // The 31st call, but rolled into the NEXT window. Production behavior:
      // stale-row DELETE nukes the W bucket; UPSERT lands at NEXT, count=1.
      // This is precisely what flaked CI on PR #23 — the prior integration
      // test asserted `tripped` here. That assertion was wrong: production
      // SHOULD reset across the boundary; the rate cap is per-minute.
      const r31 = checkWsHandshakeRate(state.storage.sql, { ip: '1.2.3.4', now: NEXT });
      expect(r31.windowStart).toBe(NEXT);
      expect(r31.count).toBe(1);
      expect(r31.tripped).toBe(false);

      // And the W bucket is gone (stale-row DELETE).
      const rows = state.storage.sql
        .exec<{ window_start: number; count: number }>(
          `SELECT window_start, count FROM ws_handshake_rate WHERE ip = '1.2.3.4'`,
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].window_start).toBe(NEXT);
      expect(rows[0].count).toBe(1);
    });
  });

  it('trip-at-31 truth holds INSIDE one window even when a rollover happens immediately after (the 31st at W trips; subsequent at W+60_000 resets)', async () => {
    const id = ROOM.idFromName('rate-helper-trip-then-rollover');
    const stub = ROOM.get(id);
    await ensureRoom(stub);
    const W = Math.floor(1_700_000_000_000 / MINUTE_MS) * MINUTE_MS;
    const NEXT = W + MINUTE_MS;

    await runInDurableObject(stub, async (_inst, state) => {
      // All 31 within W → 31st trips.
      for (let i = 0; i < RL_WS_PER_MIN; i++) {
        checkWsHandshakeRate(state.storage.sql, { ip: '1.2.3.4', now: W });
      }
      const tripped = checkWsHandshakeRate(state.storage.sql, { ip: '1.2.3.4', now: W });
      expect(tripped.tripped).toBe(true);
      expect(tripped.count).toBe(31);

      // Roll into NEXT — the count for NEXT starts at 1, no trip.
      const fresh = checkWsHandshakeRate(state.storage.sql, { ip: '1.2.3.4', now: NEXT });
      expect(fresh.tripped).toBe(false);
      expect(fresh.count).toBe(1);
    });
  });
});

// ---- Boundary-robust integration test for the production wrapper ----

describe('WS handshake rate — integration: window rollover via direct SQL backdate', () => {
  /**
   * Pre-S9 test, kept verbatim. Already deterministic — it doesn't drive
   * across the real minute boundary, it back-dates the row by 60s in SQL
   * and checks the next handshake resets. Validates the
   * `window_start < currentWindow` DELETE path.
   */
  it('crossing a minute boundary resets the counter for the new bucket (stale-row DELETE path)', async () => {
    const id = ROOM.idFromName('rate-rollover');
    const stub = ROOM.get(id);
    await ensureRoom(stub);

    // Build up some count in the current bucket.
    for (let i = 0; i < 5; i++) {
      const res = await stub.fetch(wsReq('3.3.3.3'));
      await res.arrayBuffer();
    }

    // Age the row's window_start back one minute (still > 0, so the impl's
    // `window_start < currentWindow` DELETE catches it on the next call).
    await runInDurableObject(stub, async (_inst, state) => {
      state.storage.sql.exec(
        `UPDATE ws_handshake_rate SET window_start = window_start - 60000 WHERE ip = '3.3.3.3'`,
      );
      const rows = state.storage.sql
        .exec<{ count: number }>(`SELECT count FROM ws_handshake_rate WHERE ip = '3.3.3.3'`)
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(5);
    });

    // Next handshake: stale row gets DELETEd, fresh INSERT at current window.
    const res = await stub.fetch(wsReq('3.3.3.3'));
    await res.arrayBuffer();
    expect(res.status).toBe(101);

    // And the aged row is gone; only the new-bucket row remains.
    await runInDurableObject(stub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec<{ count: number }>(`SELECT count FROM ws_handshake_rate WHERE ip = '3.3.3.3'`)
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(1);
    });
  });
});
