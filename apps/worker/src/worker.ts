import type { AnalyticsEngineDataset, KVNamespace } from '@cloudflare/workers-types';
import type {
  ApiError,
  CreateRoomRequest,
  CreateRoomResponse,
  DeckType,
  GetRoomResponse,
  RoomMode,
} from '@pointe/shared';
import { Room } from './room';
import type { RoomReadState } from './operations';
import { lookupSlug, reserveSlug } from './slug';
import {
  checkWindowedIpLimit, clientIp, HOUR_MS,
  RL_CREATE_PER_HOUR, RL_LOOKUP_PER_HOUR,
} from './rateLimit';
import { recordRoomCreated } from './metrics';

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace;
  POINTE_SLUGS: KVNamespace;
  /**
   * S8 — Anthropic API key, set via `wrangler secret put ANTHROPIC_API_KEY`.
   * Optional in this slice: the S8.ii.a generator is inert and reads it only
   * when called, which doesn't happen until the S8.ii.b REQUEST_AI handler
   * lands. Until then the binding can be unset in CI / preview without
   * runtime impact.
   */
  ANTHROPIC_API_KEY?: string;
  /**
   * S10.vii — Cloudflare Analytics Engine dataset for the two aggregate
   * Doc 3 dials (room_created, ai_requested). Optional binding: dev /
   * preview without the binding gets no telemetry, not a crash —
   * telemetry must never fail a request (Doc 2 §17 + the "no PII"
   * privacy contract is enforced by the typed helper in metrics.ts).
   */
  METRICS?: AnalyticsEngineDataset;
}

const SESSION_TTL_SECONDS = 86400; // 24h per SI-03

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  const body: ApiError = { code, message };
  return json(body, status);
}

/** SI-06: 429 with the standard ApiError envelope + Retry-After. */
function rateLimited(message: string, retryAfterSeconds: number): Response {
  const body: ApiError = { code: 'RATE_LIMITED', message };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
    },
  });
}

/**
 * Build the SI-03 session cookie. Scoped tight: SameSite=Strict, room-only Path, 24h TTL.
 * Non-host voters get their cookie on JOIN over the realtime upgrade response in R2 —
 * out of scope here.
 */
export function buildSessionCookie(hostVoterId: string, slug: string): string {
  return (
    `pointe_session=${hostVoterId}; HttpOnly; Secure; SameSite=Strict; ` +
    `Path=/api/rooms/${slug}; Max-Age=${SESSION_TTL_SECONDS}`
  );
}

async function createRoomEndpoint(request: Request, env: Env): Promise<Response> {
  // SI-06 per-hour ceiling — fixed-window KV counter. See /spec/security.md §1.
  if (!(await checkWindowedIpLimit(env.POINTE_SLUGS, 'create', clientIp(request), RL_CREATE_PER_HOUR, HOUR_MS))) {
    return rateLimited('Too many rooms created from this IP. Try again later.', 3600);
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse('MALFORMED_JSON', 'Malformed JSON body', 400);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return errorResponse('INVALID_REQUEST', 'hostDisplayName required', 400);
  }
  const req = parsed as CreateRoomRequest;
  const name = req.hostDisplayName;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 60) {
    return errorResponse('INVALID_REQUEST', 'hostDisplayName required (1–60 chars)', 400);
  }
  const deck: DeckType = req.deck ?? 'fibonacci';
  const mode: RoomMode = req.mode ?? 'sync';
  if (deck === 'custom' && (!Array.isArray(req.customDeck) || req.customDeck.length === 0)) {
    return errorResponse('INVALID_REQUEST', 'customDeck required when deck is "custom"', 400);
  }

  const roomId = crypto.randomUUID();
  const hostVoterId = crypto.randomUUID();
  // Reserve the slug before creating the DO: cheap, fails fast. Leaks until TTL on later failure (v1 accepts).
  const slug = await reserveSlug(env.POINTE_SLUGS, roomId);

  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  const initRes = await stub.fetch(
    new Request('https://do/init', {
      method: 'POST',
      body: JSON.stringify({
        roomId,
        slug,
        hostVoterId,
        hostDisplayName: name,
        deck,
        mode,
        customDeck: req.customDeck,
      }),
    }),
  );
  if (!initRes.ok) {
    return new Response(await initRes.text(), {
      status: initRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // S10.vii — telemetry: one aggregate event covers both Doc 3 dials
  // (room-create count + async-adoption rate as async/total at query time).
  // The metrics helper writes ONLY the `mode` dimension; no slug, no
  // hostVoterId, no IP. Fire-and-forget — failure is silent (§17).
  recordRoomCreated(env, mode);

  const host = new URL(request.url).host;
  const responseBody: CreateRoomResponse = {
    slug,
    voterId: hostVoterId,
    wsUrl: `wss://${host}/api/rooms/${slug}/ws`,
  };
  return json(responseBody, 201, { 'Set-Cookie': buildSessionCookie(hostVoterId, slug) });
}

/** GET /api/rooms/:slug/ws → upgrade to WebSocket, forward to DO `/ws`. R2.i (transport entry). */
async function wsUpgradeEndpoint(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = pathname.match(/^\/api\/rooms\/([a-z-]+-\d+)\/ws$/);
  if (!match) return null;
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected websocket', { status: 426 });
  }
  const slug = match[1];
  const roomId = await lookupSlug(env.POINTE_SLUGS, slug);
  if (roomId === null) {
    return errorResponse('SLUG_NOT_FOUND', 'Room not found', 404);
  }
  // SI-06: per-IP/min WS handshake limit is enforced atomically in the room DO
  // (KV is structurally unfit for a sub-minute window — read cache ≥ window,
  // 1 write/sec/key cap under burst). Forward the trusted CF-Connecting-IP as
  // an internal header — set (override) so a client-supplied X-Client-IP can't
  // spoof. The DO is only reachable via the Worker; trust ends here.
  // See /spec/security.md §1.
  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  const doReq = new Request('https://do/ws', request);
  doReq.headers.set('X-Client-IP', clientIp(request));
  return stub.fetch(doReq);
}

/** GET /api/rooms/:slug → minimal `{state, deck}`. Full state comes over WS in R2. */
async function getRoomEndpoint(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = pathname.match(/^\/api\/rooms\/([a-z-]+-\d+)$/);
  if (!match) return null;
  // SI-06 per-hour ceiling — fixed-window KV counter. /ws is matched earlier so
  // the upgrade path is NOT counted as a lookup. See /spec/security.md §1.
  if (!(await checkWindowedIpLimit(env.POINTE_SLUGS, 'lookup', clientIp(request), RL_LOOKUP_PER_HOUR, HOUR_MS))) {
    return rateLimited('Too many lookups from this IP. Try again later.', 3600);
  }
  const slug = match[1];

  const roomId = await lookupSlug(env.POINTE_SLUGS, slug);
  if (roomId === null) {
    return errorResponse('SLUG_NOT_FOUND', 'Room not found', 404);
  }

  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  const stateRes = await stub.fetch(new Request('https://do/state', { method: 'GET' }));
  if (!stateRes.ok) {
    return new Response(await stateRes.text(), {
      status: stateRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const readState = (await stateRes.json()) as RoomReadState;
  const responseBody: GetRoomResponse = {
    state: readState.room.state,
    deck: readState.room.deck,
    // S9.ii.c1 — pre-join framing for async rooms. mode is set at create;
    // closesAt is null until OPEN_ASYNC stamps async_window.
    mode: readState.room.mode,
    closesAt: readState.room.asyncWindow?.closesAt ?? null,
  };
  return json(responseBody, 200);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return Response.json({ ok: true, ts: Date.now() });
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      try {
        return await createRoomEndpoint(request, env);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return errorResponse(message, message, 500);
      }
    }

    // WS upgrade must be matched BEFORE the broader GET /api/rooms/:slug handler.
    if (url.pathname.startsWith('/api/rooms/') && url.pathname.endsWith('/ws') && request.method === 'GET') {
      try {
        const res = await wsUpgradeEndpoint(request, env);
        if (res) return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return errorResponse(message, message, 500);
      }
    }

    if (url.pathname.startsWith('/api/rooms/') && request.method === 'GET') {
      try {
        const res = await getRoomEndpoint(request, env);
        if (res) return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return errorResponse(message, message, 500);
      }
    }

    return errorResponse('NOT_FOUND', 'Not found', 404);
  },
};
