import { resolveDeck } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { RevealCard } from './RevealCard';

// Section 4.1 — animated card flip deck shown on the live active→revealed edge.
// Replaced by VoterSeats (revealed mode) once animateReveal resets to false (~1s).
export function RevealDeck({ storyId }: { storyId: string }) {
  const voters = useRoomStore((s) => s.voters);
  const reveal = useRoomStore((s) => s.revealed[storyId]);
  const me = useRoomStore((s) => s.me);
  const room = useRoomStore((s) => s.room);

  if (!reveal || !room) return null;

  const deckValues = resolveDeck(room.deck, room.customDeck);
  const voteByVoter = new Map(reveal.votes.map((v) => [v.voterId, v]));
  const outliers = new Set<string>(reveal.stats?.outliers ?? []);

  const seated = Object.values(voters)
    .filter((v) => v.connectionState !== 'left' && v.role !== 'spectator')
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  if (seated.length === 0) return null;

  return (
    <div>
      <p className="font-mono text-meta text-text-secondary mb-2 uppercase tracking-[0.12em]">
        Votes · {seated.length}
      </p>
      <ul className="flex flex-wrap gap-2">
        {seated.map((v, i) => (
          <RevealCard
            key={v.id}
            voterId={v.id}
            value={voteByVoter.get(v.id)?.points ?? '—'}
            deckValues={deckValues}
            delay={i * 50}
            voterName={v.displayName}
            isMe={v.id === me?.voterId}
            outlier={outliers.has(v.id)}
          />
        ))}
      </ul>
    </div>
  );
}
