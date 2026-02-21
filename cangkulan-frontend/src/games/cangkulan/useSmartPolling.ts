import { useEffect, useRef, useCallback } from 'react';

/**
 * Smart Polling Hook — Adaptive, visibility-aware game state polling
 *
 * Features:
 * - Adaptive intervals: faster when game is active, slower when idle
 * - Change detection: resets to fast polling when state changes
 * - Visibility-aware: pauses when tab is hidden, refreshes on focus
 * - Nudge API: instant re-poll after user actions
 * - Exponential backoff: slows down when no changes detected
 */

export interface SmartPollingConfig {
  /** Base interval in ms for the current phase */
  baseInterval: number;
  /** Maximum interval after backoff (default: 10000) */
  maxInterval?: number;
  /** Backoff multiplier (default: 1.3) */
  backoffFactor?: number;
  /** Whether polling is enabled */
  enabled: boolean;
}

export function useSmartPolling(
  fetchFn: () => Promise<unknown>,
  config: SmartPollingConfig,
) {
  const { baseInterval, maxInterval = 10000, backoffFactor = 1.3, enabled } = config;

  const currentInterval = useRef(baseInterval);
  const lastStateHash = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);
  const isVisible = useRef(!document.hidden);
  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;

  // Schedule next poll
  const scheduleNext = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!isMounted.current || !isVisible.current) return;

    timerRef.current = setTimeout(async () => {
      if (!isMounted.current) return;
      try {
        const result = await fetchRef.current();
        if (!isMounted.current) return;

        // Simple change detection via JSON hash
        const hash = JSON.stringify(result);
        if (hash !== lastStateHash.current) {
          // State changed — reset to fast polling
          lastStateHash.current = hash;
          currentInterval.current = baseInterval;
        } else {
          // No change — back off
          currentInterval.current = Math.min(
            currentInterval.current * backoffFactor,
            maxInterval,
          );
        }
      } catch {
        // On error, slow down slightly
        currentInterval.current = Math.min(currentInterval.current * 1.5, maxInterval);
      }
      scheduleNext();
    }, currentInterval.current);
  }, [baseInterval, maxInterval, backoffFactor]);

  // Nudge: instant re-poll (call after user actions)
  const nudge = useCallback(() => {
    currentInterval.current = baseInterval;
    if (timerRef.current) clearTimeout(timerRef.current);
    // Immediate fetch then reschedule
    fetchRef.current().then(() => {
      if (isMounted.current) scheduleNext();
    }).catch(() => {
      if (isMounted.current) scheduleNext();
    });
  }, [baseInterval, scheduleNext]);

  // Visibility change handler
  useEffect(() => {
    const handleVisibility = () => {
      isVisible.current = !document.hidden;
      if (!document.hidden && enabled) {
        // Tab became visible — immediate refresh
        currentInterval.current = baseInterval;
        nudge();
      } else {
        // Tab hidden — clear timer
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [enabled, baseInterval, nudge]);

  // Main effect
  useEffect(() => {
    isMounted.current = true;
    currentInterval.current = baseInterval;
    lastStateHash.current = '';

    if (enabled) {
      // Initial fetch
      fetchRef.current().then(() => {
        if (isMounted.current) scheduleNext();
      }).catch(() => {
        if (isMounted.current) scheduleNext();
      });
    }

    return () => {
      isMounted.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, baseInterval, scheduleNext]);

  return { nudge };
}
