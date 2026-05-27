import type { KVNamespace } from '@cloudflare/workers-types';
import type {
  ApiError,
  CreateRoomRequest,
  CreateRoomResponse,
  GetRoomResponse,
  Room as RoomState,
} from '@pointe/shared';
import { Room } from './room';
import { lookupSlug, reserveSlug } from './slug';

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace;
  POINTE_SLUGS: KVNamespace;
}

const SESSION_TTL_SECONDS = 2592000;

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function errorResponse(
  error: string,
  code: string,
  status: number,
  details?: Record<string, unknown>,
): Response {
  const body: ApiError = details ? { error, code, details } : { error, code };
  return json(body, status);
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse('Malformed JSON', 'MALFORMED_JSON', 400);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return errorResponse('Validation failed', 'INVALID_REQUEST', 400, { field: 'hostDisplayName' });
  }

  const req = parsed as CreateRoomRequest;
  const name = req.hostDisplayName;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 60) {
    return errorResponse('Validation failed', 'INVALID_REQUEST', 400, { field: 'hostDisplayName' });
  }

  const roomId = crypto.randomUUID();
  const hostUserId = crypto.randomUUID();

  // Reserve the slug before creating the DO: it's cheap and fails fast.
  // Caveat: if the DO init below fails after this point, the slug entry leaks
  // until its 30-day TTL expires. v1 accepts this; v2 should add cleanup.
  const slug = await reserveSlug(env.POINTE_SLUGS, roomId);

  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  const initRes = await stub.fetch(
    new Request('https://do/init', {
      method: 'POST',
      body: JSON.stringify({
        roomId,
        hostUser: { id: hostUserId, displayName: name },
        scaleType: req.scaleType ?? 'fibonacci',
        topic: req.topic,
      }),
    }),
  );
  if (!initRes.ok) {
    // Propagate the DO's error body and status code unchanged.
    return new Response(await initRes.text(), {
      status: initRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const room = (await initRes.json()) as RoomState;
  const sessionToken = crypto.randomUUID();
  const responseBody: CreateRoomResponse = { room, sessionToken, slug };
  const cookie =
    `pointe_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
  return json(responseBody, 201, { 'Set-Cookie': cookie });
}

/**
 * Handle GET /api/rooms/:slug. Returns null if the path isn't a room-by-slug
 * request, signalling the dispatcher to fall through to the 404 handler.
 */
async function getRoom(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = pathname.match(/^\/api\/rooms\/([a-z-]+-\d+)$/);
  if (!match) return null;
  const slug = match[1];

  const roomId = await lookupSlug(env.POINTE_SLUGS, slug);
  if (roomId === null) {
    return errorResponse('Room not found', 'SLUG_NOT_FOUND', 404);
  }

  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  const stateRes = await stub.fetch(new Request('https://do/state', { method: 'GET' }));
  if (!stateRes.ok) {
    // Propagate the DO's error body and status code unchanged.
    return new Response(await stateRes.text(), {
      status: stateRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const room = (await stateRes.json()) as RoomState;
  const responseBody: GetRoomResponse = { room };
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
        return await createRoom(request, env);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return errorResponse('Internal server error', message, 500);
      }
    }

    if (url.pathname.startsWith('/api/rooms/') && request.method === 'GET') {
      try {
        const res = await getRoom(request, env);
        if (res) return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return errorResponse('Internal server error', message, 500);
      }
    }

    return errorResponse('Not found', 'NOT_FOUND', 404);
  },
};
