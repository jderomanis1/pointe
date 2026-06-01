import { describe, it, expect } from 'vitest';
import { Room } from '../src/room';
import { createMockDoState } from './helpers/mockDoState';
import { addVoter } from '../src/operations';
import type { Env } from '../src/worker';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';

function makeRoom() {
  const state = createMockDoState();
  return new Room(state, {} as Env);
}

// Builds a Room whose DO state also exposes a mutable `getWebSockets()` for fan-out tests.
function makeRoomWithSockets() {
  const state = createMockDoState();
  const sockets: WebSocket[] = [];
  const enhanced = Object.assign(state, { getWebSockets: () => sockets }) as DurableObjectState;
  return { room: new Room(enhanced, {} as Env), state, sockets };
}

function fakeSock(attachment: unknown): { ws: WebSocket; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    ws: {
      send: (s: string) => { sent.push(s); },
      serializeAttachment: () => {},
      deserializeAttachment: () => attachment,
      close: () => {},
    } as unknown as WebSocket,
  };
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

  it('webSocketClose marks the voter `left` and broadcasts `voter_left` to peers (excludes closer)', async () => {
    const { room, state, sockets } = makeRoomWithSockets();
    const initRes = await room.fetch(
      new Request('https://do/init', { method: 'POST', body: JSON.stringify(initBody) }),
    );
    expect(initRes.status).toBe(201);
    addVoter(state.storage.sql, { voterId: 'v-a', displayName: 'A', now: Date.now() });

    const peer = fakeSock({ voterId: 'h-1', role: 'host' });
    const closing = fakeSock({ voterId: 'v-a', role: 'voter' });
    sockets.push(peer.ws, closing.ws);

    await room.webSocketClose(closing.ws, 1000, 'bye', true);

    const stateBody = (await (await room.fetch(new Request('https://do/state'))).json()) as {
      voters: { id: string; connectionState: string }[];
    };
    const va = stateBody.voters.find((v) => v.id === 'v-a');
    expect(va?.connectionState).toBe('left');

    expect(peer.sent).toHaveLength(1);
    const env = JSON.parse(peer.sent[0]) as {
      type: string; payload: { changes: { kind: string; voterId?: string }[] };
    };
    expect(env.type).toBe('DELTA');
    expect(env.payload.changes[0]).toEqual({ kind: 'voter_left', voterId: 'v-a' });
    expect(closing.sent).toEqual([]); // sender excluded
  });

  it('webSocketClose does not throw when the socket has no attachment (never JOINed)', async () => {
    const { room, sockets } = makeRoomWithSockets();
    await room.fetch(
      new Request('https://do/init', { method: 'POST', body: JSON.stringify(initBody) }),
    );
    const unattached = fakeSock(undefined);
    sockets.push(unattached.ws);
    await expect(room.webSocketClose(unattached.ws, 1006, '', false)).resolves.toBeUndefined();
  });
});
