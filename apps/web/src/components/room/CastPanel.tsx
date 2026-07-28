import { useEffect, useState } from 'react';
import type { Story } from '@pointe/shared';
import { resolveDeck } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Button } from '../Button';
import { useSend } from './RoomClientContext';
import { VoteCards } from './VoteCards';
import { ConfidencePicker, type ConfidenceLevel } from './ConfidencePicker';

const DEFAULT_CONFIDENCE: ConfidenceLevel = 3;

function clampConfidence(n: number): ConfidenceLevel {
  if (n <= 1) return 1;
  if (n >= 5) return 5;
  return Math.round(n) as ConfidenceLevel;
}

export function CastPanel({ story }: { story: Story }) {
  const send = useSend();
  const room = useRoomStore((s) => s.room);
  const myVote = useRoomStore((s) => s.myVotes[story.id]);

  const [points, setPoints] = useState<string | null>(myVote?.points ?? null);
  const [confidence, setConfidence] = useState<ConfidenceLevel>(
    myVote ? clampConfidence(myVote.confidence) : DEFAULT_CONFIDENCE,
  );

  useEffect(() => {
    setPoints(myVote?.points ?? null);
    setConfidence(myVote ? clampConfidence(myVote.confidence) : DEFAULT_CONFIDENCE);
  }, [story.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!room) return null;
  const deck = resolveDeck(room.deck, room.customDeck);
  const canSubmit = points !== null;
  const label = myVote ? 'Update vote' : 'Cast estimate';

  function submit() {
    if (points === null) return;
    send('VOTE_CAST', { storyId: story.id, points, confidence });
  }

  return (
    <section aria-label="Your estimate" className="rounded-[24px] border border-hairline bg-bg/40 px-2 pb-5 pt-4 sm:px-5">
      <div className="text-center">
        <p className="text-meta font-extrabold uppercase tracking-[.14em] text-accent-text">Your hand</p>
        <h2 className="mt-1 font-serif text-2xl text-text">Choose the card that feels right.</h2>
      </div>

      <VoteCards deck={deck} selected={points} onSelect={setPoints} />

      <div className="mx-auto flex max-w-2xl flex-col items-center justify-between gap-4 rounded-[18px] border border-hairline bg-surface px-4 py-4 shadow-card sm:flex-row sm:px-5">
        <div className="text-center sm:text-left">
          <p className="text-sm font-bold text-text">How confident are you?</p>
          <p className="mt-0.5 text-caption text-text-secondary">Optional signal for the discussion after reveal.</p>
        </div>
        <ConfidencePicker value={confidence} onChange={setConfidence} />
        <Button
          variant="primary"
          onClick={submit}
          disabled={!canSubmit}
          className="w-full min-w-36 sm:w-auto"
        >
          {label}
        </Button>
      </div>

      {myVote ? (
        <p className="mt-3 text-center text-caption font-bold text-success-on" role="status">
          Your card is down. You can change it until the reveal.
        </p>
      ) : null}
    </section>
  );
}
