import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useLobbyPresence } from '@/hooks/useLobbyPresence';
import { getLobbySocketInterface } from '@/services/lobbySocket';
import type { AppRoute } from '@/hooks/useHashRouter';
import type { ProofMode } from '../types';
import type { Room, RoomListItem, RoomChatMessage, RoomType } from './roomTypes';

// Lazy-load the game once room is ready
const CangkulanGame = lazy(() => import('../CangkulanGame').then(m => ({ default: m.CangkulanGame })));

type Phase = 'select' | 'creating' | 'waiting' | 'joining' | 'playing';

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

// ── Create Room Form ──────────────────────────────────────────────────────

interface CreateRoomFormProps {
  onCreateRoom: (type: RoomType, betAmount: number, zkMode: ProofMode | 'auto') => void;
  isCreating: boolean;
}

function CreateRoomForm({ onCreateRoom, isCreating }: CreateRoomFormProps) {
  const [roomType, setRoomType] = useState<RoomType>('public');
  const [betAmount, setBetAmount] = useState(0);
  const [zkMode, setZkMode] = useState<ProofMode | 'auto'>('pedersen');
  const { balanceXlm } = useWallet();

  const betPresets = [0, 1, 5, 10];

  return (
    <div className="card space-y-4">
      <h3 className="text-lg font-bold" style={{ color: 'var(--color-ink)' }}>Create Room</h3>

      {/* Room Type */}
      <div>
        <label className="text-sm font-semibold block mb-1.5" style={{ color: 'var(--color-ink-muted)' }}>
          Room Type
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => setRoomType('public')}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              roomType === 'public'
                ? 'bg-emerald-500 text-white shadow-lg'
                : 'bg-gray-100 dark:bg-gray-700'
            }`}
            style={roomType !== 'public' ? { color: 'var(--color-ink-muted)' } : undefined}
          >
            🌐 Public
          </button>
          <button
            onClick={() => setRoomType('private')}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              roomType === 'private'
                ? 'bg-violet-500 text-white shadow-lg'
                : 'bg-gray-100 dark:bg-gray-700'
            }`}
            style={roomType !== 'private' ? { color: 'var(--color-ink-muted)' } : undefined}
          >
            🔒 Private
          </button>
        </div>
      </div>

      {/* Bet Amount */}
      <div>
        <label className="text-sm font-semibold block mb-1.5" style={{ color: 'var(--color-ink-muted)' }}>
          Bet Amount (XLM) — <span className="text-xs opacity-70">Balance: {balanceXlm ?? '...'} XLM</span>
        </label>
        <div className="flex gap-2">
          {betPresets.map(amt => (
            <button
              key={amt}
              onClick={() => setBetAmount(amt)}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all ${
                betAmount === amt
                  ? 'bg-blue-500 text-white shadow-lg'
                  : 'bg-gray-100 dark:bg-gray-700'
              }`}
              style={betAmount !== amt ? { color: 'var(--color-ink-muted)' } : undefined}
            >
              {amt === 0 ? 'Free' : `${amt}`}
            </button>
          ))}
        </div>
      </div>

      {/* ZK Mode — Multiplayer uses Pedersen (locked) */}
      <div>
        <label className="text-sm font-semibold block mb-1.5" style={{ color: 'var(--color-ink-muted)' }}>
          ZK Proof Mode
        </label>
        <div className="flex gap-2 items-center">
          <div className="px-3 py-2 rounded-xl text-sm font-semibold bg-teal-500 text-white shadow-lg">
            🔐 Pedersen (224 B)
          </div>
          <span className="text-[10px]" style={{ color: 'var(--color-ink-muted)' }}>
            Multiplayer uses elliptic-curve commitment — fast &amp; on-chain verified
          </span>
        </div>
      </div>

      {/* Create Button */}
      <button
        onClick={() => onCreateRoom(roomType, betAmount, zkMode)}
        disabled={isCreating}
        className="w-full py-3 rounded-xl text-white font-bold text-sm bg-gradient-to-r from-emerald-500 to-teal-600 hover:shadow-xl hover:scale-[1.02] transition-all disabled:opacity-50"
      >
        {isCreating ? 'Creating Room...' : '✨ Create Room'}
      </button>
    </div>
  );
}

// ── Waiting Room ──────────────────────────────────────────────────────────

interface WaitingRoomProps {
  room: Room;
  roomChat: RoomChatMessage[];
  onSendChat: (text: string) => void;
  onCancel: () => void;
}

function WaitingRoom({ room, roomChat, onSendChat, onCancel }: WaitingRoomProps) {
  const [chatInput, setChatInput] = useState('');

  const inviteLink = `${window.location.origin}${window.location.pathname}?room=${room.id}&code=${room.inviteCode}#/game`;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <div className="space-y-4">
      {/* Room Header */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xl font-bold" style={{ color: 'var(--color-ink)' }}>
            Room #{room.id}
          </h3>
          <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
            room.type === 'public' ? 'bg-emerald-100 text-emerald-700' : 'bg-violet-100 text-violet-700'
          }`}>
            {room.type === 'public' ? '🌐 Public' : '🔒 Private'}
          </span>
        </div>
        <div className="flex gap-3 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          <span>Bet: <strong>{room.betAmount === 0 ? 'Free' : `${room.betAmount} XLM`}</strong></span>
          <span>ZK: <strong>{room.zkMode === 'auto' ? 'Auto' : room.zkMode.toUpperCase()}</strong></span>
          <span>Session: <strong>{room.sessionId}</strong></span>
        </div>
      </div>

      {/* Players */}
      <div className="card">
        <h4 className="text-sm font-bold mb-3" style={{ color: 'var(--color-ink)' }}>Players</h4>
        <div className="space-y-2">
          <div className="flex items-center gap-3 p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20">
            <span className="text-lg">👑</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate" style={{ color: 'var(--color-ink)' }}>
                {room.host.address.slice(0, 8)}...{room.host.address.slice(-4)}
              </div>
              <div className="text-xs text-emerald-600">Host — Ready</div>
            </div>
            <span className="text-emerald-500">✅</span>
          </div>
          <div className="flex items-center gap-3 p-2.5 rounded-xl bg-gray-50 dark:bg-gray-700/30">
            <span className="text-lg">👤</span>
            <div className="flex-1">
              {room.guest ? (
                <>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--color-ink)' }}>
                    {room.guest.address.slice(0, 8)}...{room.guest.address.slice(-4)}
                  </div>
                  <div className="text-xs text-blue-600">Guest — Joined!</div>
                </>
              ) : (
                <>
                  <div className="text-sm font-semibold" style={{ color: 'var(--color-ink-muted)' }}>
                    Waiting for opponent...
                  </div>
                  <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
                    Share the invite link below
                  </div>
                </>
              )}
            </div>
            {room.guest ? <span className="text-blue-500">✅</span> : (
              <div className="w-5 h-5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
            )}
          </div>
        </div>
      </div>

      {/* Spectators */}
      {room.spectators.length > 0 && (
        <div className="card">
          <h4 className="text-sm font-bold mb-2" style={{ color: 'var(--color-ink)' }}>
            👁 Spectators ({room.spectators.length})
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {room.spectators.map((s, i) => (
              <span key={i} className="px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-700" style={{ color: 'var(--color-ink-muted)' }}>
                {s.address.slice(0, 6)}...
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Invite Section */}
      {!room.guest && (
        <div className="card">
          <h4 className="text-sm font-bold mb-3" style={{ color: 'var(--color-ink)' }}>Invite</h4>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={inviteLink}
                className="flex-1 px-3 py-2 rounded-lg text-xs font-mono bg-gray-100 dark:bg-gray-700 truncate"
                style={{ color: 'var(--color-ink)' }}
              />
              <button
                onClick={() => copyToClipboard(inviteLink)}
                className="px-3 py-2 rounded-lg text-xs font-bold bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                📋 Copy
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold" style={{ color: 'var(--color-ink-muted)' }}>
                Code:
              </span>
              <code className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-sm font-bold tracking-wider" style={{ color: 'var(--color-ink)' }}>
                {room.inviteCode}
              </code>
              <button
                onClick={() => copyToClipboard(room.inviteCode)}
                className="text-xs text-blue-500 hover:underline"
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Room Chat */}
      <div className="card">
        <h4 className="text-sm font-bold mb-2" style={{ color: 'var(--color-ink)' }}>Room Chat</h4>
        <div className="h-32 overflow-y-auto space-y-1 mb-2 p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50">
          {roomChat.length === 0 ? (
            <p className="text-xs text-center py-4" style={{ color: 'var(--color-ink-muted)' }}>
              No messages yet
            </p>
          ) : (
            roomChat.map((msg, i) => (
              <div key={i} className="text-xs">
                <span className="font-bold text-emerald-600">{msg.from.slice(0, 6)}…</span>{' '}
                <span style={{ color: 'var(--color-ink)' }}>{msg.text}</span>
              </div>
            ))
          )}
        </div>
        <form
          onSubmit={e => {
            e.preventDefault();
            if (chatInput.trim()) {
              onSendChat(chatInput.trim());
              setChatInput('');
            }
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            placeholder="Type a message..."
            maxLength={200}
            className="flex-1 px-3 py-2 rounded-lg text-sm bg-gray-100 dark:bg-gray-700"
            style={{ color: 'var(--color-ink)' }}
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-lg text-sm font-bold bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
          >
            Send
          </button>
        </form>
      </div>

      {/* Cancel */}
      <button
        onClick={onCancel}
        className="w-full py-2.5 rounded-xl text-sm font-semibold border-2 border-red-300 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
      >
        ❌ Cancel Room
      </button>
    </div>
  );
}

// ── Join Room Panel ───────────────────────────────────────────────────────

interface JoinRoomPanelProps {
  publicRooms: RoomListItem[];
  onJoinRoom: (roomId: string, inviteCode?: string) => void;
  isJoining: boolean;
}

function JoinRoomPanel({ publicRooms, onJoinRoom, isJoining }: JoinRoomPanelProps) {
  const [inviteCode, setInviteCode] = useState('');

  return (
    <div className="card space-y-4">
      <h3 className="text-lg font-bold" style={{ color: 'var(--color-ink)' }}>Join Room</h3>

      {/* Invite Code */}
      <div>
        <label className="text-sm font-semibold block mb-1.5" style={{ color: 'var(--color-ink-muted)' }}>
          Enter Invite Code (Private Rooms)
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value.toUpperCase())}
            placeholder="e.g. XY7K"
            maxLength={8}
            className="flex-1 px-3 py-2.5 rounded-lg text-sm font-mono tracking-wider bg-gray-100 dark:bg-gray-700 uppercase"
            style={{ color: 'var(--color-ink)' }}
          />
          <button
            onClick={() => {
              if (inviteCode.trim()) onJoinRoom('', inviteCode.trim());
            }}
            disabled={!inviteCode.trim() || isJoining}
            className="px-4 py-2.5 rounded-lg text-sm font-bold bg-violet-500 text-white hover:bg-violet-600 transition-colors disabled:opacity-50"
          >
            Join
          </button>
        </div>
      </div>

      {/* Public Rooms List */}
      <div>
        <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--color-ink-muted)' }}>
          Browse Public Rooms
        </h4>
        {publicRooms.length === 0 ? (
          <div className="p-6 rounded-xl bg-gray-50 dark:bg-gray-800/50 text-center text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            No rooms available. Create one!
          </div>
        ) : (
          <div className="space-y-2">
            {publicRooms.map(room => (
              <div
                key={room.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>#{room.id}</span>
                    <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
                      {room.host.address.slice(0, 6)}...
                    </span>
                  </div>
                  <div className="flex gap-2 text-[10px]" style={{ color: 'var(--color-ink-muted)' }}>
                    <span>{room.betAmount === 0 ? 'Free' : `${room.betAmount} XLM`}</span>
                    <span>·</span>
                    <span>{room.zkMode === 'auto' ? 'Auto ZK' : room.zkMode.toUpperCase()}</span>
                    <span>·</span>
                    <span>👁 {room.spectatorCount}</span>
                  </div>
                </div>
                <button
                  onClick={() => onJoinRoom(room.id)}
                  disabled={isJoining}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-500 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
                >
                  Join
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MultiplayerFlow — orchestrates room creation, joining, and game flow
// ═══════════════════════════════════════════════════════════════════════════════

interface MultiplayerFlowProps {
  userAddress: string;
  navigate: (route: AppRoute) => void;
  initialSessionId?: number;
  onBack: () => void;
}

export function MultiplayerFlow({ userAddress, navigate, initialSessionId, onBack }: MultiplayerFlowProps) {
  const lobby = useLobbyPresence(userAddress);

  // If we have an initialSessionId (resuming), go directly to playing
  const [phase, setPhase] = useState<Phase>(() =>
    initialSessionId ? 'playing' : 'select'
  );
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [publicRooms, setPublicRooms] = useState<RoomListItem[]>([]);
  const [roomChat, setRoomChat] = useState<RoomChatMessage[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [gameSessionId, setGameSessionId] = useState<number | undefined>(initialSessionId);

  // Stable ref to lobby socket interface (replaces window.__lobbySocket global)
  const lobbySocketRef = useRef(getLobbySocketInterface());

  // Check URL for room invite on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('room');
    const code = params.get('code');
    if (roomId && lobby.isConnected) {
      handleJoinRoom(roomId, code || undefined);
      // Clean URL
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      url.searchParams.delete('code');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  }, [lobby.isConnected]);

  // Listen for room events from WS
  useEffect(() => {
    if (!lobby.isConnected) return;

    const handleRoomCreated = (data: any) => {
      setCurrentRoom(data.room);
      setPhase('waiting');
      setIsCreating(false);
    };

    const handleRoomUpdated = (data: any) => {
      setCurrentRoom(data.room);
      // If guest joined, auto-start after short delay
      if (data.room?.guest && data.room?.status === 'starting') {
        setGameSessionId(data.room.sessionId);
        setTimeout(() => setPhase('playing'), 1500);
      }
    };

    const handleRoomList = (data: any) => {
      setPublicRooms(data.rooms || []);
    };

    const handleRoomChat = (data: any) => {
      setRoomChat(prev => [...prev.slice(-49), data]);
    };

    const handleRoomClosed = () => {
      setCurrentRoom(null);
      setPhase('select');
      setRoomChat([]);
    };

    const handleRoomGameStart = (data: any) => {
      setGameSessionId(data.sessionId);
      setPhase('playing');
    };

    // Use the lobby socket service directly for room events
    const socket = (lobby as any)._socket || lobby;
    const unsubs: Array<() => void> = [];

    // Register custom event handlers via the lobby socket service
    const lobbySocket = lobbySocketRef.current;
    if (lobbySocket) {
      unsubs.push(lobbySocket.on('room-created', handleRoomCreated));
      unsubs.push(lobbySocket.on('room-updated', handleRoomUpdated));
      unsubs.push(lobbySocket.on('room-list', handleRoomList));
      unsubs.push(lobbySocket.on('room-chat', handleRoomChat));
      unsubs.push(lobbySocket.on('room-closed', handleRoomClosed));
      unsubs.push(lobbySocket.on('room-game-start', handleRoomGameStart));
    }

    // Request room list on connect
    if (lobbySocket) {
      lobbySocket.send({ type: 'room-list' });
    }

    return () => { unsubs.forEach(fn => fn()); };
  }, [lobby.isConnected]);

  const handleCreateRoom = useCallback((type: RoomType, betAmount: number, zkMode: ProofMode | 'auto') => {
    const lobbySocket = lobbySocketRef.current;
    if (!lobbySocket) return;
    setIsCreating(true);
    try {
      lobbySocket.send({
        type: 'create-room',
        payload: { type, betAmount, zkMode },
      });
    } catch {
      setIsCreating(false);
    }
    // Safety timeout: reset isCreating if server doesn't respond within 10s
    setTimeout(() => setIsCreating(false), 10000);
  }, []);

  const handleJoinRoom = useCallback((roomId: string, inviteCode?: string) => {
    const lobbySocket = lobbySocketRef.current;
    if (!lobbySocket) return;
    setIsJoining(true);
    lobbySocket.send({
      type: 'join-room',
      payload: { roomId, inviteCode },
    });
    // On success, server will send room-updated → room-game-start
    setTimeout(() => setIsJoining(false), 5000);
  }, []);

  const handleCancelRoom = useCallback(() => {
    const lobbySocket = lobbySocketRef.current;
    if (lobbySocket && currentRoom) {
      lobbySocket.send({ type: 'leave-room', payload: { roomId: currentRoom.id } });
    }
    setCurrentRoom(null);
    setPhase('select');
    setRoomChat([]);
  }, [currentRoom]);

  const handleSendRoomChat = useCallback((text: string) => {
    const lobbySocket = lobbySocketRef.current;
    if (lobbySocket && currentRoom) {
      lobbySocket.send({ type: 'room-chat', payload: { roomId: currentRoom.id, text } });
    }
  }, [currentRoom]);

  // ── Quick Match (uses existing FIFO queue) ──────────────────────────────
  const handleQuickMatch = useCallback(() => {
    if (lobby.isInQueue) {
      lobby.leaveQueue();
    } else {
      lobby.joinQueue();
    }
  }, [lobby]);

  // Watch for match found → create a game session
  useEffect(() => {
    if (lobby.matchFound) {
      setGameSessionId(undefined); // Will be created by CangkulanGame
      setPhase('playing');
    }
  }, [lobby.matchFound]);

  // ── Render Phases ───────────────────────────────────────────────────────

  if (phase === 'playing') {
    return (
      <Suspense fallback={<PageLoader />}>
        <div className="mb-3">
          <button
            onClick={() => { setPhase('select'); setGameSessionId(undefined); }}
            className="text-xs font-medium hover:underline"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            ← Back to Room Select
          </button>
        </div>
        <CangkulanGame
          userAddress={userAddress}
          availablePoints={1000000000n}
          onStandingsRefresh={() => {}}
          onGameComplete={() => {}}
          initialSessionId={gameSessionId}
          navigate={navigate}
          gameMode="multiplayer"
        />
      </Suspense>
    );
  }

  return (
    <div className="space-y-4">
      {/* Back Button */}
      <button
        onClick={onBack}
        className="text-sm font-medium hover:underline"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        ← Back to Mode Select
      </button>

      {/* Title */}
      <div className="text-center mb-2">
        <h2 className="text-2xl font-bold gradient-text">🎮 Multiplayer</h2>
        <p className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>
          {lobby.isConnected ? (
            <span className="text-emerald-500">● Connected to lobby ({lobby.onlinePlayers.length} online)</span>
          ) : (
            <span className="text-amber-500">● Connecting to lobby...</span>
          )}
        </p>
      </div>

      {phase === 'select' && (
        <>
          {/* Create Room */}
          <CreateRoomForm onCreateRoom={handleCreateRoom} isCreating={isCreating} />

          {/* Join Room */}
          <JoinRoomPanel
            publicRooms={publicRooms}
            onJoinRoom={handleJoinRoom}
            isJoining={isJoining}
          />

          {/* Quick Actions */}
          <div className="card">
            <div className="flex gap-2">
              <button
                onClick={handleQuickMatch}
                className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${
                  lobby.isInQueue
                    ? 'bg-amber-500 text-white animate-pulse'
                    : 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:shadow-lg'
                }`}
              >
                {lobby.isInQueue ? '⏳ Searching... (Click to cancel)' : '⚡ Quick Match'}
              </button>
              <button
                onClick={() => {
                  setGameSessionId(undefined);
                  setPhase('playing');
                }}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold border-2 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-all"
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-ink)' }}
              >
                ⚡ Quick Play (No Room)
              </button>
            </div>
          </div>
        </>
      )}

      {phase === 'waiting' && currentRoom && (
        <WaitingRoom
          room={currentRoom}
          roomChat={roomChat}
          onSendChat={handleSendRoomChat}
          onCancel={handleCancelRoom}
        />
      )}
    </div>
  );
}
