import type { KVNamespace } from '@cloudflare/workers-types';
import type {
  ApiError,
  CreateRoomRequest,
  CreateRoomResponse,
  Room as RoomState,
} from '@pointe/shared';
import { Room } from './room';
import { reserveSlug } from './slug';

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

    return errorResponse('Not found', 'NOT_FOUND', 404);
  },
};
