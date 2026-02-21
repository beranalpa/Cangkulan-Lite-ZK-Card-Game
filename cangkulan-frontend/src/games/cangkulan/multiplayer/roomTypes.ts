/**
 * Room system types shared between frontend and WS server
 */

import type { ProofMode } from '../types';

export type RoomType = 'public' | 'private';
export type RoomStatus = 'waiting' | 'starting' | 'playing' | 'ended';

export interface Room {
  id: string;
  inviteCode: string;
  host: RoomPlayer;
  guest: RoomPlayer | null;
  spectators: RoomPlayer[];
  type: RoomType;
  betAmount: number;
  zkMode: ProofMode | 'auto';
  sessionId: number;
  status: RoomStatus;
  createdAt: number;
}

export interface RoomPlayer {
  address: string;
  name?: string;
}

export interface RoomChatMessage {
  from: string;
  fromName?: string;
  text: string;
  timestamp: number;
}

/** Create room request sent from client */
export interface CreateRoomPayload {
  type: RoomType;
  betAmount: number;
  zkMode: ProofMode | 'auto';
}

/** Join room request */
export interface JoinRoomPayload {
  roomId?: string;
  inviteCode?: string;
}

/** Room list item (subset for browse) */
export interface RoomListItem {
  id: string;
  host: RoomPlayer;
  type: RoomType;
  betAmount: number;
  zkMode: ProofMode | 'auto';
  spectatorCount: number;
  createdAt: number;
}
