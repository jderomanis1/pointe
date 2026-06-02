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

/**
 * The cast UI for the active story. Drops into VotingStage's reserved
 * data-slot="cast". Combines:
 *   - VoteCards: pick a deck value (subtle-accent when selected).
 *   - ConfidencePicker: 1–5 dots, pre-selected at 3.
 *   - Submit (primary accent): enabled once a card is picked → VOTE_CAST.
 *
 * Re-vote replaces — the server upserts on (storyId, voterId) while the story
 * is active. The button reflects state: "Cast estimate" → "Update vote".
 *
 * Anti-anchoring intact: this reads only `myVotes[storyId]` (the local user's
 * own value, echoed via `vote_value`). Peer values aren't in the store pre-reveal.
 */
export function CastPanel({ story }: { story: Story }) {
  const send = useSend();
  const room = useRoomStore((s) => s.room);
  const myVote = useRoomStore((s) => s.myVotes[story.id]);

  const [points, setPoints] = useState<string | null>(myVote?.points ?? null);
  const [confidence, setConfidence] = useState<ConfidenceLevel>(
    myVote ? clampConfidence(myVote.confidence) : DEFAULT_CONFIDENCE,
  );

  // Active story changed → reseed from whatever myVote says for the new story
  // (or back to a clean pick + default confidence). Keeps re-vote-vs-fresh
  // initialisation correct when the host advances to the next story.
  // Intentionally keyed on story.id only: edits to myVote during this story
  // come from our own send → we don't want to clobber the local picker mid-edit.
  useEffect(() => {
    setPoints(myVote?.points ?? null);
    setConfidence(myVote ? clampConfidence(myVote.confidence) : DEFAULT_CONFIDENCE);
  }, [story.id]);

  if (!room) return null;
  const deck = resolveDeck(room.deck, room.customDeck);
  const canSubmit = points !== null;
  const label = myVote ? 'Update vote' : 'Cast estimate';

  function submit() {
    if (points === null) return;
    send('VOTE_CAST', { storyId: story.id, points, confidence });
  }

  return (
    <div className="flex flex-col gap-6">
      <VoteCards deck={deck} selected={points} onSelect={setPoints} />
      <ConfidencePicker value={confidence} onChange={setConfidence} />
      <div>
        <Button variant="primary" onClick={submit} disabled={!canSubmit}>
          {label}
        </Button>
      </div>
    </div>
  );
}
