/**
 * S8.ii.c1 — host-scoped `ai` on the reveal (AA-1 edge #2).
 *
 * The reveal payload (the `votes_revealed` DeltaChange inside a DELTA envelope
 * — the spec name `REVEAL_BROADCAST` is reserved but currently unused) carries
 * an optional `ai?` field. The dispatcher attaches whatever suggestion exists;
 * `projectChangesFor` strips it for non-hosts via `projectAiForRecipient` so
 * a voter's reveal is byte-identical to a reveal of a no-AI story.
 *
 * The byte-identical capstone (`JSON.stringify(noAi) === JSON.stringify(unsharedAi)`
 * for a voter) extends the S8.i serializer guarantee to the reveal stream — a
 * step toward S8.v's whole-stream capstone.
 */
import { describe, it, expect } from 'vitest';
import type { DeltaChange, Envelope, DeltaPayload } from '@pointe/shared';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import { handleMessage } from '../src/dispatcher';
import { broadcast } from '../src/broadcast';
import {
  addStory, addVoter, castVote, createRoom, getHostVoterId, openVoting,
} from '../src/operations';
import { upsertAiSuggestion, type AiPayloadJson } from '../src/ai';
import { withRoom } from './helpers/pool';

const HOST = 'host-1';
const VOTER = 'v-1';
const SPECT = 'sp-1';
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

function seedActiveWithVotes(sql: SqlStorage): void {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
  });
  addVoter(sql, { voterId: VOTER, displayName: 'Ben', now: NOW + 1 });
  addVoter(sql, { voterId: SPECT, displayName: 'Sue', role: 'spectator', now: NOW + 2 });
  addStory(sql, { storyId: STORY, text: 't', now: NOW + 10 });
  openVoting(sql, { storyId: STORY, now: NOW + 11 });
  castVote(sql, { storyId: STORY, voterId: VOTER, points: '5', confidence: 4, now: NOW + 12 });
}

function revealEnv(storyId = STORY, id = 'rv-1'): string {
  return JSON.stringify({ v: 1, type: 'REVEAL_VOTES', id, at: 0, payload: { storyId } });
}

function runReveal(
  sql: SqlStorage,
  sockets: { ws: WebSocket; sent: string[] }[],
  hostWs: WebSocket,
): void {
  const ctx = {
    getWebSockets: () => sockets.map((s) => s.ws),
  } as unknown as DurableObjectState;
  handleMessage(
    sql, hostWs, revealEnv(),
    (changes, opts) => broadcast(ctx, changes, getHostVoterId(sql), opts),
  );
}

function revealChangeFrom(sent: string[]): Extract<DeltaChange, { kind: 'votes_revealed' }> {
  expect(sent).toHaveLength(1);
  const env = JSON.parse(sent[0]) as Envelope<DeltaPayload>;
  const c = env.payload.changes.find((x) => x.kind === 'votes_revealed');
  expect(c).toBeDefined();
  return c as Extract<DeltaChange, { kind: 'votes_revealed' }>;
}

describe('S8.ii.c1 — reveal `ai` is host-only (AA-1 edge #2)', () => {
  it('host reveal carries the full CERU suggestion; voter reveal has no `ai` key; spectator same as voter', async () => {
    await withRoom((sql) => {
      seedActiveWithVotes(sql);
      upsertAiSuggestion(sql, {
        storyId: STORY, state: 'ready', payload: FIXTURE_PAYLOAD,
        requestedAt: NOW + 20, completedAt: NOW + 21, shared: false,
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      const sockSpec = fakeWs({ voterId: SPECT, role: 'spectator' });

      runReveal(sql, [sockHost, sockVoter, sockSpec], sockHost.ws);

      const hostChange = revealChangeFrom(sockHost.sent);
      expect(hostChange.ai).toBeDefined();
      if (hostChange.ai?.state !== 'ready') throw new Error('expected ready');
      expect(hostChange.ai.suggestedRange).toEqual({ low: '3', high: '5' });

      const voterChange = revealChangeFrom(sockVoter.sent);
      expect('ai' in voterChange).toBe(false);
      const specChange = revealChangeFrom(sockSpec.sent);
      expect('ai' in specChange).toBe(false);
      // And the wire bytes never contain CERU-shaped fields for the voter or spectator.
      expect(sockVoter.sent[0]).not.toContain('rationale');
      expect(sockSpec.sent[0]).not.toContain('rationale');
    });
  });

  it('failed suggestion: host sees { state, errorMessage }; voter sees no `ai` key', async () => {
    await withRoom((sql) => {
      seedActiveWithVotes(sql);
      upsertAiSuggestion(sql, {
        storyId: STORY, state: 'failed', errorMessage: 'TIMEOUT',
        requestedAt: NOW + 20, completedAt: NOW + 21,
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });

      runReveal(sql, [sockHost, sockVoter], sockHost.ws);

      const hostChange = revealChangeFrom(sockHost.sent);
      expect(hostChange.ai).toEqual({ state: 'failed', errorMessage: 'TIMEOUT' });
      const voterChange = revealChangeFrom(sockVoter.sent);
      expect('ai' in voterChange).toBe(false);
    });
  });

  it('reveal-stream capstone: a voter\'s reveal of an unshared-AI story is byte-identical to a reveal of a no-AI story', async () => {
    // Two parallel rooms — same seed/votes; one has an AI row, the other doesn't.
    // Capture each voter's serialized DELTA envelope and compare the bytes of
    // the `votes_revealed` change. We diff the change (not the envelope) to
    // avoid the freshly-minted envelope `id` / `at` noise.
    function pickRevealBytes(sentRaw: string): string {
      const env = JSON.parse(sentRaw) as Envelope<DeltaPayload>;
      const reveal = env.payload.changes.find((c) => c.kind === 'votes_revealed');
      return JSON.stringify(reveal);
    }

    const voterRevealWithAi = await withRoom((sql) => {
      seedActiveWithVotes(sql);
      upsertAiSuggestion(sql, {
        storyId: STORY, state: 'ready', payload: FIXTURE_PAYLOAD,
        requestedAt: NOW + 20, completedAt: NOW + 21, shared: false,
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      runReveal(sql, [sockHost, sockVoter], sockHost.ws);
      return pickRevealBytes(sockVoter.sent[0]);
    });

    const voterRevealNoAi = await withRoom((sql) => {
      seedActiveWithVotes(sql);
      // No upsertAiSuggestion — the suggestion row never existed.
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      runReveal(sql, [sockHost, sockVoter], sockHost.ws);
      return pickRevealBytes(sockVoter.sent[0]);
    });

    expect(voterRevealWithAi).toBe(voterRevealNoAi);
  });

  it('no suggestion row → `ai` absent for everyone (host and voter both)', async () => {
    await withRoom((sql) => {
      seedActiveWithVotes(sql);
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      runReveal(sql, [sockHost, sockVoter], sockHost.ws);

      const hostChange = revealChangeFrom(sockHost.sent);
      const voterChange = revealChangeFrom(sockVoter.sent);
      expect('ai' in hostChange).toBe(false);
      expect('ai' in voterChange).toBe(false);
    });
  });

  it('the suggested CERU payload is dropped from the bytes seen by non-host (a defense-in-depth wire check)', async () => {
    await withRoom((sql) => {
      seedActiveWithVotes(sql);
      upsertAiSuggestion(sql, {
        storyId: STORY, state: 'ready', payload: FIXTURE_PAYLOAD,
        requestedAt: NOW + 20, completedAt: NOW + 21, shared: false,
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      runReveal(sql, [sockHost, sockVoter], sockHost.ws);

      const voterRaw = sockVoter.sent[0];
      // None of the suggestion's distinguishing fields may appear in voter bytes.
      expect(voterRaw).not.toContain('complexity');
      expect(voterRaw).not.toContain('suggestedRange');
      expect(voterRaw).not.toContain('rationale');
      expect(voterRaw).not.toContain('"ai"');
    });
  });
});

describe('S8.ii.c1 — projector defaults safe with no host', () => {
  it('hostVoterId === null: ai is stripped for everyone (host-vacant safe default)', async () => {
    await withRoom((sql) => {
      seedActiveWithVotes(sql);
      upsertAiSuggestion(sql, {
        storyId: STORY, state: 'ready', payload: FIXTURE_PAYLOAD,
        requestedAt: NOW + 20, completedAt: NOW + 21, shared: false,
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      const ctx = {
        getWebSockets: () => [sockHost.ws, sockVoter.ws],
      } as unknown as DurableObjectState;
      // Pass null hostVoterId directly to broadcast — simulates a transient
      // host-vacant fan-out. With no host, even the host socket sees no ai.
      handleMessage(
        sql, sockHost.ws, revealEnv(),
        (changes, opts) => broadcast(ctx, changes, null, opts),
      );
      const hostChange = revealChangeFrom(sockHost.sent);
      const voterChange = revealChangeFrom(sockVoter.sent);
      expect('ai' in hostChange).toBe(false);
      expect('ai' in voterChange).toBe(false);
    });
  });
});

