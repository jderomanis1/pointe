import { useState } from 'react';
import type { Story } from '@pointe/shared';
import { resolveDeck } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Button } from '../Button';
import { useSend } from './RoomClientContext';
import { VoteCards } from './VoteCards';

/**
 * Host-only commit control on the revealed view. Two exits live here:
 *   - Commit estimate  (primary accent — the resolving action)
 *   - Vote again       (secondary — OQ-010, re-open the story for another round)
 *
 * Commit pre-selects `stats.median` so the common case is one click; the host
 * overrides by picking a different card when the team landed elsewhere. With
 * no numeric median (all-non-numeric reveal), nothing pre-selects and commit
 * is disabled until the host picks. Vote again is always available — re-opening
 * doesn't depend on a final pick.
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

  function reopen() {
    send('OPEN_VOTING', { storyId: story.id });
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
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="primary" onClick={commit} disabled={!canCommit}>
          Commit estimate
        </Button>
        <Button variant="secondary" onClick={reopen}>
          Vote again
        </Button>
      </div>
    </section>
  );
}
