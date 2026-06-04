// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
const NOW = 1_700_000_000_000;

function room(opts: { mode?: 'sync' | 'async'; asyncOpen?: boolean } = {}): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: opts.mode ?? 'async',
    state: opts.asyncOpen ? 'active' : 'lobby',
    hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
    asyncWindow: opts.asyncOpen
      ? { opensAt: NOW, closesAt: NOW + 4 * 3600 * 1000 }
      : undefined,
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function story(id: string, orderIndex: number, text: string): Story {
  return { id, roomId: 'r-1', orderIndex, text, state: 'active', edited: false, createdAt: 0 };
}

function seedAsync(opts: { meVoterId: string; storyCount?: number }) {
  const storyCount = opts.storyCount ?? 3;
  const stories = Array.from({ length: storyCount }, (_, i) =>
    story(`s-${i + 1}`, (i + 1) * 100, `Story ${i + 1}`));
  const snap: RoomSnapshot = {
    room: room({ mode: 'async', asyncOpen: true }),
    voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
    stories,
    you: { voterId: opts.meVoterId, role: 'voter' },
  };
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

function getPrimary(): HTMLElement {
  return document.querySelector('[data-slot="async-primary"]') as HTMLElement;
}
function getDots(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-dot-index]')) as HTMLElement[];
}

beforeEach(() => {
  useRoomStore.setState(initialState);
  document.documentElement.removeAttribute('data-theme');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

// ---- Visibility gates ------------------------------------------------------

describe('<AsyncVoterView /> — visibility gates', () => {
  it('renders for a voter on an open async window', () => {
    seedAsync({ meVoterId: VOTER_ID });
    renderShell();
    expect(document.querySelector('[data-slot="async-voter-view"]')).toBeInTheDocument();
  });

  it('does NOT render for the host (host monitoring is c4)', () => {
    seedAsync({ meVoterId: HOST_ID });
    renderShell();
    expect(document.querySelector('[data-slot="async-voter-view"]')).not.toBeInTheDocument();
  });

  it('does NOT render on a sync room', () => {
    useRoomStore.setState(initialState);
    useRoomStore.getState().hydrate({
      room: room({ mode: 'sync' }),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [story('s-1', 100, 'one')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    useRoomStore.getState().setConnection('connected');
    renderShell();
    expect(document.querySelector('[data-slot="async-voter-view"]')).not.toBeInTheDocument();
  });
});

// ---- Primary commit button: disabled → saturated; commit + advance --------

describe('<AsyncVoterView /> — primary commit (X)', () => {
  it('primary button is visually outlined (data-can-submit="false") with no card; clicking shows the pick-or-skip hint and does NOT send', async () => {
    seedAsync({ meVoterId: VOTER_ID });
    const send = renderShell();
    const primary = getPrimary();
    expect(primary).toBeInTheDocument();
    expect(primary.getAttribute('data-can-submit')).toBe('false');
    // No vote_value sends.
    await userEvent.click(primary);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/Pick a card to vote, or skip this story/);
  });

  it('saturates to oxblood (data-can-submit="true") once a card is picked', async () => {
    seedAsync({ meVoterId: VOTER_ID });
    renderShell();
    await userEvent.click(screen.getByRole('radio', { name: '5' }));
    expect(getPrimary().getAttribute('data-can-submit')).toBe('true');
  });

  it('clicking the primary with a card picked sends VOTE_CAST + advances to the next story', async () => {
    seedAsync({ meVoterId: VOTER_ID, storyCount: 3 });
    const send = renderShell();
    expect(screen.getByText('Story 1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: '5' }));
    await userEvent.click(getPrimary());
    expect(send).toHaveBeenCalledWith('VOTE_CAST', {
      storyId: 's-1', points: '5', confidence: 3,
    });
    expect(screen.getByText('Story 2')).toBeInTheDocument();
  });

  it('final story shows "Submit & finish →"; commit reaches the done state', async () => {
    seedAsync({ meVoterId: VOTER_ID, storyCount: 2 });
    const send = renderShell();
    // Advance to story 2.
    await userEvent.click(screen.getByRole('radio', { name: '5' }));
    await userEvent.click(getPrimary());
    expect(screen.getByText('Story 2')).toBeInTheDocument();
    expect(getPrimary().textContent).toMatch(/Submit & finish/);
    // Commit final.
    await userEvent.click(screen.getByRole('radio', { name: '8' }));
    await userEvent.click(getPrimary());
    expect(send).toHaveBeenLastCalledWith('VOTE_CAST', {
      storyId: 's-2', points: '8', confidence: 3,
    });
    expect(document.querySelector('[data-slot="async-done"]')).toBeInTheDocument();
    expect(screen.getByText(/You['’]re all set/)).toBeInTheDocument();
  });
});

// ---- Skip (no opinion exit) ------------------------------------------------

describe('<AsyncVoterView /> — skip (the no-opinion exit)', () => {
  it('skip advances without sending VOTE_CAST', async () => {
    seedAsync({ meVoterId: VOTER_ID, storyCount: 3 });
    const send = renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText('Story 2')).toBeInTheDocument();
  });
});

// ---- Vote cast ✓ + revisit (Y) --------------------------------------------

describe('<AsyncVoterView /> — Vote cast ✓ + revisit (Y)', () => {
  it('after committing story 1 and navigating back via Previous, the ✓ marker + prior selection are restored', async () => {
    seedAsync({ meVoterId: VOTER_ID, storyCount: 3 });
    renderShell();
    // Pick + commit story 1 — the local store updates via the simulated send
    // path; here we mimic the round-trip by applying the delta manually.
    await userEvent.click(screen.getByRole('radio', { name: '5' }));
    // Manually round-trip the server's vote_value echo so myVotes[s-1] is set.
    useRoomStore.getState().applyServerDelta({
      changes: [{ kind: 'vote_value', storyId: 's-1', points: '5', confidence: 3 }],
    });
    await userEvent.click(getPrimary()); // commits + advances to story 2
    expect(screen.getByText('Story 2')).toBeInTheDocument();

    // Go back.
    await userEvent.click(screen.getByRole('button', { name: /Previous/i }));
    expect(screen.getByText('Story 1')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="vote-cast-marker"]')).toBeInTheDocument();
    expect(screen.getByText('Vote cast')).toBeInTheDocument();
    // Prior selection restored.
    expect(screen.getByRole('radio', { name: '5' })).toHaveAttribute('aria-checked', 'true');
  });
});

// ---- Progress dots: fill = committed, ring = current ----------------------

describe('<AsyncVoterView /> — progress dots compose fill + ring', () => {
  it('dot 0 has ring (current); after committing story 1 dot 0 fills and dot 1 takes the ring', async () => {
    seedAsync({ meVoterId: VOTER_ID, storyCount: 3 });
    renderShell();
    let dots = getDots();
    expect(dots[0].getAttribute('data-current')).toBe('true');
    expect(dots[0].getAttribute('data-committed')).toBe('false');
    expect(dots[1].getAttribute('data-current')).toBe('false');

    await userEvent.click(screen.getByRole('radio', { name: '5' }));
    useRoomStore.getState().applyServerDelta({
      changes: [{ kind: 'vote_value', storyId: 's-1', points: '5', confidence: 3 }],
    });
    await userEvent.click(getPrimary());

    dots = getDots();
    // Dot 0 now committed; dot 1 now current.
    expect(dots[0].getAttribute('data-committed')).toBe('true');
    expect(dots[0].getAttribute('data-current')).toBe('false');
    expect(dots[1].getAttribute('data-current')).toBe('true');
    expect(dots[1].getAttribute('data-committed')).toBe('false');
  });
});

// ---- Countdown + privacy framing ------------------------------------------

describe('<AsyncVoterView /> — header (countdown + privacy)', () => {
  it('shows the closes-in countdown in mono and the votes-hidden caption', () => {
    seedAsync({ meVoterId: VOTER_ID });
    renderShell();
    expect(screen.getByTestId('countdown').textContent).toMatch(/4h 0m/);
    expect(screen.getByText(/Your vote stays hidden until the window closes/)).toBeInTheDocument();
  });

  it('the host monitoring view is NOT rendered here (c4 handles host UI)', () => {
    seedAsync({ meVoterId: VOTER_ID });
    renderShell();
    // Sanity: no story values are leaked for the voter on the active stories
    // (anti-anchoring per snapshot — votes stay [] until close).
    const view = document.querySelector('[data-slot="async-voter-view"]') as HTMLElement;
    // The voter's own pre-commit pickers are present, but no peer vote-value text.
    expect(within(view).queryByText(/median/i)).not.toBeInTheDocument();
  });
});
