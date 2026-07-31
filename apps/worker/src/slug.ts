/**
 * Human-readable room slugs with a cryptographic capability suffix.
 *
 * New shape: adjective-noun-noun-<24 lowercase hex chars>. The suffix alone
 * carries 96 bits of entropy; the words remain useful when reading a link
 * aloud. Legacy adjective-noun-NN slugs remain valid until their KV TTL ends.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

const ADJECTIVES = [
  'swift', 'brave', 'clever', 'quiet', 'bright', 'calm', 'bold', 'deft',
  'eager', 'fair', 'glad', 'kind', 'lithe', 'merry', 'noble', 'prime',
  'quick', 'rapid', 'sharp', 'sound', 'steady', 'sure', 'tough', 'vivid',
  'warm', 'wise', 'agile', 'alert', 'ample', 'apt', 'crisp', 'keen', 'nimble',
] as const;

const NOUNS = [
  'deer', 'fox', 'owl', 'wolf', 'hawk', 'eagle', 'bear', 'lion',
  'tiger', 'otter', 'swan', 'crane', 'falcon', 'heron', 'lynx', 'raven',
  'robin', 'salmon', 'sparrow', 'stork', 'swallow', 'trout', 'viper', 'wren',
  'badger', 'beaver', 'bison', 'dolphin', 'finch', 'gazelle', 'hare', 'ibex',
] as const;

export const LEGACY_SLUG_PATTERN = /^[a-z]+-[a-z]+-\d{2}$/;
export const SECURE_SLUG_PATTERN = /^[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{24}$/;

function randomIndex(length: number): number {
  const max = 0x1_0000_0000;
  const limit = max - (max % length);
  const values = new Uint32Array(1);
  do crypto.getRandomValues(values); while (values[0] >= limit);
  return values[0] % length;
}

function pick<T>(list: readonly T[]): T {
  return list[randomIndex(list.length)];
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function isRoomSlug(value: string): boolean {
  return LEGACY_SLUG_PATTERN.test(value) || SECURE_SLUG_PATTERN.test(value);
}

export function generateSlug(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${pick(NOUNS)}-${randomHex(12)}`;
}

export async function reserveSlug(
  kv: KVNamespace,
  roomId: string,
  maxRetries = 5,
  slugFactory: () => string = generateSlug,
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const slug = slugFactory();
    const existing = await kv.get(slug);
    if (existing === null) {
      await kv.put(slug, roomId, { expirationTtl: 2592000 });
      const claimed = await kv.get(slug);
      if (claimed === roomId) return slug;
    }
  }
  throw new Error('SLUG_GENERATION_EXHAUSTED');
}

export async function lookupSlug(kv: KVNamespace, slug: string): Promise<string | null> {
  if (!isRoomSlug(slug)) return null;
  return kv.get(slug);
}
