// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { RevealStats, Room, RoomSnapshot, Vote, Voter } from '@pointe/shared';
import { RoomShell } from '../src/components/room/RoomShell';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';
import { useRoomStore } from '../src/store/roomStore';
import { applyChange, initialState } from '../src/store/reducer';

const SLUG = 'apt-sparrow-16';
const HOST_ID = 'host-1';
const VOTER_ID = 'voter-1';

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'sync',
    state: 'active', hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
    ...overrides,
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function vote(voterId: string, points: string, confidence: number, storyId = 's-1'): Vote {
  return { storyId, voterId, points, confidence, submittedAt: 0, updatedAt: 0 };
}

function seed(snap: RoomSnapshot) {
  useRoomStore.setState(initialState);
  useRoomStore.getState().hydrate(snap);
  useRoomStore.getState().setConnection('connected');
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
});

// ---- Reducer: voting_opened clears the prior round's view ----

describe('reducer — voting_opened on a re-opened story', () => {
  it('clears revealed[storyId], myVotes[storyId], votedPresence[storyId] (the round-1 view drops)', () => {
    const stats: RevealStats = {
      median: '5', outliers: [], avgConfidence: 3.5, lowConfidence: false, nonNumeric: [], numericCount: 2,
    };
    const seeded = {
      ...initialState,
      stories: [
        { id: 's-1', roomId: 'r-1', orderIndex: 100, text: 'A', state: 'revealed' as const, edited: false, createdAt: 0 },
        { id: 's-2', roomId: 'r-1', orderIndex: 200, text: 'B', state: 'pending' as const, edited: false, createdAt: 0 },
      ],
      revealed: { 's-1': { votes: [vote(VOTER_ID, '5', 4)], stats } },
      myVotes: { 's-1': { points: '5', confidence: 4 } },
      votedPresence: { 's-1': new Set([HOST_ID, VOTER_ID]) },
    };

    const next = applyChange(seeded, { kind: 'voting_opened', storyId: 's-1' });

    // Story flipped to active.
    expect(next.stories.find((s) => s.id === 's-1')!.state).toBe('active');
    // Round-1 view dropped.
    expect(next.revealed['s-1']).toBeUndefined();
    expect(next.myVotes['s-1']).toBeUndefined();
    expect(next.votedPresence['s-1']).toBeUndefined();
  });

  it('first-open (pending → active) on a clean store is a no-op for the round slots', () => {
    const seeded = {
      ...initialState,
      stories: [
        { id: 's-1', roomId: 'r-1', orderIndex: 100, text: 'A', state: 'pending' as const, edited: false, createdAt: 0 },
      ],
    };
    const next = applyChange(seeded, { kind: 'voting_opened', storyId: 's-1' });
    expect(next.stories.find((s) => s.id === 's-1')!.state).toBe('active');
    expect(next.revealed).toEqual({});
    expect(next.myVotes).toEqual({});
    expect(next.votedPresence).toEqual({});
  });

  it('preserves OTHER stories\' round state (only the re-opened story is cleared)', () => {
    const stats: RevealStats = {
      median: '5', outliers: [], avgConfidence: 4, lowConfidence: false, nonNumeric: [], numericCount: 1,
    };
    const seeded = {
      ...initialState,
      stories: [
        { id: 's-1', roomId: 'r-1', orderIndex: 100, text: 'A', state: 'revealed' as const, edited: false, createdAt: 0 },
        { id: 's-2', roomId: 'r-1', orderIndex: 200, text: 'B', state: 'revealed' as const, edited: false, createdAt: 0 },
      ],
      revealed: {
        's-1': { votes: [vote(VOTER_ID, '5', 4, 's-1')], stats },
        's-2': { votes: [vote(VOTER_ID, '8', 4, 's-2')], stats },
      },
      myVotes: { 's-1': { points: '5', confidence: 4 }, 's-2': { points: '8', confidence: 4 } },
    };
    const next = applyChange(seeded, { kind: 'voting_opened', storyId: 's-1' });
    expect(next.revealed['s-1']).toBeUndefined();
    expect(next.revealed['s-2']).toBeDefined(); // untouched
    expect(next.myVotes['s-1']).toBeUndefined();
    expect(next.myVotes['s-2']).toEqual({ points: '8', confidence: 4 });
  });
});

// ---- UI: host "Vote again" in the revealed view ----

function seedRevealedActive(asHost: boolean, votes: Vote[], stats: RevealStats) {
  seed({
    room: room(),
    voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
    stories: [
      { id: 's-1', roomId: 'r-1', orderIndex: 100, text: 'Auth', state: 'revealed' as const, edited: false, createdAt: 0 },
    ],
    you: { voterId: asHost ? HOST_ID : VOTER_ID, role: 'voter' },
  });
  useRoomStore.setState((s) => ({ ...s, revealed: { 's-1': { votes, stats } } }));
}

describe('CommitPanel — "Vote again" (re-open) host control', () => {
  it('host sees "Vote again" in the revealed view; click sends OPEN_VOTING { storyId }', async () => {
    seedRevealedActive(
      true,
      [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 4)],
      { median: '5', outliers: [], avgConfidence: 4, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    );
    const send = renderShell();
    const btn = screen.getByRole('button', { name: 'Vote again' });
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('OPEN_VOTING', { storyId: 's-1' });
  });

  it('non-host does NOT see "Vote again" (CommitPanel is host-only anyway)', () => {
    seedRevealedActive(
      false,
      [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 4)],
      { median: '5', outliers: [], avgConfidence: 4, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    );
    renderShell();
    expect(screen.queryByRole('button', { name: 'Vote again' })).not.toBeInTheDocument();
  });
});
