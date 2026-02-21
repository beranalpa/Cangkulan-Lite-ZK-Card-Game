/**
 * WebSocket Lobby Relay Server
 *
 * Lightweight Bun WebSocket server for real-time lobby features:
 *   - Player presence (who's online)
 *   - Matchmaking queue (find opponent)
 *   - Game invites (challenge a player)
 *   - Lobby chat
 *   - Room system (create/join/spectate public & private rooms)
 *
 * Run:  bun run scripts/ws-lobby.ts
 * Port: WS_LOBBY_PORT env var, default 8787
 *
 * Protocol: JSON messages with { type, payload } shape.
 * This is a stateless relay — no persistence. All game state is on-chain.
 */

const PORT = parseInt(process.env.WS_LOBBY_PORT || '8787', 10);

// ── Types ──────────────────────────────────────────────────────────────────

import type { ServerWebSocket } from 'bun';

interface WsData {
  connectedAt: number;
  challenge?: string;
  authenticated?: boolean;
}

type WS = ServerWebSocket<WsData>;

interface PlayerInfo {
  address: string;
  name?: string;
  joinedAt: number;
  status: 'idle' | 'in-queue' | 'in-game';
}

interface WsMessage {
  type: string;
  payload?: any;
}

// ── Room Types ─────────────────────────────────────────────────────────────

interface RoomPlayer {
  address: string;
  name?: string;
}

interface Room {
  id: string;
  inviteCode: string;
  host: RoomPlayer;
  guest: RoomPlayer | null;
  spectators: RoomPlayer[];
  type: 'public' | 'private';
  betAmount: number;
  zkMode: string;
  sessionId: number;
  status: 'waiting' | 'starting' | 'playing' | 'ended';
  chat: Array<{ from: string; fromName?: string; text: string; timestamp: number }>;
  createdAt: number;
  hostWs: WS | null;
  guestWs: WS | null;
  spectatorWs: WS[];
}

// ── State ──────────────────────────────────────────────────────────────────

const clients = new Map<WS, PlayerInfo>();
const matchQueue: WS[] = [];
const rooms = new Map<string, Room>();

// Rate limiting: track connection timestamps per IP
const ipConnectionLog = new Map<string, number[]>();
const MAX_CONNECTIONS_PER_WINDOW = 5;
const RATE_WINDOW_MS = 10_000; // 10 seconds

// Message rate limiting per connected client
const messageTimestamps = new Map<WS, number[]>();
const MAX_MESSAGES_PER_SECOND = 10;

// Allowed origins for WebSocket connections (configurable via env)
const ALLOWED_ORIGINS = (process.env.WS_ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:4173,http://localhost:3000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Periodic cleanup interval for rate-limit maps (prevent memory leak)
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000; // 1 minute
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of ipConnectionLog) {
    const recent = timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) {
      ipConnectionLog.delete(ip);
    } else {
      ipConnectionLog.set(ip, recent);
    }
  }
  // Clean up disconnected client message timestamps
  for (const [ws] of messageTimestamps) {
    if (!clients.has(ws)) {
      messageTimestamps.delete(ws);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

function isRateLimited(ws: WS): boolean {
  const now = Date.now();
  const timestamps = messageTimestamps.get(ws) || [];
  const recent = timestamps.filter(t => now - t < 1000);
  recent.push(now);
  messageTimestamps.set(ws, recent);
  return recent.length > MAX_MESSAGES_PER_SECOND;
}

function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = ipConnectionLog.get(ip) || [];
  const recent = timestamps.filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  ipConnectionLog.set(ip, recent);
  return recent.length > MAX_CONNECTIONS_PER_WINDOW;
}

// Challenge nonce generation
function generateChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Room auto-cleanup interval (10 min TTL for waiting rooms)
const ROOM_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.status === 'waiting' && now - room.createdAt > ROOM_TTL_MS) {
      // Notify host
      if (room.hostWs) {
        send(room.hostWs, { type: 'room-closed', payload: { roomId: id, reason: 'timeout' } });
      }
      rooms.delete(id);
      broadcastRoomList();
    }
  }
}, 30000);

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId(length = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (const b of bytes) result += chars[b % chars.length];
  return result;
}

function broadcast(msg: WsMessage, exclude?: WS) {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws !== exclude) {
      ws.send(data);
    }
  }
}

function send(ws: WS, msg: WsMessage) {
  ws.send(JSON.stringify(msg));
}

function getOnlinePlayers(): PlayerInfo[] {
  return Array.from(clients.values());
}

function removeFromQueue(ws: WS) {
  const idx = matchQueue.indexOf(ws);
  if (idx !== -1) matchQueue.splice(idx, 1);
}

function broadcastPresence() {
  broadcast({ type: 'presence', payload: { players: getOnlinePlayers() } });
}

function findWsByAddress(address: string): WS | undefined {
  for (const [ws, info] of clients) {
    if (info.address === address) return ws;
  }
  return undefined;
}

// ── Room Helpers ───────────────────────────────────────────────────────────

function roomToClient(room: Room): any {
  return {
    id: room.id,
    inviteCode: room.inviteCode,
    host: room.host,
    guest: room.guest,
    spectators: room.spectators,
    type: room.type,
    betAmount: room.betAmount,
    zkMode: room.zkMode,
    sessionId: room.sessionId,
    status: room.status,
    createdAt: room.createdAt,
  };
}

function getPublicRoomList(): any[] {
  const list: any[] = [];
  for (const [, room] of rooms) {
    if (room.type === 'public' && room.status === 'waiting') {
      list.push({
        id: room.id,
        host: room.host,
        type: room.type,
        betAmount: room.betAmount,
        zkMode: room.zkMode,
        spectatorCount: room.spectators.length,
        createdAt: room.createdAt,
      });
    }
  }
  return list;
}

function broadcastRoomList() {
  broadcast({ type: 'room-list', payload: { rooms: getPublicRoomList() } });
}

function broadcastToRoom(room: Room, msg: WsMessage, exclude?: WS) {
  const data = JSON.stringify(msg);
  if (room.hostWs && room.hostWs !== exclude) room.hostWs.send(data);
  if (room.guestWs && room.guestWs !== exclude) room.guestWs.send(data);
  for (const sw of room.spectatorWs) {
    if (sw !== exclude) sw.send(data);
  }
}

function removePlayerFromRooms(ws: WS) {
  const info = clients.get(ws);
  if (!info) return;
  for (const [id, room] of rooms) {
    if (room.hostWs === ws) {
      // Host left — close the room
      broadcastToRoom(room, { type: 'room-closed', payload: { roomId: id, reason: 'host_left' } }, ws);
      rooms.delete(id);
      broadcastRoomList();
    } else if (room.guestWs === ws) {
      room.guest = null;
      room.guestWs = null;
      if (room.status === 'starting' || room.status === 'playing') {
        room.status = 'waiting';
      }
      broadcastToRoom(room, { type: 'room-updated', payload: { room: roomToClient(room) } });
    } else {
      const specIdx = room.spectatorWs.indexOf(ws);
      if (specIdx !== -1) {
        room.spectatorWs.splice(specIdx, 1);
        room.spectators = room.spectators.filter(s => s.address !== info.address);
        broadcastToRoom(room, { type: 'room-updated', payload: { room: roomToClient(room) } });
      }
    }
  }
}

// ── Match Queue ────────────────────────────────────────────────────────────

function tryMatch(ws: WS): boolean {
  // Find another player in queue who is not this player
  const info = clients.get(ws);
  if (!info) return false;

  for (let i = 0; i < matchQueue.length; i++) {
    const candidate = matchQueue[i];
    if (candidate === ws) continue;
    const cInfo = clients.get(candidate);
    if (!cInfo) {
      matchQueue.splice(i, 1);
      i--;
      continue;
    }

    // Match found!
    matchQueue.splice(i, 1);
    removeFromQueue(ws);

    info.status = 'in-game';
    cInfo.status = 'in-game';

    const matchId = `match-${Date.now()}`;
    const sessionIdBuf = new Uint32Array(1);
    crypto.getRandomValues(sessionIdBuf);
    const sessionId = sessionIdBuf[0] || Date.now();

    send(ws, {
      type: 'match-found',
      payload: { matchId, sessionId, opponent: cInfo.address, role: 'player1' },
    });
    send(candidate, {
      type: 'match-found',
      payload: { matchId, sessionId, opponent: info.address, role: 'player2' },
    });

    broadcastPresence();
    return true;
  }
  return false;
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = Bun.serve<WsData>({
  port: PORT,
  fetch(req, server) {
    // Upgrade to WebSocket
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      // Origin validation — reject connections from unknown origins
      const origin = req.headers.get('origin') || '';
      if (origin && ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
        console.warn(`[WS] Rejected connection from disallowed origin: ${origin}`);
        return new Response('Forbidden origin', { status: 403 });
      }

      // Rate-limit connections per IP
      const ip = server.requestIP(req)?.address || 'unknown';
      if (isIpRateLimited(ip)) {
        return new Response('Too many connections', { status: 429 });
      }
      const challenge = generateChallenge();
      const upgraded = server.upgrade(req, {
        data: { connectedAt: Date.now(), challenge, authenticated: false },
      });
      if (upgraded) return;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          players: clients.size,
          queue: matchQueue.length,
          uptime: process.uptime(),
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response('Cangkulan Lobby WS — connect to /ws', { status: 200 });
  },

  websocket: {
    open(ws: WS) {
      // Send auth challenge — client must echo it back in 'join'
      const challenge = ws.data.challenge;
      send(ws, { type: 'auth-challenge', payload: { challenge } });
      console.log(`[WS] Connection opened, challenge sent (${clients.size + 1} total)`);
    },

    message(ws: WS, message: string | Buffer) {
      try {
        // Per-message rate limiting
        if (isRateLimited(ws)) {
          send(ws, { type: 'error', payload: { message: 'rate limited' } });
          return;
        }

        const raw = typeof message === 'string' ? message : message.toString();
        const msg: WsMessage = JSON.parse(raw);

        switch (msg.type) {
          // ── Join lobby ──────────────────────────────────────────────
          case 'join': {
            const address = msg.payload?.address;
            if (!address || typeof address !== 'string') {
              send(ws, { type: 'error', payload: { message: 'address required' } });
              return;
            }

            // Verify challenge-response nonce
            const clientChallenge = msg.payload?.challenge;
            const serverChallenge = ws.data.challenge;
            if (!serverChallenge || clientChallenge !== serverChallenge) {
              send(ws, { type: 'error', payload: { message: 'invalid challenge response' } });
              return;
            }

            // Validate Stellar address format (G... 56 chars)
            if (!/^G[A-Z2-7]{55}$/.test(address)) {
              send(ws, { type: 'error', payload: { message: 'invalid Stellar address' } });
              return;
            }

            // Challenge consumed — prevent replay
            ws.data.challenge = undefined;
            ws.data.authenticated = true;

            // Check if address already connected
            for (const [existingWs, info] of clients) {
              if (info.address === address && existingWs !== ws) {
                // Kick old connection
                send(existingWs, { type: 'kicked', payload: { reason: 'duplicate' } });
                clients.delete(existingWs);
                removeFromQueue(existingWs);
                try { existingWs.close(); } catch { }
              }
            }

            clients.set(ws, {
              address,
              name: msg.payload?.name,
              joinedAt: Date.now(),
              status: 'idle',
            });

            send(ws, {
              type: 'joined',
              payload: { players: getOnlinePlayers() },
            });
            broadcastPresence();
            console.log(`[WS] ${address.slice(0, 8)}… joined (${clients.size} online)`);
            break;
          }

          // ── Enter matchmaking queue ─────────────────────────────────
          case 'queue-join': {
            const info = clients.get(ws);
            if (!info) return;
            if (info.status === 'in-queue') return;

            info.status = 'in-queue';
            matchQueue.push(ws);
            send(ws, { type: 'queue-joined', payload: { position: matchQueue.length } });
            broadcastPresence();

            // Try immediate match
            tryMatch(ws);
            break;
          }

          // ── Leave matchmaking queue ─────────────────────────────────
          case 'queue-leave': {
            const info = clients.get(ws);
            if (!info) return;
            removeFromQueue(ws);
            info.status = 'idle';
            send(ws, { type: 'queue-left' });
            broadcastPresence();
            break;
          }

          // ── Direct invite ───────────────────────────────────────────
          case 'invite': {
            const fromInfo = clients.get(ws);
            if (!fromInfo) return;
            const targetAddr = msg.payload?.target;
            if (!targetAddr) return;

            // Find target socket
            for (const [targetWs, tInfo] of clients) {
              if (tInfo.address === targetAddr) {
                send(targetWs, {
                  type: 'invite-received',
                  payload: {
                    from: fromInfo.address,
                    fromName: fromInfo.name,
                    sessionId: msg.payload?.sessionId,
                  },
                });
                send(ws, { type: 'invite-sent', payload: { target: targetAddr } });
                break;
              }
            }
            break;
          }

          // ── Accept invite ───────────────────────────────────────────
          case 'invite-accept': {
            const acceptInfo = clients.get(ws);
            if (!acceptInfo) return;
            const fromAddr = msg.payload?.from;

            for (const [fromWs, fInfo] of clients) {
              if (fInfo.address === fromAddr) {
                send(fromWs, {
                  type: 'invite-accepted',
                  payload: { by: acceptInfo.address, sessionId: msg.payload?.sessionId },
                });
                break;
              }
            }
            break;
          }

          // ── Chat message ────────────────────────────────────────────
          case 'chat': {
            const chatInfo = clients.get(ws);
            if (!chatInfo) return;
            // Sanitize: strip control chars, limit length
            const rawText = typeof msg.payload?.text === 'string' ? msg.payload.text : '';
            const text = rawText.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
            if (!text) return;

            broadcast(
              {
                type: 'chat',
                payload: {
                  from: chatInfo.address,
                  fromName: chatInfo.name,
                  text,
                  timestamp: Date.now(),
                },
              },
              // Don't exclude sender — they'll see it echoed back as confirmation
            );
            break;
          }

          // ── Game started (notify lobby) ─────────────────────────────
          case 'game-started': {
            const gsInfo = clients.get(ws);
            if (!gsInfo) return;
            gsInfo.status = 'in-game';
            broadcast({
              type: 'game-started',
              payload: {
                sessionId: msg.payload?.sessionId,
                player1: msg.payload?.player1,
                player2: msg.payload?.player2,
              },
            });
            broadcastPresence();
            break;
          }

          // ── Game ended (player returns to idle) ─────────────────────
          case 'game-ended': {
            const geInfo = clients.get(ws);
            if (!geInfo) return;
            geInfo.status = 'idle';
            broadcastPresence();
            break;
          }

          // ══════════════════════════════════════════════════════════════
          //  Room System
          // ══════════════════════════════════════════════════════════════

          // ── Create Room ─────────────────────────────────────────────
          case 'create-room': {
            const crInfo = clients.get(ws);
            if (!crInfo) return;

            // Validate inputs
            const roomType = msg.payload?.type === 'private' ? 'private' : 'public';
            const rawBet = Number(msg.payload?.betAmount);
            const betAmount = Number.isFinite(rawBet) && rawBet >= 0 && rawBet <= 1_000_000 ? rawBet : 0;
            const rawZkMode = typeof msg.payload?.zkMode === 'string' ? msg.payload.zkMode.slice(0, 20) : 'auto';
            const zkMode = /^[a-zA-Z0-9_-]+$/.test(rawZkMode) ? rawZkMode : 'auto';

            const roomId = generateId(6);
            const inviteCode = generateId(8);
            const sessionIdBuf = new Uint32Array(1);
            crypto.getRandomValues(sessionIdBuf);
            const sessionId = sessionIdBuf[0] || Date.now();

            const room: Room = {
              id: roomId,
              inviteCode,
              host: { address: crInfo.address, name: crInfo.name },
              guest: null,
              spectators: [],
              type: roomType,
              betAmount,
              zkMode,
              sessionId,
              status: 'waiting',
              chat: [],
              createdAt: Date.now(),
              hostWs: ws,
              guestWs: null,
              spectatorWs: [],
            };

            rooms.set(roomId, room);
            crInfo.status = 'in-game';
            removeFromQueue(ws); // Ensure they leave matchmaking queue

            send(ws, { type: 'room-created', payload: { room: roomToClient(room) } });
            broadcastRoomList();
            broadcastPresence();
            console.log(`[WS] Room #${roomId} created by ${crInfo.address.slice(0, 8)}… (${room.type})`);
            break;
          }

          // ── Join Room ───────────────────────────────────────────────
          case 'join-room': {
            const jrInfo = clients.get(ws);
            if (!jrInfo) return;

            const targetRoomId = msg.payload?.roomId;
            const targetCode = msg.payload?.inviteCode;

            let room: Room | undefined;

            if (targetRoomId) {
              room = rooms.get(targetRoomId);
            } else if (targetCode) {
              for (const [, r] of rooms) {
                if (r.inviteCode === targetCode && r.status === 'waiting') {
                  room = r;
                  break;
                }
              }
            }

            if (!room) {
              send(ws, { type: 'error', payload: { message: 'Room not found or no longer available' } });
              break;
            }
            if (room.status !== 'waiting') {
              send(ws, { type: 'error', payload: { message: 'Room is no longer waiting for players' } });
              break;
            }
            if (room.host.address === jrInfo.address) {
              send(ws, { type: 'error', payload: { message: 'Cannot join your own room' } });
              break;
            }

            // Join as guest
            room.guest = { address: jrInfo.address, name: jrInfo.name };
            room.guestWs = ws;
            room.status = 'starting';
            jrInfo.status = 'in-game';
            removeFromQueue(ws); // Ensure guest leaves matchmaking queue

            // Notify room members
            broadcastToRoom(room, { type: 'room-updated', payload: { room: roomToClient(room) } });

            // Auto-start game after brief delay
            setTimeout(() => {
              const currentRoom = rooms.get(room!.id);
              if (currentRoom && currentRoom.status === 'starting' && currentRoom.guestWs) {
                currentRoom.status = 'playing';
                broadcastToRoom(currentRoom, { type: 'room-game-start', payload: { roomId: currentRoom.id, sessionId: currentRoom.sessionId } });
                broadcastToRoom(currentRoom, { type: 'room-updated', payload: { room: roomToClient(currentRoom) } });
              }
            }, 1000); // Reduced to 1s for better snappiness

            broadcastRoomList();
            broadcastPresence();
            console.log(`[WS] ${jrInfo.address.slice(0, 8)}… joined room #${room.id}`);
            break;
          }

          // ── Spectate Room ───────────────────────────────────────────
          case 'spectate-room': {
            const srInfo = clients.get(ws);
            if (!srInfo) return;
            const room = rooms.get(msg.payload?.roomId);
            if (!room) {
              send(ws, { type: 'error', payload: { message: 'Room not found' } });
              break;
            }
            room.spectators.push({ address: srInfo.address, name: srInfo.name });
            room.spectatorWs.push(ws);
            broadcastToRoom(room, { type: 'room-updated', payload: { room: roomToClient(room) } });
            break;
          }

          // ── Leave Room ──────────────────────────────────────────────
          case 'leave-room': {
            const lrInfo = clients.get(ws);
            if (!lrInfo) return;
            const roomId = msg.payload?.roomId;
            const room = rooms.get(roomId);
            if (!room) break;

            if (room.hostWs === ws) {
              // Host leaving — close room
              broadcastToRoom(room, { type: 'room-closed', payload: { roomId, reason: 'host_left' } }, ws);
              rooms.delete(roomId);
            } else if (room.guestWs === ws) {
              room.guest = null;
              room.guestWs = null;
              room.status = 'waiting';

              // Host is still in room but room is now waiting, 
              // we keep host in 'in-game' status as they are tied to a room.

              broadcastToRoom(room, { type: 'room-updated', payload: { room: roomToClient(room) } });
            } else {
              const specIdx = room.spectatorWs.indexOf(ws);
              if (specIdx !== -1) {
                room.spectatorWs.splice(specIdx, 1);
                room.spectators = room.spectators.filter(s => s.address !== lrInfo.address);
                broadcastToRoom(room, { type: 'room-updated', payload: { room: roomToClient(room) } });
              }
            }
            lrInfo.status = 'idle';
            broadcastRoomList();
            broadcastPresence();
            break;
          }

          // ── Room Chat ───────────────────────────────────────────────
          case 'room-chat': {
            const rcInfo = clients.get(ws);
            if (!rcInfo) return;
            const room = rooms.get(msg.payload?.roomId);
            if (!room) break;
            // Sanitize: strip control chars, limit length
            const rawText = typeof msg.payload?.text === 'string' ? msg.payload.text : '';
            const text = rawText.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
            if (!text) break;

            const chatMsg = { from: rcInfo.address, fromName: rcInfo.name, text, timestamp: Date.now() };
            room.chat.push(chatMsg);
            if (room.chat.length > 50) room.chat.shift();

            broadcastToRoom(room, { type: 'room-chat', payload: chatMsg });
            break;
          }

          // ── Room List Request ────────────────────────────────────────
          case 'room-list': {
            send(ws, { type: 'room-list', payload: { rooms: getPublicRoomList() } });
            break;
          }

          // ── Heartbeat ───────────────────────────────────────────────
          case 'ping': {
            send(ws, { type: 'pong' });
            break;
          }

          default:
            send(ws, { type: 'error', payload: { message: `Unknown type: ${msg.type}` } });
        }
      } catch (err) {
        console.error('[WS] Message parse error:', err);
      }
    },

    close(ws: WS) {
      const info = clients.get(ws);
      if (info) {
        console.log(`[WS] ${info.address.slice(0, 8)}… left (${clients.size - 1} online)`);
      }
      removePlayerFromRooms(ws);
      clients.delete(ws);
      removeFromQueue(ws);
      broadcastPresence();
    },
  },
});

console.log(`🎴 Cangkulan Lobby WS server running on ws://localhost:${PORT}/ws`);
console.log(`   Health: http://localhost:${PORT}/health`);
console.log(`   Rooms: enabled (10 min TTL)`);
