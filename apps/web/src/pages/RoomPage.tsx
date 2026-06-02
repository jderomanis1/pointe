import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { ErrorPayload, JoinRoomPayload } from '@pointe/shared';

type JoinRole = 'voter' | 'spectator';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Badge } from '../components/Badge';
import { getRoom, buildWsUrl } from '../lib/api';
import { useRoomClient } from '../hooks/useRoomClient';
import { useRoomStore } from '../store/roomStore';
import type { CreateNavState } from './CreatePage';

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

  // 1) Resolve the slug. 404 → RoomNotFound; otherwise proceed.
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

  // 2) Host handoff — if we arrived from CreatePage, connect immediately.
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

  if (probe.kind === 'loading') return <RoomShell><p className="text-text-secondary">Looking up <Slug slug={slug} />…</p></RoomShell>;
  if (probe.kind === 'not_found') return <RoomNotFound slug={slug} />;
  if (probe.kind === 'probe_error') {
    return <RoomShell><p className="text-error">Couldn&apos;t reach the server: {probe.message}</p></RoomShell>;
  }

  if (!joinParams) {
    return <JoinForm slug={slug} onSubmit={setJoinParams} />;
  }
  return <RoomConnected wsUrl={joinParams.wsUrl} join={joinParams.join} slug={slug} />;
}

// ---- subcomponents ----

function RoomShell({ children }: { children: ReactNode }) {
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
    <RoomShell>
      <h1 className="font-serif text-display text-text">No room here</h1>
      <p className="text-text-secondary text-body mt-3">
        <Slug slug={slug} /> doesn&apos;t match any open room.
      </p>
      <p className="mt-6">
        <Link to="/" className="text-accent font-medium">Create one →</Link>
      </p>
    </RoomShell>
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
    <RoomShell>
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
    </RoomShell>
  );
}

function RoomConnected({ wsUrl, join, slug }: { wsUrl: string; join: JoinRoomPayload; slug: string }) {
  const [serverError, setServerError] = useState<ErrorPayload | null>(null);
  // Stable args for the mount-only effect.
  const args = useMemo(() => ({
    wsUrl, join, onError: (e: ErrorPayload) => setServerError(e),
  }), [wsUrl, join]);
  useRoomClient(args);

  const connection = useRoomStore((s) => s.connection);
  const room = useRoomStore((s) => s.room);
  const voters = useRoomStore((s) => s.voters);
  const me = useRoomStore((s) => s.me);

  const voterCount = Object.values(voters).filter((v) => v.connectionState !== 'left').length;

  return (
    <RoomShell>
      <header className="flex items-center justify-between">
        <h1 className="font-serif text-heading text-text"><Slug slug={slug} /></h1>
        <StatusBadge status={connection} />
      </header>

      {connection === 'reconnecting' ? (
        <div className="mt-4 bg-warning-surface text-warning-on text-meta rounded-md px-3 py-2">
          Reconnecting…
        </div>
      ) : null}

      {serverError ? (
        <div className="mt-4 bg-error-surface text-error-on text-meta rounded-md px-3 py-2">
          {serverError.code}: {serverError.message}
        </div>
      ) : null}

      {connection === 'connecting' || !room ? (
        <p className="mt-8 text-text-secondary">Joining…</p>
      ) : (
        <section className="mt-8 bg-surface border border-hairline rounded-md p-6">
          <p className="text-text-secondary text-meta">Room state</p>
          <p className="text-text text-body mt-1">{room.state}</p>

          <p className="text-text-secondary text-meta mt-4">Voters connected</p>
          <p className="text-text text-num font-mono mt-1">{voterCount}</p>

          <p className="text-text-secondary text-meta mt-4">You</p>
          <p className="text-text text-body mt-1">
            <span className="font-mono">{me?.voterId.slice(0, 8) ?? '—'}</span>
            {' '}· {me?.role}
          </p>

          <p className="text-text-muted text-caption mt-6">
            The room shell (story queue, voting deck, reveal, host controls) arrives in R4.v.
          </p>
        </section>
      )}
    </RoomShell>
  );
}

function StatusBadge({ status }: { status: ReturnType<typeof useRoomStore.getState>['connection'] }) {
  if (status === 'connected') return <Badge variant="success">Connected</Badge>;
  if (status === 'connecting') return <Badge variant="neutral">Connecting</Badge>;
  if (status === 'reconnecting') return <Badge variant="warning">Reconnecting</Badge>;
  return <Badge variant="error">Disconnected</Badge>;
}
