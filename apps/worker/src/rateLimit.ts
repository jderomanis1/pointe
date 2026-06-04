import type { KVNamespace, SqlStorage } from '@cloudflare/workers-types';

/**
 * SI-06 rate-limit helper. One uniform mechanism for all three external
 * surfaces — fixed-window per-IP counters in KV. See /spec/security.md §1
 * for the rationale (the ratelimit binding was considered for the per-minute
 * WS handshake and rejected: its per-location async counters enforce only
 * approximately and can't be deterministically verified).
 */

export const HOUR_MS = 3_600_000;
/** Window for the per-IP/room WS handshake limit (enforced in the DO, not KV). */
export const MINUTE_MS = 60_000;

// Spec-locked budgets.
export const RL_CREATE_PER_HOUR = 20;
export const RL_LOOKUP_PER_HOUR = 200;
/** WS handshake budget per IP per ROOM per minute. Atomic counter in the room DO. */
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

/**
 * S9 fix — extract the SI-06 WS-handshake counter into a pure function with
 * `now` threaded in. The DO's `checkWsHandshakeRate` wraps this with
 * `Date.now()` in production; tests invoke it directly with a controlled
 * `now` through `runInDurableObject` to assert the trip-at-31 truth without
 * a wall-clock dependency.
 *
 * Production shape is unchanged: stale rows (`window_start < currentWindow`)
 * are deleted, then an atomic upsert-returning bumps the current-bucket
 * count by 1 and reads the new value in one statement. The same shape the
 * S7 saga proved out — RETURNING is the only counter pattern that avoids
 * the real-DO `.one()` zero-row throw.
 *
 * Returns the post-increment `count` and the trip decision. The caller
 * shapes the HTTP response (status + Retry-After + body).
 */
export function checkWsHandshakeRate(
  sql: SqlStorage,
  params: { ip: string; now: number; limit?: number },
): { count: number; tripped: boolean; windowStart: number } {
  const limit = params.limit ?? RL_WS_PER_MIN;
  const windowStart = Math.floor(params.now / MINUTE_MS) * MINUTE_MS;
  sql.exec('DELETE FROM ws_handshake_rate WHERE window_start < ?', windowStart);
  const result = sql.exec<{ count: number }>(
    `INSERT INTO ws_handshake_rate (ip, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(ip, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
    params.ip, windowStart,
  ).one();
  return {
    count: result.count,
    tripped: result.count > limit,
    windowStart,
  };
}
