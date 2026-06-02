import type { Story } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Badge } from '../Badge';
import { VoterSeats } from './VoterSeats';
import { CastPanel } from './CastPanel';

/**
 * The active-story focus. R5.iii fills the reserved `data-slot="cast"` region
 * with the CastPanel (deck + confidence + submit). Spectators see the stage
 * + seats but no cast UI — the slot stays empty for them.
 */
export function VotingStage({ story }: { story: Story }) {
  const me = useRoomStore((s) => s.me);
  const canVote = me !== null && me.role !== 'spectator';

  return (
    <section className="bg-surface border border-hairline rounded-md p-6 md:p-8 flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant="accent">voting open</Badge>
          {story.externalId ? (
            <span className="font-mono text-meta text-text-secondary">{story.externalId}</span>
          ) : null}
          {story.edited ? <Badge variant="neutral">edited</Badge> : null}
        </div>
        <h2 className="font-serif text-heading text-text break-words">{story.text}</h2>
        {story.description ? (
          <p className="text-body text-text-secondary max-w-prose">{story.description}</p>
        ) : null}
      </header>

      <VoterSeats activeStoryId={story.id} />

      <div data-slot="cast">
        {canVote ? <CastPanel story={story} /> : null}
      </div>
    </section>
  );
}
