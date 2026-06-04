// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Room, RoomSnapshot, Story, Vote, Voter } from '@pointe/shared';
import { RoomShell } from '../src/components/room/RoomShell';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';
import { useRoomStore } from '../src/store/roomStore';
import { initialState } from '../src/store/reducer';

const SLUG = 'apt-sparrow-16';
const HOST_ID = 'host-1';
const V1 = 'v-1';
const V2 = 'v-2';
const V3 = 'v-3';

function room(state: 'lobby' | 'active' | 'review' = 'review'): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'async',
    state, hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function rs(id: string, text: string, needsDiscussion = false): Story {
  return {
    id, roomId: 'r-1', orderIndex: 100, text, state: 'revealed',
    edited: false, createdAt: 0, revealedAt: 0,
    ...(needsDiscussion ? { needsDiscussion: true } : {}),
  };
}
function v(storyId: string, voterId: string, points: string, confidence: number): Vote {
  return { storyId, voterId, points, confidence, submittedAt: 0, updatedAt: 0 };
}

function seedReview(opts: {
  meVoterId: string;
  myVotes?: Record<string, { points: string; confidence: number }>;
  stories: Array<{ id: string; text: string; needsDiscussion: boolean; votes: { voterId: string; points: string; confidence: number }[] }>;
}) {
  const voters: Voter[] = [
    voter(HOST_ID, 'Alice', 'host'),
    voter(V1, 'Ben'),
    voter(V2, 'Cleo'),
    voter(V3, 'Dax'),
  ];
  const stories: (Story & { votes?: Vote[] })[] = opts.stories.map((s, i) => ({
    ...rs(s.id, s.text, s.needsDiscussion),
    orderIndex: (i + 1) * 100,
    revealedAt: 100 + i,
    votes: s.votes.map((vt) => v(s.id, vt.voterId, vt.points, vt.confidence)),
  }));
  const snap: RoomSnapshot = {
    room: room('review'),
    voters,
    stories,
    you: { voterId: opts.meVoterId, role: 'voter' },
  };
  useRoomStore.setState(initialState);
  useRoomStore.getState().hydrate(snap);
  useRoomStore.getState().setConnection('connected');
  // myVotes is rebuilt from `vote_value` deltas; for a voter who voted
  // pre-close, simulate the echo here.
  if (opts.myVotes) {
    for (const [storyId, mv] of Object.entries(opts.myVotes)) {
      useRoomStore.getState().applyServerDelta({
        changes: [{ kind: 'vote_value', storyId, points: mv.points, confidence: mv.confidence }],
      });
    }
  }
}

function renderShell(send = vi.fn()) {
  render(
    <MemoryRouter>
      <RoomClientProvider send={send}>
        <RoomShell slug={SLUG} />
      </RoomClientProvider>
    </MemoryRouter>,
  );
  return send;
}

beforeEach(() => {
  useRoomStore.setState(initialState);
  document.documentElement.removeAttribute('data-theme');
});

// ---- Voter read-only outcome ----------------------------------------------

describe('<ReviewVoterScreen /> — read-only outcome', () => {
  it('renders for a voter in review; shows the outcome and the voter\'s own per-story vote vs team median', () => {
    seedReview({
      meVoterId: V1,
      myVotes: { 's-a': { points: '5', confidence: 5 }, 's-d': { points: '5', confidence: 4 } },
      stories: [
        { id: 's-a', text: 'agreed story', needsDiscussion: false, votes: [
          { voterId: V1, points: '5', confidence: 5 }, { voterId: V2, points: '5', confidence: 5 },
        ] },
        { id: 's-d', text: 'discuss story', needsDiscussion: true, votes: [
          { voterId: V1, points: '5',  confidence: 4 },
          { voterId: V2, points: '13', confidence: 4 },
        ] },
      ],
    });
    renderShell();
    expect(document.querySelector('[data-slot="review-voter-screen"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="review-host-screen"]')).not.toBeInTheDocument();

    // Each row shows team median + voter's own vote.
    const agreedRow = document.querySelector('[data-slot="review-row"][data-story-id="s-a"]') as HTMLElement;
    expect(agreedRow.textContent).toContain('Team');
    expect(agreedRow.textContent).toContain('You');
    // Both team and my vote are 5; both appear in the row.
    expect(agreedRow.textContent).toMatch(/5/);

    const discussRow = document.querySelector('[data-slot="review-row"][data-story-id="s-d"]') as HTMLElement;
    expect(discussRow.getAttribute('data-bucket')).toBe('discuss');
    // The median for the discuss story is 5 (5 + 13 → 5 on fib distance).
    expect(discussRow.textContent).toContain('5');
  });

  it('voter does NOT see host controls (no Accept all, no Discuss live)', () => {
    seedReview({
      meVoterId: V1,
      stories: [
        { id: 's-a', text: 'agreed', needsDiscussion: false, votes: [
          { voterId: V1, points: '5', confidence: 5 }, { voterId: V2, points: '5', confidence: 5 },
        ] },
        { id: 's-d', text: 'discuss', needsDiscussion: true, votes: [
          { voterId: V1, points: '5',  confidence: 4 },
          { voterId: V2, points: '13', confidence: 4 },
        ] },
      ],
    });
    renderShell();
    expect(screen.queryByRole('button', { name: /Accept all/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Discuss live/i })).not.toBeInTheDocument();
  });
});

// ---- The review ⇄ active switch (reactive, room_state_changed) ------------

describe('S9.iii — review ⇄ active switch (reactive)', () => {
  it('VOTER: review screen → room_state_changed:active flips into VotingStage for the now-active story (cast UI present)', async () => {
    seedReview({
      meVoterId: V1,
      stories: [
        { id: 's-d', text: 'discuss me', needsDiscussion: true, votes: [
          { voterId: V1, points: '5',  confidence: 4 },
          { voterId: V2, points: '13', confidence: 4 },
        ] },
      ],
    });
    renderShell();
    expect(document.querySelector('[data-slot="review-voter-screen"]')).toBeInTheDocument();

    // The OPEN_DISCUSSION backend handler emits voting_opened + room_state_changed.
    // Replay both: the story flips to active, the room flips to active.
    act(() => {
      useRoomStore.getState().applyServerDelta({
        changes: [
          { kind: 'voting_opened', storyId: 's-d' },
          { kind: 'room_state_changed', state: 'active' },
        ],
      });
    });

    // Review screen unmounts; VotingStage takes over (cast UI for the voter).
    await waitFor(() => {
      expect(document.querySelector('[data-slot="review-voter-screen"]')).not.toBeInTheDocument();
    });
    expect(document.querySelector('[data-slot="cast"]')).toBeInTheDocument();

    // COMMIT_STORY's return-to-review: story_committed + room_state_changed:review.
    act(() => {
      useRoomStore.getState().applyServerDelta({
        changes: [
          { kind: 'story_committed', storyId: 's-d', finalEstimate: '8' },
          { kind: 'room_state_changed', state: 'review' },
        ],
      });
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="review-voter-screen"]')).toBeInTheDocument();
    });
    expect(document.querySelector('[data-slot="cast"]')).not.toBeInTheDocument();
  });

  it('HOST: review screen → room_state_changed:active flips into VotingStage (host gets the Reveal control); back to review on commit', async () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [
        { id: 's-d', text: 'discuss me', needsDiscussion: true, votes: [
          { voterId: V1, points: '5',  confidence: 4 },
          { voterId: V2, points: '13', confidence: 4 },
        ] },
      ],
    });
    renderShell();
    expect(document.querySelector('[data-slot="review-host-screen"]')).toBeInTheDocument();

    act(() => {
      useRoomStore.getState().applyServerDelta({
        changes: [
          { kind: 'voting_opened', storyId: 's-d' },
          { kind: 'room_state_changed', state: 'active' },
        ],
      });
    });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="review-host-screen"]')).not.toBeInTheDocument();
    });
    // Host sees the Reveal-votes affordance on the active story (sync VotingStage).
    expect(screen.getByRole('button', { name: /Reveal votes/i })).toBeInTheDocument();

    // Return.
    act(() => {
      useRoomStore.getState().applyServerDelta({
        changes: [
          { kind: 'story_committed', storyId: 's-d', finalEstimate: '8' },
          { kind: 'room_state_changed', state: 'review' },
        ],
      });
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="review-host-screen"]')).toBeInTheDocument();
    });
  });
});

// ---- No hex on the voter screen + RoomShell change -------------------------

describe('S9.iii.c2 — no hardcoded hex', () => {
  it('ReviewVoterScreen.tsx has no hardcoded hex literals', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/components/room/ReviewVoterScreen.tsx', 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it('RoomShell.tsx (touched in S9.iii) has no hardcoded hex literals', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/components/room/RoomShell.tsx', 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
