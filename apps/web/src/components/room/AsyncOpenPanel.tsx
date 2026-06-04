import { useState } from 'react';
import type { AsyncWindowDuration } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Button } from '../Button';
import { cn } from '../../lib/cn';
import { useSend } from './RoomClientContext';

/**
 * S9.ii.c2 — host-only "Open async voting" affordance.
 *
 * Mounted only when:
 *   • the local viewer is the host (server gates SI-02 too),
 *   • room.mode === 'async',
 *   • room.asyncWindow is unset (not yet opened),
 *   • the queue has at least one story (server gates NO_PENDING_STORIES).
 *
 * Picks the duration here (rather than persisting it at create): a fresh
 * choice on the click that opens the window is reconnect-robust by being
 * made fresh. Sends OPEN_ASYNC { window }; the backend stamps
 * room.async_window and arms the close alarm.
 */
const DURATIONS: { value: AsyncWindowDuration; label: string }[] = [
  { value: '4h',  label: '4 hours' },
  { value: '24h', label: '24 hours' },
  { value: '3d',  label: '3 days' },
];

export function AsyncOpenPanel() {
  const send = useSend();
  const me = useRoomStore((s) => s.me);
  const room = useRoomStore((s) => s.room);
  const stories = useRoomStore((s) => s.stories);

  const isHost = me?.voterId !== undefined
    && room?.hostVoterId !== null
    && me?.voterId === room?.hostVoterId;
  const shouldRender = isHost
    && room?.mode === 'async'
    && room.asyncWindow === undefined
    && stories.length > 0;

  const [duration, setDuration] = useState<AsyncWindowDuration>('24h');
  const [opening, setOpening] = useState(false);

  if (!shouldRender) return null;

  const onOpen = () => {
    setOpening(true);
    send('OPEN_ASYNC', { window: duration });
    // Optimistic — the broadcast will hydrate room.asyncWindow and we'll
    // unmount when shouldRender flips. Leave `opening` set in case it's slow.
  };

  return (
    <section
      className="bg-surface border border-hairline rounded-md p-5 flex flex-col gap-4"
      data-slot="async-open-panel"
      aria-label="Open async voting"
    >
      <header className="flex flex-col gap-1">
        <h2 className="font-sans font-medium text-subhead text-text">
          Open async voting
        </h2>
        <p className="text-caption text-text-secondary">
          Everyone votes at their own pace; the window auto-reveals at close.
        </p>
      </header>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-meta text-text-secondary mb-1">Window</legend>
        <div role="radiogroup" aria-label="Window duration" className="flex gap-2">
          {DURATIONS.map((d) => {
            const active = duration === d.value;
            return (
              <button
                key={d.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setDuration(d.value)}
                className={cn(
                  'flex-1 rounded-sm border px-3 py-2 text-meta font-mono',
                  'transition-colors duration-fast',
                  active
                    ? 'border-accent bg-accent-tint text-accent'
                    : 'border-hairline bg-surface text-text hover:bg-fill',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                )}
                data-duration={d.value}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div>
        <Button
          variant="primary"
          size="md"
          onClick={onOpen}
          disabled={opening || stories.length === 0}
        >
          {opening ? 'Opening…' : 'Open async voting'}
        </Button>
      </div>
    </section>
  );
}
