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

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'sync',
    state: 'lobby', hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
    ...overrides,
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function story(id: string, orderIndex: number, text: string, state: Story['state'] = 'active'): Story {
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

function seedActiveAsVoter(role: Voter['role'] = 'voter', overrides: Partial<Room> = {}) {
  seed({
    room: room(overrides),
    voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob', role)],
    stories: [story('s-1', 100, 'Add password reset')],
    you: { voterId: VOTER_ID, role },
  });
}

function castSlot() {
  return document.querySelector('[data-slot="cast"]') as HTMLElement;
}

beforeEach(() => {
  useRoomStore.setState(initialState);
  document.documentElement.removeAttribute('data-theme');
});

describe('CastPanel — deck rendering', () => {
  it('renders the resolved fibonacci deck as mono-valued cards', () => {
    seedActiveAsVoter();
    renderShell();
    const slot = castSlot();
    for (const v of ['1', '2', '3', '5', '8', '13', '21']) {
      const btn = within(slot).getByRole('radio', { name: v });
      expect(btn).toBeInTheDocument();
      expect(btn.className).toMatch(/font-mono/);
    }
  });

  it('renders a custom deck verbatim (including non-numeric cards)', () => {
    seedActiveAsVoter('voter', { deck: 'custom', customDeck: ['XS', 'M', 'XL', '?', '∞'] });
    renderShell();
    const slot = castSlot();
    for (const v of ['XS', 'M', 'XL', '?', '∞']) {
      expect(within(slot).getByRole('radio', { name: v })).toBeInTheDocument();
    }
  });
});

describe('CastPanel — confidence default and submit gate', () => {
  it('confidence defaults to 3 on entry', () => {
    seedActiveAsVoter();
    renderShell();
    const dot3 = screen.getByRole('radio', { name: 'Confidence 3' });
    expect(dot3.getAttribute('aria-checked')).toBe('true');
    expect(dot3.getAttribute('data-filled')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Confidence 4' }).getAttribute('data-filled')).toBe('false');
  });

  it('submit disabled until a card is picked; enabled once selected', async () => {
    seedActiveAsVoter();
    renderShell();
    const submit = screen.getByRole('button', { name: 'Cast estimate' });
    expect(submit).toBeDisabled();
    await userEvent.click(within(castSlot()).getByRole('radio', { name: '5' }));
    expect(submit).not.toBeDisabled();
  });
});

describe('CastPanel — VOTE_CAST send', () => {
  it('select 5 + submit → VOTE_CAST with default confidence 3', async () => {
    seedActiveAsVoter();
    const send = renderShell();
    await userEvent.click(within(castSlot()).getByRole('radio', { name: '5' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cast estimate' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('VOTE_CAST', { storyId: 's-1', points: '5', confidence: 3 });
  });

  it('select 8 + raise confidence to 5 + submit → VOTE_CAST with confidence 5', async () => {
    seedActiveAsVoter();
    const send = renderShell();
    await userEvent.click(within(castSlot()).getByRole('radio', { name: '8' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Confidence 5' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cast estimate' }));
    expect(send).toHaveBeenCalledWith('VOTE_CAST', { storyId: 's-1', points: '8', confidence: 5 });
  });

  it('non-numeric pick (?) sends the literal value', async () => {
    seedActiveAsVoter('voter', { deck: 'custom', customDeck: ['1', '2', '?', '∞'] });
    const send = renderShell();
    await userEvent.click(within(castSlot()).getByRole('radio', { name: '?' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cast estimate' }));
    expect(send).toHaveBeenCalledWith('VOTE_CAST', { storyId: 's-1', points: '?', confidence: 3 });
  });
});

describe('CastPanel — re-vote replaces', () => {
  it('with myVote seeded, the card is pre-selected and the button says "Update vote"', () => {
    seedActiveAsVoter();
    useRoomStore.setState((s) => ({ ...s, myVotes: { 's-1': { points: '5', confidence: 3 } } }));
    renderShell();
    expect(screen.getByRole('button', { name: 'Update vote' })).toBeInTheDocument();
    expect(within(castSlot()).getByRole('radio', { name: '5' }).getAttribute('aria-checked')).toBe('true');
  });

  it('changing the card and submitting sends a new VOTE_CAST with the replacement', async () => {
    seedActiveAsVoter();
    useRoomStore.setState((s) => ({ ...s, myVotes: { 's-1': { points: '5', confidence: 3 } } }));
    const send = renderShell();
    await userEvent.click(within(castSlot()).getByRole('radio', { name: '8' }));
    await userEvent.click(screen.getByRole('button', { name: 'Update vote' }));
    expect(send).toHaveBeenCalledWith('VOTE_CAST', { storyId: 's-1', points: '8', confidence: 3 });
  });
});

describe('CastPanel — spectator gating', () => {
  it('spectator sees the stage but no cast UI inside the reserved slot', () => {
    seedActiveAsVoter('spectator');
    renderShell();
    // Stage rendered (story heading + voting-open badge).
    expect(screen.getByRole('heading', { name: 'Add password reset' })).toBeInTheDocument();
    expect(screen.getByText('voting open')).toBeInTheDocument();
    // Slot exists but is empty for spectators.
    expect(castSlot()).not.toBeNull();
    expect(within(castSlot()).queryByRole('button')).not.toBeInTheDocument();
    expect(within(castSlot()).queryByRole('radio')).not.toBeInTheDocument();
  });
});
