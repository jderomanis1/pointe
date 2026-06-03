import { describe, it, expect } from 'vitest';
import type { WebSocket } from '@cloudflare/workers-types';
import type { Envelope, HostReclaimedPayload, ServerMessageType } from '@pointe/shared';
import { handleMessage } from '../src/dispatcher';
import { addVoter, createRoom, markRoomHostVacant } from '../src/operations';
import { withRoom } from './helpers/pool';

const HOST_ID = 'h-1';
const VOTER_B = 'v-b';
const VOTER_C = 'v-c';
const SPEC_ID = 's-1';

type SentEnvelope = { type: ServerMessageType; payload: unknown };

function seedRoom(sql: SqlStorage): void {
  createRoom(sql, {
    roomId: 'r-1', slug: 'apt-sparrow-16', hostVoterId: HOST_ID,
    hostDisplayName: 'Alice', deck: 'fibonacci', mode: 'sync', now: 1_000,
  });
  sql.exec(`UPDATE room SET state = 'active'`);
  addVoter(sql, { voterId: VOTER_B, displayName: 'Ben', now: 2_000 });
  addVoter(sql, { voterId: VOTER_C, displayName: 'Cyd', now: 3_000 });
  addVoter(sql, { voterId: SPEC_ID, displayName: 'Spec', role: 'spectator', now: 4_000 });
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
  sql: SqlStorage,
  ws: WebSocket,
  envelope: Envelope,
  broadcasts: SentEnvelope[],
): Envelope[] {
  return handleMessage(
    sql,
    ws,
    JSON.stringify(envelope),
    () => {},
    () => {},
    (type, payload) => broadcasts.push({ type, payload }),
  );
}

function roomState(sql: SqlStorage): { state: string; host_voter_id: string | null } {
  return sql
    .exec<{ state: string; host_voter_id: string | null }>(
      'SELECT state, host_voter_id FROM room LIMIT 1',
    ).toArray()[0];
}

function voterRole(sql: SqlStorage, voterId: string): string | null {
  const row = sql
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

describe('CLAIM_HOST — vacant room (real DO SQLite)', () => {
  it('voter claims a vacant room → becomes host, room active, roles swap, HOST_RECLAIMED via "claim" broadcast', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      markRoomHostVacant(sql, { vacantSince: 9_000 });
      const sock = fakeSock(VOTER_B);

      const replies = callDispatcher(sql, sock.ws, claim(), broadcasts);

      expect(roomState(sql)).toEqual({ state: 'active', host_voter_id: VOTER_B });
      expect(voterRole(sql, VOTER_B)).toBe('host');
      expect(voterRole(sql, HOST_ID)).toBe('voter');
      const hosts = sql
        .exec<{ id: string }>(`SELECT id FROM voter WHERE role = 'host'`).toArray();
      expect(hosts.map((r) => r.id)).toEqual([VOTER_B]);

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].type).toBe('HOST_RECLAIMED');
      expect(broadcasts[0].payload).toEqual({ newHostVoterId: VOTER_B, via: 'claim' });

      expect(replies).toHaveLength(1);
      expect(replies[0].type).toBe('HOST_RECLAIMED');
      expect(replies[0].id).toBe('c-claim');
    });
  });

  it('spectator can claim a vacant room (D1)', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      markRoomHostVacant(sql, { vacantSince: 9_000 });
      const sock = fakeSock(SPEC_ID);

      callDispatcher(sql, sock.ws, claim(), broadcasts);

      expect(roomState(sql).host_voter_id).toBe(SPEC_ID);
      expect(voterRole(sql, SPEC_ID)).toBe('host');
    });
  });

  it('first claim wins; second claim sees state=active → no transition, claimer informed of the real host', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      markRoomHostVacant(sql, { vacantSince: 9_000 });
      const sockB = fakeSock(VOTER_B);
      const sockC = fakeSock(VOTER_C);

      callDispatcher(sql, sockB.ws, claim('c-1'), broadcasts);
      const cReplies = callDispatcher(sql, sockC.ws, claim('c-2'), broadcasts);

      expect(roomState(sql)).toEqual({ state: 'active', host_voter_id: VOTER_B });
      expect(voterRole(sql, VOTER_C)).toBe('voter');

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].payload).toEqual({ newHostVoterId: VOTER_B, via: 'claim' });

      expect(cReplies).toHaveLength(1);
      expect(cReplies[0].type).toBe('HOST_RECLAIMED');
      expect((cReplies[0].payload as HostReclaimedPayload).newHostVoterId).toBe(VOTER_B);
    });
  });

  it('CLAIM_HOST on a NON-vacant active room → no transition; HOST_RECLAIMED direct-reply names current host', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      const sock = fakeSock(VOTER_B);
      const replies = callDispatcher(sql, sock.ws, claim(), broadcasts);
      expect(roomState(sql).host_voter_id).toBe(HOST_ID);
      expect(broadcasts).toHaveLength(0);
      expect(replies[0].type).toBe('HOST_RECLAIMED');
      expect((replies[0].payload as HostReclaimedPayload).newHostVoterId).toBe(HOST_ID);
    });
  });

  it('CLAIM_HOST without JOIN first → NOT_JOINED error', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      markRoomHostVacant(sql, { vacantSince: 9_000 });
      const sock = fakeSock(null);
      const replies = callDispatcher(sql, sock.ws, claim(), broadcasts);
      expect(replies[0].type).toBe('ERROR');
      expect((replies[0].payload as { code: string }).code).toBe('NOT_JOINED');
      expect(broadcasts).toHaveLength(0);
    });
  });
});

describe('TRANSFER_HOST — by host (real DO SQLite)', () => {
  it("host transfers to a connected voter → target is host, old host is voter, HOST_RECLAIMED via 'transfer' broadcast", async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      const sock = fakeSock(HOST_ID);
      const replies = callDispatcher(sql, sock.ws, transfer(VOTER_B), broadcasts);

      expect(roomState(sql).host_voter_id).toBe(VOTER_B);
      expect(voterRole(sql, VOTER_B)).toBe('host');
      expect(voterRole(sql, HOST_ID)).toBe('voter');
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].payload).toEqual({ newHostVoterId: VOTER_B, via: 'transfer' });
      expect(replies[0].type).toBe('HOST_RECLAIMED');
    });
  });

  it('non-host sender → NOT_HOST (SI-02), no change', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      const sock = fakeSock(VOTER_B);
      const replies = callDispatcher(sql, sock.ws, transfer(VOTER_C), broadcasts);
      expect(replies[0].type).toBe('ERROR');
      expect((replies[0].payload as { code: string }).code).toBe('NOT_HOST');
      expect(roomState(sql).host_voter_id).toBe(HOST_ID);
      expect(broadcasts).toHaveLength(0);
    });
  });

  it('transfer to a voter who is "left" → INVALID_TARGET', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      sql.exec(`UPDATE voter SET connection_state = 'left' WHERE id = ?`, VOTER_B);
      const sock = fakeSock(HOST_ID);
      const replies = callDispatcher(sql, sock.ws, transfer(VOTER_B), broadcasts);
      expect(replies[0].type).toBe('ERROR');
      expect((replies[0].payload as { code: string }).code).toBe('INVALID_TARGET');
      expect(roomState(sql).host_voter_id).toBe(HOST_ID);
    });
  });

  it('transfer to an unknown voterId → INVALID_TARGET', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      const sock = fakeSock(HOST_ID);
      const replies = callDispatcher(sql, sock.ws, transfer('nobody'), broadcasts);
      expect(replies[0].type).toBe('ERROR');
      expect((replies[0].payload as { code: string }).code).toBe('INVALID_TARGET');
    });
  });

  it('transfer to self → INVALID_TARGET', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      const sock = fakeSock(HOST_ID);
      const replies = callDispatcher(sql, sock.ws, transfer(HOST_ID), broadcasts);
      expect(replies[0].type).toBe('ERROR');
      expect((replies[0].payload as { code: string }).code).toBe('INVALID_TARGET');
    });
  });
});

describe('host reconnect — D2 (real DO SQLite)', () => {
  it('original host JOINs while still vacant → auto-reclaim, HOST_RECLAIMED via "reconnect"', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      markRoomHostVacant(sql, { vacantSince: 9_000 });
      const sock = fakeSock(null);
      let attachment: unknown = null;
      (sock.ws as unknown as { serializeAttachment(v: unknown): void }).serializeAttachment = (v) => { attachment = v; };
      (sock.ws as unknown as { deserializeAttachment(): unknown }).deserializeAttachment = () => attachment;

      callDispatcher(sql, sock.ws, join(HOST_ID), broadcasts);

      expect(roomState(sql)).toEqual({ state: 'active', host_voter_id: HOST_ID });
      expect(voterRole(sql, HOST_ID)).toBe('host');
      const reclaimed = broadcasts.find((b) => b.type === 'HOST_RECLAIMED');
      expect(reclaimed).toBeDefined();
      expect(reclaimed!.payload).toEqual({ newHostVoterId: HOST_ID, via: 'reconnect' });
    });
  });

  it('ex-host JOINs AFTER someone claimed → no reclaim, no broadcast, role stays voter', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      markRoomHostVacant(sql, { vacantSince: 9_000 });
      const sockB = fakeSock(VOTER_B);
      callDispatcher(sql, sockB.ws, claim('c-1'), broadcasts);
      expect(broadcasts).toHaveLength(1);
      expect(voterRole(sql, HOST_ID)).toBe('voter');

      const sockA = fakeSock(null);
      let attachment: unknown = null;
      (sockA.ws as unknown as { serializeAttachment(v: unknown): void }).serializeAttachment = (v) => { attachment = v; };
      (sockA.ws as unknown as { deserializeAttachment(): unknown }).deserializeAttachment = () => attachment;
      callDispatcher(sql, sockA.ws, join(HOST_ID), broadcasts);

      expect(roomState(sql).host_voter_id).toBe(VOTER_B);
      expect(voterRole(sql, HOST_ID)).toBe('voter');
      expect(broadcasts.filter((b) => b.type === 'HOST_RECLAIMED')).toHaveLength(1);
    });
  });
});

describe('exactly-one-host invariant (real DO SQLite)', () => {
  it('holds across claim → transfer → reclaim chain', async () => {
    await withRoom((sql) => {
      seedRoom(sql);
      const broadcasts: SentEnvelope[] = [];
      markRoomHostVacant(sql, { vacantSince: 9_000 });

      const sockB = fakeSock(VOTER_B);
      callDispatcher(sql, sockB.ws, claim('c-1'), broadcasts);
      const sockBHost = fakeSock(VOTER_B);
      callDispatcher(sql, sockBHost.ws, transfer(VOTER_C, 'c-2'), broadcasts);

      const hosts = sql
        .exec<{ id: string }>(`SELECT id FROM voter WHERE role = 'host'`).toArray();
      expect(hosts.map((r) => r.id)).toEqual([VOTER_C]);
      expect(voterRole(sql, VOTER_B)).toBe('voter');
      expect(voterRole(sql, HOST_ID)).toBe('voter');
    });
  });
});
