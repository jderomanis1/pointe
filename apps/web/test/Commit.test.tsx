// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { RevealStats, Room, RoomSnapshot, Story, Vote, Voter } from '@pointe/shared';
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
function story(id: string, orderIndex: number, text: string, state: Story['state'] = 'revealed', overrides: Partial<Story> = {}): Story {
  return { id, roomId: 'r-1', orderIndex, text, state, edited: false, createdAt: 0, ...overrides };
}
function vote(voterId: string, points: string, confidence: number, storyId = 's-1'): Vote {
  return { storyId, voterId, points, confidence, submittedAt: 0, updatedAt: 0 };
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

function seed(snap: RoomSnapshot) {
  useRoomStore.setState(initialState);
  useRoomStore.getState().hydrate(snap);
  useRoomStore.getState().setConnection('connected');
}

function seedRevealedAs(
  asHost: boolean,
  votes: Vote[],
  stats: RevealStats,
  extraStories: Story[] = [],
) {
  seed({
    room: room(),
    voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben'), voter('v-cyd', 'Cyd')],
    stories: [story('s-1', 100, 'A story', 'revealed'), ...extraStories],
    you: { voterId: asHost ? HOST_ID : VOTER_ID, role: 'voter' },
  });
  useRoomStore.setState((s) => ({ ...s, revealed: { 's-1': { votes, stats } } }));
}

function finalEstimateSelector() {
  // The selector is the second radiogroup labelled "Story points" on the revealed
  // view (RevealStats has the median; CommitPanel has the picker). Find it via the
  // "Final estimate" heading scope.
  const heading = screen.getByText('Final estimate');
  const section = heading.closest('section')!;
  return within(section).getByRole('radiogroup', { name: 'Story points' });
}

beforeEach(() => {
  useRoomStore.setState(initialState);
  document.documentElement.removeAttribute('data-theme');
});

describe('Commit — host-only control', () => {
  it('host on a revealed story sees Final estimate selector + Commit button', () => {
    seedRevealedAs(true,
      [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 4)],
      { median: '5', outliers: [], avgConfidence: 4, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    );
    renderShell();
    expect(screen.getByText('Final estimate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit estimate' })).toBeInTheDocument();
  });

  it('non-host does not see the commit control', () => {
    seedRevealedAs(false,
      [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 4)],
      { median: '5', outliers: [], avgConfidence: 4, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    );
    renderShell();
    expect(screen.queryByText('Final estimate')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commit estimate' })).not.toBeInTheDocument();
  });
});

describe('Commit — default median + override', () => {
  it("pre-selects the median (5) and commits 5 without changing the pick", async () => {
    seedRevealedAs(true,
      [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 4), vote('v-cyd', '5', 3)],
      { median: '5', outliers: [], avgConfidence: 3.7, lowConfidence: false, nonNumeric: [], numericCount: 3 },
    );
    const send = renderShell();

    const selector = finalEstimateSelector();
    expect(within(selector).getByRole('radio', { name: '5' }).getAttribute('aria-checked')).toBe('true');

    await userEvent.click(screen.getByRole('button', { name: 'Commit estimate' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('COMMIT_STORY', { storyId: 's-1', finalEstimate: '5' });
  });

  it('override: pick 8 and commit → COMMIT_STORY with finalEstimate 8', async () => {
    seedRevealedAs(true,
      [vote(HOST_ID, '5', 4), vote(VOTER_ID, '13', 3)],
      { median: '5', outliers: [VOTER_ID], avgConfidence: 3.5, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    );
    const send = renderShell();

    const selector = finalEstimateSelector();
    await userEvent.click(within(selector).getByRole('radio', { name: '8' }));
    await userEvent.click(screen.getByRole('button', { name: 'Commit estimate' }));
    expect(send).toHaveBeenCalledWith('COMMIT_STORY', { storyId: 's-1', finalEstimate: '8' });
  });
});

describe('Commit — no numeric median', () => {
  it('all-non-numeric reveal → no pre-selection, commit disabled; pick a card → enabled → commits it', async () => {
    seedRevealedAs(true,
      [vote(HOST_ID, '?', 3), vote(VOTER_ID, '?', 3)],
      { median: null, outliers: [], avgConfidence: null, lowConfidence: false, nonNumeric: [HOST_ID, VOTER_ID], numericCount: 0 },
    );
    const send = renderShell();

    const selector = finalEstimateSelector();
    // Nothing pre-selected on the selector — every radio is unchecked.
    for (const r of within(selector).getAllByRole('radio')) {
      expect(r.getAttribute('aria-checked')).toBe('false');
    }
    const button = screen.getByRole('button', { name: 'Commit estimate' });
    expect(button).toBeDisabled();

    await userEvent.click(within(selector).getByRole('radio', { name: '3' }));
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(send).toHaveBeenCalledWith('COMMIT_STORY', { storyId: 's-1', finalEstimate: '3' });
  });
});

describe('Committed display — queue row', () => {
  it('committed stories render their finalEstimate (mono) in the queue; they are not in the stage', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [
        story('s-done', 50, 'Wired auth', 'committed', { finalEstimate: '8' }),
        story('s-next', 100, 'Refactor login', 'pending'),
      ],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    renderShell();
    // No stage — no active or revealed story.
    expect(screen.queryByText('voting open')).not.toBeInTheDocument();
    expect(screen.queryByText('revealed')).not.toBeInTheDocument();
    // The finalEstimate is rendered in the queue row, mono, labeled.
    const finalEstimate = screen.getByLabelText('Final estimate 8');
    expect(finalEstimate).toBeInTheDocument();
    expect(finalEstimate.className).toMatch(/font-mono/);
    expect(finalEstimate.textContent).toBe('8');
  });
});

describe('Fix 08 — long-text truncation', () => {
  const SHORT = 'A normal short description.';
  // 320 chars — comfortably over the 280 limit.
  const LONG = 'A'.repeat(140) + ' ' + 'B'.repeat(179);

  it('description ≤ 280 chars → no toggle, full text shown', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'A short story', 'active', { description: SHORT })],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.getByText(SHORT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show full description' })).not.toBeInTheDocument();
  });

  it('description > 280 chars → truncated + "Show full description" toggle; click reveals full', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'A story', 'active', { description: LONG })],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();

    const toggle = screen.getByRole('button', { name: 'Show full description' });
    expect(toggle).toBeInTheDocument();
    // Before expansion the full text is NOT all present (the ellipsis chopped the tail).
    expect(document.body.textContent ?? '').not.toContain(LONG);

    await userEvent.click(toggle);
    expect(document.body.textContent ?? '').toContain(LONG);
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('SI-04: long-text stays escaped — no innerHTML injection from a story description', () => {
    const evilText = '<img src=x onerror=alert(1)>';
    // Pad it past the limit so we go through the LongText render path.
    const padded = evilText + ' ' + 'C'.repeat(LONG_TEXT_LIMIT_LOCAL);
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'A story', 'active', { description: padded })],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    // No real <img> element materialised — React escaped the text.
    expect(document.querySelector('img')).toBeNull();
    // The literal escaped string survives as text content.
    expect(document.body.textContent ?? '').toContain('<img src=x onerror=alert(1)>');
  });
});

// Local constant to keep the SI-04 test self-contained (no import of internals).
const LONG_TEXT_LIMIT_LOCAL = 280;
