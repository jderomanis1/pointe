/** Frontend guard for secure and legacy Pointe room links. */

const LEGACY_SLUG_PATTERN = /^[a-z]+-[a-z]+-\d{2}$/;
const SECURE_SLUG_PATTERN = /^[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{24}$/;

const RESERVED = new Set([
  'about', 'preview', 'docs', 'pricing', 'blog', 'help', 'api', 'admin', 'r',
]);

export function isReservedPath(value: string): boolean {
  return RESERVED.has(value);
}

export function isRoomSlug(value: string): boolean {
  if (RESERVED.has(value)) return false;
  return LEGACY_SLUG_PATTERN.test(value) || SECURE_SLUG_PATTERN.test(value);
}
