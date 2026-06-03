import { describe, it, expect } from 'vitest';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { DeltaChange, Envelope } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import { initSchema } from '../src/schema';
import { addStory, addVoter, castVote, createRoom, openVoting, revealVotes } from '../src/operations';
import { createMockDoState } from './helpers/mockDoState';

const HOST_ID = 'h-1';
const VOTER_A = 'v-a';
const VOTER_B = 'v-b';
const STORY_ID = 's-1';

function setupWithRevealedStory(): {
  state: DurableObjectState;
  broadcasts: DeltaChange[][];
} {
  const state = createMockDoState();
  initSchema(state.storage.sql);
  createRoom(state.storage.sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
  });
  addVoter(state.storage.sql, { voterId: VOTER_A, displayName: 'Ann', now: 0 });
  addVoter(state.storage.sql, { voterId: VOTER_B, displayName: 'Bob', now: 0 });
  addStory(state.storage.sql, { storyId: STORY_ID, text: 'Auth', now: 0 });
  openVoting(state.storage.sql, { storyId: STORY_ID, now: 100 });
  castVote(state.storage.sql, { storyId: STORY_ID, voterId: VOTER_A, points: '5', confidence: 4, now: 110 });
  castVote(state.storage.sql, { storyId: STORY_ID, voterId: VOTER_B, points: '8', confidence: 3, now: 120 });
  revealVotes(state.storage.sql, { storyId: STORY_ID, now: 200 });

  const broadcasts: DeltaChange[][] = [];
  return { state, broadcasts };
}

function fakeSock(voterId: string | null): WebSocket {
  const attachment = voterId ? { voterId, role: 'voter' } : null;
  return {
    send: () => {},
    serializeAttachment: () => {},
    deserializeAttachment: () => attachment,
    close: () => {},
  } as unknown as WebSocket;
}

function call(
  state: DurableObjectState,
  ws: WebSocket,
  envelope: Envelope,
  broadcasts: DeltaChange[][],
): Envelope[] {
  return handleMessage(
    state.storage.sql,
    ws,
    JSON.stringify(envelope),
    (changes) => { broadcasts.push(changes); },
  );
}

function openVotingEnv(storyId: string, id = 'c-1'): Envelope {
  return { v: 1, type: 'OPEN_VOTING', id, at: 0, payload: { storyId } };
}

function storyState(state: DurableObjectState, id: string): string {
  return state.storage.sql
    .exec<{ state: string }>(`SELECT state FROM story WHERE id = ?`, id).toArray()[0].state;
}

function voteCount(state: DurableObjectState, id: string): number {
  return state.storage.sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vote WHERE story_id = ?`, id).toArray()[0].n;
}

function auditEvents(state: DurableObjectState): { event_type: string; at: number; payload: string }[] {
  return state.storage.sql
    .exec<{ event_type: string; at: number; payload: string }>(
      `SELECT event_type, at, payload FROM audit_event ORDER BY at`,
    ).toArray();
}

// ---- Re-open (revealed → active) ----

describe('OPEN_VOTING — re-open after reveal (OQ-010)', () => {
  it('host re-opens a revealed story: state→active, votes cleared, revealedAt nulled, voting_opened broadcast', () => {
    const { state, broadcasts } = setupWithRevealedStory();
    expect(storyState(state, STORY_ID)).toBe('revealed');
    expect(voteCount(state, STORY_ID)).toBe(2);

    const ws = fakeSock(HOST_ID);
    const reply = call(state, ws, openVotingEnv(STORY_ID), broadcasts);

    expect(reply).toEqual([]);
    expect(storyState(state, STORY_ID)).toBe('active');
    expect(voteCount(state, STORY_ID)).toBe(0);
    const revealedAt = state.storage.sql
      .exec<{ revealed_at: number | null }>(`SELECT revealed_at FROM story WHERE id = ?`, STORY_ID)
      .toArray()[0].revealed_at;
    expect(revealedAt).toBeNull();
    expect(broadcasts).toEqual([[{ kind: 'voting_opened', storyId: STORY_ID }]]);
  });

  it('preserves the round in audit_event BEFORE deletion (preserve-before-destroy)', () => {
    const { state, broadcasts } = setupWithRevealedStory();
    call(state, fakeSock(HOST_ID), openVotingEnv(STORY_ID), broadcasts);

    const events = auditEvents(state);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('votes_revealed');
    expect(events[0].at).toBe(200); // the prior round's revealedAt, not "now"
    const payload = JSON.parse(events[0].payload);
    expect(payload.storyId).toBe(STORY_ID);
    expect(payload.reason).toBe('reopened');
    expect(payload.votes).toHaveLength(2);
    expect(payload.stats.median).toBe('5'); // Fibonacci(5)+Fibonacci(8) idx-median = idx 3 = '5'
    expect(payload.stats.numericCount).toBe(2);
  });

  it('non-host sender → NOT_HOST, nothing changes', () => {
    const { state, broadcasts } = setupWithRevealedStory();
    const ws = fakeSock(VOTER_A);
    const reply = call(state, ws, openVotingEnv(STORY_ID), broadcasts);
    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('NOT_HOST');
    expect(storyState(state, STORY_ID)).toBe('revealed');
    expect(voteCount(state, STORY_ID)).toBe(2);
    expect(broadcasts).toEqual([]);
    expect(auditEvents(state)).toHaveLength(0);
  });

  it('another story is already active → ANOTHER_STORY_ACTIVE, no transition', () => {
    const { state, broadcasts } = setupWithRevealedStory();
    addStory(state.storage.sql, { storyId: 's-2', text: 'Auth phase 2', now: 0 });
    openVoting(state.storage.sql, { storyId: 's-2', now: 300 });

    const ws = fakeSock(HOST_ID);
    const reply = call(state, ws, openVotingEnv(STORY_ID), broadcasts);
    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('ANOTHER_STORY_ACTIVE');
    expect(storyState(state, STORY_ID)).toBe('revealed'); // unchanged
    expect(voteCount(state, STORY_ID)).toBe(2);
    expect(broadcasts).toEqual([]);
    expect(auditEvents(state)).toHaveLength(0);
  });

  it('FIRST open (pending story) still works and does NOT write an audit event', () => {
    const state = createMockDoState();
    initSchema(state.storage.sql);
    createRoom(state.storage.sql, {
      roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
      hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
    });
    addStory(state.storage.sql, { storyId: STORY_ID, text: 'Auth', now: 0 });
    const broadcasts: DeltaChange[][] = [];

    const ws = fakeSock(HOST_ID);
    const reply = call(state, ws, openVotingEnv(STORY_ID), broadcasts);

    expect(reply).toEqual([]);
    expect(storyState(state, STORY_ID)).toBe('active');
    expect(broadcasts).toEqual([[{ kind: 'voting_opened', storyId: STORY_ID }]]);
    expect(auditEvents(state)).toHaveLength(0); // first-open never audits
  });

  it('zero-vote re-open audits with empty votes + null median (no crash)', () => {
    const state = createMockDoState();
    initSchema(state.storage.sql);
    createRoom(state.storage.sql, {
      roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
      hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
    });
    addStory(state.storage.sql, { storyId: STORY_ID, text: 'Auth', now: 0 });
    openVoting(state.storage.sql, { storyId: STORY_ID, now: 100 });
    revealVotes(state.storage.sql, { storyId: STORY_ID, now: 200 }); // reveal with no votes
    const broadcasts: DeltaChange[][] = [];

    call(state, fakeSock(HOST_ID), openVotingEnv(STORY_ID), broadcasts);
    const events = auditEvents(state);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.votes).toEqual([]);
    expect(payload.stats.median).toBeNull();
    expect(payload.stats.numericCount).toBe(0);
  });
});
