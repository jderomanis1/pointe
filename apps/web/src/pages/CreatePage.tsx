import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { createRoom } from '../lib/api';

export type CreateNavState = {
  wsUrl: string;
  voterId: string;
  displayName: string;
  asHost: true;
};

export function CreatePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
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
    const res = await createRoom({ hostDisplayName: trimmed });
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
