import { create } from 'zustand';
import type {
  AiSharedPayload, DeltaPayload, HostReclaimedPayload, HostVacantPayload, RoomSnapshot,
} from '@pointe/shared';
import {
  applyAiShared, applyDelta, applyHostReclaimed, applyHostVacant, applySnapshot, initialState,
} from './reducer';
import type { ConnectionStatus, RoomStore } from './types';

type Actions = {
  hydrate: (snapshot: RoomSnapshot) => void;
  applyServerDelta: (payload: DeltaPayload) => void;
  applyHostVacant: (payload: HostVacantPayload) => void;
  applyHostReclaimed: (payload: HostReclaimedPayload) => void;
  /** S8.iv.c2: AI_SHARED — flip the suggestion to shared for all viewers. */
  applyAiShared: (payload: AiSharedPayload) => void;
  /** S7.iv: clear the "you were replaced" notice once dismissed. */
  dismissReplacedNotice: () => void;
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
  applyHostVacant: (payload) => set(applyHostVacant(get(), payload)),
  applyHostReclaimed: (payload) => set(applyHostReclaimed(get(), payload)),
  applyAiShared: (payload) => set(applyAiShared(get(), payload)),
  dismissReplacedNotice: () => set({ replacedByHostName: null }),
  setConnection: (status) => set({ connection: status }),
  reset: () => set(initialState),
}));
