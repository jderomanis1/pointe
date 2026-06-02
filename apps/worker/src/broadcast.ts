import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type {
  DeltaChange, DeltaPayload, Envelope, ServerMessageType, VoterRole,
} from '@pointe/shared';
import { PROTOCOL_VERSION } from '@pointe/shared';

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
 * `vote_value` is the only caster-filtered kind (anti-anchoring on the active story);
 * all other kinds are explicitly public and pass through unchanged for every viewer.
 * Pre-reveal active-story values reach the caster only; `votes_revealed` (the controlled
 * inversion at reveal time) reaches everyone — that's intentional, not a leak.
 */
export function projectChangesFor(
  viewerVoterId: string | null,
  changes: DeltaChange[],
): DeltaChange[] {
  return changes.filter((change): boolean => {
    switch (change.kind) {
      // Caster-only — drop for non-casters. The caster is identified by the paired
      // `voter_voted` on the same storyId in the same batch.
      case 'vote_value': {
        const paired = changes.find(
          (c): c is Extract<DeltaChange, { kind: 'voter_voted' }> =>
            c.kind === 'voter_voted' && c.storyId === change.storyId,
        );
        if (!paired) return false;
        return paired.voterId === viewerVoterId;
      }
      // Public — pass through for every viewer.
      case 'voter_joined':
      case 'voter_left':
      case 'voter_connection':
      case 'voter_voted':
      case 'story_added':
      case 'story_edited':
      case 'voting_opened':
      case 'votes_revealed':
      case 'story_committed':
      case 'story_skipped':
        return true;
      default: {
        // Unknown future kind — drop defensively so accidental new payloads can't auto-leak.
        const _exhaustive: never = change;
        void _exhaustive;
        return false;
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
  opts?: { excludeWs?: WebSocket },
): void {
  const sockets = ctx.getWebSockets();
  for (const sock of sockets) {
    if (opts?.excludeWs === sock) continue;
    const att = getAttachment(sock);
    if (!att) continue;
    const projected = projectChangesFor(att.voterId, changes);
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
