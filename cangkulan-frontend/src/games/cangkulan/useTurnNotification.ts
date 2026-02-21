import { useEffect, useRef, useCallback, useState } from 'react';

// ═══════════════════════════════════════════════════════════════════════════════
//  useTurnNotification
//  Fires a browser Notification when it becomes the player's turn while the tab
//  is hidden. Also updates the document title with a visual indicator.
// ═══════════════════════════════════════════════════════════════════════════════

export interface TurnNotificationConfig {
  /** Whether the player is currently waiting for the opponent */
  isWaitingForOpponent: boolean;
  /** Whether the game is in an active phase (not create/complete) */
  isActiveGame: boolean;
  /** Session ID for notification context */
  sessionId: number;
}

export interface TurnNotificationResult {
  /** Current permission state */
  permission: NotificationPermission | 'unsupported';
  /** Whether notifications are enabled by the user */
  enabled: boolean;
  /** Toggle notifications on/off */
  setEnabled: (v: boolean) => void;
  /** Manually request permission (useful for a settings button) */
  requestPermission: () => Promise<void>;
}

const STORAGE_KEY = 'cangkulan_notifications_enabled';

function getStoredEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function useTurnNotification(config: TurnNotificationConfig): TurnNotificationResult {
  const { isWaitingForOpponent, isActiveGame, sessionId } = config;

  const [enabled, setEnabledState] = useState(getStoredEnabled);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    () => typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );

  const prevWaiting = useRef(isWaitingForOpponent);
  const originalTitle = useRef(document.title);

  // Persist preference
  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try { localStorage.setItem(STORAGE_KEY, String(v)); } catch { /* ignore */ }
  }, []);

  // Request permission
  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
    } catch { /* ignore */ }
  }, []);

  // Auto-request permission when enabled and not yet granted
  useEffect(() => {
    if (enabled && permission === 'default') {
      requestPermission();
    }
  }, [enabled, permission, requestPermission]);

  // Detect turn transition: waiting → not waiting (it's now our turn)
  useEffect(() => {
    const wasWaiting = prevWaiting.current;
    prevWaiting.current = isWaitingForOpponent;

    if (!isActiveGame) return;

    // Transition: was waiting → now it's our turn
    if (wasWaiting && !isWaitingForOpponent) {
      // Update title
      document.title = '🎯 Your Turn! — Cangkulan';

      // Fire notification if tab is hidden
      if (
        enabled &&
        document.hidden &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        try {
          const notification = new Notification('Your Turn! 🎯', {
            body: `Session #${sessionId} — It's your turn to play!`,
            icon: '/favicon.ico',
            tag: `cangkulan-turn-${sessionId}`,
          });

          // Auto-close after 8 seconds
          setTimeout(() => notification.close(), 8000);

          // Focus window on click
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        } catch {
          // Notification constructor can throw in some environments
        }
      }
    }

    // When we're waiting, it's the opponent's turn — keep title normal
    if (isWaitingForOpponent) {
      document.title = '⏳ Waiting… — Cangkulan';
    }
  }, [isWaitingForOpponent, isActiveGame, enabled, sessionId]);

  // Restore title when tab becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && isActiveGame) {
        document.title = originalTitle.current;
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isActiveGame]);

  // Restore title on unmount or when game ends
  useEffect(() => {
    if (!isActiveGame) {
      document.title = originalTitle.current;
    }
    return () => { document.title = originalTitle.current; };
  }, [isActiveGame]);

  return { permission, enabled, setEnabled, requestPermission };
}
