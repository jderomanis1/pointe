/**
 * S10.i.c2 — dev/CI entry point for the worker.
 *
 * Selected only by `wrangler.dev.toml` (the `dev:e2e` script). The prod
 * `wrangler.toml` points at `worker.ts` and never imports this module —
 * so the prod bundle physically does not contain the test-route code or
 * the DevRoom subclass. The build-exclusion test asserts that fact
 * against the dry-run prod bundle.
 *
 * Two responsibilities:
 *   1. Re-export a `Room` subclass `DevRoom` (named "Room" so the
 *      wrangler.dev.toml `class_name = "Room"` binding resolves here).
 *      The subclass adds one internal-only route to the DO's fetch:
 *      `POST /__test/force-async-close` schedules an `async_close` task
 *      at-now and fires the alarm — exactly the production path
 *      `handleAsyncCloseFire` runs.
 *   2. Wrap the prod default fetch with `maybeHandleTestRoute` — any
 *      `/api/__test/*` request goes to the test routes (which validate
 *      the token + forward to the DO), everything else falls through to
 *      the prod worker unchanged.
 */
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { AISuggestion } from '@pointe/shared';
import prodWorker, { Room as ProdRoom, type Env } from './worker';
import { maybeHandleTestRoute } from './testRoutes';
import { upsertAiSuggestion } from './ai';
import { getHostVoterId } from './operations';
import { getAttachment } from './broadcast';

/**
 * DevRoom — Room subclass with one extra internal fetch route. Constructor
 * stashes the state ref because the parent class declares its `sql`/`ctx`
 * fields private; the subclass needs its own handle to schedule a task
 * via storage and to invoke `alarm()`.
 *
 * Behaviour of the new route:
 *   POST /__test/force-async-close
 *     • Inserts an `async_close` scheduled_task at `at=0` (immediately due).
 *     • Calls `this.alarm()` — the production alarm handler runs
 *       `runDueTasks` → `dispatchScheduledTask` → `handleAsyncCloseFire`.
 *     • Idempotent: a room already in `review`/`closing`/`archived` has
 *       `handleAsyncCloseFire` return early with no broadcast.
 *     • Returns 200 with `{ ok: true }` either way.
 */
export class Room extends ProdRoom {
  private readonly devState: DurableObjectState;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.devState = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/__test/force-async-close' && request.method === 'POST') {
      this.devState.storage.sql.exec(
        `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
        crypto.randomUUID(),
        0,
        'async_close',
        JSON.stringify({ closesAt: Date.now() }),
      );
      await this.alarm();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (pathname === '/__test/inject-ai-ready' && request.method === 'POST') {
      return this.injectAiReady();
    }
    if (pathname === '/__test/fire-host-vacancy' && request.method === 'POST') {
      return await this.fireHostVacancy();
    }
    if (pathname === '/__test/drop-voter-sockets' && request.method === 'POST') {
      return await this.dropVoterSockets();
    }
    return super.fetch(request);
  }

  /**
   * S10.iv — close every WS NOT bound to the host. Faithfulness contract:
   *   1. `sock.close()` initiates the close from the server side, sending
   *      a close frame to the client — the WSClient's `onclose` handler
   *      runs and kicks off the reconnect loop. This is the production
   *      path's outgoing half.
   *   2. We then invoke `this.webSocketClose(sock, ...)` directly, with
   *      the same args the workerd runtime would have passed had the
   *      client initiated the close. This runs the SAME production
   *      handler (`Room.webSocketClose` → markGoneAndBroadcast →
   *      voter_left broadcast → maybeScheduleHostVacant). The runtime
   *      doesn't auto-invoke the close handler when the DO is the
   *      closer; calling it ourselves is what makes the test reflect a
   *      real packet-loss the way it would land on every other socket.
   *
   * Skips the host socket — vacancy/claim is a separate flow with its
   * own dedicated test route.
   */
  private async dropVoterSockets(): Promise<Response> {
    const hostId = getHostVoterId(this.devState.storage.sql);
    let closed = 0;
    for (const sock of this.devState.getWebSockets()) {
      const att = getAttachment(sock);
      if (att?.voterId === hostId) continue;
      try {
        sock.close(4000, 'test-drop');
        // Run the production close path the way the runtime would have.
        await this.webSocketClose(sock, 4000, 'test-drop', true);
        closed++;
      } catch { /* already closing */ }
    }
    return new Response(JSON.stringify({ ok: true, closed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * S10.iv — collapse the 30s host_vacant grace window deterministically.
   * Sets `at = 0` on every pending host_vacant scheduled task and invokes
   * the alarm. The same production handler (`Room.handleHostVacantFire`)
   * runs through `runDueTasks → dispatchScheduledTask`; eligibility
   * checks (room state, hostVoterId unchanged, host still absent) are
   * intact. The only thing the test fakes is the wall-clock — the same
   * faithfulness contract S10.i's force-async-close holds.
   *
   * Idempotent: zero pending vacancy tasks yields a no-op `runDueTasks`,
   * returning 200 with `{ ok: true }`.
   */
  private async fireHostVacancy(): Promise<Response> {
    this.devState.storage.sql.exec(
      `UPDATE scheduled_task SET at = 0 WHERE type = 'host_vacant'`,
    );
    await this.alarm();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * S10.ii — stub the host-private "AI ready" arrival without calling
   * Anthropic. Resolves the room's currently-active story (the same
   * branch a real REQUEST_AI handler targets), upserts a deterministic
   * `ready` ai_suggestion (shared=0), and delegates delivery to the
   * production `sendAiUpdatedToHost`.
   *
   * Vacuity-guard contract: the stub fabricates only the AI payload.
   * The change shape, envelope construction, and host-only socket
   * filter all come from the production methods on `Room` (made
   * `protected` for this call). Voters' non-receipt is therefore
   * enforced by production code — not a parallel stub filter.
   *
   * 404 if no active story exists — the caller (E2E spec) sequences
   * `OPEN_VOTING` before this route, so this is a programming error
   * surfacing rather than a flake to mask.
   */
  private injectAiReady(): Response {
    const sql = this.devState.storage.sql;
    const row = sql.exec<{ id: string }>(
      `SELECT id FROM story WHERE state = 'active' LIMIT 1`,
    ).toArray()[0];
    if (!row) {
      return new Response(
        JSON.stringify({ code: 'NO_ACTIVE_STORY', message: 'No active story to attach AI to' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const storyId = row.id;
    const payload = {
      complexity: { level: 'medium' as const, note: 'Several flows interact.' },
      effort: { level: 'medium' as const, note: 'A few small files.' },
      risk: { level: 'low' as const, note: 'Reversible.' },
      unknowns: { level: 'low' as const, note: 'Well-trodden path.' },
      suggestedRange: { low: '3', high: '5' },
      rationale: 'Stubbed AI rationale for E2E.',
    };
    const now = Date.now();
    upsertAiSuggestion(sql, {
      storyId,
      state: 'ready',
      payload,
      requestedAt: now,
      completedAt: now,
      shared: false,
    });
    const ai: AISuggestion = { state: 'ready', ...payload, shared: false };
    // Production delivery path — same function the real REQUEST_AI
    // completion calls in `runAiCall`. This is the load-bearing line
    // for AA-1 in the E2E suite: the host-only filter that keeps the
    // ai_updated change off voter sockets is the one inside
    // `sendToHostSockets`, not a copy in this stub.
    this.sendAiUpdatedToHost(storyId, ai);
    return new Response(JSON.stringify({ ok: true, storyId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Required by hibernation contract — re-expose parent methods so the
  // workerd runtime finds them on the subclass instance.
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return super.webSocketMessage(ws, message);
  }
  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    return super.webSocketClose(ws, code, reason, wasClean);
  }
  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    return super.webSocketError(ws, error);
  }
  override async alarm(): Promise<void> {
    return super.alarm();
  }
}

/**
 * Dev fetch handler: try test routes first, then fall through to prod.
 * Same shape as prodWorker.fetch (Request, Env, ExecutionContext) so the
 * binding from wrangler is identical.
 */
export default {
  async fetch(
    request: Request,
    env: Env & { POINTE_E2E_TOKEN?: string },
    ctx: Parameters<typeof prodWorker.fetch>[2],
  ): Promise<Response> {
    const testResp = await maybeHandleTestRoute(request, env);
    if (testResp) return testResp;
    return prodWorker.fetch(request, env, ctx);
  },
};
