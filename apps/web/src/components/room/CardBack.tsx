import { cn } from '../../lib/cn';

// Cross-hatch gradient replicates the ink hatching pattern from DESIGN_SPEC Section 3.2.
// Inline style keeps the long repeating-linear-gradient readable; all values are tokens.
const HATCH: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, var(--border-hairline) 0, var(--border-hairline) 1px, transparent 0, transparent 8px)',
};

export function CardBack({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      style={HATCH}
      className={cn(
        'relative w-24 h-32 rounded-[2px]',
        'bg-surface border border-[var(--border-strong)]',
        className,
      )}
    >
      <span className="absolute inset-0 flex items-center justify-center font-mono text-meta uppercase tracking-[0.12em] text-text-secondary">
        POINTE
      </span>
    </div>
  );
}
