/**
 * S9.i.c1 — room.mode + async_window plumbing (round-trip).
 *
 * Schema, shared types, and POST /api/rooms already accepted `mode` from R1
 * — this slice's commit verifies the wire still round-trips it end-to-end
 * after the rest of S9 lands on the same plumbing. Plus the new
 * `story.needs_discussion` column (server-truth bucket flag set by the c3
 * close alarm) is asserted to default 0 / map to `needsDiscussion: undefined`
 * on the wire for unrevealed stories.
 */
import { describe, it, expect } from 'vitest';
import {
  addStory, createRoom, getRoomState,
} from '../src/operations';
import { withRoom } from './helpers/pool';

const NOW = 1_700_000_000_000;

describe('S9.i.c1 — room mode + async_window persist + round-trip', () => {
  it('createRoom with mode=sync (default) persists; async_window null on creation', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: 'h-1',
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
      });
      const { room } = getRoomState(sql);
      expect(room.mode).toBe('sync');
      expect(room.asyncWindow).toBeUndefined();
    });
  });

  it('createRoom with mode=async persists and round-trips through getRoomState', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-2', slug: 'merry-dove-17', hostVoterId: 'h-2',
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'async', now: NOW,
      });
      const { room } = getRoomState(sql);
      expect(room.mode).toBe('async');
      expect(room.asyncWindow).toBeUndefined(); // window is set by OPEN_ASYNC (c2)
    });
  });
});

describe('S9.i.c1 — story.needs_discussion column', () => {
  it('new stories default to needs_discussion = 0; the wire shape omits the key (server-truth absence)', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: 'h-1',
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
      });
      addStory(sql, { storyId: 'st-1', text: 't', now: NOW });
      const { stories } = getRoomState(sql);
      expect(stories[0].id).toBe('st-1');
      // The flag is absent on the wire when 0 (sync-mode reveals never set it).
      expect('needsDiscussion' in stories[0]).toBe(false);

      // Confirm the column itself exists and defaults to 0.
      const row = sql.exec<{ needs_discussion: number }>(
        `SELECT needs_discussion FROM story WHERE id = 'st-1'`,
      ).toArray()[0];
      expect(row.needs_discussion).toBe(0);
    });
  });

  it('manually flipping needs_discussion = 1 surfaces as story.needsDiscussion = true on the wire', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: 'h-1',
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
      });
      addStory(sql, { storyId: 'st-1', text: 't', now: NOW });
      sql.exec(`UPDATE story SET needs_discussion = 1 WHERE id = 'st-1'`);
      const { stories } = getRoomState(sql);
      expect(stories[0].needsDiscussion).toBe(true);
    });
  });
});

// ---- S9.ii.c1 — GetRoomResponse echoes mode + closesAt --------------------

describe('S9.ii.c1 — getRoomState carries mode + asyncWindow.closesAt for the GET projection', () => {
  it('sync room: mode=sync, asyncWindow undefined → endpoint projects closesAt:null', () => {
    return withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: 'h-1',
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
      });
      const { room } = getRoomState(sql);
      // The worker endpoint's projection (mirrors apps/worker/src/worker.ts:184-191):
      const wireResponse = {
        state: room.state,
        deck: room.deck,
        mode: room.mode,
        closesAt: room.asyncWindow?.closesAt ?? null,
      };
      expect(wireResponse).toEqual({
        state: 'lobby', deck: 'fibonacci', mode: 'sync', closesAt: null,
      });
    });
  });

  it('async room, window unopened: mode=async, closesAt:null (window not stamped until OPEN_ASYNC)', () => {
    return withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: 'h-1',
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'async', now: NOW,
      });
      const { room } = getRoomState(sql);
      expect(room.mode).toBe('async');
      expect(room.asyncWindow).toBeUndefined();
      // Endpoint projection still returns mode + closesAt:null for pre-open framing.
      expect(room.asyncWindow?.closesAt ?? null).toBeNull();
    });
  });

  it('async room with window opened: closesAt projects the stamped value (the pre-join countdown anchor)', async () => {
    const { openAsyncWindow } = await import('../src/operations');
    return withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: 'h-1',
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'async', now: NOW,
      });
      addStory(sql, { storyId: 'st-1', text: 't', now: NOW });
      const opensAt = NOW + 100;
      const closesAt = opensAt + 4 * 60 * 60 * 1000;
      openAsyncWindow(sql, { opensAt, closesAt });
      const { room } = getRoomState(sql);
      expect(room.mode).toBe('async');
      expect(room.asyncWindow?.closesAt).toBe(closesAt);
      // The projection used by the GET endpoint:
      expect({
        state: room.state, deck: room.deck, mode: room.mode,
        closesAt: room.asyncWindow?.closesAt ?? null,
      }).toEqual({
        state: 'active', // OPEN_ASYNC transitions room to active
        deck: 'fibonacci',
        mode: 'async',
        closesAt,
      });
    });
  });
});
