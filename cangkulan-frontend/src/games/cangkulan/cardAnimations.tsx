import { motion, AnimatePresence, type Variants, type Transition } from 'framer-motion';
import type { ReactNode } from 'react';

/* ═══════════════════════════════════════════════════════════════════════════════
   Card Animation Library — Framer Motion components for card game effects
   ═══════════════════════════════════════════════════════════════════════════════
   
   Exports:
     AnimatedCard       — Enter/exit layout animation wrapper for hand cards
     CardFlip           — 3D flip between face-down and face-up
     CardCollect        — Cards fly toward the winner after trick resolution
     TrickResultOverlay — Brief "Player X wins!" overlay after trick
     HandLayout         — AnimatePresence wrapper for card hands
     FadeIn             — Generic fade + slide entrance
   ═══════════════════════════════════════════════════════════════════════════════ */

// ── Shared Transitions ─────────────────────────────────────────────────────

const springTransition: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 25,
  mass: 0.8,
};

const gentleSpring: Transition = {
  type: 'spring',
  stiffness: 200,
  damping: 20,
  mass: 0.6,
};

// ── AnimatedCard ────────────────────────────────────────────────────────────
// Wraps individual cards with layout animation + enter/exit

interface AnimatedCardProps {
  cardId: number;
  children: ReactNode;
  /** Index in hand for stagger delay */
  index?: number;
  /** Drag properties */
  draggable?: boolean;
}

const cardVariants: Variants = {
  initial: {
    opacity: 0,
    y: 30,
    scale: 0.85,
    rotateZ: -5,
  },
  animate: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    rotateZ: 0,
    transition: {
      ...gentleSpring,
      delay: i * 0.05,
    },
  }),
  exit: {
    opacity: 0,
    y: -40,
    scale: 0.7,
    rotateZ: 10,
    transition: { duration: 0.25, ease: 'easeIn' },
  },
  hover: {
    y: -8,
    scale: 1.05,
    transition: { type: 'spring', stiffness: 400, damping: 15 },
  },
};

export function AnimatedCard({ cardId, children, index = 0 }: AnimatedCardProps) {
  return (
    <motion.div
      layout
      layoutId={`card-${cardId}`}
      variants={cardVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      whileHover="hover"
      custom={index}
      style={{ display: 'inline-block' }}
    >
      {children}
    </motion.div>
  );
}

// ── CardFlip ────────────────────────────────────────────────────────────────
// 3D card flip between two faces

interface CardFlipProps {
  flipped: boolean;
  front: ReactNode;
  back: ReactNode;
  width?: number;
  height?: number;
}

export function CardFlip({ flipped, front, back, width = 67, height = 96 }: CardFlipProps) {
  return (
    <div style={{ perspective: 800, width, height }} className="relative">
      <motion.div
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={springTransition}
        style={{
          width: '100%',
          height: '100%',
          transformStyle: 'preserve-3d',
          position: 'relative',
        }}
      >
        {/* Front face */}
        <div
          style={{
            position: 'absolute',
            width: '100%',
            height: '100%',
            backfaceVisibility: 'hidden',
          }}
        >
          {front}
        </div>
        {/* Back face */}
        <div
          style={{
            position: 'absolute',
            width: '100%',
            height: '100%',
            backfaceVisibility: 'hidden',
            transform: 'rotateY(180deg)',
          }}
        >
          {back}
        </div>
      </motion.div>
    </div>
  );
}

// ── CardCollect ─────────────────────────────────────────────────────────────
// Fly cards toward the winner side

interface CardCollectProps {
  children: ReactNode;
  /** Which side the card flies to: 'left' (P1) or 'right' (P2) */
  direction: 'left' | 'right';
  /** True to trigger the collect animation */
  collecting: boolean;
  delay?: number;
}

export function CardCollect({ children, direction, collecting, delay = 0 }: CardCollectProps) {
  return (
    <motion.div
      animate={
        collecting
          ? {
              x: direction === 'left' ? -200 : 200,
              y: 60,
              scale: 0.5,
              opacity: 0,
              rotateZ: direction === 'left' ? -30 : 30,
            }
          : { x: 0, y: 0, scale: 1, opacity: 1, rotateZ: 0 }
      }
      transition={{ ...springTransition, delay }}
    >
      {children}
    </motion.div>
  );
}

// ── TrickResultOverlay ──────────────────────────────────────────────────────
// Brief "Player X wins trick!" callout

interface TrickResultOverlayProps {
  message: string | null;
}

const overlayVariants: Variants = {
  initial: { opacity: 0, scale: 0.6, y: 20 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { ...springTransition } },
  exit: { opacity: 0, scale: 0.8, y: -20, transition: { duration: 0.3 } },
};

export function TrickResultOverlay({ message }: TrickResultOverlayProps) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          key="trick-result"
          variants={overlayVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30
                     px-5 py-3 rounded-2xl bg-gradient-to-r from-amber-500/90 to-yellow-500/90
                     text-white font-bold text-sm sm:text-base shadow-2xl backdrop-blur-sm
                     pointer-events-none select-none whitespace-nowrap"
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── HandLayout ──────────────────────────────────────────────────────────────
// AnimatePresence wrapper for card hands — handles enter/exit of cards

interface HandLayoutProps {
  children: ReactNode;
  className?: string;
}

export function HandLayout({ children, className = '' }: HandLayoutProps) {
  return (
    <AnimatePresence mode="popLayout">
      <motion.div
        layout
        className={`flex flex-wrap gap-1.5 justify-center ${className}`}
        transition={gentleSpring}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

// ── FadeIn ──────────────────────────────────────────────────────────────────
// Generic entrance animation for sections

interface FadeInProps {
  children: ReactNode;
  delay?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  className?: string;
}

const directionOffsets = {
  up: { y: 20 },
  down: { y: -20 },
  left: { x: 20 },
  right: { x: -20 },
};

export function FadeIn({ children, delay = 0, direction = 'up', className = '' }: FadeInProps) {
  const offset = directionOffsets[direction];
  return (
    <motion.div
      initial={{ opacity: 0, ...offset }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.4, delay, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ── DealAnimation (Framer Motion version) ───────────────────────────────────
// Animated card dealing from deck to players

interface DealCardMotionProps {
  active: boolean;
  cardCount: number;
  onComplete?: () => void;
}

export function DealCardsMotion({ active, cardCount, onComplete }: DealCardMotionProps) {
  if (!active) return null;

  return (
    <AnimatePresence onExitComplete={onComplete}>
      {active && (
        <motion.div
          key="deal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm pointer-events-none"
        >
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={springTransition}
            className="text-center"
          >
            <p className="text-2xl sm:text-3xl font-black text-white drop-shadow-lg">
              🎴 Dealing {cardCount} Cards...
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Re-export AnimatePresence for convenience
export { AnimatePresence, motion };
