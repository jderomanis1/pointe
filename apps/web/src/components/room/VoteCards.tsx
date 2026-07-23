import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

// --ease-snap for all micro-interactions per Section 3.1.
const TRANS = '[transition:transform_80ms_cubic-bezier(0.1,0.9,0.2,1),box-shadow_80ms_cubic-bezier(0.1,0.9,0.2,1),background-color_80ms_cubic-bezier(0.1,0.9,0.2,1),border-color_80ms_cubic-bezier(0.1,0.9,0.2,1),color_80ms_cubic-bezier(0.1,0.9,0.2,1)]';

const CARD_BASE = cn(
  'relative w-24 h-32 rounded-[2px] border select-none',
  TRANS,
  'focus-visible:[outline:2px_solid_var(--border-focus)] focus-visible:[outline-offset:2px]',
  'disabled:opacity-40 disabled:cursor-not-allowed disabled:border-dashed',
);

const CARD_DEFAULT = cn(
  'bg-surface border-hairline text-text cursor-pointer',
  'hover:-translate-y-0.5 hover:border-text hover:shadow-[var(--shadow-hard-sm)]',
  'active:translate-x-px active:translate-y-px active:shadow-none',
);

const CARD_SELECTED = 'bg-fill border-2 border-accent text-accent-text shadow-[var(--shadow-hard-md)] cursor-default';

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
      className="flex flex-wrap gap-3"
      onKeyDown={handleKeyDown}
    >
      {deck.map((v, i) => {
        const isSel = selected === v;
        // Roving tabIndex: selected card (or first when nothing selected) receives focus.
        const tIdx = isSel || (selected === null && i === 0) ? 0 : -1;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={isSel}
            data-value={v}
            tabIndex={tIdx}
            disabled={disabled}
            onClick={() => onSelect(v)}
            className={cn(CARD_BASE, isSel ? CARD_SELECTED : CARD_DEFAULT)}
          >
            {/* Top-left corner index */}
            <span aria-hidden="true" className="absolute top-1.5 left-1.5 font-serif text-[10px] leading-none">{v}</span>
            {/* Top-right corner: pip when selected, value otherwise */}
            <span aria-hidden="true" className="absolute top-1.5 right-1.5 font-serif text-[10px] leading-none">
              {isSel ? '●' : v}
            </span>
            {/* Center value — screen readers announce only this */}
            <span className="absolute inset-0 flex items-center justify-center font-serif text-display leading-none">
              {v}
            </span>
            {/* Bottom corners rotated 180° */}
            <span aria-hidden="true" className="absolute bottom-1.5 left-1.5 font-serif text-[10px] leading-none rotate-180">{v}</span>
            <span aria-hidden="true" className="absolute bottom-1.5 right-1.5 font-serif text-[10px] leading-none rotate-180">
              {isSel ? '●' : v}
            </span>
          </button>
        );
      })}
    </div>
  );
}
