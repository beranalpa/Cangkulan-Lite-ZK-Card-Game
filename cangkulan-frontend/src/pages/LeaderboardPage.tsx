import { useState, useEffect, useCallback, useMemo } from 'react';
import { rpc, xdr, Address } from '@stellar/stellar-sdk';
import { RPC_URL, CANGKULAN_CONTRACT, needsAllowHttp } from '@/utils/constants';
import { log } from '@/utils/logger';
import type { AppRoute } from '@/hooks/useHashRouter';
import { PageHero } from '@/components/PageHero';

/* ═══════════════════════════════════════════════════════════════════════════════
   Leaderboard Page — ELO rankings derived from on-chain game events
   ═══════════════════════════════════════════════════════════════════════════════

   Fetches EvGameStarted and EvGameEnded events from the Soroban RPC to
   build an ELO-based leaderboard. Computed entirely client-side from
   on-chain events — no off-chain indexer required.

   When a deployed leaderboard contract is available, this can be upgraded
   to call get_top_players() directly.
   ═══════════════════════════════════════════════════════════════════════════════ */

// ── Types ────────────────────────────────────────────────────────────────────

interface PlayerRanking {
  address: string;
  shortAddress: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
  winRate: number;
  winStreak: number;
  bestStreak: number;
}

interface LeaderboardState {
  loading: boolean;
  error: string | null;
  players: PlayerRanking[];
  lastUpdated: number | null;
}

// ── ELO Calculator ──────────────────────────────────────────────────────────

const DEFAULT_ELO = 1200;
const K_NEW = 32;
const K_ESTABLISHED = 16;
const GAMES_THRESHOLD = 30;

function expectedScore(ratingDiff: number): number {
  return 1 / (1 + Math.pow(10, ratingDiff / 400));
}

function calculateEloChange(
  playerElo: number,
  opponentElo: number,
  actual: number, // 1 = win, 0.5 = draw, 0 = loss
  gamesPlayed: number,
): number {
  const k = gamesPlayed < GAMES_THRESHOLD ? K_NEW : K_ESTABLISHED;
  const expected = expectedScore(opponentElo - playerElo);
  // Match contract: scale expected to 0-100, then divide by 100
  const expectedPct = expected * 100;
  const actualPct = actual === 1 ? 100 : actual === 0 ? 0 : 50;
  const change = Math.round(k * (actualPct - expectedPct) / 100);
  return change;
}

// ── Event Parsing ───────────────────────────────────────────────────────────

function parseMapEvent(data: xdr.ScVal): Record<string, xdr.ScVal> {
  const result: Record<string, xdr.ScVal> = {};
  if (data.switch().name === 'scvMap') {
    const map = data.value() as xdr.ScMapEntry[];
    for (const entry of map) {
      const rawKey = entry.key().value();
      const key = rawKey instanceof Uint8Array ? new TextDecoder().decode(rawKey) : String(rawKey);
      if (key) result[key] = entry.val();
    }
  }
  return result;
}

function scValToAddress(val: xdr.ScVal): string {
  try {
    return Address.fromScVal(val).toString();
  } catch {
    return '';
  }
}

function scValToU32(val: xdr.ScVal): number {
  try {
    const n = val.value();
    return typeof n === 'number' ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch events with forward-scan pagination.
 * Soroban RPC scans ~10 000 ledgers per request. When startLedger is far
 * before events, we advance in 10k steps until we reach the chain tip.
 */
const RPC_SCAN_WINDOW = 10_000;

async function fetchGameEvents(
  server: rpc.Server,
  startLedger: number,
  topicSymbol: string,
  limit = 100,
  chainTip?: number,
): Promise<{ data: xdr.ScVal; ledger: number }[]> {
  const results: { data: xdr.ScVal; ledger: number }[] = [];
  let cursor: string | undefined;
  let currentStart = startLedger;
  const contractId = CANGKULAN_CONTRACT;
  if (!contractId) return results;

  try {
    for (let page = 0; page < 40; page++) {
      const params: any = {
        filters: [{
          type: 'contract' as const,
          contractIds: [contractId],
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

      if (!resp.events?.length) {
        // RPC may have only scanned ~10k ledgers. Advance and retry.
        const tip = chainTip ?? resp.latestLedger ?? 0;
        currentStart += RPC_SCAN_WINDOW;
        cursor = undefined;
        if (tip > 0 && currentStart < tip) {
          continue;
        }
        break;
      }

      for (const ev of resp.events) {
        if (ev.value) {
          results.push({ data: ev.value, ledger: ev.ledger });
        }
      }

      // If we got a full page, use cursor-based pagination for next page
      if (resp.events.length >= limit) {
        cursor = resp.events[resp.events.length - 1]?.id;
        if (!cursor) break;
        continue;
      }

      // Got fewer than limit — RPC may have only scanned ~10k ledgers.
      // Advance past the end of the scanned window (whichever is further:
      // the last event position or the expected end of this scan window).
      const lastEventLedger = resp.events[resp.events.length - 1].ledger;
      const tip = chainTip ?? resp.latestLedger ?? 0;
      const nextStart = Math.max(lastEventLedger + 1, currentStart + RPC_SCAN_WINDOW);
      cursor = undefined;
      if (tip > 0 && nextStart < tip) {
        currentStart = nextStart;
        continue;
      }
      break;
    }
  } catch (err: any) {
    // If startLedger is out of range, try to recover
    const m = (err?.message ?? '').match(/ledger range:\s*(\d+)/);
    if (m && !cursor && results.length === 0) {
      return fetchGameEvents(server, Number(m[1]), topicSymbol, limit, chainTip);
    }
    log.warn('[Leaderboard] Event fetch error:', err);
  }
  return results;
}

// ── Build Leaderboard ───────────────────────────────────────────────────────

interface MutablePlayerData {
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
  winStreak: number;
  bestStreak: number;
}

function buildLeaderboard(
  startEvents: { data: xdr.ScVal; ledger: number }[],
  endEvents: { data: xdr.ScVal; ledger: number }[],
): PlayerRanking[] {
  // Map session_id → { player1, player2 }
  const sessions = new Map<number, { player1: string; player2: string }>();
  for (const ev of startEvents) {
    const fields = parseMapEvent(ev.data);
    const sessionId = scValToU32(fields['session_id']);
    const player1 = scValToAddress(fields['player1']);
    const player2 = scValToAddress(fields['player2']);
    if (sessionId && player1 && player2) {
      sessions.set(sessionId, { player1, player2 });
    }
  }

  // Process end events to compute ELO
  const players = new Map<string, MutablePlayerData>();

  const getPlayer = (addr: string): MutablePlayerData => {
    if (!players.has(addr)) {
      players.set(addr, { elo: DEFAULT_ELO, wins: 0, losses: 0, draws: 0, gamesPlayed: 0, winStreak: 0, bestStreak: 0 });
    }
    return players.get(addr)!;
  };

  for (const ev of endEvents) {
    const fields = parseMapEvent(ev.data);
    const sessionId = scValToU32(fields['session_id']);
    const outcome = scValToU32(fields['outcome']);
    const session = sessions.get(sessionId);
    if (!session) continue;

    const p1 = getPlayer(session.player1);
    const p2 = getPlayer(session.player2);

    let actual1 = 0.5, actual2 = 0.5;
    if (outcome === 1) { actual1 = 1; actual2 = 0; }
    else if (outcome === 2) { actual1 = 0; actual2 = 1; }

    const change1 = calculateEloChange(p1.elo, p2.elo, actual1, p1.gamesPlayed);
    const change2 = calculateEloChange(p2.elo, p1.elo, actual2, p2.gamesPlayed);

    p1.elo = Math.max(100, p1.elo + change1);
    p2.elo = Math.max(100, p2.elo + change2);
    p1.gamesPlayed++;
    p2.gamesPlayed++;

    if (outcome === 1) {
      p1.wins++; p1.winStreak++; p1.bestStreak = Math.max(p1.bestStreak, p1.winStreak);
      p2.losses++; p2.winStreak = 0;
    } else if (outcome === 2) {
      p2.wins++; p2.winStreak++; p2.bestStreak = Math.max(p2.bestStreak, p2.winStreak);
      p1.losses++; p1.winStreak = 0;
    } else {
      p1.draws++; p2.draws++; p1.winStreak = 0; p2.winStreak = 0;
    }
  }

  // Convert to rankings
  const rankings: PlayerRanking[] = [];
  for (const [address, data] of players) {
    rankings.push({
      address,
      shortAddress: `${address.slice(0, 4)}…${address.slice(-4)}`,
      elo: data.elo,
      wins: data.wins,
      losses: data.losses,
      draws: data.draws,
      gamesPlayed: data.gamesPlayed,
      winRate: data.gamesPlayed > 0 ? Math.round((data.wins / data.gamesPlayed) * 100) : 0,
      winStreak: data.winStreak,
      bestStreak: data.bestStreak,
    });
  }

  // Sort by ELO descending
  rankings.sort((a, b) => b.elo - a.elo);
  return rankings;
}

// ── Rank Badge ──────────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="text-2xl" title="1st place">🥇</span>;
  if (rank === 2) return <span className="text-2xl" title="2nd place">🥈</span>;
  if (rank === 3) return <span className="text-2xl" title="3rd place">🥉</span>;
  return <span className="text-sm font-bold text-gray-500 dark:text-gray-400">#{rank}</span>;
}

function EloBar({ elo, max }: { elo: number; max: number }) {
  const pct = Math.min(100, Math.max(5, ((elo - 100) / (max - 100)) * 100));
  const color = elo >= 1400 ? 'bg-emerald-500' : elo >= 1200 ? 'bg-blue-500' : 'bg-orange-500';
  return (
    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
      <div className={`${color} h-2 rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function EloTier({ elo }: { elo: number }) {
  if (elo >= 1600) return <span className="text-xs font-bold text-purple-500">🔥 Grandmaster</span>;
  if (elo >= 1400) return <span className="text-xs font-bold text-emerald-500">⭐ Expert</span>;
  if (elo >= 1200) return <span className="text-xs font-bold text-blue-500">📘 Intermediate</span>;
  if (elo >= 1000) return <span className="text-xs font-bold text-orange-500">📗 Beginner</span>;
  return <span className="text-xs font-bold text-gray-500">🆕 Novice</span>;
}

// ── Main Component ──────────────────────────────────────────────────────────

export function LeaderboardPage({ navigate }: { navigate: (route: AppRoute) => void }) {
  const [state, setState] = useState<LeaderboardState>({
    loading: true,
    error: null,
    players: [],
    lastUpdated: null,
  });
  const [sortBy, setSortBy] = useState<'elo' | 'wins' | 'winRate' | 'games'>('elo');
  const [searchQuery, setSearchQuery] = useState('');
  const [lookbackDays, setLookbackDays] = useState(7); // Time range selector: 1, 7, 30 days

  const fetchLeaderboard = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const server = new rpc.Server(RPC_URL, { allowHttp: needsAllowHttp(RPC_URL) });
      const latestLedger = await server.getLatestLedger();
      // Ledger rate: ~5 seconds per ledger
      // Calculate lookback: days * 24h * 60m * 60s / 5s = days * 17,280 ledgers
      const LEDGERS_PER_DAY = 17_280;
      const lookbackLedgers = lookbackDays * LEDGERS_PER_DAY;
      const startLedger = Math.max(1, latestLedger.sequence - lookbackLedgers);
      const chainTip = latestLedger.sequence;

      const [startEvents, endEvents] = await Promise.all([
        fetchGameEvents(server, startLedger, 'ev_game_started', 100, chainTip),
        fetchGameEvents(server, startLedger, 'ev_game_ended', 100, chainTip),
      ]);

      const rankings = buildLeaderboard(startEvents, endEvents);

      setState({
        loading: false,
        error: null,
        players: rankings,
        lastUpdated: Date.now(),
      });
    } catch (err) {
      log.error('[Leaderboard] Failed to fetch:', err);
      setState(prev => ({
        ...prev,
        loading: false,
        error: 'Failed to load leaderboard data. Please try again.',
      }));
    }
  }, [lookbackDays]);

  useEffect(() => { fetchLeaderboard(); }, [fetchLeaderboard, lookbackDays]);

  const sortedPlayers = useMemo(() => {
    let filtered = state.players.filter(p => p.gamesPlayed > 0); // Only active players
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(p => p.address.toLowerCase().includes(q));
    }
    const sorted = [...filtered];
    switch (sortBy) {
      case 'wins': sorted.sort((a, b) => b.wins - a.wins); break;
      case 'winRate': sorted.sort((a, b) => b.winRate - a.winRate || b.gamesPlayed - a.gamesPlayed); break;
      case 'games': sorted.sort((a, b) => b.gamesPlayed - a.gamesPlayed); break;
      default: sorted.sort((a, b) => b.elo - a.elo); break;
    }
    return sorted;
  }, [state.players, sortBy, searchQuery]);

  const maxElo = useMemo(() => Math.max(1400, ...state.players.map(p => p.elo)), [state.players]);

  // ── Summary stats ─────────────────────────────────────────────────────────
  // Only include active players (those with at least 1 game played) in statistics
  const activePlayers = state.players.filter(p => p.gamesPlayed > 0);
  const totalActivePlayers = activePlayers.length;
  const totalPlayers = state.players.length;
  const totalGames = activePlayers.reduce((sum, p) => sum + p.gamesPlayed, 0) / 2; // each game has 2 players
  const avgElo = totalActivePlayers > 0
    ? Math.round(activePlayers.reduce((sum, p) => sum + p.elo, 0) / totalActivePlayers)
    : DEFAULT_ELO;

  // Debug: Log average ELO calculation
  useEffect(() => {
    if (activePlayers.length > 0) {
      const sum = activePlayers.reduce((sum, p) => sum + p.elo, 0);
      const avg = sum / totalActivePlayers;
      log.debug(`[Leaderboard] Avg ELO: ${sum} / ${totalActivePlayers} = ${avg.toFixed(2)} → ${avgElo}`,
        activePlayers.slice(0, 5).map(p => ({ addr: p.shortAddress, elo: p.elo, games: p.gamesPlayed })));
    }
  }, [activePlayers, totalActivePlayers, avgElo]);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Hero Header */}
      <PageHero
        icon="🏆"
        title="Leaderboard"
        subtitle="ELO ratings computed from on-chain game events"
        gradient="from-emerald-600 via-teal-600 to-cyan-700"
        navigate={navigate}
        backTo={{ page: 'home' }}
        actions={
          <div className="flex items-center gap-2">
            {state.lastUpdated && (
              <span className="text-xs text-white/70">
                {new Date(state.lastUpdated).toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={fetchLeaderboard}
              disabled={state.loading}
              className="px-3 py-1.5 text-sm bg-white/20 hover:bg-white/30 backdrop-blur-sm text-white rounded-lg disabled:opacity-50 transition-colors font-bold"
            >
              {state.loading ? '⏳' : '🔄'} Refresh
            </button>
          </div>
        }
      />

      {/* Time range selector */}
      <div className="flex gap-2">
        {[1, 7, 30].map((days) => (
          <button
            key={days}
            onClick={() => setLookbackDays(days)}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all ${days === lookbackDays
              ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg'
              : 'hover:opacity-80'
              }`}
            style={days !== lookbackDays ? { background: 'var(--color-surface)', color: 'var(--color-ink)', border: '1px solid var(--color-border)' } : undefined}
          >
            Last {days === 1 ? '1 Day' : `${days} Days`}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-4">
        <div className="rounded-xl p-4 shadow-sm" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <p className="text-2xl font-bold text-emerald-600">{totalActivePlayers}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>
            Active {lookbackDays === 1 ? 'Today' : `(Last ${lookbackDays}d)`}
            {totalPlayers > totalActivePlayers ? ` • ${totalPlayers} total` : ''}
          </p>
        </div>
        <div className="rounded-xl p-4 shadow-sm" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <p className="text-2xl font-bold text-blue-600">{Math.round(totalGames)}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>Games Played</p>
        </div>
        <div className="rounded-xl p-4 shadow-sm" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <p className="text-2xl font-bold text-purple-600">{avgElo}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>Avg ELO {lookbackDays === 1 ? '(Today)' : ''}</p>
        </div>
      </div>

      {/* ELO Tier Legend */}
      <div className="rounded-xl p-4 shadow-sm" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--color-ink)' }}>ELO Tiers</h3>
        <div className="flex flex-wrap gap-2 sm:gap-4 text-xs">
          <span>🔥 <strong className="text-purple-500">Grandmaster</strong> 1600+</span>
          <span>⭐ <strong className="text-emerald-500">Expert</strong> 1400-1599</span>
          <span>📘 <strong className="text-blue-500">Intermediate</strong> 1200-1399</span>
          <span>📗 <strong className="text-orange-500">Beginner</strong> 1000-1199</span>
          <span>🆕 <strong className="text-gray-500">Novice</strong> &lt;1000</span>
        </div>
      </div>

      {/* Search & Sort */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          placeholder="Search by address…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="flex-1 px-3 py-2 text-sm rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
          style={{ background: 'var(--color-surface)', color: 'var(--color-ink)', border: '1px solid var(--color-border)' }}
        />
        <div className="flex gap-1">
          {(['elo', 'wins', 'winRate', 'games'] as const).map(key => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${sortBy === key
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
            >
              {key === 'elo' ? '🏅 ELO' : key === 'wins' ? '🏆 Wins' : key === 'winRate' ? '📊 Win%' : '🎮 Games'}
            </button>
          ))}
        </div>
      </div>

      {/* Loading skeleton */}
      {state.loading && state.players.length === 0 && (
        <div className="space-y-5">
          {/* Progress indicator */}
          <div className="flex flex-col items-center py-4 gap-3">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-[3px] border-emerald-200 dark:border-emerald-900/40" />
              <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-emerald-500 animate-spin" />
              <div className="absolute inset-2 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center">
                <span className="text-sm">🏆</span>
              </div>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-600 dark:text-gray-300">Computing ELO rankings…</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Scanning on-chain game events</p>
            </div>
          </div>

          {/* Summary cards skeleton */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-4 animate-pulse">
            {['Players', 'Games', 'Avg ELO'].map((label) => (
              <div key={label} className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-200 dark:border-gray-700">
                <div className="h-7 w-12 bg-gray-200 dark:bg-gray-700 rounded-lg" />
                <div className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 mt-2">{label}</div>
              </div>
            ))}
          </div>

          {/* ELO Tier skeleton */}
          <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-200 dark:border-gray-700 animate-pulse">
            <div className="h-4 w-20 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
            <div className="flex flex-wrap gap-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
              ))}
            </div>
          </div>

          {/* Table skeleton */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden animate-pulse">
            {/* Header */}
            <div className="bg-gray-50 dark:bg-gray-900/50 px-4 py-3 flex gap-4">
              {['#', 'Player', 'ELO', 'Tier', 'W/L/D', 'Win%', 'Streak', 'Rating'].map((h) => (
                <div key={h} className="h-4 bg-gray-200 dark:bg-gray-700 rounded" style={{ width: h === 'Player' ? '120px' : h === 'Rating' ? '100px' : '50px' }} />
              ))}
            </div>
            {/* Rows */}
            {[...Array(8)].map((_, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-4 border-t border-gray-100 dark:border-gray-700">
                <div className="w-6 h-6 bg-gray-200 dark:bg-gray-700 rounded-full flex-shrink-0" />
                <div className="h-4 w-20 bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="h-5 w-10 bg-gray-200 dark:bg-gray-700 rounded font-bold" />
                <div className="h-4 w-20 bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="h-4 w-16 bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="h-4 w-10 bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="h-4 w-14 bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Refreshing overlay */}
      {state.loading && state.players.length > 0 && (
        <div className="flex items-center justify-center gap-2 py-2 px-4 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl">
          <div className="w-4 h-4 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Refreshing rankings…</span>
        </div>
      )}

      {state.error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 text-center">
          <p className="text-red-600 dark:text-red-400 text-sm">{state.error}</p>
          <button onClick={fetchLeaderboard} className="mt-2 text-sm text-red-500 underline">
            Try again
          </button>
        </div>
      )}

      {!state.loading && !state.error && sortedPlayers.length === 0 && (
        <div className="text-center py-16">
          <p className="text-4xl mb-3">🏆</p>
          <p className="text-gray-500 dark:text-gray-400">
            {searchQuery ? 'No players match your search.' : 'No games recorded yet. Play some games to populate the leaderboard!'}
          </p>
        </div>
      )}

      {/* Rankings Table */}
      {!state.loading && sortedPlayers.length > 0 && (
        <div className="rounded-xl shadow-sm overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-900/50 text-left">
                  <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-400 w-12">#</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-400">Player</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-400 text-center">ELO</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-400 text-center">Tier</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-400 text-center">W/L/D</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-400 text-center">Win%</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-400 text-center">🔥 Streak</th>
                  <th className="px-4 py-3 font-semibold text-gray-600 dark:text-gray-400 w-32">Rating</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {sortedPlayers.map((player, idx) => (
                  <tr key={player.address} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                    <td className="px-4 py-3"><RankBadge rank={idx + 1} /></td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-gray-700 dark:text-gray-300" title={player.address}>
                        {player.shortAddress}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center font-bold text-gray-900 dark:text-white">{player.elo}</td>
                    <td className="px-4 py-3 text-center"><EloTier elo={player.elo} /></td>
                    <td className="px-4 py-3 text-center text-xs">
                      <span className="text-emerald-600">{player.wins}</span>
                      <span className="text-gray-400 mx-0.5">/</span>
                      <span className="text-red-500">{player.losses}</span>
                      <span className="text-gray-400 mx-0.5">/</span>
                      <span className="text-gray-500">{player.draws}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`font-medium ${player.winRate >= 60 ? 'text-emerald-600' : player.winRate >= 40 ? 'text-blue-600' : 'text-red-500'}`}>
                        {player.winRate}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {player.winStreak > 0 && <span className="text-orange-500 font-bold">{player.winStreak}</span>}
                      {player.winStreak === 0 && <span className="text-gray-400">—</span>}
                      <span className="text-xs text-gray-400 ml-1">(best: {player.bestStreak})</span>
                    </td>
                    <td className="px-4 py-3"><EloBar elo={player.elo} max={maxElo} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden divide-y divide-gray-100 dark:divide-gray-700">
            {sortedPlayers.map((player, idx) => (
              <div key={player.address} className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <RankBadge rank={idx + 1} />
                    <span className="font-mono text-xs text-gray-700 dark:text-gray-300" title={player.address}>
                      {player.shortAddress}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-gray-900 dark:text-white">{player.elo}</span>
                    <EloTier elo={player.elo} />
                  </div>
                </div>
                <EloBar elo={player.elo} max={maxElo} />
                <div className="flex justify-between text-xs text-gray-500">
                  <span>
                    <span className="text-emerald-600">{player.wins}W</span>
                    {' / '}
                    <span className="text-red-500">{player.losses}L</span>
                    {' / '}
                    <span>{player.draws}D</span>
                  </span>
                  <span className={player.winRate >= 50 ? 'text-emerald-600' : 'text-red-500'}>
                    {player.winRate}% win rate
                  </span>
                  {player.bestStreak > 0 && <span>🔥 Best: {player.bestStreak}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data source */}
      <div className="text-center">
        <p className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          Rankings computed from Stellar Soroban contract events
        </p>
      </div>
    </div>
  );
}

export default LeaderboardPage;
