import { useEffect, useRef, useState } from 'react';
import type { Story } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { VoterSeats } from './VoterSeats';
import { CastPanel } from './CastPanel';
import { RevealStats } from './RevealStats';
import { CommitPanel } from './CommitPanel';
import { LongText } from './LongText';
import { useSend } from './RoomClientContext';

/**
 * The active-story focus, branched by story.state:
 *
 *   active   → cast UI (voters/host) + host "Reveal votes" + presence seats.
 *   revealed → seats flip to values + RevealStats; cast UI gone. No commit
 *              control here — that's R5.v.
 *
 * Animation B fires on the live active→revealed edge only (not on hydrate of
 * an already-revealed story). prev-state ref guards against re-animating on
 * subsequent renders or hydration.
 */
export function VotingStage({ story }: { story: Story }) {
  const send = useSend();
  const me = useRoomStore((s) => s.me);
  const room = useRoomStore((s) => s.room);
  const canVote = me !== null && me.role !== 'spectator';
  const isHost = me?.voterId !== undefined
    && room?.hostVoterId !== null
    && me?.voterId === room?.hostVoterId;

  // --- reveal-edge detection (animation B fires once on the live transition) ---
  const prevState = useRef<Story['state']>(story.state);
  const [animateReveal, setAnimateReveal] = useState(false);
  useEffect(() => {
    if (prevState.current === 'active' && story.state === 'revealed') {
      setAnimateReveal(true);
      // Allow ~1s for the staggered animation to play out; then idle.
      const t = setTimeout(() => setAnimateReveal(false), 1000);
      prevState.current = story.state;
      return () => clearTimeout(t);
    }
    prevState.current = story.state;
  }, [story.state]);

  const isRevealed = story.state === 'revealed' || story.state === 'committed';

  return (
    <section className="bg-surface border border-hairline rounded-md p-6 md:p-8 flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant={isRevealed ? 'success' : 'accent'}>
            {isRevealed ? 'revealed' : 'voting open'}
          </Badge>
          {story.externalId ? (
            <span className="font-mono text-meta text-text-secondary">{story.externalId}</span>
          ) : null}
          {story.edited ? <Badge variant="neutral">edited</Badge> : null}
          {isHost && story.state === 'active' ? (
            <div className="ml-auto">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => send('REVEAL_VOTES', { storyId: story.id })}
              >
                Reveal votes
              </Button>
            </div>
          ) : null}
        </div>
        <h2 className="font-serif text-heading text-text break-words">
          <LongText text={story.text} expandLabel="Show full title" collapseLabel="Show less" />
        </h2>
        {story.description ? (
          <p className="text-body text-text-secondary max-w-prose">
            <LongText text={story.description} />
          </p>
        ) : null}
      </header>

      <VoterSeats
        activeStoryId={story.id}
        mode={isRevealed ? 'revealed' : 'active'}
        animateReveal={animateReveal}
      />

      {isRevealed ? (
        <>
          <RevealStats storyId={story.id} animateReveal={animateReveal} />
          {isHost && story.state === 'revealed' ? <CommitPanel story={story} /> : null}
        </>
      ) : (
        <div data-slot="cast">
          {canVote ? <CastPanel story={story} /> : null}
        </div>
      )}
    </section>
  );
}
