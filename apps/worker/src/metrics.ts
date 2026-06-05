/**
 * S10.vii — telemetry: the four dials, nothing more.
 *
 * Two aggregate events in this module, mapped to the Doc 3 success metrics:
 *
 *   room_created (with mode dimension) → room-create count + async-adoption
 *     rate. Adoption rate is async / total at query time.
 *   ai_requested                       → AI opt-in rate. Counts validated
 *     host intent, recorded BEFORE the rate-limit decision (see
 *     `recordAiRequested` for the full counting contract). Rate's
 *     denominator comes from room_created counts; computed at query time.
 *
 * Privacy (Doc 2 §17) is the hard constraint: no PII, no per-user or
 * per-room identifiers, no cookies. The shape of each writeDataPoint
 * call is locked here so a careless future caller can't smuggle a slug
 * or voterId in via the wrong field. The metric helpers take ONLY the
 * permitted dimensions as typed parameters; everything else is rejected
 * by the type system before runtime.
 *
 * GitHub stars is the fourth Doc 3 dial — tracked off-platform on
 * github.com itself; no in-app instrumentation.
 */
import type { AnalyticsEngineDataset } from '@cloudflare/workers-types';
import type { RoomMode } from '@pointe/shared';

/** The Worker env we read from. METRICS is optional so missing binding
 *  in dev/preview is a no-op rather than a crash. */
export type MetricsEnv = {
  METRICS?: AnalyticsEngineDataset;
};

/**
 * Emit `room_created` with a `mode` dimension. The only fields written
 * are the event name and the mode — no slug, no host voterId, no IP, no
 * timestamps (CF's AE adds an aggregate timestamp itself). One row per
 * call; AE indexes/aggregates server-side.
 */
export function recordRoomCreated(env: MetricsEnv, mode: RoomMode): void {
  // Fire-and-forget. AE binding is optional in dev/test/preview; missing
  // means no telemetry, not an error — telemetry must never fail a request.
  const m = env.METRICS;
  if (!m) return;
  try {
    m.writeDataPoint({
      blobs: ['room_created', mode],
      doubles: [],
      indexes: [],
    });
  } catch {
    /* AE backpressure / quota — silently drop, never break the request. */
  }
}

/**
 * Emit `ai_requested`. Pure count event — NO dimensions. The rate's
 * denominator comes from `room_created` counts at query time. Resist the
 * over-instrumentation reflex (this would be where a story id / room id
 * would creep in "to be useful later" — don't add it).
 *
 * **Counting contract: validated host intent, recorded BEFORE the
 * rate-limit decision.** Concretely the call site (dispatcher.ts
 * `handleRequestAi`) fires this AFTER `requireHost`, payload-shape, and
 * the story-state guard reject — and BEFORE `checkAiRateLimit`. So the
 * count measures *"the host chose AI for an eligible story"*, not
 * *"the infra let the call through"*. Idempotent silent-absorb (a call
 * already in flight for this story) does NOT count, because that path
 * returns before reaching here.
 *
 * Doc 3's "20% of stories" is loose enough to support either reading
 * (intent vs delivered); we lock the intent reading explicitly so the
 * dashboard label and the code agree.
 *
 * **Honest claim — what the number CAN and CAN'T say.** `ai_requested`
 * is an **event count** of validated host intent. In-flight duplicate
 * requests are excluded (the silent-absorb gate above), but READY
 * re-sends and CACHE HITS are counted as fresh intent — each is a
 * separate "host clicked AI for this story" signal. The event is
 * deliberately **not per-story-deduped**: story IDs are forbidden in
 * telemetry per Doc 2 §17, so the dataset has no key to dedup on at
 * query time either. Consequence — Doc 3's "AI on 20% of stories"
 * reads as an **event-rate proxy** (`ai_requested ÷ stories_created`,
 * itself derived from `room_created` × avg stories/room). It can run
 * slightly above the true fraction-of-stories when a host re-requests
 * on the same story; we accept that bias because the alternative
 * (sending a hash or story id) violates the privacy contract.
 */
export function recordAiRequested(env: MetricsEnv): void {
  const m = env.METRICS;
  if (!m) return;
  try {
    m.writeDataPoint({
      blobs: ['ai_requested'],
      doubles: [],
      indexes: [],
    });
  } catch {
    /* see recordRoomCreated */
  }
}
