import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type { Room, Story } from '@pointe/shared';
import { resolveDeck } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Button } from '../Button';
import { cn } from '../../lib/cn';
import { useSend } from './RoomClientContext';
import { VoteCards } from './VoteCards';
import { ConfidencePicker, type ConfidenceLevel } from './ConfidencePicker';
import { LongText } from './LongText';
import { StoryExternalRef } from './StoryExternalRef';

/**
 * S9.ii.c3 — the focused, one-story-at-a-time async voter view.
 *
 * Mounted only when:
 *   • room.mode === 'async',
 *   • room.asyncWindow is set (window opened),
 *   • the viewer is a voter (not host, not spectator).
 *
 * Anti-anchoring across the window: the voter sees stories one at a time,
 * never a scrollable list. A list would leak cross-story size anchoring
 * (seeing #5 forms a frame for #1) — the same bias votes-hidden prevents on
 * a different axis. Focused mode makes anti-anchoring strict across the window.
 *
 * X + Y interaction (Pillar-3-preserving):
 *   • X — primary "Next story →" / "Submit & finish →" commits (card +
 *     confidence) on press. Visually outlined until a card is picked,
 *     saturates to oxblood once ready. Tapping with no card shows the
 *     pick-or-skip hint rather than silently no-op'ing — explicit skip
 *     exit teaching.
 *   • Y — "Vote cast ✓" on a committed story; revisiting via Prev shows the
 *     prior selection + the ✓ (re-castable; the server upserts VOTE_CAST).
 *
 * Progress dots compose two orthogonal signals: fill = committed
 * (`myVotes[storyId]` set), ring = current position. Skipped folds into
 * unfilled for v1.
 */
const DEFAULT_CONFIDENCE: ConfidenceLevel = 3;

function clampConfidence(n: number): ConfidenceLevel {
  if (n <= 1) return 1;
  if (n >= 5) return 5;
  return Math.round(n) as ConfidenceLevel;
}

/** "22h 14m" / "59m 14s" / "30s" — mono-friendly, no seconds when ≥ 1h. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return 'closing…';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function useCountdown(closesAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return formatCountdown(closesAt - now);
}

export function AsyncVoterView({ room }: { room: Room }) {
  const stories = useRoomStore((s) => s.stories);
  const myVotes = useRoomStore((s) => s.myVotes);

  // Stable, ordered view of the queue. `slice()` so the sort is local.
  const queue: Story[] = useMemo(
    () => stories.filter((s) => s.state === 'active')
      .slice().sort((a, b) => a.orderIndex - b.orderIndex),
    [stories],
  );

  // currentIndex: 0..N. When === N, render the done state.
  const [currentIndex, setCurrentIndex] = useState(0);
  // Clamp if the queue shrinks (split/skipped reduces count mid-session).
  useEffect(() => {
    if (currentIndex > queue.length) setCurrentIndex(queue.length);
  }, [queue.length, currentIndex]);

  const closesAt = room.asyncWindow?.closesAt ?? 0;
  const countdown = useCountdown(closesAt);

  const isDone = currentIndex >= queue.length;
  const currentStory = !isDone ? queue[currentIndex] : null;

  return (
    <section
      className="bg-surface border border-hairline rounded-md p-6 md:p-8 flex flex-col gap-6"
      data-slot="async-voter-view"
    >
      <Header
        countdown={countdown}
        index={isDone ? queue.length - 1 : currentIndex}
        total={queue.length}
        queue={queue}
        myVotes={myVotes}
        currentIndex={currentIndex}
      />

      {isDone ? (
        <DoneState onPrev={() => setCurrentIndex((i) => Math.max(0, i - 1))} canPrev={queue.length > 0} />
      ) : currentStory ? (
        <StoryStage
          story={currentStory}
          room={room}
          isFinal={currentIndex === queue.length - 1}
          canPrev={currentIndex > 0}
          onPrev={() => setCurrentIndex((i) => Math.max(0, i - 1))}
          onAdvance={() => setCurrentIndex((i) => i + 1)}
        />
      ) : null}
    </section>
  );
}

function Header({
  countdown, index, total, queue, myVotes, currentIndex,
}: {
  countdown: string;
  index: number;
  total: number;
  queue: Story[];
  myVotes: Record<string, { points: string; confidence: number }>;
  currentIndex: number;
}) {
  return (
    <header className="flex flex-col gap-3" data-slot="async-header">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <span className="text-meta text-text-secondary">
          Async <span className="text-text-muted">·</span>{' '}
          <span>closes in </span>
          <span className="font-mono text-text" data-testid="countdown">{countdown}</span>
        </span>
        <span className="text-meta text-text-secondary">
          Story <span className="font-mono text-text">{Math.min(index + 1, total)}</span>{' '}
          of <span className="font-mono text-text">{total}</span>
        </span>
      </div>
      <ProgressDots queue={queue} myVotes={myVotes} currentIndex={currentIndex} />
    </header>
  );
}

function ProgressDots({
  queue, myVotes, currentIndex,
}: {
  queue: Story[];
  myVotes: Record<string, { points: string; confidence: number }>;
  currentIndex: number;
}) {
  return (
    <div
      role="img"
      aria-label={`Progress: ${Object.keys(myVotes).length} of ${queue.length} voted`}
      className="flex items-center gap-2"
      data-slot="async-dots"
    >
      {queue.map((s, i) => {
        const committed = !!myVotes[s.id];
        const isCurrent = i === currentIndex;
        return (
          <span
            key={s.id}
            data-dot-index={i}
            data-committed={committed ? 'true' : 'false'}
            data-current={isCurrent ? 'true' : 'false'}
            className={cn(
              'inline-block rounded-pill border',
              // fill = committed
              committed ? 'bg-accent border-accent' : 'bg-transparent border-hairline',
              // ring = current position (a heavier outline)
              isCurrent ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface' : '',
            )}
            style={{ width: '10px', height: '10px' }}
          />
        );
      })}
    </div>
  );
}

function StoryStage({
  story, room, isFinal, canPrev, onPrev, onAdvance,
}: {
  story: Story;
  room: Room;
  isFinal: boolean;
  canPrev: boolean;
  onPrev: () => void;
  onAdvance: () => void;
}) {
  const send = useSend();
  const myVote = useRoomStore((s) => s.myVotes[story.id]);
  const committed = !!myVote;

  const [points, setPoints] = useState<string | null>(myVote?.points ?? null);
  const [confidence, setConfidence] = useState<ConfidenceLevel>(
    myVote ? clampConfidence(myVote.confidence) : DEFAULT_CONFIDENCE,
  );
  const [hint, setHint] = useState<string | null>(null);

  // Re-seed local state when the focused story changes — same shape as
  // CastPanel.tsx, just keyed on async navigation.
  useEffect(() => {
    setPoints(myVote?.points ?? null);
    setConfidence(myVote ? clampConfidence(myVote.confidence) : DEFAULT_CONFIDENCE);
    setHint(null);
    // Intentionally keyed on story.id only; edits to myVote during this story
    // come from our own send and shouldn't clobber the local picker mid-edit.
  }, [story.id]);

  const deck = resolveDeck(room.deck, room.customDeck);
  const canSubmit = points !== null;

  const onPrimary = () => {
    if (!canSubmit) {
      setHint('Pick a card to vote, or skip this story');
      return;
    }
    send('VOTE_CAST', { storyId: story.id, points, confidence });
    onAdvance();
  };

  const onSkip = () => {
    setHint(null);
    onAdvance();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          {committed ? (
            <span
              className="inline-flex items-center gap-1 text-meta text-accent"
              data-slot="vote-cast-marker"
            >
              <Check size={14} aria-hidden="true" />
              <span>Vote cast</span>
            </span>
          ) : null}
          <StoryExternalRef story={story} />
        </div>
        <h2 className="font-serif text-heading text-text break-words">
          <LongText text={story.text} expandLabel="Show full title" collapseLabel="Show less" />
        </h2>
        {story.description ? (
          <p className="text-body text-text-secondary max-w-prose">
            <LongText text={story.description} />
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-meta text-text-secondary">Your estimate</span>
        <VoteCards deck={deck} selected={points} onSelect={(v) => { setHint(null); setPoints(v); }} />
        <ConfidencePicker value={confidence} onChange={setConfidence} />
      </div>

      <p className="text-caption text-text-muted">
        Your vote stays hidden until the window closes.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        {canPrev ? (
          <Button
            variant="ghost"
            size="md"
            onClick={onPrev}
            data-slot="async-prev"
          >
            ← Previous
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="md"
          onClick={onSkip}
          data-slot="async-skip"
        >
          Skip
        </Button>
        <div className="ml-auto">
          <PrimaryCommit
            canSubmit={canSubmit}
            isFinal={isFinal}
            onClick={onPrimary}
          />
        </div>
      </div>

      {hint ? (
        <p
          role="status"
          className="text-meta text-warning-on bg-warning-surface rounded-sm px-3 py-2"
          data-slot="async-hint"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The primary commit button. Visually outlined (accent border + accent text +
 * transparent bg) until a card is picked, then saturates to the oxblood
 * primary. The button is NEVER HTML-disabled — tapping with no card teaches
 * the skip exit via the hint state. The disabled-look is the affordance.
 */
function PrimaryCommit({
  canSubmit, isFinal, onClick,
}: {
  canSubmit: boolean;
  isFinal: boolean;
  onClick: () => void;
}) {
  const label = isFinal ? 'Submit & finish →' : 'Next story →';
  return (
    <button
      type="button"
      onClick={onClick}
      data-slot="async-primary"
      data-can-submit={canSubmit ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-sans font-medium',
        'transition-colors duration-fast',
        'text-body px-4 py-2',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        canSubmit
          ? 'bg-accent text-accent-ink hover:bg-accent-hover active:bg-accent-active'
          : 'bg-transparent text-accent border border-accent hover:bg-accent-tint',
      )}
    >
      {label}
    </button>
  );
}

function DoneState({ onPrev, canPrev }: { onPrev: () => void; canPrev: boolean }) {
  return (
    <div className="flex flex-col gap-4" data-slot="async-done">
      <div className="flex flex-col gap-1">
        <h2 className="font-serif text-heading text-text">You&rsquo;re all set</h2>
        <p className="text-body text-text-secondary">
          Results when the window closes. You can review or change earlier votes until then.
        </p>
      </div>
      {canPrev ? (
        <div>
          <Button variant="ghost" size="md" onClick={onPrev} data-slot="async-done-prev">
            ← Review previous
          </Button>
        </div>
      ) : null}
    </div>
  );
}
