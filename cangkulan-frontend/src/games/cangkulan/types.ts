import type { CangkulanGame as GameState } from './bindings';
import type { AppRoute } from '@/hooks/useHashRouter';

export type { GameState };

export type GamePhase = 'create' | 'seed-commit' | 'seed-reveal' | 'playing' | 'complete';

export type CreateMode = 'create' | 'import' | 'load';

export interface TrickRecord {
  trickNumber: number;
  winner: 'p1' | 'p2' | 'waste';
  p1HandAfter: number;
  p2HandAfter: number;
  /** Whether player 1's play was ZK-verified on-chain */
  p1ZkVerified?: boolean;
  /** Whether player 2's play was ZK-verified on-chain */
  p2ZkVerified?: boolean;
}

export type ProofMode = 'nizk' | 'pedersen' | 'noir';

export type GameMode = 'ai' | 'multiplayer' | 'dev';

export interface SeedData {
  seed: string;     // hex-encoded raw seed (stays client-side only!)
  blinding: string; // hex-encoded blinding factor
  proofMode?: ProofMode; // 'nizk', 'pedersen' (default), or 'noir'
}

export interface CangkulanGameProps {
  userAddress: string;
  availablePoints: bigint;
  initialXDR?: string | null;
  initialSessionId?: number;
  onStandingsRefresh: () => void;
  onGameComplete: () => void;
  navigate?: (route: AppRoute) => void;
  /** If provided, Player 2 is a bot that auto-signs and auto-plays */
  botPlayer?: any;
  /** Game mode — controls which ZK proof modes are available */
  gameMode?: GameMode;
  /** Immediately trigger Quickstart on mount (for dev mode) */
  autoQuickstart?: boolean;
}

export const LIFECYCLE = {
  SEED_COMMIT: 1,
  SEED_REVEAL: 2,
  PLAYING: 3,
  FINISHED: 4,
} as const;

export const TRICK = {
  NONE: 0,
  COMMIT_WAIT_BOTH: 10,
  COMMIT_WAIT_P1: 11,
  COMMIT_WAIT_P2: 12,
  REVEAL_WAIT_BOTH: 20,
  REVEAL_WAIT_P1: 21,
  REVEAL_WAIT_P2: 22,
} as const;

export const CANNOT_FOLLOW_SENTINEL = 0xFFFFFFFF;

export const OUTCOME = {
  UNRESOLVED: 0,
  PLAYER1_WIN: 1,
  PLAYER2_WIN: 2,
  DRAW: 3,
} as const;

export const POINTS_DECIMALS = 7;
export const DEFAULT_POINTS = '0.1';
export const TIMEOUT_SECONDS = 600; // 10 minutes — matches contract TIMEOUT_MINUTES
