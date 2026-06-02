import type { Story } from '@pointe/shared';
import { Badge } from '../Badge';
import { VoterSeats } from './VoterSeats';

/**
 * The active-story focus. R5.iii fills the reserved `data-slot="cast"` region
 * with vote cards + the confidence picker. Until then the slot stays empty —
 * no placeholder text, no "coming soon": a coherent view missing one element
 * reads as in-progress; a captioned placeholder reads as broken-on-purpose.
 * R5 merges as a unit, so this half-state only exists on the branch.
 */
export function VotingStage({ story }: { story: Story }) {
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

      {/* Reserved-empty casting slot — R5.iii's vote cards + confidence picker drop here. */}
      <div data-slot="cast" />
    </section>
  );
}
