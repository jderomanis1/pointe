import { useEffect, useId, useState, type ReactNode } from 'react';
import { Check, EyeOff, HelpCircle, X } from 'lucide-react';
import type { AISuggestion, DimLevel } from '@pointe/shared';
import { Button } from '../Button';
import { cn } from '../../lib/cn';

/**
 * S8.iii.c2 + S8.iv.c1 — the AI suggestion panel.
 *
 * Two viewer contexts and two share states, all in one component:
 *   • S8.iii pre-reveal, host: host-private during voting. Shows
 *     "Visible to you only". No share — you can't share before reveal.
 *   • S8.iv reveal, host, NOT YET SHARED: same "Visible to you only" plus
 *     the armed oxblood "Share with the team" button + the "or keep it
 *     as your reference" caption.
 *   • S8.iv reveal, ANY viewer, SHARED: "Visible to you only" drops; share
 *     button drops; a quiet contextual shared label appears
 *     (host → "Shared with the team", non-host → "Shared by the host").
 *     Panel is read-only.
 *
 * The visibility gate (host-private during pre-reveal; voter-renders-only-
 * after-share) lives at the call-site. AA-1 holds because a voter's
 * `story.ai` is undefined until AI_SHARED lands — they have nothing to pass
 * to this component until the host shares.
 */
export type AiSuggestionPanelProps = {
  ai: AISuggestion;
  /** Whose viewer is this? Drives the shared label wording + share affordance. */
  isHost?: boolean;
  /** True iff story.state is 'revealed' or 'committed'. Gates the share button. */
  revealed?: boolean;
  /** Called when the host clicks "Share with the team". Required for the
   *  share button to render; undefined disables it entirely. */
  onShare?: () => void;
  className?: string;
  /** Slot rendered below the rationale, above any built-in footer (share /
   *  shared label). Reserved for future extension; the slice doesn't use it. */
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

export function AiSuggestionPanel({
  ai, isHost = false, revealed = false, onShare, className, footerSlot,
}: AiSuggestionPanelProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  // S10 a11y-keyboard §3 (resolved A): the "What's CERU?" popover is a
  // disclosure, NOT a modal. Trigger toggles it; Escape closes it as a
  // cheap nice-to-have. No focus-trap, no focus-move-into — those are
  // modal behaviors that don't belong on an informational popover.
  // The trigger button carries `aria-expanded`/`aria-controls` and the
  // panel is a labelled region (see CeruPopover + PanelHeader).
  const togglePopover = () => setPopoverOpen((o) => !o);
  const popoverId = useId();
  const popoverHeadingId = `${popoverId}-heading`;
  useEffect(() => {
    if (!popoverOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopoverOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [popoverOpen]);
  const shared = ai.state === 'ready' && ai.shared === true;
  // The armed share button only renders for a host at reveal, with a
  // not-yet-shared ready suggestion AND an onShare handler wired up.
  const canShare = isHost && revealed && ai.state === 'ready' && !shared && !!onShare;

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
        <PanelHeader
          open={popoverOpen}
          onToggle={togglePopover}
          controlsId={popoverId}
        />
        <p className="text-meta text-text-muted">Asking…</p>
        {popoverOpen ? (
          <CeruPopover
            id={popoverId}
            headingId={popoverHeadingId}
            onClose={() => setPopoverOpen(false)}
          />
        ) : null}
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
        <PanelHeader
          open={popoverOpen}
          onToggle={togglePopover}
          controlsId={popoverId}
        />
        <p className="text-meta text-text-muted">
          AI unavailable
          {ai.errorMessage ? (
            <span className="font-mono text-text-secondary">{` · ${ai.errorMessage}`}</span>
          ) : null}
        </p>
        {popoverOpen ? (
          <CeruPopover
            id={popoverId}
            headingId={popoverHeadingId}
            onClose={() => setPopoverOpen(false)}
          />
        ) : null}
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
      <PanelHeader
        open={popoverOpen}
        onToggle={togglePopover}
        controlsId={popoverId}
      />

      {/* Visibility caption — drops once the suggestion is shared. */}
      {!shared ? (
        <p
          className="flex items-center gap-1.5 text-caption text-text-muted"
          data-slot="visibility-caption"
        >
          <EyeOff size={12} aria-hidden="true" />
          <span>Visible to you only</span>
        </p>
      ) : null}

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

      {/* S8.iv.c1 footer: at reveal, either the armed share button (host,
       *  not-yet-shared) OR the contextual shared label (anyone, post-share).
       *  Pre-reveal renders neither. */}
      {canShare ? (
        <div
          data-slot="share-affordance"
          className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
        >
          <Button
            variant="primary"
            size="sm"
            onClick={onShare}
          >
            Share with the team
          </Button>
          <p className="text-caption text-text-muted">
            or keep it as your reference
          </p>
        </div>
      ) : shared ? (
        <p
          data-slot="shared-label"
          className="flex items-center gap-1.5 text-caption text-text-secondary"
        >
          <Check size={12} aria-hidden="true" />
          <span>{isHost ? 'Shared with the team' : 'Shared by the host'}</span>
        </p>
      ) : null}

      {popoverOpen ? (
        <CeruPopover
          id={popoverId}
          headingId={popoverHeadingId}
          onClose={() => setPopoverOpen(false)}
        />
      ) : null}
    </section>
  );
}

function PanelHeader({
  open, onToggle, controlsId,
}: {
  open: boolean;
  onToggle: () => void;
  controlsId: string;
}) {
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
        onClick={onToggle}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-sm px-2 py-1',
          'border border-hairline bg-surface text-text-secondary',
          'text-caption font-sans',
          'hover:bg-fill transition-colors duration-fast',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
        // Disclosure pattern: trigger advertises its disclosed state +
        // names the controlled region. NOT `aria-haspopup` — that would
        // re-imply the modal-dialog promise we explicitly demoted from.
        aria-expanded={open}
        aria-controls={controlsId}
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

/**
 * S10 a11y-keyboard §3 (resolved A): rendered as a labelled disclosure
 * region, NOT `role="dialog"`. The trigger (PanelHeader) carries
 * `aria-expanded`/`aria-controls` and toggles `popoverOpen`; Escape
 * also closes (parent `useEffect`). No focus-trap, no forced
 * focus-move-into — those are the modal behaviors the demote
 * deliberately leaves off. The inline X button stays as a redundant
 * mouse/touch dismissal; on the keyboard the trigger toggle and
 * Escape are the two paths.
 */
function CeruPopover({
  id, headingId, onClose,
}: {
  id: string;
  headingId: string;
  onClose: () => void;
}) {
  return (
    <div
      id={id}
      role="region"
      aria-labelledby={headingId}
      className={cn(
        'mt-2 bg-surface border border-hairline rounded-md p-4',
        'flex flex-col gap-2',
      )}
      style={{ borderWidth: '0.5px' }}
    >
      <div className="flex items-start justify-between gap-3">
        <span id={headingId} className="font-sans font-medium text-text">What&rsquo;s CERU?</span>
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
