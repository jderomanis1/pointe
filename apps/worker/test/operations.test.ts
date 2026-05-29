import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/schema';
import { createRoom, addVoter, getRoomState } from '../src/operations';
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
});
