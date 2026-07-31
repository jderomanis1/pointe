from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    if old not in content:
        raise RuntimeError(f"Expected text not found in {path}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))


def append_once(path: str, marker: str, addition: str) -> None:
    content = read(path)
    if marker not in content:
        write(path, content.rstrip() + "\n\n" + addition.strip() + "\n")


# ---------------------------------------------------------------------------
# Shared protocol additions: opaque resume credentials are optional on the
# type surface for rolling compatibility, but every newly-created production
# session receives one.
# ---------------------------------------------------------------------------
replace_once(
    "packages/shared/src/types.ts",
    "  /** The host's voterId — also set as the `pointe_session` cookie. */\n  voterId: string;\n  /** Constructed WebSocket URL. The /ws endpoint itself lands in R2. */",
    "  /** The host's voterId — also set as the `pointe_session` cookie. */\n  voterId: string;\n  /** Opaque credential used with voterId to securely resume after refresh. */\n  resumeToken?: string;\n  /** Constructed WebSocket URL. The /ws endpoint itself lands in R2. */",
)
replace_once(
    "packages/shared/src/types.ts",
    "  /** From the cookie / prior session. */\n  resumeVoterId?: string;\n  /** Host is assigned by room creation, not claimed here. */",
    "  /** From the prior browser session. Never sufficient without resumeToken. */\n  resumeVoterId?: string;\n  /** Opaque room-scoped credential paired with resumeVoterId. */\n  resumeToken?: string;\n  /** Host is assigned by room creation, not claimed here. */",
)
replace_once(
    "packages/shared/src/types.ts",
    "  /** Server-bound identity (SI-01). */\n  you: { voterId: string; role: VoterRole };",
    "  /** Server-bound identity (SI-01) plus refresh-safe resume credential. */\n  you: { voterId: string; role: VoterRole; resumeToken?: string };",
)

# ---------------------------------------------------------------------------
# Secure, high-entropy room identifiers while continuing to recognize legacy
# adjective-noun-NN links for rooms that already exist.
# ---------------------------------------------------------------------------
write(
    "apps/worker/src/slug.ts",
    r'''/**
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

export async function lookupSlug(kv: KVNamespace, slug: string): Promise<string | null> {
  if (!isRoomSlug(slug)) return null;
  return kv.get(slug);
}
''',
)

write(
    "apps/web/src/lib/slug.ts",
    r'''/** Frontend guard for secure and legacy Pointe room links. */

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
''',
)

# ---------------------------------------------------------------------------
# Centralized request/origin/header limits.
# ---------------------------------------------------------------------------
write(
    "apps/worker/src/security.ts",
    r'''import type { CreateRoomRequest, DeckType, RoomMode } from '@pointe/shared';

export const MAX_HTTP_BODY_BYTES = 16 * 1024;
export const MAX_WS_MESSAGE_BYTES = 64 * 1024;
export const MAX_WS_MESSAGES_PER_MINUTE = 100;

const DECKS = new Set<DeckType>(['fibonacci', 'modFibonacci', 'tshirt', 'powers2', 'custom']);
const MODES = new Set<RoomMode>(['sync', 'async']);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string; status: number };

export async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_HTTP_BODY_BYTES) {
      return { ok: false, code: 'BODY_TOO_LARGE', message: 'Request body is too large', status: 413 };
    }
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_HTTP_BODY_BYTES) {
    return { ok: false, code: 'BODY_TOO_LARGE', message: 'Request body is too large', status: 413 };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, code: 'MALFORMED_JSON', message: 'Malformed JSON body', status: 400 };
  }
}

function validText(value: unknown, maxCharacters: number, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Array.from(value).length <= maxCharacters
    && new TextEncoder().encode(value).byteLength <= maxBytes
    && !CONTROL_CHARS.test(value);
}

export type CreateValidationResult =
  | { ok: true; value: Required<Pick<CreateRoomRequest, 'hostDisplayName' | 'deck' | 'mode'>> & Pick<CreateRoomRequest, 'customDeck'> }
  | { ok: false; code: string; message: string; status: number };

export function validateCreateRoomRequest(input: unknown): CreateValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Request body must be an object', status: 400 };
  }
  const value = input as Record<string, unknown>;
  if (!validText(value.hostDisplayName, 60, 240)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'hostDisplayName required (1–60 safe characters)', status: 400 };
  }
  const deck = value.deck === undefined ? 'fibonacci' : value.deck;
  const mode = value.mode === undefined ? 'sync' : value.mode;
  if (typeof deck !== 'string' || !DECKS.has(deck as DeckType)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Unsupported deck', status: 400 };
  }
  if (typeof mode !== 'string' || !MODES.has(mode as RoomMode)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Unsupported room mode', status: 400 };
  }

  let customDeck: string[] | undefined;
  if (deck === 'custom') {
    if (!Array.isArray(value.customDeck) || value.customDeck.length < 2 || value.customDeck.length > 30) {
      return { ok: false, code: 'INVALID_REQUEST', message: 'customDeck must contain 2–30 cards', status: 400 };
    }
    customDeck = [];
    const seen = new Set<string>();
    for (const card of value.customDeck) {
      if (!validText(card, 12, 48)) {
        return { ok: false, code: 'INVALID_REQUEST', message: 'Each custom card must be 1–12 safe characters', status: 400 };
      }
      const normalized = card.trim();
      if (seen.has(normalized)) {
        return { ok: false, code: 'INVALID_REQUEST', message: 'Custom deck cards must be unique', status: 400 };
      }
      seen.add(normalized);
      customDeck.push(normalized);
    }
  } else if (value.customDeck !== undefined && !Array.isArray(value.customDeck)) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'customDeck must be an array', status: 400 };
  }

  return {
    ok: true,
    value: {
      hostDisplayName: value.hostDisplayName.trim(),
      deck: deck as DeckType,
      mode: mode as RoomMode,
      ...(customDeck ? { customDeck } : {}),
    },
  };
}

/**
 * Browsers send an unforgeable Origin header on WebSocket handshakes. Reject
 * a present cross-site origin; allow a missing header for CLI/soak clients.
 */
export function isAllowedWebSocketOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const url = new URL(request.url);
  const sameOrigin = `${url.protocol}//${url.host}`;
  if (origin === sameOrigin) return true;
  if (url.hostname === 'pointe.team' && origin === 'https://www.pointe.team') return true;
  if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      && (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173')) {
    return true;
  }
  return false;
}
''',
)

# ---------------------------------------------------------------------------
# Durable Object schema and operations: random, room-scoped resume tokens.
# ---------------------------------------------------------------------------
replace_once(
    "apps/worker/src/schema.ts",
    "  sql.exec(`CREATE TABLE IF NOT EXISTS voter (\n    id               TEXT PRIMARY KEY,\n    display_name     TEXT NOT NULL,\n    role             TEXT NOT NULL,\n    connection_state TEXT NOT NULL,\n    last_seen_at     INTEGER NOT NULL,\n    joined_at        INTEGER NOT NULL\n  )`);",
    "  sql.exec(`CREATE TABLE IF NOT EXISTS voter (\n    id               TEXT PRIMARY KEY,\n    display_name     TEXT NOT NULL,\n    role             TEXT NOT NULL,\n    connection_state TEXT NOT NULL,\n    last_seen_at     INTEGER NOT NULL,\n    joined_at        INTEGER NOT NULL,\n    resume_token     TEXT\n  )`);\n  migrateVoterResumeToken(sql);\n  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_voter_resume_token\n    ON voter(resume_token) WHERE resume_token IS NOT NULL`);",
)
append_once(
    "apps/worker/src/schema.ts",
    "function migrateVoterResumeToken",
    r'''
/** Add the opaque participant resume credential to rooms created before this deploy. */
function migrateVoterResumeToken(sql: SqlStorage): void {
  const cols = sql
    .exec<{ name: string }>(`PRAGMA table_info(voter)`)
    .toArray()
    .map((row) => row.name);
  if (!cols.includes('resume_token')) {
    sql.exec(`ALTER TABLE voter ADD COLUMN resume_token TEXT`);
  }
}
''',
)

replace_once(
    "apps/worker/src/operations.ts",
    "type VoterRow = { id: string; display_name: string; role: string; connection_state: string; last_seen_at: number; joined_at: number };",
    "type VoterRow = { id: string; display_name: string; role: string; connection_state: string; last_seen_at: number; joined_at: number; resume_token: string | null };",
)
replace_once(
    "apps/worker/src/operations.ts",
    "    roomId: string; slug: string; hostVoterId: string; hostDisplayName: string;\n    deck: DeckType; mode: RoomMode; customDeck?: string[]; now: number;",
    "    roomId: string; slug: string; hostVoterId: string; hostDisplayName: string;\n    hostResumeToken?: string; deck: DeckType; mode: RoomMode; customDeck?: string[]; now: number;",
)
replace_once(
    "apps/worker/src/operations.ts",
    "  sql.exec(\n    `INSERT INTO room (id, slug, deck, custom_deck, mode, async_window, state,",
    "  const hostResumeToken = params.hostResumeToken ?? createResumeToken();\n  sql.exec(\n    `INSERT INTO room (id, slug, deck, custom_deck, mode, async_window, state,",
)
replace_once(
    "apps/worker/src/operations.ts",
    "  sql.exec(\n    `INSERT INTO voter (id, display_name, role, connection_state, last_seen_at, joined_at)\n     VALUES (?, ?, 'host', 'connected', ?, ?)`,\n    params.hostVoterId, params.hostDisplayName, params.now, params.now,\n  );",
    "  sql.exec(\n    `INSERT INTO voter (id, display_name, role, connection_state, last_seen_at, joined_at, resume_token)\n     VALUES (?, ?, 'host', 'connected', ?, ?, ?)`,\n    params.hostVoterId, params.hostDisplayName, params.now, params.now, hostResumeToken,\n  );",
)
replace_once(
    "apps/worker/src/operations.ts",
    "  params: { voterId: string; displayName: string; role?: VoterRole; now: number },",
    "  params: { voterId: string; displayName: string; role?: VoterRole; resumeToken?: string; now: number },",
)
replace_once(
    "apps/worker/src/operations.ts",
    "  const role: VoterRole = params.role ?? 'voter';\n  sql.exec(\n    `INSERT INTO voter (id, display_name, role, connection_state, last_seen_at, joined_at)\n     VALUES (?, ?, ?, 'connected', ?, ?)`,\n    params.voterId, params.displayName, role, params.now, params.now,\n  );",
    "  const role: VoterRole = params.role ?? 'voter';\n  const resumeToken = params.resumeToken ?? createResumeToken();\n  sql.exec(\n    `INSERT INTO voter (id, display_name, role, connection_state, last_seen_at, joined_at, resume_token)\n     VALUES (?, ?, ?, 'connected', ?, ?, ?)`,\n    params.voterId, params.displayName, role, params.now, params.now, resumeToken,\n  );",
)
old_resume = r'''export function resumeOrAddVoter(
  sql: SqlStorage,
  params: {
    voterId: string;
    resumeVoterId?: string;
    displayName?: string;
    role: VoterRole;
    now: number;
  },
): Voter {
  if (params.resumeVoterId) {
    const existing = sql
      .exec<{ id: string; display_name: string; role: string; joined_at: number }>(
        'SELECT id, display_name, role, joined_at FROM voter WHERE id = ?',
        params.resumeVoterId,
      ).toArray()[0];
    if (existing) {
      sql.exec(
        `UPDATE voter SET connection_state = 'connected', last_seen_at = ? WHERE id = ?`,
        params.now, params.resumeVoterId,
      );
      const room = sql.exec<{ id: string }>('SELECT id FROM room LIMIT 1').toArray()[0];
      if (!room) throw new Error('ROOM_NOT_FOUND');
      return {
        id: existing.id, roomId: room.id, displayName: existing.display_name,
        role: existing.role as VoterRole, connectionState: 'connected',
        lastSeenAt: params.now, joinedAt: existing.joined_at,
      };
    }
    // resumeVoterId given but not found → fall through to new voter.
  }
  if (!params.displayName) throw new Error('DISPLAY_NAME_REQUIRED');
  return addVoter(sql, {
    voterId: params.voterId, displayName: params.displayName,
    role: params.role, now: params.now,
  });
}
'''
new_resume = r'''export function createResumeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export type ResumableVoter = Voter & { resumeToken: string };

export function resumeOrAddVoter(
  sql: SqlStorage,
  params: {
    voterId: string;
    resumeVoterId?: string;
    resumeToken?: string;
    displayName?: string;
    role: VoterRole;
    now: number;
  },
): ResumableVoter {
  if (params.resumeVoterId) {
    const existing = sql
      .exec<{ id: string; display_name: string; role: string; joined_at: number; resume_token: string | null }>(
        'SELECT id, display_name, role, joined_at, resume_token FROM voter WHERE id = ?',
        params.resumeVoterId,
      ).toArray()[0];
    if (existing) {
      let resumeToken = existing.resume_token;
      if (resumeToken !== null) {
        if (!params.resumeToken || params.resumeToken !== resumeToken) {
          throw new Error('INVALID_RESUME_TOKEN');
        }
      } else {
        // One-time rolling upgrade for rooms created before resume tokens existed.
        resumeToken = createResumeToken();
        sql.exec('UPDATE voter SET resume_token = ? WHERE id = ?', resumeToken, existing.id);
      }
      sql.exec(
        `UPDATE voter SET connection_state = 'connected', last_seen_at = ? WHERE id = ?`,
        params.now, params.resumeVoterId,
      );
      const room = sql.exec<{ id: string }>('SELECT id FROM room LIMIT 1').toArray()[0];
      if (!room) throw new Error('ROOM_NOT_FOUND');
      return {
        id: existing.id, roomId: room.id, displayName: existing.display_name,
        role: existing.role as VoterRole, connectionState: 'connected',
        lastSeenAt: params.now, joinedAt: existing.joined_at, resumeToken,
      };
    }
  }
  if (!params.displayName) throw new Error('DISPLAY_NAME_REQUIRED');
  const resumeToken = createResumeToken();
  const voter = addVoter(sql, {
    voterId: params.voterId, displayName: params.displayName,
    role: params.role, resumeToken, now: params.now,
  });
  return { ...voter, resumeToken };
}

export function getOrCreateVoterResumeToken(sql: SqlStorage, voterId: string): string {
  const row = sql
    .exec<{ resume_token: string | null }>('SELECT resume_token FROM voter WHERE id = ?', voterId)
    .toArray()[0];
  if (!row) throw new Error('VOTER_NOT_FOUND');
  if (row.resume_token) return row.resume_token;
  const token = createResumeToken();
  sql.exec('UPDATE voter SET resume_token = ? WHERE id = ?', token, voterId);
  return token;
}
'''
replace_once("apps/worker/src/operations.ts", old_resume, new_resume)

# Socket attachment carries the secret only inside the room Durable Object.
replace_once(
    "apps/worker/src/broadcast.ts",
    "export type SocketAttachment = { voterId: string; role: VoterRole };",
    "export type SocketAttachment = { voterId: string; role: VoterRole; resumeToken?: string };",
)
replace_once(
    "apps/worker/src/broadcast.ts",
    "      const a = att as { voterId: string; role: unknown };\n      if (a.role === 'voter' || a.role === 'spectator' || a.role === 'host') {\n        return { voterId: a.voterId, role: a.role };\n      }",
    "      const a = att as { voterId: string; role: unknown; resumeToken?: unknown };\n      if (a.role === 'voter' || a.role === 'spectator' || a.role === 'host') {\n        return {\n          voterId: a.voterId,\n          role: a.role,\n          ...(typeof a.resumeToken === 'string' ? { resumeToken: a.resumeToken } : {}),\n        };\n      }",
)

# Dispatcher join and snapshot path.
replace_once(
    "apps/worker/src/dispatcher.ts",
    "  resumeOrAddVoter, getHostVoterId, getRoomLifecycle, getRoomState, getVoterById,",
    "  resumeOrAddVoter, getOrCreateVoterResumeToken, getHostVoterId, getRoomLifecycle, getRoomState, getVoterById,",
)
old_join = r'''  let voterId: string;
  let didBind = false;
  if (ctx.voterId) {
    // Re-JOIN on a live socket — reuse the existing binding.
    voterId = ctx.voterId;
  } else {
    try {
      const voter = resumeOrAddVoter(sql, {
        voterId: crypto.randomUUID(),
        resumeVoterId: payload.resumeVoterId,
        displayName: payload.displayName,
        role: payload.role,
        now: Date.now(),
      });
      voterId = voter.id;
      // SI-01: bind identity on the socket. Survives hibernation.
      ws.serializeAttachment({ voterId: voter.id, role: voter.role });
      didBind = true;
    } catch (err) {
      const code = err instanceof Error ? err.message : 'INTERNAL';
      return [makeError(code, code, false, envelope.id)];
    }
  }
'''
new_join = r'''  let voterId: string;
  let resumeToken: string;
  let didBind = false;
  let priorAttachment: Record<string, unknown> = {};
  try {
    const raw = ws.deserializeAttachment();
    if (raw && typeof raw === 'object') priorAttachment = raw as Record<string, unknown>;
  } catch {
    priorAttachment = {};
  }

  if (ctx.voterId) {
    // Re-JOIN on a live socket — reuse the existing server-bound identity.
    voterId = ctx.voterId;
    const attachment = getAttachment(ws);
    resumeToken = attachment?.resumeToken ?? getOrCreateVoterResumeToken(sql, voterId);
    ws.serializeAttachment({
      ...priorAttachment,
      voterId,
      role: attachment?.role ?? getVoterById(sql, voterId)?.role ?? 'voter',
      resumeToken,
    });
  } else {
    try {
      const voter = resumeOrAddVoter(sql, {
        voterId: crypto.randomUUID(),
        resumeVoterId: payload.resumeVoterId,
        resumeToken: payload.resumeToken,
        displayName: payload.displayName,
        role: payload.role,
        now: Date.now(),
      });
      voterId = voter.id;
      resumeToken = voter.resumeToken;
      // SI-01: bind identity + resume credential on the socket. Survives hibernation.
      ws.serializeAttachment({
        ...priorAttachment,
        voterId: voter.id,
        role: voter.role,
        resumeToken,
      });
      didBind = true;
    } catch (err) {
      const code = err instanceof Error ? err.message : 'INTERNAL';
      return [makeError(code, code, false, envelope.id)];
    }
  }
'''
replace_once("apps/worker/src/dispatcher.ts", old_join, new_join)
replace_once(
    "apps/worker/src/dispatcher.ts",
    "  const snapshot = buildSnapshot(sql, voterId);",
    "  const snapshot = buildSnapshot(sql, voterId, resumeToken);",
)
replace_once(
    "apps/worker/src/dispatcher.ts",
    "function buildSnapshot(sql: SqlStorage, voterId: string): RoomSnapshot {",
    "function buildSnapshot(sql: SqlStorage, voterId: string, resumeToken: string): RoomSnapshot {",
)
replace_once(
    "apps/worker/src/dispatcher.ts",
    "    you: { voterId, role: me.role as VoterRole },",
    "    you: { voterId, role: me.role as VoterRole, resumeToken },",
)
replace_once(
    "apps/worker/src/dispatcher.ts",
    "  if (o.resumeVoterId !== undefined && typeof o.resumeVoterId !== 'string') return false;\n  return o.role === 'voter' || o.role === 'spectator';",
    "  if (o.resumeVoterId !== undefined && typeof o.resumeVoterId !== 'string') return false;\n  if (o.resumeToken !== undefined && typeof o.resumeToken !== 'string') return false;\n  return o.role === 'voter' || o.role === 'spectator';",
)

# ---------------------------------------------------------------------------
# Worker HTTP and WebSocket boundary hardening.
# ---------------------------------------------------------------------------
replace_once(
    "apps/worker/src/worker.ts",
    "  ApiError,\n  CreateRoomRequest,\n  CreateRoomResponse,",
    "  ApiError,\n  CreateRoomResponse,",
)
replace_once(
    "apps/worker/src/worker.ts",
    "import { lookupSlug, reserveSlug } from './slug';",
    "import { isRoomSlug, lookupSlug, reserveSlug } from './slug';",
)
replace_once(
    "apps/worker/src/worker.ts",
    "import type { RoomReadState } from './operations';",
    "import { createResumeToken, type RoomReadState } from './operations';",
)
replace_once(
    "apps/worker/src/worker.ts",
    "import { recordRoomCreated } from './metrics';",
    "import { recordRoomCreated } from './metrics';\nimport {\n  isAllowedWebSocketOrigin, readJsonBody, securityHeaders, validateCreateRoomRequest,\n} from './security';",
)
replace_once(
    "apps/worker/src/worker.ts",
    "    headers: { 'Content-Type': 'application/json', ...extraHeaders },",
    "    headers: securityHeaders({ 'Content-Type': 'application/json', ...extraHeaders }),",
)
old_parse = r'''  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse('MALFORMED_JSON', 'Malformed JSON body', 400);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return errorResponse('INVALID_REQUEST', 'hostDisplayName required', 400);
  }
  const req = parsed as CreateRoomRequest;
  const name = req.hostDisplayName;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 60) {
    return errorResponse('INVALID_REQUEST', 'hostDisplayName required (1–60 chars)', 400);
  }
  const deck: DeckType = req.deck ?? 'fibonacci';
  const mode: RoomMode = req.mode ?? 'sync';
  if (deck === 'custom' && (!Array.isArray(req.customDeck) || req.customDeck.length === 0)) {
    return errorResponse('INVALID_REQUEST', 'customDeck required when deck is "custom"', 400);
  }
'''
new_parse = r'''  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return errorResponse(parsed.code, parsed.message, parsed.status);
  }
  const validated = validateCreateRoomRequest(parsed.value);
  if (!validated.ok) {
    return errorResponse(validated.code, validated.message, validated.status);
  }
  const req = validated.value;
  const name = req.hostDisplayName;
  const deck: DeckType = req.deck;
  const mode: RoomMode = req.mode;
'''
replace_once("apps/worker/src/worker.ts", old_parse, new_parse)
replace_once(
    "apps/worker/src/worker.ts",
    "  const hostVoterId = crypto.randomUUID();\n  // Reserve the slug",
    "  const hostVoterId = crypto.randomUUID();\n  const hostResumeToken = createResumeToken();\n  // Reserve the slug",
)
replace_once(
    "apps/worker/src/worker.ts",
    "        hostDisplayName: name,\n        deck,",
    "        hostDisplayName: name,\n        hostResumeToken,\n        deck,",
)
replace_once(
    "apps/worker/src/worker.ts",
    "    voterId: hostVoterId,\n    wsUrl:",
    "    voterId: hostVoterId,\n    resumeToken: hostResumeToken,\n    wsUrl:",
)
replace_once(
    "apps/worker/src/worker.ts",
    "  const match = pathname.match(/^\\/api\\/rooms\\/([a-z-]+-\\d+)\\/ws$/);\n  if (!match) return null;",
    "  const match = pathname.match(/^\\/api\\/rooms\\/([^/]+)\\/ws$/);\n  if (!match || !isRoomSlug(match[1])) return null;",
)
replace_once(
    "apps/worker/src/worker.ts",
    "  if (request.headers.get('Upgrade') !== 'websocket') {\n    return new Response('Expected websocket', { status: 426 });\n  }\n  const slug = match[1];",
    "  if (request.headers.get('Upgrade') !== 'websocket') {\n    return new Response('Expected websocket', { status: 426, headers: securityHeaders() });\n  }\n  if (!isAllowedWebSocketOrigin(request)) {\n    return errorResponse('ORIGIN_NOT_ALLOWED', 'WebSocket origin is not allowed', 403);\n  }\n  const slug = match[1];",
)
replace_once(
    "apps/worker/src/worker.ts",
    "  const match = pathname.match(/^\\/api\\/rooms\\/([a-z-]+-\\d+)$/);\n  if (!match) return null;",
    "  const match = pathname.match(/^\\/api\\/rooms\\/([^/]+)$/);\n  if (!match || !isRoomSlug(match[1])) return null;",
)
replace_once(
    "apps/worker/src/worker.ts",
    "      return Response.json({ ok: true, ts: Date.now() });",
    "      return json({ ok: true, ts: Date.now() }, 200);",
)

# DO initialization + per-frame size/rate enforcement.
replace_once(
    "apps/worker/src/room.ts",
    "import { recordAiRequested } from './metrics';",
    "import { recordAiRequested } from './metrics';\nimport {\n  MAX_WS_MESSAGE_BYTES, MAX_WS_MESSAGES_PER_MINUTE,\n} from './security';",
)
replace_once(
    "apps/worker/src/room.ts",
    "  hostDisplayName: string;\n  deck: DeckType;",
    "  hostDisplayName: string;\n  hostResumeToken?: string;\n  deck: DeckType;",
)
old_ws_message = r'''  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const envelopes = handleMessage(
      this.sql,
      ws,
      message,
      (changes, opts) => broadcast(this.ctx, changes, getHostVoterId(this.sql), opts),
      // S7.ii fire-and-forget: deletes the row synchronously; alarm re-schedule
      // is async (acceptable — stale alarm fires into an empty table → no-op).
      () => { void cancelTasksByType(this.ctx.storage, 'host_vacant'); },
      // S7.iii: HOST_RECLAIMED fan-out for CLAIM_HOST / TRANSFER_HOST / reclaim.
      (type, payload) => { broadcastEnvelope(this.ctx, type, payload); },
      // S8.ii.b: REQUEST_AI orchestration. The dispatcher's handler runs
      // sync (cache check, rate check, accept); the API call happens here.
      this.aiOrchestrator(),
      // S9.i.c2: OPEN_ASYNC arms the close alarm. Fire-and-forget — the
      // alarm is in place in milliseconds; the scheduler multiplexes via
      // MIN(at) so any pending host_vacant alarm is preserved.
      (closesAt) => {
        void scheduleTask(this.ctx.storage, 'async_close', closesAt, { closesAt });
      },
    );
    for (const env of envelopes) {
      ws.send(JSON.stringify(env));
    }
  }
'''
new_ws_message = r'''  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') {
      await this.closeForProtocolViolation(ws, 1003, 'Text messages only');
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_WS_MESSAGE_BYTES) {
      await this.closeForProtocolViolation(ws, 1009, 'Message too large');
      return;
    }
    if (!this.consumeSocketMessageBudget(ws)) {
      await this.closeForProtocolViolation(ws, 1008, 'Message rate exceeded');
      return;
    }

    const envelopes = handleMessage(
      this.sql,
      ws,
      message,
      (changes, opts) => broadcast(this.ctx, changes, getHostVoterId(this.sql), opts),
      () => { void cancelTasksByType(this.ctx.storage, 'host_vacant'); },
      (type, payload) => { broadcastEnvelope(this.ctx, type, payload); },
      this.aiOrchestrator(),
      (closesAt) => {
        void scheduleTask(this.ctx.storage, 'async_close', closesAt, { closesAt });
      },
    );
    for (const env of envelopes) {
      ws.send(JSON.stringify(env));
    }
  }

  private consumeSocketMessageBudget(ws: WebSocket, now: number = Date.now()): boolean {
    let attachment: Record<string, unknown> = {};
    try {
      const raw = ws.deserializeAttachment();
      if (raw && typeof raw === 'object') attachment = raw as Record<string, unknown>;
    } catch {
      attachment = {};
    }
    const previousStart = typeof attachment.messageWindowStart === 'number'
      ? attachment.messageWindowStart : now;
    const inWindow = now - previousStart < 60_000;
    const windowStart = inWindow ? previousStart : now;
    const previousCount = inWindow && typeof attachment.messageCount === 'number'
      ? attachment.messageCount : 0;
    const messageCount = previousCount + 1;
    ws.serializeAttachment({ ...attachment, messageWindowStart: windowStart, messageCount });
    return messageCount <= MAX_WS_MESSAGES_PER_MINUTE;
  }

  private async closeForProtocolViolation(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason); } catch { /* already closing */ }
    // Workerd does not call webSocketClose after a DO-initiated close.
    await this.webSocketClose(ws, code, reason, false);
  }
'''
replace_once("apps/worker/src/room.ts", old_ws_message, new_ws_message)

# ---------------------------------------------------------------------------
# Browser session persistence and secure resume plumbing.
# ---------------------------------------------------------------------------
write(
    "apps/web/src/lib/session.ts",
    r'''export type StoredRoomSession = {
  voterId: string;
  resumeToken: string;
  displayName: string;
  role: 'voter' | 'spectator';
};

const PREFIX = 'pointe:room-session:';

export function loadRoomSession(slug: string): StoredRoomSession | null {
  try {
    const raw = sessionStorage.getItem(`${PREFIX}${slug}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredRoomSession>;
    if (typeof value.voterId !== 'string' || typeof value.resumeToken !== 'string'
        || typeof value.displayName !== 'string'
        || (value.role !== 'voter' && value.role !== 'spectator')) {
      return null;
    }
    return value as StoredRoomSession;
  } catch {
    return null;
  }
}

export function saveRoomSession(slug: string, session: StoredRoomSession): void {
  try {
    sessionStorage.setItem(`${PREFIX}${slug}`, JSON.stringify(session));
  } catch {
    // Private browsing/storage denial should not stop the live session.
  }
}

export function clearRoomSession(slug: string): void {
  try { sessionStorage.removeItem(`${PREFIX}${slug}`); } catch { /* ignore */ }
}
''',
)

replace_once(
    "apps/web/src/pages/CreatePage.tsx",
    "  voterId: string;\n  displayName: string;",
    "  voterId: string;\n  resumeToken?: string;\n  displayName: string;",
)
replace_once(
    "apps/web/src/pages/CreatePage.tsx",
    "      voterId: res.data.voterId,\n      displayName: trimmed,",
    "      voterId: res.data.voterId,\n      resumeToken: res.data.resumeToken,\n      displayName: trimmed,",
)
replace_once(
    "apps/web/src/pages/CreatePage.tsx",
    "      setJoinError('Enter a valid Pointe room link or code, such as calm-fox-42.');",
    "      setJoinError('Enter a valid Pointe room link or code.');",
)

replace_once(
    "apps/web/src/pages/RoomPage.tsx",
    "import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';",
    "import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';",
)
replace_once(
    "apps/web/src/pages/RoomPage.tsx",
    "import type { ErrorPayload, JoinRoomPayload } from '@pointe/shared';",
    "import type { ErrorPayload, JoinRoomPayload, RoomSnapshot } from '@pointe/shared';",
)
replace_once(
    "apps/web/src/pages/RoomPage.tsx",
    "import type { CreateNavState } from './CreatePage';",
    "import type { CreateNavState } from './CreatePage';\nimport { clearRoomSession, loadRoomSession, saveRoomSession } from '../lib/session';",
)
old_room_effect = r'''  useEffect(() => {
    if (probe.kind !== 'found' || joinParams || !navState?.asHost) return;
    setJoinParams({
      wsUrl: buildWsUrl(slug),
      join: {
        slug,
        displayName: navState.displayName,
        resumeVoterId: navState.voterId,
        role: 'voter',
      },
    });
  }, [probe.kind, joinParams, navState, slug]);
'''
new_room_effect = r'''  useEffect(() => {
    if (probe.kind !== 'found' || joinParams) return;
    if (navState?.asHost) {
      setJoinParams({
        wsUrl: buildWsUrl(slug),
        join: {
          slug,
          displayName: navState.displayName,
          resumeVoterId: navState.voterId,
          resumeToken: navState.resumeToken,
          role: 'voter',
        },
      });
      return;
    }
    const saved = loadRoomSession(slug);
    if (saved) {
      setJoinParams({
        wsUrl: buildWsUrl(slug),
        join: {
          slug,
          displayName: saved.displayName,
          resumeVoterId: saved.voterId,
          resumeToken: saved.resumeToken,
          role: saved.role,
        },
      });
    }
  }, [probe.kind, joinParams, navState, slug]);
'''
replace_once("apps/web/src/pages/RoomPage.tsx", old_room_effect, new_room_effect)
old_connected = r'''  const [serverError, setServerError] = useState<ErrorPayload | null>(null);
  const args = useMemo(() => ({
    wsUrl, join, onError: (e: ErrorPayload) => setServerError(e),
  }), [wsUrl, join]);
  const api = useRoomClient(args);
'''
new_connected = r'''  const [serverError, setServerError] = useState<ErrorPayload | null>(null);
  const rememberSession = useCallback((snapshot: RoomSnapshot) => {
    const resumeToken = snapshot.you.resumeToken;
    const me = snapshot.voters.find((voter) => voter.id === snapshot.you.voterId);
    if (!resumeToken || !me) return;
    saveRoomSession(slug, {
      voterId: snapshot.you.voterId,
      resumeToken,
      displayName: me.displayName,
      role: me.role === 'spectator' ? 'spectator' : 'voter',
    });
  }, [slug]);
  const args = useMemo(() => ({
    wsUrl,
    join,
    onSession: rememberSession,
    onError: (error: ErrorPayload) => {
      setServerError(error);
      if (error.code === 'INVALID_RESUME_TOKEN') {
        clearRoomSession(slug);
        window.setTimeout(() => window.location.reload(), 0);
      }
    },
  }), [wsUrl, join, rememberSession, slug]);
  const api = useRoomClient(args);
'''
replace_once("apps/web/src/pages/RoomPage.tsx", old_connected, new_connected)

replace_once(
    "apps/web/src/hooks/useRoomClient.ts",
    "import type { ClientMessageType, ErrorPayload, JoinRoomPayload } from '@pointe/shared';",
    "import type { ClientMessageType, ErrorPayload, JoinRoomPayload, RoomSnapshot } from '@pointe/shared';",
)
replace_once(
    "apps/web/src/hooks/useRoomClient.ts",
    "  /** Surfaces logical server errors (NOT_HOST, ROOM_CLOSED, etc.). Socket stays open. */\n  onError?: (err: ErrorPayload) => void;",
    "  /** Surfaces logical server errors (NOT_HOST, ROOM_CLOSED, etc.). Socket stays open. */\n  onError?: (err: ErrorPayload) => void;\n  /** Persists the server-issued opaque resume credential after JOIN. */\n  onSession?: (snapshot: RoomSnapshot) => void;",
)
replace_once(
    "apps/web/src/hooks/useRoomClient.ts",
    "      onError: args.onError,",
    "      onError: args.onError,\n      onSession: args.onSession,",
)

replace_once(
    "apps/web/src/ws/client.ts",
    "  /** Called when the server sends ERROR — logical error, socket stays open. */\n  onError?: (err: ErrorPayload, envelope: Envelope) => void;",
    "  /** Called when the server sends ERROR — logical error, socket stays open. */\n  onError?: (err: ErrorPayload, envelope: Envelope) => void;\n  /** Called after each authoritative JOIN snapshot. */\n  onSession?: (snapshot: RoomSnapshot) => void;",
)
replace_once(
    "apps/web/src/ws/client.ts",
    "  private opts: Required<Omit<WsClientOptions, 'onError'>> & Pick<WsClientOptions, 'onError'>;",
    "  private opts: Required<Omit<WsClientOptions, 'onError' | 'onSession'>>\n    & Pick<WsClientOptions, 'onError' | 'onSession'>;",
)
replace_once(
    "apps/web/src/ws/client.ts",
    "  private voterId: string | null = null;",
    "  private voterId: string | null = null;\n  private resumeToken: string | null = null;",
)
replace_once(
    "apps/web/src/ws/client.ts",
    "    this.opts = {",
    "    this.voterId = opts.join.resumeVoterId ?? null;\n    this.resumeToken = opts.join.resumeToken ?? null;\n    this.opts = {",
)
replace_once(
    "apps/web/src/ws/client.ts",
    "      ...(this.voterId ? { resumeVoterId: this.voterId } : {}),",
    "      ...(this.voterId ? { resumeVoterId: this.voterId } : {}),\n      ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}),",
)
replace_once(
    "apps/web/src/ws/client.ts",
    "        this.voterId = snap.you.voterId;\n        this.opts.store.hydrate(snap);",
    "        this.voterId = snap.you.voterId;\n        this.resumeToken = snap.you.resumeToken ?? this.resumeToken;\n        this.opts.onSession?.(snap);\n        this.opts.store.hydrate(snap);",
)

# ---------------------------------------------------------------------------
# Mobile refinements: one-line roster and explicit card-scroll affordance.
# ---------------------------------------------------------------------------
replace_once(
    "apps/web/src/components/room/Roster.tsx",
    "    <aside className=\"rounded-[22px] border border-hairline bg-surface/85 px-4 py-4 shadow-card sm:px-5\" aria-label=\"Team roster\">\n      <div className=\"flex flex-col gap-3 sm:flex-row sm:items-center\">",
    "    <aside className=\"rounded-[22px] border border-hairline bg-surface/85 px-3 py-3 shadow-card sm:px-5 sm:py-4\" aria-label=\"Team roster\">\n      <div className=\"flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3\">",
)
replace_once(
    "apps/web/src/components/room/Roster.tsx",
    "        <ul className=\"flex flex-1 flex-wrap gap-2 sm:justify-end\">",
    "        <ul className=\"flex flex-1 flex-nowrap gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:justify-end sm:overflow-visible sm:pb-0\">",
)
replace_once(
    "apps/web/src/components/room/RoomShell.tsx",
    "      <div className=\"relative mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-7\">",
    "      <div className=\"relative mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 py-4 sm:gap-5 sm:px-6 sm:py-7\">",
)
replace_once(
    "apps/web/src/components/room/VoteCards.tsx",
    "  return (\n    <div\n      ref={groupRef}",
    "  return (\n    <div className=\"relative\">\n      {deck.length > 5 ? (\n        <p id=\"card-scroll-hint\" className=\"mb-1 text-center text-caption font-semibold text-text-muted sm:hidden\">\n          Swipe sideways to see every card\n        </p>\n      ) : null}\n      <div\n      ref={groupRef}",
)
replace_once(
    "apps/web/src/components/room/VoteCards.tsx",
    "      aria-label=\"Story points\"\n      className=\"pointe-card-hand",
    "      aria-label=\"Story points\"\n      aria-describedby={deck.length > 5 ? 'card-scroll-hint' : undefined}\n      className=\"pointe-card-hand",
)
replace_once(
    "apps/web/src/components/room/VoteCards.tsx",
    "      })}\n    </div>\n  );",
    "      })}\n      </div>\n      <div aria-hidden=\"true\" className=\"pointer-events-none absolute bottom-5 right-0 top-10 w-8 bg-gradient-to-l from-bg/90 to-transparent sm:hidden\" />\n    </div>\n  );",
)

# Existing E2E room creator must wait for the new slug shape.
replace_once(
    "e2e/helpers/multi-context.ts",
    "  await page.waitForURL(/\\/[a-z]+-[a-z]+-\\d+$/);",
    "  await page.waitForURL(/\\/[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{24}$/);",
)

# Static response hardening. style/script inline allowances are required by the
# current React inline styles, JSON-LD, and Cloudflare analytics beacon.
write(
    "apps/web/public/_headers",
    r'''/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss://pointe.team wss://www.pointe.team https://cloudflareinsights.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; upgrade-insecure-requests
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
''',
)

# Dependency upgrade; pnpm refreshes the lockfile in the workflow.
package = json.loads(read("apps/web/package.json"))
package["dependencies"]["react-router-dom"] = "^7.18.0"
write("apps/web/package.json", json.dumps(package, indent=2) + "\n")

# Focused tests.
write(
    "apps/worker/test/hardening.test.ts",
    r'''import { describe, expect, it } from 'vitest';
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
''',
)

write(
    "apps/web/test/session.test.ts",
    r'''// @vitest-environment jsdom
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
''',
)

append_once(
    "spec/security.md",
    "## 4. 2026-07 production hardening",
    r'''
## 4. 2026-07 production hardening

- New room links contain a 96-bit cryptographic capability suffix while legacy
  word-word-number links remain readable during their existing KV lifetime.
- Participant refresh resume requires both voter id and a random, room-scoped
  resume token persisted in session storage and verified by the room DO.
- Browser WebSocket handshakes reject a present non-allowlisted Origin.
- HTTP create bodies are capped at 16 KiB and custom decks are normalized and bounded.
- WebSocket frames are text-only, capped at 64 KiB, and limited to 100 messages
  per socket per minute using hibernation-persisted attachment counters.
- Static and API responses add HSTS, CSP/frame protection, nosniff, referrer,
  permissions, opener, and resource-isolation headers.
''',
)

print('Hardening patches applied successfully.')
