import { useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  BarChart3,
  Check,
  Link2,
  Lock,
  MessageCircleMore,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { createRoom } from '../lib/api';
import { cn } from '../lib/cn';
import { isRoomSlug } from '../lib/slug';

export type CreateNavState = {
  wsUrl: string;
  voterId: string;
  resumeToken?: string;
  displayName: string;
  asHost: true;
};

type ActionMode = 'create' | 'join';

const FEATURE_POINTS = [
  'No account or installation',
  'Voting opens automatically',
  'Free, private, and ad-free',
];

const PREVIEW_PLAYERS = [
  { name: 'Maya', initials: 'MK', ready: true, tone: 'bg-[#FFE2CF] text-[#8E3500]' },
  { name: 'Jordan', initials: 'JL', ready: true, tone: 'bg-[#DDF4E5] text-[#17633A]' },
  { name: 'Priya', initials: 'PS', ready: false, tone: 'bg-[#DCEFEB] text-[#185C54]' },
  { name: 'You', initials: 'JD', ready: true, tone: 'bg-[#FFF0B8] text-[#6F4A00]' },
];

export function CreatePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [action, setAction] = useState<ActionMode>('create');
  const [joinReference, setJoinReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 60) {
      setError('Pick a name between 1 and 60 characters.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await createRoom({ hostDisplayName: trimmed, mode: 'sync' });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error.message || 'Could not create a room. Try again.');
      return;
    }
    const navState: CreateNavState = {
      wsUrl: res.data.wsUrl,
      voterId: res.data.voterId,
      resumeToken: res.data.resumeToken,
      displayName: trimmed,
      asHost: true,
    };
    navigate(`/${res.data.slug}`, { state: navState });
  }

  function onJoin(e: FormEvent) {
    e.preventDefault();
    const slug = roomSlugFromReference(joinReference);
    if (!slug) {
      setJoinError('Enter a valid Pointe room link or code.');
      return;
    }
    setJoinError(null);
    navigate(`/${slug}`);
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg text-text font-sans">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[620px] opacity-70"
        style={{
          background:
            'radial-gradient(circle at 12% 12%, rgba(255,138,61,.20), transparent 34%), radial-gradient(circle at 84% 18%, rgba(46,158,143,.13), transparent 30%)',
        }}
      />

      <SiteHeader onStart={() => setAction('create')} />

      <section className="relative mx-auto grid w-full max-w-7xl gap-12 px-5 pb-20 pt-12 sm:px-8 lg:grid-cols-[1.08fr_.92fr] lg:items-center lg:gap-16 lg:px-10 lg:pb-28 lg:pt-20">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface/90 px-3 py-1.5 text-meta font-semibold text-text-secondary shadow-card">
            <Sparkles size={14} aria-hidden="true" />
            Planning poker with nothing to configure
          </div>

          <h1 className="mt-7 max-w-3xl text-[clamp(3.1rem,7vw,6.4rem)] font-extrabold leading-[.92] tracking-[-.055em] text-text">
            Join the room. Pick a card. Keep moving.
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
            Pointe gives agile teams one focused place to estimate together. Start in seconds, share one link, and enter directly into an open vote.
          </p>

          <div className="mt-7 flex flex-wrap gap-x-5 gap-y-3">
            {FEATURE_POINTS.map((point) => (
              <span key={point} className="inline-flex items-center gap-2 text-sm font-semibold text-text-secondary">
                <span className="grid size-5 place-items-center rounded-full bg-success-surface text-success-on">
                  <Check size={13} aria-hidden="true" />
                </span>
                {point}
              </span>
            ))}
          </div>

          <SessionPreview />
        </div>

        <section
          aria-label="Start or join a planning poker session"
          className="relative rounded-[28px] border border-hairline bg-surface p-3 shadow-[0_22px_70px_rgba(72,41,19,.16)] sm:p-4"
        >
          <div className="grid grid-cols-2 rounded-[18px] bg-fill p-1.5" role="tablist" aria-label="Session action">
            <ActionTab active={action === 'create'} onClick={() => setAction('create')}>
              Start a session
            </ActionTab>
            <ActionTab active={action === 'join'} onClick={() => setAction('join')}>
              Join a session
            </ActionTab>
          </div>

          <div className="p-3 sm:p-5">
            {action === 'create' ? (
              <CreateSessionForm
                name={name}
                setName={setName}
                submitting={submitting}
                error={error}
                onSubmit={onSubmit}
              />
            ) : (
              <JoinSessionForm
                value={joinReference}
                setValue={setJoinReference}
                error={joinError}
                onSubmit={onJoin}
              />
            )}
          </div>
        </section>
      </section>

      <section id="why-pointe" className="border-y border-hairline bg-surface/70">
        <div className="mx-auto grid max-w-7xl gap-px border-x border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
          <ValueCell icon={<Zap size={20} />} title="Start instantly">
            Name yourself, create the room, and voting is already open.
          </ValueCell>
          <ValueCell icon={<Users size={20} />} title="Built for agile teams">
            Designed around the actual refinement rhythm, not workspace administration.
          </ValueCell>
          <ValueCell icon={<Lock size={20} />} title="Private by default">
            Votes stay hidden until the facilitator reveals them.
          </ValueCell>
          <ValueCell icon={<BarChart3 size={20} />} title="Useful discussion">
            Surface consensus and spread without slowing down the team.
          </ValueCell>
        </div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:px-10 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-[.7fr_1.3fr] lg:gap-20">
          <div>
            <p className="text-meta font-bold uppercase tracking-[.16em] text-accent-text">One link. One live loop.</p>
            <h2 className="mt-4 text-[clamp(2.6rem,5vw,4.4rem)] font-extrabold leading-[.98] tracking-[-.045em]">
              The ceremony should support the conversation, not interrupt it.
            </h2>
            <p className="mt-6 max-w-xl text-lg leading-8 text-text-secondary">
              Pointe removes setup steps and keeps the full team oriented around the vote that is happening now.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Capability
              number="01"
              icon={<Link2 size={20} />}
              title="Create and share"
              body="Enter your name, send the room link, and the vote opens automatically."
            />
            <Capability
              number="02"
              icon={<MessageCircleMore size={20} />}
              title="Vote independently"
              body="Cards stay private until reveal so every team member forms an honest estimate."
            />
            <Capability
              number="03"
              icon={<Sparkles size={20} />}
              title="Reveal together"
              body="The facilitator flips the cards when the team is ready, even if someone is still thinking."
            />
            <Capability
              number="04"
              icon={<BarChart3 size={20} />}
              title="Close and continue"
              body="Discuss the useful spread, close the vote, and the next round opens immediately."
            />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-20 sm:px-8 lg:px-10 lg:pb-28">
        <div className="relative overflow-hidden rounded-[32px] border border-hairline bg-text px-6 py-12 text-bg shadow-pop sm:px-10 lg:flex lg:items-center lg:justify-between lg:px-14 lg:py-14">
          <div
            aria-hidden="true"
            className="absolute inset-0 opacity-30"
            style={{ background: 'radial-gradient(circle at 82% 10%, #FF8A3D 0, transparent 30%)' }}
          />
          <div className="relative max-w-2xl">
            <p className="text-meta font-bold uppercase tracking-[.16em] opacity-70">Your next refinement starts here</p>
            <h2 className="mt-3 text-4xl font-extrabold leading-none tracking-[-.04em] sm:text-5xl">
              Get everyone voting in under a minute.
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              setAction('create');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="relative mt-8 inline-flex min-h-12 items-center gap-2 rounded-full bg-accent px-6 py-3 font-bold text-accent-ink transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:mt-0"
          >
            Start a free session <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

function SiteHeader({ onStart }: { onStart: () => void }) {
  return (
    <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
      <Link to="/" className="inline-flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Pointe home">
        <BrandMark />
        <span>
          <span className="block text-2xl font-extrabold leading-none tracking-[-.04em]">Pointe</span>
          <span className="mt-1 block text-[10px] font-bold uppercase tracking-[.18em] text-text-muted">Plan with confidence</span>
        </span>
      </Link>
      <nav className="hidden items-center gap-7 text-sm font-semibold text-text-secondary md:flex" aria-label="Primary navigation">
        <a className="transition-colors hover:text-text" href="#how-it-works">How it works</a>
        <a className="transition-colors hover:text-text" href="#why-pointe">Why Pointe</a>
        <a
          className="inline-flex items-center gap-1.5 transition-colors hover:text-text"
          href="https://github.com/jderomanis1/pointe"
          target="_blank"
          rel="noreferrer"
        >
          <span aria-hidden="true">↗</span> Open source
        </a>
      </nav>
      <button
        type="button"
        onClick={onStart}
        className="inline-flex min-h-10 items-center rounded-full border border-hairline bg-surface px-4 text-sm font-bold shadow-card transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Start free
      </button>
    </header>
  );
}

function BrandMark() {
  return (
    <span className="relative block h-11 w-12" aria-hidden="true">
      <span className="absolute left-1 top-1 h-9 w-7 -rotate-6 rounded-[9px] border-2 border-text bg-surface" />
      <span className="absolute right-0 top-0 grid h-10 w-8 rotate-6 place-items-center rounded-[9px] border-2 border-text bg-accent text-lg font-black text-accent-ink shadow-card">
        P
      </span>
    </span>
  );
}

function ActionTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'min-h-11 rounded-[14px] px-3 text-sm font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        active ? 'bg-surface text-text shadow-card' : 'text-text-secondary hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function CreateSessionForm({
  name,
  setName,
  submitting,
  error,
  onSubmit,
}: {
  name: string;
  setName: (value: string) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex min-h-[360px] flex-col justify-center gap-5">
      <div>
        <p className="text-meta font-bold uppercase tracking-[.14em] text-accent-text">Create a room</p>
        <h2 className="mt-2 text-4xl font-extrabold leading-[1.02] tracking-[-.04em]">Bring the team straight into the vote.</h2>
        <p className="mt-3 text-sm leading-6 text-text-secondary">You will be the facilitator. No mode selection, story setup, account, or workspace required.</p>
      </div>

      <Input
        id="host-name"
        label="Your name"
        placeholder="e.g. Jordan"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={error ?? undefined}
        helper={error ? undefined : 'Shown to everyone at the table.'}
        disabled={submitting}
        autoFocus
      />

      <Button type="submit" variant="primary" disabled={submitting}>
        {submitting ? 'Creating Session…' : 'Create Session'}
      </Button>
      <p className="flex items-center justify-center gap-2 text-center text-caption font-semibold text-text-muted">
        <Lock size={13} aria-hidden="true" /> Free forever. No ads. No personal profile.
      </p>
    </form>
  );
}

function JoinSessionForm({
  value,
  setValue,
  error,
  onSubmit,
}: {
  value: string;
  setValue: (value: string) => void;
  error: string | null;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex min-h-[360px] flex-col justify-center gap-5">
      <div>
        <p className="text-meta font-bold uppercase tracking-[.14em] text-accent-text">Join your team</p>
        <h2 className="mt-2 text-4xl font-extrabold leading-[1.02] tracking-[-.04em]">Paste the link. Pick a name. Start voting.</h2>
        <p className="mt-3 text-sm leading-6 text-text-secondary">Use the full invitation link or the short room code shared by your facilitator.</p>
      </div>
      <Input
        id="room-reference"
        label="Room link or code"
        placeholder="calm-fox-42"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        error={error ?? undefined}
        helper={error ? undefined : 'Example: pointe.team/calm-fox-42'}
        autoFocus
      />
      <Button type="submit" variant="primary">Join Session</Button>
      <div className="rounded-[16px] border border-hairline bg-fill p-4 text-sm leading-6 text-text-secondary">
        <strong className="text-text">Just observing?</strong> Choose spectator on the next screen and follow the vote without placing a card.
      </div>
    </form>
  );
}

function SessionPreview() {
  return (
    <div className="mt-10 max-w-2xl rounded-[26px] border border-hairline bg-surface/90 p-4 shadow-card sm:p-5">
      <div className="flex items-center justify-between border-b border-hairline pb-4">
        <div>
          <p className="text-meta font-bold uppercase tracking-[.13em] text-text-muted">Live estimate</p>
          <p className="mt-1 font-semibold text-text">Everyone is voting now</p>
        </div>
        <span className="rounded-full bg-success-surface px-3 py-1 text-caption font-bold text-success-on">3 of 4 ready</span>
      </div>
      <div className="grid grid-cols-4 gap-2 py-5 sm:gap-4">
        {PREVIEW_PLAYERS.map((player) => (
          <div key={player.name} className="flex min-w-0 flex-col items-center gap-2 text-center">
            <div className={cn('grid size-10 place-items-center rounded-full text-xs font-black sm:size-11', player.tone)}>{player.initials}</div>
            <span className="w-full truncate text-caption font-bold text-text-secondary">{player.name}</span>
            <div className={cn(
              'grid h-16 w-11 place-items-center rounded-[10px] border-2 text-xl font-black transition-transform sm:h-20 sm:w-14 sm:text-2xl',
              player.ready
                ? 'rotate-[-2deg] border-accent bg-[repeating-linear-gradient(45deg,var(--color-accent),var(--color-accent)_6px,var(--color-accent-hover)_6px,var(--color-accent-hover)_12px)] text-transparent shadow-card'
                : 'border-dashed border-hairline bg-bg text-text-muted',
            )}>
              {player.ready ? '•' : '…'}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-[18px] bg-fill p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-semibold text-text">Votes stay hidden until reveal.</p>
          <p className="mt-1 text-caption text-text-secondary">Independent thinking first. Conversation second.</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-black text-accent-ink shadow-card">
          Reveal cards <Sparkles size={15} aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

function ValueCell({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="bg-surface p-6 sm:p-8">
      <span className="grid size-10 place-items-center rounded-full bg-accent-tint text-accent-text">{icon}</span>
      <h3 className="mt-5 text-lg font-bold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-text-secondary">{children}</p>
    </div>
  );
}

function Capability({ number, icon, title, body }: { number: string; icon: ReactNode; title: string; body: string }) {
  return (
    <article className="rounded-[22px] border border-hairline bg-surface p-5 shadow-card transition-transform hover:-translate-y-1 sm:p-6">
      <div className="flex items-center justify-between">
        <span className="grid size-10 place-items-center rounded-full bg-fill text-text-secondary">{icon}</span>
        <span className="font-mono text-caption font-bold text-text-muted">{number}</span>
      </div>
      <h3 className="mt-8 text-xl font-bold">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-text-secondary">{body}</p>
    </article>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-hairline bg-surface/70">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-8 text-sm text-text-secondary sm:px-8 md:flex-row md:items-center md:justify-between lg:px-10">
        <div className="flex items-center gap-3">
          <BrandMark />
          <div>
            <p className="font-bold text-text">Pointe</p>
            <p className="text-caption">Planning poker that respects your team&apos;s time and judgment.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span>Free and open source</span>
          <a className="font-semibold text-text hover:text-accent-text" href="mailto:feedback@pointe.team">Feedback</a>
          <a
            className="inline-flex items-center gap-1.5 font-semibold text-text hover:text-accent-text"
            href="https://github.com/jderomanis1/pointe"
            target="_blank"
            rel="noreferrer"
          >
            <span aria-hidden="true">↗</span> GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}

function roomSlugFromReference(reference: string): string | null {
  const trimmed = reference.trim().toLowerCase();
  if (!trimmed) return null;

  let candidate = trimmed;
  try {
    const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withProtocol);
    if (url.hostname.includes('.') || trimmed.includes('/')) {
      candidate = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    }
  } catch {
    candidate = trimmed;
  }

  candidate = candidate.split(/[?#]/)[0] ?? '';
  return isRoomSlug(candidate) ? candidate : null;
}
