import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { ErrorPayload, JoinRoomPayload, RoomMode } from '@pointe/shared';
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
  /** S9.ii.c4 — carry mode + closesAt so the join form can frame async arrival. */
  | { kind: 'found'; mode: RoomMode; closesAt: number | null }
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
      if (res.ok) setProbe({ kind: 'found', mode: res.data.mode, closesAt: res.data.closesAt });
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
  if (!joinParams) return (
    <JoinForm
      slug={slug}
      mode={probe.mode}
      closesAt={probe.closesAt}
      onSubmit={setJoinParams}
    />
  );
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

/**
 * S9.ii.c4 — async pre-join framing. Shown above the join form when the
 * probe returns mode='async'. Closes-in countdown ticks every second
 * while the user is on the page; absent when the host hasn't opened the
 * window yet (closesAt === null) — we just say "vote at your pace".
 */
function AsyncJoinFraming({ closesAt }: { closesAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = closesAt !== null ? closesAt - now : null;
  const countdownStr = remaining !== null ? formatJoinCountdown(remaining) : null;
  return (
    <section
      data-slot="async-join-framing"
      className="mt-6 rounded-md bg-accent-tint border border-accent px-4 py-3 flex flex-col gap-1"
      aria-label="Async voting"
    >
      <p className="text-meta font-medium text-accent">
        Async voting{closesAt !== null ? ' — vote at your pace' : ''}
      </p>
      {countdownStr ? (
        <p className="text-caption text-text">
          Closes in{' '}
          <span className="font-mono text-text" data-testid="join-countdown">{countdownStr}</span>
        </p>
      ) : (
        <p className="text-caption text-text-secondary">
          The host hasn&rsquo;t opened the window yet — you&rsquo;ll join the lobby.
        </p>
      )}
    </section>
  );
}

function formatJoinCountdown(ms: number): string {
  if (ms <= 0) return 'closing…';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

function JoinForm({ slug, mode, closesAt, onSubmit }: {
  slug: string;
  mode: RoomMode;
  closesAt: number | null;
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
    <PageShell>
      <h1 className="font-serif text-display text-text">Join <Slug slug={slug} /></h1>
      {mode === 'async' ? <AsyncJoinFraming closesAt={closesAt} /> : null}
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
