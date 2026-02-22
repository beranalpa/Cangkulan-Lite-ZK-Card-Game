import { useState } from 'react';
import { loadGameHistory, clearGameHistory, type GameHistoryEntry } from './gameHistory';

// ═══════════════════════════════════════════════════════════════════════════════
//  Game History Panel — shows past completed games
// ═══════════════════════════════════════════════════════════════════════════════

function outcomeEmoji(o: GameHistoryEntry['outcome']) {
  switch (o) {
    case 'win': return '🏆';
    case 'loss': return '❌';
    case 'draw': return '🤝';
    case 'timeout': return '⏰';
  }
}

function outcomeLabel(o: GameHistoryEntry['outcome']) {
  switch (o) {
    case 'win': return 'Won';
    case 'loss': return 'Lost';
    case 'draw': return 'Draw';
    case 'timeout': return 'Timeout Win';
  }
}

function outcomeColor(o: GameHistoryEntry['outcome']) {
  switch (o) {
    case 'win': return 'text-emerald-700';
    case 'loss': return 'text-red-600';
    case 'draw': return 'text-amber-700';
    case 'timeout': return 'text-orange-600';
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function GameHistoryPanel({ onLoadGame }: { onLoadGame?: (sessionId: number) => void }) {
  const [history, setHistory] = useState(() => loadGameHistory());
  const [expanded, setExpanded] = useState(false);

  if (history.length === 0) return null;

  const stats = {
    wins: history.filter(h => h.outcome === 'win' || h.outcome === 'timeout').length,
    losses: history.filter(h => h.outcome === 'loss').length,
    draws: history.filter(h => h.outcome === 'draw').length,
  };

  const handleClear = () => {
    clearGameHistory();
    setHistory([]);
  };

  const displayed = expanded ? history : history.slice(0, 5);

  return (
    <div className="mt-6 p-4 bg-gradient-to-br from-gray-50 to-white border-2 border-gray-200 rounded-xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base">📜</span>
          <h4 className="text-sm font-bold text-gray-800">Game History</h4>
          <span className="text-xs text-gray-400 font-mono">({history.length})</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5 text-xs font-bold">
            <span className="text-emerald-600">{stats.wins}W</span>
            <span className="text-gray-300">/</span>
            <span className="text-red-500">{stats.losses}L</span>
            <span className="text-gray-300">/</span>
            <span className="text-amber-600">{stats.draws}D</span>
          </div>
          <button
            onClick={handleClear}
            className="text-xs text-gray-400 hover:text-red-500 transition-colors bg-transparent border-0 p-1 shadow-none"
            style={{ background: 'none', border: 'none', padding: '2px 6px', minWidth: 'auto' }}
            title="Clear history"
          >
            🗑
          </button>
        </div>
      </div>

      {/* Entries */}
      <div className="space-y-1.5">
        {displayed.map((entry) => (
          <div
            key={`${entry.sessionId}-${entry.playerAddress}`}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-gray-100 hover:border-gray-300 transition-colors group"
          >
            <span className="text-sm shrink-0">{outcomeEmoji(entry.outcome)}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold ${outcomeColor(entry.outcome)}`}>
                  {outcomeLabel(entry.outcome)}
                </span>
                <span className="text-xs text-gray-400 font-mono">
                  #{entry.sessionId}
                </span>
              </div>
              <div className="text-[10px] text-gray-400 truncate">
                vs {entry.opponentAddress.slice(0, 8)}...{entry.opponentAddress.slice(-4)}
                {' · '}Tricks {entry.tricksWon}–{entry.tricksLost}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[10px] text-gray-400">{timeAgo(entry.timestamp)}</span>
              {onLoadGame && (
                <button
                  onClick={() => onLoadGame(entry.sessionId)}
                  className="opacity-0 group-hover:opacity-100 text-xs text-blue-500 hover:text-blue-700 transition-all bg-transparent border-0 p-0 shadow-none"
                  style={{ background: 'none', border: 'none', padding: '2px 6px', minWidth: 'auto' }}
                  title="View game"
                >
                  →
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Expand / Collapse */}
      {history.length > 5 && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-2 w-full text-xs text-gray-400 hover:text-gray-600 transition-colors bg-transparent border-0 p-1 shadow-none"
          style={{ background: 'none', border: 'none', padding: '4px', minWidth: 'auto' }}
        >
          {expanded ? '▲ Show less' : `▼ Show all ${history.length} games`}
        </button>
      )}
    </div>
  );
}
