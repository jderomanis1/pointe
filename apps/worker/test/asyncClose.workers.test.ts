/**
 * S9.i.c3 — async_close alarm: auto-reveal all + bucket.
 *
 * Fires the close alarm via the production path (Room.alarm() with tasks
 * forced due). Asserts:
 *  • Every active story → revealed; votes + stats visible to a connected voter.
 *  • Each story's needsDiscussion flag matches `storyNeedsDiscussion(stats)`:
 *    outlier OR low-confidence → discuss (OQ-016).
 *  • Deck-position outlier semantics (Fibonacci): 13 among 5s is an outlier
 *    (positions 5 vs 3 → distance 2), 3 among 5s is NOT (distance 1).
 *  • Room transitions to 'review'.
 *  • A single DELTA carrying N `votes_revealed` + `async_window_closed`.
 */
import { describe, it, expect } from 'vitest';
import type {
  DeltaChange, DeltaPayload, Envelope, RevealStats,
} from '@pointe/shared';
import { storyNeedsDiscussion } from '@pointe/shared';
import type {
  DurableObjectState, WebSocket as CfWebSocket,
} from '@cloudflare/workers-types';
import {
  addStory, addVoter, castVote, createRoom, openAsyncWindow,
} from '../src/operations';
import { upsertAiSuggestion, type AiPayloadJson } from '../src/ai';
import { withRoomInstance } from './helpers/pool';

type WebSocket = CfWebSocket;

const HOST = 'host-1';
const VOTER = 'v-1';
const VOTER2 = 'v-2';
const VOTER3 = 'v-3';
const NOW = 1_700_000_000_000;

/** Real WebSocketPair → accepted by DO state. Pattern from hostVacancy tests. */
function makeRealSock(
  state: DurableObjectState,
  attachment: { voterId: string; role: 'host' | 'voter' | 'spectator' },
): { server: WebSocket; received: Envelope[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pair = new (globalThis as any).WebSocketPair() as { 0: WebSocket; 1: WebSocket };
  const client = pair[0];
  const server = pair[1];
  state.acceptWebSocket(server);
  server.serializeAttachment(attachment);
  const received: Envelope[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).accept();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).addEventListener('message', (ev: { data: string | ArrayBuffer }) => {
    if (typeof ev.data === 'string') received.push(JSON.parse(ev.data) as Envelope);
  });
  return { server, received };
}

function seedAsyncRoomActive(
  sql: SqlStorage,
  opts: { stories: string[] },
): { closesAt: number } {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'async', now: NOW,
  });
  addVoter(sql, { voterId: VOTER, displayName: 'Ben', now: NOW });
  addVoter(sql, { voterId: VOTER2, displayName: 'Cleo', now: NOW });
  addVoter(sql, { voterId: VOTER3, displayName: 'Dax', now: NOW });
  for (let i = 0; i < opts.stories.length; i++) {
    addStory(sql, { storyId: opts.stories[i], text: `s${i + 1}`, now: NOW + i });
  }
  const opensAt = NOW + 10;
  const closesAt = opensAt + 4 * 60 * 60 * 1000;
  openAsyncWindow(sql, { opensAt, closesAt });
  return { closesAt };
}

/** Make every scheduled task immediately due so room.alarm() picks them up. */
function forceTasksDue(sql: SqlStorage): void {
  sql.exec(`UPDATE scheduled_task SET at = 0`);
}

function findChange<K extends DeltaChange['kind']>(
  envs: Envelope[], kind: K,
  match?: (c: Extract<DeltaChange, { kind: K }>) => boolean,
): Extract<DeltaChange, { kind: K }> | undefined {
  for (const e of envs) {
    if (e.type !== 'DELTA') continue;
    const payload = e.payload as DeltaPayload;
    for (const c of payload.changes) {
      if (c.kind === kind) {
        const typed = c as Extract<DeltaChange, { kind: K }>;
        if (!match || match(typed)) return typed;
      }
    }
  }
  return undefined;
}

// ---- The three OQ-016 buckets, all in one timeline -------------------------

describe('S9.i.c3 — close alarm: auto-reveal + bucket (OQ-016)', () => {
  it('three stories: consensus+confident → auto-accept; outlier (13 among 5s) → discuss; consensus-but-low-confidence → discuss', async () => {
    await withRoomInstance(async (room, state) => {
      const sql = state.storage.sql;
      // SETUP — seed three stories, all active under one async window.
      const { closesAt } = seedAsyncRoomActive(sql, {
        stories: ['st-consensus', 'st-outlier', 'st-lowconf'],
      });
      // Schedule the close alarm (op-only seed didn't go through OPEN_ASYNC).
      sql.exec(
        `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
        'task-close', closesAt, 'async_close', JSON.stringify({ closesAt }),
      );

      // VOTES — three voters per story.
      // Story 1 (consensus + confident): 5/5/5 with high confidence.
      castVote(sql, { storyId: 'st-consensus', voterId: VOTER,  points: '5', confidence: 5, now: NOW + 100 });
      castVote(sql, { storyId: 'st-consensus', voterId: VOTER2, points: '5', confidence: 4, now: NOW + 101 });
      castVote(sql, { storyId: 'st-consensus', voterId: VOTER3, points: '5', confidence: 5, now: NOW + 102 });

      // Story 2 (outlier): 5, 5, 13 (deck-position 3, 3, 5 — distance 2 → outlier).
      castVote(sql, { storyId: 'st-outlier', voterId: VOTER,  points: '5',  confidence: 4, now: NOW + 110 });
      castVote(sql, { storyId: 'st-outlier', voterId: VOTER2, points: '5',  confidence: 4, now: NOW + 111 });
      castVote(sql, { storyId: 'st-outlier', voterId: VOTER3, points: '13', confidence: 4, now: NOW + 112 });

      // Story 3 (low-confidence consensus): 5/5/5 but confidence avg < 2.5.
      castVote(sql, { storyId: 'st-lowconf', voterId: VOTER,  points: '5', confidence: 2, now: NOW + 120 });
      castVote(sql, { storyId: 'st-lowconf', voterId: VOTER2, points: '5', confidence: 2, now: NOW + 121 });
      castVote(sql, { storyId: 'st-lowconf', voterId: VOTER3, points: '5', confidence: 2, now: NOW + 122 });

      // A connected voter socket — observes the broadcast.
      const voterSock = makeRealSock(state, { voterId: VOTER, role: 'voter' });

      // FIRE THE ALARM.
      forceTasksDue(sql);
      await room.alarm();
      await new Promise((r) => setTimeout(r, 10)); // let ws drain

      // Stories revealed.
      const states = sql.exec<{ id: string; state: string; needs_discussion: number }>(
        `SELECT id, state, needs_discussion FROM story ORDER BY id`,
      ).toArray();
      const byId = Object.fromEntries(states.map((s) => [s.id, s]));
      expect(byId['st-consensus'].state).toBe('revealed');
      expect(byId['st-outlier'].state).toBe('revealed');
      expect(byId['st-lowconf'].state).toBe('revealed');

      // Bucket per story (server-truth on the row).
      expect(byId['st-consensus'].needs_discussion).toBe(0); // auto-accept
      expect(byId['st-outlier'].needs_discussion).toBe(1);   // discuss (outlier)
      // OQ-016 anchor: low-confidence consensus → discuss. This is the case
      // outliers-only would have wrongly auto-accepted.
      expect(byId['st-lowconf'].needs_discussion).toBe(1);

      // Room transitioned to 'review'.
      const room2 = sql.exec<{ state: string; async_window: string | null }>(
        `SELECT state, async_window FROM room LIMIT 1`,
      ).toArray()[0];
      expect(room2.state).toBe('review');

      // S10.iii fast guard — async_window is cleared at close. Leaving the
      // JSON column set across review would re-trigger AsyncVoterView on the
      // subsequent OPEN_DISCUSSION-driven `review → active` flip (RoomShell's
      // asyncWindowOpen gate is mode+asyncWindow+state==='active'). The S10.iii
      // E2E proves the rendered consequence; this is the regression guard at
      // the per-push gate.
      expect(room2.async_window).toBeNull();

      // The voter received the broadcast with all three votes_revealed + a
      // trailing async_window_closed.
      const consensus = findChange(voterSock.received, 'votes_revealed',
        (c) => c.storyId === 'st-consensus');
      const outlier = findChange(voterSock.received, 'votes_revealed',
        (c) => c.storyId === 'st-outlier');
      const lowconf = findChange(voterSock.received, 'votes_revealed',
        (c) => c.storyId === 'st-lowconf');
      expect(consensus).toBeDefined();
      expect(outlier).toBeDefined();
      expect(lowconf).toBeDefined();

      // Votes ARE visible at close (the window's anti-anchoring ends here,
      // batch reveal exactly like a sync reveal).
      expect(consensus!.votes).toHaveLength(3);
      expect(outlier!.votes.find((v) => v.voterId === VOTER3)?.points).toBe('13');

      // needsDiscussion on each change matches the persisted flag.
      expect(consensus!.needsDiscussion).toBe(false);
      expect(outlier!.needsDiscussion).toBe(true);
      expect(lowconf!.needsDiscussion).toBe(true);

      // async_window_closed lands in the same broadcast.
      const closed = findChange(voterSock.received, 'async_window_closed');
      expect(closed).toBeDefined();
    });
  });
});

// ---- Deck-position semantics ----------------------------------------------

describe('S9.i.c3 — outlier is deck-position-aware (Fibonacci)', () => {
  it('a 3 among 5s is NOT an outlier (distance 1, adjacent cards)', async () => {
    await withRoomInstance(async (room, state) => {
      const sql = state.storage.sql;
      const { closesAt } = seedAsyncRoomActive(sql, { stories: ['st-1'] });
      sql.exec(
        `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
        't-1', closesAt, 'async_close', JSON.stringify({ closesAt }),
      );
      // Confidence high to keep low-confidence path out of it.
      castVote(sql, { storyId: 'st-1', voterId: VOTER,  points: '5', confidence: 5, now: NOW + 1 });
      castVote(sql, { storyId: 'st-1', voterId: VOTER2, points: '5', confidence: 5, now: NOW + 2 });
      castVote(sql, { storyId: 'st-1', voterId: VOTER3, points: '3', confidence: 5, now: NOW + 3 });

      forceTasksDue(sql);
      await room.alarm();

      const row = sql.exec<{ needs_discussion: number }>(
        `SELECT needs_discussion FROM story WHERE id = 'st-1'`,
      ).toArray()[0];
      expect(row.needs_discussion).toBe(0); // 3 vs median 5 → distance 1 → not outlier
    });
  });
});

// ---- The bucket function as a unit ----------------------------------------

describe('S9.i.c3 — storyNeedsDiscussion (the pure bucket function)', () => {
  const baseStats: Omit<RevealStats, 'outliers' | 'avgConfidence' | 'lowConfidence'> = {
    median: '5', nonNumeric: [], numericCount: 3,
  };
  it('no outlier + high confidence → false (auto-accept)', () => {
    expect(storyNeedsDiscussion({
      ...baseStats, outliers: [], avgConfidence: 4.5, lowConfidence: false,
    })).toBe(false);
  });
  it('outlier → true (discuss)', () => {
    expect(storyNeedsDiscussion({
      ...baseStats, outliers: ['v-3'], avgConfidence: 4.5, lowConfidence: false,
    })).toBe(true);
  });
  it('low confidence → true (Pillar 3 false-consensus catch — OQ-016)', () => {
    expect(storyNeedsDiscussion({
      ...baseStats, outliers: [], avgConfidence: 1.8, lowConfidence: true,
    })).toBe(true);
  });
});

// ---- Idempotency -----------------------------------------------------------

describe('S9.i.c3 — close-alarm idempotency', () => {
  it('a duplicate fire after the room is already in review is a silent no-op', async () => {
    await withRoomInstance(async (room, state) => {
      const sql = state.storage.sql;
      const { closesAt } = seedAsyncRoomActive(sql, { stories: ['st-1'] });
      sql.exec(
        `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
        't-1', closesAt, 'async_close', JSON.stringify({ closesAt }),
      );
      castVote(sql, { storyId: 'st-1', voterId: VOTER,  points: '5', confidence: 4, now: NOW + 1 });

      forceTasksDue(sql);
      await room.alarm();
      const room1 = sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(room1.state).toBe('review');

      // Manually re-schedule and re-fire — closeAsyncWindow returns empty results.
      sql.exec(
        `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
        't-2', 0, 'async_close', JSON.stringify({ closesAt }),
      );
      await room.alarm();
      // No throws; room still in review; stories still revealed.
      const room2 = sql.exec<{ state: string }>(`SELECT state FROM room LIMIT 1`).toArray()[0];
      expect(room2.state).toBe('review');
    });
  });
});

// ---- AA-1 holds across the async close (S9.i.c4) --------------------------

const FIXTURE_PAYLOAD: AiPayloadJson = {
  complexity: { level: 'medium', note: 'c' },
  effort: { level: 'low', note: 'e' },
  risk: { level: 'low', note: 'r' },
  unknowns: { level: 'low', note: 'u' },
  suggestedRange: { low: '3', high: '5' },
  rationale: 'because',
};

describe('S9.i.c4 — AA-1 holds across the async-close reveal trigger', () => {
  // The MUST: the close auto-reveal is a NEW reveal trigger, and the only
  // invariant we prove is the AA-1 invariant. Voter receives no `ai` on a
  // story whose suggestion the host privately consulted but did NOT share.
  it('unshared `ai` stays host-scoped at close: voter\'s votes_revealed has NO ai; host\'s DOES (per-recipient projection holds)', async () => {
    await withRoomInstance(async (room, state) => {
      const sql = state.storage.sql;
      const { closesAt } = seedAsyncRoomActive(sql, { stories: ['st-1'] });
      sql.exec(
        `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
        't-close', closesAt, 'async_close', JSON.stringify({ closesAt }),
      );

      // Host privately consulted AI on st-1 → ready, NOT shared.
      upsertAiSuggestion(sql, {
        storyId: 'st-1', state: 'ready', payload: FIXTURE_PAYLOAD,
        requestedAt: NOW + 50, completedAt: NOW + 60, shared: false,
      });

      // Three votes (consensus + confident) so the bucket itself is uneventful
      // — the AA-1 question is about the `ai` projection, not the bucket.
      castVote(sql, { storyId: 'st-1', voterId: VOTER,  points: '5', confidence: 5, now: NOW + 100 });
      castVote(sql, { storyId: 'st-1', voterId: VOTER2, points: '5', confidence: 5, now: NOW + 101 });
      castVote(sql, { storyId: 'st-1', voterId: VOTER3, points: '5', confidence: 5, now: NOW + 102 });

      // Both sockets attached: voter is observed; host is the validity anchor
      // (the same broadcast that strips ai for voter MUST include it for host
      // — that's the per-recipient projection working, not an absence of data).
      const voterSock = makeRealSock(state, { voterId: VOTER, role: 'voter' });
      const hostSock = makeRealSock(state, { voterId: HOST, role: 'host' });

      forceTasksDue(sql);
      await room.alarm();
      await new Promise((r) => setTimeout(r, 10));

      // Voter received the reveal (auto-reveal at close); votes/stats land,
      // but `ai` is absent — the AA-1 key. Stripped via projectChangesFor.
      const voterChange = findChange(voterSock.received, 'votes_revealed',
        (c) => c.storyId === 'st-1');
      expect(voterChange).toBeDefined();
      expect('ai' in voterChange!).toBe(false);
      expect(voterChange!.votes).toHaveLength(3);

      // Host received the SAME broadcast with `ai` included — proves the
      // suggestion was attached at the source and the strip is per-recipient.
      const hostChange = findChange(hostSock.received, 'votes_revealed',
        (c) => c.storyId === 'st-1');
      expect(hostChange).toBeDefined();
      expect(hostChange!.ai).toBeDefined();
      expect(hostChange!.ai?.state).toBe('ready');
    });
  });

  // VALIDITY (so the no-leak assertion isn't vacuous): the same close-path
  // observation harness CAN detect ai when the host shares — same logic as
  // the S8.v capstone's S timeline. Without this, an always-empty assertion
  // would pass even on a broken projection.
  it('after SHARE_AI the voter DOES receive the suggestion (AI_SHARED carries the ai) — the observation harness has teeth', async () => {
    await withRoomInstance(async (room, state) => {
      const sql = state.storage.sql;
      const { closesAt } = seedAsyncRoomActive(sql, { stories: ['st-1'] });
      sql.exec(
        `INSERT INTO scheduled_task (id, at, type, payload) VALUES (?, ?, ?, ?)`,
        't-close', closesAt, 'async_close', JSON.stringify({ closesAt }),
      );
      upsertAiSuggestion(sql, {
        storyId: 'st-1', state: 'ready', payload: FIXTURE_PAYLOAD,
        requestedAt: NOW + 50, completedAt: NOW + 60, shared: false,
      });
      castVote(sql, { storyId: 'st-1', voterId: VOTER,  points: '5', confidence: 5, now: NOW + 100 });

      const voterSock = makeRealSock(state, { voterId: VOTER, role: 'voter' });
      const hostSock = makeRealSock(state, { voterId: HOST, role: 'host' });

      // Close fires; voter sees no ai (re-asserts the no-leak case in this run).
      forceTasksDue(sql);
      await room.alarm();
      await new Promise((r) => setTimeout(r, 10));
      const voterCloseChange = findChange(voterSock.received, 'votes_revealed',
        (c) => c.storyId === 'st-1');
      expect(voterCloseChange).toBeDefined();
      expect('ai' in voterCloseChange!).toBe(false);

      // Host shares after close (SHARE_AI requires revealed/committed; the
      // close-alarm just transitioned the story to revealed).
      await room.webSocketMessage(hostSock.server, JSON.stringify({
        v: 1, type: 'SHARE_AI', id: 'sh-1', at: 0, payload: { storyId: 'st-1' },
      }));
      await new Promise((r) => setTimeout(r, 10));

      // Voter now receives an AI_SHARED envelope carrying the ready suggestion.
      // This proves the no-leak assertion above is detecting real scoping, not
      // an always-empty field — the SAME socket DOES see ai when the host
      // sanctions the crossing.
      const sharedEnv = voterSock.received.find((e) => e.type === 'AI_SHARED');
      expect(sharedEnv).toBeDefined();
      const sharedAi = (sharedEnv!.payload as { ai: { state: string; shared: boolean } }).ai;
      expect(sharedAi.state).toBe('ready');
      expect(sharedAi.shared).toBe(true);
    });
  });
});
