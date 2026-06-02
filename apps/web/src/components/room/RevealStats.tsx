import { TriangleAlert } from 'lucide-react';
import type { RevealStats as RevealStatsT } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

/**
 * The verdict panel: mono median (num-hero) as the hero, outliers, avg confidence,
 * the amber low-confidence flag when team avg < 2.5 (Pillar 3 payoff).
 *
 * Reads `revealed[storyId].stats` straight — same shape live (votes_revealed DELTA)
 * and on snapshot-hydrate (computed client-side via the shared pure function in R5.i).
 * Graceful edges: zero numeric votes → calm 'no estimate' state, no NaN, no crash.
 *
 * `animateReveal` triggers the median pop + flag fade-in on the live edge only;
 * on hydrate the stats are already present and animation stays off.
 */
export function RevealStats({
  storyId, animateReveal,
}: {
  storyId: string;
  animateReveal: boolean;
}) {
  const reveal = useRoomStore((s) => s.revealed[storyId]);
  const voters = useRoomStore((s) => s.voters);

  if (!reveal) return null;
  const stats: RevealStatsT | null = reveal.stats;
  const voteCount = reveal.votes.length;

  if (voteCount === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-meta text-text-secondary">Result</h3>
        <p className="text-body text-text-secondary">No votes cast — nothing to estimate.</p>
      </section>
    );
  }
  if (!stats) return null;

  const allNonNumeric = stats.numericCount === 0;
  const hasNonNumeric = stats.nonNumeric.length > 0;
  const outlierNames = stats.outliers
    .map((vid) => voters[vid]?.displayName)
    .filter((n): n is string => Boolean(n));

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-meta text-text-secondary mb-2">Result</h3>
        {allNonNumeric ? (
          <p className="text-heading font-serif text-text">Needs discussion</p>
        ) : (
          <div className="flex items-baseline gap-3 flex-wrap">
            <span
              className={cn(
                'font-mono text-num-hero text-text leading-tight',
                animateReveal ? 'anim-reveal-median' : '',
              )}
              aria-label={`Median ${stats.median}`}
            >
              {stats.median}
            </span>
            <span className="text-meta text-text-secondary">median</span>
          </div>
        )}
      </div>

      <dl className="grid gap-3 grid-cols-1 sm:grid-cols-2">
        {!allNonNumeric ? (
          <div>
            <dt className="text-meta text-text-secondary">Avg confidence</dt>
            <dd className="text-body text-text font-mono mt-1">
              {stats.avgConfidence !== null ? stats.avgConfidence.toFixed(1) : '—'}
              <span className="text-text-secondary"> / 5</span>
            </dd>
          </div>
        ) : null}
        {outlierNames.length > 0 ? (
          <div>
            <dt className="text-meta text-text-secondary">Outliers</dt>
            <dd className="text-body text-text mt-1">{outlierNames.join(', ')}</dd>
          </div>
        ) : null}
        {/* Surface non-numeric voters only when there's a partial split — the all-non-numeric
            heading already says "Needs discussion" by itself. */}
        {hasNonNumeric && !allNonNumeric ? (
          <div>
            <dt className="text-meta text-text-secondary">Needs discussion</dt>
            <dd className="text-body text-text mt-1">
              {stats.nonNumeric
                .map((vid) => voters[vid]?.displayName)
                .filter((n): n is string => Boolean(n))
                .join(', ') || `${stats.nonNumeric.length} voter(s)`}
            </dd>
          </div>
        ) : null}
      </dl>

      {stats.lowConfidence ? (
        <div
          role="status"
          className={cn(
            'flex items-start gap-2 rounded-md bg-warning-surface text-warning-on px-3 py-2',
            animateReveal ? 'anim-reveal-flag' : '',
          )}
        >
          <TriangleAlert size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-meta">
            This story may need more refinement — confidence is low across the team.
          </p>
        </div>
      ) : null}
    </section>
  );
}
