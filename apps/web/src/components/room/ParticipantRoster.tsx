import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

// Section 3.3 — typographic print index table for active voting.
// [× OFFLINE] animation (Section 4.4 Redaction Fade) deferred to Increment 10:
// server emits immediate 'left' on socket drop (no 'reconnecting' intermediate),
// so only the 500ms client-side flush belongs here — kept out of this structural increment.
// ESTIMATE column omitted for active mode (always '--'); VoterSeats handles reveal values.

function StatusCell({ voted, role }: { voted: boolean; role: string }) {
  if (role === 'spectator') {
    return <span className="text-text-secondary">[OBS]</span>;
  }
  return voted
    ? <span className="text-accent">● READY</span>
    : <span className="text-text-muted">○ PENDING</span>;
}

export function ParticipantRoster({ storyId }: { storyId: string }) {
  const voters = useRoomStore((s) => s.voters);
  const presence = useRoomStore((s) => s.votedPresence[storyId]);
  const me = useRoomStore((s) => s.me);
  const myVote = useRoomStore((s) => s.myVotes[storyId]);

  const rows = Object.values(voters)
    .filter((v) => v.connectionState !== 'left')
    .sort((a, b) => {
      // Voters before spectators; within each group, alphabetical.
      if (a.role === 'spectator' && b.role !== 'spectator') return 1;
      if (a.role !== 'spectator' && b.role === 'spectator') return -1;
      return a.displayName.localeCompare(b.displayName);
    });

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-meta border-collapse">
        <thead>
          <tr className="border-b border-[var(--border-strong)]">
            <th className="text-left pr-4 pb-1.5 text-text-muted uppercase tracking-[0.12em] w-10 font-normal">
              IDX
            </th>
            <th className="text-left pr-4 pb-1.5 text-text-muted uppercase tracking-[0.12em] font-normal">
              PARTICIPANT
            </th>
            <th className="text-left pr-4 pb-1.5 text-text-muted uppercase tracking-[0.12em] font-normal hidden sm:table-cell">
              ROLE
            </th>
            <th className="text-left pb-1.5 text-text-muted uppercase tracking-[0.12em] font-normal">
              STATUS
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => {
            const isMe = v.id === me?.voterId;
            const voted = isMe ? Boolean(myVote) : Boolean(presence?.has(v.id));
            return (
              <tr
                key={v.id}
                data-testid={`seat-${v.id}`}
                data-voted={voted ? 'true' : 'false'}
                className={cn('border-b border-hairline', isMe && 'text-text')}
              >
                <td className="py-1.5 pr-4 text-text-muted tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </td>
                <td className="py-1.5 pr-4 max-w-[180px] truncate">
                  {v.displayName}
                </td>
                <td className="py-1.5 pr-4 text-text-secondary hidden sm:table-cell">
                  {v.role === 'spectator' ? 'Observer' : 'Voter'}
                </td>
                <td className="py-1.5">
                  <StatusCell voted={voted} role={v.role} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
