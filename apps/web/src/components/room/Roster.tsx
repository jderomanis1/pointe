import type { Voter } from '@pointe/shared';
import { useRoomStore } from '../../store/roomStore';
import { Badge } from '../Badge';
import { cn } from '../../lib/cn';

function ConnectionDot({ state }: { state: Voter['connectionState'] }) {
  const cls = state === 'connected' ? 'bg-success'
    : state === 'reconnecting' ? 'bg-warning'
    : 'bg-text-muted';
  return <span aria-label={state} className={cn('inline-block h-2 w-2 rounded-pill shrink-0', cls)} />;
}

function VoterRow({ v, isMe }: { v: Voter; isMe: boolean }) {
  return (
    <li className={cn(
      'flex items-center gap-2 py-2 px-3 rounded-md',
      isMe ? 'bg-fill' : '',
    )}>
      <ConnectionDot state={v.connectionState} />
      <span className={cn('text-body truncate', v.connectionState === 'left' ? 'text-text-muted' : 'text-text')}>
        {v.displayName}
      </span>
      {isMe ? <span className="text-caption text-text-muted">(you)</span> : null}
      <span className="ml-auto flex items-center gap-1">
        {v.role === 'host' ? <Badge variant="accent">host</Badge> : null}
        {v.role === 'spectator' ? <Badge variant="neutral">spectator</Badge> : null}
      </span>
    </li>
  );
}

export function Roster() {
  const voters = useRoomStore((s) => s.voters);
  const me = useRoomStore((s) => s.me);

  const rows = Object.values(voters).sort((a, b) => {
    // Host first, then connected before left, then alphabetical.
    if ((a.role === 'host') !== (b.role === 'host')) return a.role === 'host' ? -1 : 1;
    const aLive = a.connectionState !== 'left';
    const bLive = b.connectionState !== 'left';
    if (aLive !== bLive) return aLive ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });

  return (
    <aside className="bg-surface border border-hairline rounded-md p-3">
      <h2 className="text-meta text-text-secondary px-3 py-1">
        Voters · {rows.filter((v) => v.connectionState !== 'left').length}
      </h2>
      <ul className="mt-1 flex flex-col">
        {rows.map((v) => (
          <VoterRow key={v.id} v={v} isMe={v.id === me?.voterId} />
        ))}
      </ul>
    </aside>
  );
}
