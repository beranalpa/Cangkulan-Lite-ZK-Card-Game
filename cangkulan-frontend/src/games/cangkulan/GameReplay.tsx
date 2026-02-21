import { useState, useEffect, useRef } from 'react';
import type { TrickRecord } from './types';
import { playSound } from './soundHelpers';
import { ZkTrickBadge } from './ZkVerificationBadge';

// ═══════════════════════════════════════════════════════════════════════════════
//  Game Replay — step-by-step playback of trick history
// ═══════════════════════════════════════════════════════════════════════════════

interface GameReplayProps {
  trickHistory: TrickRecord[];
  onClose: () => void;
}

export function GameReplay({ trickHistory, onClose }: GameReplayProps) {
  const [currentStep, setCurrentStep] = useState(-1); // -1 = not started
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1500); // ms per step
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const totalSteps = trickHistory.length;

  // Auto-play
  useEffect(() => {
    if (isPlaying && currentStep < totalSteps - 1) {
      timerRef.current = setTimeout(() => {
        setCurrentStep(s => s + 1);
        playSound('card-play');
      }, speed);
    } else if (currentStep >= totalSteps - 1) {
      setIsPlaying(false);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isPlaying, currentStep, totalSteps, speed]);

  const handlePlay = () => {
    if (currentStep >= totalSteps - 1) setCurrentStep(-1);
    setIsPlaying(true);
    if (currentStep === -1) {
      setCurrentStep(0);
      playSound('deal');
    }
  };

  const handlePause = () => setIsPlaying(false);

  const handleStepForward = () => {
    if (currentStep < totalSteps - 1) {
      setCurrentStep(s => s + 1);
      playSound('card-play');
    }
  };

  const handleStepBack = () => {
    if (currentStep > 0) setCurrentStep(s => s - 1);
  };

  const handleReset = () => {
    setIsPlaying(false);
    setCurrentStep(-1);
  };

  const visibleTricks = currentStep >= 0 ? trickHistory.slice(0, currentStep + 1) : [];
  const currentTrick = currentStep >= 0 ? trickHistory[currentStep] : null;

  // Running score
  const p1Score = visibleTricks.filter(t => t.winner === 'p1').length;
  const p2Score = visibleTricks.filter(t => t.winner === 'p2').length;

  // Progress percentage
  const progress = totalSteps > 0 ? ((currentStep + 1) / totalSteps) * 100 : 0;

  return (
    <div
      className="slide-in-up p-5 rounded-xl space-y-4 border-2"
      style={{
        background: 'color-mix(in srgb, var(--color-surface) 95%, #7c3aed)',
        borderColor: 'color-mix(in srgb, var(--color-border) 70%, #7c3aed)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🎬</span>
          <h4 className="text-sm font-black" style={{ color: 'var(--color-ink)' }}>Game Replay</h4>
          <span className="text-xs font-mono" style={{ color: 'var(--color-ink-muted)' }}>
            {currentStep >= 0 ? `${currentStep + 1}/${totalSteps}` : `${totalSteps} tricks`}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-xs font-bold transition-colors"
          style={{ background: 'none', border: 'none', padding: '4px 8px', minWidth: 'auto', minHeight: 'auto', color: 'var(--color-ink-muted)' }}
        >
          ✕ Close
        </button>
      </div>

      {/* Progress Bar */}
      <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${progress}%`, background: 'var(--color-accent)' }}
        />
      </div>

      {/* Scoreboard */}
      <div className="flex items-center justify-center gap-8">
        <div className="text-center">
          <div className="text-xs font-bold text-blue-600 uppercase">Player 1</div>
          <div className="text-3xl font-black text-blue-700">{p1Score}</div>
        </div>
        <div className="text-xl font-black text-gray-300">vs</div>
        <div className="text-center">
          <div className="text-xs font-bold text-purple-600 uppercase">Player 2</div>
          <div className="text-3xl font-black text-purple-700">{p2Score}</div>
        </div>
      </div>

      {/* Current Trick Display */}
      {currentTrick && (
        <div className={`p-3 rounded-xl text-center transition-all duration-300 card-deal-anim ${
          currentTrick.winner === 'p1'
            ? 'bg-blue-50 border-2 border-blue-200'
            : currentTrick.winner === 'p2'
            ? 'bg-purple-50 border-2 border-purple-200'
            : 'bg-gray-50 border-2 border-gray-200'
        }`} key={currentStep}>
          <p className="text-sm font-black">
            Trick #{currentTrick.trickNumber}:{' '}
            <span className={
              currentTrick.winner === 'p1' ? 'text-blue-600' :
              currentTrick.winner === 'p2' ? 'text-purple-600' : 'text-gray-500'
            }>
              {currentTrick.winner === 'p1' ? '🟦 Player 1 wins!' :
               currentTrick.winner === 'p2' ? '🟪 Player 2 wins!' : '⬜ Wasted'}
            </span>
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Cards remaining — P1: {currentTrick.p1HandAfter} · P2: {currentTrick.p2HandAfter}
          </p>
          {(currentTrick.p1ZkVerified || currentTrick.p2ZkVerified) && (
            <div className="flex items-center justify-center gap-2 mt-1.5">
              {currentTrick.p1ZkVerified && (
                <span className="text-[10px] text-blue-600 font-semibold">P1 <ZkTrickBadge verified /></span>
              )}
              {currentTrick.p2ZkVerified && (
                <span className="text-[10px] text-purple-600 font-semibold">P2 <ZkTrickBadge verified /></span>
              )}
            </div>
          )}
        </div>
      )}

      {currentStep === -1 && (
        <div className="p-4 text-center text-sm font-semibold" style={{ color: 'var(--color-ink-muted)' }}>
          Press ▶ to begin replay
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-center gap-2">
        <button
          onClick={handleReset}
          disabled={currentStep === -1}
          className="px-3 py-2 rounded-lg text-sm font-bold bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-30 transition-all"
          style={{ minWidth: 'auto' }}
          title="Reset"
        >
          ⏮
        </button>
        <button
          onClick={handleStepBack}
          disabled={currentStep <= 0}
          className="px-3 py-2 rounded-lg text-sm font-bold bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-30 transition-all"
          style={{ minWidth: 'auto' }}
          title="Previous trick"
        >
          ⏪
        </button>
        {isPlaying ? (
          <button
            onClick={handlePause}
            className="px-5 py-2 rounded-lg text-sm font-bold bg-violet-500 text-white hover:bg-violet-600 transition-all shadow-md"
            style={{ minWidth: 'auto' }}
            title="Pause"
          >
            ⏸ Pause
          </button>
        ) : (
          <button
            onClick={handlePlay}
            disabled={totalSteps === 0}
            className="px-5 py-2 rounded-lg text-sm font-bold bg-gradient-to-r from-violet-500 to-purple-500 text-white hover:from-violet-600 hover:to-purple-600 disabled:opacity-30 transition-all shadow-md"
            style={{ minWidth: 'auto' }}
            title="Play"
          >
            ▶ {currentStep >= totalSteps - 1 ? 'Replay' : 'Play'}
          </button>
        )}
        <button
          onClick={handleStepForward}
          disabled={currentStep >= totalSteps - 1}
          className="px-3 py-2 rounded-lg text-sm font-bold bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-30 transition-all"
          style={{ minWidth: 'auto' }}
          title="Next trick"
        >
          ⏩
        </button>

        {/* Speed selector */}
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="ml-2 px-2 py-1 rounded-lg text-xs font-bold bg-gray-100 border border-gray-200 text-gray-600"
          style={{ width: 'auto', minWidth: 'auto', padding: '4px 8px' }}
        >
          <option value={2500}>0.5x</option>
          <option value={1500}>1x</option>
          <option value={800}>2x</option>
          <option value={400}>4x</option>
        </select>
      </div>

      {/* Trick Timeline */}
      {visibleTricks.length > 0 && (
        <div className="max-h-32 overflow-y-auto space-y-1">
          {visibleTricks.map((t, i) => (
            <div
              key={t.trickNumber}
              className="flex items-center gap-3 text-xs py-1 px-2 rounded-lg border transition-all"
              style={{
                background: i === currentStep
                  ? 'color-mix(in srgb, var(--color-accent) 15%, var(--color-surface))'
                  : 'color-mix(in srgb, var(--color-surface) 60%, transparent)',
                borderColor: i === currentStep
                  ? 'color-mix(in srgb, var(--color-accent) 40%, transparent)'
                  : 'var(--color-border)',
                fontWeight: i === currentStep ? 700 : 400,
              }}
            >
              <span className="font-bold text-gray-500 w-6">#{t.trickNumber}</span>
              <span className={`font-bold ${
                t.winner === 'p1' ? 'text-blue-600' : t.winner === 'p2' ? 'text-purple-600' : 'text-gray-400'
              }`}>
                {t.winner === 'p1' ? '🟦 P1' : t.winner === 'p2' ? '🟪 P2' : '⬜ —'}
              </span>
              <span className="text-gray-400 ml-auto flex items-center gap-1.5" style={{ color: 'var(--color-ink-muted)' }}>
                {(t.p1ZkVerified || t.p2ZkVerified) && <ZkTrickBadge verified />}
                P1:{t.p1HandAfter} P2:{t.p2HandAfter}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
