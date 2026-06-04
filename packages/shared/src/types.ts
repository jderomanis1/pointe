/**
 * Pointe shared types — six-entity domain model.
 * Replaces the rounds-based v1.1 model. Used by both apps/web and apps/worker.
 *
 * Spec: Doc 2 §5. Slug format amended per OQ-005 (2026-05-28) — words, not base32.
 */

// Enums / unions

export type DeckType = 'fibonacci' | 'modFibonacci' | 'tshirt' | 'powers2' | 'custom';
export type RoomMode = 'sync' | 'async';
export type RoomState =
  | 'lobby'
  | 'active'
  | 'host_vacant'
  | 'closing'
  | 'archived'
  /** S9.i — async window closed; the room is showing bucketed results
   *  (auto-accepted vs needs-discussion). Set by the async_close alarm. */
  | 'review';
export type StoryState = 'pending' | 'active' | 'revealed' | 'committed' | 'skipped' | 'split';
export type VoterRole = 'voter' | 'spectator' | 'host';
export type ConnectionState = 'connected' | 'reconnecting' | 'left';
export type DimLevel = 'low' | 'medium' | 'high';
export type AISuggestionState = 'pending' | 'ready' | 'failed';

export type AuditEventType =
  | 'room_created'
  | 'story_added'
  | 'story_edited'
  | 'story_reordered'
  | 'story_split'
  | 'voting_opened'
  | 'vote_cast'
  | 'votes_revealed'
  | 'story_committed'
  | 'voter_joined'
  | 'voter_left'
  | 'host_transferred'
  | 'ai_requested'
  | 'ai_completed'
  | 'ai_failed';

// Entities (Doc 2 §5)

export type Room = {
  id: string;
  /**
   * OQ-005 (resolved 2026-05-28): slug is WORDS format, e.g. "apt-sparrow-16".
   * Spec amended from 5-char base32 — memorability / say-aloud beats compactness
   * for shared room links.
   */
  slug: string;
  deck: DeckType;
  /** Only set when deck === 'custom'. */
  customDeck?: string[];
  mode: RoomMode;
  asyncWindow?: { opensAt: number; closesAt: number };
  state: RoomState;
  hostVoterId: string | null;
  /** Set when the host disconnects; cleared on reclaim. */
  hostVacantSince?: number;
  createdAt: number;
  lastActivityAt: number;
};

export type Story = {
  id: string;
  roomId: string;
  /** Sparse ordering — 100, 200, 300… so inserts between siblings need no rewrite. */
  orderIndex: number;
  text: string;
  /** External tracker id, e.g. "PROJ-4821". */
  externalId?: string;
  externalUrl?: string;
  description?: string;
  state: StoryState;
  finalEstimate?: string;
  /** True if the story was changed after any vote was cast on it. */
  edited: boolean;
  splitParentId?: string;
  createdAt: number;
  openedAt?: number;
  revealedAt?: number;
  /**
   * AA-1: when present, the recipient is entitled to see the (possibly partial)
   * AI suggestion for this story. Absence is the signal that AA-1 stripped it
   * — non-host stories MUST omit this key entirely (not null, not present-empty)
   * when there is nothing to expose, so a "AI was requested" story is byte-
   * identical to one where AI was never requested.
   */
  ai?: AISuggestion;
  /**
   * S9.i — async-close bucket. True iff the close alarm tagged the story as
   * "needs discussion" (outlier OR low-confidence, per OQ-016). Absent on
   * sync-mode reveals and on unrevealed stories — only the close alarm sets
   * it. Server-truth: client renders from this, never recomputes.
   */
  needsDiscussion?: boolean;
};

export type Voter = {
  /** Persists across reconnects via cookie. */
  id: string;
  roomId: string;
  displayName: string;
  role: VoterRole;
  connectionState: ConnectionState;
  lastSeenAt: number;
  joinedAt: number;
};

export type Vote = {
  storyId: string;
  voterId: string;
  /** String to handle non-numeric decks: "5", "L", "?", "∞". */
  points: string;
  /** 1–5 integer. */
  confidence: number;
  submittedAt: number;
  updatedAt: number;
  // Logical primary key: (storyId, voterId) — one vote per voter per story.
};

/** One dimension of the CERU breakdown. */
export type AIDim = { level: DimLevel; note: string };

/**
 * Wire shape of an AI suggestion. State-discriminated union so a `ready`
 * suggestion guarantees its full CERU payload to consumers (and S8.iv UI
 * gets exhaustiveness). Bookkeeping fields (storyId, requestedAt,
 * completedAt, sharedAt) live in storage only — they are not part of the
 * recipient-facing contract.
 *
 * `shared` appears only on `ready` (the only state the host may surface
 * after reveal — pending/failed are not shareable by construction).
 */
export type AISuggestion =
  | { state: 'pending' }
  | { state: 'failed'; errorMessage: string }
  | {
      state: 'ready';
      complexity: AIDim;
      effort: AIDim;
      risk: AIDim;
      unknowns: AIDim;
      suggestedRange: { low: string; high: string };
      rationale: string;
      /** Host-gated share flag (S8.iv). False until SHARE_AI lands. */
      shared: boolean;
    };

export type AuditEvent = {
  id: string;
  roomId: string;
  at: number;
  actorVoterId?: string;
  eventType: AuditEventType;
  payload: Record<string, unknown>;
};

// API DTOs (REST surface — see Doc 2 §9)

export type CreateRoomRequest = {
  hostDisplayName: string;
  /** Defaults to 'fibonacci'. */
  deck?: DeckType;
  /** Defaults to 'sync'. */
  mode?: RoomMode;
  /** Required iff `deck === 'custom'`. */
  customDeck?: string[];
};

export type CreateRoomResponse = {
  slug: string;
  /** The host's voterId — also set as the `pointe_session` cookie. */
  voterId: string;
  /** Constructed WebSocket URL. The /ws endpoint itself lands in R2. */
  wsUrl: string;
};

export type GetRoomResponse = {
  state: RoomState;
  deck: DeckType;
};

export type ApiError = { code: string; message: string };

// WebSocket protocol envelope (Doc 2 §8) — used by R2.ii+.

export const PROTOCOL_VERSION = 1;

export type ClientMessageType =
  | 'JOIN_ROOM' | 'ADD_STORY' | 'EDIT_STORY' | 'REORDER_STORY' | 'SPLIT_STORY'
  | 'SKIP_STORY' | 'OPEN_VOTING' | 'OPEN_ASYNC' | 'VOTE_CAST' | 'REVEAL_VOTES'
  | 'COMMIT_STORY' | 'REQUEST_AI' | 'SHARE_AI' | 'RECONNECT_PING'
  | 'KICK_VOTER' | 'CLOSE_ROOM' | 'CLAIM_HOST' | 'TRANSFER_HOST';

export type ServerMessageType =
  | 'SNAPSHOT_RESPONSE' | 'DELTA' | 'REVEAL_BROADCAST' | 'STORY_COMMITTED' | 'ERROR'
  | 'HOST_VACANT' | 'HOST_RECLAIMED' | 'STORY_AI_READY' | 'STORY_AI_FAILED'
  | 'AI_SHARED' | 'PONG';

export type Envelope<T = unknown> = {
  v: number;
  type: ClientMessageType | ServerMessageType;
  /** Client-generated idempotency key. */
  id: string;
  /** Server-authoritative; clients send it but the server overrides. */
  at: number;
  payload: T;
};

export type ErrorPayload = { code: string; message: string; retriable: boolean };

/** S7.ii: host has been absent through the grace window. `vacantSince` is when
 *  they disconnected, confirmed after the 30s grace by the alarm handler. */
export type HostVacantPayload = { vacantSince: number };

/** S7.iii: claim host (no payload). The claimer is identified by SI-01 socket binding. */
export type ClaimHostPayload = Record<string, never>;

/** S7.iii: deliberate host transfer. SI-02: sender must be the current host. */
export type TransferHostPayload = { newHostVoterId: string };

/** S8.ii.b — REQUEST_AI: host opts in to a CERU suggestion for one story. */
export type RequestAiPayload = { storyId: string };

/** S8.ii.b — STORY_AI_READY: host-only notification that the AI suggestion
 *  for `storyId` has settled to `ready`. The host's snapshot now carries
 *  the projected suggestion. AA-1: never delivered to non-hosts. */
export type StoryAiReadyPayload = { storyId: string };

/** S8.ii.b — STORY_AI_FAILED (Fix 06): host-only graceful-failure notice.
 *  Voting is never blocked — failure touches only the ai row + this host
 *  message. AA-1: never delivered to non-hosts. */
export type StoryAiFailedPayload = { storyId: string; errorMessage: string };

/** S8.ii.c — SHARE_AI: host opts to surface the (ready) suggestion to the
 *  room after reveal. The only path that crosses `ai` to a non-host. SI-02
 *  host-only; story must be revealed/committed; suggestion must be ready. */
export type ShareAiPayload = { storyId: string };

/** S8.ii.c — AI_SHARED: server broadcast (to ALL connected sockets) after
 *  a successful SHARE_AI. Carries the ready suggestion so clients can render
 *  it immediately — snapshots/reveals from this point on also project it
 *  via projectAiForRecipient (the row's `shared` flag is the persistent state). */
export type AiSharedPayload = {
  storyId: string;
  ai: Extract<AISuggestion, { state: 'ready' }>;
};

/** S7.iii: a host-change occurred. `via` lets the UI tell the three stories apart. */
export type HostReclaimedPayload = {
  newHostVoterId: string;
  via: 'reconnect' | 'claim' | 'transfer';
};

// JOIN_ROOM + SNAPSHOT_RESPONSE (R2.iii).

export type JoinRoomPayload = {
  /** Informational — the DO already is the room. */
  slug: string;
  /** Required for a NEW voter; ignored on resume. */
  displayName?: string;
  /** From the cookie / prior session. */
  resumeVoterId?: string;
  /** Host is assigned by room creation, not claimed here. */
  role: 'voter' | 'spectator';
};

/** A Story with votes optionally included (revealed/committed only — active is stripped). */
export type SnapshotStory = Story & { votes?: Vote[] };

export type RoomSnapshot = {
  room: Room;
  voters: Voter[];
  stories: SnapshotStory[];
  /** Server-bound identity (SI-01). */
  you: { voterId: string; role: VoterRole };
};

// DELTA broadcast (R2.iv). Per-recipient projection enforces anti-anchoring:
// `voter_voted` is sent to everyone (presence only); `vote_value` only to the caster.

export type RevealStats = {
  /** A real deck card, or null if no numeric votes. */
  median: string | null;
  /** voterIds strictly more than 1 deck position from the median. */
  outliers: string[];
  /** Mean of 1–5 confidence over numeric votes, or null if none. */
  avgConfidence: number | null;
  /** True when avgConfidence is below the low-confidence threshold (Pillar 3). */
  lowConfidence: boolean;
  /** voterIds who voted a non-deck card (`?`, `∞`, etc.) — "needs discussion" flag. */
  nonNumeric: string[];
  numericCount: number;
};

export type DeltaChange =
  | { kind: 'voter_joined'; voter: Voter }
  | { kind: 'voter_left'; voterId: string }
  | { kind: 'voter_connection'; voterId: string; connectionState: ConnectionState }
  | { kind: 'voter_voted'; storyId: string; voterId: string }
  | { kind: 'vote_value'; storyId: string; points: string; confidence: number }
  | { kind: 'story_added'; story: Story }
  | { kind: 'story_edited'; story: Story }
  | { kind: 'voting_opened'; storyId: string }
  | {
      kind: 'votes_revealed';
      storyId: string;
      votes: Vote[];
      stats: RevealStats;
      /**
       * AA-1 (S8.ii.c, edge #2): host-only at reveal time. The dispatcher
       * attaches the source suggestion when one exists; the per-recipient
       * `projectChangesFor` strips it for non-hosts via `projectAiForRecipient`,
       * so a voter's reveal is byte-identical to a reveal of a no-AI story.
       * Absence is the AA-1 signal — present-as-null would still leak.
       */
      ai?: AISuggestion;
      /**
       * S9.i — async-close bucket flag. Set by the close alarm only;
       * undefined on sync reveals (no bucketing in sync mode).
       */
      needsDiscussion?: boolean;
    }
  | { kind: 'story_committed'; storyId: string; finalEstimate: string }
  | { kind: 'story_skipped'; storyId: string }
  | { kind: 'story_split'; parentId: string; children: Story[] }
  /**
   * S9.i.c2 — async voting window opened. All listed stories transition to
   * `active` (without the single-active mirror that `voting_opened` enforces
   * in sync mode). Room transitions to `state='active'`. Broadcast to all.
   */
  | {
      kind: 'async_window_opened';
      opensAt: number;
      closesAt: number;
      storyIds: string[];
    }
  /**
   * S9.i.c3 — async voting window closed (auto-reveal fired). Room transitions
   * to `state='review'`. The per-story `votes_revealed` changes carrying votes +
   * stats + needsDiscussion accompany this in the same DELTA batch.
   */
  | {
      kind: 'async_window_closed';
      closedAt: number;
    }
  /**
   * S8.iii.c1 — host-only AI content delivery.
   *
   * Pending stories are out of snapshot scope, so the snapshot can't deliver
   * a freshly-completed AI suggestion to the host. This change is the push
   * channel: emitted via the AI orchestrator's `sendToHost` after the API
   * call settles (ready or failed) and on the cache-hit / already-ready
   * fast paths. The host reducer sets `story.ai` from it.
   *
   * AA-1: host-only by construction (sent through `sendToHostSockets` which
   * filters by live `room.host_voter_id`). `projectChangesFor` ALSO strips
   * this change for non-hosts as defense-in-depth — should it ever leak
   * into the general broadcast path, the projector drops it.
   */
  | { kind: 'ai_updated'; storyId: string; ai: AISuggestion };

export type DeltaPayload = { changes: DeltaChange[] };

// Story-queue message payloads (R3.i).

export type AddStoryPayload = {
  text: string;
  externalId?: string;
  externalUrl?: string;
  description?: string;
};

export type EditStoryPayload = {
  storyId: string;
  text?: string;
  externalId?: string;
  externalUrl?: string;
  description?: string;
};

export type OpenVotingPayload = { storyId: string };

/**
 * VOTE_CAST payload (R3.ii). Note: NO `voterId` field — attribution comes from the
 * socket binding (SI-01), never from the payload.
 */
export type VoteCastPayload = { storyId: string; points: string; confidence: number };

// REVEAL_VOTES + COMMIT_STORY payloads (R3.iii).

export type RevealVotesPayload = { storyId: string };
export type CommitStoryPayload = { storyId: string; finalEstimate: string };
/** S7 SKIP_STORY — host skips a story (terminal). pending/active/revealed only. */
export type SkipStoryPayload = { storyId: string };

/**
 * S7 SPLIT_STORY — host breaks one story into N children. Parent → 'split'
 * (terminal); children inserted as 'pending' in the parent's queue slot
 * (sparse orderIndex; tail resequence if the gap is too tight).
 *
 * Constraints (server-enforced): MIN_CHILDREN ≤ children.length ≤ MAX_CHILDREN,
 * each `text` trimmed non-empty. Parent must be in a non-terminal state
 * (pending / active / revealed).
 */
export type SplitStoryPayload = {
  storyId: string;
  children: { text: string }[];
};
export const SPLIT_MIN_CHILDREN = 2;
export const SPLIT_MAX_CHILDREN = 8;

// ---- S9.i: async window ----------------------------------------------------

/**
 * Closed set of host-selectable async window durations. Locked decision —
 * voters can't pick custom durations (host control, no fractional units).
 * Map values are milliseconds.
 */
export const WINDOW_DURATIONS = {
  '4h':  4 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d':  3 * 24 * 60 * 60 * 1000,
} as const;

export type AsyncWindowDuration = keyof typeof WINDOW_DURATIONS;

/** S9.i — OPEN_ASYNC: host opens the async voting window on a queue of
 *  pending stories. Host-only (SI-02); rejected if mode !== 'async', window
 *  already open, or no pending stories. */
export type OpenAsyncPayload = { window: AsyncWindowDuration };
