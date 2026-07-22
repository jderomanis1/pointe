import { useRef } from 'react';
import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

// Section 3.9 + Section 4.1 Phase 5 — unanimous consensus indicator.
// Slams scale(1.4) → scale(1.0) at rotate(-3deg) in 80ms on first reveal.
export function ConsensusStamp({ storyId, animate }: { storyId: string; animate: boolean }) {
  const reveal = useRoomStore((s) => s.revealed[storyId]);
  const voters = useRoomStore((s) => s.voters);
  const reduced = useRef(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  ).current;

  if (!reveal) return null;

  const seated = Object.values(voters).filter(
    (v) => v.connectionState !== 'left' && v.role !== 'spectator',
  );
  const { votes } = reveal;
  if (votes.length === 0 || votes.length !== seated.length) return null;

  const consensusValue = votes[0].points;
  if (!votes.every((v) => v.points === consensusValue)) return null;

  return (
    <div
      role="status"
      className={cn(
        'self-start rotate-[-3deg]',
        'border-[3px] border-success text-success-on bg-success-surface',
        'font-mono font-black uppercase tracking-[0.12em] px-8 py-4',
        'shadow-[var(--shadow-stamp)]',
        animate && !reduced && 'anim-stamp-slam',
      )}
    >
      <span aria-hidden="true">★ </span>
      {`UNANIMOUS CONSENSUS: ${consensusValue} PTS`}
    </div>
  );
}
