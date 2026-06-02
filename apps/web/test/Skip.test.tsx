// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Room, RoomSnapshot, Story, Voter } from '@pointe/shared';
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
function story(id: string, orderIndex: number, text: string, state: Story['state'] = 'pending'): Story {
  return { id, roomId: 'r-1', orderIndex, text, state, edited: false, createdAt: 0 };
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

// ---- Reducer ----

describe('reducer — story_skipped', () => {
  it('flips story.state to skipped (terminal)', () => {
    const seeded = {
      ...initialState,
      stories: [story('s-1', 100, 'A', 'pending')],
    };
    const next = applyChange(seeded, { kind: 'story_skipped', storyId: 's-1' });
    expect(next.stories.find((s) => s.id === 's-1')!.state).toBe('skipped');
  });

  it('skipping the active story drops it from stage focus (state !== active anymore)', () => {
    const seeded = {
      ...initialState,
      stories: [story('s-1', 100, 'A', 'active')],
    };
    const next = applyChange(seeded, { kind: 'story_skipped', storyId: 's-1' });
    expect(next.stories.find((s) => s.id === 's-1')!.state).toBe('skipped');
    // No active or revealed story remains → RoomShell focusStory returns null.
    expect(
      next.stories.find((s) => s.state === 'active' || s.state === 'revealed'),
    ).toBeUndefined();
  });
});

// ---- UI: host-only skip control on pending row + active stage ----

describe('Skip — queue pending row (host only)', () => {
  it('host on a pending row sees Skip; click sends SKIP_STORY { storyId }', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'Auth')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();
    const btn = screen.getByRole('button', { name: 'Skip' });
    await userEvent.click(btn);
    expect(send).toHaveBeenCalledWith('SKIP_STORY', { storyId: 's-1' });
  });

  it('non-host does NOT see Skip', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'Auth')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
  });
});

describe('Skip — active story stage (host only)', () => {
  it('host on the active stage sees "Skip story"; click sends SKIP_STORY { storyId }', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'Auth', 'active')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();
    const btn = screen.getByRole('button', { name: 'Skip story' });
    await userEvent.click(btn);
    expect(send).toHaveBeenCalledWith('SKIP_STORY', { storyId: 's-1' });
  });

  it('non-host does NOT see Skip story on the active stage', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'Auth', 'active')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: 'Skip story' })).not.toBeInTheDocument();
  });
});

// ---- Skipped row display ----

describe('Skipped story row', () => {
  it('renders the skipped badge in the queue (muted; no host actions on terminal rows)', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [
        story('s-skip', 100, 'Blocked by infra', 'skipped'),
        story('s-todo', 200, 'Next up'),
      ],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    // The skipped row carries the "skipped" badge text. Scope to its <li> so
    // we don't collide with other rows' badges.
    const lis = screen.getAllByRole('listitem');
    const skippedRow = lis.find((li) => li.textContent?.includes('Blocked by infra'))!;
    expect(within(skippedRow).getByText('skipped')).toBeInTheDocument();
    // No host actions on the skipped row — Skip / Open voting both absent.
    expect(within(skippedRow).queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    expect(within(skippedRow).queryByRole('button', { name: 'Open voting' })).not.toBeInTheDocument();
  });
});
