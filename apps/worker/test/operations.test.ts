import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/schema';
import {
  createRoom, addVoter, addStory, editStory,
  openVoting, castVote, revealVotes, commitStory,
  resumeOrAddVoter, setVoterConnection, getRoomState,
} from '../src/operations';
import { createMockDoState } from './helpers/mockDoState';

function setup() {
  const sql = createMockDoState().storage.sql;
  initSchema(sql);
  return sql;
}

const NOW = 1_700_000_000_000;
const baseParams = {
  roomId: 'room-1',
  slug: 'apt-sparrow-16',
  hostVoterId: 'host-1',
  hostDisplayName: 'Host',
  deck: 'fibonacci' as const,
  mode: 'sync' as const,
  now: NOW,
};

describe('operations', () => {
  it('createRoom + getRoomState: room is lobby, host voter is connected with role host', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    const state = getRoomState(sql);
    expect(state.room.id).toBe('room-1');
    expect(state.room.slug).toBe('apt-sparrow-16');
    expect(state.room.state).toBe('lobby');
    expect(state.room.hostVoterId).toBe('host-1');
    expect(state.voters).toHaveLength(1);
    expect(state.voters[0].id).toBe('host-1');
    expect(state.voters[0].roomId).toBe('room-1');
    expect(state.voters[0].role).toBe('host');
    expect(state.voters[0].connectionState).toBe('connected');
  });

  it('createRoom twice throws ROOM_ALREADY_EXISTS', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    expect(() => createRoom(sql, baseParams)).toThrow('ROOM_ALREADY_EXISTS');
  });

  it('addVoter persists a non-host voter visible in getRoomState', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addVoter(sql, { voterId: 'v-2', displayName: 'Alice', now: NOW + 1 });
    const state = getRoomState(sql);
    expect(state.voters).toHaveLength(2);
    const alice = state.voters.find((v) => v.id === 'v-2');
    expect(alice).toBeDefined();
    expect(alice!.role).toBe('voter');
    expect(alice!.roomId).toBe('room-1');
    expect(alice!.connectionState).toBe('connected');
  });

  it('getRoomState before createRoom throws ROOM_NOT_FOUND', () => {
    const sql = setup();
    expect(() => getRoomState(sql)).toThrow('ROOM_NOT_FOUND');
  });

  it('round-trips customDeck through the custom_deck JSON column', () => {
    const sql = setup();
    createRoom(sql, { ...baseParams, deck: 'custom', customDeck: ['XS', 'S', 'M'] });
    const state = getRoomState(sql);
    expect(state.room.deck).toBe('custom');
    expect(state.room.customDeck).toEqual(['XS', 'S', 'M']);
  });

  it('addStory once: story has state=pending, orderIndex=100, edited=false, roomId set', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'first story', now: NOW + 1 });
    const state = getRoomState(sql);
    expect(state.stories).toHaveLength(1);
    expect(state.stories[0]).toMatchObject({
      id: 's-1',
      roomId: 'room-1',
      orderIndex: 100,
      state: 'pending',
      edited: false,
      text: 'first story',
    });
  });

  it('addStory three times: orderIndex is 100, 200, 300 in order', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    addStory(sql, { storyId: 's-2', text: 'two', now: NOW + 2 });
    addStory(sql, { storyId: 's-3', text: 'three', now: NOW + 3 });
    const state = getRoomState(sql);
    expect(state.stories.map((s) => s.orderIndex)).toEqual([100, 200, 300]);
    expect(state.stories.map((s) => s.id)).toEqual(['s-1', 's-2', 's-3']);
  });

  it('editStory: changes text when no votes exist; edited stays false', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'old text', now: NOW + 1 });
    const updated = editStory(sql, { storyId: 's-1', text: 'new text' });
    expect(updated.text).toBe('new text');
    expect(updated.edited).toBe(false);
    const state = getRoomState(sql);
    expect(state.stories[0].text).toBe('new text');
    expect(state.stories[0].edited).toBe(false);
  });

  it('editStory: edited becomes true if a vote exists when text changes', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'old text', now: NOW + 1 });
    // Seed a vote directly via the mock sql — castVote arrives in R1.iii.b2.
    sql.exec(
      `INSERT INTO vote (story_id, voter_id, points, confidence, submitted_at, updated_at)
       VALUES ('s-1', 'host-1', '5', 3, ?, ?)`,
      NOW + 1, NOW + 1,
    );
    const updated = editStory(sql, { storyId: 's-1', text: 'edited text' });
    expect(updated.text).toBe('edited text');
    expect(updated.edited).toBe(true);
  });

  it('editStory: throws STORY_NOT_FOUND for unknown storyId', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    expect(() => editStory(sql, { storyId: 'nope', text: 'x' })).toThrow('STORY_NOT_FOUND');
  });

  // ---- openVoting ----

  it('openVoting: pending → active and sets openedAt', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    const updated = openVoting(sql, { storyId: 's-1', now: NOW + 2 });
    expect(updated.state).toBe('active');
    expect(updated.openedAt).toBe(NOW + 2);
  });

  it('openVoting: throws ANOTHER_STORY_ACTIVE when another story is already active', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    addStory(sql, { storyId: 's-2', text: 'two', now: NOW + 2 });
    openVoting(sql, { storyId: 's-1', now: NOW + 3 });
    expect(() => openVoting(sql, { storyId: 's-2', now: NOW + 4 })).toThrow('ANOTHER_STORY_ACTIVE');
  });

  it('openVoting: throws STORY_NOT_PENDING when the story is not pending', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    openVoting(sql, { storyId: 's-1', now: NOW + 2 });
    expect(() => openVoting(sql, { storyId: 's-1', now: NOW + 3 })).toThrow('STORY_NOT_PENDING');
  });

  it('openVoting: throws STORY_NOT_FOUND for missing storyId', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    expect(() => openVoting(sql, { storyId: 'nope', now: NOW + 1 })).toThrow('STORY_NOT_FOUND');
  });

  // ---- castVote ----

  function setupActive() {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    openVoting(sql, { storyId: 's-1', now: NOW + 2 });
    return sql;
  }

  it('castVote: records the vote and it appears in getRoomState().votes', () => {
    const sql = setupActive();
    castVote(sql, { storyId: 's-1', voterId: 'host-1', points: '5', confidence: 3, now: NOW + 10 });
    const state = getRoomState(sql);
    expect(state.votes).toHaveLength(1);
    expect(state.votes[0]).toMatchObject({
      storyId: 's-1', voterId: 'host-1', points: '5', confidence: 3,
      submittedAt: NOW + 10, updatedAt: NOW + 10,
    });
  });

  it('castVote: re-cast updates the same row; submittedAt stable, updatedAt advances', () => {
    const sql = setupActive();
    const first = castVote(sql, { storyId: 's-1', voterId: 'host-1', points: '5', confidence: 3, now: NOW + 10 });
    expect(first.submittedAt).toBe(NOW + 10);
    expect(first.updatedAt).toBe(NOW + 10);

    const second = castVote(sql, { storyId: 's-1', voterId: 'host-1', points: '8', confidence: 5, now: NOW + 20 });
    expect(second.points).toBe('8');
    expect(second.confidence).toBe(5);
    expect(second.submittedAt).toBe(NOW + 10); // preserved
    expect(second.updatedAt).toBe(NOW + 20);   // advanced

    const state = getRoomState(sql);
    expect(state.votes).toHaveLength(1); // still one row (composite PK upsert)
    expect(state.votes[0].points).toBe('8');
  });

  it('castVote: throws STORY_NOT_ACTIVE when the story is not active', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    // Story is still pending — not active.
    expect(() =>
      castVote(sql, { storyId: 's-1', voterId: 'host-1', points: '5', confidence: 3, now: NOW + 2 }),
    ).toThrow('STORY_NOT_ACTIVE');
  });

  it('castVote: throws SPECTATOR_CANNOT_VOTE when the voter is a spectator', () => {
    const sql = setupActive();
    addVoter(sql, { voterId: 'spec-1', displayName: 'Spec', role: 'spectator', now: NOW + 5 });
    expect(() =>
      castVote(sql, { storyId: 's-1', voterId: 'spec-1', points: '5', confidence: 3, now: NOW + 10 }),
    ).toThrow('SPECTATOR_CANNOT_VOTE');
  });

  it('castVote: throws VOTER_NOT_FOUND for unknown voterId', () => {
    const sql = setupActive();
    expect(() =>
      castVote(sql, { storyId: 's-1', voterId: 'nobody', points: '5', confidence: 3, now: NOW + 10 }),
    ).toThrow('VOTER_NOT_FOUND');
  });

  it('castVote: rejects confidence outside 1–5 with INVALID_CONFIDENCE', () => {
    const sql = setupActive();
    expect(() =>
      castVote(sql, { storyId: 's-1', voterId: 'host-1', points: '5', confidence: 0, now: NOW + 10 }),
    ).toThrow('INVALID_CONFIDENCE');
    expect(() =>
      castVote(sql, { storyId: 's-1', voterId: 'host-1', points: '5', confidence: 6, now: NOW + 11 }),
    ).toThrow('INVALID_CONFIDENCE');
  });

  // ---- revealVotes ----

  it('revealVotes: active → revealed; sets revealedAt; returns the votes', () => {
    const sql = setupActive();
    castVote(sql, { storyId: 's-1', voterId: 'host-1', points: '5', confidence: 3, now: NOW + 10 });
    const result = revealVotes(sql, { storyId: 's-1', now: NOW + 20 });
    expect(result.story.state).toBe('revealed');
    expect(result.story.revealedAt).toBe(NOW + 20);
    expect(result.votes).toHaveLength(1);
    expect(result.votes[0]).toMatchObject({ storyId: 's-1', voterId: 'host-1', points: '5' });
  });

  it('revealVotes: throws STORY_NOT_ACTIVE on a non-active story', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    // Story is pending, never opened.
    expect(() => revealVotes(sql, { storyId: 's-1', now: NOW + 2 })).toThrow('STORY_NOT_ACTIVE');
  });

  // ---- commitStory ----

  it('commitStory: revealed → committed and sets finalEstimate', () => {
    const sql = setupActive();
    revealVotes(sql, { storyId: 's-1', now: NOW + 20 });
    const committed = commitStory(sql, { storyId: 's-1', finalEstimate: '5' });
    expect(committed.state).toBe('committed');
    expect(committed.finalEstimate).toBe('5');
  });

  it('commitStory: throws STORY_NOT_REVEALED on a non-revealed story', () => {
    const sql = setupActive();
    // Story is active but not revealed yet.
    expect(() =>
      commitStory(sql, { storyId: 's-1', finalEstimate: '5' }),
    ).toThrow('STORY_NOT_REVEALED');
  });

  // ---- resumeOrAddVoter ----

  it('resumeOrAddVoter: new voter requires displayName; missing → DISPLAY_NAME_REQUIRED', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    expect(() =>
      resumeOrAddVoter(sql, { voterId: 'v-new', role: 'voter', now: NOW + 5 }),
    ).toThrow('DISPLAY_NAME_REQUIRED');
  });

  it('resumeOrAddVoter: new path inserts a fresh voter with the given role', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    const v = resumeOrAddVoter(sql, {
      voterId: 'v-new', displayName: 'New', role: 'voter', now: NOW + 5,
    });
    expect(v.id).toBe('v-new');
    expect(v.displayName).toBe('New');
    expect(v.role).toBe('voter');
    expect(v.connectionState).toBe('connected');
    expect(getRoomState(sql).voters.some((x) => x.id === 'v-new')).toBe(true);
  });

  it('setVoterConnection: updates connection_state and last_seen_at; visible via getRoomState', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    setVoterConnection(sql, { voterId: 'host-1', connectionState: 'left', now: NOW + 100 });
    const voter = getRoomState(sql).voters.find((v) => v.id === 'host-1');
    expect(voter?.connectionState).toBe('left');
    expect(voter?.lastSeenAt).toBe(NOW + 100);
  });

  it('resumeOrAddVoter: resume reuses the existing voter id; keeps name/role; reactivates connection', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    // host-1 already exists from createRoom; resume them with a different requested role.
    const v = resumeOrAddVoter(sql, {
      voterId: 'ignored', resumeVoterId: 'host-1',
      displayName: 'ignored-too', role: 'spectator', now: NOW + 5,
    });
    expect(v.id).toBe('host-1');                 // keeps original id
    expect(v.role).toBe('host');                 // keeps original role (NOT 'spectator')
    expect(v.displayName).toBe('Host');          // keeps original displayName
    expect(v.connectionState).toBe('connected'); // reactivated
    expect(v.lastSeenAt).toBe(NOW + 5);
    expect(getRoomState(sql).voters).toHaveLength(1);
  });
});
