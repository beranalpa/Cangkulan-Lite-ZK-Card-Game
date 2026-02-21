import { useState, useEffect, lazy, Suspense } from 'react';
import { useWallet } from '@/hooks/useWallet';
import type { AppRoute } from '@/hooks/useHashRouter';
import type { ProofMode } from './types';
import { loadBotSession } from './ai/BotPlayer';

// ── Lazy-loaded sub-flows ──────────────────────────────────────────────────
const CangkulanGame = lazy(() => import('./CangkulanGame').then(m => ({ default: m.CangkulanGame })));
const MultiplayerFlow = lazy(() => import('./multiplayer/MultiplayerFlow').then(m => ({ default: m.MultiplayerFlow })));
const AIGameFlow = lazy(() => import('./ai/AIGameFlow').then(m => ({ default: m.AIGameFlow })));
const DevTestingPage = lazy(() => import('./dev/DevTestingPage').then(m => ({ default: m.DevTestingPage })));

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

// ═══════════════════════════════════════════════════════════════════════════════
//  Game Mode Type
// ═══════════════════════════════════════════════════════════════════════════════

export type GameMode = 'multiplayer' | 'ai' | 'dev' | null;

// ═══════════════════════════════════════════════════════════════════════════════
//  Room context from URL query params (?room=ABC&code=XY7K)
// ═══════════════════════════════════════════════════════════════════════════════

function parseRoomFromURL(): { roomId?: string; inviteCode?: string } {
  try {
    const params = new URLSearchParams(window.location.search);
    return {
      roomId: params.get('room') || undefined,
      inviteCode: params.get('code') || undefined,
    };
  } catch { return {}; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Mode Selector — 3 cards to pick game mode
// ═══════════════════════════════════════════════════════════════════════════════

interface ModeSelectorProps {
  onSelect: (mode: GameMode) => void;
  isDevMode: boolean;
}

function ModeSelector({ onSelect, isDevMode }: ModeSelectorProps) {
  return (
    <div className="space-y-6">
      {/* Title */}
      <div className="text-center">
        <h1 className="text-3xl font-bold gradient-text mb-2">Choose Game Mode</h1>
        <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
          Select how you want to play Cangkulan
        </p>
      </div>

      {/* Mode Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Multiplayer */}
        <button
          onClick={() => onSelect('multiplayer')}
          className="group relative p-6 rounded-2xl border-2 border-transparent bg-gradient-to-br from-emerald-500/10 to-teal-500/10 hover:border-emerald-500 hover:shadow-xl hover:shadow-emerald-500/20 transition-all duration-300 text-left"
        >
          <div className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500 text-white">
            ONLINE
          </div>
          <div className="text-4xl mb-3">🎮</div>
          <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--color-ink)' }}>Multiplayer</h2>
          <p className="text-sm mb-3" style={{ color: 'var(--color-ink-muted)' }}>
            Create or join a room — play against real opponents on Stellar testnet.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700">
              Create Room
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700">
              Join Room
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700">
              Quick Match
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700">
              Public / Private
            </span>
          </div>
        </button>

        {/* vs AI */}
        <button
          onClick={() => onSelect('ai')}
          className="group relative p-6 rounded-2xl border-2 border-transparent bg-gradient-to-br from-violet-500/10 to-purple-500/10 hover:border-violet-500 hover:shadow-xl hover:shadow-violet-500/20 transition-all duration-300 text-left"
        >
          <div className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-500 text-white">
            OFFLINE
          </div>
          <div className="text-4xl mb-3">🤖</div>
          <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--color-ink)' }}>vs AI</h2>
          <p className="text-sm mb-3" style={{ color: 'var(--color-ink-muted)' }}>
            Practice against a bot — choose difficulty level. All moves still verified on-chain.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-100 text-violet-700">
              Easy
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-100 text-violet-700">
              Medium
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-100 text-violet-700">
              Hard
            </span>
          </div>
        </button>

        {/* Dev Testing - only visible in dev mode */}
        {isDevMode && (
          <button
            onClick={() => onSelect('dev')}
            className="group relative p-6 rounded-2xl border-2 border-transparent bg-gradient-to-br from-amber-500/10 to-orange-500/10 hover:border-amber-500 hover:shadow-xl hover:shadow-amber-500/20 transition-all duration-300 text-left"
          >
            <div className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white">
              DEV
            </div>
            <div className="text-4xl mb-3">🔧</div>
            <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--color-ink)' }}>Dev Testing</h2>
            <p className="text-sm mb-3" style={{ color: 'var(--color-ink-muted)' }}>
              Test ZK proof modes, auto-play games, inspect contract state.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">
                ZK Modes
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">
                Auto-Play
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">
                Inspector
              </span>
            </div>
          </button>
        )}
      </div>

      {/* Load existing game */}
      <div className="text-center">
        <button
          onClick={() => onSelect('multiplayer')}
          className="text-sm underline opacity-60 hover:opacity-100 transition-opacity"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          Have a session ID or invite link? Join via Multiplayer →
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GameModePage — controls which sub-flow to render
// ═══════════════════════════════════════════════════════════════════════════════

interface GameModePageProps {
  userAddress: string;
  navigate: (route: AppRoute) => void;
  initialSessionId?: number;
}

export function GameModePage({ userAddress, navigate, initialSessionId }: GameModePageProps) {
  const { walletType } = useWallet();
  const isDevMode = walletType === 'dev';

  // If we have an initial session ID, go straight to multiplayer (resume game)
  // If we have a persisted bot session, resume AI mode
  const [mode, setMode] = useState<GameMode>(() => {
    // Check for active bot session first (takes priority)
    const botSession = loadBotSession();
    if (botSession) return 'ai';
    if (initialSessionId) return 'multiplayer';
    // Check URL for room invite
    const { roomId } = parseRoomFromURL();
    if (roomId) return 'multiplayer';
    return null;
  });

  // Back handler
  const handleBack = () => setMode(null);

  // If no mode selected, show selector
  if (mode === null) {
    return <ModeSelector onSelect={setMode} isDevMode={isDevMode} />;
  }

  // Render selected mode
  return (
    <Suspense fallback={<PageLoader />}>
      {mode === 'multiplayer' && (
        <MultiplayerFlow
          userAddress={userAddress}
          navigate={navigate}
          initialSessionId={initialSessionId}
          onBack={handleBack}
        />
      )}
      {mode === 'ai' && (
        <AIGameFlow
          userAddress={userAddress}
          navigate={navigate}
          onBack={handleBack}
          initialSessionId={initialSessionId}
        />
      )}
      {mode === 'dev' && (
        <DevTestingPage
          userAddress={userAddress}
          navigate={navigate}
          onBack={handleBack}
        />
      )}
    </Suspense>
  );
}
