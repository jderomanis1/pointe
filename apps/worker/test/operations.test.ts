import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/schema';
import { createRoom, addVoter, addStory, editStory, getRoomState } from '../src/operations';
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
    const updated = editStory(sql, { storyId: 's-1', text: 'new text', now: NOW + 2 });
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
    const updated = editStory(sql, { storyId: 's-1', text: 'edited text', now: NOW + 2 });
    expect(updated.text).toBe('edited text');
    expect(updated.edited).toBe(true);
  });

  it('editStory: throws STORY_NOT_FOUND for unknown storyId', () => {
    const sql = setup();
    createRoom(sql, baseParams);
    expect(() => editStory(sql, { storyId: 'nope', text: 'x', now: NOW + 1 })).toThrow('STORY_NOT_FOUND');
  });
});
