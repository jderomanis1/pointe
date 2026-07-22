import { resolveDeck } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

// Section 3.8 — typographic print-ledger tally. No chart libraries.
export function SessionResultsPanel({ storyId }: { storyId: string }) {
  const reveal = useRoomStore((s) => s.revealed[storyId]);
  const voters = useRoomStore((s) => s.voters);
  const room = useRoomStore((s) => s.room);

  if (!reveal || !room || reveal.votes.length === 0) return null;

  const { votes, stats } = reveal;
  const deck = resolveDeck(room.deck, room.customDeck);
  const medianPos = stats?.median != null ? deck.indexOf(stats.median) : -1;

  // Group by value, sorted by deck position (non-deck values at end, alpha-within)
  const groups = new Map<string, string[]>();
  for (const v of votes) {
    const g = groups.get(v.points) ?? [];
    g.push(v.voterId);
    groups.set(v.points, g);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => {
    const ai = deck.indexOf(a), bi = deck.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    return ai === -1 ? 1 : bi === -1 ? -1 : ai - bi;
  });

  const numericVals = votes
    .map((v) => parseFloat(v.points))
    .filter((n) => !isNaN(n) && isFinite(n));
  const avg = numericVals.length > 0
    ? (numericVals.reduce((a, b) => a + b, 0) / numericVals.length).toFixed(1)
    : null;
  const allSame = votes.every((v) => v.points === votes[0].points);

  return (
    <section
      className="bg-surface border-2 border-[var(--border-strong)] font-mono overflow-x-auto"
      aria-label="Session tally"
    >
      <div className="border-b-2 border-[var(--border-strong)] px-4 py-2">
        <h3 className="text-meta uppercase tracking-[0.12em] text-text">
          SUMMARY // SESSION TALLY
        </h3>
      </div>

      <div className="px-4 py-2 border-b border-[var(--border-strong)] flex flex-wrap gap-x-6 gap-y-1 text-meta">
        {stats?.median != null && (
          <span>
            <span className="text-text-muted">MEDIAN: </span>
            <span className="font-serif text-text">{stats.median} PTS</span>
          </span>
        )}
        {avg !== null && (
          <span>
            <span className="text-text-muted">AVERAGE: </span>
            <span className="font-serif text-text">{avg} PTS</span>
          </span>
        )}
        <span>
          <span className="text-text-muted">CONSENSUS: </span>
          <span className={cn('font-serif', allSame ? 'text-success' : 'text-text')}>
            {allSame ? `${votes[0].points} PTS` : 'NONE'}
          </span>
        </span>
        <span>
          <span className="text-text-muted">TOTAL VOTES: </span>
          <span className="font-serif text-text tabular-nums">{votes.length}</span>
        </span>
      </div>

      <table className="w-full border-collapse text-meta">
        <tbody>
          {sorted.map(([value, voterIds]) => {
            const pos = deck.indexOf(value);
            const isOutlier = medianPos !== -1 && pos !== -1 && Math.abs(pos - medianPos) >= 2;
            const names = voterIds
              .map((id) => voters[id]?.displayName)
              .filter((n): n is string => Boolean(n))
              .join(', ');
            return (
              <tr key={value} className="border-b border-hairline">
                <td className="pl-4 pr-3 py-2 font-serif text-body text-text tabular-nums whitespace-nowrap">
                  {value} PTS
                </td>
                <td className="pr-3 py-2 text-text-muted tabular-nums whitespace-nowrap">
                  [{voterIds.length}]
                </td>
                <td className="pr-4 py-2 font-bold text-text whitespace-nowrap">
                  {'|'.repeat(voterIds.length)}
                </td>
                <td className="pr-3 py-2 whitespace-nowrap">
                  {isOutlier ? (
                    <span className="text-caption text-error bg-error-surface border border-error px-1.5 py-0.5">
                      [OUTLIER]
                    </span>
                  ) : null}
                </td>
                <td className="pr-4 py-2 text-text-secondary">
                  ({names})
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {stats?.lowConfidence && (
        <div
          role="status"
          className="border-t border-[var(--border-strong)] px-4 py-2 text-meta uppercase tracking-[0.08em] text-warning-on bg-warning-surface"
        >
          LOW CONFIDENCE — MAY NEED MORE REFINEMENT
        </div>
      )}
    </section>
  );
}
