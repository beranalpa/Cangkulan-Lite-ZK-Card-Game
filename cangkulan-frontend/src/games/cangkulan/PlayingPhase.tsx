import { useState, useEffect, useRef, useCallback } from 'react';
import type { GameState, TrickRecord, ProofMode } from './types';
import { TRICK, LIFECYCLE, CANNOT_FOLLOW_SENTINEL } from './types';
import { cardSuit, cardLabel, hasMatchingSuitCards, SUIT_SYMBOLS, SUIT_NAMES } from './cardHelpers';
import { PlayingCard, CardBack } from './PlayingCard';
import { AnimatedCard, TrickResultOverlay, AnimatePresence } from './cardAnimations';
import { GameTable } from './GameTable';
import { TimeoutControls } from './TimeoutControls';
import { EmojiReactions } from './EmojiReactions';
import { ProgressiveScoreDisplay } from './ProgressiveScore';
import { ZkVerificationBadge } from './ZkVerificationBadge';

// ─── Touch Drag Helpers ────────────────────────────────────────────────────
interface TouchDragState {
  cardId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  ghost: HTMLDivElement | null;
}

function createGhostElement(sourceEl: HTMLElement): HTMLDivElement {
  const ghost = document.createElement('div');
  ghost.style.position = 'fixed';
  ghost.style.zIndex = '9999';
  ghost.style.pointerEvents = 'none';
  ghost.style.opacity = '0.85';
  ghost.style.transform = 'scale(1.1) rotate(-3deg)';
  ghost.style.transition = 'transform 0.1s ease';
  ghost.style.filter = 'drop-shadow(0 8px 16px rgba(0,0,0,0.3))';
  ghost.innerHTML = sourceEl.innerHTML;
  const rect = sourceEl.getBoundingClientRect();
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);
  return ghost;
}

function removeGhostElement(ghost: HTMLDivElement | null) {
  if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
}

// ─── Opponent Activity Indicator ───────────────────────────────────────────
function OpponentIndicator({ gameState, isWaitingForOpponent }: { gameState: GameState; isWaitingForOpponent: boolean }) {
  const lastNonceRef = useRef(gameState.action_nonce);
  const [lastActive, setLastActive] = useState<number>(Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (gameState.action_nonce !== lastNonceRef.current) {
      lastNonceRef.current = gameState.action_nonce;
      setLastActive(Date.now());
    }
  }, [gameState.action_nonce]);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(iv);
  }, []);

  const secsAgo = Math.floor((now - lastActive) / 1000);
  const isActive = secsAgo < 15;
  const isRecent = secsAgo < 60;

  if (!isWaitingForOpponent) return null;

  const statusText = isActive ? 'Opponent active' : isRecent ? `Last seen ${secsAgo}s ago` : `Idle ${Math.floor(secsAgo / 60)}m`;
  const statusShape = isActive ? '●' : isRecent ? '◐' : '○';

  return (
    <div className="flex items-center gap-1.5 text-xs" role="status" aria-live="polite" aria-label={`Opponent status: ${statusText}`}>
      <span
        className={`inline-block w-2 h-2 rounded-full ${isActive ? 'bg-green-500 animate-pulse' : isRecent ? 'bg-yellow-500' : 'bg-gray-400'
          }`}
        aria-hidden="true"
      />
      <span className="sr-only">{statusShape}</span>
      <span className={`font-semibold ${isActive ? 'text-green-700' : isRecent ? 'text-yellow-700' : 'text-gray-500'}`}>
        {statusText}
      </span>
    </div>
  );
}

interface PlayingPhaseProps {
  gameState: GameState;
  userAddress: string;
  isPlayer1: boolean;
  isPlayer2: boolean;
  playerNumber: number;
  isBusy: boolean;
  loading: boolean;
  onCommitPlay: (cardId: number) => void;
  onRevealPlay: () => void;
  onTickTimeout: () => void;
  onResolveTimeout: () => void;
  onForfeit?: () => void;
  isWaitingForOpponent: boolean;
  timeoutReady: boolean | undefined;
  canTimeout: boolean;
  lastTrickResult: string | null;
  sessionId: number;
  autoCommitStatus?: string | null;
  proofMode?: ProofMode;
  /** Override opponent hand size (used in vs-Bot mode where contract redacts hand2 for P1's view) */
  opponentHandSizeOverride?: number;
}

export function PlayingPhase({
  gameState,
  userAddress,
  isPlayer1,
  isPlayer2,
  playerNumber,
  isBusy,
  loading,
  onCommitPlay,
  onRevealPlay,
  onTickTimeout,
  onResolveTimeout,
  onForfeit,
  isWaitingForOpponent,
  timeoutReady,
  canTimeout,
  lastTrickResult,
  sessionId,
  autoCommitStatus,
  proofMode = 'pedersen',
  opponentHandSizeOverride,
}: PlayingPhaseProps) {
  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  const [dragOverDrop, setDragOverDrop] = useState(false);
  const [draggingCard, setDraggingCard] = useState<number | null>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const touchDragRef = useRef<TouchDragState | null>(null);

  // ─── Touch drag handlers (mobile support) ─────────────────────────────
  const isOverDropZone = useCallback((x: number, y: number): boolean => {
    if (!dropZoneRef.current) return false;
    const rect = dropZoneRef.current.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }, []);

  const handleTouchStart = useCallback((cardId: number, e: React.TouchEvent) => {
    const touch = e.touches[0];
    const el = (e.currentTarget as HTMLElement);
    const ghost = createGhostElement(el);
    ghost.style.left = `${touch.clientX - 30}px`;
    ghost.style.top = `${touch.clientY - 40}px`;
    touchDragRef.current = { cardId, startX: touch.clientX, startY: touch.clientY, currentX: touch.clientX, currentY: touch.clientY, ghost };
    setDraggingCard(cardId);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const td = touchDragRef.current;
    if (!td) return;
    e.preventDefault(); // prevent scroll while dragging
    const touch = e.touches[0];
    td.currentX = touch.clientX;
    td.currentY = touch.clientY;
    if (td.ghost) {
      td.ghost.style.left = `${touch.clientX - 30}px`;
      td.ghost.style.top = `${touch.clientY - 40}px`;
    }
    setDragOverDrop(isOverDropZone(touch.clientX, touch.clientY));
  }, [isOverDropZone]);

  const myHand = isPlayer1 ? (gameState.hand1 ?? []) : isPlayer2 ? (gameState.hand2 ?? []) : [];
  const rawOpponentSize = isPlayer1 ? (gameState.hand2?.length ?? 0) : (gameState.hand1?.length ?? 0);
  // Use override if provided (e.g. bot hand size, since contract redacts it in P1's view)
  const opponentHandSize = opponentHandSizeOverride ?? rawOpponentSize;
  const trickSuit = gameState.trick_suit ?? null;
  const trickState = gameState.trick_state ?? TRICK.NONE;
  const drawPileSize = gameState.draw_pile?.length ?? 0;

  // Commit phase: player can commit if state is COMMIT_WAIT_BOTH or waiting for them
  const isMyCommitTurn = trickState === TRICK.COMMIT_WAIT_BOTH
    || (trickState === TRICK.COMMIT_WAIT_P1 && isPlayer1)
    || (trickState === TRICK.COMMIT_WAIT_P2 && isPlayer2);

  const handleTouchEnd = useCallback(() => {
    const td = touchDragRef.current;
    if (!td) return;
    removeGhostElement(td.ghost);
    if (isOverDropZone(td.currentX, td.currentY) && isMyCommitTurn && !isBusy && trickSuit !== null && cardSuit(td.cardId) === trickSuit) {
      onCommitPlay(td.cardId);
      setSelectedCard(null);
    }
    setDraggingCard(null);
    setDragOverDrop(false);
    touchDragRef.current = null;
  }, [isOverDropZone, trickSuit, onCommitPlay, isMyCommitTurn, isBusy]);

  // Clean up ghost element on unmount
  useEffect(() => {
    return () => {
      if (touchDragRef.current?.ghost) {
        removeGhostElement(touchDragRef.current.ghost);
      }
    };
  }, []);

  // My commit is done if we're past commit waiting for me
  const hasCommitted = (trickState === TRICK.COMMIT_WAIT_P1 && isPlayer2)
    || (trickState === TRICK.COMMIT_WAIT_P2 && isPlayer1)
    || trickState === TRICK.REVEAL_WAIT_BOTH
    || trickState === TRICK.REVEAL_WAIT_P1
    || trickState === TRICK.REVEAL_WAIT_P2;

  // Reveal phase: auto-handled by parent component
  const isRevealPhase = trickState === TRICK.REVEAL_WAIT_BOTH
    || trickState === TRICK.REVEAL_WAIT_P1
    || trickState === TRICK.REVEAL_WAIT_P2;

  const canFollowSuit = trickSuit !== null && hasMatchingSuitCards(myHand as number[], trickSuit);

  // Status text for the current phase
  const phaseStatus = (() => {
    if (trickState === TRICK.COMMIT_WAIT_BOTH) return '🎯 Both players choose a card...';
    if (trickState === TRICK.COMMIT_WAIT_P1 && isPlayer1) return '🎯 Your turn to choose a card';
    if (trickState === TRICK.COMMIT_WAIT_P1 && isPlayer2) return '⏳ Waiting for opponent to choose...';
    if (trickState === TRICK.COMMIT_WAIT_P2 && isPlayer2) return '🎯 Your turn to choose a card';
    if (trickState === TRICK.COMMIT_WAIT_P2 && isPlayer1) return '⏳ Waiting for opponent to choose...';
    if (trickState === TRICK.REVEAL_WAIT_BOTH) return '🔓 Revealing cards...';
    if (trickState === TRICK.REVEAL_WAIT_P1 && isPlayer1) return '🔓 Revealing your card...';
    if (trickState === TRICK.REVEAL_WAIT_P1 && isPlayer2) return '⏳ Waiting for opponent to reveal...';
    if (trickState === TRICK.REVEAL_WAIT_P2 && isPlayer2) return '🔓 Revealing your card...';
    if (trickState === TRICK.REVEAL_WAIT_P2 && isPlayer1) return '⏳ Waiting for opponent to reveal...';
    return '';
  })();

  return (
    <div className="space-y-5">
      {/* Progressive Score Display */}
      <div className="p-3 bg-gradient-to-r from-emerald-50 to-teal-50 border-2 border-emerald-200 rounded-xl">
        <ProgressiveScoreDisplay
          p1Tricks={gameState.tricks_won1}
          p2Tricks={gameState.tricks_won2}
          p1HandSize={myHand.length}
          p2HandSize={opponentHandSize}
          drawPileSize={drawPileSize}
          playerNumber={playerNumber}
        />
        <div className="mt-2 text-right">
          <OpponentIndicator gameState={gameState} isWaitingForOpponent={isWaitingForOpponent} />
        </div>
      </div>

      {/* Emoji Reactions */}
      <EmojiReactions sessionId={sessionId} userAddress={userAddress} />

      {/* Auto-commit Status */}
      {autoCommitStatus && (
        <div className="p-2.5 rounded-xl text-center bg-indigo-50 border-2 border-indigo-300 animate-pulse">
          <p className="text-sm font-bold text-indigo-700">{autoCommitStatus}</p>
        </div>
      )}

      {/* Phase Status */}
      {phaseStatus && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={`p-2.5 rounded-xl text-center transition-all duration-300 ${isWaitingForOpponent
            ? 'bg-amber-50 border border-amber-300'
            : isMyCommitTurn
              ? 'bg-emerald-50 border-2 border-emerald-300 pulse-glow'
              : 'bg-blue-50 border border-blue-200'
            }`}
        >
          <p className={`text-sm font-semibold ${isWaitingForOpponent ? 'text-amber-700' : isMyCommitTurn ? 'text-emerald-700' : 'text-blue-700'
            }`}>{phaseStatus}</p>
        </div>
      )}

      {/* Table Area — with Drop Zone */}
      <div
        ref={dropZoneRef}
        className={`relative transition-all duration-200 ${dragOverDrop ? 'ring-4 ring-emerald-400 ring-offset-2 rounded-2xl' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOverDrop(true);
        }}
        onDragLeave={() => setDragOverDrop(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverDrop(false);
          const cardId = parseInt(e.dataTransfer.getData('text/card-id'), 10);
          if (!isNaN(cardId) && isMyCommitTurn && trickSuit !== null && cardSuit(cardId) === trickSuit) {
            onCommitPlay(cardId);
            setSelectedCard(null);
            setDraggingCard(null);
          }
        }}
      >
        {dragOverDrop && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="px-6 py-3 rounded-xl bg-emerald-500/90 text-white font-bold text-sm shadow-xl backdrop-blur-sm animate-pulse">
              Drop card here to play!
            </div>
          </div>
        )}
        <GameTable gameState={gameState} isPlayer1={isPlayer1} isPlayer2={isPlayer2} />
      </div>

      {/* Opponent Hand Visualization */}
      {opponentHandSize > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold text-gray-500 uppercase">Opponent's Hand ({opponentHandSize} cards)</h3>
          </div>
          <div className="flex flex-wrap gap-1 p-2 bg-gray-50 rounded-lg border border-gray-200">
            {Array.from({ length: Math.min(opponentHandSize, 15) }).map((_, i) => (
              <CardBack key={i} size="sm" />
            ))}
            {opponentHandSize > 15 && (
              <span className="flex items-center text-xs font-bold text-gray-400 px-2">+{opponentHandSize - 15}</span>
            )}
          </div>
        </div>
      )}

      {/* Your Hand */}
      {(isPlayer1 || isPlayer2) && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-gray-800">Your Hand ({myHand.length} cards)</h3>
            {isMyCommitTurn && trickSuit !== null && (
              <span className="text-xs font-bold text-emerald-700 truncate max-w-[55%] text-right">
                {canFollowSuit
                  ? `Drag or tap a ${SUIT_SYMBOLS[trickSuit]} ${SUIT_NAMES[trickSuit]} card`
                  : `No ${SUIT_NAMES[trickSuit]} cards — declare can't follow`}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2 min-h-[5.5rem] p-3 bg-gray-50 rounded-xl border-2 border-gray-200">
            <AnimatePresence mode="popLayout">
              {(myHand as number[]).sort((a, b) => a - b).map((cardId, idx) => {
                const isPlayable = isMyCommitTurn && trickSuit !== null && cardSuit(cardId) === trickSuit;
                return (
                  <AnimatedCard key={cardId} cardId={cardId} index={idx}>
                    <div
                      className={`card-deal-anim card-hover-lift card-stagger-${Math.min(idx, 9)} ${draggingCard === cardId ? 'opacity-40 scale-90' : ''}`}
                      draggable={isPlayable && !isBusy}
                      onDragStart={(e) => {
                        if (!isPlayable) return;
                        e.dataTransfer.setData('text/card-id', cardId.toString());
                        e.dataTransfer.effectAllowed = 'move';
                        setDraggingCard(cardId);
                      }}
                      onDragEnd={() => setDraggingCard(null)}
                      onTouchStart={isPlayable && !isBusy ? (e) => handleTouchStart(cardId, e) : undefined}
                      onTouchMove={isPlayable && !isBusy ? handleTouchMove : undefined}
                      onTouchEnd={isPlayable && !isBusy ? handleTouchEnd : undefined}
                      style={{ cursor: isPlayable ? 'grab' : undefined, touchAction: isPlayable ? 'none' : undefined }}
                    >
                      <PlayingCard
                        cardId={cardId}
                        selected={selectedCard === cardId}
                        playable={isPlayable}
                        onClick={isPlayable ? () => {
                          if (selectedCard === cardId) {
                            onCommitPlay(cardId);
                            setSelectedCard(null);
                          } else {
                            setSelectedCard(cardId);
                          }
                        } : undefined}
                        onKeyDown={isPlayable ? (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (selectedCard === cardId) {
                              onCommitPlay(cardId);
                              setSelectedCard(null);
                            } else {
                              setSelectedCard(cardId);
                            }
                          } else if (e.key === 'Escape') {
                            setSelectedCard(null);
                          }
                        } : undefined}
                      />
                    </div>
                  </AnimatedCard>
                );
              })}
            </AnimatePresence>
            {myHand.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-gray-400 text-sm font-semibold">No cards — well done!</div>
            )}
          </div>

          {/* Action Buttons */}
          {isMyCommitTurn && trickSuit !== null && (
            <div className="mt-3 flex gap-3">
              {selectedCard !== null && canFollowSuit && (
                <button onClick={() => { onCommitPlay(selectedCard); setSelectedCard(null); }} disabled={isBusy}
                  className="flex-1 py-3 rounded-xl font-bold text-white bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-lg">
                  {loading ? 'Committing...' : `Play ${cardLabel(selectedCard)}`}
                </button>
              )}
              {!canFollowSuit && (
                <button onClick={() => onCommitPlay(CANNOT_FOLLOW_SENTINEL)} disabled={isBusy}
                  className="flex-1 py-3 rounded-xl font-bold text-white bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-lg">
                  {loading ? 'Declaring...' : "🚫 Can't Follow Suit"}
                </button>
              )}
            </div>
          )}

          {hasCommitted && !isRevealPhase && (
            <div role="status" aria-live="polite" className="mt-3 p-3 bg-blue-50 border-2 border-blue-200 rounded-xl">
              <p className="text-sm font-semibold text-blue-700">✓ Card committed! Waiting for opponent...</p>
              {(gameState.zk_play1 || gameState.zk_play2) && (
                <div className="mt-1.5">
                  <ZkVerificationBadge variant="action" proofMode={proofMode} verified actionLabel="Card Play" />
                </div>
              )}
            </div>
          )}

          {isRevealPhase && (
            <div role="status" aria-live="polite" className="mt-3 p-3 bg-amber-50 border-2 border-amber-200 rounded-xl">
              <p className="text-sm font-semibold text-amber-700">🔓 Revealing cards automatically...</p>
              {(gameState.zk_play1 || gameState.zk_play2) && (
                <div className="mt-1.5">
                  <ZkVerificationBadge variant="action" proofMode={proofMode} verified actionLabel="Play Reveal" />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Timeout Controls */}
      {canTimeout && (
        <TimeoutControls gameState={gameState} isBusy={isBusy} loading={loading}
          onTick={onTickTimeout} onResolve={onResolveTimeout} timeoutReady={timeoutReady}
          isWaitingForOpponent={isWaitingForOpponent} sessionId={sessionId} />
      )}

      {/* Forfeit / Withdraw */}
      {onForfeit && (isPlayer1 || isPlayer2) && (
        <ForfeitButton onForfeit={onForfeit} isBusy={isBusy} />
      )}

      {/* Last Trick Result */}
      <TrickResultOverlay message={lastTrickResult} />
    </div>
  );
}

// ─── Forfeit Button ────────────────────────────────────────────────────────
function ForfeitButton({ onForfeit, isBusy }: { onForfeit: () => void; isBusy: boolean }) {
  const [confirmForfeit, setConfirmForfeit] = useState(false);

  const handleClick = () => {
    if (!confirmForfeit) {
      setConfirmForfeit(true);
      setTimeout(() => setConfirmForfeit(false), 4000);
      return;
    }
    onForfeit();
    setConfirmForfeit(false);
  };

  return (
    <div className="flex justify-end mt-2">
      <button
        onClick={handleClick}
        disabled={isBusy}
        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${confirmForfeit
          ? 'border-red-400 bg-red-100 text-red-700 hover:bg-red-200 animate-pulse'
          : 'border-gray-200 bg-gray-50 text-gray-400 hover:text-gray-600 hover:bg-gray-100'
          } disabled:opacity-40`}
        title={confirmForfeit ? 'Click again to forfeit — you will LOSE this game!' : 'Withdraw from this game (counts as a loss)'}
      >
        {confirmForfeit ? '⚠️ Confirm Forfeit (= LOSE)' : '🏳️ Withdraw'}
      </button>
    </div>
  );
}
