import { useState, useEffect, useCallback } from 'react';

// ═══════════════════════════════════════════════════════════════════════════════
//  Hash-based router for single-page app
//  Keeps current page + session in URL so reloads stay on the right screen.
//
//  Routes:
//    #/             → home / connection screen
//    #/game/:sid    → active game with session ID
// ═══════════════════════════════════════════════════════════════════════════════

export type AppRoute =
  | { page: 'home' }
  | { page: 'game'; sessionId?: number }
  | { page: 'spectate'; sessionId: number }
  | { page: 'lobby' }
  | { page: 'tutorial' }
  | { page: 'history' }
  | { page: 'rules' }
  | { page: 'settings' }
  | { page: 'stats' }
  | { page: 'leaderboard' }
  | { page: 'architecture' }
  | { page: 'demo' };

export function parseHash(hash: string): AppRoute {
  const clean = hash.replace(/^#\/?/, '');
  if (!clean || clean === '/') return { page: 'home' };

  const parts = clean.split('/');
  if (parts[0] === 'game') {
    if (parts[1]) {
      const sid = parseInt(parts[1], 10);
      if (!isNaN(sid) && sid > 0) return { page: 'game', sessionId: sid };
    }
    // #/game with no session → "create new game"
    return { page: 'game' };
  }
  if (parts[0] === 'spectate' && parts[1]) {
    const sid = parseInt(parts[1], 10);
    if (!isNaN(sid) && sid > 0) return { page: 'spectate', sessionId: sid };
  }
  if (parts[0] === 'lobby') return { page: 'lobby' };
  if (parts[0] === 'tutorial') return { page: 'tutorial' };
  if (parts[0] === 'history') return { page: 'history' };
  if (parts[0] === 'rules') return { page: 'rules' };
  if (parts[0] === 'settings') return { page: 'settings' };
  if (parts[0] === 'stats') return { page: 'stats' };
  if (parts[0] === 'leaderboard') return { page: 'leaderboard' };
  if (parts[0] === 'architecture') return { page: 'architecture' };
  if (parts[0] === 'demo') return { page: 'demo' };

  return { page: 'home' };
}

function routeToHash(route: AppRoute): string {
  switch (route.page) {
    case 'home': return '#/';
    case 'game': return route.sessionId ? `#/game/${route.sessionId}` : '#/game';
    case 'spectate': return `#/spectate/${route.sessionId}`;
    case 'lobby': return '#/lobby';
    case 'tutorial': return '#/tutorial';
    case 'history': return '#/history';
    case 'rules': return '#/rules';
    case 'settings': return '#/settings';
    case 'stats': return '#/stats';
    case 'leaderboard': return '#/leaderboard';
    case 'architecture': return '#/architecture';
    case 'demo': return '#/demo';
  }
}

export function useHashRouter() {
  const [route, setRoute] = useState<AppRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((newRoute: AppRoute) => {
    const hash = routeToHash(newRoute);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    setRoute(newRoute);
  }, []);

  return { route, navigate };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Session persistence — remember active session across reloads
// ═══════════════════════════════════════════════════════════════════════════════

const SESSION_KEY = 'cangkulan-active-session';

export interface PersistedSession {
  sessionId: number;
  userAddress: string;
  timestamp: number;
}

export function saveActiveSession(sessionId: number, userAddress: string): void {
  try {
    const data: PersistedSession = { sessionId, userAddress, timestamp: Date.now() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

export function loadActiveSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedSession;
    // Expire after 24 hours
    if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return data;
  } catch { return null; }
}

export function clearActiveSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
