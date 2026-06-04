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
const V1 = 'v-1';
const V2 = 'v-2';
const V3 = 'v-3';

function room(state: 'lobby' | 'active' | 'review' = 'review'): Room {
  return {
    id: 'r-1', slug: SLUG, deck: 'fibonacci', mode: 'async',
    state, hostVoterId: HOST_ID, createdAt: 0, lastActivityAt: 0,
  };
}
function voter(id: string, displayName: string, role: Voter['role'] = 'voter'): Voter {
  return { id, roomId: 'r-1', displayName, role, connectionState: 'connected', lastSeenAt: 0, joinedAt: 0 };
}
function story(id: string, text: string, needsDiscussion = false): Story {
  return {
    id, roomId: 'r-1', orderIndex: 100, text, state: 'revealed',
    edited: false, createdAt: 0,
    ...(needsDiscussion ? { needsDiscussion: true } : {}),
  };
}
function vote(storyId: string, voterId: string, points: string, confidence: number): Vote {
  return { storyId, voterId, points, confidence, submittedAt: 0, updatedAt: 0 };
}

function statsOf(votes: Vote[], deck: string[] = ['1','2','3','5','8','13','21']): RevealStats {
  // Mirrors computeRevealStats; we don't need byte-equality here, the
  // reducer recomputes via the real shared function on hydrate.
  void deck;
  const numeric = votes.filter((v) => ['1','2','3','5','8','13','21'].includes(v.points));
  if (numeric.length === 0) {
    return { median: null, outliers: [], avgConfidence: null, lowConfidence: false, nonNumeric: votes.map((v) => v.voterId), numericCount: 0 };
  }
  // Simpler: defer to the real fn by leaving stats:null in the snapshot —
  // applySnapshot recomputes for us.
  throw new Error('use computeRevealStats path');
}
void statsOf;

/**
 * Seed a review-state room with N revealed stories + their votes. The
 * snapshot reducer recomputes stats client-side via the shared pure fn —
 * exactly the production hydrate path. No mocked stats anywhere.
 */
function seedReview(opts: { meVoterId: string; stories: Array<{ id: string; text: string; needsDiscussion: boolean; votes: { voterId: string; points: string; confidence: number }[] }>; }) {
  const voters: Voter[] = [
    voter(HOST_ID, 'Alice', 'host'),
    voter(V1, 'Ben'),
    voter(V2, 'Cleo'),
    voter(V3, 'Dax'),
  ];
  const stories: (Story & { votes?: Vote[] })[] = opts.stories.map((s, i) => ({
    ...story(s.id, s.text, s.needsDiscussion),
    orderIndex: (i + 1) * 100,
    revealedAt: 100 + i,
    votes: s.votes.map((v) => vote(s.id, v.voterId, v.points, v.confidence)),
  }));
  const snap: RoomSnapshot = {
    room: room('review'),
    voters,
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

beforeEach(() => {
  useRoomStore.setState(initialState);
  document.documentElement.removeAttribute('data-theme');
});

// ---- Visibility + summary --------------------------------------------------

describe('<ReviewHostScreen /> — visibility + summary', () => {
  it('renders when room.state === "review" + host viewer; voter sees the voter screen instead', () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [
        { id: 's-1', text: 'one', needsDiscussion: false, votes: [
          { voterId: V1, points: '5', confidence: 5 }, { voterId: V2, points: '5', confidence: 5 },
        ] },
      ],
    });
    renderShell();
    expect(document.querySelector('[data-slot="review-host-screen"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="review-voter-screen"]')).not.toBeInTheDocument();
  });

  it('summary distillation reads "N stories · X agreed · Y need discussion"', () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [
        { id: 's-a1', text: 'a1', needsDiscussion: false, votes: [
          { voterId: V1, points: '5', confidence: 5 }, { voterId: V2, points: '5', confidence: 5 },
        ] },
        { id: 's-a2', text: 'a2', needsDiscussion: false, votes: [
          { voterId: V1, points: '8', confidence: 5 }, { voterId: V2, points: '8', confidence: 5 },
        ] },
        { id: 's-d1', text: 'd1', needsDiscussion: true, votes: [
          { voterId: V1, points: '5', confidence: 4 }, { voterId: V2, points: '13', confidence: 4 },
        ] },
      ],
    });
    renderShell();
    const summary = document.querySelector('[data-slot="review-summary"]') as HTMLElement;
    expect(summary.textContent).toMatch(/3.*stories.*2.*agreed.*1.*need discussion/);
  });
});

// ---- The three discuss-card variants (visual heart of the pillar) ----------

describe('<ReviewHostScreen /> — discuss card variants', () => {
  it('SPLIT-ONLY: outlier (13 among 5s, confidence 5/5/5) → "Split vote" chip + spread, NO confidence meter', () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [{
        id: 's-split', text: 'split-only', needsDiscussion: true,
        votes: [
          { voterId: V1, points: '5',  confidence: 5 },
          { voterId: V2, points: '5',  confidence: 5 },
          { voterId: V3, points: '13', confidence: 5 },
        ],
      }],
    });
    renderShell();
    const card = document.querySelector('[data-slot="discuss-card"]') as HTMLElement;
    expect(card).toBeInTheDocument();
    expect(card.getAttribute('data-has-outlier')).toBe('true');
    expect(card.getAttribute('data-low-confidence')).toBe('false');
    // Split chip present; low-confidence chip absent.
    expect(within(card).getByText(/Split vote/)).toBeInTheDocument();
    expect(within(card).queryByText(/Low confidence/)).not.toBeInTheDocument();
    // Vote spread present; confidence band absent.
    expect(card.querySelector('[data-slot="vote-spread"]')).toBeInTheDocument();
    expect(card.querySelector('[data-slot="confidence-band"]')).not.toBeInTheDocument();
    // The outlier face is flagged.
    const outlierFace = card.querySelector(`[data-vote-voter="${V3}"]`) as HTMLElement;
    expect(outlierFace.getAttribute('data-vote-outlier')).toBe('true');
    // Non-outlier faces are not flagged.
    expect(card.querySelector(`[data-vote-voter="${V1}"]`)?.getAttribute('data-vote-outlier')).toBe('false');
  });

  it('LOW-CONFIDENCE ONLY: clustered (5/5/5) at confidence 2/2/2 → "Low confidence" chip + meter + advisory, NO split chip, NO outlier spread', () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [{
        id: 's-lowconf', text: 'low-confidence only', needsDiscussion: true,
        votes: [
          { voterId: V1, points: '5', confidence: 2 },
          { voterId: V2, points: '5', confidence: 2 },
          { voterId: V3, points: '5', confidence: 2 },
        ],
      }],
    });
    renderShell();
    const card = document.querySelector('[data-slot="discuss-card"]') as HTMLElement;
    expect(card.getAttribute('data-has-outlier')).toBe('false');
    expect(card.getAttribute('data-low-confidence')).toBe('true');
    expect(within(card).queryByText(/Split vote/)).not.toBeInTheDocument();
    expect(within(card).getByText(/Low confidence/)).toBeInTheDocument();
    expect(card.querySelector('[data-slot="vote-spread"]')).not.toBeInTheDocument();
    const band = card.querySelector('[data-slot="confidence-band"]') as HTMLElement;
    expect(band).toBeInTheDocument();
    // The advisory line is the human framing — uses curly apostrophe.
    expect(band.textContent).toMatch(/The team agreed on/);
    expect(band.textContent).toMatch(/isn(?:'|’)t sure/);
  });

  it('BOTH: outlier + low-confidence (5/5/13 at 2/2/2) → both chips, spread AND meter both rendered', () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [{
        id: 's-both', text: 'both', needsDiscussion: true,
        votes: [
          { voterId: V1, points: '5',  confidence: 2 },
          { voterId: V2, points: '5',  confidence: 2 },
          { voterId: V3, points: '13', confidence: 2 },
        ],
      }],
    });
    renderShell();
    const card = document.querySelector('[data-slot="discuss-card"]') as HTMLElement;
    expect(card.getAttribute('data-has-outlier')).toBe('true');
    expect(card.getAttribute('data-low-confidence')).toBe('true');
    expect(within(card).getByText(/Split vote/)).toBeInTheDocument();
    expect(within(card).getByText(/Low confidence/)).toBeInTheDocument();
    expect(card.querySelector('[data-slot="vote-spread"]')).toBeInTheDocument();
    expect(card.querySelector('[data-slot="confidence-band"]')).toBeInTheDocument();
  });
});

// ---- Host controls: Accept all + Discuss live ------------------------------

describe('<ReviewHostScreen /> — host controls', () => {
  it('Accept all sends ACCEPT_AGREED with empty payload', async () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [
        { id: 's-a', text: 'agreed', needsDiscussion: false, votes: [
          { voterId: V1, points: '5', confidence: 5 }, { voterId: V2, points: '5', confidence: 5 },
        ] },
      ],
    });
    const send = renderShell();
    await userEvent.click(screen.getByRole('button', { name: /Accept all 1/i }));
    expect(send).toHaveBeenCalledWith('ACCEPT_AGREED', {});
  });

  it('Discuss live sends OPEN_DISCUSSION with the right storyId', async () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [
        { id: 's-d', text: 'discuss', needsDiscussion: true, votes: [
          { voterId: V1, points: '5',  confidence: 4 },
          { voterId: V2, points: '13', confidence: 4 },
        ] },
      ],
    });
    const send = renderShell();
    await userEvent.click(screen.getByRole('button', { name: /Discuss live/i }));
    expect(send).toHaveBeenCalledWith('OPEN_DISCUSSION', { storyId: 's-d' });
  });

  it('Agreed strip toggles open via "+ N more"; agreed rows render with title + mono median, no checkbox / no per-row commit button', async () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [
        { id: 's-a1', text: 'first agreed', needsDiscussion: false, votes: [
          { voterId: V1, points: '5', confidence: 5 }, { voterId: V2, points: '5', confidence: 5 },
        ] },
        { id: 's-a2', text: 'second agreed', needsDiscussion: false, votes: [
          { voterId: V1, points: '8', confidence: 5 }, { voterId: V2, points: '8', confidence: 5 },
        ] },
      ],
    });
    renderShell();
    // Collapsed initially.
    expect(document.querySelector('[data-slot="agreed-expand-list"]')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /\+ 2 more/i }));
    const list = document.querySelector('[data-slot="agreed-expand-list"]') as HTMLElement;
    expect(list).toBeInTheDocument();
    // Both stories present with their medians in mono.
    expect(within(list).getByText('first agreed')).toBeInTheDocument();
    expect(within(list).getByText('second agreed')).toBeInTheDocument();
    const medians = list.querySelectorAll('[data-slot="agreed-median"]');
    expect(Array.from(medians).map((m) => m.textContent)).toEqual(['5', '8']);
    // No checkbox, no per-row commit button.
    expect(within(list).queryAllByRole('checkbox')).toEqual([]);
    expect(within(list).queryByRole('button', { name: /commit/i })).not.toBeInTheDocument();
  });
});

// ---- Null-median agreed visible somewhere ----------------------------------

describe('<ReviewHostScreen /> — null-median agreed story is surfaced', () => {
  it('all-? story (median:null, !needs_discussion) appears in the agreed expand with "—" + "no estimate" caption', async () => {
    seedReview({
      meVoterId: HOST_ID,
      stories: [
        { id: 's-?', text: 'all questions', needsDiscussion: false, votes: [
          { voterId: V1, points: '?', confidence: 4 },
          { voterId: V2, points: '?', confidence: 4 },
          { voterId: V3, points: '?', confidence: 4 },
        ] },
      ],
    });
    renderShell();
    // Even with zero numeric-agreed, the no-estimate count is visible in the
    // strip header so the host knows there's a story needing manual touch.
    const strip = document.querySelector('[data-slot="agreed-strip"]') as HTMLElement;
    expect(within(strip).getByText(/no estimate/i)).toBeInTheDocument();
    // Expand to see the row.
    await userEvent.click(screen.getByRole('button', { name: /\+ 1 more/i }));
    const list = document.querySelector('[data-slot="agreed-expand-list"]') as HTMLElement;
    const row = list.querySelector('[data-bucket="no-estimate"]') as HTMLElement;
    expect(row).toBeInTheDocument();
    expect(row.textContent).toContain('—');
    expect(row.textContent).toContain('no estimate');
    expect(row.textContent).toContain('all questions');
  });
});

// ---- No hardcoded hex on touched files -------------------------------------

describe('S9.iii.c1 — no hardcoded hex', () => {
  it('ReviewHostScreen.tsx has no hardcoded hex literals', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/components/room/ReviewHostScreen.tsx', 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
