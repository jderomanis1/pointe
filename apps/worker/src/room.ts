import type { DurableObjectState, SqlStorage } from '@cloudflare/workers-types';
import type { DeckType, HostVacantPayload, RoomMode } from '@pointe/shared';
import type { Env } from './worker';
import { initSchema } from './schema';
import {
  createRoom, getHostVoterId, getRoomLifecycle, getRoomState,
  markRoomHostVacant, setVoterConnection,
} from './operations';
import { handleMessage } from './dispatcher';
import { broadcast, broadcastEnvelope, getAttachment } from './broadcast';
import {
  cancelTasksByType, runDueTasks, scheduleTask, type ScheduledTask,
} from './scheduler';

/** Grace window between host-disconnect and the host_vacant transition. */
export const HOST_VACANT_GRACE_MS = 30_000;

/** Payload schema for the scheduled `host_vacant` task. */
type HostVacantTaskPayload = { hostVoterId: string; disconnectedAt: number };

type InitBody = {
  roomId: string;
  slug: string;
  hostVoterId: string;
  hostDisplayName: string;
  deck: DeckType;
  mode: RoomMode;
  customDeck?: string[];
};

function mapErrorToStatus(code: string): number {
  switch (code) {
    case 'ROOM_ALREADY_EXISTS':
      return 409;
    case 'ROOM_NOT_FOUND':
      return 404;
    default:
      return 500;
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Plain-class Durable Object — Decision 1 keeps it off the cloudflare base class
 * (see D1–D4 hang notes). Constructor wires the SQLite schema; `fetch` dispatches the
 * two internal paths the worker calls. Voting / story / voter ops attach to the
 * realtime transport in R2; this slice has no REST routes for them.
 */
export class Room {
  private sql: SqlStorage;
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.sql = ctx.storage.sql;
    this.ctx = ctx;
    initSchema(this.sql);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    try {
      if (pathname === '/ws') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('Expected websocket', { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
        this.ctx.acceptWebSocket(server); // hibernation accept — NOT server.accept()
        return new Response(null, { status: 101, webSocket: client });
      }
      if (method === 'POST' && pathname === '/init') {
        const body = (await request.json()) as InitBody;
        const room = createRoom(this.sql, { ...body, now: Date.now() });
        return jsonResponse(room, 201);
      }
      if (method === 'GET' && pathname === '/state') {
        return jsonResponse(getRoomState(this.sql), 200);
      }
      return jsonResponse({ code: 'NOT_FOUND', message: 'Not found' }, 404);
    } catch (err) {
      const code = err instanceof Error ? err.message : 'INTERNAL';
      return jsonResponse({ code, message: code }, mapErrorToStatus(code));
    }
  }

  // ---- Hibernation handlers (skeleton — R2.ii replaces webSocketMessage) ----

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const envelopes = handleMessage(
      this.sql,
      ws,
      message,
      (changes, opts) => broadcast(this.ctx, changes, opts),
      // S7.ii fire-and-forget: deletes the row synchronously; alarm re-schedule
      // is async (acceptable — stale alarm fires into an empty table → no-op).
      () => { void cancelTasksByType(this.ctx.storage, 'host_vacant'); },
      // S7.iii: HOST_RECLAIMED fan-out for CLAIM_HOST / TRANSFER_HOST / reclaim.
      (type, payload) => { broadcastEnvelope(this.ctx, type, payload); },
    );
    for (const env of envelopes) {
      ws.send(JSON.stringify(env));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    this.markGoneAndBroadcast(ws);
    await this.maybeScheduleHostVacant(ws);
    try {
      ws.close(code, 'server ack');
    } catch {
      /* already closing */
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    this.markGoneAndBroadcast(ws);
    await this.maybeScheduleHostVacant(ws);
  }

  /**
   * Single alarm entry-point. The scheduler module pulls every task with
   * at <= now and routes it through `dispatchScheduledTask`. S7.ii (host
   * vacancy), S9 (async windows) and archival all extend the switch — the
   * scheduler stays domain-agnostic.
   */
  async alarm() {
    await runDueTasks(this.ctx.storage, Date.now(), (task) => this.dispatchScheduledTask(task));
  }

  private dispatchScheduledTask(task: ScheduledTask): void {
    switch (task.type) {
      case '__test_marker': {
        // Synthetic — exists so S7.i tests can observe dispatch end-to-end.
        this.sql.exec(
          `INSERT INTO processed_message (id, at) VALUES (?, ?)`,
          `__test_marker:${task.id}`,
          Date.now(),
        );
        break;
      }
      case 'host_vacant': {
        this.handleHostVacantFire(task.payload as HostVacantTaskPayload | null);
        break;
      }
      default:
        console.warn(`scheduler: unknown task type "${task.type}" (id=${task.id})`);
        break;
    }
  }

  /**
   * S7.ii: the alarm fired — but a fire only means "30s elapsed," not "host
   * is gone." Re-check (a) hostVoterId unchanged, (b) host still absent
   * (no live attached socket bound to them), (c) room is still `active`.
   * Any failing check → silent no-op. This is the idempotency contract.
   */
  private handleHostVacantFire(payload: HostVacantTaskPayload | null): void {
    if (!payload || typeof payload.hostVoterId !== 'string'
        || typeof payload.disconnectedAt !== 'number') {
      return;
    }
    const lifecycle = getRoomLifecycle(this.sql);
    if (!lifecycle) return;
    if (lifecycle.state !== 'active') return;
    if (lifecycle.hostVoterId !== payload.hostVoterId) return;
    if (this.hostIsLive(payload.hostVoterId)) return;

    markRoomHostVacant(this.sql, { vacantSince: payload.disconnectedAt });
    const message: HostVacantPayload = { vacantSince: payload.disconnectedAt };
    broadcastEnvelope(this.ctx, 'HOST_VACANT', message);
  }

  /** True iff any non-closing attached socket is bound to `hostVoterId`. */
  private hostIsLive(hostVoterId: string, excluding?: WebSocket): boolean {
    for (const sock of this.ctx.getWebSockets()) {
      if (excluding && sock === excluding) continue;
      const att = getAttachment(sock);
      if (att?.voterId === hostVoterId) return true;
    }
    return false;
  }

  /**
   * Called from webSocketClose/Error. If the closing socket's voter is the
   * room's host and no other live socket is bound to them, schedule the
   * 30s host_vacant grace. The handler will re-check before transitioning.
   */
  private async maybeScheduleHostVacant(closing: WebSocket): Promise<void> {
    try {
      const att = getAttachment(closing);
      if (!att) return;
      const hostVoterId = getHostVoterId(this.sql);
      if (!hostVoterId || att.voterId !== hostVoterId) return;
      if (this.hostIsLive(hostVoterId, closing)) return;
      const now = Date.now();
      const payload: HostVacantTaskPayload = { hostVoterId, disconnectedAt: now };
      await scheduleTask(this.ctx.storage, 'host_vacant', now + HOST_VACANT_GRACE_MS, payload);
    } catch {
      /* never throw from hibernation handlers */
    }
  }

  /** Mark the voter `left` and emit a `voter_left` delta to peers. Never throws. */
  private markGoneAndBroadcast(ws: WebSocket) {
    try {
      const att = getAttachment(ws);
      if (!att) return;
      setVoterConnection(this.sql, {
        voterId: att.voterId,
        connectionState: 'left',
        now: Date.now(),
      });
      broadcast(this.ctx, [{ kind: 'voter_left', voterId: att.voterId }], { excludeWs: ws });
    } catch {
      /* don't throw out of the hibernation handler */
    }
  }
}
