import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Story } from '@pointe/shared';
import { Button } from '../Button';
import { AiSuggestionPanel } from './AiSuggestionPanel';
import { useSend } from './RoomClientContext';

/**
 * S8.iii.c3 — the host's per-active-story AI affordance + panel.
 *
 * Owns the ask state machine + REQUEST_AI wiring. The visibility gate
 * (host-only) lives at the call-site (VotingStage). AA-1: this component
 * is NEVER rendered for a voter — voters don't have `story.ai` in their
 * store either (the projector strips it; the ai_updated DELTA is host-only).
 *
 * State machine, derived from `story.ai` + a local optimistic `asking`:
 *   ai === undefined, !asking         → "Ask AI" button (idle)
 *   asking || ai.state === 'pending'  → quiet "Asking…"
 *   ai.state === 'ready'              → the panel
 *   ai.state === 'failed'             → the panel + a retry affordance
 *
 * The server sends nothing on REQUEST_AI accept; the ready-state lands as
 * an `ai_updated` DELTA from the backend, which the reducer applies to
 * `story.ai`. `asking` is local optimism only — once `story.ai` is set
 * the machine reads off the store.
 */
export function HostAiSection({ story }: { story: Story }) {
  const send = useSend();
  const [asking, setAsking] = useState(false);

  const ai = story.ai;
  const showAsking = ai === undefined ? asking : ai.state === 'pending';

  const onAsk = () => {
    setAsking(true);
    send('REQUEST_AI', { storyId: story.id });
  };

  if (ai === undefined && !showAsking) {
    return (
      <div data-slot="ai-ask">
        <Button
          variant="secondary"
          size="sm"
          onClick={onAsk}
          leftIcon={<Sparkles size={14} aria-hidden="true" />}
        >
          Ask AI
        </Button>
      </div>
    );
  }

  if (showAsking) {
    return (
      <div
        data-slot="ai-ask"
        className="flex items-center gap-2 text-meta text-text-muted"
        aria-live="polite"
      >
        <span className="font-sans">Asking…</span>
      </div>
    );
  }

  // ai.state === 'ready' | 'failed' — render the panel; on failed, add retry.
  return (
    <div data-slot="ai-ask" className="flex flex-col gap-2">
      <AiSuggestionPanel ai={ai!} />
      {ai!.state === 'failed' ? (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onAsk}
            leftIcon={<Sparkles size={14} aria-hidden="true" />}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
