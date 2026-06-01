import { create } from 'zustand';
import type { DeltaPayload, RoomSnapshot } from '@pointe/shared';
import { applyDelta, applySnapshot, initialState } from './reducer';
import type { ConnectionStatus, RoomStore } from './types';

type Actions = {
  hydrate: (snapshot: RoomSnapshot) => void;
  applyServerDelta: (payload: DeltaPayload) => void;
  setConnection: (status: ConnectionStatus) => void;
  /** Reset to initial state (for leaving a room). */
  reset: () => void;
};

/**
 * Zustand store wrapping the pure reducers. The actions are the *only* way the store mutates;
 * each one delegates to a pure function in `reducer.ts` so the data layer can be unit-tested
 * without instantiating the store.
 */
export const useRoomStore = create<RoomStore & Actions>()((set, get) => ({
  ...initialState,
  hydrate: (snapshot) => set(applySnapshot(get(), snapshot)),
  applyServerDelta: (payload) => set(applyDelta(get(), payload)),
  setConnection: (status) => set({ connection: status }),
  reset: () => set(initialState),
}));
