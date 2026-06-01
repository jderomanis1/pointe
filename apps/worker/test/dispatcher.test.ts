import { describe, it, expect } from 'vitest';
import { handleMessage } from '../src/dispatcher';
import { initSchema } from '../src/schema';
import { createMockDoState } from './helpers/mockDoState';
import type { ErrorPayload } from '@pointe/shared';

function setup() {
  const sql = createMockDoState().storage.sql;
  initSchema(sql);
  return sql;
}

function envelope(
  type: string,
  id = 'msg-1',
  at = Date.now(),
  payload: unknown = {},
  v = 1,
): string {
  return JSON.stringify({ v, type, id, at, payload });
}

describe('dispatcher.handleMessage', () => {
  it('valid RECONNECT_PING → PONG', () => {
    const sql = setup();
    const out = handleMessage(sql, envelope('RECONNECT_PING'));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('PONG');
    expect(out[0].v).toBe(1);
  });

  it('malformed JSON → ERROR BAD_ENVELOPE (does not throw)', () => {
    const sql = setup();
    const out = handleMessage(sql, '{not json');
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('ERROR');
    expect((out[0].payload as ErrorPayload).code).toBe('BAD_ENVELOPE');
    expect((out[0].payload as ErrorPayload).retriable).toBe(false);
  });

  it('wrong protocol version → ERROR UNSUPPORTED_VERSION', () => {
    const sql = setup();
    const out = handleMessage(sql, envelope('RECONNECT_PING', 'm-x', Date.now(), {}, 999));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('ERROR');
    expect((out[0].payload as ErrorPayload).code).toBe('UNSUPPORTED_VERSION');
  });

  it('not-yet-implemented type (VOTE_CAST) → ERROR NOT_IMPLEMENTED', () => {
    const sql = setup();
    const out = handleMessage(sql, envelope('VOTE_CAST'));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('ERROR');
    expect((out[0].payload as ErrorPayload).code).toBe('NOT_IMPLEMENTED');
  });

  it('idempotency: replay of same id records one row in processed_message', () => {
    const sql = setup();
    handleMessage(sql, envelope('RECONNECT_PING', 'dup-id'));
    handleMessage(sql, envelope('RECONNECT_PING', 'dup-id'));
    const rows = sql
      .exec<{ id: string }>(`SELECT id FROM processed_message WHERE id = 'dup-id'`)
      .toArray();
    expect(rows).toHaveLength(1);
  });

  it('at override: server-stamps reply.at to a real timestamp, ignoring client at=0', () => {
    const sql = setup();
    const before = Date.now();
    const out = handleMessage(sql, envelope('RECONNECT_PING', 'm-at', 0));
    const after = Date.now();
    expect(out).toHaveLength(1);
    expect(out[0].at).toBeGreaterThanOrEqual(before);
    expect(out[0].at).toBeLessThanOrEqual(after);
    expect(out[0].at).not.toBe(0);
  });
});
