import { Room } from './room';

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return Response.json({ ok: true, ts: Date.now() });
    }

    return new Response('Not found', { status: 404 });
  },
};
