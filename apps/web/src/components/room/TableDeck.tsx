import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';
import { CardBack } from './CardBack';

/**
 * Central board face-down tiles — one slot per seated voter.
 * Voted slots show the full cross-hatch back; unvoted slots show a ghost
 * outline so the "empty seat" is visible without revealing any information.
 */
export function TableDeck({ storyId }: { storyId: string }) {
  const voters = useRoomStore((s) => s.voters);
  const presence = useRoomStore((s) => s.votedPresence[storyId]);
  const me = useRoomStore((s) => s.me);
  const myVote = useRoomStore((s) => s.myVotes[storyId]);

  const seated = Object.values(voters).filter(
    (v) => v.connectionState !== 'left' && v.role !== 'spectator',
  );
  if (seated.length === 0) return null;

  const votedCount = seated.filter((v) =>
    v.id === me?.voterId ? Boolean(myVote) : Boolean(presence?.has(v.id)),
  ).length;

  return (
    <div
      role="img"
      aria-label={`${votedCount} of ${seated.length} cards placed`}
      className="flex flex-wrap gap-2"
    >
      {seated.map((v) => {
        const voted = v.id === me?.voterId
          ? Boolean(myVote)
          : Boolean(presence?.has(v.id));
        return (
          <CardBack
            key={v.id}
            className={cn('w-14 h-20', !voted && 'opacity-25 border-dashed [background-image:none]')}
          />
        );
      })}
    </div>
  );
}
