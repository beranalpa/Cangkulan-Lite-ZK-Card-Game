/**
 * Reusable skeleton loading primitives for shimmer/pulse effects.
 * Used across LeaderboardPage, StatsPage, HistoryPage, and GameLobby
 * to show placeholder UI while async data loads.
 */

interface SkeletonProps {
  className?: string;
  /** Width in Tailwind (e.g. "w-24"). Defaults to "w-full" */
  width?: string;
  /** Height in Tailwind (e.g. "h-4"). Defaults to "h-4" */
  height?: string;
  /** Shape — "rounded" (default), "circle", "pill" */
  shape?: 'rounded' | 'circle' | 'pill';
}

export function Skeleton({ className = '', width = 'w-full', height = 'h-4', shape = 'rounded' }: SkeletonProps) {
  const radius = shape === 'circle' ? 'rounded-full' : shape === 'pill' ? 'rounded-full' : 'rounded-lg';
  return (
    <div
      className={`animate-pulse bg-gray-200 dark:bg-gray-700 ${radius} ${width} ${height} ${className}`}
      aria-hidden="true"
    />
  );
}

/** Skeleton card with title placeholder + 2-3 text lines */
export function SkeletonCard({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div
      className={`animate-pulse p-4 rounded-xl border ${className}`}
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      aria-hidden="true"
    >
      <Skeleton width="w-2/3" height="h-5" className="mb-3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          width={i === lines - 1 ? 'w-1/2' : 'w-full'}
          height="h-3"
          className={i < lines - 1 ? 'mb-2' : ''}
        />
      ))}
    </div>
  );
}

/** Skeleton row for list items (avatar + text) */
export function SkeletonRow({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse flex items-center gap-3 p-3 rounded-xl border ${className}`}
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      aria-hidden="true"
    >
      <Skeleton width="w-8" height="h-8" shape="circle" />
      <div className="flex-1 space-y-1.5">
        <Skeleton width="w-28" height="h-4" />
        <Skeleton width="w-20" height="h-3" />
      </div>
      <Skeleton width="w-16" height="h-5" shape="pill" />
    </div>
  );
}

/** Skeleton stat metric box */
export function SkeletonMetric({ label, className = '' }: { label?: string; className?: string }) {
  return (
    <div
      className={`animate-pulse p-3 rounded-xl border text-center ${className}`}
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      aria-hidden="true"
    >
      <Skeleton width="w-10" height="h-6" className="mx-auto" />
      {label
        ? <div className="text-[10px] font-semibold mt-1" style={{ color: 'var(--color-ink-muted)' }}>{label}</div>
        : <Skeleton width="w-14" height="h-3" className="mx-auto mt-1.5" />
      }
    </div>
  );
}
