import { describe, it, expect } from 'vitest';
import type {
  DeltaChange, Room, RoomSnapshot, Story, Vote, Voter,
} from '@pointe/shared';
import { applyAiShared, applyChange, applyDelta, applySnapshot, initialState } from '../src/store/reducer';

// ---- helpers ----

function makeVoter(
  id: string,
  role: Voter['role'] = 'voter',
  connectionState: Voter['connectionState'] = 'connected',
): Voter {
  return {
    id, roomId: 'r-1', displayName: `name-${id}`,
    role, connectionState, lastSeenAt: 0, joinedAt: 0,
  };
}

function makeStory(
  id: string,
  orderIndex: number,
  state: Story['state'] = 'pending',
): Story {
  return {
    id, roomId: 'r-1', orderIndex, text: `story-${id}`,
    state, edited: false, createdAt: 0,
  };
}

const ROOM: Room = {
  id: 'r-1', slug: 'apt-sparrow-16', deck: 'fibonacci', mode: 'sync',
  state: 'lobby', hostVoterId: 'host-1', createdAt: 0, lastActivityAt: 0,
};

// ---- applySnapshot ----

describe('applySnapshot', () => {
  it('hydrates me, room, voters (by id), and stories (sorted by orderIndex)', () => {
    const snapshot: RoomSnapshot = {
      room: ROOM,
      voters: [makeVoter('host-1', 'host'), makeVoter('v-a')],
      stories: [makeStory('s-2', 200), makeStory('s-1', 100)],
      you: { voterId: 'v-a', role: 'voter' },
    };
    const state = applySnapshot(initialState, snapshot);
    expect(state.me).toEqual({ voterId: 'v-a', role: 'voter' });
    expect(state.room).toBe(ROOM);
    expect(state.voters['host-1'].role).toBe('host');
    expect(state.voters['v-a']).toBeDefined();
    expect(state.stories.map((s) => s.id)).toEqual(['s-1', 's-2']);
  });

  it('seeds `revealed` from revealed/committed stories carrying votes; stats computed client-side via the shared pure function', () => {
    // Three votes around median 5 on the Fibonacci deck — a recognisable result.
    const votes: Vote[] = [
      { storyId: 's-1', voterId: 'v-a', points: '5', confidence: 4, submittedAt: 0, updatedAt: 0 },
      { storyId: 's-1', voterId: 'v-b', points: '5', confidence: 3, submittedAt: 0, updatedAt: 0 },
      { storyId: 's-1', voterId: 'v-c', points: '8', confidence: 5, submittedAt: 0, updatedAt: 0 },
    ];
    const snapshot: RoomSnapshot = {
      room: ROOM,
      voters: [makeVoter('v-a')],
      stories: [
        { ...makeStory('s-1', 100, 'revealed'), votes },
        makeStory('s-2', 200, 'pending'),
      ],
      you: { voterId: 'v-a', role: 'voter' },
    };
    const state = applySnapshot(initialState, snapshot);
    expect(state.revealed['s-1'].votes).toEqual(votes);
    // The bug-fix: stats is NOT null — it's the computed result of the shared function.
    expect(state.revealed['s-1'].stats).not.toBeNull();
    expect(state.revealed['s-1'].stats?.median).toBe('5');
    expect(state.revealed['s-1'].stats?.numericCount).toBe(3);
    expect(state.revealed['s-1'].stats?.outliers).toEqual([]);
    expect(state.revealed['s-1'].stats?.avgConfidence).toBeCloseTo(4);
    expect(state.revealed['s-1'].stats?.lowConfidence).toBe(false);
    expect(state.revealed['s-2']).toBeUndefined();
    // myVotes / votedPresence start clean — snapshot strips active-story votes.
    expect(state.myVotes).toEqual({});
    expect(state.votedPresence).toEqual({});
  });

  it('revealed story with zero votes hydrates safely (stats with null median, no throw)', () => {
    const snapshot: RoomSnapshot = {
      room: ROOM,
      voters: [makeVoter('v-a')],
      stories: [{ ...makeStory('s-1', 100, 'revealed'), votes: [] }],
      you: { voterId: 'v-a', role: 'voter' },
    };
    const state = applySnapshot(initialState, snapshot);
    expect(state.revealed['s-1'].votes).toEqual([]);
    expect(state.revealed['s-1'].stats).not.toBeNull();
    expect(state.revealed['s-1'].stats?.median).toBeNull();
    expect(state.revealed['s-1'].stats?.numericCount).toBe(0);
    expect(state.revealed['s-1'].stats?.outliers).toEqual([]);
  });
});

// ---- applyChange (per kind) ----

describe('applyChange — voter roster', () => {
  it('voter_joined adds/replaces a voter by id', () => {
    const next = applyChange(initialState, { kind: 'voter_joined', voter: makeVoter('v-a') });
    expect(next.voters['v-a']).toBeDefined();
  });

  it('voter_left marks connectionState=left (keeps them in the roster)', () => {
    const seeded = applyChange(initialState, { kind: 'voter_joined', voter: makeVoter('v-a') });
    const next = applyChange(seeded, { kind: 'voter_left', voterId: 'v-a' });
    expect(next.voters['v-a']).toBeDefined();
    expect(next.voters['v-a'].connectionState).toBe('left');
  });

  it('voter_connection updates the connectionState in place', () => {
    const seeded = applyChange(initialState, { kind: 'voter_joined', voter: makeVoter('v-a') });
    const next = applyChange(seeded, {
      kind: 'voter_connection', voterId: 'v-a', connectionState: 'reconnecting',
    });
    expect(next.voters['v-a'].connectionState).toBe('reconnecting');
  });

  it('voter_left/connection are no-ops for unknown voterIds (defensive)', () => {
    const next = applyChange(initialState, { kind: 'voter_left', voterId: 'nobody' });
    expect(next).toBe(initialState);
  });
});

describe('applyChange — votes (anti-anchoring)', () => {
  it('voter_voted adds presence to `votedPresence` and stores NO value anywhere', () => {
    const next = applyChange(initialState, {
      kind: 'voter_voted', storyId: 's-1', voterId: 'v-a',
    });
    expect(next.votedPresence['s-1'].has('v-a')).toBe(true);
    // No value of any kind was added — only the presence flag.
    expect(next.myVotes).toEqual({});
    expect(next.revealed).toEqual({});
  });

  it('vote_value populates `myVotes` only; peer voter_voted on the same story does NOT', () => {
    const withMine = applyChange(initialState, {
      kind: 'vote_value', storyId: 's-1', points: '8', confidence: 4,
    });
    const withPeer = applyChange(withMine, {
      kind: 'voter_voted', storyId: 's-1', voterId: 'peer',
    });
    expect(withPeer.myVotes['s-1']).toEqual({ points: '8', confidence: 4 });
    expect(withPeer.votedPresence['s-1'].has('peer')).toBe(true);
    // The peer presence change did not invent a myVotes entry for 'peer'.
    expect(Object.keys(withPeer.myVotes)).toEqual(['s-1']);
  });
});

describe('applyChange — story queue', () => {
  it('story_added keeps order by orderIndex', () => {
    const added2 = applyChange(initialState, { kind: 'story_added', story: makeStory('s-2', 200) });
    const added1 = applyChange(added2, { kind: 'story_added', story: makeStory('s-1', 100) });
    expect(added1.stories.map((s) => s.id)).toEqual(['s-1', 's-2']);
  });

  it('story_edited replaces the story by id', () => {
    const seeded = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100) });
    const edited: Story = { ...makeStory('s-1', 100), text: 'new text', edited: true };
    const next = applyChange(seeded, { kind: 'story_edited', story: edited });
    expect(next.stories[0].text).toBe('new text');
    expect(next.stories[0].edited).toBe(true);
  });

  it('voting_opened flips a prior active story OUT of active (single-active mirror)', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100) });
    state = applyChange(state, { kind: 'story_added', story: makeStory('s-2', 200) });
    state = applyChange(state, { kind: 'voting_opened', storyId: 's-1' });
    expect(state.stories.find((s) => s.id === 's-1')?.state).toBe('active');
    state = applyChange(state, { kind: 'voting_opened', storyId: 's-2' });
    expect(state.stories.find((s) => s.id === 's-2')?.state).toBe('active');
    expect(state.stories.find((s) => s.id === 's-1')?.state).not.toBe('active');
  });

  it('story_committed sets state=committed and finalEstimate', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'revealed') });
    state = applyChange(state, { kind: 'story_committed', storyId: 's-1', finalEstimate: '5' });
    const s = state.stories.find((x) => x.id === 's-1');
    expect(s?.state).toBe('committed');
    expect(s?.finalEstimate).toBe('5');
  });
});

describe('applyChange — ai_updated (S8.iii.c1, host-only delivery)', () => {
  const READY = {
    state: 'ready' as const,
    complexity: { level: 'medium' as const, note: 'c' },
    effort: { level: 'low' as const, note: 'e' },
    risk: { level: 'low' as const, note: 'r' },
    unknowns: { level: 'low' as const, note: 'u' },
    suggestedRange: { low: '3', high: '5' },
    rationale: 'because',
    shared: false,
  };

  it('sets story.ai to a ready suggestion', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'active') });
    state = applyChange(state, { kind: 'ai_updated', storyId: 's-1', ai: READY });
    expect(state.stories.find((s) => s.id === 's-1')?.ai).toEqual(READY);
  });

  it('replaces an existing ai with a newer one (e.g. failed → ready on retry)', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'active') });
    state = applyChange(state, {
      kind: 'ai_updated', storyId: 's-1',
      ai: { state: 'failed', errorMessage: 'TIMEOUT' },
    });
    expect(state.stories.find((s) => s.id === 's-1')?.ai).toEqual({ state: 'failed', errorMessage: 'TIMEOUT' });
    state = applyChange(state, { kind: 'ai_updated', storyId: 's-1', ai: READY });
    expect(state.stories.find((s) => s.id === 's-1')?.ai).toEqual(READY);
  });

  it('targets only the matching story; siblings are left intact', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'active') });
    state = applyChange(state, { kind: 'story_added', story: makeStory('s-2', 200, 'pending') });
    state = applyChange(state, { kind: 'ai_updated', storyId: 's-1', ai: READY });
    expect(state.stories.find((s) => s.id === 's-1')?.ai).toEqual(READY);
    expect(state.stories.find((s) => s.id === 's-2')?.ai).toBeUndefined();
  });

  it('unknown storyId is a no-op (idempotent on stale targets)', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'active') });
    state = applyChange(state, { kind: 'ai_updated', storyId: 'nope', ai: READY });
    expect(state.stories.find((s) => s.id === 's-1')?.ai).toBeUndefined();
  });
});

describe('applyChange — votes_revealed (the inversion)', () => {
  it('sets revealed[storyId] with votes+stats and flips story to revealed', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'active') });
    const votes: Vote[] = [
      { storyId: 's-1', voterId: 'a', points: '5', confidence: 4, submittedAt: 0, updatedAt: 0 },
      { storyId: 's-1', voterId: 'b', points: '8', confidence: 3, submittedAt: 0, updatedAt: 0 },
    ];
    state = applyChange(state, {
      kind: 'votes_revealed',
      storyId: 's-1',
      votes,
      stats: { median: '5', outliers: [], avgConfidence: 3.5, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    });
    expect(state.stories[0].state).toBe('revealed');
    expect(state.revealed['s-1'].votes).toEqual(votes);
    expect(state.revealed['s-1'].stats?.median).toBe('5');
  });
});

// ---- the leak test (client-state mirror of R3.ii) ----

describe('ANTI-ANCHORING STATE INVARIANT', () => {
  it('after my vote + several peers voting, state holds presence + my value, but ZERO peer values', () => {
    // Distinctive peer-secret markers chosen to NOT collide with my own values, the IDs,
    // or any structural number elsewhere in state.
    const peerSecretPointsA = 'XPEER-A-POINTS';
    const peerSecretPointsB = 'XPEER-B-POINTS';
    const peerSecretConfidenceJson = '"confidence":99';

    let state = applySnapshot(initialState, {
      room: ROOM,
      voters: [makeVoter('me'), makeVoter('peer-A'), makeVoter('peer-B')],
      stories: [],
      you: { voterId: 'me', role: 'voter' },
    });
    state = applyChange(state, { kind: 'story_added', story: makeStory('s-1', 100) });
    state = applyChange(state, { kind: 'voting_opened', storyId: 's-1' });

    // I cast my own vote — the wire would send vote_value to me only.
    state = applyChange(state, { kind: 'vote_value', storyId: 's-1', points: '5', confidence: 4 });
    // Peers vote — the wire sends ONLY voter_voted (presence, no value).
    state = applyChange(state, { kind: 'voter_voted', storyId: 's-1', voterId: 'me' });
    state = applyChange(state, { kind: 'voter_voted', storyId: 's-1', voterId: 'peer-A' });
    state = applyChange(state, { kind: 'voter_voted', storyId: 's-1', voterId: 'peer-B' });

    // What the UI can show:
    expect(state.myVotes['s-1']).toEqual({ points: '5', confidence: 4 });
    expect(state.votedPresence['s-1'].has('peer-A')).toBe(true);
    expect(state.votedPresence['s-1'].has('peer-B')).toBe(true);
    expect(state.revealed['s-1']).toBeUndefined(); // pre-reveal: no peer values stored

    // Schema-level guarantee: the only place non-self values COULD live is `revealed[*]`,
    // and that's empty. Serialise the whole state and assert no peer-value marker appears.
    const serialised = JSON.stringify(state, (_k, v) => (v instanceof Set ? [...v] : v));
    expect(serialised).not.toContain(peerSecretPointsA);
    expect(serialised).not.toContain(peerSecretPointsB);
    expect(serialised).not.toContain(peerSecretConfidenceJson);
    // Sanity: my own value IS present.
    expect(serialised).toContain('"points":"5"');
    expect(serialised).toContain('"confidence":4');
  });

  it('after votes_revealed, peer values appear correctly (the deliberate inversion)', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'active') });
    state = applyChange(state, {
      kind: 'votes_revealed',
      storyId: 's-1',
      votes: [
        { storyId: 's-1', voterId: 'me', points: '5', confidence: 4, submittedAt: 0, updatedAt: 0 },
        { storyId: 's-1', voterId: 'peer-A', points: '13', confidence: 5, submittedAt: 0, updatedAt: 0 },
      ],
      stats: { median: '8', outliers: [], avgConfidence: 4.5, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    });
    // After reveal, the peer's value IS in state — that's the inversion.
    expect(state.revealed['s-1'].votes.find((v) => v.voterId === 'peer-A')?.points).toBe('13');
  });
});

// ---- applyDelta ----

describe('applyDelta', () => {
  it('folds multiple changes left-to-right', () => {
    const changes: DeltaChange[] = [
      { kind: 'voter_joined', voter: makeVoter('v-a') },
      { kind: 'voter_joined', voter: makeVoter('v-b') },
      { kind: 'voter_left', voterId: 'v-a' },
    ];
    const state = applyDelta(initialState, { changes });
    expect(state.voters['v-a'].connectionState).toBe('left');
    expect(state.voters['v-b'].connectionState).toBe('connected');
  });
});

describe('applyAiShared — S8.iv.c2 (the host-deliberate voter exposure)', () => {
  const READY_SHARED = {
    state: 'ready' as const,
    complexity: { level: 'medium' as const, note: 'c' },
    effort: { level: 'low' as const, note: 'e' },
    risk: { level: 'low' as const, note: 'r' },
    unknowns: { level: 'low' as const, note: 'u' },
    suggestedRange: { low: '3', high: '5' },
    rationale: 'because',
    shared: true,
  };

  it('voter view: a story with no story.ai gets it populated (the first time voter sees the suggestion)', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'revealed') });
    expect(state.stories[0].ai).toBeUndefined();
    state = applyAiShared(state, { storyId: 's-1', ai: READY_SHARED });
    expect(state.stories[0].ai).toEqual(READY_SHARED);
    if (state.stories[0].ai!.state !== 'ready') throw new Error('expected ready');
    expect(state.stories[0].ai.shared).toBe(true);
  });

  it('host view: a story with an unshared ready ai gets the shared flag flipped (post-share readonly)', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'revealed') });
    state = applyChange(state, {
      kind: 'ai_updated', storyId: 's-1',
      ai: { ...READY_SHARED, shared: false },
    });
    expect((state.stories[0].ai as { shared: boolean }).shared).toBe(false);
    state = applyAiShared(state, { storyId: 's-1', ai: READY_SHARED });
    expect((state.stories[0].ai as { shared: boolean }).shared).toBe(true);
  });

  it('targets only the matching story; siblings are unchanged', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'revealed') });
    state = applyChange(state, { kind: 'story_added', story: makeStory('s-2', 200, 'pending') });
    state = applyAiShared(state, { storyId: 's-1', ai: READY_SHARED });
    expect(state.stories.find((s) => s.id === 's-1')?.ai).toEqual(READY_SHARED);
    expect(state.stories.find((s) => s.id === 's-2')?.ai).toBeUndefined();
  });

  it('unknown storyId is a silent no-op (story may have split/skipped after the event was queued)', () => {
    let state = applyChange(initialState, { kind: 'story_added', story: makeStory('s-1', 100, 'revealed') });
    const before = state;
    state = applyAiShared(state, { storyId: 'gone', ai: READY_SHARED });
    expect(state).toBe(before); // identity preserved → React shallow-equal short-circuit OK
  });
});
