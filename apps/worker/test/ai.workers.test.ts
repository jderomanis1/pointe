/**
 * S8.i.a — AI data-model + DO plumbing.
 *
 * Tests the storage primitives wired in this slice:
 *   - schema migration of `ai_suggestion.shared` / `shared_at` on legacy DOs,
 *   - `ai_suggestion` upsert + read round-trip,
 *   - `ai_cache` get/put,
 *   - the DO-atomic AI rate-limit counter (3/room/hr).
 *
 * No protocol surface yet (REQUEST_AI / SHARE_AI handlers, broadcasting,
 * Claude integration — all S8.ii). The rate counter is a check-and-consume
 * primitive that S8.ii's REQUEST_AI handler will call only after a cache
 * miss.
 */
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/schema';
import {
  AI_RATE_LIMIT_PER_ROOM_PER_HOUR,
  checkAiRateLimit,
  getAiCache,
  getAiSuggestion,
  putAiCache,
  upsertAiSuggestion,
} from '../src/ai';
import { withRoom } from './helpers/pool';

const HOUR_MS = 3_600_000;

describe('S8.i.a — ai_suggestion schema migration', () => {
  it('a fresh DO has shared + shared_at columns from CREATE TABLE', async () => {
    await withRoom((sql) => {
      const cols = sql
        .exec<{ name: string }>(`PRAGMA table_info(ai_suggestion)`)
        .toArray()
        .map((r) => r.name);
      expect(cols).toContain('shared');
      expect(cols).toContain('shared_at');
    });
  });

  it('idempotent migration: drop columns from a legacy table, re-run initSchema → columns restored, no throw', async () => {
    await withRoom((sql) => {
      // Simulate a pre-S8 DO that already has the old shape.
      sql.exec(`DROP TABLE ai_suggestion`);
      sql.exec(`CREATE TABLE ai_suggestion (
        story_id      TEXT PRIMARY KEY,
        state         TEXT NOT NULL,
        payload       TEXT,
        error_message TEXT,
        requested_at  INTEGER NOT NULL,
        completed_at  INTEGER
      )`);
      const before = sql
        .exec<{ name: string }>(`PRAGMA table_info(ai_suggestion)`).toArray().map((r) => r.name);
      expect(before).not.toContain('shared');

      // Migration runs; the PRAGMA check makes it idempotent.
      expect(() => initSchema(sql)).not.toThrow();
      expect(() => initSchema(sql)).not.toThrow();

      const after = sql
        .exec<{ name: string }>(`PRAGMA table_info(ai_suggestion)`).toArray().map((r) => r.name);
      expect(after).toContain('shared');
      expect(after).toContain('shared_at');
    });
  });
});

describe('S8.i.a — ai_suggestion data-access', () => {
  it('upsert + read returns the typed row with payload parsed and shared defaulting to 0', async () => {
    await withRoom((sql) => {
      upsertAiSuggestion(sql, {
        storyId: 'st-1',
        state: 'ready',
        payload: {
          complexity: { level: 'medium', note: 'CRUD plus a webhook' },
          effort: { level: 'low', note: 'small surface' },
          risk: { level: 'low', note: 'no auth changes' },
          unknowns: { level: 'medium', note: 'rate limit shape TBD' },
          suggestedRange: { low: '3', high: '5' },
          rationale: 'Bounded scope with one unknown.',
        },
        requestedAt: 1000,
        completedAt: 2000,
      });
      const read = getAiSuggestion(sql, 'st-1');
      expect(read).not.toBeNull();
      expect(read!.state).toBe('ready');
      // Discriminated union: TS narrows on state === 'ready'.
      if (read!.state !== 'ready') throw new Error('expected ready');
      expect(read!.complexity).toEqual({ level: 'medium', note: 'CRUD plus a webhook' });
      expect(read!.suggestedRange).toEqual({ low: '3', high: '5' });
      expect(read!.rationale).toBe('Bounded scope with one unknown.');
      expect(read!.shared).toBe(false); // default 0 → false on the wire
      // Bookkeeping fields (storyId/requestedAt/completedAt/sharedAt) live in
      // the row only — they are NOT part of the wire-shape AISuggestion. The
      // row-level assertions are exercised below via a direct SELECT.
      const rawRow = sql
        .exec<{ requested_at: number; completed_at: number }>(
          `SELECT requested_at, completed_at FROM ai_suggestion WHERE story_id = 'st-1'`,
        ).toArray()[0];
      expect(rawRow.requested_at).toBe(1000);
      expect(rawRow.completed_at).toBe(2000);
    });
  });

  it('upsert a pending row (no payload) → read returns the pending wire shape only', async () => {
    await withRoom((sql) => {
      upsertAiSuggestion(sql, {
        storyId: 'st-pending',
        state: 'pending',
        requestedAt: 100,
      });
      const read = getAiSuggestion(sql, 'st-pending');
      expect(read).toEqual({ state: 'pending' });
    });
  });

  it('upsert a failed row → read returns the failed wire shape with errorMessage only', async () => {
    await withRoom((sql) => {
      upsertAiSuggestion(sql, {
        storyId: 'st-fail',
        state: 'failed',
        errorMessage: 'API_TIMEOUT',
        requestedAt: 100,
        completedAt: 200,
      });
      const read = getAiSuggestion(sql, 'st-fail');
      expect(read).toEqual({ state: 'failed', errorMessage: 'API_TIMEOUT' });
    });
  });

  it('upsert overwrites on conflict (story_id PK) — pending → ready transition lands on the same row', async () => {
    await withRoom((sql) => {
      upsertAiSuggestion(sql, { storyId: 'st-x', state: 'pending', requestedAt: 100 });
      upsertAiSuggestion(sql, {
        storyId: 'st-x',
        state: 'ready',
        payload: {
          complexity: { level: 'low', note: 'n' },
          effort: { level: 'low', note: 'n' },
          risk: { level: 'low', note: 'n' },
          unknowns: { level: 'low', note: 'n' },
          suggestedRange: { low: '1', high: '2' },
          rationale: 'r',
        },
        requestedAt: 100,
        completedAt: 200,
      });
      const rows = sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_suggestion WHERE story_id = 'st-x'`).toArray();
      expect(rows[0].n).toBe(1);
      expect(getAiSuggestion(sql, 'st-x')!.state).toBe('ready');
    });
  });

  it('read for unknown story returns null (not throws)', async () => {
    await withRoom((sql) => {
      expect(getAiSuggestion(sql, 'nope')).toBeNull();
    });
  });
});

describe('S8.i.a — ai_cache data-access', () => {
  it('put + get round-trip; miss returns null (no throw on zero rows)', async () => {
    await withRoom((sql) => {
      expect(getAiCache(sql, 'sha256:nope')).toBeNull();
      const payload = {
        complexity: { level: 'medium' as const, note: 'c' },
        effort: { level: 'low' as const, note: 'e' },
        risk: { level: 'low' as const, note: 'r' },
        unknowns: { level: 'low' as const, note: 'u' },
        suggestedRange: { low: '3', high: '5' },
        rationale: 'r',
      };
      putAiCache(sql, { cacheKey: 'sha256:abc', payload, now: 5000 });
      const got = getAiCache(sql, 'sha256:abc');
      expect(got).toEqual(payload);
    });
  });

  it('put overwrites on key collision (idempotent on hash)', async () => {
    await withRoom((sql) => {
      const p1 = {
        complexity: { level: 'low' as const, note: 'a' },
        effort: { level: 'low' as const, note: 'a' },
        risk: { level: 'low' as const, note: 'a' },
        unknowns: { level: 'low' as const, note: 'a' },
        suggestedRange: { low: '1', high: '2' },
        rationale: 'a',
      };
      const p2 = { ...p1, rationale: 'b' };
      putAiCache(sql, { cacheKey: 'k', payload: p1, now: 1 });
      putAiCache(sql, { cacheKey: 'k', payload: p2, now: 2 });
      expect(getAiCache(sql, 'k')!.rationale).toBe('b');
    });
  });
});

describe('S8.i.a — DO-atomic AI rate-limit counter (3/room/hr)', () => {
  const baseNow = HOUR_MS * 100_000; // a stable hour-aligned moment

  it('first 3 calls allowed (count 1..3); 4th over budget with count=4; resetAt is the window end', async () => {
    await withRoom((sql) => {
      const results = Array.from({ length: 4 }, () => checkAiRateLimit(sql, { now: baseNow + 10 }));
      expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
      expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
      for (const r of results) {
        expect(r.limit).toBe(AI_RATE_LIMIT_PER_ROOM_PER_HOUR);
        expect(r.resetAt).toBe(baseNow + HOUR_MS);
      }
    });
  });

  it('a call in a new hourly window starts at count=1; the old bucket is cleaned out', async () => {
    await withRoom((sql) => {
      checkAiRateLimit(sql, { now: baseNow + 10 });
      checkAiRateLimit(sql, { now: baseNow + 20 });
      const nextHour = baseNow + HOUR_MS + 1;
      const r = checkAiRateLimit(sql, { now: nextHour });
      expect(r.count).toBe(1);
      expect(r.allowed).toBe(true);
      expect(r.resetAt).toBe(baseNow + 2 * HOUR_MS);
      // Stale row cleaned.
      const rows = sql.exec<{ window_start: number }>(`SELECT window_start FROM ai_rate_limit`).toArray();
      expect(rows.map((r) => r.window_start)).toEqual([baseNow + HOUR_MS]);
    });
  });
});
