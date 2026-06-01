/**
 * Pointe shared types — six-entity domain model.
 * Replaces the rounds-based v1.1 model. Used by both apps/web and apps/worker.
 *
 * Spec: Doc 2 §5. Slug format amended per OQ-005 (2026-05-28) — words, not base32.
 */

// Enums / unions

export type DeckType = 'fibonacci' | 'modFibonacci' | 'tshirt' | 'powers2' | 'custom';
export type RoomMode = 'sync' | 'async';
export type RoomState = 'lobby' | 'active' | 'host_vacant' | 'closing' | 'archived';
export type StoryState = 'pending' | 'active' | 'revealed' | 'committed' | 'skipped' | 'split';
export type VoterRole = 'voter' | 'spectator' | 'host';
export type ConnectionState = 'connected' | 'reconnecting' | 'left';
export type DimLevel = 'low' | 'medium' | 'high';
export type AISuggestionState = 'pending' | 'ready' | 'failed' | 'unavailable';

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

export type AISuggestion = {
  storyId: string;
  state: AISuggestionState;
  complexity: { level: DimLevel; note: string };
  effort: { level: DimLevel; note: string };
  risk: { level: DimLevel; note: string };
  unknowns: { level: DimLevel; note: string };
  suggestedRange: { low: string; high: string };
  rationale: string;
  errorMessage?: string;
  requestedAt: number;
  completedAt?: number;
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
  | 'SKIP_STORY' | 'OPEN_VOTING' | 'VOTE_CAST' | 'REVEAL_VOTES' | 'COMMIT_STORY'
  | 'REQUEST_AI' | 'RECONNECT_PING' | 'KICK_VOTER' | 'CLOSE_ROOM' | 'TRANSFER_HOST';

export type ServerMessageType =
  | 'SNAPSHOT_RESPONSE' | 'DELTA' | 'REVEAL_BROADCAST' | 'STORY_COMMITTED' | 'ERROR'
  | 'HOST_VACANT' | 'HOST_RECLAIMED' | 'STORY_AI_READY' | 'STORY_AI_FAILED'
  | 'PONG';

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
