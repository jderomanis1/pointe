// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearRoomSession, loadRoomSession, saveRoomSession } from '../src/lib/session';

describe('room session persistence', () => {
  beforeEach(() => sessionStorage.clear());

  it('round-trips an opaque room-scoped resume credential', () => {
    saveRoomSession('secure-room', {
      voterId: 'voter-1', resumeToken: 'secret-token', displayName: 'Maya', role: 'voter',
    });
    expect(loadRoomSession('secure-room')).toEqual({
      voterId: 'voter-1', resumeToken: 'secret-token', displayName: 'Maya', role: 'voter',
    });
    expect(loadRoomSession('another-room')).toBeNull();
    clearRoomSession('secure-room');
    expect(loadRoomSession('secure-room')).toBeNull();
  });

  it('ignores malformed stored data', () => {
    sessionStorage.setItem('pointe:room-session:bad', '{"voterId":42}');
    expect(loadRoomSession('bad')).toBeNull();
  });
});
