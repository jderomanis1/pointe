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

function renderShell() {
  return render(
    <MemoryRouter>
      <RoomClientProvider send={vi.fn()}>
        <RoomShell slug={SLUG} />
      </RoomClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useRoomStore.setState(initialState);
  // Reset the data-theme attribute the ThemeToggle reads.
  document.documentElement.removeAttribute('data-theme');
});

describe('RoomShell — empty state (Fix 07)', () => {
  it('host + no stories → editorial guide with add CTA, share link, and deck context', () => {
    seed({
      room: baseRoom(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();

    expect(screen.getByRole('heading', { name: 'Your room is ready.' })).toBeInTheDocument();
    expect(screen.getByText(/Add your first story/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy room link/ })).toBeInTheDocument();
    // Deck context: fibonacci values rendered.
    for (const v of ['1', '2', '3', '5', '8', '13', '21']) {
      expect(screen.getByText(v)).toBeInTheDocument();
    }
  });

  it('non-host + no stories → passive waiting message, no add affordance', () => {
    seed({
      room: baseRoom(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();

    expect(screen.getByRole('heading', { name: 'Waiting for the host' })).toBeInTheDocument();
    expect(screen.queryByText(/Add your first story/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy room link/ })).not.toBeInTheDocument();
  });

  it('host clicks Copy room link → writes `${origin}/${slug}` to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText },
    });

    seed({
      room: baseRoom(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();

    await userEvent.click(screen.getByRole('button', { name: /Copy room link/ }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/${SLUG}`);
    await waitFor(() => expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument());
  });
});

describe('RoomShell — populated', () => {
  it('seeded stories render in order with text + state badge + external id', () => {
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

    const items = screen.getAllByRole('listitem');
    const storyTexts = items
      .map((li) => li.textContent ?? '')
      .filter((t) => t.includes('PROJ-'));
    expect(storyTexts[0]).toContain('Add password reset');
    expect(storyTexts[0]).toContain('PROJ-1');
    expect(storyTexts[1]).toContain('Refactor login');
    // State badges.
    expect(screen.getByText('voting')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
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
      stories: [],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('host')).toBeInTheDocument();
    expect(screen.getByText('Cleo')).toBeInTheDocument();
    expect(screen.getByText('spectator')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
    // Excludes 'left' from the connected count in the roster header.
    expect(screen.getByText(/Voters · 3/)).toBeInTheDocument();
  });
});
