import devWorker, { Room } from './worker.dev';
import retroWorker, { RetroRoom, type Env } from './workerWithRetro';

export { Room, RetroRoom };

export default {
  async fetch(
    request: Request,
    env: Env & { POINTE_E2E_TOKEN?: string },
    ctx: ExecutionContext,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/retros' || pathname.startsWith('/api/retros/')) {
      return retroWorker.fetch(request, env, ctx);
    }
    return devWorker.fetch(request, env, ctx);
  },
};
