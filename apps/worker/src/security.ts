import type { CreateRoomRequest, DeckType, RoomMode } from '@pointe/shared';

export const MAX_HTTP_BODY_BYTES = 16 * 1024;
export const MAX_WS_MESSAGE_BYTES = 64 * 1024;
export const MAX_WS_MESSAGES_PER_MINUTE = 100;

const DECKS = new Set<DeckType>(['fibonacci', 'modFibonacci', 'tshirt', 'powers2', 'custom']);
const MODES = new Set<RoomMode>(['sync', 'async']);
// Deliberately rejects ASCII control characters from user-facing labels.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

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
  if (utf8ByteLength(raw) > MAX_HTTP_BODY_BYTES) {
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
    && utf8ByteLength(value) <= maxBytes
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
