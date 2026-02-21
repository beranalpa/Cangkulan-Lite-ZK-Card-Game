/**
 * useLobbyPresence — React hook for real-time lobby features
 *
 * Wraps the LobbySocketService in React-friendly state.
 * Auto-connects when the user has a wallet address and auto-disconnects on unmount.
 *
 * Returns:
 *   - Online players and connection status
 *   - Matchmaking queue controls
 *   - Invite/accept functions
 *   - Chat messages and send function
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getLobbySocket,
  resetLobbySocket,
  type LobbyPlayer,
  type ChatMessage,
  type MatchFound,
  type InviteReceived,
} from '@/services/lobbySocket';

export interface UseLobbyPresenceReturn {
  // Connection
  isConnected: boolean;
  /** Number of online players */
  onlinePlayers: LobbyPlayer[];

  // Matchmaking
  isInQueue: boolean;
  matchFound: MatchFound | null;
  joinQueue: () => void;
  leaveQueue: () => void;
  clearMatch: () => void;

  // Invites
  pendingInvite: InviteReceived | null;
  invite: (target: string, sessionId?: number) => void;
  acceptInvite: (from: string, sessionId?: number) => void;
  dismissInvite: () => void;

  // Chat
  chatMessages: ChatMessage[];
  sendChat: (text: string) => void;
}

export function useLobbyPresence(userAddress: string | null): UseLobbyPresenceReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [onlinePlayers, setOnlinePlayers] = useState<LobbyPlayer[]>([]);
  const [isInQueue, setIsInQueue] = useState(false);
  const [matchFound, setMatchFound] = useState<MatchFound | null>(null);
  const [pendingInvite, setPendingInvite] = useState<InviteReceived | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const cleanupRef = useRef<Array<() => void>>([]);

  // Connect / disconnect based on wallet address
  useEffect(() => {
    if (!userAddress) {
      setIsConnected(false);
      setOnlinePlayers([]);
      setIsInQueue(false);
      return;
    }

    const socket = getLobbySocket();

    // Subscribe to events
    const unsubs: Array<() => void> = [];

    unsubs.push(socket.on('connected', () => setIsConnected(true)));
    unsubs.push(socket.on('disconnected', () => {
      setIsConnected(false);
      setIsInQueue(false);
    }));
    unsubs.push(socket.on('presence', (data) => {
      setOnlinePlayers(data.players ?? []);
    }));
    unsubs.push(socket.on('queue-joined', () => setIsInQueue(true)));
    unsubs.push(socket.on('queue-left', () => setIsInQueue(false)));
    unsubs.push(socket.on('match-found', (data) => {
      setMatchFound(data);
      setIsInQueue(false);
    }));
    unsubs.push(socket.on('invite-received', (data) => setPendingInvite(data)));
    unsubs.push(socket.on('invite-accepted', () => {
      // invite target accepted — they'll navigate to game
    }));
    unsubs.push(socket.on('chat', (msg) => {
      setChatMessages((prev) => [...prev.slice(-99), msg]); // keep last 100
    }));

    cleanupRef.current = unsubs;

    // Connect
    socket.connect(userAddress);

    return () => {
      unsubs.forEach((u) => u());
      resetLobbySocket();
      setIsConnected(false);
      setOnlinePlayers([]);
      setIsInQueue(false);
      setChatMessages([]);
      setMatchFound(null);
      setPendingInvite(null);
    };
  }, [userAddress]);

  const joinQueue = useCallback(() => {
    getLobbySocket().joinQueue();
  }, []);

  const leaveQueue = useCallback(() => {
    getLobbySocket().leaveQueue();
  }, []);

  const clearMatch = useCallback(() => {
    setMatchFound(null);
  }, []);

  const invite = useCallback((target: string, sessionId?: number) => {
    getLobbySocket().invite(target, sessionId);
  }, []);

  const acceptInvite = useCallback((from: string, sessionId?: number) => {
    getLobbySocket().acceptInvite(from, sessionId);
    setPendingInvite(null);
  }, []);

  const dismissInvite = useCallback(() => {
    setPendingInvite(null);
  }, []);

  const sendChat = useCallback((text: string) => {
    getLobbySocket().chat(text);
  }, []);

  return {
    isConnected,
    onlinePlayers,
    isInQueue,
    matchFound,
    joinQueue,
    leaveQueue,
    clearMatch,
    pendingInvite,
    invite,
    acceptInvite,
    dismissInvite,
    chatMessages,
    sendChat,
  };
}
