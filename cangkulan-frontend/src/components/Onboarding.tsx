import { useState } from 'react';
import { CANGKULAN_CONTRACT, ZK_VERIFIER_CONTRACT, GAME_HUB_CONTRACT, STELLAR_EXPERT_BASE, getContractId } from '@/utils/constants';
import { useIntl } from 'react-intl';

const STORAGE_KEY = 'cangkulan-onboarding-done';

const STELLAR_EXPERT = STELLAR_EXPERT_BASE;

// ═══════════════════════════════════════════════════════════════════════════════
//  Helper — themed inline-style objects for slide content
// ═══════════════════════════════════════════════════════════════════════════════

/** Tinted card used inside slides (replaces hard-coded bg-gray-50, bg-blue-50, etc.) */
const tintCard = (accent: string): React.CSSProperties => ({
  background: `color-mix(in srgb, ${accent} 10%, var(--color-surface))`,
  border: `1px solid color-mix(in srgb, ${accent} 25%, var(--color-border))`,
  borderRadius: 12,
  padding: '0.75rem',
});

const tintBadge = (accent: string): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0.125rem 0.5rem',
  borderRadius: 9999,
  fontSize: 10,
  fontWeight: 700,
  background: `color-mix(in srgb, ${accent} 15%, var(--color-surface))`,
  color: accent,
});

const tintStep = (accent: string): React.CSSProperties => ({
  background: `color-mix(in srgb, ${accent} 15%, var(--color-surface))`,
  color: accent,
  borderRadius: 9999,
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 11,
  fontWeight: 700,
  flexShrink: 0,
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Slide Data
// ═══════════════════════════════════════════════════════════════════════════════

interface Slide {
  title: string;
  icon: string;
  content: React.ReactNode;
}

const slides: Slide[] = [
  {
    title: 'Welcome to Cangkulan Lite',
    icon: '🃏',
    content: (
      <div className="space-y-3">
        <div className="flex justify-center">
          <img src="/cangkulan-logo.png" alt="Cangkulan Lite" className="rounded-xl shadow-md" style={{ width: 72, height: 72, objectFit: 'cover' }} />
        </div>
        <p>
          <strong>Cangkulan</strong> is a traditional Indonesian trick-taking card game — now on
          Stellar blockchain with provably fair ZK shuffling.
        </p>
        <p>Two players compete to <strong>empty their hand first</strong>.</p>
        <div className="flex justify-center gap-3 text-3xl pt-2">
          <span>♠</span><span className="text-red-500">♥</span>
          <span className="text-red-500">♦</span><span>♣</span>
        </div>
      </div>
    ),
  },
  {
    title: 'How to Play',
    icon: '📖',
    content: (
      <div className="space-y-2 text-left">
        <div className="flex items-start gap-2">
          <span className="font-bold shrink-0" style={{ color: '#d97706' }}>1.</span>
          <span>A card is flipped from the <strong>draw pile</strong> — its suit is the <strong>trick suit</strong>.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="font-bold shrink-0" style={{ color: '#d97706' }}>2.</span>
          <span>If you have a matching suit, <strong>play one</strong>. Highest value wins the trick.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="font-bold shrink-0" style={{ color: '#d97706' }}>3.</span>
          <span>If you don't have the suit, press <strong>"Cangkul"</strong> — you draw a penalty card.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="font-bold shrink-0" style={{ color: '#d97706' }}>4.</span>
          <span><strong>First to empty their hand wins!</strong> If the pile runs out, fewest cards wins.</span>
        </div>
      </div>
    ),
  },
  {
    title: 'ZK Fair Shuffle',
    icon: '🔐',
    content: (
      <div className="space-y-3">
        <p>The deck is shuffled <strong>on-chain</strong> using zero-knowledge cryptography:</p>
        <div className="rounded-xl p-3 space-y-2 text-sm" style={tintCard('#3b82f6')}>
          <div className="flex items-center gap-2">
            <span style={tintStep('#3b82f6')}>1</span>
            <span><strong>Commit</strong> — Both players submit a secret seed hash</span>
          </div>
          <div className="flex items-center gap-2">
            <span style={tintStep('#3b82f6')}>2</span>
            <span><strong>Verify</strong> — ZK proof validated on-chain (auto-detected mode)</span>
          </div>
          <div className="flex items-center gap-2">
            <span style={tintStep('#3b82f6')}>3</span>
            <span><strong>Shuffle</strong> — Combined seeds produce a deterministic deck</span>
          </div>
        </div>
        <div className="flex gap-2 mt-1 flex-wrap">
          <span style={tintBadge('#0891b2')}>#️⃣ NIZK (lightest)</span>
          <span style={tintBadge('#2563eb')}>🔐 Pedersen (default)</span>
          <span style={tintBadge('#7c3aed')}>🌑 Noir (SNARK)</span>
        </div>
        <p className="text-xs italic text-center" style={{ color: 'var(--color-ink-muted)' }}>
          Choose your proof mode before committing. Anyone can call <code>verify_shuffle()</code> to audit any game.
        </p>
        <div className="rounded-lg p-2.5 mt-1" style={tintCard('#6366f1')}>
          <p className="text-[10px] font-bold uppercase tracking-wide mb-1.5" style={{ color: '#6366f1' }}>Deployed Contracts (Testnet)</p>
          <div className="space-y-1">
            {[
              { label: 'Cangkulan', id: CANGKULAN_CONTRACT },
              { label: 'ZK Verifier', id: ZK_VERIFIER_CONTRACT },
              { label: 'Game Hub', id: GAME_HUB_CONTRACT },
              { label: 'Leaderboard', id: getContractId('leaderboard') },
            ].filter(c => c.id).map(c => (
              <a key={c.label} href={`${STELLAR_EXPERT}/${c.id}`} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-between gap-1.5 text-[10px] no-underline group"
                style={{ color: '#6366f1' }}>
                <span className="font-semibold shrink-0">{c.label}:</span>
                <span className="font-mono truncate group-hover:underline">{c.id.slice(0, 8)}…{c.id.slice(-6)}</span>
                <span style={{ opacity: 0.6 }} className="shrink-0">↗</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    ),
  },
  {
    title: 'ZK Proof Modes',
    icon: '🔐',
    content: (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>Choose your zero-knowledge proof mode before committing your seed:</p>

        {/* Pedersen */}
        <div className="rounded-xl p-3.5" style={tintCard('#3b82f6')}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-lg">🔐</span>
            <span className="font-bold" style={{ color: 'var(--color-ink)' }}>Pedersen Commitment</span>
            <span className="ml-auto" style={tintBadge('#16a34a')}>Default • On-Chain ✓</span>
          </div>
          <div className="space-y-1 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            <p><strong>Curve:</strong> BLS12-381 (Schnorr/Sigma proof)</p>
            <p><strong>Proof size:</strong> 224 bytes — generated instantly</p>
            <p><strong>How:</strong> C = Fr(seedHash)·G + Fr(blinding)·H → verified on-chain via Sigma protocol</p>
          </div>
        </div>

        {/* Noir */}
        <div className="rounded-xl p-3.5" style={tintCard('#7c3aed')}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-lg">🌑</span>
            <span className="font-bold" style={{ color: 'var(--color-ink)' }}>Noir ZK Circuit</span>
            <span className="ml-auto" style={tintBadge('#d97706')}>Local Node Only ⚠️</span>
          </div>
          <div className="space-y-1 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            <p><strong>Prover:</strong> UltraKeccakHonk via @aztec/bb.js</p>
            <p><strong>Proof size:</strong> ~14 KB — generated in-browser (~10–30s)</p>
            <p><strong>Circuit:</strong> blake2s(seed) == hash AND seed[0..4] != 0x00 (in-circuit entropy)</p>
            <p><strong>Status:</strong> Proof generation works ✓; split-TX verified fully on local node. UltraHonk exceeds Soroban's public Testnet per-TX CPU limit (~215M vs ~100M). Requires Local Node with unlimited CPU.</p>
          </div>
        </div>

        {/* Summary */}
        <p className="text-[10px] italic text-center mt-1" style={{ color: 'var(--color-ink-muted)' }}>
          Pedersen and NIZK proofs are fully verified on-chain today on public Testnet. Noir proofs are verified on Local Node, as UltraHonk verification exceeds the public Testnet per-TX CPU limit.
        </p>
      </div>
    ),
  },
  {
    title: 'Built-in Protections',
    icon: '🛡️',
    content: (
      <div className="space-y-2 text-left">
        <div className="flex items-start gap-2">
          <span className="text-lg shrink-0">🎲</span>
          <span><strong>Entropy Check</strong> — Seeds with low randomness are rejected to prevent manipulation.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-lg shrink-0">🔢</span>
          <span><strong>Session Nonce</strong> — Every action has a sequence number, preventing replayed or stale moves.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-lg shrink-0">⏱️</span>
          <span><strong>Auto Timeout</strong> — If your opponent stalls, you can claim the win after ~10 minutes.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-lg shrink-0">📋</span>
          <span><strong>On-Chain Events</strong> — Every game action is logged, making all games fully auditable.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-lg shrink-0">📜</span>
          <span><strong>Game History</strong> — Your last 50 games are stored on-chain with W/L/D, tricks, and opponent — persisted for 120 days.</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-lg shrink-0">🏆</span>
          <span><strong>ELO Leaderboard</strong> — On-chain ELO ratings with tier badges (Grandmaster → Novice), win streaks, and rankings.</span>
        </div>
      </div>
    ),
  },
  {
    title: 'Multiplayer & Rankings',
    icon: '🏆',
    content: (
      <div className="space-y-3">
        <p>Play with friends or find opponents in real-time:</p>
        <div className="space-y-2 text-sm text-left">
          <div className="flex items-start gap-2">
            <span className="text-lg shrink-0">🌐</span>
            <span><strong>Live Lobby</strong> — See online players, send game invites, and chat in real-time via WebSocket.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-lg shrink-0">🎯</span>
            <span><strong>Matchmaking</strong> — Press "Find Match" to queue up and be paired with a random opponent automatically.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-lg shrink-0">🏅</span>
            <span><strong>ELO Rankings</strong> — On-chain leaderboard tracks your ELO rating, win streaks, and tier (Grandmaster → Novice).</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-lg shrink-0">🌍</span>
            <span><strong>Multi-Language</strong> — Switch between English and Bahasa Indonesia in Settings.</span>
          </div>
        </div>
        <div className="rounded-lg p-2 text-xs mt-2" style={tintCard('#059669')}>
          📱 <strong>Install as App:</strong> Cangkulan is a PWA — add to your home screen for an app-like experience with offline support!
        </div>
      </div>
    ),
  },
  {
    title: 'Game Setup',
    icon: '🚀',
    content: (
      <div className="space-y-3">
        <p>To start a game:</p>
        <div className="space-y-2 text-sm">
          <div className="flex items-start gap-2">
            <span className="text-lg">🔗</span>
            <span>Connect your <strong>Stellar wallet</strong> (Freighter, HOT Wallet, Hana, Klever) or use <strong>Dev Mode</strong></span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-lg">👤</span>
            <span><strong>Player 1</strong> creates the game and shares an invite link</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-lg">👥</span>
            <span><strong>Player 2</strong> opens the link and joins the session</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-lg">🔑</span>
            <span>Both commit & reveal seeds → deck is shuffled → <strong>game begins!</strong></span>
          </div>
        </div>
        <div className="rounded-lg p-2 text-xs mt-3" style={tintCard('#2563eb')}>
          🌐 <strong>Public Play:</strong> Connect any Stellar wallet to play with your own account. Invite friends by sharing the game link!
        </div>
        <div className="rounded-lg p-2 text-xs" style={tintCard('#d97706')}>
          💡 <strong>Dev Mode:</strong> Uses pre-funded test wallets — great for trying out the game locally.
        </div>
      </div>
    ),
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  Onboarding Component
// ═══════════════════════════════════════════════════════════════════════════════

export function useOnboarding() {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
  };

  const reset = () => {
    localStorage.removeItem(STORAGE_KEY);
    setDismissed(false);
  };

  return { showOnboarding: !dismissed, dismiss, reset };
}

export function OnboardingModal({ onDismiss }: { onDismiss: () => void }) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const slide = slides[currentSlide];
  const isLast = currentSlide === slides.length - 1;
  const isFirst = currentSlide === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div
        className="rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          animation: 'onboarding-pop 0.3s ease-out',
        }}
      >
        {/* Header */}
        <div
          className="px-6 pt-6 pb-4 text-center"
          style={{
            background: 'linear-gradient(135deg, color-mix(in srgb, #f59e0b 12%, var(--color-surface)), color-mix(in srgb, #3b82f6 12%, var(--color-surface)))',
          }}
        >
          <span className="text-4xl block mb-2">{slide.icon}</span>
          <h2
            className="text-xl font-bold"
            style={{ fontFamily: 'var(--font-serif)', color: 'var(--color-ink)' }}
          >
            {slide.title}
          </h2>
        </div>

        {/* Body */}
        <div
          className="px-6 py-5 text-sm leading-relaxed min-h-[200px]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {slide.content}
        </div>

        {/* Progress dots */}
        <div className="flex justify-center gap-2 pb-3">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentSlide(i)}
              className="rounded-full transition-all duration-200 border-0 p-0 shadow-none"
              style={{
                width: i === currentSlide ? '1.5rem' : '0.5rem',
                height: '0.5rem',
                minWidth: i === currentSlide ? '1.5rem' : '0.5rem',
                background: i === currentSlide
                  ? '#f59e0b'
                  : 'var(--color-border)',
              }}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex items-center justify-between gap-3">
          {isFirst ? (
            <button
              onClick={onDismiss}
              className="text-xs px-4 py-2 font-semibold transition-all hover:scale-105 active:scale-95"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border)',
                color: 'var(--color-ink-muted)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Skip
            </button>
          ) : (
            <button
              onClick={() => setCurrentSlide(currentSlide - 1)}
              className="text-xs px-4 py-2 font-semibold transition-all hover:scale-105 active:scale-95"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border)',
                color: 'var(--color-ink-muted)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              ← Back
            </button>
          )}

          {isLast ? (
            <button
              onClick={onDismiss}
              className="text-sm px-6 py-2 font-bold transition-all hover:scale-105 active:scale-95"
              style={{
                background: 'var(--color-accent)',
                color: '#0f0f0f',
                border: '1px solid var(--color-ink)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Let's Play! 🎮
            </button>
          ) : (
            <button
              onClick={() => setCurrentSlide(currentSlide + 1)}
              className="text-sm px-6 py-2 font-bold transition-all hover:scale-105 active:scale-95"
              style={{
                background: 'var(--color-accent)',
                color: '#0f0f0f',
                border: '1px solid var(--color-ink)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Next →
            </button>
          )}
        </div>
      </div>

      {/* Animation keyframe */}
      <style>{`
        @keyframes onboarding-pop {
          from { opacity: 0; transform: scale(0.95) translateY(10px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
