// ═══════════════════════════════════════════════════════════════════════════════
//  Game History — persisted to localStorage
//  Records completed games so players can view past sessions.
// ═══════════════════════════════════════════════════════════════════════════════

const HISTORY_KEY = 'cangkulan-game-history';
const MAX_HISTORY = 30;

export interface GameHistoryEntry {
  sessionId: number;
  playerAddress: string;
  opponentAddress: string;
  playerNumber: 1 | 2;
  outcome: 'win' | 'loss' | 'draw' | 'timeout';
  tricksWon: number;
  tricksLost: number;
  timestamp: number;
}

export function loadGameHistory(): GameHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as GameHistoryEntry[];
  } catch {
    return [];
  }
}

export function addGameToHistory(entry: GameHistoryEntry): void {
  try {
    const history = loadGameHistory();
    // Avoid duplicates
    if (history.some(h => h.sessionId === entry.sessionId && h.playerAddress === entry.playerAddress)) return;
    history.unshift(entry);
    // Keep only last N entries
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch { /* ignore */ }
}

export function clearGameHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch { /* ignore */ }
}
