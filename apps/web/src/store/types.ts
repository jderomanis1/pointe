import type { RevealStats, Room, Story, Vote, Voter, VoterRole } from '@pointe/shared';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * Client-side view-model. The three-way vote split is the anti-anchoring guarantee in state form:
 *   - `myVotes`        — only the local user's own votes (echoed via `vote_value`).
 *   - `votedPresence`  — who has voted, NO values. The state shape physically cannot hold a peer's points.
 *   - `revealed`       — full votes + stats, populated only after a REVEAL.
 * Before reveal there is no field anywhere in this shape that could hold another voter's value.
 */
export type RoomStore = {
  connection: ConnectionStatus;
  /** Server-bound identity from SNAPSHOT.you (SI-01). Null before JOIN. */
  me: { voterId: string; role: VoterRole } | null;
  room: Room | null;
  voters: Record<string, Voter>;
  stories: Story[];
  myVotes: Record<string, { points: string; confidence: number }>;
  votedPresence: Record<string, Set<string>>;
  /** Stats may be null when seeded from a SNAPSHOT (the snapshot doesn't carry stats — only votes). */
  revealed: Record<string, { votes: Vote[]; stats: RevealStats | null }>;
  /**
   * S7.iv: a quiet "you were replaced" notice that fires only when the local
   * user WAS the host and the host moved away (via a HOST_RECLAIMED with via
   * 'claim'/'transfer', or a reconnect SNAPSHOT showing a different host).
   * The string is the new host's display name. Null when nothing to show.
   * Degrades gracefully on a full page reload (store wiped → no false notice).
   */
  replacedByHostName: string | null;
};
