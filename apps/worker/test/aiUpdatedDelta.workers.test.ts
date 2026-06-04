/**
 * S8.iii.c1 — host-only `ai_updated` DELTA on AI completion.
 *
 * Two guarantees verified end-to-end through the orchestrator wiring:
 *  (a) the host receives a DELTA carrying an `ai_updated` change with the
 *      ready/failed suggestion; the reducer applies it to set `story.ai`.
 *  (b) any non-host socket attached to the same room receives ZERO
 *      on-completion traffic — no DELTA, no STORY_AI_READY/FAILED, no
 *      heartbeat. This is the AA-1 timing-leak guarantee: a voter must not
 *      be able to correlate "AI completed" with the host's request.
 *
 * Uses the same fake-orchestrator scaffolding as aiHandler.workers.test.ts
 * (the resolved/hold path writes ai_suggestion + calls sendToHost directly
 * — equivalent to room.ts:runAiCall).
 */
import { describe, it, expect } from 'vitest';
import type { WebSocket } from '@cloudflare/workers-types';
import type {
  AISuggestion, DeltaChange, DeltaPayload, Envelope, ServerMessageType,
} from '@pointe/shared';
import { handleMessage, type AiOrchestrator } from '../src/dispatcher';
import {
  addStory, addVoter, createRoom, openVoting,
} from '../src/operations';
import { deriveAiCacheKey, putAiCache, type AiPayloadJson } from '../src/ai';
import { withRoom } from './helpers/pool';

const HOST_ID = 'host-1';
const VOTER_ID = 'v-1';
const STORY_ID = 'st-1';
const NOW = 1_700_000_000_000;

const FIXTURE_PAYLOAD: AiPayloadJson = {
  complexity: { level: 'medium', note: 'm' },
  effort: { level: 'low', note: 'e' },
  risk: { level: 'low', note: 'r' },
  unknowns: { level: 'low', note: 'u' },
  suggestedRange: { low: '3', high: '5' },
  rationale: 'because',
};

function fakeWs(att: { voterId: string; role: 'host' | 'voter' | 'spectator' }): {
  ws: WebSocket; sent: Envelope[];
} {
  const sent: Envelope[] = [];
  return {
    sent,
    ws: {
      send: (s: string) => { sent.push(JSON.parse(s) as Envelope); },
      serializeAttachment: () => {},
      deserializeAttachment: () => att,
      close: () => {},
    } as unknown as WebSocket,
  };
}

function makeOrch(opts: {
  sql: SqlStorage;
  hostId: string;
  sockets: { ws: WebSocket; sent: Envelope[] }[];
  resolution?: { ok: true; payload?: AiPayloadJson } | { ok: false; errorMessage: string };
}): AiOrchestrator {
  const resolution = opts.resolution ?? { ok: true };
  const orch: AiOrchestrator = {
    available: true,
    sendToHost: (type, payload) => {
      const env = { v: 1, type, id: 'srv-' + type, at: Date.now(), payload } as Envelope;
      const raw = JSON.stringify(env);
      for (const s of opts.sockets) {
        const att = s.ws.deserializeAttachment() as { voterId: string } | null;
        if (att?.voterId === opts.hostId) s.ws.send(raw);
      }
    },
    scheduleAiCall: (p) => {
      const now = Date.now();
      if (resolution.ok) {
        const payload = resolution.payload ?? FIXTURE_PAYLOAD;
        opts.sql.exec(
          `INSERT INTO ai_suggestion (story_id, state, payload, error_message, requested_at, completed_at, shared, shared_at)
           VALUES (?, 'ready', ?, NULL, ?, ?, 0, NULL)
           ON CONFLICT(story_id) DO UPDATE SET state='ready', payload=excluded.payload, error_message=NULL, completed_at=excluded.completed_at, shared=0`,
          p.storyId, JSON.stringify(payload), p.requestedAt, now,
        );
        putAiCache(opts.sql, { cacheKey: p.cacheKey, payload, now });
        // Mirrors room.ts runAiCall:
        orch.sendToHost('STORY_AI_READY', { storyId: p.storyId });
        const ready: AISuggestion = {
          state: 'ready',
          complexity: payload.complexity,
          effort: payload.effort,
          risk: payload.risk,
          unknowns: payload.unknowns,
          suggestedRange: payload.suggestedRange,
          rationale: payload.rationale,
          shared: false,
        };
        const change: DeltaChange = { kind: 'ai_updated', storyId: p.storyId, ai: ready };
        orch.sendToHost('DELTA', { changes: [change] } satisfies DeltaPayload);
      } else {
        opts.sql.exec(
          `INSERT INTO ai_suggestion (story_id, state, payload, error_message, requested_at, completed_at, shared, shared_at)
           VALUES (?, 'failed', NULL, ?, ?, ?, 0, NULL)
           ON CONFLICT(story_id) DO UPDATE SET state='failed', payload=NULL, error_message=excluded.error_message, completed_at=excluded.completed_at`,
          p.storyId, resolution.errorMessage, p.requestedAt, now,
        );
        orch.sendToHost('STORY_AI_FAILED', { storyId: p.storyId, errorMessage: resolution.errorMessage });
        const change: DeltaChange = {
          kind: 'ai_updated', storyId: p.storyId,
          ai: { state: 'failed', errorMessage: resolution.errorMessage },
        };
        orch.sendToHost('DELTA', { changes: [change] } satisfies DeltaPayload);
      }
    },
  };
  return orch;
}

function seedRoom(sql: SqlStorage): void {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
  });
  addVoter(sql, { voterId: VOTER_ID, displayName: 'Ben', now: NOW });
  addStory(sql, { storyId: STORY_ID, text: 'reset password', now: NOW + 1 });
  openVoting(sql, { storyId: STORY_ID, now: NOW + 2 });
}

function requestAiEnv(storyId = STORY_ID, id = 'req-1'): string {
  return JSON.stringify({ v: 1, type: 'REQUEST_AI', id, at: 0, payload: { storyId } });
}

function aiUpdatedChange(envs: Envelope[]):
  | Extract<DeltaChange, { kind: 'ai_updated' }> | null {
  for (const e of envs) {
    if (e.type !== 'DELTA') continue;
    const payload = e.payload as DeltaPayload;
    const c = payload.changes.find((c) => c.kind === 'ai_updated');
    if (c) return c as Extract<DeltaChange, { kind: 'ai_updated' }>;
  }
  return null;
}

// ---- Tests ------------------------------------------------------------------

describe('S8.iii.c1 — ai_updated DELTA on completion (content delivery)', () => {
  it('ready: host receives a DELTA with ai_updated carrying the ready suggestion', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const sockHost = fakeWs({ voterId: HOST_ID, role: 'host' });
      const orch = makeOrch({ sql, hostId: HOST_ID, sockets: [sockHost] });
      handleMessage(sql, sockHost.ws, requestAiEnv(), undefined, undefined, undefined, orch);

      const change = aiUpdatedChange(sockHost.sent);
      expect(change).not.toBeNull();
      expect(change!.storyId).toBe(STORY_ID);
      expect(change!.ai.state).toBe('ready');
      if (change!.ai.state !== 'ready') throw new Error('expected ready');
      expect(change!.ai.suggestedRange).toEqual({ low: '3', high: '5' });
      expect(change!.ai.shared).toBe(false);
    });
  });

  it('failed: host receives a DELTA with ai_updated { state: failed, errorMessage }', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const sockHost = fakeWs({ voterId: HOST_ID, role: 'host' });
      const orch = makeOrch({
        sql, hostId: HOST_ID, sockets: [sockHost],
        resolution: { ok: false, errorMessage: 'TIMEOUT' },
      });
      handleMessage(sql, sockHost.ws, requestAiEnv(), undefined, undefined, undefined, orch);

      const change = aiUpdatedChange(sockHost.sent);
      expect(change).not.toBeNull();
      expect(change!.ai).toEqual({ state: 'failed', errorMessage: 'TIMEOUT' });
    });
  });

  it('cache hit: host receives ai_updated DELTA from the fast path (no scheduleAiCall)', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      // Pre-seed the cache so REQUEST_AI takes the hit branch.
      const cacheKey = deriveAiCacheKey(
        'reset password',
        ['1', '2', '3', '5', '8', '13', '21'],
      );
      putAiCache(sql, { cacheKey, payload: FIXTURE_PAYLOAD, now: NOW });

      const sockHost = fakeWs({ voterId: HOST_ID, role: 'host' });
      const orch = makeOrch({ sql, hostId: HOST_ID, sockets: [sockHost] });
      handleMessage(sql, sockHost.ws, requestAiEnv(), undefined, undefined, undefined, orch);

      const change = aiUpdatedChange(sockHost.sent);
      expect(change).not.toBeNull();
      expect(change!.ai.state).toBe('ready');
      if (change!.ai.state !== 'ready') throw new Error('expected ready');
      expect(change!.ai.suggestedRange).toEqual(FIXTURE_PAYLOAD.suggestedRange);
    });
  });
});

describe('S8.iii.c1 — AA-1 timing leak: voters get ZERO on-completion traffic', () => {
  it('ready: voter socket receives no DELTA, no STORY_AI_READY/FAILED, no message at all', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const sockHost = fakeWs({ voterId: HOST_ID, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER_ID, role: 'voter' });
      const orch = makeOrch({
        sql, hostId: HOST_ID, sockets: [sockHost, sockVoter],
      });
      handleMessage(
        sql, sockHost.ws, requestAiEnv(),
        // No broadcaster wired — the orchestrator's sendToHost is the only
        // server-egress path here. Any voter traffic would be a leak.
        undefined, undefined, undefined, orch,
      );

      expect(sockHost.sent.some((e) => e.type === 'STORY_AI_READY')).toBe(true);
      expect(aiUpdatedChange(sockHost.sent)).not.toBeNull();
      // The whole assertion:
      expect(sockVoter.sent).toEqual([]);
    });
  });

  it('failed: voter socket receives no traffic on the failure path either', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const sockHost = fakeWs({ voterId: HOST_ID, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER_ID, role: 'voter' });
      const orch = makeOrch({
        sql, hostId: HOST_ID, sockets: [sockHost, sockVoter],
        resolution: { ok: false, errorMessage: 'HTTP_500' },
      });
      handleMessage(sql, sockHost.ws, requestAiEnv(), undefined, undefined, undefined, orch);

      expect(sockHost.sent.some((e) => e.type === 'STORY_AI_FAILED')).toBe(true);
      expect(sockVoter.sent).toEqual([]);
    });
  });
});

// Reference the ServerMessageType import so eslint doesn't grumble.
const _types: ServerMessageType[] = ['DELTA', 'STORY_AI_READY', 'STORY_AI_FAILED'];
void _types;
