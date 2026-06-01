import type { SqlStorage } from '@cloudflare/workers-types';
import type { Envelope, ErrorPayload, ServerMessageType } from '@pointe/shared';
import { PROTOCOL_VERSION } from '@pointe/shared';

const FIVE_MIN_MS = 5 * 60 * 1000;

/**
 * Pure-ish dispatcher: parses + validates + dedupes the envelope and returns the
 * envelope(s) the caller (webSocketMessage in room.ts) should `ws.send(JSON.stringify(...))`.
 * Never throws. Server-stamps `at` on every emitted envelope; the client's `at` is ignored.
 */
export function handleMessage(sql: SqlStorage, raw: string | ArrayBuffer): Envelope[] {
  // Only JSON text is supported; binary frames are rejected.
  if (typeof raw !== 'string') {
    return [makeError('BAD_ENVELOPE', 'Binary frames are not supported', false)];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [makeError('BAD_ENVELOPE', 'Malformed JSON envelope', false)];
  }
  if (!isValidEnvelope(parsed)) {
    return [makeError('BAD_ENVELOPE', 'Envelope shape invalid', false)];
  }
  if (parsed.v !== PROTOCOL_VERSION) {
    return [makeError('UNSUPPORTED_VERSION', `Unsupported protocol version: ${parsed.v}`, false)];
  }

  // Idempotency: durable dedupe with 5-min TTL. Opportunistic cleanup of stale rows.
  const now = Date.now();
  sql.exec('DELETE FROM processed_message WHERE at < ?', now - FIVE_MIN_MS);
  const existing = sql
    .exec<{ at: number }>('SELECT at FROM processed_message WHERE id = ?', parsed.id)
    .toArray()[0];
  const isReplay = existing !== undefined && now - existing.at < FIVE_MIN_MS;
  if (!isReplay) {
    sql.exec('INSERT OR REPLACE INTO processed_message (id, at) VALUES (?, ?)', parsed.id, now);
  }
  // For RECONNECT_PING (and the NOT_IMPLEMENTED scaffolding), there are no state effects to
  // duplicate — replays re-emit the same ack. Once domain messages land in R2.iii+, their
  // handlers will check the replay flag before applying state changes.

  return routeByType(parsed.type);
}

function routeByType(type: string): Envelope[] {
  if (type === 'RECONNECT_PING') {
    return [makeEnvelope('PONG', {})];
  }
  return [makeError('NOT_IMPLEMENTED', `${type} arrives in a later task`, false)];
}

function makeEnvelope<T>(type: ServerMessageType, payload: T): Envelope<T> {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: crypto.randomUUID(),
    at: Date.now(),
    payload,
  };
}

function makeError(code: string, message: string, retriable: boolean): Envelope<ErrorPayload> {
  return makeEnvelope('ERROR', { code, message, retriable });
}

function isValidEnvelope(
  x: unknown,
): x is { v: number; type: string; id: string; at: number; payload: unknown } {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.v === 'number' &&
    typeof e.type === 'string' &&
    typeof e.id === 'string' &&
    typeof e.at === 'number' &&
    'payload' in e
  );
}
