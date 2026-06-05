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
import prodWorker, { Room as ProdRoom, type Env } from './worker';
import { maybeHandleTestRoute } from './testRoutes';

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
    return super.fetch(request);
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
