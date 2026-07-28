import { TriangleAlert } from 'lucide-react';
import type { Voter, Vote } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

const AVATAR_TONES = [
  'border-[#F07C2A] bg-[#F07C2A]/10 text-[#9F3B00]',
  'border-[#2E9E8F] bg-[#2E9E8F]/10 text-[#17665D]',
  'border-[#E04F4F] bg-[#E04F4F]/10 text-[#8D3030]',
  'border-[#3C9E5D] bg-[#3C9E5D]/10 text-[#246D3B]',
  'border-[#C28A18] bg-[#FFC24B]/15 text-[#755000]',
];

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

function toneFor(id: string): string {
  const score = [...id].reduce((total, char) => total + char.charCodeAt(0), 0);
  return AVATAR_TONES[score % AVATAR_TONES.length];
}

export function VoterSeats({
  activeStoryId, mode, animateReveal,
}: {
  activeStoryId: string;
  mode: 'active' | 'revealed';
  animateReveal: boolean;
}) {
  const voters = useRoomStore((s) => s.voters);
  const presence = useRoomStore((s) => s.votedPresence[activeStoryId]);
  const reveal = useRoomStore((s) => s.revealed[activeStoryId]);
  const me = useRoomStore((s) => s.me);
  const myVote = useRoomStore((s) => s.myVotes[activeStoryId]);

  const all = Object.values(voters).filter((v) => v.connectionState !== 'left');
  const seated = all.filter((v) => v.role !== 'spectator');
  const spectators = all.filter((v) => v.role === 'spectator');

  const voteByVoter = new Map<string, Vote>();
  const outlierSet = new Set<string>(reveal?.stats?.outliers ?? []);
  if (mode === 'revealed' && reveal) {
    for (const v of reveal.votes) voteByVoter.set(v.voterId, v);
  }

  return (
    <section className="flex flex-col gap-5">
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-6 sm:gap-x-7">
        {seated.map((v) => {
          const isMe = v.id === me?.voterId;
          if (mode === 'revealed') {
            const vote = voteByVoter.get(v.id);
            return (
              <RevealedSeat
                key={v.id}
                v={v}
                vote={vote}
                isMe={isMe}
                outlier={outlierSet.has(v.id)}
                animate={animateReveal}
              />
            );
          }
          const hasVoted = isMe ? Boolean(myVote) : Boolean(presence?.has(v.id));
          return <ActiveSeat key={v.id} v={v} hasVoted={hasVoted} isMe={isMe} />;
        })}
      </ul>

      {spectators.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2 text-caption text-text-secondary">
          <span className="font-bold">Watching:</span>
          {spectators.map((v) => (
            <span key={v.id} className="rounded-full border border-hairline bg-fill px-3 py-1 font-semibold">
              {v.displayName}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ActiveSeat({ v, hasVoted, isMe }: { v: Voter; hasVoted: boolean; isMe: boolean }) {
  return (
    <li
      data-testid={`seat-${v.id}`}
      data-voted={hasVoted ? 'true' : 'false'}
      className="flex min-w-[76px] flex-col items-center gap-2 text-center"
    >
      <div
        className={cn(
          'grid h-[72px] w-[52px] place-items-center rounded-[11px] border-2',
          hasVoted ? 'border-accent bg-accent-tint' : 'border-dashed border-hairline bg-bg/35',
        )}
      >
        <span className="text-sm font-black text-text-muted">{hasVoted ? '✓' : '…'}</span>
      </div>
      <span className="text-sm font-bold text-text">{v.displayName}{isMe ? ' (you)' : ''}</span>
    </li>
  );
}

function RevealedSeat({
  v, vote, isMe, outlier, animate,
}: {
  v: Voter;
  vote: Vote | undefined;
  isMe: boolean;
  outlier: boolean;
  animate: boolean;
}) {
  return (
    <li
      data-testid={`seat-${v.id}`}
      data-revealed="true"
      data-outlier={outlier ? 'true' : 'false'}
      className={cn(
        'flex min-w-[82px] flex-col items-center gap-2 text-center',
        animate ? 'anim-reveal-seat' : '',
      )}
    >
      <div
        aria-label={`${v.displayName} voted ${vote?.points ?? 'no vote'}`}
        className={cn(
          'relative grid h-[82px] w-[58px] place-items-center rounded-[12px] border-2 bg-surface shadow-[0_9px_20px_rgba(102,61,29,.18)]',
          outlier ? 'border-warning' : 'border-accent',
        )}
      >
        <span className="font-sans text-3xl font-extrabold text-text">{vote?.points ?? '—'}</span>
        {outlier ? (
          <span className="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full bg-warning-surface text-warning-on shadow-card">
            <TriangleAlert size={13} aria-label="outlier" />
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <span className={cn('grid size-9 place-items-center rounded-full border-2 text-xs font-extrabold', toneFor(v.id))}>
          {initials(v.displayName)}
        </span>
        <span className="min-w-0 text-left">
          <span className="block max-w-28 truncate text-sm font-bold text-text">
            {v.displayName}{isMe ? ' (you)' : ''}
          </span>
          <ConfidenceDots level={vote ? vote.confidence : 0} />
        </span>
      </div>
    </li>
  );
}

function ConfidenceDots({ level }: { level: number }) {
  return (
    <div role="img" aria-label={`Confidence ${level} of 5`} className="mt-0.5 flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((lvl) => (
        <span
          key={lvl}
          data-filled={lvl <= level ? 'true' : 'false'}
          className={cn('text-[8px] leading-none', lvl <= level ? 'text-text-secondary' : 'text-text-muted opacity-30')}
          aria-hidden="true"
        >
          ●
        </span>
      ))}
    </div>
  );
}
