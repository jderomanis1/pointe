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
      wsUrl: buildWsUrl(slug),
      join: {
        slug,
        displayName: navState.displayName,
        resumeVoterId: navState.voterId,
        role: 'voter',
      },
    });
  }, [probe.kind, joinParams, navState, slug]);

  if (probe.kind === 'loading') return <PageShell><StatusCard>Opening <Slug slug={slug} />…</StatusCard></PageShell>;
  if (probe.kind === 'not_found') return <RoomNotFound slug={slug} />;
  if (probe.kind === 'probe_error') {
    return <PageShell><StatusCard tone="error">Couldn&apos;t reach the server: {probe.message}</StatusCard></PageShell>;
  }
  if (!joinParams) return <JoinForm slug={slug} onSubmit={setJoinParams} />;
  return <RoomConnected wsUrl={joinParams.wsUrl} join={joinParams.join} slug={slug} />;
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-bg text-text font-sans">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-70"
        style={{
          background:
            'radial-gradient(circle at 14% 8%, rgba(255,138,61,.20), transparent 34%), radial-gradient(circle at 86% 16%, rgba(46,158,143,.13), transparent 28%)',
        }}
      />
      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Link
          to="/"
          className="inline-flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Pointe home"
        >
          <span className="relative block h-10 w-11" aria-hidden="true">
            <span className="absolute left-1 top-1 h-8 w-6 -rotate-6 rounded-[8px] border-2 border-text bg-surface" />
            <span className="absolute right-0 top-0 grid h-9 w-7 rotate-6 place-items-center rounded-[8px] border-2 border-text bg-accent text-sm font-black text-accent-ink shadow-card">P</span>
          </span>
          <span className="text-2xl font-extrabold leading-none tracking-[-.04em]">Pointe</span>
        </Link>
        <span className="rounded-full border border-hairline bg-surface/90 px-3 py-1.5 text-caption font-bold text-text-secondary shadow-card">
          Live planning poker
        </span>
      </header>
      <div className="relative mx-auto flex min-h-[calc(100vh-160px)] max-w-xl items-center px-5 py-10 sm:px-8">
        <div className="w-full">{children}</div>
      </div>
      <footer className="relative px-5 pb-8 text-center text-caption text-text-muted">
        No account required · Private by default · Open source
      </footer>
    </main>
  );
}

function StatusCard({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'error' }) {
  return (
    <div className={tone === 'error'
      ? 'rounded-[22px] border border-error bg-error-surface p-6 text-error-on shadow-card'
      : 'rounded-[22px] border border-hairline bg-surface p-6 text-text-secondary shadow-card'}>
      {children}
    </div>
  );
}

function Slug({ slug }: { slug: string }) {
  return <span className="font-mono font-semibold text-text">{slug}</span>;
}

function RoomNotFound({ slug }: { slug: string }) {
  return (
    <PageShell>
      <section className="rounded-[26px] border border-hairline bg-surface p-6 shadow-pop sm:p-8">
        <p className="text-meta font-bold uppercase tracking-[.14em] text-accent-text">Room unavailable</p>
        <h1 className="mt-3 text-5xl font-extrabold leading-none tracking-[-.045em]">No table is open here.</h1>
        <p className="mt-4 text-body leading-7 text-text-secondary">
          <Slug slug={slug} /> does not match an active room. Check the invitation or create a fresh session.
        </p>
        <p className="mt-7">
          <Link to="/" className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 font-bold text-accent-ink shadow-card">Create a session</Link>
        </p>
      </section>
    </PageShell>
  );
}

function JoinForm({ slug, onSubmit }: {
  slug: string;
  onSubmit: (p: JoinParams) => void;
}) {
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
    <section className="rounded-[26px] border border-hairline bg-surface p-5 shadow-pop sm:p-8">
      <p className="text-meta font-bold uppercase tracking-[.14em] text-accent-text">You&apos;re invited</p>
      <h1 className="mt-3 text-5xl font-extrabold leading-none tracking-[-.045em]">Join and start voting.</h1>
      <p className="mt-3 text-sm text-text-secondary">Room <Slug slug={slug} /> is already open.</p>
      <form onSubmit={submit} className="mt-7 flex flex-col gap-5">
        <Input
          id="join-name"
          label="Your name"
          placeholder="e.g. Maya"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error ?? undefined}
          autoFocus
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-meta font-semibold text-text-secondary">How will you participate?</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <RoleOption
              active={role === 'voter'}
              onSelect={() => setRole('voter')}
              title="Voter"
              description="Choose an estimate each round."
            />
            <RoleOption
              active={role === 'spectator'}
              onSelect={() => setRole('spectator')}
              title="Spectator"
              description="Follow the room without voting."
            />
          </div>
        </fieldset>
        <Button type="submit" variant="primary">Join</Button>
      </form>
    </section>
  );
}

function RoleOption({ active, onSelect, title, description }: {
  active: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <label className={active
      ? 'cursor-pointer rounded-[16px] border border-accent bg-accent-tint p-4 shadow-card'
      : 'cursor-pointer rounded-[16px] border border-hairline bg-surface p-4 hover:border-text-muted'}>
      <input
        type="radio"
        name="role"
        checked={active}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="block font-bold text-text">{title}</span>
      <span className="mt-1 block text-caption text-text-secondary">{description}</span>
    </label>
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
    return <PageShell><StatusCard>Joining <Slug slug={slug} />…</StatusCard></PageShell>;
  }

  return (
    <RoomClientProvider send={api.send}>
      {serverError ? (
        <div className="bg-error-surface px-4 py-2 text-center text-meta text-error-on">
          {serverError.code}: {serverError.message}
        </div>
      ) : null}
      <RoomShell slug={slug} />
    </RoomClientProvider>
  );
}
