import { cn } from '../../lib/cn';

/**
 * Deck as selectable cards. Mono values (numbers have their own voice).
 * One selectable at a time; selected = subtle-accent (accent-tint bg + accent border),
 * not a second saturated accent (the cast button keeps that slot).
 * Non-numeric values like '?' and '∞' are normal selectable cards.
 */
export function VoteCards({
  deck, selected, onSelect, disabled,
}: {
  deck: string[];
  selected: string | null;
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Story points" className="flex flex-wrap gap-2">
      {deck.map((v) => {
        const isSel = selected === v;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={isSel}
            data-value={v}
            disabled={disabled}
            onClick={() => onSelect(v)}
            className={cn(
              'min-w-12 h-16 px-3 rounded-md border font-mono text-num',
              'transition-colors duration-fast',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'disabled:cursor-not-allowed disabled:text-text-disabled',
              isSel
                ? 'bg-accent-tint border-accent text-accent'
                : 'bg-surface border-hairline text-text hover:bg-fill',
            )}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}
