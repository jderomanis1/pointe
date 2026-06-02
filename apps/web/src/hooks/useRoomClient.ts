import { useEffect, useRef } from 'react';
import type { ClientMessageType, ErrorPayload, JoinRoomPayload } from '@pointe/shared';
import { RoomWsClient } from '../ws/client';
import { useRoomStore } from '../store/roomStore';

export type UseRoomClientArgs = {
  wsUrl: string;
  join: JoinRoomPayload;
  /** Surfaces logical server errors (NOT_HOST, ROOM_CLOSED, etc.). Socket stays open. */
  onError?: (err: ErrorPayload) => void;
};

export type RoomClientApi = {
  send: (type: ClientMessageType, payload: unknown) => void;
  disconnect: () => void;
};

/**
 * Owns a RoomWsClient instance for the room route's lifetime.
 *
 *  - Constructs the client once on mount with the store's three hooks.
 *  - disconnect() + store.reset() on unmount (leaving the room).
 *  - The instance is stable across re-renders (held in a ref); store hooks
 *    update through getState() inside the wrapper callbacks so the client
 *    doesn't need to be rebuilt when the store changes.
 */
export function useRoomClient(args: UseRoomClientArgs): RoomClientApi {
  const clientRef = useRef<RoomWsClient | null>(null);

  useEffect(() => {
    const store = useRoomStore.getState();
    const client = new RoomWsClient({
      wsUrl: args.wsUrl,
      join: args.join,
      store: {
        hydrate: (snap) => useRoomStore.getState().hydrate(snap),
        applyServerDelta: (p) => useRoomStore.getState().applyServerDelta(p),
        setConnection: (s) => useRoomStore.getState().setConnection(s),
      },
      onError: args.onError,
    });
    clientRef.current = client;
    return () => {
      client.disconnect();
      clientRef.current = null;
      store.reset();
    };
    // Mount-only: ws URL + join payload are room-scoped and don't change mid-session.
  }, []);

  return {
    send: (type, payload) => clientRef.current?.send(type, payload),
    disconnect: () => clientRef.current?.disconnect(),
  };
}
