import type { SqlStorage } from '@cloudflare/workers-types';
import type {
  AuditEventType, DeckType, Room, RoomMode, RoomState, Story, Vote, Voter, VoterRole,
} from '@pointe/shared';
import { SPLIT_MAX_CHILDREN, SPLIT_MIN_CHILDREN } from '@pointe/shared';

/** Worker-internal read result. NOT the protocol snapshot — that's R2. */
export type RoomReadState = { room: Room; voters: Voter[]; stories: Story[]; votes: Vote[] };

// SQLite row shapes (snake_case mirrors of the spec entities).
type RoomRow = { id: string; slug: string; deck: string; custom_deck: string | null; mode: string; async_window: string | null; state: string; host_voter_id: string | null; host_vacant_since: number | null; created_at: number; last_activity_at: number };
type VoterRow = { id: string; display_name: string; role: string; connection_state: string; last_seen_at: number; joined_at: number };
type StoryRow = { id: string; order_index: number; text: string; external_id: string | null; external_url: string | null; description: string | null; state: string; final_estimate: string | null; edited: number; split_parent_id: string | null; created_at: number; opened_at: number | null; revealed_at: number | null; needs_discussion: number };
type VoteRow = { story_id: string; voter_id: string; points: string; confidence: number; submitted_at: number; updated_at: number };

/** Create the singleton room row and insert the host voter. */
export function createRoom(
  sql: SqlStorage,
  params: {
    roomId: string; slug: string; hostVoterId: string; hostDisplayName: string;
    deck: DeckType; mode: RoomMode; customDeck?: string[]; now: number;
  },
): Room {
  if (sql.exec<{ id: string }>('SELECT id FROM room LIMIT 1').toArray().length > 0) {
    throw new Error('ROOM_ALREADY_EXISTS');
  }
  sql.exec(
    `INSERT INTO room (id, slug, deck, custom_deck, mode, async_window, state,
      host_voter_id, host_vacant_since, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'lobby', ?, NULL, ?, ?)`,
    params.roomId, params.slug, params.deck,
    params.customDeck ? JSON.stringify(params.customDeck) : null,
    params.mode, params.hostVoterId, params.now, params.now,
  );
  sql.exec(
    `INSERT INTO voter (id, display_name, role, connection_state, last_seen_at, joined_at)
     VALUES (?, ?, 'host', 'connected', ?, ?)`,
    params.hostVoterId, params.hostDisplayName, params.now, params.now,
  );
  return {
    id: params.roomId,
    slug: params.slug,
    deck: params.deck,
    customDeck: params.customDeck,
    mode: params.mode,
    state: 'lobby',
    hostVoterId: params.hostVoterId,
    createdAt: params.now,
    lastActivityAt: params.now,
  };
}

/** Add a non-host voter to the existing room. */
export function addVoter(
  sql: SqlStorage,
  params: { voterId: string; displayName: string; role?: VoterRole; now: number },
): Voter {
  const roomRow = sql.exec<{ id: string }>('SELECT id FROM room LIMIT 1').toArray()[0];
  if (!roomRow) throw new Error('ROOM_NOT_FOUND');
  const role: VoterRole = params.role ?? 'voter';
  sql.exec(
    `INSERT INTO voter (id, display_name, role, connection_state, last_seen_at, joined_at)
     VALUES (?, ?, ?, 'connected', ?, ?)`,
    params.voterId, params.displayName, role, params.now, params.now,
  );
  return {
    id: params.voterId,
    roomId: roomRow.id,
    displayName: params.displayName,
    role,
    connectionState: 'connected',
    lastSeenAt: params.now,
    joinedAt: params.now,
  };
}

/**
 * JOIN flow: resume an existing voter (if `resumeVoterId` matches), else add a new one.
 * On resume: connection_state → 'connected', last_seen_at updated; existing role/displayName kept.
 * On new: requires `displayName`; throws DISPLAY_NAME_REQUIRED otherwise.
 */
export function resumeOrAddVoter(
  sql: SqlStorage,
  params: {
    voterId: string;
    resumeVoterId?: string;
    displayName?: string;
    role: VoterRole;
    now: number;
  },
): Voter {
  if (params.resumeVoterId) {
    const existing = sql
      .exec<{ id: string; display_name: string; role: string; joined_at: number }>(
        'SELECT id, display_name, role, joined_at FROM voter WHERE id = ?',
        params.resumeVoterId,
      ).toArray()[0];
    if (existing) {
      sql.exec(
        `UPDATE voter SET connection_state = 'connected', last_seen_at = ? WHERE id = ?`,
        params.now, params.resumeVoterId,
      );
      const room = sql.exec<{ id: string }>('SELECT id FROM room LIMIT 1').toArray()[0];
      if (!room) throw new Error('ROOM_NOT_FOUND');
      return {
        id: existing.id, roomId: room.id, displayName: existing.display_name,
        role: existing.role as VoterRole, connectionState: 'connected',
        lastSeenAt: params.now, joinedAt: existing.joined_at,
      };
    }
    // resumeVoterId given but not found → fall through to new voter.
  }
  if (!params.displayName) throw new Error('DISPLAY_NAME_REQUIRED');
  return addVoter(sql, {
    voterId: params.voterId, displayName: params.displayName,
    role: params.role, now: params.now,
  });
}

/** R3.i: focused read for SI-02 host enforcement (avoids loading full state). */
export function getHostVoterId(sql: SqlStorage): string | null {
  const row = sql
    .exec<{ host_voter_id: string | null }>('SELECT host_voter_id FROM room LIMIT 1')
    .toArray()[0];
  return row ? row.host_voter_id : null;
}

/** S7.ii: focused read used by the host_vacant alarm handler. */
export function getRoomLifecycle(sql: SqlStorage): {
  state: Room['state'];
  hostVoterId: string | null;
  hostVacantSince: number | null;
} | null {
  const row = sql
    .exec<{ state: string; host_voter_id: string | null; host_vacant_since: number | null }>(
      'SELECT state, host_voter_id, host_vacant_since FROM room LIMIT 1',
    )
    .toArray()[0];
  if (!row) return null;
  return {
    state: row.state as Room['state'],
    hostVoterId: row.host_voter_id,
    hostVacantSince: row.host_vacant_since,
  };
}

/** S7.ii: flip the room into host_vacant. Caller must have verified preconditions. */
export function markRoomHostVacant(
  sql: SqlStorage,
  params: { vacantSince: number },
): void {
  sql.exec(
    `UPDATE room SET state = 'host_vacant', host_vacant_since = ?`,
    params.vacantSince,
  );
}

/** S7.iii: read voter role + connection_state. Used to gate claim / transfer targets. */
export function getVoterById(
  sql: SqlStorage,
  voterId: string,
): { id: string; role: VoterRole; connectionState: Voter['connectionState'] } | null {
  const row = sql
    .exec<{ id: string; role: string; connection_state: string }>(
      `SELECT id, role, connection_state FROM voter WHERE id = ?`,
      voterId,
    )
    .toArray()[0];
  if (!row) return null;
  return {
    id: row.id,
    role: row.role as VoterRole,
    connectionState: row.connection_state as Voter['connectionState'],
  };
}

/**
 * S7.iii: atomically transition the room to a new host. Enforces the
 * exactly-one-host invariant — previous host (if any) demotes to 'voter',
 * new host promotes to 'host'. Clears host_vacant_since and (if vacant)
 * resets the room to 'active'.
 *
 * Caller has already validated preconditions (vacancy for claim, host
 * authority for transfer, target is a connected participant).
 */
export function setRoomHost(
  sql: SqlStorage,
  params: { newHostVoterId: string },
): void {
  const prev = getHostVoterId(sql);
  if (prev && prev !== params.newHostVoterId) {
    sql.exec(`UPDATE voter SET role = 'voter' WHERE id = ?`, prev);
  }
  sql.exec(`UPDATE voter SET role = 'host' WHERE id = ?`, params.newHostVoterId);
  // S9.iii — when reclaiming out of `host_vacant`, derive the target from
  // room contents. The naïve `host_vacant → active` was correct for sync
  // rooms but wrong for async review-vacancy: a host who left during
  // `review` should return to `review`, not `active`. Derivation:
  //   any active story → 'active'  (a round is in progress; resume it)
  //   else any revealed+needs_discussion → 'review'  (review wasn't done)
  //   else 'active'                  (default; sync queues, empty rooms)
  const target = deriveReclaimRoomState(sql);
  sql.exec(
    `UPDATE room SET host_voter_id = ?, host_vacant_since = NULL,
       state = CASE WHEN state = 'host_vacant' THEN ? ELSE state END`,
    params.newHostVoterId, target,
  );
}

/**
 * S9.iii — derive the room state to return to when a host reclaims out of
 * `host_vacant`. Single source of truth for the reclaim transition; also
 * reused by `maybeReturnToReviewAfterCommit` to keep the rule in one place.
 *
 * The rule is observable, not stored: we look at the stories table. A live
 * round (`active` story) always wins; otherwise pending discuss flags pull
 * us into `review`; otherwise default to `active` (sync rooms; empty queues).
 */
export function deriveReclaimRoomState(sql: SqlStorage): 'active' | 'review' {
  const activeCount = sql.exec<{ c: number }>(
    `SELECT COUNT(*) AS c FROM story WHERE state = 'active'`,
  ).toArray()[0]?.c ?? 0;
  if (activeCount > 0) return 'active';
  const discussCount = sql.exec<{ c: number }>(
    `SELECT COUNT(*) AS c FROM story WHERE state = 'revealed' AND needs_discussion = 1`,
  ).toArray()[0]?.c ?? 0;
  if (discussCount > 0) return 'review';
  return 'active';
}

/**
 * S9.iii — after a COMMIT_STORY succeeds, return the room to `review` IFF
 * we were in `active` (mid live re-vote), no other story is `active`, and
 * at least one discuss story remains. Otherwise leave room state alone.
 * Pure: returns the new state if a transition occurred, else null.
 */
export function maybeReturnToReviewAfterCommit(sql: SqlStorage): RoomState | null {
  const roomRow = sql.exec<{ state: string }>('SELECT state FROM room LIMIT 1').toArray()[0];
  if (!roomRow || roomRow.state !== 'active') return null;
  const stillActive = sql.exec<{ c: number }>(
    `SELECT COUNT(*) AS c FROM story WHERE state = 'active'`,
  ).toArray()[0]?.c ?? 0;
  if (stillActive > 0) return null;
  const stillDiscuss = sql.exec<{ c: number }>(
    `SELECT COUNT(*) AS c FROM story WHERE state = 'revealed' AND needs_discussion = 1`,
  ).toArray()[0]?.c ?? 0;
  if (stillDiscuss === 0) return null;
  sql.exec(`UPDATE room SET state = 'review'`);
  return 'review';
}

/** R2.iv: set a voter's connection_state (no-op if voter missing). */
export function setVoterConnection(
  sql: SqlStorage,
  params: { voterId: string; connectionState: 'connected' | 'reconnecting' | 'left'; now: number },
): void {
  sql.exec(
    'UPDATE voter SET connection_state = ?, last_seen_at = ? WHERE id = ?',
    params.connectionState, params.now, params.voterId,
  );
}

/** Read the full room state for the worker. roomId is populated at read time per spec §6. */
export function getRoomState(sql: SqlStorage): RoomReadState {
  const r = sql.exec<RoomRow>('SELECT * FROM room LIMIT 1').toArray()[0];
  if (!r) throw new Error('ROOM_NOT_FOUND');
  const room: Room = {
    id: r.id,
    slug: r.slug,
    deck: r.deck as DeckType,
    customDeck: r.custom_deck ? (JSON.parse(r.custom_deck) as string[]) : undefined,
    mode: r.mode as RoomMode,
    asyncWindow: r.async_window
      ? (JSON.parse(r.async_window) as { opensAt: number; closesAt: number })
      : undefined,
    state: r.state as Room['state'],
    hostVoterId: r.host_voter_id,
    hostVacantSince: r.host_vacant_since ?? undefined,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
  };
  const voters = sql.exec<VoterRow>('SELECT * FROM voter ORDER BY joined_at ASC').toArray().map((v): Voter => ({
    id: v.id, roomId: room.id, displayName: v.display_name,
    role: v.role as VoterRole,
    connectionState: v.connection_state as Voter['connectionState'],
    lastSeenAt: v.last_seen_at, joinedAt: v.joined_at,
  }));
  const stories = sql.exec<StoryRow>('SELECT * FROM story ORDER BY order_index ASC')
    .toArray().map((s) => mapStoryRow(s, room.id));
  const votes = sql.exec<VoteRow>('SELECT * FROM vote ORDER BY submitted_at ASC').toArray().map((v): Vote => ({
    storyId: v.story_id, voterId: v.voter_id, points: v.points,
    confidence: v.confidence, submittedAt: v.submitted_at, updatedAt: v.updated_at,
  }));
  return { room, voters, stories, votes };
}

function mapStoryRow(s: StoryRow, roomId: string): Story {
  return {
    id: s.id, roomId, orderIndex: s.order_index, text: s.text,
    externalId: s.external_id ?? undefined,
    externalUrl: s.external_url ?? undefined,
    description: s.description ?? undefined,
    state: s.state as Story['state'],
    finalEstimate: s.final_estimate ?? undefined,
    edited: s.edited === 1,
    splitParentId: s.split_parent_id ?? undefined,
    createdAt: s.created_at,
    openedAt: s.opened_at ?? undefined,
    revealedAt: s.revealed_at ?? undefined,
    // S9.i: only emit when truthy — sync-mode revealed stories have it unset,
    // and absence is the wire signal (no async bucket applies).
    ...(s.needs_discussion === 1 ? { needsDiscussion: true } : {}),
  };
}

/** Add a story to the queue with a sparse order index (100, 200, 300…). */
export function addStory(
  sql: SqlStorage,
  params: {
    storyId: string; text: string; externalId?: string; externalUrl?: string;
    description?: string; now: number;
  },
): Story {
  const roomRow = sql.exec<{ id: string }>('SELECT id FROM room LIMIT 1').toArray()[0];
  if (!roomRow) throw new Error('ROOM_NOT_FOUND');
  const maxRow = sql.exec<{ max: number | null }>('SELECT MAX(order_index) AS max FROM story').toArray()[0];
  const orderIndex = (maxRow?.max ?? 0) + 100;
  sql.exec(
    `INSERT INTO story (id, order_index, text, external_id, external_url, description,
      state, final_estimate, edited, split_parent_id, created_at, opened_at, revealed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, 0, NULL, ?, NULL, NULL)`,
    params.storyId, orderIndex, params.text,
    params.externalId ?? null, params.externalUrl ?? null, params.description ?? null,
    params.now,
  );
  return {
    id: params.storyId,
    roomId: roomRow.id,
    orderIndex,
    text: params.text,
    externalId: params.externalId,
    externalUrl: params.externalUrl,
    description: params.description,
    state: 'pending',
    edited: false,
    createdAt: params.now,
  };
}

/** Update story fields. Sets edited=1 only if votes already exist for the story. */
export function editStory(
  sql: SqlStorage,
  params: {
    storyId: string; text?: string; externalId?: string; externalUrl?: string;
    description?: string;
  },
): Story {
  const existing = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0];
  if (!existing) throw new Error('STORY_NOT_FOUND');

  const sets: string[] = [];
  const args: unknown[] = [];
  if (params.text !== undefined) { sets.push('text = ?'); args.push(params.text); }
  if (params.externalId !== undefined) { sets.push('external_id = ?'); args.push(params.externalId); }
  if (params.externalUrl !== undefined) { sets.push('external_url = ?'); args.push(params.externalUrl); }
  if (params.description !== undefined) { sets.push('description = ?'); args.push(params.description); }

  if (sets.length > 0) {
    const votes = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM vote WHERE story_id = ?', params.storyId).toArray()[0];
    if ((votes?.n ?? 0) > 0) sets.push('edited = 1');
    args.push(params.storyId);
    sql.exec(`UPDATE story SET ${sets.join(', ')} WHERE id = ?`, ...args);
  }

  const updated = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0]!;
  const roomId = sql.exec<{ id: string }>('SELECT id FROM room LIMIT 1').toArray()[0]!.id;
  return mapStoryRow(updated, roomId);
}

function mapVoteRow(v: VoteRow): Vote {
  return {
    storyId: v.story_id, voterId: v.voter_id, points: v.points,
    confidence: v.confidence, submittedAt: v.submitted_at, updatedAt: v.updated_at,
  };
}

function getRoomId(sql: SqlStorage): string {
  const r = sql.exec<{ id: string }>('SELECT id FROM room LIMIT 1').toArray()[0];
  if (!r) throw new Error('ROOM_NOT_FOUND');
  return r.id;
}

/**
 * Transition a story to active. State-aware (OQ-010):
 *   pending  → active : first open of a story.
 *   revealed → active : re-open for another round (clears the prior round's
 *                       votes after capturing them for the audit, resets
 *                       revealedAt). The caller (dispatcher) writes the
 *                       audit_event before broadcasting.
 *
 * Only one story may be active at a time (single-active invariant; the
 * "wrong other story is active" rejection covers both paths).
 *
 * Return shape:
 *   - `clearedVotes` is null on a first open; an array (possibly empty for
 *     a zero-vote reveal) on a re-open.
 *   - `prevRevealedAt` carries the previous round's reveal timestamp on
 *     re-open so the audit can record when the round actually closed.
 */
/**
 * S9.i.c2 — open the async voting window. Flips every `pending` story to
 * `active` at once (the reuse-`active` decision; per-story vote machinery is
 * indifferent to count). Stamps `room.async_window` and transitions
 * `room.state` → `'active'`. Returns the activated storyIds + `closesAt` so
 * the dispatcher can arm the close alarm and broadcast the open event.
 *
 * Bypasses `openVoting`'s single-active check by design: that check is the
 * sync-mode product invariant; async mode is many-at-once.
 *
 * Throws:
 *   ROOM_NOT_ASYNC        — mode !== 'async'.
 *   ASYNC_ALREADY_OPENED  — async_window already populated.
 *   NO_PENDING_STORIES    — nothing to activate.
 */
export function openAsyncWindow(
  sql: SqlStorage,
  params: { opensAt: number; closesAt: number },
): { storyIds: string[]; opensAt: number; closesAt: number } {
  const roomRow = sql.exec<{ mode: string; async_window: string | null; state: string }>(
    'SELECT mode, async_window, state FROM room LIMIT 1',
  ).toArray()[0];
  if (!roomRow) throw new Error('ROOM_NOT_FOUND');
  if (roomRow.mode !== 'async') throw new Error('ROOM_NOT_ASYNC');
  if (roomRow.async_window !== null) throw new Error('ASYNC_ALREADY_OPENED');

  const pending = sql.exec<{ id: string }>(
    `SELECT id FROM story WHERE state = 'pending' ORDER BY order_index ASC`,
  ).toArray();
  if (pending.length === 0) throw new Error('NO_PENDING_STORIES');

  sql.exec(
    `UPDATE story SET state = 'active', opened_at = ? WHERE state = 'pending'`,
    params.opensAt,
  );
  sql.exec(
    `UPDATE room SET async_window = ?, state = 'active', last_activity_at = ?`,
    JSON.stringify({ opensAt: params.opensAt, closesAt: params.closesAt }),
    params.opensAt,
  );
  return {
    storyIds: pending.map((p) => p.id),
    opensAt: params.opensAt,
    closesAt: params.closesAt,
  };
}

/**
 * S9.i.c3 — close the async voting window. Reveals every active story
 * (transition → `revealed`, stamp `revealed_at`), computes per-story stats,
 * sets the bucket flag (outlier OR low-confidence → discuss), and
 * transitions the room to `'review'`. Pure side effects in SQL; the close
 * alarm broadcasts the changes.
 *
 * Returns each story's reveal payload so the alarm can pack a single DELTA
 * with `votes_revealed × N` + `async_window_closed`.
 *
 * Idempotent on re-fire (re-running on a room already in `'review'`
 * returns an empty batch — the alarm handler is required to be
 * idempotent; see scheduler.ts).
 */
export function closeAsyncWindow(
  sql: SqlStorage,
  params: { now: number },
): {
  closedAt: number;
  results: { storyId: string; votes: Vote[] }[];
} {
  const roomRow = sql.exec<{ state: string; mode: string }>(
    'SELECT state, mode FROM room LIMIT 1',
  ).toArray()[0];
  if (!roomRow) throw new Error('ROOM_NOT_FOUND');
  // Already-closed → no-op (idempotency contract for alarm handlers).
  if (roomRow.state === 'review' || roomRow.state === 'closing' || roomRow.state === 'archived') {
    return { closedAt: params.now, results: [] };
  }

  const active = sql.exec<{ id: string }>(
    `SELECT id FROM story WHERE state = 'active' ORDER BY order_index ASC`,
  ).toArray();

  const results: { storyId: string; votes: Vote[] }[] = [];
  for (const { id } of active) {
    const votes = sql.exec<VoteRow>(
      'SELECT * FROM vote WHERE story_id = ? ORDER BY submitted_at ASC', id,
    ).toArray().map(mapVoteRow);
    sql.exec(
      `UPDATE story SET state = 'revealed', revealed_at = ? WHERE id = ?`,
      params.now, id,
    );
    results.push({ storyId: id, votes });
  }
  sql.exec(
    `UPDATE room SET state = 'review', last_activity_at = ? WHERE 1`,
    params.now,
  );
  return { closedAt: params.now, results };
}

/**
 * S9.i.c3 — persist the server-truth bucket flag for a story after the
 * close-alarm bucketing decision. Separate from `closeAsyncWindow` so the
 * stats computation (pure) and the persistence (SQL) stay decoupled.
 */
export function setStoryNeedsDiscussion(
  sql: SqlStorage,
  params: { storyId: string; needsDiscussion: boolean },
): void {
  sql.exec(
    `UPDATE story SET needs_discussion = ? WHERE id = ?`,
    params.needsDiscussion ? 1 : 0,
    params.storyId,
  );
}

export function openVoting(
  sql: SqlStorage,
  params: { storyId: string; now: number },
): { story: Story; clearedVotes: Vote[] | null; prevRevealedAt: number | null } {
  const story = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0];
  if (!story) throw new Error('STORY_NOT_FOUND');
  if (story.state !== 'pending' && story.state !== 'revealed') {
    throw new Error('STORY_NOT_OPENABLE');
  }
  const active = sql.exec<{ id: string }>(`SELECT id FROM story WHERE state = 'active' LIMIT 1`).toArray()[0];
  if (active) throw new Error('ANOTHER_STORY_ACTIVE');

  let clearedVotes: Vote[] | null = null;
  let prevRevealedAt: number | null = null;
  if (story.state === 'revealed') {
    clearedVotes = sql
      .exec<VoteRow>('SELECT * FROM vote WHERE story_id = ? ORDER BY submitted_at ASC', params.storyId)
      .toArray()
      .map(mapVoteRow);
    prevRevealedAt = story.revealed_at ?? null;
    sql.exec('DELETE FROM vote WHERE story_id = ?', params.storyId);
  }

  sql.exec(
    `UPDATE story SET state = 'active', opened_at = ?, revealed_at = NULL WHERE id = ?`,
    params.now, params.storyId,
  );
  const updated = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0]!;
  return {
    story: mapStoryRow(updated, getRoomId(sql)),
    clearedVotes,
    prevRevealedAt,
  };
}

/**
 * OQ-010 (and a flagged gap beyond it): the audit_event table has been in the
 * schema since R1 but no handler writes to it today. Re-open is the first
 * writer of record — it preserves the round that's about to be cleared so the
 * "audit log preserves history" promise of OQ-010 holds. Comprehensive audit
 * wiring across all handlers (vote_cast, votes_revealed live, story_committed,
 * voter_joined/left, host_transferred, …) is a separate task.
 */
export function insertAuditEvent(
  sql: SqlStorage,
  params: {
    eventType: AuditEventType;
    actorVoterId: string | null;
    at: number;
    payload: unknown;
  },
): void {
  sql.exec(
    `INSERT INTO audit_event (id, at, actor_voter_id, event_type, payload)
     VALUES (?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    params.at,
    params.actorVoterId,
    params.eventType,
    JSON.stringify(params.payload),
  );
}

/**
 * Cast or re-cast a vote on the currently-active story.
 * On re-cast (same story_id, voter_id), points/confidence/updatedAt change; submittedAt is preserved.
 */
export function castVote(
  sql: SqlStorage,
  params: { storyId: string; voterId: string; points: string; confidence: number; now: number },
): Vote {
  const story = sql.exec<{ state: string }>('SELECT state FROM story WHERE id = ?', params.storyId).toArray()[0];
  if (!story || story.state !== 'active') throw new Error('STORY_NOT_ACTIVE');
  const voter = sql.exec<{ role: string }>('SELECT role FROM voter WHERE id = ?', params.voterId).toArray()[0];
  if (!voter) throw new Error('VOTER_NOT_FOUND');
  if (voter.role === 'spectator') throw new Error('SPECTATOR_CANNOT_VOTE');
  if (!Number.isInteger(params.confidence) || params.confidence < 1 || params.confidence > 5) {
    throw new Error('INVALID_CONFIDENCE');
  }
  sql.exec(
    `INSERT INTO vote (story_id, voter_id, points, confidence, submitted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(story_id, voter_id) DO UPDATE SET
       points = excluded.points,
       confidence = excluded.confidence,
       updated_at = excluded.updated_at`,
    params.storyId, params.voterId, params.points, params.confidence, params.now, params.now,
  );
  const v = sql
    .exec<VoteRow>('SELECT * FROM vote WHERE story_id = ? AND voter_id = ?', params.storyId, params.voterId)
    .toArray()[0]!;
  return mapVoteRow(v);
}

/**
 * Transition an active story to revealed and return the raw votes.
 * Reveal-time statistics are deferred to R3 — OQ-008.
 */
export function revealVotes(
  sql: SqlStorage,
  params: { storyId: string; now: number },
): { story: Story; votes: Vote[] } {
  const story = sql.exec<{ state: string }>('SELECT state FROM story WHERE id = ?', params.storyId).toArray()[0];
  if (!story || story.state !== 'active') throw new Error('STORY_NOT_ACTIVE');
  sql.exec(`UPDATE story SET state = 'revealed', revealed_at = ? WHERE id = ?`, params.now, params.storyId);
  const updated = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0]!;
  const votes = sql
    .exec<VoteRow>('SELECT * FROM vote WHERE story_id = ? ORDER BY submitted_at ASC', params.storyId)
    .toArray()
    .map(mapVoteRow);
  return { story: mapStoryRow(updated, getRoomId(sql)), votes };
}

/**
 * S7 SKIP_STORY: terminal transition. Accepts pending / active / revealed;
 * rejects committed / skipped / split (already terminal).
 *
 * Cheap by design: no vote clear, no audit. Skipping the active story leaves
 * the room with no active story (correct — the host opens the next one).
 */
export function skipStory(sql: SqlStorage, params: { storyId: string }): Story {
  const story = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0];
  if (!story) throw new Error('STORY_NOT_FOUND');
  if (story.state !== 'pending' && story.state !== 'active' && story.state !== 'revealed') {
    throw new Error('STORY_NOT_SKIPPABLE');
  }
  sql.exec(`UPDATE story SET state = 'skipped' WHERE id = ?`, params.storyId);
  const updated = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0]!;
  return mapStoryRow(updated, getRoomId(sql));
}

/**
 * S7 SPLIT_STORY: parent → 'split' terminal; N pending children land in the
 * parent's queue slot, linked via `splitParentId`.
 *
 * Placement (sparse orderIndex, addStory-style):
 *   - Children get integer positions strictly between parent and the next story.
 *   - If the gap is too tight to fit N children with ≥1 spacing, shift the
 *     tail (every order_index >= next) up by enough to make a comfortable
 *     gap (100·(N+1)). One-time, scoped to that point.
 *   - Parent last in queue → children placed at parent + 100·k (no resequence).
 *
 * Atomic: all writes (parent UPDATE + optional tail shift + N INSERTs) run
 * synchronously within one handler tick; the DO storage layer commits them
 * as a single transaction at the next async boundary. The handler awaits
 * nothing between writes.
 *
 * Cheap-by-design (mirrors skip): parent's votes (if active/revealed) stay
 * inert. No clear, no audit.
 */
export function splitStory(
  sql: SqlStorage,
  params: { storyId: string; childTexts: string[]; now: number },
): { parent: Story; children: Story[] } {
  const parentRow = sql
    .exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId)
    .toArray()[0];
  if (!parentRow) throw new Error('STORY_NOT_FOUND');
  if (parentRow.state !== 'pending' && parentRow.state !== 'active' && parentRow.state !== 'revealed') {
    throw new Error('STORY_NOT_SPLITTABLE');
  }
  if (params.childTexts.length < SPLIT_MIN_CHILDREN) throw new Error('TOO_FEW_CHILDREN');
  if (params.childTexts.length > SPLIT_MAX_CHILDREN) throw new Error('TOO_MANY_CHILDREN');
  const cleaned = params.childTexts.map((t) => t.trim());
  if (cleaned.some((t) => t.length === 0)) throw new Error('EMPTY_CHILD_TEXT');

  const N = cleaned.length;
  const P = parentRow.order_index;
  const nextRow = sql
    .exec<{ next: number | null }>(
      `SELECT MIN(order_index) AS next FROM story WHERE order_index > ?`,
      P,
    )
    .toArray()[0];
  const nextOrder = nextRow?.next ?? null;

  let positions: number[];
  if (nextOrder === null) {
    // Parent is last — pad the tail with 100-step children.
    positions = Array.from({ length: N }, (_, i) => P + (i + 1) * 100);
  } else {
    let gap = nextOrder - P;
    if (gap < N + 1) {
      // Tail resequence: shift every story at or after `nextOrder` so the gap
      // can fit N children with ≥1 spacing (comfortably more — 100·(N+1)).
      const shift = 100 * (N + 1) - gap;
      sql.exec(
        `UPDATE story SET order_index = order_index + ? WHERE order_index >= ?`,
        shift, nextOrder,
      );
      gap = 100 * (N + 1);
    }
    const step = Math.floor(gap / (N + 1));
    positions = Array.from({ length: N }, (_, i) => P + step * (i + 1));
  }

  // Parent → split terminal.
  sql.exec(`UPDATE story SET state = 'split' WHERE id = ?`, params.storyId);

  const roomId = getRoomId(sql);
  const children: Story[] = [];
  for (let i = 0; i < N; i++) {
    const childId = crypto.randomUUID();
    sql.exec(
      `INSERT INTO story (id, order_index, text, external_id, external_url, description,
        state, final_estimate, edited, split_parent_id, created_at, opened_at, revealed_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'pending', NULL, 0, ?, ?, NULL, NULL)`,
      childId, positions[i], cleaned[i], params.storyId, params.now,
    );
    const row = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', childId).toArray()[0]!;
    children.push(mapStoryRow(row, roomId));
  }

  const updated = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0]!;
  return {
    parent: mapStoryRow(updated, roomId),
    children,
  };
}

/** Commit a revealed story with the agreed final estimate. */
export function commitStory(
  sql: SqlStorage,
  params: { storyId: string; finalEstimate: string },
): Story {
  const story = sql.exec<{ state: string }>('SELECT state FROM story WHERE id = ?', params.storyId).toArray()[0];
  if (!story || story.state !== 'revealed') throw new Error('STORY_NOT_REVEALED');
  sql.exec(`UPDATE story SET state = 'committed', final_estimate = ? WHERE id = ?`, params.finalEstimate, params.storyId);
  const updated = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0]!;
  return mapStoryRow(updated, getRoomId(sql));
}
