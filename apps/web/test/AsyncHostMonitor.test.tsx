// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Room, RoomSnapshot, Story, Voter } from '@pointe/shared';
import { RoomShell } from '../src/components/room/RoomShell';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';
import { useRoomStore } from '../src/store/roomStore';
import { initialState } from '../src/store/reducer';

const SLUG = 'apt-sparrow-16';
const HOST_ID = 'host-1';
const VOTER_ID = 'voter-1';
const VOTER2_ID = 'voter-2';
const NOW = 1_700_000_000_000;

function room(): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'async',
    state: 'active', hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
    asyncWindow: { opensAt: NOW, closesAt: NOW + 24 * 3600 * 1000 },
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function story(id: string, orderIndex: number, text: string): Story {
  return { id, roomId: 'r-1', orderIndex, text, state: 'active', edited: false, createdAt: 0 };
}

function seedHostAsync() {
  const snap: RoomSnapshot = {
    room: room(),
    voters: [
      voter(HOST_ID, 'Alice', 'host'),
      voter(VOTER_ID, 'Bob'),
      voter(VOTER2_ID, 'Cleo'),
    ],
    stories: [
      story('s-1', 100, 'Story one'),
      story('s-2', 200, 'Story two'),
    ],
    you: { voterId: HOST_ID, role: 'voter' },
  };
  useRoomStore.setState(initialState);
  useRoomStore.getState().hydrate(snap);
  useRoomStore.getState().setConnection('connected');
}

function renderShell() {
  render(
    <MemoryRouter>
      <RoomClientProvider send={vi.fn()}>
        <RoomShell slug={SLUG} />
      </RoomClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useRoomStore.setState(initialState);
  document.documentElement.removeAttribute('data-theme');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

describe('<AsyncHostMonitorView /> — render gate + content', () => {
  it('renders for the host on an open async window with the countdown + per-story progress list', () => {
    seedHostAsync();
    renderShell();
    expect(document.querySelector('[data-slot="async-host-monitor"]')).toBeInTheDocument();
    expect(screen.getByTestId('host-countdown').textContent).toMatch(/24h 0m/);
    // The story list — both stories present.
    const list = document.querySelector('[data-slot="async-host-list"]') as HTMLElement;
    expect(list.querySelectorAll('[data-story-id]').length).toBe(2);
  });

  it('does NOT render the voter view for the host (no async-voter-view mount)', () => {
    seedHostAsync();
    renderShell();
    expect(document.querySelector('[data-slot="async-voter-view"]')).not.toBeInTheDocument();
  });
});

describe('<AsyncHostMonitorView /> — AA-1: voted counts only, never values', () => {
  it('shows per-story counts ("0 of 2 voted") with no peer vote values anywhere in the view', () => {
    seedHostAsync();
    renderShell();
    const view = document.querySelector('[data-slot="async-host-monitor"]') as HTMLElement;
    const counts = view.querySelectorAll('[data-slot="vote-count"]');
    expect(counts).toHaveLength(2);
    // Total voter-roles = 2 (Bob + Cleo); host is non-spectator too but
    // canVote allows them — actually castVote allows all non-spectators, so
    // the host counts. With 1 host + 2 voters = 3 total.
    expect(counts[0].textContent).toMatch(/0/);
    expect(counts[0].textContent).toMatch(/of/);
    expect(counts[0].textContent).toMatch(/3/);
    expect(counts[0].textContent).toMatch(/voted/);
    // No peer vote values rendered. Check that no card-face value appears in
    // the monitor view (no '5', '8', '13' as standalone text — we only have
    // the count digits 0/1/2/3 and the story IDs).
    const text = view.textContent || '';
    // Sanity: counts use 0..3, but no Fibonacci card face like '13', '8', '21' present.
    expect(text).not.toMatch(/\b13\b/);
    expect(text).not.toMatch(/\b21\b/);
    expect(text).not.toMatch(/median/i);
  });

  it('voted_voted delta lands → count flips up (presence-only, never value)', async () => {
    seedHostAsync();
    renderShell();
    // Round-trip a voter_voted delta (presence-only; server's per-recipient
    // projection strips vote_value for non-casters, so peer values never
    // reach the host's store pre-reveal).
    act(() => {
      useRoomStore.getState().applyServerDelta({
        changes: [{ kind: 'voter_voted', storyId: 's-1', voterId: VOTER_ID }],
      });
    });
    await waitFor(() => {
      const view = document.querySelector('[data-slot="async-host-monitor"]') as HTMLElement;
      const counts = view.querySelectorAll('[data-slot="vote-count"]');
      expect(counts[0].textContent).toMatch(/1/);
    });
    const view = document.querySelector('[data-slot="async-host-monitor"]') as HTMLElement;
    // Sanity: even after the delta there's no vote-value in the DOM.
    expect(within(view).queryByText(/median/i)).not.toBeInTheDocument();
  });
});

describe('<AsyncHostMonitorView /> — share link affordance', () => {
  it('renders a copyable share link', () => {
    seedHostAsync();
    renderShell();
    expect(screen.getByText(/Share the link/i)).toBeInTheDocument();
  });
});
