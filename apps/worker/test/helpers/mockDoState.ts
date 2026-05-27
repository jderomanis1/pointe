import Database from 'better-sqlite3';
import type { DurableObjectState } from '@cloudflare/workers-types';

/**
 * Build a fake DurableObjectState backed by an in-memory SQLite database.
 * Implements only the `storage.sql.exec().toArray()` surface that Room uses.
 * Each call returns a fresh database, so tests stay isolated.
 */
export function createMockDoState(): DurableObjectState {
  const db = new Database(':memory:');

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

  // Only the subset Room uses is implemented; the workers types are nominal,
  // so a structural cast through `unknown` is required and acceptable here.
  return { storage: { sql } } as unknown as DurableObjectState;
}
