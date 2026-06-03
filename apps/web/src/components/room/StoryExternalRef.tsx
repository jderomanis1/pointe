import type { Story } from '@pointe/shared';
import { cn } from '../../lib/cn';

/**
 * S8.iii.c4 — render a story's external tracker reference.
 *
 * When `externalUrl` is present: a safe link with `rel="noopener noreferrer"`
 * and `target="_blank"`. Label = `externalId` when set, else a generic
 * "link" so users with URL-only stories still get an affordance.
 *
 * SI-04: plain-text rendering only. `externalId` and the label flow as text
 * children — never via `dangerouslySetInnerHTML`. `href` is the URL verbatim
 * (browsers handle URL parsing); we don't reconstruct or interpolate.
 *
 * Note: `externalUrl` is host-facing only. It is NEVER sent to the AI — the
 * boundary lives in `apps/worker/src/ai.ts` (the `requestCeruSuggestion`
 * signature takes story text + deck, no URL). This component does not
 * change that contract.
 */
export function StoryExternalRef({
  story, className,
}: { story: Story; className?: string }) {
  const { externalId, externalUrl } = story;
  if (!externalId && !externalUrl) return null;

  const label = externalId ?? 'link';
  const linkClass = cn(
    'font-mono text-meta text-text-secondary',
    'underline-offset-2 hover:underline hover:text-accent transition-colors duration-fast',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm',
    className,
  );

  if (externalUrl) {
    return (
      <a
        href={externalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        data-slot="story-external-link"
      >
        {label}
      </a>
    );
  }

  return (
    <span className={cn('font-mono text-meta text-text-muted', className)}>
      {externalId}
    </span>
  );
}
