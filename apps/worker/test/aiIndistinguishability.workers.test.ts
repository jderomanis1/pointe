/**
 * S8.v — AA-1 indistinguishability capstone.
 *
 * The conjunction. Every prior AA-1 test proved one channel in isolation:
 *   • the reveal change is byte-identical for the voter (S8.ii.c1),
 *   • the AI completion sends the voter no traffic (S8.iii.c1),
 *   • the snapshot serializer strips `ai` for the voter (S8.i.b),
 *   • AI_SHARED is the only path that crosses `ai` to a non-host (S8.ii.c2).
 *
 * This file proves the conjunction. The same scripted session is run three
 * times, identical in every input except the AI action:
 *
 *   Timeline N — no AI ever requested.
 *   Timeline U — host requests AI on a story (it completes), never shares.
 *   Timeline S — host requests AI and shares it at reveal.
 *
 * For each run we capture the non-host voter's complete, ordered stream of
 * received envelopes from JOIN onward, then:
 *
 *   • CAPSTONE  — normalize(N) deep-equals normalize(U). The voter's entire
 *     observable experience is identical whether the host privately consulted
 *     AI or not.
 *   • VALIDITY — normalize(S) differs from normalize(U) by exactly one
 *     inserted AI_SHARED envelope. The byte-equality has teeth: it can detect
 *     an AI-correlated difference, and the ONLY thing that produces one is a
 *     deliberate share.
 *
 * Normalization (see `normalize`) canonicalizes ONLY values that vary
 * non-deterministically across runs of the same script: envelope `id` /
 * `at`, the closed set of timestamp fields in payloads, and any UUID-shaped
 * string (the server-minted storyId, which we never see at fixture-time).
 * It NEVER touches envelope `type`, the set of envelopes, their order, or
 * their kinds. A guard test (`normalize is idempotent + leaves type alone`)
 * locks that contract — if the normalizer ever silently laundered a leak,
 * that test would tell us.
 *
 * Determinism vs normalization: workerd has no clean injection points for
 * Date.now / crypto.randomUUID, but the surface that varies is narrow and
 * the slice prescribes normalization. Fixtures pin every deterministic id
 * (roomId, voterIds, slug). Only the storyId (dispatcher-minted) and the
 * envelope-level fields actually vary; the normalizer maps them positionally
 * by order of first appearance.
 */
import { describe, it, expect } from 'vitest';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type {
  AISuggestion, Envelope, ServerMessageType,
} from '@pointe/shared';
import { handleMessage, type AiOrchestrator } from '../src/dispatcher';
import { broadcast, broadcastEnvelope } from '../src/broadcast';
import {
  addVoter, createRoom, getHostVoterId, getRoomState,
} from '../src/operations';
import { putAiCache, type AiPayloadJson } from '../src/ai';
import { withRoom } from './helpers/pool';

// ---- Fixtures --------------------------------------------------------------

const ROOM_ID = 'r-1';
const SLUG = 'apt-sparrow-16';
const HOST = 'host-1';
const VOTER = 'v-1';   // observed
const VOTER2 = 'v-2';  // second voter — needed for a non-degenerate reveal
const NOW = 1_700_000_000_000;

const FIXTURE_PAYLOAD: AiPayloadJson = {
  complexity: { level: 'medium', note: 'c' },
  effort: { level: 'low', note: 'e' },
  risk: { level: 'low', note: 'r' },
  unknowns: { level: 'low', note: 'u' },
  suggestedRange: { low: '3', high: '5' },
  rationale: 'because',
};

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
 * The AI orchestrator mock. Identical to the one used by the aiHandler tests
 * (S8.iii.c1) — synchronous, resolves the simulated async call inline so the
 * dispatcher's `sendToHost` paths complete before the next script step.
 *
 * AA-1: `sendToHost` filters by the host's voterId. A voter socket attached
 * to this same orchestrator will never see any envelope it emits.
 */
function makeOrch(opts: {
  sql: SqlStorage;
  hostId: string;
  sockets: { ws: WebSocket; sent: string[] }[];
}): AiOrchestrator {
  const orch: AiOrchestrator = {
    available: true,
    sendToHost: (type, payload) => {
      const env = { v: 1, type, id: 'srv-' + type, at: 0, payload } as Envelope;
      const raw = JSON.stringify(env);
      for (const s of opts.sockets) {
        const att = s.ws.deserializeAttachment() as { voterId: string } | null;
        if (att?.voterId === opts.hostId) s.ws.send(raw);
      }
    },
    scheduleAiCall: (p) => {
      const now = Date.now();
      opts.sql.exec(
        `INSERT INTO ai_suggestion (story_id, state, payload, error_message, requested_at, completed_at, shared, shared_at)
         VALUES (?, 'ready', ?, NULL, ?, ?, 0, NULL)
         ON CONFLICT(story_id) DO UPDATE SET state='ready', payload=excluded.payload, error_message=NULL, completed_at=excluded.completed_at, shared=0`,
        p.storyId, JSON.stringify(FIXTURE_PAYLOAD), p.requestedAt, now,
      );
      putAiCache(opts.sql, { cacheKey: p.cacheKey, payload: FIXTURE_PAYLOAD, now });
      orch.sendToHost('STORY_AI_READY', { storyId: p.storyId });
      const ready: AISuggestion = {
        state: 'ready',
        complexity: FIXTURE_PAYLOAD.complexity,
        effort: FIXTURE_PAYLOAD.effort,
        risk: FIXTURE_PAYLOAD.risk,
        unknowns: FIXTURE_PAYLOAD.unknowns,
        suggestedRange: FIXTURE_PAYLOAD.suggestedRange,
        rationale: FIXTURE_PAYLOAD.rationale,
        shared: false,
      };
      orch.sendToHost('DELTA', { changes: [{ kind: 'ai_updated', storyId: p.storyId, ai: ready }] });
    },
  };
  return orch;
}

// ---- The normalizer --------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_KEYS = new Set([
  'at',                                                          // envelope clock
  'createdAt', 'lastActivityAt',                                  // room
  'lastSeenAt', 'joinedAt',                                       // voter
  'openedAt', 'revealedAt',                                       // story
  'submittedAt', 'updatedAt',                                     // vote
  'requestedAt', 'completedAt', 'sharedAt',                       // ai bookkeeping
  'hostVacantSince',                                              // host vacancy
]);

/**
 * Canonicalize a captured envelope stream so two runs of the same script can
 * be compared. The contract is narrow on purpose:
 *
 *   • Replaces every UUID-shaped string with a positional token
 *     `UUID_n` minted in ORDER OF FIRST APPEARANCE across the stream. The
 *     server-minted storyId is the load-bearing case here; envelope.id is
 *     also a UUID (DELTA broadcasts mint a fresh one per fan-out).
 *   • Replaces values at known timestamp keys with 0 (closed set).
 *   • Walks objects + arrays recursively, preserving structure exactly.
 *
 * Does NOT:
 *   • touch envelope.type or any DeltaChange.kind discriminant,
 *   • dedupe, reorder, or drop envelopes,
 *   • collapse counts (the array is rebuilt 1:1 with the input),
 *   • map non-UUID strings (the slug, displayName, points, level words,
 *     median, error messages, etc. all pass through).
 *
 * The guard test below asserts these properties on a real stream so the
 * normalizer itself cannot silently launder a leak.
 */
function normalize(envelopes: Envelope[]): unknown[] {
  const idMap = new Map<string, string>();
  let nextToken = 0;
  function tok(uuid: string): string {
    const existing = idMap.get(uuid);
    if (existing) return existing;
    nextToken += 1;
    const t = `UUID_${nextToken}`;
    idMap.set(uuid, t);
    return t;
  }
  function walk(value: unknown, key?: string): unknown {
    if (typeof value === 'string') {
      return UUID_RE.test(value) ? tok(value) : value;
    }
    if (typeof value === 'number') {
      return key !== undefined && TIMESTAMP_KEYS.has(key) ? 0 : value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v));
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    return value;
  }
  return envelopes.map((env) => walk(env));
}

// ---- The scripted session --------------------------------------------------

type TimelineOpts = { requestAi: boolean; share: boolean };

async function runTimeline(opts: TimelineOpts): Promise<{
  voterStream: Envelope[];
  rest: { state: string; deck: string };
}> {
  return await withRoom((sql) => {
    // Seed the room with deterministic fixtures.
    createRoom(sql, {
      roomId: ROOM_ID, slug: SLUG, hostVoterId: HOST,
      hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: NOW,
    });
    addVoter(sql, { voterId: VOTER, displayName: 'Ben', now: NOW });
    addVoter(sql, { voterId: VOTER2, displayName: 'Cleo', now: NOW });

    const sockHost = fakeWs({ voterId: HOST, role: 'host' });
    const sockVoter = fakeWs({ voterId: VOTER, role: 'voter' });
    const sockVoter2 = fakeWs({ voterId: VOTER2, role: 'voter' });
    const sockets = [sockHost, sockVoter, sockVoter2];
    const ctx = {
      getWebSockets: () => sockets.map((s) => s.ws),
    } as unknown as DurableObjectState;

    const broadcastFn = (changes: Parameters<typeof broadcast>[1], o?: { excludeWs?: WebSocket }) =>
      broadcast(ctx, changes, getHostVoterId(sql), o);
    const broadcastEnvFn = (type: ServerMessageType, payload: unknown) => {
      broadcastEnvelope(ctx, type, payload);
    };
    const orch = makeOrch({ sql, hostId: HOST, sockets });

    const drive = (sock: { ws: WebSocket; sent: string[] }, envRaw: string) => {
      const replies = handleMessage(
        sql, sock.ws, envRaw,
        broadcastFn, undefined, broadcastEnvFn, orch,
      );
      for (const env of replies) sock.sent.push(JSON.stringify(env));
    };

    const env = (type: string, id: string, payload: unknown) =>
      JSON.stringify({ v: 1, type, id, at: 0, payload });

    // 1. Voter joins. Server replies SNAPSHOT_RESPONSE direct to the voter.
    drive(sockVoter, env('JOIN_ROOM', 'j-1', {
      slug: SLUG, resumeVoterId: VOTER, role: 'voter',
    }));

    // 2. Host adds the story. Server mints the storyId via crypto.randomUUID
    //    — the normalizer maps it positionally. Voter sees `story_added`.
    drive(sockHost, env('ADD_STORY', 'a-1', { text: 'Reset password' }));
    const storyId = sql.exec<{ id: string }>('SELECT id FROM story').toArray()[0].id;

    // 3. Host opens voting on the new story.
    drive(sockHost, env('OPEN_VOTING', 'o-1', { storyId }));

    // 4. (U, S) Host requests AI. The mocked orchestrator settles synchronously
    //    and sends the host TWO envelopes (STORY_AI_READY + DELTA with
    //    ai_updated). Both are sendToHost-filtered — the voter sees NOTHING.
    if (opts.requestAi) {
      drive(sockHost, env('REQUEST_AI', 'r-1', { storyId }));
    }

    // 5. Voter votes; voter2 votes. The voter sees their own vote_value
    //    plus presence (voter_voted) for both; vote_value for voter2 is
    //    projected out (caster-only) by `projectChangesFor`.
    drive(sockVoter, env('VOTE_CAST', 'vc-1', { storyId, points: '5', confidence: 4 }));
    drive(sockVoter2, env('VOTE_CAST', 'vc-2', { storyId, points: '8', confidence: 3 }));

    // 6. Host reveals. votes_revealed change carries `ai` only when set on
    //    the source; projectChangesFor strips it for non-hosts (S8.ii.c1).
    drive(sockHost, env('REVEAL_VOTES', 'rv-1', { storyId }));

    // 7. (S only) Host shares. AI_SHARED is the only path that crosses ai
    //    to a non-host. Broadcast via broadcastEnvelope (no projection).
    if (opts.share) {
      drive(sockHost, env('SHARE_AI', 'sh-1', { storyId }));
    }

    // 8. Host commits.
    drive(sockHost, env('COMMIT_STORY', 'cs-1', { storyId, finalEstimate: '5' }));

    // The REST bootstrap projection: GET /api/rooms/:slug returns just
    // { state, deck } — AI-independent by construction. Read the same
    // fields the worker would derive from this room and return.
    const state = getRoomState(sql);
    const rest = { state: state.room.state, deck: state.room.deck };

    const voterStream = sockVoter.sent.map((s) => JSON.parse(s) as Envelope);
    return { voterStream, rest };
  });
}

// ---- Tests ----------------------------------------------------------------

describe('S8.v — AA-1 indistinguishability capstone', () => {
  it('CAPSTONE: normalize(N) deep-equals normalize(U) — the voter\'s full stream is identical whether AI was privately consulted or not', async () => {
    const N = await runTimeline({ requestAi: false, share: false });
    const U = await runTimeline({ requestAi: true,  share: false });

    const normN = normalize(N.voterStream);
    const normU = normalize(U.voterStream);

    expect(normN).toEqual(normU);
  });

  it('VALIDITY: normalize(S) differs from normalize(U) by EXACTLY one inserted AI_SHARED envelope — every other envelope identical in type, order, content', async () => {
    const U = await runTimeline({ requestAi: true, share: false });
    const S = await runTimeline({ requestAi: true, share: true  });

    const sharedEnvs = S.voterStream.filter((e) => e.type === 'AI_SHARED');
    expect(sharedEnvs).toHaveLength(1); // exactly one
    expect(S.voterStream.length).toBe(U.voterStream.length + 1); // exactly one more envelope

    const sMinusShared = S.voterStream.filter((e) => e.type !== 'AI_SHARED');
    expect(normalize(sMinusShared)).toEqual(normalize(U.voterStream));

    // And direct comparison without removal must FAIL — the capstone would
    // be vacuous otherwise (a normalizer that smooshes any AI signal out
    // would pass N === U trivially).
    expect(normalize(S.voterStream)).not.toEqual(normalize(U.voterStream));
  });

  it('REST bootstrap (GET /api/rooms/:slug) is AI-independent: { state, deck } identical across N and U', async () => {
    const N = await runTimeline({ requestAi: false, share: false });
    const U = await runTimeline({ requestAi: true,  share: false });
    expect(N.rest).toEqual(U.rest);
    expect(N.rest).toEqual({ state: 'lobby', deck: 'fibonacci' });
  });
});

// ---- Guard: the normalizer itself ----------------------------------------

describe('S8.v — normalizer guard (so the capstone can\'t be vacuous)', () => {
  it('is idempotent on a real captured stream', async () => {
    const N = await runTimeline({ requestAi: false, share: false });
    const once = normalize(N.voterStream);
    const twice = normalize(JSON.parse(JSON.stringify(once)) as Envelope[]);
    // A non-UUID string (UUID_n token) does not match UUID_RE; values stay put.
    // Timestamp keys are already 0; re-normalizing leaves them at 0.
    expect(twice).toEqual(once);
  });

  it('never touches envelope.type or DeltaChange.kind across a real stream', async () => {
    const N = await runTimeline({ requestAi: false, share: false });
    const types = N.voterStream.map((e) => e.type);
    const kinds = N.voterStream
      .filter((e) => e.type === 'DELTA')
      .flatMap((e) => (e.payload as { changes: { kind: string }[] }).changes.map((c) => c.kind));

    const norm = normalize(N.voterStream) as Envelope[];
    const normTypes = norm.map((e) => e.type);
    const normKinds = norm
      .filter((e) => e.type === 'DELTA')
      .flatMap((e) => (e.payload as { changes: { kind: string }[] }).changes.map((c) => c.kind));

    expect(normTypes).toEqual(types);
    expect(normKinds).toEqual(kinds);
  });

  it('preserves envelope count + order (it never drops or reorders envelopes)', async () => {
    const N = await runTimeline({ requestAi: false, share: false });
    const norm = normalize(N.voterStream) as Envelope[];
    expect(norm).toHaveLength(N.voterStream.length);
    // Type sequence identical to input — order preserved.
    expect(norm.map((e) => e.type)).toEqual(N.voterStream.map((e) => e.type));
  });

  it('does NOT normalize non-UUID strings (slug, points, level words, deck name)', () => {
    // A synthetic envelope containing all the strings we rely on staying intact.
    const env: Envelope = {
      v: 1,
      type: 'SNAPSHOT_RESPONSE',
      id: 'j-1', // echoed client id — non-UUID
      at: 1_780_000_000_000,
      payload: {
        room: { id: 'r-1', slug: 'apt-sparrow-16', deck: 'fibonacci' },
        you: { voterId: 'v-1', role: 'voter' },
        someStats: { median: '5', avgConfidence: 3.5 },
        nestedKind: { kind: 'voter_voted' },
      },
    };
    const [out] = normalize([env]) as Envelope[];
    const p = out.payload as Record<string, Record<string, unknown>>;
    expect(out.id).toBe('j-1');
    expect(p.room.slug).toBe('apt-sparrow-16');
    expect(p.room.deck).toBe('fibonacci');
    expect(p.room.id).toBe('r-1');
    expect(p.you.voterId).toBe('v-1');
    expect(p.someStats.median).toBe('5');
    expect(p.someStats.avgConfidence).toBe(3.5);
    expect(p.nestedKind.kind).toBe('voter_voted');
    // The single timestamp field WAS canonicalized.
    expect(out.at).toBe(0);
  });

  it('maps a UUID to UUID_1 the first time it sees it (positional, by order of first appearance)', () => {
    const u1 = '00000000-0000-4000-8000-000000000001';
    const u2 = '00000000-0000-4000-8000-000000000002';
    const envs: Envelope[] = [
      { v: 1, type: 'DELTA', id: u1, at: 0, payload: { changes: [{ kind: 'voting_opened', storyId: u2 }] } },
      { v: 1, type: 'DELTA', id: u1, at: 0, payload: { changes: [{ kind: 'voting_opened', storyId: u2 }] } },
    ];
    const out = normalize(envs) as Envelope[];
    expect(out[0].id).toBe('UUID_1'); // first uuid seen
    expect((out[0].payload as { changes: { storyId: string }[] }).changes[0].storyId).toBe('UUID_2');
    // The SAME uuid appearing later gets the SAME token (stable mapping).
    expect(out[1].id).toBe('UUID_1');
    expect((out[1].payload as { changes: { storyId: string }[] }).changes[0].storyId).toBe('UUID_2');
  });
});
