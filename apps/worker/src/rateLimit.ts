import type { KVNamespace } from '@cloudflare/workers-types';

/**
 * SI-06 rate-limit helper. One uniform mechanism for all three external
 * surfaces — fixed-window per-IP counters in KV. See /spec/security.md §1
 * for the rationale (the ratelimit binding was considered for the per-minute
 * WS handshake and rejected: its per-location async counters enforce only
 * approximately and can't be deterministically verified).
 */

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

// Spec-locked budgets.
export const RL_CREATE_PER_HOUR = 20;
export const RL_LOOKUP_PER_HOUR = 200;
export const RL_WS_PER_MIN = 30;

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/**
 * Fixed-window per-IP counter. Reuses POINTE_SLUGS KV under the rl: prefix
 * (slug ops are point get/put with no list — no collision).
 *
 * Non-atomic by design — an abuse ceiling, not exact accounting. A racing
 * burst can slip 2–3 past the cap; that's fine at this scale. A DO-backed
 * counter would buy precision we don't need at the cost of a per-request hop.
 *
 * `windowMs` is the bucket size. TTL = 2× window (covers slop for in-flight
 * requests crossing the boundary), clamped to KV's 60s minimum.
 */
export async function checkWindowedIpLimit(
  kv: KVNamespace,
  action: string,
  ip: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  const bucket = Math.floor(now / windowMs);
  const key = `rl:${action}:${ip}:${bucket}`;
  const current = parseInt((await kv.get(key)) ?? '0', 10);
  if (current >= limit) return false;
  const ttl = Math.max(60, Math.ceil(windowMs / 1000) * 2);
  await kv.put(key, String(current + 1), { expirationTtl: ttl });
  return true;
}
