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
import type { Envelope, RoomSnapshot, SnapshotStory } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import { projectAiForRecipient, upsertAiSuggestion } from '../src/ai';
import {
  addStory, addVoter, castVote, createRoom, openVoting, revealVotes,
} from '../src/operations';
import { withRoom } from './helpers/pool';

// ---- (a) the pure projector --------------------------------------------------

describe('S8.i.b — projectAiForRecipient (pure)', () => {
  const READY = {
    storyId: 'st-1',
    state: 'ready' as const,
    complexity: { level: 'medium' as const, note: 'm' },
    effort: { level: 'low' as const, note: 'e' },
    risk: { level: 'low' as const, note: 'r' },
    unknowns: { level: 'low' as const, note: 'u' },
    suggestedRange: { low: '3', high: '5' },
    rationale: 'because',
    requestedAt: 1, completedAt: 2,
  };
  const PENDING = { storyId: 'st-1', state: 'pending' as const, requestedAt: 1 };
  const FAILED = { storyId: 'st-1', state: 'failed' as const, errorMessage: 'TIMEOUT', requestedAt: 1, completedAt: 2 };

  it('no suggestion row → undefined for every recipient', () => {
    expect(projectAiForRecipient('active', null, true)).toBeUndefined();
    expect(projectAiForRecipient('active', null, false)).toBeUndefined();
    expect(projectAiForRecipient('revealed', null, false)).toBeUndefined();
  });

  it('host sees ready / pending / failed throughout', () => {
    expect(projectAiForRecipient('pending', READY, true)).toEqual(READY);
    expect(projectAiForRecipient('active', PENDING, true)).toEqual(PENDING);
    expect(projectAiForRecipient('active', FAILED, true)).toEqual(FAILED);
    expect(projectAiForRecipient('revealed', READY, true)).toEqual(READY);
  });

  it('non-host active story + ready unshared → undefined (AA-1)', () => {
    expect(projectAiForRecipient('active', READY, false)).toBeUndefined();
  });

  it('non-host revealed + ready BUT shared=0 → undefined (AA-1)', () => {
    expect(projectAiForRecipient('revealed', READY, false)).toBeUndefined();
    expect(projectAiForRecipient('committed', READY, false)).toBeUndefined();
  });

  it('non-host revealed + ready + shared=true → full suggestion', () => {
    const shared = { ...READY, shared: true, sharedAt: 999 };
    expect(projectAiForRecipient('revealed', shared, false)).toEqual(shared);
    expect(projectAiForRecipient('committed', shared, false)).toEqual(shared);
  });

  it('non-host: shared=true but state != ready → undefined (no surfacing of pending/failed to voters even post-reveal)', () => {
    expect(projectAiForRecipient('revealed', { ...PENDING, shared: true }, false)).toBeUndefined();
    expect(projectAiForRecipient('revealed', { ...FAILED, shared: true }, false)).toBeUndefined();
  });

  it('non-host: shared=true on an ACTIVE story → undefined (AA-1 defends against a malformed pre-reveal share)', () => {
    expect(projectAiForRecipient('active', { ...READY, shared: true }, false)).toBeUndefined();
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
      expect(s.ai!.state).toBe('ready');
      expect(s.ai!.suggestedRange).toEqual({ low: '3', high: '5' });
    });
  });

  it('host snapshot: pending suggestion appears as { storyId, state, requestedAt } (spinner data)', async () => {
    await withRoom((sql) => {
      seedRoomWithStories(sql);
      upsertAiSuggestion(sql, { storyId: 'st-active', state: 'pending', requestedAt: 105 });
      const snap = snapshotFor(sql, HOST, 'host');
      const s = storyById(snap, 'st-active');
      expect(s.ai).toEqual({ storyId: 'st-active', state: 'pending', requestedAt: 105 });
    });
  });

  it('host snapshot: failed suggestion appears with errorMessage', async () => {
    await withRoom((sql) => {
      seedRoomWithStories(sql);
      upsertAiSuggestion(sql, {
        storyId: 'st-active', state: 'failed', errorMessage: 'API_TIMEOUT',
        requestedAt: 100, completedAt: 110,
      });
      const snap = snapshotFor(sql, HOST, 'host');
      const s = storyById(snap, 'st-active');
      expect(s.ai).toEqual({
        storyId: 'st-active', state: 'failed', errorMessage: 'API_TIMEOUT',
        requestedAt: 100, completedAt: 110,
      });
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
      expect(s.ai!.shared).toBe(true);
      expect(s.ai!.sharedAt).toBe(230);
      expect(s.ai!.suggestedRange).toEqual({ low: '2', high: '3' });
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
