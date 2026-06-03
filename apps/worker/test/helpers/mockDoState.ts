import Database from 'better-sqlite3';
import type { DurableObjectState } from '@cloudflare/workers-types';

/**
 * Build a fake DurableObjectState backed by an in-memory SQLite database.
 *
 * Implements the `storage.sql.exec(...)` surface the Room uses:
 *   - `.toArray()` — list of rows
 *   - `.one()`     — exactly one row; throws on zero or many (matches real DO
 *                    Cloudflare SQLite semantics — see the WS-rate bug that
 *                    hid in unit tests because the mock used to silently
 *                    return undefined on zero rows)
 *
 * Detects `RETURNING` so INSERT/UPDATE/DELETE … RETURNING run via `.all()`
 * and yield their projected rows.
 *
 * Plus a minimal alarm tracker for the S7.i scheduler. Each call returns a
 * fresh database + alarm state, so tests stay isolated.
 */
export function createMockDoState(): DurableObjectState {
  const db = new Database(':memory:');
  let armedAlarm: number | null = null;

  const sql = {
    exec<T = unknown>(query: string, ...params: unknown[]): { toArray(): T[]; one(): T } {
      const stmt = db.prepare(query);
      const upper = query.trim().toUpperCase();
      const isProjecting = upper.startsWith('SELECT') || / RETURNING\b/.test(upper);
      let rows: T[];
      if (isProjecting) {
        rows = stmt.all(...params) as T[];
      } else {
        stmt.run(...params);
        rows = [];
      }
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length === 0) throw new Error('exec().one(): query returned zero rows');
          if (rows.length > 1) throw new Error('exec().one(): query returned more than one row');
          return rows[0];
        },
      };
    },
  };

  const storage = {
    sql,
    setAlarm(timeMs: number) { armedAlarm = timeMs; },
    getAlarm() { return armedAlarm; },
    deleteAlarm() { armedAlarm = null; },
  };

  return { storage } as unknown as DurableObjectState;
}
