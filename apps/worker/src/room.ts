import type { DurableObjectState, SqlStorage, WebSocket } from '@cloudflare/workers-types';
import type {
  AISuggestion, DeckType, DeltaChange, Envelope, HostVacantPayload, RoomMode,
  ServerMessageType, StoryAiFailedPayload, StoryAiReadyPayload,
} from '@pointe/shared';
import {
  PROTOCOL_VERSION, computeRevealStats, resolveDeck, storyNeedsDiscussion,
} from '@pointe/shared';
import type { Env } from './worker';
import { initSchema } from './schema';
import {
  closeAsyncWindow, createRoom, getHostVoterId, getRoomLifecycle, getRoomState,
  markRoomHostVacant, setStoryNeedsDiscussion, setVoterConnection,
} from './operations';
import { handleMessage, type AiOrchestrator } from './dispatcher';
import { broadcast, broadcastEnvelope, getAttachment } from './broadcast';
import { checkWsHandshakeRate } from './rateLimit';
import {
  cancelTasksByType, runDueTasks, scheduleTask, type ScheduledTask,
} from './scheduler';
import {
  getAiSuggestion, putAiCache, requestCeruSuggestion, upsertAiSuggestion,
} from './ai';
import { recordAiRequested } from './metrics';

/** Grace window between host-disconnect and the host_vacant transition. */
export const HOST_VACANT_GRACE_MS = 30_000;

/** Payload schema for the scheduled `host_vacant` task. */
type HostVacantTaskPayload = { hostVoterId: string; disconnectedAt: number };

/**
 * S7.ii guard (c) — states the vacancy fire SHOULD skip. The original spec
 * wording was "don't transition a closing / archived / already-vacant room";
 * the first cut coded it as `state === 'active'`, which also excluded `lobby`
 * — a state the intent never meant to exclude. Lobby rooms (created, link
 * shared, no activity yet) are a legitimate vacancy case if the host drops.
 *
 * OQ-011 (filed at this fix): the room FSM never transitions lobby → active
 * today (`openVoting` flips story state, not room state). Until that lands,
 * effectively every vacancy fire is on a lobby room. Even after, lobby + active
 * are both eligible; this exclude-list expresses the actual rule.
 */
const VACANCY_INELIGIBLE_STATES = new Set<string>(['closing', 'archived', 'host_vacant']);

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
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.sql = ctx.storage.sql;
    this.ctx = ctx;
    this.env = env;
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
        // SI-06: per-IP/min WS handshake rate. Atomic in the DO (KV is
        // structurally unfit for a sub-minute window — read cache ≥ window,
        // 1 write/sec/key burst cap). Per-IP/per-room scope maps to the real
        // threat (one IP hammering one room); multi-room spam is bounded by
        // the hourly create + lookup KV limits at the Worker.
        // The Worker is the trust boundary for IP — it SETs X-Client-IP from
        // CF-Connecting-IP. A client-supplied X-Client-IP cannot reach this
        // handler because the Worker overrides it.
        const gate = this.checkWsHandshakeRate(request);
        if (gate.limited) return gate.limited;
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
      (changes, opts) => broadcast(this.ctx, changes, getHostVoterId(this.sql), opts),
      // S7.ii fire-and-forget: deletes the row synchronously; alarm re-schedule
      // is async (acceptable — stale alarm fires into an empty table → no-op).
      () => { void cancelTasksByType(this.ctx.storage, 'host_vacant'); },
      // S7.iii: HOST_RECLAIMED fan-out for CLAIM_HOST / TRANSFER_HOST / reclaim.
      (type, payload) => { broadcastEnvelope(this.ctx, type, payload); },
      // S8.ii.b: REQUEST_AI orchestration. The dispatcher's handler runs
      // sync (cache check, rate check, accept); the API call happens here.
      this.aiOrchestrator(),
      // S9.i.c2: OPEN_ASYNC arms the close alarm. Fire-and-forget — the
      // alarm is in place in milliseconds; the scheduler multiplexes via
      // MIN(at) so any pending host_vacant alarm is preserved.
      (closesAt) => {
        void scheduleTask(this.ctx.storage, 'async_close', closesAt, { closesAt });
      },
    );
    for (const env of envelopes) {
      ws.send(JSON.stringify(env));
    }
  }

  // ---- S8.ii.b — AI orchestration -----------------------------------------

  /**
   * Build the per-message AiOrchestrator. `available` is derived live from
   * env.ANTHROPIC_API_KEY (a secret that may be unset in CI / preview); the
   * dispatcher uses it to gate fresh API calls. Cache hits succeed regardless.
   */
  private aiOrchestrator(): AiOrchestrator {
    return {
      available: !!this.env.ANTHROPIC_API_KEY,
      sendToHost: (type, payload) => this.sendToHostSockets(type, payload),
      scheduleAiCall: (p) => {
        // Fire-and-forget. The DO runtime keeps the promise alive while
        // there's outstanding I/O — same shape as cancelTasksByType above.
        void this.runAiCall(p);
      },
      // S10.vii — aggregate AI opt-in count. Writes ONLY the event name
      // (no story id, no room id, no voter id). Missing METRICS binding
      // is a silent no-op — telemetry must never fail a request.
      recordAiRequested: () => recordAiRequested(this.env),
    };
  }

  /**
   * AA-1 enforcement: deliver one server envelope to every socket bound to
   * the current `room.host_voter_id`. A host with multiple tabs gets it on
   * each; if no live host socket exists, nothing is sent (the snapshot
   * covers reconnect). Host id is resolved LIVE — survives host transfer.
   *
   * `protected` (not private) so the S10.ii dev-entry subclass can call
   * this directly when stubbing an AI completion — the voter's
   * non-receipt is then enforced by THIS production code, not by a
   * parallel filter inside the stub.
   */
  protected sendToHostSockets<T>(type: ServerMessageType, payload: T): void {
    const hostId = getHostVoterId(this.sql);
    if (!hostId) return;
    const env: Envelope<T> = {
      v: PROTOCOL_VERSION,
      type,
      id: crypto.randomUUID(),
      at: Date.now(),
      payload,
    };
    const raw = JSON.stringify(env);
    for (const sock of this.ctx.getWebSockets()) {
      const att = getAttachment(sock);
      if (att?.voterId !== hostId) continue;
      try { sock.send(raw); } catch { /* socket closing */ }
    }
  }

  /**
   * The async half of REQUEST_AI. Calls Anthropic, then re-reads SQL
   * (the S7 cursor lesson — the story may have moved). Persists ai_suggestion
   * + ai_cache on success; ai_suggestion failed-state on failure. Notifies
   * host via sendToHostSockets. Never throws.
   */
  private async runAiCall(p: {
    storyId: string;
    storyText: string;
    deckValues: string[];
    cacheKey: string;
    requestedAt: number;
  }): Promise<void> {
    try {
      const key = this.env.ANTHROPIC_API_KEY;
      // Defense in depth: the dispatcher already gated on this. If the
      // secret got unset between accept and now (impossible in practice
      // but cheap to handle), treat as a failed call.
      if (!key) {
        upsertAiSuggestion(this.sql, {
          storyId: p.storyId, state: 'failed', errorMessage: 'AI_UNAVAILABLE',
          requestedAt: p.requestedAt, completedAt: Date.now(),
        });
        const failed: StoryAiFailedPayload = { storyId: p.storyId, errorMessage: 'AI_UNAVAILABLE' };
        this.sendToHostSockets('STORY_AI_FAILED', failed);
        this.sendAiUpdatedToHost(p.storyId, { state: 'failed', errorMessage: 'AI_UNAVAILABLE' });
        return;
      }
      const result = await requestCeruSuggestion(key, p.storyText, p.deckValues);
      const now = Date.now();
      if (result.ok) {
        const payload = {
          complexity: result.suggestion.complexity,
          effort: result.suggestion.effort,
          risk: result.suggestion.risk,
          unknowns: result.suggestion.unknowns,
          suggestedRange: result.suggestion.suggestedRange,
          rationale: result.suggestion.rationale,
        };
        upsertAiSuggestion(this.sql, {
          storyId: p.storyId, state: 'ready', payload,
          requestedAt: p.requestedAt, completedAt: now, shared: false,
        });
        putAiCache(this.sql, { cacheKey: p.cacheKey, payload, now });
        const ready: StoryAiReadyPayload = { storyId: p.storyId };
        this.sendToHostSockets('STORY_AI_READY', ready);
        this.sendAiUpdatedToHost(p.storyId, {
          state: 'ready', ...payload, shared: false,
        });
      } else {
        upsertAiSuggestion(this.sql, {
          storyId: p.storyId, state: 'failed', errorMessage: result.errorMessage,
          requestedAt: p.requestedAt, completedAt: now,
        });
        const failed: StoryAiFailedPayload = { storyId: p.storyId, errorMessage: result.errorMessage };
        this.sendToHostSockets('STORY_AI_FAILED', failed);
        this.sendAiUpdatedToHost(p.storyId, { state: 'failed', errorMessage: result.errorMessage });
      }
    } catch {
      // Never throw — voting must not be blocked by an AI fault.
    }
  }

  /**
   * S8.iii.c1 — host-only DELTA pushing the AI suggestion content. Frontend
   * reducer applies `ai_updated` to set `story.ai`. Voters get nothing on
   * AI completion (the AA-1 timing-leak guarantee).
   *
   * `protected` (not private) so the S10.ii dev-entry subclass calls THIS
   * function when stubbing a `ready` AI arrival — the change shape +
   * envelope + host-only delivery are all the production code, not a
   * parallel copy in the stub. The stub fabricates only the AI payload.
   */
  protected sendAiUpdatedToHost(storyId: string, ai: AISuggestion): void {
    const change: DeltaChange = { kind: 'ai_updated', storyId, ai };
    this.sendToHostSockets('DELTA', { changes: [change] });
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
      case 'async_close': {
        this.handleAsyncCloseFire();
        break;
      }
      default:
        console.warn(`scheduler: unknown task type "${task.type}" (id=${task.id})`);
        break;
    }
  }

  /**
   * S7.ii: the alarm fired — but a fire only means "30s elapsed," not "host
   * is gone." Re-check
   *   (a) room is in a vacancy-eligible state (not closing / archived /
   *       already host_vacant — see VACANCY_INELIGIBLE_STATES),
   *   (b) hostVoterId unchanged (no transfer happened),
   *   (c) host still absent (no live attached socket bound to them).
   * Any failing check → silent no-op. This is the idempotency contract.
   */
  private handleHostVacantFire(payload: HostVacantTaskPayload | null): void {
    if (!payload || typeof payload.hostVoterId !== 'string'
        || typeof payload.disconnectedAt !== 'number') {
      return;
    }
    const lifecycle = getRoomLifecycle(this.sql);
    if (!lifecycle) return;
    if (VACANCY_INELIGIBLE_STATES.has(lifecycle.state)) return;
    if (lifecycle.hostVoterId !== payload.hostVoterId) return;
    if (this.hostIsLive(payload.hostVoterId)) return;

    markRoomHostVacant(this.sql, { vacantSince: payload.disconnectedAt });
    const message: HostVacantPayload = { vacantSince: payload.disconnectedAt };
    broadcastEnvelope(this.ctx, 'HOST_VACANT', message);
  }

  /**
   * S9.i.c3 — the async_close alarm fired. Reveal every active story (batch),
   * compute stats, tag each story's bucket via `storyNeedsDiscussion`, persist
   * the flag, broadcast a single DELTA with all `votes_revealed` changes + a
   * trailing `async_window_closed`. Room transitions to `'review'`.
   *
   * AA-1 unchanged: each `votes_revealed` carries the (optional) AI suggestion
   * which `projectChangesFor` strips for non-hosts unless `shared`. So in
   * async exactly as in sync, the host's reveal carries AI and the voter's
   * doesn't — until the host explicitly SHARE_AIs after close.
   *
   * Idempotent: `closeAsyncWindow` returns an empty batch if the room is
   * already in a closed-ish state; the broadcast becomes a no-op.
   */
  private handleAsyncCloseFire(): void {
    const now = Date.now();
    const close = closeAsyncWindow(this.sql, { now });
    if (close.results.length === 0) return; // already closed; idempotent no-op

    const roomRow = this.sql
      .exec<{ deck: string; custom_deck: string | null }>(
        'SELECT deck, custom_deck FROM room LIMIT 1',
      ).toArray()[0];
    const deck = roomRow
      ? resolveDeck(
          roomRow.deck as Parameters<typeof resolveDeck>[0],
          roomRow.custom_deck ? (JSON.parse(roomRow.custom_deck) as string[]) : null,
        )
      : [];

    const changes: DeltaChange[] = [];
    for (const r of close.results) {
      const stats = computeRevealStats(deck, r.votes);
      const needsDiscussion = storyNeedsDiscussion(stats);
      setStoryNeedsDiscussion(this.sql, { storyId: r.storyId, needsDiscussion });
      // AA-1: attach the AI suggestion (any state) so the host's per-recipient
      // projection lets it through. projectChangesFor strips it for non-hosts.
      const suggestion = getAiSuggestion(this.sql, r.storyId);
      const change: Extract<DeltaChange, { kind: 'votes_revealed' }> = suggestion
        ? { kind: 'votes_revealed', storyId: r.storyId, votes: r.votes, stats, needsDiscussion, ai: suggestion }
        : { kind: 'votes_revealed', storyId: r.storyId, votes: r.votes, stats, needsDiscussion };
      changes.push(change);
    }
    changes.push({ kind: 'async_window_closed', closedAt: close.closedAt });

    broadcast(this.ctx, changes, getHostVoterId(this.sql));
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

  /**
   * SI-06: atomic per-IP, per-room WS handshake rate (30/min).
   *
   * One atomic INSERT…ON CONFLICT DO UPDATE…RETURNING — increments the
   * counter and reads the new value in a single statement. .one() is safe
   * here because RETURNING always yields exactly one row.
   *
   * Self-cleans stale rows (window_start < current) on every call so the
   * table stays bounded by distinct IPs in the last minute.
   *
   * (S8.ii.b cleanup: the temporary X-RL-* diagnostic headers from the
   * SI-06 verification have been removed. Status + the ws_handshake_rate
   * row are the source of truth now; tests read the row via
   * runInDurableObject when the count needs assertion.)
   */
  protected checkWsHandshakeRate(
    request: Request,
    now: number = Date.now(),
  ): { limited: Response | null } {
    const ip = request.headers.get('X-Client-IP') ?? 'unknown';
    // S9 fix: delegate to the pure rateLimit helper with a real-clock `now`.
    // S10.v.c3: `now` is also an explicit (defaulted) parameter on the wrapper
    // — a wrapper-coverage test pins it so the route → wrapper → 429
    // wiring is deterministic, independent of where in the wall-clock minute
    // the test runs. Production callers use the default (Date.now()).
    const result = checkWsHandshakeRate(this.sql, { ip, now });
    if (!result.tripped) return { limited: null };
    const body = {
      code: 'RATE_LIMITED',
      message: 'WebSocket handshake rate exceeded for this IP in this room.',
    };
    return {
      limited: new Response(JSON.stringify(body), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
      }),
    };
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
      broadcast(
        this.ctx,
        [{ kind: 'voter_left', voterId: att.voterId }],
        getHostVoterId(this.sql),
        { excludeWs: ws },
      );
    } catch {
      /* don't throw out of the hibernation handler */
    }
  }
}
