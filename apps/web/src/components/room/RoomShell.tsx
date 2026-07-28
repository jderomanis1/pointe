import { useEffect, useRef, useState } from 'react';
import { Check, Link2, LoaderCircle, Wifi, WifiOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useRoomStore } from '../../store/roomStore';
import { AUTO_ROUND_TEXT, isAutoRoundText } from '../../lib/rounds';
import { Badge } from '../Badge';
import { Roster } from './Roster';
import { StoryQueue } from './StoryQueue';
import { ThemeToggle } from './ThemeToggle';
import { VotingStage } from './VotingStage';
import { HostVacantBanner } from './HostVacantBanner';
import { ReplacedNotice } from './ReplacedNotice';
import { useSend } from './RoomClientContext';

function ConnectionStatus() {
  const status = useRoomStore((s) => s.connection);
  const connected = status === 'connected';
  const reconnecting = status === 'connecting' || status === 'reconnecting';
  const label = connected ? 'Connected' : reconnecting ? 'Reconnecting' : 'Offline';

  return (
    <span
      className={connected
        ? 'inline-flex items-center gap-2 rounded-full bg-success-surface px-3 py-1.5 text-caption font-bold text-success-on'
        : reconnecting
          ? 'inline-flex items-center gap-2 rounded-full bg-warning-surface px-3 py-1.5 text-caption font-bold text-warning-on'
          : 'inline-flex items-center gap-2 rounded-full bg-error-surface px-3 py-1.5 text-caption font-bold text-error-on'}
      aria-label={`Connection ${label}`}
    >
      {connected ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
      {label}
    </span>
  );
}

function BrandMark() {
  return (
    <span className="relative block h-10 w-11 shrink-0" aria-hidden="true">
      <span className="absolute left-1 top-1 h-8 w-6 -rotate-6 rounded-[8px] border-2 border-text bg-surface" />
      <span className="absolute right-0 top-0 grid h-9 w-7 rotate-6 place-items-center rounded-[8px] border-2 border-text bg-accent text-sm font-black text-accent-ink shadow-card">
        P
      </span>
    </span>
  );
}

function InviteButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);

  async function copyInvite() {
    const url = `${window.location.origin}/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this room link', url);
    }
  }

  return (
    <button
      type="button"
      onClick={copyInvite}
      className="inline-flex min-h-10 items-center gap-2 rounded-full border border-hairline bg-surface px-4 text-sm font-bold text-text shadow-card transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}
      <span className="hidden sm:inline">{copied ? 'Link copied' : 'Invite the team'}</span>
      <span className="sm:hidden">{copied ? 'Copied' : 'Invite'}</span>
    </button>
  );
}

function AutoRoundController({ isHost }: { isHost: boolean }) {
  const send = useSend();
  const stories = useRoomStore((s) => s.stories);
  const addSent = useRef(false);
  const openedIds = useRef(new Set<string>());

  useEffect(() => {
    if (!isHost) return;

    const focusStory = stories.find((story) => story.state === 'active' || story.state === 'revealed');
    if (focusStory) return;

    if (stories.length === 0) {
      if (addSent.current) return;
      addSent.current = true;
      send('ADD_STORY', { text: AUTO_ROUND_TEXT });
      return;
    }

    const next = stories.find((story) => story.state === 'pending');
    if (!next || openedIds.current.has(next.id)) return;
    openedIds.current.add(next.id);
    send('OPEN_VOTING', { storyId: next.id });
  }, [isHost, send, stories]);

  return null;
}

function OpeningRound({ isHost }: { isHost: boolean }) {
  return (
    <section className="rounded-[28px] border border-hairline bg-surface/95 px-6 py-14 text-center shadow-pop sm:px-10">
      <LoaderCircle className="mx-auto animate-spin text-accent-text" size={30} aria-hidden="true" />
      <h1 className="mt-5 text-3xl font-extrabold tracking-[-.035em] text-text">
        {isHost ? 'Opening the vote…' : 'The facilitator is opening the vote…'}
      </h1>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-text-secondary">
        Your card hand will appear automatically. There is nothing else to set up.
      </p>
    </section>
  );
}

export function RoomShell({ slug }: { slug: string }) {
  const room = useRoomStore((s) => s.room);
  const stories = useRoomStore((s) => s.stories);
  const me = useRoomStore((s) => s.me);

  const isHost = me?.voterId !== undefined
    && room?.hostVoterId !== null
    && me?.voterId === room?.hostVoterId;
  const focusStory = stories.find((story) => story.state === 'active' || story.state === 'revealed') ?? null;
  const legacyStories = stories.filter((story) => !isAutoRoundText(story.text));

  return (
    <main className="relative min-h-screen overflow-x-hidden bg-bg text-text font-sans">
      <AutoRoundController isHost={isHost} />

      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-[620px] opacity-80"
        style={{
          background:
            'radial-gradient(circle at 8% 8%, rgba(255,138,61,.18), transparent 32%), radial-gradient(circle at 90% 10%, rgba(46,158,143,.14), transparent 30%)',
        }}
      />

      <header className="sticky top-0 z-30 border-b border-hairline bg-bg/90 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link
            to="/"
            className="inline-flex min-w-0 items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            aria-label="Pointe home"
          >
            <BrandMark />
            <span className="min-w-0">
              <span className="block text-xl font-extrabold leading-none tracking-[-.04em]">Pointe</span>
              <span className="mt-1 block truncate text-[10px] font-bold uppercase tracking-[.15em] text-text-muted">
                Room {slug}
              </span>
            </span>
          </Link>

          <div className="ml-auto flex items-center gap-2">
            <ConnectionStatus />
            <InviteButton slug={slug} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-7">
        <HostVacantBanner />
        <ReplacedNotice />
        <Roster />

        {focusStory ? <VotingStage story={focusStory} /> : <OpeningRound isHost={isHost} />}

        {legacyStories.length > 0 ? (
          <details className="group rounded-[22px] border border-hairline bg-surface/85 shadow-card">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <span>Legacy session items</span>
              <span className="text-caption font-semibold text-text-secondary group-open:hidden">Show</span>
              <span className="hidden text-caption font-semibold text-text-secondary group-open:inline">Hide</span>
            </summary>
            <div className="border-t border-hairline p-4 sm:p-5">
              <StoryQueue />
              <Badge variant="neutral">Previous room format</Badge>
            </div>
          </details>
        ) : null}
      </div>
    </main>
  );
}
