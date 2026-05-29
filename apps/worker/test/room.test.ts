import { describe, it, expect } from 'vitest';
import { Room } from '../src/room';
import { createMockDoState } from './helpers/mockDoState';
import type { Env } from '../src/worker';

function makeRoom() {
  const state = createMockDoState();
  return new Room(state, {} as Env);
}

const initBody = {
  roomId: 'r-1',
  slug: 'apt-sparrow-16',
  hostVoterId: 'h-1',
  hostDisplayName: 'Host',
  deck: 'fibonacci',
  mode: 'sync',
};

describe('Room (DO shell)', () => {
  it('POST /init creates the room; GET /state returns it with the host voter', async () => {
    const room = makeRoom();
    const initRes = await room.fetch(
      new Request('https://do/init', { method: 'POST', body: JSON.stringify(initBody) }),
    );
    expect(initRes.status).toBe(201);

    const stateRes = await room.fetch(new Request('https://do/state', { method: 'GET' }));
    expect(stateRes.status).toBe(200);
    const body = (await stateRes.json()) as {
      room: { state: string; slug: string; deck: string };
      voters: { id: string; role: string; connectionState: string }[];
    };
    expect(body.room.state).toBe('lobby');
    expect(body.room.slug).toBe('apt-sparrow-16');
    expect(body.room.deck).toBe('fibonacci');
    expect(body.voters).toHaveLength(1);
    expect(body.voters[0].id).toBe('h-1');
    expect(body.voters[0].role).toBe('host');
    expect(body.voters[0].connectionState).toBe('connected');
  });

  it('returns 404 for unknown internal paths', async () => {
    const room = makeRoom();
    const res = await room.fetch(new Request('https://do/nope', { method: 'POST' }));
    expect(res.status).toBe(404);
  });
});
