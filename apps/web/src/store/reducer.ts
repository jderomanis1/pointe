import type {
  DeltaChange, DeltaPayload, RoomSnapshot, RevealStats, Story, Vote, Voter,
} from '@pointe/shared';
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
};

/** Hydrate from a SNAPSHOT_RESPONSE (full state on JOIN / reconnect). */
export function applySnapshot(state: RoomStore, snapshot: RoomSnapshot): RoomStore {
  const voters: Record<string, Voter> = {};
  for (const v of snapshot.voters) voters[v.id] = v;

  // Drop the optional `votes` field from SnapshotStory when storing in `stories`.
  const stories: Story[] = snapshot.stories
    .map(({ votes: _votes, ...story }) => story)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  // Seed `revealed` from revealed/committed stories in the snapshot. The snapshot doesn't
  // carry stats — only votes — so stats is null until a REVEAL delta refreshes it.
  const revealed: Record<string, { votes: Vote[]; stats: RevealStats | null }> = {};
  for (const s of snapshot.stories) {
    if ((s.state === 'revealed' || s.state === 'committed') && s.votes) {
      revealed[s.id] = { votes: s.votes, stats: null };
    }
  }

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

    case 'voting_opened':
      // Single-active mirror: any other story currently 'active' is flipped out defensively.
      return {
        ...state,
        stories: state.stories.map((s) => {
          if (s.id === change.storyId) return { ...s, state: 'active' };
          if (s.state === 'active') return { ...s, state: 'pending' };
          return s;
        }),
      };

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
