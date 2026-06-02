// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Room, RoomSnapshot, Voter } from '@pointe/shared';
import { RoomShell } from '../src/components/room/RoomShell';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';
import { useRoomStore } from '../src/store/roomStore';
import { applyHostReclaimed, applyHostVacant, initialState } from '../src/store/reducer';

const SLUG = 'apt-sparrow-16';
const HOST_ID = 'host-1';
const VOTER_ID = 'voter-1';
const SPEC_ID = 'spec-1';

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

// ---- Pure reducer ----

describe('reducer — applyHostVacant', () => {
  it('flips room.state to host_vacant and stamps hostVacantSince', () => {
    const seeded = useRoomStore.getState();
    useRoomStore.setState({
      ...seeded,
      room: room(),
      me: { voterId: VOTER_ID, role: 'voter' },
    });
    const next = applyHostVacant(useRoomStore.getState(), { vacantSince: 12_345 });
    expect(next.room!.state).toBe('host_vacant');
    expect(next.room!.hostVacantSince).toBe(12_345);
  });

  it('is a no-op when room is not yet hydrated', () => {
    const next = applyHostVacant(initialState, { vacantSince: 1 });
    expect(next).toBe(initialState);
  });
});

describe('reducer — applyHostReclaimed', () => {
  it('swaps host: prior host → voter, new host → host, state → active, clears vacancy', () => {
    useRoomStore.setState({
      ...initialState,
      room: room({ state: 'host_vacant', hostVacantSince: 9_000 }),
      voters: {
        [HOST_ID]: voter(HOST_ID, 'Alice', 'host'),
        [VOTER_ID]: voter(VOTER_ID, 'Ben'),
      },
      me: { voterId: VOTER_ID, role: 'voter' },
    });
    const next = applyHostReclaimed(useRoomStore.getState(), {
      newHostVoterId: VOTER_ID, via: 'claim',
    });
    expect(next.room!.state).toBe('active');
    expect(next.room!.hostVoterId).toBe(VOTER_ID);
    expect(next.room!.hostVacantSince).toBeUndefined();
    expect(next.voters[HOST_ID].role).toBe('voter');
    expect(next.voters[VOTER_ID].role).toBe('host');
  });

  it('updates `me.role` when the local user gains or loses host', () => {
    useRoomStore.setState({
      ...initialState,
      room: room({ state: 'host_vacant', hostVacantSince: 9_000 }),
      voters: {
        [HOST_ID]: voter(HOST_ID, 'Alice', 'host'),
        [VOTER_ID]: voter(VOTER_ID, 'Ben'),
      },
      me: { voterId: VOTER_ID, role: 'voter' },
    });
    const next = applyHostReclaimed(useRoomStore.getState(), {
      newHostVoterId: VOTER_ID, via: 'claim',
    });
    expect(next.me!.role).toBe('host');
  });
});

// ---- HostVacantBanner ----

describe('HostVacantBanner', () => {
  it('renders only when room.state === "host_vacant"', () => {
    seed({
      room: room({ state: 'active' }),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim host' })).not.toBeInTheDocument();

    act(() => { useRoomStore.getState().applyHostVacant({ vacantSince: 100 }); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim host' })).toBeInTheDocument();
  });

  it('clicking Claim host sends CLAIM_HOST with an empty payload', async () => {
    seed({
      room: room({ state: 'host_vacant', hostVacantSince: 100 }),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    const send = renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Claim host' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('CLAIM_HOST', {});
  });

  it('spectator sees Claim host (D1: any connected participant can claim)', () => {
    seed({
      room: room({ state: 'host_vacant', hostVacantSince: 100 }),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(SPEC_ID, 'Spec', 'spectator')],
      stories: [],
      you: { voterId: SPEC_ID, role: 'spectator' },
    });
    renderShell();
    expect(screen.getByRole('button', { name: 'Claim host' })).toBeInTheDocument();
  });

  it('HOST_RECLAIMED clears the banner', () => {
    seed({
      room: room({ state: 'host_vacant', hostVacantSince: 100 }),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => { useRoomStore.getState().applyHostReclaimed({ newHostVoterId: VOTER_ID, via: 'claim' }); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ---- ReplacedNotice ----

describe('ReplacedNotice — fires for an ex-host who came back', () => {
  it('local user WAS host; HOST_RECLAIMED to someone else → notice naming the new host appears, dismissible', async () => {
    seed({
      room: room({ state: 'host_vacant', hostVacantSince: 100 }),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      // me === Alice (the original host)
      you: { voterId: HOST_ID, role: 'host' },
      stories: [],
    });
    renderShell();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => { useRoomStore.getState().applyHostReclaimed({ newHostVoterId: VOTER_ID, via: 'claim' }); });
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('While you were away');
    expect(notice).toHaveTextContent('Ben');

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('local user was NEVER host; same HOST_RECLAIMED → no notice', () => {
    seed({
      room: room({ state: 'host_vacant', hostVacantSince: 100 }),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      // me === Ben (always a voter)
      you: { voterId: VOTER_ID, role: 'voter' },
      stories: [],
    });
    renderShell();
    act(() => { useRoomStore.getState().applyHostReclaimed({ newHostVoterId: VOTER_ID, via: 'claim' }); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('fires on a reconnect SNAPSHOT showing a different host (live reconnect path)', () => {
    seed({
      room: room({ state: 'active' }),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      // me === Alice and Alice IS the host on the first snapshot
      you: { voterId: HOST_ID, role: 'host' },
      stories: [],
    });
    renderShell();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Reconnect snapshot: now Ben is the host (someone else claimed while we were away).
    act(() => {
      useRoomStore.getState().hydrate({
        room: room({ state: 'active', hostVoterId: VOTER_ID }),
        voters: [voter(HOST_ID, 'Alice'), voter(VOTER_ID, 'Ben', 'host')],
        stories: [],
        you: { voterId: HOST_ID, role: 'voter' },
      });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Ben');
  });
});
