/**
 * S9.i.c2 — OPEN_ASYNC handler.
 *
 * Host-only message. Validates payload, calls openAsyncWindow op, arms the
 * close alarm, broadcasts async_window_opened.
 *
 * Coexistence with vacancy: the scheduler multiplexes via MIN(at) so the
 * pre-existing host_vacant alarm is preserved — the async_close alarm
 * arms alongside it. Asserted explicitly below.
 */
import { describe, it, expect } from 'vitest';
import type {
  AsyncWindowDuration, DeltaChange, DeltaPayload, Envelope, ErrorPayload,
} from '@pointe/shared';
import { WINDOW_DURATIONS } from '@pointe/shared';
import type {
  DurableObjectState, WebSocket as CfWebSocket,
} from '@cloudflare/workers-types';
type WebSocket = CfWebSocket;
import { handleMessage } from '../src/dispatcher';
import { broadcast } from '../src/broadcast';
import {
  addStory, addVoter, createRoom, getHostVoterId,
} from '../src/operations';
import { scheduleTask } from '../src/scheduler';
import { withRoom, withRoomInstance } from './helpers/pool';

const HOST = 'host-1';
const VOTER = 'v-1';
const NOW = 1_700_000_000_000;

function fakeWs(att: { voterId: string; role: 'host' | 'voter' | 'spectator' }): {
  ws: WebSocket; sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    ws: {
      send: (s: string) => { sent.push(s); },
      serializeAttachment: () => {},
      deserializeAttachment: () => att,
      close: () => {},
    } as unknown as WebSocket,
  };
}

/** Real WebSocketPair → accepted by DO state. Pattern from hostVacancy tests. */
function makeRealSock(
  state: DurableObjectState,
  attachment: { voterId: string; role: 'host' | 'voter' | 'spectator' },
): { server: WebSocket; received: Envelope[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pair = new (globalThis as any).WebSocketPair() as { 0: WebSocket; 1: WebSocket };
  const client = pair[0];
  const server = pair[1];
  state.acceptWebSocket(server);
  server.serializeAttachment(attachment);
  const received: Envelope[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).accept();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).addEventListener('message', (ev: { data: string | ArrayBuffer }) => {
    if (typeof ev.data === 'string') received.push(JSON.parse(ev.data) as Envelope);
  });
  return { server, received };
}

function seedAsyncRoom(sql: SqlStorage, opts: { stories?: number } = {}) {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'async', now: NOW,
  });
  addVoter(sql, { voterId: VOTER, displayName: 'Ben', now: NOW });
  const count = opts.stories ?? 3;
  for (let i = 0; i < count; i++) {
    addStory(sql, { storyId: `st-${i + 1}`, text: `story ${i + 1}`, now: NOW + i });
  }
}

function openAsyncEnv(window: AsyncWindowDuration = '4h', id = 'oa-1'): string {
  return JSON.stringify({ v: 1, type: 'OPEN_ASYNC', id, at: 0, payload: { window } });
}

function runOpenAsync(
  sql: SqlStorage,
  sockets: { ws: WebSocket; sent: string[] }[],
  senderWs: WebSocket,
  envRaw: string = openAsyncEnv(),
  scheduleAsyncClose: (closesAt: number) => void = () => {},
): Envelope[] {
  const ctx = {
    getWebSockets: () => sockets.map((s) => s.ws),
  } as unknown as DurableObjectState;
  return handleMessage(
    sql, senderWs, envRaw,
    (changes, opts) => broadcast(ctx, changes, getHostVoterId(sql), opts),
    undefined, undefined, undefined,
    scheduleAsyncClose,
  );
}

function deltaFrom(sent: string[]): DeltaChange[] {
  for (const raw of sent) {
    const env = JSON.parse(raw) as Envelope<DeltaPayload>;
    if (env.type === 'DELTA') return env.payload.changes;
  }
  return [];
}

// ---- Happy path ------------------------------------------------------------

describe('OPEN_ASYNC — happy path', () => {
  it('host on an async room with pending stories → window stamped, all stories active, broadcast carries async_window_opened with storyIds', async () => {
    await withRoom((sql) => {
      seedAsyncRoom(sql, { stories: 3 });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      const calls: number[] = [];

      const out = runOpenAsync(
        sql, [sockHost, sockVoter], sockHost.ws,
        openAsyncEnv('4h'),
        (closesAt) => calls.push(closesAt),
      );
      expect(out).toEqual([]); // accept, no direct reply

      // Room state: async_window populated; state='active'.
      const room = sql.exec<{ async_window: string | null; state: string }>(
        `SELECT async_window, state FROM room LIMIT 1`,
      ).toArray()[0];
      expect(room.async_window).not.toBeNull();
      expect(room.state).toBe('active');
      const win = JSON.parse(room.async_window!);
      expect(win.closesAt - win.opensAt).toBe(WINDOW_DURATIONS['4h']);

      // All stories are active.
      const states = sql.exec<{ state: string }>(
        `SELECT state FROM story ORDER BY order_index ASC`,
      ).toArray().map((r) => r.state);
      expect(states).toEqual(['active', 'active', 'active']);

      // Voter received an `async_window_opened` change carrying all storyIds.
      const changes = deltaFrom(sockVoter.sent);
      const opened = changes.find((c) => c.kind === 'async_window_opened');
      expect(opened).toBeDefined();
      if (opened?.kind !== 'async_window_opened') throw new Error('expected async_window_opened');
      expect(opened.storyIds.sort()).toEqual(['st-1', 'st-2', 'st-3']);
      expect(opened.closesAt - opened.opensAt).toBe(WINDOW_DURATIONS['4h']);

      // The scheduleAsyncClose callback fired with closesAt.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe(opened.closesAt);
    });
  });

  it('arms the alarm at closesAt via the real scheduler (end-to-end through Room.ts wiring)', async () => {
    await withRoomInstance(async (room, state) => {
      const sql = state.storage.sql;
      seedAsyncRoom(sql, { stories: 1 });
      const host = makeRealSock(state, { voterId: HOST, role: 'host' });
      // Use Room.webSocketMessage so we exercise the production scheduling
      // callback wiring (room.ts → scheduleTask → setAlarm).
      await room.webSocketMessage(host.server, openAsyncEnv('4h'));
      // Fire-and-forget — give the scheduler a tick to complete.
      await new Promise((r) => setTimeout(r, 20));

      const taskRow = sql.exec<{ at: number; type: string }>(
        `SELECT at, type FROM scheduled_task WHERE type = 'async_close'`,
      ).toArray()[0];
      expect(taskRow).toBeDefined();
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBe(taskRow.at); // MIN(at) → the async_close
    });
  });

  it('a pre-existing host_vacant task is NOT clobbered when OPEN_ASYNC arms async_close (scheduler multiplexes via MIN(at))', async () => {
    await withRoomInstance(async (room, state) => {
      const sql = state.storage.sql;
      seedAsyncRoom(sql, { stories: 1 });
      // Arm a host_vacant task SOONER than the async_close will be.
      const vacantAt = Date.now() + 5_000;
      await scheduleTask(state.storage, 'host_vacant', vacantAt, { hostVoterId: HOST, disconnectedAt: Date.now() });

      const host = makeRealSock(state, { voterId: HOST, role: 'host' });
      await room.webSocketMessage(host.server, openAsyncEnv('24h'));
      await new Promise((r) => setTimeout(r, 20));

      const tasks = sql.exec<{ type: string; at: number }>(
        `SELECT type, at FROM scheduled_task ORDER BY at ASC`,
      ).toArray();
      // Both tasks exist; the alarm is set to the earlier one (vacancy).
      expect(tasks.map((t) => t.type).sort()).toEqual(['async_close', 'host_vacant']);
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBe(vacantAt); // the SOONER task — vacancy was NOT clobbered
    });
  });
});

// ---- Guards ----------------------------------------------------------------

describe('OPEN_ASYNC — guards', () => {
  it('non-host → NOT_HOST; no window; no alarm', async () => {
    await withRoom((sql) => {
      seedAsyncRoom(sql, { stories: 1 });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
      const calls: number[] = [];
      const out = runOpenAsync(
        sql, [sockHost, sockVoter], sockVoter.ws,
        openAsyncEnv(), (n) => calls.push(n),
      );
      expect((out[0].payload as ErrorPayload).code).toBe('NOT_HOST');
      expect(calls).toEqual([]);
      const room = sql.exec<{ async_window: string | null }>(
        `SELECT async_window FROM room LIMIT 1`,
      ).toArray()[0];
      expect(room.async_window).toBeNull();
    });
  });

  it('sync-mode room → ROOM_NOT_ASYNC; no transitions', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
      });
      addStory(sql, { storyId: 'st-1', text: 't', now: NOW });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const out = runOpenAsync(sql, [sockHost], sockHost.ws);
      expect((out[0].payload as ErrorPayload).code).toBe('ROOM_NOT_ASYNC');
      const story = sql.exec<{ state: string }>(`SELECT state FROM story LIMIT 1`).toArray()[0];
      expect(story.state).toBe('pending'); // untouched
    });
  });

  it('double OPEN_ASYNC → ASYNC_ALREADY_OPENED (second call rejected; window unchanged)', async () => {
    await withRoom((sql) => {
      seedAsyncRoom(sql, { stories: 1 });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      // First open succeeds.
      runOpenAsync(sql, [sockHost], sockHost.ws, openAsyncEnv('4h', 'first'));
      const winBefore = sql.exec<{ async_window: string | null }>(
        `SELECT async_window FROM room LIMIT 1`,
      ).toArray()[0].async_window;
      // Second open rejected.
      const out = runOpenAsync(sql, [sockHost], sockHost.ws, openAsyncEnv('24h', 'second'));
      expect((out[0].payload as ErrorPayload).code).toBe('ASYNC_ALREADY_OPENED');
      const winAfter = sql.exec<{ async_window: string | null }>(
        `SELECT async_window FROM room LIMIT 1`,
      ).toArray()[0].async_window;
      expect(winAfter).toBe(winBefore); // unchanged
    });
  });

  it('no pending stories → NO_PENDING_STORIES', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'async', now: NOW,
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const out = runOpenAsync(sql, [sockHost], sockHost.ws);
      expect((out[0].payload as ErrorPayload).code).toBe('NO_PENDING_STORIES');
    });
  });

  it('invalid window value → INVALID_PAYLOAD', async () => {
    await withRoom((sql) => {
      seedAsyncRoom(sql, { stories: 1 });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const raw = JSON.stringify({
        v: 1, type: 'OPEN_ASYNC', id: 'bad', at: 0,
        payload: { window: '1h' }, // not in WINDOW_DURATIONS
      });
      const out = runOpenAsync(sql, [sockHost], sockHost.ws, raw);
      expect((out[0].payload as ErrorPayload).code).toBe('INVALID_PAYLOAD');
    });
  });
});
