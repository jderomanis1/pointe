/**
 * S8.ii.c2 — SHARE_AI handler + AI_SHARED broadcast.
 *
 * The only sanctioned path that crosses the AI suggestion to non-host
 * recipients. Tests cover:
 *   • Host-only auth (SI-02).
 *   • Story-state guards (must be revealed/committed).
 *   • Suggestion-state guards (must be ready).
 *   • The flip: voter snapshot has no `ai` before SHARE_AI, has it after.
 *   • Broadcast scope: host AND voter receive AI_SHARED carrying the ready ai.
 *   • Idempotent: a second SHARE_AI doesn't double-flip shared_at but does
 *     re-broadcast (cheap, deliberate, lossless on a missed delivery).
 *   • Snapshot-level reveal: a voter's reveal change AFTER a shared row is
 *     still consistent (the row is now shareable → voter would see `ai` on
 *     a subsequent reveal; but this slice's reveal payload is captured at
 *     reveal time — see commit 1).
 */
import { describe, it, expect } from 'vitest';
import type {
  AiSharedPayload, AISuggestion, Envelope, ErrorPayload, RoomSnapshot, ServerMessageType,
  SnapshotStory,
} from '@pointe/shared';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import { handleMessage } from '../src/dispatcher';
import { broadcast, broadcastEnvelope } from '../src/broadcast';
import {
  addStory, addVoter, castVote, createRoom, getHostVoterId, openVoting, revealVotes,
} from '../src/operations';
import { upsertAiSuggestion, type AiPayloadJson } from '../src/ai';
import { withRoom } from './helpers/pool';

const HOST = 'host-1';
const VOTER = 'v-1';
const STORY = 'st-1';
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
  ws: WebSocket; sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    ws: {
      send: (s: string) => { sent.push(s); },
      serializeAttachment: () => {},
      deserializeAttachment: () => att,
      close: () => {},
    } as unknown as WebSocket,
  };
}

function seedRevealedWithReadySuggestion(sql: SqlStorage): void {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
  });
  addVoter(sql, { voterId: VOTER, displayName: 'Ben', now: NOW + 1 });
  addStory(sql, { storyId: STORY, text: 't', now: NOW + 10 });
  openVoting(sql, { storyId: STORY, now: NOW + 11 });
  castVote(sql, { storyId: STORY, voterId: VOTER, points: '5', confidence: 4, now: NOW + 12 });
  revealVotes(sql, { storyId: STORY, now: NOW + 20 });
  upsertAiSuggestion(sql, {
    storyId: STORY, state: 'ready', payload: FIXTURE_PAYLOAD,
    requestedAt: NOW + 15, completedAt: NOW + 16, shared: false,
  });
}

function shareEnv(storyId = STORY, id = 'sh-1'): string {
  return JSON.stringify({ v: 1, type: 'SHARE_AI', id, at: 0, payload: { storyId } });
}

function joinEnv(voterId: string, id: string): string {
  return JSON.stringify({
    v: 1, type: 'JOIN_ROOM', id, at: 0,
    payload: { slug: 's', resumeVoterId: voterId, role: 'voter' },
  });
}

function runShare(
  sql: SqlStorage,
  sockets: { ws: WebSocket; sent: string[] }[],
  senderWs: WebSocket,
  envRaw = shareEnv(),
): Envelope[] {
  const ctx = {
    getWebSockets: () => sockets.map((s) => s.ws),
  } as unknown as DurableObjectState;
  return handleMessage(
    sql, senderWs, envRaw,
    (changes, opts) => broadcast(ctx, changes, getHostVoterId(sql), opts),
    undefined,
    (type: ServerMessageType, payload: unknown) => {
      broadcastEnvelope(ctx, type, payload);
    },
  );
}

function snapshotFor(sql: SqlStorage, voterId: string, role: 'host' | 'voter'): RoomSnapshot {
  const out = handleMessage(
    sql,
    fakeWs({ voterId, role }).ws,
    joinEnv(voterId, `j-${voterId}-${Math.random()}`),
  );
  expect(out[0].type).toBe('SNAPSHOT_RESPONSE');
  return out[0].payload as RoomSnapshot;
}

function storyById(snap: RoomSnapshot, id: string): SnapshotStory {
  return snap.stories.find((s) => s.id === id)!;
}

function aiSharedReceived(sock: { sent: string[] }): AiSharedPayload | null {
  for (const raw of sock.sent) {
    const env = JSON.parse(raw) as Envelope<unknown>;
    if (env.type === 'AI_SHARED') return env.payload as AiSharedPayload;
  }
  return null;
}

// ---- Auth + guards ----------------------------------------------------------

describe('SHARE_AI — host auth (SI-02)', () => {
  it('non-host → NOT_HOST; no flip; no broadcast', async () => {
    await withRoom((sql) => {
      seedRevealedWithReadySuggestion(sql);
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      const out = runShare(sql, [sockHost, sockVoter], sockVoter.ws);
      expect((out[0].payload as ErrorPayload).code).toBe('NOT_HOST');
      const row = sql.exec<{ shared: number }>(
        `SELECT shared FROM ai_suggestion WHERE story_id = ?`, STORY,
      ).toArray()[0];
      expect(row.shared).toBe(0);
      expect(aiSharedReceived(sockHost)).toBeNull();
      expect(aiSharedReceived(sockVoter)).toBeNull();
    });
  });
});

describe('SHARE_AI — story state guards', () => {
  it('unrevealed (active) story → AI_NOT_SHAREABLE; no flip; no broadcast', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
      });
      addStory(sql, { storyId: STORY, text: 't', now: NOW + 1 });
      openVoting(sql, { storyId: STORY, now: NOW + 2 });
      upsertAiSuggestion(sql, {
        storyId: STORY, state: 'ready', payload: FIXTURE_PAYLOAD,
        requestedAt: NOW + 3, completedAt: NOW + 4, shared: false,
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const out = runShare(sql, [sockHost], sockHost.ws);
      expect((out[0].payload as ErrorPayload).code).toBe('AI_NOT_SHAREABLE');
      const row = sql.exec<{ shared: number }>(
        `SELECT shared FROM ai_suggestion WHERE story_id = ?`, STORY,
      ).toArray()[0];
      expect(row.shared).toBe(0);
      expect(aiSharedReceived(sockHost)).toBeNull();
    });
  });

  it('committed story is shareable (post-reveal terminal also qualifies)', async () => {
    await withRoom((sql) => {
      seedRevealedWithReadySuggestion(sql);
      sql.exec(`UPDATE story SET state = 'committed', final_estimate = '5' WHERE id = ?`, STORY);
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const out = runShare(sql, [sockHost], sockHost.ws);
      expect(out).toEqual([]);
      const row = sql.exec<{ shared: number }>(
        `SELECT shared FROM ai_suggestion WHERE story_id = ?`, STORY,
      ).toArray()[0];
      expect(row.shared).toBe(1);
    });
  });

  it('missing story → STORY_NOT_FOUND', async () => {
    await withRoom((sql) => {
      seedRevealedWithReadySuggestion(sql);
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const out = runShare(sql, [sockHost], sockHost.ws, shareEnv('nope'));
      expect((out[0].payload as ErrorPayload).code).toBe('STORY_NOT_FOUND');
    });
  });
});

describe('SHARE_AI — suggestion state guards', () => {
  it('no suggestion row → AI_NOT_SHAREABLE; no broadcast', async () => {
    await withRoom((sql) => {
      seedRevealedWithReadySuggestion(sql);
      sql.exec(`DELETE FROM ai_suggestion WHERE story_id = ?`, STORY);
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const out = runShare(sql, [sockHost], sockHost.ws);
      expect((out[0].payload as ErrorPayload).code).toBe('AI_NOT_SHAREABLE');
      expect(aiSharedReceived(sockHost)).toBeNull();
    });
  });

  it('pending suggestion → AI_NOT_SHAREABLE; no flip', async () => {
    await withRoom((sql) => {
      seedRevealedWithReadySuggestion(sql);
      sql.exec(`UPDATE ai_suggestion SET state='pending', payload=NULL WHERE story_id=?`, STORY);
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const out = runShare(sql, [sockHost], sockHost.ws);
      expect((out[0].payload as ErrorPayload).code).toBe('AI_NOT_SHAREABLE');
      const row = sql.exec<{ shared: number }>(
        `SELECT shared FROM ai_suggestion WHERE story_id = ?`, STORY,
      ).toArray()[0];
      expect(row.shared).toBe(0);
    });
  });

  it('failed suggestion → AI_NOT_SHAREABLE; no flip', async () => {
    await withRoom((sql) => {
      seedRevealedWithReadySuggestion(sql);
      sql.exec(
        `UPDATE ai_suggestion SET state='failed', payload=NULL, error_message='TIMEOUT' WHERE story_id=?`,
        STORY,
      );
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const out = runShare(sql, [sockHost], sockHost.ws);
      expect((out[0].payload as ErrorPayload).code).toBe('AI_NOT_SHAREABLE');
      const row = sql.exec<{ shared: number }>(
        `SELECT shared FROM ai_suggestion WHERE story_id = ?`, STORY,
      ).toArray()[0];
      expect(row.shared).toBe(0);
    });
  });
});

// ---- The flip + broadcast ---------------------------------------------------

describe('SHARE_AI — happy path (AA-1: the sanctioned voter-exposure)', () => {
  it('host shares a revealed ready suggestion → shared flips to 1; AI_SHARED reaches host AND voter; payload carries the ready ai', async () => {
    await withRoom((sql) => {
      seedRevealedWithReadySuggestion(sql);
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      const out = runShare(sql, [sockHost, sockVoter], sockHost.ws);
      expect(out).toEqual([]); // no direct reply

      const row = sql.exec<{ shared: number; shared_at: number | null }>(
        `SELECT shared, shared_at FROM ai_suggestion WHERE story_id = ?`, STORY,
      ).toArray()[0];
      expect(row.shared).toBe(1);
      expect(row.shared_at).not.toBeNull();

      const hostPayload = aiSharedReceived(sockHost);
      const voterPayload = aiSharedReceived(sockVoter);
      expect(hostPayload).not.toBeNull();
      expect(voterPayload).not.toBeNull();
      expect(hostPayload!.storyId).toBe(STORY);
      expect(hostPayload!.ai.state).toBe('ready');
      expect(hostPayload!.ai.shared).toBe(true);
      expect(hostPayload!.ai.suggestedRange).toEqual({ low: '3', high: '5' });
      // Voter receives the SAME payload — once sanctioned, no projection diff.
      expect(JSON.stringify(voterPayload)).toBe(JSON.stringify(hostPayload));
    });
  });

  it('the flip is observable via snapshot: voter has no `ai` BEFORE SHARE_AI, has it AFTER', async () => {
    await withRoom((sql) => {
      seedRevealedWithReadySuggestion(sql);

      const snapBefore = snapshotFor(sql, VOTER, 'voter');
      const storyBefore = storyById(snapBefore, STORY);
      expect('ai' in storyBefore).toBe(false); // unshared → invisible to voter

      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      runShare(sql, [sockHost], sockHost.ws);

      const snapAfter = snapshotFor(sql, VOTER, 'voter');
      const storyAfter = storyById(snapAfter, STORY);
      expect(storyAfter.ai).toBeDefined();
      if (storyAfter.ai!.state !== 'ready') throw new Error('expected ready');
      expect(storyAfter.ai.shared).toBe(true);
      expect(storyAfter.ai.suggestedRange).toEqual({ low: '3', high: '5' });
    });
  });
});

describe('SHARE_AI — idempotency', () => {
  it('a second SHARE_AI does not double-flip shared_at; broadcasts again (lossless on missed delivery)', async () => {
    await withRoom((sql) => {
      seedRevealedWithReadySuggestion(sql);
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });

      runShare(sql, [sockHost], sockHost.ws, shareEnv(STORY, 'sh-1'));
      const firstAt = sql.exec<{ shared_at: number | null }>(
        `SELECT shared_at FROM ai_suggestion WHERE story_id = ?`, STORY,
      ).toArray()[0].shared_at;
      expect(firstAt).not.toBeNull();
      const firstBroadcastCount = sockHost.sent.filter(
        (raw) => (JSON.parse(raw) as Envelope).type === 'AI_SHARED',
      ).length;
      expect(firstBroadcastCount).toBe(1);

      // Second SHARE_AI — different envelope id so dedupe doesn't swallow it.
      runShare(sql, [sockHost], sockHost.ws, shareEnv(STORY, 'sh-2'));
      const secondAt = sql.exec<{ shared_at: number | null; shared: number }>(
        `SELECT shared_at, shared FROM ai_suggestion WHERE story_id = ?`, STORY,
      ).toArray()[0];
      expect(secondAt.shared).toBe(1);
      // shared_at preserved across the no-op flip (COALESCE invariant):
      expect(secondAt.shared_at).toBe(firstAt);
      const totalBroadcasts = sockHost.sent.filter(
        (raw) => (JSON.parse(raw) as Envelope).type === 'AI_SHARED',
      ).length;
      expect(totalBroadcasts).toBe(2); // re-broadcast on the second call
    });
  });
});

// Reference imports so TS doesn't complain.
const _ai: AISuggestion = { state: 'pending' };
void _ai;
