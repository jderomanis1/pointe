/**
 * S7.ii host-vacancy — real Cloudflare DO SQLite + real WebSocket sockets.
 *
 * Mock-vs-real notes:
 * - The better-sqlite3 mock simulated `state.getWebSockets()` from an
 *   array the test mutated by hand. Real DO returns sockets actually
 *   accepted via `state.acceptWebSocket(...)`. In the workerd test
 *   harness `server.close()` does NOT remove the socket from
 *   `getWebSockets()` (the runtime would, on a real close event, but
 *   that loop doesn't run inside `runInDurableObject`). So after the
 *   `webSocketClose` handler ran we clear the socket's attachment —
 *   that makes `hostIsLive(hostVoterId)` skip it (the check uses
 *   attachment.voterId, not socket identity), which is functionally
 *   identical to the runtime taking it out of the set.
 * - The mock honored `vi.useFakeTimers()` because Date lived in node.
 *   Workerd uses its own time. To make the alarm fire on demand we
 *   force-due the task row directly (`UPDATE scheduled_task SET at = 0`)
 *   then call `room.alarm()` — the scheduler queries `at <= Date.now()`
 *   either way, so the contract is unchanged.
 */
import { describe, it, expect } from 'vitest';
import type {
  DurableObjectState,
  WebSocket as CfWebSocket,
} from '@cloudflare/workers-types';
import type { Envelope, HostVacantPayload } from '@pointe/shared';
import { HOST_VACANT_GRACE_MS } from '../src/room';
import { addVoter, createRoom } from '../src/operations';
import { withRoomInstance } from './helpers/pool';

const HOST_ID = 'h-1';
const VOTER_ID = 'v-1';

type Sock = {
  server: CfWebSocket;
  client: CfWebSocket;
  received: Envelope[];
};

function makeSock(state: DurableObjectState, attachment: unknown): Sock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pair = new (globalThis as any).WebSocketPair() as {
    0: CfWebSocket;
    1: CfWebSocket;
  };
  const client = pair[0];
  const server = pair[1];
  state.acceptWebSocket(server);
  if (attachment) server.serializeAttachment(attachment);
  const received: Envelope[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).accept();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).addEventListener('message', (ev: { data: string | ArrayBuffer }) => {
    if (typeof ev.data === 'string') received.push(JSON.parse(ev.data) as Envelope);
  });
  return { server, client, received };
}

function seedRoom(sql: SqlStorage): void {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 1_000,
  });
  // Default to 'active' to match the original suite; lobby-premise test overrides.
  sql.exec(`UPDATE room SET state = 'active'`);
  addVoter(sql, { voterId: VOTER_ID, displayName: 'Ben', now: 2_000 });
}

function listTasks(sql: SqlStorage): { type: string; payload: string | null; at: number }[] {
  return sql
    .exec<{ type: string; payload: string | null; at: number }>(
      `SELECT type, payload, at FROM scheduled_task ORDER BY at`,
    )
    .toArray();
}

/** Make every scheduled task immediately due so room.alarm() picks them up. */
function forceTasksDue(sql: SqlStorage): void {
  sql.exec(`UPDATE scheduled_task SET at = 0`);
}

describe('host-vacancy — schedule on close (real DO SQLite + real WS)', () => {
  it("host's last socket closing schedules a host_vacant task with hostVoterId + disconnectedAt", async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const host = makeSock(state, { voterId: HOST_ID, role: 'host' });

      const before = Date.now();
      // Close server first so getWebSockets no longer returns it (mirror runtime).
      host.server.close(1000, 'gone');
      await room.webSocketClose(host.server, 1006, '', false);
      const after = Date.now();

      const tasks = listTasks(state.storage.sql);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].type).toBe('host_vacant');
      const payload = JSON.parse(tasks[0].payload!) as { hostVoterId: string; disconnectedAt: number };
      expect(payload.hostVoterId).toBe(HOST_ID);
      expect(payload.disconnectedAt).toBeGreaterThanOrEqual(before);
      expect(payload.disconnectedAt).toBeLessThanOrEqual(after);
      expect(tasks[0].at).toBe(payload.disconnectedAt + HOST_VACANT_GRACE_MS);
    });
  });

  it('a non-host socket closing schedules NO host_vacant task', async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const voter = makeSock(state, { voterId: VOTER_ID, role: 'voter' });
      voter.server.close(1000, 'gone');
      await room.webSocketClose(voter.server, 1006, '', false);
      expect(listTasks(state.storage.sql)).toHaveLength(0);
    });
  });

  it('host close while ANOTHER live host socket remains → no task', async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const hostA = makeSock(state, { voterId: HOST_ID, role: 'host' });
      makeSock(state, { voterId: HOST_ID, role: 'host' }); // hostB stays live
      hostA.server.close(1000, 'gone');
      await room.webSocketClose(hostA.server, 1006, '', false);
      expect(listTasks(state.storage.sql)).toHaveLength(0);
    });
  });
});

describe('host-vacancy — JOIN cancels the pending task', () => {
  it('JOIN with resumeVoterId === hostVoterId clears the host_vacant row', async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const host = makeSock(state, { voterId: HOST_ID, role: 'host' });
      host.server.close(1000, 'gone');
      await room.webSocketClose(host.server, 1006, '', false);
      expect(listTasks(state.storage.sql)).toHaveLength(1);

      // Host reconnects on a fresh socket; JOIN binds identity AND fires
      // the cancelTasksByType('host_vacant') callback wired into dispatcher.
      const rejoin = makeSock(state, null);
      await room.webSocketMessage(rejoin.server, JSON.stringify({
        v: 1, type: 'JOIN_ROOM', id: 'c-rejoin', at: 0,
        payload: { slug: 'apt-sparrow-16', resumeVoterId: HOST_ID, role: 'voter' },
      }));

      // cancelTasksByType is fire-and-forget; let microtasks drain.
      await Promise.resolve();
      await Promise.resolve();
      expect(listTasks(state.storage.sql)).toHaveLength(0);
    });
  });
});

describe('host-vacancy — alarm fire: vacant transition', () => {
  it('host still absent → room.state = host_vacant, hostVacantSince = disconnectedAt, HOST_VACANT broadcast', async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const voter = makeSock(state, { voterId: VOTER_ID, role: 'voter' });
      const host = makeSock(state, { voterId: HOST_ID, role: 'host' });

      host.server.close(1000, 'gone');
      await room.webSocketClose(host.server, 1006, '', false);
      host.server.serializeAttachment(null); // make hostIsLive ignore the closed sock
      const disconnectedAt = JSON.parse(listTasks(state.storage.sql)[0].payload!).disconnectedAt;

      forceTasksDue(state.storage.sql);
      await room.alarm();
      // Let client message handlers drain after the server pushed via ws.send.
      await new Promise((r) => setTimeout(r, 10));

      const roomRow = state.storage.sql
        .exec<{ state: string; host_vacant_since: number | null }>(
          `SELECT state, host_vacant_since FROM room LIMIT 1`,
        ).toArray()[0];
      expect(roomRow.state).toBe('host_vacant');
      expect(roomRow.host_vacant_since).toBe(disconnectedAt);

      const hostVacantMsg = voter.received.find((m) => m.type === 'HOST_VACANT');
      expect(hostVacantMsg).toBeDefined();
      expect((hostVacantMsg!.payload as HostVacantPayload).vacantSince).toBe(disconnectedAt);
    });
  });
});

describe('host-vacancy — alarm fire: no-op when conditions changed', () => {
  it('host reconnected before fire → no transition, no broadcast', async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const voter = makeSock(state, { voterId: VOTER_ID, role: 'voter' });
      const host = makeSock(state, { voterId: HOST_ID, role: 'host' });
      host.server.close(1000, 'gone');
      await room.webSocketClose(host.server, 1006, '', false);

      // Host comes back: a new socket bound to host voterId is live again.
      makeSock(state, { voterId: HOST_ID, role: 'host' });

      forceTasksDue(state.storage.sql);
      await room.alarm();

      const row = state.storage.sql
        .exec<{ state: string; host_vacant_since: number | null }>(
          `SELECT state, host_vacant_since FROM room LIMIT 1`,
        ).toArray()[0];
      expect(row.state).toBe('active');
      expect(row.host_vacant_since).toBeNull();
      expect(voter.received.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    });
  });

  it('hostVoterId changed since scheduling → stale task no-ops', async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const voter = makeSock(state, { voterId: VOTER_ID, role: 'voter' });
      const host = makeSock(state, { voterId: HOST_ID, role: 'host' });
      host.server.close(1000, 'gone');
      await room.webSocketClose(host.server, 1006, '', false);

      state.storage.sql.exec(`UPDATE room SET host_voter_id = ?`, 'h-2');

      forceTasksDue(state.storage.sql);
      await room.alarm();

      const row = state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(row.state).toBe('active');
      expect(voter.received.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    });
  });

  it('room in wrong state (e.g. closing) → no transition', async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const voter = makeSock(state, { voterId: VOTER_ID, role: 'voter' });
      const host = makeSock(state, { voterId: HOST_ID, role: 'host' });
      host.server.close(1000, 'gone');
      await room.webSocketClose(host.server, 1006, '', false);

      state.storage.sql.exec(`UPDATE room SET state = 'closing'`);

      forceTasksDue(state.storage.sql);
      await room.alarm();

      const row = state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(row.state).toBe('closing');
      expect(voter.received.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    });
  });
});

describe('host-vacancy — INTEGRATION PREMISE (lobby state)', () => {
  it('LOBBY room + host leaves + alarm fires → host_vacant + HOST_VACANT broadcast', async () => {
    await withRoomInstance(async (room, state) => {
      // Re-seed without forcing 'active' — exercise the lobby premise OQ-011 exposed.
      createRoom(state.storage.sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 1_000,
      });
      addVoter(state.storage.sql, { voterId: VOTER_ID, displayName: 'Ben', now: 2_000 });
      expect(
        state.storage.sql.exec<{ state: string }>(`SELECT state FROM room`).toArray()[0].state,
      ).toBe('lobby');

      const voter = makeSock(state, { voterId: VOTER_ID, role: 'voter' });
      const host = makeSock(state, { voterId: HOST_ID, role: 'host' });
      host.server.close(1000, 'gone');
      await room.webSocketClose(host.server, 1006, '', false);
      host.server.serializeAttachment(null);
      const disconnectedAt = JSON.parse(listTasks(state.storage.sql)[0].payload!).disconnectedAt;

      forceTasksDue(state.storage.sql);
      await room.alarm();
      await new Promise((r) => setTimeout(r, 10));

      const row = state.storage.sql
        .exec<{ state: string; host_vacant_since: number | null }>(
          `SELECT state, host_vacant_since FROM room LIMIT 1`,
        ).toArray()[0];
      expect(row.state).toBe('host_vacant');
      expect(row.host_vacant_since).toBe(disconnectedAt);
      expect(voter.received.find((m) => m.type === 'HOST_VACANT')).toBeDefined();
    });
  });
});

describe('host-vacancy — exclude-list no-ops', () => {
  it('room.state === "archived" → no transition (terminal)', async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const voter = makeSock(state, { voterId: VOTER_ID, role: 'voter' });
      const host = makeSock(state, { voterId: HOST_ID, role: 'host' });
      host.server.close(1000, 'gone');
      await room.webSocketClose(host.server, 1006, '', false);

      state.storage.sql.exec(`UPDATE room SET state = 'archived'`);

      forceTasksDue(state.storage.sql);
      await room.alarm();

      const row = state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(row.state).toBe('archived');
      expect(voter.received.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    });
  });

  it('room.state === "host_vacant" (already vacant — idempotency) → no transition, no second broadcast', async () => {
    await withRoomInstance(async (room, state) => {
      seedRoom(state.storage.sql);
      const voter = makeSock(state, { voterId: VOTER_ID, role: 'voter' });
      const host = makeSock(state, { voterId: HOST_ID, role: 'host' });
      host.server.close(1000, 'gone');
      await room.webSocketClose(host.server, 1006, '', false);

      // Some other path already flipped vacancy + recorded a since value.
      state.storage.sql.exec(
        `UPDATE room SET state = 'host_vacant', host_vacant_since = ?`,
        7_999_900,
      );

      forceTasksDue(state.storage.sql);
      await room.alarm();

      const row = state.storage.sql
        .exec<{ state: string; host_vacant_since: number | null }>(
          `SELECT state, host_vacant_since FROM room LIMIT 1`,
        ).toArray()[0];
      expect(row.state).toBe('host_vacant');
      expect(row.host_vacant_since).toBe(7_999_900);
      expect(voter.received.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    });
  });
});
