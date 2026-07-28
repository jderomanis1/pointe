// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Room, RoomSnapshot, Story, Voter } from '@pointe/shared';
import { RoomShell } from '../src/components/room/RoomShell';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';
import { useRoomStore } from '../src/store/roomStore';
import { initialState } from '../src/store/reducer';
import { AUTO_ROUND_TEXT } from '../src/lib/rounds';

const SLUG = 'apt-sparrow-16';
const HOST_ID = 'host-1';
const VOTER_ID = 'voter-1';

function baseRoom(): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'sync',
    state: 'lobby', hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
  };
}

function voter(id: string, displayName: string, role: Voter['role'] = 'voter', connectionState: Voter['connectionState'] = 'connected'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState, lastSeenAt: 0, joinedAt: 0 };
}

function story(id: string, orderIndex: number, text: string, state: Story['state'] = 'pending', externalId?: string): Story {
  return { id, roomId: 'r-1', orderIndex, text, state, edited: false, createdAt: 0, externalId };
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
  document.documentElement.removeAttribute('data-theme');
});

describe('RoomShell — automatic live round', () => {
  it('host + no stories automatically creates the internal round', async () => {
    seed({
      room: baseRoom(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();

    expect(screen.getByRole('heading', { name: 'Opening the vote…' })).toBeInTheDocument();
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith('ADD_STORY', { text: AUTO_ROUND_TEXT });
    });
    expect(screen.queryByText(/Add your first story/i)).not.toBeInTheDocument();
  });

  it('host + pending internal round automatically opens voting', async () => {
    seed({
      room: baseRoom(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story('auto-1', 100, AUTO_ROUND_TEXT)],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith('OPEN_VOTING', { storyId: 'auto-1' });
    });
  });

  it('non-host waits for the facilitator without receiving setup controls', () => {
    seed({
      room: baseRoom(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    const send = renderShell();

    expect(screen.getByRole('heading', { name: 'The facilitator is opening the vote…' })).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText(/Add your first story/i)).not.toBeInTheDocument();
  });

  it('header invite copies `${origin}/${slug}` to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText },
    });

    seed({
      room: baseRoom(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story('auto-1', 100, AUTO_ROUND_TEXT, 'active')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();

    await userEvent.click(screen.getByRole('button', { name: /Invite the team/ }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/${SLUG}`);
    await waitFor(() => expect(screen.getByRole('button', { name: /Link copied/ })).toBeInTheDocument());
  });
});

describe('RoomShell — legacy compatibility', () => {
  it('seeded legacy stories remain available in the optional queue', () => {
    seed({
      room: baseRoom(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [
        story('s-2', 200, 'Refactor login', 'pending', 'PROJ-2'),
        story('s-1', 100, 'Add password reset', 'active', 'PROJ-1'),
      ],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();

    expect(screen.getByRole('heading', { name: 'Add password reset' })).toBeInTheDocument();
    const details = screen.getByText('Legacy session items').closest('details');
    expect(details).not.toBeNull();
    expect(screen.getAllByText('PROJ-1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('PROJ-2')).toBeInTheDocument();
  });
});

describe('RoomShell — roster', () => {
  it('seeded voters render with host/spectator markers; me is highlighted', () => {
    seed({
      room: baseRoom(),
      voters: [
        voter(HOST_ID, 'Alice', 'host'),
        voter(VOTER_ID, 'Bob'),
        voter('spec-1', 'Cleo', 'spectator'),
        voter('left-1', 'Dropout', 'voter', 'left'),
      ],
      stories: [story('auto-1', 100, AUTO_ROUND_TEXT, 'active')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();

    expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('host')).toBeInTheDocument();
    expect(screen.getByText('Cleo')).toBeInTheDocument();
    expect(screen.getByText('spectator')).toBeInTheDocument();
    expect(screen.getAllByText('Bob').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('(you)').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Voters · 3/)).toBeInTheDocument();
  });
});
