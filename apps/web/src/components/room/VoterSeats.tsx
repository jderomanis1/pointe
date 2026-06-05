import { TriangleAlert } from 'lucide-react';
import type { Voter, Vote } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

/**
 * Voter seats. Two modes:
 *
 *  active  → presence only. Render membership in `votedPresence[storyId]` (a Set
 *            of voterIds) for peers, plus `myVotes[storyId]` for the local user.
 *            The store shape physically cannot hold a peer's value pre-reveal —
 *            so seats here are value-free by construction.
 *
 *  revealed → values released. Read `revealed[storyId].votes` (public post-reveal)
 *             and render each voter's points (mono) + confidence dots. Outlier
 *             voters carry the amber advisory marker.
 *
 * Spectators are in a separate non-voting "Watching" group in both modes.
 */
export function VoterSeats({
  activeStoryId, mode, animateReveal,
}: {
  activeStoryId: string;
  mode: 'active' | 'revealed';
  animateReveal: boolean;
}) {
  const voters = useRoomStore((s) => s.voters);
  const presence = useRoomStore((s) => s.votedPresence[activeStoryId]);
  const reveal = useRoomStore((s) => s.revealed[activeStoryId]);
  const me = useRoomStore((s) => s.me);
  const myVote = useRoomStore((s) => s.myVotes[activeStoryId]);

  const all = Object.values(voters).filter((v) => v.connectionState !== 'left');
  const seated = all.filter((v) => v.role !== 'spectator');
  const spectators = all.filter((v) => v.role === 'spectator');

  const voteByVoter = new Map<string, Vote>();
  const outlierSet = new Set<string>(reveal?.stats?.outliers ?? []);
  if (mode === 'revealed' && reveal) {
    for (const v of reveal.votes) voteByVoter.set(v.voterId, v);
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-meta text-text-secondary mb-2">
          {mode === 'revealed' ? `Votes · ${seated.length}` : `Voters · ${seated.length}`}
        </h3>
        <ul className="flex flex-wrap gap-2">
          {seated.map((v) => {
            const isMe = v.id === me?.voterId;
            if (mode === 'revealed') {
              const vote = voteByVoter.get(v.id);
              return (
                <RevealedSeat
                  key={v.id}
                  v={v}
                  vote={vote}
                  isMe={isMe}
                  outlier={outlierSet.has(v.id)}
                  animate={animateReveal}
                />
              );
            }
            const hasVoted = isMe ? Boolean(myVote) : Boolean(presence?.has(v.id));
            return <ActiveSeat key={v.id} v={v} hasVoted={hasVoted} isMe={isMe} />;
          })}
        </ul>
      </div>
      {spectators.length > 0 ? (
        <div>
          <h3 className="text-meta text-text-secondary mb-2">Watching · {spectators.length}</h3>
          <ul className="flex flex-wrap gap-2">
            {spectators.map((v) => (
              <li
                key={v.id}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-pill bg-fill text-text-muted text-meta"
              >
                <span className="truncate">{v.displayName}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ---- active mode (presence only) ----

function ActiveSeat({ v, hasVoted, isMe }: { v: Voter; hasVoted: boolean; isMe: boolean }) {
  return (
    <li
      data-testid={`seat-${v.id}`}
      data-voted={hasVoted ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded-pill border',
        hasVoted ? 'border-accent bg-accent-tint text-accent' : 'border-hairline bg-surface text-text-secondary',
      )}
    >
      <PresenceDot voted={hasVoted} />
      <span className="truncate text-meta font-medium">
        {v.displayName}{isMe ? ' (you)' : ''}
      </span>
    </li>
  );
}

function PresenceDot({ voted }: { voted: boolean }) {
  return (
    <span
      role="img"
      aria-label={voted ? 'voted' : 'not yet'}
      className={cn(
        'inline-block h-2 w-2 rounded-pill',
        voted ? 'bg-accent' : 'bg-text-muted',
      )}
    />
  );
}

// ---- revealed mode (values released) ----

function RevealedSeat({
  v, vote, isMe, outlier, animate,
}: {
  v: Voter;
  vote: Vote | undefined;
  isMe: boolean;
  outlier: boolean;
  animate: boolean;
}) {
  return (
    <li
      data-testid={`seat-${v.id}`}
      data-revealed="true"
      data-outlier={outlier ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center gap-3 px-3 py-2 rounded-md border bg-surface',
        outlier ? 'border-warning' : 'border-hairline',
        animate ? 'anim-reveal-seat' : '',
      )}
    >
      <span className="font-mono text-num text-text" aria-label={`${v.displayName} voted ${vote?.points ?? 'no vote'}`}>
        {vote ? vote.points : '—'}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="text-meta text-text font-medium truncate">
          {v.displayName}{isMe ? ' (you)' : ''}
        </span>
        <ConfidenceDots level={vote ? vote.confidence : 0} />
      </div>
      {outlier ? (
        <TriangleAlert
          size={14}
          aria-label="outlier"
          className="text-warning shrink-0"
        />
      ) : null}
    </li>
  );
}

function ConfidenceDots({ level }: { level: number }) {
  return (
    <div role="img" aria-label={`Confidence ${level} of 5`} className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((lvl) => (
        <span
          key={lvl}
          data-filled={lvl <= level ? 'true' : 'false'}
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-pill',
            lvl <= level ? 'bg-text-secondary' : 'bg-fill',
          )}
        />
      ))}
    </div>
  );
}
