import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { DeltaChange, DeltaPayload, Envelope, VoterRole } from '@pointe/shared';
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
 * `voter_voted` is presence — included for everyone.
 * `vote_value` is the casted value — included only when the viewer IS the caster.
 * The caster is identified by the paired `voter_voted` on the same storyId in the same batch.
 */
export function projectChangesFor(
  viewerVoterId: string | null,
  changes: DeltaChange[],
): DeltaChange[] {
  return changes.filter((change) => {
    if (change.kind !== 'vote_value') return true;
    const paired = changes.find(
      (c): c is Extract<DeltaChange, { kind: 'voter_voted' }> =>
        c.kind === 'voter_voted' && c.storyId === change.storyId,
    );
    if (!paired) return false;
    return paired.voterId === viewerVoterId;
  });
}

/**
 * Fan out per-recipient projected DELTAs to all peers with an attachment.
 * `ctx.getWebSockets()` is called fresh — no cached connection array (hibernation safe).
 * `opts.excludeWs` skips the sender (e.g. the joining socket).
 * DELTA ids are minted fresh; this is an unsolicited server message, not a reply.
 */
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
