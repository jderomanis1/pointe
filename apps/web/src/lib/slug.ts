/** Frontend slug guard. Matches `adjective-noun-NN` and rejects reserved words. */

const SLUG_PATTERN = /^[a-z]+-[a-z]+-\d{2}$/;

/** Reserved at the URL root — these own static pages or namespaces. */
const RESERVED = new Set([
  'about', 'preview', 'docs', 'pricing', 'blog', 'help', 'api', 'admin', 'r',
]);

export function isReservedPath(s: string): boolean {
  return RESERVED.has(s);
}

export function isRoomSlug(s: string): boolean {
  if (!SLUG_PATTERN.test(s)) return false;
  if (RESERVED.has(s)) return false;
  return true;
}
