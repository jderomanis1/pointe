/**
 * S8.i.b — AA-1 recipient-scoped AI serialization.
 *
 * Two surfaces tested:
 *   (a) the pure `projectAiForRecipient` helper — the AA-1 decision point;
 *   (b) the snapshot serializer (`buildSnapshot` via the JOIN_ROOM dispatcher
 *       path) — confirms the `ai` key is OMITTED ENTIRELY for non-hosts when
 *       there's nothing to surface, and present-as-projection otherwise.
 *
 * The capstone shape check asserts a story object is byte-identical between
 * "AI was requested but not shared" and "AI was never requested" for a
 * non-host recipient. This is the seed of S8.v's stream-level capstone
 * (which will diff snapshot + every delta + reveal).
 */
import { describe, it, expect } from 'vitest';
import type { AISuggestion, Envelope, RoomSnapshot, SnapshotStory } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import { projectAiForRecipient, upsertAiSuggestion } from '../src/ai';
import {
  addStory, addVoter, castVote, createRoom, openVoting, revealVotes,
} from '../src/operations';
import { withRoom } from './helpers/pool';

// ---- (a) the pure projector --------------------------------------------------

describe('S8.i.b — projectAiForRecipient (pure)', () => {
  const READY_UNSHARED: AISuggestion = {
    state: 'ready',
    complexity: { level: 'medium', note: 'm' },
    effort: { level: 'low', note: 'e' },
    risk: { level: 'low', note: 'r' },
    unknowns: { level: 'low', note: 'u' },
    suggestedRange: { low: '3', high: '5' },
    rationale: 'because',
    shared: false,
  };
  const READY_SHARED: AISuggestion = { ...READY_UNSHARED, shared: true };
  const PENDING: AISuggestion = { state: 'pending' };
  const FAILED: AISuggestion = { state: 'failed', errorMessage: 'TIMEOUT' };

  it('no suggestion row → undefined for every recipient', () => {
    expect(projectAiForRecipient('active', null, true)).toBeUndefined();
    expect(projectAiForRecipient('active', null, false)).toBeUndefined();
    expect(projectAiForRecipient('revealed', null, false)).toBeUndefined();
  });

  it('host sees ready / pending / failed throughout', () => {
    expect(projectAiForRecipient('pending', READY_UNSHARED, true)).toEqual(READY_UNSHARED);
    expect(projectAiForRecipient('active', PENDING, true)).toEqual(PENDING);
    expect(projectAiForRecipient('active', FAILED, true)).toEqual(FAILED);
    expect(projectAiForRecipient('revealed', READY_UNSHARED, true)).toEqual(READY_UNSHARED);
  });

  it('non-host active story + ready unshared → undefined (AA-1)', () => {
    expect(projectAiForRecipient('active', READY_UNSHARED, false)).toBeUndefined();
  });

  it('non-host revealed + ready BUT shared=false → undefined (AA-1)', () => {
    expect(projectAiForRecipient('revealed', READY_UNSHARED, false)).toBeUndefined();
    expect(projectAiForRecipient('committed', READY_UNSHARED, false)).toBeUndefined();
  });

  it('non-host revealed + ready + shared=true → full suggestion', () => {
    expect(projectAiForRecipient('revealed', READY_SHARED, false)).toEqual(READY_SHARED);
    expect(projectAiForRecipient('committed', READY_SHARED, false)).toEqual(READY_SHARED);
  });

  it('non-host: state != ready → undefined (pending/failed are not shareable by construction)', () => {
    // The union doesn't allow `shared` on pending/failed; verify the projector
    // doesn't expose those states post-reveal even if a caller forced one in.
    expect(projectAiForRecipient('revealed', PENDING, false)).toBeUndefined();
    expect(projectAiForRecipient('revealed', FAILED, false)).toBeUndefined();
  });

  it('non-host: shared=true on an ACTIVE story → undefined (AA-1 defends against a malformed pre-reveal share)', () => {
    expect(projectAiForRecipient('active', READY_SHARED, false)).toBeUndefined();
  });
});

// ---- (b) the snapshot serializer through the dispatcher ---------------------

const HOST = 'host-1';
const VOTER = 'v-1';

function joinEnvelope(voterId: string, id: string): string {
  return JSON.stringify({
    v: 1, type: 'JOIN_ROOM', id, at: 0,
    payload: { slug: 's', resumeVoterId: voterId, role: 'voter' },
  });
}

function fakeWs(attachment: { voterId: string; role: 'host' | 'voter' | 'spectator' }) {
  return {
    send: () => {},
    serializeAttachment: () => {},
    deserializeAttachment: () => attachment,
    close: () => {},
  } as unknown as Parameters<typeof handleMessage>[1];
}

function seedRoomWithStories(sql: SqlStorage): void {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
  });
  addVoter(sql, { voterId: VOTER, displayName: 'Ben', now: 0 });
  // st-rev: open, vote, reveal first so it's in the revealed history.
  addStory(sql, { storyId: 'st-rev', text: 'R', now: 200 });
  openVoting(sql, { storyId: 'st-rev', now: 210 });
  castVote(sql, { storyId: 'st-rev', voterId: VOTER, points: '5', confidence: 4, now: 215 });
  revealVotes(sql, { storyId: 'st-rev', now: 220 });
  // st-active: opened LAST so ANOTHER_STORY_ACTIVE doesn't fire.
  addStory(sql, { storyId: 'st-active', text: 'A', now: 100 });
  openVoting(sql, { storyId: 'st-active', now: 230 });
}

function snapshotFor(sql: SqlStorage, voterId: string, role: 'host' | 'voter'): RoomSnapshot {
  const out: Envelope[] = handleMessage(
    sql,
    fakeWs({ voterId, role }),
    joinEnvelope(voterId, `j-${voterId}`),
  );
  expect(out[0].type).toBe('SNAPSHOT_RESPONSE');
  return out[0].payload as RoomSnapshot;
}

function storyById(snap: RoomSnapshot, id: string): SnapshotStory {
  const s = snap.stories.find((s) => s.id === id);
  expect(s, `expected story ${id} in snapshot`).toBeDefined();
  return s!;
}

describe('S8.i.b — snapshot serializer obeys AA-1', () => {
  it('host snapshot: a ready suggestion on the active story is included (full payload)', async () => {
    await withRoom((sql) => {
      seedRoomWithStories(sql);
      upsertAiSuggestion(sql, {
        storyId: 'st-active', state: 'ready', requestedAt: 105, completedAt: 108,
        payload: {
          complexity: { level: 'medium', note: 'c' },
          effort: { level: 'low', note: 'e' },
          risk: { level: 'low', note: 'r' },
          unknowns: { level: 'low', note: 'u' },
          suggestedRange: { low: '3', high: '5' },
          rationale: 'because',
        },
      });
      const snap = snapshotFor(sql, HOST, 'host');
      const s = storyById(snap, 'st-active');
      expect(s.ai).toBeDefined();
      if (s.ai!.state !== 'ready') throw new Error('expected ready');
      expect(s.ai.suggestedRange).toEqual({ low: '3', high: '5' });
    });
  });

  it('host snapshot: pending suggestion appears as { state: "pending" } (spinner data)', async () => {
    await withRoom((sql) => {
      seedRoomWithStories(sql);
      upsertAiSuggestion(sql, { storyId: 'st-active', state: 'pending', requestedAt: 105 });
      const snap = snapshotFor(sql, HOST, 'host');
      const s = storyById(snap, 'st-active');
      expect(s.ai).toEqual({ state: 'pending' });
    });
  });

  it('host snapshot: failed suggestion appears as { state, errorMessage } — bookkeeping fields stay storage-only', async () => {
    await withRoom((sql) => {
      seedRoomWithStories(sql);
      upsertAiSuggestion(sql, {
        storyId: 'st-active', state: 'failed', errorMessage: 'API_TIMEOUT',
        requestedAt: 100, completedAt: 110,
      });
      const snap = snapshotFor(sql, HOST, 'host');
      const s = storyById(snap, 'st-active');
      expect(s.ai).toEqual({ state: 'failed', errorMessage: 'API_TIMEOUT' });
    });
  });

  it('non-host snapshot: active story with ready+unshared suggestion → ai key OMITTED entirely (not null)', async () => {
    await withRoom((sql) => {
      seedRoomWithStories(sql);
      upsertAiSuggestion(sql, {
        storyId: 'st-active', state: 'ready', requestedAt: 105, completedAt: 108,
        payload: {
          complexity: { level: 'medium', note: 'c' },
          effort: { level: 'low', note: 'e' },
          risk: { level: 'low', note: 'r' },
          unknowns: { level: 'low', note: 'u' },
          suggestedRange: { low: '3', high: '5' },
          rationale: 'because',
        },
      });
      const snap = snapshotFor(sql, VOTER, 'voter');
      const s = storyById(snap, 'st-active');
      expect('ai' in s).toBe(false); // key absent — not present-as-null
    });
  });

  it('non-host snapshot: revealed story with ready suggestion BUT shared=0 → ai key still omitted', async () => {
    await withRoom((sql) => {
      seedRoomWithStories(sql);
      upsertAiSuggestion(sql, {
        storyId: 'st-rev', state: 'ready', requestedAt: 205, completedAt: 215,
        payload: {
          complexity: { level: 'low', note: 'c' },
          effort: { level: 'low', note: 'e' },
          risk: { level: 'low', note: 'r' },
          unknowns: { level: 'low', note: 'u' },
          suggestedRange: { low: '2', high: '3' },
          rationale: 'because',
        },
      });
      const snap = snapshotFor(sql, VOTER, 'voter');
      const s = storyById(snap, 'st-rev');
      expect('ai' in s).toBe(false);
    });
  });

  it('non-host snapshot: revealed story with shared=true ready suggestion → ai present (the post-reveal share path)', async () => {
    await withRoom((sql) => {
      seedRoomWithStories(sql);
      upsertAiSuggestion(sql, {
        storyId: 'st-rev', state: 'ready', requestedAt: 205, completedAt: 215,
        shared: true, sharedAt: 230,
        payload: {
          complexity: { level: 'low', note: 'c' },
          effort: { level: 'low', note: 'e' },
          risk: { level: 'low', note: 'r' },
          unknowns: { level: 'low', note: 'u' },
          suggestedRange: { low: '2', high: '3' },
          rationale: 'because',
        },
      });
      const snap = snapshotFor(sql, VOTER, 'voter');
      const s = storyById(snap, 'st-rev');
      expect(s.ai).toBeDefined();
      if (s.ai!.state !== 'ready') throw new Error('expected ready');
      expect(s.ai.shared).toBe(true);
      // sharedAt is storage-only (not on the wire union).
      const row = sql
        .exec<{ shared_at: number }>(`SELECT shared_at FROM ai_suggestion WHERE story_id = 'st-rev'`)
        .toArray()[0];
      expect(row.shared_at).toBe(230);
      expect(s.ai.suggestedRange).toEqual({ low: '2', high: '3' });
    });
  });

  it('AA-1 indistinguishability (serializer level): a non-host story is deep-equal between "AI requested unshared" and "AI never requested"', async () => {
    const aiRequested = await withRoom((sql) => {
      seedRoomWithStories(sql);
      upsertAiSuggestion(sql, {
        storyId: 'st-active', state: 'ready', requestedAt: 105, completedAt: 108,
        payload: {
          complexity: { level: 'medium', note: 'c' },
          effort: { level: 'low', note: 'e' },
          risk: { level: 'low', note: 'r' },
          unknowns: { level: 'low', note: 'u' },
          suggestedRange: { low: '3', high: '5' },
          rationale: 'because',
        },
      });
      const snap = snapshotFor(sql, VOTER, 'voter');
      return storyById(snap, 'st-active');
    });
    const aiNeverRequested = await withRoom((sql) => {
      seedRoomWithStories(sql);
      // No upsertAiSuggestion — the row never existed.
      const snap = snapshotFor(sql, VOTER, 'voter');
      return storyById(snap, 'st-active');
    });
    expect(aiRequested).toEqual(aiNeverRequested);
    // And the serialized JSON is byte-identical — the leak vector is the
    // presence of the key, even on null values, so JSON.stringify catches
    // it on the wire.
    expect(JSON.stringify(aiRequested)).toBe(JSON.stringify(aiNeverRequested));
  });
});
