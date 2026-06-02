import type { SqlStorage } from '@cloudflare/workers-types';

/**
 * Initialize the per-room Durable Object SQLite schema.
 *
 * Idempotent: every statement uses IF NOT EXISTS, so calling this on every
 * Room constructor is safe. Schema follows Doc 2 §6 (storage), not §5 (entities).
 * Notes:
 *  - No `room_id` column on story/voter/audit_event: one DO per room, so it's implicit.
 *  - `ai_suggestion.payload` stores the structured suggestion as JSON (not one column per dimension).
 */
export function initSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS room (
    id                TEXT PRIMARY KEY,
    slug              TEXT NOT NULL,
    deck              TEXT NOT NULL,
    custom_deck       TEXT,
    mode              TEXT NOT NULL,
    async_window      TEXT,
    state             TEXT NOT NULL,
    host_voter_id     TEXT,
    host_vacant_since INTEGER,
    created_at        INTEGER NOT NULL,
    last_activity_at  INTEGER NOT NULL
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS story (
    id              TEXT PRIMARY KEY,
    order_index     INTEGER NOT NULL,
    text            TEXT NOT NULL,
    external_id     TEXT,
    external_url    TEXT,
    description     TEXT,
    state           TEXT NOT NULL,
    final_estimate  TEXT,
    edited          INTEGER NOT NULL DEFAULT 0,
    split_parent_id TEXT,
    created_at      INTEGER NOT NULL,
    opened_at       INTEGER,
    revealed_at     INTEGER
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_story_order ON story(order_index)`);

  sql.exec(`CREATE TABLE IF NOT EXISTS voter (
    id               TEXT PRIMARY KEY,
    display_name     TEXT NOT NULL,
    role             TEXT NOT NULL,
    connection_state TEXT NOT NULL,
    last_seen_at     INTEGER NOT NULL,
    joined_at        INTEGER NOT NULL
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS vote (
    story_id     TEXT NOT NULL,
    voter_id     TEXT NOT NULL,
    points       TEXT NOT NULL,
    confidence   INTEGER NOT NULL,
    submitted_at INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (story_id, voter_id)
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS ai_suggestion (
    story_id      TEXT PRIMARY KEY,
    state         TEXT NOT NULL,
    payload       TEXT,
    error_message TEXT,
    requested_at  INTEGER NOT NULL,
    completed_at  INTEGER
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS audit_event (
    id             TEXT PRIMARY KEY,
    at             INTEGER NOT NULL,
    actor_voter_id TEXT,
    event_type     TEXT NOT NULL,
    payload        TEXT
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_event(at)`);

  sql.exec(`CREATE TABLE IF NOT EXISTS ai_cache (
    cache_key  TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  // WS protocol idempotency dedupe (R2.ii). Durable so it survives hibernation.
  sql.exec(`CREATE TABLE IF NOT EXISTS processed_message (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_message(at)`);

  // Scheduler infra (S7.i). Multiplexes the DO's single alarm across an
  // arbitrary set of pending tasks (host-vacancy, async windows, archival, …).
  // Not a domain entity — plumbing alongside the 7 domain tables.
  sql.exec(`CREATE TABLE IF NOT EXISTS scheduled_task (
    id      TEXT PRIMARY KEY,
    at      INTEGER NOT NULL,
    type    TEXT NOT NULL,
    payload TEXT
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_task_at ON scheduled_task(at)`);
}
