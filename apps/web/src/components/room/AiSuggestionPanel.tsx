import { useState, type ReactNode } from 'react';
import { EyeOff, HelpCircle, X } from 'lucide-react';
import type { AISuggestion, DimLevel } from '@pointe/shared';
import { cn } from '../../lib/cn';

/**
 * S8.iii.c2 — the host's private AI suggestion panel.
 *
 * Rendered from a `ready` or `failed` AISuggestion. Voters never see this
 * component — the visibility gate lives one level up (S8.iii.c3 wires it
 * to `isHost && story.ai`). All design-token only — no hardcoded hex.
 *
 * Scope per the slice: NO share control here. Sharing is a post-reveal act
 * landing in S8.iv. The component leaves a slot intent (`footerSlot`) so
 * S8.iv can extend without rewriting the panel.
 */
export type AiSuggestionPanelProps = {
  ai: AISuggestion;
  className?: string;
  /** S8.iv extension point: rendered below the rationale (e.g. a share row). */
  footerSlot?: ReactNode;
};

const LEVEL_FILLED: Record<DimLevel, number> = { low: 1, medium: 2, high: 3 };
const DIMENSIONS = ['complexity', 'effort', 'risk', 'unknowns'] as const;
const DIM_LABEL: Record<typeof DIMENSIONS[number], string> = {
  complexity: 'Complexity',
  effort: 'Effort',
  risk: 'Risk',
  unknowns: 'Unknowns',
};

export function AiSuggestionPanel({ ai, className, footerSlot }: AiSuggestionPanelProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);

  if (ai.state === 'pending') {
    // Quiet pending state — the ask affordance (c3) drives this UX,
    // but render something safe if the panel is mounted while pending.
    return (
      <section
        className={cn(
          'bg-surface border-hairline rounded-md p-4 flex flex-col gap-2',
          className,
        )}
        style={{ borderWidth: '0.5px' }}
        aria-label="AI suggestion (pending)"
      >
        <PanelHeader onWhatIsCeru={() => setPopoverOpen(true)} />
        <p className="text-meta text-text-muted">Asking…</p>
        {popoverOpen ? <CeruPopover onClose={() => setPopoverOpen(false)} /> : null}
      </section>
    );
  }

  if (ai.state === 'failed') {
    return (
      <section
        className={cn(
          'bg-surface border-hairline rounded-md p-4 flex flex-col gap-2',
          className,
        )}
        style={{ borderWidth: '0.5px' }}
        aria-label="AI suggestion (unavailable)"
      >
        <PanelHeader onWhatIsCeru={() => setPopoverOpen(true)} />
        <p className="text-meta text-text-muted">
          AI unavailable
          {ai.errorMessage ? (
            <span className="font-mono text-text-secondary">{` · ${ai.errorMessage}`}</span>
          ) : null}
        </p>
        {popoverOpen ? <CeruPopover onClose={() => setPopoverOpen(false)} /> : null}
      </section>
    );
  }

  // ai.state === 'ready'
  return (
    <section
      className={cn(
        'bg-surface border-hairline rounded-md p-4 md:p-5 flex flex-col gap-4',
        className,
      )}
      style={{ borderWidth: '0.5px' }}
      aria-label="AI suggestion"
    >
      <PanelHeader onWhatIsCeru={() => setPopoverOpen(true)} />

      <p className="flex items-center gap-1.5 text-caption text-text-muted">
        <EyeOff size={12} aria-hidden="true" />
        <span>Visible to you only</span>
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3">
        {DIMENSIONS.map((dim) => (
          <CeruCell
            key={dim}
            name={DIM_LABEL[dim]}
            level={ai[dim].level}
            note={ai[dim].note}
          />
        ))}
      </div>

      <hr className="border-0 border-t border-hairline" style={{ borderTopWidth: '0.5px' }} />

      <div className="flex items-baseline gap-2">
        <span className="text-caption text-text-secondary uppercase tracking-[var(--tracking-caption)]">
          Suggested range
        </span>
        <span className="font-mono font-medium text-text" style={{ fontSize: '19px' }}>
          {ai.suggestedRange.low}<span className="text-text-muted">–</span>{ai.suggestedRange.high}
        </span>
      </div>

      <p
        className="font-sans text-body text-text-secondary"
        style={{ lineHeight: 1.6 }}
        data-slot="rationale"
      >
        {ai.rationale}
      </p>

      {footerSlot}

      {popoverOpen ? <CeruPopover onClose={() => setPopoverOpen(false)} /> : null}
    </section>
  );
}

function PanelHeader({ onWhatIsCeru }: { onWhatIsCeru: () => void }) {
  return (
    <header className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="bg-warning inline-block rounded-pill"
          style={{ width: '6px', height: '6px' }}
        />
        <span className="font-sans font-medium text-subhead text-text">AI suggestion</span>
      </div>
      <button
        type="button"
        onClick={onWhatIsCeru}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-sm px-2 py-1',
          'border border-hairline bg-surface text-text-secondary',
          'text-caption font-sans',
          'hover:bg-fill transition-colors duration-fast',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
        aria-haspopup="dialog"
      >
        <HelpCircle size={12} aria-hidden="true" />
        <span>What&rsquo;s CERU?</span>
      </button>
    </header>
  );
}

function CeruCell({ name, level, note }: { name: string; level: DimLevel; note: string }) {
  const filled = LEVEL_FILLED[level];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-sans text-meta text-text-secondary">{name}</span>
        <span className="font-mono text-meta text-warning lowercase">{level}</span>
      </div>
      <SegmentedIndicator filled={filled} aria-label={`${name} ${level}`} />
      <p className="font-sans text-meta text-text-secondary">{note}</p>
    </div>
  );
}

function SegmentedIndicator({ filled, ...rest }: {
  filled: number; 'aria-label'?: string;
}) {
  return (
    <div className="flex items-center gap-1" role="img" {...rest}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            'inline-block rounded-pill',
            i <= filled ? 'bg-warning' : 'border-hairline border bg-transparent',
          )}
          style={{ width: '18px', height: '4px' }}
        />
      ))}
    </div>
  );
}

const CERU_COPY = [
  'Pointe’s AI sizes a story across Mike Cohn’s four dimensions — an independent reference, never a verdict.',
  'Complexity — how tangled is the work? Interacting parts, edge cases, unclear logic.',
  'Effort — how much volume, regardless of difficulty? The sheer amount of work.',
  'Risk — what could go wrong, and how far does it spread? The blast radius if it breaks.',
  'Unknowns — what isn’t decided yet? Open questions and undefined scope.',
] as const;

function CeruPopover({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="What is CERU?"
      className={cn(
        'mt-2 bg-surface border border-hairline rounded-md p-4',
        'flex flex-col gap-2',
      )}
      style={{ borderWidth: '0.5px' }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-sans font-medium text-text">What&rsquo;s CERU?</span>
        <button
          type="button"
          onClick={onClose}
          className="text-text-muted hover:text-text transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
          aria-label="Close"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <ul className="flex flex-col gap-1 text-meta text-text-secondary">
        {CERU_COPY.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
