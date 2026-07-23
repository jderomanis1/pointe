import { useEffect, useRef, useState } from 'react';
import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

// Section 3.3 + Section 4.3/4.4 — typographic print roster with join/leave motion.
// Join (4.3): 0px→40px height (80ms linear) + translateX(-8px→0) slide (50ms, 80ms delay).
// Left (4.4): show [× OFFLINE] at 0.45 opacity for 500ms, then disappear.
// 'reconnecting' never fires server-side (socket drop = immediate 'left'); handled per spec.

function StatusCell({ connectionState, voted, role }: { connectionState: string; voted: boolean; role: string }) {
  if (connectionState !== 'connected') {
    return <span className="italic text-text-muted">[× OFFLINE]</span>;
  }
  if (role === 'spectator') return <span className="text-text-secondary">[OBS]</span>;
  return voted
    ? <span className="text-accent-text">● READY</span>
    : <span className="text-text-muted">○ PENDING</span>;
}

export function ParticipantRoster({ storyId }: { storyId: string }) {
  const voters = useRoomStore((s) => s.voters);
  const presence = useRoomStore((s) => s.votedPresence[storyId]);
  const me = useRoomStore((s) => s.me);
  const myVote = useRoomStore((s) => s.myVotes[storyId]);

  // Track voters mid-leave (500ms grace before row disappears). Section 4.4.
  const [pendingLeft, setPendingLeft] = useState<Set<string>>(new Set());
  const prevStates = useRef<Map<string, string>>(new Map());

  // Track new arrivals for join animation. Section 4.3.
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const prevIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(Object.keys(voters));

    // Joined: present now, not seen before, and not immediately left
    const joined = new Set(
      [...currentIds].filter((id) => !prevIds.current.has(id) && voters[id].connectionState !== 'left'),
    );
    prevIds.current = currentIds;

    if (joined.size > 0) {
      setNewIds(joined);
      const t = setTimeout(() => setNewIds(new Set()), 200);
      // Detect left-transitions after updating prevIds
      for (const [id, voter] of Object.entries(voters)) {
        prevStates.current.set(id, voter.connectionState);
      }
      return () => clearTimeout(t);
    }

    // Detect transitions to 'left' → start 500ms grace
    for (const [id, voter] of Object.entries(voters)) {
      const prev = prevStates.current.get(id);
      if (prev && prev !== 'left' && voter.connectionState === 'left') {
        setPendingLeft((s) => new Set([...s, id]));
        setTimeout(() => setPendingLeft((s) => { const n = new Set(s); n.delete(id); return n; }), 500);
      }
      prevStates.current.set(id, voter.connectionState);
    }
  }, [voters]);

  const rows = Object.values(voters)
    .filter((v) => v.connectionState !== 'left' || pendingLeft.has(v.id))
    .sort((a, b) => {
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
            <th className="text-left pr-4 pb-1.5 text-text-muted uppercase tracking-[0.12em] w-10 font-normal">IDX</th>
            <th className="text-left pr-4 pb-1.5 text-text-muted uppercase tracking-[0.12em] font-normal">PARTICIPANT</th>
            <th className="text-left pr-4 pb-1.5 text-text-muted uppercase tracking-[0.12em] font-normal hidden sm:table-cell">ROLE</th>
            <th className="text-left pb-1.5 text-text-muted uppercase tracking-[0.12em] font-normal">STATUS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => {
            const isMe = v.id === me?.voterId;
            const voted = isMe ? Boolean(myVote) : Boolean(presence?.has(v.id));
            const isLeaving = pendingLeft.has(v.id);
            const isNew = newIds.has(v.id);
            return (
              <tr
                key={v.id}
                data-testid={`seat-${v.id}`}
                data-voted={voted ? 'true' : 'false'}
                className={cn(
                  'border-b border-hairline',
                  isMe && 'text-text',
                  isLeaving && 'opacity-45',
                  isNew && 'anim-roster-join',
                )}
              >
                <td className="py-1.5 pr-4 text-text-muted tabular-nums">{String(i + 1).padStart(2, '0')}</td>
                <td className="py-1.5 pr-4 max-w-[180px] truncate">{v.displayName}</td>
                <td className="py-1.5 pr-4 text-text-secondary hidden sm:table-cell">
                  {v.role === 'spectator' ? 'Observer' : 'Voter'}
                </td>
                <td className="py-1.5">
                  <StatusCell connectionState={v.connectionState} voted={voted} role={v.role} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
