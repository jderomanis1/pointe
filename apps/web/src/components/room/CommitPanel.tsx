import { useEffect, useRef, useState } from 'react';
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

  // S10 a11y-keyboard §2 (resolved: REVEAL→Commit only, host hot-path).
  // On the host's transition from `active` → `revealed` (which is when
  // this panel mounts — host view renders CommitPanel only in the
  // revealed state), move focus to the Commit estimate primary so the
  // host's next action is already in hand. Keyed on `story.id` so a
  // story-change re-fires the effect once, not on unrelated re-renders.
  // Graceful no-op when the Commit button is disabled (zero-vote /
  // no-numeric-median edge: the median pre-select is null, picked is
  // null, button is `disabled` — focusing a disabled element is a
  // no-op in browsers, and we additionally gate on the ref existing).
  // Async-close→review and story-change focus targets are v1.5
  // (see spec/a11y-keyboard-checklist.md §Deferred to v1.5).
  const commitRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const btn = commitRef.current;
    if (btn && !btn.disabled) btn.focus();
    // Intentionally keyed on story.id only — the per-transition fire is
    // "this panel mounted for THIS story." A median change shouldn't
    // re-grab focus from the user's working flow.
  }, [story.id]);

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
        <p className="text-meta text-text-secondary mb-3">
          {median
            ? 'Defaulting to the median — pick a different card if the discussion landed elsewhere.'
            : 'No numeric median. Pick the value the team agreed on.'}
        </p>
        <VoteCards deck={deck} selected={picked} onSelect={setPicked} />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button ref={commitRef} variant="primary" onClick={commit} disabled={!canCommit}>
          Commit estimate
        </Button>
        <Button variant="secondary" onClick={reopen}>
          Vote again
        </Button>
      </div>
    </section>
  );
}
