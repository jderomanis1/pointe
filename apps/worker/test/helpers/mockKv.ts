import type { KVNamespace } from '@cloudflare/workers-types';

/**
 * Minimal in-memory KV mock for rate-limit tests. Implements only the get/put
 * surface the rate-limiter touches; TTL is ignored (these tests don't sleep).
 * Casting through unknown because KVNamespace is a nominal interface; this
 * mock supports just the methods used.
 */
export function createMockKv(): KVNamespace & { __dump(): Map<string, string> } {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    __dump: () => store,
  } as unknown as KVNamespace & { __dump(): Map<string, string> };
}
