import { describe, it, expect } from 'vitest';
import { buildSessionCookie } from '../src/worker';

describe('session cookie (SI-03)', () => {
  it('produces the SI-03 attributes for the given voterId + slug', () => {
    const cookie = buildSessionCookie('host-voter-id', 'apt-sparrow-16');
    expect(cookie.startsWith('pointe_session=host-voter-id')).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/rooms/apt-sparrow-16');
    expect(cookie).toContain('Max-Age=86400');
    // Old broad attributes must be gone.
    expect(cookie).not.toContain('SameSite=Lax');
    expect(cookie).not.toContain('Max-Age=2592000');
  });

  it('interpolates a different slug into the Path scope', () => {
    const cookie = buildSessionCookie('v-9', 'clever-wren-61');
    expect(cookie).toContain('Path=/api/rooms/clever-wren-61');
    expect(cookie).not.toContain('Path=/api/rooms/apt-sparrow-16');
  });
});
