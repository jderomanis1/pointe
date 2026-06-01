import type { SqlStorage, WebSocket } from '@cloudflare/workers-types';
import type {
  DeltaChange, Envelope, ErrorPayload, JoinRoomPayload, RoomSnapshot,
  ServerMessageType, SnapshotStory, VoterRole,
} from '@pointe/shared';
import { PROTOCOL_VERSION } from '@pointe/shared';
import { resumeOrAddVoter, getRoomState } from './operations';
import { getAttachment } from './broadcast';

/** Side-effect callback the room.ts wrapper supplies; tests default to a no-op. */
export type BroadcastFn = (
  changes: DeltaChange[],
  opts?: { excludeWs?: WebSocket },
) => void;

const FIVE_MIN_MS = 5 * 60 * 1000;
const REVEALED_HISTORY_LIMIT = 3;

type HandlerCtx = {
  sql: SqlStorage;
  ws: WebSocket;
  envelope: Envelope;
  /** From `ws.deserializeAttachment()`. null until JOIN binds the socket. */
  voterId: string | null;
  /** True if this envelope id was already in `processed_message` within the 5-min window. */
  alreadyProcessed: boolean;
  /** Fan-out to other sockets (R2.iv). No-op by default in tests. */
  broadcast: BroadcastFn;
};

/**
 * Parse + validate + dedupe; route to a handler. Never throws.
 * Server-stamps `at` and echoes the request `id` on replies (unsolicited messages mint).
 */
export function handleMessage(
  sql: SqlStorage,
  ws: WebSocket,
  raw: string | ArrayBuffer,
  broadcast: BroadcastFn = () => {},
): Envelope[] {
  // Pre-parse errors: no request id available, mint.
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
  // `type` may be any string here; unknown types are routed to NOT_IMPLEMENTED by `route`.
  const envelope = parsed as Envelope;
  // Post-parse: echo request id from here on.
  if (envelope.v !== PROTOCOL_VERSION) {
    return [makeError('UNSUPPORTED_VERSION', `Unsupported protocol version: ${envelope.v}`, false, envelope.id)];
  }

  // Idempotency: durable 5-min dedupe + opportunistic cleanup.
  const now = Date.now();
  sql.exec('DELETE FROM processed_message WHERE at < ?', now - FIVE_MIN_MS);
  const existing = sql
    .exec<{ at: number }>('SELECT at FROM processed_message WHERE id = ?', envelope.id)
    .toArray()[0];
  const alreadyProcessed = existing !== undefined && now - existing.at < FIVE_MIN_MS;
  if (!alreadyProcessed) {
    sql.exec('INSERT OR REPLACE INTO processed_message (id, at) VALUES (?, ?)', envelope.id, now);
  }

  return route({
    sql, ws, envelope,
    voterId: getAttachment(ws)?.voterId ?? null,
    alreadyProcessed, broadcast,
  });
}

function route(ctx: HandlerCtx): Envelope[] {
  switch (ctx.envelope.type) {
    case 'RECONNECT_PING':
      return [makeEnvelope('PONG', {}, ctx.envelope.id)];
    case 'JOIN_ROOM':
      return handleJoinRoom(ctx);
    default:
      return [makeError('NOT_IMPLEMENTED', `${ctx.envelope.type} arrives in a later task`, false, ctx.envelope.id)];
  }
}

function handleJoinRoom(ctx: HandlerCtx): Envelope[] {
  const { sql, ws, envelope, broadcast } = ctx;
  if (!isJoinRoomPayload(envelope.payload)) {
    return [makeError('BAD_PAYLOAD', 'JOIN_ROOM payload invalid', false, envelope.id)];
  }
  const payload = envelope.payload;

  let voterId: string;
  let didBind = false;
  if (ctx.voterId) {
    // Re-JOIN on a live socket — reuse the existing binding.
    voterId = ctx.voterId;
  } else {
    try {
      const voter = resumeOrAddVoter(sql, {
        voterId: crypto.randomUUID(),
        resumeVoterId: payload.resumeVoterId,
        displayName: payload.displayName,
        role: payload.role,
        now: Date.now(),
      });
      voterId = voter.id;
      // SI-01: bind identity on the socket. Survives hibernation.
      ws.serializeAttachment({ voterId: voter.id, role: voter.role });
      didBind = true;
    } catch (err) {
      const code = err instanceof Error ? err.message : 'INTERNAL';
      return [makeError(code, code, false, envelope.id)];
    }
  }

  const snapshot = buildSnapshot(sql, voterId);

  // Broadcast voter_joined to OTHER sockets (skip the joiner — they have the snapshot).
  // Re-JOIN on an already-bound socket does not re-announce.
  if (didBind) {
    const me = snapshot.voters.find((v) => v.id === voterId);
    if (me) broadcast([{ kind: 'voter_joined', voter: me }], { excludeWs: ws });
  }

  return [makeEnvelope('SNAPSHOT_RESPONSE', snapshot, envelope.id)];
}

/** Build the snapshot with anti-anchoring + scope limit. */
function buildSnapshot(sql: SqlStorage, voterId: string): RoomSnapshot {
  const state = getRoomState(sql);
  const me = state.voters.find((v) => v.id === voterId);
  if (!me) throw new Error('VOTER_NOT_FOUND');

  const active = state.stories.find((s) => s.state === 'active');
  const revealed = state.stories
    .filter((s) => s.state === 'revealed' || s.state === 'committed')
    .sort((a, b) => (a.revealedAt ?? 0) - (b.revealedAt ?? 0))
    .slice(-REVEALED_HISTORY_LIMIT);

  const snapStories: SnapshotStory[] = [];
  if (active) {
    // Anti-anchoring: active story carries NO votes.
    snapStories.push({ ...active, votes: [] });
  }
  for (const story of revealed) {
    snapStories.push({ ...story, votes: state.votes.filter((v) => v.storyId === story.id) });
  }

  return {
    room: state.room,
    voters: state.voters,
    stories: snapStories,
    you: { voterId, role: me.role as VoterRole },
  };
}

// ---- helpers ----

function makeEnvelope<T>(type: ServerMessageType, payload: T, id?: string): Envelope<T> {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: id ?? crypto.randomUUID(),
    at: Date.now(),
    payload,
  };
}

function makeError(code: string, message: string, retriable: boolean, id?: string): Envelope<ErrorPayload> {
  return makeEnvelope('ERROR', { code, message, retriable }, id);
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

function isJoinRoomPayload(p: unknown): p is JoinRoomPayload {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  if (o.slug !== undefined && typeof o.slug !== 'string') return false;
  if (o.displayName !== undefined && typeof o.displayName !== 'string') return false;
  if (o.resumeVoterId !== undefined && typeof o.resumeVoterId !== 'string') return false;
  return o.role === 'voter' || o.role === 'spectator';
}
