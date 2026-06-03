import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { Room } from '../src/room';
import { createMockDoState } from './helpers/mockDoState';
import type { Env } from '../src/worker';
import { RL_WS_PER_MIN } from '../src/rateLimit';

// WebSocketPair is a Cloudflare runtime global; stub minimally. The Node
// Response constructor doesn't accept the { webSocket } init field, so the
// 101 success path throws after the rate-limit check and ends up at the DO
// fetch try/catch as a 500. That's fine — these tests assert the rate-limit
// GATE (429 vs not-429), not the upgrade machinery, which is exercised live
// on Cloudflare's runtime.
beforeAll(() => {
  (globalThis as Record<string, unknown>).WebSocketPair = function () {
    const fake = {};
    return { 0: fake, 1: fake } as unknown as Record<string, unknown>;
  };
});

function makeRoom() {
  const state = createMockDoState();
  Object.assign(state, { acceptWebSocket: () => {} });
  return { state, room: new Room(state as unknown as DurableObjectState, {} as Env) };
}

function wsRequest(ip: string | null) {
  const headers = new Headers({ Upgrade: 'websocket' });
  if (ip !== null) headers.set('X-Client-IP', ip);
  return new Request('https://do/ws', { method: 'GET', headers });
}

const IP = '7.7.7.7';

describe('SI-06 — DO atomic per-IP/room WS handshake rate', () => {
  it('30 handshakes from one IP pass the limiter; the 31st returns 429 RATE_LIMITED + Retry-After:60', async () => {
    const { room } = makeRoom();
    for (let i = 0; i < RL_WS_PER_MIN; i++) {
      const res = await room.fetch(wsRequest(IP));
      // Anything other than 429 means the rate-limit check passed (the
      // downstream WebSocketPair stub returns 500, which is fine for this
      // assertion).
      expect(res.status).not.toBe(429);
    }
    const res31 = await room.fetch(wsRequest(IP));
    expect(res31.status).toBe(429);
    expect(res31.headers.get('Retry-After')).toBe('60');
    const body = await res31.json() as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
  });

  it('new minute bucket: counter resets, handshakes pass the limiter again', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-03T10:00:30Z').getTime());
      const { room } = makeRoom();
      for (let i = 0; i < RL_WS_PER_MIN; i++) {
        expect((await room.fetch(wsRequest(IP))).status).not.toBe(429);
      }
      expect((await room.fetch(wsRequest(IP))).status).toBe(429);
      vi.setSystemTime(new Date('2026-06-03T10:01:30Z').getTime());
      expect((await room.fetch(wsRequest(IP))).status).not.toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two distinct IPs are independent', async () => {
    const { room } = makeRoom();
    for (let i = 0; i < RL_WS_PER_MIN; i++) {
      expect((await room.fetch(wsRequest('1.1.1.1'))).status).not.toBe(429);
    }
    expect((await room.fetch(wsRequest('1.1.1.1'))).status).toBe(429);
    expect((await room.fetch(wsRequest('2.2.2.2'))).status).not.toBe(429);
  });

  it('missing X-Client-IP attributes to "unknown" (defensive — Worker always sets it)', async () => {
    const { room } = makeRoom();
    for (let i = 0; i < RL_WS_PER_MIN; i++) {
      expect((await room.fetch(wsRequest(null))).status).not.toBe(429);
    }
    expect((await room.fetch(wsRequest(null))).status).toBe(429);
  });

  it('table is DO-local: a fresh Room instance starts with a clean counter', async () => {
    const a = makeRoom();
    for (let i = 0; i < RL_WS_PER_MIN; i++) await a.room.fetch(wsRequest(IP));
    expect((await a.room.fetch(wsRequest(IP))).status).toBe(429);
    const b = makeRoom();
    expect((await b.room.fetch(wsRequest(IP))).status).not.toBe(429);
  });

  it('self-cleans stale rows on each call (no unbounded table growth)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-03T10:00:30Z').getTime());
      const { state, room } = makeRoom();
      await room.fetch(wsRequest(IP));
      vi.setSystemTime(new Date('2026-06-03T10:01:30Z').getTime());
      await room.fetch(wsRequest(IP));
      const rows = state.storage.sql
        .exec<{ window_start: number }>(`SELECT window_start FROM ws_handshake_rate`)
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].window_start).toBe(Math.floor(Date.now() / 60_000) * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
