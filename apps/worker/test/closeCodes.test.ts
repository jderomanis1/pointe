import { describe, it, expect } from 'vitest';
import { WS_CLOSE, shouldReconnect } from '@pointe/shared';

describe('WS_CLOSE — application close codes', () => {
  it('defines the documented values', () => {
    expect(WS_CLOSE.KICKED).toBe(4001);
    expect(WS_CLOSE.ROOM_CLOSED).toBe(4002);
  });
});

describe('shouldReconnect', () => {
  it('terminal app codes → false (the client must not retry)', () => {
    expect(shouldReconnect(WS_CLOSE.KICKED)).toBe(false);
    expect(shouldReconnect(WS_CLOSE.ROOM_CLOSED)).toBe(false);
  });

  it('transient codes → true (network drop, hibernation cycle, normal close)', () => {
    expect(shouldReconnect(1006)).toBe(true);  // abnormal closure
    expect(shouldReconnect(1000)).toBe(true);  // normal closure
    expect(shouldReconnect(1011)).toBe(true);  // internal server error
  });
});
