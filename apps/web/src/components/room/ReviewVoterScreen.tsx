import { useMemo } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import type { RevealStats, Story, Vote } from '@pointe/shared';
import { resolveDeck, computeRevealStats } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { StoryExternalRef } from './StoryExternalRef';
import { LongText } from './LongText';
import { cn } from '../../lib/cn';

/**
 * S9.iii (c2) — voter read-only review outcome.
 *
 * Mounted by RoomShell when `room.state === 'review'` and the viewer is
 * NOT host. Shows the agreed/discuss breakdown + per-story team median
 * + the voter's own vote (`myVotes[storyId]`) — no host actions
 * (no Accept all, no Discuss live).
 *
 * The voter cannot trigger anything from here; reactivity comes from the
 * server: when the host fires OPEN_DISCUSSION, `room_state_changed: active`
 * lands and RoomShell drops the voter into the live VotingStage for the
 * now-active story. When the host commits, `room_state_changed: review`
 * returns the voter here.
 */
type Bucket = 'agreed' | 'discuss' | 'no-estimate';

type Row = {
  story: Story;
  votes: Vote[];
  stats: RevealStats;
  bucket: Bucket;
};

export function ReviewVoterScreen() {
  const room = useRoomStore((s) => s.room);
  const stories = useRoomStore((s) => s.stories);
  const revealed = useRoomStore((s) => s.revealed);
  const myVotes = useRoomStore((s) => s.myVotes);

  const deck = useMemo(
    () => (room ? resolveDeck(room.deck, room.customDeck) : []),
    [room],
  );

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
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
      data-slot="review-voter-screen"
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
        <p className="text-caption text-text-muted">
          Waiting on the host — they’ll either accept the agreed estimates or open a discussion.
        </p>
      </header>

      {agreed.length + noEstimate.length > 0 ? (
        <section
          data-slot="voter-agreed-list"
          className="bg-fill border border-hairline rounded-md p-4 flex flex-col gap-3"
        >
          <h3 className="inline-flex items-center gap-1.5 text-meta text-text-secondary">
            <Check size={14} className="text-success" aria-hidden="true" />
            Agreed
          </h3>
          <ul className="flex flex-col gap-2">
            {agreed.map((r) => (
              <ReviewRow
                key={r.story.id}
                row={r}
                myVote={myVotes[r.story.id] ?? null}
                bucket="agreed"
              />
            ))}
            {noEstimate.map((r) => (
              <ReviewRow
                key={r.story.id}
                row={r}
                myVote={myVotes[r.story.id] ?? null}
                bucket="no-estimate"
              />
            ))}
          </ul>
        </section>
      ) : null}

      {discuss.length > 0 ? (
        <section data-slot="voter-discuss-list" className="flex flex-col gap-3">
          <h3 className="inline-flex items-center gap-1.5 text-meta text-text-secondary">
            <TriangleAlert size={14} className="text-warning-on" aria-hidden="true" />
            Need discussion
          </h3>
          <ul className="flex flex-col gap-2">
            {discuss.map((r) => (
              <ReviewRow
                key={r.story.id}
                row={r}
                myVote={myVotes[r.story.id] ?? null}
                bucket="discuss"
              />
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

/** One row: story text + team median + the voter's own vote. Read-only. */
function ReviewRow({
  row, myVote, bucket,
}: {
  row: Row;
  myVote: { points: string; confidence: number } | null;
  bucket: Bucket;
}) {
  const { story, stats } = row;
  return (
    <li
      data-slot="review-row"
      data-story-id={story.id}
      data-bucket={bucket}
      className="bg-surface border border-hairline rounded-sm px-3 py-2 flex items-start justify-between gap-3"
    >
      <div className="min-w-0 flex-1">
        <p className="font-sans text-body text-text break-words">
          <LongText text={story.text} expandLabel="Show full title" collapseLabel="Show less" />
        </p>
        <p className="mt-1">
          <StoryExternalRef story={story} />
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-3">
        <Pair label="Team" value={stats.median} mute={stats.median === null} />
        <Pair label="You" value={myVote?.points ?? null} mute={!myVote} />
      </div>
    </li>
  );
}

function Pair({ label, value, mute }: { label: string; value: string | null; mute?: boolean }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="text-caption text-text-muted">{label}</span>
      <span
        className={cn(
          'font-mono text-meta',
          mute ? 'text-text-muted' : 'text-text',
        )}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}
