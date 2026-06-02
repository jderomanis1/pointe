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

describe('Open voting — host control', () => {
  it('host on a pending story sees "Open voting"; click sends OPEN_VOTING { storyId }', async () => {
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
  it('renders the story text as a serif heading + voting-open status; cast slot present', () => {
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
    expect(heading.className).toMatch(/font-serif/);
    expect(screen.getByText('voting open')).toBeInTheDocument();
    // PROJ-1 appears in both the stage and the queue row — both legitimate.
    expect(screen.getAllByText('PROJ-1').length).toBeGreaterThanOrEqual(1);

    // The cast slot exists. R5.iii fills it with the CastPanel for voters/host;
    // the spectator-gating + cast behavior are covered in CastPanel.test.tsx.
    const slot = document.querySelector('[data-slot="cast"]') as HTMLElement | null;
    expect(slot).not.toBeNull();
  });
});

describe('VoterSeats — ANTI-ANCHORING UI INVARIANT', () => {
  it('shows who voted (presence) but never any peer value', () => {
    // Distinctive markers we'd notice if a peer value leaked into rendered output.
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
    // Pre-reveal: the store shape physically can't hold peer values. Hand-poking the store
    // to insert `myVotes` for the local user (legitimate — vote_value mirror) and presence
    // for two peers; then assert nothing in the DOM exposes points/confidence for peers.
    useRoomStore.setState((s) => ({
      ...s,
      votedPresence: { 's-1': new Set(['host-1', 'voter-1']) }, // Alice + Ben voted
      myVotes: { 's-1': { points: '5', confidence: 4 } },
    }));

    renderShell();

    // Presence visible:
    expect(screen.getByTestId('seat-host-1').getAttribute('data-voted')).toBe('true');
    expect(screen.getByTestId('seat-voter-1').getAttribute('data-voted')).toBe('true');
    expect(screen.getByTestId('seat-v-cyd').getAttribute('data-voted')).toBe('false');

    // Spectators are in the separate non-voting group, never seated as voters.
    expect(screen.queryByTestId('seat-spec-1')).not.toBeInTheDocument();
    // 'Specs' appears in both the Roster (R4.v) and the Watching list (here).
    expect(screen.getAllByText('Specs').length).toBeGreaterThanOrEqual(1);

    // Anti-anchoring: assert no peer value reaches the DOM. The store didn't hold one,
    // but seal that with a grep over the rendered HTML for distinctive markers.
    const html = document.body.innerHTML;
    expect(html).not.toContain(peerSecretPoints);
    expect(html).not.toContain(peerSecretConfidenceText);

    // And no number-shaped value rendered alongside the peer seats (the structural
    // invariant — seats render presence, never any digit or rank).
    const benSeat = screen.getByTestId('seat-voter-1');
    expect(benSeat.textContent ?? '').not.toMatch(/\d/);
    const cydSeat = screen.getByTestId('seat-v-cyd');
    expect(cydSeat.textContent ?? '').not.toMatch(/\d/);
  });
});
