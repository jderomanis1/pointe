import type { DurableObjectState, SqlStorage, WebSocket } from '@cloudflare/workers-types';
import type {
  RetroClientMessage,
  RetroColumn,
  RetroMode,
  RetroNote,
  RetroParticipant,
  RetroRole,
  RetroRoomState,
  RetroServerMessage,
  RetroSnapshot,
} from '@pointe/shared';
import type { Env } from './worker';

const VALID_COLUMNS = new Set<RetroColumn>(['start', 'stop', 'continue']);
const VALID_MODES = new Set<RetroMode>(['entry', 'review']);

type InitBody = {
  roomId: string;
  slug: string;
  facilitatorId: string;
  facilitatorName: string;
};

type RetroRoomRow = {
  id: string;
  slug: string;
  state: RetroRoomState;
  mode: RetroMode;
  facilitator_id: string;
  created_at: number;
  updated_at: number;
};

type RetroParticipantRow = {
  id: string;
  display_name: string;
  role: RetroRole;
  connected: number;
  joined_at: number;
};

type RetroNoteRow = {
  id: string;
  column_name: RetroColumn;
  text: string;
  author_id: string;
  author_name: string | null;
  anonymous: number;
  discussed: number;
  created_at: number;
  updated_at: number;
};

type SocketAttachment = { participantId: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function initRetroSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS retro_room (
    id             TEXT PRIMARY KEY,
    slug           TEXT NOT NULL,
    state          TEXT NOT NULL,
    mode           TEXT NOT NULL,
    facilitator_id TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS retro_participant (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role         TEXT NOT NULL,
    connected    INTEGER NOT NULL DEFAULT 0,
    joined_at    INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS retro_note (
    id          TEXT PRIMARY KEY,
    column_name TEXT NOT NULL,
    text        TEXT NOT NULL,
    author_id   TEXT NOT NULL,
    author_name TEXT,
    anonymous   INTEGER NOT NULL DEFAULT 0,
    discussed   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_retro_note_created ON retro_note(created_at)`);
}

export class RetroRoom {
  private readonly sql: SqlStorage;
  private readonly ctx: DurableObjectState;
  // Retained for the Durable Object constructor contract and future telemetry.
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.sql = ctx.storage.sql;
    this.ctx = ctx;
    this.env = env;
    initRetroSchema(this.sql);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/ws') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('Expected websocket', { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
      if (pathname === '/init' && request.method === 'POST') {
        const body = (await request.json()) as InitBody;
        if (this.getRoom()) return json({ code: 'RETRO_ALREADY_EXISTS', message: 'Retrospective already exists' }, 409);
        const now = Date.now();
        this.sql.exec(
          `INSERT INTO retro_room (id, slug, state, mode, facilitator_id, created_at, updated_at)
           VALUES (?, ?, 'open', 'entry', ?, ?, ?)`,
          body.roomId,
          body.slug,
          body.facilitatorId,
          now,
          now,
        );
        this.sql.exec(
          `INSERT INTO retro_participant (id, display_name, role, connected, joined_at)
           VALUES (?, ?, 'facilitator', 0, ?)`,
          body.facilitatorId,
          body.facilitatorName.trim(),
          now,
        );
        return json({ ok: true }, 201);
      }
      if (pathname === '/state' && request.method === 'GET') {
        const room = this.getRoom();
        return room ? json({ state: room.state }) : json({ code: 'RETRO_NOT_FOUND', message: 'Retrospective not found' }, 404);
      }
      return json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error';
      return json({ code: 'INTERNAL', message }, 500);
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const message = JSON.parse(text) as RetroClientMessage;
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        this.sendError(ws, 'INVALID_MESSAGE', 'Invalid message');
        return;
      }
      if (message.type === 'JOIN') {
        this.join(ws, message.payload);
        return;
      }

      const attachment = this.attachment(ws);
      if (!attachment) {
        this.sendError(ws, 'NOT_JOINED', 'Join the retrospective first');
        return;
      }
      const actor = this.getParticipant(attachment.participantId);
      if (!actor) {
        this.sendError(ws, 'PARTICIPANT_NOT_FOUND', 'Participant not found');
        return;
      }

      switch (message.type) {
        case 'ADD_NOTE':
          this.addNote(ws, actor, message.payload.column, message.payload.text, message.payload.anonymous);
          break;
        case 'UPDATE_NOTE':
          this.updateNote(ws, actor, message.payload.noteId, message.payload.text);
          break;
        case 'MOVE_NOTE':
          this.moveNote(ws, actor, message.payload.noteId, message.payload.column);
          break;
        case 'DELETE_NOTE':
          this.deleteNote(ws, actor, message.payload.noteId);
          break;
        case 'TOGGLE_DISCUSSED':
          this.toggleDiscussed(ws, actor, message.payload.noteId);
          break;
        case 'SET_MODE':
          this.setMode(ws, actor, message.payload.mode);
          break;
        case 'CLOSE_RETRO':
          this.closeRetro(ws, actor);
          break;
      }
    } catch {
      this.sendError(ws, 'INVALID_MESSAGE', 'The retrospective message could not be read');
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.markDisconnected(ws);
    try { ws.close(code, 'server ack'); } catch { /* already closing */ }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.markDisconnected(ws);
  }

  private join(ws: WebSocket, payload: Extract<RetroClientMessage, { type: 'JOIN' }>['payload']): void {
    const room = this.getRoom();
    if (!room || payload.slug !== room.slug) {
      this.sendError(ws, 'RETRO_NOT_FOUND', 'Retrospective not found');
      return;
    }

    let participant = payload.resumeParticipantId
      ? this.getParticipant(payload.resumeParticipantId)
      : null;

    if (!participant) {
      const displayName = payload.displayName?.trim() ?? '';
      if (displayName.length < 1 || displayName.length > 60) {
        this.sendError(ws, 'INVALID_NAME', 'Choose a name between 1 and 60 characters');
        return;
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO retro_participant (id, display_name, role, connected, joined_at)
         VALUES (?, ?, ?, 1, ?)`,
        id,
        displayName,
        payload.role,
        now,
      );
      participant = this.getParticipant(id);
    } else {
      this.sql.exec(`UPDATE retro_participant SET connected = 1 WHERE id = ?`, participant.id);
      participant = { ...participant, connected: 1 };
    }

    if (!participant) {
      this.sendError(ws, 'JOIN_FAILED', 'Could not join the retrospective');
      return;
    }
    ws.serializeAttachment({ participantId: participant.id } satisfies SocketAttachment);
    this.broadcastSnapshots();
  }

  private addNote(
    ws: WebSocket,
    actor: RetroParticipantRow,
    column: RetroColumn,
    text: string,
    anonymous: boolean,
  ): void {
    if (!this.canChangeBoard(ws, actor)) return;
    if (actor.role === 'observer') {
      this.sendError(ws, 'READ_ONLY', 'Observers cannot add notes');
      return;
    }
    if (!VALID_COLUMNS.has(column)) {
      this.sendError(ws, 'INVALID_COLUMN', 'Choose Start, Stop, or Continue');
      return;
    }
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed.length < 1 || trimmed.length > 500) {
      this.sendError(ws, 'INVALID_NOTE', 'Notes must be between 1 and 500 characters');
      return;
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO retro_note
       (id, column_name, text, author_id, author_name, anonymous, discussed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      crypto.randomUUID(),
      column,
      trimmed,
      actor.id,
      anonymous ? null : actor.display_name,
      anonymous ? 1 : 0,
      now,
      now,
    );
    this.touch(now);
    this.broadcastSnapshots();
  }

  private updateNote(ws: WebSocket, actor: RetroParticipantRow, noteId: string, text: string): void {
    if (!this.canChangeBoard(ws, actor)) return;
    const note = this.getNote(noteId);
    if (!note || !this.canEdit(actor, note)) {
      this.sendError(ws, 'NOT_ALLOWED', 'You can edit only your own notes');
      return;
    }
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed.length < 1 || trimmed.length > 500) {
      this.sendError(ws, 'INVALID_NOTE', 'Notes must be between 1 and 500 characters');
      return;
    }
    const now = Date.now();
    this.sql.exec(`UPDATE retro_note SET text = ?, updated_at = ? WHERE id = ?`, trimmed, now, noteId);
    this.touch(now);
    this.broadcastSnapshots();
  }

  private moveNote(ws: WebSocket, actor: RetroParticipantRow, noteId: string, column: RetroColumn): void {
    if (!this.canChangeBoard(ws, actor)) return;
    const note = this.getNote(noteId);
    if (!note || !this.canEdit(actor, note)) {
      this.sendError(ws, 'NOT_ALLOWED', 'You can move only your own notes');
      return;
    }
    if (!VALID_COLUMNS.has(column)) {
      this.sendError(ws, 'INVALID_COLUMN', 'Choose Start, Stop, or Continue');
      return;
    }
    const now = Date.now();
    this.sql.exec(`UPDATE retro_note SET column_name = ?, updated_at = ? WHERE id = ?`, column, now, noteId);
    this.touch(now);
    this.broadcastSnapshots();
  }

  private deleteNote(ws: WebSocket, actor: RetroParticipantRow, noteId: string): void {
    if (!this.canChangeBoard(ws, actor)) return;
    const note = this.getNote(noteId);
    if (!note || !this.canEdit(actor, note)) {
      this.sendError(ws, 'NOT_ALLOWED', 'You can delete only your own notes');
      return;
    }
    this.sql.exec(`DELETE FROM retro_note WHERE id = ?`, noteId);
    this.touch(Date.now());
    this.broadcastSnapshots();
  }

  private toggleDiscussed(ws: WebSocket, actor: RetroParticipantRow, noteId: string): void {
    if (!this.canChangeBoard(ws, actor)) return;
    if (actor.role !== 'facilitator') {
      this.sendError(ws, 'FACILITATOR_ONLY', 'Only the facilitator can mark notes discussed');
      return;
    }
    const note = this.getNote(noteId);
    if (!note) {
      this.sendError(ws, 'NOTE_NOT_FOUND', 'Note not found');
      return;
    }
    const now = Date.now();
    this.sql.exec(
      `UPDATE retro_note SET discussed = CASE discussed WHEN 0 THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?`,
      now,
      noteId,
    );
    this.touch(now);
    this.broadcastSnapshots();
  }

  private setMode(ws: WebSocket, actor: RetroParticipantRow, mode: RetroMode): void {
    if (!this.canChangeBoard(ws, actor)) return;
    if (actor.role !== 'facilitator') {
      this.sendError(ws, 'FACILITATOR_ONLY', 'Only the facilitator can change modes');
      return;
    }
    if (!VALID_MODES.has(mode)) {
      this.sendError(ws, 'INVALID_MODE', 'Choose entry or review mode');
      return;
    }
    const now = Date.now();
    this.sql.exec(`UPDATE retro_room SET mode = ?, updated_at = ?`, mode, now);
    this.broadcastSnapshots();
  }

  private closeRetro(ws: WebSocket, actor: RetroParticipantRow): void {
    if (actor.role !== 'facilitator') {
      this.sendError(ws, 'FACILITATOR_ONLY', 'Only the facilitator can close the retrospective');
      return;
    }
    const room = this.getRoom();
    if (!room || room.state === 'closed') return;
    const now = Date.now();
    this.sql.exec(`UPDATE retro_room SET state = 'closed', mode = 'review', updated_at = ?`, now);
    this.broadcastSnapshots();
  }

  private canChangeBoard(ws: WebSocket, _actor: RetroParticipantRow): boolean {
    const room = this.getRoom();
    if (!room || room.state === 'closed') {
      this.sendError(ws, 'RETRO_CLOSED', 'This retrospective is closed and read-only');
      return false;
    }
    return true;
  }

  private canEdit(actor: RetroParticipantRow, note: RetroNoteRow): boolean {
    return actor.role === 'facilitator' || actor.id === note.author_id;
  }

  private markDisconnected(ws: WebSocket): void {
    const attachment = this.attachment(ws);
    if (!attachment) return;
    if (this.participantIsLive(attachment.participantId, ws)) return;
    this.sql.exec(`UPDATE retro_participant SET connected = 0 WHERE id = ?`, attachment.participantId);
    this.broadcastSnapshots(ws);
  }

  private participantIsLive(participantId: string, excluding?: WebSocket): boolean {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excluding) continue;
      if (this.attachment(socket)?.participantId === participantId) return true;
    }
    return false;
  }

  private broadcastSnapshots(excluding?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excluding) continue;
      const attachment = this.attachment(socket);
      if (!attachment) continue;
      const snapshot = this.snapshotFor(attachment.participantId);
      if (!snapshot) continue;
      this.send(socket, { type: 'SNAPSHOT', payload: snapshot });
    }
  }

  private snapshotFor(viewerId: string): RetroSnapshot | null {
    const room = this.getRoom();
    const viewer = this.getParticipant(viewerId);
    if (!room || !viewer) return null;

    const participants: RetroParticipant[] = this.sql
      .exec<RetroParticipantRow>(
        `SELECT id, display_name, role, connected, joined_at
         FROM retro_participant ORDER BY joined_at ASC`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        displayName: row.display_name,
        role: row.role,
        connected: row.connected === 1,
        joinedAt: row.joined_at,
      }));

    const notes: RetroNote[] = this.sql
      .exec<RetroNoteRow>(
        `SELECT id, column_name, text, author_id, author_name, anonymous,
                discussed, created_at, updated_at
         FROM retro_note ORDER BY created_at ASC`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        column: row.column_name,
        text: row.text,
        authorId: row.anonymous === 1 && row.author_id !== viewerId ? '' : row.author_id,
        authorName: row.anonymous === 1 ? null : row.author_name,
        anonymous: row.anonymous === 1,
        discussed: row.discussed === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

    return {
      slug: room.slug,
      state: room.state,
      mode: room.mode,
      participants,
      notes,
      you: { participantId: viewer.id, role: viewer.role },
    };
  }

  private getRoom(): RetroRoomRow | null {
    return this.sql
      .exec<RetroRoomRow>(
        `SELECT id, slug, state, mode, facilitator_id, created_at, updated_at
         FROM retro_room LIMIT 1`,
      )
      .toArray()[0] ?? null;
  }

  private getParticipant(id: string): RetroParticipantRow | null {
    return this.sql
      .exec<RetroParticipantRow>(
        `SELECT id, display_name, role, connected, joined_at
         FROM retro_participant WHERE id = ?`,
        id,
      )
      .toArray()[0] ?? null;
  }

  private getNote(id: string): RetroNoteRow | null {
    return this.sql
      .exec<RetroNoteRow>(
        `SELECT id, column_name, text, author_id, author_name, anonymous,
                discussed, created_at, updated_at
         FROM retro_note WHERE id = ?`,
        id,
      )
      .toArray()[0] ?? null;
  }

  private touch(now: number): void {
    this.sql.exec(`UPDATE retro_room SET updated_at = ?`, now);
  }

  private attachment(ws: WebSocket): SocketAttachment | null {
    try {
      return ws.deserializeAttachment() as SocketAttachment | null;
    } catch {
      return null;
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { type: 'ERROR', payload: { code, message } });
  }

  private send(ws: WebSocket, message: RetroServerMessage): void {
    try { ws.send(JSON.stringify(message)); } catch { /* socket closing */ }
  }
}
