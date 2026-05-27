import { describe, it, expect, beforeEach } from 'vitest';
import { Room } from '../src/room';
import { createMockDoState } from './helpers/mockDoState';
import type { Env } from '../src/worker';

const HOST_ID = 'host-id';

function initParams() {
  return {
    roomId: 'test-room-id',
    hostUser: { id: HOST_ID, displayName: 'Test Host' },
    scaleType: 'fibonacci' as const,
    topic: 'Test topic',
  };
}

describe('Room', () => {
  let room: Room;

  beforeEach(() => {
    const state = createMockDoState();
    const mockEnv = {} as Env; // Room does not read env in any tested method.
    room = new Room(state, mockEnv);
  });

  describe('init', () => {
    it('creates a room with the host user', async () => {
      const result = await room.init(initParams());
      expect(result.id).toBe('test-room-id');
      expect(result.hostUserId).toBe(HOST_ID);
      expect(result.phase).toBe('voting');
      expect(result.scaleType).toBe('fibonacci');
      expect(result.topic).toBe('Test topic');
      expect(result.users).toHaveLength(1);
      expect(result.users[0].displayName).toBe('Test Host');
      expect(result.users[0].isHost).toBe(true);
      expect(result.users[0].isObserver).toBe(false);
    });

    it('throws ROOM_ALREADY_INITIALIZED if init is called twice', async () => {
      await room.init(initParams());
      await expect(room.init(initParams())).rejects.toThrow('ROOM_ALREADY_INITIALIZED');
    });
  });

  describe('getState', () => {
    it('throws ROOM_NOT_INITIALIZED before init', async () => {
      await expect(room.getState()).rejects.toThrow('ROOM_NOT_INITIALIZED');
    });

    it('returns the room state after init', async () => {
      await room.init(initParams());
      const state = await room.getState();
      expect(state.id).toBe('test-room-id');
      expect(state.users).toHaveLength(1);
      expect(state.votes).toEqual([]);
      expect(state.history).toEqual([]);
    });
  });

  describe('addUser', () => {
    beforeEach(async () => {
      await room.init(initParams());
    });

    it('adds a user with is_host=false, is_observer=false by default', async () => {
      const user = await room.addUser({ displayName: 'Alice' });
      expect(user.displayName).toBe('Alice');
      expect(user.isHost).toBe(false);
      expect(user.isObserver).toBe(false);
      expect(user.id).toBeTruthy();
    });

    it('adds an observer when isObserver: true', async () => {
      const user = await room.addUser({ displayName: 'Obs', isObserver: true });
      expect(user.isObserver).toBe(true);
    });

    it('users are visible in getState() afterward', async () => {
      const user = await room.addUser({ displayName: 'Alice' });
      const state = await room.getState();
      expect(state.users).toHaveLength(2);
      expect(state.users.some((u) => u.id === user.id)).toBe(true);
    });
  });

  describe('castVote', () => {
    beforeEach(async () => {
      await room.init(initParams());
    });

    it('records a vote from a non-observer user', async () => {
      await room.castVote({ userId: HOST_ID, value: '5', confidence: 'high' });
      const state = await room.getState();
      expect(state.votes).toHaveLength(1);
      expect(state.votes[0].userId).toBe(HOST_ID);
      expect(state.votes[0].value).toBe('5');
      expect(state.votes[0].confidence).toBe('high');
    });

    it('throws USER_NOT_FOUND for unknown user id', async () => {
      await expect(
        room.castVote({ userId: 'nobody', value: '5', confidence: 'low' }),
      ).rejects.toThrow('USER_NOT_FOUND');
    });

    it('throws OBSERVER_CANNOT_VOTE for observer user', async () => {
      const obs = await room.addUser({ displayName: 'Obs', isObserver: true });
      await expect(
        room.castVote({ userId: obs.id, value: '3', confidence: 'medium' }),
      ).rejects.toThrow('OBSERVER_CANNOT_VOTE');
    });

    it('throws ROOM_NOT_IN_VOTING_PHASE after revealVotes', async () => {
      await room.revealVotes();
      await expect(
        room.castVote({ userId: HOST_ID, value: '5', confidence: 'high' }),
      ).rejects.toThrow('ROOM_NOT_IN_VOTING_PHASE');
    });
  });

  describe('revealVotes', () => {
    beforeEach(async () => {
      await room.init(initParams());
    });

    it('moves current votes to history and clears current', async () => {
      await room.castVote({ userId: HOST_ID, value: '8', confidence: 'high' });
      const result = await room.revealVotes();
      expect(result.votes).toHaveLength(1);

      const state = await room.getState();
      expect(state.votes).toEqual([]);
      expect(state.history).toHaveLength(1);
      expect(state.history[0].votes).toHaveLength(1);
      expect(state.history[0].votes[0].value).toBe('8');
    });

    it('changes phase to revealed', async () => {
      await room.revealVotes();
      const state = await room.getState();
      expect(state.phase).toBe('revealed');
    });

    it('throws ROOM_NOT_IN_VOTING_PHASE if already revealed', async () => {
      await room.revealVotes();
      await expect(room.revealVotes()).rejects.toThrow('ROOM_NOT_IN_VOTING_PHASE');
    });
  });

  describe('startNextRound', () => {
    beforeEach(async () => {
      await room.init(initParams());
    });

    it('throws ROOM_NOT_IN_REVEALED_PHASE if called before reveal', async () => {
      await expect(room.startNextRound({ topic: 'Next' })).rejects.toThrow(
        'ROOM_NOT_IN_REVEALED_PHASE',
      );
    });

    it('starts a new voting round with the given topic after reveal', async () => {
      await room.revealVotes();
      const state = await room.startNextRound({ topic: 'Next topic' });
      expect(state.phase).toBe('voting');
      expect(state.topic).toBe('Next topic');
    });
  });

  describe('closeRoom', () => {
    it('changes phase to closed', async () => {
      await room.init(initParams());
      await room.closeRoom();
      const state = await room.getState();
      expect(state.phase).toBe('closed');
    });
  });
});
