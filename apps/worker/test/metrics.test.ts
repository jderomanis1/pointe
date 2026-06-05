/**
 * S10.vii — telemetry: the two app-side metrics + the privacy contract.
 *
 * The privacy assertion is as load-bearing as the count assertion. If
 * `recordRoomCreated` writes a slug, a hostVoterId, an IP, or any other
 * identifier, the privacy promise (Doc 2 §17) is broken — and broken
 * promises are worse than no telemetry. So each test asserts BOTH:
 *
 *   (a) the event fired the right number of times, with the right
 *       event-name marker (count contract);
 *   (b) every captured writeDataPoint call carries ONLY values from the
 *       allowed set (the event name + the typed dimension), and the
 *       captured shape contains no identifier-shaped strings (privacy
 *       contract).
 *
 * Identifier-shaped strings are detected positively: UUID v4 hex pattern,
 * the slug pattern (`[a-z]+-[a-z]+-\d+`), or any base64-looking length
 * over 12. The lock is "literally only the allowed values."
 */
import { describe, it, expect } from 'vitest';
import type { AnalyticsEngineDataPoint, AnalyticsEngineDataset } from '@cloudflare/workers-types';
import { recordAiRequested, recordRoomCreated } from '../src/metrics';

type CapturedCall = AnalyticsEngineDataPoint;

function makeStubMetrics(): {
  dataset: AnalyticsEngineDataset;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const dataset = {
    writeDataPoint: (p: AnalyticsEngineDataPoint) => {
      // Deep-copy so callers can't mutate captured snapshots later.
      calls.push(JSON.parse(JSON.stringify(p)) as CapturedCall);
    },
  } as unknown as AnalyticsEngineDataset;
  return { dataset, calls };
}

// Detectors for the privacy lock — if any of these match a captured
// blob, the test fails. The strings the helpers WRITE are short fixed
// labels ('room_created', 'ai_requested', 'sync', 'async'), so the
// detectors should never match on a clean call.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SLUG_RE = /^[a-z]+-[a-z]+-\d+$/;
function looksLikeIdentifier(s: string): boolean {
  if (UUID_RE.test(s)) return true;
  if (SLUG_RE.test(s)) return true;
  // Generic guard: any unexpected long opaque string. The four legal
  // strings are <= 12 chars; anything beyond that hints at id leakage.
  if (s.length > 12) return true;
  return false;
}

const ALLOWED_STRINGS = new Set([
  // Event names.
  'room_created',
  'ai_requested',
  // RoomMode dimension values.
  'sync',
  'async',
]);

function assertOnlyAllowedStrings(calls: CapturedCall[]): void {
  for (const c of calls) {
    const blobs = (c.blobs ?? []) as string[];
    for (const b of blobs) {
      expect(ALLOWED_STRINGS, `unexpected blob value "${b}" — privacy contract`).toContain(b);
      expect(looksLikeIdentifier(b), `blob "${b}" looks like an identifier`).toBe(false);
    }
    // `doubles` should be empty — we don't write numeric dimensions today.
    expect(c.doubles ?? []).toEqual([]);
    // `indexes` should be empty — we don't slice by an indexed dimension
    // today; adding one is a privacy-review surface (e.g. an IP-derived
    // index is forbidden by §17). Lock it empty until that's decided.
    expect(c.indexes ?? []).toEqual([]);
  }
}

describe('S10.vii — recordRoomCreated', () => {
  it('writes one row per call with [event_name, mode] blobs (sync)', () => {
    const { dataset, calls } = makeStubMetrics();
    recordRoomCreated({ METRICS: dataset }, 'sync');
    expect(calls).toHaveLength(1);
    expect(calls[0].blobs).toEqual(['room_created', 'sync']);
    assertOnlyAllowedStrings(calls);
  });

  it('writes the right mode for an async room (separate dimension value)', () => {
    const { dataset, calls } = makeStubMetrics();
    recordRoomCreated({ METRICS: dataset }, 'async');
    expect(calls).toHaveLength(1);
    expect(calls[0].blobs).toEqual(['room_created', 'async']);
    assertOnlyAllowedStrings(calls);
  });

  it('missing METRICS binding is a silent no-op (telemetry must never fail a request)', () => {
    // Empty env — no METRICS binding. The helper should swallow and
    // return, not throw. The Doc 2 §17 invariant: telemetry never
    // shapes the request path.
    expect(() => recordRoomCreated({}, 'sync')).not.toThrow();
  });

  it('AE backpressure / quota throw is swallowed (no request-path impact)', () => {
    // Simulate AE throwing — the helper must catch.
    const failing = {
      writeDataPoint: () => { throw new Error('AE quota exceeded'); },
    } as unknown as AnalyticsEngineDataset;
    expect(() => recordRoomCreated({ METRICS: failing }, 'sync')).not.toThrow();
  });
});

describe('S10.vii — recordAiRequested', () => {
  it('writes one row per call with ONLY the event-name blob (no dimensions)', () => {
    const { dataset, calls } = makeStubMetrics();
    recordAiRequested({ METRICS: dataset });
    expect(calls).toHaveLength(1);
    expect(calls[0].blobs).toEqual(['ai_requested']);
    assertOnlyAllowedStrings(calls);
  });

  it('multiple calls accumulate one-per-call', () => {
    const { dataset, calls } = makeStubMetrics();
    recordAiRequested({ METRICS: dataset });
    recordAiRequested({ METRICS: dataset });
    recordAiRequested({ METRICS: dataset });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.blobs).toEqual(['ai_requested']);
    assertOnlyAllowedStrings(calls);
  });

  it('missing METRICS binding is a silent no-op', () => {
    expect(() => recordAiRequested({})).not.toThrow();
  });
});

describe('S10.vii — privacy lock (the contract test)', () => {
  it('a full session of calls (sync + async + several AI requests) carries zero identifiers', () => {
    // Realistic mix of metric events from a single CI minute. Every
    // captured blob must be in the ALLOWED_STRINGS set; nothing else
    // can ride along.
    const { dataset, calls } = makeStubMetrics();
    const env = { METRICS: dataset };
    recordRoomCreated(env, 'sync');
    recordRoomCreated(env, 'async');
    recordRoomCreated(env, 'sync');
    recordAiRequested(env);
    recordAiRequested(env);
    expect(calls).toHaveLength(5);
    assertOnlyAllowedStrings(calls);
  });
});
