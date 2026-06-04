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

function room(opts: { mode?: 'sync' | 'async'; asyncOpened?: boolean } = {}): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: opts.mode ?? 'sync',
    state: 'lobby', hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
    asyncWindow: opts.asyncOpened
      ? { opensAt: 1_700_000_000_000, closesAt: 1_700_000_000_000 + 4 * 3600 * 1000 }
      : undefined,
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function story(id: string, text = 't'): Story {
  return { id, roomId: 'r-1', orderIndex: 100, text, state: 'pending', edited: false, createdAt: 0 };
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

describe('<AsyncOpenPanel /> — visibility gates', () => {
  it('renders for the host on an async room with stories + no open window', () => {
    seed({
      room: room({ mode: 'async' }),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story('s-1')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.getByRole('button', { name: /Open async voting/i })).toBeInTheDocument();
  });

  it('does NOT render for a non-host (server gates too via SI-02)', () => {
    seed({
      room: room({ mode: 'async' }),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [story('s-1')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: /Open async voting/i })).not.toBeInTheDocument();
  });

  it('does NOT render on a sync-mode room', () => {
    seed({
      room: room({ mode: 'sync' }),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story('s-1')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: /Open async voting/i })).not.toBeInTheDocument();
  });

  it('does NOT render once the async window is already open (asyncWindow set)', () => {
    seed({
      room: room({ mode: 'async', asyncOpened: true }),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story('s-1')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: /Open async voting/i })).not.toBeInTheDocument();
  });

  it('does NOT render when the queue is empty (server would 4xx NO_PENDING_STORIES)', () => {
    seed({
      room: room({ mode: 'async' }),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: /Open async voting/i })).not.toBeInTheDocument();
  });
});

describe('<AsyncOpenPanel /> — duration picker + OPEN_ASYNC wiring', () => {
  it('defaults to 24h; clicking the button sends OPEN_ASYNC { window: "24h" }', async () => {
    seed({
      room: room({ mode: 'async' }),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story('s-1')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();
    expect(screen.getByRole('radio', { name: '24 hours' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('button', { name: /Open async voting/i }));
    expect(send).toHaveBeenCalledWith('OPEN_ASYNC', { window: '24h' });
  });

  it('picking 4h then opening sends OPEN_ASYNC { window: "4h" }', async () => {
    seed({
      room: room({ mode: 'async' }),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story('s-1')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();
    await userEvent.click(screen.getByRole('radio', { name: '4 hours' }));
    await userEvent.click(screen.getByRole('button', { name: /Open async voting/i }));
    expect(send).toHaveBeenCalledWith('OPEN_ASYNC', { window: '4h' });
  });

  it('picking 3 days sends window: "3d"', async () => {
    seed({
      room: room({ mode: 'async' }),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story('s-1')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();
    await userEvent.click(screen.getByRole('radio', { name: '3 days' }));
    await userEvent.click(screen.getByRole('button', { name: /Open async voting/i }));
    expect(send).toHaveBeenCalledWith('OPEN_ASYNC', { window: '3d' });
  });
});
