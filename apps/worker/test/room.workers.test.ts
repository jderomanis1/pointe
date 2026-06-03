import { describe, it, expect } from 'vitest';
import type { DurableObjectState, WebSocket as CfWebSocket } from '@cloudflare/workers-types';
import type { Envelope } from '@pointe/shared';
import { addVoter } from '../src/operations';
import { ROOM, withRoomInstance } from './helpers/pool';

const initBody = {
  roomId: 'r-1',
  slug: 'apt-sparrow-16',
  hostVoterId: 'h-1',
  hostDisplayName: 'Host',
  deck: 'fibonacci',
  mode: 'sync',
};

type Sock = { server: CfWebSocket; client: CfWebSocket; received: Envelope[] };

function makeSock(state: DurableObjectState, attachment: unknown): Sock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pair = new (globalThis as any).WebSocketPair() as { 0: CfWebSocket; 1: CfWebSocket };
  const client = pair[0];
  const server = pair[1];
  state.acceptWebSocket(server);
  if (attachment !== undefined) server.serializeAttachment(attachment);
  const received: Envelope[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).accept();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).addEventListener('message', (ev: { data: string | ArrayBuffer }) => {
    if (typeof ev.data === 'string') received.push(JSON.parse(ev.data) as Envelope);
  });
  return { server, client, received };
}

describe('Room (DO shell) — real DO SQLite', () => {
  it('POST /init creates the room; GET /state returns it with the host voter', async () => {
    const stub = ROOM.get(ROOM.idFromName('room-shell-1'));
    await (await stub.fetch(new Request('https://do/state'))).arrayBuffer();
    const initRes = await stub.fetch(
      new Request('https://do/init', { method: 'POST', body: JSON.stringify(initBody) }),
    );
    expect(initRes.status).toBe(201);
    await initRes.arrayBuffer();

    const stateRes = await stub.fetch(new Request('https://do/state', { method: 'GET' }));
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
    const stub = ROOM.get(ROOM.idFromName('room-shell-2'));
    const res = await stub.fetch(new Request('https://do/nope', { method: 'POST' }));
    expect(res.status).toBe(404);
    await res.arrayBuffer();
  });

  it('webSocketClose marks the voter `left` and broadcasts `voter_left` to peers (excludes closer)', async () => {
    await withRoomInstance(async (room, state) => {
      // Init the room via the public fetch path.
      const initRes = await room.fetch(
        new Request('https://do/init', { method: 'POST', body: JSON.stringify(initBody) }),
      );
      expect(initRes.status).toBe(201);
      addVoter(state.storage.sql, { voterId: 'v-a', displayName: 'A', now: Date.now() });

      const peer = makeSock(state, { voterId: 'h-1', role: 'host' });
      const closing = makeSock(state, { voterId: 'v-a', role: 'voter' });

      await room.webSocketClose(closing.server, 1000, 'bye', true);
      await new Promise((r) => setTimeout(r, 10));

      const stateRes = await room.fetch(new Request('https://do/state'));
      const stateBody = (await stateRes.json()) as {
        voters: { id: string; connectionState: string }[];
      };
      const va = stateBody.voters.find((v) => v.id === 'v-a');
      expect(va?.connectionState).toBe('left');

      const delta = peer.received.find((m) => m.type === 'DELTA') as
        | Envelope & { payload: { changes: { kind: string; voterId?: string }[] } }
        | undefined;
      expect(delta).toBeDefined();
      expect(delta!.payload.changes[0]).toEqual({ kind: 'voter_left', voterId: 'v-a' });
      expect(closing.received).toEqual([]); // sender excluded
    });
  });

  it('webSocketClose does not throw when the socket has no attachment (never JOINed)', async () => {
    await withRoomInstance(async (room, state) => {
      await room.fetch(
        new Request('https://do/init', { method: 'POST', body: JSON.stringify(initBody) }),
      );
      // attachment === undefined → don't call serializeAttachment at all.
      const unattached = makeSock(state, undefined);
      await expect(room.webSocketClose(unattached.server, 1000, '', false)).resolves.toBeUndefined();
    });
  });
});
