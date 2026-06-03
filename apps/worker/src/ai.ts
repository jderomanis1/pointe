/**
 * S8.i.a — AI data-access primitives.
 *
 * Pure storage helpers over `ai_suggestion`, `ai_cache`, and `ai_rate_limit`.
 * No protocol, no broadcasting — those are S8.ii. This file is what the
 * REQUEST_AI / SHARE_AI handlers will call when they land.
 *
 * Schema lives in src/schema.ts (the table definitions and the
 * `shared`/`shared_at` migration). The shape of `payload` JSON matches the
 * `AISuggestion` shared type minus the bookkeeping fields the columns already
 * carry (storyId / state / requestedAt / completedAt / errorMessage / shared).
 */
import type { SqlStorage } from '@cloudflare/workers-types';
import type { AISuggestion, AISuggestionState } from '@pointe/shared';

/** The hourly AI budget per room. Spec §S8 — locked decision #4. */
export const AI_RATE_LIMIT_PER_ROOM_PER_HOUR = 3;
const HOUR_MS = 3_600_000;

/** Shape persisted in `ai_suggestion.payload` (TEXT JSON). */
type AiPayloadJson = Pick<
  AISuggestion,
  'complexity' | 'effort' | 'risk' | 'unknowns' | 'suggestedRange' | 'rationale'
>;

type AiSuggestionRow = {
  story_id: string;
  state: string;
  payload: string | null;
  error_message: string | null;
  requested_at: number;
  completed_at: number | null;
  shared: number;
  shared_at: number | null;
};

/**
 * Upsert (story_id PK) the AI suggestion row. Pass only the fields you want
 * to set; the call writes whatever was provided. Designed so the REQUEST_AI
 * insert and the post-call ready/failed updates use the same primitive.
 */
export function upsertAiSuggestion(
  sql: SqlStorage,
  params: {
    storyId: string;
    state: AISuggestionState;
    payload?: AiPayloadJson | null;
    errorMessage?: string | null;
    requestedAt: number;
    completedAt?: number | null;
    shared?: boolean;
    sharedAt?: number | null;
  },
): void {
  sql.exec(
    `INSERT INTO ai_suggestion
       (story_id, state, payload, error_message, requested_at, completed_at, shared, shared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(story_id) DO UPDATE SET
       state         = excluded.state,
       payload       = excluded.payload,
       error_message = excluded.error_message,
       requested_at  = excluded.requested_at,
       completed_at  = excluded.completed_at,
       shared        = excluded.shared,
       shared_at     = excluded.shared_at`,
    params.storyId,
    params.state,
    params.payload === undefined || params.payload === null
      ? null
      : JSON.stringify(params.payload),
    params.errorMessage ?? null,
    params.requestedAt,
    params.completedAt ?? null,
    params.shared ? 1 : 0,
    params.sharedAt ?? null,
  );
}

/** Read a suggestion by story id; null if no row exists. */
export function getAiSuggestion(sql: SqlStorage, storyId: string): AISuggestion | null {
  const row = sql
    .exec<AiSuggestionRow>(`SELECT * FROM ai_suggestion WHERE story_id = ?`, storyId)
    .toArray()[0];
  if (!row) return null;
  return mapAiSuggestionRow(row);
}

/** Internal — single row mapper so the serializer (S8.i.b) can reuse the shape. */
export function mapAiSuggestionRow(row: AiSuggestionRow): AISuggestion {
  const payload: AiPayloadJson | null = row.payload ? (JSON.parse(row.payload) as AiPayloadJson) : null;
  const suggestion: AISuggestion = {
    storyId: row.story_id,
    state: row.state as AISuggestionState,
    requestedAt: row.requested_at,
  };
  if (row.completed_at !== null) suggestion.completedAt = row.completed_at;
  if (row.error_message !== null) suggestion.errorMessage = row.error_message;
  if (payload) {
    if (payload.complexity) suggestion.complexity = payload.complexity;
    if (payload.effort) suggestion.effort = payload.effort;
    if (payload.risk) suggestion.risk = payload.risk;
    if (payload.unknowns) suggestion.unknowns = payload.unknowns;
    if (payload.suggestedRange) suggestion.suggestedRange = payload.suggestedRange;
    if (payload.rationale) suggestion.rationale = payload.rationale;
  }
  if (row.shared === 1) suggestion.shared = true;
  if (row.shared_at !== null) suggestion.sharedAt = row.shared_at;
  return suggestion;
}

/** Read the row shape directly — used by the serializer where the typed
 *  AISuggestion isn't needed (we only need the row's shared flag + state). */
export function getAiSuggestionRow(sql: SqlStorage, storyId: string): AiSuggestionRow | null {
  const row = sql
    .exec<AiSuggestionRow>(`SELECT * FROM ai_suggestion WHERE story_id = ?`, storyId)
    .toArray()[0];
  return row ?? null;
}

// ---- ai_cache --------------------------------------------------------------

/** Read a cached suggestion payload. Returns the parsed JSON or null. */
export function getAiCache(sql: SqlStorage, cacheKey: string): AiPayloadJson | null {
  const row = sql
    .exec<{ payload: string }>(`SELECT payload FROM ai_cache WHERE cache_key = ?`, cacheKey)
    .toArray()[0];
  if (!row) return null;
  return JSON.parse(row.payload) as AiPayloadJson;
}

/** Write a cached suggestion payload (overwrites on hash collision; key is
 *  sha256(text+deck) computed in S8.ii). */
export function putAiCache(
  sql: SqlStorage,
  params: { cacheKey: string; payload: AiPayloadJson; now: number },
): void {
  sql.exec(
    `INSERT INTO ai_cache (cache_key, payload, created_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
    params.cacheKey,
    JSON.stringify(params.payload),
    params.now,
  );
}

// ---- ai_rate_limit ---------------------------------------------------------

/**
 * Check-and-consume the per-room AI hourly budget. Atomic upsert-returning,
 * same shape as the WS-handshake limiter (S7 SI-06 saga lesson: this is the
 * only counter shape that avoids the real-DO `.one()` zero-row throw).
 *
 * Callers MUST invoke this only when an actual API call is about to happen —
 * after a cache miss. The spec is "3 AI calls per room per hour" and a cache
 * hit is not an API call. S8.ii wires the call-site.
 *
 * Returns the post-increment state. `allowed: false` means the budget is
 * exhausted for the current window; the counter still increments so repeated
 * over-budget attempts don't reset the clock.
 */
export function checkAiRateLimit(
  sql: SqlStorage,
  params: { now: number; limit?: number },
): { allowed: boolean; count: number; limit: number; resetAt: number } {
  const limit = params.limit ?? AI_RATE_LIMIT_PER_ROOM_PER_HOUR;
  const windowStart = Math.floor(params.now / HOUR_MS) * HOUR_MS;
  // Self-clean stale buckets — bounded to one row across the DO's lifetime
  // for this counter, but keeps the table from accumulating windows.
  sql.exec(`DELETE FROM ai_rate_limit WHERE window_start < ?`, windowStart);
  const result = sql
    .exec<{ count: number }>(
      `INSERT INTO ai_rate_limit (window_start, count) VALUES (?, 1)
       ON CONFLICT(window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
      windowStart,
    )
    .one();
  return {
    allowed: result.count <= limit,
    count: result.count,
    limit,
    resetAt: windowStart + HOUR_MS,
  };
}
