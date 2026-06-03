import { describe, it, expect, vi } from 'vitest';
import { checkHourlyIpLimit, clientIp } from '../src/rateLimit';
import { createMockKv } from './helpers/mockKv';

describe('clientIp', () => {
  it('returns CF-Connecting-IP when present', () => {
    const req = new Request('https://x/', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
    expect(clientIp(req)).toBe('1.2.3.4');
  });

  it("returns 'unknown' when CF-Connecting-IP is absent", () => {
    expect(clientIp(new Request('https://x/'))).toBe('unknown');
  });
});

describe('checkHourlyIpLimit — fixed-window KV counter', () => {
  it('allows requests under the limit; the (limit+1)th is rejected', async () => {
    const kv = createMockKv();
    for (let i = 0; i < 3; i++) {
      expect(await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 3)).toBe(true);
    }
    expect(await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 3)).toBe(false);
  });

  it('per-IP isolation: hitting the cap on one IP does not block another', async () => {
    const kv = createMockKv();
    expect(await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 1)).toBe(true);
    expect(await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 1)).toBe(false);
    expect(await checkHourlyIpLimit(kv, 'create', '2.2.2.2', 1)).toBe(true);
  });

  it('per-action isolation: hitting the create cap does not block lookups', async () => {
    const kv = createMockKv();
    expect(await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 1)).toBe(true);
    expect(await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 1)).toBe(false);
    expect(await checkHourlyIpLimit(kv, 'lookup', '1.1.1.1', 1)).toBe(true);
  });

  it('crossing the hour boundary resets the bucket', async () => {
    vi.useFakeTimers();
    try {
      // Bucket A.
      vi.setSystemTime(new Date('2026-06-03T10:00:00Z').getTime());
      expect(await checkHourlyIpLimit(createMockKv(), 'create', '1.1.1.1', 1)).toBe(true);

      // Fresh KV; fill bucket A to the cap.
      const kv = createMockKv();
      expect(await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 1)).toBe(true);
      expect(await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 1)).toBe(false);

      // Bucket B (next hour) — capped IP can request again because the key is bucket-scoped.
      vi.setSystemTime(new Date('2026-06-03T11:00:01Z').getTime());
      expect(await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes the counter with a 2h TTL (self-cleaning)', async () => {
    const kv = createMockKv();
    const putSpy = vi.spyOn(kv, 'put');
    await checkHourlyIpLimit(kv, 'create', '1.1.1.1', 5);
    expect(putSpy).toHaveBeenCalledTimes(1);
    const [, , opts] = putSpy.mock.calls[0];
    expect(opts).toEqual({ expirationTtl: 7_200 });
  });

  it('counter key carries the action, IP, and hour bucket', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-03T10:30:00Z').getTime());
      const kv = createMockKv();
      const putSpy = vi.spyOn(kv, 'put');
      await checkHourlyIpLimit(kv, 'create', '9.9.9.9', 100);
      const [key] = putSpy.mock.calls[0];
      // bucket = floor(epoch_ms / 3_600_000) for the timestamp above.
      const bucket = Math.floor(new Date('2026-06-03T10:30:00Z').getTime() / 3_600_000);
      expect(key).toBe(`rl:create:9.9.9.9:${bucket}`);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- Handler-level integration ----

import worker from '../src/worker';
import type { Env } from '../src/worker';
import { createMockRateLimit } from './helpers/mockKv';

function makeEnv(opts: { wsSuccess?: boolean } = {}): {
  env: Env;
  kv: ReturnType<typeof createMockKv>;
  rl: ReturnType<typeof createMockRateLimit>;
} {
  const kv = createMockKv();
  const rl = createMockRateLimit({ success: opts.wsSuccess ?? true });
  const env = {
    ROOM: {
      // Just enough surface for the handlers that 429 BEFORE they touch the DO.
      idFromName: (_n: string) => ({ name: _n }),
      get: (_id: unknown) => ({ fetch: async () => new Response('{}', { status: 500 }) }),
    } as unknown as Env['ROOM'],
    POINTE_SLUGS: kv,
    WS_HANDSHAKE_LIMITER: rl.binding as unknown as Env['WS_HANDSHAKE_LIMITER'],
  };
  return { env, kv, rl };
}

const CTX = {} as unknown as ExecutionContext;
const IP = { 'CF-Connecting-IP': '7.7.7.7' };

describe('SI-06 handler integration — POST /api/rooms', () => {
  it('returns 429 once the create budget is spent for that IP', async () => {
    const { env, kv } = makeEnv();
    // Pre-fill the bucket to the cap (20) for this IP — direct KV puts so
    // we don't actually create 20 rooms.
    const bucket = Math.floor(Date.now() / 3_600_000);
    await kv.put(`rl:create:7.7.7.7:${bucket}`, '20', { expirationTtl: 7_200 });

    const req = new Request('https://pointe.team/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...IP },
      body: JSON.stringify({ hostDisplayName: 'X' }),
    });
    const res = await worker.fetch(req, env, CTX);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    const body = await res.json() as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
  });
});

describe('SI-06 handler integration — GET /api/rooms/:slug (lookup)', () => {
  it('returns 429 once the lookup budget is spent for that IP', async () => {
    const { env, kv } = makeEnv();
    const bucket = Math.floor(Date.now() / 3_600_000);
    await kv.put(`rl:lookup:7.7.7.7:${bucket}`, '200', { expirationTtl: 7_200 });

    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16', { headers: IP });
    const res = await worker.fetch(req, env, CTX);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });
});

describe('SI-06 handler integration — GET /api/rooms/:slug/ws (WS handshake)', () => {
  it('binding success=false → 429, no upgrade attempted', async () => {
    const { env, rl } = makeEnv({ wsSuccess: false });
    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
      headers: { Upgrade: 'websocket', ...IP },
    });
    const res = await worker.fetch(req, env, CTX);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(rl.calls).toEqual([{ key: '7.7.7.7' }]);
  });

  it('binding success=true → proceeds past the limiter (does NOT short-circuit to 429)', async () => {
    const { env, rl } = makeEnv({ wsSuccess: true });
    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
      headers: { Upgrade: 'websocket', ...IP },
    });
    const res = await worker.fetch(req, env, CTX);
    expect(res.status).not.toBe(429);
    expect(rl.calls).toEqual([{ key: '7.7.7.7' }]);
  });

  it('the /ws path does NOT consume the lookup budget (matched before getRoomEndpoint)', async () => {
    const { env, kv } = makeEnv({ wsSuccess: true });
    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
      headers: { Upgrade: 'websocket', ...IP },
    });
    await worker.fetch(req, env, CTX);
    // No rl:lookup:... key was written.
    const bucket = Math.floor(Date.now() / 3_600_000);
    expect(kv.__dump().get(`rl:lookup:7.7.7.7:${bucket}`)).toBeUndefined();
  });
});

