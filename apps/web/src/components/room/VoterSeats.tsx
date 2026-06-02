import type { Voter } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

/**
 * Voter seats — presence only, never values.
 *
 * Renders membership in `votedPresence[activeStoryId]` (a Set of voterIds).
 * The store shape physically can't hold a peer's points/confidence pre-reveal,
 * so this component is value-free by construction. The local user's own state
 * may surface from `myVotes` later (R5.iii); peers always show presence only.
 */
export function VoterSeats({ activeStoryId }: { activeStoryId: string }) {
  const voters = useRoomStore((s) => s.voters);
  const presence = useRoomStore((s) => s.votedPresence[activeStoryId]);
  const me = useRoomStore((s) => s.me);
  const myVote = useRoomStore((s) => s.myVotes[activeStoryId]);

  const all = Object.values(voters).filter((v) => v.connectionState !== 'left');
  const seated = all.filter((v) => v.role !== 'spectator');
  const spectators = all.filter((v) => v.role === 'spectator');

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-meta text-text-secondary mb-2">Voters · {seated.length}</h3>
        <ul className="flex flex-wrap gap-2">
          {seated.map((v) => {
            const isMe = v.id === me?.voterId;
            const hasVoted = isMe ? Boolean(myVote) : Boolean(presence?.has(v.id));
            return <Seat key={v.id} v={v} hasVoted={hasVoted} isMe={isMe} />;
          })}
        </ul>
      </div>
      {spectators.length > 0 ? (
        <div>
          <h3 className="text-meta text-text-secondary mb-2">Watching · {spectators.length}</h3>
          <ul className="flex flex-wrap gap-2">
            {spectators.map((v) => (
              <li
                key={v.id}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-pill bg-fill text-text-muted text-meta"
              >
                <span className="truncate">{v.displayName}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Seat({ v, hasVoted, isMe }: { v: Voter; hasVoted: boolean; isMe: boolean }) {
  return (
    <li
      data-testid={`seat-${v.id}`}
      data-voted={hasVoted ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded-pill border',
        hasVoted ? 'border-accent bg-accent-tint text-accent' : 'border-hairline bg-surface text-text-secondary',
      )}
    >
      <PresenceDot voted={hasVoted} />
      <span className="truncate text-meta font-medium">
        {v.displayName}{isMe ? ' (you)' : ''}
      </span>
    </li>
  );
}

function PresenceDot({ voted }: { voted: boolean }) {
  return (
    <span
      aria-label={voted ? 'voted' : 'not yet'}
      className={cn(
        'inline-block h-2 w-2 rounded-pill',
        voted ? 'bg-accent' : 'bg-text-muted',
      )}
    />
  );
}
