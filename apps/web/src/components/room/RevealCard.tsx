import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { CardBack } from './CardBack';

// Section 4.1 — five-phase reveal animation per voter card.
// Phase 5 (ConsensusStamp) is deferred to Increment 8.
type Phase = 'back' | 'flipping' | 'cycling' | 'face' | 'shaking' | 'done';

const FACE = 'absolute inset-0 rounded-[2px] bg-surface border border-[var(--border-strong)] flex flex-col items-center justify-center gap-1';

export function RevealCard({
  voterId, value, deckValues, delay, voterName, isMe, outlier,
}: {
  voterId: string;
  value: string;
  deckValues: string[];
  delay: number;
  voterName: string;
  isMe: boolean;
  outlier: boolean;
}) {
  // Section 6.1: skip all phases, land on settled face immediately.
  const reduced = useRef(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  ).current;

  const [phase, setPhase] = useState<Phase>(reduced ? 'done' : 'back');
  const [display, setDisplay] = useState(reduced ? value : '');

  useEffect(() => {
    if (reduced) return;
    let dead = false;
    const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    async function run() {
      await pause(delay);
      if (dead) return;
      setPhase('flipping');                          // Phase 1: CSS rotates back face 0°→90°

      await pause(100);
      if (dead) return;
      setPhase('cycling');                           // Phase 2: front face rotates in −90°→0°

      const t0 = performance.now();
      await new Promise<void>((res) => {
        function tick() {
          if (dead || performance.now() - t0 >= 150) { res(); return; }
          if (deckValues.length) {
            setDisplay(deckValues[Math.floor(Math.random() * deckValues.length)]);
          }
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
      if (dead) return;

      setDisplay(value);
      setPhase('face');                              // Phase 3: lock + switch to serif

      await pause(0);
      if (dead) return;
      setPhase('shaking');                           // Phase 4: micro-shake

      await pause(100);
      if (dead) return;
      setPhase('done');
    }

    run();
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showFront = phase !== 'back' && phase !== 'flipping';
  const bY = phase === 'back' ? 0 : 90;
  const fY = showFront ? 0 : -90;
  const bTrans = phase === 'flipping' ? 'transform 100ms var(--ease-mechanical)' : 'none';
  const fTrans = phase === 'cycling' ? 'transform 150ms var(--ease-mechanical)' : 'none';

  return (
    <li
      data-testid={`seat-${voterId}`}
      data-revealed="true"
      data-outlier={outlier ? 'true' : 'false'}
      className="relative w-14 h-20"
      style={{ perspective: '600px' }}
    >
      <div
        className="absolute inset-0"
        style={{ transform: `rotateY(${bY}deg)`, transition: bTrans, backfaceVisibility: 'hidden' }}
      >
        <CardBack className="w-full h-full" />
      </div>
      <div
        className={cn(FACE, outlier && 'border-warning', phase === 'shaking' && 'anim-micro-shake')}
        style={{ transform: `rotateY(${fY}deg)`, transition: fTrans, backfaceVisibility: 'hidden' }}
        aria-label={`${voterName}${isMe ? ' (you)' : ''} voted ${value}`}
      >
        <span className={cn(
          'text-num text-text tabular-nums leading-none',
          phase === 'cycling' ? 'font-mono' : 'font-serif',
        )}>
          {display}
        </span>
        <span className="font-mono text-caption text-text-muted truncate max-w-[48px] text-center">
          {voterName}{isMe ? '*' : ''}
        </span>
      </div>
    </li>
  );
}
