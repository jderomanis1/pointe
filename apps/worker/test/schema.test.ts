import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/schema';
import { createMockDoState } from './helpers/mockDoState';

const EXPECTED_TABLES = [
  'room', 'story', 'voter', 'vote', 'ai_suggestion', 'audit_event', 'ai_cache',
  'processed_message',
];
const EXPECTED_INDEXES = ['idx_story_order', 'idx_audit_at', 'idx_processed_at'];

function freshSql() {
  return createMockDoState().storage.sql;
}

function masterSqlFor(sql: ReturnType<typeof freshSql>, name: string): string {
  const row = sql
    .exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, name)
    .toArray()[0];
  expect(row, `expected row in sqlite_master for ${name}`).toBeDefined();
  return row!.sql.replace(/\s+/g, ' ').toUpperCase();
}

describe('initSchema', () => {
  it('creates all 8 tables (spec §6 + R2.ii dedupe)', () => {
    const sql = freshSql();
    initSchema(sql);
    const names = sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .toArray()
      .map((r) => r.name);
    for (const t of EXPECTED_TABLES) expect(names).toContain(t);
  });

  it('creates the two named indexes', () => {
    const sql = freshSql();
    initSchema(sql);
    const names = sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`,
      )
      .toArray()
      .map((r) => r.name);
    for (const idx of EXPECTED_INDEXES) expect(names).toContain(idx);
  });

  it('uses composite PRIMARY KEY (story_id, voter_id) on vote', () => {
    const sql = freshSql();
    initSchema(sql);
    expect(masterSqlFor(sql, 'vote')).toContain('PRIMARY KEY (STORY_ID, VOTER_ID)');
  });

  it('uses story_id as the PRIMARY KEY on ai_suggestion', () => {
    const sql = freshSql();
    initSchema(sql);
    expect(masterSqlFor(sql, 'ai_suggestion')).toContain('STORY_ID TEXT PRIMARY KEY');
  });

  it('is idempotent — calling twice does not throw', () => {
    const sql = freshSql();
    expect(() => {
      initSchema(sql);
      initSchema(sql);
    }).not.toThrow();
  });
});
