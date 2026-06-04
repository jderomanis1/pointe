// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type {
  AISuggestion, Room, RoomSnapshot, Story, Vote, Voter,
} from '@pointe/shared';
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
function story(
  id: string, text: string, state: Story['state'] = 'revealed', ai?: AISuggestion,
): Story {
  return { id, roomId: 'r-1', orderIndex: 100, text, state, edited: false, createdAt: 0, ai };
}

/** A revealed story snapshot with votes the test runner can chew on. The
 *  reducer recomputes stats client-side via the shared pure function. */
function revealedSnapshot(opts: {
  meVoterId: string;
  hostAi?: AISuggestion;
}): RoomSnapshot {
  const votes: Vote[] = [
    { storyId: STORY_ID, voterId: VOTER_ID, points: '5', confidence: 4, submittedAt: 0, updatedAt: 0 },
    { storyId: STORY_ID, voterId: HOST_ID, points: '5', confidence: 5, submittedAt: 0, updatedAt: 0 },
  ];
  return {
    room: room(),
    voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Bob')],
    // Only the host's snapshot would actually carry `ai`; voter's projection
    // strips it. We pass it in via `hostAi` so tests can choose what each
    // viewer's hydrate looks like.
    stories: [{ ...story(STORY_ID, 'Reset password', 'revealed', opts.hostAi), votes }],
    you: { voterId: opts.meVoterId, role: 'voter' },
  };
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

// ---- The AA-1 guarantee at reveal -------------------------------------------

describe('S8.iv.c3 — voter at reveal, pre-share: no AI panel anywhere (AA-1)', () => {
  it('voter snapshot has no story.ai → no panel renders; team result remains', () => {
    seed(revealedSnapshot({ meVoterId: VOTER_ID })); // no hostAi → voter has no ai
    renderShell();

    // Team result block IS present.
    expect(screen.getByLabelText(/Median 5/i)).toBeInTheDocument();
    // The AI panel and its parts are absent.
    expect(screen.queryByLabelText('AI suggestion')).not.toBeInTheDocument();
    expect(screen.queryByText('Suggested range')).not.toBeInTheDocument();
    expect(screen.queryByText('Shared by the host')).not.toBeInTheDocument();
    expect(screen.queryByText('Visible to you only')).not.toBeInTheDocument();
    // And of course no share affordance leaks to a voter.
    expect(screen.queryByRole('button', { name: /Share with the team/i })).not.toBeInTheDocument();
  });
});

// ---- Host: panel + share button below the stats -----------------------------

describe('S8.iv.c3 — host at reveal: panel + armed share button below the team result', () => {
  it('renders the panel + the "Share with the team" button BELOW the team-result block', () => {
    seed(revealedSnapshot({ meVoterId: HOST_ID, hostAi: READY }));
    renderShell();

    const median = screen.getByLabelText(/Median 5/i);
    const panel = screen.getByLabelText('AI suggestion');
    expect(panel).toBeInTheDocument();
    // DOM order: the team-result median appears before the AI panel.
    const cmp = median.compareDocumentPosition(panel);
    // Node.DOCUMENT_POSITION_FOLLOWING = 4 — panel follows median.
    expect(cmp & 4).toBe(4);
    // The armed share button is in the panel.
    const share = screen.getByRole('button', { name: /Share with the team/i });
    expect(share).toBeInTheDocument();
    expect(screen.getByText('Visible to you only')).toBeInTheDocument();
  });

  it('clicking the share button sends SHARE_AI { storyId }', async () => {
    seed(revealedSnapshot({ meVoterId: HOST_ID, hostAi: READY }));
    const send = renderShell();
    await userEvent.click(screen.getByRole('button', { name: /Share with the team/i }));
    expect(send).toHaveBeenCalledWith('SHARE_AI', { storyId: STORY_ID });
  });
});

// ---- The end-to-end flip: AI_SHARED → voter renders read-only panel ---------

describe('S8.iv.c3 — voter post-share: AI_SHARED populates story.ai → panel renders read-only', () => {
  it('AI_SHARED arrives → panel mounts read-only; no share button; "Shared by the host" label present', async () => {
    seed(revealedSnapshot({ meVoterId: VOTER_ID })); // pre-share
    renderShell();
    expect(screen.queryByLabelText('AI suggestion')).not.toBeInTheDocument();

    // The host shared — voter receives AI_SHARED.
    act(() => {
      useRoomStore.getState().applyAiShared({
        storyId: STORY_ID,
        ai: { ...READY, shared: true },
      });
    });

    await waitFor(() => expect(screen.getByLabelText('AI suggestion')).toBeInTheDocument());
    expect(screen.queryByText('Visible to you only')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Share with the team/i })).not.toBeInTheDocument();
    expect(screen.getByText('Shared by the host')).toBeInTheDocument();
    // CERU content rendered for the voter (read-only).
    expect(screen.getByText('Suggested range')).toBeInTheDocument();
    expect(screen.getByText('Complexity')).toBeInTheDocument();
  });
});

// ---- The host's share flip — c2 in action at the panel level ---------------

describe('S8.iv.c3 — host share flip end-to-end', () => {
  it('AI_SHARED arrives on host → share button + "Visible to you only" gone; "Shared with the team" appears', async () => {
    seed(revealedSnapshot({ meVoterId: HOST_ID, hostAi: READY }));
    renderShell();
    expect(screen.getByRole('button', { name: /Share with the team/i })).toBeInTheDocument();
    expect(screen.getByText('Visible to you only')).toBeInTheDocument();

    act(() => {
      useRoomStore.getState().applyAiShared({
        storyId: STORY_ID,
        ai: { ...READY, shared: true },
      });
    });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Share with the team/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Visible to you only')).not.toBeInTheDocument();
    expect(screen.getByText('Shared with the team')).toBeInTheDocument();
  });
});
