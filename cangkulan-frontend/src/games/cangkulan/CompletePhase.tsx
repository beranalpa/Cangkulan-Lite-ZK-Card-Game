import { useMemo, useState } from 'react';
import type { GameState, TrickRecord, ProofMode } from './types';
import { OUTCOME, POINTS_DECIMALS } from './types';
import { cardSuit, cardLabel } from './cardHelpers';
import { getActiveCangkulanContract, getActiveGameHubContract, getStellarExpertLink } from '@/utils/constants';
import { CanvasConfetti, CardSweepOverlay } from './CanvasConfetti';
import { GameReplay } from './GameReplay';
import { FadeIn } from './cardAnimations';
import { ZkVerificationBadge, ZkTrickBadge } from './ZkVerificationBadge';

interface CompletePhaseProps {
  gameState: GameState;
  sessionId: number;
  userAddress: string;
  isPlayer1: boolean;
  isPlayer2: boolean;
  isBusy: boolean;
  onVerifyShuffle: () => void;
  shuffleData: number[] | null;
  shuffleLoading: boolean;
  trickHistory: TrickRecord[];
  onStartNewGame: () => void;
  proofMode?: ProofMode;
}

function outcomeLabel(outcome: number, player1: string, player2: string, userAddress: string): string {
  switch (outcome) {
    case OUTCOME.PLAYER1_WIN:
      return userAddress === player1 ? '🎉 You Won!' : `Winner: ${player1.slice(0, 8)}...`;
    case OUTCOME.PLAYER2_WIN:
      return userAddress === player2 ? '🎉 You Won!' : `Winner: ${player2.slice(0, 8)}...`;
    case OUTCOME.DRAW:
      return '🤝 Draw!';
    default:
      return 'Unresolved';
  }
}

/** When both have same cards left, explain how the winner was decided */
function tiebreakerNote(gs: GameState): string | null {
  if (gs.outcome === OUTCOME.DRAW) return 'Same cards, same tricks — a true draw!';
  if (gs.hand1.length !== gs.hand2.length) return null; // decided by card count
  if (gs.tricks_won1 !== gs.tricks_won2) return 'Won by most tricks!';
  return null; // decided by card value sum (rare)
}

export function CompletePhase({
  gameState,
  sessionId,
  userAddress,
  isPlayer1,
  isPlayer2,
  isBusy,
  onVerifyShuffle,
  shuffleData,
  shuffleLoading,
  trickHistory,
  onStartNewGame,
  proofMode = 'pedersen',
}: CompletePhaseProps) {
  // Stable confetti data (avoids re-randomizing on re-render)
  const confettiParticles = useMemo(() =>
    Array.from({ length: 24 }, (_, i) => ({
      left: `${Math.random() * 100}%`,
      animationDelay: `${Math.random() * 1.5}s`,
      animationDuration: `${2 + Math.random() * 2}s`,
      backgroundColor: ['#fdda24', '#00a7b5', '#b7ace8', '#ff6b6b', '#4ecdc4', '#ffe66d'][i % 6],
    })),
    []);

  const isWinner =
    (gameState.outcome === OUTCOME.PLAYER1_WIN && isPlayer1)
    || (gameState.outcome === OUTCOME.PLAYER2_WIN && isPlayer2);

  const [showReplay, setShowReplay] = useState(false);

  // Spectator share URL
  const spectateUrl = `${window.location.origin}${window.location.pathname}#/spectate/${sessionId}`;

  return (
    <div className="space-y-6">
      {/* Win celebration — Canvas Confetti + Card Sweep */}
      <CanvasConfetti active={isWinner} />
      <CardSweepOverlay active={isWinner} />

      <FadeIn delay={0.1}>
        <div className="p-5 sm:p-10 bg-gradient-to-br from-green-50 via-emerald-50 to-teal-50 border-2 border-green-300 rounded-2xl text-center shadow-2xl" role="status" aria-live="polite" aria-atomic="true">
          <div className="text-5xl sm:text-7xl mb-4 sm:mb-6" aria-hidden="true" style={{
            animation: isWinner ? 'trophy-bounce 0.6s ease-out' : undefined,
          }}>🏆</div>
          <style>{`
          @keyframes trophy-bounce {
            0% { transform: scale(0) rotate(-15deg); }
            50% { transform: scale(1.3) rotate(5deg); }
            100% { transform: scale(1) rotate(0deg); }
          }
        `}</style>
          <h3 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3 sm:mb-4">Game Complete!</h3>
          <div className="text-xl sm:text-2xl font-bold text-green-700 mb-2">
            {outcomeLabel(gameState.outcome, gameState.player1, gameState.player2, userAddress)}
          </div>
          {tiebreakerNote(gameState) && (
            <p className="text-sm text-gray-500 mb-6">{tiebreakerNote(gameState)}</p>
          )}
          {!tiebreakerNote(gameState) && <div className="mb-6" />}

          {/* Player Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            <div className="p-4 bg-white/70 border border-green-200 rounded-xl">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-1">Player 1</p>
              <p className="font-mono text-xs text-gray-700 mb-2">{gameState.player1.slice(0, 8)}...{gameState.player1.slice(-4)}</p>
              <p className="text-sm font-semibold text-gray-800">
                Cards left: {gameState.hand1.length} | Tricks won: {gameState.tricks_won1}
              </p>
              <p className="text-xs text-gray-600">Points: {(Number(gameState.player1_points) / 10 ** POINTS_DECIMALS).toFixed(2)}</p>
            </div>
            <div className="p-4 bg-white/70 border border-green-200 rounded-xl">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-1">Player 2</p>
              <p className="font-mono text-xs text-gray-700 mb-2">{gameState.player2.slice(0, 8)}...{gameState.player2.slice(-4)}</p>
              <p className="text-sm font-semibold text-gray-800">
                Cards left: {gameState.hand2.length} | Tricks won: {gameState.tricks_won2}
              </p>
              <p className="text-xs text-gray-600">Points: {(Number(gameState.player2_points) / 10 ** POINTS_DECIMALS).toFixed(2)}</p>
            </div>
          </div>

          {/* Verify & Explore Links */}
          <div className="flex flex-wrap items-center justify-center gap-3 text-xs">
            {getStellarExpertLink('contract', getActiveCangkulanContract()) && (
              <a href={`${getStellarExpertLink('contract', getActiveCangkulanContract())}?filter=events`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 no-underline font-semibold transition-colors">
                🔗 Game Contract Events ↗
              </a>
            )}
            {getStellarExpertLink('contract', getActiveGameHubContract()) && (
              <a href={`${getStellarExpertLink('contract', getActiveGameHubContract())}?filter=events`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 no-underline font-semibold transition-colors">
                🏆 Winner Proof (Game Hub) ↗
              </a>
            )}
            <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gray-50 border border-gray-200 text-gray-600 font-mono">
              Session #{sessionId}
            </span>
          </div>
        </div>
      </FadeIn>

      {/* Shuffle Verification */}
      {!shuffleData ? (
        <button onClick={onVerifyShuffle} disabled={isBusy || shuffleLoading}
          className="w-full py-3 rounded-xl font-bold text-sm text-indigo-700 bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-200 hover:from-indigo-100 hover:to-purple-100 disabled:opacity-50 transition-all shadow-md">
          {shuffleLoading ? '🔍 Verifying on-chain...' : '🔍 Verify Shuffle Fairness'}
        </button>
      ) : (
        <div className="slide-in-up p-5 bg-gradient-to-br from-indigo-50 to-purple-50 border-2 border-indigo-200 rounded-xl space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-lg">✅</span>
            <h4 className="text-sm font-bold text-indigo-800">Shuffle Verified On-Chain</h4>
          </div>
          <p className="text-xs text-gray-600">Both players contributed random seeds. The combined hash was used to deterministically shuffle the deck via Fisher-Yates. Anyone can recompute this to prove fairness.</p>
          <div className="space-y-3">
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <span className="text-xs font-bold text-blue-700 block mb-1">Player 1 Initial Hand (cards 1–5)</span>
              <div className="flex flex-wrap gap-1">
                {shuffleData.slice(0, 5).map((c, i) => (
                  <span key={i} className={`text-xs font-mono px-1.5 py-0.5 rounded ${cardSuit(c) === 1 || cardSuit(c) === 2 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-800'}`}>{cardLabel(c)}</span>
                ))}
              </div>
            </div>
            <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg">
              <span className="text-xs font-bold text-purple-700 block mb-1">Player 2 Initial Hand (cards 6–10)</span>
              <div className="flex flex-wrap gap-1">
                {shuffleData.slice(5, 10).map((c, i) => (
                  <span key={i} className={`text-xs font-mono px-1.5 py-0.5 rounded ${cardSuit(c) === 1 || cardSuit(c) === 2 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-800'}`}>{cardLabel(c)}</span>
                ))}
              </div>
            </div>
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
              <span className="text-xs font-bold text-emerald-700 block mb-1">Draw Pile Order (cards 11–36)</span>
              <div className="flex flex-wrap gap-1">
                {shuffleData.slice(10).map((c, i) => (
                  <span key={i} className={`text-xs font-mono px-1.5 py-0.5 rounded ${cardSuit(c) === 1 || cardSuit(c) === 2 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-800'}`}>{cardLabel(c)}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ZK Coverage Summary */}
      {trickHistory.length > 0 && (
        <ZkVerificationBadge
          variant="summary"
          proofMode={proofMode}
          coverage={{
            total: trickHistory.length * 2,
            verified: trickHistory.reduce(
              (sum, t) => sum + (t.p1ZkVerified ? 1 : 0) + (t.p2ZkVerified ? 1 : 0),
              0,
            ),
          }}
        />
      )}

      {/* Trick History */}
      {trickHistory.length > 0 && (
        <div className="slide-in-up p-4 bg-gradient-to-br from-amber-50 to-yellow-50 border-2 border-amber-200 rounded-xl">
          <h4 className="text-sm font-bold text-amber-800 mb-2">📜 Trick History ({trickHistory.length} tricks)</h4>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {trickHistory.map((trick) => (
              <div key={trick.trickNumber} className="flex items-center gap-3 text-xs py-1.5 px-2 rounded-lg bg-white/60 border border-amber-100">
                <span className="font-bold text-gray-500 w-8">#{trick.trickNumber}</span>
                <span className={`font-bold ${trick.winner === 'p1' ? 'text-blue-600' : trick.winner === 'p2' ? 'text-purple-600' : 'text-gray-400'
                  }`}>
                  {trick.winner === 'p1' ? '🟦 P1 wins' : trick.winner === 'p2' ? '🟪 P2 wins' : '⬜ Waste'}
                </span>
                <span className="text-gray-400 ml-auto flex items-center gap-1.5">
                  {(trick.p1ZkVerified || trick.p2ZkVerified) && <ZkTrickBadge verified />}
                  P1: {trick.p1HandAfter} • P2: {trick.p2HandAfter}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Game Replay */}
      {trickHistory.length > 0 && !showReplay && (
        <button onClick={() => setShowReplay(true)}
          className="w-full py-3 rounded-xl font-bold text-sm text-amber-700 bg-gradient-to-r from-amber-50 to-yellow-50 border-2 border-amber-200 hover:from-amber-100 hover:to-yellow-100 transition-all shadow-md">
          🎬 Replay Game Step-by-Step
        </button>
      )}
      {showReplay && (
        <GameReplay trickHistory={trickHistory} onClose={() => setShowReplay(false)} />
      )}

      {/* Spectator Link */}
      <div className="flex items-center justify-center gap-2 text-xs">
        <button
          onClick={() => navigator.clipboard.writeText(spectateUrl)}
          className="px-4 py-2 rounded-lg bg-purple-50 border border-purple-200 text-purple-700 hover:bg-purple-100 font-semibold transition-colors"
          style={{ border: '1px solid rgba(168,85,247,0.3)' }}
        >
          👁️ Copy Spectator Link
        </button>
      </div>

      <button onClick={onStartNewGame}
        className="w-full py-4 rounded-xl font-bold text-gray-700 bg-gradient-to-r from-gray-200 to-gray-300 hover:from-gray-300 hover:to-gray-400 transition-all shadow-lg">
        Start New Game
      </button>
    </div>
  );
}
