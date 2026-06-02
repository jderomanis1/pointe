import { describe, it, expect } from 'vitest';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { DeltaChange, Envelope } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import { initSchema } from '../src/schema';
import {
  addStory, addVoter, castVote, commitStory, createRoom, openVoting, revealVotes, skipStory,
} from '../src/operations';
import { createMockDoState } from './helpers/mockDoState';

const HOST_ID = 'h-1';
const VOTER_ID = 'v-1';
const STORY_ID = 's-1';

function baseRoom() {
  const state = createMockDoState();
  initSchema(state.storage.sql);
  createRoom(state.storage.sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
  });
  addVoter(state.storage.sql, { voterId: VOTER_ID, displayName: 'Ben', now: 0 });
  return state;
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

function skipEnv(storyId: string, id = 'c-skip'): Envelope {
  return { v: 1, type: 'SKIP_STORY', id, at: 0, payload: { storyId } };
}

function storyState(state: DurableObjectState, id: string): string {
  return state.storage.sql
    .exec<{ state: string }>(`SELECT state FROM story WHERE id = ?`, id).toArray()[0].state;
}

function voteCount(state: DurableObjectState, id: string): number {
  return state.storage.sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vote WHERE story_id = ?`, id).toArray()[0].n;
}

// ---- Valid sources: pending / active / revealed ----

describe('SKIP_STORY — valid source states', () => {
  it('host skips a pending story → skipped + story_skipped broadcast', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: STORY_ID, text: 'A', now: 0 });
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);

    expect(reply).toEqual([]);
    expect(storyState(state, STORY_ID)).toBe('skipped');
    expect(broadcasts).toEqual([[{ kind: 'story_skipped', storyId: STORY_ID }]]);
  });

  it('host skips the ACTIVE story → skipped, room left with no active story (votes inert, NOT cleared)', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: STORY_ID, text: 'A', now: 0 });
    openVoting(state.storage.sql, { storyId: STORY_ID, now: 100 });
    castVote(state.storage.sql, { storyId: STORY_ID, voterId: VOTER_ID, points: '5', confidence: 4, now: 110 });
    const broadcasts: DeltaChange[][] = [];

    call(state, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);

    expect(storyState(state, STORY_ID)).toBe('skipped');
    // Cheap-by-design: votes stay (inert).
    expect(voteCount(state, STORY_ID)).toBe(1);
    // No active story remains.
    const anyActive = state.storage.sql
      .exec<{ id: string }>(`SELECT id FROM story WHERE state = 'active' LIMIT 1`).toArray();
    expect(anyActive).toHaveLength(0);
  });

  it('host skips a REVEALED story → skipped (post-reveal abandon)', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: STORY_ID, text: 'A', now: 0 });
    openVoting(state.storage.sql, { storyId: STORY_ID, now: 100 });
    castVote(state.storage.sql, { storyId: STORY_ID, voterId: VOTER_ID, points: '5', confidence: 4, now: 110 });
    revealVotes(state.storage.sql, { storyId: STORY_ID, now: 200 });
    const broadcasts: DeltaChange[][] = [];

    call(state, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);

    expect(storyState(state, STORY_ID)).toBe('skipped');
    expect(voteCount(state, STORY_ID)).toBe(1); // votes inert, not cleared
  });
});

// ---- SI-02 ----

describe('SKIP_STORY — non-host rejected (SI-02)', () => {
  it('voter sender → NOT_HOST, no change, no broadcast', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: STORY_ID, text: 'A', now: 0 });
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(VOTER_ID), skipEnv(STORY_ID), broadcasts);

    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('NOT_HOST');
    expect(storyState(state, STORY_ID)).toBe('pending');
    expect(broadcasts).toEqual([]);
  });
});

// ---- Terminal sources rejected ----

describe('SKIP_STORY — terminal sources rejected', () => {
  it('committed → STORY_NOT_SKIPPABLE', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: STORY_ID, text: 'A', now: 0 });
    openVoting(state.storage.sql, { storyId: STORY_ID, now: 100 });
    revealVotes(state.storage.sql, { storyId: STORY_ID, now: 200 });
    commitStory(state.storage.sql, { storyId: STORY_ID, finalEstimate: '5' });
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);

    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_SKIPPABLE');
    expect(storyState(state, STORY_ID)).toBe('committed');
    expect(broadcasts).toEqual([]);
  });

  it('already-skipped → STORY_NOT_SKIPPABLE', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: STORY_ID, text: 'A', now: 0 });
    skipStory(state.storage.sql, { storyId: STORY_ID });
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);

    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_SKIPPABLE');
    expect(storyState(state, STORY_ID)).toBe('skipped');
    expect(broadcasts).toEqual([]);
  });

  it('split → STORY_NOT_SKIPPABLE', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: STORY_ID, text: 'A', now: 0 });
    state.storage.sql.exec(`UPDATE story SET state = 'split' WHERE id = ?`, STORY_ID);
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);

    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_SKIPPABLE');
  });
});

// ---- Unknown story ----

describe('SKIP_STORY — unknown storyId', () => {
  it('STORY_NOT_FOUND', () => {
    const state = baseRoom();
    const broadcasts: DeltaChange[][] = [];
    const reply = call(state, fakeSock(HOST_ID), skipEnv('nobody'), broadcasts);
    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_FOUND');
    expect(broadcasts).toEqual([]);
  });
});
