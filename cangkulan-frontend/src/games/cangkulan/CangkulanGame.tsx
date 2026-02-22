import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CangkulanService } from './cangkulanService';
import { TransactionLog, useTransactionLog } from '@/components/TransactionLog';
import { useToast, ToastContainer } from '@/components/Toast';
import { getActiveCangkulanContract } from '@/utils/constants';
import { useNetworkStore } from '@/store/networkStore';
import { useWallet } from '@/hooks/useWallet';
import { saveActiveSession, clearActiveSession } from '@/hooks/useHashRouter';
import { useSmartPolling } from './useSmartPolling';

import type { CangkulanGameProps, GamePhase, TrickRecord, GameState } from './types';
import { LIFECYCLE, TRICK, OUTCOME, POINTS_DECIMALS } from './types';
import { playSound } from './soundHelpers';
import { addGameToHistory } from './gameHistory';
import type { GameHistoryEntry } from './gameHistory';
import { useCangkulanActions } from './useCangkulanActions';
import { useTurnNotification } from './useTurnNotification';
import { useBotAutoPlay } from './useBotAutoPlay';
import { saveBotSession } from './ai/BotPlayer';

import { CreatePhase } from './CreatePhase';
import { SeedPhase } from './SeedPhase';
import { PlayingPhase } from './PlayingPhase';
import { CompletePhase } from './CompletePhase';
import { GameLoadingSkeleton } from './GameLoadingSkeleton';
import { CardDealAnimation } from './CardDealAnimation';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const createRandomSessionId = (): number => {
  const buffer = new Uint32Array(1);
  let value = 0;
  while (value === 0) {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  }
  return value;
};

function phaseFromLifecycle(state: number): GamePhase {
  switch (state) {
    case LIFECYCLE.SEED_COMMIT: return 'seed-commit';
    case LIFECYCLE.SEED_REVEAL: return 'seed-reveal';
    case LIFECYCLE.PLAYING: return 'playing';
    case LIFECYCLE.FINISHED: return 'complete';
    default: return 'seed-commit';
  }
}

const parsePoints = (value: string): bigint | null => {
  try {
    const cleaned = value.replace(/[^\d.]/g, '');
    if (!cleaned || cleaned === '.') return null;
    const [whole = '0', fraction = ''] = cleaned.split('.');
    const paddedFraction = fraction.padEnd(POINTS_DECIMALS, '0').slice(0, POINTS_DECIMALS);
    return BigInt(whole + paddedFraction);
  } catch { return null; }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  Service Instance — re-created when active network changes
// ═══════════════════════════════════════════════════════════════════════════════

function useCangkulanService(): CangkulanService {
  const activeNetwork = useNetworkStore(s => s.activeNetwork);
  const localContractIds = useNetworkStore(s => s.localContractIds);
  // Re-create service when network or contract IDs change
  return useMemo(
    () => new CangkulanService(getActiveCangkulanContract()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeNetwork, localContractIds.cangkulan],
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Main Component (Orchestrator)
// ═══════════════════════════════════════════════════════════════════════════════

export function CangkulanGame({
  userAddress,
  availablePoints,
  initialXDR,
  initialSessionId,
  onStandingsRefresh,
  onGameComplete,
  navigate,
  botPlayer,
  gameMode = 'multiplayer',
  autoQuickstart,
}: CangkulanGameProps) {
  const { getContractSigner } = useWallet();
  const { txLog, addTx, clearLog } = useTransactionLog();
  const toast = useToast();
  const cangkulanService = useCangkulanService();

  // ─── Core State ──────────────────────────────────────────────────────────
  const [sessionId, setSessionIdInternal] = useState<number>(
    () => initialSessionId ?? createRandomSessionId(),
  );
  const [player1Address, setPlayer1Address] = useState(userAddress);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [quickstartLoading, setQuickstartLoading] = useState(false);
  const [sessionIdCopied, setSessionIdCopied] = useState(false);
  const [gamePhase, setGamePhaseInternal] = useState<GamePhase>(
    initialSessionId ? 'seed-commit' : 'create',
  );
  const [showDealAnimation, setShowDealAnimation] = useState(false);
  const [exitConfirm, setExitConfirm] = useState(false);
  const prevPhaseRef = useRef<GamePhase>(initialSessionId ? 'seed-commit' : 'create');

  // Wrapped setters that also update the URL hash / localStorage
  const setSessionId = useCallback((id: number) => {
    setSessionIdInternal(id);
    navigate?.({ page: 'game', sessionId: id });
    saveActiveSession(id, userAddress);
  }, [navigate, userAddress]);

  const setGamePhase = useCallback((phase: GamePhase) => {
    setGamePhaseInternal(phase);
    if (phase === 'create') {
      navigate?.({ page: 'home' });
      clearActiveSession();
    }
  }, [navigate]);

  // ─── Trick History ───────────────────────────────────────────────────────
  const [trickHistory, setTrickHistory] = useState<TrickRecord[]>([]);
  const prevTricksRef = useRef({ won1: 0, won2: 0 });
  const [lastTrickResult, setLastTrickResult] = useState<string | null>(null);

  useEffect(() => { setPlayer1Address(userAddress); }, [userAddress]);

  // ═══════════════════════════════════════════════════════════════════════════
  //  Smart Game State Polling (adaptive, visibility-aware)
  // ═══════════════════════════════════════════════════════════════════════════

  const loadGameState = useCallback(async () => {
    // Guard: skip fetch when wallet address is not yet available.
    // On page refresh the wallet may connect asynchronously; fetching
    // getGameView with an empty address returns a spectator view where
    // both hands are redacted (privacy protection), making all cards
    // disappear from the UI.
    if (!userAddress) return null;
    try {
      const game = await cangkulanService.getGameView(sessionId, userAddress);
      if (game) {
        setGameState(game);
        setGamePhaseInternal(phaseFromLifecycle(game.lifecycle_state));
        saveActiveSession(sessionId, userAddress);
      }
      return game;
    } catch { return null; }
  }, [sessionId, userAddress]);

  const pollingConfig = useMemo(() => ({
    baseInterval: gamePhase === 'playing' ? 1500 : gamePhase === 'seed-reveal' ? 2000 : 4000,
    maxInterval: gamePhase === 'playing' ? 5000 : 12000,
    backoffFactor: 1.3,
    enabled: gamePhase !== 'create',
  }), [gamePhase]);

  const { nudge: nudgePoll } = useSmartPolling(loadGameState, pollingConfig);

  // Wrap loadGameState so manual calls also reset the polling interval
  const loadGameStateAndNudge = useCallback(async () => {
    await loadGameState();
    nudgePoll();
  }, [loadGameState, nudgePoll]);

  // When the wallet address becomes available after a page refresh,
  // force an immediate re-fetch so that hand cards appear right away
  // instead of waiting for the next scheduled polling interval.
  const prevUserAddressRef = useRef('');
  useEffect(() => {
    if (userAddress && userAddress !== prevUserAddressRef.current && gamePhase !== 'create') {
      prevUserAddressRef.current = userAddress;
      loadGameState();
    }
  }, [userAddress, gamePhase, loadGameState]);

  // ═══════════════════════════════════════════════════════════════════════════
  //  Derived State
  // ═══════════════════════════════════════════════════════════════════════════

  const isPlayer1 = gameState?.player1 === userAddress;
  const isPlayer2 = gameState?.player2 === userAddress;
  const playerNumber = isPlayer1 ? 1 : isPlayer2 ? 2 : 0;

  // Allow timeout in bot games as a safety valve — the bot *should* act
  // automatically, but if it fails (e.g. seed recovery loss after refresh)
  // the player must have a way to escape the deadlocked game.
  const canTimeout = !!(gameState && gameState.lifecycle_state !== LIFECYCLE.FINISHED);
  const timeoutReady = gameState?.deadline_nonce != null && gameState.action_nonce >= (gameState.deadline_nonce ?? Infinity);
  const trickState = gameState?.trick_state ?? TRICK.NONE;

  const isWaitingForOpponent = (() => {
    if (!gameState || gameState.lifecycle_state === LIFECYCLE.FINISHED) return false;
    if (gameState.lifecycle_state === LIFECYCLE.SEED_COMMIT) {
      if (isPlayer1 && gameState.seed_commit1 != null && gameState.seed_commit2 == null) return true;
      if (isPlayer2 && gameState.seed_commit2 != null && gameState.seed_commit1 == null) return true;
    }
    if (gameState.lifecycle_state === LIFECYCLE.SEED_REVEAL) {
      if (isPlayer1 && gameState.seed_revealed1 && !gameState.seed_revealed2) return true;
      if (isPlayer2 && gameState.seed_revealed2 && !gameState.seed_revealed1) return true;
    }
    if (gameState.lifecycle_state === LIFECYCLE.PLAYING) {
      if (isPlayer1 && trickState === TRICK.COMMIT_WAIT_P2) return true;
      if (isPlayer2 && trickState === TRICK.COMMIT_WAIT_P1) return true;
      if (isPlayer1 && trickState === TRICK.REVEAL_WAIT_P2) return true;
      if (isPlayer2 && trickState === TRICK.REVEAL_WAIT_P1) return true;
    }
    return false;
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  //  useCangkulanActions Hook
  // ═══════════════════════════════════════════════════════════════════════════

  const actions = useCangkulanActions({
    service: cangkulanService,
    sessionId,
    userAddress,
    isPlayer1,
    isPlayer2,
    gameState,
    getContractSigner,
    addTx,
    loadGameStateAndNudge,
    onStandingsRefresh,
    gameMode,
  });

  // ─── Push Notifications (background tab turn alerts) ──────────────────────
  const isActiveGame = gamePhase === 'playing' || gamePhase === 'seed-commit' || gamePhase === 'seed-reveal';
  const notifications = useTurnNotification({ isWaitingForOpponent, isActiveGame, sessionId });

  // ─── Bot Auto-Play (when botPlayer is provided) ──────────────────────────
  // Track bot hand size separately — contract redacts hand2 for privacy in
  // P1's view, so we get it from the bot's own getGameView fetch.
  const [botHandSize, setBotHandSize] = useState<number | null>(null);
  useBotAutoPlay({
    bot: botPlayer,
    service: cangkulanService,
    sessionId,
    gameState,
    loadGameState: loadGameStateAndNudge,
    addTx,
    proofMode: actions.proofMode,
    onBotHandSize: setBotHandSize,
  });

  // Auto-create game when botPlayer is provided and we're still in create phase
  const botAutoCreateRef = useRef(false);
  useEffect(() => {
    if (!botPlayer || gamePhase !== 'create' || botAutoCreateRef.current) return;
    botAutoCreateRef.current = true;

    (async () => {
      try {
        setQuickstartLoading(true);
        const botSigner = botPlayer.getContractSigner();
        const humanSigner = getContractSigner();
        const qsSessionId = createRandomSessionId();
        const points = 10000000n; // 1 XLM (7 decimals)

        setSessionId(qsSessionId);
        setPlayer1Address(userAddress);

        const startResult = await cangkulanService.startGameDirect(
          qsSessionId, userAddress, botPlayer.address,
          points, points, humanSigner, botSigner,
        );
        if (startResult.txHash) addTx('Start Game (vs Bot)', startResult.txHash, userAddress, `Session #${qsSessionId}`);

        try {
          const game = await cangkulanService.getGame(qsSessionId);
          setGameState(game);
        } catch { /* ignore */ }
        setGamePhaseInternal('seed-commit');
        onStandingsRefresh();
        // Persist bot session for page-refresh recovery
        if (botPlayer.serialize) {
          saveBotSession(botPlayer.serialize(qsSessionId));
        }
        toast.success(`Game started vs ${botPlayer.displayName}!`);
      } catch (err) {
        toast.error(`Bot game creation failed: ${err instanceof Error ? err.message : String(err)}`);
        botAutoCreateRef.current = false; // Allow retry
      } finally {
        setQuickstartLoading(false);
      }
    })();
  }, [botPlayer, gamePhase]);

  const isBusy = actions.loading || quickstartLoading;

  // ─── Detect seed→playing transition for deal animation ────────────────────
  useEffect(() => {
    const prev = prevPhaseRef.current;
    if ((prev === 'seed-reveal' || prev === 'seed-commit') && gamePhase === 'playing') {
      setShowDealAnimation(true);
    }
    prevPhaseRef.current = gamePhase;
  }, [gamePhase]);

  // ─── Game-end sound + record history ──────────────────────────────────────
  const historyRecorded = useRef(false);
  useEffect(() => {
    if (gamePhase === 'complete' && gameState && gameState.outcome !== OUTCOME.UNRESOLVED) {
      onStandingsRefresh();
      playSound('game-win');

      // Record to game history once
      if (!historyRecorded.current && (isPlayer1 || isPlayer2)) {
        historyRecorded.current = true;
        const isWin =
          (gameState.outcome === OUTCOME.PLAYER1_WIN && isPlayer1) ||
          (gameState.outcome === OUTCOME.PLAYER2_WIN && isPlayer2);
        const isLoss =
          (gameState.outcome === OUTCOME.PLAYER1_WIN && isPlayer2) ||
          (gameState.outcome === OUTCOME.PLAYER2_WIN && isPlayer1);
        const entry: GameHistoryEntry = {
          sessionId,
          playerAddress: userAddress,
          opponentAddress: isPlayer1 ? gameState.player2 : gameState.player1,
          playerNumber: isPlayer1 ? 1 : 2,
          outcome: gameState.outcome === OUTCOME.DRAW ? 'draw' : isWin ? 'win' : 'loss',
          tricksWon: isPlayer1 ? gameState.tricks_won1 : gameState.tricks_won2,
          tricksLost: isPlayer1 ? gameState.tricks_won2 : gameState.tricks_won1,
          timestamp: Date.now(),
        };
        addGameToHistory(entry);
      }
    }
  }, [gamePhase, gameState?.outcome]);

  // ─── Trick History Detection ─────────────────────────────────────────────
  useEffect(() => {
    if (!gameState || gameState.lifecycle_state !== LIFECYCLE.PLAYING) return;
    const prev = prevTricksRef.current;
    const curr = { won1: gameState.tricks_won1, won2: gameState.tricks_won2 };
    if (curr.won1 + curr.won2 > prev.won1 + prev.won2) {
      const winner = curr.won1 > prev.won1 ? 'p1' as const : 'p2' as const;
      const total = curr.won1 + curr.won2;
      setTrickHistory(h => [...h, {
        trickNumber: total, winner,
        p1HandAfter: gameState.hand1?.length ?? 0,
        p2HandAfter: gameState.hand2?.length ?? 0,
        p1ZkVerified: gameState.zk_play1,
        p2ZkVerified: gameState.zk_play2,
      }]);
      setLastTrickResult(`Trick #${total}: ${winner === 'p1' ? 'Player 1' : 'Player 2'} wins!`);
      playSound('trick-win');
      setTimeout(() => setLastTrickResult(null), 3000);
    }
    prevTricksRef.current = curr;
  }, [gameState?.tricks_won1, gameState?.tricks_won2]);

  // ─── Bridge error/success to toast notifications ─────────────────────────
  // Use the last-action ref from useCangkulanActions so we can offer retry on errors
  useEffect(() => {
    if (actions.error) {
      const retryFn = actions.lastActionRef.current;
      toast.error(actions.error, undefined, retryFn ? () => { retryFn(); } : undefined);
      actions.setError(null);
    }
  }, [actions.error]);
  useEffect(() => {
    if (actions.success) { toast.success(actions.success); actions.setSuccess(null); }
  }, [actions.success]);

  // ═══════════════════════════════════════════════════════════════════════════
  //  Handlers (component-level only)
  // ═══════════════════════════════════════════════════════════════════════════

  const handleStartNewGame = () => {
    if (gameState && gameState.outcome !== OUTCOME.UNRESOLVED) onGameComplete();
    setGamePhaseInternal('create'); setSessionIdInternal(createRandomSessionId()); setGameState(null);
    setQuickstartLoading(false);
    actions.setLoading(false); actions.setError(null); actions.setSuccess(null);
    setTrickHistory([]); setLastTrickResult(null);
    prevTricksRef.current = { won1: 0, won2: 0 };
    historyRecorded.current = false;
    setExitConfirm(false);
    setPlayer1Address(userAddress);
    navigate?.({ page: 'home' });
    clearActiveSession();
  };

  const handleExitGame = () => {
    if (!exitConfirm) {
      setExitConfirm(true);
      // Auto-cancel confirm after 4 seconds
      setTimeout(() => setExitConfirm(false), 4000);
      return;
    }
    // If game is active (not finished), forfeit first — withdraw = LOSE
    if (gameState && gameState.lifecycle_state !== LIFECYCLE.FINISHED) {
      actions.handleForfeit().then(() => {
        handleStartNewGame();
      }).catch(() => {
        // If forfeit fails (e.g. network error), still allow exit
        handleStartNewGame();
      });
      return;
    }
    handleStartNewGame();
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  Render
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Turn glow class ─────────────────────────────────────────────────────
  const turnGlowClass = (() => {
    if (gamePhase !== 'playing' && gamePhase !== 'seed-commit' && gamePhase !== 'seed-reveal') return '';
    if (isWaitingForOpponent) return 'turn-glow-waiting';
    if (gameState && gameState.lifecycle_state !== LIFECYCLE.FINISHED) return 'turn-glow-your-turn';
    return '';
  })();

  const copySessionId = async () => {
    try {
      await navigator.clipboard.writeText(sessionId.toString());
      setSessionIdCopied(true);
      toast.info('Session ID copied!');
      setTimeout(() => setSessionIdCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const copySpectateLink = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}#/spectate/${sessionId}`;
      await navigator.clipboard.writeText(url);
      toast.info('Spectator link copied!');
    } catch { /* ignore */ }
  };

  return (
    <div
      className={`backdrop-blur-xl rounded-2xl p-5 sm:p-6 shadow-lg transition-all duration-500 ${turnGlowClass}`}
      style={{
        background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)',
        border: '1px solid var(--color-border)',
      }}
    >
      {/* Toast Container */}
      <ToastContainer toasts={toast.toasts} onDismiss={toast.removeToast} />

      {/* Card Deal Animation (seed → playing transition) */}
      <CardDealAnimation
        active={showDealAnimation}
        p1HandSize={gameState?.hand1?.length ?? 5}
        p2HandSize={gameState?.hand2?.length ?? 5}
        onComplete={() => setShowDealAnimation(false)}
      />

      {/* Compact Header — session info + quick actions */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <p
            className="text-xs text-gray-500 font-mono session-id-copy inline-block cursor-pointer hover:text-gray-700 transition-colors"
            onClick={copySessionId}
            title="Click to copy Session ID"
            role="button"
            tabIndex={0}
          >
            {sessionIdCopied ? '✓ Copied!' : `Session #${sessionId}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {gamePhase !== 'create' && (
            <button
              onClick={() => {
                if (notifications.permission === 'unsupported') {
                  toast.info('Notifications not supported in this browser');
                } else if (notifications.permission === 'denied') {
                  toast.info('Notifications blocked — enable in browser settings');
                } else {
                  notifications.setEnabled(!notifications.enabled);
                  toast.info(notifications.enabled ? 'Turn notifications off' : 'Turn notifications on');
                }
              }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${notifications.enabled && notifications.permission === 'granted'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100'
                }`}
              title={notifications.enabled ? 'Turn notifications: ON' : 'Turn notifications: OFF'}
              aria-label={`Turn notifications ${notifications.enabled ? 'on' : 'off'}`}
            >
              {notifications.enabled && notifications.permission === 'granted' ? '🔔' : '🔕'}
            </button>
          )}
          {gamePhase !== 'create' && (
            <button
              onClick={copySpectateLink}
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 transition-colors"
              title="Copy spectator link"
            >
              👁️ Spectate
            </button>
          )}
          {gamePhase !== 'create' && gamePhase !== 'complete' && (
            <button
              onClick={handleExitGame}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${exitConfirm
                ? 'border-red-400 bg-red-100 text-red-700 hover:bg-red-200 animate-pulse'
                : 'border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100'
                }`}
              title={exitConfirm ? 'Click again — you will FORFEIT and LOSE this game!' : 'Withdraw from game (counts as a loss)'}
              aria-label={exitConfirm ? 'Confirm forfeit and exit' : 'Withdraw from game'}
            >
              {exitConfirm ? '⚠️ Forfeit & Lose?' : '🏳️ Withdraw'}
            </button>
          )}
          {gamePhase === 'create' && navigate && (
            <button
              onClick={() => navigate({ page: 'tutorial' })}
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
            >
              🎓 Tutorial
            </button>
          )}
        </div>
      </div>

      {/* ═══════════ Phase Routing ═══════════ */}
      {gamePhase === 'create' && (
        <CreatePhase
          sessionId={sessionId} userAddress={userAddress} availablePoints={availablePoints}
          service={cangkulanService} isBusy={isBusy} loading={actions.loading}
          setLoading={actions.setLoading} quickstartLoading={quickstartLoading} setQuickstartLoading={setQuickstartLoading}
          setError={actions.setError} setSuccess={actions.setSuccess} setSessionId={setSessionId}
          setGameState={setGameState} setGamePhase={setGamePhase} setPlayer1Address={setPlayer1Address}
          addTx={addTx} onStandingsRefresh={onStandingsRefresh}
          createRandomSessionId={createRandomSessionId} runAction={actions.runAction} parsePoints={parsePoints}
          initialXDR={initialXDR} initialSessionId={initialSessionId}
          onStartTutorial={navigate ? () => navigate({ page: 'tutorial' }) : undefined}
          autoQuickstart={autoQuickstart}
        />
      )}

      {(gamePhase === 'seed-commit' || gamePhase === 'seed-reveal') && gameState && (
        <SeedPhase
          gameState={gameState} sessionId={sessionId} userAddress={userAddress}
          isPlayer1={isPlayer1} isPlayer2={isPlayer2} isBusy={isBusy} loading={actions.loading}
          onCommitSeed={actions.handleCommitSeed} onRevealSeed={actions.handleRevealSeed}
          onTickTimeout={actions.handleTickTimeout} onResolveTimeout={actions.handleResolveTimeout}
          isWaitingForOpponent={isWaitingForOpponent} timeoutReady={timeoutReady} canTimeout={canTimeout}
          proofMode={actions.proofMode} onProofModeChange={actions.setProofMode}
          noirProofProgress={actions.noirProofProgress}
          gameMode={gameMode}
        />
      )}

      {gamePhase === 'playing' && gameState && (
        <PlayingPhase
          gameState={gameState} userAddress={userAddress}
          isPlayer1={isPlayer1} isPlayer2={isPlayer2} playerNumber={playerNumber}
          isBusy={isBusy} loading={actions.loading}
          onCommitPlay={actions.handleCommitPlay} onRevealPlay={actions.handleRevealPlay}
          onTickTimeout={actions.handleTickTimeout} onResolveTimeout={actions.handleResolveTimeout}
          onForfeit={actions.handleForfeit}
          isWaitingForOpponent={isWaitingForOpponent} timeoutReady={timeoutReady} canTimeout={canTimeout}
          lastTrickResult={lastTrickResult} sessionId={sessionId}
          autoCommitStatus={actions.autoCommitStatus}
          proofMode={actions.proofMode}
          opponentHandSizeOverride={botPlayer ? (botHandSize ?? undefined) : undefined}
        />
      )}

      {gamePhase === 'complete' && gameState && (
        <CompletePhase
          gameState={gameState} sessionId={sessionId} userAddress={userAddress}
          isPlayer1={isPlayer1} isPlayer2={isPlayer2} isBusy={isBusy}
          onVerifyShuffle={actions.handleVerifyShuffle} shuffleData={actions.shuffleData}
          shuffleLoading={actions.shuffleLoading} trickHistory={trickHistory}
          onStartNewGame={handleStartNewGame}
          proofMode={actions.proofMode}
        />
      )}

      {/* Fallback Loading — skeleton layout instead of spinner */}
      {gamePhase !== 'create' && !gameState && (
        <GameLoadingSkeleton sessionId={sessionId} onCancel={handleStartNewGame} />
      )}

      {/* Transaction Proof Log — filtered to current wallet for dev privacy */}
      <TransactionLog txLog={txLog} onClear={clearLog} currentUser={userAddress} />
    </div>
  );
}

