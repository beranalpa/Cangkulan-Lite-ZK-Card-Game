import { useState, useEffect, useRef } from 'react';
import type { GameState } from './types';
import { TIMEOUT_SECONDS } from './types';

// ─── Circular Progress Ring ────────────────────────────────────────────────
function CircularTimer({ secondsLeft, total, isUrgent }: { secondsLeft: number; total: number; isUrgent: boolean }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const progress = secondsLeft / total;
  const offset = circumference * (1 - progress);
  const strokeColor = isUrgent ? '#ef4444' : '#f59e0b';

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: 56, height: 56 }}>
      <svg width="56" height="56" viewBox="0 0 56 56" className="transform -rotate-90">
        <circle cx="28" cy="28" r={radius} fill="none" stroke="#e5e7eb" strokeWidth="4" />
        <circle
          cx="28" cy="28" r={radius} fill="none"
          stroke={strokeColor}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
        />
      </svg>
      <span className={`absolute text-xs font-black font-mono ${isUrgent ? 'text-red-600' : 'text-orange-700'}`}>
        {secondsLeft}
      </span>
    </div>
  );
}

export function TimeoutControls({
  gameState,
  isBusy,
  loading,
  onTick,
  onResolve,
  timeoutReady,
  isWaitingForOpponent,
  sessionId,
}: {
  gameState: GameState;
  isBusy: boolean;
  loading: boolean;
  onTick: () => void;
  onResolve: () => void;
  timeoutReady: boolean | undefined;
  isWaitingForOpponent: boolean;
  sessionId: number;
}) {
  const [secondsLeft, setSecondsLeft] = useState(TIMEOUT_SECONDS);
  const [autoResolving, setAutoResolving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number | null>(null);
  // Guard ref to prevent double-firing of resolve (race between auto-fire and manual click)
  const resolveDispatchedRef = useRef(false);

  // Track the wall-clock time when waiting started, anchored to nonce so
  // it doesn't reset on re-mount.  Uses the action_nonce as a stable key —
  // when the nonce changes it means the opponent acted, so the timer should
  // legitimately restart. Include sessionId to prevent cross-game bleeding.
  const anchorNonce = gameState.action_nonce;
  const anchorKey = `cangkulan-timeout-start:${sessionId}:${anchorNonce}`;

  // Start/reset timer when waiting for opponent
  useEffect(() => {
    if (isWaitingForOpponent && !autoResolving) {
      // Recover persisted start time so refresh doesn't reset the clock
      let start: number;
      try {
        const persisted = sessionStorage.getItem(anchorKey);
        start = persisted ? parseInt(persisted, 10) : Date.now();
        if (!persisted) sessionStorage.setItem(anchorKey, String(start));
      } catch {
        start = Date.now();
      }
      startTimeRef.current = start;
      const elapsed = Math.floor((Date.now() - start) / 1000);
      setSecondsLeft(Math.max(0, TIMEOUT_SECONDS - elapsed));

      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - (startTimeRef.current ?? Date.now())) / 1000);
        const remaining = Math.max(0, TIMEOUT_SECONDS - elapsed);
        setSecondsLeft(remaining);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      if (!isWaitingForOpponent) {
        setSecondsLeft(TIMEOUT_SECONDS);
        setAutoResolving(false);
        resolveDispatchedRef.current = false;
        // Clean up persisted start time when opponent responds
        try { sessionStorage.removeItem(anchorKey); } catch { /* ignore */ }
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isWaitingForOpponent, autoResolving, anchorKey]);

  // Auto-fire when timer expires (3s grace period)
  useEffect(() => {
    if (secondsLeft !== 0 || !isWaitingForOpponent || autoResolving || isBusy) return;
    const grace = setTimeout(() => handleAutoTimeout(), 3000);
    return () => clearTimeout(grace);
  }, [secondsLeft, isWaitingForOpponent, autoResolving, isBusy]);

  // Auto-resolve when timer hits 0
  const handleAutoTimeout = async () => {
    if (autoResolving || isBusy || resolveDispatchedRef.current) return;
    // Guard: don't attempt on-chain resolve if deadline not met
    if (!timeoutReady && secondsLeft > 0) return;
    resolveDispatchedRef.current = true;
    setAutoResolving(true);
    try {
      try {
        await onResolve();
        return;
      } catch {
        // Ledger deadline not met yet — fall back to nonce-based ticks
      }
      await onTick();
      await onTick();
      await onResolve();
    } catch {
      setAutoResolving(false);
      resolveDispatchedRef.current = false;
    }
  };

  if (!isWaitingForOpponent && !autoResolving) return null;

  const progress = ((TIMEOUT_SECONDS - secondsLeft) / TIMEOUT_SECONDS) * 100;
  const isUrgent = secondsLeft <= 15;
  const isExpired = secondsLeft === 0;

  return (
    <div className={`p-4 border-2 rounded-xl transition-colors ${isUrgent
      ? 'bg-gradient-to-r from-red-50 to-orange-50 border-red-300'
      : 'bg-gradient-to-r from-orange-50 to-amber-50 border-orange-200'
      }`} role="timer" aria-live="polite" aria-label={`Opponent timeout: ${Math.floor(secondsLeft / 60)} minutes ${secondsLeft % 60} seconds remaining`}>
      <div className="flex items-center gap-3 mb-2">
        <CircularTimer secondsLeft={secondsLeft} total={TIMEOUT_SECONDS} isUrgent={isUrgent} />
        <div className="flex-1">
          <p className="text-xs font-bold text-orange-800">⏰ Opponent Timeout</p>
          <span className={`text-lg font-black font-mono ${isUrgent ? 'text-red-600 animate-pulse' : 'text-orange-700'
            }`} aria-hidden="true">
            {Math.floor(secondsLeft / 60)}:{(secondsLeft % 60).toString().padStart(2, '0')}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden mb-3" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Timeout progress">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${isUrgent ? 'bg-red-500' : 'bg-orange-400'
            }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <p className="text-xs text-gray-600 mb-3">
        {autoResolving
          ? 'Resolving timeout — claiming win...'
          : isExpired
            ? 'Time expired! Click to claim your win.'
            : `Opponent has ${secondsLeft}s to respond or you can claim a win.`
        }
      </p>

      <button
        onClick={handleAutoTimeout}
        disabled={isBusy || autoResolving || !isExpired}
        className={`w-full py-2.5 rounded-lg font-bold text-sm transition-all shadow-md ${isExpired && !autoResolving
          ? 'bg-gradient-to-r from-red-500 to-rose-500 hover:from-red-600 hover:to-rose-600 text-white'
          : 'bg-gradient-to-r from-gray-200 to-gray-300 text-gray-500 cursor-not-allowed'
          }`}
      >
        {autoResolving ? '⏳ Resolving...' : isExpired ? '🏆 Claim Win (Opponent Timed Out)' : `⏰ Wait ${Math.floor(secondsLeft / 60)}:${(secondsLeft % 60).toString().padStart(2, '0')}...`}
      </button>
    </div>
  );
}
