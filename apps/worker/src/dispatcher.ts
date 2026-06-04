import type { SqlStorage, WebSocket } from '@cloudflare/workers-types';
import type {
  AddStoryPayload, AiSharedPayload, AISuggestion, CommitStoryPayload, DeltaChange,
  EditStoryPayload, Envelope, ErrorPayload, HostReclaimedPayload, JoinRoomPayload,
  OpenAsyncPayload, OpenVotingPayload, RevealVotesPayload, RoomSnapshot,
  ServerMessageType, ShareAiPayload, SkipStoryPayload, SnapshotStory, SplitStoryPayload,
  TransferHostPayload, VoteCastPayload, VoterRole,
} from '@pointe/shared';
import {
  PROTOCOL_VERSION, WINDOW_DURATIONS, computeRevealStats, resolveDeck,
} from '@pointe/shared';
import {
  addStory, castVote, commitStory, editStory, insertAuditEvent, openAsyncWindow,
  openVoting, revealVotes, resumeOrAddVoter, getHostVoterId, getRoomLifecycle, getRoomState,
  getVoterById, setRoomHost, skipStory, splitStory,
} from './operations';
import { getAttachment } from './broadcast';
import {
  checkAiRateLimit, deriveAiCacheKey, getAiCache, getAiSuggestion,
  markAiSuggestionShared, projectAiForRecipient, upsertAiSuggestion,
} from './ai';

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

/** S9.i.c2: fire-and-forget — arm the async-close alarm. The wrapper in
 *  room.ts calls `scheduleTask(storage, 'async_close', closesAt, …)`. Same
 *  fire-and-forget semantics as `cancelHostVacantTask`. */
export type ScheduleAsyncCloseFn = (closesAt: number) => void;

/**
 * S8.ii.b — AI orchestrator. The room.ts wrapper supplies the live
 * implementation (calls requestCeruSuggestion + iterates host sockets).
 *
 * AA-1: every method here is host-only by construction — `sendToHost`
 * iterates `getWebSockets()` filtering by current room.host_voter_id, and
 * `scheduleAiCall` writes to ai_suggestion + ai_cache then calls sendToHost.
 * No voter-visible egress goes through this surface.
 *
 * `available` reflects whether `env.ANTHROPIC_API_KEY` is set. A cache hit
 * can still complete with `available: false` (it's already-paid-for data),
 * but a fresh call cannot.
 */
export type AiOrchestrator = {
  available: boolean;
  sendToHost: <T>(type: ServerMessageType, payload: T) => void;
  scheduleAiCall: (params: {
    storyId: string;
    storyText: string;
    deckValues: string[];
    cacheKey: string;
    requestedAt: number;
  }) => void;
};

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
  /** S8.ii.b: AI orchestrator. Null in tests / when the worker has no AI wiring. */
  aiOrchestrator: AiOrchestrator | null;
  /** S9.i.c2: arm the async_close scheduled task. No-op in tests by default. */
  scheduleAsyncClose: ScheduleAsyncCloseFn;
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
  aiOrchestrator: AiOrchestrator | null = null,
  scheduleAsyncClose: ScheduleAsyncCloseFn = () => {},
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
    aiOrchestrator,
    scheduleAsyncClose,
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
    case 'OPEN_ASYNC':
      return handleOpenAsync(ctx);
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
    case 'REQUEST_AI':
      // Async: returns nothing on accept (host UI is optimistic + the snapshot
      // is AA-1-scoped). We CANNOT return a Promise from `route` because the
      // caller (room.ts) does `for (env of envelopes) ws.send(...)` — so the
      // handler schedules the async work through the orchestrator and exits.
      return handleRequestAi(ctx);
    case 'SHARE_AI':
      return handleShareAi(ctx);
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
 * S9.i.c2 — OPEN_ASYNC (host-only). Arms the async voting window:
 *  • Validates payload (`window: '4h' | '24h' | '3d'`).
 *  • `openAsyncWindow` op flips every pending story → active, stamps
 *    `room.async_window = { opensAt, closesAt }`, transitions
 *    `room.state` → 'active'. Throws ROOM_NOT_ASYNC / ASYNC_ALREADY_OPENED
 *    / NO_PENDING_STORIES if guards fail.
 *  • Arms the close alarm via `ctx.scheduleAsyncClose(closesAt)`. The
 *    scheduler multiplexes — a pending host_vacant alarm is preserved
 *    by `rescheduleAlarm`'s MIN(at) logic; no clobbering.
 *  • Broadcasts an `async_window_opened` change to all sockets so clients
 *    see the queue go active in bulk.
 */
function handleOpenAsync(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isOpenAsyncPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'OPEN_ASYNC payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  const durationMs = WINDOW_DURATIONS[p.window];
  const now = Date.now();
  const closesAt = now + durationMs;
  try {
    const result = openAsyncWindow(ctx.sql, { opensAt: now, closesAt });
    ctx.markProcessed();
    ctx.scheduleAsyncClose(closesAt);
    ctx.broadcast([{
      kind: 'async_window_opened',
      opensAt: now,
      closesAt,
      storyIds: result.storyIds,
    }]);
    return [];
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL';
    return [makeError(code, code, false, ctx.envelope.id)];
  }
}

function isOpenAsyncPayload(p: unknown): p is OpenAsyncPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return o.window === '4h' || o.window === '24h' || o.window === '3d';
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
    // AA-1 edge #2: attach the AI suggestion (any state) so the host's reveal
    // carries it. `projectChangesFor` strips `ai` for non-hosts via
    // `projectAiForRecipient` — voters get a reveal byte-identical to a
    // no-AI reveal. If no suggestion exists, the field is absent entirely.
    const suggestion = getAiSuggestion(ctx.sql, p.storyId);
    const revealChange: Extract<DeltaChange, { kind: 'votes_revealed' }> = suggestion
      ? { kind: 'votes_revealed', storyId: p.storyId, votes, stats, ai: suggestion }
      : { kind: 'votes_revealed', storyId: p.storyId, votes, stats };
    ctx.markProcessed();
    ctx.broadcast([revealChange]);
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

/**
 * S8.ii.b — REQUEST_AI: host opts in to a CERU suggestion for one story.
 *
 * Ordering: host auth → payload validation → orchestrator presence →
 * story exists + state eligible (pending/active — the anti-anchoring
 * window) → existing-suggestion fast paths → cache hit → key availability
 * → rate budget → accept (write `pending`, hand off to async orchestrator).
 *
 * Returns `[]` on accept and on the cache-hit fast path (the orchestrator's
 * sendToHost has already pushed STORY_AI_READY in the hit case). Returns
 * an ERROR envelope on every failure path so the host's request id echoes.
 *
 * AA-1: every notification leaves through `aiOrchestrator.sendToHost` —
 * iterates host sockets only. Nothing voter-visible happens through this
 * handler, by construction (verified by the host-only-addressing test).
 */
function handleRequestAi(ctx: HandlerCtx): Envelope[] {
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isRequestAiPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'REQUEST_AI payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;
  if (!ctx.aiOrchestrator) {
    // No AI wiring in this Worker build / test — same UX as missing key.
    return [makeError('AI_UNAVAILABLE', 'AI is currently unavailable', false, ctx.envelope.id)];
  }

  // Story guard: must exist and be pre-reveal. Reveal closes the AA-1
  // window — we won't generate a suggestion after the team has seen votes.
  const story = ctx.sql
    .exec<{ id: string; text: string; state: string }>(
      `SELECT id, text, state FROM story WHERE id = ?`, p.storyId,
    ).toArray()[0];
  if (!story) {
    return [makeError('STORY_NOT_FOUND', 'Story not found', false, ctx.envelope.id)];
  }
  if (story.state !== 'pending' && story.state !== 'active') {
    return [makeError(
      'STORY_NOT_ELIGIBLE_FOR_AI',
      `AI suggestion not allowed in state '${story.state}'`,
      false, ctx.envelope.id,
    )];
  }

  // Idempotency on existing suggestion.
  const existing = getAiSuggestion(ctx.sql, p.storyId);
  if (existing) {
    if (existing.state === 'pending') {
      // A call is already in flight — silently absorb.
      return [];
    }
    if (existing.state === 'ready') {
      // Re-send notification; no new work, no rate consume.
      ctx.aiOrchestrator.sendToHost('STORY_AI_READY', { storyId: p.storyId });
      // Host-only DELTA carrying the content (S8.iii.c1) — the host store
      // applies `ai_updated` to set `story.ai`. Voters get nothing.
      sendAiUpdatedToHost(ctx, p.storyId, existing);
      return [];
    }
    // existing.state === 'failed' → fall through and try again.
  }

  // Resolve deck for cache key + the eventual API call.
  const roomRow = ctx.sql
    .exec<{ deck: string; custom_deck: string | null }>(
      `SELECT deck, custom_deck FROM room LIMIT 1`,
    ).toArray()[0];
  if (!roomRow) {
    return [makeError('ROOM_NOT_FOUND', 'Room not initialized', false, ctx.envelope.id)];
  }
  const deckValues = resolveDeck(
    roomRow.deck as Parameters<typeof resolveDeck>[0],
    roomRow.custom_deck ? (JSON.parse(roomRow.custom_deck) as string[]) : null,
  );
  const cacheKey = deriveAiCacheKey(story.text, deckValues);
  const now = Date.now();

  // Cache check — hits do NOT consume rate budget.
  const cached = getAiCache(ctx.sql, cacheKey);
  if (cached) {
    upsertAiSuggestion(ctx.sql, {
      storyId: p.storyId,
      state: 'ready',
      payload: cached,
      requestedAt: now,
      completedAt: now,
      shared: false,
    });
    ctx.aiOrchestrator.sendToHost('STORY_AI_READY', { storyId: p.storyId });
    // Host-only DELTA carries the content; voters get nothing.
    sendAiUpdatedToHost(ctx, p.storyId, getAiSuggestion(ctx.sql, p.storyId));
    return [];
  }

  // Missing key → can't call. Surfaced as a direct ERROR so the host UI
  // can disable the affordance until the secret is configured. No rate
  // consumption — we structurally couldn't have made the call.
  if (!ctx.aiOrchestrator.available) {
    return [makeError('AI_UNAVAILABLE', 'AI is currently unavailable', false, ctx.envelope.id)];
  }

  // Rate check (S7 SI-06 shape — increment-then-check, room-scoped hourly).
  const gate = checkAiRateLimit(ctx.sql, { now });
  if (!gate.allowed) {
    const msg = `AI rate limit (${gate.limit}/hour) reached; try again after ${new Date(gate.resetAt).toISOString()}`;
    return [makeError('AI_RATE_LIMITED', msg, true, ctx.envelope.id)];
  }

  // Accept: write pending and hand off. The orchestrator runs the API call
  // off-thread (room.ts keeps the promise alive — the DO is not evicted
  // while a fetch is in flight). Re-read SQL on settle (the S7 cursor
  // lesson: the story may have been revealed/skipped/split meanwhile).
  upsertAiSuggestion(ctx.sql, {
    storyId: p.storyId, state: 'pending', requestedAt: now,
  });
  ctx.aiOrchestrator.scheduleAiCall({
    storyId: p.storyId,
    storyText: story.text,
    deckValues,
    cacheKey,
    requestedAt: now,
  });
  return [];
}

function isRequestAiPayload(p: unknown): p is { storyId: string } {
  return typeof p === 'object' && p !== null
    && typeof (p as { storyId: unknown }).storyId === 'string';
}

/**
 * S8.iii.c1 — host-only DELTA carrying the AI suggestion content. Routed via
 * the orchestrator's `sendToHost('DELTA', ...)` so it lands on host sockets
 * only (the orchestrator filters by live `room.host_voter_id`). Voters get
 * zero on-completion traffic — the AA-1 timing-leak guarantee.
 *
 * No-op when the suggestion is null (defensive — shouldn't happen at the
 * call-sites that invoke this, but never emit a broken delta).
 */
function sendAiUpdatedToHost(
  ctx: HandlerCtx, storyId: string, ai: AISuggestion | null,
): void {
  if (!ctx.aiOrchestrator || !ai) return;
  const change: DeltaChange = { kind: 'ai_updated', storyId, ai };
  ctx.aiOrchestrator.sendToHost('DELTA', { changes: [change] });
}

function isShareAiPayload(p: unknown): p is ShareAiPayload {
  return typeof p === 'object' && p !== null
    && typeof (p as { storyId: unknown }).storyId === 'string'
    && (p as { storyId: string }).storyId.length > 0;
}

/**
 * S8.ii.c — SHARE_AI: host opts to surface the (ready) suggestion to the room.
 *
 * The only sanctioned path that crosses `ai` to a non-host. Guards:
 *   • SI-02 host-only.
 *   • Story must be `revealed` or `committed` — you can't share before reveal
 *     (AA-1 would be defeated; the row's projector also checks this).
 *   • Suggestion must exist and be `ready` (pending / failed / absent are
 *     not shareable by construction).
 *
 * On success: flip `ai_suggestion.shared = 1` (idempotent via
 * `markAiSuggestionShared` — shared_at is set on first transition only) and
 * broadcast `AI_SHARED { storyId, ai }` to every JOIN-bound socket. The
 * suggestion in the broadcast carries `shared: true` so clients can render
 * straight away — snapshots/reconnects stay consistent because the row's
 * `shared` flag is the persistent state and `projectAiForRecipient` lets the
 * suggestion through for non-hosts once it flips.
 *
 * Idempotency: a second SHARE_AI on an already-shared row does NOT flip
 * anything but DOES re-broadcast — covers a missed delivery on the first try
 * (cheap, host-deliberate, and consistent with the request being accepted).
 */
function handleShareAi(ctx: HandlerCtx): Envelope[] {
  if (ctx.alreadyProcessed) return [];
  const auth = requireHost(ctx);
  if (!auth.ok) return [auth.error];
  if (!isShareAiPayload(ctx.envelope.payload)) {
    return [makeError('INVALID_PAYLOAD', 'SHARE_AI payload invalid', false, ctx.envelope.id)];
  }
  const p = ctx.envelope.payload;

  const story = ctx.sql
    .exec<{ id: string; state: string }>(
      `SELECT id, state FROM story WHERE id = ?`, p.storyId,
    ).toArray()[0];
  if (!story) {
    return [makeError('STORY_NOT_FOUND', 'Story not found', false, ctx.envelope.id)];
  }
  if (story.state !== 'revealed' && story.state !== 'committed') {
    return [makeError(
      'AI_NOT_SHAREABLE',
      `Cannot share AI before reveal (story is '${story.state}')`,
      false, ctx.envelope.id,
    )];
  }

  const suggestion = getAiSuggestion(ctx.sql, p.storyId);
  if (!suggestion || suggestion.state !== 'ready') {
    return [makeError(
      'AI_NOT_SHAREABLE',
      `No ready AI suggestion to share (state: ${suggestion?.state ?? 'none'})`,
      false, ctx.envelope.id,
    )];
  }

  markAiSuggestionShared(ctx.sql, { storyId: p.storyId, now: Date.now() });
  ctx.markProcessed();

  // The broadcast carries the ready suggestion with shared=true so receivers
  // can render without a re-snapshot. Re-read after the flip so the payload's
  // `shared` reflects truth (the flip on already-shared is a no-op; on a
  // fresh share, it flips 0→1).
  const post = getAiSuggestion(ctx.sql, p.storyId);
  if (!post || post.state !== 'ready') {
    // Defensive: the row was racing somehow. Fail loud — never leak a stale
    // unshared suggestion through the broadcast.
    return [makeError('AI_NOT_SHAREABLE', 'Suggestion state changed', false, ctx.envelope.id)];
  }
  const aiShared: AISuggestion = { ...post, shared: true };
  const payload: AiSharedPayload = {
    storyId: p.storyId,
    ai: aiShared as Extract<AISuggestion, { state: 'ready' }>,
  };
  ctx.broadcastEnvelope('AI_SHARED', payload);
  return [];
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

  // S9.i: filter, not find. Sync mode has at most one active story (enforced
  // by openVoting's ANOTHER_STORY_ACTIVE check); async mode flips the whole
  // queue active when OPEN_ASYNC arms the window. Vote-hiding is per-story:
  // every active story gets `votes: []`, regardless of count.
  const active = state.stories.filter((s) => s.state === 'active');
  const revealed = state.stories
    .filter((s) => s.state === 'revealed' || s.state === 'committed')
    .sort((a, b) => (a.revealedAt ?? 0) - (b.revealedAt ?? 0))
    .slice(-REVEALED_HISTORY_LIMIT);

  const snapStories: SnapshotStory[] = [];
  for (const story of active) {
    // Anti-anchoring: active stories carry NO votes (each independently).
    snapStories.push(withAiProjection(sql, { ...story, votes: [] }, isHost));
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
