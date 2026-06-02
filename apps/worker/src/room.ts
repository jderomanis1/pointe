import type { DurableObjectState, SqlStorage } from '@cloudflare/workers-types';
import type { DeckType, RoomMode } from '@pointe/shared';
import type { Env } from './worker';
import { initSchema } from './schema';
import { createRoom, getRoomState, setVoterConnection } from './operations';
import { handleMessage } from './dispatcher';
import { broadcast, getAttachment } from './broadcast';
import { runDueTasks, type ScheduledTask } from './scheduler';

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
    );
    for (const env of envelopes) {
      ws.send(JSON.stringify(env));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    this.markGoneAndBroadcast(ws);
    try {
      ws.close(code, 'server ack');
    } catch {
      /* already closing */
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    this.markGoneAndBroadcast(ws);
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
        // Consumers (host_vacant in S7.ii, etc.) replace this with the real
        // case statements; the default keeps unknown types from throwing.
        this.sql.exec(
          `INSERT INTO processed_message (id, at) VALUES (?, ?)`,
          `__test_marker:${task.id}`,
          Date.now(),
        );
        break;
      }
      default:
        console.warn(`scheduler: unknown task type "${task.type}" (id=${task.id})`);
        break;
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
