import type { SqlStorage, WebSocket } from '@cloudflare/workers-types';
import type {
  AddStoryPayload, CommitStoryPayload, DeltaChange, EditStoryPayload, Envelope, ErrorPayload,
  HostReclaimedPayload, JoinRoomPayload, OpenVotingPayload, RevealVotesPayload, RoomSnapshot,
  ServerMessageType, SkipStoryPayload, SnapshotStory, SplitStoryPayload, TransferHostPayload,
  VoteCastPayload, VoterRole,
} from '@pointe/shared';
import { PROTOCOL_VERSION, computeRevealStats, resolveDeck } from '@pointe/shared';
import {
  addStory, castVote, commitStory, editStory, insertAuditEvent, openVoting,
  revealVotes, resumeOrAddVoter, getHostVoterId, getRoomLifecycle, getRoomState,
  getVoterById, setRoomHost, skipStory, splitStory,
} from './operations';
import { getAttachment } from './broadcast';
import { getAiSuggestion, projectAiForRecipient } from './ai';

/** Side-effect callback the room.ts wrapper supplies; tests default to a no-op. */
export type BroadcastFn = (
  changes: DeltaChange[],
  opts?: { excludeWs?: WebSocket },
) => void;

/** S7.ii: fire-and-forget host_vacant-task cancellation. Wrapped here so the
 *  dispatcher doesn't need to know about the scheduler module. */
export type CancelHostVacantFn = () => void;

/** S7.iii: fan out a non-DELTA server envelope (HOST_RECLAIMED, …) to every
 *  attached socket. Wrapped here so the dispatcher doesn't import broadcast.ts. */
export type BroadcastEnvelopeFn = <T>(type: ServerMessageType, payload: T) => void;

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
  /** S7.ii: fire-and-forget cancel of pending host_vacant tasks. No-op in tests by default. */
  cancelHostVacantTask: CancelHostVacantFn;
  /** S7.iii: fan out a top-level non-DELTA server message. No-op in tests by default. */
  broadcastEnvelope: BroadcastEnvelopeFn;
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
  cancelHostVacantTask: CancelHostVacantFn = () => {},
  broadcastEnvelope: BroadcastEnvelopeFn = () => {},
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
    cancelHostVacantTask,
    broadcastEnvelope,
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
    case 'SKIP_STORY':
      return handleSkipStory(ctx);
    case 'SPLIT_STORY':
      return handleSplitStory(ctx);
    case 'CLAIM_HOST':
      return handleClaimHost(ctx);
    case 'TRANSFER_HOST':
      return handleTransferHost(ctx);
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
    const result = openVoting(ctx.sql, { storyId: p.storyId, now: Date.now() });
    // OQ-010: re-open path captured the prior round's votes. Preserve them in
    // the audit_event log BEFORE broadcasting (preserve-before-destroy). The
    // operation already deleted the vote rows; we just record what they were.
    if (result.clearedVotes !== null) {
      const roomRow = ctx.sql
        .exec<{ deck: string; custom_deck: string | null }>(
          'SELECT deck, custom_deck FROM room LIMIT 1',
        ).toArray()[0];
      const deck = roomRow
        ? resolveDeck(roomRow.deck as Parameters<typeof resolveDeck>[0], roomRow.custom_deck ? JSON.parse(roomRow.custom_deck) : null)
        : [];
      const stats = computeRevealStats(deck, result.clearedVotes);
      insertAuditEvent(ctx.sql, {
        eventType: 'votes_revealed',
        actorVoterId: ctx.voterId,
        at: result.prevRevealedAt ?? Date.now(),
        payload: {
          storyId: p.storyId,
          votes: result.clearedVotes,
          stats,
          reason: 'reopened',
        },
      });
    }
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

function handleSplitStory(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isSplitStoryPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'SPLIT_STORY payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  try {
    const result = splitStory(ctx.sql, {
      storyId: p.storyId,
      childTexts: p.children.map((c) => c.text),
      now: Date.now(),
    });
    ctx.markProcessed();
    ctx.broadcast([{ kind: 'story_split', parentId: result.parent.id, children: result.children }]);
    return [];
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL';
    return [makeError(code, code, false, ctx.envelope.id)];
  }
}

function handleSkipStory(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isSkipStoryPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'SKIP_STORY payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  try {
    skipStory(ctx.sql, { storyId: p.storyId });
    ctx.markProcessed();
    ctx.broadcast([{ kind: 'story_skipped', storyId: p.storyId }]);
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

  // S7.ii: host reconnect within the grace cancels the pending host_vacant task.
  // Idempotent: alarm handler re-checks state, so a missed cancel is a no-op too.
  // S7.iii: post-vacancy reclaim — original host rejoining while still vacant
  // (nobody claimed in the grace) auto-restores them (D2). After someone has
  // claimed (room === 'active' with a different host), they simply rejoin as
  // their stored role; no backend restore. The S7.iv notice is UI-only.
  {
    const lifecycle = getRoomLifecycle(sql);
    if (lifecycle && voterId === lifecycle.hostVoterId) {
      if (lifecycle.state === 'active') {
        ctx.cancelHostVacantTask();
      } else if (lifecycle.state === 'host_vacant') {
        setRoomHost(sql, { newHostVoterId: voterId });
        ctx.cancelHostVacantTask();
        const reclaimed: HostReclaimedPayload = { newHostVoterId: voterId, via: 'reconnect' };
        ctx.broadcastEnvelope('HOST_RECLAIMED', reclaimed);
      }
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

/**
 * S7.iii CLAIM_HOST — any connected voter/spectator (D1) can claim while
 * `room.state === 'host_vacant'`. First-valid-wins falls out of the DO's
 * serial processing + the state check: a second claim arriving after the
 * first sees state !== 'host_vacant' and loses; we then send them a
 * HOST_RECLAIMED naming the actual host so their UI converges.
 */
function handleClaimHost(ctx: HandlerCtx): Envelope[] {
  const { sql, envelope, voterId } = ctx;
  if (!voterId) {
    return [makeError('NOT_JOINED', 'JOIN_ROOM first', false, envelope.id)];
  }
  const lifecycle = getRoomLifecycle(sql);
  if (!lifecycle) {
    return [makeError('ROOM_NOT_FOUND', 'Room not found', false, envelope.id)];
  }

  // Lost claim (or never vacant): no transition; tell the claimer who the host
  // actually is so their UI can converge.
  if (lifecycle.state !== 'host_vacant') {
    if (lifecycle.hostVoterId) {
      const reclaimed: HostReclaimedPayload = {
        newHostVoterId: lifecycle.hostVoterId, via: 'claim',
      };
      // Direct to this socket — first-valid-wins races shouldn't blast peers.
      return [makeEnvelope('HOST_RECLAIMED', reclaimed, envelope.id)];
    }
    return [makeError('NOT_VACANT', 'Room is not vacant', false, envelope.id)];
  }

  // D1: voter OR spectator may claim. Connected check via the existing voter row.
  const claimer = getVoterById(sql, voterId);
  if (!claimer) {
    return [makeError('VOTER_NOT_FOUND', 'Voter not found', false, envelope.id)];
  }

  setRoomHost(sql, { newHostVoterId: voterId });
  ctx.markProcessed();
  const reclaimed: HostReclaimedPayload = { newHostVoterId: voterId, via: 'claim' };
  ctx.broadcastEnvelope('HOST_RECLAIMED', reclaimed);
  return [makeEnvelope('HOST_RECLAIMED', reclaimed, envelope.id)];
}

/**
 * S7.iii TRANSFER_HOST — deliberate hand-off from the current host. SI-02:
 * sender must be the bound host. Target must be a participant currently in
 * the room (connection_state !== 'left'). Allowed while `active`; doesn't
 * require vacancy.
 */
function handleTransferHost(ctx: HandlerCtx): Envelope[] {
  const { sql, envelope, voterId } = ctx;
  if (!voterId) {
    return [makeError('NOT_JOINED', 'JOIN_ROOM first', false, envelope.id)];
  }
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];

  if (!isTransferHostPayload(envelope.payload)) {
    return [makeError('BAD_PAYLOAD', 'TRANSFER_HOST payload invalid', false, envelope.id)];
  }
  const target = getVoterById(sql, envelope.payload.newHostVoterId);
  if (!target || target.connectionState === 'left') {
    return [makeError('INVALID_TARGET', 'Target voter is not in the room', false, envelope.id)];
  }
  if (target.id === voterId) {
    return [makeError('INVALID_TARGET', 'You are already the host', false, envelope.id)];
  }

  setRoomHost(sql, { newHostVoterId: target.id });
  ctx.markProcessed();
  const reclaimed: HostReclaimedPayload = { newHostVoterId: target.id, via: 'transfer' };
  ctx.broadcastEnvelope('HOST_RECLAIMED', reclaimed);
  return [makeEnvelope('HOST_RECLAIMED', reclaimed, envelope.id)];
}

/** Build the snapshot with anti-anchoring + scope limit. */
function buildSnapshot(sql: SqlStorage, voterId: string): RoomSnapshot {
  const state = getRoomState(sql);
  const me = state.voters.find((v) => v.id === voterId);
  if (!me) throw new Error('VOTER_NOT_FOUND');
  // AA-1: the host is the only recipient entitled to AI before SHARE_AI.
  // Compare directly to room.hostVoterId (truthy source after claim/transfer);
  // voter.role can lag in edge cases the snapshot serves through.
  const isHost = state.room.hostVoterId !== null && voterId === state.room.hostVoterId;

  const active = state.stories.find((s) => s.state === 'active');
  const revealed = state.stories
    .filter((s) => s.state === 'revealed' || s.state === 'committed')
    .sort((a, b) => (a.revealedAt ?? 0) - (b.revealedAt ?? 0))
    .slice(-REVEALED_HISTORY_LIMIT);

  const snapStories: SnapshotStory[] = [];
  if (active) {
    // Anti-anchoring: active story carries NO votes.
    snapStories.push(withAiProjection(sql, { ...active, votes: [] }, isHost));
  }
  for (const story of revealed) {
    snapStories.push(withAiProjection(
      sql,
      { ...story, votes: state.votes.filter((v) => v.storyId === story.id) },
      isHost,
    ));
  }

  return {
    room: state.room,
    voters: state.voters,
    stories: snapStories,
    you: { voterId, role: me.role as VoterRole },
  };
}

/**
 * AA-1: attach the projected AI suggestion to a story for this recipient,
 * or leave the `ai` key absent. When the projector returns undefined the key
 * is NOT set — a non-host story with AI requested is byte-identical to one
 * where AI was never requested (snapshot capstone test).
 */
function withAiProjection(
  sql: SqlStorage,
  story: SnapshotStory,
  isHost: boolean,
): SnapshotStory {
  const suggestion = getAiSuggestion(sql, story.id);
  const projected = projectAiForRecipient(story.state, suggestion, isHost);
  if (projected === undefined) return story;
  return { ...story, ai: projected };
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

function isSplitStoryPayload(p: unknown): p is SplitStoryPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.storyId !== 'string' || o.storyId.length === 0) return false;
  if (!Array.isArray(o.children)) return false;
  for (const c of o.children) {
    if (!c || typeof c !== 'object') return false;
    const cc = c as Record<string, unknown>;
    if (typeof cc.text !== 'string') return false;
  }
  return true;
}

function isSkipStoryPayload(p: unknown): p is SkipStoryPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.storyId === 'string' && o.storyId.length > 0;
}

function isTransferHostPayload(p: unknown): p is TransferHostPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.newHostVoterId === 'string' && o.newHostVoterId.length > 0;
}
