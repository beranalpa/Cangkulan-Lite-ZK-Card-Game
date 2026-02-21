import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { rpc, xdr, Address } from '@stellar/stellar-sdk';
import { RPC_URL, CANGKULAN_CONTRACT, needsAllowHttp } from '@/utils/constants';
import { log } from '@/utils/logger';
import type { AppRoute } from '@/hooks/useHashRouter';
import { PageHero } from '@/components/PageHero';

/* ═══════════════════════════════════════════════════════════════════════════════
   Stats Page — On-chain analytics via Soroban event indexing
   ═══════════════════════════════════════════════════════════════════════════════

   Fetches EvGameStarted, EvGameEnded, and EvTrickResolved events from the
   Soroban RPC and computes aggregate statistics:
     • Total games played / completed / active
     • Outcome distribution (Player 1 / Player 2 / Draw)
     • Unique players
     • Average tricks per game
     • Top players by win count
     • Activity timeline (games per hour)

   All data is derived from on-chain events — no off-chain indexer required.
   ═══════════════════════════════════════════════════════════════════════════════ */

// ── Types ────────────────────────────────────────────────────────────────────

interface GameStartEvent {
  sessionId: number;
  player1: string;
  player2: string;
  ledger: number;
  timestamp?: string;
}

interface GameEndEvent {
  sessionId: number;
  outcome: number; // 1 = P1 wins, 2 = P2 wins, 3 = draw
  ledger: number;
  timestamp?: string;
}

interface RecentGame {
  sessionId: number;
  player1: string;
  player2: string;
  ledger: number;
  timestamp?: string;
  outcome?: number;    // 1 = P1 wins, 2 = P2 wins, 3 = draw
  winner?: string;     // Address of winner
  endedAt?: string;    // ISO timestamp of end event
  isActive: boolean;   // Still in progress?
}

interface TrickEvent {
  sessionId: number;
  ledger: number;
}

interface ZkPlayEvent {
  sessionId: number;
  player: string;
  validSetSize: number;
  ledger: number;
}

interface ZkCangkulEvent {
  sessionId: number;
  player: string;
  handSize: number;
  trickSuit: number;
  ledger: number;
}

interface OnChainStats {
  totalGamesStarted: number;
  totalGamesEnded: number;
  activeGames: number;
  outcomeCounts: { p1Wins: number; p2Wins: number; draws: number };
  uniquePlayers: number;
  totalTricks: number;
  avgTricksPerGame: number;
  topPlayers: { address: string; wins: number; games: number; winRate: number }[];
  recentGames: RecentGame[];
  activityByHour: number[];
  ledgerSpan: { earliest: number; latest: number };
  /** ZK verification stats */
  totalZkCardPlays: number;
  totalZkCangkuls: number;
  zkTotalVerified: number;
  zkCoveragePercent: number;
  zkTopPlayers: { address: string; proofs: number }[];
}

// ── Event fetching ───────────────────────────────────────────────────────────

/** Parse an ScVal map event payload, extracting named fields. */
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

/**
 * Fetch events of a given topic from the Soroban RPC, paginating if needed.
 * The RPC scans ~10 000 ledgers per request. When the startLedger is far
 * before the first event, the response is empty. We handle this by advancing
 * startLedger in 10 000-ledger steps until we either find events or reach
 * the chain tip.
 */
const RPC_SCAN_WINDOW = 10_000;

async function fetchEvents(
  server: rpc.Server,
  startLedger: number,
  topicSymbol: string,
  limit: number = 100,
  chainTip?: number,
): Promise<{ data: xdr.ScVal; ledger: number; timestamp?: string }[]> {
  const results: { data: xdr.ScVal; ledger: number; timestamp?: string }[] = [];
  let cursor: string | undefined;
  let currentStart = startLedger;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const params: any = {
        filters: [
          {
            type: 'contract' as const,
            contractIds: [CANGKULAN_CONTRACT],
            topics: [[xdr.ScVal.scvSymbol(topicSymbol).toXDR('base64')]],
          },
        ],
        limit,
      };

      if (cursor) {
        params.cursor = cursor;
      } else {
        params.startLedger = currentStart;
      }

      const resp = await server.getEvents(params);

      if (!resp.events || resp.events.length === 0) {
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
        results.push({ data: ev.value, ledger: ev.ledger, timestamp: ev.ledgerClosedAt });
      }

      // If we got a full page, use cursor-based pagination for next page
      if (resp.events.length >= limit) {
        cursor = resp.events[resp.events.length - 1].id;
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
    } catch (err) {
      // If startLedger is out of range, try to recover
      const msg = (err as any)?.message ?? '';
      const m = msg.match(/ledger range:\s*(\d+)/);
      if (m && !cursor) {
        currentStart = Number(m[1]);
        continue;
      }
      log.warn(`[Stats] Failed fetching ${topicSymbol} events:`, err);
      break;
    }
  }

  return results;
}

/** Fetch all game events and compute aggregate statistics. */
async function fetchOnChainStats(lookbackLedgers: number = 17280): Promise<OnChainStats> {
  const server = new rpc.Server(RPC_URL, { allowHttp: needsAllowHttp(RPC_URL) });
  const latestLedger = await server.getLatestLedger();
  const startLedger = Math.max(latestLedger.sequence - lookbackLedgers, 1);
  const chainTip = latestLedger.sequence;

  // Fetch all event types in parallel
  // Soroban #[contractevent] uses snake_case topic names on-chain
  const [startEvents, endEvents, trickEvents, zkPlayEvents, zkCangkulEvents] = await Promise.all([
    fetchEvents(server, startLedger, 'ev_game_started', 100, chainTip),
    fetchEvents(server, startLedger, 'ev_game_ended', 100, chainTip),
    fetchEvents(server, startLedger, 'ev_trick_resolved', 100, chainTip),
    fetchEvents(server, startLedger, 'ev_zk_card_play_verified', 100, chainTip),
    fetchEvents(server, startLedger, 'ev_zk_cangkul_verified', 100, chainTip),
  ]);

  // Parse game starts
  const gameStarts: GameStartEvent[] = [];
  const gameStartMap = new Map<number, GameStartEvent>();
  for (const ev of startEvents) {
    const fields = parseMapEvent(ev.data);
    const sessionId = fields['session_id']?.value() as number;
    let player1 = '';
    let player2 = '';
    try { player1 = Address.fromScVal(fields['player1']).toString(); } catch { /* skip */ }
    try { player2 = Address.fromScVal(fields['player2']).toString(); } catch { /* skip */ }
    if (sessionId > 0) {
      const entry = { sessionId, player1, player2, ledger: ev.ledger, timestamp: ev.timestamp };
      gameStarts.push(entry);
      gameStartMap.set(sessionId, entry);
    }
  }

  // Parse game ends
  const gameEnds: GameEndEvent[] = [];
  const endedSessionIds = new Set<number>();
  const endMap = new Map<number, GameEndEvent>();
  for (const ev of endEvents) {
    const fields = parseMapEvent(ev.data);
    const sessionId = fields['session_id']?.value() as number;
    const outcome = fields['outcome']?.value() as number;
    if (sessionId > 0) {
      const endEvent = { sessionId, outcome, ledger: ev.ledger, timestamp: ev.timestamp };
      gameEnds.push(endEvent);
      endedSessionIds.add(sessionId);
      endMap.set(sessionId, endEvent);
    }
  }

  // Parse trick events (just count per session)
  const trickCountBySession = new Map<number, number>();
  for (const ev of trickEvents) {
    const fields = parseMapEvent(ev.data);
    const sessionId = fields['session_id']?.value() as number;
    if (sessionId > 0) {
      trickCountBySession.set(sessionId, (trickCountBySession.get(sessionId) ?? 0) + 1);
    }
  }

  // Parse ZK card play events
  const zkPlays: ZkPlayEvent[] = [];
  for (const ev of zkPlayEvents) {
    const fields = parseMapEvent(ev.data);
    const sessionId = fields['session_id']?.value() as number;
    let player = '';
    try { player = Address.fromScVal(fields['player']).toString(); } catch { /* skip */ }
    const validSetSize = (fields['valid_set_size']?.value() as number) ?? 0;
    if (sessionId > 0) zkPlays.push({ sessionId, player, validSetSize, ledger: ev.ledger });
  }

  // Parse ZK cangkul events
  const zkCangkuls: ZkCangkulEvent[] = [];
  for (const ev of zkCangkulEvents) {
    const fields = parseMapEvent(ev.data);
    const sessionId = fields['session_id']?.value() as number;
    let player = '';
    try { player = Address.fromScVal(fields['player']).toString(); } catch { /* skip */ }
    const handSize = (fields['hand_size']?.value() as number) ?? 0;
    const trickSuit = (fields['trick_suit']?.value() as number) ?? 0;
    if (sessionId > 0) zkCangkuls.push({ sessionId, player, handSize, trickSuit, ledger: ev.ledger });
  }

  // ZK aggregation
  const zkPlayerProofs = new Map<string, number>();
  for (const zk of [...zkPlays, ...zkCangkuls]) {
    if (zk.player) zkPlayerProofs.set(zk.player, (zkPlayerProofs.get(zk.player) ?? 0) + 1);
  }
  const zkTopPlayers = Array.from(zkPlayerProofs.entries())
    .map(([address, proofs]) => ({ address, proofs }))
    .sort((a, b) => b.proofs - a.proofs)
    .slice(0, 5);
  const zkTotalVerified = zkPlays.length + zkCangkuls.length;

  // ── Compute aggregates ──────────────────────────────────────────────────

  // Outcome distribution (only count games whose start event is in the window)
  const outcomeCounts = { p1Wins: 0, p2Wins: 0, draws: 0 };
  for (const ge of gameEnds) {
    if (!gameStartMap.has(ge.sessionId)) continue; // skip ends without matching start
    if (ge.outcome === 1) outcomeCounts.p1Wins++;
    else if (ge.outcome === 2) outcomeCounts.p2Wins++;
    else if (ge.outcome === 3) outcomeCounts.draws++;
  }

  // Unique players
  const playerSet = new Set<string>();
  for (const gs of gameStarts) {
    if (gs.player1) playerSet.add(gs.player1);
    if (gs.player2) playerSet.add(gs.player2);
  }

  // Tricks per game (for games that have ended)
  let totalTricks = 0;
  for (const [, count] of trickCountBySession) {
    totalTricks += count;
  }
  // Count only end events with matching starts for averages
  const matchedEndsCount = gameEnds.filter(ge => gameStartMap.has(ge.sessionId)).length;
  const avgTricksPerGame =
    matchedEndsCount > 0 ? Math.round((totalTricks / matchedEndsCount) * 10) / 10 : 0;

  // ZK coverage: verified plays out of total trick plays (each trick = 2 plays)
  const totalPlays = totalTricks * 2;
  const zkCoveragePercent = totalPlays > 0 ? Math.round((zkTotalVerified / totalPlays) * 100) : 0;

  // Top players (by wins)
  const playerStats = new Map<string, { wins: number; games: number }>();
  for (const ge of gameEnds) {
    const gs = gameStartMap.get(ge.sessionId);
    if (!gs) continue;

    const players = [gs.player1, gs.player2].filter(Boolean);
    for (const p of players) {
      const s = playerStats.get(p) ?? { wins: 0, games: 0 };
      s.games++;
      playerStats.set(p, s);
    }

    let winner: string | null = null;
    if (ge.outcome === 1) winner = gs.player1;
    else if (ge.outcome === 2) winner = gs.player2;

    if (winner) {
      const s = playerStats.get(winner)!;
      s.wins++;
    }
  }

  const topPlayers = Array.from(playerStats.entries())
    .map(([address, s]) => ({
      address,
      wins: s.wins,
      games: s.games,
      winRate: s.games > 0 ? Math.round((s.wins / s.games) * 100) : 0,
    }))
    .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate)
    .slice(0, 10);

  // Activity by hour (24-slot histogram using ledger as proxy)
  // Rough: each ledger ~5s, so ledger % (720 * 24) ≈ time-of-day slot
  const activityByHour = new Array(24).fill(0);
  for (const gs of gameStarts) {
    if (gs.timestamp) {
      const date = new Date(gs.timestamp);
      activityByHour[date.getUTCHours()]++;
    } else {
      // Fallback: use ledger position within the lookback window
      const relLedger = gs.ledger - startLedger;
      const approxHour = Math.floor((relLedger / lookbackLedgers) * 24) % 24;
      activityByHour[approxHour]++;
    }
  }

  // Active = started but not ended
  const activeGames = gameStarts.filter(gs => !endedSessionIds.has(gs.sessionId)).length;

  return {
    totalGamesStarted: gameStarts.length,
    // Only count end events that match a start within our window
    totalGamesEnded: gameStarts.filter(gs => endedSessionIds.has(gs.sessionId)).length,
    activeGames,
    outcomeCounts,
    uniquePlayers: playerSet.size,
    totalTricks,
    avgTricksPerGame,
    topPlayers,
    recentGames: gameStarts.slice(-10).reverse().map(gs => {
      const endEvent = endMap.get(gs.sessionId);
      const recentGame: RecentGame = {
        sessionId: gs.sessionId,
        player1: gs.player1,
        player2: gs.player2,
        ledger: gs.ledger,
        timestamp: gs.timestamp,
        isActive: !endedSessionIds.has(gs.sessionId),
      };
      if (endEvent) {
        recentGame.outcome = endEvent.outcome;
        recentGame.endedAt = endEvent.timestamp;
        if (endEvent.outcome === 1) recentGame.winner = gs.player1;
        else if (endEvent.outcome === 2) recentGame.winner = gs.player2;
      }
      return recentGame;
    }),
    activityByHour,
    ledgerSpan: { earliest: startLedger, latest: latestLedger.sequence },
    totalZkCardPlays: zkPlays.length,
    totalZkCangkuls: zkCangkuls.length,
    zkTotalVerified,
    zkCoveragePercent,
    zkTopPlayers,
  };
}

// ── UI Helpers ───────────────────────────────────────────────────────────────

function shortenAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Format a past timestamp as a human-readable relative time string. */
function timeAgo(isoOrMs: string | number): string {
  const ms = typeof isoOrMs === 'string' ? new Date(isoOrMs).getTime() : isoOrMs;
  const diffMs = Date.now() - ms;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function outcomeLabel(o: number): string {
  if (o === 1) return 'Player 1';
  if (o === 2) return 'Player 2';
  return 'Draw';
}

// ── Components ───────────────────────────────────────────────────────────────

/** Stat card — single metric */
function StatCard({ label, value, icon, color }: {
  label: string;
  value: string | number;
  icon: string;
  color: string;
}) {
  return (
    <div className={`p-4 rounded-xl border ${color} text-center`}>
      <div className="text-2xl mb-1">{icon}</div>
      <div className="text-2xl font-bold text-gray-800 dark:text-gray-100">{value}</div>
      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mt-1">{label}</div>
    </div>
  );
}

/** Outcome bar chart */
function OutcomeChart({ p1Wins, p2Wins, draws }: { p1Wins: number; p2Wins: number; draws: number }) {
  const total = p1Wins + p2Wins + draws;
  if (total === 0) {
    return <p className="text-sm text-gray-400 text-center py-4">No completed games yet</p>;
  }

  const pct = (n: number) => Math.round((n / total) * 100);
  const items = [
    { label: 'P1 Wins', count: p1Wins, color: 'bg-emerald-500', textColor: 'text-emerald-700' },
    { label: 'P2 Wins', count: p2Wins, color: 'bg-blue-500', textColor: 'text-blue-700' },
    { label: 'Draws', count: draws, color: 'bg-amber-500', textColor: 'text-amber-700' },
  ];

  return (
    <div className="space-y-3">
      {items.map(item => (
        <div key={item.label}>
          <div className="flex justify-between text-xs font-semibold mb-1">
            <span className={`${item.textColor}`}>{item.label}</span>
            <span className="text-gray-500">{item.count} ({pct(item.count)}%)</span>
          </div>
          <div className="h-3 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full ${item.color} rounded-full transition-all duration-700`}
              style={{ width: `${pct(item.count)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Activity heatmap — 24-hour histogram */
function ActivityChart({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);

  return (
    <div className="space-y-2">
      <div className="flex gap-0.5 items-end h-20">
        {data.map((count, hour) => (
          <div key={hour} className="flex-1 flex flex-col items-center gap-1">
            <div
              className="w-full bg-gradient-to-t from-emerald-500 to-teal-400 rounded-t-sm transition-all duration-500"
              style={{ height: `${(count / max) * 100}%`, minHeight: count > 0 ? '4px' : '1px' }}
              title={`${hour}:00 UTC — ${count} game(s)`}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-0.5">
        {data.map((_, hour) => (
          <div key={hour} className="flex-1 text-center text-[8px] text-gray-400">
            {hour % 6 === 0 ? `${hour}h` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Leaderboard table */
function Leaderboard({ players }: { players: OnChainStats['topPlayers'] }) {
  if (players.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-4">No player data yet</p>;
  }

  return (
    <div className="space-y-2">
      {players.map((p, i) => (
        <div
          key={p.address}
          className="flex items-center gap-3 p-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl"
        >
          <span className="text-lg font-bold text-gray-400 w-6 text-center">
            {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-gray-800 dark:text-gray-200 font-mono truncate">
              {shortenAddr(p.address)}
            </div>
            <div className="text-xs text-gray-500">
              {p.games} game{p.games !== 1 ? 's' : ''}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm font-bold text-emerald-600">{p.wins}W</div>
            <div className="text-xs text-gray-400">{p.winRate}%</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Lookback period options ──────────────────────────────────────────────────
// Ledger rate: ~5 seconds per ledger on Stellar
// Calculation: time_unit / 5 seconds = ledgers

const LOOKBACK_OPTIONS = [
  { label: '1 Hour', ledgers: 720 },      // 1h * 60m * 60s / 5s = 720 ledgers
  { label: '6 Hours', ledgers: 4320 },     // 6h * 60m * 60s / 5s = 4,320 ledgers
  { label: '1 Days', ledgers: 17280 },    // 1d * 24h * 60m * 60s / 5s = 17,280 ledgers
  { label: '7 Days', ledgers: 120960 },   // 7d * 24h * 60m * 60s / 5s = 120,960 ledgers
] as const;

// ── Main StatsPage ───────────────────────────────────────────────────────────

interface StatsPageProps {
  navigate: (route: AppRoute) => void;
}

export function StatsPage({ navigate }: StatsPageProps) {
  const [stats, setStats] = useState<OnChainStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lookbackIdx, setLookbackIdx] = useState(2); // default: 1 day
  const mountedRef = useRef(true);

  const loadStats = useCallback(async (ledgers: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchOnChainStats(ledgers);
      if (mountedRef.current) {
        setStats(result);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load stats');
        log.error('[Stats] Error:', err);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadStats(LOOKBACK_OPTIONS[lookbackIdx].ledgers);
    return () => { mountedRef.current = false; };
  }, [lookbackIdx, loadStats]);

  return (
    <div className="space-y-6 pb-8">
      {/* Hero Header */}
      <PageHero
        icon="📈"
        title="On-Chain Analytics"
        subtitle="Live statistics from Soroban contract events"
        gradient="from-purple-600 via-pink-600 to-rose-700"
        navigate={navigate}
        backTo={{ page: 'home' }}
        actions={
          <button
            onClick={() => loadStats(LOOKBACK_OPTIONS[lookbackIdx].ledgers)}
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

      {/* Time range selector */}
      <div className="flex gap-2">
        {LOOKBACK_OPTIONS.map((opt, i) => (
          <button
            key={opt.label}
            onClick={() => setLookbackIdx(i)}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all ${i === lookbackIdx
              ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-lg'
              : 'hover:opacity-80'
              }`}
            style={i !== lookbackIdx ? { background: 'var(--color-surface)', color: 'var(--color-ink)', border: '1px solid var(--color-border)' } : undefined}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !stats && (
        <div className="space-y-5">
          {/* Progress indicator */}
          <div className="flex flex-col items-center py-4 gap-3">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-[3px] border-purple-200 dark:border-purple-900/40" />
              <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-purple-500 animate-spin" />
              <div className="absolute inset-2 rounded-full bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-900/30 dark:to-pink-900/30 flex items-center justify-center">
                <span className="text-sm">📊</span>
              </div>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-600 dark:text-gray-300">Scanning on-chain events…</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">This may take a moment for large time ranges</p>
            </div>
          </div>

          {/* Stat cards skeleton */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-pulse">
            {['🎮 Games', '✅ Completed', '🔴 Active', '👥 Players'].map((label) => (
              <div key={label} className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-850 text-center">
                <div className="text-2xl mb-2 opacity-30">{label.split(' ')[0]}</div>
                <div className="h-7 w-12 mx-auto bg-gray-200 dark:bg-gray-700 rounded-lg" />
                <div className="h-3 w-16 mx-auto bg-gray-200 dark:bg-gray-700 rounded mt-2" />
              </div>
            ))}
          </div>

          {/* Extended metrics skeleton */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3 animate-pulse">
            {['Total Tricks', 'Avg Tricks/Game', 'Ledger Span'].map((label) => (
              <div key={label} className="p-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-center">
                <div className="h-5 w-10 mx-auto bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 mt-2">{label}</div>
              </div>
            ))}
          </div>

          {/* Chart skeletons */}
          <div className="p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl animate-pulse">
            <div className="h-4 w-36 bg-gray-200 dark:bg-gray-700 rounded mb-4" />
            <div className="space-y-3">
              {[75, 55, 20].map((w, i) => (
                <div key={i}>
                  <div className="flex justify-between mb-1">
                    <div className="h-3 w-16 bg-gray-200 dark:bg-gray-700 rounded" />
                    <div className="h-3 w-12 bg-gray-200 dark:bg-gray-700 rounded" />
                  </div>
                  <div className="h-3 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full bg-gray-200 dark:bg-gray-600 rounded-full" style={{ width: `${w}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Activity skeleton */}
          <div className="p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl animate-pulse">
            <div className="h-4 w-32 bg-gray-200 dark:bg-gray-700 rounded mb-4" />
            <div className="flex gap-0.5 items-end h-20">
              {Array.from({ length: 24 }, (_, i) => (
                <div key={i} className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-t-sm" style={{ height: `${15 + Math.sin(i * 0.5) * 30 + Math.random() * 25}%` }} />
              ))}
            </div>
          </div>

          {/* Leaderboard skeleton */}
          <div className="p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl animate-pulse">
            <div className="h-4 w-28 bg-gray-200 dark:bg-gray-700 rounded mb-4" />
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl">
                  <div className="w-6 h-6 bg-gray-200 dark:bg-gray-700 rounded-full" />
                  <div className="flex-1">
                    <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
                    <div className="h-3 w-14 bg-gray-200 dark:bg-gray-700 rounded mt-1" />
                  </div>
                  <div className="text-right">
                    <div className="h-4 w-8 bg-gray-200 dark:bg-gray-700 rounded" />
                    <div className="h-3 w-10 bg-gray-200 dark:bg-gray-700 rounded mt-1" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent games skeleton */}
          <div className="p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl animate-pulse">
            <div className="h-4 w-28 bg-gray-200 dark:bg-gray-700 rounded mb-4" />
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl">
                  <div className="h-4 w-12 bg-gray-200 dark:bg-gray-700 rounded" />
                  <div className="flex-1">
                    <div className="h-3 w-full bg-gray-200 dark:bg-gray-700 rounded" />
                    <div className="h-3 w-2/3 bg-gray-200 dark:bg-gray-700 rounded mt-1" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Refreshing overlay */}
      {loading && stats && (
        <div className="flex items-center justify-center gap-2 py-2 px-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-xl">
          <div className="w-4 h-4 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
          <span className="text-xs font-medium text-purple-600 dark:text-purple-400">Refreshing data…</span>
        </div>
      )}

      {/* Stats content */}
      {stats && (
        <>
          {/* Key metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Games Started" value={stats.totalGamesStarted} icon="🎮" color="bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-900/20 dark:to-green-900/20 border-emerald-200 dark:border-emerald-800" />
            <StatCard label="Completed" value={stats.totalGamesEnded} icon="✅" color="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border-blue-200 dark:border-blue-800" />
            <StatCard label="Active Now" value={stats.activeGames} icon="🔴" color="bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-900/20 dark:to-rose-900/20 border-red-200 dark:border-red-800" />
            <StatCard label="Unique Players" value={stats.uniquePlayers} icon="👥" color="bg-gradient-to-br from-purple-50 to-violet-50 dark:from-purple-900/20 dark:to-violet-900/20 border-purple-200 dark:border-purple-800" />
          </div>

          {/* Extended metrics row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
            <div className="p-4 rounded-xl text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
              <div className="text-lg font-bold" style={{ color: 'var(--color-ink)' }}>{stats.totalTricks}</div>
              <div className="text-xs font-semibold" style={{ color: 'var(--color-ink-muted)' }}>Total Tricks</div>
            </div>
            <div className="p-4 rounded-xl text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
              <div className="text-lg font-bold" style={{ color: 'var(--color-ink)' }}>{stats.avgTricksPerGame}</div>
              <div className="text-xs font-semibold" style={{ color: 'var(--color-ink-muted)' }}>Avg Tricks/Game</div>
            </div>
            <div className="p-4 rounded-xl text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
              <div className="text-lg font-bold" style={{ color: 'var(--color-ink)' }}>
                {stats.ledgerSpan.latest - stats.ledgerSpan.earliest}
              </div>
              <div className="text-xs font-semibold" style={{ color: 'var(--color-ink-muted)' }}>Ledger Span</div>
            </div>
          </div>

          {/* ZK Verification Coverage */}
          <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 border border-green-200 dark:border-green-800 rounded-xl">
            <h3 className="text-sm font-bold text-green-700 dark:text-green-300 uppercase tracking-wide mb-3 flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              🔐 ZK Verification Coverage
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <div className="p-3 bg-white/60 dark:bg-gray-800/60 rounded-lg text-center">
                <div className="text-xl font-bold text-green-700 dark:text-green-300">{stats.zkTotalVerified}</div>
                <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Total ZK Proofs</div>
              </div>
              <div className="p-3 bg-white/60 dark:bg-gray-800/60 rounded-lg text-center">
                <div className="text-xl font-bold text-blue-700 dark:text-blue-300">{stats.totalZkCardPlays}</div>
                <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Ring Sigma (Mode 7)</div>
              </div>
              <div className="p-3 bg-white/60 dark:bg-gray-800/60 rounded-lg text-center">
                <div className="text-xl font-bold text-purple-700 dark:text-purple-300">{stats.totalZkCangkuls}</div>
                <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Cangkul Hand (Mode 8)</div>
              </div>
              <div className="p-3 bg-white/60 dark:bg-gray-800/60 rounded-lg text-center">
                <div className="text-xl font-bold text-emerald-700 dark:text-emerald-300">{stats.zkCoveragePercent}%</div>
                <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Coverage</div>
              </div>
            </div>
            {/* Coverage bar */}
            <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-2">
              <div
                className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full transition-all duration-700"
                style={{ width: `${Math.min(stats.zkCoveragePercent, 100)}%` }}
              />
            </div>
            {/* ZK top provers */}
            {stats.zkTopPlayers.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1.5">Top ZK Provers</div>
                <div className="space-y-1">
                  {stats.zkTopPlayers.map((p, i) => (
                    <div key={p.address} className="flex items-center gap-2 text-xs">
                      <span className="text-gray-400 font-bold w-5">#{i + 1}</span>
                      <span className="font-mono text-gray-600 dark:text-gray-300 truncate flex-1">{shortenAddr(p.address)}</span>
                      <span className="font-bold text-green-600 dark:text-green-400">{p.proofs} proofs</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Outcome distribution */}
          <div className="p-4 rounded-xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <h3 className="text-sm font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--color-ink)' }}>
              Outcome Distribution
            </h3>
            <OutcomeChart {...stats.outcomeCounts} />
          </div>

          {/* Activity timeline */}
          <div className="p-4 rounded-xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <h3 className="text-sm font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--color-ink)' }}>
              Activity (UTC hours)
            </h3>
            <ActivityChart data={stats.activityByHour} />
          </div>

          {/* Leaderboard */}
          <div className="p-4 rounded-xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <h3 className="text-sm font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--color-ink)' }}>
              🏆 Top Players
            </h3>
            <Leaderboard players={stats.topPlayers} />
          </div>

          {/* Recent games */}
          <div className="p-4 rounded-xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <h3 className="text-sm font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--color-ink)' }}>
              Recent Games
            </h3>
            {stats.recentGames.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No games in this time window</p>
            ) : (
              <div className="space-y-2">
                {stats.recentGames.map(g => (
                  <div
                    key={g.sessionId}
                    className="flex items-center gap-3 p-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl cursor-pointer hover:shadow-md transition-all"
                    onClick={() => navigate({ page: 'spectate', sessionId: g.sessionId })}
                  >
                    <span className="text-sm font-bold text-gray-700 dark:text-gray-300 w-12">
                      #{g.sessionId}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <span className="font-mono truncate">{shortenAddr(g.player1)}</span>
                        <span className="text-gray-300 dark:text-gray-600">vs</span>
                        <span className="font-mono truncate">{shortenAddr(g.player2)}</span>
                      </div>
                      {/* Winner + time ago */}
                      <div className="flex items-center gap-2 mt-0.5 text-xs">
                        {g.outcome === 1 && (
                          <span className="text-amber-600 dark:text-amber-400 font-semibold">🏆 {shortenAddr(g.player1)}</span>
                        )}
                        {g.outcome === 2 && (
                          <span className="text-amber-600 dark:text-amber-400 font-semibold">🏆 {shortenAddr(g.player2)}</span>
                        )}
                        {g.outcome === 3 && (
                          <span className="text-gray-500 font-semibold">🤝 Draw</span>
                        )}
                        {g.isActive && (
                          <span className="text-emerald-500 font-semibold">⚡ Live</span>
                        )}
                        {!g.isActive && !g.outcome && (
                          <span className="text-red-500 font-semibold">⏳ Stuck</span>
                        )}
                        {g.endedAt && (
                          <span className="text-gray-400 dark:text-gray-500">• {timeAgo(g.endedAt)}</span>
                        )}
                        {!g.endedAt && g.timestamp && (
                          <span className="text-gray-400 dark:text-gray-500">• started {timeAgo(g.timestamp)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Data source notice */}
          <div className="text-center">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Data sourced from Soroban contract events on Stellar Testnet
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Ledger range: {stats.ledgerSpan.earliest.toLocaleString()} – {stats.ledgerSpan.latest.toLocaleString()}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
