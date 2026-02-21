import { useEffect, useRef, lazy, Suspense } from 'react';
import { config } from './config';
import { Layout } from './components/Layout';
import { OnboardingModal, useOnboarding } from './components/Onboarding';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NetworkStatusBanner } from './components/NetworkStatusBanner';
import { useWallet } from './hooks/useWallet';
import { useHashRouter, loadActiveSession, parseHash } from './hooks/useHashRouter';

// Lightweight page — loaded eagerly (always shown first)
import { HomePage } from './pages/HomePage';

// ── Lazy-loaded pages (code-split) ──────────────────────────────────────────
const TutorialPage = lazy(() => import('./pages/TutorialPage').then(m => ({ default: m.TutorialPage })));
const HistoryPage  = lazy(() => import('./pages/HistoryPage').then(m => ({ default: m.HistoryPage })));
const RulesPage    = lazy(() => import('./pages/RulesPage').then(m => ({ default: m.RulesPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const StatsPage    = lazy(() => import('./pages/StatsPage').then(m => ({ default: m.StatsPage })));
const ArchitecturePage = lazy(() => import('./pages/ArchitecturePage').then(m => ({ default: m.ArchitecturePage })));
const LeaderboardPage  = lazy(() => import('./pages/LeaderboardPage').then(m => ({ default: m.LeaderboardPage })));
const DemoShowcasePage = lazy(() => import('./pages/DemoShowcasePage').then(m => ({ default: m.DemoShowcasePage })));

// ── Lazy-loaded game components (heaviest chunks) ──────────────────────────
const GameModePage  = lazy(() => import('./games/cangkulan/GameModePage').then(m => ({ default: m.GameModePage })));
const SpectatorView = lazy(() => import('./games/cangkulan/SpectatorView').then(m => ({ default: m.SpectatorView })));
const GameLobby     = lazy(() => import('./games/cangkulan/GameLobby').then(m => ({ default: m.GameLobby })));

/** Shared loading fallback for lazy chunks */
function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-gray-500 font-medium">Loading…</span>
      </div>
    </div>
  );
}



export default function App() {
  const { publicKey, isConnected, walletType, walletId, connectDev } = useWallet();
  const { showOnboarding, dismiss: dismissOnboarding, reset: resetOnboarding } = useOnboarding();
  const { route, navigate } = useHashRouter();
  const userAddress = publicKey ?? '';
  const reconnectAttempted = useRef(false);

  // ── Auto-reconnect dev wallets on reload ──────────────────────────────────
  useEffect(() => {
    if (reconnectAttempted.current) return;
    reconnectAttempted.current = true;

    const doReconnect = async () => {
      if (!isConnected && walletType === 'dev' && walletId) {
        const playerNum = walletId === 'dev-player1' ? 1 : walletId === 'dev-player2' ? 2 : null;
        if (playerNum) {
          try {
            await connectDev(playerNum);
          } catch { /* ignore — user will need to reconnect manually */ }
        }
      }

      // ── Invite link auto-redirect: ?auth=... or ?session-id=... → #/game ──
      // Run AFTER wallet reconnect so the signer is ready when CreatePhase mounts
      const params = new URLSearchParams(window.location.search);
      if (params.has('auth') || params.has('session-id')) {
        const currentRoute = parseHash(window.location.hash);
        if (currentRoute.page === 'home') {
          navigate({ page: 'game' });
        }
      }
    };

    doReconnect();
  }, []);

  // ── Determine active session for nav bar badge ───────────────────────────
  const activeSession = loadActiveSession();
  const activeSessionId = activeSession && activeSession.userAddress === userAddress
    ? activeSession.sessionId : undefined;

  // ── Determine initial session ID from hash route ──────────────────────────
  const initialSessionId = route.page === 'game' ? route.sessionId : undefined;

  // ═══════════════════════════════════════════════════════════════════════════
  //  Route → Page
  // ═══════════════════════════════════════════════════════════════════════════

  const renderPage = () => {
    switch (route.page) {
      case 'spectate':
        return (
          <Suspense fallback={<PageLoader />}>
            <SpectatorView
              sessionId={route.sessionId}
              onExit={() => navigate({ page: 'home' })}
            />
          </Suspense>
        );

      case 'tutorial':
        return <Suspense fallback={<PageLoader />}><TutorialPage navigate={navigate} /></Suspense>;

      case 'lobby':
        return <Suspense fallback={<PageLoader />}><GameLobby userAddress={userAddress} navigate={navigate} /></Suspense>;

      case 'history':
        return <Suspense fallback={<PageLoader />}><HistoryPage navigate={navigate} /></Suspense>;

      case 'rules':
        return <Suspense fallback={<PageLoader />}><RulesPage navigate={navigate} /></Suspense>;

      case 'settings':
        return <Suspense fallback={<PageLoader />}><SettingsPage navigate={navigate} /></Suspense>;

      case 'stats':
        return <Suspense fallback={<PageLoader />}><StatsPage navigate={navigate} /></Suspense>;

      case 'leaderboard':
        return <Suspense fallback={<PageLoader />}><LeaderboardPage navigate={navigate} /></Suspense>;

      case 'architecture':
        return <Suspense fallback={<PageLoader />}><ArchitecturePage navigate={navigate} /></Suspense>;

      case 'demo':
        return <Suspense fallback={<PageLoader />}><DemoShowcasePage navigate={navigate} /></Suspense>;

      case 'game':
        if (!isConnected) {
          // Show home with wallet modal auto-triggered
          return <HomePage userAddress={userAddress} isConnected={false} navigate={navigate} autoConnectFor="game" onShowOnboarding={resetOnboarding} />;
        }
        return (
          <Suspense fallback={<PageLoader />}>
            <GameModePage
              userAddress={userAddress}
              navigate={navigate}
              initialSessionId={initialSessionId}
            />
          </Suspense>
        );

      case 'home':
      default:
        return <HomePage userAddress={userAddress} isConnected={isConnected} navigate={navigate} onShowOnboarding={resetOnboarding} />;
    }
  };

  return (
    <ErrorBoundary>
      <NetworkStatusBanner />
      <Layout
        currentPage={route.page}
        navigate={navigate}
        isConnected={isConnected}
        activeSessionId={activeSessionId}
      >
        {showOnboarding && <OnboardingModal onDismiss={dismissOnboarding} />}
        {renderPage()}
      </Layout>
    </ErrorBoundary>
  );
}
