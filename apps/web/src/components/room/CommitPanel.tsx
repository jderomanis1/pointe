import { useState } from 'react';
import type { Story } from '@pointe/shared';
import { resolveDeck } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Button } from '../Button';
import { useSend } from './RoomClientContext';
import { VoteCards } from './VoteCards';

/**
 * Host-only commit control on the revealed view.
 *
 * Pre-selects `stats.median` so the common case is one click: "the median
 * matches the discussion → commit." When the team talked through an outlier
 * and landed elsewhere, the host overrides by picking a different card.
 *
 * No numeric median (all-non-numeric reveal) → no pre-selection, commit
 * disabled until the host picks outright.
 */
export function CommitPanel({ story }: { story: Story }) {
  const send = useSend();
  const room = useRoomStore((s) => s.room);
  const reveal = useRoomStore((s) => s.revealed[story.id]);

  const median = reveal?.stats?.median ?? null;
  const [picked, setPicked] = useState<string | null>(median);

  if (!room) return null;
  const deck = resolveDeck(room.deck, room.customDeck);
  const canCommit = picked !== null;

  function commit() {
    if (picked === null) return;
    send('COMMIT_STORY', { storyId: story.id, finalEstimate: picked });
  }

  return (
    <section className="flex flex-col gap-4 border-t border-hairline pt-6">
      <div>
        <h3 className="text-meta text-text-secondary mb-2">Final estimate</h3>
        <p className="text-meta text-text-muted mb-3">
          {median
            ? 'Defaulting to the median — pick a different card if the discussion landed elsewhere.'
            : 'No numeric median. Pick the value the team agreed on.'}
        </p>
        <VoteCards deck={deck} selected={picked} onSelect={setPicked} />
      </div>
      <div>
        <Button variant="primary" onClick={commit} disabled={!canCommit}>
          Commit estimate
        </Button>
      </div>
    </section>
  );
}
