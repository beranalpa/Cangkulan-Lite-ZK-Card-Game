import { useIntl } from 'react-intl';
import type { AppRoute } from '@/hooks/useHashRouter';
import { PageHero } from '@/components/PageHero';

// ═══════════════════════════════════════════════════════════════════════════════
//  Tutorial Page — blockchain education & game rules
// ═══════════════════════════════════════════════════════════════════════════════

interface TutorialPageProps {
  navigate: (route: AppRoute) => void;
}

export function TutorialPage({ navigate }: TutorialPageProps) {
  const { formatMessage: t } = useIntl();

  const concepts = [
    { icon: '🎯', titleKey: 'tutorial.howToWin.title', textKey: 'tutorial.howToWin.text' },
    { icon: '🔒', titleKey: 'tutorial.commitReveal.title', textKey: 'tutorial.commitReveal.text' },
    { icon: '🔐', titleKey: 'tutorial.zkProofs.title', textKey: 'tutorial.zkProofs.text' },
    { icon: '🎲', titleKey: 'tutorial.fairShuffle.title', textKey: 'tutorial.fairShuffle.text' },
    { icon: '⏰', titleKey: 'tutorial.timeout.title', textKey: 'tutorial.timeout.text' },
    { icon: '📜', titleKey: 'tutorial.onChain.title', textKey: 'tutorial.onChain.text' },
  ];

  return (
    <div className="space-y-4">
      {/* Hero */}
      <PageHero
        icon="🎓"
        title={t({ id: 'nav.tutorial' })}
        subtitle={t({ id: 'home.tutorialDesc' })}
        gradient="from-amber-500 via-orange-500 to-red-500"
        navigate={navigate}
        backTo={{ page: 'home' }}
      />

      {/* Blockchain Education Section */}
      <div className="rounded-2xl p-5" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div className="mb-4">
          <h2 className="text-lg font-bold" style={{ color: 'var(--color-ink)' }}>🧠 How Blockchain Makes This Fair</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-ink-muted)' }}>
            Rules, win conditions, and why crypto matters for card games
          </p>
        </div>

        <div className="space-y-3">
          {concepts.map(({ icon, titleKey, textKey }) => (
            <div key={titleKey} className="rounded-xl p-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xl">{icon}</span>
                <h3 className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>{t({ id: titleKey })}</h3>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-ink-muted)' }}>{t({ id: textKey })}</p>
            </div>
          ))}

          <div className="text-center pt-2">
            <button
              onClick={() => navigate({ page: 'demo' })}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl font-bold text-sm transition-all hover:scale-105 active:scale-95"
              style={{ background: 'var(--color-accent)', color: '#0f0f0f', border: '1px solid var(--color-ink)' }}
            >
              {t({ id: 'tutorial.showcase.cta' })}
            </button>
          </div>
        </div>
      </div>

      {/* CTA to AI Bot */}
      <div className="rounded-2xl p-5 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <span className="text-3xl block mb-2">🤖</span>
        <h3 className="text-lg font-bold mb-1" style={{ color: 'var(--color-ink)' }}>{t({ id: 'tutorial.ready.title' })}</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--color-ink-muted)' }}>{t({ id: 'tutorial.ready.text' })}</p>
        <button
          onClick={() => navigate({ page: 'game' })}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl font-bold text-sm transition-all hover:scale-105 active:scale-95"
          style={{ background: 'var(--color-accent)', color: '#0f0f0f', border: '1px solid var(--color-ink)' }}
        >
          <span>🎮</span> {t({ id: 'tutorial.ready.cta' })}
        </button>
      </div>
    </div>
  );
}
