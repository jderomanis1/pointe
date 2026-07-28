import { useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

const TRANS = '[transition:transform_220ms_cubic-bezier(.34,1.56,.64,1),box-shadow_160ms_ease,background-color_120ms_ease,border-color_120ms_ease,color_120ms_ease,opacity_120ms_ease]';

const CARD_BASE = cn(
  'pointe-vote-card relative h-[98px] w-[66px] shrink-0 select-none rounded-[12px] border-2 sm:h-[108px] sm:w-[74px]',
  TRANS,
  'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent focus-visible:ring-offset-3 focus-visible:ring-offset-bg',
  'disabled:cursor-not-allowed disabled:opacity-40',
);

const CARD_DEFAULT = cn(
  'cursor-pointer border-[#E7D4BB] bg-surface text-text shadow-[0_6px_14px_rgba(102,61,29,.14)]',
  'hover:border-accent hover:shadow-[0_12px_24px_rgba(102,61,29,.18)]',
);

const CARD_SELECTED = 'cursor-default border-[#E04F4F] bg-[#FFF8EC] text-[#A63731] shadow-[0_15px_28px_rgba(224,79,79,.24)]';

export function VoteCards({
  deck, selected, onSelect, disabled,
}: {
  deck: string[];
  selected: string | null;
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  const groupRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(e: ReactKeyboardEvent) {
    if (!groupRef.current) return;
    const cards = Array.from(
      groupRef.current.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])')
    );
    if (cards.length === 0) return;
    const idx = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (idx < 0) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = cards[(idx + 1) % cards.length];
      next.focus();
      onSelect(next.dataset.value!);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = cards[(idx - 1 + cards.length) % cards.length];
      prev.focus();
      onSelect(prev.dataset.value!);
    }
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Story points"
      className="pointe-card-hand flex w-full items-end overflow-x-auto px-4 pb-7 pt-5 sm:justify-center sm:overflow-visible sm:px-8"
      onKeyDown={handleKeyDown}
    >
      {deck.map((v, i) => {
        const isSel = selected === v;
        const tIdx = isSel || (selected === null && i === 0) ? 0 : -1;
        const mid = (deck.length - 1) / 2;
        const rotation = Math.max(-14, Math.min(14, (i - mid) * 2.8));
        const lift = Math.abs(i - mid) * 1.6;
        const cardStyle = {
          '--card-rotation': `${rotation}deg`,
          '--card-lift': `${lift}px`,
          zIndex: isSel ? deck.length + 2 : i + 1,
        } as CSSProperties;

        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={isSel}
            data-selected={isSel ? 'true' : 'false'}
            data-value={v}
            tabIndex={tIdx}
            disabled={disabled}
            onClick={() => onSelect(v)}
            style={cardStyle}
            className={cn(CARD_BASE, i > 0 && '-ml-2.5 sm:-ml-3', isSel ? CARD_SELECTED : CARD_DEFAULT)}
          >
            <span aria-hidden="true" className="absolute left-2 top-1.5 text-[10px] font-extrabold leading-none">{v}</span>
            <span className="absolute inset-0 flex items-center justify-center font-sans text-[1.65rem] font-extrabold leading-none sm:text-[1.85rem]">
              {v}
            </span>
            <span aria-hidden="true" className="absolute bottom-1.5 right-2 rotate-180 text-[10px] font-extrabold leading-none">{v}</span>
          </button>
        );
      })}
    </div>
  );
}
