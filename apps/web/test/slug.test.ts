import { describe, it, expect } from 'vitest';
import { isReservedPath, isRoomSlug } from '../src/lib/slug';

describe('isRoomSlug — valid', () => {
  it.each([
    'apt-sparrow-16',
    'clever-wren-61',
    'quiet-bear-04',
  ])('%s → true', (s) => {
    expect(isRoomSlug(s)).toBe(true);
  });
});

describe('isRoomSlug — invalid shape', () => {
  it.each([
    ['', 'empty'],
    ['apt-sparrow', 'no number'],
    ['apt-sparrow-1', 'one digit'],
    ['apt-sparrow-123', 'three digits'],
    ['Apt-Sparrow-16', 'capitalised'],
    ['apt sparrow 16', 'spaces'],
    ['apt_sparrow_16', 'underscores'],
    ['apt-sparrow-1a', 'non-digit suffix'],
    ['apt--16', 'missing noun'],
    ['1-sparrow-16', 'digits in first word'],
    ['apt-spa1row-16', 'digit in middle word'],
  ])('%s → false (%s)', (s) => {
    expect(isRoomSlug(s)).toBe(false);
  });
});

describe('isRoomSlug — reserved words', () => {
  it.each(['about', 'preview', 'docs', 'pricing', 'blog', 'help', 'api', 'admin', 'r'])(
    '%s → false (reserved)',
    (s) => {
      expect(isRoomSlug(s)).toBe(false);
      expect(isReservedPath(s)).toBe(true);
    },
  );
});
