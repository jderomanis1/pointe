import type {
  AiSharedPayload, ClientMessageType, DeltaPayload, Envelope, ErrorPayload,
  HostReclaimedPayload, HostVacantPayload, JoinRoomPayload, RoomSnapshot, ServerMessageType,
} from '@pointe/shared';
import { PROTOCOL_VERSION } from '@pointe/shared';
import type { ConnectionStatus } from '../store/types';

/** Store actions the client drives. Drive the store through these — never reach into internals. */
export type StoreHooks = {
  hydrate: (snapshot: RoomSnapshot) => void;
  applyServerDelta: (payload: DeltaPayload) => void;
  applyHostVacant: (payload: HostVacantPayload) => void;
  applyHostReclaimed: (payload: HostReclaimedPayload) => void;
  applyAiShared: (payload: AiSharedPayload) => void;
  setConnection: (status: ConnectionStatus) => void;
};

/**
 * Minimal WebSocket surface the client uses. Lets tests inject a fake.
 * Mirrors the browser/Node `WebSocket` shape — readyState constants + event listeners + send/close.
 */
export type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends 'open' | 'message' | 'close' | 'error'>(
    type: K,
    listener: K extends 'message' ? (e: { data: string }) => void : (e?: unknown) => void,
  ): void;
};

export type WsClientOptions = {
  wsUrl: string;
  /** JOIN payload sent on every (re)connect. `resumeVoterId` is auto-filled once known. */
  join: JoinRoomPayload;
  store: StoreHooks;
  /** Called when the server sends ERROR — logical error, socket stays open. */
  onError?: (err: ErrorPayload, envelope: Envelope) => void;
  /** Base delay (ms) before first reconnect attempt. Default 500. */
  baseBackoffMs?: number;
  /** Upper cap (ms) on the exponential backoff. Default 15000. */
  maxBackoffMs?: number;
  /** Reconnect on unintentional close. Default true. */
  reconnect?: boolean;
  /** Send RECONNECT_PING every N ms when connected. null disables. Default 25000. */
  keepaliveMs?: number | null;
  /** Inject a WebSocket constructor for tests. Defaults to the global one. */
  webSocketFactory?: (url: string) => WsLike;
  /** Inject Math.random for deterministic jitter in tests. */
  random?: () => number;
};

const WS_OPEN = 1; // WebSocket.OPEN — matches both browser and node ws

/**
 * Browser WebSocket client that drives the R4.ii store from the live wire.
 *
 *  - JOIN_ROOM on open → SNAPSHOT_RESPONSE → store.hydrate, capture voterId for resume.
 *  - DELTA → store.applyServerDelta.
 *  - ERROR → onError callback (socket stays open — logical errors don't tear down).
 *  - On unintentional close: setConnection('reconnecting'), exponential backoff + jitter,
 *    reconnect re-runs JOIN_ROOM with resumeVoterId so the server rebinds the same voter.
 *  - On successful SNAPSHOT: reset backoff, setConnection('connected'), start keepalive.
 *  - disconnect() → intentional, no reconnect.
 */
export class RoomWsClient {
  private opts: Required<Omit<WsClientOptions, 'onError'>> & Pick<WsClientOptions, 'onError'>;
  private ws: WsLike | null = null;
  private intentional = false;
  private voterId: string | null = null;
  private attempt = 0;
  private outbound: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WsClientOptions) {
    this.opts = {
      baseBackoffMs: 500,
      maxBackoffMs: 15_000,
      reconnect: true,
      keepaliveMs: 25_000,
      webSocketFactory: (url) => new WebSocket(url) as unknown as WsLike,
      random: Math.random,
      ...opts,
    };
    this.connect();
  }

  /** Build an envelope and send it (queued if the socket isn't open yet). */
  send(type: ClientMessageType, payload: unknown): void {
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      type,
      id: cryptoRandomId(),
      at: Date.now(),
      payload,
    };
    const raw = JSON.stringify(env);
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(raw);
    } else {
      this.outbound.push(raw);
    }
  }

  /** Intentional disconnect — no reconnect, no further state changes. */
  disconnect(): void {
    this.intentional = true;
    this.clearReconnect();
    this.clearKeepalive();
    this.outbound = [];
    if (this.ws) {
      try { this.ws.close(1000, 'client disconnect'); } catch { /* ignore */ }
    }
    this.opts.store.setConnection('disconnected');
  }

  /** For tests + future telemetry. */
  getRetainedVoterId(): string | null { return this.voterId; }

  private connect(): void {
    this.opts.store.setConnection(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WsLike;
    try {
      ws = this.opts.webSocketFactory(this.opts.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => this.onOpen());
    ws.addEventListener('message', (e) => this.onMessage(e.data));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => { /* surfaces as close */ });
  }

  private onOpen(): void {
    // Send JOIN first; the JOIN reply gates the 'connected' state. Then flush any queued sends.
    const join: JoinRoomPayload = {
      ...this.opts.join,
      ...(this.voterId ? { resumeVoterId: this.voterId } : {}),
    };
    this.send('JOIN_ROOM', join);
    // Queue flush waits until after JOIN so re-cast votes etc. arrive after the rebind.
    while (this.outbound.length > 0 && this.ws?.readyState === WS_OPEN) {
      const next = this.outbound.shift();
      if (next) this.ws.send(next);
    }
  }

  private onMessage(raw: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return; // ignore garbage
    }
    const type = env.type as ServerMessageType;
    switch (type) {
      case 'SNAPSHOT_RESPONSE': {
        const snap = env.payload as RoomSnapshot;
        this.voterId = snap.you.voterId;
        this.opts.store.hydrate(snap);
        this.opts.store.setConnection('connected');
        this.attempt = 0; // backoff resets on successful JOIN
        this.startKeepalive();
        break;
      }
      case 'DELTA':
        this.opts.store.applyServerDelta(env.payload as DeltaPayload);
        break;
      case 'PONG':
        // Keepalive ack — liveness signal only.
        break;
      case 'ERROR':
        if (this.opts.onError) this.opts.onError(env.payload as ErrorPayload, env);
        // Logical error — socket stays open.
        break;
      case 'HOST_VACANT':
        this.opts.store.applyHostVacant(env.payload as HostVacantPayload);
        break;
      case 'HOST_RECLAIMED':
        this.opts.store.applyHostReclaimed(env.payload as HostReclaimedPayload);
        break;
      case 'AI_SHARED':
        // S8.iv.c2: the only sanctioned path that crosses `ai` to a voter.
        // The reducer sets story.ai on the matching story for all viewers.
        this.opts.store.applyAiShared(env.payload as AiSharedPayload);
        break;
      default:
        // Unknown server message — ignore for forward compat.
        break;
    }
  }

  private onClose(): void {
    this.ws = null;
    this.clearKeepalive();
    if (this.intentional || !this.opts.reconnect) {
      this.opts.store.setConnection('disconnected');
      return;
    }
    this.opts.store.setConnection('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    // Full-jitter exponential backoff: delay = random(0, min(cap, base * 2^attempt))
    const ceiling = Math.min(
      this.opts.maxBackoffMs,
      this.opts.baseBackoffMs * Math.pow(2, this.attempt),
    );
    const delay = Math.floor(this.opts.random() * ceiling);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startKeepalive(): void {
    this.clearKeepalive();
    if (this.opts.keepaliveMs === null) return;
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WS_OPEN) this.send('RECONNECT_PING', {});
    }, this.opts.keepaliveMs);
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}

function cryptoRandomId(): string {
  // Available globally in Node 22 + all modern browsers; safe to call.
  return crypto.randomUUID();
}
