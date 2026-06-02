import Database from 'better-sqlite3';
import type { DurableObjectState } from '@cloudflare/workers-types';

/**
 * Build a fake DurableObjectState backed by an in-memory SQLite database.
 * Implements the `storage.sql.exec().toArray()` surface that Room uses plus
 * a minimal alarm tracker (`setAlarm` / `getAlarm` / `deleteAlarm`) so the
 * S7.i scheduler can be exercised end-to-end. Each call returns a fresh
 * database + alarm state, so tests stay isolated.
 */
export function createMockDoState(): DurableObjectState {
  const db = new Database(':memory:');
  let armedAlarm: number | null = null;

  const sql = {
    exec<T = unknown>(query: string, ...params: unknown[]): { toArray(): T[] } {
      const stmt = db.prepare(query);
      if (query.trim().toUpperCase().startsWith('SELECT')) {
        const rows = stmt.all(...params) as T[];
        return { toArray: () => rows };
      }
      stmt.run(...params);
      return { toArray: () => [] };
    },
  };

  const storage = {
    sql,
    setAlarm(timeMs: number) { armedAlarm = timeMs; },
    getAlarm() { return armedAlarm; },
    deleteAlarm() { armedAlarm = null; },
  };

  // Only the subset Room uses is implemented; the workers types are nominal,
  // so a structural cast through `unknown` is required and acceptable here.
  return { storage } as unknown as DurableObjectState;
}
