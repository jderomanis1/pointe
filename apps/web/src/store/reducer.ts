import type {
  AiSharedPayload, DeltaChange, DeltaPayload, HostReclaimedPayload, HostVacantPayload,
  RoomSnapshot, RevealStats, Story, Vote, Voter,
} from '@pointe/shared';
import { computeRevealStats, resolveDeck } from '@pointe/shared';
import type { RoomStore } from './types';

export const initialState: RoomStore = {
  connection: 'disconnected',
  me: null,
  room: null,
  voters: {},
  stories: [],
  myVotes: {},
  votedPresence: {},
  revealed: {},
  replacedByHostName: null,
};

/**
 * S7.iv replaced-notice detection: did the local user just lose the host role?
 * Returns the new host's display name when true, else null. Used by applySnapshot
 * (reconnect SNAPSHOT showing a different host) and applyHostReclaimed.
 *
 * Robust case: a live reconnect — the host's tab stayed open, the connection
 * blipped, the store still remembers `me === room.hostVoterId`. Full page
 * reloads wipe the store and lose this detection — acceptable graceful
 * degradation per the spec, not worth server-side tracking for v1.
 */
function detectReplacedByHostName(
  state: RoomStore,
  newHostVoterId: string | null,
  newVotersById: Record<string, Voter>,
): string | null {
  const myId = state.me?.voterId ?? null;
  const wasHost = myId !== null && state.room?.hostVoterId === myId;
  if (!wasHost) return null;
  if (newHostVoterId === null || newHostVoterId === myId) return null;
  return newVotersById[newHostVoterId]?.displayName ?? null;
}

/** Hydrate from a SNAPSHOT_RESPONSE (full state on JOIN / reconnect). */
export function applySnapshot(state: RoomStore, snapshot: RoomSnapshot): RoomStore {
  const voters: Record<string, Voter> = {};
  for (const v of snapshot.voters) voters[v.id] = v;

  // Drop the optional `votes` field from SnapshotStory when storing in `stories`.
  const stories: Story[] = snapshot.stories
    .map(({ votes: _votes, ...story }) => story)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  // Seed `revealed` from revealed/committed stories in the snapshot. The snapshot carries
  // votes but not stats (stats are computed at reveal-time on the server, sent in the
  // votes_revealed DELTA, and never persisted). We recompute client-side from the same
  // pure function the worker uses — identical inputs, identical output, no null hole.
  const deck = resolveDeck(snapshot.room.deck, snapshot.room.customDeck);
  const revealed: Record<string, { votes: Vote[]; stats: RevealStats | null }> = {};
  for (const s of snapshot.stories) {
    if ((s.state === 'revealed' || s.state === 'committed') && s.votes) {
      revealed[s.id] = {
        votes: s.votes,
        stats: computeRevealStats(deck, s.votes),
      };
    }
  }

  // S7.iv: if we were the host and the snapshot moves the host elsewhere,
  // remember the new host's name so the UI can quietly say "you were replaced."
  // Carry an existing notice forward if it's still relevant (a second snapshot
  // shouldn't silently clobber a not-yet-dismissed notice).
  const detected = detectReplacedByHostName(state, snapshot.room.hostVoterId, voters);
  const replacedByHostName = detected ?? state.replacedByHostName;

  return {
    ...state,
    me: { voterId: snapshot.you.voterId, role: snapshot.you.role },
    room: snapshot.room,
    voters,
    stories,
    // SNAPSHOT strips active-story foreign votes (R2.iii), so nothing to seed here.
    // myVotes is rebuilt from local-session `vote_value` deltas; votedPresence from `voter_voted`.
    myVotes: {},
    votedPresence: {},
    revealed,
    replacedByHostName,
  };
}

/**
 * S7.iv HOST_VACANT — the server-confirmed vacant transition (alarm-driven).
 * Mirrors the worker's markRoomHostVacant: state → 'host_vacant', stamp
 * hostVacantSince. The roster row of the absent host is unchanged (their
 * role stays 'host' until someone claims).
 */
export function applyHostVacant(state: RoomStore, payload: HostVacantPayload): RoomStore {
  if (!state.room) return state;
  return {
    ...state,
    room: {
      ...state.room,
      state: 'host_vacant',
      hostVacantSince: payload.vacantSince,
    },
  };
}

/**
 * S7.iv HOST_RECLAIMED — a host-change occurred (claim / transfer / reconnect).
 * Mirrors the worker's setRoomHost: swap the room.hostVoterId, demote the
 * prior host to 'voter' and promote the new host to 'host', clear vacancy,
 * and (if vacant) return state to 'active'. Idempotent: re-applying after the
 * swap is a no-op (prior host === new host → no role churn).
 */
export function applyHostReclaimed(
  state: RoomStore, payload: HostReclaimedPayload,
): RoomStore {
  if (!state.room) return state;
  const prevHostId = state.room.hostVoterId;
  const newHostId = payload.newHostVoterId;

  const voters: Record<string, Voter> = { ...state.voters };
  if (prevHostId && prevHostId !== newHostId && voters[prevHostId]) {
    voters[prevHostId] = { ...voters[prevHostId], role: 'voter' };
  }
  if (voters[newHostId]) {
    voters[newHostId] = { ...voters[newHostId], role: 'host' };
  }

  // Update `me` if the local user gained or lost the host role.
  let me = state.me;
  if (me) {
    if (me.voterId === newHostId && me.role !== 'host') {
      me = { ...me, role: 'host' };
    } else if (me.voterId === prevHostId && me.voterId !== newHostId && me.role === 'host') {
      me = { ...me, role: 'voter' };
    }
  }

  const detected = detectReplacedByHostName(state, newHostId, voters);
  const replacedByHostName = detected ?? state.replacedByHostName;

  return {
    ...state,
    me,
    room: {
      ...state.room,
      hostVoterId: newHostId,
      state: state.room.state === 'host_vacant' ? 'active' : state.room.state,
      hostVacantSince: undefined,
    },
    voters,
    replacedByHostName,
  };
}

/**
 * S8.iv.c2 — AI_SHARED arrives at every JOIN-bound socket (S8.ii.c
 * broadcast). The payload carries the ready suggestion with shared:true.
 * For the host this flips the panel from armed-share to shared-readonly;
 * for a voter it populates `story.ai` for the first time so the panel can
 * render. Idempotent: re-applying on an already-shared row is a no-op.
 *
 * Tolerant of stale storyId targets (story split/skipped before the event
 * arrives) — drop silently rather than corrupt state.
 */
export function applyAiShared(state: RoomStore, payload: AiSharedPayload): RoomStore {
  const target = state.stories.find((s) => s.id === payload.storyId);
  if (!target) return state;
  return {
    ...state,
    stories: state.stories.map((s) =>
      s.id === payload.storyId ? { ...s, ai: payload.ai } : s,
    ),
  };
}

/** Pure single-change reducer; exhaustive switch with a `never` default. */
export function applyChange(state: RoomStore, change: DeltaChange): RoomStore {
  switch (change.kind) {
    case 'voter_joined':
      return { ...state, voters: { ...state.voters, [change.voter.id]: change.voter } };

    case 'voter_left': {
      const existing = state.voters[change.voterId];
      if (!existing) return state;
      return {
        ...state,
        voters: {
          ...state.voters,
          [change.voterId]: { ...existing, connectionState: 'left' },
        },
      };
    }

    case 'voter_connection': {
      const existing = state.voters[change.voterId];
      if (!existing) return state;
      return {
        ...state,
        voters: {
          ...state.voters,
          [change.voterId]: { ...existing, connectionState: change.connectionState },
        },
      };
    }

    case 'voter_voted': {
      const next = new Set(state.votedPresence[change.storyId] ?? []);
      next.add(change.voterId);
      return {
        ...state,
        votedPresence: { ...state.votedPresence, [change.storyId]: next },
      };
    }

    case 'vote_value':
      return {
        ...state,
        myVotes: {
          ...state.myVotes,
          [change.storyId]: { points: change.points, confidence: change.confidence },
        },
      };

    case 'story_added': {
      const next = [...state.stories, change.story].sort((a, b) => a.orderIndex - b.orderIndex);
      return { ...state, stories: next };
    }

    case 'story_edited':
      return {
        ...state,
        stories: state.stories.map((s) => (s.id === change.story.id ? change.story : s)),
      };

    case 'voting_opened': {
      // OQ-010: voting_opened can be a re-open of a revealed story; clear the
      // round-1 view so the re-vote starts clean. Idempotent for first-open —
      // the targeted slots would already be empty.
      const { [change.storyId]: _droppedRevealed, ...revealedRest } = state.revealed;
      const { [change.storyId]: _droppedMyVote, ...myVotesRest } = state.myVotes;
      const { [change.storyId]: _droppedPresence, ...presenceRest } = state.votedPresence;
      return {
        ...state,
        // Single-active mirror: any other story currently 'active' is flipped out defensively.
        stories: state.stories.map((s) => {
          if (s.id === change.storyId) return { ...s, state: 'active' };
          if (s.state === 'active') return { ...s, state: 'pending' };
          return s;
        }),
        revealed: revealedRest,
        myVotes: myVotesRest,
        votedPresence: presenceRest,
      };
    }

    case 'votes_revealed':
      return {
        ...state,
        stories: state.stories.map((s) =>
          s.id === change.storyId ? { ...s, state: 'revealed' } : s,
        ),
        revealed: {
          ...state.revealed,
          [change.storyId]: { votes: change.votes, stats: change.stats },
        },
      };

    case 'story_committed':
      return {
        ...state,
        stories: state.stories.map((s) =>
          s.id === change.storyId
            ? { ...s, state: 'committed', finalEstimate: change.finalEstimate }
            : s,
        ),
      };

    case 'story_skipped':
      // Terminal transition. If the skipped story was active, the stage
      // clears automatically (RoomShell focusStory drops it). Votes (if any
      // from an active/revealed skip) stay in `revealed` / `myVotes` —
      // inert, harmless, and a future history view could surface them.
      return {
        ...state,
        stories: state.stories.map((s) =>
          s.id === change.storyId ? { ...s, state: 'skipped' } : s,
        ),
      };

    case 'story_split': {
      // Parent → terminal 'split' (stays visible as context); children land
      // pending. Re-sort by orderIndex so children appear in the parent's slot.
      // If the parent was the focused story, RoomShell drops it from focus
      // (no longer active||revealed) — same exit as skip.
      const withParent = state.stories.map((s) =>
        s.id === change.parentId ? { ...s, state: 'split' as const } : s,
      );
      const next = [...withParent, ...change.children]
        .sort((a, b) => a.orderIndex - b.orderIndex);
      return { ...state, stories: next };
    }

    case 'ai_updated':
      // S8.iii.c1 — only ever arrives on the host's socket (server-side
      // host-only fan-out + projector defense-in-depth). The reducer applies
      // it unconditionally; a voter's store never sees this kind because
      // the server never sends it to them.
      return {
        ...state,
        stories: state.stories.map((s) =>
          s.id === change.storyId ? { ...s, ai: change.ai } : s,
        ),
      };

    default: {
      // Compile-time check: adding a new DeltaChange kind without handling it fails typecheck.
      const _exhaustive: never = change;
      void _exhaustive;
      return state;
    }
  }
}

/** Fold a DELTA payload's changes into the store. */
export function applyDelta(state: RoomStore, payload: DeltaPayload): RoomStore {
  return payload.changes.reduce(applyChange, state);
}
