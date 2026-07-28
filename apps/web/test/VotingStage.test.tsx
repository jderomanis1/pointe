// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Room, RoomSnapshot, Story, Voter } from '@pointe/shared';
import { RoomShell } from '../src/components/room/RoomShell';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';
import { useRoomStore } from '../src/store/roomStore';
import { initialState } from '../src/store/reducer';

const SLUG = 'apt-sparrow-16';
const HOST_ID = 'host-1';
const VOTER_ID = 'voter-1';

function room(): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'sync',
    state: 'lobby', hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function story(id: string, orderIndex: number, text: string, state: Story['state'] = 'pending', externalId?: string): Story {
  return { id, roomId: 'r-1', orderIndex, text, state, edited: false, createdAt: 0, externalId };
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
  document.documentElement.removeAttribute('data-theme');
});

describe('Open voting — legacy host control', () => {
  it('host on a pending legacy story sees Open voting and sends OPEN_VOTING', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [story('s-1', 100, 'Add password reset')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();

    const btn = screen.getByRole('button', { name: 'Open voting' });
    await userEvent.click(btn);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('OPEN_VOTING', { storyId: 's-1' });
  });

  it('non-host does not see the open-voting control', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [story('s-1', 100, 'Add password reset')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: 'Open voting' })).not.toBeInTheDocument();
  });
});

describe('VotingStage — active story focus', () => {
  it('renders the story as a clean bold heading with voting status and cast slot', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [
        { ...story('s-1', 100, 'Add password reset', 'active', 'PROJ-1') },
        story('s-2', 200, 'Refactor login'),
      ],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();

    const heading = screen.getByRole('heading', { name: 'Add password reset' });
    expect(heading).toBeInTheDocument();
    expect(heading.className).toMatch(/font-extrabold/);
    expect(screen.getByText('voting open')).toBeInTheDocument();
    expect(screen.getAllByText('PROJ-1').length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('[data-slot="cast"]')).not.toBeNull();
  });
});

describe('VoterSeats — anti-anchoring UI invariant', () => {
  it('shows who voted but never any peer value', () => {
    const peerSecretPoints = 'XPEER-POINTS';
    const peerSecretConfidenceText = 'XPEER-CONFIDENCE-99';

    seed({
      room: room(),
      voters: [
        voter(HOST_ID, 'Alice', 'host'),
        voter(VOTER_ID, 'Ben'),
        voter('v-cyd', 'Cyd'),
        voter('spec-1', 'Specs', 'spectator'),
      ],
      stories: [{ ...story('s-1', 100, 'A story', 'active') }],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    useRoomStore.setState((s) => ({
      ...s,
      votedPresence: { 's-1': new Set(['host-1', 'voter-1']) },
      myVotes: { 's-1': { points: '5', confidence: 4 } },
    }));

    renderShell();

    expect(screen.getByTestId('seat-host-1').getAttribute('data-voted')).toBe('true');
    expect(screen.getByTestId('seat-voter-1').getAttribute('data-voted')).toBe('true');
    expect(screen.getByTestId('seat-v-cyd').getAttribute('data-voted')).toBe('false');

    const specRow = screen.getByTestId('seat-spec-1');
    expect(specRow.getAttribute('data-voted')).toBe('false');
    expect(screen.getAllByText('Specs').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('[OBS]')).toBeInTheDocument();

    const html = document.body.innerHTML;
    expect(html).not.toContain(peerSecretPoints);
    expect(html).not.toContain(peerSecretConfidenceText);
    expect(screen.getByTestId('seat-voter-1').textContent ?? '').not.toContain(peerSecretPoints);
    expect(screen.getByTestId('seat-v-cyd').textContent ?? '').not.toContain(peerSecretPoints);
  });
});
