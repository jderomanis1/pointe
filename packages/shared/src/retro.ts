export type RetroColumn = 'start' | 'stop' | 'continue';
export type RetroMode = 'entry' | 'review';
export type RetroRoomState = 'open' | 'closed';
export type RetroRole = 'facilitator' | 'participant' | 'observer';

export type RetroParticipant = {
  id: string;
  displayName: string;
  role: RetroRole;
  connected: boolean;
  joinedAt: number;
};

export type RetroNote = {
  id: string;
  column: RetroColumn;
  text: string;
  authorId: string;
  authorName: string | null;
  anonymous: boolean;
  discussed: boolean;
  createdAt: number;
  updatedAt: number;
};

export type CreateRetroRequest = {
  facilitatorName: string;
};

export type CreateRetroResponse = {
  slug: string;
  participantId: string;
  wsUrl: string;
};

export type GetRetroResponse = {
  state: RetroRoomState;
};

export type JoinRetroPayload = {
  slug: string;
  displayName?: string;
  resumeParticipantId?: string;
  role: 'participant' | 'observer';
};

export type RetroSnapshot = {
  slug: string;
  state: RetroRoomState;
  mode: RetroMode;
  participants: RetroParticipant[];
  notes: RetroNote[];
  you: {
    participantId: string;
    role: RetroRole;
  };
};

export type RetroError = {
  code: string;
  message: string;
};

export type RetroClientMessage =
  | { type: 'JOIN'; payload: JoinRetroPayload }
  | { type: 'ADD_NOTE'; payload: { column: RetroColumn; text: string; anonymous: boolean } }
  | { type: 'UPDATE_NOTE'; payload: { noteId: string; text: string } }
  | { type: 'MOVE_NOTE'; payload: { noteId: string; column: RetroColumn } }
  | { type: 'DELETE_NOTE'; payload: { noteId: string } }
  | { type: 'TOGGLE_DISCUSSED'; payload: { noteId: string } }
  | { type: 'SET_MODE'; payload: { mode: RetroMode } }
  | { type: 'CLOSE_RETRO'; payload: Record<string, never> };

export type RetroServerMessage =
  | { type: 'SNAPSHOT'; payload: RetroSnapshot }
  | { type: 'ERROR'; payload: RetroError };
