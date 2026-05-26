/**
 * Pointe shared types — Data model from Phase 1 Data Model v1.1.
 * Used by both apps/web and apps/worker.
 */

/** Unique room identifier (slug format, e.g. swift-deer-42). */
export type RoomId = string;

/** Unique user identifier (session-scoped, persisted via cookie). */
export type RoomUserId = string;

/** Lifecycle phase of a room. */
export type RoomPhase = 'voting' | 'revealed' | 'closed';

/** Estimation scale used by the room. */
export type ScaleType = 'fibonacci' | 'tshirt' | 'powers-of-two';

/** Confidence level paired with each vote. */
export type Confidence = 'low' | 'medium' | 'high';

/** A user participating in a room. */
export interface RoomUser {
  id: RoomUserId;
  displayName: string;
  /** Unix milliseconds when the user joined. */
  joinedAt: number;
  /** True for the first user who created the room. */
  isHost: boolean;
  /** Observers can watch but not vote. */
  isObserver: boolean;
}

/** A single vote cast by a user in a round. */
export interface Vote {
  userId: RoomUserId;
  /** Vote value as a string: "1", "2", "3", "5", "8", "13", "?", "infinity". */
  value: string;
  confidence: Confidence;
  /** CERU reasoning committed by the voter before reveal. */
  reasoning?: string;
  /** Unix milliseconds when the vote was submitted. */
  submittedAt: number;
}

/** A completed round of estimation. */
export interface RoundResult {
  /** The story or topic being estimated, if provided. */
  topic?: string;
  votes: Vote[];
  /** The agreed-upon consensus value, if the round closed with consensus. */
  consensusValue?: string;
  /** Unix milliseconds when the round was finalized. */
  agreedAt: number;
}

/** The full state of a room. */
export interface Room {
  id: RoomId;
  /** Unix milliseconds when the room was created. */
  createdAt: number;
  hostUserId: RoomUserId;
  phase: RoomPhase;
  /** Current story or topic being estimated. */
  topic?: string;
  scaleType: ScaleType;
  users: RoomUser[];
  /** Votes from the current not-yet-revealed round. */
  votes: Vote[];
  /** Completed rounds in chronological order. */
  history: RoundResult[];
}

/** Request body for POST /api/rooms. */
export interface CreateRoomRequest {
  hostDisplayName: string;
  scaleType?: ScaleType;
  topic?: string;
}

/** Response body for POST /api/rooms. */
export interface CreateRoomResponse {
  room: Room;
  /** Session token for the host user, set as HttpOnly cookie. */
  sessionToken: string;
}

/** Response body for GET /api/rooms/:slug. */
export interface GetRoomResponse {
  room: Room;
}

/** Standard error response shape. */
export interface ApiError {
  error: string;
  /** Machine-readable error code. */
  code: string;
  /** Optional details for debugging. */
  details?: Record<string, unknown>;
}
