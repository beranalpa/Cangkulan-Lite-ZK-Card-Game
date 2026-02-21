import { useEffect, useRef, useState, useCallback } from 'react';
import { config } from '@/config';
import { ConnectionModal } from '@/components/ConnectionScreen';
import { loadActiveSession } from '@/hooks/useHashRouter';
import type { AppRoute } from '@/hooks/useHashRouter';
import { loadGameHistory } from '@/games/cangkulan/gameHistory';
import { useIntl } from 'react-intl';

const GAME_ID = 'cangkulan';

// ═══════════════════════════════════════════════════════════════════════════════
// Animated Counter — ticks up from 0 to target for visual polish
// ═══════════════════════════════════════════════════════════════════════════════

function AnimatedNumber({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (value === 0) { setDisplay(0); return; }
    let start = 0;
    const step = Math.max(1, Math.ceil(value / 20));
    const timer = setInterval(() => {
      start = Math.min(start + step, value);
      setDisplay(start);
      if (start >= value) clearInterval(timer);
    }, 30);
    return () => clearInterval(timer);
  }, [value]);

  return <span ref={ref}>{display}{suffix}</span>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mini Stats — animated W/L/D/WR bar with streak indicator
// ═══════════════════════════════════════════════════════════════════════════════

function MiniStats() {
  const history = loadGameHistory();
  if (history.length === 0) return null;

  const wins = history.filter(h => h.outcome === 'win' || h.outcome === 'timeout').length;
  const losses = history.filter(h => h.outcome === 'loss').length;
  const draws = history.filter(h => h.outcome === 'draw').length;
  const winRate = history.length > 0 ? Math.round((wins / history.length) * 100) : 0;

  // Calculate current streak
  let streak = 0;
  let streakType: 'win' | 'loss' | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const o = history[i].outcome;
    const isWin = o === 'win' || o === 'timeout';
    const isLoss = o === 'loss';
    if (i === history.length - 1) {
      streakType = isWin ? 'win' : isLoss ? 'loss' : null;
      if (streakType) streak = 1;
    } else {
      if (streakType === 'win' && isWin) streak++;
      else if (streakType === 'loss' && isLoss) streak++;
      else break;
    }
  }

  return (
    <div className="relative overflow-hidden rounded-2xl p-3 sm:p-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
      <div className="grid grid-cols-4 gap-1 sm:gap-3 items-center">
        <div className="text-center">
          <div className="text-base sm:text-lg font-black text-emerald-500"><AnimatedNumber value={wins} /></div>
          <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-ink-muted)' }}>Wins</div>
        </div>
        <div className="text-center">
          <div className="text-base sm:text-lg font-black text-red-500"><AnimatedNumber value={losses} /></div>
          <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-ink-muted)' }}>Losses</div>
        </div>
        <div className="text-center">
          <div className="text-base sm:text-lg font-black text-amber-500"><AnimatedNumber value={draws} /></div>
          <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-ink-muted)' }}>Draws</div>
        </div>
        <div className="text-center">
          <div className="text-base sm:text-lg font-black text-blue-500"><AnimatedNumber value={winRate} suffix="%" /></div>
          <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-ink-muted)' }}>Rate</div>
        </div>
      </div>
      {streak >= 2 && (
        <div className="flex justify-end mt-2">
          <div className={`px-2.5 py-1 rounded-full text-xs font-bold ${
            streakType === 'win' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
            : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
          }`}>
            {streakType === 'win' ? '🔥' : '💀'} {streak} streak
          </div>
        </div>
      )}
      {/* Win rate bar */}
      <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-1000"
          style={{ width: `${winRate}%` }}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tech Badges — infinite marquee ticker
// ═══════════════════════════════════════════════════════════════════════════════

const TECH_BADGES = [
  { icon: '🔐', label: 'ZK Proof Modes', detail: 'NIZK · Pedersen · Ring Sigma · Noir' },
  { icon: '📜', label: '5 Smart Contracts', detail: 'Soroban on Stellar Testnet' },
  { icon: '🏆', label: 'On-Chain ELO', detail: 'K=32/16 rating system' },
  { icon: '🎴', label: 'Commit-Reveal Cards', detail: 'True on-chain privacy' },
  { icon: '🌐', label: 'Real-Time Lobby', detail: 'WebSocket rooms + matchmaking' },
  { icon: '🤖', label: 'AI Opponent', detail: '3 difficulty levels' },
  { icon: '🌍', label: 'i18n Ready', detail: 'English + Bahasa Indonesia' },
  { icon: '📱', label: 'PWA', detail: 'Installable & offline-ready' },
];

function TechBadge({ icon, label, detail }: { icon: string; label: string; detail: string }) {
  return (
    <div
      className="flex items-center gap-2 px-3.5 py-2 rounded-xl shrink-0"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      <span className="text-base">{icon}</span>
      <div>
        <div className="text-xs font-bold whitespace-nowrap" style={{ color: 'var(--color-ink)' }}>{label}</div>
        <div className="text-[10px] whitespace-nowrap" style={{ color: 'var(--color-ink-muted)' }}>{detail}</div>
      </div>
    </div>
  );
}

function TechBadges() {
  // Duplicate badges for seamless loop
  const doubled = [...TECH_BADGES, ...TECH_BADGES];

  return (
    <div className="marquee-container overflow-hidden relative">
      {/* Fade edges */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-8 z-10" style={{ background: 'linear-gradient(to right, var(--color-bg), transparent)' }} />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-8 z-10" style={{ background: 'linear-gradient(to left, var(--color-bg), transparent)' }} />
      <div className="marquee-track flex gap-2.5 py-1">
        {doubled.map((b, i) => (
          <TechBadge key={i} icon={b.icon} label={b.label} detail={b.detail} />
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Floating Card Decoration — animated card suits in background
// ═══════════════════════════════════════════════════════════════════════════════

function FloatingCards() {
  const suits = ['♠', '♥', '♦', '♣'];
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {suits.map((s, i) => (
        <span
          key={i}
          className="absolute text-4xl opacity-[0.04] select-none"
          style={{
            top: `${15 + i * 20}%`,
            left: `${10 + i * 22}%`,
            transform: `rotate(${-15 + i * 12}deg)`,
            animation: `float-card ${4 + i}s ease-in-out infinite`,
            animationDelay: `${i * 0.7}s`,
          }}
        >
          {s}
        </span>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HomePage
// ═══════════════════════════════════════════════════════════════════════════════

interface HomePageProps {
  userAddress: string;
  isConnected: boolean;
  navigate: (route: AppRoute) => void;
  autoConnectFor?: 'game' | 'lobby';
  onShowOnboarding?: () => void;
}

export function HomePage({ userAddress, isConnected, navigate, autoConnectFor, onShowOnboarding }: HomePageProps) {
  const intl = useIntl();
  const contractId = config.contractIds[GAME_ID] || '';
  const hasContract = contractId && contractId !== 'YOUR_CONTRACT_ID';
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<AppRoute | null>(null);

  // Auto-open wallet modal if redirected from a page that needs wallet
  const autoTriggered = useRef(false);
  useEffect(() => {
    if (autoConnectFor && !isConnected && !autoTriggered.current) {
      autoTriggered.current = true;
      const route: AppRoute = autoConnectFor === 'game' ? { page: 'game' } : { page: 'lobby' };
      setPendingRoute(route);
      setShowWalletModal(true);
    }
  }, [autoConnectFor, isConnected]);

  // Redirect to active game if one exists
  const redirectAttempted = useRef(false);
  useEffect(() => {
    if (redirectAttempted.current || !isConnected) return;
    redirectAttempted.current = true;
    const session = loadActiveSession();
    if (session && session.userAddress === userAddress) {
      navigate({ page: 'game', sessionId: session.sessionId });
    }
  }, [isConnected, userAddress, navigate]);

  // When wallet connects and we have a pending route, navigate there
  useEffect(() => {
    if (isConnected && pendingRoute) {
      navigate(pendingRoute);
      setPendingRoute(null);
    }
  }, [isConnected, pendingRoute, navigate]);

  const navigateWithWallet = useCallback((route: AppRoute) => {
    if (isConnected) {
      navigate(route);
    } else {
      setPendingRoute(route);
      setShowWalletModal(true);
    }
  }, [isConnected, navigate]);

  if (!hasContract) {
    return (
      <div className="card">
        <h3 className="gradient-text">{intl.formatMessage({ id: 'home.contractNotConfigured' })}</h3>
        <p style={{ color: 'var(--color-ink-muted)', marginTop: '1rem' }}>
          {intl.formatMessage({ id: 'home.contractNotConfiguredDesc' })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── Hero Section ──────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-3xl p-6 sm:p-8 bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 text-white">
        <FloatingCards />
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-3xl">🃏</span>
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight">Cangkulan Lite</h1>
          </div>
          <p className="text-sm sm:text-base opacity-90 mb-1 font-medium">
            {intl.formatMessage({ id: 'home.heroSubtitle' })}
          </p>
          <p className="text-xs opacity-70 mb-5 max-w-lg">
            {intl.formatMessage({ id: 'home.heroDescription' })}
          </p>

          {/* Primary CTA */}
          <button
            onClick={() => navigateWithWallet({ page: 'game' })}
            className="group relative inline-flex items-center gap-2.5 px-7 py-3.5 rounded-2xl bg-white text-emerald-700 font-bold text-base shadow-xl hover:shadow-2xl hover:scale-[1.03] active:scale-[0.98] transition-all"
          >
            <span className="text-xl group-hover:animate-bounce">🎮</span>
            <span>{intl.formatMessage({ id: 'home.playGame' })}</span>
            <svg className="w-4 h-4 opacity-60 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <p className="text-[11px] opacity-60 mt-2.5 font-medium">
            Multiplayer · vs AI · Dev Testing
          </p>
        </div>
      </section>

      {/* ── Stats Bar (connected only) ────────────────────────────────────── */}
      {isConnected && <MiniStats />}

      {/* ── Feature Cards (2 rows × 3 cols) ──────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold" style={{ color: 'var(--color-ink)' }}>
            {intl.formatMessage({ id: 'home.explore' })}
          </h2>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {/* Live Lobby */}
          <FeatureCard
            icon="🌐"
            title={intl.formatMessage({ id: 'home.gameLobby' })}
            desc={intl.formatMessage({ id: 'home.gameLobbyDesc' })}
            gradient="from-cyan-500 to-blue-500"
            onClick={() => navigateWithWallet({ page: 'lobby' })}
            badge="LIVE"
            badgeColor="bg-cyan-500"
          />

          {/* Tutorial */}
          <FeatureCard
            icon="🎓"
            title={intl.formatMessage({ id: 'home.tutorial' })}
            desc={intl.formatMessage({ id: 'home.tutorialDesc' })}
            gradient="from-amber-400 to-orange-500"
            onClick={() => navigate({ page: 'tutorial' })}
          />

          {/* Leaderboard */}
          <FeatureCard
            icon="🏆"
            title={intl.formatMessage({ id: 'home.leaderboard' })}
            desc={intl.formatMessage({ id: 'home.leaderboardDesc' })}
            gradient="from-yellow-500 to-amber-600"
            onClick={() => navigate({ page: 'leaderboard' })}
          />

          {/* History */}
          <FeatureCard
            icon="📊"
            title={intl.formatMessage({ id: 'home.history' })}
            desc={intl.formatMessage({ id: 'home.historyDesc' })}
            gradient="from-purple-500 to-violet-600"
            onClick={() => navigate({ page: 'history' })}
            requiresWallet
            isConnected={isConnected}
          />

          {/* On-Chain Stats */}
          <FeatureCard
            icon="📈"
            title={intl.formatMessage({ id: 'home.onChainStats' })}
            desc={intl.formatMessage({ id: 'home.onChainStatsDesc' })}
            gradient="from-pink-500 to-rose-600"
            onClick={() => navigate({ page: 'stats' })}
          />

          {/* Feature Showcase */}
          <FeatureCard
            icon="✨"
            title={intl.formatMessage({ id: 'home.demo' })}
            desc={intl.formatMessage({ id: 'home.demoDesc' })}
            gradient="from-violet-500 to-purple-600"
            onClick={() => navigate({ page: 'demo' })}
          />
        </div>
      </section>

      {/* ── Tech Highlights (running marquee) ─────────────────────────────── */}
      <section>
        <h2 className="text-base font-bold mb-3" style={{ color: 'var(--color-ink)' }}>
          {intl.formatMessage({ id: 'home.techHighlights' })}
        </h2>
        <TechBadges />
      </section>

      {/* ── Quick Links (secondary pages from removed navbar) ────────────── */}
      <section className="rounded-2xl p-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--color-ink)' }}>
          {intl.formatMessage({ id: 'home.morePages' })}
        </h3>
        <div className="flex flex-wrap gap-2">
          <QuickLink icon="📖" label={intl.formatMessage({ id: 'home.rules' })} onClick={() => navigate({ page: 'rules' })} />
          <QuickLink icon="📐" label={intl.formatMessage({ id: 'home.architecture' })} onClick={() => navigate({ page: 'architecture' })} />
          <QuickLink icon="⚙️" label={intl.formatMessage({ id: 'home.settings' })} onClick={() => navigate({ page: 'settings' })} />
          <QuickLink icon="🔄" label={intl.formatMessage({ id: 'home.onboarding' })} onClick={() => onShowOnboarding?.()} />
        </div>
      </section>

      {/* Wallet connection modal */}
      {showWalletModal && (
        <ConnectionModal onClose={() => { setShowWalletModal(false); setPendingRoute(null); }} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sub-Components
// ═══════════════════════════════════════════════════════════════════════════════

interface FeatureCardProps {
  icon: string;
  title: string;
  desc: string;
  gradient: string;
  onClick: () => void;
  badge?: string;
  badgeColor?: string;
  requiresWallet?: boolean;
  isConnected?: boolean;
}

function FeatureCard({ icon, title, desc, gradient, onClick, badge, badgeColor, requiresWallet, isConnected }: FeatureCardProps) {
  const dimmed = requiresWallet && !isConnected;
  return (
    <button
      onClick={onClick}
      className={`group relative p-4 rounded-2xl text-left transition-all duration-200 hover:shadow-lg hover:scale-[1.03] active:scale-[0.98] ${dimmed ? 'opacity-50' : ''}`}
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      {badge && (
        <span className={`absolute top-2 right-2 px-1.5 py-0.5 rounded-full text-[9px] font-black text-white ${badgeColor || 'bg-blue-500'} animate-pulse`}>
          {badge}
        </span>
      )}
      <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl mb-2.5 bg-gradient-to-br ${gradient} text-white text-lg shadow-md group-hover:shadow-lg group-hover:scale-110 transition-all`}>
        {icon}
      </div>
      <div className="text-sm font-bold mb-0.5" style={{ color: 'var(--color-ink)' }}>{title}</div>
      <div className="text-[11px] leading-snug" style={{ color: 'var(--color-ink-muted)' }}>{desc}</div>
      {dimmed && (
        <div className="text-[9px] mt-1 text-amber-600 font-semibold">🔗 Connect wallet first</div>
      )}
    </button>
  );
}

function QuickLink({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all hover:scale-105 active:scale-95"
      style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-ink-muted)' }}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
