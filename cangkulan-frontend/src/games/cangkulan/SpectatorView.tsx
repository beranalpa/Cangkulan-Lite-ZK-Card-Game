import { useState, useEffect, useCallback } from 'react';
import { CangkulanService } from './cangkulanService';
import { CANGKULAN_CONTRACT } from '@/utils/constants';
import type { GameState, TrickRecord } from './types';
import { LIFECYCLE, TRICK, OUTCOME, POINTS_DECIMALS } from './types';
import { cardSuit, cardLabel, SUIT_NAMES, SUIT_SYMBOLS } from './cardHelpers';
import { PlayingCard, CardBack } from './PlayingCard';
import { GameTable } from './GameTable';

// ═══════════════════════════════════════════════════════════════════════════════
//  Spectator View — read-only game observation (no hand reveal, no actions)
// ═══════════════════════════════════════════════════════════════════════════════

const service = new CangkulanService(CANGKULAN_CONTRACT);

function phaseLabel(state: number): string {
  switch (state) {
    case LIFECYCLE.SEED_COMMIT: return 'Seed Commit';
    case LIFECYCLE.SEED_REVEAL: return 'Seed Reveal';
    case LIFECYCLE.PLAYING: return 'Playing';
    case LIFECYCLE.FINISHED: return 'Finished';
    default: return 'Unknown';
  }
}

function trickStateLabel(ts: number): string {
  switch (ts) {
    case TRICK.COMMIT_WAIT_BOTH: return 'Both players choosing...';
    case TRICK.COMMIT_WAIT_P1: return 'Waiting for Player 1...';
    case TRICK.COMMIT_WAIT_P2: return 'Waiting for Player 2...';
    case TRICK.REVEAL_WAIT_BOTH: return 'Both players revealing...';
    case TRICK.REVEAL_WAIT_P1: return 'Player 1 revealing...';
    case TRICK.REVEAL_WAIT_P2: return 'Player 2 revealing...';
    default: return '';
  }
}

interface SpectatorViewProps {
  sessionId: number;
  onExit: () => void;
}

export function SpectatorView({ sessionId, onExit }: SpectatorViewProps) {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trickLog, setTrickLog] = useState<TrickRecord[]>([]);
  const [prevTricks, setPrevTricks] = useState({ won1: 0, won2: 0 });

  const loadGameState = useCallback(async () => {
    try {
      const game = await service.getGame(sessionId);
      if (game) {
        setGameState(game);
        setError(null);
      } else {
        // Contract returned null/GameNotFound
        setError(`Game #${sessionId} not found on-chain. It may have expired, ended, or the Session ID is incorrect.`);
      }
    } catch (err) {
      setError(`Failed to load game state: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [sessionId]);

  // Poll
  useEffect(() => {
    loadGameState();
    const ms = 3000;
    const iv = setInterval(loadGameState, ms);
    return () => clearInterval(iv);
  }, [loadGameState]);

  // Trick log tracking
  useEffect(() => {
    if (!gameState || gameState.lifecycle_state !== LIFECYCLE.PLAYING) return;
    const curr = { won1: gameState.tricks_won1, won2: gameState.tricks_won2 };
    if (curr.won1 + curr.won2 > prevTricks.won1 + prevTricks.won2) {
      const winner = curr.won1 > prevTricks.won1 ? 'p1' as const : 'p2' as const;
      const total = curr.won1 + curr.won2;
      setTrickLog(h => [...h, {
        trickNumber: total,
        winner,
        p1HandAfter: gameState.hand1?.length ?? 0,
        p2HandAfter: gameState.hand2?.length ?? 0,
      }]);
    }
    setPrevTricks(curr);
  }, [gameState?.tricks_won1, gameState?.tricks_won2]);

  if (error && !gameState) {
    return (
      <div className="space-y-4">
        <div className="p-6 bg-red-50 border-2 border-red-200 rounded-xl text-center">
          <p className="text-red-700 font-bold">{error}</p>
        </div>
        <button onClick={onExit} className="w-full py-3 rounded-xl font-bold text-gray-700 bg-gray-200 hover:bg-gray-300 transition-all">
          ← Back
        </button>
      </div>
    );
  }

  if (!gameState) {
    return (
      <div className="p-8 text-center">
        <div className="text-4xl mb-4 animate-pulse">👁️</div>
        <p className="text-gray-600 font-semibold">Loading game #{sessionId}...</p>
      </div>
    );
  }

  const trickState = gameState.trick_state ?? TRICK.NONE;
  const drawPileSize = gameState.draw_pile?.length ?? 0;
  const isFinished = gameState.lifecycle_state === LIFECYCLE.FINISHED;

  return (
    <div className="space-y-5">
      {/* Spectator Banner */}
      <div className="flex items-center justify-between p-3 bg-gradient-to-r from-violet-100 to-purple-100 border-2 border-violet-300 rounded-xl">
        <div className="flex items-center gap-2">
          <span className="text-lg">👁️</span>
          <div>
            <p className="text-sm font-black text-violet-800">Spectator Mode</p>
            <p className="text-xs text-violet-600">Session #{sessionId} · {phaseLabel(gameState.lifecycle_state)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isFinished && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-100 text-green-700 text-xs font-bold">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              LIVE
            </span>
          )}
          <button
            onClick={onExit}
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white border border-violet-200 text-violet-700 hover:bg-violet-50 transition-colors"
            style={{ minHeight: '32px', minWidth: 'auto' }}
          >
            ← Exit
          </button>
        </div>
      </div>

      {/* Player Info */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl">
          <p className="text-xs font-bold text-blue-800 uppercase">Player 1</p>
          <p className="font-mono text-xs text-gray-700 truncate">{gameState.player1.slice(0, 10)}...{gameState.player1.slice(-4)}</p>
          <p className="text-xs text-gray-600 mt-1">
            Cards: {gameState.hand1?.length ?? '?'} · Tricks: {gameState.tricks_won1}
          </p>
        </div>
        <div className="p-3 bg-purple-50 border border-purple-200 rounded-xl">
          <p className="text-xs font-bold text-purple-800 uppercase">Player 2</p>
          <p className="font-mono text-xs text-gray-700 truncate">{gameState.player2.slice(0, 10)}...{gameState.player2.slice(-4)}</p>
          <p className="text-xs text-gray-600 mt-1">
            Cards: {gameState.hand2?.length ?? '?'} · Tricks: {gameState.tricks_won2}
          </p>
        </div>
      </div>

      {/* Game Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-gradient-to-r from-emerald-50 to-teal-50 border-2 border-emerald-200 rounded-xl">
        <div className="flex items-center gap-4">
          <div className="text-center">
            <div className="text-xs font-bold text-gray-500 uppercase">Draw Pile</div>
            <div className="text-2xl font-black text-emerald-700">{drawPileSize}</div>
          </div>
          <div className="text-center">
            <div className="text-xs font-bold text-gray-500 uppercase">Tricks P1</div>
            <div className="text-2xl font-black text-blue-700">{gameState.tricks_won1}</div>
          </div>
          <div className="text-center">
            <div className="text-xs font-bold text-gray-500 uppercase">Tricks P2</div>
            <div className="text-2xl font-black text-purple-700">{gameState.tricks_won2}</div>
          </div>
        </div>
        {trickState !== TRICK.NONE && (
          <div className="text-xs font-semibold text-gray-600">{trickStateLabel(trickState)}</div>
        )}
      </div>

      {/* Game Table (read-only) */}
      {gameState.lifecycle_state === LIFECYCLE.PLAYING && (
        <GameTable gameState={gameState} isPlayer1={false} isPlayer2={false} />
      )}

      {/* Seed Phase Info */}
      {(gameState.lifecycle_state === LIFECYCLE.SEED_COMMIT || gameState.lifecycle_state === LIFECYCLE.SEED_REVEAL) && (
        <div className="p-5 bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-200 rounded-xl text-center">
          <p className="text-lg font-black text-indigo-800 mb-2">
            {gameState.lifecycle_state === LIFECYCLE.SEED_COMMIT ? '🎲 Seed Commitment' : '🔓 Seed Reveal'}
          </p>
          <div className="flex justify-center gap-4">
            <span className={`px-3 py-1 rounded-full text-xs font-bold ${gameState.seed_commit1 != null
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-500'
              }`}>
              P1: {gameState.lifecycle_state === LIFECYCLE.SEED_REVEAL
                ? (gameState.seed_revealed1 ? '✓ Revealed' : '🔒 Locked')
                : (gameState.seed_commit1 != null ? '✓ Committed' : 'Waiting')
              }
            </span>
            <span className={`px-3 py-1 rounded-full text-xs font-bold ${gameState.seed_commit2 != null
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-500'
              }`}>
              P2: {gameState.lifecycle_state === LIFECYCLE.SEED_REVEAL
                ? (gameState.seed_revealed2 ? '✓ Revealed' : '🔒 Locked')
                : (gameState.seed_commit2 != null ? '✓ Committed' : 'Waiting')
              }
            </span>
          </div>
        </div>
      )}

      {/* Card Hands — face-down only (no cheating!) */}
      {gameState.lifecycle_state === LIFECYCLE.PLAYING && (
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 bg-gray-50 rounded-xl border border-gray-200">
            <p className="text-xs font-bold text-gray-500 mb-2">P1 Hand ({gameState.hand1?.length ?? 0})</p>
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: Math.min(gameState.hand1?.length ?? 0, 15) }).map((_, i) => (
                <CardBack key={i} size="sm" />
              ))}
              {(gameState.hand1?.length ?? 0) > 15 && (
                <span className="text-xs text-gray-400 font-bold px-1">+{(gameState.hand1?.length ?? 0) - 15}</span>
              )}
            </div>
          </div>
          <div className="p-3 bg-gray-50 rounded-xl border border-gray-200">
            <p className="text-xs font-bold text-gray-500 mb-2">P2 Hand ({gameState.hand2?.length ?? 0})</p>
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: Math.min(gameState.hand2?.length ?? 0, 15) }).map((_, i) => (
                <CardBack key={i} size="sm" />
              ))}
              {(gameState.hand2?.length ?? 0) > 15 && (
                <span className="text-xs text-gray-400 font-bold px-1">+{(gameState.hand2?.length ?? 0) - 15}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Finished state */}
      {isFinished && (
        <div className="p-6 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-300 rounded-xl text-center">
          <div className="text-5xl mb-3">🏆</div>
          <h3 className="text-xl font-black text-gray-900 mb-2">Game Finished!</h3>
          <p className="text-lg font-bold text-green-700">
            {gameState.outcome === OUTCOME.PLAYER1_WIN
              ? `Player 1 Wins!`
              : gameState.outcome === OUTCOME.PLAYER2_WIN
                ? `Player 2 Wins!`
                : gameState.outcome === OUTCOME.DRAW
                  ? 'Draw!'
                  : 'Unresolved'}
          </p>
          <div className="flex justify-center gap-6 mt-3 text-sm text-gray-600">
            <span>P1: {gameState.tricks_won1} tricks</span>
            <span>P2: {gameState.tricks_won2} tricks</span>
          </div>
        </div>
      )}

      {/* Trick Log */}
      {trickLog.length > 0 && (
        <div className="p-4 bg-gradient-to-br from-amber-50 to-yellow-50 border-2 border-amber-200 rounded-xl">
          <h4 className="text-sm font-black text-amber-800 mb-2">📜 Trick Log ({trickLog.length})</h4>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {trickLog.map((t) => (
              <div key={t.trickNumber} className="flex items-center gap-3 text-xs py-1 px-2 rounded-lg bg-white/60 border border-amber-100">
                <span className="font-bold text-gray-500 w-8">#{t.trickNumber}</span>
                <span className={`font-bold ${t.winner === 'p1' ? 'text-blue-600' : 'text-purple-600'}`}>
                  {t.winner === 'p1' ? '🟦 P1' : '🟪 P2'}
                </span>
                <span className="text-gray-400 ml-auto">P1: {t.p1HandAfter} · P2: {t.p2HandAfter}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
