/**
 * Slug minting for Pointe rooms.
 * Generates human-readable, collision-resistant room slugs and maps them
 * to Durable Object room IDs in Workers KV.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

/** Professional, neutral, safe-for-work adjectives. */
const ADJECTIVES: string[] = [
  'swift', 'brave', 'clever', 'quiet', 'bright', 'calm', 'bold', 'deft',
  'eager', 'fair', 'glad', 'kind', 'lithe', 'merry', 'noble', 'prime',
  'quick', 'rapid', 'sharp', 'sound', 'steady', 'sure', 'tough', 'vivid',
  'warm', 'wise', 'agile', 'alert', 'ample', 'apt', 'crisp', 'keen', 'nimble',
];

/** Neutral animal nouns — easy to say and remember. */
const NOUNS: string[] = [
  'deer', 'fox', 'owl', 'wolf', 'hawk', 'eagle', 'bear', 'lion',
  'tiger', 'otter', 'swan', 'crane', 'falcon', 'heron', 'lynx', 'raven',
  'robin', 'salmon', 'sparrow', 'stork', 'swallow', 'trout', 'viper', 'wren',
  'badger', 'beaver', 'bison', 'dolphin', 'finch', 'gazelle', 'hare', 'ibex',
];

/** Pick a uniformly random element from a list. */
function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Generate a slug in the format "adjective-noun-NN" (NN = 10–99).
 * Not security-sensitive, so Math.random() is sufficient.
 */
export function generateSlug(): string {
  const number = Math.floor(Math.random() * 90) + 10;
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${number}`;
}

/**
 * Reserve a unique slug for a room in KV, retrying on collision.
 * KV is eventually consistent, so the post-put re-read is best-effort,
 * not an airtight compare-and-set. Entries expire after 30 days.
 * @throws Error("SLUG_GENERATION_EXHAUSTED") if every attempt collides.
 */
export async function reserveSlug(
  kv: KVNamespace,
  roomId: string,
  maxRetries = 5,
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const slug = generateSlug();
    const existing = await kv.get(slug);
    if (existing === null) {
      await kv.put(slug, roomId, { expirationTtl: 2592000 });
      const claimed = await kv.get(slug);
      if (claimed === roomId) return slug;
    }
  }
  throw new Error('SLUG_GENERATION_EXHAUSTED');
}

/**
 * Look up the room ID a slug maps to.
 * Returns the room ID, or null if the slug does not exist (does not throw).
 */
export async function lookupSlug(kv: KVNamespace, slug: string): Promise<string | null> {
  return kv.get(slug);
}
