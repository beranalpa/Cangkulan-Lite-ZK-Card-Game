import type { AppRoute } from '@/hooks/useHashRouter';

/* ═══════════════════════════════════════════════════════════════════════════════
   PageHero — Reusable gradient header for all pages
   Provides consistent visual treatment across the app:
   • Gradient background with icon
   • Title / subtitle
   • Optional back button
   ═══════════════════════════════════════════════════════════════════════════════ */

interface PageHeroProps {
  icon: string;
  title: string;
  subtitle?: string;
  gradient?: string;          // Tailwind gradient classes (default: emerald→teal)
  navigate?: (route: AppRoute) => void;
  backTo?: AppRoute;
  actions?: React.ReactNode;  // optional right-side actions
}

export function PageHero({
  icon,
  title,
  subtitle,
  gradient = 'from-emerald-600 via-teal-600 to-cyan-700',
  navigate,
  backTo,
  actions,
}: PageHeroProps) {
  return (
    <section className={`relative overflow-hidden rounded-2xl p-5 sm:p-6 bg-gradient-to-br ${gradient} text-white`}>
      <div className="relative z-10 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">{icon}</span>
            <h1 className="text-xl sm:text-2xl font-black tracking-tight">{title}</h1>
          </div>
          {subtitle && (
            <p className="text-xs sm:text-sm opacity-80 font-medium max-w-md">{subtitle}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          {navigate && backTo && (
            <button
              onClick={() => navigate(backTo)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/20 hover:bg-white/30 backdrop-blur-sm transition-all active:scale-95"
            >
              ← Back
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
