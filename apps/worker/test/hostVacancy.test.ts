import { describe, it, expect, vi } from 'vitest';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { Envelope, HostVacantPayload } from '@pointe/shared';
import { Room, HOST_VACANT_GRACE_MS } from '../src/room';
import { createMockDoState } from './helpers/mockDoState';
import type { Env } from '../src/worker';

// ---- Fixture builders ----

const HOST_ID = 'h-1';
const VOTER_ID = 'v-1';

function fakeSock(attachment: unknown): { ws: WebSocket; sent: Envelope[] } {
  const sent: Envelope[] = [];
  return {
    sent,
    ws: {
      send: (s: string) => { sent.push(JSON.parse(s) as Envelope); },
      serializeAttachment: () => {},
      deserializeAttachment: () => attachment,
      close: () => {},
    } as unknown as WebSocket,
  };
}

async function makeRoomWithHost(opts: { initialState?: 'lobby' | 'active' } = {}): Promise<{
  room: Room;
  state: DurableObjectState;
  sockets: WebSocket[];
  hostSock: { ws: WebSocket; sent: Envelope[] };
}> {
  const state = createMockDoState();
  const sockets: WebSocket[] = [];
  const enhanced = Object.assign(state, { getWebSockets: () => sockets }) as DurableObjectState;
  const room = new Room(enhanced, {} as Env);
  await room.fetch(new Request('https://do/init', {
    method: 'POST',
    body: JSON.stringify({
      roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
      hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync',
    }),
  }));
  // S7.ii-fix: default to 'active' for legacy tests, but allow callers to
  // exercise the real-world premise (rooms start 'lobby' and OQ-011 means
  // they stay that way until that FSM transition lands).
  if (opts.initialState !== 'lobby') {
    state.storage.sql.exec(`UPDATE room SET state = 'active'`);
  }
  const hostSock = fakeSock({ voterId: HOST_ID, role: 'host' });
  sockets.push(hostSock.ws);
  return { room, state, sockets, hostSock };
}

function listTasks(state: DurableObjectState): { type: string; payload: string | null }[] {
  return state.storage.sql
    .exec<{ type: string; payload: string | null }>(
      `SELECT type, payload FROM scheduled_task ORDER BY at`,
    )
    .toArray();
}

function getArmedAlarm(state: DurableObjectState): number | null {
  return state.storage.getAlarm() as unknown as number | null;
}

// ---- Schedule on host departure ----

describe('host-vacancy — schedule on close', () => {
  it("host's last socket closing schedules a host_vacant task with hostVoterId + disconnectedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { room, state, sockets, hostSock } = await makeRoomWithHost();
      // Remove the closing socket from the live list before invoking the hook —
      // mirrors the runtime: by the time webSocketClose runs the socket is gone.
      sockets.splice(0, sockets.length);
      await room.webSocketClose(hostSock.ws, 1006, '', false);

      const tasks = listTasks(state);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].type).toBe('host_vacant');
      const payload = JSON.parse(tasks[0].payload!);
      expect(payload).toEqual({ hostVoterId: HOST_ID, disconnectedAt: 1_000_000 });
      expect(getArmedAlarm(state)).toBe(1_000_000 + HOST_VACANT_GRACE_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-host socket closing schedules NO host_vacant task', async () => {
    const { room, state, sockets } = await makeRoomWithHost();
    const voterSock = fakeSock({ voterId: VOTER_ID, role: 'voter' });
    sockets.push(voterSock.ws);
    sockets.splice(sockets.indexOf(voterSock.ws), 1);
    await room.webSocketClose(voterSock.ws, 1006, '', false);
    expect(listTasks(state)).toHaveLength(0);
  });

  it('host close while ANOTHER live host socket remains → no task', async () => {
    const { room, state, sockets, hostSock } = await makeRoomWithHost();
    const hostSockB = fakeSock({ voterId: HOST_ID, role: 'host' });
    sockets.push(hostSockB.ws);
    // Close the first host socket while host_sock_b is still live.
    sockets.splice(sockets.indexOf(hostSock.ws), 1);
    await room.webSocketClose(hostSock.ws, 1006, '', false);
    expect(listTasks(state)).toHaveLength(0);
  });
});

// ---- Cancel on host reconnect within grace ----

describe('host-vacancy — JOIN cancels the pending task', () => {
  it('JOIN with resumeVoterId === hostVoterId clears the host_vacant row', async () => {
    const { room, state, sockets, hostSock } = await makeRoomWithHost();
    // First, close the host socket to schedule the task.
    sockets.splice(0, sockets.length);
    await room.webSocketClose(hostSock.ws, 1006, '', false);
    expect(listTasks(state)).toHaveLength(1);

    // Now the host reconnects on a fresh socket and JOINs with their voterId.
    const newHostSock = fakeSock(null);
    let bound: unknown = null;
    (newHostSock.ws as unknown as { serializeAttachment(v: unknown): void }).serializeAttachment = (v) => { bound = v; };
    (newHostSock.ws as unknown as { deserializeAttachment(): unknown }).deserializeAttachment = () => bound;
    sockets.push(newHostSock.ws);

    await room.webSocketMessage(newHostSock.ws, JSON.stringify({
      v: 1, type: 'JOIN_ROOM', id: 'c-rejoin', at: 0,
      payload: { slug: 'apt-sparrow-16', resumeVoterId: HOST_ID, role: 'voter' },
    }));

    expect(listTasks(state)).toHaveLength(0);
  });
});

// ---- Alarm fire: vacant transition + broadcast ----

describe('host-vacancy — alarm fire: vacant transition', () => {
  it('host still absent → room.state = host_vacant, hostVacantSince = disconnectedAt, HOST_VACANT broadcast', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    try {
      const { room, state, sockets, hostSock } = await makeRoomWithHost();
      // Add a voter who'll receive the broadcast.
      const voterSock = fakeSock({ voterId: VOTER_ID, role: 'voter' });
      sockets.push(voterSock.ws);
      // Close the host (still absent for the rest of the test).
      sockets.splice(sockets.indexOf(hostSock.ws), 1);
      await room.webSocketClose(hostSock.ws, 1006, '', false);

      // Advance past the grace window, then fire the alarm.
      vi.setSystemTime(2_000_000 + HOST_VACANT_GRACE_MS + 1);
      await room.alarm();

      const roomRow = state.storage.sql
        .exec<{ state: string; host_vacant_since: number | null }>(
          `SELECT state, host_vacant_since FROM room LIMIT 1`,
        ).toArray()[0];
      expect(roomRow.state).toBe('host_vacant');
      expect(roomRow.host_vacant_since).toBe(2_000_000);

      const hostVacantMsg = voterSock.sent.find((m) => m.type === 'HOST_VACANT');
      expect(hostVacantMsg).toBeDefined();
      expect((hostVacantMsg!.payload as HostVacantPayload).vacantSince).toBe(2_000_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- Alarm fire: no-op safety paths ----

describe('host-vacancy — alarm fire: no-op when conditions changed', () => {
  it('host reconnected before fire → no transition, no broadcast', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    try {
      const { room, state, sockets, hostSock } = await makeRoomWithHost();
      const voterSock = fakeSock({ voterId: VOTER_ID, role: 'voter' });
      sockets.push(voterSock.ws);
      sockets.splice(sockets.indexOf(hostSock.ws), 1);
      await room.webSocketClose(hostSock.ws, 1006, '', false);

      // Host comes back: a new socket bound to the host's voterId is live again.
      const rejoinHostSock = fakeSock({ voterId: HOST_ID, role: 'host' });
      sockets.push(rejoinHostSock.ws);

      vi.setSystemTime(3_000_000 + HOST_VACANT_GRACE_MS + 1);
      await room.alarm();

      const stateRow = state.storage.sql
        .exec<{ state: string; host_vacant_since: number | null }>(
          `SELECT state, host_vacant_since FROM room LIMIT 1`,
        ).toArray()[0];
      expect(stateRow.state).toBe('active');
      expect(stateRow.host_vacant_since).toBeNull();
      expect(voterSock.sent.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hostVoterId changed since scheduling → stale task no-ops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    try {
      const { room, state, sockets, hostSock } = await makeRoomWithHost();
      const voterSock = fakeSock({ voterId: VOTER_ID, role: 'voter' });
      sockets.push(voterSock.ws);
      sockets.splice(sockets.indexOf(hostSock.ws), 1);
      await room.webSocketClose(hostSock.ws, 1006, '', false);

      // Host changed: pretend a transfer happened (S7.iii will do this for real).
      state.storage.sql.exec(`UPDATE room SET host_voter_id = ?`, 'h-2');

      vi.setSystemTime(4_000_000 + HOST_VACANT_GRACE_MS + 1);
      await room.alarm();

      const stateRow = state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(stateRow.state).toBe('active');
      expect(voterSock.sent.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('room in wrong state (e.g. closing) → no transition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    try {
      const { room, state, sockets, hostSock } = await makeRoomWithHost();
      const voterSock = fakeSock({ voterId: VOTER_ID, role: 'voter' });
      sockets.push(voterSock.ws);
      sockets.splice(sockets.indexOf(hostSock.ws), 1);
      await room.webSocketClose(hostSock.ws, 1006, '', false);

      // Out-of-band: a closing flow set room.state.
      state.storage.sql.exec(`UPDATE room SET state = 'closing'`);

      vi.setSystemTime(5_000_000 + HOST_VACANT_GRACE_MS + 1);
      await room.alarm();

      const stateRow = state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      // closing should remain — we don't trample it on a vacancy fire.
      expect(stateRow.state).toBe('closing');
      expect(voterSock.sent.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- S7.ii-fix: integration premise + new exclude-list guards ----

describe('host-vacancy — INTEGRATION PREMISE (the test the original suite was missing)', () => {
  it('LOBBY room + host leaves + alarm fires → host_vacant + HOST_VACANT broadcast', async () => {
    // The premise the production probe exposed: rooms are created 'lobby' and
    // nothing flips them to 'active' yet (OQ-011). The fire MUST work here,
    // not just under a synthetic UPDATE state='active' in setup.
    vi.useFakeTimers();
    vi.setSystemTime(6_000_000);
    try {
      const { room, state, sockets, hostSock } = await makeRoomWithHost({ initialState: 'lobby' });
      // Sanity: this room really is 'lobby' (the bug the fix addresses).
      expect(
        state.storage.sql.exec<{ state: string }>(`SELECT state FROM room`).toArray()[0].state,
      ).toBe('lobby');

      const voterSock = fakeSock({ voterId: VOTER_ID, role: 'voter' });
      sockets.push(voterSock.ws);
      sockets.splice(sockets.indexOf(hostSock.ws), 1);
      await room.webSocketClose(hostSock.ws, 1006, '', false);

      vi.setSystemTime(6_000_000 + HOST_VACANT_GRACE_MS + 1);
      await room.alarm();

      const roomRow = state.storage.sql
        .exec<{ state: string; host_vacant_since: number | null }>(
          `SELECT state, host_vacant_since FROM room LIMIT 1`,
        ).toArray()[0];
      expect(roomRow.state).toBe('host_vacant');
      expect(roomRow.host_vacant_since).toBe(6_000_000);
      expect(voterSock.sent.find((m) => m.type === 'HOST_VACANT')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('host-vacancy — exclude-list no-ops', () => {
  it('room.state === "archived" → no transition (terminal)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(7_000_000);
    try {
      const { room, state, sockets, hostSock } = await makeRoomWithHost();
      const voterSock = fakeSock({ voterId: VOTER_ID, role: 'voter' });
      sockets.push(voterSock.ws);
      sockets.splice(sockets.indexOf(hostSock.ws), 1);
      await room.webSocketClose(hostSock.ws, 1006, '', false);

      state.storage.sql.exec(`UPDATE room SET state = 'archived'`);

      vi.setSystemTime(7_000_000 + HOST_VACANT_GRACE_MS + 1);
      await room.alarm();

      const stateRow = state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(stateRow.state).toBe('archived');
      expect(voterSock.sent.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('room.state === "host_vacant" (already vacant — idempotency) → no transition, no second broadcast', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(8_000_000);
    try {
      const { room, state, sockets, hostSock } = await makeRoomWithHost();
      const voterSock = fakeSock({ voterId: VOTER_ID, role: 'voter' });
      sockets.push(voterSock.ws);
      sockets.splice(sockets.indexOf(hostSock.ws), 1);
      await room.webSocketClose(hostSock.ws, 1006, '', false);

      // Some other path already flipped vacancy + recorded a since value.
      state.storage.sql.exec(
        `UPDATE room SET state = 'host_vacant', host_vacant_since = ?`,
        7_999_900,
      );

      vi.setSystemTime(8_000_000 + HOST_VACANT_GRACE_MS + 1);
      await room.alarm();

      // hostVacantSince stays at the earlier value; no second broadcast.
      const stateRow = state.storage.sql
        .exec<{ state: string; host_vacant_since: number | null }>(
          `SELECT state, host_vacant_since FROM room LIMIT 1`,
        ).toArray()[0];
      expect(stateRow.state).toBe('host_vacant');
      expect(stateRow.host_vacant_since).toBe(7_999_900);
      expect(voterSock.sent.find((m) => m.type === 'HOST_VACANT')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
