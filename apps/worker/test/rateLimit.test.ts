import { describe, it, expect, vi } from 'vitest';
import { checkWindowedIpLimit, clientIp, HOUR_MS } from '../src/rateLimit';
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

describe('checkWindowedIpLimit — KV fixed-window counter (hourly surfaces only)', () => {
  it('allows under the limit; the (limit+1)th is rejected', async () => {
    const kv = createMockKv();
    for (let i = 0; i < 3; i++) {
      expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 3, HOUR_MS)).toBe(true);
    }
    expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 3, HOUR_MS)).toBe(false);
  });

  it('per-IP isolation', async () => {
    const kv = createMockKv();
    expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 1, HOUR_MS)).toBe(true);
    expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 1, HOUR_MS)).toBe(false);
    expect(await checkWindowedIpLimit(kv, 'create', '2.2.2.2', 1, HOUR_MS)).toBe(true);
  });

  it('per-action isolation: create cap does not block lookup', async () => {
    const kv = createMockKv();
    expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 1, HOUR_MS)).toBe(true);
    expect(await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 1, HOUR_MS)).toBe(false);
    expect(await checkWindowedIpLimit(kv, 'lookup', '1.1.1.1', 1, HOUR_MS)).toBe(true);
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

  it('TTL is 2× the window, clamped to KV minimum 60s', async () => {
    const kv = createMockKv();
    const putSpy = vi.spyOn(kv, 'put');
    await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 5, HOUR_MS);
    expect(putSpy.mock.calls[0][2]).toEqual({ expirationTtl: 7_200 });
    // Sub-60s window would clamp to 60.
    await checkWindowedIpLimit(kv, 'create', '1.1.1.1', 5, 10_000);
    expect(putSpy.mock.calls[1][2]).toEqual({ expirationTtl: 60 });
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
  let lastSeenIp: string | null = null;
  const env = {
    ROOM: {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({
        fetch: async (req: Request) => {
          // Record what the Worker forwarded; the DO would then enforce the
          // per-IP/min limit using this value. The DO's own enforcement is
          // covered by wsHandshakeRate.test.ts; this handler test only verifies
          // the Worker correctly sets the trusted IP header.
          lastSeenIp = req.headers.get('X-Client-IP');
          return new Response(null, { status: 101 });
        },
      }),
    } as unknown as Env['ROOM'],
    POINTE_SLUGS: kv,
  };
  return {
    env: Object.assign(env, { __lastSeenIp: () => lastSeenIp }) as Env,
    kv,
  };
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
    expect((await res.json() as { code: string }).code).toBe('RATE_LIMITED');
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

describe('SI-06 — Worker IP forwarding for the WS path', () => {
  // The WS limit moved to the DO. The Worker's job is to forward the trusted
  // CF-Connecting-IP and stop a client from spoofing it.
  // (Lookup mock requires a real slug; these tests stub the DO stub to inspect
  //  the forwarded header rather than running the real lookup.)
  function wsEnv(): { env: Env; getForwardedIp: () => string | null } {
    let lastSeenIp: string | null = null;
    const kv = createMockKv();
    // Seed a fake slug so lookupSlug resolves and the request reaches the DO stub.
    kv.put('apt-sparrow-16', 'room-id-1', { expirationTtl: 86_400 });
    const env = {
      ROOM: {
        idFromName: (n: string) => ({ name: n }),
        get: () => ({
          fetch: async (req: Request) => {
            lastSeenIp = req.headers.get('X-Client-IP');
            return new Response(null, { status: 101 });
          },
        }),
      } as unknown as Env['ROOM'],
      POINTE_SLUGS: kv,
    };
    return { env, getForwardedIp: () => lastSeenIp };
  }

  it('sets X-Client-IP from CF-Connecting-IP when forwarding to the DO', async () => {
    const { env, getForwardedIp } = wsEnv();
    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
      headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '3.3.3.3' },
    });
    await worker.fetch(req, env, CTX);
    expect(getForwardedIp()).toBe('3.3.3.3');
  });

  it('OVERRIDES a client-supplied X-Client-IP (spoof-resistance — SI-01-adjacent)', async () => {
    const { env, getForwardedIp } = wsEnv();
    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
      headers: {
        Upgrade: 'websocket',
        'CF-Connecting-IP': '3.3.3.3',
        'X-Client-IP': '9.9.9.9', // attacker's spoof attempt
      },
    });
    await worker.fetch(req, env, CTX);
    // The Worker MUST set X-Client-IP from CF-Connecting-IP, replacing the spoof.
    expect(getForwardedIp()).toBe('3.3.3.3');
  });

  it('the /ws path writes no rl:ws or rl:lookup KV keys (WS limiting moved to DO)', async () => {
    const { env } = wsEnv();
    const kv = (env as unknown as { POINTE_SLUGS: ReturnType<typeof createMockKv> }).POINTE_SLUGS;
    const before = kv.__dump().size;
    const req = new Request('https://pointe.team/api/rooms/apt-sparrow-16/ws', {
      headers: { Upgrade: 'websocket', ...IP },
    });
    await worker.fetch(req, env, CTX);
    const writtenKeys = [...kv.__dump().keys()].filter((k) => k.startsWith('rl:'));
    expect(writtenKeys).toEqual([]);
    // Sanity: no other keys appeared either (the seeded slug:* aside).
    expect(kv.__dump().size).toBe(before);
  });
});
