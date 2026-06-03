import { describe, it, expect } from 'vitest';
import type { DeltaChange, Envelope } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import { addStory, addVoter, castVote, createRoom, openVoting, revealVotes } from '../src/operations';
import { withRoom, fakeSock } from './helpers/pool';

const HOST_ID = 'h-1';
const VOTER_A = 'v-a';
const VOTER_B = 'v-b';
const STORY_ID = 's-1';

function seedRevealedStory(sql: SqlStorage) {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
  });
  addVoter(sql, { voterId: VOTER_A, displayName: 'Ann', now: 0 });
  addVoter(sql, { voterId: VOTER_B, displayName: 'Bob', now: 0 });
  addStory(sql, { storyId: STORY_ID, text: 'Auth', now: 0 });
  openVoting(sql, { storyId: STORY_ID, now: 100 });
  castVote(sql, { storyId: STORY_ID, voterId: VOTER_A, points: '5', confidence: 4, now: 110 });
  castVote(sql, { storyId: STORY_ID, voterId: VOTER_B, points: '8', confidence: 3, now: 120 });
  revealVotes(sql, { storyId: STORY_ID, now: 200 });
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

const openVotingEnv = (storyId: string, id = 'c-1'): Envelope =>
  ({ v: 1, type: 'OPEN_VOTING', id, at: 0, payload: { storyId } });

const storyState = (sql: SqlStorage, id: string) =>
  sql.exec<{ state: string }>(`SELECT state FROM story WHERE id = ?`, id).toArray()[0].state;

const voteCount = (sql: SqlStorage, id: string) =>
  sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vote WHERE story_id = ?`, id).toArray()[0].n;

const auditEvents = (sql: SqlStorage) =>
  sql.exec<{ event_type: string; at: number; payload: string }>(
    `SELECT event_type, at, payload FROM audit_event ORDER BY at`,
  ).toArray();

describe('OPEN_VOTING — re-open after reveal (OQ-010, real DO SQLite)', () => {
  it('host re-opens a revealed story: state→active, votes cleared, revealedAt nulled, voting_opened broadcast', async () => {
    await withRoom((sql) => {
      seedRevealedStory(sql);
      const broadcasts: DeltaChange[][] = [];
      expect(storyState(sql, STORY_ID)).toBe('revealed');
      expect(voteCount(sql, STORY_ID)).toBe(2);

      const reply = call(sql, fakeSock(HOST_ID), openVotingEnv(STORY_ID), broadcasts);
      expect(reply).toEqual([]);
      expect(storyState(sql, STORY_ID)).toBe('active');
      expect(voteCount(sql, STORY_ID)).toBe(0);
      const revealedAt = sql
        .exec<{ revealed_at: number | null }>(`SELECT revealed_at FROM story WHERE id = ?`, STORY_ID)
        .toArray()[0].revealed_at;
      expect(revealedAt).toBeNull();
      expect(broadcasts).toEqual([[{ kind: 'voting_opened', storyId: STORY_ID }]]);
    });
  });

  it('preserves the round in audit_event BEFORE deletion (preserve-before-destroy)', async () => {
    await withRoom((sql) => {
      seedRevealedStory(sql);
      const broadcasts: DeltaChange[][] = [];
      call(sql, fakeSock(HOST_ID), openVotingEnv(STORY_ID), broadcasts);

      const events = auditEvents(sql);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('votes_revealed');
      expect(events[0].at).toBe(200);
      const payload = JSON.parse(events[0].payload);
      expect(payload.storyId).toBe(STORY_ID);
      expect(payload.reason).toBe('reopened');
      expect(payload.votes).toHaveLength(2);
      expect(payload.stats.median).toBe('5');
      expect(payload.stats.numericCount).toBe(2);
    });
  });

  it('non-host sender → NOT_HOST, nothing changes', async () => {
    await withRoom((sql) => {
      seedRevealedStory(sql);
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(VOTER_A), openVotingEnv(STORY_ID), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('NOT_HOST');
      expect(storyState(sql, STORY_ID)).toBe('revealed');
      expect(voteCount(sql, STORY_ID)).toBe(2);
      expect(broadcasts).toEqual([]);
      expect(auditEvents(sql)).toHaveLength(0);
    });
  });

  it('another story is already active → ANOTHER_STORY_ACTIVE, no transition', async () => {
    await withRoom((sql) => {
      seedRevealedStory(sql);
      addStory(sql, { storyId: 's-2', text: 'Auth phase 2', now: 0 });
      openVoting(sql, { storyId: 's-2', now: 300 });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), openVotingEnv(STORY_ID), broadcasts);
      expect(reply[0].type).toBe('ERROR');
      expect((reply[0].payload as { code: string }).code).toBe('ANOTHER_STORY_ACTIVE');
      expect(storyState(sql, STORY_ID)).toBe('revealed');
      expect(voteCount(sql, STORY_ID)).toBe(2);
      expect(broadcasts).toEqual([]);
      expect(auditEvents(sql)).toHaveLength(0);
    });
  });

  it('FIRST open (pending story) still works and does NOT write an audit event', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
      });
      addStory(sql, { storyId: STORY_ID, text: 'Auth', now: 0 });
      const broadcasts: DeltaChange[][] = [];
      const reply = call(sql, fakeSock(HOST_ID), openVotingEnv(STORY_ID), broadcasts);
      expect(reply).toEqual([]);
      expect(storyState(sql, STORY_ID)).toBe('active');
      expect(broadcasts).toEqual([[{ kind: 'voting_opened', storyId: STORY_ID }]]);
      expect(auditEvents(sql)).toHaveLength(0);
    });
  });

  it('zero-vote re-open audits with empty votes + null median (no crash)', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
      });
      addStory(sql, { storyId: STORY_ID, text: 'Auth', now: 0 });
      openVoting(sql, { storyId: STORY_ID, now: 100 });
      revealVotes(sql, { storyId: STORY_ID, now: 200 });
      const broadcasts: DeltaChange[][] = [];
      call(sql, fakeSock(HOST_ID), openVotingEnv(STORY_ID), broadcasts);
      const events = auditEvents(sql);
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0].payload);
      expect(payload.votes).toEqual([]);
      expect(payload.stats.median).toBeNull();
      expect(payload.stats.numericCount).toBe(0);
    });
  });
});
