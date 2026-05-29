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
