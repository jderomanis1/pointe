/**
 * S10.i.c2 — dev/CI-only test routes for the E2E harness.
 *
 * SECURITY / GATING (the load-bearing decision):
 *   • This module is imported by `worker.dev.ts` only — never by
 *     `worker.ts`. The prod build's entry point is `worker.ts`; wrangler
 *     bundles only the import-reachable set, so the prod binary cannot
 *     physically contain this file. The build-exclusion test asserts
 *     this with grep against the dry-run prod bundle.
 *   • Defense in depth: every test route requires a header token matched
 *     against `env.POINTE_E2E_TOKEN`. If the dev-config file accidentally
 *     leaked into prod via a misconfigured `wrangler deploy --config`,
 *     the missing token would still 403 every request.
 *   • Defense in depth ×2: `dev:e2e` binds wrangler to `127.0.0.1` only,
 *     so even on a developer's machine the routes aren't on the LAN.
 *
 * Routes:
 *   POST /api/__test/close/:slug
 *     S10.i — fires the production async-close alarm immediately on the
 *     named room (same code path as the real alarm).
 *
 *   POST /api/__test/ai-ready/:slug
 *     S10.ii — injects a deterministic `ready` AI suggestion for the room's
 *     currently-active story + broadcasts the host-only `ai_updated` DELTA.
 *     Used by the anti-anchoring spec because dev/CI worker has no
 *     ANTHROPIC_API_KEY — a real REQUEST_AI would resolve `failed`, which
 *     can't be SHARE_AI'd. This route bypasses the Anthropic call but
 *     re-uses the same storage primitive (`upsertAiSuggestion`) and the
 *     same host-only DELTA shape, so the AA-1 projection logic + the
 *     reveal/share UI still exercise their production paths.
 */
import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';
import { lookupSlug } from './slug';

export type TestRoutesEnv = {
  ROOM: DurableObjectNamespace;
  POINTE_SLUGS: KVNamespace;
  /** Set by `apps/worker/.dev.vars` and the CI workflow. Missing → all
   *  routes 403. Production never sets this (and never imports this file
   *  anyway), so a leaked dev entry wouldn't expose anything. */
  POINTE_E2E_TOKEN?: string;
};

const TEST_PATH_PREFIX = '/api/__test/';
const E2E_TOKEN_HEADER = 'x-pointe-e2e-token';

/**
 * Try to handle a request as a test route. Returns null if the path
 * doesn't match any test route — the caller falls through to the prod
 * worker. Returns a Response only when the prefix matches (including
 * the 403/404 error responses, so the routing stays consistent).
 */
export async function maybeHandleTestRoute(
  request: Request,
  env: TestRoutesEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(TEST_PATH_PREFIX)) return null;

  // Token gate. A missing env var means the dev/CI runtime forgot to
  // set it — fail closed.
  const expected = env.POINTE_E2E_TOKEN;
  if (!expected) {
    return json({ code: 'E2E_DISABLED', message: 'POINTE_E2E_TOKEN not set' }, 503);
  }
  const provided = request.headers.get(E2E_TOKEN_HEADER);
  if (provided !== expected) {
    return json({ code: 'FORBIDDEN', message: 'invalid or missing e2e token' }, 403);
  }

  // POST /api/__test/close/:slug — force the async-close alarm immediately.
  const closeMatch = url.pathname.match(/^\/api\/__test\/close\/([a-z-]+-\d+)$/);
  if (closeMatch && request.method === 'POST') {
    const slug = closeMatch[1];
    return await forceAsyncClose(slug, env);
  }

  // POST /api/__test/ai-ready/:slug — inject a deterministic ready AI
  // suggestion for the room's currently-active story.
  const aiReadyMatch = url.pathname.match(/^\/api\/__test\/ai-ready\/([a-z-]+-\d+)$/);
  if (aiReadyMatch && request.method === 'POST') {
    const slug = aiReadyMatch[1];
    return await injectAiReady(slug, env);
  }

  return json({ code: 'TEST_ROUTE_NOT_FOUND', message: `${request.method} ${url.pathname}` }, 404);
}

/**
 * Resolve the slug → DO stub, then call an internal-only route on the
 * Room subclass (exposed by `DevRoom` in `worker.dev.ts`) that schedules
 * an `async_close` task at-now and fires the alarm. Exactly the same
 * code path the real alarm executes — no parallel implementation.
 */
async function forceAsyncClose(slug: string, env: TestRoutesEnv): Promise<Response> {
  const roomId = await lookupSlug(env.POINTE_SLUGS, slug);
  if (roomId === null) {
    return json({ code: 'SLUG_NOT_FOUND', message: 'Room not found' }, 404);
  }
  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  // `/__test/force-async-close` is implemented by DevRoom (subclass-only
  // route, not present on the prod Room class). Returns 200 if the close
  // fired or was already-closed (idempotent — matches the alarm's
  // semantics in `handleAsyncCloseFire`).
  const inner = await stub.fetch(new Request('https://do/__test/force-async-close', {
    method: 'POST',
  }));
  return new Response(await inner.text(), {
    status: inner.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Resolve the slug → DO stub, then call a DevRoom-only internal route
 * that upserts the ai_suggestion row to `ready` (with a deterministic
 * stub payload) and broadcasts an `ai_updated` DELTA to host sockets —
 * identical shape to a real REQUEST_AI completion. Returns 200 with the
 * inner body; 404 if no active story exists.
 */
async function injectAiReady(slug: string, env: TestRoutesEnv): Promise<Response> {
  const roomId = await lookupSlug(env.POINTE_SLUGS, slug);
  if (roomId === null) {
    return json({ code: 'SLUG_NOT_FOUND', message: 'Room not found' }, 404);
  }
  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  const inner = await stub.fetch(new Request('https://do/__test/inject-ai-ready', {
    method: 'POST',
  }));
  return new Response(await inner.text(), {
    status: inner.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
