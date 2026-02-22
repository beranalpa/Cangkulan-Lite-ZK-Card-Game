import type { AppRoute } from '@/hooks/useHashRouter';
import { PageHero } from '@/components/PageHero';

/* ═══════════════════════════════════════════════════════════════════════════════
   Demo Showcase — Feature highlights for judges / reviewers
   
   Designed to be shown during a hackathon demo to quickly communicate
   the technical depth of the project without having to play a full game.
   ═══════════════════════════════════════════════════════════════════════════════ */

interface FeatureCard {
  icon: string;
  title: string;
  subtitle: string;
  details: string[];
  tag: string;
  tagColor: string;
}

const FEATURES: FeatureCard[] = [
  {
    icon: '🔐',
    title: '8-Mode ZK Verification System',
    subtitle: 'Players prove seed knowledge and card play compliance without revealing secrets',
    details: [
      '8 ZK verifier modes (card, NIZK, legacy, Pedersen+Sigma, Groth16 BLS12-381, Groth16 BN254, Ring Sigma, Cangkul Hand)',
      'NIZK Hash (AI default) — keccak256 Schnorr proof (64 B), lightest on-chain mode',
      'Pedersen+Sigma (multiplayer default) — BLS12-381 EC commitment with Schnorr sigma proof (224 B), verified on-chain instantly',
      'Noir UltraKeccakHonk — blake2s preimage + in-circuit entropy check, browser-generated ~14 KB SNARK proof. Split-TX verified on local node with unlimited CPU budget. Full on-chain ZK verification works!',
      'Ring Sigma (Mode 7) — ZK proof that played card is in the player\'s hand without revealing which card',
      'Cangkul Hand Proof (Mode 8) — aggregate Pedersen + suit exclusion proves player must draw (228 B)',
      'Auto-detection by proof byte size — contract routes to correct verifier automatically',
    ],
    tag: 'Zero Knowledge',
    tagColor: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/20',
  },
  {
    icon: '🎴',
    title: 'Commit-Reveal Card Protocol',
    subtitle: 'Every card play is cryptographically committed before reveal',
    details: [
      'Commit phase: player submits keccak256(card_id || salt) — opponent cannot see the card',
      'Both players commit simultaneously — prevents "peek and copy" strategy',
      'Reveal phase: contract verifies hash matches, then resolves the trick',
      'Salt stored client-side only — never leaves the browser until reveal',
    ],
    tag: 'Fairness',
    tagColor: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
  },
  {
    icon: '🎲',
    title: 'Deterministic Fair Shuffle',
    subtitle: 'Neither player can control the deck order',
    details: [
      'Each player commits a random seed (with ZK proof of knowledge)',
      'Seeds revealed and combined via keccak256(seed1 ⊕ seed2)',
      'Combined seed drives Fisher-Yates shuffle — deterministic and reproducible',
      'Anyone can verify the shuffle using the "Verify Shuffle" button after the game',
    ],
    tag: 'Provably Fair',
    tagColor: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/20',
  },
  {
    icon: '⏰',
    title: 'On-chain Timeout Mechanism',
    subtitle: 'Anti-griefing — AFK players auto-lose',
    details: [
      'Deadline tracked by ledger sequence number (60s equivalent)',
      'Nonce-based tick system prevents premature timeout claims',
      'Auto-fire: when timer expires, resolution triggers automatically',
      'Works across seed phase and playing phase — no stuck games',
    ],
    tag: 'Anti-grief',
    tagColor: 'bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/20',
  },
  {
    icon: '🏆',
    title: 'ELO Leaderboard from Events',
    subtitle: 'Rankings computed client-side from on-chain events — no indexer needed',
    details: [
      'Fetches EvGameStarted & EvGameEnded events directly from Soroban RPC',
      'Standard ELO algorithm (K=32 new, K=16 established)',
      'Tier system: Novice → Beginner → Intermediate → Expert → Grandmaster',
      'Win streaks, search, sort — all derived from contract event emissions',
    ],
    tag: 'On-chain Data',
    tagColor: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 border-yellow-500/20',
  },
  {
    icon: '🎮',
    title: 'Game Hub Integration',
    subtitle: 'Multi-game platform with shared lifecycle',
    details: [
      'Game Hub contract manages start_game() and end_game() lifecycle',
      'Points staking: both players commit points at game start',
      'Cangkulan is the flagship game in the Stellar Game Studio',
      'Any new game can plug into the same hub — shared rankings and identity',
    ],
    tag: 'Platform',
    tagColor: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20',
  },
  {
    icon: '🤖',
    title: 'Smart Auto-play',
    subtitle: 'Reduces unnecessary clicks without removing player agency',
    details: [
      'Auto-reveal: once both commit, reveals trigger automatically (no extra click)',
      'Auto-commit: 0 matching cards → auto can\'t-follow, 1 matching → auto-play',
      '2+ matching cards → player chooses (meaningful decision preserved)',
      'Visual feedback: "🤖 Auto-playing ♠3..." flash before auto-commit',
    ],
    tag: 'UX Polish',
    tagColor: 'bg-teal-500/10 text-teal-700 dark:text-teal-300 border-teal-500/20',
  },
  {
    icon: '👁️',
    title: 'Spectator Mode & Lobby',
    subtitle: 'Watch games live and discover active sessions',
    details: [
      'Shareable spectator link — anyone can watch any game in real-time',
      'Game Lobby polls on-chain events to discover live games',
      'WebSocket lobby for real-time matchmaking (optional)',
      'No backend required — all state from Soroban RPC',
    ],
    tag: 'Social',
    tagColor: 'bg-pink-500/10 text-pink-700 dark:text-pink-300 border-pink-500/20',
  },
];

const DEMO_STEPS = [
  { step: 1, action: 'Open 2 browser tabs, connect as Player 1 and Player 2', tip: 'Use Dev Wallet switch in Settings' },
  { step: 2, action: 'Create a game from Player 1 → share invite link to Player 2', tip: 'Quick Start auto-joins both players' },
  { step: 3, action: 'Both players commit seeds — multiplayer uses Pedersen (224 B)', tip: '🌟 WOW moment: EC commitment verified on-chain instantly' },
  { step: 4, action: 'Watch auto-reveal → deck shuffled → cards dealt', tip: 'Deal animation shows the transition' },
  { step: 5, action: 'Play 2-3 tricks — show commit-reveal flow', tip: 'Auto-play fires for forced moves' },
  { step: 6, action: 'Click "Verify Shuffle" to prove deck fairness', tip: 'Shows combined seed → full deck order' },
  { step: 7, action: 'Show Leaderboard — ELO computed from on-chain events', tip: 'No off-chain indexer needed' },
  { step: 8, action: 'Show Dev Testing → try Noir local proof (~14 KB SNARK)', tip: 'Full on-chain verification using Split-TX flow with unlimited CPU' },
];

export function DemoShowcasePage({ navigate }: { navigate: (route: AppRoute) => void }) {
  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Hero Header */}
      <PageHero
        icon="✨"
        title="Cangkulan — Feature Showcase"
        subtitle="A fully on-chain card game with dual ZK proofs, commit-reveal protocol, and provably fair shuffle"
        gradient="from-violet-600 via-purple-600 to-indigo-700"
        navigate={navigate}
        backTo={{ page: 'home' }}
      />

      {/* Tech Stack Pills */}
      <div className="flex flex-wrap justify-center gap-2">
        {['Soroban Smart Contracts', 'Noir ZK Proofs', 'Pedersen Commitments', 'React + TypeScript', 'Stellar Network', 'Commit-Reveal Protocol'].map(tech => (
          <span key={tech} className="px-3 py-1 text-xs font-semibold rounded-full" style={{ background: 'var(--color-surface)', color: 'var(--color-ink-muted)', border: '1px solid var(--color-border)' }}>
            {tech}
          </span>
        ))}
      </div>

      {/* Demo Walkthrough */}
      <div className="rounded-2xl p-6 bg-gradient-to-br from-amber-500/10 to-orange-500/10" style={{ border: '2px solid var(--color-border)' }}>
        <h2 className="text-lg font-bold mb-4 text-amber-700 dark:text-amber-300">🎬 Demo Walkthrough (5 minutes)</h2>
        <div className="space-y-3">
          {DEMO_STEPS.map(({ step, action, tip }) => (
            <div key={step} className="flex gap-3 items-start">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-amber-500 text-white text-sm font-bold flex items-center justify-center">
                {step}
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>{action}</p>
                <p className="text-xs mt-0.5 text-amber-700 dark:text-amber-300">💡 {tip}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Feature Cards */}
      <div className="space-y-4">
        <h2 className="text-lg font-bold text-center" style={{ color: 'var(--color-ink)' }}>🔧 Technical Features</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{feature.icon}</span>
                  <div>
                    <h3 className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>{feature.title}</h3>
                    <p className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>{feature.subtitle}</p>
                  </div>
                </div>
                <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${feature.tagColor}`}>
                  {feature.tag}
                </span>
              </div>
              <ul className="space-y-1.5">
                {feature.details.map((detail, i) => (
                  <li key={i} className="text-xs flex gap-2" style={{ color: 'var(--color-ink-muted)' }}>
                    <span className="text-emerald-500 font-bold mt-0.5">•</span>
                    <span>{detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { page: 'game' as const, icon: '🎮', label: 'Play Game', gradient: 'from-emerald-500/10 to-teal-500/10', color: 'text-emerald-700 dark:text-emerald-300' },
          { page: 'leaderboard' as const, icon: '🏆', label: 'Leaderboard', gradient: 'from-yellow-500/10 to-amber-500/10', color: 'text-yellow-700 dark:text-yellow-300' },
          { page: 'architecture' as const, icon: '📐', label: 'Architecture', gradient: 'from-indigo-500/10 to-violet-500/10', color: 'text-indigo-700 dark:text-indigo-300' },
          { page: 'tutorial' as const, icon: '🎓', label: 'Tutorial', gradient: 'from-amber-500/10 to-orange-500/10', color: 'text-amber-700 dark:text-amber-300' },
        ].map(link => (
          <button key={link.page} onClick={() => navigate({ page: link.page })}
            className={`p-3 rounded-xl bg-gradient-to-br ${link.gradient} text-center hover:scale-[1.02] active:scale-[0.98] transition-all`}
            style={{ border: '1px solid var(--color-border)' }}>
            <div className="text-xl mb-1">{link.icon}</div>
            <div className={`text-xs font-bold ${link.color}`}>{link.label}</div>
          </button>
        ))}
      </div>

      {/* Contract Info */}
      <div className="rounded-xl p-4 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <p className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          Smart contracts: <strong>Cangkulan Game</strong> • <strong>Game Hub</strong> • <strong>Leaderboard</strong> • <strong>ZK Verifier (Pedersen)</strong> • <strong>ZK Verifier (UltraHonk)</strong>
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)', opacity: 0.7 }}>
          All game logic runs on-chain. Frontend is a pure client — no backend server.
        </p>
      </div>
    </div>
  );
}

export default DemoShowcasePage;
