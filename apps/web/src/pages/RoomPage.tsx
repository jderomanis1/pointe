import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { ErrorPayload, JoinRoomPayload } from '@pointe/shared';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { getRoom, buildWsUrl } from '../lib/api';
import { useRoomClient } from '../hooks/useRoomClient';
import { useRoomStore } from '../store/roomStore';
import { RoomShell } from '../components/room/RoomShell';
import { RoomClientProvider } from '../components/room/RoomClientContext';
import { AddStory } from '../components/room/AddStory';
import type { CreateNavState } from './CreatePage';

type JoinRole = 'voter' | 'spectator';

type ProbeState =
  | { kind: 'loading' }
  | { kind: 'found' }
  | { kind: 'not_found' }
  | { kind: 'probe_error'; message: string };

type JoinParams = { wsUrl: string; join: JoinRoomPayload };

export function RoomPage({ slug }: { slug: string }) {
  const location = useLocation();
  const navState = (location.state as CreateNavState | null) ?? null;

  const [probe, setProbe] = useState<ProbeState>({ kind: 'loading' });
  const [joinParams, setJoinParams] = useState<JoinParams | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await getRoom(slug);
      if (!alive) return;
      if (res.ok) setProbe({ kind: 'found' });
      else if (res.status === 404) setProbe({ kind: 'not_found' });
      else setProbe({ kind: 'probe_error', message: res.error.message });
    })();
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    if (probe.kind !== 'found' || joinParams || !navState?.asHost) return;
    setJoinParams({
      wsUrl: navState.wsUrl,
      join: {
        slug,
        displayName: navState.displayName,
        resumeVoterId: navState.voterId,
        role: 'voter',
      },
    });
  }, [probe.kind, joinParams, navState, slug]);

  if (probe.kind === 'loading') return <PageShell><p className="text-text-secondary">Looking up <Slug slug={slug} />…</p></PageShell>;
  if (probe.kind === 'not_found') return <RoomNotFound slug={slug} />;
  if (probe.kind === 'probe_error') {
    return <PageShell><p className="text-error">Couldn&apos;t reach the server: {probe.message}</p></PageShell>;
  }
  if (!joinParams) return <JoinForm slug={slug} onSubmit={setJoinParams} />;
  return <RoomConnected wsUrl={joinParams.wsUrl} join={joinParams.join} slug={slug} />;
}

// ---- pre-shell page wrapper (only used before the room shell takes over) ----

function PageShell({ children }: { children: ReactNode }) {
  return (
    <main className="bg-bg text-text min-h-screen font-sans">
      <div className="max-w-xl mx-auto px-6 py-24">{children}</div>
    </main>
  );
}

function Slug({ slug }: { slug: string }) {
  return <span className="font-mono text-text">{slug}</span>;
}

function RoomNotFound({ slug }: { slug: string }) {
  return (
    <PageShell>
      <h1 className="font-serif text-display text-text">No room here</h1>
      <p className="text-text-secondary text-body mt-3">
        <Slug slug={slug} /> doesn&apos;t match any open room.
      </p>
      <p className="mt-6">
        <Link to="/" className="text-accent font-medium">Create one →</Link>
      </p>
    </PageShell>
  );
}

function JoinForm({ slug, onSubmit }: { slug: string; onSubmit: (p: JoinParams) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<JoinRole>('voter');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 60) {
      setError('Pick a name between 1 and 60 characters.');
      return;
    }
    onSubmit({
      wsUrl: buildWsUrl(slug),
      join: { slug, displayName: trimmed, role },
    });
  }

  return (
    <PageShell>
      <h1 className="font-serif text-display text-text">Join <Slug slug={slug} /></h1>
      <form onSubmit={submit} className="mt-8 bg-surface border border-hairline rounded-md p-6 flex flex-col gap-5">
        <Input
          id="join-name"
          label="Your name"
          placeholder="e.g. Alice"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error ?? undefined}
          autoFocus
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-meta text-text-secondary mb-1">How you&apos;ll participate</legend>
          <label className="flex items-center gap-2 text-body cursor-pointer">
            <input
              type="radio" name="role" value="voter"
              checked={role === 'voter'} onChange={() => setRole('voter')}
            />
            <span>Voter — vote on every story.</span>
          </label>
          <label className="flex items-center gap-2 text-body cursor-pointer">
            <input
              type="radio" name="role" value="spectator"
              checked={role === 'spectator'} onChange={() => setRole('spectator')}
            />
            <span>Spectator — watch only, don&apos;t vote.</span>
          </label>
        </fieldset>
        <div>
          <Button type="submit" variant="primary">Join</Button>
        </div>
      </form>
    </PageShell>
  );
}

function RoomConnected({ wsUrl, join, slug }: { wsUrl: string; join: JoinRoomPayload; slug: string }) {
  const [serverError, setServerError] = useState<ErrorPayload | null>(null);
  const args = useMemo(() => ({
    wsUrl, join, onError: (e: ErrorPayload) => setServerError(e),
  }), [wsUrl, join]);
  const api = useRoomClient(args);

  const connection = useRoomStore((s) => s.connection);
  const room = useRoomStore((s) => s.room);

  if (connection !== 'connected' || !room) {
    return <PageShell><p className="text-text-secondary">Joining <Slug slug={slug} />…</p></PageShell>;
  }

  return (
    <RoomClientProvider send={api.send}>
      {serverError ? (
        <div className="bg-error-surface text-error-on text-meta px-4 py-2 text-center">
          {serverError.code}: {serverError.message}
        </div>
      ) : null}
      <RoomShell
        slug={slug}
        addStorySlot={<AddStory />}
        persistentAddStorySlot={<AddStory />}
      />
    </RoomClientProvider>
  );
}
