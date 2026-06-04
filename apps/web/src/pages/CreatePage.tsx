import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomMode } from '@pointe/shared';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { createRoom } from '../lib/api';
import { cn } from '../lib/cn';

export type CreateNavState = {
  wsUrl: string;
  voterId: string;
  displayName: string;
  asHost: true;
};

export function CreatePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<RoomMode>('sync');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 60) {
      setError('Pick a name between 1 and 60 characters.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await createRoom({ hostDisplayName: trimmed, mode });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error.message || 'Could not create a room. Try again.');
      return;
    }
    const navState: CreateNavState = {
      wsUrl: res.data.wsUrl,
      voterId: res.data.voterId,
      displayName: trimmed,
      asHost: true,
    };
    navigate(`/${res.data.slug}`, { state: navState });
  }

  return (
    <main className="bg-bg text-text min-h-screen font-sans">
      <div className="max-w-xl mx-auto px-6 py-24">
        <h1 className="font-serif text-display text-text">Pointe</h1>
        <p className="text-text-secondary text-body mt-2">
          Planning poker that respects your team&apos;s time and judgment.
        </p>

        <form onSubmit={onSubmit} className="mt-10 bg-surface border border-hairline rounded-md p-6 flex flex-col gap-5">
          <Input
            id="host-name"
            label="Your name"
            placeholder="e.g. Alice"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={error ?? undefined}
            helper={error ? undefined : 'Shown to the room. You can be a spectator later if you prefer.'}
            disabled={submitting}
            autoFocus
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-meta text-text-secondary mb-1">How will the team estimate?</legend>
            <div
              role="radiogroup"
              aria-label="Estimation mode"
              className="flex gap-2"
            >
              <ModeOption
                value="sync"
                selected={mode}
                onSelect={setMode}
                title="Live (sync)"
                desc="Everyone votes at once on a shared call."
              />
              <ModeOption
                value="async"
                selected={mode}
                onSelect={setMode}
                title="Async window"
                desc="Open a window; team votes at their own pace; auto-reveal at close."
              />
            </div>
          </fieldset>

          <div>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create room'}
            </Button>
          </div>
        </form>

        <p className="mt-6 text-text-muted text-caption">
          <Link to="/preview" className="hover:text-accent">View components</Link>
        </p>
      </div>
    </main>
  );
}

/**
 * Radio-card pair for sync vs. async. Token-only styling: selected → accent
 * border + accent-tint surface; unselected → hairline + surface. The
 * window-duration picker lives at OPEN_ASYNC time, not here — the host
 * picks fresh on the open click (reconnect-robust by being made fresh).
 */
function ModeOption({
  value, selected, onSelect, title, desc,
}: {
  value: RoomMode;
  selected: RoomMode;
  onSelect: (m: RoomMode) => void;
  title: string;
  desc: string;
}) {
  const active = selected === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onSelect(value)}
      className={cn(
        'flex-1 text-left rounded-md p-3 border transition-colors duration-fast',
        active
          ? 'border-accent bg-accent-tint text-accent'
          : 'border-hairline bg-surface text-text hover:bg-fill',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
      data-mode-option={value}
    >
      <div className="font-sans font-medium text-body">{title}</div>
      <div className="text-caption text-text-secondary mt-1">{desc}</div>
    </button>
  );
}
