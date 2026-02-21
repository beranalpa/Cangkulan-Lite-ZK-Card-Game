import { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import type { AppRoute } from '@/hooks/useHashRouter';
import { BotPlayer, type BotDifficulty, saveBotSession, loadBotSession, clearBotSession } from './BotPlayer';

const CangkulanGame = lazy(() => import('../CangkulanGame').then(m => ({ default: m.CangkulanGame })));

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AI Setup — difficulty picker before game starts
// ═══════════════════════════════════════════════════════════════════════════════

interface AISetupProps {
  onStart: (bot: BotPlayer) => void;
  isLoading: boolean;
  onBack: () => void;
}

function AISetup({ onStart, isLoading, onBack }: AISetupProps) {
  const [difficulty, setDifficulty] = useState<BotDifficulty>('easy');

  const handleStart = async () => {
    const bot = new BotPlayer(difficulty);
    onStart(bot);
  };

  const difficulties: { level: BotDifficulty; icon: string; label: string; desc: string }[] = [
    { level: 'easy', icon: '😊', label: 'Easy', desc: 'Random valid moves — good for learning the rules' },
    { level: 'medium', icon: '🧠', label: 'Medium', desc: 'Basic strategy — follows suit smartly, saves good cards' },
    { level: 'hard', icon: '💀', label: 'Hard', desc: 'Card counting — tracks played cards, tries to force draws' },
  ];

  return (
    <div className="space-y-6">
      <button
        onClick={onBack}
        className="text-sm font-medium hover:underline"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        ← Back to Mode Select
      </button>

      <div className="text-center">
        <h2 className="text-2xl font-bold gradient-text">🤖 vs AI</h2>
        <p className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>
          Choose bot difficulty — all moves verified on Stellar testnet
        </p>
      </div>

      {/* Difficulty Cards */}
      <div className="space-y-3">
        {difficulties.map(d => (
          <button
            key={d.level}
            onClick={() => setDifficulty(d.level)}
            className={`w-full p-4 rounded-xl border-2 text-left transition-all ${
              difficulty === d.level
                ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20 shadow-lg'
                : 'border-transparent bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700/50'
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="text-3xl">{d.icon}</span>
              <div>
                <div className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>{d.label}</div>
                <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>{d.desc}</div>
              </div>
              {difficulty === d.level && (
                <span className="ml-auto text-violet-500 text-lg">✓</span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Info Box */}
      <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
        <p className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          <strong>ℹ️ How it works:</strong> The bot is a real Stellar wallet — it signs transactions
          and plays on-chain just like a human opponent. ZK proofs are generated and verified on Soroban.
          This is a free practice game (no XLM bet).
        </p>
      </div>

      {/* Start Button */}
      <button
        onClick={handleStart}
        disabled={isLoading}
        className="w-full py-3.5 rounded-xl text-white font-bold text-sm bg-gradient-to-r from-violet-500 to-purple-600 hover:shadow-xl hover:scale-[1.02] transition-all disabled:opacity-50"
      >
        {isLoading ? '⏳ Setting up bot...' : `🚀 Start Game vs ${difficulties.find(d => d.level === difficulty)?.icon} ${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} Bot`}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AIGameFlow — manages bot + game lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

interface AIGameFlowProps {
  userAddress: string;
  navigate: (route: AppRoute) => void;
  onBack: () => void;
  initialSessionId?: number;
}

export function AIGameFlow({ userAddress, navigate, onBack, initialSessionId: urlSessionId }: AIGameFlowProps) {
  const [bot, setBot] = useState<BotPlayer | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [phase, setPhase] = useState<'setup' | 'playing'>('setup');
  const [recoveredSessionId, setRecoveredSessionId] = useState<number | undefined>(undefined);

  const [setupError, setSetupError] = useState<string | null>(null);

  // ─── Recover bot session from sessionStorage on mount ──────────────────
  useEffect(() => {
    const saved = loadBotSession();
    if (saved) {
      try {
        const recovered = BotPlayer.fromSecret(saved.secret, saved.difficulty);
        setBot(recovered);
        // Use saved sessionId, or fall back to URL sessionId
        setRecoveredSessionId(saved.sessionId || urlSessionId);
        setPhase('playing');
      } catch (err) {
        console.warn('[AIGameFlow] Failed to recover bot session:', err);
        clearBotSession();
      }
    } else if (urlSessionId) {
      // URL has a session ID but no bot session — we can't reconstruct the bot.
      // Clear the URL so we don't get stuck in a broken state.
      console.warn('[AIGameFlow] URL has sessionId but no bot session — cannot recover bot keypair');
    }
  }, []);

  const handleStartBot = useCallback(async (newBot: BotPlayer) => {
    setIsSettingUp(true);
    setSetupError(null);
    try {
      // Fund bot via Friendbot
      await newBot.fund();
      setBot(newBot);
      setPhase('playing');
      // Persistence happens after game creation in CangkulanGame (we need the sessionId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Bot setup failed:', err);
      setSetupError(`Bot setup failed: ${message}. Friendbot may be rate-limited — try again in a few seconds.`);
    } finally {
      setIsSettingUp(false);
    }
  }, []);

  const handleGameComplete = useCallback(() => {
    clearBotSession();
    setBot(null);
    setPhase('setup');
    setRecoveredSessionId(undefined);
  }, []);

  if (phase === 'setup' || !bot) {
    return (
      <>
        <AISetup
          onStart={handleStartBot}
          isLoading={isSettingUp}
          onBack={onBack}
        />
        {setupError && (
          <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {setupError}
          </div>
        )}
      </>
    );
  }

  return (
    <div>
      {/* Bot Info Banner */}
      <div className="mb-3 flex items-center justify-between p-2.5 rounded-xl bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800">
        <div className="flex items-center gap-2">
          <span className="text-lg">{bot.displayName.split(' ')[0]}</span>
          <div>
            <span className="text-xs font-bold" style={{ color: 'var(--color-ink)' }}>
              {bot.displayName}
            </span>
            <span className="text-[10px] ml-1.5 font-mono" style={{ color: 'var(--color-ink-muted)' }}>
              {bot.address.slice(0, 6)}...{bot.address.slice(-4)}
            </span>
          </div>
        </div>
        <button
          onClick={() => { clearBotSession(); setBot(null); setPhase('setup'); setRecoveredSessionId(undefined); }}
          className="text-xs text-violet-500 hover:underline"
        >
          Change Bot
        </button>
      </div>

      {/* Game — the bot address will be used as Player 2 via the CreatePhase quickstart-like flow */}
      <Suspense fallback={<PageLoader />}>
        <CangkulanGame
          userAddress={userAddress}
          availablePoints={1000000000n}
          onStandingsRefresh={() => {}}
          onGameComplete={handleGameComplete}
          navigate={navigate}
          botPlayer={bot}
          initialSessionId={recoveredSessionId}
          gameMode="ai"
        />
      </Suspense>
    </div>
  );
}
