import { useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, TriangleAlert, MessageSquare } from 'lucide-react';
import type { RevealStats, Story, Vote, Voter } from '@pointe/shared';
import { resolveDeck, computeRevealStats } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Button } from '../Button';
import { cn } from '../../lib/cn';
import { useSend } from './RoomClientContext';
import { StoryExternalRef } from './StoryExternalRef';
import { LongText } from './LongText';

/**
 * S9.iii (c1) — host close-review screen.
 *
 * Mounted by RoomShell when `room.state === 'review'` and the viewer is host.
 * Receives a pre-filtered set of revealed stories via the store and derives
 * each story's bucket from its stats — same `storyNeedsDiscussion` rule the
 * close alarm uses, so client/server agree on the split by construction.
 *
 * Three regions:
 *   • Header: distillation line — "N stories · X agreed · Y need discussion".
 *   • Agreed strip: count + primary "Accept all X" (sends ACCEPT_AGREED),
 *     optional expand to glance the agreed stories (read-only — no
 *     per-row commit, no checkbox). Null-median agreed stories (all-`?`
 *     votes) surface here with `—` and a "no estimate" caption so they
 *     don't vanish (Accept-all skips them server-side).
 *   • Discuss list: one card per flagged story, shape derived from stats:
 *       - outliers.length > 0  → "Split vote" chip + the vote spread,
 *                                  outlier face flagged warning.
 *       - lowConfidence       → "Low confidence" chip + confidence meter
 *                                  + advisory line.
 *       - both                → both chips, both visuals stacked.
 *     Each card carries a `Discuss live →` link that sends OPEN_DISCUSSION.
 *
 * All design-token only — no hardcoded hex. Both themes flip via data-theme.
 */
type Bucket = 'agreed' | 'discuss' | 'no-estimate';

type StoryRow = {
  story: Story;
  votes: Vote[];
  stats: RevealStats;
  bucket: Bucket;
};

export function ReviewHostScreen() {
  const send = useSend();
  const room = useRoomStore((s) => s.room);
  const stories = useRoomStore((s) => s.stories);
  const voters = useRoomStore((s) => s.voters);
  const revealed = useRoomStore((s) => s.revealed);

  const deck = useMemo(
    () => (room ? resolveDeck(room.deck, room.customDeck) : []),
    [room],
  );

  // Derive per-story rows. Bucket from server truth: needs_discussion on the
  // story. The `no-estimate` bucket is a UI-side sub-classification of agreed
  // (server agreement, but median is null — show but can't auto-commit).
  const rows: StoryRow[] = useMemo(() => {
    const out: StoryRow[] = [];
    for (const s of stories) {
      if (s.state !== 'revealed') continue;
      const r = revealed[s.id];
      if (!r) continue;
      const stats = r.stats ?? computeRevealStats(deck, r.votes);
      let bucket: Bucket;
      if (s.needsDiscussion) bucket = 'discuss';
      else if (stats.median === null) bucket = 'no-estimate';
      else bucket = 'agreed';
      out.push({ story: s, votes: r.votes, stats, bucket });
    }
    return out;
  }, [stories, revealed, deck]);

  const agreed = rows.filter((r) => r.bucket === 'agreed');
  const discuss = rows.filter((r) => r.bucket === 'discuss');
  const noEstimate = rows.filter((r) => r.bucket === 'no-estimate');
  const total = rows.length;

  return (
    <section
      data-slot="review-host-screen"
      className="bg-surface border border-hairline rounded-md p-6 md:p-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-2">
        <h2 className="font-serif text-heading text-text">Review</h2>
        <p className="text-meta text-text-secondary" data-slot="review-summary">
          <span className="font-mono text-text">{total}</span>{' '}
          <span>stor{total === 1 ? 'y' : 'ies'} · </span>
          <span className="font-mono text-text">{agreed.length + noEstimate.length}</span>{' '}
          <span>agreed · </span>
          <span className="font-mono text-text">{discuss.length}</span>{' '}
          <span>need discussion</span>
        </p>
      </header>

      <AgreedStrip
        agreed={agreed}
        noEstimate={noEstimate}
        onAcceptAll={() => send('ACCEPT_AGREED', {})}
      />

      {discuss.length > 0 ? (
        <ul className="flex flex-col gap-4" data-slot="discuss-list">
          {discuss.map((row) => (
            <li key={row.story.id}>
              <DiscussCard
                row={row}
                voters={voters}
                onDiscussLive={() => send('OPEN_DISCUSSION', { storyId: row.story.id })}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Agreed strip: count + primary `Accept all`, expand toggle reveals an
 * inline read-only list (story title + median). Null-median agreed stories
 * (`no-estimate`) get a `—` and a small "no estimate" caption — visible
 * without being on the auto-commit path.
 */
function AgreedStrip({
  agreed, noEstimate, onAcceptAll,
}: {
  agreed: StoryRow[];
  noEstimate: StoryRow[];
  onAcceptAll: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandable = agreed.length + noEstimate.length;
  if (expandable === 0) return null;
  return (
    <section
      data-slot="agreed-strip"
      className="bg-fill border border-hairline rounded-md p-4 flex flex-col gap-3"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1.5 text-meta text-text-secondary">
          <Check size={14} className="text-success" aria-hidden="true" />
          <span>
            <span className="font-mono text-text">{agreed.length}</span> agreed
            {noEstimate.length > 0 ? (
              <span className="text-text-muted">
                {' · '}
                <span className="font-mono text-text">{noEstimate.length}</span> no estimate
              </span>
            ) : null}
          </span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {expandable > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
              leftIcon={expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              data-slot="agreed-expand"
            >
              {expanded ? 'Hide' : `+ ${expandable} more`}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            onClick={onAcceptAll}
            disabled={agreed.length === 0}
            data-slot="accept-all"
          >
            Accept all {agreed.length}
          </Button>
        </div>
      </div>

      {expanded ? (
        <ul className="flex flex-col gap-1.5 pt-1" data-slot="agreed-expand-list">
          {agreed.map((r) => (
            <li key={r.story.id} className="flex items-center gap-3" data-bucket="agreed">
              <span className="font-mono text-meta text-text" data-slot="agreed-median">
                {r.stats.median}
              </span>
              <span className="text-meta text-text-secondary break-words flex-1">
                {r.story.text}
              </span>
            </li>
          ))}
          {noEstimate.map((r) => (
            <li key={r.story.id} className="flex items-center gap-3" data-bucket="no-estimate">
              <span className="font-mono text-meta text-text-muted" aria-label="No estimate">—</span>
              <span className="text-meta text-text-secondary break-words flex-1">
                {r.story.text}
              </span>
              <span className="text-caption text-text-muted">no estimate</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Discuss card — data-carries-the-why. The card's shape teaches the problem
 * type before the chip labels it.
 */
function DiscussCard({
  row, voters, onDiscussLive,
}: {
  row: StoryRow;
  voters: Record<string, Voter>;
  onDiscussLive: () => void;
}) {
  const { story, votes, stats } = row;
  const hasOutlier = stats.outliers.length > 0;
  const isLowConf = stats.lowConfidence;

  return (
    <article
      data-slot="discuss-card"
      data-story-id={story.id}
      data-has-outlier={hasOutlier ? 'true' : 'false'}
      data-low-confidence={isLowConf ? 'true' : 'false'}
      className="bg-surface border border-hairline rounded-md p-4 md:p-5 flex flex-col gap-4"
    >
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex flex-col gap-2 flex-1">
          <div className="flex items-center gap-2 flex-wrap" data-slot="discuss-chips">
            {hasOutlier ? (
              <Chip data-slot="chip-split">
                Split vote
                <span className="text-warning-on/70">
                  {' · '}
                  <span className="font-mono">{stats.outliers.length}</span>{' '}
                  outlier{stats.outliers.length === 1 ? '' : 's'}
                </span>
              </Chip>
            ) : null}
            {isLowConf ? (
              <Chip data-slot="chip-low-confidence">Low confidence</Chip>
            ) : null}
          </div>
          <h3 className="font-serif text-subhead text-text break-words">
            <LongText text={story.text} expandLabel="Show full title" collapseLabel="Show less" />
          </h3>
          <StoryExternalRef story={story} />
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-caption text-text-secondary">median</span>
          <span className="font-mono text-num text-text">
            {stats.median ?? '—'}
          </span>
        </div>
      </header>

      {hasOutlier ? (
        <VoteSpread
          votes={votes}
          voters={voters}
          outlierIds={new Set(stats.outliers)}
        />
      ) : null}

      {isLowConf ? (
        <ConfidenceBand stats={stats} median={stats.median} />
      ) : null}

      <footer className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={onDiscussLive}
          rightIcon={<MessageSquare size={14} aria-hidden="true" />}
          data-slot="discuss-live"
        >
          <span className="text-accent">Discuss live →</span>
        </Button>
      </footer>
    </article>
  );
}

function Chip({
  children, ...rest
}: {
  children: ReactNode;
  'data-slot'?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm bg-warning-surface text-warning-on px-2 py-0.5 text-caption font-sans font-medium"
      {...rest}
    >
      <TriangleAlert size={11} aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * The vote spread: one face per cast, mono. Outlier faces are flagged with
 * the warning border + text, NOT the ok/cell colors — this preserves the
 * "warning, not danger" tone.
 */
function VoteSpread({
  votes, voters, outlierIds,
}: {
  votes: Vote[];
  voters: Record<string, Voter>;
  outlierIds: Set<string>;
}) {
  return (
    <div className="flex flex-wrap gap-2" data-slot="vote-spread">
      {votes.map((v) => {
        const isOutlier = outlierIds.has(v.voterId);
        const name = voters[v.voterId]?.displayName ?? '—';
        return (
          <div
            key={v.voterId}
            data-vote-voter={v.voterId}
            data-vote-outlier={isOutlier ? 'true' : 'false'}
            className="flex flex-col items-center gap-1"
          >
            <span
              className={cn(
                'inline-flex items-center justify-center rounded-md border font-mono text-num',
                'h-10 min-w-10 px-2',
                isOutlier
                  ? 'bg-warning-surface border-warning text-warning-on'
                  : 'bg-surface border-hairline text-text',
              )}
            >
              {v.points}
            </span>
            <span className="text-caption text-text-muted truncate max-w-16">{name}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Low-confidence band: a confidence meter (filled bars amber) + the human
 * advisory line. The meter is the "spread" stand-in for the consensus case —
 * when votes cluster, the shape tells the team it's confidence not values
 * that's wobbling.
 */
function ConfidenceBand({
  stats, median,
}: {
  stats: RevealStats;
  median: string | null;
}) {
  const avg = stats.avgConfidence ?? 0;
  // Fill as a fraction of 5 with quarter-bar resolution.
  const filled = Math.round((avg / 5) * 4) / 4;
  return (
    <div
      data-slot="confidence-band"
      className="flex flex-col gap-2 bg-warning-surface text-warning-on rounded-sm px-3 py-2"
    >
      <div className="flex items-center gap-3">
        <span className="text-caption">Confidence</span>
        <ConfidenceMeter filled={filled} />
        <span className="font-mono text-meta">
          {stats.avgConfidence !== null ? stats.avgConfidence.toFixed(1) : '—'}
          <span className="text-warning-on/70"> / 5</span>
        </span>
      </div>
      <p className="text-meta">
        The team agreed on{' '}
        <span className="font-mono">{median ?? '—'}</span>
        {' — but isn’t sure.'}
      </p>
    </div>
  );
}

function ConfidenceMeter({ filled }: { filled: number }) {
  // 5 bars; each represents one unit. `filled` ∈ [0, 5] (rounded to quarters).
  return (
    <div className="flex items-center gap-1" role="img" aria-label="Confidence meter">
      {[1, 2, 3, 4, 5].map((i) => {
        const isFull = i <= filled;
        return (
          <span
            key={i}
            data-meter-index={i}
            data-meter-filled={isFull ? 'true' : 'false'}
            className={cn(
              'inline-block rounded-pill',
              isFull ? 'bg-warning' : 'bg-warning-surface border border-warning-on/30',
            )}
            style={{ width: '16px', height: '4px' }}
          />
        );
      })}
    </div>
  );
}
