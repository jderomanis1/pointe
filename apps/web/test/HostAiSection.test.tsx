// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AISuggestion, Room, RoomSnapshot, Story, Voter } from '@pointe/shared';
import { RoomShell } from '../src/components/room/RoomShell';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';
import { useRoomStore } from '../src/store/roomStore';
import { initialState } from '../src/store/reducer';

const SLUG = 'apt-sparrow-16';
const HOST_ID = 'host-1';
const VOTER_ID = 'voter-1';
const STORY_ID = 's-1';

const READY: Extract<AISuggestion, { state: 'ready' }> = {
  state: 'ready',
  complexity: { level: 'medium', note: 'c' },
  effort: { level: 'low', note: 'e' },
  risk: { level: 'low', note: 'r' },
  unknowns: { level: 'low', note: 'u' },
  suggestedRange: { low: '3', high: '5' },
  rationale: 'because',
  shared: false,
};

function room(): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'sync',
    state: 'active', hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function story(id: string, text: string, state: Story['state'] = 'active', ai?: AISuggestion): Story {
  return { id, roomId: 'r-1', orderIndex: 100, text, state, edited: false, createdAt: 0, ai };
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

describe('HostAiSection — host-only render (AA-1 affordance gate)', () => {
  it('host on an active story sees the "Ask AI" affordance', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [story(STORY_ID, 'Reset password', 'active')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.getByRole('button', { name: /Ask AI/i })).toBeInTheDocument();
  });

  it('voter on the SAME active story does NOT see the affordance nor the panel', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
      stories: [story(STORY_ID, 'Reset password', 'active')], // no ai by AA-1
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    // No ask button.
    expect(screen.queryByRole('button', { name: /Ask AI/i })).not.toBeInTheDocument();
    // No panel — sub-caption / dimensions / range absent too.
    expect(screen.queryByText('Visible to you only')).not.toBeInTheDocument();
    expect(screen.queryByText('AI suggestion')).not.toBeInTheDocument();
    expect(screen.queryByText('Suggested range')).not.toBeInTheDocument();
  });

  it('host does NOT see the affordance on a non-active story (pre-reveal only this slice)', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      // pending story — not active
      stories: [story(STORY_ID, 'A', 'pending')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: /Ask AI/i })).not.toBeInTheDocument();
  });
});

describe('HostAiSection — REQUEST_AI wiring + optimistic asking', () => {
  it('clicking "Ask AI" sends REQUEST_AI { storyId } and transitions to the "Asking…" state', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story(STORY_ID, 'Reset password', 'active')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();
    await userEvent.click(screen.getByRole('button', { name: /Ask AI/i }));
    expect(send).toHaveBeenCalledWith('REQUEST_AI', { storyId: STORY_ID });
    // Optimistic transition.
    expect(screen.getByText('Asking…')).toBeInTheDocument();
    // The ask button is gone.
    expect(screen.queryByRole('button', { name: /Ask AI/i })).not.toBeInTheDocument();
  });

  it('an incoming ai_updated ready DELTA transitions asking → panel; cancel button gone', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story(STORY_ID, 'Reset password', 'active')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: /Ask AI/i }));
    expect(screen.getByText('Asking…')).toBeInTheDocument();
    // Server side-effect: ai_updated DELTA lands → reducer applies it.
    act(() => {
      useRoomStore.getState().applyServerDelta({
        changes: [{ kind: 'ai_updated', storyId: STORY_ID, ai: READY }],
      });
    });
    // Panel renders.
    await waitFor(() => expect(screen.getByText('Visible to you only')).toBeInTheDocument());
    expect(screen.getByText('Suggested range')).toBeInTheDocument();
    expect(screen.queryByText('Asking…')).not.toBeInTheDocument();
  });

  it('a failed ai_updated DELTA renders the failed panel + a Retry affordance; clicking Retry re-sends REQUEST_AI', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story(STORY_ID, 'Reset password', 'active')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();
    await userEvent.click(screen.getByRole('button', { name: /Ask AI/i }));
    act(() => {
      useRoomStore.getState().applyServerDelta({
        changes: [{
          kind: 'ai_updated', storyId: STORY_ID,
          ai: { state: 'failed', errorMessage: 'TIMEOUT' },
        }],
      });
    });
    await waitFor(() => expect(screen.getByText(/AI unavailable/i)).toBeInTheDocument());
    const retry = screen.getByRole('button', { name: /Retry/i });
    expect(retry).toBeInTheDocument();
    send.mockClear();
    await userEvent.click(retry);
    expect(send).toHaveBeenCalledWith('REQUEST_AI', { storyId: STORY_ID });
  });

  it('hydrate already-ready (e.g. host reconnect with story.ai populated) → panel without asking', () => {
    // Reconnect path: the snapshot carries the host's story.ai already.
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host')],
      stories: [story(STORY_ID, 'Reset password', 'active', READY)],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.getByText('Visible to you only')).toBeInTheDocument();
    expect(screen.getByText('Suggested range')).toBeInTheDocument();
    expect(screen.queryByText('Asking…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ask AI/i })).not.toBeInTheDocument();
  });
});
