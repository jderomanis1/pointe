import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';
import { CardBack } from './CardBack';

/**
 * Central board face-down tiles — one slot per seated voter who hasn't left.
 *
 * Four slot states (connectionState × voted):
 *   connected + voted     → full hatch, full opacity  (card is on the table)
 *   connected + not-voted → ghost (dashed, no hatch, opacity-25)  (awaiting play)
 *   reconnecting + voted  → full hatch at opacity-45  (offline but vote is placed)
 *   reconnecting + not-voted → ghost at opacity-45    (offline, seat reserved)
 *
 * 'left' voters are excluded — their slot collapses per Section 4.4.
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
        const offline = v.connectionState === 'reconnecting';

        if (voted) {
          // Card is on the table — show hatch; dim to 0.45 if voter went offline.
          return (
            <CardBack
              key={v.id}
              className={cn('w-14 h-20', offline && 'opacity-45')}
            />
          );
        }
        // No card placed yet — ghost placeholder; dimmer still if offline.
        return (
          <CardBack
            key={v.id}
            className={cn(
              'w-14 h-20 border-dashed [background-image:none]',
              offline ? 'opacity-45' : 'opacity-25',
            )}
          />
        );
      })}
    </div>
  );
}
