// ═══════════════════════════════════════════════════════════════════════════════
//  Game Loading Skeleton
//  Shown while game state is being fetched from chain after a reload.
//  Mimics the actual game layout so it feels instantaneous.
// ═══════════════════════════════════════════════════════════════════════════════

function Bone({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-gray-200 ${className ?? ''}`} />;
}

export function GameLoadingSkeleton({ sessionId, onCancel }: { sessionId?: number; onCancel?: () => void }) {
  return (
    <div className="space-y-5">
      {/* Info bar skeleton */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-gradient-to-r from-gray-50 to-gray-100 border-2 border-gray-200 rounded-xl">
        <div className="flex items-center gap-4">
          <div className="text-center space-y-1">
            <Bone className="h-3 w-14 mx-auto" />
            <Bone className="h-7 w-8 mx-auto" />
          </div>
          <div className="text-center space-y-1">
            <Bone className="h-3 w-12 mx-auto" />
            <Bone className="h-7 w-6 mx-auto" />
          </div>
          <div className="text-center space-y-1">
            <Bone className="h-3 w-12 mx-auto" />
            <Bone className="h-7 w-6 mx-auto" />
          </div>
        </div>
        <div className="text-right space-y-1">
          <Bone className="h-3 w-24 ml-auto" />
          <Bone className="h-3 w-32 ml-auto" />
        </div>
      </div>

      {/* Phase status skeleton */}
      <div className="p-2.5 bg-blue-50/50 border border-blue-100 rounded-xl flex items-center justify-center">
        <Bone className="h-4 w-48" />
      </div>

      {/* Game table skeleton */}
      <div className="p-3 sm:p-5 bg-gradient-to-br from-green-800/80 to-green-900/80 rounded-2xl shadow-inner">
        <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6">
          {/* Draw pile */}
          <div className="text-center">
            <Bone className="h-3 w-16 mx-auto mb-2 !bg-green-600" />
            <div className="w-14 h-20 rounded-lg bg-green-700/60 animate-pulse" />
          </div>
          {/* Flipped card */}
          <div className="text-center">
            <Bone className="h-3 w-14 mx-auto mb-2 !bg-yellow-600" />
            <div className="w-14 h-20 rounded-lg bg-yellow-700/30 animate-pulse" />
          </div>
          {/* P1 / P2 trick cards */}
          <div className="flex gap-2 sm:gap-4">
            <div className="text-center">
              <Bone className="h-3 w-8 mx-auto mb-2 !bg-blue-500" />
              <div className="w-14 h-20 rounded-lg border-2 border-dashed border-blue-600/40" />
            </div>
            <div className="text-center">
              <Bone className="h-3 w-8 mx-auto mb-2 !bg-purple-500" />
              <div className="w-14 h-20 rounded-lg border-2 border-dashed border-purple-600/40" />
            </div>
          </div>
        </div>
        {/* Trick status */}
        <div className="mt-4 flex justify-center">
          <Bone className="h-4 w-56 !bg-green-600" />
        </div>
      </div>

      {/* Opponent hand skeleton */}
      <div>
        <Bone className="h-3 w-36 mb-2" />
        <div className="flex flex-wrap gap-1 p-2 bg-gray-50 rounded-lg border border-gray-200">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-10 h-14 rounded-lg bg-blue-200/60 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      </div>

      {/* Your hand skeleton */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Bone className="h-4 w-32" />
          <Bone className="h-3 w-40" />
        </div>
        <div className="flex flex-wrap gap-2 min-h-[5.5rem] p-3 bg-gray-50 rounded-xl border-2 border-gray-200">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-14 h-20 rounded-lg bg-gray-200 animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
          ))}
        </div>
      </div>

      {/* Session info + cancel */}
      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-gray-400 font-mono">
          {sessionId ? `Restoring session #${sessionId}...` : 'Loading game state...'}
        </p>
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 border border-gray-200 transition-colors"
            style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
          >
            Start New Game
          </button>
        )}
      </div>
    </div>
  );
}
