import { TriangleAlert } from 'lucide-react';
import { useRoomStore } from '../../store/roomStore';
import { Button } from '../Button';
import { useSend } from './RoomClientContext';

/**
 * S7.iv: room-level advisory banner shown while the host is gone (state
 * 'host_vacant'). Amber per the design sheet (advisory states are amber —
 * reconnecting, low-confidence, outliers, this). Any connected participant
 * — voter or spectator (D1) — sees the claim button.
 *
 * Distinct from the per-client reconnecting status badge (R4.iii). They
 * coexist: "the host is gone" is a room concern, "you're reconnecting" is
 * a personal concern.
 */
export function HostVacantBanner() {
  const send = useSend();
  const state = useRoomStore((s) => s.room?.state ?? null);
  if (state !== 'host_vacant') return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-3 bg-warning-surface text-warning-on rounded-md px-4 py-3"
    >
      <TriangleAlert size={16} aria-hidden="true" className="shrink-0" />
      <p className="flex-1 text-body">
        The host disconnected. Anyone can take over.
      </p>
      <Button
        variant="primary"
        size="sm"
        onClick={() => send('CLAIM_HOST', {})}
      >
        Claim host
      </Button>
    </div>
  );
}
