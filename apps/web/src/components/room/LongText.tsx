import { useState, useEffect } from 'react';

/**
 * Fix 08 — long-text handling. Truncates at 280 chars and surfaces a quiet
 * "Show full description" toggle; short content renders inline with no toggle.
 *
 * Text stays escaped per SI-04: this only ever renders `text` as a string
 * (React's default escaping). No dangerouslySetInnerHTML, ever.
 */
export const LONG_TEXT_LIMIT = 280;

export function LongText({
  text,
  limit = LONG_TEXT_LIMIT,
  expandLabel = 'Show full description',
  collapseLabel = 'Show less',
}: {
  text: string;
  limit?: number;
  expandLabel?: string;
  collapseLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Collapse back when the text identity changes (host advances to the next story).
  useEffect(() => { setExpanded(false); }, [text]);

  if (text.length <= limit) return <>{text}</>;

  const shown = expanded ? text : `${text.slice(0, limit).trimEnd()}…`;
  return (
    <>
      {shown}{' '}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="text-meta text-text-secondary hover:text-text underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
      >
        {expanded ? collapseLabel : expandLabel}
      </button>
    </>
  );
}
