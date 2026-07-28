import type { KVNamespace } from '@cloudflare/workers-types';
import type {
  ApiError,
  CreateRetroRequest,
  CreateRetroResponse,
  GetRetroResponse,
} from '@pointe/shared';
import prodWorker, { createPerHour, type Env as PlanningEnv } from './worker';
import { lookupSlug, reserveSlug } from './slug';
import {
  checkWindowedIpLimit,
  clientIp,
  HOUR_MS,
  RL_LOOKUP_PER_HOUR,
} from './rateLimit';

export { Room } from './worker';
export { RetroRoom } from './retroRoom';

export interface Env extends PlanningEnv {
  RETRO: DurableObjectNamespace;
  POINTE_SLUGS: KVNamespace;
}

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

function rateLimited(message: string, retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ code: 'RATE_LIMITED', message } satisfies ApiError), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
    },
  });
}

async function retroRoomId(env: Env, slug: string): Promise<string | null> {
  const stored = await lookupSlug(env.POINTE_SLUGS, slug);
  return stored?.startsWith('retro:') ? stored.slice('retro:'.length) : null;
}

async function createRetroEndpoint(request: Request, env: Env): Promise<Response> {
  if (!(await checkWindowedIpLimit(
    env.POINTE_SLUGS,
    'create',
    clientIp(request),
    createPerHour(env),
    HOUR_MS,
  ))) {
    return rateLimited('Too many rooms created from this IP. Try again later.', 3600);
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse('MALFORMED_JSON', 'Malformed JSON body', 400);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return errorResponse('INVALID_REQUEST', 'facilitatorName required', 400);
  }

  const req = parsed as CreateRetroRequest;
  const facilitatorName = req.facilitatorName;
  if (typeof facilitatorName !== 'string' || facilitatorName.trim().length < 1 || facilitatorName.length > 60) {
    return errorResponse('INVALID_REQUEST', 'facilitatorName required (1–60 chars)', 400);
  }

  const roomId = crypto.randomUUID();
  const participantId = crypto.randomUUID();
  const slug = await reserveSlug(env.POINTE_SLUGS, `retro:${roomId}`);
  const stub = env.RETRO.get(env.RETRO.idFromName(roomId));
  const init = await stub.fetch(new Request('https://retro/init', {
    method: 'POST',
    body: JSON.stringify({
      roomId,
      slug,
      facilitatorId: participantId,
      facilitatorName: facilitatorName.trim(),
    }),
  }));
  if (!init.ok) {
    return new Response(await init.text(), {
      status: init.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const host = new URL(request.url).host;
  const body: CreateRetroResponse = {
    slug,
    participantId,
    wsUrl: `wss://${host}/api/retros/${slug}/ws`,
  };
  return json(body, 201);
}

async function retroWsEndpoint(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = pathname.match(/^\/api\/retros\/([a-z-]+-\d+)\/ws$/);
  if (!match) return null;
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected websocket', { status: 426 });
  }
  const roomId = await retroRoomId(env, match[1]);
  if (!roomId) return errorResponse('RETRO_NOT_FOUND', 'Retrospective not found', 404);
  const stub = env.RETRO.get(env.RETRO.idFromName(roomId));
  return stub.fetch(new Request('https://retro/ws', request));
}

async function getRetroEndpoint(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = pathname.match(/^\/api\/retros\/([a-z-]+-\d+)$/);
  if (!match) return null;
  if (!(await checkWindowedIpLimit(
    env.POINTE_SLUGS,
    'lookup',
    clientIp(request),
    RL_LOOKUP_PER_HOUR,
    HOUR_MS,
  ))) {
    return rateLimited('Too many lookups from this IP. Try again later.', 3600);
  }
  const roomId = await retroRoomId(env, match[1]);
  if (!roomId) return errorResponse('RETRO_NOT_FOUND', 'Retrospective not found', 404);
  const stub = env.RETRO.get(env.RETRO.idFromName(roomId));
  const state = await stub.fetch(new Request('https://retro/state'));
  if (!state.ok) {
    return new Response(await state.text(), {
      status: state.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return json((await state.json()) as GetRetroResponse, 200);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/retros' && request.method === 'POST') {
      try {
        return await createRetroEndpoint(request, env);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal error';
        return errorResponse('INTERNAL', message, 500);
      }
    }

    if (url.pathname.startsWith('/api/retros/') && url.pathname.endsWith('/ws') && request.method === 'GET') {
      try {
        const response = await retroWsEndpoint(request, env);
        if (response) return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal error';
        return errorResponse('INTERNAL', message, 500);
      }
    }

    if (url.pathname.startsWith('/api/retros/') && request.method === 'GET') {
      try {
        const response = await getRetroEndpoint(request, env);
        if (response) return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal error';
        return errorResponse('INTERNAL', message, 500);
      }
    }

    return prodWorker.fetch(request, env, ctx);
  },
};
