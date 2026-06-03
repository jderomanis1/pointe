import { describe, it, expect, vi } from 'vitest';
import {
  checkWindowedIpLimit, clientIp, HOUR_MS, MINUTE_MS,
} from '../src/rateLimit';
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

describe('checkWindowedIpLimit — fixed-window KV counter', () => {
  it('hour window: allows under the limit; the (limit+1)th is rejected', async () => {
    const kv = createMockKv();
    for (let i = 0; i < 3; i++) {
      expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 3, HOUR_MS)).toBe(true);
    }
    expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 3, HOUR_MS)).toBe(false);
  });

  it('minute window: allows under the limit; the (limit+1)th is rejected', async () => {
    const kv = createMockKv();
    for (let i = 0; i < 3; i++) {
      expect(await checkWindowedIpLimit(kv, 'ws', '1.1.1.1', 3, MINUTE_MS)).toBe(true);
    }
    expect(await checkWindowedIpLimit(kv, 'ws', '1.1.1.1', 3, MINUTE_MS)).toBe(false);
  });

  it('per-IP isolation: hitting the cap on one IP does not block another', async () => {
    const kv = createMockKv();
    expect(await checkWindowedIpLimit(kv, 'ws', '1.1.1.1', 1, MINUTE_MS)).toBe(true);
    expect(await checkWindowedIpLimit(kv, 'ws', '1.1.1.1', 1, MINUTE_MS)).toBe(false);
    expect(await checkWindowedIpLimit(kv, 'ws', '2.2.2.2', 1, MINUTE_MS)).toBe(true);
  });

  it('per-action isolation: hitting the create cap does not block lookups or ws', async () => {
    const kv = createMockKv();
    expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 1, HOUR_MS)).toBe(true);
    expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 1, HOUR_MS)).toBe(false);
    expect(await checkWindowedIpLimit(kv, 'lookup', '1.1.1.1', 1, HOUR_MS)).toBe(true);
    expect(await checkWindowedIpLimit(kv, 'ws', '1.1.1.1', 1, MINUTE_MS)).toBe(true);
  });

  it('hour bucket rollover: capped IP can request again in the next hour', async () => {
    vi.useFakeTimers();
    try {
      const kv = createMockKv();
      vi.setSystemTime(new Date('2026-06-03T10:00:00Z').getTime());
      expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 1, HOUR_MS)).toBe(true);
      expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 1, HOUR_MS)).toBe(false);

      vi.setSystemTime(new Date('2026-06-03T11:00:01Z').getTime());
      expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 1, HOUR_MS)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('minute bucket rollover: capped IP can request again in the next minute', async () => {
    vi.useFakeTimers();
    try {
      const kv = createMockKv();
      vi.setSystemTime(new Date('2026-06-03T10:00:00Z').getTime());
      expect(await checkWindowedIpLimit(kv, 'ws', '1.1.1.1', 1, MINUTE_MS)).toBe(true);
      expect(await checkWindowedIpLimit(kv, 'ws', '1.1.1.1', 1, MINUTE_MS)).toBe(false);

      vi.setSystemTime(new Date('2026-06-03T10:01:01Z').getTime());
      expect(await checkWindowedIpLimit(kv, 'ws', '1.1.1.1', 1, MINUTE_MS)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTL is 2× the window (covers slop), clamped to KV minimum 60s', async () => {
    const kv = createMockKv();
    const putSpy = vi.spyOn(kv, 'put');

    await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 5, HOUR_MS);
    // First call → put with 2h TTL.
    expect(putSpy.mock.calls[0][2]).toEqual({ expirationTtl: 7_200 });

    await checkWindowedIpLimit(kv, 'ws', '1.1.1.1', 5, MINUTE_MS);
    // Minute window → 2 × 60s = 120s.
    expect(putSpy.mock.calls[1][2]).toEqual({ expirationTtl: 120 });
  });

  it('counter key carries action, IP, and the window-scoped bucket', async () => {
    vi.useFakeTimers();
    try {
      const t = new Date('2026-06-03T10:30:00Z').getTime();
      vi.setSystemTime(t);
      const kv = createMockKv();
      const putSpy = vi.spyOn(kv, 'put');

      await checkWindowedIpLimit(kv, 'create', '9.9.9.9', 100, HOUR_MS);
      expect(putSpy.mock.calls[0][0]).toBe(`rl:create:9.9.9.9:${Math.floor(t / HOUR_MS)}`);

      await checkWindowedIpLimit(kv, 'ws', '9.9.9.9', 100, MINUTE_MS);
      expect(putSpy.mock.calls[1][0]).toBe(`rl:ws:9.9.9.9:${Math.floor(t / MINUTE_MS)}`);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- Handler-level integration ----

import worker from '../src/worker';
import type { Env } from '../src/worker';

function makeEnv(): { env: Env; kv: ReturnType<typeof createMockKv> } {
  const kv = createMockKv();
  const env = {
    ROOM: {
      // The handlers we test all 429 BEFORE touching the DO.
      idFromName: (n: string) => ({ name: n }),
      get: (_id: unknown) => ({ fetch: async () => new Response('{}', { status: 500 }) }),
    } as unknown as Env['ROOM'],
    POINTE_SLUGS: kv,
  };
  return { env, kv };
}

const CTX = {} as unknown as ExecutionContext;
const IP = { 'CF-Connecting-IP': '7.7.7.7' };

describe('SI-06 handler integration — POST /api/rooms', () => {
  it('returns 429 once the create budget is spent for that IP', async () => {
    const { env, kv } = makeEnv();
    const bucket = Math.floor(Date.now() / HOUR_MS);
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
    const bucket = Math.floor(Date.now() / HOUR_MS);
    await kv.put(`rl:lookup:7.7.7.7:${bucket}`, '200', { expirationTtl: 7_200 });

    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16', { headers: IP });
    const res = await worker.fetch(req, env, CTX);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });
});

describe('SI-06 handler integration — GET /api/rooms/:slug/ws (WS handshake)', () => {
  it('returns 429 once the per-minute WS budget is spent for that IP', async () => {
    const { env, kv } = makeEnv();
    const minuteBucket = Math.floor(Date.now() / MINUTE_MS);
    await kv.put(`rl:ws:7.7.7.7:${minuteBucket}`, '30', { expirationTtl: 120 });

    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
      headers: { Upgrade: 'websocket', ...IP },
    });
    const res = await worker.fetch(req, env, CTX);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await res.json() as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
  });

  it('new minute bucket: a request after the rollover is allowed again', async () => {
    vi.useFakeTimers();
    try {
      const { env, kv } = makeEnv();
      vi.setSystemTime(new Date('2026-06-03T10:00:00Z').getTime());
      const bucketA = Math.floor(Date.now() / MINUTE_MS);
      await kv.put(`rl:ws:7.7.7.7:${bucketA}`, '30', { expirationTtl: 120 });

      // Same minute → 429.
      const req1 = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
        headers: { Upgrade: 'websocket', ...IP },
      });
      expect((await worker.fetch(req1, env, CTX)).status).toBe(429);

      // Next minute → past the limiter (room lookup downstream — irrelevant here).
      vi.setSystemTime(new Date('2026-06-03T10:01:01Z').getTime());
      const req2 = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
        headers: { Upgrade: 'websocket', ...IP },
      });
      const res = await worker.fetch(req2, env, CTX);
      expect(res.status).not.toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the /ws path writes rl:ws but NOT rl:lookup (upgrade is not double-counted as a lookup)', async () => {
    const { env, kv } = makeEnv();
    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
      headers: { Upgrade: 'websocket', ...IP },
    });
    await worker.fetch(req, env, CTX);
    const wsBucket = Math.floor(Date.now() / MINUTE_MS);
    const lookupBucket = Math.floor(Date.now() / HOUR_MS);
    // WS budget was charged.
    expect(kv.__dump().get(`rl:ws:7.7.7.7:${wsBucket}`)).toBe('1');
    // Lookup budget was NOT charged — the /ws path is matched before getRoomEndpoint.
    expect(kv.__dump().get(`rl:lookup:7.7.7.7:${lookupBucket}`)).toBeUndefined();
  });
});
