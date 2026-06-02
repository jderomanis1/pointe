import { describe, it, expect } from 'vitest';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { DeltaChange, Envelope, Story } from '@pointe/shared';
import { SPLIT_MAX_CHILDREN } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import { initSchema } from '../src/schema';
import {
  addStory, addVoter, castVote, commitStory, createRoom, openVoting, revealVotes,
  skipStory, splitStory,
} from '../src/operations';
import { createMockDoState } from './helpers/mockDoState';

const HOST_ID = 'h-1';
const VOTER_ID = 'v-1';

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

function splitEnv(storyId: string, children: { text: string }[], id = 'c-split'): Envelope {
  return { v: 1, type: 'SPLIT_STORY', id, at: 0, payload: { storyId, children } };
}

function rowsByOrder(state: DurableObjectState): { id: string; order_index: number; state: string; text: string; split_parent_id: string | null }[] {
  return state.storage.sql
    .exec<{ id: string; order_index: number; state: string; text: string; split_parent_id: string | null }>(
      `SELECT id, order_index, state, text, split_parent_id FROM story ORDER BY order_index ASC`,
    )
    .toArray();
}

// ---- Backend: operation-level placement / resequence ----

describe('splitStory (operation) — placement', () => {
  it('parent in the middle: children land STRICTLY between parent and next, sparse + ordered', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 }); // 100
    addStory(state.storage.sql, { storyId: 's-2', text: 'B', now: 0 }); // 200
    addStory(state.storage.sql, { storyId: 's-3', text: 'C', now: 0 }); // 300
    const out = splitStory(state.storage.sql, {
      storyId: 's-2', childTexts: ['B1', 'B2', 'B3'], now: 0,
    });
    const ids = out.children.map((c) => c.id);
    const rows = rowsByOrder(state);

    // Sequence: A(100), B1, B2, B3, C(300). All children's order_index strictly
    // between 200 and 300, ascending, and unique.
    const childPositions = ids.map((id) => rows.find((r) => r.id === id)!.order_index);
    expect(childPositions).toEqual([...childPositions].sort((a, b) => a - b));
    expect(Math.min(...childPositions)).toBeGreaterThan(200);
    expect(Math.max(...childPositions)).toBeLessThan(300);
    expect(new Set(childPositions).size).toBe(childPositions.length);

    // Parent stayed at 200, marked split. C still at 300 (no resequence needed).
    expect(rows.find((r) => r.id === 's-2')!.order_index).toBe(200);
    expect(rows.find((r) => r.id === 's-2')!.state).toBe('split');
    expect(rows.find((r) => r.id === 's-3')!.order_index).toBe(300);
  });

  it('parent is LAST: children pad the tail with 100-step positions, no resequence', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 }); // 100
    splitStory(state.storage.sql, {
      storyId: 's-1', childTexts: ['A1', 'A2'], now: 0,
    });
    const rows = rowsByOrder(state);
    // Parent 100 (now split), children at 200 and 300.
    const parent = rows.find((r) => r.id === 's-1')!;
    expect(parent.state).toBe('split');
    expect(parent.order_index).toBe(100);
    const children = rows.filter((r) => r.split_parent_id === 's-1');
    expect(children.map((c) => c.order_index).sort((a, b) => a - b)).toEqual([200, 300]);
  });

  it('tight gap: shifts the tail when the parent→next gap can\'t fit N children', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 }); // 100
    addStory(state.storage.sql, { storyId: 's-2', text: 'B', now: 0 }); // 200
    addStory(state.storage.sql, { storyId: 's-3', text: 'C', now: 0 }); // 300
    // Squeeze: move s-3 right next to s-2 so the gap is 1 (impossible for N≥1).
    state.storage.sql.exec(`UPDATE story SET order_index = 201 WHERE id = 's-3'`);

    splitStory(state.storage.sql, {
      storyId: 's-2', childTexts: ['B1', 'B2', 'B3'], now: 0,
    });
    const rows = rowsByOrder(state);

    // s-3 (and anything further) was shifted up to make room.
    expect(rows.find((r) => r.id === 's-3')!.order_index).toBeGreaterThan(201);
    // Children still strictly between parent and the (shifted) s-3.
    const childPositions = rows
      .filter((r) => r.split_parent_id === 's-2')
      .map((r) => r.order_index)
      .sort((a, b) => a - b);
    const cNew = rows.find((r) => r.id === 's-3')!.order_index;
    expect(Math.min(...childPositions)).toBeGreaterThan(200);
    expect(Math.max(...childPositions)).toBeLessThan(cNew);
    expect(new Set(childPositions).size).toBe(3);

    // Final sequence: A(100), B(split, 200), B1, B2, B3, C(shifted).
    const seq = rows.map((r) => r.id);
    const iB = seq.indexOf('s-2');
    const iC = seq.indexOf('s-3');
    expect(iB).toBeLessThan(iC);
    const childIds = rows
      .filter((r) => r.split_parent_id === 's-2')
      .sort((a, b) => a.order_index - b.order_index)
      .map((r) => r.id);
    expect(seq.slice(iB + 1, iC)).toEqual(childIds);
  });
});

// ---- Dispatcher: SPLIT_STORY ----

describe('SPLIT_STORY — valid sources', () => {
  it('host splits a pending story → parent split + children pending + story_split broadcast', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'Huge', now: 0 });
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A' }, { text: 'B' }]), broadcasts);

    expect(reply).toEqual([]);
    const rows = rowsByOrder(state);
    expect(rows.find((r) => r.id === 's-1')!.state).toBe('split');
    const children = rows.filter((r) => r.split_parent_id === 's-1');
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.state === 'pending')).toBe(true);

    expect(broadcasts).toHaveLength(1);
    const change = broadcasts[0][0] as Extract<DeltaChange, { kind: 'story_split' }>;
    expect(change.kind).toBe('story_split');
    expect(change.parentId).toBe('s-1');
    expect(change.children).toHaveLength(2);
    expect(change.children.every((c: Story) => c.state === 'pending')).toBe(true);
    expect(change.children.every((c: Story) => c.splitParentId === 's-1')).toBe(true);
  });

  it('host splits the ACTIVE story → parent split, no active story left, votes inert (preserved)', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 });
    openVoting(state.storage.sql, { storyId: 's-1', now: 100 });
    castVote(state.storage.sql, { storyId: 's-1', voterId: VOTER_ID, points: '5', confidence: 4, now: 110 });
    const broadcasts: DeltaChange[][] = [];

    call(state, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A1' }, { text: 'A2' }]), broadcasts);

    expect(rowsByOrder(state).find((r) => r.id === 's-1')!.state).toBe('split');
    // No active story left.
    expect(
      state.storage.sql.exec<{ id: string }>(`SELECT id FROM story WHERE state = 'active' LIMIT 1`).toArray(),
    ).toEqual([]);
    // Votes preserved (inert).
    expect(
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vote WHERE story_id = 's-1'`).toArray()[0].n,
    ).toBe(1);
  });

  it('host splits a REVEALED story → parent split, votes inert', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 });
    openVoting(state.storage.sql, { storyId: 's-1', now: 100 });
    castVote(state.storage.sql, { storyId: 's-1', voterId: VOTER_ID, points: '5', confidence: 4, now: 110 });
    revealVotes(state.storage.sql, { storyId: 's-1', now: 200 });
    const broadcasts: DeltaChange[][] = [];

    call(state, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A1' }, { text: 'A2' }]), broadcasts);

    expect(rowsByOrder(state).find((r) => r.id === 's-1')!.state).toBe('split');
    expect(
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vote WHERE story_id = 's-1'`).toArray()[0].n,
    ).toBe(1);
  });
});

// ---- Dispatcher: payload + auth rejects ----

describe('SPLIT_STORY — payload rejects', () => {
  it('fewer than MIN children → TOO_FEW_CHILDREN, atomicity preserved', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 });
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A' }]), broadcasts);

    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('TOO_FEW_CHILDREN');
    // Parent untouched, no children created.
    expect(rowsByOrder(state).find((r) => r.id === 's-1')!.state).toBe('pending');
    expect(rowsByOrder(state).filter((r) => r.split_parent_id === 's-1')).toHaveLength(0);
    expect(broadcasts).toEqual([]);
  });

  it('more than MAX children → TOO_MANY_CHILDREN', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 });
    const broadcasts: DeltaChange[][] = [];
    const tooMany = Array.from({ length: SPLIT_MAX_CHILDREN + 1 }, (_, i) => ({ text: `c-${i}` }));

    const reply = call(state, fakeSock(HOST_ID), splitEnv('s-1', tooMany), broadcasts);

    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('TOO_MANY_CHILDREN');
  });

  it('empty (whitespace-only) child text → EMPTY_CHILD_TEXT, no partial state', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 });
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'ok' }, { text: '   ' }]), broadcasts);

    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('EMPTY_CHILD_TEXT');
    expect(rowsByOrder(state).find((r) => r.id === 's-1')!.state).toBe('pending');
    expect(rowsByOrder(state).filter((r) => r.split_parent_id === 's-1')).toHaveLength(0);
    expect(broadcasts).toEqual([]);
  });

  it('terminal parent (committed / skipped / split) → STORY_NOT_SPLITTABLE', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 });
    openVoting(state.storage.sql, { storyId: 's-1', now: 100 });
    revealVotes(state.storage.sql, { storyId: 's-1', now: 200 });
    commitStory(state.storage.sql, { storyId: 's-1', finalEstimate: '5' });
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A1' }, { text: 'A2' }]), broadcasts);

    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_SPLITTABLE');

    // skipped
    const state2 = baseRoom();
    addStory(state2.storage.sql, { storyId: 's-1', text: 'A', now: 0 });
    skipStory(state2.storage.sql, { storyId: 's-1' });
    const r2 = call(state2, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A1' }, { text: 'A2' }]), []);
    expect((r2[0].payload as { code: string }).code).toBe('STORY_NOT_SPLITTABLE');
  });

  it('unknown storyId → STORY_NOT_FOUND', () => {
    const state = baseRoom();
    const broadcasts: DeltaChange[][] = [];
    const reply = call(state, fakeSock(HOST_ID), splitEnv('nope', [{ text: 'a' }, { text: 'b' }]), broadcasts);
    expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_FOUND');
    expect(broadcasts).toEqual([]);
  });
});

describe('SPLIT_STORY — non-host rejected (SI-02)', () => {
  it('voter sender → NOT_HOST, no change, no broadcast', () => {
    const state = baseRoom();
    addStory(state.storage.sql, { storyId: 's-1', text: 'A', now: 0 });
    const broadcasts: DeltaChange[][] = [];

    const reply = call(state, fakeSock(VOTER_ID), splitEnv('s-1', [{ text: 'a' }, { text: 'b' }]), broadcasts);

    expect(reply[0].type).toBe('ERROR');
    expect((reply[0].payload as { code: string }).code).toBe('NOT_HOST');
    expect(rowsByOrder(state).find((r) => r.id === 's-1')!.state).toBe('pending');
    expect(broadcasts).toEqual([]);
  });
});
