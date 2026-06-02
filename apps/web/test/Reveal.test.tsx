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
function story(id: string, orderIndex: number, text: string, state: Story['state'] = 'active'): Story {
  return { id, roomId: 'r-1', orderIndex, text, state, edited: false, createdAt: 0 };
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

function seedRevealed({
  asRole = 'voter' as Voter['role'],
  votes,
  stats,
  storyState = 'revealed' as Story['state'],
}: {
  asRole?: Voter['role'];
  votes: Vote[];
  stats: RevealStats;
  storyState?: Story['state'];
}) {
  seed({
    room: room(),
    voters: [
      voter(HOST_ID, 'Alice', 'host'),
      voter(VOTER_ID, 'Ben', asRole),
      voter('v-cyd', 'Cyd'),
      voter('v-dax', 'Dax'),
    ],
    stories: [story('s-1', 100, 'Pillar 3 story', storyState)],
    you: { voterId: VOTER_ID, role: asRole },
  });
  // Hydrate the revealed slot manually — applySnapshot already does this for
  // snapshots carrying votes, but seeding directly keeps the test focused on
  // rendering not the reducer plumbing.
  useRoomStore.setState((s) => ({ ...s, revealed: { 's-1': { votes, stats } } }));
}

beforeEach(() => {
  useRoomStore.setState(initialState);
  document.documentElement.removeAttribute('data-theme');
});

describe('Reveal — host control', () => {
  it('host on an active story sees "Reveal votes"; click → send REVEAL_VOTES { storyId }', async () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'A story', 'active')],
      you: { voterId: HOST_ID, role: 'voter' },
    });
    const send = renderShell();
    const btn = screen.getByRole('button', { name: 'Reveal votes' });
    await userEvent.click(btn);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('REVEAL_VOTES', { storyId: 's-1' });
  });

  it('non-host does not see the reveal control', () => {
    seed({
      room: room(),
      voters: [voter(HOST_ID, 'Alice', 'host'), voter(VOTER_ID, 'Ben')],
      stories: [story('s-1', 100, 'A story', 'active')],
      you: { voterId: VOTER_ID, role: 'voter' },
    });
    renderShell();
    expect(screen.queryByRole('button', { name: 'Reveal votes' })).not.toBeInTheDocument();
  });

  it('reveal control is absent after the story is already revealed (no double-reveal)', () => {
    seedRevealed({
      votes: [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 3)],
      stats: { median: '5', outliers: [], avgConfidence: 3.5, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    });
    // Re-set me to the host so we'd see the control if it were still rendered.
    useRoomStore.setState((s) => ({ ...s, me: { voterId: HOST_ID, role: 'voter' } }));
    renderShell();
    expect(screen.queryByRole('button', { name: 'Reveal votes' })).not.toBeInTheDocument();
  });
});

describe('Reveal — ANTI-ANCHORING INVERSE (the load-bearing test)', () => {
  it('post-reveal, peer values are present in the DOM — symmetric counterpart to R5.ii', () => {
    // Two peers with values that R5.ii made literally invisible. After reveal,
    // they're public — these exact strings must now appear in the rendered tree.
    seedRevealed({
      votes: [
        vote(HOST_ID, '13', 5),         // Alice (peer to Ben)
        vote(VOTER_ID, '5', 3),         // Ben (us)
        vote('v-cyd', '13', 4),         // Cyd (peer)
        vote('v-dax', '21', 2),         // Dax (peer)
      ],
      stats: {
        // Stats are server-computed truth — we render whatever the wire delivered.
        median: '13',
        outliers: ['v-dax'],
        avgConfidence: 3.5,
        lowConfidence: false,
        nonNumeric: [],
        numericCount: 4,
      },
    });
    renderShell();

    const aliceSeat = screen.getByTestId(`seat-${HOST_ID}`);
    const cydSeat = screen.getByTestId('seat-v-cyd');
    const daxSeat = screen.getByTestId('seat-v-dax');
    const benSeat = screen.getByTestId(`seat-${VOTER_ID}`);

    // The inverse of R5.ii: peer points are now part of the seat's text.
    expect(aliceSeat.textContent).toContain('13');
    expect(cydSeat.textContent).toContain('13');
    expect(daxSeat.textContent).toContain('21');
    expect(benSeat.textContent).toContain('5');

    // data-revealed marker present.
    expect(aliceSeat.getAttribute('data-revealed')).toBe('true');
    expect(daxSeat.getAttribute('data-outlier')).toBe('true');
    expect(aliceSeat.getAttribute('data-outlier')).toBe('false');
  });
});

describe('Reveal — median hero', () => {
  it("stats.median '5' renders as a mono num-hero element", () => {
    seedRevealed({
      votes: [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 3), vote('v-cyd', '5', 4)],
      stats: { median: '5', outliers: [], avgConfidence: 3.7, lowConfidence: false, nonNumeric: [], numericCount: 3 },
    });
    renderShell();
    const median = screen.getByLabelText('Median 5');
    expect(median).toBeInTheDocument();
    expect(median.className).toMatch(/font-mono/);
    expect(median.className).toMatch(/text-num-hero/);
    expect(median.textContent).toBe('5');
  });
});

describe('Reveal — low-confidence flag (Pillar 3 payoff)', () => {
  it('lowConfidence true → amber flag message present', () => {
    seedRevealed({
      votes: [vote(HOST_ID, '5', 2), vote(VOTER_ID, '5', 2), vote('v-cyd', '5', 2)],
      stats: { median: '5', outliers: [], avgConfidence: 2.0, lowConfidence: true, nonNumeric: [], numericCount: 3 },
    });
    renderShell();
    expect(screen.getByRole('status')).toHaveTextContent(/may need more refinement/);
  });

  it('lowConfidence false → no flag', () => {
    seedRevealed({
      votes: [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 5)],
      stats: { median: '5', outliers: [], avgConfidence: 4.5, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    });
    renderShell();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('Reveal — outlier marking', () => {
  it("stats.outliers includes a voter → that seat gets data-outlier=true + 'outlier' aria-label", () => {
    seedRevealed({
      votes: [vote(HOST_ID, '3', 4), vote(VOTER_ID, '3', 3), vote('v-cyd', '13', 4)],
      stats: { median: '3', outliers: ['v-cyd'], avgConfidence: 3.7, lowConfidence: false, nonNumeric: [], numericCount: 3 },
    });
    renderShell();
    const cydSeat = screen.getByTestId('seat-v-cyd');
    expect(cydSeat.getAttribute('data-outlier')).toBe('true');
    expect(within(cydSeat).getByLabelText('outlier')).toBeInTheDocument();
    expect(screen.getByTestId(`seat-${HOST_ID}`).getAttribute('data-outlier')).toBe('false');
    // Outliers list surfaces Cyd's name (it also appears in the roster — both legitimate).
    const outliersDt = screen.getByText('Outliers', { selector: 'dt' });
    const outliersDd = outliersDt.nextElementSibling as HTMLElement;
    expect(outliersDd.textContent).toContain('Cyd');
  });
});

describe('Reveal — non-numeric votes', () => {
  it('all-non-numeric → "Needs discussion" instead of a median', () => {
    seedRevealed({
      votes: [vote(HOST_ID, '?', 3), vote(VOTER_ID, '?', 3)],
      stats: { median: null, outliers: [], avgConfidence: null, lowConfidence: false, nonNumeric: [HOST_ID, VOTER_ID], numericCount: 0 },
    });
    renderShell();
    expect(screen.getByText('Needs discussion')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Median/)).not.toBeInTheDocument();
  });

  it('mixed numeric + non-numeric → median over numerics, non-numeric voters flagged needs-discussion', () => {
    seedRevealed({
      votes: [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 3), vote('v-cyd', '?', 2)],
      stats: { median: '5', outliers: [], avgConfidence: 3.5, lowConfidence: false, nonNumeric: ['v-cyd'], numericCount: 2 },
    });
    renderShell();
    expect(screen.getByLabelText('Median 5')).toBeInTheDocument();
    // Needs-discussion dt + Cyd's name.
    const ndDt = screen.getByText('Needs discussion', { selector: 'dt' });
    expect(ndDt).toBeInTheDocument();
    const ndDd = ndDt.nextElementSibling as HTMLElement;
    expect(ndDd.textContent).toContain('Cyd');
  });
});

describe('Reveal — graceful zero-vote', () => {
  it('revealed with no votes → calm empty state, no median, no NaN, no crash', () => {
    seedRevealed({
      votes: [],
      stats: { median: null, outliers: [], avgConfidence: null, lowConfidence: false, nonNumeric: [], numericCount: 0 },
    });
    renderShell();
    expect(screen.getByText(/No votes cast/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Median/)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('NaN');
  });
});

describe('Reveal — cast UI gone after reveal', () => {
  it('no cast slot rendered post-reveal — voters see stats, not the deck', () => {
    seedRevealed({
      votes: [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 3)],
      stats: { median: '5', outliers: [], avgConfidence: 3.5, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    });
    renderShell();
    expect(document.querySelector('[data-slot="cast"]')).toBeNull();
  });
});

describe('Reveal — animation gating', () => {
  it('hydrate of an already-revealed story does NOT apply the median pop class', () => {
    seedRevealed({
      votes: [vote(HOST_ID, '5', 4), vote(VOTER_ID, '5', 3)],
      stats: { median: '5', outliers: [], avgConfidence: 3.5, lowConfidence: false, nonNumeric: [], numericCount: 2 },
    });
    renderShell();
    // First render with state already 'revealed' → no anim-reveal-* on the median.
    const median = screen.getByLabelText('Median 5');
    expect(median.className).not.toMatch(/anim-reveal-median/);
  });
});
