import { describe, it, expect } from 'vitest';
import { handleMessage } from '../src/dispatcher';
import { initSchema } from '../src/schema';
import {
  createRoom, addStory, openVoting, castVote, revealVotes, addVoter, getRoomState,
} from '../src/operations';
import { createMockDoState } from './helpers/mockDoState';
import type { DeltaChange, ErrorPayload, RoomSnapshot } from '@pointe/shared';

const NOW = 1_700_000_000_000;

// --- Mock WebSocket ---
// Records serializeAttachment / send; deserializeAttachment returns the last serialized value.
function fakeWs(initialAttachment: unknown = undefined) {
  let attachment: unknown = initialAttachment;
  const sent: string[] = [];
  return {
    sent,
    ws: {
      send: (s: string) => { sent.push(s); },
      serializeAttachment: (a: unknown) => { attachment = a; },
      deserializeAttachment: () => attachment,
      close: () => {},
    } as unknown as Parameters<typeof handleMessage>[1],
  };
}

function captureBroadcasts() {
  const calls: { changes: DeltaChange[]; opts?: { excludeWs?: unknown } }[] = [];
  const broadcast = (changes: DeltaChange[], opts?: { excludeWs?: unknown }) => {
    calls.push({ changes, opts });
  };
  return { calls, broadcast: broadcast as Parameters<typeof handleMessage>[3] };
}

function setupRoom() {
  const sql = createMockDoState().storage.sql;
  initSchema(sql);
  createRoom(sql, {
    roomId: 'room-1', slug: 'apt-sparrow-16',
    hostVoterId: 'host-1', hostDisplayName: 'Host',
    deck: 'fibonacci', mode: 'sync', now: NOW,
  });
  return sql;
}

function env(type: string, id = 'm-1', at = Date.now(), payload: unknown = {}, v = 1): string {
  return JSON.stringify({ v, type, id, at, payload });
}

describe('dispatcher.handleMessage — R2.ii pipe (reply id echo correction)', () => {
  it('RECONNECT_PING → PONG; reply id echoes request id', () => {
    const sql = setupRoom();
    const { ws } = fakeWs();
    const out = handleMessage(sql, ws, env('RECONNECT_PING', 'ping-id'));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('PONG');
    expect(out[0].id).toBe('ping-id');
  });

  it('malformed JSON → ERROR BAD_ENVELOPE (does not throw; minted id ok)', () => {
    const sql = setupRoom();
    const { ws } = fakeWs();
    const out = handleMessage(sql, ws, '{not json');
    expect((out[0].payload as ErrorPayload).code).toBe('BAD_ENVELOPE');
  });

  it('wrong protocol version → ERROR UNSUPPORTED_VERSION; reply id echoes', () => {
    const sql = setupRoom();
    const { ws } = fakeWs();
    const out = handleMessage(sql, ws, env('RECONNECT_PING', 'v-x', Date.now(), {}, 999));
    expect(out[0].type).toBe('ERROR');
    expect((out[0].payload as ErrorPayload).code).toBe('UNSUPPORTED_VERSION');
    expect(out[0].id).toBe('v-x');
  });

  it('not-yet-implemented type → ERROR NOT_IMPLEMENTED; reply id echoes', () => {
    const sql = setupRoom();
    const { ws } = fakeWs();
    // REVEAL_VOTES is still in the NOT_IMPLEMENTED default branch (lands in R3.iii).
    const out = handleMessage(sql, ws, env('REVEAL_VOTES', 'rv-1'));
    expect((out[0].payload as ErrorPayload).code).toBe('NOT_IMPLEMENTED');
    expect(out[0].id).toBe('rv-1');
  });

  it('non-mutating PING does NOT record in processed_message (record-on-success refinement)', () => {
    const sql = setupRoom();
    const { ws } = fakeWs();
    handleMessage(sql, ws, env('RECONNECT_PING', 'dup'));
    handleMessage(sql, ws, env('RECONNECT_PING', 'dup'));
    const rows = sql.exec<{ id: string }>(`SELECT id FROM processed_message WHERE id = 'dup'`).toArray();
    expect(rows).toHaveLength(0);
  });

  it('at override: server-stamps reply.at; client at=0 ignored', () => {
    const sql = setupRoom();
    const { ws } = fakeWs();
    const before = Date.now();
    const out = handleMessage(sql, ws, env('RECONNECT_PING', 'at-x', 0));
    expect(out[0].at).toBeGreaterThanOrEqual(before);
    expect(out[0].at).not.toBe(0);
  });
});

describe('dispatcher.handleMessage — JOIN_ROOM (R2.iii)', () => {
  function joinEnv(id: string, payload: object) {
    return JSON.stringify({ v: 1, type: 'JOIN_ROOM', id, at: 0, payload });
  }

  it('new voter: creates voter, binds via serializeAttachment, returns SNAPSHOT_RESPONSE; reply id echoes', () => {
    const sql = setupRoom();
    const { ws, sent } = fakeWs();
    const captured: unknown[] = [];
    const wsProxy = new Proxy(ws, {
      get(target, prop) {
        if (prop === 'serializeAttachment') {
          return (a: unknown) => { captured.push(a); (target as unknown as { serializeAttachment: (a: unknown) => void }).serializeAttachment(a); };
        }
        return (target as unknown as Record<string | symbol, unknown>)[prop];
      },
    });
    const out = handleMessage(sql, wsProxy, joinEnv('join-1', { slug: 's', displayName: 'Alice', role: 'voter' }));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('SNAPSHOT_RESPONSE');
    expect(out[0].id).toBe('join-1');
    const snap = out[0].payload as RoomSnapshot;
    expect(snap.you.voterId).toBeTruthy();
    expect(snap.you.role).toBe('voter');
    expect(captured).toHaveLength(1);
    expect((captured[0] as { voterId: string }).voterId).toBe(snap.you.voterId);
    expect(sent).toEqual([]); // dispatcher returns envelopes; the room.ts wrapper sends them
  });

  it('resume: same voterId reused; no duplicate row; connection reactivated', () => {
    const sql = setupRoom();
    // Add a voter to resume.
    addVoter(sql, { voterId: 'v-alice', displayName: 'Alice', now: NOW + 1 });
    const { ws } = fakeWs();
    const out = handleMessage(sql, ws, joinEnv('join-r', { slug: 's', resumeVoterId: 'v-alice', role: 'voter' }));
    const snap = out[0].payload as RoomSnapshot;
    expect(snap.you.voterId).toBe('v-alice');
    expect(snap.voters.filter((v) => v.id === 'v-alice')).toHaveLength(1);
  });

  it('missing displayName for a new voter → ERROR DISPLAY_NAME_REQUIRED; binding NOT applied', () => {
    const sql = setupRoom();
    const { ws } = fakeWs();
    const out = handleMessage(sql, ws, joinEnv('join-bad', { slug: 's', role: 'voter' }));
    expect(out[0].type).toBe('ERROR');
    expect((out[0].payload as ErrorPayload).code).toBe('DISPLAY_NAME_REQUIRED');
    expect(out[0].id).toBe('join-bad');
    // No attachment was set.
    expect(ws.deserializeAttachment()).toBeUndefined();
  });

  it('SI-01: a payload-supplied `voterId` cannot impersonate; server mints/binds its own', () => {
    const sql = setupRoom();
    const { ws } = fakeWs();
    const out = handleMessage(
      sql, ws,
      joinEnv('join-spoof', { slug: 's', displayName: 'X', role: 'voter', voterId: 'SPOOFED' }),
    );
    const snap = out[0].payload as RoomSnapshot;
    expect(snap.you.voterId).not.toBe('SPOOFED');
    expect(snap.you.voterId.length).toBeGreaterThan(8);
  });

  it('anti-anchoring: active story strips votes; revealed story keeps votes', () => {
    const sql = setupRoom();
    // Add v-a, v-b. Add story-1, open, both vote, reveal. Add story-2, open, both vote (active).
    addVoter(sql, { voterId: 'v-a', displayName: 'A', now: NOW + 1 });
    addVoter(sql, { voterId: 'v-b', displayName: 'B', now: NOW + 2 });
    addStory(sql, { storyId: 'story-1', text: 'one', now: NOW + 3 });
    openVoting(sql, { storyId: 'story-1', now: NOW + 4 });
    castVote(sql, { storyId: 'story-1', voterId: 'v-a', points: '5', confidence: 3, now: NOW + 5 });
    castVote(sql, { storyId: 'story-1', voterId: 'v-b', points: '8', confidence: 4, now: NOW + 6 });
    revealVotes(sql, { storyId: 'story-1', now: NOW + 7 });
    addStory(sql, { storyId: 'story-2', text: 'two', now: NOW + 8 });
    openVoting(sql, { storyId: 'story-2', now: NOW + 9 });
    castVote(sql, { storyId: 'story-2', voterId: 'v-a', points: '3', confidence: 2, now: NOW + 10 });

    const { ws } = fakeWs();
    const out = handleMessage(sql, ws, joinEnv('j', { slug: 's', displayName: 'C', role: 'voter' }));
    const snap = out[0].payload as RoomSnapshot;
    const active = snap.stories.find((s) => s.state === 'active');
    const revealed = snap.stories.find((s) => s.state === 'revealed');
    expect(active).toBeDefined();
    expect(active!.votes).toEqual([]); // STRIPPED
    expect(revealed).toBeDefined();
    expect(revealed!.votes).toHaveLength(2); // KEPT
  });

  it('JOIN broadcasts `voter_joined` to peers; joiner gets SNAPSHOT only (no self-delta)', () => {
    const sql = setupRoom();
    const { ws: joinerWs } = fakeWs();
    const broadcasts: { changes: unknown[]; opts?: { excludeWs?: unknown } }[] = [];
    const out = handleMessage(
      sql,
      joinerWs,
      joinEnv('join-b', { slug: 's', displayName: 'Joiner', role: 'voter' }),
      (changes, opts) => broadcasts.push({ changes, opts }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('SNAPSHOT_RESPONSE'); // joiner reply
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].changes).toHaveLength(1);
    expect((broadcasts[0].changes[0] as { kind: string }).kind).toBe('voter_joined');
    expect(broadcasts[0].opts?.excludeWs).toBe(joinerWs); // joiner excluded
  });

  it('scope limit: snapshot includes the active + only the last 3 revealed', () => {
    const sql = setupRoom();
    // Reveal 5 stories chronologically, then open a 6th (active).
    for (let i = 1; i <= 5; i++) {
      addStory(sql, { storyId: `s${i}`, text: `t${i}`, now: NOW + i });
      openVoting(sql, { storyId: `s${i}`, now: NOW + 100 + i });
      revealVotes(sql, { storyId: `s${i}`, now: NOW + 200 + i });
    }
    addStory(sql, { storyId: 's6', text: 't6', now: NOW + 300 });
    openVoting(sql, { storyId: 's6', now: NOW + 301 });

    const { ws } = fakeWs();
    const out = handleMessage(sql, ws, joinEnv('j', { slug: 's', displayName: 'D', role: 'voter' }));
    const snap = out[0].payload as RoomSnapshot;
    expect(snap.stories).toHaveLength(4); // 1 active + 3 revealed
    const revealedIds = snap.stories.filter((s) => s.state === 'revealed').map((s) => s.id).sort();
    expect(revealedIds).toEqual(['s3', 's4', 's5']);
    expect(snap.stories.some((s) => s.id === 's6' && s.state === 'active')).toBe(true);
  });
});

describe('dispatcher.handleMessage — story-queue messages (R3.i)', () => {
  const HOST = { voterId: 'host-1', role: 'host' as const };
  const VOTER = { voterId: 'v-a', role: 'voter' as const };

  function storyEnv(type: string, id: string, payload: object) {
    return JSON.stringify({ v: 1, type, id, at: 0, payload });
  }

  // ---- ADD_STORY ----

  it('ADD_STORY (host): creates a story; broadcasts story_added to all; no direct reply', () => {
    const sql = setupRoom();
    const { ws } = fakeWs(HOST);
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(sql, ws, storyEnv('ADD_STORY', 'a1', { text: 'first' }), broadcast);
    expect(out).toEqual([]); // actor receives via broadcast, not a direct reply
    expect(calls).toHaveLength(1);
    expect(calls[0].changes[0]).toMatchObject({ kind: 'story_added' });
    expect(calls[0].opts?.excludeWs).toBeUndefined(); // story metadata is public — actor included
    expect(getRoomState(sql).stories).toHaveLength(1);
  });

  it('ADD_STORY (non-host): ERROR NOT_HOST (id echoed); no story; no processed_message row', () => {
    const sql = setupRoom();
    addVoter(sql, { voterId: 'v-a', displayName: 'A', now: NOW + 1 });
    const { ws } = fakeWs(VOTER);
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(sql, ws, storyEnv('ADD_STORY', 'a-bad', { text: 'nope' }), broadcast);
    expect(out).toHaveLength(1);
    expect((out[0].payload as ErrorPayload).code).toBe('NOT_HOST');
    expect(out[0].id).toBe('a-bad');
    expect(calls).toEqual([]);
    expect(getRoomState(sql).stories).toHaveLength(0);
    const rows = sql.exec(`SELECT id FROM processed_message WHERE id = 'a-bad'`).toArray();
    expect(rows).toHaveLength(0); // rejected → no dedupe record
  });

  it('ADD_STORY (not joined): ERROR NOT_JOINED; no story; no row', () => {
    const sql = setupRoom();
    const { ws } = fakeWs(); // no attachment
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(sql, ws, storyEnv('ADD_STORY', 'a-nj', { text: 'x' }), broadcast);
    expect((out[0].payload as ErrorPayload).code).toBe('NOT_JOINED');
    expect(calls).toEqual([]);
    expect(getRoomState(sql).stories).toHaveLength(0);
  });

  it('ADD_STORY replay (host): exactly one story, one processed_message row, one broadcast', () => {
    const sql = setupRoom();
    const { ws } = fakeWs(HOST);
    const { calls, broadcast } = captureBroadcasts();
    const raw = storyEnv('ADD_STORY', 'a-dup', { text: 'twice' });
    handleMessage(sql, ws, raw, broadcast);
    handleMessage(sql, ws, raw, broadcast); // replay
    expect(getRoomState(sql).stories).toHaveLength(1);
    const rows = sql.exec(`SELECT id FROM processed_message WHERE id = 'a-dup'`).toArray();
    expect(rows).toHaveLength(1);
    expect(calls).toHaveLength(1); // replay does not re-broadcast
  });

  // ---- EDIT_STORY ----

  it('EDIT_STORY (host): updates and broadcasts story_edited', () => {
    const sql = setupRoom();
    addStory(sql, { storyId: 's-1', text: 'old', now: NOW + 1 });
    const { ws } = fakeWs(HOST);
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(
      sql, ws,
      storyEnv('EDIT_STORY', 'e1', { storyId: 's-1', text: 'new' }),
      broadcast,
    );
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].changes[0]).toMatchObject({ kind: 'story_edited' });
    expect(getRoomState(sql).stories[0].text).toBe('new');
  });

  it('EDIT_STORY (host, missing story): ERROR STORY_NOT_FOUND', () => {
    const sql = setupRoom();
    const { ws } = fakeWs(HOST);
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(
      sql, ws,
      storyEnv('EDIT_STORY', 'e-bad', { storyId: 'nope', text: 'x' }),
      broadcast,
    );
    expect((out[0].payload as ErrorPayload).code).toBe('STORY_NOT_FOUND');
    expect(calls).toEqual([]);
  });

  // ---- OPEN_VOTING ----

  it('OPEN_VOTING (host, pending): transitions to active; broadcasts voting_opened', () => {
    const sql = setupRoom();
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    const { ws } = fakeWs(HOST);
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(
      sql, ws, storyEnv('OPEN_VOTING', 'o1', { storyId: 's-1' }), broadcast,
    );
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].changes[0]).toEqual({ kind: 'voting_opened', storyId: 's-1' });
    const st = getRoomState(sql).stories.find((s) => s.id === 's-1');
    expect(st?.state).toBe('active');
  });

  it('OPEN_VOTING (host, another active): ERROR ANOTHER_STORY_ACTIVE; no state change', () => {
    const sql = setupRoom();
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    addStory(sql, { storyId: 's-2', text: 'two', now: NOW + 2 });
    openVoting(sql, { storyId: 's-1', now: NOW + 3 });
    const { ws } = fakeWs(HOST);
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(
      sql, ws, storyEnv('OPEN_VOTING', 'o-2', { storyId: 's-2' }), broadcast,
    );
    expect((out[0].payload as ErrorPayload).code).toBe('ANOTHER_STORY_ACTIVE');
    expect(calls).toEqual([]);
    const s2 = getRoomState(sql).stories.find((s) => s.id === 's-2');
    expect(s2?.state).toBe('pending');
  });

  it('OPEN_VOTING (non-host): ERROR NOT_HOST', () => {
    const sql = setupRoom();
    addStory(sql, { storyId: 's-1', text: 'one', now: NOW + 1 });
    addVoter(sql, { voterId: 'v-a', displayName: 'A', now: NOW + 2 });
    const { ws } = fakeWs(VOTER);
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(
      sql, ws, storyEnv('OPEN_VOTING', 'o-nh', { storyId: 's-1' }), broadcast,
    );
    expect((out[0].payload as ErrorPayload).code).toBe('NOT_HOST');
    expect(calls).toEqual([]);
  });
});

describe('dispatcher.handleMessage — VOTE_CAST (R3.ii, anti-anchoring split)', () => {
  function setupActive() {
    const sql = setupRoom();
    addStory(sql, { storyId: 'st-1', text: 'one', now: NOW + 1 });
    openVoting(sql, { storyId: 'st-1', now: NOW + 2 });
    return sql;
  }

  function voteEnv(id: string, payload: object) {
    return JSON.stringify({ v: 1, type: 'VOTE_CAST', id, at: 0, payload });
  }

  it('LEAK TEST: vote_value reaches the caster ONLY; peer DELTA carries presence with no points/confidence', async () => {
    // Real broadcast helper (not a capturing stub) so projection is genuinely exercised on the wire.
    const { broadcast } = await import('../src/broadcast');

    const sql = setupActive();
    addVoter(sql, { voterId: 'v-A', displayName: 'A', now: NOW + 3 });
    addVoter(sql, { voterId: 'v-B', displayName: 'B', now: NOW + 4 });

    const sockA = fakeWs({ voterId: 'v-A', role: 'voter' });
    const sockB = fakeWs({ voterId: 'v-B', role: 'voter' });
    const ctx = {
      getWebSockets: () => [sockA.ws, sockB.ws],
    } as unknown as import('@cloudflare/workers-types').DurableObjectState;

    const realBroadcast: Parameters<typeof handleMessage>[3] = (changes, opts) =>
      broadcast(ctx, changes, opts);

    const out = handleMessage(
      sql, sockA.ws,
      voteEnv('vc-leak', { storyId: 'st-1', points: '8', confidence: 4 }),
      realBroadcast,
    );
    expect(out).toEqual([]);

    // Caster receives the full pair.
    expect(sockA.sent).toHaveLength(1);
    const aEnv = JSON.parse(sockA.sent[0]) as { type: string; payload: { changes: DeltaChange[] } };
    expect(aEnv.type).toBe('DELTA');
    expect(aEnv.payload.changes).toEqual([
      { kind: 'vote_value', storyId: 'st-1', points: '8', confidence: 4 },
      { kind: 'voter_voted', storyId: 'st-1', voterId: 'v-A' },
    ]);

    // Peer receives presence ONLY — strictly no points/confidence anywhere in the payload.
    expect(sockB.sent).toHaveLength(1);
    const bEnv = JSON.parse(sockB.sent[0]) as { type: string; payload: { changes: DeltaChange[] } };
    expect(bEnv.payload.changes).toEqual([
      { kind: 'voter_voted', storyId: 'st-1', voterId: 'v-A' },
    ]);
    const bRaw = sockB.sent[0];
    expect(bRaw).not.toContain('"points"');
    expect(bRaw).not.toContain('"confidence"');
    expect(bRaw).not.toContain('vote_value');
  });

  it('attribution: payload-supplied `voterId` is ignored; vote attributed to the binding', () => {
    const sql = setupActive();
    addVoter(sql, { voterId: 'v-A', displayName: 'A', now: NOW + 3 });
    const { ws } = fakeWs({ voterId: 'v-A', role: 'voter' });
    const { calls, broadcast } = captureBroadcasts();
    const raw = JSON.stringify({
      v: 1, type: 'VOTE_CAST', id: 'vc-spoof', at: 0,
      payload: { storyId: 'st-1', points: '5', confidence: 3, voterId: 'SPOOFED' },
    });
    const out = handleMessage(sql, ws, raw, broadcast);
    expect(out).toEqual([]);
    const row = sql
      .exec<{ voter_id: string }>(`SELECT voter_id FROM vote WHERE story_id = 'st-1'`)
      .toArray()[0];
    expect(row?.voter_id).toBe('v-A');
    expect(calls[0].changes[1]).toEqual({ kind: 'voter_voted', storyId: 'st-1', voterId: 'v-A' });
  });

  it('spectator rejected: ERROR SPECTATOR_CANNOT_VOTE; no vote; no broadcast', () => {
    const sql = setupActive();
    addVoter(sql, { voterId: 'v-spec', displayName: 'Spec', role: 'spectator', now: NOW + 3 });
    const { ws } = fakeWs({ voterId: 'v-spec', role: 'spectator' });
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(
      sql, ws,
      voteEnv('vc-spec', { storyId: 'st-1', points: '5', confidence: 3 }),
      broadcast,
    );
    expect((out[0].payload as ErrorPayload).code).toBe('SPECTATOR_CANNOT_VOTE');
    expect(calls).toEqual([]);
    const rows = sql.exec(`SELECT * FROM vote`).toArray();
    expect(rows).toHaveLength(0);
  });

  it('not-joined: ERROR NOT_JOINED', () => {
    const sql = setupActive();
    const { ws } = fakeWs(); // no attachment
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(
      sql, ws,
      voteEnv('vc-nj', { storyId: 'st-1', points: '5', confidence: 3 }),
      broadcast,
    );
    expect((out[0].payload as ErrorPayload).code).toBe('NOT_JOINED');
    expect(calls).toEqual([]);
  });

  it('story not active: ERROR STORY_NOT_ACTIVE (also covers missing/revealed/pending)', () => {
    const sql = setupRoom();
    addStory(sql, { storyId: 'st-pending', text: 'p', now: NOW + 1 });
    addVoter(sql, { voterId: 'v-A', displayName: 'A', now: NOW + 2 });
    const { ws } = fakeWs({ voterId: 'v-A', role: 'voter' });
    const { calls, broadcast } = captureBroadcasts();
    const out = handleMessage(
      sql, ws,
      voteEnv('vc-na', { storyId: 'st-pending', points: '5', confidence: 3 }),
      broadcast,
    );
    expect((out[0].payload as ErrorPayload).code).toBe('STORY_NOT_ACTIVE');
    expect(calls).toEqual([]);
  });

  it('bad confidence (0 and 6): ERROR INVALID_PAYLOAD; no vote', () => {
    const sql = setupActive();
    addVoter(sql, { voterId: 'v-A', displayName: 'A', now: NOW + 3 });
    const { ws } = fakeWs({ voterId: 'v-A', role: 'voter' });
    const { calls, broadcast } = captureBroadcasts();
    const lo = handleMessage(
      sql, ws, voteEnv('vc-lo', { storyId: 'st-1', points: '5', confidence: 0 }), broadcast,
    );
    const hi = handleMessage(
      sql, ws, voteEnv('vc-hi', { storyId: 'st-1', points: '5', confidence: 6 }), broadcast,
    );
    expect((lo[0].payload as ErrorPayload).code).toBe('INVALID_PAYLOAD');
    expect((hi[0].payload as ErrorPayload).code).toBe('INVALID_PAYLOAD');
    expect(calls).toEqual([]);
    expect(sql.exec(`SELECT * FROM vote`).toArray()).toHaveLength(0);
  });

  it('re-cast (new envelope id): updates same row; submitted_at preserved; second broadcast emitted', () => {
    const sql = setupActive();
    addVoter(sql, { voterId: 'v-A', displayName: 'A', now: NOW + 3 });
    const { ws } = fakeWs({ voterId: 'v-A', role: 'voter' });
    const { calls, broadcast } = captureBroadcasts();
    handleMessage(
      sql, ws, voteEnv('vc-1', { storyId: 'st-1', points: '5', confidence: 3 }), broadcast,
    );
    handleMessage(
      sql, ws, voteEnv('vc-2', { storyId: 'st-1', points: '8', confidence: 4 }), broadcast,
    );
    const rows = sql
      .exec<{ voter_id: string; points: string; confidence: number; submitted_at: number; updated_at: number }>(
        `SELECT * FROM vote WHERE story_id = 'st-1'`,
      ).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].points).toBe('8');
    expect(rows[0].confidence).toBe(4);
    expect(rows[0].updated_at).toBeGreaterThanOrEqual(rows[0].submitted_at);
    expect(calls).toHaveLength(2);
  });

  it('replay (same envelope id): no second broadcast; alreadyProcessed short-circuits', () => {
    const sql = setupActive();
    addVoter(sql, { voterId: 'v-A', displayName: 'A', now: NOW + 3 });
    const { ws } = fakeWs({ voterId: 'v-A', role: 'voter' });
    const { calls, broadcast } = captureBroadcasts();
    const raw = voteEnv('vc-dup', { storyId: 'st-1', points: '5', confidence: 3 });
    handleMessage(sql, ws, raw, broadcast);
    handleMessage(sql, ws, raw, broadcast);
    expect(calls).toHaveLength(1);
    const procRows = sql
      .exec(`SELECT id FROM processed_message WHERE id = 'vc-dup'`).toArray();
    expect(procRows).toHaveLength(1);
  });
});
