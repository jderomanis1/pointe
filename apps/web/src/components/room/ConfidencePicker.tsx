import { cn } from '../../lib/cn';

/**
 * Five-dot confidence picker (1 = least sure, 5 = most). Pre-selected at 3,
 * so picking only a card and casting at the default is one beat.
 * Neutral by design — the amber low-confidence flag is a reveal concept
 * (team average), not a per-voter cast-time signal.
 */
export type ConfidenceLevel = 1 | 2 | 3 | 4 | 5;
const LEVELS: ConfidenceLevel[] = [1, 2, 3, 4, 5];

export function ConfidencePicker({
  value, onChange, disabled,
}: {
  value: ConfidenceLevel;
  onChange: (v: ConfidenceLevel) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-meta text-text-secondary">Confidence</span>
      <div role="radiogroup" aria-label="Confidence" className="flex items-center gap-2">
        {LEVELS.map((lvl) => {
          const filled = lvl <= value;
          return (
            <button
              key={lvl}
              type="button"
              role="radio"
              aria-checked={value === lvl}
              aria-label={`Confidence ${lvl}`}
              data-level={lvl}
              data-filled={filled ? 'true' : 'false'}
              disabled={disabled}
              onClick={() => onChange(lvl)}
              className={cn(
                'h-5 w-5 rounded-pill border transition-colors duration-fast',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                'disabled:cursor-not-allowed',
                filled ? 'bg-text-secondary border-text-secondary' : 'bg-fill border-hairline',
              )}
            />
          );
        })}
        <span className="text-meta text-text-secondary ml-2">least → most</span>
      </div>
    </div>
  );
}
