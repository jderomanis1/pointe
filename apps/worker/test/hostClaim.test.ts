import { describe, it, expect } from 'vitest';
import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { Envelope, HostReclaimedPayload, ServerMessageType } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import { initSchema } from '../src/schema';
import { addVoter, createRoom, markRoomHostVacant } from '../src/operations';
import { createMockDoState } from './helpers/mockDoState';

const HOST_ID = 'h-1';
const VOTER_B = 'v-b';
const VOTER_C = 'v-c';
const SPEC_ID = 's-1';

type SentEnvelope = { type: ServerMessageType; payload: unknown };

function setupRoom(): { state: DurableObjectState; broadcasts: SentEnvelope[] } {
  const state = createMockDoState();
  initSchema(state.storage.sql);
  createRoom(state.storage.sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 1_000,
  });
  state.storage.sql.exec(`UPDATE room SET state = 'active'`);
  addVoter(state.storage.sql, { voterId: VOTER_B, displayName: 'Ben', now: 2_000 });
  addVoter(state.storage.sql, { voterId: VOTER_C, displayName: 'Cyd', now: 3_000 });
  addVoter(state.storage.sql, { voterId: SPEC_ID, displayName: 'Spec', role: 'spectator', now: 4_000 });
  const broadcasts: SentEnvelope[] = [];
  return { state, broadcasts };
}

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

function callDispatcher(
  state: DurableObjectState,
  ws: WebSocket,
  envelope: Envelope,
  broadcasts: SentEnvelope[],
): Envelope[] {
  return handleMessage(
    state.storage.sql,
    ws,
    JSON.stringify(envelope),
    () => {},
    () => {},
    (type, payload) => broadcasts.push({ type, payload }),
  );
}

function roomState(state: DurableObjectState): { state: string; host_voter_id: string | null } {
  return state.storage.sql
    .exec<{ state: string; host_voter_id: string | null }>(
      'SELECT state, host_voter_id FROM room LIMIT 1',
    ).toArray()[0];
}

function voterRole(state: DurableObjectState, voterId: string): string | null {
  const row = state.storage.sql
    .exec<{ role: string }>('SELECT role FROM voter WHERE id = ?', voterId)
    .toArray()[0];
  return row?.role ?? null;
}

function claim(envId = 'c-claim'): Envelope {
  return { v: 1, type: 'CLAIM_HOST', id: envId, at: 0, payload: {} };
}
function transfer(target: string, envId = 'c-tx'): Envelope {
  return { v: 1, type: 'TRANSFER_HOST', id: envId, at: 0, payload: { newHostVoterId: target } };
}
function join(resumeVoterId: string, envId = 'c-join'): Envelope {
  return {
    v: 1, type: 'JOIN_ROOM', id: envId, at: 0,
    payload: { slug: 'apt-sparrow-16', resumeVoterId, role: 'voter' },
  };
}

// ---- CLAIM_HOST ----

describe('CLAIM_HOST — vacant room', () => {
  it('voter claims a vacant room → becomes host, room active, roles swap, HOST_RECLAIMED via "claim" broadcast', () => {
    const { state, broadcasts } = setupRoom();
    markRoomHostVacant(state.storage.sql, { vacantSince: 9_000 });
    const sock = fakeSock(VOTER_B);

    const replies = callDispatcher(state, sock.ws, claim(), broadcasts);

    expect(roomState(state)).toEqual({ state: 'active', host_voter_id: VOTER_B });
    expect(voterRole(state, VOTER_B)).toBe('host');
    expect(voterRole(state, HOST_ID)).toBe('voter');
    // Exactly-one-host invariant.
    const hosts = state.storage.sql
      .exec<{ id: string }>(`SELECT id FROM voter WHERE role = 'host'`).toArray();
    expect(hosts.map((r) => r.id)).toEqual([VOTER_B]);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].type).toBe('HOST_RECLAIMED');
    expect(broadcasts[0].payload).toEqual({ newHostVoterId: VOTER_B, via: 'claim' });

    // Direct reply to the claimer echoes the env id.
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe('HOST_RECLAIMED');
    expect(replies[0].id).toBe('c-claim');
  });

  it('spectator can claim a vacant room (D1)', () => {
    const { state, broadcasts } = setupRoom();
    markRoomHostVacant(state.storage.sql, { vacantSince: 9_000 });
    const sock = fakeSock(SPEC_ID);

    callDispatcher(state, sock.ws, claim(), broadcasts);

    expect(roomState(state).host_voter_id).toBe(SPEC_ID);
    expect(voterRole(state, SPEC_ID)).toBe('host');
  });

  it('first claim wins; second claim sees state=active → no transition, claimer informed of the real host', () => {
    const { state, broadcasts } = setupRoom();
    markRoomHostVacant(state.storage.sql, { vacantSince: 9_000 });
    const sockB = fakeSock(VOTER_B);
    const sockC = fakeSock(VOTER_C);

    callDispatcher(state, sockB.ws, claim('c-1'), broadcasts);
    const cReplies = callDispatcher(state, sockC.ws, claim('c-2'), broadcasts);

    // B won.
    expect(roomState(state)).toEqual({ state: 'active', host_voter_id: VOTER_B });
    expect(voterRole(state, VOTER_C)).toBe('voter');

    // Second claim got no broadcast — only the winning claim broadcasts.
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].payload).toEqual({ newHostVoterId: VOTER_B, via: 'claim' });

    // Direct reply to C tells them who the host actually is.
    expect(cReplies).toHaveLength(1);
    expect(cReplies[0].type).toBe('HOST_RECLAIMED');
    expect((cReplies[0].payload as HostReclaimedPayload).newHostVoterId).toBe(VOTER_B);
  });

  it('CLAIM_HOST on a NON-vacant active room → no transition; HOST_RECLAIMED direct-reply names current host', () => {
    const { state, broadcasts } = setupRoom();
    const sock = fakeSock(VOTER_B);
    const replies = callDispatcher(state, sock.ws, claim(), broadcasts);
    expect(roomState(state).host_voter_id).toBe(HOST_ID);
    expect(broadcasts).toHaveLength(0);
    expect(replies[0].type).toBe('HOST_RECLAIMED');
    expect((replies[0].payload as HostReclaimedPayload).newHostVoterId).toBe(HOST_ID);
  });

  it('CLAIM_HOST without JOIN first → NOT_JOINED error', () => {
    const { state, broadcasts } = setupRoom();
    markRoomHostVacant(state.storage.sql, { vacantSince: 9_000 });
    const sock = fakeSock(null);
    const replies = callDispatcher(state, sock.ws, claim(), broadcasts);
    expect(replies[0].type).toBe('ERROR');
    expect((replies[0].payload as { code: string }).code).toBe('NOT_JOINED');
    expect(broadcasts).toHaveLength(0);
  });
});

// ---- TRANSFER_HOST ----

describe('TRANSFER_HOST — by host', () => {
  it("host transfers to a connected voter → target is host, old host is voter, HOST_RECLAIMED via 'transfer' broadcast", () => {
    const { state, broadcasts } = setupRoom();
    const sock = fakeSock(HOST_ID);
    const replies = callDispatcher(state, sock.ws, transfer(VOTER_B), broadcasts);

    expect(roomState(state).host_voter_id).toBe(VOTER_B);
    expect(voterRole(state, VOTER_B)).toBe('host');
    expect(voterRole(state, HOST_ID)).toBe('voter');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].payload).toEqual({ newHostVoterId: VOTER_B, via: 'transfer' });
    expect(replies[0].type).toBe('HOST_RECLAIMED');
  });

  it('non-host sender → NOT_HOST (SI-02), no change', () => {
    const { state, broadcasts } = setupRoom();
    const sock = fakeSock(VOTER_B);
    const replies = callDispatcher(state, sock.ws, transfer(VOTER_C), broadcasts);
    expect(replies[0].type).toBe('ERROR');
    expect((replies[0].payload as { code: string }).code).toBe('NOT_HOST');
    expect(roomState(state).host_voter_id).toBe(HOST_ID);
    expect(broadcasts).toHaveLength(0);
  });

  it('transfer to a voter who is "left" → INVALID_TARGET', () => {
    const { state, broadcasts } = setupRoom();
    state.storage.sql.exec(`UPDATE voter SET connection_state = 'left' WHERE id = ?`, VOTER_B);
    const sock = fakeSock(HOST_ID);
    const replies = callDispatcher(state, sock.ws, transfer(VOTER_B), broadcasts);
    expect(replies[0].type).toBe('ERROR');
    expect((replies[0].payload as { code: string }).code).toBe('INVALID_TARGET');
    expect(roomState(state).host_voter_id).toBe(HOST_ID);
  });

  it('transfer to an unknown voterId → INVALID_TARGET', () => {
    const { state, broadcasts } = setupRoom();
    const sock = fakeSock(HOST_ID);
    const replies = callDispatcher(state, sock.ws, transfer('nobody'), broadcasts);
    expect(replies[0].type).toBe('ERROR');
    expect((replies[0].payload as { code: string }).code).toBe('INVALID_TARGET');
  });

  it('transfer to self → INVALID_TARGET', () => {
    const { state, broadcasts } = setupRoom();
    const sock = fakeSock(HOST_ID);
    const replies = callDispatcher(state, sock.ws, transfer(HOST_ID), broadcasts);
    expect(replies[0].type).toBe('ERROR');
    expect((replies[0].payload as { code: string }).code).toBe('INVALID_TARGET');
  });
});

// ---- Reconnect cases (D2) ----

describe('host reconnect — D2', () => {
  it('original host JOINs while still vacant → auto-reclaim, HOST_RECLAIMED via "reconnect"', () => {
    const { state, broadcasts } = setupRoom();
    markRoomHostVacant(state.storage.sql, { vacantSince: 9_000 });
    const sock = fakeSock(null);
    let attachment: unknown = null;
    (sock.ws as unknown as { serializeAttachment(v: unknown): void }).serializeAttachment = (v) => { attachment = v; };
    (sock.ws as unknown as { deserializeAttachment(): unknown }).deserializeAttachment = () => attachment;

    callDispatcher(state, sock.ws, join(HOST_ID), broadcasts);

    expect(roomState(state)).toEqual({ state: 'active', host_voter_id: HOST_ID });
    expect(voterRole(state, HOST_ID)).toBe('host');
    const reclaimed = broadcasts.find((b) => b.type === 'HOST_RECLAIMED');
    expect(reclaimed).toBeDefined();
    expect(reclaimed!.payload).toEqual({ newHostVoterId: HOST_ID, via: 'reconnect' });
  });

  it('ex-host JOINs AFTER someone claimed → no reclaim, no broadcast, role stays voter', () => {
    const { state, broadcasts } = setupRoom();
    markRoomHostVacant(state.storage.sql, { vacantSince: 9_000 });
    // B claims first.
    const sockB = fakeSock(VOTER_B);
    callDispatcher(state, sockB.ws, claim('c-1'), broadcasts);
    expect(broadcasts).toHaveLength(1);
    expect(voterRole(state, HOST_ID)).toBe('voter');

    // Now the original host reconnects.
    const sockA = fakeSock(null);
    let attachment: unknown = null;
    (sockA.ws as unknown as { serializeAttachment(v: unknown): void }).serializeAttachment = (v) => { attachment = v; };
    (sockA.ws as unknown as { deserializeAttachment(): unknown }).deserializeAttachment = () => attachment;
    callDispatcher(state, sockA.ws, join(HOST_ID), broadcasts);

    // Host stays B; A rejoins as voter.
    expect(roomState(state).host_voter_id).toBe(VOTER_B);
    expect(voterRole(state, HOST_ID)).toBe('voter');
    // No second HOST_RECLAIMED — just the original claim's broadcast.
    expect(broadcasts.filter((b) => b.type === 'HOST_RECLAIMED')).toHaveLength(1);
  });
});

// ---- Exactly-one-host invariant under churn ----

describe('exactly-one-host invariant', () => {
  it('holds across claim → transfer → reclaim chain', () => {
    const { state, broadcasts } = setupRoom();
    markRoomHostVacant(state.storage.sql, { vacantSince: 9_000 });

    const sockB = fakeSock(VOTER_B);
    callDispatcher(state, sockB.ws, claim('c-1'), broadcasts); // B host
    const sockBHost = fakeSock(VOTER_B);
    callDispatcher(state, sockBHost.ws, transfer(VOTER_C, 'c-2'), broadcasts); // C host

    const hosts = state.storage.sql
      .exec<{ id: string }>(`SELECT id FROM voter WHERE role = 'host'`).toArray();
    expect(hosts.map((r) => r.id)).toEqual([VOTER_C]);
    expect(voterRole(state, VOTER_B)).toBe('voter');
    expect(voterRole(state, HOST_ID)).toBe('voter');
  });
});
