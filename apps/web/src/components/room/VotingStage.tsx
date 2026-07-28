import { useEffect, useRef, useState } from 'react';
import type { Story } from '@pointe/shared';
import { resolveDeck } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { VoterSeats } from './VoterSeats';
import { CastPanel } from './CastPanel';
import { RevealStats } from './RevealStats';
import { CommitPanel } from './CommitPanel';
import { LongText } from './LongText';
import { SplitForm } from './SplitForm';
import { useSend } from './RoomClientContext';
import { AiSuggestionPanel } from './AiSuggestionPanel';
import { HostAiSection } from './HostAiSection';
import { StoryExternalRef } from './StoryExternalRef';
import { ParticipantRoster } from './ParticipantRoster';
import { RevealDeck } from './RevealDeck';
import { ConsensusStamp } from './ConsensusStamp';
import { VarianceBanner } from './VarianceBanner';
import { SessionResultsPanel } from './SessionResultsPanel';

export function VotingStage({ story }: { story: Story }) {
  const send = useSend();
  const me = useRoomStore((s) => s.me);
  const room = useRoomStore((s) => s.room);
  const voters = useRoomStore((s) => s.voters);
  const presence = useRoomStore((s) => s.votedPresence[story.id]);
  const myVote = useRoomStore((s) => s.myVotes[story.id]);
  const canVote = me !== null && me.role !== 'spectator';
  const isHost = me?.voterId !== undefined
    && room?.hostVoterId !== null
    && me?.voterId === room?.hostVoterId;

  const reveal = useRoomStore((s) => s.revealed[story.id]);
  const prevState = useRef<Story['state']>(story.state);
  const [animateReveal, setAnimateReveal] = useState(false);
  const [srAnnounce, setSrAnnounce] = useState('');
  const [splitOpen, setSplitOpen] = useState(false);

  useEffect(() => {
    if (prevState.current === 'active' && story.state === 'revealed') {
      setAnimateReveal(true);
      const t1 = setTimeout(() => setAnimateReveal(false), 1000);
      const t2 = setTimeout(() => {
        const votes = reveal?.votes ?? [];
        const numVals = votes.map((v) => parseFloat(v.points)).filter((n) => !isNaN(n) && isFinite(n));
        const avg = numVals.length > 0
          ? (numVals.reduce((a, b) => a + b, 0) / numVals.length).toFixed(1)
          : null;
        const allSame = votes.length > 0 && votes.every((v) => v.points === votes[0].points);
        const deck = room ? resolveDeck(room.deck, room.customDeck) : [];
        const positions = votes.map((v) => deck.indexOf(v.points)).filter((i) => i !== -1);
        const spread = positions.length >= 2
          ? Math.max(...positions) - Math.min(...positions) >= 2 : false;
        let text = 'Votes revealed.';
        if (avg !== null) text += ` Average ${avg}.`;
        if (allSame && votes.length > 0) text += ` Consensus reached at ${votes[0].points} points.`;
        else if (spread) {
          const lo = deck[Math.min(...positions)], hi = deck[Math.max(...positions)];
          text += ` Vote spread high, ${lo} to ${hi}.`;
        }
        setSrAnnounce(text);
      }, 300);
      const t3 = setTimeout(() => setSrAnnounce(''), 2000);
      prevState.current = story.state;
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
    prevState.current = story.state;
  }, [story.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const isRevealed = story.state === 'revealed' || story.state === 'committed';
  const seated = Object.values(voters).filter((v) => v.connectionState !== 'left' && v.role !== 'spectator');
  const votedCount = seated.filter((v) => v.id === me?.voterId ? Boolean(myVote) : Boolean(presence?.has(v.id))).length;
  const everyoneIn = seated.length > 0 && votedCount === seated.length;

  return (
    <section className="relative overflow-hidden rounded-[30px] border border-hairline bg-surface/95 shadow-pop">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-48 opacity-60"
        style={{
          background:
            'radial-gradient(circle at 12% 0%, rgba(255,138,61,.16), transparent 42%), radial-gradient(circle at 88% 0%, rgba(46,158,143,.11), transparent 38%)',
        }}
      />

      <header className="relative border-b border-hairline px-5 py-5 sm:px-7 sm:py-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={isRevealed ? 'success' : 'accent'}>
                {isRevealed ? 'Cards revealed' : 'voting open'}
              </Badge>
              <StoryExternalRef story={story} />
              {story.edited ? <Badge variant="neutral">edited</Badge> : null}
            </div>
            <h1 className="mt-3 max-w-4xl font-serif text-[clamp(2rem,5vw,3.7rem)] leading-[.98] tracking-[-.035em] text-text break-words">
              <LongText text={story.text} expandLabel="Show full title" collapseLabel="Show less" />
            </h1>
            {story.description ? (
              <p className="mt-3 max-w-3xl text-body leading-7 text-text-secondary">
                <LongText text={story.description} />
              </p>
            ) : null}
          </div>

          {isHost && (story.state === 'active' || story.state === 'revealed') ? (
            <div className="flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface/90 p-1 shadow-card">
              <Button variant="ghost" size="sm" onClick={() => setSplitOpen((o) => !o)}>
                {splitOpen ? 'Cancel split' : 'Split'}
              </Button>
              {story.state === 'active' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Skip story"
                  onClick={() => send('SKIP_STORY', { storyId: story.id })}
                >
                  Skip
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <div className="relative flex flex-col gap-6 px-4 py-6 sm:px-7 sm:py-8">
        {isRevealed ? (
          animateReveal
            ? <RevealDeck storyId={story.id} />
            : <VoterSeats activeStoryId={story.id} mode="revealed" animateReveal={false} />
        ) : (
          <ParticipantRoster storyId={story.id} />
        )}

        {isHost && splitOpen && (story.state === 'active' || story.state === 'revealed') ? (
          <SplitForm storyId={story.id} onClose={() => setSplitOpen(false)} />
        ) : null}

        {!isRevealed ? (
          <div className="flex min-h-28 flex-col items-center justify-center gap-3 rounded-[22px] border border-dashed border-hairline bg-bg/45 px-4 py-5 text-center">
            <p className={everyoneIn ? 'font-serif text-2xl text-success-on' : 'font-serif text-2xl text-text'}>
              {everyoneIn
                ? 'Everyone’s in!'
                : myVote
                  ? `${votedCount} of ${seated.length} cards are down`
                  : canVote
                    ? 'Pick a card from your hand'
                    : `${votedCount} of ${seated.length} cards are down`}
            </p>
            <p className="max-w-xl text-sm leading-6 text-text-secondary">
              {everyoneIn
                ? 'Flip together, then talk about the spread.'
                : myVote
                  ? 'Your estimate is private until the host flips the table.'
                  : 'Votes stay hidden so everyone can think independently.'}
            </p>
            {isHost ? (
              <Button
                variant="primary"
                size="lg"
                aria-label="Execute Reveal"
                onClick={() => send('REVEAL_VOTES', { storyId: story.id })}
                className="mt-1 min-w-52"
              >
                Flip the cards!
              </Button>
            ) : null}
            {isHost && !everyoneIn ? (
              <span className="text-caption font-semibold text-text-muted">You can flip early when the conversation is ready.</span>
            ) : null}
          </div>
        ) : null}

        {isRevealed ? (
          <div className="flex flex-col gap-5">
            <ConsensusStamp storyId={story.id} animate={animateReveal} />
            <VarianceBanner storyId={story.id} />
            <RevealStats storyId={story.id} animateReveal={animateReveal} />
            <SessionResultsPanel storyId={story.id} />
            {story.ai ? (
              <AiSuggestionPanel
                ai={story.ai}
                isHost={isHost}
                revealed
                onShare={isHost ? () => send('SHARE_AI', { storyId: story.id }) : undefined}
              />
            ) : null}
            {isHost && story.state === 'revealed' ? <CommitPanel story={story} /> : null}
          </div>
        ) : (
          <>
            <div data-slot="cast">
              {canVote ? <CastPanel story={story} /> : null}
            </div>
            {isHost && story.state === 'active' ? <HostAiSection story={story} /> : null}
          </>
        )}
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">{srAnnounce}</div>
    </section>
  );
}
