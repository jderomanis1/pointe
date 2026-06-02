import type { SqlStorage } from '@cloudflare/workers-types';
import type { DeckType, Room, RoomMode, Story, Vote, Voter, VoterRole } from '@pointe/shared';

/** Worker-internal read result. NOT the protocol snapshot — that's R2. */
export type RoomReadState = { room: Room; voters: Voter[]; stories: Story[]; votes: Vote[] };

// SQLite row shapes (snake_case mirrors of the spec entities).
type RoomRow = { id: string; slug: string; deck: string; custom_deck: string | null; mode: string; async_window: string | null; state: string; host_voter_id: string | null; host_vacant_since: number | null; created_at: number; last_activity_at: number };
type VoterRow = { id: string; display_name: string; role: string; connection_state: string; last_seen_at: number; joined_at: number };
type StoryRow = { id: string; order_index: number; text: string; external_id: string | null; external_url: string | null; description: string | null; state: string; final_estimate: string | null; edited: number; split_parent_id: string | null; created_at: number; opened_at: number | null; revealed_at: number | null };
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

/** Transition a pending story to active. Only one story may be active at a time. */
export function openVoting(sql: SqlStorage, params: { storyId: string; now: number }): Story {
  const story = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0];
  if (!story) throw new Error('STORY_NOT_FOUND');
  if (story.state !== 'pending') throw new Error('STORY_NOT_PENDING');
  const active = sql.exec<{ id: string }>(`SELECT id FROM story WHERE state = 'active' LIMIT 1`).toArray()[0];
  if (active) throw new Error('ANOTHER_STORY_ACTIVE');
  sql.exec(`UPDATE story SET state = 'active', opened_at = ? WHERE id = ?`, params.now, params.storyId);
  const updated = sql.exec<StoryRow>('SELECT * FROM story WHERE id = ?', params.storyId).toArray()[0]!;
  return mapStoryRow(updated, getRoomId(sql));
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
