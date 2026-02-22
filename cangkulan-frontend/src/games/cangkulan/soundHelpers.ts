export type SoundType = 'card-play' | 'cangkul' | 'trick-win' | 'game-win' | 'deal' | 'commit';

// ═══════════════════════════════════════════════════════════════════════════════
//  Sound Mute — persisted to localStorage
// ═══════════════════════════════════════════════════════════════════════════════

const MUTE_KEY = 'cangkulan-sound-muted';

let _muted: boolean = (() => {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
})();

export function isSoundMuted(): boolean { return _muted; }

export function setSoundMuted(muted: boolean): void {
  _muted = muted;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* ignore */ }
}

export function toggleSoundMuted(): boolean {
  setSoundMuted(!_muted);
  return _muted;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Audio Context — singleton, lazy-initialized (reuse avoids Chrome limits)
// ═══════════════════════════════════════════════════════════════════════════════

let _ctx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!_ctx || _ctx.state === 'closed') {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return null;
      _ctx = new Ctor();
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Helper — white noise buffer for card shuffle/flip sounds
// ═══════════════════════════════════════════════════════════════════════════════

function createNoiseBuffer(ctx: AudioContext, duration: number): AudioBuffer {
  const len = Math.ceil(ctx.sampleRate * duration);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Sound Generators — realistic card / game sounds using Web Audio synthesis
// ═══════════════════════════════════════════════════════════════════════════════

/** Card flick — short burst of HP-filtered noise (snap/flick feel). */
function playCardFlick(ctx: AudioContext) {
  const now = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.08);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 2000;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 3500; bp.Q.value = 1.5;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.25, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

  noise.connect(hp).connect(bp).connect(gain).connect(ctx.destination);
  noise.start(now); noise.stop(now + 0.08);
}

/** Cangkul thud — low sine thump + click overlay for emphasis. */
function playCangkulThud(ctx: AudioContext) {
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, now);
  osc.frequency.exponentialRampToValueAtTime(50, now + 0.2);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.25, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now); osc.stop(now + 0.25);

  // Click overlay
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.05);
  const nGain = ctx.createGain();
  nGain.gain.setValueAtTime(0.15, now);
  nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
  noise.connect(nGain).connect(ctx.destination);
  noise.start(now); noise.stop(now + 0.05);
}

/** Trick win — bright ascending 2-note chime (A5 → C#6). */
function playTrickWin(ctx: AudioContext) {
  const now = ctx.currentTime;
  [880, 1108].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = freq;
    const gain = ctx.createGain();
    const t = now + i * 0.08;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.22);
  });
}

/** Victory fanfare — ascending C major arpeggio with shimmer. */
function playGameWin(ctx: AudioContext) {
  const now = ctx.currentTime;
  const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
  notes.forEach((freq, i) => {
    const t = now + i * 0.12;

    // Primary tone
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.13 - i * 0.02, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.6);

    // Detuned shimmer
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine'; osc2.frequency.value = freq * 1.003;
    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(0.0001, t);
    gain2.gain.linearRampToValueAtTime(0.06, t + 0.02);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc2.connect(gain2).connect(ctx.destination);
    osc2.start(t); osc2.stop(t + 0.55);
  });

  // Sparkle noise tail
  const shimmer = ctx.createBufferSource();
  shimmer.buffer = createNoiseBuffer(ctx, 0.4);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 6000; bp.Q.value = 3;
  const sGain = ctx.createGain();
  const sT = now + 0.4;
  sGain.gain.setValueAtTime(0.0001, sT);
  sGain.gain.linearRampToValueAtTime(0.04, sT + 0.05);
  sGain.gain.exponentialRampToValueAtTime(0.001, sT + 0.35);
  shimmer.connect(bp).connect(sGain).connect(ctx.destination);
  shimmer.start(sT); shimmer.stop(sT + 0.4);
}

/** Deal — quick HP noise burst (single card being placed). */
function playDeal(ctx: AudioContext) {
  const now = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.04);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 3000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.10, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

  noise.connect(hp).connect(gain).connect(ctx.destination);
  noise.start(now); noise.stop(now + 0.04);
}

/** Commit confirmation — clean single tone with quick decay. */
function playCommit(ctx: AudioContext) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine'; osc.frequency.value = 600;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.09, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now); osc.stop(now + 0.16);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════════════

const SOUND_PLAYERS: Record<SoundType, (ctx: AudioContext) => void> = {
  'card-play': playCardFlick,
  'cangkul':   playCangkulThud,
  'trick-win': playTrickWin,
  'game-win':  playGameWin,
  'deal':      playDeal,
  'commit':    playCommit,
};

export function playSound(type: SoundType) {
  if (_muted) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try { SOUND_PLAYERS[type](ctx); } catch { /* audio not available */ }
}
