import { useEffect, useState } from 'react';
import type { Room, Story } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { StoryExternalRef } from './StoryExternalRef';
import { ShareLink } from './EmptyState';
import { cn } from '../../lib/cn';

/**
 * S9.ii.c4 — host's during-window monitoring view.
 *
 * AA-1 / Pillar-2 invariant: the host sees per-story voted counts but
 * NEVER vote values until the close-alarm reveals (same anti-anchoring
 * that voters get). The data shape makes this physical: the store carries
 * `votedPresence[storyId]: Set<voterId>` (presence-only), and `myVotes`
 * (the host's own casts). There is no peer-vote-value field client-side
 * pre-reveal — value can't be rendered because it isn't there.
 */
function formatCountdown(ms: number): string {
  if (ms <= 0) return 'closing…';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function useCountdown(closesAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return formatCountdown(closesAt - now);
}

export function AsyncHostMonitorView({ room, slug }: { room: Room; slug: string }) {
  const stories = useRoomStore((s) => s.stories);
  const voters = useRoomStore((s) => s.voters);
  const votedPresence = useRoomStore((s) => s.votedPresence);

  const closesAt = room.asyncWindow?.closesAt ?? 0;
  const countdown = useCountdown(closesAt);

  // Total seats that could vote = non-spectator non-left voters in the roster.
  // Mirrors the canVote rule (castVote rejects spectators server-side).
  const total = Object.values(voters)
    .filter((v) => v.role !== 'spectator' && v.connectionState !== 'left')
    .length;

  const queue: Story[] = stories
    .filter((s) => s.state === 'active')
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex);

  return (
    <section
      className="bg-surface border border-hairline rounded-md p-6 md:p-8 flex flex-col gap-5"
      data-slot="async-host-monitor"
      aria-label="Async window — host monitoring"
    >
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <span className="text-meta text-text-secondary">
            Async window <span className="text-text-muted">·</span>{' '}
            <span>closes in </span>
            <span className="font-mono text-text" data-testid="host-countdown">{countdown}</span>
          </span>
          <span className="text-meta text-text-secondary">
            <span className="font-mono text-text">{queue.length}</span> stories open
          </span>
        </div>
        <p className="text-caption text-text-muted">
          Votes stay hidden until the window closes — same as everyone else.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <span className="text-meta text-text-secondary">Share the link</span>
        <ShareLink slug={slug} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-meta text-text-secondary">Voting progress</span>
        <ul className="flex flex-col" data-slot="async-host-list">
          {queue.map((s) => {
            const voted = votedPresence[s.id]?.size ?? 0;
            const isFull = total > 0 && voted >= total;
            return (
              <li
                key={s.id}
                data-story-id={s.id}
                className="flex items-start justify-between gap-3 py-3 px-4 border-b border-hairline last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-body text-text break-words">{s.text}</p>
                  <p className="mt-1">
                    <StoryExternalRef story={s} />
                  </p>
                </div>
                <span
                  data-slot="vote-count"
                  className={cn(
                    'shrink-0 font-mono text-meta tabular-nums',
                    isFull ? 'text-accent' : 'text-text-secondary',
                  )}
                  aria-label={`${voted} of ${total} voted`}
                >
                  {voted}<span className="text-text-muted"> of </span>{total}{' '}
                  <span className="text-text-muted">voted</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
