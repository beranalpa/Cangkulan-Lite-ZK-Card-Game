import { useState, useEffect, useCallback, useRef } from 'react';
import { rpc, xdr, Address } from '@stellar/stellar-sdk';
import { RPC_URL, CANGKULAN_CONTRACT, needsAllowHttp } from '@/utils/constants';
import { CangkulanService } from './cangkulanService';
import { LIFECYCLE, OUTCOME } from './types';
import type { AppRoute } from '@/hooks/useHashRouter';
import { log } from '@/utils/logger';
import { useLobbyPresence } from '@/hooks/useLobbyPresence';
import { ConnectionModal } from '@/components/ConnectionScreen';
import { useIntl, FormattedMessage } from 'react-intl';

/* ═══════════════════════════════════════════════════════════════════════════════
   Game Lobby — Discover live games on-chain + real-time WebSocket presence
   ═══════════════════════════════════════════════════════════════════════════════

   Reads EvGameStarted events from the Soroban RPC to build a live list
   of recent games. Enhanced with WebSocket relay for:
     - Online player presence (see who's in the lobby)
     - Matchmaking queue (auto-pair with a random opponent)
     - Direct game invites (challenge a specific player)
     - Lobby chat
   ═══════════════════════════════════════════════════════════════════════════════ */

interface LobbyGame {
  sessionId: number;
  player1: string;
  player2: string;
  status: 'seed-commit' | 'seed-reveal' | 'playing' | 'finished' | 'timed-out' | 'unknown';
  ledgerTimestamp?: number;
  createdAt?: number;  // Unix timestamp in milliseconds (game started)
  endedAt?: number;    // Unix timestamp in milliseconds (approx game ended)
  outcome?: number;    // 0=unresolved, 1=P1 wins, 2=P2 wins, 3=draw
  winner?: string;     // Address of the winner (empty for draw/unresolved)
}

/** Format a past timestamp as a human-readable relative time string. */
function timeAgo(timestampMs: number): string {
  const diffMs = Date.now() - timestampMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

const cangkulanService = new CangkulanService(CANGKULAN_CONTRACT);

function shortenAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const STATUS_CONFIG: Record<LobbyGame['status'], { label: string; color: string; dot: string }> = {
  'seed-commit': { label: 'Seeding', color: 'text-amber-600', dot: 'bg-amber-400' },
  'seed-reveal': { label: 'Revealing', color: 'text-blue-600', dot: 'bg-blue-400' },
  'playing': { label: 'Live', color: 'text-emerald-600', dot: 'bg-emerald-400 animate-pulse' },
  'finished': { label: 'Ended', color: 'text-gray-500', dot: 'bg-gray-400' },
  'timed-out': { label: 'Stuck', color: 'text-red-600', dot: 'bg-red-400' },
  'unknown': { label: '…', color: 'text-gray-400', dot: 'bg-gray-300' },
};

function lifecycleToStatus(state: number): LobbyGame['status'] {
  switch (state) {
    case LIFECYCLE.SEED_COMMIT: return 'seed-commit';
    case LIFECYCLE.SEED_REVEAL: return 'seed-reveal';
    case LIFECYCLE.PLAYING: return 'playing';
    case LIFECYCLE.FINISHED: return 'finished';
    default: return 'unknown';
  }
}

/**
 * Fetch events of a given topic from the Soroban RPC, paginating across
 * the ~10 000-ledger scan windows until we reach the chain tip.
 */
const RPC_SCAN_WINDOW = 10_000;

async function fetchPaginatedEvents(
  server: rpc.Server,
  startLedger: number,
  topicSymbol: string,
  chainTip: number,
  limit = 100,
): Promise<{ data: xdr.ScVal; ledger: number; closedAt?: string }[]> {
  const results: { data: xdr.ScVal; ledger: number; closedAt?: string }[] = [];
  let cursor: string | undefined;
  let currentStart = startLedger;

  for (let page = 0; page < 30; page++) {
    try {
      const params: any = {
        filters: [{
          type: 'contract' as const,
          contractIds: [CANGKULAN_CONTRACT],
          topics: [[xdr.ScVal.scvSymbol(topicSymbol).toXDR('base64')]],
        }],
        limit,
      };

      if (cursor) {
        params.cursor = cursor;
      } else {
        params.startLedger = currentStart;
      }

      const resp = await server.getEvents(params);

      if (!resp.events || resp.events.length === 0) {
        currentStart += RPC_SCAN_WINDOW;
        cursor = undefined;
        if (currentStart < chainTip) continue;
        break;
      }

      for (const ev of resp.events) {
        results.push({ data: ev.value, ledger: ev.ledger, closedAt: ev.ledgerClosedAt });
      }

      if (resp.events.length >= limit) {
        cursor = resp.events[resp.events.length - 1].id;
        continue;
      }

      // Advance past this scan window
      const lastLedger = resp.events[resp.events.length - 1].ledger;
      const nextStart = Math.max(lastLedger + 1, currentStart + RPC_SCAN_WINDOW);
      cursor = undefined;
      if (nextStart < chainTip) {
        currentStart = nextStart;
        continue;
      }
      break;
    } catch (err) {
      const msg = (err as any)?.message ?? '';
      const m = msg.match(/ledger range:\s*(\d+)/);
      if (m && !cursor) {
        currentStart = Number(m[1]);
        continue;
      }
      log.warn(`[Lobby] Failed fetching ${topicSymbol}:`, err);
      break;
    }
  }
  return results;
}

/**
 * Fetch recent games from on-chain events with full pagination.
 * Returns ALL live games + the 5 most recent finished games.
 */
async function fetchRecentGames(): Promise<LobbyGame[]> {
  try {
    const server = new rpc.Server(RPC_URL, { allowHttp: needsAllowHttp(RPC_URL) });
    const latestLedger = await server.getLatestLedger();
    // Look back 1 day (at ~5s per ledger = ~17,280 ledgers)
    const startLedger = Math.max(latestLedger.sequence - 17280, 1);
    const chainTip = latestLedger.sequence;

    // Fetch both start and end events in parallel with full pagination
    const [startEvents, endEvents] = await Promise.all([
      fetchPaginatedEvents(server, startLedger, 'ev_game_started', chainTip),
      fetchPaginatedEvents(server, startLedger, 'ev_game_ended', chainTip),
    ]);

    // Parse end events into a map: sessionId → { outcome, endedAt }
    const endMap = new Map<number, { outcome: number; endedAt: number }>();
    for (const ev of endEvents) {
      try {
        const data = ev.data;
        if (data.switch().name === 'scvMap') {
          const map = data.value() as xdr.ScMapEntry[];
          let sessionId = 0;
          let outcome = 0;
          for (const entry of map) {
            const rawKey = entry.key().value();
            const key = rawKey instanceof Uint8Array ? new TextDecoder().decode(rawKey) : String(rawKey);
            if (key === 'session_id') sessionId = entry.val().value() as number;
            else if (key === 'outcome') outcome = entry.val().value() as number;
          }
          if (sessionId > 0) {
            endMap.set(sessionId, {
              outcome,
              endedAt: ev.closedAt ? new Date(ev.closedAt).getTime() : Date.now(),
            });
          }
        }
      } catch { /* skip */ }
    }

    if (startEvents.length === 0) {
      return [];
    }

    // Parse start events into lobby entries
    const games: LobbyGame[] = [];
    for (const ev of startEvents) {
      try {
        const data = ev.data;
        if (data.switch().name === 'scvMap') {
          const map = data.value() as xdr.ScMapEntry[];
          let sessionId = 0;
          let player1 = '';
          let player2 = '';

          for (const entry of map) {
            const rawKey = entry.key().value();
            const key = rawKey instanceof Uint8Array ? new TextDecoder().decode(rawKey) : String(rawKey);
            if (key === 'session_id') {
              sessionId = entry.val().value() as number;
            } else if (key === 'player1') {
              player1 = Address.fromScVal(entry.val()).toString();
            } else if (key === 'player2') {
              player2 = Address.fromScVal(entry.val()).toString();
            }
          }

          if (sessionId > 0 && player1 && player2) {
            const endInfo = endMap.get(sessionId);
            const game: LobbyGame = {
              sessionId,
              player1,
              player2,
              status: endInfo ? 'finished' : 'unknown',
              ledgerTimestamp: ev.ledger,
              createdAt: ev.closedAt ? new Date(ev.closedAt).getTime() : Date.now(),
            };

            // Attach end event data if available
            if (endInfo) {
              game.outcome = endInfo.outcome;
              game.endedAt = endInfo.endedAt;
              if (endInfo.outcome === OUTCOME.PLAYER1_WIN) game.winner = player1;
              else if (endInfo.outcome === OUTCOME.PLAYER2_WIN) game.winner = player2;
            }

            games.push(game);
          }
        }
      } catch {
        // Skip malformed events
      }
    }

    // Deduplicate by session ID (keep latest)
    const deduped = new Map<number, LobbyGame>();
    for (const g of games) {
      deduped.set(g.sessionId, g);
    }

    return Array.from(deduped.values()).reverse(); // newest first
  } catch (err) {
    log.warn('[Lobby] Failed to fetch events:', err);
    return [];
  }
}

/**
 * Check if a game is stuck.
 * - Seeding (seed-commit/seed-reveal) > 5 minutes = stuck
 * - Playing > 2 hours = stuck
 */
function isGameStuck(game: LobbyGame): boolean {
  if (!game.createdAt) return false;
  const ageMs = Date.now() - game.createdAt;
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  if ((game.status === 'seed-commit' || game.status === 'seed-reveal') && ageMs > FIVE_MIN_MS) return true;
  if (game.status === 'playing' && ageMs > TWO_HOURS_MS) return true;
  return false;
}

/**
 * Check the current status of each game via the contract.
 */
async function enrichGameStatuses(games: LobbyGame[]): Promise<LobbyGame[]> {
  const enriched = await Promise.all(
    games.map(async (game) => {
      try {
        const state = await cangkulanService.getGame(game.sessionId);
        if (state) {
          const status = lifecycleToStatus(state.lifecycle_state);
          const enrichedGame: LobbyGame = { ...game, status };

          // For finished games, add outcome & winner info
          if (status === 'finished' && state.outcome) {
            enrichedGame.outcome = state.outcome;
            // Estimate end time: if createdAt is available, use it as base
            // Since we don't have exact end time, approximate from current time
            enrichedGame.endedAt = enrichedGame.endedAt ?? Date.now();
            if (state.outcome === OUTCOME.PLAYER1_WIN) {
              enrichedGame.winner = state.player1;
            } else if (state.outcome === OUTCOME.PLAYER2_WIN) {
              enrichedGame.winner = state.player2;
            }
          }

          // Check if this game is stuck
          if (isGameStuck(enrichedGame)) {
            return { ...enrichedGame, status: 'timed-out' as const };
          }
          return enrichedGame;
        }
        return { ...game, status: 'finished' as const };
      } catch {
        return game;
      }
    }),
  );
  return enriched;
}

/* ═══════════════════════════════════════════════════════════════════════════════ */

interface GameLobbyProps {
  userAddress: string;
  navigate: (route: AppRoute) => void;
}

export function GameLobby({ userAddress, navigate }: GameLobbyProps) {
  const intl = useIntl();
  const [games, setGames] = useState<LobbyGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const mountedRef = useRef(true);

  // Real-time lobby features
  const lobby = useLobbyPresence(userAddress);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rawGames = await fetchRecentGames();
      if (!mountedRef.current) return;

      // Only enrich games we'll actually display:
      // all non-finished (potential active) + 5 most recent finished
      const nonFinished = rawGames.filter(g => g.status !== 'finished');
      const finished = rawGames.filter(g => g.status === 'finished').slice(0, 5);
      const toEnrich = [...nonFinished, ...finished];

      setGames(toEnrich);
      // Enrich statuses via contract calls (background)
      const enriched = await enrichGameStatuses(toEnrich);
      if (!mountedRef.current) return;
      setGames(enriched);
      setLastRefresh(new Date());
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load games');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const interval = setInterval(refresh, 15000); // refresh every 15s
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  const activeGames = games.filter(g => g.status !== 'finished' && g.status !== 'timed-out');
  const recentFinished = games.filter(g => g.status === 'finished').slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 bg-clip-text text-transparent">
            <FormattedMessage id="lobby.title" defaultMessage="Game Lobby" />
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            <FormattedMessage id="lobby.subtitle" defaultMessage="Discover live games on the Stellar testnet" />
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Connection indicator */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-50 text-xs">
            <div className={`w-2 h-2 rounded-full ${lobby.isConnected ? 'bg-emerald-400 animate-pulse'
              : !userAddress ? 'bg-amber-400'
                : 'bg-gray-300'
              }`} />
            <span className={
              lobby.isConnected ? 'text-emerald-600 font-medium'
                : !userAddress ? 'text-amber-600'
                  : 'text-gray-400'
            }>
              {lobby.isConnected
                ? intl.formatMessage({ id: 'lobby.ws.online', defaultMessage: '{count} online' }, { count: lobby.onlinePlayers.length })
                : !userAddress
                  ? intl.formatMessage({ id: 'lobby.ws.noWallet', defaultMessage: 'No Wallet' })
                  : intl.formatMessage({ id: 'lobby.ws.offline', defaultMessage: 'Offline' })}
            </span>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="p-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-600 transition-all disabled:opacity-50"
            title={intl.formatMessage({ id: 'leaderboard.refresh', defaultMessage: 'Refresh' })}
          >
            <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Match Found Banner */}
      {lobby.matchFound && (
        <div className="p-4 bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-2xl animate-pulse">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-emerald-800">
                🎯 <FormattedMessage id="lobby.ws.matchFound" defaultMessage="Match Found!" />
              </h3>
              <p className="text-sm text-emerald-600 mt-0.5">
                <FormattedMessage id="lobby.ws.matchOpponent" defaultMessage="Opponent: {address}" values={{ address: shortenAddress(lobby.matchFound.opponent) }} />
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  navigate({ page: 'game' });
                  lobby.clearMatch();
                }}
                className="px-4 py-2 text-sm font-bold rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
              >
                <FormattedMessage id="lobby.ws.startGame" defaultMessage="Start Game" />
              </button>
              <button
                onClick={lobby.clearMatch}
                className="px-3 py-2 text-sm rounded-lg bg-white text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <FormattedMessage id="common.close" defaultMessage="Close" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Incoming Invite Banner */}
      {lobby.pendingInvite && (
        <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-blue-800">
                ⚔️ <FormattedMessage id="lobby.ws.inviteReceived" defaultMessage="Game Invite!" />
              </h3>
              <p className="text-sm text-blue-600 mt-0.5">
                <FormattedMessage id="lobby.ws.inviteFrom" defaultMessage="{address} wants to play" values={{ address: shortenAddress(lobby.pendingInvite.from) }} />
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => lobby.acceptInvite(lobby.pendingInvite!.from)}
                className="px-4 py-2 text-sm font-bold rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                <FormattedMessage id="lobby.ws.accept" defaultMessage="Accept" />
              </button>
              <button
                onClick={lobby.dismissInvite}
                className="px-3 py-2 text-sm rounded-lg bg-white text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <FormattedMessage id="lobby.ws.decline" defaultMessage="Decline" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => navigate({ page: 'game' })}
          className="flex-1 p-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-semibold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all text-sm"
        >
          <FormattedMessage id="lobby.createNew" defaultMessage="+ Create New Game" />
        </button>
        {/* Matchmaking toggle */}
        {lobby.isConnected && (
          <button
            onClick={lobby.isInQueue ? lobby.leaveQueue : lobby.joinQueue}
            className={`p-3 rounded-xl font-semibold transition-all text-sm ${lobby.isInQueue
              ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 animate-pulse'
              : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
              }`}
          >
            {lobby.isInQueue
              ? intl.formatMessage({ id: 'lobby.ws.searching', defaultMessage: '⏳ Searching…' })
              : intl.formatMessage({ id: 'lobby.ws.findMatch', defaultMessage: '🎯 Find Match' })}
          </button>
        )}
        <button
          onClick={() => navigate({ page: 'home' })}
          className="p-3 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold transition-all text-sm"
        >
          <FormattedMessage id="lobby.back" defaultMessage="Back" />
        </button>
      </div>

      {/* Online Players Panel */}
      {lobby.isConnected && lobby.onlinePlayers.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">
            <FormattedMessage id="lobby.ws.onlinePlayers" defaultMessage="Online Players ({count})" values={{ count: lobby.onlinePlayers.length }} />
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {lobby.onlinePlayers
              .filter(p => p.address !== userAddress)
              .map(player => (
                <div key={player.address} className="flex items-center gap-2 p-2.5 bg-white/70 border border-gray-200 rounded-xl">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${player.status === 'idle' ? 'bg-emerald-400' :
                    player.status === 'in-queue' ? 'bg-amber-400 animate-pulse' :
                      'bg-blue-400'
                    }`} />
                  <span className="text-xs font-mono text-gray-700 truncate flex-1" title={player.address}>
                    {shortenAddress(player.address)}
                  </span>
                  {player.status === 'idle' && (
                    <button
                      onClick={() => lobby.invite(player.address)}
                      className="px-2 py-0.5 text-[10px] font-bold rounded bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors shrink-0"
                      title={intl.formatMessage({ id: 'lobby.ws.inviteToPlay', defaultMessage: 'Invite to play' })}
                    >
                      ⚔️
                    </button>
                  )}
                  {player.status === 'in-queue' && (
                    <span className="text-[10px] text-amber-600 font-semibold shrink-0">
                      <FormattedMessage id="lobby.ws.queueStatus" defaultMessage="Queued" />
                    </span>
                  )}
                  {player.status === 'in-game' && (
                    <span className="text-[10px] text-blue-600 font-semibold shrink-0">
                      <FormattedMessage id="lobby.ws.inGame" defaultMessage="In Game" />
                    </span>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Active Games */}
      <div>
        <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">
          <FormattedMessage id="lobby.activeGames" defaultMessage="Active Games ({count})" values={{ count: activeGames.length }} />
        </h3>
        {loading && activeGames.length === 0 ? (
          <div className="space-y-3">
            {/* Loading progress */}
            <div className="flex flex-col items-center py-4 gap-2">
              <div className="relative w-10 h-10">
                <div className="absolute inset-0 rounded-full border-[3px] border-emerald-200 dark:border-emerald-900/40" />
                <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-emerald-500 animate-spin" />
                <div className="absolute inset-2 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center">
                  <span className="text-xs">🎴</span>
                </div>
              </div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                <FormattedMessage id="lobby.scanningBlockchain" defaultMessage="Scanning blockchain events..." />
              </p>
            </div>
            {/* Game card skeletons */}
            <div className="animate-pulse space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700">
                  <div className="w-8 h-8 bg-gray-200 dark:bg-gray-700 rounded-full flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-3 w-20 bg-gray-200 dark:bg-gray-700 rounded" />
                      <div className="h-3 w-6 bg-gray-200 dark:bg-gray-700 rounded" />
                      <div className="h-3 w-20 bg-gray-200 dark:bg-gray-700 rounded" />
                    </div>
                    <div className="h-3 w-16 bg-gray-200 dark:bg-gray-700 rounded" />
                  </div>
                  <div className="h-6 w-14 bg-gray-200 dark:bg-gray-700 rounded-lg" />
                </div>
              ))}
            </div>
          </div>
        ) : activeGames.length === 0 ? (
          <div className="p-6 bg-gray-50 rounded-2xl text-center">
            <div className="text-3xl mb-2">🎴</div>
            <p className="text-sm text-gray-500 font-medium">
              <FormattedMessage id="lobby.noActiveGames" defaultMessage="No active games found" />
            </p>
            <p className="text-xs text-gray-400 mt-1">
              <FormattedMessage id="lobby.beFirstToCreate" defaultMessage="Be the first to create one!" />
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeGames.map(game => (
              <GameRow key={game.sessionId} game={game} userAddress={userAddress} navigate={navigate} />
            ))}
          </div>
        )}
      </div>

      {/* Recently Finished */}
      {recentFinished.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">
            <FormattedMessage id="lobby.recentlyFinished" defaultMessage="Recently Finished" />
          </h3>
          <div className="space-y-2 opacity-70">
            {recentFinished.map(game => (
              <GameRow key={game.sessionId} game={game} userAddress={userAddress} navigate={navigate} />
            ))}
          </div>
        </div>
      )}

      {/* Wallet Connection Prompt — shown when wallet is disconnected */}
      {!userAddress && (
        <div className="p-4 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
              <span className="text-lg">🔗</span>
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-amber-800 text-sm">
                <FormattedMessage id="lobby.ws.connectWalletTitle" defaultMessage="Connect Your Wallet" />
              </h3>
              <p className="text-xs text-amber-600 mt-0.5">
                <FormattedMessage
                  id="lobby.ws.connectWalletDesc"
                  defaultMessage="Connect a Stellar wallet to access lobby chat, see online players, matchmaking, and game invites."
                />
              </p>
            </div>
            <button
              onClick={() => setShowWalletModal(true)}
              className="px-4 py-2 text-sm font-bold rounded-xl bg-amber-500 text-white hover:bg-amber-600 transition-colors shadow-md shrink-0"
            >
              <FormattedMessage id="lobby.ws.connectBtn" defaultMessage="Connect" />
            </button>
          </div>
        </div>
      )}

      {/* Wallet connection modal */}
      {showWalletModal && (
        <ConnectionModal onClose={() => setShowWalletModal(false)} />
      )}

      {/* Lobby Chat */}
      {lobby.isConnected && (
        <LobbyChatPanel
          show={showChat}
          onToggle={() => setShowChat(v => !v)}
          messages={lobby.chatMessages}
          onSend={lobby.sendChat}
          userAddress={userAddress}
        />
      )}

      {/* Last refresh */}
      {lastRefresh && (
        <p className="text-xs text-gray-400 text-center">
          <FormattedMessage id="lobby.lastRefreshed" defaultMessage="Last refreshed: {time}" values={{ time: lastRefresh.toLocaleTimeString() }} />
        </p>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════ */

function GameRow({
  game,
  userAddress,
  navigate,
}: {
  game: LobbyGame;
  userAddress: string;
  navigate: (route: AppRoute) => void;
}) {
  const intl = useIntl();
  const { label, color, dot } = STATUS_CONFIG[game.status];
  const isMyGame = game.player1 === userAddress || game.player2 === userAddress;
  const isActive = game.status !== 'finished' && game.status !== 'unknown' && game.status !== 'timed-out';

  return (
    <div className="flex items-center gap-3 p-3 bg-white/70 border border-gray-200 rounded-xl hover:shadow-md transition-all">
      {/* Status dot */}
      <div className={`w-2.5 h-2.5 rounded-full ${dot} shrink-0`} />

      {/* Game info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-gray-800">
            #{game.sessionId}
          </span>
          <span className={`text-xs font-semibold ${color}`}>{label}</span>
          {isMyGame && (
            <span className="px-1.5 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-700 rounded-md">
              <FormattedMessage id="lobby.you" defaultMessage="YOU" />
            </span>
          )}
        </div>
        <div className="flex gap-2 text-xs text-gray-500 mt-0.5">
          <span title={game.player1}>
            P1: {game.player1 === userAddress ? intl.formatMessage({ id: 'lobby.you', defaultMessage: 'YOU' }) : shortenAddress(game.player1)}
          </span>
          <span className="text-gray-300"><FormattedMessage id="lobby.vs" defaultMessage="vs" /></span>
          <span title={game.player2}>
            P2: {game.player2 === userAddress ? intl.formatMessage({ id: 'lobby.you', defaultMessage: 'YOU' }) : shortenAddress(game.player2)}
          </span>
        </div>

        {/* Finished game details: winner + time ago */}
        {(game.status === 'finished' || game.status === 'timed-out') && (
          <div className="flex items-center gap-2 mt-1 text-xs">
            {game.outcome === OUTCOME.PLAYER1_WIN && (
              <span className="text-amber-600 font-semibold" title={game.player1}>
                🏆 {game.player1 === userAddress ? 'You won!' : `Winner: ${shortenAddress(game.player1)}`}
              </span>
            )}
            {game.outcome === OUTCOME.PLAYER2_WIN && (
              <span className="text-amber-600 font-semibold" title={game.player2}>
                🏆 {game.player2 === userAddress ? 'You won!' : `Winner: ${shortenAddress(game.player2)}`}
              </span>
            )}
            {game.outcome === OUTCOME.DRAW && (
              <span className="text-gray-500 font-semibold">🤝 Draw</span>
            )}
            {game.endedAt && (
              <span className="text-gray-400">• {timeAgo(game.endedAt)}</span>
            )}
            {game.createdAt && !game.endedAt && (
              <span className="text-gray-400">• started {timeAgo(game.createdAt)}</span>
            )}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 shrink-0">
        {isMyGame && isActive ? (
          <button
            onClick={() => navigate({ page: 'game', sessionId: game.sessionId })}
            className="px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
          >
            <FormattedMessage id="lobby.resume" defaultMessage="Resume" />
          </button>
        ) : isActive ? (
          <button
            onClick={() => navigate({ page: 'spectate', sessionId: game.sessionId })}
            className="px-3 py-1.5 text-xs font-bold rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
          >
            <FormattedMessage id="lobby.spectate" defaultMessage="Spectate" />
          </button>
        ) : (
          <button
            onClick={() => navigate({ page: 'spectate', sessionId: game.sessionId })}
            className="px-3 py-1.5 text-xs font-bold rounded-lg bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors"
          >
            <FormattedMessage id="lobby.view" defaultMessage="View" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   Lobby Chat Panel — collapsible chat at the bottom of the lobby
   ═══════════════════════════════════════════════════════════════════════════════ */

function LobbyChatPanel({
  show,
  onToggle,
  messages,
  onSend,
  userAddress,
}: {
  show: boolean;
  onToggle: () => void;
  messages: Array<{ from: string; text: string; timestamp: number }>;
  onSend: (text: string) => void;
  userAddress: string;
}) {
  const intl = useIntl();
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (show && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, show]);

  const handleSend = () => {
    if (input.trim()) {
      onSend(input.trim());
      setInput('');
    }
  };

  return (
    <div className="border border-gray-200 rounded-2xl overflow-hidden bg-white/70">
      {/* Toggle header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition-colors"
      >
        <span className="text-sm font-bold text-gray-600">
          💬 <FormattedMessage id="lobby.ws.chat" defaultMessage="Lobby Chat" />
          {messages.length > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-bold bg-blue-100 text-blue-600 rounded-full">
              {messages.length}
            </span>
          )}
        </span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${show ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {show && (
        <>
          {/* Messages */}
          <div ref={scrollRef} className="h-48 overflow-y-auto border-t border-gray-100 px-3 py-2 space-y-1.5">
            {messages.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-8">
                <FormattedMessage id="lobby.ws.noChatYet" defaultMessage="No messages yet. Say hello! 👋" />
              </p>
            ) : (
              messages.map((msg, i) => {
                const isMe = msg.from === userAddress;
                return (
                  <div key={i} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                    <span className="text-[10px] text-gray-400 mb-0.5">
                      {isMe ? intl.formatMessage({ id: 'lobby.ws.chatYou', defaultMessage: 'You' }) : shortenAddress(msg.from)}
                    </span>
                    <div className={`px-2.5 py-1.5 rounded-xl text-xs max-w-[80%] ${isMe
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-gray-100 text-gray-700'
                      }`}>
                      {msg.text}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Input */}
          <div className="flex gap-2 p-2 border-t border-gray-100">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              placeholder={intl.formatMessage({ id: 'lobby.ws.chatPlaceholder', defaultMessage: 'Type a message…' })}
              maxLength={200}
              className="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:border-emerald-400 transition-colors"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 transition-colors"
            >
              <FormattedMessage id="lobby.ws.send" defaultMessage="Send" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
