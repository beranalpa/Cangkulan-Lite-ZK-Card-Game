import { useEffect, useRef } from 'react';

// ═══════════════════════════════════════════════════════════════════════════════
//  Canvas Confetti — high-performance particle celebration on win
// ═══════════════════════════════════════════════════════════════════════════════

const COLORS = ['#fdda24', '#00a7b5', '#b7ace8', '#ff6b6b', '#4ecdc4', '#ffe66d', '#ff9ff3', '#54a0ff'];
const PARTICLE_COUNT = 120;
const DURATION = 4000; // ms

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  color: string;
  rotation: number;
  rotSpeed: number;
  gravity: number;
  drag: number;
  opacity: number;
  shape: 'rect' | 'circle' | 'strip';
}

function createParticle(canvasW: number, canvasH: number): Particle {
  const angle = Math.random() * Math.PI * 2;
  const speed = 4 + Math.random() * 10;
  const shape = (['rect', 'circle', 'strip'] as const)[Math.floor(Math.random() * 3)];
  return {
    x: canvasW / 2 + (Math.random() - 0.5) * canvasW * 0.4,
    y: canvasH * 0.35 + (Math.random() - 0.5) * canvasH * 0.2,
    vx: Math.cos(angle) * speed * (0.5 + Math.random()),
    vy: Math.sin(angle) * speed - 3 - Math.random() * 5,
    w: shape === 'strip' ? 3 + Math.random() * 4 : 6 + Math.random() * 8,
    h: shape === 'strip' ? 12 + Math.random() * 16 : 6 + Math.random() * 8,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.3,
    gravity: 0.12 + Math.random() * 0.08,
    drag: 0.98 + Math.random() * 0.015,
    opacity: 1,
    shape,
  };
}

export function CanvasConfetti({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Size canvas to viewport
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    // Create particles
    particlesRef.current = Array.from({ length: PARTICLE_COUNT }, () =>
      createParticle(canvas.width, canvas.height)
    );
    startRef.current = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startRef.current;
      if (elapsed > DURATION) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const fadeOut = elapsed > DURATION * 0.6 ? 1 - (elapsed - DURATION * 0.6) / (DURATION * 0.4) : 1;

      for (const p of particlesRef.current) {
        p.vy += p.gravity;
        p.vx *= p.drag;
        p.vy *= p.drag;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotSpeed;
        p.opacity = Math.max(0, fadeOut);

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.globalAlpha = p.opacity;
        ctx.fillStyle = p.color;

        if (p.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }

        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [active]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-50"
      aria-hidden="true"
      style={{ width: '100vw', height: '100vh' }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Card Sweep Animation — dramatic cards flying across screen
// ═══════════════════════════════════════════════════════════════════════════════

export function CardSweepOverlay({ active }: { active: boolean }) {
  if (!active) return null;

  const cards = Array.from({ length: 8 }, (_, i) => {
    const suits = ['♠', '♥', '♦', '♣'];
    const vals = ['A', 'K', 'Q', 'J', '10'];
    return {
      suit: suits[i % 4],
      val: vals[i % 5],
      isRed: i % 4 === 1 || i % 4 === 2,
      delay: i * 0.15,
      startX: -100 - Math.random() * 200,
      endX: window.innerWidth + 200,
      y: 10 + (i / 8) * 70,
      rotation: -30 + Math.random() * 60,
    };
  });

  return (
    <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden" aria-hidden="true">
      {cards.map((c, i) => (
        <div
          key={i}
          className="absolute w-12 h-16 rounded-lg bg-white border-2 border-gray-300 shadow-lg flex flex-col items-center justify-center"
          style={{
            top: `${c.y}%`,
            animation: `cardSweepAcross 1.5s ease-in-out ${c.delay}s both`,
            transform: `rotate(${c.rotation}deg)`,
          }}
        >
          <span className={`text-xs font-black ${c.isRed ? 'text-red-600' : 'text-gray-900'}`}>{c.val}</span>
          <span className={`text-sm ${c.isRed ? 'text-red-600' : 'text-gray-900'}`}>{c.suit}</span>
        </div>
      ))}
      <style>{`
        @keyframes cardSweepAcross {
          0% { left: -120px; opacity: 0; transform: rotate(-30deg) scale(0.5); }
          15% { opacity: 1; transform: rotate(-10deg) scale(1); }
          85% { opacity: 1; transform: rotate(10deg) scale(1); }
          100% { left: calc(100vw + 120px); opacity: 0; transform: rotate(30deg) scale(0.5); }
        }
      `}</style>
    </div>
  );
}
