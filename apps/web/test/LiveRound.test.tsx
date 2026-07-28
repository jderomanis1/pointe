// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Room, RoomSnapshot, Story, Vote, Voter } from '@pointe/shared';
import { RoomShell } from '../src/components/room/RoomShell';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';
import { useRoomStore } from '../src/store/roomStore';
import { initialState } from '../src/store/reducer';
import { AUTO_ROUND_TEXT } from '../src/lib/rounds';

const SLUG = 'apt-sparrow-16';
const HOST_ID = 'host-1';
const VOTER_ID = 'voter-1';
const STORY_ID = 'auto-round-1';

function room(): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'sync', state: 'active',
    hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
  };
}

function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}

function story(state: Story['state']): Story {
  return {
    id: STORY_ID, roomId: 'r-1', orderIndex: 100, text: AUTO_ROUND_TEXT,
    state, edited: false, createdAt: 0,
  };
}

function vote(voterId: string, points: string): Vote {
  return { storyId: STORY_ID, voterId, points, confidence: 3, submittedAt: 0, updatedAt: 0 };
}

function seed(snapshot: RoomSnapshot) {
  useRoomStore.setState(initialState);
  useRoomStore.getState().hydrate(snapshot);
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

describe('automatic live round UX', () => {
  it('active round enters directly into the estimate hand without showing an internal story title', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Helen', 'host'), voter(VOTER_ID, 'Alice')],
      stories: [story('active')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();

    expect(screen.getByRole('heading', { name: 'Choose your estimate.' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: AUTO_ROUND_TEXT })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cast estimate' })).toBeInTheDocument();
  });

  it('facilitator reveals cards and closes the vote by reopening the internal round', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Helen', 'host'), voter(VOTER_ID, 'Alice')],
      stories: [story('revealed')],
      you: { voterId: HOST_ID, role: 'voter' },
      votes: [vote(HOST_ID, '5'), vote(VOTER_ID, '8')],
    });
    useRoomStore.setState((state) => ({
      ...state,
      revealed: {
        [STORY_ID]: {
          votes: [vote(HOST_ID, '5'), vote(VOTER_ID, '8')],
          stats: {
            median: '6.5', outliers: [], avgConfidence: 3,
            lowConfidence: false, nonNumeric: [], numericCount: 2,
          },
        },
      },
    }));
    const send = renderShell();

    expect(screen.getByRole('heading', { name: 'Talk about what the team saw.' })).toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Vote again' });
    expect(close).toHaveTextContent('Close vote');
    await userEvent.click(close);
    expect(send).toHaveBeenCalledWith('OPEN_VOTING', { storyId: STORY_ID });
  });

  it('non-facilitators see discussion guidance instead of close controls', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Helen', 'host'), voter(VOTER_ID, 'Alice')],
      stories: [story('revealed')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    useRoomStore.setState((state) => ({
      ...state,
      revealed: {
        [STORY_ID]: {
          votes: [vote(HOST_ID, '5'), vote(VOTER_ID, '8')],
          stats: {
            median: '6.5', outliers: [], avgConfidence: 3,
            lowConfidence: false, nonNumeric: [], numericCount: 2,
          },
        },
      },
    }));
    renderShell();

    expect(screen.getByRole('heading', { name: 'Discuss the differences.' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Vote again' })).not.toBeInTheDocument();
  });
});
