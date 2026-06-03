import { env, runInDurableObject } from 'cloudflare:test';
import type { DurableObjectNamespace, DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { Room } from '../../src/room';

export const ROOM = (env as { ROOM: DurableObjectNamespace }).ROOM;

/**
 * Each call returns a fresh DO instance — its constructor already ran
 * initSchema, so the schema is in place. The callback receives the real
 * `state.storage.sql` (and the Room instance, when needed).
 *
 * Test bodies that only need `sql` use this; tests that need the Room
 * methods (e.g. `instance.alarm()`) destructure `instance` too.
 */
let counter = 0;
export async function withRoom<T>(
  fn: (sql: SqlStorage) => T | Promise<T>,
): Promise<T> {
  const name = `t-${counter++}`;
  const stub = ROOM.get(ROOM.idFromName(name));
  const wake = await stub.fetch(new Request('https://do/state'));
  await wake.arrayBuffer();
  return await runInDurableObject(stub, async (_instance, state) =>
    fn(state.storage.sql),
  );
}

/** Like withRoom but also exposes the Room instance + DurableObjectState — for
 *  tests that drive `room.alarm()`, `room.webSocketClose(...)`, or interact
 *  with the live socket set via `state.acceptWebSocket` / `state.getWebSockets`. */
export async function withRoomInstance<T>(
  fn: (room: Room, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  const name = `t-${counter++}`;
  const stub = ROOM.get(ROOM.idFromName(name));
  const wake = await stub.fetch(new Request('https://do/state'));
  await wake.arrayBuffer();
  return await runInDurableObject(stub, async (instance, state) =>
    fn(instance as unknown as Room, state),
  );
}

/** Build a fake WebSocket with a fixed attachment. The dispatcher only uses
 *  serializeAttachment/deserializeAttachment from this surface. */
export function fakeSock(voterId: string | null, role: 'host' | 'voter' | 'spectator' = 'voter'): WebSocket {
  const attachment = voterId ? { voterId, role } : null;
  return {
    send: () => {},
    serializeAttachment: () => {},
    deserializeAttachment: () => attachment,
    close: () => {},
  } as unknown as WebSocket;
}
