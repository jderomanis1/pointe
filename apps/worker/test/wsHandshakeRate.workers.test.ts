/**
 * SI-06 WS handshake rate — re-verified against REAL Cloudflare DO SQLite.
 *
 * This is the proof file for the @cloudflare/vitest-pool-workers harness
 * (Phase 1 of the test-migration). It runs in workerd against the real
 * DurableObjectStorage SQLite, which is where `.one()` actually throws on
 * zero rows. The previous better-sqlite3 mock silently returned undefined
 * on zero rows and hid the original WS-rate bug; this file is the standing
 * regression that catches a regression to that shape.
 *
 * S8.ii.b: the temporary X-RL-* diagnostic headers have been removed from
 * the production response (SI-06 is verified enforcing). Tests now read
 * `ws_handshake_rate` directly via runInDurableObject for the count when
 * an assertion needs it. Status code (101 vs 429) covers the rate-trip.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';

// The Env shape isn't auto-typed in this repo; cast loosely. The pool reads
// the bindings from wrangler.toml at runtime.
const ROOM = (env as { ROOM: DurableObjectNamespace }).ROOM;

const RL_WS_PER_MIN = 30;

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

describe('WS handshake rate — real DO SQLite (Workers pool)', () => {
  it('first call in a fresh window does not throw (zero-row case) and counts to 1', async () => {
    // This is the exact case the prior SELECT-then-INSERT pattern blew up
    // on: zero rows + .one() = throw in real DO SQLite. The upsert-returning
    // shape sidesteps the SELECT, so the first call must succeed and persist
    // count=1. If this regresses, future bugs of this shape are caught.
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

  it('trips at exactly the 31st handshake for one IP (status climbs 101×30 then 429; row count = 31)', async () => {
    const id = ROOM.idFromName('rate-trip');
    const stub = ROOM.get(id);
    await ensureRoom(stub);

    for (let i = 1; i <= RL_WS_PER_MIN; i++) {
      const res = await stub.fetch(wsReq('1.2.3.4'));
      await res.arrayBuffer();
      expect(res.status).toBe(101);
    }

    const res31 = await stub.fetch(wsReq('1.2.3.4'));
    expect(res31.status).toBe(429);
    expect(res31.headers.get('Retry-After')).toBe('60');
    const body = (await res31.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMITED');

    // The DO row is the source of truth for the count progression.
    await runInDurableObject(stub, async (_inst, state) => {
      const row = state.storage.sql
        .exec<{ count: number }>(`SELECT count FROM ws_handshake_rate WHERE ip = '1.2.3.4'`)
        .toArray()[0];
      expect(row.count).toBe(31); // 30 allowed + 1 over → still increments
    });
  });

  it('two different IPs are independent (per-IP scope is structural)', async () => {
    const id = ROOM.idFromName('rate-per-ip');
    const stub = ROOM.get(id);
    await ensureRoom(stub);

    // Burn 1.1.1.1's budget.
    for (let i = 0; i < RL_WS_PER_MIN; i++) {
      const res = await stub.fetch(wsReq('1.1.1.1'));
      await res.arrayBuffer();
    }
    const overA = await stub.fetch(wsReq('1.1.1.1'));
    await overA.arrayBuffer();
    expect(overA.status).toBe(429);

    // 2.2.2.2 has full budget — independent bucket.
    const okB = await stub.fetch(wsReq('2.2.2.2'));
    await okB.arrayBuffer();
    expect(okB.status).toBe(101);
    await runInDurableObject(stub, async (_inst, state) => {
      const row = state.storage.sql
        .exec<{ count: number }>(`SELECT count FROM ws_handshake_rate WHERE ip = '2.2.2.2'`)
        .toArray()[0];
      expect(row.count).toBe(1);
    });
  });

  it('window rollover: crossing a minute boundary resets the counter for the new bucket', async () => {
    // The implementation deletes stale rows (window_start < current) then
    // upserts at the current windowStart. We simulate the minute crossing
    // by force-aging the row to the previous bucket via direct SQL — the
    // next handshake lands in the new minute, so the count restarts at 1.
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
      // Sanity: the aged row is the only one.
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
