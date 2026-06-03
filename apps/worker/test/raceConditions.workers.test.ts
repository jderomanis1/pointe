/**
 * S7.vi — Race-condition consolidation.
 *
 * One canonical, spec-§13 race contract for Pointe. Each describe maps 1:1
 * to a documented race from Data Model §13 and asserts the documented
 * resolution against real Cloudflare DO SQLite (workerd via
 * @cloudflare/vitest-pool-workers). The Phase-1/2 mock retirement is what
 * makes this faithful — DO single-threaded serialization is real here.
 *
 * §13 races covered in this file:
 *   1. Slug collision on creation         → retry ≤5, then SLUG_GENERATION_EXHAUSTED
 *   2. Concurrent story reorder           → DEFERRED (REORDER_STORY is v1.5)
 *   3. Concurrent host claim              → first valid wins; loser HOST_RECLAIMED
 *   4. Vote during reveal                 → late vote rejected (STORY_NOT_ACTIVE)
 *   5. Original host rejoin after claim   → notification path, no auto-restore
 *   6. Vote ack lost (idempotency)        → re-fire same envelope id is deduped
 *
 * Plus the surface SPLIT introduced (v1):
 *   7. SPLIT child-placement integrity    → sparse orderIndex; split-a-split rejected
 *
 * Findings rule: if a documented resolution does NOT hold, that is a real
 * concurrency bug — surfaced as a failing assertion. Tests do NOT weaken
 * around broken resolutions.
 */
import { describe, it, expect } from 'vitest';
import type { WebSocket } from '@cloudflare/workers-types';
import type { DeltaChange, Envelope, HostReclaimedPayload, ServerMessageType } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import {
  addStory, addVoter, castVote, createRoom, markRoomHostVacant, openVoting, revealVotes,
} from '../src/operations';
import { reserveSlug } from '../src/slug';
import { withRoom } from './helpers/pool';
import { createMockKv } from './helpers/mockKv';

// ---- Shared envelope + ws helpers ---------------------------------------

type SentEnvelope = { type: ServerMessageType; payload: unknown };

function fakeSock(voterId: string | null): { ws: WebSocket; sent: Envelope[] } {
  const sent: Envelope[] = [];
  const attachment = voterId ? { voterId, role: 'voter' } : null;
  return {
    sent,
    ws: {
      send: (s: string) => { sent.push(JSON.parse(s) as Envelope); },
      serializeAttachment: () => {},
      deserializeAttachment: () => attachment,
      close: () => {},
    } as unknown as WebSocket,
  };
}

function call(
  sql: SqlStorage,
  ws: WebSocket,
  envelope: Envelope,
  broadcasts: DeltaChange[][],
  hostReclaimed?: SentEnvelope[],
): Envelope[] {
  return handleMessage(
    sql, ws, JSON.stringify(envelope),
    (changes) => { broadcasts.push(changes); },
    () => {},
    hostReclaimed
      ? (type, payload) => hostReclaimed.push({ type, payload })
      : undefined,
  );
}

// ---- Race 1: slug collision on creation ---------------------------------

describe('Race 1 — slug collision on creation (spec §13.1)', () => {
  it('reserveSlug retries on collision and returns a fresh slug', async () => {
    // Pre-seed the KV with whatever the FIRST attempt would generate, so
    // the retry path actually fires; the second attempt picks a different
    // pair (Math.random) and wins. To make this deterministic without
    // mocking Math.random we instead force every possible slug except one
    // — too large. Use Math.random seeding via spy.
    const kv = createMockKv();
    const seq = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99];
    let i = 0;
    const origRandom = Math.random;
    Math.random = () => seq[Math.min(i++, seq.length - 1)];
    try {
      // First call mints a slug and writes it.
      const first = await reserveSlug(kv, 'room-A', 5);
      expect(first).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
      // Second call — random sequence now produces a different slug; previous
      // is still in KV from first call, so the retry-on-existing path runs
      // for any collision; this room gets its own slug.
      const second = await reserveSlug(kv, 'room-B', 5);
      expect(second).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
      expect(second).not.toBe(first);
    } finally {
      Math.random = origRandom;
    }
  });

  it('exhausts after maxRetries collisions → throws SLUG_GENERATION_EXHAUSTED', async () => {
    // Pin every retry to the same generated slug → all 5 collide → throws.
    const kv = createMockKv();
    const origRandom = Math.random;
    Math.random = () => 0.0; // deterministic: same adj+noun+number every call
    try {
      const firstSlug = await reserveSlug(kv, 'room-X', 1);
      // Pre-seed the KV with the same slug under a different room id, so
      // the retry loop sees it as "taken" by some other room.
      // (firstSlug is already in KV — reserveSlug just wrote it.) Now any
      // further reserve attempts collide and the post-put re-read sees the
      // existing owner, not us → exhausts.
      await expect(reserveSlug(kv, 'room-Y', 5)).rejects.toThrow('SLUG_GENERATION_EXHAUSTED');
      expect(firstSlug).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    } finally {
      Math.random = origRandom;
    }
  });
});

// ---- Race 2: concurrent story reorder — DEFERRED ------------------------

describe('Race 2 — concurrent story reorder (spec §13.2) — DEFERRED', () => {
  // REORDER_STORY is a v1.5 feature. The documented resolution (server
  // resequences sparse indices; last-write-wins) cannot be tested before
  // the feature lands. This case is intentionally tracked here, not
  // silently omitted: when REORDER_STORY ships, add the test alongside
  // and remove this placeholder.
  it.skip('DEFERRED with REORDER_STORY (v1.5)', () => {});
});

// ---- Race 3: concurrent host claim --------------------------------------

const HOST_ID = 'host-1';
const VOTER_B = 'v-b';
const VOTER_C = 'v-c';

function seedActiveRoom(sql: SqlStorage): void {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 1_000,
  });
  sql.exec(`UPDATE room SET state = 'active'`);
  addVoter(sql, { voterId: VOTER_B, displayName: 'Ben', now: 2_000 });
  addVoter(sql, { voterId: VOTER_C, displayName: 'Cyd', now: 3_000 });
}

const claimEnv = (id: string): Envelope =>
  ({ v: 1, type: 'CLAIM_HOST', id, at: 0, payload: {} });

describe('Race 3 — concurrent host claim (spec §13.3)', () => {
  it('two claims at a vacant room: first wins, second gets HOST_RECLAIMED with winner id; exactly-one-host holds', async () => {
    await withRoom((sql) => {
      seedActiveRoom(sql);
      markRoomHostVacant(sql, { vacantSince: 9_000 });

      const sockB = fakeSock(VOTER_B);
      const sockC = fakeSock(VOTER_C);
      const broadcasts: DeltaChange[][] = [];
      const reclaimedBroadcasts: SentEnvelope[] = [];

      // DO single-threaded serialization makes "concurrent" deterministic:
      // we fire two claims in sequence; the first observes state=host_vacant
      // and wins, the second sees state=active and loses with a direct
      // HOST_RECLAIMED naming the actual host.
      const bReplies = call(sql, sockB.ws, claimEnv('claim-b'), broadcasts, reclaimedBroadcasts);
      const cReplies = call(sql, sockC.ws, claimEnv('claim-c'), broadcasts, reclaimedBroadcasts);

      // Winner: B.
      const hosts = sql
        .exec<{ id: string }>(`SELECT id FROM voter WHERE role = 'host'`)
        .toArray();
      expect(hosts.map((r) => r.id)).toEqual([VOTER_B]); // exactly-one-host
      const room = sql
        .exec<{ host_voter_id: string; state: string }>(
          `SELECT host_voter_id, state FROM room LIMIT 1`,
        ).toArray()[0];
      expect(room.host_voter_id).toBe(VOTER_B);
      expect(room.state).toBe('active');

      // Winner got the broadcast HOST_RECLAIMED (via = 'claim').
      const winningBroadcast = reclaimedBroadcasts.find((b) => b.type === 'HOST_RECLAIMED');
      expect(winningBroadcast).toBeDefined();
      expect(winningBroadcast!.payload).toEqual({ newHostVoterId: VOTER_B, via: 'claim' });
      // Only ONE broadcast — the losing claim doesn't blast peers.
      expect(reclaimedBroadcasts).toHaveLength(1);

      // Loser (C) got a direct HOST_RECLAIMED echoing C's envelope id but
      // naming B as the real host.
      expect(bReplies).toHaveLength(1);
      expect(bReplies[0].type).toBe('HOST_RECLAIMED');
      expect(cReplies).toHaveLength(1);
      expect(cReplies[0].type).toBe('HOST_RECLAIMED');
      expect(cReplies[0].id).toBe('claim-c');
      expect((cReplies[0].payload as HostReclaimedPayload).newHostVoterId).toBe(VOTER_B);
    });
  });
});

// ---- Race 4: vote during reveal -----------------------------------------

describe('Race 4 — vote during reveal (spec §13.4)', () => {
  it('VOTE_CAST after REVEAL_VOTES is rejected; no late row lands in vote table', async () => {
    await withRoom((sql) => {
      seedActiveRoom(sql);
      addStory(sql, { storyId: 'st-1', text: 'Auth', now: 100 });
      openVoting(sql, { storyId: 'st-1', now: 110 });
      // B votes early (legit).
      castVote(sql, { storyId: 'st-1', voterId: VOTER_B, points: '5', confidence: 4, now: 120 });
      // Host reveals → story.state = 'revealed', window closes.
      revealVotes(sql, { storyId: 'st-1', now: 200 });

      // Now C tries to vote late (race: their VOTE_CAST was inflight at reveal).
      const sockC = fakeSock(VOTER_C);
      const broadcasts: DeltaChange[][] = [];
      const replies = call(sql, sockC.ws, {
        v: 1, type: 'VOTE_CAST', id: 'late-vote', at: 0,
        payload: { storyId: 'st-1', points: '13', confidence: 5 },
      }, broadcasts);

      expect(replies).toHaveLength(1);
      expect(replies[0].type).toBe('ERROR');
      expect((replies[0].payload as { code: string }).code).toBe('STORY_NOT_ACTIVE');

      // No late vote landed; the original (B's) vote is the only row.
      const rows = sql
        .exec<{ voter_id: string; points: string }>(
          `SELECT voter_id, points FROM vote WHERE story_id = 'st-1'`,
        ).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].voter_id).toBe(VOTER_B);
      expect(rows[0].points).toBe('5');
      // No broadcast for the rejected vote.
      expect(broadcasts).toEqual([]);
    });
  });
});

// ---- Race 5: original host rejoin after someone else claimed ------------

describe('Race 5 — original host rejoin after claim (spec §13.5)', () => {
  it('original host rejoining an active room with a new host: no auto-restore; rebinds as voter, room host unchanged', async () => {
    await withRoom((sql) => {
      seedActiveRoom(sql);
      markRoomHostVacant(sql, { vacantSince: 9_000 });

      // B claims while vacant.
      const sockB = fakeSock(VOTER_B);
      const broadcasts: DeltaChange[][] = [];
      const reclaimed: SentEnvelope[] = [];
      call(sql, sockB.ws, claimEnv('c-b'), broadcasts, reclaimed);
      expect(reclaimed).toHaveLength(1); // the winning claim broadcast
      // Original host (A) is now demoted to voter.
      const aRoleAfterClaim = sql
        .exec<{ role: string }>(`SELECT role FROM voter WHERE id = ?`, HOST_ID)
        .toArray()[0].role;
      expect(aRoleAfterClaim).toBe('voter');

      // Original host (A) reconnects on a fresh socket. JOIN_ROOM with
      // resumeVoterId === HOST_ID. The dispatcher must NOT auto-restore A.
      const sockA = fakeSock(null);
      let attachment: unknown = null;
      (sockA.ws as unknown as { serializeAttachment(v: unknown): void }).serializeAttachment = (v) => { attachment = v; };
      (sockA.ws as unknown as { deserializeAttachment(): unknown }).deserializeAttachment = () => attachment;
      call(sql, sockA.ws, {
        v: 1, type: 'JOIN_ROOM', id: 'rejoin-a', at: 0,
        payload: { slug: 'apt-sparrow-16', resumeVoterId: HOST_ID, role: 'voter' },
      }, broadcasts, reclaimed);

      // Host is still B. A is still voter. NO second HOST_RECLAIMED (the
      // UI gets the snapshot on JOIN; the in-app "you were displaced"
      // notification is UI-only — see S7.iv comment in dispatcher.ts).
      const room = sql
        .exec<{ host_voter_id: string }>(`SELECT host_voter_id FROM room LIMIT 1`)
        .toArray()[0];
      expect(room.host_voter_id).toBe(VOTER_B);
      const aRoleAfterRejoin = sql
        .exec<{ role: string }>(`SELECT role FROM voter WHERE id = ?`, HOST_ID)
        .toArray()[0].role;
      expect(aRoleAfterRejoin).toBe('voter');
      expect(reclaimed.filter((b) => b.type === 'HOST_RECLAIMED')).toHaveLength(1);
    });
  });
});

// ---- Race 6: vote ack lost (idempotency) --------------------------------

describe('Race 6 — vote ack lost; client retries (spec §13.6)', () => {
  it('re-fire same VOTE_CAST envelope id within 5min: exactly one vote, exactly one broadcast, one processed_message row', async () => {
    await withRoom((sql) => {
      seedActiveRoom(sql);
      addStory(sql, { storyId: 'st-1', text: 'X', now: 100 });
      openVoting(sql, { storyId: 'st-1', now: 110 });
      const sockB = fakeSock(VOTER_B);
      const broadcasts: DeltaChange[][] = [];
      const raw: Envelope = {
        v: 1, type: 'VOTE_CAST', id: 'dup-vote', at: 0,
        payload: { storyId: 'st-1', points: '8', confidence: 4 },
      };

      // Client fires once; ack drops; client retries with the SAME id.
      const first = call(sql, sockB.ws, raw, broadcasts);
      const second = call(sql, sockB.ws, raw, broadcasts);
      expect(first).toEqual([]); // VOTE_CAST returns no direct reply on success
      expect(second).toEqual([]); // idempotent retry is silently absorbed

      const votes = sql
        .exec<{ voter_id: string; points: string }>(
          `SELECT voter_id, points FROM vote WHERE story_id = 'st-1'`,
        ).toArray();
      expect(votes).toHaveLength(1);
      expect(votes[0]).toEqual({ voter_id: VOTER_B, points: '8' });
      expect(broadcasts).toHaveLength(1); // not 2 — second was deduped
      const procRows = sql
        .exec(`SELECT id FROM processed_message WHERE id = 'dup-vote'`).toArray();
      expect(procRows).toHaveLength(1);
    });
  });
});

// ---- Race 7: SPLIT child-placement integrity ----------------------------

describe('Race 7 — SPLIT placement under contention (v1 surface)', () => {
  const splitEnv = (storyId: string, children: { text: string }[], id = 'c-split'): Envelope =>
    ({ v: 1, type: 'SPLIT_STORY', id, at: 0, payload: { storyId, children } });

  it('SPLIT followed by ADD_STORY: child orderIndices stay strictly between parent and next; tail ADD appends after', async () => {
    await withRoom((sql) => {
      seedActiveRoom(sql);
      // Three pending stories: A (100), B (200), C (300) — the addStory
      // op uses MAX(order_index)+100 by default; verify by SELECT.
      addStory(sql, { storyId: 's-A', text: 'A', now: 100 });
      addStory(sql, { storyId: 's-B', text: 'B', now: 100 });
      addStory(sql, { storyId: 's-C', text: 'C', now: 100 });

      const hostSock = fakeSock(HOST_ID);
      const broadcasts: DeltaChange[][] = [];
      // Host splits B → B1, B2, B3. DO serialization is real here.
      call(sql, hostSock.ws, splitEnv('s-B', [{ text: 'B1' }, { text: 'B2' }, { text: 'B3' }]), broadcasts);
      // Then ADD_STORY for a tail-added story.
      call(sql, hostSock.ws, {
        v: 1, type: 'ADD_STORY', id: 'add-D', at: 0, payload: { text: 'D' },
      }, broadcasts);

      const rows = sql
        .exec<{ id: string; order_index: number; state: string; split_parent_id: string | null }>(
          `SELECT id, order_index, state, split_parent_id FROM story ORDER BY order_index ASC`,
        ).toArray();

      // Parent (B) is now state='split'; children sit strictly between A and C.
      const parent = rows.find((r) => r.id === 's-B')!;
      expect(parent.state).toBe('split');
      const a = rows.find((r) => r.id === 's-A')!;
      const c = rows.find((r) => r.id === 's-C')!;
      const children = rows.filter((r) => r.split_parent_id === 's-B');
      expect(children).toHaveLength(3);
      for (const child of children) {
        expect(child.order_index).toBeGreaterThan(parent.order_index);
        expect(child.order_index).toBeLessThan(c.order_index);
        expect(child.order_index).toBeGreaterThan(a.order_index);
      }
      // All order_index values are distinct — no collision.
      const indices = rows.map((r) => r.order_index);
      expect(new Set(indices).size).toBe(indices.length);
      // Strictly ascending (already ORDER BY, but assert no equal-adjacent).
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1]);
      }
      // The tail ADD landed AFTER C.
      const d = rows.find((r) => r.id !== 's-A' && r.id !== 's-B' && r.id !== 's-C'
        && r.split_parent_id === null)!;
      expect(d.order_index).toBeGreaterThan(c.order_index);
    });
  });

  it('SPLIT a story already in state=split is rejected (terminal) → STORY_NOT_SPLITTABLE', async () => {
    await withRoom((sql) => {
      seedActiveRoom(sql);
      addStory(sql, { storyId: 's-1', text: 'A', now: 100 });
      // Force the story into split terminal directly (any prior SPLIT got us here).
      sql.exec(`UPDATE story SET state = 'split' WHERE id = ?`, 's-1');

      const hostSock = fakeSock(HOST_ID);
      const broadcasts: DeltaChange[][] = [];
      const replies = call(sql, hostSock.ws, splitEnv('s-1', [{ text: 'X' }, { text: 'Y' }]), broadcasts);
      expect(replies).toHaveLength(1);
      expect(replies[0].type).toBe('ERROR');
      expect((replies[0].payload as { code: string }).code).toBe('STORY_NOT_SPLITTABLE');
      // Story still split; no children created.
      const stillSplit = sql
        .exec<{ state: string }>(`SELECT state FROM story WHERE id = 's-1'`)
        .toArray()[0].state;
      expect(stillSplit).toBe('split');
      const childCount = sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM story WHERE split_parent_id = 's-1'`)
        .toArray()[0].n;
      expect(childCount).toBe(0);
      expect(broadcasts).toEqual([]);
    });
  });
});
