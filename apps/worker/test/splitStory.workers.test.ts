import { describe, it, expect } from 'vitest';
import type { DeltaChange, Envelope, Story } from '@pointe/shared';
import { SPLIT_MAX_CHILDREN } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import {
  addStory, addVoter, castVote, commitStory, createRoom, openVoting, revealVotes,
  skipStory, splitStory,
} from '../src/operations';
import { withRoom, fakeSock } from './helpers/pool';

const HOST_ID = 'h-1';
const VOTER_ID = 'v-1';

function seedRoom(sql: SqlStorage) {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
  });
  addVoter(sql, { voterId: VOTER_ID, displayName: 'Ben', now: 0 });
}

function call(
  sql: SqlStorage,
  ws: ReturnType<typeof fakeSock>,
  envelope: Envelope,
  broadcasts: DeltaChange[][],
): Envelope[] {
  return handleMessage(
    sql, ws, JSON.stringify(envelope),
    (changes) => { broadcasts.push(changes); },
  );
}

const splitEnv = (storyId: string, children: { text: string }[], id = 'c-split'): Envelope =>
  ({ v: 1, type: 'SPLIT_STORY', id, at: 0, payload: { storyId, children } });

type RowShape = { id: string; order_index: number; state: string; text: string; split_parent_id: string | null };
const rowsByOrder = (sql: SqlStorage): RowShape[] =>
  sql.exec<RowShape>(
    `SELECT id, order_index, state, text, split_parent_id FROM story ORDER BY order_index ASC`,
  ).toArray();

describe('splitStory (operation) — placement (real DO SQLite)', () => {
  it('parent in the middle: children land STRICTLY between parent and next, sparse + ordered', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      addStory(sql, { storyId: 's-2', text: 'B', now: 0 });
      addStory(sql, { storyId: 's-3', text: 'C', now: 0 });
      const out = splitStory(sql, { storyId: 's-2', childTexts: ['B1', 'B2', 'B3'], now: 0 });
      const ids = out.children.map((c) => c.id);
      const rows = rowsByOrder(sql);
      const childPositions = ids.map((id) => rows.find((r) => r.id === id)!.order_index);
      expect(childPositions).toEqual([...childPositions].sort((a, b) => a - b));
      expect(Math.min(...childPositions)).toBeGreaterThan(200);
      expect(Math.max(...childPositions)).toBeLessThan(300);
      expect(new Set(childPositions).size).toBe(childPositions.length);
      expect(rows.find((r) => r.id === 's-2')!.order_index).toBe(200);
      expect(rows.find((r) => r.id === 's-2')!.state).toBe('split');
      expect(rows.find((r) => r.id === 's-3')!.order_index).toBe(300);
    });
  });

  it('parent is LAST: children pad the tail with 100-step positions, no resequence', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      splitStory(sql, { storyId: 's-1', childTexts: ['A1', 'A2'], now: 0 });
      const rows = rowsByOrder(sql);
      const parent = rows.find((r) => r.id === 's-1')!;
      expect(parent.state).toBe('split');
      expect(parent.order_index).toBe(100);
      const children = rows.filter((r) => r.split_parent_id === 's-1');
      expect(children.map((c) => c.order_index).sort((a, b) => a - b)).toEqual([200, 300]);
    });
  });

  it('tight gap: shifts the tail when the parent→next gap can\'t fit N children', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      addStory(sql, { storyId: 's-2', text: 'B', now: 0 });
      addStory(sql, { storyId: 's-3', text: 'C', now: 0 });
      sql.exec(`UPDATE story SET order_index = 201 WHERE id = 's-3'`);

      splitStory(sql, { storyId: 's-2', childTexts: ['B1', 'B2', 'B3'], now: 0 });
      const rows = rowsByOrder(sql);
      expect(rows.find((r) => r.id === 's-3')!.order_index).toBeGreaterThan(201);
      const childPositions = rows
        .filter((r) => r.split_parent_id === 's-2')
        .map((r) => r.order_index)
        .sort((a, b) => a - b);
      const cNew = rows.find((r) => r.id === 's-3')!.order_index;
      expect(Math.min(...childPositions)).toBeGreaterThan(200);
      expect(Math.max(...childPositions)).toBeLessThan(cNew);
      expect(new Set(childPositions).size).toBe(3);

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
});

describe('SPLIT_STORY — valid sources (real DO SQLite)', () => {
  it('host splits a pending story → parent split + children pending + story_split broadcast', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'Huge', now: 0 });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A' }, { text: 'B' }]), broadcasts);
      expect(reply).toEqual([]);
      const rows = rowsByOrder(sql);
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
  });

  it('host splits the ACTIVE story → parent split, no active story left, votes inert (preserved)', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      openVoting(sql, { storyId: 's-1', now: 100 });
      castVote(sql, { storyId: 's-1', voterId: VOTER_ID, points: '5', confidence: 4, now: 110 });
      const broadcasts: DeltaChange[][] = [];
      call(sql, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A1' }, { text: 'A2' }]), broadcasts);
      expect(rowsByOrder(sql).find((r) => r.id === 's-1')!.state).toBe('split');
      expect(
        sql.exec<{ id: string }>(`SELECT id FROM story WHERE state = 'active' LIMIT 1`).toArray(),
      ).toEqual([]);
      expect(
        sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vote WHERE story_id = 's-1'`).toArray()[0].n,
      ).toBe(1);
    });
  });

  it('host splits a REVEALED story → parent split, votes inert', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      openVoting(sql, { storyId: 's-1', now: 100 });
      castVote(sql, { storyId: 's-1', voterId: VOTER_ID, points: '5', confidence: 4, now: 110 });
      revealVotes(sql, { storyId: 's-1', now: 200 });
      const broadcasts: DeltaChange[][] = [];
      call(sql, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A1' }, { text: 'A2' }]), broadcasts);
      expect(rowsByOrder(sql).find((r) => r.id === 's-1')!.state).toBe('split');
      expect(
        sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vote WHERE story_id = 's-1'`).toArray()[0].n,
      ).toBe(1);
    });
  });
});

describe('SPLIT_STORY — payload rejects', () => {
  it('fewer than MIN children → TOO_FEW_CHILDREN, atomicity preserved', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A' }]), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('TOO_FEW_CHILDREN');
      expect(rowsByOrder(sql).find((r) => r.id === 's-1')!.state).toBe('pending');
      expect(rowsByOrder(sql).filter((r) => r.split_parent_id === 's-1')).toHaveLength(0);
      expect(broadcasts).toEqual([]);
    });
  });

  it('more than MAX children → TOO_MANY_CHILDREN', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      const broadcasts: DeltaChange[][] = [];
      const tooMany = Array.from({ length: SPLIT_MAX_CHILDREN + 1 }, (_, i) => ({ text: `c-${i}` }));
      const reply = call(sql, fakeSock(HOST_ID), splitEnv('s-1', tooMany), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('TOO_MANY_CHILDREN');
    });
  });

  it('empty (whitespace-only) child text → EMPTY_CHILD_TEXT, no partial state', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'ok' }, { text: '   ' }]), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('EMPTY_CHILD_TEXT');
      expect(rowsByOrder(sql).find((r) => r.id === 's-1')!.state).toBe('pending');
      expect(rowsByOrder(sql).filter((r) => r.split_parent_id === 's-1')).toHaveLength(0);
      expect(broadcasts).toEqual([]);
    });
  });

  it('terminal parent (committed) → STORY_NOT_SPLITTABLE', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      openVoting(sql, { storyId: 's-1', now: 100 });
      revealVotes(sql, { storyId: 's-1', now: 200 });
      commitStory(sql, { storyId: 's-1', finalEstimate: '5' });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A1' }, { text: 'A2' }]), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_SPLITTABLE');
    });
  });

  it('terminal parent (skipped) → STORY_NOT_SPLITTABLE', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      skipStory(sql, { storyId: 's-1' });
      const reply = call(sql, fakeSock(HOST_ID), splitEnv('s-1', [{ text: 'A1' }, { text: 'A2' }]), []);
      expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_SPLITTABLE');
    });
  });

  it('unknown storyId → STORY_NOT_FOUND', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), splitEnv('nope', [{ text: 'a' }, { text: 'b' }]), broadcasts);
      expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_FOUND');
      expect(broadcasts).toEqual([]);
    });
  });
});

describe('SPLIT_STORY — non-host rejected (SI-02)', () => {
  it('voter sender → NOT_HOST, no change, no broadcast', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 0 });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(VOTER_ID), splitEnv('s-1', [{ text: 'a' }, { text: 'b' }]), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('NOT_HOST');
      expect(rowsByOrder(sql).find((r) => r.id === 's-1')!.state).toBe('pending');
      expect(broadcasts).toEqual([]);
    });
  });
});
