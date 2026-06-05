/**
 * S10.v.c1 — recipient-own-vote snapshot compliance.
 *
 * Doc 2 §8 says active-story votes are "filtered out except for the voter
 * who cast it." The snapshot serializer previously over-stripped — it set
 * `votes: []` on every active story, regardless of the recipient. That
 * surfaced as "reconnect loses your own vote": the server kept the row,
 * the host's view kept the seat-voted indicator (host's votedPresence is
 * delta-driven, not snapshot-driven), but the reconnecting voter's own
 * UI re-rendered with `myVotes` empty, the cast button flipped back to
 * "Cast estimate", and the deck card deselected.
 *
 * The fix: include the recipient's own active-story vote in the snapshot
 * while still stripping every other voter's. Two halves asserted as one
 * pair: the AA half (others stripped) and the compliance half (own kept).
 */
import { describe, it, expect } from 'vitest';
import type { Envelope, RoomSnapshot, SnapshotStory } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import {
  addStory, addVoter, castVote, createRoom, openVoting,
} from '../src/operations';
import { withRoom } from './helpers/pool';

const HOST = 'host-1';
const ALICE = 'voter-alice';
const BOB = 'voter-bob';

function joinEnvelope(voterId: string, id: string): string {
  // handleMessage expects a raw JSON string (matches the WS frame shape).
  return JSON.stringify({
    v: 1, type: 'JOIN_ROOM', id, at: 0,
    payload: { slug: 'apt-sparrow-16', resumeVoterId: voterId, role: 'voter' },
  });
}

function fakeWs(attachment: { voterId: string; role: 'host' | 'voter' }): Parameters<typeof handleMessage>[1] {
  return {
    send: () => {},
    serializeAttachment: () => {},
    deserializeAttachment: () => attachment,
    close: () => {},
  } as unknown as Parameters<typeof handleMessage>[1];
}

function snapshotFor(sql: SqlStorage, voterId: string, role: 'host' | 'voter'): RoomSnapshot {
  const out: Envelope[] = handleMessage(
    sql,
    fakeWs({ voterId, role }),
    joinEnvelope(voterId, `j-${voterId}`),
  );
  if (out[0].type !== 'SNAPSHOT_RESPONSE') {
    throw new Error(`unexpected envelope: ${JSON.stringify(out[0])}`);
  }
  return out[0].payload as RoomSnapshot;
}

function storyById(snap: RoomSnapshot, id: string): SnapshotStory {
  const s = snap.stories.find((s) => s.id === id);
  expect(s, `expected story ${id} in snapshot`).toBeDefined();
  return s!;
}

function seedActiveRoomWithVotes(sql: SqlStorage): void {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 0,
  });
  addVoter(sql, { voterId: ALICE, displayName: 'Alice', now: 1 });
  addVoter(sql, { voterId: BOB, displayName: 'Bob', now: 2 });
  addStory(sql, { storyId: 'st-active', text: 'A', now: 100 });
  openVoting(sql, { storyId: 'st-active', now: 110 });
  // Both Alice and Bob have cast votes. Different values so a leak would be
  // visible in the assertions.
  castVote(sql, { storyId: 'st-active', voterId: ALICE, points: '5', confidence: 4, now: 120 });
  castVote(sql, { storyId: 'st-active', voterId: BOB,   points: '8', confidence: 3, now: 121 });
}

describe('S10.v.c1 — snapshot includes recipient own vote, strips others', () => {
  it('Alice reconnect: her snapshot carries HER vote on the active story, NOT Bob\'s', async () => {
    await withRoom((sql) => {
      seedActiveRoomWithVotes(sql);
      const snap = snapshotFor(sql, ALICE, 'voter');
      const s = storyById(snap, 'st-active');

      // Compliance half: Alice's own vote is preserved across the snapshot
      // rebuild — this is what makes "reconnect restores your selection"
      // work in the UI.
      const votes = s.votes ?? [];
      const mine = votes.find((v) => v.voterId === ALICE);
      expect(mine, 'Alice\'s own vote should be in her snapshot').toBeDefined();
      expect(mine!.points).toBe('5');
      expect(mine!.confidence).toBe(4);

      // AA half: Bob's value is NOT in Alice's snapshot — anti-anchoring
      // intact. (And no third-party voter either, which falls out for free
      // from the same filter.)
      const others = votes.filter((v) => v.voterId !== ALICE);
      expect(others, 'no other voter\'s value should leak to Alice').toEqual([]);
    });
  });

  it('Bob reconnect: his snapshot carries HIS vote, not Alice\'s', async () => {
    // The symmetric case — proves the filter is recipient-scoped, not
    // "first voter wins" or some other accident.
    await withRoom((sql) => {
      seedActiveRoomWithVotes(sql);
      const snap = snapshotFor(sql, BOB, 'voter');
      const s = storyById(snap, 'st-active');
      const votes = s.votes ?? [];
      expect(votes).toHaveLength(1);
      expect(votes[0].voterId).toBe(BOB);
      expect(votes[0].points).toBe('8');
    });
  });

  it('a voter with no cast vote yet: snapshot active-story votes is empty', async () => {
    // No-cast case — Alice arrives, sees an active story she hasn't voted
    // on yet. The filter shouldn't surface anyone else's value.
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
        hostDisplayName: 'H', deck: 'fibonacci', mode: 'sync', now: 0,
      });
      addVoter(sql, { voterId: ALICE, displayName: 'Alice', now: 1 });
      addVoter(sql, { voterId: BOB, displayName: 'Bob', now: 2 });
      addStory(sql, { storyId: 'st-active', text: 'A', now: 100 });
      openVoting(sql, { storyId: 'st-active', now: 110 });
      // Only Bob votes.
      castVote(sql, { storyId: 'st-active', voterId: BOB, points: '8', confidence: 3, now: 120 });

      const snap = snapshotFor(sql, ALICE, 'voter');
      const s = storyById(snap, 'st-active');
      expect(s.votes ?? []).toEqual([]); // no leak from Bob
    });
  });
});
