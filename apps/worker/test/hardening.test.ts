import { describe, expect, it } from 'vitest';
import { generateSlug, isRoomSlug, SECURE_SLUG_PATTERN } from '../src/slug';
import {
  isAllowedWebSocketOrigin, securityHeaders, validateCreateRoomRequest,
} from '../src/security';

describe('security hardening', () => {
  it('generates readable slugs with at least a 96-bit cryptographic suffix', () => {
    const slugs = new Set(Array.from({ length: 200 }, () => generateSlug()));
    expect(slugs.size).toBe(200);
    for (const slug of slugs) {
      expect(slug).toMatch(SECURE_SLUG_PATTERN);
      expect(isRoomSlug(slug)).toBe(true);
    }
    expect(isRoomSlug('apt-sparrow-16')).toBe(true);
  });

  it('rejects hostile browser origins while retaining non-browser clients', () => {
    expect(isAllowedWebSocketOrigin(new Request('https://pointe.team/api/rooms/x/ws'))).toBe(true);
    expect(isAllowedWebSocketOrigin(new Request('https://pointe.team/api/rooms/x/ws', {
      headers: { Origin: 'https://pointe.team' },
    }))).toBe(true);
    expect(isAllowedWebSocketOrigin(new Request('https://pointe.team/api/rooms/x/ws', {
      headers: { Origin: 'https://attacker.invalid' },
    }))).toBe(false);
  });

  it('normalizes valid create requests and rejects unsafe decks or labels', () => {
    const valid = validateCreateRoomRequest({
      hostDisplayName: '  Maya  ', deck: 'custom', mode: 'sync', customDeck: ['1', ' 2 ', '3'],
    });
    expect(valid).toEqual({
      ok: true,
      value: { hostDisplayName: 'Maya', deck: 'custom', mode: 'sync', customDeck: ['1', '2', '3'] },
    });
    expect(validateCreateRoomRequest({ hostDisplayName: 'Maya', deck: 'bogus' }).ok).toBe(false);
    expect(validateCreateRoomRequest({
      hostDisplayName: 'Maya', deck: 'custom', customDeck: ['5', '5'],
    }).ok).toBe(false);
    expect(validateCreateRoomRequest({ hostDisplayName: 'Bad\nName' }).ok).toBe(false);
  });

  it('emits the core browser security headers', () => {
    const headers = securityHeaders();
    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });
});
