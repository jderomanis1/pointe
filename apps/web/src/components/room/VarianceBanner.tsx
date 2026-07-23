import { resolveDeck } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';

// Section 3.10 — high-spread warning when min/max votes are ≥ 2 deck positions apart.
export function VarianceBanner({ storyId }: { storyId: string }) {
  const reveal = useRoomStore((s) => s.revealed[storyId]);
  const room = useRoomStore((s) => s.room);

  if (!reveal || !room) return null;

  const deck = resolveDeck(room.deck, room.customDeck);
  const positions = reveal.votes
    .map((v) => deck.indexOf(v.points))
    .filter((i) => i !== -1);

  if (positions.length < 2) return null;
  const minPos = Math.min(...positions);
  const maxPos = Math.max(...positions);
  if (maxPos - minPos < 2) return null;

  return (
    <div
      role="status"
      className="border-l-4 border-warning bg-warning-surface text-text font-mono uppercase tracking-[0.08em] px-4 py-3"
    >
      {`NOTICE: VOTE SPREAD HIGH (${deck[minPos]} TO ${deck[maxPos]})`}
    </div>
  );
}
