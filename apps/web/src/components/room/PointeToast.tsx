import { useEffect } from 'react';

// Section 3.11 — inverse mono toast. role="status" so screen readers announce it.
// Auto-dismisses after 5s; dismiss button focus ring uses vermilion accent.
export function PointeToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-4 px-4 py-3 font-mono text-meta border border-[var(--border-strong)] shadow-[var(--shadow-hard-md)]"
      style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
    >
      <span>{message}</span>
      <button
        onClick={onDismiss}
        className="font-mono text-meta uppercase tracking-[0.08em] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-vermilion)]"
        aria-label="Dismiss toast"
      >
        [DISMISS]
      </button>
    </div>
  );
}
