export type StoredRoomSession = {
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
