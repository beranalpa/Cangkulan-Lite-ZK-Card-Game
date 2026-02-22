import { useState, useEffect, useRef } from 'react';

// ═══════════════════════════════════════════════════════════════════════════════
//  Animated Score Counter — smoothly rolls between old and new values
//  with color flash on change (green for increase, red for decrease)
// ═══════════════════════════════════════════════════════════════════════════════

interface AnimatedScoreProps {
  value: number;
  label: string;
  color: string;        // base text color class e.g. 'text-blue-700'
  flashColor?: string;  // flash background on change
  size?: 'sm' | 'md' | 'lg';
}

export function AnimatedScore({ value, label, color, flashColor = 'bg-emerald-100', size = 'md' }: AnimatedScoreProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const [isAnimating, setIsAnimating] = useState(false);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  const prevValueRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const prev = prevValueRef.current;
    if (value === prev) return;
    prevValueRef.current = value;

    setDirection(value > prev ? 'up' : 'down');
    setIsAnimating(true);

    // Animate from prev to value
    const start = performance.now();
    const duration = 500; // ms
    const startVal = prev;
    const endVal = value;

    const animate = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(startVal + (endVal - startVal) * eased);
      setDisplayValue(current);

      if (t < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayValue(endVal);
        setTimeout(() => {
          setIsAnimating(false);
          setDirection(null);
        }, 400);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value]);

  const sizeClasses = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-4xl',
  }[size];

  return (
    <div className="text-center relative">
      <div className="text-xs font-bold text-gray-500 uppercase">{label}</div>
      <div
        className={`${sizeClasses} font-black ${color} transition-all duration-200 ${
          isAnimating ? 'scale-125' : 'scale-100'
        }`}
      >
        {displayValue}

        {/* Score change indicator */}
        {isAnimating && direction && (
          <span
            className={`absolute -top-2 -right-3 text-xs font-black ${
              direction === 'up' ? 'text-green-500' : 'text-red-500'
            }`}
            style={{ animation: 'scorePopUp 0.8s ease-out forwards' }}
          >
            {direction === 'up' ? `+${value - (prevValueRef.current ?? value)}` : `${value - (prevValueRef.current ?? value)}`}
          </span>
        )}
      </div>

      {/* Flash background */}
      {isAnimating && (
        <div
          className={`absolute inset-0 -m-2 rounded-lg ${
            direction === 'up' ? flashColor : 'bg-red-100'
          }`}
          style={{ animation: 'scoreFlash 0.6s ease-out forwards', zIndex: -1 }}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Progressive Score Bar — horizontal bar comparison + animated scores
// ═══════════════════════════════════════════════════════════════════════════════

interface ProgressiveScoreDisplayProps {
  p1Tricks: number;
  p2Tricks: number;
  p1HandSize: number;
  p2HandSize: number;
  drawPileSize: number;
  playerNumber: number;
}

export function ProgressiveScoreDisplay({
  p1Tricks,
  p2Tricks,
  p1HandSize,
  p2HandSize,
  drawPileSize,
  playerNumber,
}: ProgressiveScoreDisplayProps) {
  const total = p1Tricks + p2Tricks || 1;
  const p1Pct = (p1Tricks / total) * 100;
  const p2Pct = (p2Tricks / total) * 100;

  return (
    <div className="space-y-3">
      {/* Score counters */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <AnimatedScore value={p1Tricks} label="P1 Tricks" color="text-blue-700" flashColor="bg-blue-100" />
          <div className="text-xs text-gray-400 font-bold">
            {p1HandSize} 🃏
          </div>
        </div>

        <div className="flex flex-col items-center">
          <div className="text-xs font-bold text-gray-400 uppercase">Draw</div>
          <div className="text-lg font-black text-emerald-700">{drawPileSize}</div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-xs text-gray-400 font-bold">
            🃏 {p2HandSize}
          </div>
          <AnimatedScore value={p2Tricks} label="P2 Tricks" color="text-purple-700" flashColor="bg-purple-100" />
        </div>
      </div>

      {/* Progress bar */}
      {p1Tricks + p2Tricks > 0 && (
        <div className="h-2 rounded-full bg-gray-200 overflow-hidden flex">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500 ease-out"
            style={{ width: `${p1Pct}%` }}
          />
          <div
            className="h-full bg-gradient-to-r from-purple-400 to-purple-500 transition-all duration-500 ease-out"
            style={{ width: `${p2Pct}%` }}
          />
        </div>
      )}

      {/* Player indicator */}
      <div className="flex justify-between text-xs font-bold">
        <span className={playerNumber === 1 ? 'text-blue-600' : 'text-gray-400'}>
          {playerNumber === 1 ? '⭐ You' : 'P1'}
        </span>
        <span className={playerNumber === 2 ? 'text-purple-600' : 'text-gray-400'}>
          {playerNumber === 2 ? 'You ⭐' : 'P2'}
        </span>
      </div>
    </div>
  );
}
