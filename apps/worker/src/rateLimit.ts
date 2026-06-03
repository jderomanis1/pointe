import type { KVNamespace } from '@cloudflare/workers-types';

/**
 * SI-06 rate-limit helpers. See /spec/security.md §1 for the why-two-mechanisms
 * rationale: the Workers ratelimit binding only supports 10s/60s windows, so
 * the per-hour budgets live here in KV as fixed-window counters.
 */

const HOUR_MS = 3_600_000;
// 2h: the active hour bucket + slop for any in-flight requests crossing the
// boundary, then the key self-cleans. No janitor needed.
const COUNTER_TTL_S = 7_200;

// Per-hour budgets are locked from spec.
export const RL_CREATE_PER_HOUR = 20;
export const RL_LOOKUP_PER_HOUR = 200;

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/**
 * Fixed-window per-IP hourly counter. Reuses POINTE_SLUGS KV under the rl:
 * prefix — slug ops are point get/put with no list, so no collision.
 *
 * Non-atomic by design — an abuse ceiling, not exact accounting. A racing
 * burst could slip 2–3 past the cap; that's fine at this scale. A DO-backed
 * counter would buy precision we don't need at the cost of a per-request hop.
 * See /spec/security.md §1.
 */
export async function checkHourlyIpLimit(
  kv: KVNamespace,
  action: string,
  ip: string,
  limit: number,
  now: number = Date.now(),
): Promise<boolean> {
  const bucket = Math.floor(now / HOUR_MS);
  const key = `rl:${action}:${ip}:${bucket}`;
  const current = parseInt((await kv.get(key)) ?? '0', 10);
  if (current >= limit) return false;
  await kv.put(key, String(current + 1), { expirationTtl: COUNTER_TTL_S });
  return true;
}
