import { useState, useEffect, useRef } from 'react';
import type { GameState, ProofMode, GameMode } from './types';
import { LIFECYCLE } from './types';
import { TimeoutControls } from './TimeoutControls';
import { loadSeedData } from './seedStorage';
import { ZkVerificationBadge } from './ZkVerificationBadge';
import { useNetworkStore } from '@/store/networkStore';

// ─── Opponent Activity Indicator (Seed Phase) ──────────────────────────────
function SeedOpponentIndicator({ gameState, isWaitingForOpponent }: { gameState: GameState; isWaitingForOpponent: boolean }) {
  const lastNonceRef = useRef(gameState.action_nonce);
  const [lastActive, setLastActive] = useState<number>(Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (gameState.action_nonce !== lastNonceRef.current) {
      lastNonceRef.current = gameState.action_nonce;
      setLastActive(Date.now());
    }
  }, [gameState.action_nonce]);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(iv);
  }, []);

  const secsAgo = Math.floor((now - lastActive) / 1000);
  const isActive = secsAgo < 15;
  const isRecent = secsAgo < 60;

  if (!isWaitingForOpponent) return null;

  const statusText = isActive ? 'Opponent active' : isRecent ? `Last seen ${secsAgo}s ago` : `Idle ${Math.floor(secsAgo / 60)}m`;

  return (
    <div className="flex items-center justify-center gap-1.5 text-xs mt-2" role="status" aria-live="polite" aria-label={statusText}>
      <span
        className={`inline-block w-2 h-2 rounded-full ${isActive ? 'bg-green-500 animate-pulse' : isRecent ? 'bg-yellow-500' : 'bg-gray-400'
          }`}
        aria-hidden="true"
      />
      <span className="sr-only">{isActive ? '●' : isRecent ? '◐' : '○'}</span>
      <span className={`font-semibold ${isActive ? 'text-green-700' : isRecent ? 'text-yellow-700' : 'text-gray-500'}`}>
        {statusText}
      </span>
    </div>
  );
}

interface SeedPhaseProps {
  gameState: GameState;
  sessionId: number;
  userAddress: string;
  isPlayer1: boolean;
  isPlayer2: boolean;
  isBusy: boolean;
  loading: boolean;
  onCommitSeed: () => void;
  onRevealSeed: () => void;
  onTickTimeout: () => void;
  onResolveTimeout: () => void;
  isWaitingForOpponent: boolean;
  timeoutReady: boolean | undefined;
  canTimeout: boolean;
  proofMode: ProofMode;
  onProofModeChange: (mode: ProofMode) => void;
  noirProofProgress: string | null;
  /** Game mode — controls which proof toggle variant to show */
  gameMode?: GameMode;
}

export function SeedPhase({
  gameState,
  sessionId,
  userAddress,
  isPlayer1,
  isPlayer2,
  isBusy,
  loading,
  onCommitSeed,
  onRevealSeed,
  onTickTimeout,
  onResolveTimeout,
  isWaitingForOpponent,
  timeoutReady,
  canTimeout,
  proofMode,
  onProofModeChange,
  noirProofProgress,
  gameMode = 'multiplayer',
}: SeedPhaseProps) {
  const isCommitPhase = gameState.lifecycle_state === LIFECYCLE.SEED_COMMIT;
  const isRevealPhase = gameState.lifecycle_state === LIFECYCLE.SEED_REVEAL;

  const hasCommittedSeed = isPlayer1
    ? gameState.seed_commit1 != null
    : isPlayer2
      ? gameState.seed_commit2 != null
      : false;
  const hasRevealedSeed = isPlayer1 ? gameState.seed_revealed1 : isPlayer2 ? gameState.seed_revealed2 : false;
  const bothCommitted = gameState.seed_commit1 != null && gameState.seed_commit2 != null;
  const bothRevealed = gameState.seed_revealed1 && gameState.seed_revealed2;
  const savedSeed = loadSeedData(sessionId, userAddress);

  if (isCommitPhase) {
    return (
      <div className="space-y-6">
        <div className="p-4 bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-200 rounded-xl text-center" role="status" aria-live="polite" aria-atomic="true">
          <p className="text-lg font-bold text-indigo-800">🎲 Seed Commitment Phase</p>
          <p className="text-xs text-gray-600 mt-1">Both players commit a random seed for provably fair deck shuffle</p>
        </div>

        {/* Player Status */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <PlayerStatusCard
            label="Player 1"
            isYou={isPlayer1}
            address={gameState.player1}
            points={gameState.player1_points}
            status={gameState.seed_commit1 != null ? 'committed' : 'waiting'}
          />
          <PlayerStatusCard
            label="Player 2"
            isYou={isPlayer2}
            address={gameState.player2}
            points={gameState.player2_points}
            status={gameState.seed_commit2 != null ? 'committed' : 'waiting'}
          />
        </div>

        {/* Commit Action */}
        {(isPlayer1 || isPlayer2) && !hasCommittedSeed && (
          <div className="p-6 bg-gradient-to-br from-indigo-50 to-purple-50 border-2 border-indigo-300 rounded-2xl text-center">
            <div className="text-4xl mb-3">🎲</div>
            <h3 className="text-xl font-bold text-gray-900 mb-2">Commit Your Random Seed</h3>
            <p className="text-sm text-gray-700 mb-4">A random 32-byte seed will be generated and committed. The hash is stored on-chain — nobody can see your seed until you reveal it.</p>

            {/* ── Proof Mode Toggle (varies by game mode) ── */}
            {gameMode === 'ai' ? (
              <ProofModeInfoBadge mode="nizk" label="Hash-NIZK Schnorr proof — 64 bytes, auto-verified on-chain" />
            ) : gameMode === 'dev' ? (
              <ProofModeToggleFull mode={proofMode} onChange={onProofModeChange} disabled={isBusy} />
            ) : (
              <ProofModeInfoBadge mode="pedersen" label="Pedersen+Sigma EC commitment — 224 bytes, auto-verified on-chain" />
            )}

            <button onClick={onCommitSeed} disabled={isBusy}
              className="px-10 py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl">
              {loading ? 'Committing...' : proofMode === 'noir' ? '🌑 Commit Seed (Noir)' : proofMode === 'nizk' ? '#️⃣ Commit Seed (NIZK)' : '🎲 Commit Seed'}
            </button>
          </div>
        )}

        {hasCommittedSeed && !bothCommitted && (
          <div className="p-4 bg-gradient-to-r from-blue-50 to-cyan-50 border-2 border-blue-200 rounded-xl" role="status" aria-live="polite">
            <p className="text-sm font-semibold text-blue-700">✓ You've committed your seed. Waiting for the other player...</p>
            <SeedOpponentIndicator gameState={gameState} isWaitingForOpponent={isWaitingForOpponent} />
          </div>
        )}

        {canTimeout && (
          <TimeoutControls gameState={gameState} isBusy={isBusy} loading={loading}
            onTick={onTickTimeout} onResolve={onResolveTimeout} timeoutReady={timeoutReady}
            isWaitingForOpponent={isWaitingForOpponent} sessionId={sessionId} />
        )}

        <ZkVerificationBadge variant="action" proofMode={proofMode} actionLabel="Seed Phase" />
      </div>
    );
  }

  // Reveal Phase
  return (
    <div className="space-y-6">
      <div className="p-4 bg-gradient-to-r from-amber-50 to-yellow-50 border-2 border-amber-200 rounded-xl text-center" role="status" aria-live="polite" aria-atomic="true">
        <p className="text-lg font-bold text-amber-800">🔓 Seed Reveal Phase</p>
        <p className="text-xs text-gray-600 mt-1">Both players reveal seeds → combined seed shuffles the deck</p>
      </div>

      {/* Player Status */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <PlayerStatusCard
          label="Player 1"
          isYou={isPlayer1}
          address={gameState.player1}
          status={gameState.seed_revealed1 ? 'revealed' : 'locked'}
        />
        <PlayerStatusCard
          label="Player 2"
          isYou={isPlayer2}
          address={gameState.player2}
          status={gameState.seed_revealed2 ? 'revealed' : 'locked'}
        />
      </div>

      {/* Reveal Action */}
      {(isPlayer1 || isPlayer2) && !hasRevealedSeed && (
        <div className="p-6 bg-gradient-to-br from-amber-50 via-yellow-50 to-orange-50 border-2 border-amber-300 rounded-2xl text-center">
          <div className="text-4xl mb-3">🔓</div>
          <h3 className="text-xl font-bold text-gray-900 mb-2">Reveal Your Seed</h3>
          {savedSeed ? (
            <>
              <p className="text-sm text-gray-700 mb-2">Your seed is saved locally. Click to reveal and verify on-chain.</p>
              {(savedSeed as any).proofMode === 'noir' ? (
                <span className="inline-block mb-3 px-3 py-1 rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white text-xs font-bold shadow">
                  Noir UltraKeccakHonk Proof
                </span>
              ) : (savedSeed as any).proofMode === 'nizk' ? (
                <span className="inline-block mb-3 px-3 py-1 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 text-white text-xs font-bold shadow">
                  Hash-NIZK Schnorr Proof
                </span>
              ) : (
                <span className="inline-block mb-3 px-3 py-1 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 text-white text-xs font-bold shadow">
                  Pedersen ZK Proof
                </span>
              )}
            </>
          ) : (
            <p className="text-sm text-red-600 font-semibold mb-4">⚠️ No saved seed data. You may have committed from a different browser.</p>
          )}

          {/* Noir proof progress indicator */}
          {noirProofProgress && (
            <div className="mb-4 p-3 bg-violet-50 border border-violet-200 rounded-lg animate-pulse">
              <div className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4 text-violet-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm font-semibold text-violet-700">{noirProofProgress}</span>
              </div>
            </div>
          )}

          <button onClick={onRevealSeed} disabled={isBusy || !savedSeed}
            className="px-10 py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl">
            {loading && noirProofProgress ? 'Generating Proof...' : loading ? 'Revealing...' : '🔓 Reveal Seed'}
          </button>
        </div>
      )}

      {hasRevealedSeed && !bothRevealed && (
        <div className="p-4 bg-gradient-to-r from-blue-50 to-cyan-50 border-2 border-blue-200 rounded-xl" role="status" aria-live="polite">
          <p className="text-sm font-semibold text-blue-700">✓ You've revealed your seed. Waiting for the other player to reveal...</p>
          <SeedOpponentIndicator gameState={gameState} isWaitingForOpponent={isWaitingForOpponent} />
        </div>
      )}

      {canTimeout && (
        <TimeoutControls gameState={gameState} isBusy={isBusy} loading={loading}
          onTick={onTickTimeout} onResolve={onResolveTimeout} timeoutReady={timeoutReady}
          isWaitingForOpponent={isWaitingForOpponent} sessionId={sessionId} />
      )}

      <ZkVerificationBadge variant="action" proofMode={(savedSeed as any)?.proofMode ?? proofMode} actionLabel="Seed Reveal" />
    </div>
  );
}

// ─── Proof Mode Toggle ─────────────────────────────────────────────────────

// ─── AI Mode: No toggle — just a subtle info badge ─────────────────────────

function ProofModeInfoBadge({ mode, label }: { mode: ProofMode; label?: string }) {
  const isLocal = useNetworkStore(s => s.activeNetwork === 'local');
  const localReachable = useNetworkStore(s => s.localNodeReachable);
  const noirOnLocal = isLocal && localReachable;

  const info: Record<ProofMode, { icon: string; text: string; tooltip: string; colors: string }> = {
    nizk: {
      icon: '#️⃣',
      text: label || 'Hash-NIZK Schnorr proof — auto-verified on-chain',
      tooltip: 'Hash-based Non-Interactive Zero-Knowledge proof using Keccak256 + Fiat-Shamir challenge-response. Lightest proof at 64 bytes. Proves knowledge of the seed preimage without revealing it. ~0.5M CPU on-chain.',
      colors: 'bg-cyan-50 border-cyan-100 text-cyan-700',
    },
    pedersen: {
      icon: '🔐',
      text: label || 'Pedersen EC commitment — auto-verified on-chain',
      tooltip: 'Pedersen commitment on BLS12-381 curve with Schnorr sigma proof. Information-theoretic hiding — the commitment reveals zero information about the seed. 224-byte proof verified on-chain in ~1.5M CPU instructions.',
      colors: 'bg-indigo-50 border-indigo-100 text-indigo-700',
    },
    noir: {
      icon: '🌑',
      text: label || 'Noir — Local Node (Unlimited CPU) ✅',
      tooltip: 'Noir UltraKeccakHonk SNARK (~14 KB) generated in-browser via @aztec/bb.js. Split-TX: TX 1 = verify_noir_seed (UltraHonk on-chain) → TX 2 = reveal_seed. Local node has unlimited CPU budget — full on-chain verification works!',
      colors: 'bg-emerald-50 border-emerald-100 text-emerald-700',
    },
  };
  const { icon, text, tooltip, colors } = info[mode];
  return (
    <div className="mb-5 flex items-center justify-center">
      <div className={`group relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-medium cursor-help ${colors}`} title={tooltip}>
        <span>{icon}</span>
        <span>{text}</span>
        <span className="text-[9px] opacity-60 ml-1">ⓘ</span>
        {/* Hover tooltip */}
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 p-3 rounded-xl shadow-xl border bg-white text-gray-700 text-[11px] leading-relaxed opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
          {tooltip}
        </div>
      </div>
    </div>
  );
}

// ─── (Multiplayer now uses ProofModeInfoBadge directly — no toggle needed) ──

// ─── Dev Mode: Full toggle — all 3 modes ────────────────────────────────────

function ProofModeToggleFull({
  mode,
  onChange,
  disabled,
}: {
  mode: ProofMode;
  onChange: (m: ProofMode) => void;
  disabled: boolean;
}) {
  const isLocal = useNetworkStore(s => s.activeNetwork === 'local');
  const localReachable = useNetworkStore(s => s.localNodeReachable);
  const noirOnLocal = isLocal && localReachable;

  // Sync mode based on active network rules
  useEffect(() => {
    if (isLocal && mode !== 'noir') {
      onChange('noir');
    } else if (!isLocal && mode === 'noir') {
      onChange('nizk');
    }
  }, [isLocal, mode, onChange]);

  return (
    <div className="mb-5 p-4 bg-white/80 backdrop-blur border border-amber-200 rounded-xl">
      <div className="text-xs font-bold uppercase tracking-wider text-amber-600 mb-2">🔧 Dev — ZK Modes</div>
      <div className="flex items-center justify-center gap-2">
        {!isLocal && (
          <div className="flex-1 group relative">
            <button
              onClick={() => onChange('nizk')}
              disabled={disabled}
              className={`w-full px-3 py-2.5 rounded-lg text-sm font-bold transition-all ${mode === 'nizk'
                ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg scale-[1.02]'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                } disabled:opacity-50`}
            >
              <div>#️⃣ NIZK</div>
              <div className="text-[10px] font-normal opacity-80 mt-0.5">64 B</div>
            </button>
            <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-56 p-2.5 bg-gray-900 text-white text-[11px] rounded-lg shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-30">
              <strong>Hash-NIZK (Non-Interactive Zero Knowledge)</strong><br />
              Keccak256 hash + Schnorr challenge-response. Lightest proof at 64 bytes, ~0.5M CPU. Best for casual play.
            </div>
          </div>
        )}
        {!isLocal && (
          <div className="flex-1 group relative">
            <button
              onClick={() => onChange('pedersen')}
              disabled={disabled}
              className={`w-full px-3 py-2.5 rounded-lg text-sm font-bold transition-all ${mode === 'pedersen'
                ? 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white shadow-lg scale-[1.02]'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                } disabled:opacity-50`}
            >
              <div>🔐 Pedersen</div>
              <div className="text-[10px] font-normal opacity-80 mt-0.5">224 B</div>
            </button>
            <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-56 p-2.5 bg-gray-900 text-white text-[11px] rounded-lg shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-30">
              <strong>Pedersen + Sigma Proof</strong><br />
              BLS12-381 elliptic curve commitment + Schnorr sigma proof. 224 bytes, ~1.5M CPU. Production-grade for competitive play.
            </div>
          </div>
        )}
        {isLocal && (
          <div className="flex-1 group relative">
            <button
              onClick={() => onChange('noir')}
              disabled={disabled}
              className={`w-full px-3 py-2.5 rounded-lg text-sm font-bold transition-all ${mode === 'noir'
                ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-lg scale-[1.02]'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                } disabled:opacity-50`}
            >
              <div>🌑 Noir</div>
              <div className="text-[10px] font-normal opacity-80 mt-0.5">~14 KB · Local Node ✅</div>
            </button>
            <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-56 p-2.5 bg-gray-900 text-white text-[11px] rounded-lg shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-30">
              <strong>Noir UltraKeccakHonk SNARK</strong><br />
              Full SNARK proof generated in-browser (10-30s). Split-TX verified on local node with unlimited CPU budget. Full on-chain ZK verification works!
            </div>
          </div>
        )}
      </div>
      {mode === 'nizk' && (
        <div className="mt-2 text-[11px] text-cyan-700 bg-cyan-50 border border-cyan-100 rounded-lg px-3 py-1.5">
          Hash-NIZK uses Keccak256 + Schnorr challenge-response. Lightest proof at 64 bytes.
        </div>
      )}
      {mode === 'pedersen' && (
        <div className="mt-2 text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-1.5">
          Pedersen+Sigma: BLS12-381 EC commitment + Schnorr sigma proof. ~1.5M CPU.
        </div>
      )}
      {mode === 'noir' && (
        <div className="mt-2 text-[11px] rounded-lg px-3 py-1.5 text-emerald-700 bg-emerald-50 border border-emerald-100">
          Noir UltraKeccakHonk SNARK (~14 KB) generated in-browser via @aztec/bb.js. Split-TX: TX 1 = verify_noir_seed (UltraHonk on-chain) → TX 2 = reveal_seed. Local node has unlimited CPU budget — full on-chain verification works!
        </div>
      )}
    </div>
  );
}

// ─── Player Status Card ────────────────────────────────────────────────────

function PlayerStatusCard({
  label,
  isYou,
  address,
  points,
  status,
}: {
  label: string;
  isYou: boolean;
  address: string;
  points?: bigint | number;
  status: 'committed' | 'waiting' | 'revealed' | 'locked';
}) {
  const statusBadge = {
    committed: <span className="inline-block px-3 py-1 rounded-full bg-gradient-to-r from-green-400 to-emerald-500 text-white text-xs font-bold shadow-md">✓ Committed</span>,
    waiting: <span className="inline-block px-3 py-1 rounded-full bg-gray-200 text-gray-600 text-xs font-bold">Waiting...</span>,
    revealed: <span className="inline-block px-3 py-1 rounded-full bg-gradient-to-r from-green-400 to-emerald-500 text-white text-xs font-bold shadow-md">✓ Revealed</span>,
    locked: <span className="inline-block px-3 py-1 rounded-full bg-yellow-200 text-yellow-800 text-xs font-bold">🔒 Not Revealed</span>,
  }[status];

  return (
    <div className={`p-5 rounded-xl border-2 ${isYou ? 'border-emerald-400 bg-gradient-to-br from-emerald-50 to-teal-50 shadow-lg' : 'border-gray-200 bg-white'}`}>
      <div className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-1">{label} {isYou && '(You)'}</div>
      <div className="font-mono text-sm font-semibold mb-2 text-gray-800">{address.slice(0, 8)}...{address.slice(-4)}</div>
      {points !== undefined && (
        <div className="text-xs font-semibold text-gray-600">Points: {(Number(points) / 10000000).toFixed(2)}</div>
      )}
      <div className="mt-3">{statusBadge}</div>
    </div>
  );
}
