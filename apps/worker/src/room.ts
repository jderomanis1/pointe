import type { DurableObjectState } from '@cloudflare/workers-types';
import type {
  Room as RoomState,
  RoomUser,
  Vote,
  RoundResult,
  RoomPhase,
  ScaleType,
  Confidence,
} from '@pointe/shared';
import type { Env } from './worker';

type MetaRow = {
  id: string;
  room_id: string;
  created_at: number;
  host_user_id: string;
  phase: string;
  topic: string | null;
  scale_type: string;
  current_round_id: number;
};

type UserRow = {
  id: string;
  display_name: string;
  joined_at: number;
  is_host: number;
  is_observer: number;
};

type VoteRow = {
  user_id: string;
  value: string;
  confidence: string;
  reasoning: string | null;
  submitted_at: number;
};

type RoundRow = {
  round_id: number;
  topic: string | null;
  consensus_value: string | null;
  agreed_at: number;
};

type RoundVoteRow = VoteRow & { round_id: number };

export class Room {
  private ctx: DurableObjectState;
  private env: Env;
  private schemaReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  /** Lazily create all tables. Idempotent; runs once per instance. */
  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        host_user_id TEXT NOT NULL, phase TEXT NOT NULL, topic TEXT,
        scale_type TEXT NOT NULL, current_round_id INTEGER NOT NULL DEFAULT 0)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, joined_at INTEGER NOT NULL,
        is_host INTEGER NOT NULL, is_observer INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS votes (
        user_id TEXT PRIMARY KEY, value TEXT NOT NULL, confidence TEXT NOT NULL,
        reasoning TEXT, submitted_at INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS rounds (
        round_id INTEGER PRIMARY KEY, topic TEXT, consensus_value TEXT,
        agreed_at INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS round_votes (
        round_id INTEGER NOT NULL, user_id TEXT NOT NULL, value TEXT NOT NULL,
        confidence TEXT NOT NULL, reasoning TEXT, submitted_at INTEGER NOT NULL,
        PRIMARY KEY (round_id, user_id))`,
    );
    this.schemaReady = true;
  }

  async init(params: {
    roomId: string;
    hostUser: { id: string; displayName: string };
    scaleType: ScaleType;
    topic?: string;
  }): Promise<RoomState> {
    await this.ensureSchema();
    const sql = this.ctx.storage.sql;
    const existing = sql.exec<MetaRow>("SELECT id FROM meta WHERE id = 'singleton'").toArray();
    if (existing.length > 0) throw new Error('ROOM_ALREADY_INITIALIZED');

    const now = Date.now();
    sql.exec(
      `INSERT OR ABORT INTO meta
        (id, room_id, created_at, host_user_id, phase, topic, scale_type, current_round_id)
        VALUES ('singleton', ?, ?, ?, 'voting', ?, ?, 0)`,
      params.roomId,
      now,
      params.hostUser.id,
      params.topic ?? null,
      params.scaleType,
    );
    sql.exec(
      `INSERT INTO users (id, display_name, joined_at, is_host, is_observer)
        VALUES (?, ?, ?, 1, 0)`,
      params.hostUser.id,
      params.hostUser.displayName,
      now,
    );
    return this.getState();
  }

  async getState(): Promise<RoomState> {
    await this.ensureSchema();
    const sql = this.ctx.storage.sql;
    const metaRows = sql.exec<MetaRow>("SELECT * FROM meta WHERE id = 'singleton'").toArray();
    const meta = metaRows[0];
    if (!meta) throw new Error('ROOM_NOT_INITIALIZED');

    const users = sql
      .exec<UserRow>('SELECT * FROM users ORDER BY joined_at ASC')
      .toArray()
      .map((u): RoomUser => ({
        id: u.id,
        displayName: u.display_name,
        joinedAt: u.joined_at,
        isHost: u.is_host === 1,
        isObserver: u.is_observer === 1,
      }));

    const votes = sql
      .exec<VoteRow>('SELECT * FROM votes ORDER BY submitted_at ASC')
      .toArray()
      .map((v) => this.toVote(v));

    const rounds = sql.exec<RoundRow>('SELECT * FROM rounds ORDER BY round_id ASC').toArray();
    const roundVotes = sql
      .exec<RoundVoteRow>('SELECT * FROM round_votes ORDER BY round_id ASC')
      .toArray();
    const history = rounds.map((r): RoundResult => ({
      topic: r.topic ?? undefined,
      votes: roundVotes.filter((rv) => rv.round_id === r.round_id).map((rv) => this.toVote(rv)),
      consensusValue: r.consensus_value ?? undefined,
      agreedAt: r.agreed_at,
    }));

    return {
      id: meta.room_id,
      createdAt: meta.created_at,
      hostUserId: meta.host_user_id,
      phase: meta.phase as RoomPhase,
      topic: meta.topic ?? undefined,
      scaleType: meta.scale_type as ScaleType,
      users,
      votes,
      history,
    };
  }

  async addUser(params: { displayName: string; isObserver?: boolean }): Promise<RoomUser> {
    await this.ensureSchema();
    const id = crypto.randomUUID();
    const joinedAt = Date.now();
    const isObserver = params.isObserver ?? false;
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, display_name, joined_at, is_host, is_observer)
        VALUES (?, ?, ?, 0, ?)`,
      id,
      params.displayName,
      joinedAt,
      isObserver ? 1 : 0,
    );
    return { id, displayName: params.displayName, joinedAt, isHost: false, isObserver };
  }

  async castVote(params: {
    userId: string;
    value: string;
    confidence: Confidence;
    reasoning?: string;
  }): Promise<void> {
    await this.ensureSchema();
    const sql = this.ctx.storage.sql;
    const userRows = sql
      .exec<UserRow>('SELECT * FROM users WHERE id = ?', params.userId)
      .toArray();
    const user = userRows[0];
    if (!user) throw new Error('USER_NOT_FOUND');
    if (user.is_observer === 1) throw new Error('OBSERVER_CANNOT_VOTE');

    const phaseRow = sql.exec<MetaRow>("SELECT phase FROM meta WHERE id = 'singleton'").toArray()[0];
    if (!phaseRow || phaseRow.phase !== 'voting') throw new Error('ROOM_NOT_IN_VOTING_PHASE');

    sql.exec(
      `INSERT OR REPLACE INTO votes (user_id, value, confidence, reasoning, submitted_at)
        VALUES (?, ?, ?, ?, ?)`,
      params.userId,
      params.value,
      params.confidence,
      params.reasoning ?? null,
      Date.now(),
    );
  }

  async revealVotes(): Promise<RoundResult> {
    await this.ensureSchema();
    const sql = this.ctx.storage.sql;
    const meta = sql.exec<MetaRow>("SELECT * FROM meta WHERE id = 'singleton'").toArray()[0];
    if (!meta || meta.phase !== 'voting') throw new Error('ROOM_NOT_IN_VOTING_PHASE');

    const currentVotes = sql.exec<VoteRow>('SELECT * FROM votes ORDER BY submitted_at ASC').toArray();
    const newRoundId = meta.current_round_id + 1;
    const agreedAt = Date.now();

    sql.exec(
      `INSERT INTO rounds (round_id, topic, consensus_value, agreed_at) VALUES (?, ?, NULL, ?)`,
      newRoundId,
      meta.topic ?? null,
      agreedAt,
    );
    for (const v of currentVotes) {
      sql.exec(
        `INSERT INTO round_votes (round_id, user_id, value, confidence, reasoning, submitted_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        newRoundId,
        v.user_id,
        v.value,
        v.confidence,
        v.reasoning ?? null,
        v.submitted_at,
      );
    }
    sql.exec('DELETE FROM votes');
    sql.exec(
      "UPDATE meta SET phase = 'revealed', current_round_id = ? WHERE id = 'singleton'",
      newRoundId,
    );

    return {
      topic: meta.topic ?? undefined,
      votes: currentVotes.map((v) => this.toVote(v)),
      consensusValue: undefined,
      agreedAt,
    };
  }

  async startNextRound(params?: { topic?: string }): Promise<RoomState> {
    await this.ensureSchema();
    const sql = this.ctx.storage.sql;
    const meta = sql.exec<MetaRow>("SELECT phase FROM meta WHERE id = 'singleton'").toArray()[0];
    if (!meta || meta.phase !== 'revealed') throw new Error('ROOM_NOT_IN_REVEALED_PHASE');
    sql.exec(
      "UPDATE meta SET phase = 'voting', topic = ? WHERE id = 'singleton'",
      params?.topic ?? null,
    );
    return this.getState();
  }

  async closeRoom(): Promise<void> {
    await this.ensureSchema();
    this.ctx.storage.sql.exec("UPDATE meta SET phase = 'closed' WHERE id = 'singleton'");
  }

  private toVote(row: VoteRow): Vote {
    return {
      userId: row.user_id,
      value: row.value,
      confidence: row.confidence as Confidence,
      reasoning: row.reasoning ?? undefined,
      submittedAt: row.submitted_at,
    };
  }
}
