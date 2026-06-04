import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type {
  DeltaChange, DeltaPayload, Envelope, ServerMessageType, VoterRole,
} from '@pointe/shared';
import { PROTOCOL_VERSION } from '@pointe/shared';
import { projectAiForRecipient } from './ai';

/** SI-01 binding shape stored via `ws.serializeAttachment`. */
export type SocketAttachment = { voterId: string; role: VoterRole };

/** Pull the binding off a socket, or null if not yet JOINed. */
export function getAttachment(ws: WebSocket): SocketAttachment | null {
  try {
    const att = ws.deserializeAttachment();
    if (
      att &&
      typeof att === 'object' &&
      'voterId' in att &&
      'role' in att &&
      typeof (att as { voterId: unknown }).voterId === 'string'
    ) {
      const a = att as { voterId: string; role: unknown };
      if (a.role === 'voter' || a.role === 'spectator' || a.role === 'host') {
        return { voterId: a.voterId, role: a.role };
      }
    }
  } catch {
    /* not bound yet */
  }
  return null;
}

/**
 * Pure projection: per-recipient anti-anchoring filter.
 *
 * `vote_value` is the only caster-filtered kind (anti-anchoring on the active story);
 * most other kinds are explicitly public and pass through unchanged. Pre-reveal
 * active-story values reach the caster only; `votes_revealed` (the controlled
 * inversion at reveal time) reaches everyone for its votes/stats — but its
 * optional `ai` field is HOST-ONLY at reveal (AA-1 edge #2, S8.ii.c). The
 * projector strips `ai` for non-hosts via `projectAiForRecipient`, so a voter's
 * reveal of an AI-requested-but-unshared story is byte-identical to a reveal of
 * a story that never had AI.
 *
 * `hostVoterId` is the live `room.host_voter_id` at broadcast time (resolved
 * fresh per call by the caller — survives transfer). A null `hostVoterId`
 * (transient host-vacant) means no recipient is host, so any `ai` on a
 * `votes_revealed` is stripped for everyone.
 */
export function projectChangesFor(
  viewerVoterId: string | null,
  hostVoterId: string | null,
  changes: DeltaChange[],
): DeltaChange[] {
  const isHost = viewerVoterId !== null && hostVoterId !== null && viewerVoterId === hostVoterId;
  return changes.flatMap((change): DeltaChange[] => {
    switch (change.kind) {
      // Caster-only — drop for non-casters. The caster is identified by the paired
      // `voter_voted` on the same storyId in the same batch.
      case 'vote_value': {
        const paired = changes.find(
          (c): c is Extract<DeltaChange, { kind: 'voter_voted' }> =>
            c.kind === 'voter_voted' && c.storyId === change.storyId,
        );
        if (!paired) return [];
        return paired.voterId === viewerVoterId ? [change] : [];
      }
      // Reveal: votes + stats are public; the optional `ai` is host-only at
      // reveal time (`shared` is always false here — SHARE_AI is the only
      // path that crosses ai to a non-host, and that goes via AI_SHARED, not
      // via this change). When projector returns undefined we DELETE the key
      // entirely; not null, not present-empty.
      case 'votes_revealed': {
        if (change.ai === undefined) return [change];
        const projected = projectAiForRecipient('revealed', change.ai, isHost);
        if (projected === undefined) {
          const { ai: _omit, ...rest } = change;
          return [rest];
        }
        return projected === change.ai ? [change] : [{ ...change, ai: projected }];
      }
      // Host-only by design (S8.iii.c1). This change is delivered through
      // `sendToHostSockets` (which targets only the live host), so it should
      // never reach this projector via the public broadcast path. Defense
      // in depth: if it ever does, strip it for non-hosts so the AI content
      // can't leak via a stray broadcast.
      case 'ai_updated':
        return isHost ? [change] : [];
      // Public — pass through for every viewer.
      case 'voter_joined':
      case 'voter_left':
      case 'voter_connection':
      case 'voter_voted':
      case 'story_added':
      case 'story_edited':
      case 'voting_opened':
      case 'story_committed':
      case 'story_skipped':
      case 'story_split':
        return [change];
      // S9.i — async lifecycle is public by design (the window opens and
      // closes for everyone in the room; voters need to know).
      case 'async_window_opened':
      case 'async_window_closed':
        return [change];
      // S9.iii — review/active room transitions are public too.
      case 'room_state_changed':
        return [change];
      default: {
        // Unknown future kind — drop defensively so accidental new payloads can't auto-leak.
        const _exhaustive: never = change;
        void _exhaustive;
        return [];
      }
    }
  });
}

/**
 * Fan out per-recipient projected DELTAs to all peers with an attachment.
 * `ctx.getWebSockets()` is called fresh — no cached connection array (hibernation safe).
 * `opts.excludeWs` skips the sender (e.g. the joining socket).
 * DELTA ids are minted fresh; this is an unsolicited server message, not a reply.
 */
/**
 * Fan out a single non-DELTA server message (HOST_VACANT, HOST_RECLAIMED, …)
 * to every JOIN-bound socket. Same hibernation discipline as `broadcast`:
 * fresh `getWebSockets()`, no caching. No per-recipient projection — these
 * lifecycle messages are public by design.
 */
export function broadcastEnvelope<T>(
  ctx: DurableObjectState,
  type: ServerMessageType,
  payload: T,
  opts?: { excludeWs?: WebSocket },
): void {
  const sockets = ctx.getWebSockets();
  if (sockets.length === 0) return;
  const env: Envelope<T> = {
    v: PROTOCOL_VERSION,
    type,
    id: crypto.randomUUID(),
    at: Date.now(),
    payload,
  };
  const raw = JSON.stringify(env);
  for (const sock of sockets) {
    if (opts?.excludeWs === sock) continue;
    if (!getAttachment(sock)) continue;
    try {
      sock.send(raw);
    } catch {
      /* socket gone; skip */
    }
  }
}

export function broadcast(
  ctx: DurableObjectState,
  changes: DeltaChange[],
  hostVoterId: string | null,
  opts?: { excludeWs?: WebSocket },
): void {
  const sockets = ctx.getWebSockets();
  for (const sock of sockets) {
    if (opts?.excludeWs === sock) continue;
    const att = getAttachment(sock);
    if (!att) continue;
    const projected = projectChangesFor(att.voterId, hostVoterId, changes);
    if (projected.length === 0) continue;
    const env: Envelope<DeltaPayload> = {
      v: PROTOCOL_VERSION,
      type: 'DELTA',
      id: crypto.randomUUID(),
      at: Date.now(),
      payload: { changes: projected },
    };
    try {
      sock.send(JSON.stringify(env));
    } catch {
      /* socket gone; skip */
    }
  }
}
