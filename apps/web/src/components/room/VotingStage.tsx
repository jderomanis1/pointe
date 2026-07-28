import { useEffect, useRef, useState } from 'react';
import { ArrowRight, MessageCircleMore, RotateCcw } from 'lucide-react';
import type { Story } from '@pointe/shared';
import { resolveDeck } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { isAutoRoundText } from '../../lib/rounds';
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
  const isAutoRound = isAutoRoundText(story.text);

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
        const numVals = votes.map((vote) => parseFloat(vote.points)).filter((n) => !isNaN(n) && isFinite(n));
        const avg = numVals.length > 0
          ? (numVals.reduce((a, b) => a + b, 0) / numVals.length).toFixed(1)
          : null;
        const allSame = votes.length > 0 && votes.every((vote) => vote.points === votes[0].points);
        const deck = room ? resolveDeck(room.deck, room.customDeck) : [];
        const positions = votes.map((vote) => deck.indexOf(vote.points)).filter((i) => i !== -1);
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
  const seated = Object.values(voters).filter((voter) => voter.connectionState !== 'left' && voter.role !== 'spectator');
  const votedCount = seated.filter((voter) => voter.id === me?.voterId ? Boolean(myVote) : Boolean(presence?.has(voter.id))).length;
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
              {isAutoRound ? (
                <span className="text-caption font-semibold text-text-secondary">
                  {isRevealed ? 'Discuss, decide, and close when ready' : 'Everyone can vote now'}
                </span>
              ) : (
                <>
                  <StoryExternalRef story={story} />
                  {story.edited ? <Badge variant="neutral">edited</Badge> : null}
                </>
              )}
            </div>

            {isAutoRound ? (
              <>
                <h1 className="mt-3 text-[clamp(2rem,5vw,3.5rem)] font-extrabold leading-[1.02] tracking-[-.045em] text-text">
                  {isRevealed ? 'Talk about what the team saw.' : 'Choose your estimate.'}
                </h1>
                <p className="mt-3 max-w-3xl text-body leading-7 text-text-secondary">
                  {isRevealed
                    ? 'Start with the highest and lowest cards. Ask what assumptions, dependencies, or unknowns drove the difference.'
                    : 'Think independently and place the card that best represents the effort, complexity, risk, and unknowns you see.'}
                </p>
              </>
            ) : (
              <>
                <h1 className="mt-3 max-w-4xl text-[clamp(2rem,5vw,3.5rem)] font-extrabold leading-[1.02] tracking-[-.045em] text-text break-words">
                  <LongText text={story.text} expandLabel="Show full title" collapseLabel="Show less" />
                </h1>
                {story.description ? (
                  <p className="mt-3 max-w-3xl text-body leading-7 text-text-secondary">
                    <LongText text={story.description} />
                  </p>
                ) : null}
              </>
            )}
          </div>

          {!isAutoRound && isHost && (story.state === 'active' || story.state === 'revealed') ? (
            <div className="flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface/90 p-1 shadow-card">
              <Button variant="ghost" size="sm" onClick={() => setSplitOpen((open) => !open)}>
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

        {!isAutoRound && isHost && splitOpen && (story.state === 'active' || story.state === 'revealed') ? (
          <SplitForm storyId={story.id} onClose={() => setSplitOpen(false)} />
        ) : null}

        {!isRevealed ? (
          <div className="flex min-h-28 flex-col items-center justify-center gap-3 rounded-[22px] border border-dashed border-hairline bg-bg/45 px-4 py-5 text-center">
            <p className={everyoneIn ? 'text-2xl font-extrabold text-success-on' : 'text-2xl font-extrabold text-text'}>
              {everyoneIn
                ? 'Everyone’s in.'
                : myVote
                  ? `${votedCount} of ${seated.length} cards are down`
                  : canVote
                    ? 'Your team is waiting on cards'
                    : `${votedCount} of ${seated.length} cards are down`}
            </p>
            <p className="max-w-xl text-sm leading-6 text-text-secondary">
              {everyoneIn
                ? 'The facilitator can reveal now, or give the team another moment.'
                : myVote
                  ? 'Your card is private. You can change it until the reveal.'
                  : 'Votes stay hidden so no one anchors on another person’s estimate.'}
            </p>
            {isHost ? (
              <Button
                variant="primary"
                size="lg"
                aria-label="Execute Reveal"
                onClick={() => send('REVEAL_VOTES', { storyId: story.id })}
                className="mt-1 min-w-52"
              >
                Reveal cards
              </Button>
            ) : null}
            {isHost && !everyoneIn ? (
              <span className="text-caption font-semibold text-text-muted">You can reveal early when the conversation is ready.</span>
            ) : null}
          </div>
        ) : null}

        {isRevealed ? (
          <div className="flex flex-col gap-5">
            <ConsensusStamp storyId={story.id} animate={animateReveal} />
            <VarianceBanner storyId={story.id} />
            <RevealStats storyId={story.id} animateReveal={animateReveal} />
            <SessionResultsPanel storyId={story.id} />

            {isAutoRound ? (
              <RoundClosePanel storyId={story.id} isHost={isHost} />
            ) : (
              <>
                {story.ai ? (
                  <AiSuggestionPanel
                    ai={story.ai}
                    isHost={isHost}
                    revealed
                    onShare={isHost ? () => send('SHARE_AI', { storyId: story.id }) : undefined}
                  />
                ) : null}
                {isHost && story.state === 'revealed' ? <CommitPanel story={story} /> : null}
              </>
            )}
          </div>
        ) : (
          <>
            <div data-slot="cast">
              {canVote ? <CastPanel story={story} /> : null}
            </div>
            {!isAutoRound && isHost && story.state === 'active' ? <HostAiSection story={story} /> : null}
          </>
        )}
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">{srAnnounce}</div>
    </section>
  );
}

function RoundClosePanel({ storyId, isHost }: { storyId: string; isHost: boolean }) {
  const send = useSend();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, [storyId]);

  if (!isHost) {
    return (
      <section className="rounded-[22px] border border-hairline bg-bg/45 p-5 text-center">
        <MessageCircleMore className="mx-auto text-accent-text" size={24} aria-hidden="true" />
        <h2 className="mt-3 text-lg font-extrabold text-text">Discuss the differences.</h2>
        <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
          The facilitator will close this vote when the team has enough shared understanding. Your cards will reset automatically.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-[22px] border border-accent bg-accent-tint p-5 sm:flex sm:items-center sm:justify-between sm:gap-6">
      <div>
        <p className="text-meta font-extrabold uppercase tracking-[.13em] text-accent-text">Facilitator action</p>
        <h2 className="mt-2 text-xl font-extrabold text-text">Close this vote when the conversation is complete.</h2>
        <p className="mt-2 text-sm leading-6 text-text-secondary">
          Closing clears every card and immediately opens a fresh vote for the team.
        </p>
      </div>
      <Button
        ref={closeRef}
        variant="primary"
        size="lg"
        aria-label="Vote again"
        onClick={() => send('OPEN_VOTING', { storyId })}
        leftIcon={<RotateCcw size={18} aria-hidden="true" />}
        rightIcon={<ArrowRight size={18} aria-hidden="true" />}
        className="mt-5 w-full shrink-0 sm:mt-0 sm:w-auto"
      >
        Close vote
      </Button>
    </section>
  );
}
