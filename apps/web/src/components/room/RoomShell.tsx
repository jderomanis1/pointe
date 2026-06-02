import type { ReactNode } from 'react';
import { useRoomStore } from '../../store/roomStore';
import { Badge } from '../Badge';
import { Roster } from './Roster';
import { StoryQueue } from './StoryQueue';
import { EmptyState } from './EmptyState';
import { ThemeToggle } from './ThemeToggle';
import { ShareLink } from './EmptyState';
import { VotingStage } from './VotingStage';
import { HostVacantBanner } from './HostVacantBanner';
import { ReplacedNotice } from './ReplacedNotice';

function StatusBadge() {
  const status = useRoomStore((s) => s.connection);
  if (status === 'connected') return <Badge variant="success">Connected</Badge>;
  if (status === 'connecting') return <Badge variant="neutral">Connecting</Badge>;
  if (status === 'reconnecting') return <Badge variant="warning">Reconnecting</Badge>;
  return <Badge variant="error">Disconnected</Badge>;
}

export function RoomShell({
  slug, addStorySlot, persistentAddStorySlot,
}: {
  slug: string;
  /** EmptyState's primary CTA — host's add-story control (Phase 2). */
  addStorySlot?: ReactNode;
  /** When the queue is populated, the host's persistent add affordance. */
  persistentAddStorySlot?: ReactNode;
}) {
  const room = useRoomStore((s) => s.room);
  const stories = useRoomStore((s) => s.stories);
  const me = useRoomStore((s) => s.me);

  const isHost = me?.voterId !== undefined
    && room?.hostVoterId !== null
    && me?.voterId === room?.hostVoterId;
  // The stage holds focus while a story is being voted on OR has just been revealed.
  // R5.v's COMMIT_STORY moves a revealed story to 'committed' → the queue takes over again.
  const focusStory = stories.find((s) => s.state === 'active' || s.state === 'revealed') ?? null;

  return (
    <main className="bg-bg text-text min-h-screen font-sans">
      <header className="border-b border-hairline">
        <div className="max-w-5xl mx-auto px-4 md:px-6 py-4 flex items-center gap-3 flex-wrap">
          <span className="font-mono text-subhead text-text">{slug}</span>
          {room ? <Badge variant="neutral">{room.deck}</Badge> : null}
          <div className="ml-auto flex items-center gap-3">
            <StatusBadge />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 md:py-8 grid gap-6 md:grid-cols-[260px_1fr]">
        <Roster />
        <div className="flex flex-col gap-6">
          {/* Room-level advisory + transient notice; both can coexist with the
              per-client connection status badge in the header. */}
          <HostVacantBanner />
          <ReplacedNotice />
          {stories.length === 0 ? (
            <EmptyState
              slug={slug}
              deck={room?.deck ?? 'fibonacci'}
              customDeck={room?.customDeck}
              isHost={isHost}
              addStorySlot={addStorySlot}
            />
          ) : focusStory ? (
            <>
              <VotingStage story={focusStory} />
              <StoryQueue />
              {isHost && persistentAddStorySlot ? persistentAddStorySlot : null}
            </>
          ) : (
            <>
              {isHost && persistentAddStorySlot ? persistentAddStorySlot : null}
              <StoryQueue />
              {isHost ? (
                <div className="mt-2">
                  <ShareLink slug={slug} />
                  <p className="text-text-muted text-caption mt-2">
                    Voters: paste this link to invite teammates.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
