// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AISuggestion } from '@pointe/shared';
import { AiSuggestionPanel } from '../src/components/room/AiSuggestionPanel';

const READY: Extract<AISuggestion, { state: 'ready' }> = {
  state: 'ready',
  complexity: { level: 'medium', note: 'Token lifecycle, email, UI.' },
  effort: { level: 'low', note: 'Small surface.' },
  risk: { level: 'high', note: 'Token leak / replay.' },
  unknowns: { level: 'medium', note: 'Email provider TBD.' },
  suggestedRange: { low: '5', high: '8' },
  rationale: 'Magic-link reset is a well-known pattern; size pivots on email infra.',
  shared: false,
};

describe('<AiSuggestionPanel /> — ready variant', () => {
  it('renders the four CERU dimensions with level words + notes', () => {
    render(<AiSuggestionPanel ai={READY} />);
    // The four dimension names.
    expect(screen.getByText('Complexity')).toBeInTheDocument();
    expect(screen.getByText('Effort')).toBeInTheDocument();
    expect(screen.getByText('Risk')).toBeInTheDocument();
    expect(screen.getByText('Unknowns')).toBeInTheDocument();
    // The level words appear (lowercase, mono).
    expect(screen.getAllByText('medium').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('low').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('high')).toBeInTheDocument();
    // Notes render too.
    expect(screen.getByText('Token lifecycle, email, UI.')).toBeInTheDocument();
    expect(screen.getByText('Token leak / replay.')).toBeInTheDocument();
  });

  it('segmented indicators fill 1/2/3 bars per level (low/medium/high)', () => {
    render(<AiSuggestionPanel ai={READY} />);
    // Three indicators via role=img + aria-label that includes the level.
    const low = screen.getByRole('img', { name: /Effort low/i });
    const medium = screen.getByRole('img', { name: /Complexity medium/i });
    const high = screen.getByRole('img', { name: /Risk high/i });
    const filled = (el: HTMLElement) =>
      Array.from(el.querySelectorAll('span'))
        .filter((s) => s.className.includes('bg-warning')).length;
    expect(filled(low)).toBe(1);
    expect(filled(medium)).toBe(2);
    expect(filled(high)).toBe(3);
  });

  it('renders the suggested range in mono, with the low–high values', () => {
    render(<AiSuggestionPanel ai={READY} />);
    expect(screen.getByText('Suggested range')).toBeInTheDocument();
    // Range cell contains 5, an en-dash separator, and 8 inside a font-mono span.
    const range = screen.getByText('Suggested range').nextElementSibling as HTMLElement;
    expect(range).toBeTruthy();
    expect(range.className).toContain('font-mono');
    expect(range.textContent).toContain('5');
    expect(range.textContent).toContain('8');
  });

  it('renders the rationale text in a sans body', () => {
    render(<AiSuggestionPanel ai={READY} />);
    const r = screen.getByText(/well-known pattern/i);
    expect(r).toBeInTheDocument();
    expect(r.className).toContain('font-sans');
  });

  it('shows the "Visible to you only" sub-caption (privacy framing)', () => {
    render(<AiSuggestionPanel ai={READY} />);
    expect(screen.getByText('Visible to you only')).toBeInTheDocument();
  });

  it('has no share button in this slice (S8.iv only)', () => {
    render(<AiSuggestionPanel ai={READY} />);
    expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
  });
});

describe('<AiSuggestionPanel /> — failed variant', () => {
  it('renders "AI unavailable" + errorMessage, no CERU grid', () => {
    render(<AiSuggestionPanel ai={{ state: 'failed', errorMessage: 'TIMEOUT' }} />);
    expect(screen.getByText(/AI unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/TIMEOUT/)).toBeInTheDocument();
    expect(screen.queryByText('Complexity')).not.toBeInTheDocument();
    expect(screen.queryByText('Suggested range')).not.toBeInTheDocument();
  });
});

describe('<AiSuggestionPanel /> — pending variant (defensive)', () => {
  it('shows a quiet "Asking…" state with no grid', () => {
    render(<AiSuggestionPanel ai={{ state: 'pending' }} />);
    expect(screen.getByText(/Asking…/)).toBeInTheDocument();
    expect(screen.queryByText('Complexity')).not.toBeInTheDocument();
  });
});

describe('<AiSuggestionPanel /> — What\'s CERU popover (OQ-001)', () => {
  it('opens on click and renders five lines of educational copy', async () => {
    const user = userEvent.setup();
    render(<AiSuggestionPanel ai={READY} />);
    expect(screen.queryByRole('dialog', { name: /What is CERU/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /What['’]s CERU\?/i }));
    const dialog = screen.getByRole('dialog', { name: /What is CERU/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/Mike Cohn['’]s four dimensions/);
    expect(dialog.textContent).toMatch(/Complexity — how tangled/);
    expect(dialog.textContent).toMatch(/Effort — how much volume/);
    expect(dialog.textContent).toMatch(/Risk — what could go wrong/);
    expect(dialog.textContent).toMatch(/Unknowns — what isn['’]t decided/);
  });

  it('closes when the close (X) button is clicked', async () => {
    const user = userEvent.setup();
    render(<AiSuggestionPanel ai={READY} />);
    await user.click(screen.getByRole('button', { name: /What['’]s CERU\?/i }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: /What is CERU/i })).not.toBeInTheDocument();
  });
});

// ---- S8.iv.c1: reveal + share variants -------------------------------------

const READY_SHARED: Extract<AISuggestion, { state: 'ready' }> = { ...READY, shared: true };

describe('<AiSuggestionPanel /> — S8.iv host at reveal, not yet shared', () => {
  it('renders the armed "Share with the team" button + the "or keep it as your reference" caption', () => {
    const onShare = vi.fn();
    render(<AiSuggestionPanel ai={READY} isHost revealed onShare={onShare} />);
    expect(screen.getByRole('button', { name: /Share with the team/i })).toBeInTheDocument();
    expect(screen.getByText(/or keep it as your reference/i)).toBeInTheDocument();
    // "Visible to you only" is still present pre-share — privacy framing while
    // the suggestion is still the host's reference alone.
    expect(screen.getByText('Visible to you only')).toBeInTheDocument();
  });

  it('clicking the share button invokes onShare exactly once', async () => {
    const onShare = vi.fn();
    render(<AiSuggestionPanel ai={READY} isHost revealed onShare={onShare} />);
    await userEvent.click(screen.getByRole('button', { name: /Share with the team/i }));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('a host at reveal with NO onShare handler does NOT render the share button (defensive)', () => {
    render(<AiSuggestionPanel ai={READY} isHost revealed />);
    expect(screen.queryByRole('button', { name: /Share with the team/i })).not.toBeInTheDocument();
  });

  it('a NON-host at reveal does NOT render the share button (visibility-gate-in-component)', () => {
    const onShare = vi.fn();
    render(<AiSuggestionPanel ai={READY} isHost={false} revealed onShare={onShare} />);
    expect(screen.queryByRole('button', { name: /Share with the team/i })).not.toBeInTheDocument();
  });

  it('pre-reveal host (active story) does NOT render the share button (you can\'t share before reveal)', () => {
    const onShare = vi.fn();
    render(<AiSuggestionPanel ai={READY} isHost revealed={false} onShare={onShare} />);
    expect(screen.queryByRole('button', { name: /Share with the team/i })).not.toBeInTheDocument();
    // The pre-reveal privacy framing stays.
    expect(screen.getByText('Visible to you only')).toBeInTheDocument();
  });
});

describe('<AiSuggestionPanel /> — S8.iv shared (read-only) variant', () => {
  it('host view: "Visible to you only" + share button drop; "Shared with the team" label appears', () => {
    const onShare = vi.fn();
    render(<AiSuggestionPanel ai={READY_SHARED} isHost revealed onShare={onShare} />);
    expect(screen.queryByText('Visible to you only')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Share with the team/i })).not.toBeInTheDocument();
    expect(screen.getByText('Shared with the team')).toBeInTheDocument();
  });

  it('non-host view: same drops; the label says "Shared by the host"', () => {
    render(<AiSuggestionPanel ai={READY_SHARED} isHost={false} revealed />);
    expect(screen.queryByText('Visible to you only')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Share with the team/i })).not.toBeInTheDocument();
    expect(screen.getByText('Shared by the host')).toBeInTheDocument();
  });

  it('the shared variant renders the four dimensions + the suggested range identically (read-only same content)', () => {
    render(<AiSuggestionPanel ai={READY_SHARED} isHost={false} revealed />);
    expect(screen.getByText('Complexity')).toBeInTheDocument();
    expect(screen.getByText('Effort')).toBeInTheDocument();
    expect(screen.getByText('Risk')).toBeInTheDocument();
    expect(screen.getByText('Unknowns')).toBeInTheDocument();
    expect(screen.getByText('Suggested range')).toBeInTheDocument();
    // Range values still in mono.
    const range = screen.getByText('Suggested range').nextElementSibling as HTMLElement;
    expect(range.textContent).toContain('5');
    expect(range.textContent).toContain('8');
  });
});
