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
 * If this is green, the upsert-returning fix from f4a99e4 is now verified
 * on the real runtime, not just the mock.
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
    expect(res.headers.get('X-RL-Count')).toBe('1');
    expect(res.headers.get('X-RL-IP')).toBe('10.0.0.1');

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

  it('trips at exactly the 31st handshake for one IP (X-RL-Count climbs 1..30, then 429 with X-RL-Count=31)', async () => {
    const id = ROOM.idFromName('rate-trip');
    const stub = ROOM.get(id);
    await ensureRoom(stub);

    const counts: string[] = [];
    for (let i = 1; i <= RL_WS_PER_MIN; i++) {
      const res = await stub.fetch(wsReq('1.2.3.4'));
      await res.arrayBuffer();
      expect(res.status).toBe(101);
      counts.push(res.headers.get('X-RL-Count') ?? '');
    }
    // Count progression is exactly 1..30, deterministic — atomic upsert.
    expect(counts).toEqual(
      Array.from({ length: RL_WS_PER_MIN }, (_, i) => String(i + 1)),
    );

    const res31 = await stub.fetch(wsReq('1.2.3.4'));
    expect(res31.status).toBe(429);
    expect(res31.headers.get('X-RL-Count')).toBe('31');
    expect(res31.headers.get('Retry-After')).toBe('60');
    const body = (await res31.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
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
    expect(okB.headers.get('X-RL-Count')).toBe('1');
  });
});
