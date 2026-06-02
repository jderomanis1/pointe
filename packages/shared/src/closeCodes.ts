/**
 * WebSocket application-level close codes (range 4000–4999 per RFC 6455).
 *
 * The client's auto-reconnect logic (R4.iii) lets transient closes (network
 * drop, hibernation cycle, code 1006) trigger backoff-and-resume. These
 * codes signal an intentional, terminal close: the client must NOT reconnect.
 *
 *  - KICKED:      the host removed this voter from the room (moderation).
 *  - ROOM_CLOSED: the host closed the room; everyone leaves.
 *
 * S7.i lands the enum; moderation (S7 host-lifecycle tasks) sends the codes
 * server-side and the client's `onClose` consumes `shouldReconnect` when wired.
 */
export const WS_CLOSE = {
  KICKED: 4001,
  ROOM_CLOSED: 4002,
} as const;

export type WsCloseCode = typeof WS_CLOSE[keyof typeof WS_CLOSE];

/** True iff the client should attempt to reconnect after a close with this code. */
export function shouldReconnect(code: number): boolean {
  return code !== WS_CLOSE.KICKED && code !== WS_CLOSE.ROOM_CLOSED;
}
