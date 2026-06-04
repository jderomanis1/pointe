import { useState } from 'react';
import type { Story, StoryState } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Badge, type BadgeVariant } from '../Badge';
import { Button } from '../Button';
import { useSend } from './RoomClientContext';
import { SplitForm } from './SplitForm';
import { StoryExternalRef } from './StoryExternalRef';

function stateBadge(state: StoryState) {
  const map: Record<StoryState, { variant: BadgeVariant; label: string }> = {
    pending: { variant: 'neutral', label: 'pending' },
    active: { variant: 'accent', label: 'voting' },
    revealed: { variant: 'warning', label: 'revealed' },
    committed: { variant: 'success', label: 'committed' },
    skipped: { variant: 'neutral', label: 'skipped' },
    split: { variant: 'neutral', label: 'split' },
  };
  const { variant, label } = map[state];
  return <Badge variant={variant}>{label}</Badge>;
}

function StoryRow({
  s, isHost, anyActive, onOpenVoting, onSkip, splitOpen, onToggleSplit,
}: {
  s: Story;
  isHost: boolean;
  anyActive: boolean;
  onOpenVoting: (storyId: string) => void;
  onSkip: (storyId: string) => void;
  splitOpen: boolean;
  onToggleSplit: (storyId: string) => void;
}) {
  const showOpen = isHost && s.state === 'pending' && !anyActive;
  // Host actions on pending rows: split lives alongside skip; both terminal-ish
  // actions. Skipped/committed/split rows show no host actions.
  const showSkip = isHost && s.state === 'pending';
  const showSplit = isHost && s.state === 'pending';
  const isMuted = s.state === 'skipped' || s.state === 'split';
  return (
    <li className="flex flex-col py-3 px-4 border-b border-hairline last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className={`text-body break-words ${isMuted ? 'text-text-muted' : 'text-text'}`}>
            {s.text}
          </p>
          {s.externalId || s.externalUrl ? (
            <p className="mt-1">
              <StoryExternalRef story={s} />
            </p>
          ) : null}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {showOpen ? (
            <Button variant="secondary" size="sm" onClick={() => onOpenVoting(s.id)}>
              Open voting
            </Button>
          ) : null}
          {showSkip ? (
            <Button variant="ghost" size="sm" onClick={() => onSkip(s.id)}>
              Skip
            </Button>
          ) : null}
          {showSplit ? (
            <Button variant="ghost" size="sm" onClick={() => onToggleSplit(s.id)}>
              {splitOpen ? 'Cancel split' : 'Split'}
            </Button>
          ) : null}
          {s.state === 'committed' && s.finalEstimate ? (
            <span
              className="font-mono text-num text-text"
              aria-label={`Final estimate ${s.finalEstimate}`}
            >
              {s.finalEstimate}
            </span>
          ) : null}
          {stateBadge(s.state)}
        </div>
      </div>
      {splitOpen ? (
        <SplitForm storyId={s.id} onClose={() => onToggleSplit(s.id)} />
      ) : null}
    </li>
  );
}

export function StoryQueue() {
  const send = useSend();
  const stories = useRoomStore((s) => s.stories);
  const room = useRoomStore((s) => s.room);
  const me = useRoomStore((s) => s.me);

  const isHost = me?.voterId !== undefined
    && room?.hostVoterId !== null
    && me?.voterId === room?.hostVoterId;
  const anyActive = stories.some((s) => s.state === 'active');

  const [splittingId, setSplittingId] = useState<string | null>(null);

  return (
    <section className="bg-surface border border-hairline rounded-md">
      <header className="px-4 py-3 border-b border-hairline">
        <h2 className="text-meta text-text-secondary">Stories · {stories.length}</h2>
      </header>
      <ul className="flex flex-col">
        {stories.map((s) => (
          <StoryRow
            key={s.id}
            s={s}
            isHost={isHost}
            anyActive={anyActive}
            onOpenVoting={(storyId) => send('OPEN_VOTING', { storyId })}
            onSkip={(storyId) => send('SKIP_STORY', { storyId })}
            splitOpen={splittingId === s.id}
            onToggleSplit={(storyId) => setSplittingId((curr) => (curr === storyId ? null : storyId))}
          />
        ))}
      </ul>
    </section>
  );
}
