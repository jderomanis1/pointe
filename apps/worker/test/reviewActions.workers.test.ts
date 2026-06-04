/**
 * S9.iii — close-review host actions: ACCEPT_AGREED + OPEN_DISCUSSION.
 *
 * After the async-close alarm (S9.i.c3), each story is `revealed` with
 * `needs_discussion` set, room is in `review`. This file proves the two
 * host actions that act on that state:
 *
 *   • ACCEPT_AGREED — batch-commit every revealed+!discuss story to its
 *     median. Consensus needs no per-story ceremony.
 *   • OPEN_DISCUSSION { storyId } — re-open a flagged story for a live
 *     re-vote. Clears prior votes (subset rule: present voters only);
 *     story → active, room → active. COMMIT_STORY returns active → review
 *     when discuss stories remain.
 *
 * Plus the corollary: `review → host_vacant → reclaim` correctly returns
 * the room to `review`, not naively to `active` (deriveReclaimRoomState).
 */
import { describe, it, expect } from 'vitest';
import type {
  DeltaChange, DeltaPayload, Envelope, ErrorPayload,
} from '@pointe/shared';
import type {
  DurableObjectState, WebSocket as CfWebSocket,
} from '@cloudflare/workers-types';
import { handleMessage } from '../src/dispatcher';
import { broadcast } from '../src/broadcast';
import {
  addStory, addVoter, castVote, closeAsyncWindow, createRoom, getHostVoterId,
  openAsyncWindow, setStoryNeedsDiscussion, setRoomHost, markRoomHostVacant,
} from '../src/operations';
import { withRoom, withRoomInstance } from './helpers/pool';

type WebSocket = CfWebSocket;

const HOST = 'host-1';
const V1 = 'v-1';
const V2 = 'v-2';
const V3 = 'v-3';
const V4 = 'v-4';
const NOW = 1_700_000_000_000;

function fakeWs(att: { voterId: string; role: 'host' | 'voter' | 'spectator' }): {
  ws: WebSocket; sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    ws: {
      send: (s: string) => { sent.push(s); },
      serializeAttachment: () => {},
      deserializeAttachment: () => att,
      close: () => {},
    } as unknown as WebSocket,
  };
}

/**
 * Seed an async room mid-review: 4 voters, N stories all revealed with
 * persisted votes + needs_discussion flag per the slice's seed plan.
 * Bypasses the close alarm — directly stamps the post-close state.
 */
function seedReviewState(
  sql: SqlStorage,
  opts: { stories: { id: string; votes: { voterId: string; points: string; confidence: number }[]; needsDiscussion: boolean }[] },
) {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'async', now: NOW,
  });
  addVoter(sql, { voterId: V1, displayName: 'Ben', now: NOW });
  addVoter(sql, { voterId: V2, displayName: 'Cleo', now: NOW });
  addVoter(sql, { voterId: V3, displayName: 'Dax', now: NOW });
  addVoter(sql, { voterId: V4, displayName: 'Eli', now: NOW });
  for (let i = 0; i < opts.stories.length; i++) {
    const s = opts.stories[i];
    addStory(sql, { storyId: s.id, text: `Story ${i + 1}`, now: NOW + i });
  }
  openAsyncWindow(sql, { opensAt: NOW, closesAt: NOW + 4 * 3600 * 1000 });
  for (const s of opts.stories) {
    for (const v of s.votes) {
      castVote(sql, { storyId: s.id, voterId: v.voterId, points: v.points, confidence: v.confidence, now: NOW + 10 });
    }
  }
  closeAsyncWindow(sql, { now: NOW + 100 });
  // closeAsyncWindow flips stories to revealed and sets room → review;
  // it does NOT bucket (that's handleAsyncCloseFire in room.ts which
  // wraps closeAsyncWindow). For these tests we stamp the flag directly.
  for (const s of opts.stories) {
    setStoryNeedsDiscussion(sql, { storyId: s.id, needsDiscussion: s.needsDiscussion });
  }
}

function runFor(
  sql: SqlStorage,
  sockets: { ws: WebSocket; sent: string[] }[],
  senderWs: WebSocket,
  envRaw: string,
): Envelope[] {
  const ctx = {
    getWebSockets: () => sockets.map((s) => s.ws),
  } as unknown as DurableObjectState;
  return handleMessage(
    sql, senderWs, envRaw,
    (changes, opts) => broadcast(ctx, changes, getHostVoterId(sql), opts),
  );
}

function deltaFrom(sent: string[]): DeltaChange[] {
  for (const raw of sent) {
    const env = JSON.parse(raw) as Envelope<DeltaPayload>;
    if (env.type === 'DELTA') return env.payload.changes;
  }
  return [];
}

/** All DELTA changes across every envelope in `sent`, flattened in arrival order. */
function allChanges(sent: string[]): DeltaChange[] {
  const out: DeltaChange[] = [];
  for (const raw of sent) {
    const env = JSON.parse(raw) as Envelope<DeltaPayload>;
    if (env.type !== 'DELTA') continue;
    for (const c of env.payload.changes) out.push(c);
  }
  return out;
}

function allCommits(sent: string[]): Extract<DeltaChange, { kind: 'story_committed' }>[] {
  const out: Extract<DeltaChange, { kind: 'story_committed' }>[] = [];
  for (const raw of sent) {
    const env = JSON.parse(raw) as Envelope<DeltaPayload>;
    if (env.type !== 'DELTA') continue;
    for (const c of env.payload.changes) {
      if (c.kind === 'story_committed') out.push(c);
    }
  }
  return out;
}

// ---- ACCEPT_AGREED ---------------------------------------------------------

describe('ACCEPT_AGREED — host batch-commits consensus', () => {
  it('commits agreed stories to their median; discuss stories left untouched', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          // agreed: 5/5/5 → median 5
          { id: 'st-agreed-1', votes: [
            { voterId: V1, points: '5', confidence: 5 },
            { voterId: V2, points: '5', confidence: 5 },
            { voterId: V3, points: '5', confidence: 5 },
          ], needsDiscussion: false },
          // discuss: outlier (13 among 5s)
          { id: 'st-discuss', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '5',  confidence: 4 },
            { voterId: V3, points: '13', confidence: 4 },
          ], needsDiscussion: true },
          // agreed: 8/8/8 → median 8
          { id: 'st-agreed-2', votes: [
            { voterId: V1, points: '8', confidence: 5 },
            { voterId: V2, points: '8', confidence: 5 },
            { voterId: V3, points: '8', confidence: 5 },
          ], needsDiscussion: false },
        ],
      });

      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: V1, role: 'voter' });
      const env = JSON.stringify({ v: 1, type: 'ACCEPT_AGREED', id: 'aa-1', at: 0, payload: {} });
      const out = runFor(sql, [sockHost, sockVoter], sockHost.ws, env);
      expect(out).toEqual([]);

      // Only the two agreed stories committed.
      const committed = sql.exec<{ id: string; state: string; final_estimate: string | null }>(
        `SELECT id, state, final_estimate FROM story ORDER BY id`,
      ).toArray();
      const byId = Object.fromEntries(committed.map((s) => [s.id, s]));
      expect(byId['st-agreed-1'].state).toBe('committed');
      expect(byId['st-agreed-1'].final_estimate).toBe('5');
      expect(byId['st-agreed-2'].state).toBe('committed');
      expect(byId['st-agreed-2'].final_estimate).toBe('8');
      expect(byId['st-discuss'].state).toBe('revealed');
      expect(byId['st-discuss'].final_estimate).toBeNull();

      // Broadcast carries both commits; voter received them.
      const commits = allCommits(sockVoter.sent);
      expect(commits.map((c) => c.storyId).sort()).toEqual(['st-agreed-1', 'st-agreed-2']);
      expect(commits.find((c) => c.storyId === 'st-agreed-1')?.finalEstimate).toBe('5');
      expect(commits.find((c) => c.storyId === 'st-agreed-2')?.finalEstimate).toBe('8');
    });
  });

  it('non-host sender → NOT_HOST; nothing commits', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-1', votes: [
            { voterId: V1, points: '5', confidence: 5 },
            { voterId: V2, points: '5', confidence: 5 },
          ], needsDiscussion: false },
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: V1, role: 'voter' });
      const env = JSON.stringify({ v: 1, type: 'ACCEPT_AGREED', id: 'aa-1', at: 0, payload: {} });
      const out = runFor(sql, [sockHost, sockVoter], sockVoter.ws, env);
      expect((out[0].payload as ErrorPayload).code).toBe('NOT_HOST');
      const row = sql.exec<{ state: string }>(`SELECT state FROM story WHERE id = 'st-1'`).toArray()[0];
      expect(row.state).toBe('revealed');
    });
  });

  it('idempotent: re-running after a successful accept commits nothing more (no story_committed broadcast)', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-1', votes: [
            { voterId: V1, points: '5', confidence: 5 },
            { voterId: V2, points: '5', confidence: 5 },
          ], needsDiscussion: false },
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const env1 = JSON.stringify({ v: 1, type: 'ACCEPT_AGREED', id: 'aa-first', at: 0, payload: {} });
      runFor(sql, [sockHost], sockHost.ws, env1);
      expect(sql.exec<{ state: string }>(`SELECT state FROM story WHERE id = 'st-1'`).toArray()[0].state).toBe('committed');

      const sockHost2 = fakeWs({ voterId: HOST, role: 'host' });
      const env2 = JSON.stringify({ v: 1, type: 'ACCEPT_AGREED', id: 'aa-second', at: 0, payload: {} });
      const out = runFor(sql, [sockHost2], sockHost2.ws, env2);
      expect(out).toEqual([]);
      // No new story_committed broadcast on the second run.
      expect(allCommits(sockHost2.sent)).toEqual([]);
    });
  });

  it('zero agreed stories → clean no-op (no broadcast)', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-discuss', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '13', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const env = JSON.stringify({ v: 1, type: 'ACCEPT_AGREED', id: 'aa-z', at: 0, payload: {} });
      const out = runFor(sql, [sockHost], sockHost.ws, env);
      expect(out).toEqual([]);
      expect(allCommits(sockHost.sent)).toEqual([]);
      const row = sql.exec<{ state: string }>(`SELECT state FROM story WHERE id = 'st-discuss'`).toArray()[0];
      expect(row.state).toBe('revealed');
    });
  });

  it('all-non-numeric agreed story (median null) is skipped — host must decide', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-?', votes: [
            { voterId: V1, points: '?', confidence: 5 },
            { voterId: V2, points: '?', confidence: 5 },
            { voterId: V3, points: '?', confidence: 5 },
          ], needsDiscussion: false }, // stats.median === null
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const env = JSON.stringify({ v: 1, type: 'ACCEPT_AGREED', id: 'aa-?', at: 0, payload: {} });
      runFor(sql, [sockHost], sockHost.ws, env);
      const row = sql.exec<{ state: string; final_estimate: string | null }>(
        `SELECT state, final_estimate FROM story WHERE id = 'st-?'`,
      ).toArray()[0];
      expect(row.state).toBe('revealed'); // skipped — no median to commit to
      expect(row.final_estimate).toBeNull();
    });
  });
});

// ---- OPEN_DISCUSSION + subset re-vote (the load-bearing one) ---------------

describe('OPEN_DISCUSSION — re-opens flagged story for live re-vote', () => {
  it('clears prior votes, sets story `active`, sets room `active`; voter sees voting_opened + room_state_changed', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-discuss', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '13', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: V1, role: 'voter' });
      const env = JSON.stringify({
        v: 1, type: 'OPEN_DISCUSSION', id: 'od-1', at: 0, payload: { storyId: 'st-discuss' },
      });
      runFor(sql, [sockHost, sockVoter], sockHost.ws, env);

      // Story is active, prior votes cleared.
      const story = sql.exec<{ state: string; revealed_at: number | null }>(
        `SELECT state, revealed_at FROM story WHERE id = 'st-discuss'`,
      ).toArray()[0];
      expect(story.state).toBe('active');
      expect(story.revealed_at).toBeNull();
      const votes = sql.exec(`SELECT * FROM vote WHERE story_id = 'st-discuss'`).toArray();
      expect(votes).toEqual([]);

      // Room is active.
      const room = sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(room.state).toBe('active');

      // Voter received voting_opened + room_state_changed.
      const changes = deltaFrom(sockVoter.sent);
      expect(changes.some((c) => c.kind === 'voting_opened' && c.storyId === 'st-discuss')).toBe(true);
      expect(changes.some((c) => c.kind === 'room_state_changed' && c.state === 'active')).toBe(true);
    });
  });

  it('THE SUBSET RE-VOTE (load-bearing): 4 async voters, 2 vote in the re-vote → REVEAL_VOTES uses ONLY the 2 present voters (absent voters do not contribute)', async () => {
    await withRoom((sql) => {
      // Async close left a discuss story with 4 votes — 5, 5, 5, 13 →
      // median 5, outlier (v-4's 13) → flagged.
      seedReviewState(sql, {
        stories: [
          { id: 'st-discuss', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '5',  confidence: 4 },
            { voterId: V3, points: '5',  confidence: 4 },
            { voterId: V4, points: '13', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });

      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sock1 = fakeWs({ voterId: V1, role: 'voter' });
      const sock2 = fakeWs({ voterId: V2, role: 'voter' });

      // OPEN_DISCUSSION — clears all 4 async votes (the subset rule made real).
      runFor(sql, [sockHost, sock1, sock2], sockHost.ws,
        JSON.stringify({ v: 1, type: 'OPEN_DISCUSSION', id: 'od-1', at: 0, payload: { storyId: 'st-discuss' } }));
      const votesAfterOpen = sql.exec(`SELECT * FROM vote WHERE story_id = 'st-discuss'`).toArray();
      expect(votesAfterOpen).toEqual([]); // all 4 cleared

      // Only V1 and V2 show up for the re-vote. V3 and V4 are absent.
      runFor(sql, [sockHost, sock1, sock2], sock1.ws,
        JSON.stringify({ v: 1, type: 'VOTE_CAST', id: 'vc-1', at: 0,
          payload: { storyId: 'st-discuss', points: '8', confidence: 5 } }));
      runFor(sql, [sockHost, sock1, sock2], sock2.ws,
        JSON.stringify({ v: 1, type: 'VOTE_CAST', id: 'vc-2', at: 0,
          payload: { storyId: 'st-discuss', points: '8', confidence: 5 } }));

      // REVEAL_VOTES — new median computed from V1 + V2 only.
      runFor(sql, [sockHost, sock1, sock2], sockHost.ws,
        JSON.stringify({ v: 1, type: 'REVEAL_VOTES', id: 'rv-1', at: 0, payload: { storyId: 'st-discuss' } }));

      // The revealed votes table contains ONLY V1 + V2 — the absent V3/V4
      // contributed NOTHING. Their original 5/13 are gone (cleared on open).
      const revealedVotes = sql.exec<{ voter_id: string; points: string }>(
        `SELECT voter_id, points FROM vote WHERE story_id = 'st-discuss' ORDER BY voter_id`,
      ).toArray();
      expect(revealedVotes).toEqual([
        { voter_id: V1, points: '8' },
        { voter_id: V2, points: '8' },
      ]);
      // The new median, as recomputed at reveal-time, is 8 (V1+V2 only). The
      // outlier 13 from V4 is GONE; the original 5s from V3 are GONE. The
      // present voters' judgment stands alone — "whoever shows up."
      const story = sql.exec<{ state: string }>(`SELECT state FROM story WHERE id = 'st-discuss'`).toArray()[0];
      expect(story.state).toBe('revealed');
      // The reveal broadcast carries stats.median = '8'.
      const revealChange = allChanges(sock1.sent)
        .find((c) => c.kind === 'votes_revealed') as
          Extract<DeltaChange, { kind: 'votes_revealed' }> | undefined;
      expect(revealChange?.stats.median).toBe('8');
      expect(revealChange?.stats.outliers).toEqual([]); // 8 + 8 → consensus
    });
  });

  it('non-discuss story → STORY_NOT_DISCUSSABLE', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-agreed', votes: [
            { voterId: V1, points: '5', confidence: 5 },
            { voterId: V2, points: '5', confidence: 5 },
          ], needsDiscussion: false }, // not flagged
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const out = runFor(sql, [sockHost], sockHost.ws,
        JSON.stringify({ v: 1, type: 'OPEN_DISCUSSION', id: 'od-1', at: 0, payload: { storyId: 'st-agreed' } }));
      expect((out[0].payload as ErrorPayload).code).toBe('STORY_NOT_DISCUSSABLE');
      const row = sql.exec<{ state: string }>(`SELECT state FROM story WHERE id = 'st-agreed'`).toArray()[0];
      expect(row.state).toBe('revealed'); // untouched
    });
  });

  it('non-host → NOT_HOST', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-d', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '13', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockVoter = fakeWs({ voterId: V1, role: 'voter' });
      const out = runFor(sql, [sockHost, sockVoter], sockVoter.ws,
        JSON.stringify({ v: 1, type: 'OPEN_DISCUSSION', id: 'od-1', at: 0, payload: { storyId: 'st-d' } }));
      expect((out[0].payload as ErrorPayload).code).toBe('NOT_HOST');
    });
  });

  it('COMMIT_STORY on a re-opened story returns room active → review when other discuss stories remain', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-d1', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '13', confidence: 4 },
          ], needsDiscussion: true },
          { id: 'st-d2', votes: [
            { voterId: V1, points: '8',  confidence: 4 },
            { voterId: V2, points: '21', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockV1 = fakeWs({ voterId: V1, role: 'voter' });

      // Open + revote + reveal + commit st-d1.
      runFor(sql, [sockHost, sockV1], sockHost.ws,
        JSON.stringify({ v: 1, type: 'OPEN_DISCUSSION', id: 'od-1', at: 0, payload: { storyId: 'st-d1' } }));
      runFor(sql, [sockHost, sockV1], sockV1.ws,
        JSON.stringify({ v: 1, type: 'VOTE_CAST', id: 'vc-1', at: 0, payload: { storyId: 'st-d1', points: '8', confidence: 5 } }));
      runFor(sql, [sockHost, sockV1], sockHost.ws,
        JSON.stringify({ v: 1, type: 'REVEAL_VOTES', id: 'rv-1', at: 0, payload: { storyId: 'st-d1' } }));
      sockV1.sent.length = 0; // clear before commit
      runFor(sql, [sockHost, sockV1], sockHost.ws,
        JSON.stringify({ v: 1, type: 'COMMIT_STORY', id: 'cs-1', at: 0, payload: { storyId: 'st-d1', finalEstimate: '8' } }));

      // Room returns to review (st-d2 is still discuss + revealed).
      const room = sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(room.state).toBe('review');
      // Voter saw both story_committed AND room_state_changed → review.
      const changes = deltaFrom(sockV1.sent);
      expect(changes.some((c) => c.kind === 'story_committed' && c.storyId === 'st-d1')).toBe(true);
      expect(changes.some((c) => c.kind === 'room_state_changed' && c.state === 'review')).toBe(true);
    });
  });

  it('live round votes are HIDDEN until reveal — voter snapshot during re-vote carries no peer values', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-d', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '13', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      const sockV1 = fakeWs({ voterId: V1, role: 'voter' });
      const sockV2 = fakeWs({ voterId: V2, role: 'voter' });

      // Open re-vote.
      runFor(sql, [sockHost, sockV1, sockV2], sockHost.ws,
        JSON.stringify({ v: 1, type: 'OPEN_DISCUSSION', id: 'od-1', at: 0, payload: { storyId: 'st-d' } }));
      // V1 votes; V2 hasn't yet.
      runFor(sql, [sockHost, sockV1, sockV2], sockV1.ws,
        JSON.stringify({ v: 1, type: 'VOTE_CAST', id: 'vc-1', at: 0, payload: { storyId: 'st-d', points: '8', confidence: 4 } }));

      // V2 takes a fresh snapshot mid-round (e.g. reconnect): the active
      // story has NO peer vote values (the per-story anti-anchoring filter
      // re-engaged because openVoting set story → active).
      const sockV2New = fakeWs({ voterId: V2, role: 'voter' });
      const joinEnv = JSON.stringify({
        v: 1, type: 'JOIN_ROOM', id: 'j-1', at: 0,
        payload: { slug: 's', resumeVoterId: V2, role: 'voter' },
      });
      const snap = runFor(sql, [sockHost, sockV1, sockV2New], sockV2New.ws, joinEnv)[0];
      const snapBody = snap.payload as { stories: { id: string; votes?: { points: string }[] }[] };
      const activeStory = snapBody.stories.find((s) => s.id === 'st-d');
      expect(activeStory).toBeDefined();
      expect(activeStory!.votes ?? []).toEqual([]); // no peer values
    });
  });
});

// ---- Vacancy in review + re-vote active -----------------------------------

describe('S9.iii — vacancy in review + re-vote active', () => {
  it('host disconnect during `review` → handleHostVacantFire transitions room to host_vacant (vacancy eligibility extends to review by default)', async () => {
    await withRoomInstance(async (room, state) => {
      const sql = state.storage.sql;
      seedReviewState(sql, {
        stories: [
          { id: 'st-d', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '13', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });
      // The room is in `review` after the seed.
      expect(sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0].state).toBe('review');

      // Simulate the vacancy fire directly (testing the fire-time decision,
      // not the arm-on-disconnect — the arm runs from the live socket close
      // which is exercised in hostVacancy tests).
      sql.exec(
        `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
        't-vac', 0, 'host_vacant',
        JSON.stringify({ hostVoterId: HOST, disconnectedAt: NOW + 1000 }),
      );
      await room.alarm();

      // Room is in host_vacant. (Eligibility passes because review is NOT in
      // VACANCY_INELIGIBLE_STATES.) This proves the S7 banner+claim path
      // already covers the review state — one mechanism, two contexts.
      const r = sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(r.state).toBe('host_vacant');
    });
  });

  it('host disconnect during the re-vote `active` round → host_vacant (S7 path unchanged)', async () => {
    await withRoomInstance(async (room, state) => {
      const sql = state.storage.sql;
      seedReviewState(sql, {
        stories: [
          { id: 'st-d', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '13', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });
      // Open re-vote → room active.
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      runFor(sql, [sockHost], sockHost.ws,
        JSON.stringify({ v: 1, type: 'OPEN_DISCUSSION', id: 'od-1', at: 0, payload: { storyId: 'st-d' } }));
      expect(sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0].state).toBe('active');

      sql.exec(
        `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
        't-vac', 0, 'host_vacant',
        JSON.stringify({ hostVoterId: HOST, disconnectedAt: NOW + 1000 }),
      );
      await room.alarm();
      const r = sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(r.state).toBe('host_vacant');
    });
  });
});

// ---- The reclaim-target derivation (review → host_vacant → reclaim) -------

describe('S9.iii — reclaim from host_vacant derives target state from room contents', () => {
  it('review → host_vacant → setRoomHost reclaim → returns to `review` (not naïvely to `active`)', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-d', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '13', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });
      // Simulate the host_vacant transition.
      markRoomHostVacant(sql, { vacantSince: NOW + 1000 });
      expect(sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0].state).toBe('host_vacant');

      // Reclaim by a voter — would have gone naïvely to 'active' pre-S9.iii.
      // deriveReclaimRoomState sees: no active stories, one
      // revealed+needs_discussion → 'review'.
      setRoomHost(sql, { newHostVoterId: V1 });
      const r = sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(r.state).toBe('review');
    });
  });

  it('mid-re-vote `active` → host_vacant → reclaim → returns to `active` (round in progress)', async () => {
    await withRoom((sql) => {
      seedReviewState(sql, {
        stories: [
          { id: 'st-d', votes: [
            { voterId: V1, points: '5',  confidence: 4 },
            { voterId: V2, points: '13', confidence: 4 },
          ], needsDiscussion: true },
        ],
      });
      const sockHost = fakeWs({ voterId: HOST, role: 'host' });
      // Open re-vote → room active, story st-d → active.
      runFor(sql, [sockHost], sockHost.ws,
        JSON.stringify({ v: 1, type: 'OPEN_DISCUSSION', id: 'od-1', at: 0, payload: { storyId: 'st-d' } }));
      // Transition to host_vacant.
      markRoomHostVacant(sql, { vacantSince: NOW + 1000 });
      // Reclaim. deriveReclaimRoomState sees: one active story → 'active'.
      setRoomHost(sql, { newHostVoterId: V1 });
      const r = sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(r.state).toBe('active');
    });
  });

  it('sync room (no review, no discuss) → reclaim defaults to `active` (unchanged from pre-S9.iii)', async () => {
    await withRoom((sql) => {
      createRoom(sql, {
        roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
        hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
      });
      addVoter(sql, { voterId: V1, displayName: 'Ben', now: NOW });
      markRoomHostVacant(sql, { vacantSince: NOW + 1000 });
      setRoomHost(sql, { newHostVoterId: V1 });
      const r = sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(r.state).toBe('active'); // default
    });
  });

});
