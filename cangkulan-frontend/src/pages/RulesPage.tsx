import { useIntl } from 'react-intl';
import type { AppRoute } from '@/hooks/useHashRouter';
import { getActiveCangkulanContract, getActiveZkVerifierContract, getActiveUltrahonkVerifierContract, getActiveGameHubContract, getActiveLeaderboardContract, getStellarExpertLink } from '@/utils/constants';
import { PageHero } from '@/components/PageHero';

// ═══════════════════════════════════════════════════════════════════════════════
//  Rules Page — comprehensive game rules, ZK mechanics, and on-chain details
// ═══════════════════════════════════════════════════════════════════════════════

interface RulesPageProps {
  navigate: (route: AppRoute) => void;
}

const truncAddr = (id: string) =>
  id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;

export function RulesPage({ navigate }: RulesPageProps) {
  const { formatMessage: t } = useIntl();

  return (
    <div className="space-y-8 max-w-3xl mx-auto pb-4">

      {/* ─── Hero Header ──────────────────────────────────────────── */}
      <PageHero
        icon="📖"
        title={t({ id: 'rules.title' })}
        subtitle={t({ id: 'rules.subtitle' })}
        gradient="from-emerald-600 via-teal-600 to-cyan-700"
        navigate={navigate}
        backTo={{ page: 'home' }}
      />

      {/* ─── Overview ─────────────────────────────────────────────── */}
      <section className="p-5 rounded-2xl shadow-sm bg-gradient-to-br from-emerald-500/10 via-teal-500/10 to-cyan-500/10" style={{ border: '1px solid var(--color-border)' }}>
        <h3 className="text-sm font-bold mb-2 tracking-wide uppercase text-emerald-600 dark:text-emerald-400">
          🃏 {t({ id: 'rules.overview.heading' })}
        </h3>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--color-ink)' }}>
          {t({ id: 'rules.overview.text' })}
        </p>
      </section>

      {/* ─── Core Rules ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-base font-bold flex items-center gap-2" style={{ color: 'var(--color-ink)' }}>
          <span className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center text-sm">🎴</span>
          {t({ id: 'rules.core.heading' })}
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* The Deck */}
          <div className="p-4 rounded-xl shadow-sm space-y-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-emerald-500/10 flex items-center justify-center text-xs">🌴</span>
              <span className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>{t({ id: 'rules.deck.title' })}</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
              {t({ id: 'rules.deck.text' })}
            </p>
            <div className="p-1.5 rounded-md" style={{ background: 'var(--color-bg)' }}>
              <span className="text-[11px] font-mono" style={{ color: 'var(--color-ink-muted)' }}>
                ♠ 2–10 · <span className="text-red-400">♥ 2–10</span> · <span className="text-red-400">♦ 2–10</span> · ♣ 2–10 = 36
              </span>
            </div>
          </div>

          {/* Setup */}
          <div className="p-4 rounded-xl shadow-sm space-y-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-emerald-500/10 flex items-center justify-center text-xs">🎲</span>
              <span className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>{t({ id: 'rules.setup.title' })}</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
              {t({ id: 'rules.setup.text' })}
            </p>
            <div className="flex gap-1.5 flex-wrap">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/20">#️⃣ NIZK</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/20">🔐 Pedersen</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/20">🌑 Noir</span>
            </div>
          </div>

          {/* Each Trick */}
          <div className="p-4 rounded-xl shadow-sm space-y-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-emerald-500/10 flex items-center justify-center text-xs">🃏</span>
              <span className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>{t({ id: 'rules.trick.title' })}</span>
            </div>
            <ol className="text-xs list-decimal list-inside space-y-0.5 leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
              <li>{t({ id: 'rules.trick.step1' })}</li>
              <li>{t({ id: 'rules.trick.step2' })}</li>
              <li>{t({ id: 'rules.trick.step3' })}</li>
              <li>{t({ id: 'rules.trick.step4' })}</li>
            </ol>
            <p className="text-[10px]" style={{ color: 'var(--color-ink-muted)', opacity: 0.7 }}>
              {t({ id: 'rules.trick.footer' })}
            </p>
          </div>

          {/* Winning a Trick */}
          <div className="p-4 rounded-xl shadow-sm space-y-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-emerald-500/10 flex items-center justify-center text-xs">🏆</span>
              <span className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>{t({ id: 'rules.winning.trick.title' })}</span>
            </div>
            <div className="text-xs space-y-0.5 leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
              <p>• <strong>{t({ id: 'rules.winning.trick.both' })}</strong></p>
              <p>• <strong>{t({ id: 'rules.winning.trick.one' })}</strong></p>
              <p>• <strong>{t({ id: 'rules.winning.trick.neither' })}</strong></p>
            </div>
          </div>

          {/* Win Condition */}
          <div className="p-4 rounded-xl shadow-sm space-y-2 sm:col-span-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-emerald-500/10 flex items-center justify-center text-xs">🎯</span>
              <span className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>{t({ id: 'rules.win.title' })}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {[
                { key: '1', color: 'emerald', num: '1' },
                { key: '2', color: 'blue', num: '2' },
                { key: '3', color: 'amber', num: '3' },
                { key: '4', color: 'gray', num: '4' },
              ].map(({ key, color, num }) => (
                <p key={key} className="flex items-start gap-1.5 text-xs leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
                  <span className={`inline-flex w-5 h-5 rounded-full bg-${color}-500/20 text-${color}-700 dark:text-${color}-300 items-center justify-center text-[9px] font-bold shrink-0 mt-px`}>{num}</span>
                  <span>{t({ id: `rules.win.${key}` })}</span>
                </p>
              ))}
            </div>
          </div>

          {/* Timeouts */}
          <div className="p-4 rounded-xl shadow-sm space-y-2 sm:col-span-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-emerald-500/10 flex items-center justify-center text-xs">⏰</span>
              <span className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>{t({ id: 'rules.timeout.title' })}</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
              {t({ id: 'rules.timeout.text' })}
            </p>
          </div>
        </div>
      </section>

      {/* ─── ZK Proof Modes ───────────────────────────────────────── */}
      <section className="p-5 rounded-2xl shadow-sm space-y-4 bg-gradient-to-br from-violet-500/10 to-purple-500/10" style={{ border: '1px solid var(--color-border)' }}>
        <h3 className="text-sm font-bold tracking-wide uppercase flex items-center gap-2 text-purple-700 dark:text-purple-300">
          <span className="w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center text-sm">🔒</span>
          {t({ id: 'rules.zk.heading' })}
        </h3>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--color-ink)' }}>
          {t({ id: 'rules.zk.intro' })}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* NIZK */}
          <div className="p-4 rounded-xl shadow-sm space-y-2.5" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-cyan-500/10 flex items-center justify-center text-sm">#️⃣</span>
              <span className="text-sm font-bold text-cyan-700 dark:text-cyan-300">{t({ id: 'rules.zk.nizk.title' })}</span>
              <span className="ml-auto inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/20">{t({ id: 'rules.zk.nizk.badge' })}</span>
            </div>
            <div className="text-xs space-y-0.5 leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
              <p><strong>Hash:</strong> keccak256</p>
              <p><strong>Proof:</strong> Schnorr NIZK — 64 B</p>
              <p><strong>Speed:</strong> Instant</p>
              <p><strong>Use:</strong> Lightest on-chain mode, used for AI games</p>
            </div>
          </div>

          {/* Pedersen */}
          <div className="p-4 rounded-xl shadow-sm space-y-2.5" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center text-sm">🔐</span>
              <span className="text-sm font-bold text-blue-700 dark:text-blue-300">{t({ id: 'rules.zk.pedersen.title' })}</span>
              <span className="ml-auto inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-500/10 text-green-700 dark:text-green-300 border border-green-500/20">{t({ id: 'rules.zk.pedersen.badge' })}</span>
            </div>
            <div className="text-xs space-y-0.5 leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
              <p><strong>Curve:</strong> BLS12-381</p>
              <p><strong>Commit:</strong> C = Fr(seedHash)·G + Fr(blind)·H</p>
              <p><strong>Proof:</strong> Schnorr/Sigma — 224 B</p>
              <p><strong>Speed:</strong> Instant</p>
            </div>
          </div>

          {/* Noir */}
          <div className="p-4 rounded-xl shadow-sm space-y-2.5" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center text-sm">🌑</span>
              <span className="text-sm font-bold text-violet-700 dark:text-violet-300">{t({ id: 'rules.zk.noir.title' })}</span>
              <span className="ml-auto inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20">{t({ id: 'rules.zk.noir.badge' })}</span>
            </div>
            <div className="text-xs space-y-0.5 leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
              <p><strong>Circuit:</strong> blake2s(seed) == hash AND seed[0..4] != 0x00</p>
              <p><strong>Prover:</strong> @aztec/bb.js (in-browser)</p>
              <p><strong>Proof:</strong> ~14 KB UltraKeccakHonk</p>
              <p><strong>Speed:</strong> ~10–30 s</p>
              <p className="text-violet-700 dark:text-violet-300"><strong>In-circuit entropy:</strong> Circuit rejects seeds with zero first-4-bytes — valid proof guarantees non-trivial randomness</p>
              <p className="text-emerald-700 dark:text-emerald-300"><strong>Note:</strong> Exceeds public Testnet CPU budget, enabled for <strong>Local Node</strong> only.</p>
            </div>
          </div>
        </div>

        {/* Steps */}
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-purple-700 dark:text-purple-300">How it works</p>
          <ol className="text-xs list-none space-y-1.5 leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
            {[
              <>Each player generates a <strong>secret random seed</strong> (32 bytes) locally</>,
              <>Seed is hashed and committed on-chain (blinding hides the seed)</>,
              <>After both commit, seeds are <strong>revealed with a ZK proof</strong></>,
              <>The ZK Verifier contract validates the proof on-chain</>,
              <>Both seeds are <strong>combined</strong> → deterministic PRNG → Fisher-Yates shuffle</>,
              <>Deck order derives from both players' entropy — <strong>neither controls it</strong></>,
            ].map((txt, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-purple-500/10 text-purple-700 dark:text-purple-300 flex items-center justify-center text-[10px] font-bold shrink-0 mt-px">{i + 1}</span>
                <span>{txt}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="text-[11px] italic leading-relaxed pt-3" style={{ color: 'var(--color-ink-muted)', borderTop: '1px solid var(--color-border)' }}>
          {t({ id: 'rules.zk.footer' })}
        </p>
      </section>

      {/* ─── Card Play Privacy ────────────────────────────────────── */}
      <section className="p-5 rounded-2xl shadow-sm space-y-3 bg-gradient-to-br from-blue-500/10 to-indigo-500/10" style={{ border: '1px solid var(--color-border)' }}>
        <h3 className="text-sm font-bold tracking-wide uppercase flex items-center gap-2 text-blue-700 dark:text-blue-300">
          <span className="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center text-sm">🎭</span>
          {t({ id: 'rules.privacy.heading' })}
        </h3>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--color-ink)' }}>
          {t({ id: 'rules.privacy.intro' })}
        </p>
        <div className="rounded-xl p-4 space-y-2.5 shadow-sm" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          {[
            { label: 'Commit', desc: <>Both choose a card, generate a random salt, submit <code className="text-[10px] px-1 py-px rounded font-mono" style={{ background: 'var(--color-bg)' }}>keccak256(card_id ∥ salt)</code></> },
            { label: 'Reveal', desc: <>Both reveal <code className="text-[10px] px-1 py-px rounded font-mono" style={{ background: 'var(--color-bg)' }}>card_id + salt</code> — contract verifies hash match</> },
            { label: 'Resolve', desc: <>Cards compared, suit rules applied, trick winner determined</> },
          ].map((step, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-blue-500/10 text-blue-700 dark:text-blue-300 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">{i + 1}</span>
              <span className="text-xs leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}><strong>{step.label}:</strong> {step.desc}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] italic leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>
          Neither player can react to the opponent's choice — both commit simultaneously, then reveal.
          Even on-chain observers can't see a card until both commits are recorded.
        </p>
      </section>

      {/* ─── On-Chain Security ────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-base font-bold flex items-center gap-2" style={{ color: 'var(--color-ink)' }}>
          <span className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center text-sm">🛡️</span>
          {t({ id: 'rules.security.heading' })}
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { icon: '🎲', title: 'Entropy Check', text: <>Seeds must have ≥4 distinct byte values. Trivially predictable seeds like <code className="text-[10px] px-1 py-px rounded font-mono" style={{ background: 'var(--color-bg)' }}>[0; 32]</code> are rejected.</> },
            { icon: '🔢', title: 'Session Nonce', text: <>Every action increments a monotonic <code className="text-[10px] px-1 py-px rounded font-mono" style={{ background: 'var(--color-bg)' }}>action_nonce</code>. Stale or replayed txns are rejected.</> },
            { icon: '📋', title: 'On-Chain Events', text: <>8 event types emitted per lifecycle point (start, commit, reveal, trick, end) — fully auditable.</> },
            { icon: '🔍', title: 'Shuffle Verification', text: <>Anyone can call <code className="text-[10px] px-1 py-px rounded font-mono" style={{ background: 'var(--color-bg)' }}>verify_shuffle()</code> to recompute a game's deck from on-chain commits.</> },
          ].map(card => (
            <div key={card.title} className="p-3.5 rounded-xl shadow-sm" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="w-6 h-6 rounded-md bg-amber-500/10 flex items-center justify-center text-xs">{card.icon}</span>
                <span className="text-xs font-bold" style={{ color: 'var(--color-ink)' }}>{card.title}</span>
              </div>
              <p className="text-[11px] leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>{card.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── Deployed Contracts ───────────────────────────────────── */}
      <section className="p-4 rounded-2xl shadow-sm bg-gradient-to-br from-indigo-500/10 to-slate-500/5" style={{ border: '1px solid var(--color-border)' }}>
        <h3 className="text-xs font-bold uppercase tracking-wide mb-3 flex items-center gap-2 text-indigo-700 dark:text-indigo-300">
          <span className="w-6 h-6 rounded-md bg-indigo-500/10 flex items-center justify-center text-xs">📡</span>
          {t({ id: 'rules.contracts.heading' })}
        </h3>
        <div className="space-y-1">
          {[
            { label: 'Cangkulan Game', id: getActiveCangkulanContract() },
            { label: 'ZK Verifier', id: getActiveZkVerifierContract() },
            { label: 'UltraHonk Verifier', id: getActiveUltrahonkVerifierContract() },
            { label: 'Game Hub', id: getActiveGameHubContract() },
            { label: 'Leaderboard Tracker', id: getActiveLeaderboardContract() },
          ].filter(c => c.id).map(c => {
            const expertLink = getStellarExpertLink('contract', c.id);
            if (!expertLink) {
              return (
                <div key={c.label} className="flex items-center gap-3 text-xs py-2 px-3 rounded-lg text-gray-500">
                  <span className="font-semibold shrink-0 w-28">{c.label}</span>
                  <span className="font-mono text-[10px] truncate hidden sm:inline">{c.id}</span>
                  <span className="ml-auto shrink-0 text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-gray-100">Local</span>
                </div>
              );
            }
            return (
              <a
                key={c.label}
                href={expertLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 text-xs no-underline group py-2 px-3 rounded-lg transition-all hover:shadow-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-200"
                style={{ background: 'transparent' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span className="font-semibold shrink-0 w-28">{c.label}</span>
                <span className="font-mono text-[10px] truncate hidden sm:inline" style={{ color: 'var(--color-ink-muted)' }} title={c.id}>{c.id}</span>
                <span className="font-mono text-[10px] sm:hidden" style={{ color: 'var(--color-ink-muted)' }}>{truncAddr(c.id)}</span>
                <span className="ml-auto shrink-0 text-[10px]" style={{ color: 'var(--color-ink-muted)' }}>↗</span>
              </a>
            );
          })}
        </div>
      </section>

      {/* ─── CTA ──────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3 pt-2">
        <button
          onClick={() => navigate({ page: 'tutorial' })}
          className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 active:scale-[0.98] transition-all shadow-md"
        >
          🎓 Tutorial Mode
        </button>
        <button
          onClick={() => navigate({ page: 'architecture' })}
          className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 active:scale-[0.98] transition-all shadow-md"
        >
          🏛️ Architecture
        </button>
        <button
          onClick={() => navigate({ page: 'game' })}
          className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 active:scale-[0.98] transition-all shadow-md"
        >
          🎮 Play Now
        </button>
      </div>
    </div>
  );
}
