import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from './worker';

export class Room {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(_request: Request): Promise<Response> {
    // Real implementation arrives in Sprint S1.
    // This stub exists so the binding resolves during S0.
    return new Response('Room DO placeholder — implementation in S1', {
      status: 501,
    });
  }
}
