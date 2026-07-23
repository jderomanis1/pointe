import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { CardBack } from './CardBack';

// Section 4.1 — five-phase reveal animation per voter card. Phase 5 in Increment 8.
type Phase = 'back' | 'flipping' | 'cycling' | 'face' | 'shaking' | 'done';

const FACE_CARD = 'absolute inset-0 rounded-[2px] bg-surface border border-[var(--border-strong)] flex flex-col items-center justify-center gap-1';
// PILL dims match RevealedSeat (VoterSeats) for zero-CLS handoff at animation end.
const PILL = 'inline-flex items-center gap-3 px-3 py-2 rounded-[2px] border bg-surface';

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
  // Section 6.1: skip all motion, render settled face immediately.
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
      setPhase('cycling');                           // Phase 2: front face swings in −90°→0°

      const t0 = performance.now();
      let lastSwap = t0;
      await new Promise<void>((res) => {
        function tick() {
          const now = performance.now();
          if (dead || now - t0 >= 150) { res(); return; }
          if (now - lastSwap >= 25 && deckValues.length) {  // 25ms → ~6 ticks at any Hz
            setDisplay(deckValues[Math.floor(Math.random() * deckValues.length)]);
            lastSwap = now;
          }
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
      if (dead) return;

      setDisplay(value);
      setPhase('face');                              // Phase 3: lock value + switch to serif

      await pause(0);
      if (dead) return;
      setPhase('shaking');                           // Phase 4: micro-shake

      await pause(100);
      if (dead) return;
      setPhase('done');                              // collapse to pill for zero-CLS handoff
    }

    run();
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Settled pill — matches RevealedSeat layout. h-1.5 spacer holds ConfidenceDots height.
  if (phase === 'done') {
    return (
      <li
        data-testid={`seat-${voterId}`}
        data-revealed="true"
        data-outlier={outlier ? 'true' : 'false'}
        className={cn(PILL, outlier ? 'border-warning' : 'border-hairline')}
      >
        <span className="font-serif text-num text-text tabular-nums">{value}</span>
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-meta text-text font-medium truncate max-w-[100px]">
            {voterName}{isMe ? ' (you)' : ''}
          </span>
          <div className="h-1.5" aria-hidden="true" />
        </div>
      </li>
    );
  }

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
        className={cn(FACE_CARD, outlier && 'border-warning', phase === 'shaking' && 'anim-micro-shake')}
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
