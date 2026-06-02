import { createContext, useContext, type ReactNode } from 'react';
import type { ClientMessageType } from '@pointe/shared';

export type SendFn = (type: ClientMessageType, payload: unknown) => void;

const Ctx = createContext<SendFn | null>(null);

export function RoomClientProvider({ send, children }: { send: SendFn; children: ReactNode }) {
  return <Ctx.Provider value={send}>{children}</Ctx.Provider>;
}

export function useSend(): SendFn {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSend must be inside <RoomClientProvider>');
  return s;
}
