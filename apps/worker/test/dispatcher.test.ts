import { describe, it, expect } from 'vitest';
import { handleMessage } from '../src/dispatcher';
import { initSchema } from '../src/schema';
import {
  createRoom, addStory, openVoting, castVote, revealVotes, addVoter,
} from '../src/operations';
import { createMockDoState } from './helpers/mockDoState';
import type { ErrorPayload, RoomSnapshot } from '@pointe/shared';

const NOW = 1_700_000_000_000;

// --- Mock WebSocket ---
// Records serializeAttachment / send; deserializeAttachment returns the last serialized value.
function fakeWs() {
  let attachment: unknown = undefined;
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
    const out = handleMessage(sql, ws, env('VOTE_CAST', 'vc-1'));
    expect((out[0].payload as ErrorPayload).code).toBe('NOT_IMPLEMENTED');
    expect(out[0].id).toBe('vc-1');
  });

  it('idempotency: replay records one row in processed_message', () => {
    const sql = setupRoom();
    const { ws } = fakeWs();
    handleMessage(sql, ws, env('RECONNECT_PING', 'dup'));
    handleMessage(sql, ws, env('RECONNECT_PING', 'dup'));
    const rows = sql.exec<{ id: string }>(`SELECT id FROM processed_message WHERE id = 'dup'`).toArray();
    expect(rows).toHaveLength(1);
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
