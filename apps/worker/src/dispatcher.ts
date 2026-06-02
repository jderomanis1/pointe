import type { SqlStorage, WebSocket } from '@cloudflare/workers-types';
import type {
  AddStoryPayload, CommitStoryPayload, DeltaChange, EditStoryPayload, Envelope, ErrorPayload,
  JoinRoomPayload, OpenVotingPayload, RevealVotesPayload, RoomSnapshot, ServerMessageType,
  SnapshotStory, VoteCastPayload, VoterRole,
} from '@pointe/shared';
import { PROTOCOL_VERSION, computeRevealStats, resolveDeck } from '@pointe/shared';
import {
  addStory, castVote, commitStory, editStory, openVoting, revealVotes,
  resumeOrAddVoter, getHostVoterId, getRoomState,
} from './operations';
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
  /** R3.i: handlers call this after a successful mutation to dedupe future replays. */
  markProcessed: () => void;
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

  // Idempotency: check only — recording is record-on-success in the handler.
  const now = Date.now();
  sql.exec('DELETE FROM processed_message WHERE at < ?', now - FIVE_MIN_MS);
  const existing = sql
    .exec<{ at: number }>('SELECT at FROM processed_message WHERE id = ?', envelope.id)
    .toArray()[0];
  const alreadyProcessed = existing !== undefined && now - existing.at < FIVE_MIN_MS;

  return route({
    sql, ws, envelope,
    voterId: getAttachment(ws)?.voterId ?? null,
    alreadyProcessed,
    broadcast,
    markProcessed: () => {
      sql.exec(
        'INSERT OR REPLACE INTO processed_message (id, at) VALUES (?, ?)',
        envelope.id, Date.now(),
      );
    },
  });
}

function route(ctx: HandlerCtx): Envelope[] {
  switch (ctx.envelope.type) {
    case 'RECONNECT_PING':
      return [makeEnvelope('PONG', {}, ctx.envelope.id)];
    case 'JOIN_ROOM':
      return handleJoinRoom(ctx);
    case 'ADD_STORY':
      return handleAddStory(ctx);
    case 'EDIT_STORY':
      return handleEditStory(ctx);
    case 'OPEN_VOTING':
      return handleOpenVoting(ctx);
    case 'VOTE_CAST':
      return handleVoteCast(ctx);
    case 'REVEAL_VOTES':
      return handleRevealVotes(ctx);
    case 'COMMIT_STORY':
      return handleCommitStory(ctx);
    default:
      return [makeError('NOT_IMPLEMENTED', `${ctx.envelope.type} arrives in a later task`, false, ctx.envelope.id)];
  }
}

/** SI-02: authority is the socket binding vs Room.hostVoterId. Payload `voterId` is never trusted. */
function requireHost(ctx: HandlerCtx): { ok: true } | { ok: false; error: Envelope } {
  if (!ctx.voterId) {
    return { ok: false, error: makeError('NOT_JOINED', 'JOIN_ROOM first', false, ctx.envelope.id) };
  }
  const hostId = getHostVoterId(ctx.sql);
  if (!hostId) {
    return { ok: false, error: makeError('ROOM_NOT_FOUND', 'Room not initialized', false, ctx.envelope.id) };
  }
  if (ctx.voterId !== hostId) {
    return { ok: false, error: makeError('NOT_HOST', 'Host only', false, ctx.envelope.id) };
  }
  return { ok: true };
}

function handleAddStory(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isAddStoryPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'ADD_STORY payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  try {
    const story = addStory(ctx.sql, {
      storyId: crypto.randomUUID(),
      text: p.text,
      externalId: p.externalId,
      externalUrl: p.externalUrl,
      description: p.description,
      now: Date.now(),
    });
    ctx.markProcessed();
    ctx.broadcast([{ kind: 'story_added', story }]);
    return [];
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL';
    return [makeError(code, code, false, ctx.envelope.id)];
  }
}

function handleEditStory(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isEditStoryPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'EDIT_STORY payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  try {
    const story = editStory(ctx.sql, {
      storyId: p.storyId,
      text: p.text,
      externalId: p.externalId,
      externalUrl: p.externalUrl,
      description: p.description,
    });
    ctx.markProcessed();
    ctx.broadcast([{ kind: 'story_edited', story }]);
    return [];
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL';
    return [makeError(code, code, false, ctx.envelope.id)];
  }
}

function handleOpenVoting(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isOpenVotingPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'OPEN_VOTING payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  try {
    openVoting(ctx.sql, { storyId: p.storyId, now: Date.now() });
    ctx.markProcessed();
    ctx.broadcast([{ kind: 'voting_opened', storyId: p.storyId }]);
    return [];
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL';
    return [makeError(code, code, false, ctx.envelope.id)];
  }
}

/**
 * Any bound voter may cast. Attribution comes from `ctx.voterId` (SI-01) — payload `voterId`
 * is ignored. On success, broadcast emits BOTH `vote_value` (caster-only via projection)
 * AND `voter_voted` (presence to everyone). projectChangesFor enforces the split.
 */
function handleVoteCast(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  if (!ctx.voterId) {
    return [makeError('NOT_JOINED', 'JOIN_ROOM first', false, ctx.envelope.id)];
  }
  if (!isVoteCastPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'VOTE_CAST payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  try {
    castVote(ctx.sql, {
      storyId: p.storyId,
      voterId: ctx.voterId,
      points: p.points,
      confidence: p.confidence,
      now: Date.now(),
    });
    ctx.markProcessed();
    ctx.broadcast([
      { kind: 'vote_value', storyId: p.storyId, points: p.points, confidence: p.confidence },
      { kind: 'voter_voted', storyId: p.storyId, voterId: ctx.voterId },
    ]);
    return [];
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL';
    return [makeError(code, code, false, ctx.envelope.id)];
  }
}

/** REVEAL_VOTES (host-only) inverts the anti-anchoring filter — values become public. */
function handleRevealVotes(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isRevealVotesPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'REVEAL_VOTES payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  try {
    const { votes } = revealVotes(ctx.sql, { storyId: p.storyId, now: Date.now() });
    const roomRow = ctx.sql
      .exec<{ deck: string; custom_deck: string | null }>(
        'SELECT deck, custom_deck FROM room LIMIT 1',
      ).toArray()[0];
    const deck = roomRow
      ? resolveDeck(roomRow.deck as Parameters<typeof resolveDeck>[0], roomRow.custom_deck ? JSON.parse(roomRow.custom_deck) : null)
      : [];
    const stats = computeRevealStats(deck, votes);
    ctx.markProcessed();
    ctx.broadcast([{ kind: 'votes_revealed', storyId: p.storyId, votes, stats }]);
    return [];
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL';
    return [makeError(code, code, false, ctx.envelope.id)];
  }
}

/** COMMIT_STORY (host-only) finalises the estimate; closes the loop. */
function handleCommitStory(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isCommitStoryPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'COMMIT_STORY payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  try {
    commitStory(ctx.sql, { storyId: p.storyId, finalEstimate: p.finalEstimate });
    ctx.markProcessed();
    ctx.broadcast([{ kind: 'story_committed', storyId: p.storyId, finalEstimate: p.finalEstimate }]);
    return [];
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL';
    return [makeError(code, code, false, ctx.envelope.id)];
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

function isAddStoryPayload(p: unknown): p is AddStoryPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.text !== 'string' || o.text.length === 0) return false;
  for (const k of ['externalId', 'externalUrl', 'description'] as const) {
    if (o[k] !== undefined && typeof o[k] !== 'string') return false;
  }
  return true;
}

function isEditStoryPayload(p: unknown): p is EditStoryPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.storyId !== 'string') return false;
  for (const k of ['text', 'externalId', 'externalUrl', 'description'] as const) {
    if (o[k] !== undefined && typeof o[k] !== 'string') return false;
  }
  return true;
}

function isOpenVotingPayload(p: unknown): p is OpenVotingPayload {
  return !!p && typeof p === 'object' &&
    typeof (p as Record<string, unknown>).storyId === 'string';
}

function isVoteCastPayload(p: unknown): p is VoteCastPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.storyId !== 'string' || o.storyId.length === 0) return false;
  if (typeof o.points !== 'string' || o.points.length === 0) return false;
  if (typeof o.confidence !== 'number' || !Number.isInteger(o.confidence)) return false;
  if (o.confidence < 1 || o.confidence > 5) return false;
  return true;
}

function isRevealVotesPayload(p: unknown): p is RevealVotesPayload {
  return !!p && typeof p === 'object' &&
    typeof (p as Record<string, unknown>).storyId === 'string';
}

function isCommitStoryPayload(p: unknown): p is CommitStoryPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.storyId === 'string' &&
    typeof o.finalEstimate === 'string' && o.finalEstimate.length > 0;
}
