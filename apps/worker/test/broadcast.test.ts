import { describe, it, expect } from 'vitest';
import type { DeltaChange, Envelope, Voter } from '@pointe/shared';
import { broadcast, projectChangesFor } from '../src/broadcast';

// --- Fake socket + ctx helpers ---

type FakeSock = {
  sent: string[];
  ws: import('@cloudflare/workers-types').WebSocket;
};

function fakeWs(attachment: unknown): FakeSock {
  const sent: string[] = [];
  return {
    sent,
    ws: {
      send: (s: string) => { sent.push(s); },
      serializeAttachment: () => { /* not used */ },
      deserializeAttachment: () => attachment,
      close: () => {},
    } as unknown as import('@cloudflare/workers-types').WebSocket,
  };
}

function fakeCtx(socks: FakeSock[]) {
  return {
    getWebSockets: () => socks.map((s) => s.ws),
  } as unknown as import('@cloudflare/workers-types').DurableObjectState;
}

const VOTER_A: Voter = {
  id: 'a', roomId: 'r1', displayName: 'A', role: 'voter',
  connectionState: 'connected', lastSeenAt: 0, joinedAt: 0,
};

describe('projectChangesFor (anti-anchoring)', () => {
  it('voter_voted is presence for everyone; vote_value goes only to the caster', () => {
    const changes: DeltaChange[] = [
      { kind: 'voter_voted', storyId: 'st-1', voterId: 'a' },
      { kind: 'vote_value', storyId: 'st-1', points: '5', confidence: 3 },
    ];
    // Caster (a) sees both:
    expect(projectChangesFor('a', null, changes)).toEqual(changes);
    // Other viewer (b) sees presence only:
    expect(projectChangesFor('b', null, changes)).toEqual([
      { kind: 'voter_voted', storyId: 'st-1', voterId: 'a' },
    ]);
  });

  it('drops orphan vote_value (no paired voter_voted) defensively', () => {
    const changes: DeltaChange[] = [
      { kind: 'vote_value', storyId: 'st-9', points: '8', confidence: 4 },
    ];
    expect(projectChangesFor('a', null, changes)).toEqual([]);
  });

  it('passes through non-vote changes unchanged', () => {
    const changes: DeltaChange[] = [
      { kind: 'voter_joined', voter: VOTER_A },
      { kind: 'voter_left', voterId: 'x' },
    ];
    expect(projectChangesFor('whoever', null, changes)).toEqual(changes);
  });
});

describe('broadcast — fan-out via ctx.getWebSockets()', () => {
  it('skips sockets without an attachment; sends DELTA with a fresh (non-echoed) id to JOINed sockets', () => {
    const joined1 = fakeWs({ voterId: 'a', role: 'voter' });
    const joined2 = fakeWs({ voterId: 'b', role: 'voter' });
    const unattached = fakeWs(undefined);

    broadcast(
      fakeCtx([joined1, joined2, unattached]),
      [{ kind: 'voter_joined', voter: VOTER_A }],
      null,
    );

    expect(joined1.sent).toHaveLength(1);
    expect(joined2.sent).toHaveLength(1);
    expect(unattached.sent).toEqual([]);

    const env1 = JSON.parse(joined1.sent[0]) as Envelope;
    const env2 = JSON.parse(joined2.sent[0]) as Envelope;
    expect(env1.type).toBe('DELTA');
    expect(env2.type).toBe('DELTA');
    expect(env1.id).not.toBe(env2.id); // freshly minted per recipient
    expect(env1.v).toBe(1);
  });

  it('excludeWs skips the sender; per-recipient projection keeps vote_value only for the caster', () => {
    const caster = fakeWs({ voterId: 'a', role: 'voter' });
    const peer = fakeWs({ voterId: 'b', role: 'voter' });
    const ctx = fakeCtx([caster, peer]);
    broadcast(
      ctx,
      [
        { kind: 'voter_voted', storyId: 'st-1', voterId: 'a' },
        { kind: 'vote_value', storyId: 'st-1', points: '5', confidence: 3 },
      ],
      null,
      { excludeWs: caster.ws },
    );
    // caster excluded:
    expect(caster.sent).toEqual([]);
    // peer sees presence only (vote_value stripped):
    expect(peer.sent).toHaveLength(1);
    const env = JSON.parse(peer.sent[0]) as Envelope<{ changes: DeltaChange[] }>;
    expect(env.payload.changes).toEqual([
      { kind: 'voter_voted', storyId: 'st-1', voterId: 'a' },
    ]);
  });
});
