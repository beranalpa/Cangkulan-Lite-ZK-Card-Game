import type { GameState } from './types';
import { TRICK, LIFECYCLE } from './types';
import { cardSuit, SUIT_NAMES } from './cardHelpers';
import { PlayingCard, CardBack } from './PlayingCard';

interface GameTableProps {
  gameState: GameState;
  isPlayer1: boolean;
  isPlayer2: boolean;
}

export function GameTable({ gameState, isPlayer1, isPlayer2 }: GameTableProps) {
  const drawPileSize = gameState.draw_pile?.length ?? 0;
  const flippedCard = gameState.flipped_card ?? null;
  const trickState = gameState.trick_state ?? TRICK.NONE;

  // During commit phase, show "committed" indicator if the player has committed
  const p1Committed = gameState.play_commit1 != null;
  const p2Committed = gameState.play_commit2 != null;

  // Determine if we're in commit or reveal phase
  const isCommitPhase = trickState === TRICK.COMMIT_WAIT_BOTH
    || trickState === TRICK.COMMIT_WAIT_P1
    || trickState === TRICK.COMMIT_WAIT_P2;
  const isRevealPhase = trickState === TRICK.REVEAL_WAIT_BOTH
    || trickState === TRICK.REVEAL_WAIT_P1
    || trickState === TRICK.REVEAL_WAIT_P2;

  return (
    <div className="p-3 sm:p-5 bg-gradient-to-br from-green-800 to-green-900 rounded-2xl shadow-inner">
      <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6">
        {/* Draw Pile */}
        <div className="text-center">
          <div className="text-xs font-bold text-green-300 mb-2">Draw Pile ({drawPileSize})</div>
          {drawPileSize > 0 ? <CardBack size="md" /> : <div className="w-[4.2rem] h-[6rem] rounded-xl border-2 border-dashed border-green-600 flex items-center justify-center text-green-500 text-xs">Empty</div>}
        </div>

        {/* Flipped Card (lead) */}
        <div className="text-center">
          <div className="text-xs font-bold text-yellow-300 mb-2">
            {flippedCard != null ? `Lead: ${SUIT_NAMES[cardSuit(flippedCard)]}` : 'No Lead'}
          </div>
          {flippedCard != null ? (
            <div className="transform scale-110 card-flip-anim">
              <PlayingCard cardId={flippedCard} size="md" />
            </div>
          ) : (
            <div className="w-[4.2rem] h-[6rem] rounded-xl border-2 border-dashed border-yellow-600 flex items-center justify-center text-yellow-500 text-xs">—</div>
          )}
        </div>

        {/* Trick Cards */}
        <div className="flex gap-2 sm:gap-4">
          <div className="text-center">
            <div className="text-xs font-bold text-blue-300 mb-2">P1</div>
            {gameState.trick_card1 != null ? (
              <div className="card-reveal-3d-anim">
                <PlayingCard cardId={gameState.trick_card1} size="md" />
              </div>
            ) : isCommitPhase && p1Committed ? (
              <div className="w-[4.2rem] h-[6rem] rounded-xl border-2 border-blue-400 bg-gradient-to-br from-blue-500 to-blue-700 shadow-lg flex items-center justify-center">
                <span className="text-white text-xs font-bold">🔒</span>
              </div>
            ) : isRevealPhase && !gameState.trick_card1 ? (
              <div className="w-[4.2rem] h-[6rem] rounded-xl border-2 border-blue-400 bg-gradient-to-br from-blue-500 to-blue-700 shadow-lg flex items-center justify-center animate-pulse">
                <span className="text-white text-xs font-bold">🔓</span>
              </div>
            ) : (
              <div className="w-[4.2rem] h-[6rem] rounded-xl border-2 border-dashed border-blue-600 flex items-center justify-center text-blue-400 text-xs">?</div>
            )}
          </div>
          <div className="text-center">
            <div className="text-xs font-bold text-purple-300 mb-2">P2</div>
            {gameState.trick_card2 != null ? (
              <div className="card-reveal-3d-anim">
                <PlayingCard cardId={gameState.trick_card2} size="md" />
              </div>
            ) : isCommitPhase && p2Committed ? (
              <div className="w-[4.2rem] h-[6rem] rounded-xl border-2 border-purple-400 bg-gradient-to-br from-purple-500 to-purple-700 shadow-lg flex items-center justify-center">
                <span className="text-white text-xs font-bold">🔒</span>
              </div>
            ) : isRevealPhase && !gameState.trick_card2 ? (
              <div className="w-[4.2rem] h-[6rem] rounded-xl border-2 border-purple-400 bg-gradient-to-br from-purple-500 to-purple-700 shadow-lg flex items-center justify-center animate-pulse">
                <span className="text-white text-xs font-bold">🔓</span>
              </div>
            ) : (
              <div className="w-[4.2rem] h-[6rem] rounded-xl border-2 border-dashed border-purple-600 flex items-center justify-center text-purple-400 text-xs">?</div>
            )}
          </div>
        </div>
      </div>

      {/* Trick Status */}
      <div className="mt-4 text-center">
        {trickState === TRICK.NONE && (
          <p className="text-sm font-bold text-yellow-300">Waiting for next card flip...</p>
        )}
        {trickState === TRICK.COMMIT_WAIT_BOTH && (
          <p className="text-sm font-bold text-green-300">Both players: choose a {gameState.trick_suit != null ? SUIT_NAMES[gameState.trick_suit] : ''} card</p>
        )}
        {trickState === TRICK.COMMIT_WAIT_P1 && (
          <p className="text-sm font-bold text-blue-300">
            {isPlayer1 ? "Your turn to choose a card" : 'Waiting for Player 1 to choose...'}
          </p>
        )}
        {trickState === TRICK.COMMIT_WAIT_P2 && (
          <p className="text-sm font-bold text-purple-300">
            {isPlayer2 ? "Your turn to choose a card" : 'Waiting for Player 2 to choose...'}
          </p>
        )}
        {trickState === TRICK.REVEAL_WAIT_BOTH && (
          <p className="text-sm font-bold text-amber-300">Both cards locked in — revealing...</p>
        )}
        {trickState === TRICK.REVEAL_WAIT_P1 && (
          <p className="text-sm font-bold text-blue-300">
            {isPlayer1 ? 'Revealing your card...' : 'Waiting for Player 1 to reveal...'}
          </p>
        )}
        {trickState === TRICK.REVEAL_WAIT_P2 && (
          <p className="text-sm font-bold text-purple-300">
            {isPlayer2 ? 'Revealing your card...' : 'Waiting for Player 2 to reveal...'}
          </p>
        )}
      </div>
    </div>
  );
}
