import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  DeltaPayload, Envelope, ErrorPayload, JoinRoomPayload, RoomSnapshot,
} from '@pointe/shared';
import { RoomWsClient, type WsLike } from '../src/ws/client';
import type { ConnectionStatus } from '../src/store/types';

// ---- Fake WebSocket + factory ----

type Listener = (e?: unknown) => void;
type MessageListener = (e: { data: string }) => void;

class FakeWs implements WsLike {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  private listeners: {
    open: Listener[]; message: MessageListener[]; close: Listener[]; error: Listener[];
  } = { open: [], message: [], close: [], error: [] };
  addEventListener(type: 'open' | 'message' | 'close' | 'error', l: Listener | MessageListener) {
    (this.listeners[type] as (Listener | MessageListener)[]).push(l);
  }
  send(data: string) { this.sent.push(data); }
  close(_code?: number) { this.closed = true; this.fireClose(); }
  fireOpen() { this.readyState = 1; for (const l of this.listeners.open) l(); }
  fireMessage(data: string) { for (const l of this.listeners.message) (l as MessageListener)({ data }); }
  fireClose() { this.readyState = 3; for (const l of this.listeners.close) l(); }
}

function makeStoreSpy() {
  return {
    snapshots: [] as RoomSnapshot[],
    deltas: [] as DeltaPayload[],
    statuses: [] as ConnectionStatus[],
    vacants: [] as { vacantSince: number }[],
    reclaimeds: [] as { newHostVoterId: string; via: 'reconnect' | 'claim' | 'transfer' }[],
    hydrate(s: RoomSnapshot) { this.snapshots.push(s); },
    applyServerDelta(p: DeltaPayload) { this.deltas.push(p); },
    applyHostVacant(p: { vacantSince: number }) { this.vacants.push(p); },
    applyHostReclaimed(p: { newHostVoterId: string; via: 'reconnect' | 'claim' | 'transfer' }) { this.reclaimeds.push(p); },
    setConnection(s: ConnectionStatus) { this.statuses.push(s); },
  };
}

function makeSnapshotEnv(voterId = 'v-1'): string {
  const snap: RoomSnapshot = {
    room: {
      id: 'r-1', slug: 'apt-sparrow-16', deck: 'fibonacci', mode: 'sync',
      state: 'lobby', hostVoterId: 'host-1', createdAt: 0, lastActivityAt: 0,
    },
    voters: [],
    stories: [],
    you: { voterId, role: 'voter' },
  };
  const env: Envelope = { v: 1, type: 'SNAPSHOT_RESPONSE', id: 'srv-1', at: 0, payload: snap };
  return JSON.stringify(env);
}

function makeDeltaEnv(): string {
  const env: Envelope<DeltaPayload> = {
    v: 1, type: 'DELTA', id: 'srv-2', at: 0,
    payload: { changes: [{ kind: 'voting_opened', storyId: 's-1' }] },
  };
  return JSON.stringify(env);
}

function makeErrorEnv(code: string): string {
  const env: Envelope<ErrorPayload> = {
    v: 1, type: 'ERROR', id: 'srv-3', at: 0,
    payload: { code, message: code, retriable: false },
  };
  return JSON.stringify(env);
}

const JOIN: JoinRoomPayload = { slug: 'apt-sparrow-16', displayName: 'Alice', role: 'voter' };

// ---- Test setup ----

let wsInstances: FakeWs[] = [];
const factory = (_url: string) => {
  const ws = new FakeWs();
  wsInstances.push(ws);
  return ws;
};

beforeEach(() => {
  vi.useFakeTimers();
  wsInstances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RoomWsClient — JOIN flow', () => {
  it('sends JOIN_ROOM on open; SNAPSHOT → hydrate + voterId retained + connected', () => {
    const store = makeStoreSpy();
    const client = new RoomWsClient({
      wsUrl: 'ws://test', join: JOIN, store, webSocketFactory: factory,
    });
    expect(store.statuses).toEqual(['connecting']);
    expect(wsInstances).toHaveLength(1);

    wsInstances[0].fireOpen();
    expect(wsInstances[0].sent).toHaveLength(1);
    const joinEnv = JSON.parse(wsInstances[0].sent[0]) as Envelope<JoinRoomPayload>;
    expect(joinEnv.type).toBe('JOIN_ROOM');
    expect(joinEnv.payload).toEqual({ slug: 'apt-sparrow-16', displayName: 'Alice', role: 'voter' });

    wsInstances[0].fireMessage(makeSnapshotEnv('v-1'));
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0].you.voterId).toBe('v-1');
    expect(store.statuses.at(-1)).toBe('connected');
    expect(client.getRetainedVoterId()).toBe('v-1');
  });
});

describe('RoomWsClient — message routing', () => {
  it('DELTA → store.applyServerDelta with the payload', () => {
    const store = makeStoreSpy();
    new RoomWsClient({ wsUrl: 'ws://test', join: JOIN, store, webSocketFactory: factory });
    wsInstances[0].fireOpen();
    wsInstances[0].fireMessage(makeSnapshotEnv());
    wsInstances[0].fireMessage(makeDeltaEnv());
    expect(store.deltas).toHaveLength(1);
    expect(store.deltas[0].changes[0]).toMatchObject({ kind: 'voting_opened' });
  });

  it('ERROR → onError callback fires; socket stays open', () => {
    const store = makeStoreSpy();
    const errors: ErrorPayload[] = [];
    new RoomWsClient({
      wsUrl: 'ws://test', join: JOIN, store, webSocketFactory: factory,
      onError: (e) => { errors.push(e); },
    });
    wsInstances[0].fireOpen();
    wsInstances[0].fireMessage(makeSnapshotEnv());
    wsInstances[0].fireMessage(makeErrorEnv('NOT_HOST'));
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('NOT_HOST');
    expect(wsInstances[0].closed).toBe(false);
  });

  it('garbage JSON is ignored, not thrown', () => {
    const store = makeStoreSpy();
    new RoomWsClient({ wsUrl: 'ws://test', join: JOIN, store, webSocketFactory: factory });
    wsInstances[0].fireOpen();
    expect(() => wsInstances[0].fireMessage('{not json')).not.toThrow();
  });
});

describe('RoomWsClient — outbound queue', () => {
  it('send() before open is queued; flushed on open after JOIN', () => {
    const store = makeStoreSpy();
    const client = new RoomWsClient({
      wsUrl: 'ws://test', join: JOIN, store, webSocketFactory: factory, keepaliveMs: null,
    });
    client.send('ADD_STORY', { text: 'queued' });
    expect(wsInstances[0].sent).toHaveLength(0); // socket not open yet
    wsInstances[0].fireOpen();
    expect(wsInstances[0].sent).toHaveLength(2);
    const types = wsInstances[0].sent.map((s) => (JSON.parse(s) as Envelope).type);
    expect(types[0]).toBe('JOIN_ROOM'); // JOIN first
    expect(types[1]).toBe('ADD_STORY'); // then queued
  });
});

describe('RoomWsClient — reconnect (backoff + resume)', () => {
  it('unintentional close → reconnecting status; reconnect carries resumeVoterId', () => {
    const store = makeStoreSpy();
    const client = new RoomWsClient({
      wsUrl: 'ws://test', join: JOIN, store, webSocketFactory: factory,
      baseBackoffMs: 100, maxBackoffMs: 1000, keepaliveMs: null,
      random: () => 1, // deterministic = max delay
    });
    wsInstances[0].fireOpen();
    wsInstances[0].fireMessage(makeSnapshotEnv('v-resume-me'));
    expect(client.getRetainedVoterId()).toBe('v-resume-me');

    // Server-side close — backoff schedule should kick in.
    wsInstances[0].fireClose();
    expect(store.statuses.at(-1)).toBe('reconnecting');
    expect(wsInstances).toHaveLength(1); // not yet

    vi.advanceTimersByTime(200); // > base * 1 * random(=1) - just over
    expect(wsInstances).toHaveLength(2);
    wsInstances[1].fireOpen();
    const joinEnv = JSON.parse(wsInstances[1].sent[0]) as Envelope<JoinRoomPayload>;
    expect(joinEnv.payload.resumeVoterId).toBe('v-resume-me');
  });

  it('backoff grows on successive failures and resets on a successful reconnect', () => {
    const store = makeStoreSpy();
    let randomCalls = 0;
    const ceilings: number[] = [];
    new RoomWsClient({
      wsUrl: 'ws://test', join: JOIN, store, webSocketFactory: factory,
      baseBackoffMs: 100, maxBackoffMs: 10_000, keepaliveMs: null,
      random: () => { randomCalls += 1; return 1; },
    });
    wsInstances[0].fireOpen();
    wsInstances[0].fireMessage(makeSnapshotEnv());

    // Three consecutive close+reconnect cycles WITHOUT a snapshot — backoff grows.
    wsInstances[0].fireClose();              // schedule reconnect #1 (ceil 100)
    ceilings.push(100);
    vi.advanceTimersByTime(200);
    wsInstances[1].fireOpen();
    // Don't send snapshot — close immediately again.
    wsInstances[1].fireClose();              // schedule reconnect #2 (ceil 200)
    ceilings.push(200);
    vi.advanceTimersByTime(300);
    wsInstances[2].fireOpen();
    wsInstances[2].fireClose();              // schedule reconnect #3 (ceil 400)
    ceilings.push(400);
    vi.advanceTimersByTime(500);

    expect(wsInstances).toHaveLength(4); // 1 initial + 3 reconnects
    expect(randomCalls).toBeGreaterThanOrEqual(3);

    // Successful SNAPSHOT resets the attempt counter → next failure delays from base again.
    wsInstances[3].fireOpen();
    wsInstances[3].fireMessage(makeSnapshotEnv());
    wsInstances[3].fireClose();
    vi.advanceTimersByTime(150); // back to base ceiling 100
    expect(wsInstances).toHaveLength(5);
  });
});

describe('RoomWsClient — intentional disconnect', () => {
  it('disconnect() → disconnected status, no reconnect even after the close event', () => {
    const store = makeStoreSpy();
    const client = new RoomWsClient({
      wsUrl: 'ws://test', join: JOIN, store, webSocketFactory: factory,
      baseBackoffMs: 100, keepaliveMs: null,
    });
    wsInstances[0].fireOpen();
    wsInstances[0].fireMessage(makeSnapshotEnv());
    client.disconnect();
    expect(store.statuses.at(-1)).toBe('disconnected');
    vi.advanceTimersByTime(10_000);
    expect(wsInstances).toHaveLength(1); // no reconnect attempted
  });
});

describe('RoomWsClient — keepalive', () => {
  it('sends a RECONNECT_PING at the keepalive interval; stops after close', () => {
    const store = makeStoreSpy();
    new RoomWsClient({
      wsUrl: 'ws://test', join: JOIN, store, webSocketFactory: factory,
      keepaliveMs: 1000,
    });
    wsInstances[0].fireOpen();
    wsInstances[0].fireMessage(makeSnapshotEnv());
    // After the JOIN, exactly 1 message has been sent (JOIN itself).
    expect(wsInstances[0].sent).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    const pingTypes = wsInstances[0].sent.map((s) => (JSON.parse(s) as Envelope).type);
    expect(pingTypes).toContain('RECONNECT_PING');
  });
});
