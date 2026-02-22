import { useState, useEffect, useCallback, useMemo } from 'react';
import { CangkulanService } from '@/games/cangkulan/cangkulanService';
import { getActiveCangkulanContract, getStellarExpertLink } from '@/utils/constants';
import { useNetworkStore } from '@/store/networkStore';
import { useWallet } from '@/hooks/useWallet';
import { ConnectionModal } from '@/components/ConnectionScreen';
import type { GameSummary } from '@/games/cangkulan/bindings';
import type { AppRoute } from '@/hooks/useHashRouter';
import { PageHero } from '@/components/PageHero';

/* ═══════════════════════════════════════════════════════════════════════════════
   History Page — Player's on-chain game history (persistent storage)
   ═══════════════════════════════════════════════════════════════════════════════

   Reads the player's game history from the cangkulan contract's persistent
   storage via `get_player_history(player)`. Each entry is a compact GameSummary
   with outcome from the player's perspective (1=win, 2=loss, 3=draw).

   Data is stored on-chain for 120 days per player, max 50 games.
   ═══════════════════════════════════════════════════════════════════════════════ */


// ── Helpers ──────────────────────────────────────────────────────────────────

function shortenAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function outcomeInfo(outcome: number): { label: string; emoji: string; color: string; bg: string } {
  switch (outcome) {
    case 1: return { label: 'Victory', emoji: '🏆', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800' };
    case 2: return { label: 'Defeat', emoji: '💔', color: 'text-red-500 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' };
    case 3: return { label: 'Draw', emoji: '🤝', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800' };
    default: return { label: 'Unknown', emoji: '❓', color: 'text-gray-500', bg: 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700' };
  }
}

/** Approximate time from ledger number (rough, using current ledger as reference). */
function ledgerToTimeAgo(ledger: number, currentLedger: number): string {
  const diff = currentLedger - ledger;
  if (diff <= 0) return 'just now';
  const secs = diff * 5; // ~5s per ledger
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Components ───────────────────────────────────────────────────────────────

interface HistoryPageProps {
  navigate: (route: AppRoute) => void;
}

/** Reusable wallet-required prompt with connect button */
function WalletRequiredPrompt({ title, description }: { title: string; description: string }) {
  const [showModal, setShowModal] = useState(false);
  return (
    <>
      <div className="text-center py-12 bg-gradient-to-b from-amber-50 to-orange-50 dark:from-amber-900/10 dark:to-orange-900/10 rounded-2xl border border-amber-200 dark:border-amber-800">
        <div className="text-4xl mb-3">🔗</div>
        <h3 className="text-amber-800 dark:text-amber-300 font-bold">{title}</h3>
        <p className="text-sm text-amber-600 dark:text-amber-400 mt-1.5 max-w-sm mx-auto">{description}</p>
        <button
          onClick={() => setShowModal(true)}
          className="mt-4 px-6 py-2.5 text-sm font-bold rounded-xl bg-amber-500 text-white hover:bg-amber-600 transition-colors shadow-lg"
        >
          Connect Wallet
        </button>
      </div>
      {showModal && <ConnectionModal onClose={() => setShowModal(false)} />}
    </>
  );
}

export function HistoryPage({ navigate }: { navigate: (route: AppRoute) => void }) {
  const { publicKey, isConnected } = useWallet();
  const activeNetwork = useNetworkStore(s => s.activeNetwork);
  const cangkulanService = useMemo(() => new CangkulanService(getActiveCangkulanContract()), [activeNetwork]);

  const [games, setGames] = useState<GameSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentLedger, setCurrentLedger] = useState(0);

  const fetchHistory = useCallback(async () => {
    if (!publicKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Get current ledger for time estimates
      const { rpc: rpcModule } = await import('@stellar/stellar-sdk');
      const { RPC_URL: rpcUrl, needsAllowHttp } = await import('@/utils/constants');
      const server = new rpcModule.Server(rpcUrl, { allowHttp: needsAllowHttp(rpcUrl) });
      const latest = await server.getLatestLedger();
      setCurrentLedger(latest.sequence);

      const fetchedGames = await cangkulanService.getPlayerHistory(publicKey);
      // Show newest first
      setGames([...fetchedGames].reverse());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [publicKey, cangkulanService]); // Added cangkulanService to dependencies

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // ── Stats summary ──────────────────────────────────────────────────────
  const wins = games.filter(g => g.outcome === 1).length;
  const losses = games.filter(g => g.outcome === 2).length;
  const draws = games.filter(g => g.outcome === 3).length;
  const winRate = games.length > 0 ? Math.round((wins / games.length) * 100) : 0;
  const totalTricksWon = games.reduce((sum, g) => sum + g.tricks_won, 0);
  const totalTricksLost = games.reduce((sum, g) => sum + g.tricks_lost, 0);

  // ── Streak calculation ─────────────────────────────────────────────────
  let currentStreak = 0;
  let streakType: 'win' | 'loss' | null = null;
  for (const g of games) { // games is already newest-first
    if (g.outcome === 3) break; // draw breaks streak
    if (streakType === null) {
      streakType = g.outcome === 1 ? 'win' : 'loss';
      currentStreak = 1;
    } else if ((streakType === 'win' && g.outcome === 1) || (streakType === 'loss' && g.outcome === 2)) {
      currentStreak++;
    } else {
      break;
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-8">
      {/* Hero Header */}
      <PageHero
        icon="📜"
        title="Game History"
        subtitle={publicKey ? `Your last ${games.length} games on-chain` : 'Connect wallet to view history'}
        gradient="from-amber-600 via-orange-600 to-red-700"
        navigate={navigate}
        backTo={{ page: 'home' }}
        actions={
          <button
            onClick={fetchHistory}
            disabled={loading}
            className="p-2 rounded-lg bg-white/20 hover:bg-white/30 backdrop-blur-sm text-white transition-all disabled:opacity-50"
            title="Refresh"
          >
            <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        }
      />

      {/* Not connected */}
      {!publicKey && (
        <WalletRequiredPrompt
          title="Game History Requires Wallet"
          description="Connect a Stellar wallet to view your on-chain game history, stats, and match records."
        />
      )}

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && publicKey && (
        <div className="space-y-5">
          <div className="flex flex-col items-center py-4 gap-3">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-[3px] border-amber-200 dark:border-amber-900/40" />
              <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-amber-500 animate-spin" />
              <div className="absolute inset-2 rounded-full bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/30 dark:to-orange-900/30 flex items-center justify-center">
                <span className="text-sm">📜</span>
              </div>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-600 dark:text-gray-300">Loading game history…</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Reading from persistent storage</p>
            </div>
          </div>

          {/* Summary skeleton */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 animate-pulse">
            {['Wins', 'Losses', 'Draws', 'Win %'].map(l => (
              <div key={l} className="p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-center">
                <div className="h-6 w-8 mx-auto bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{l}</div>
              </div>
            ))}
          </div>

          {/* Game rows skeleton */}
          <div className="space-y-2 animate-pulse">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                <div className="w-8 h-8 bg-gray-200 dark:bg-gray-700 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-28 bg-gray-200 dark:bg-gray-700 rounded" />
                  <div className="h-3 w-20 bg-gray-200 dark:bg-gray-700 rounded" />
                </div>
                <div className="h-5 w-16 bg-gray-200 dark:bg-gray-700 rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      {!loading && publicKey && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl text-center">
              <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">{wins}</div>
              <div className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase">Wins</div>
            </div>
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-center">
              <div className="text-xl font-bold text-red-500 dark:text-red-400">{losses}</div>
              <div className="text-[10px] font-semibold text-red-600 dark:text-red-400 uppercase">Losses</div>
            </div>
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl text-center">
              <div className="text-xl font-bold text-amber-600 dark:text-amber-400">{draws}</div>
              <div className="text-[10px] font-semibold text-amber-700 dark:text-amber-400 uppercase">Draws</div>
            </div>
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl text-center">
              <div className="text-xl font-bold text-blue-600 dark:text-blue-400">{winRate}%</div>
              <div className="text-[10px] font-semibold text-blue-700 dark:text-blue-400 uppercase">Win Rate</div>
            </div>
          </div>

          {/* Extra stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
            <div className="p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-center">
              <div className="text-lg font-bold text-gray-800 dark:text-gray-200">{games.length}</div>
              <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase">Total Games</div>
            </div>
            <div className="p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-center">
              <div className="text-lg font-bold text-gray-800 dark:text-gray-200">
                {totalTricksWon}<span className="text-xs text-gray-400 mx-0.5">/</span>{totalTricksLost}
              </div>
              <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase">Tricks W/L</div>
            </div>
            <div className="p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-center">
              <div className="text-lg font-bold text-gray-800 dark:text-gray-200">
                {currentStreak > 0 ? (
                  <span className={streakType === 'win' ? 'text-emerald-600' : 'text-red-500'}>
                    {streakType === 'win' ? '🔥' : '💀'} {currentStreak}
                  </span>
                ) : '—'}
              </div>
              <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase">Current Streak</div>
            </div>
          </div>

          {/* Game list */}
          {games.length === 0 ? (
            <div className="text-center py-16 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700">
              <div className="text-4xl mb-3">🎴</div>
              <p className="text-gray-500 dark:text-gray-400 font-medium">No games found yet</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Play some games and they'll appear here!
              </p>
              <button
                onClick={() => navigate({ page: 'lobby' })}
                className="mt-4 px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-colors"
              >
                Go to Lobby
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {games.map((game, idx) => {
                const info = outcomeInfo(game.outcome);
                return (
                  <div
                    key={`${game.session_id}-${idx}`}
                    className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer hover:shadow-md transition-all ${info.bg}`}
                    onClick={() => navigate({ page: 'spectate', sessionId: game.session_id })}
                  >
                    {/* Outcome icon */}
                    <div className="text-2xl w-8 text-center flex-shrink-0">{info.emoji}</div>

                    {/* Details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-bold ${info.color}`}>{info.label}</span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">#{game.session_id}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        <span>vs</span>
                        <span className="font-mono truncate">{shortenAddr(game.opponent)}</span>
                        <span className="text-gray-300 dark:text-gray-600 mx-1">·</span>
                        <span>Tricks {game.tricks_won}–{game.tricks_lost}</span>
                      </div>
                    </div>

                    {/* Time ago and Stellar Expert Link */}
                    <div className="text-right flex-shrink-0 flex flex-col items-end">
                      {currentLedger > 0 && (
                        <div className="text-xs text-gray-400 dark:text-gray-500">
                          {ledgerToTimeAgo(game.ledger, currentLedger)}
                        </div>
                      )}
                      {(() => {
                        const expertLink = getStellarExpertLink('contract', getActiveCangkulanContract());
                        if (!expertLink) {
                          return <div className="text-[10px] uppercase font-bold text-gray-400">Local Node</div>;
                        }
                        return (
                          <a href={`${expertLink}?filter=events`}
                            target="_blank" rel="noopener noreferrer"
                            className="shrink-0 text-sm opacity-50 hover:opacity-100 transition-opacity">
                            ↗
                          </a>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Data notice */}
          <div className="text-center">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Stored on-chain in persistent storage (120 day TTL, max 50 games)
            </p>
          </div>
        </>
      )}

      {/* Data source notice */}
      <div className="text-center">
        <p className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          Data from Stellar Soroban persistent storage
        </p>
      </div>
    </div>
  );
}

export default HistoryPage;
