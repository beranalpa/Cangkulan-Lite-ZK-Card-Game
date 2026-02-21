/**
 * Lobby WebSocket Client Service
 *
 * Manages the connection to the lobby relay server for real-time features:
 *   - Player presence (who's online in the lobby)
 *   - Matchmaking queue (find opponent automatically)
 *   - Game invites (challenge specific players)
 *   - Lobby chat
 *
 * Designed as a singleton — one connection per session.
 * Auto-reconnects with exponential backoff on disconnect.
 */

import { log } from '@/utils/logger';

// ── Types ──────────────────────────────────────────────────────────────────

export interface LobbyPlayer {
  address: string;
  name?: string;
  joinedAt: number;
  status: 'idle' | 'in-queue' | 'in-game';
}

export interface ChatMessage {
  from: string;
  fromName?: string;
  text: string;
  timestamp: number;
}

export interface MatchFound {
  matchId: string;
  opponent: string;
  role: 'player1' | 'player2';
}

export interface InviteReceived {
  from: string;
  fromName?: string;
  sessionId?: number;
}

export type LobbyEventType =
  | 'connected'
  | 'disconnected'
  | 'presence'
  | 'chat'
  | 'match-found'
  | 'queue-joined'
  | 'queue-left'
  | 'invite-received'
  | 'invite-accepted'
  | 'invite-sent'
  | 'game-started'
  | 'kicked'
  | 'error'
  | 'room-created'
  | 'room-updated'
  | 'room-list'
  | 'room-chat'
  | 'room-closed'
  | 'room-game-start';

export interface LobbyEventMap {
  connected: undefined;
  disconnected: { reason?: string };
  presence: { players: LobbyPlayer[] };
  chat: ChatMessage;
  'match-found': MatchFound;
  'queue-joined': { position: number };
  'queue-left': undefined;
  'invite-received': InviteReceived;
  'invite-accepted': { by: string; sessionId?: number };
  'invite-sent': { target: string };
  'game-started': { sessionId: number; player1: string; player2: string };
  kicked: { reason: string };
  error: { message: string };
  'room-created': { room: any };
  'room-updated': { room: any };
  'room-list': { rooms: any[] };
  'room-chat': { from: string; fromName?: string; text: string; timestamp: number };
  'room-closed': { roomId: string; reason: string };
  'room-game-start': { roomId: string; sessionId: number };
}

type LobbyListener<T extends LobbyEventType> = (data: LobbyEventMap[T]) => void;

// ── Default WS URL ─────────────────────────────────────────────────────────

function getDefaultWsUrl(): string {
  // In dev, connect to local server. In prod, use relative or configured URL.
  const envUrl = typeof import.meta !== 'undefined'
    ? (import.meta as any).env?.VITE_WS_LOBBY_URL
    : undefined;
  if (envUrl) return envUrl;

  // Default: same host, /ws path (nginx proxies to local Bun WS server)
  // In dev (http), use ws://localhost:8787/ws directly.
  const proto = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = globalThis.location?.hostname || 'localhost';
  if (globalThis.location?.protocol === 'https:') {
    // Production: nginx reverse-proxies /ws → localhost:8787
    return `${proto}//${host}/ws`;
  }
  return `${proto}//${host}:8787/ws`;
}

// ── Lobby Socket Service ───────────────────────────────────────────────────

export class LobbySocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private userAddress: string = '';
  private userName?: string;
  private listeners = new Map<string, Set<Function>>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _destroyed = false;

  constructor(url?: string) {
    this.url = url || getDefaultWsUrl();
  }

  /** Whether the socket is currently connected */
  get connected(): boolean {
    return this._connected;
  }

  /** Connect to the lobby server */
  connect(address: string, name?: string): void {
    if (this._destroyed) return;
    this.userAddress = address;
    this.userName = name;
    this.doConnect();
  }

  /** Disconnect and clean up */
  disconnect(): void {
    this._destroyed = true;
    this.stopHeartbeat();
    this.stopReconnect();
    if (this.ws) {
      try { this.ws.close(1000, 'user-disconnect'); } catch {}
      this.ws = null;
    }
    this._connected = false;
  }

  /** Subscribe to a lobby event */
  on<T extends LobbyEventType>(event: T, listener: LobbyListener<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  /** Send join matchmaking queue */
  joinQueue(): void {
    this.send({ type: 'queue-join' });
  }

  /** Leave matchmaking queue */
  leaveQueue(): void {
    this.send({ type: 'queue-leave' });
  }

  /** Send a direct game invite to a player */
  invite(targetAddress: string, sessionId?: number): void {
    this.send({ type: 'invite', payload: { target: targetAddress, sessionId } });
  }

  /** Accept a game invite */
  acceptInvite(fromAddress: string, sessionId?: number): void {
    this.send({ type: 'invite-accept', payload: { from: fromAddress, sessionId } });
  }

  /** Send a chat message to the lobby */
  chat(text: string): void {
    if (!text.trim()) return;
    this.send({ type: 'chat', payload: { text: text.trim().slice(0, 200) } });
  }

  /** Notify lobby that a game was started */
  notifyGameStarted(sessionId: number, player1: string, player2: string): void {
    this.send({ type: 'game-started', payload: { sessionId, player1, player2 } });
  }

  /** Notify lobby that a game ended (player returns to idle) */
  notifyGameEnded(): void {
    this.send({ type: 'game-ended' });
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private doConnect(): void {
    if (this._destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      log.warn('[LobbyWS] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      log.info('[LobbyWS] Connected to', this.url);
      this._connected = true;
      this.reconnectAttempts = 0;

      // Wait for auth-challenge before joining
      // The join will be triggered in handleMessage when challenge arrives

      this.startHeartbeat();
      this.emit('connected', undefined as any);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        log.warn('[LobbyWS] Parse error:', err);
      }
    };

    this.ws.onclose = (event) => {
      log.info('[LobbyWS] Disconnected:', event.code, event.reason);
      this._connected = false;
      this.stopHeartbeat();
      this.emit('disconnected', { reason: event.reason || 'connection-closed' });

      if (!this._destroyed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this; just log
      log.warn('[LobbyWS] Connection error');
    };
  }

  private handleMessage(msg: { type: string; payload?: any }): void {
    switch (msg.type) {
      case 'auth-challenge': {
        // Server sent challenge nonce — respond with join + challenge
        const challenge = msg.payload?.challenge;
        if (challenge && this.userAddress) {
          log.info('[LobbyWS] Auth challenge received, joining with nonce');
          this.send({
            type: 'join',
            payload: { address: this.userAddress, name: this.userName, challenge },
          });
        }
        break;
      }
      case 'joined':
      case 'presence':
        this.emit('presence', msg.payload);
        break;
      case 'chat':
        this.emit('chat', msg.payload);
        break;
      case 'match-found':
        this.emit('match-found', msg.payload);
        break;
      case 'queue-joined':
        this.emit('queue-joined', msg.payload);
        break;
      case 'queue-left':
        this.emit('queue-left', undefined as any);
        break;
      case 'invite-received':
        this.emit('invite-received', msg.payload);
        break;
      case 'invite-accepted':
        this.emit('invite-accepted', msg.payload);
        break;
      case 'invite-sent':
        this.emit('invite-sent', msg.payload);
        break;
      case 'game-started':
        this.emit('game-started', msg.payload);
        break;
      case 'kicked':
        this.emit('kicked', msg.payload);
        this.disconnect();
        break;
      case 'error':
        this.emit('error', msg.payload);
        break;
      case 'room-created':
        this.emit('room-created', msg.payload);
        break;
      case 'room-updated':
        this.emit('room-updated', msg.payload);
        break;
      case 'room-list':
        this.emit('room-list', msg.payload);
        break;
      case 'room-chat':
        this.emit('room-chat', msg.payload);
        break;
      case 'room-closed':
        this.emit('room-closed', msg.payload);
        break;
      case 'room-game-start':
        this.emit('room-game-start', msg.payload);
        break;
      case 'pong':
        // heartbeat response — do nothing
        break;
    }
  }

  private emit<T extends LobbyEventType>(event: T, data: LobbyEventMap[T]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        try { (fn as any)(data); } catch (err) {
          log.warn(`[LobbyWS] Listener error on ${event}:`, err);
        }
      }
    }
  }

  private send(msg: { type: string; payload?: any }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Public send for room system and extensions */
  public sendMessage(msg: { type: string; payload?: any }): void {
    this.send(msg);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this._destroyed || this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.warn('[LobbyWS] Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    log.info(`[LobbyWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/** Singleton instance */
let _instance: LobbySocketService | null = null;

export function getLobbySocket(): LobbySocketService {
  if (!_instance) {
    _instance = new LobbySocketService();
    // Module-scoped access only — no window global to prevent XSS exploitation.
    // Use getLobbySocket() import instead of window.__lobbySocket.
    if (import.meta.env.DEV) {
      // Debug access in dev only
      (window as any).__lobbySocket_debug = {
        on: (event: string, listener: Function) => _instance!.on(event as any, listener as any),
        send: (msg: { type: string; payload?: any }) => _instance!.sendMessage(msg),
      };
    }
  }
  return _instance;
}

/**
 * Get a controlled interface for the lobby socket (for room system usage).
 * This replaces the old window.__lobbySocket global.
 */
export function getLobbySocketInterface() {
  const instance = getLobbySocket();
  return {
    on: (event: string, listener: Function) => instance.on(event as any, listener as any),
    send: (msg: { type: string; payload?: any }) => instance.sendMessage(msg),
  };
}

export function resetLobbySocket(): void {
  if (_instance) {
    _instance.disconnect();
    _instance = null;
  }
}
