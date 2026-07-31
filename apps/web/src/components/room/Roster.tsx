import type { Voter } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Badge } from '../Badge';
import { cn } from '../../lib/cn';

function ConnectionDot({ state }: { state: Voter['connectionState'] }) {
  const cls = state === 'connected' ? 'bg-success'
    : state === 'reconnecting' ? 'bg-warning'
    : 'bg-text-muted';
  return <span role="img" aria-label={state} className={cn('inline-block size-2 rounded-full shrink-0', cls)} />;
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

export function Roster() {
  const voters = useRoomStore((s) => s.voters);
  const me = useRoomStore((s) => s.me);

  const rows = Object.values(voters).sort((a, b) => {
    if ((a.role === 'host') !== (b.role === 'host')) return a.role === 'host' ? -1 : 1;
    const aLive = a.connectionState !== 'left';
    const bLive = b.connectionState !== 'left';
    if (aLive !== bLive) return aLive ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
  const liveCount = rows.filter((v) => v.connectionState !== 'left').length;

  return (
    <aside className="rounded-[22px] border border-hairline bg-surface/85 px-3 py-3 shadow-card sm:px-5 sm:py-4" aria-label="Team roster">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="shrink-0">
          <p className="text-meta font-extrabold uppercase tracking-[.13em] text-accent-text">At the table</p>
          <p className="mt-1 text-sm font-semibold text-text-secondary">Voters · {liveCount}</p>
        </div>

        <ul className="flex flex-1 flex-nowrap gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:justify-end sm:overflow-visible sm:pb-0">
          {rows.map((v) => {
            const isMe = v.id === me?.voterId;
            return (
              <li
                key={v.id}
                className={cn(
                  'inline-flex min-h-10 items-center gap-2 rounded-full border border-hairline bg-surface px-2.5 py-1.5 shadow-card',
                  v.connectionState === 'left' && 'opacity-45',
                  isMe && 'border-accent bg-accent-tint',
                )}
              >
                <span className="grid size-7 place-items-center rounded-full bg-fill text-[10px] font-extrabold text-text">
                  {initials(v.displayName)}
                </span>
                <span className="max-w-32 truncate text-sm font-bold text-text">{v.displayName}</span>
                {isMe ? <span className="text-caption font-semibold text-text-secondary">(you)</span> : null}
                <ConnectionDot state={v.connectionState} />
                {v.role === 'host' ? <Badge variant="accent">host</Badge> : null}
                {v.role === 'spectator' ? <Badge variant="neutral">spectator</Badge> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
