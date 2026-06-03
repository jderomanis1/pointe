import { describe, it, expect } from 'vitest';
import type { DeltaChange, Envelope } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import {
  addStory, addVoter, castVote, commitStory, createRoom, openVoting, revealVotes, skipStory,
} from '../src/operations';
import { withRoom, fakeSock } from './helpers/pool';

const HOST_ID = 'h-1';
const VOTER_ID = 'v-1';
const STORY_ID = 's-1';

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

const skipEnv = (storyId: string, id = 'c-skip'): Envelope =>
  ({ v: 1, type: 'SKIP_STORY', id, at: 0, payload: { storyId } });

const storyState = (sql: SqlStorage, id: string): string =>
  sql.exec<{ state: string }>(`SELECT state FROM story WHERE id = ?`, id).toArray()[0].state;

const voteCount = (sql: SqlStorage, id: string): number =>
  sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vote WHERE story_id = ?`, id).toArray()[0].n;

describe('SKIP_STORY — valid source states (real DO SQLite)', () => {
  it('host skips a pending story → skipped + story_skipped broadcast', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: STORY_ID, text: 'A', now: 0 });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);
      expect(reply).toEqual([]);
      expect(storyState(sql, STORY_ID)).toBe('skipped');
      expect(broadcasts).toEqual([[{ kind: 'story_skipped', storyId: STORY_ID }]]);
    });
  });

  it('host skips the ACTIVE story → skipped, no active story remains, votes inert (NOT cleared)', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: STORY_ID, text: 'A', now: 0 });
      openVoting(sql, { storyId: STORY_ID, now: 100 });
      castVote(sql, { storyId: STORY_ID, voterId: VOTER_ID, points: '5', confidence: 4, now: 110 });
      const broadcasts: DeltaChange[][] = [];
      call(sql, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);
      expect(storyState(sql, STORY_ID)).toBe('skipped');
      expect(voteCount(sql, STORY_ID)).toBe(1);
      const anyActive = sql.exec<{ id: string }>(`SELECT id FROM story WHERE state = 'active' LIMIT 1`).toArray();
      expect(anyActive).toHaveLength(0);
    });
  });

  it('host skips a REVEALED story → skipped (post-reveal abandon)', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: STORY_ID, text: 'A', now: 0 });
      openVoting(sql, { storyId: STORY_ID, now: 100 });
      castVote(sql, { storyId: STORY_ID, voterId: VOTER_ID, points: '5', confidence: 4, now: 110 });
      revealVotes(sql, { storyId: STORY_ID, now: 200 });
      const broadcasts: DeltaChange[][] = [];
      call(sql, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);
      expect(storyState(sql, STORY_ID)).toBe('skipped');
      expect(voteCount(sql, STORY_ID)).toBe(1);
    });
  });
});

describe('SKIP_STORY — non-host rejected (SI-02)', () => {
  it('voter sender → NOT_HOST, no change, no broadcast', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: STORY_ID, text: 'A', now: 0 });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(VOTER_ID), skipEnv(STORY_ID), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('NOT_HOST');
      expect(storyState(sql, STORY_ID)).toBe('pending');
      expect(broadcasts).toEqual([]);
    });
  });
});

describe('SKIP_STORY — terminal sources rejected', () => {
  it('committed → STORY_NOT_SKIPPABLE', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: STORY_ID, text: 'A', now: 0 });
      openVoting(sql, { storyId: STORY_ID, now: 100 });
      revealVotes(sql, { storyId: STORY_ID, now: 200 });
      commitStory(sql, { storyId: STORY_ID, finalEstimate: '5' });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_SKIPPABLE');
      expect(storyState(sql, STORY_ID)).toBe('committed');
      expect(broadcasts).toEqual([]);
    });
  });

  it('already-skipped → STORY_NOT_SKIPPABLE', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: STORY_ID, text: 'A', now: 0 });
      skipStory(sql, { storyId: STORY_ID });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_SKIPPABLE');
      expect(storyState(sql, STORY_ID)).toBe('skipped');
      expect(broadcasts).toEqual([]);
    });
  });

  it('split → STORY_NOT_SKIPPABLE', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      addStory(sql, { storyId: STORY_ID, text: 'A', now: 0 });
      sql.exec(`UPDATE story SET state = 'split' WHERE id = ?`, STORY_ID);
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), skipEnv(STORY_ID), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_SKIPPABLE');
    });
  });
});

describe('SKIP_STORY — unknown storyId', () => {
  it('STORY_NOT_FOUND', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), skipEnv('nobody'), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('STORY_NOT_FOUND');
      expect(broadcasts).toEqual([]);
    });
  });
});
