import { X } from 'lucide-react';
import { useRoomStore } from '../../store/roomStore';
import { cn } from '../../lib/cn';

/**
 * S7.iv: quiet, dismissible notice that fires only when the local user WAS
 * the host and the host moved away while we were still connected. Neutral
 * styling — it's information ("here's what happened"), not an error.
 *
 * Degrades gracefully on a full page reload (store wiped → no false notice,
 * per the S7.iv scope decision).
 */
export function ReplacedNotice() {
  const replacedByHostName = useRoomStore((s) => s.replacedByHostName);
  const dismiss = useRoomStore((s) => s.dismissReplacedNotice);
  if (replacedByHostName === null) return null;

  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 bg-fill text-text-secondary rounded-md px-4 py-2',
        'border border-hairline',
      )}
    >
      <p className="flex-1 text-meta">
        While you were away, <span className="font-medium text-text">{replacedByHostName}</span> became host.
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-sm',
          'text-text-secondary hover:text-text hover:bg-surface transition-colors duration-fast',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
      >
        <X size={14} />
      </button>
    </div>
  );
}
