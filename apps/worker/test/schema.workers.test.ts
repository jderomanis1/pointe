import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { initSchema } from '../src/schema';

const ROOM = (env as { ROOM: DurableObjectNamespace }).ROOM;

const EXPECTED_TABLES = [
  'room', 'story', 'voter', 'vote', 'ai_suggestion', 'audit_event', 'ai_cache',
  'processed_message', 'scheduled_task', 'ws_handshake_rate', 'ai_rate_limit',
];
const EXPECTED_INDEXES = [
  'idx_story_order', 'idx_audit_at', 'idx_processed_at', 'idx_scheduled_task_at',
];

/**
 * The Room DO constructor already calls initSchema. The pool gives us the
 * post-construction SQLite directly via runInDurableObject, so we assert
 * against the real schema as the room sees it.
 */
async function withSql<T>(name: string, fn: (sql: SqlStorage) => T | Promise<T>): Promise<T> {
  const stub = ROOM.get(ROOM.idFromName(name));
  // Wake the DO so the constructor runs and initSchema fires.
  const wake = await stub.fetch(new Request('https://do/state'));
  await wake.arrayBuffer();
  return await runInDurableObject(stub, async (_instance, state) => fn(state.storage.sql));
}

function masterSqlFor(sql: SqlStorage, name: string): string {
  const row = sql
    .exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, name)
    .toArray()[0];
  expect(row, `expected row in sqlite_master for ${name}`).toBeDefined();
  return row!.sql.replace(/\s+/g, ' ').toUpperCase();
}

describe('initSchema (real DO SQLite)', () => {
  it('creates every domain + infra table (spec §6 + R2.ii dedupe + S7.i scheduler + S7 WS-rate)', async () => {
    const names = await withSql('schema-tables', (sql) =>
      sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .toArray()
        .map((r) => r.name),
    );
    for (const t of EXPECTED_TABLES) expect(names).toContain(t);
  });

  it('creates the named indexes', async () => {
    const names = await withSql('schema-indexes', (sql) =>
      sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`,
        )
        .toArray()
        .map((r) => r.name),
    );
    for (const idx of EXPECTED_INDEXES) expect(names).toContain(idx);
  });

  it('uses composite PRIMARY KEY (story_id, voter_id) on vote', async () => {
    const definition = await withSql('schema-vote-pk', (sql) => masterSqlFor(sql, 'vote'));
    expect(definition).toContain('PRIMARY KEY (STORY_ID, VOTER_ID)');
  });

  it('uses story_id as the PRIMARY KEY on ai_suggestion', async () => {
    const definition = await withSql('schema-ai-pk', (sql) => masterSqlFor(sql, 'ai_suggestion'));
    expect(definition).toContain('STORY_ID TEXT PRIMARY KEY');
  });

  it('is idempotent — re-calling initSchema (after the constructor already did) does not throw', async () => {
    await withSql('schema-idempotent', (sql) => {
      expect(() => initSchema(sql)).not.toThrow();
    });
  });
});
