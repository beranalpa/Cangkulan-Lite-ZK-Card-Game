import { memo } from 'react';
import { cardSuit, cardValue, cardAccessibleName, SUIT_SYMBOLS } from './cardHelpers';

/* ═══════════════════════════════════════════════════════════════════════════════
   SVG Playing Card — professional casino-style rendering
   ═══════════════════════════════════════════════════════════════════════════════ */

const SUIT_COLORS: Record<number, string> = { 0: '#1a1a2e', 1: '#dc2626', 2: '#dc2626', 3: '#1a1a2e' };

/** Mini suit SVG paths (scaled to 0-1 viewBox) */
const SUIT_PATHS: Record<number, string> = {
  0: 'M.5.1C.5.1.05.55.5.85.95.55.5.1.5.1Z', // spade
  1: 'M.5.15C.23.35.05.55.05.7c0,.2.15.35.35.35.1,0,.1-.05.1-.05L.5.95l0,.05c0,0,0,.05.1.05.2,0,.35-.15.35-.35C.95.55.77.35.5.15Z', // heart
  2: 'M.5.1L.9.5.5.9.1.5Z', // diamond
  3: 'M.5.15C.5.15.15.35.15.55c0,.15.12.25.25.25.05,0,.07-.02.1-.05L.5.85.5.75c.03.03.05.05.1.05.13,0,.25-.1.25-.25C.85.35.5.15.5.15Z', // club
};

function SuitIcon({ suit, size = 14, className = '' }: { suit: number; size?: number; className?: string }) {
  const color = SUIT_COLORS[suit];
  return (
    <svg width={size} height={size} viewBox="0 0 1 1" className={className} aria-hidden="true">
      <path d={SUIT_PATHS[suit]} fill={color} />
    </svg>
  );
}

/** Center suit pattern — arranged based on card value (2-10) */
function CenterPips({ suit, value, size }: { suit: number; value: number; size: 'sm' | 'md' | 'lg' }) {
  const pipSize = size === 'sm' ? 8 : size === 'md' ? 10 : 14;
  const color = SUIT_COLORS[suit];
  const sym = SUIT_SYMBOLS[suit];

  // Layout positions for each value (percentage x,y)
  const layouts: Record<number, [number, number][]> = {
    2: [[50,25],[50,75]],
    3: [[50,20],[50,50],[50,80]],
    4: [[30,25],[70,25],[30,75],[70,75]],
    5: [[30,20],[70,20],[50,50],[30,80],[70,80]],
    6: [[30,20],[70,20],[30,50],[70,50],[30,80],[70,80]],
    7: [[30,18],[70,18],[50,36],[30,50],[70,50],[30,82],[70,82]],
    8: [[30,16],[70,16],[50,32],[30,50],[70,50],[50,68],[30,84],[70,84]],
    9: [[30,15],[70,15],[30,38],[70,38],[50,50],[30,62],[70,62],[30,85],[70,85]],
    10:[[30,13],[70,13],[50,26],[30,38],[70,38],[30,62],[70,62],[50,74],[30,87],[70,87]],
  };

  const positions = layouts[value] ?? layouts[2];
  const containerH = size === 'sm' ? 38 : size === 'md' ? 54 : 74;
  const containerW = size === 'sm' ? 26 : size === 'md' ? 38 : 52;

  return (
    <div className="relative mx-auto" style={{ width: containerW, height: containerH }}>
      {positions.map(([x, y], i) => (
        <span
          key={i}
          className="absolute leading-none select-none"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            transform: 'translate(-50%, -50%)',
            fontSize: pipSize,
            color,
          }}
          aria-hidden="true"
        >
          {sym}
        </span>
      ))}
    </div>
  );
}

export const PlayingCard = memo(function PlayingCard({
  cardId,
  selected,
  playable,
  onClick,
  onKeyDown,
  size = 'md',
  faceDown = false,
}: {
  cardId: number;
  selected?: boolean;
  playable?: boolean;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  size?: 'sm' | 'md' | 'lg';
  faceDown?: boolean;
}) {
  if (faceDown) return <CardBack size={size === 'lg' ? 'md' : size} />;

  const suit = cardSuit(cardId);
  const value = cardValue(cardId);
  const suitSym = SUIT_SYMBOLS[suit];
  const color = SUIT_COLORS[suit];
  const valueStr = value === 10 ? '10' : String(value);

  const dims = {
    sm: { w: 'w-12', h: 'h-[4.2rem]', valSize: 'text-xs', cornerSize: 6 },
    md: { w: 'w-[4.2rem]', h: 'h-[6rem]', valSize: 'text-sm', cornerSize: 8 },
    lg: { w: 'w-[5.5rem]', h: 'h-[8rem]', valSize: 'text-base', cornerSize: 10 },
  }[size];

  return (
    <button
      onClick={onClick}
      onKeyDown={onKeyDown}
      disabled={!onClick}
      aria-label={`${cardAccessibleName(cardId)}${selected ? ' (selected)' : ''}${playable ? '' : ' (not playable)'}`}
      className={`
        ${dims.w} ${dims.h} rounded-xl border-2 shadow-lg
        flex flex-col items-stretch justify-between p-1
        transition-all duration-200 select-none relative overflow-hidden
        ${selected
          ? 'border-yellow-400 ring-2 ring-yellow-300 -translate-y-3 shadow-2xl scale-105'
          : ''
        }
        ${playable && !selected
          ? 'border-emerald-300 hover:border-emerald-500 hover:-translate-y-2 hover:shadow-xl cursor-pointer hover:scale-[1.03]'
          : ''
        }
        ${!playable && !selected ? 'border-gray-200 opacity-60 cursor-default' : ''}
      `}
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        backgroundColor: selected ? '#fefce8' : '#fffef7',
      }}
    >
      {/* Top-left corner */}
      <div className="flex flex-col items-start leading-none" style={{ color }}>
        <span className={`${dims.valSize} font-black`}>{valueStr}</span>
        <SuitIcon suit={suit} size={dims.cornerSize} />
      </div>

      {/* Center pips */}
      <CenterPips suit={suit} value={value} size={size} />

      {/* Bottom-right corner (inverted) */}
      <div className="flex flex-col items-end leading-none rotate-180" style={{ color }}>
        <span className={`${dims.valSize} font-black`}>{valueStr}</span>
        <SuitIcon suit={suit} size={dims.cornerSize} />
      </div>

      {/* Subtle texture overlay */}
      <div
        className="absolute inset-0 pointer-events-none rounded-xl opacity-[0.03]"
        style={{
          backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 2px, currentColor 2px, currentColor 3px)',
        }}
      />
    </button>
  );
});

export const CardBack = memo(function CardBack({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const dims = {
    sm: 'w-12 h-[4.2rem]',
    md: 'w-[4.2rem] h-[6rem]',
  }[size];

  return (
    <div
      className={`${dims} rounded-xl border-2 border-indigo-400 shadow-lg flex items-center justify-center overflow-hidden relative`}
      role="img"
      aria-label="Face-down card"
      style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2442)' }}
    >
      {/* Diamond pattern */}
      <svg className="absolute inset-0 w-full h-full opacity-20" aria-hidden="true">
        <defs>
          <pattern id="card-back-pattern" x="0" y="0" width="12" height="12" patternUnits="userSpaceOnUse">
            <rect width="12" height="12" fill="none" />
            <path d="M6 0L12 6L6 12L0 6Z" fill="rgba(255,255,255,0.3)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#card-back-pattern)" />
      </svg>
      {/* Center emblem */}
      <div className="relative z-10 w-6 h-6 rounded-full border border-indigo-300/40 flex items-center justify-center">
        <span className="text-indigo-200 text-[8px] font-bold">C</span>
      </div>
    </div>
  );
});

