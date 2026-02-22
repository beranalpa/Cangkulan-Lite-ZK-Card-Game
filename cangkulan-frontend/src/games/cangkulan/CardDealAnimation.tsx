import { useState, useEffect, useCallback } from 'react';
import { playSound } from './soundHelpers';

// ═══════════════════════════════════════════════════════════════════════════════
//  Card Deal Animation — shows cards flying from deck to each player's hand
//  Triggered when transitioning from seed phase to playing phase
// ═══════════════════════════════════════════════════════════════════════════════

interface DealCard {
  id: number;
  target: 'p1' | 'p2';
  delay: number;
  dealt: boolean;
}

interface CardDealAnimationProps {
  active: boolean;
  p1HandSize: number;
  p2HandSize: number;
  onComplete: () => void;
}

export function CardDealAnimation({ active, p1HandSize, p2HandSize, onComplete }: CardDealAnimationProps) {
  const [cards, setCards] = useState<DealCard[]>([]);
  const [phase, setPhase] = useState<'idle' | 'dealing' | 'done'>('idle');

  const startDealing = useCallback(() => {
    const dealCards: DealCard[] = [];
    const maxCards = Math.max(p1HandSize, p2HandSize);
    let idx = 0;
    // Alternate dealing to P1/P2
    for (let i = 0; i < maxCards; i++) {
      if (i < p1HandSize) {
        dealCards.push({ id: idx++, target: 'p1', delay: idx * 150, dealt: false });
      }
      if (i < p2HandSize) {
        dealCards.push({ id: idx++, target: 'p2', delay: idx * 150, dealt: false });
      }
    }
    setCards(dealCards);
    setPhase('dealing');

    // Animate each card in sequence
    dealCards.forEach((card) => {
      setTimeout(() => {
        playSound('deal');
        setCards(prev => prev.map(c => c.id === card.id ? { ...c, dealt: true } : c));
      }, card.delay);
    });

    // Complete after all cards dealt + short pause
    const totalDuration = (dealCards.length * 150) + 600;
    setTimeout(() => {
      setPhase('done');
      onComplete();
    }, totalDuration);
  }, [p1HandSize, p2HandSize, onComplete]);

  useEffect(() => {
    if (active && phase === 'idle') {
      startDealing();
    }
    if (!active) {
      setPhase('idle');
      setCards([]);
    }
  }, [active, phase, startDealing]);

  if (!active || phase === 'idle') return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50" aria-hidden="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity duration-500"
        style={{ opacity: phase === 'done' ? 0 : 1 }}
      />

      {/* Title */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 text-center card-deal-title">
        <p className="text-2xl sm:text-3xl font-black text-white drop-shadow-lg">
          🎴 Dealing Cards...
        </p>
        <p className="text-sm text-white/70 mt-1">Deck shuffled with combined seeds</p>
      </div>

      {/* Deck position (center) */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="w-16 h-22 rounded-lg border-2 border-blue-300 bg-gradient-to-br from-blue-600 to-blue-800 shadow-xl flex items-center justify-center">
          <span className="text-white text-lg font-bold">🂠</span>
        </div>
      </div>

      {/* Flying cards */}
      {cards.map((card) => (
        <div
          key={card.id}
          className="absolute top-1/2 left-1/2"
          style={{
            transform: card.dealt
              ? card.target === 'p1'
                ? 'translate(-70vw, 30vh) rotate(-15deg) scale(0.7)'
                : 'translate(30vw, 30vh) rotate(15deg) scale(0.7)'
              : 'translate(-50%, -50%) rotate(0deg) scale(1)',
            opacity: card.dealt ? 0 : 1,
            transition: `transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease ${card.dealt ? '0.2s' : '0s'}`,
            zIndex: 60 + card.id,
          }}
        >
          <div className="w-12 h-17 rounded-lg border-2 border-blue-300 bg-gradient-to-br from-blue-600 to-blue-800 shadow-lg flex items-center justify-center">
            <span className="text-white text-xs font-bold">🂠</span>
          </div>
        </div>
      ))}

      {/* Player labels */}
      <div className="absolute bottom-8 left-8 text-center">
        <div className="px-4 py-2 rounded-xl bg-blue-500/80 text-white font-bold text-sm shadow-lg">
          Player 1
          <span className="ml-2 text-xs opacity-80">{cards.filter(c => c.target === 'p1' && c.dealt).length}/{p1HandSize}</span>
        </div>
      </div>
      <div className="absolute bottom-8 right-8 text-center">
        <div className="px-4 py-2 rounded-xl bg-purple-500/80 text-white font-bold text-sm shadow-lg">
          Player 2
          <span className="ml-2 text-xs opacity-80">{cards.filter(c => c.target === 'p2' && c.dealt).length}/{p2HandSize}</span>
        </div>
      </div>

      <style>{`
        .card-deal-title {
          animation: fadeIn 0.5s ease-out both;
        }
      `}</style>
    </div>
  );
}
