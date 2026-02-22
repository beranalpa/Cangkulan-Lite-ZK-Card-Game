/**
 * ZK Verification Badge - Dynamic component showing per-action ZK status.
 *
 * Supports multiple display modes:
 * - `summary`: Overall ZK coverage for a game session
 * - `action`: Inline badge for a specific action (seed commit, card play, etc.)
 * - `compact`: Tiny inline indicator
 *
 * The badge reflects the actual proof mode used and on-chain verification status.
 */

import type { ProofMode } from './types';

/* ---------- Proof mode metadata ---------- */

interface ProofMeta {
  label: string;
  /** Short technical description */
  detail: string;
  /** Tailwind color key (bg-*, text-*) */
  color: string;
  /** Badge background */
  bg: string;
}

const PROOF_MODES: Record<ProofMode, ProofMeta> = {
  nizk: {
    label: 'Hash-NIZK',
    detail: 'Keccak256 + Schnorr (64B proof)',
    color: 'text-blue-800',
    bg: 'bg-blue-100',
  },
  pedersen: {
    label: 'Pedersen',
    detail: 'Pedersen+Sigma (BLS12-381, 224B proof)',
    color: 'text-green-800',
    bg: 'bg-green-100',
  },
  noir: {
    label: 'Noir',
    detail: 'UltraKeccakHonk (blake2s circuit, 14KB proof)',
    color: 'text-purple-800',
    bg: 'bg-purple-100',
  },
};

/* ---------- Shield icon (shared) ---------- */

function ShieldIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
      />
    </svg>
  );
}

/* ---------- Props ---------- */

interface ZkVerificationBadgeProps {
  /** Display mode */
  variant?: 'summary' | 'action' | 'compact';
  /** Proof mode used for this action/session */
  proofMode?: ProofMode;
  /** Whether the proof was verified on-chain */
  verified?: boolean;
  /** Action label, e.g. "Seed Commit", "Card Play" (used in action variant) */
  actionLabel?: string;
  /** ZK coverage stats for summary variant */
  coverage?: {
    total: number;
    verified: number;
  };
}

export function ZkVerificationBadge({
  variant = 'compact',
  proofMode = 'pedersen',
  verified = true,
  actionLabel,
  coverage,
}: ZkVerificationBadgeProps) {
  const meta = PROOF_MODES[proofMode];

  /* --- Compact: tiny inline indicator --- */
  if (variant === 'compact') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-500">
        <span
          className={`inline-block w-2 h-2 rounded-full ${verified ? 'bg-green-500' : 'bg-gray-300'}`}
        />
        <span>
          {verified ? '🔐 ZK Verified' : 'Unverified'} ({meta.label})
        </span>
      </span>
    );
  }

  /* --- Action: per-action badge --- */
  if (variant === 'action') {
    return (
      <div
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border ${
          verified
            ? 'bg-green-50 border-green-200 text-green-700'
            : 'bg-gray-50 border-gray-200 text-gray-500'
        }`}
      >
        <ShieldIcon className={`w-3.5 h-3.5 ${verified ? 'text-green-600' : 'text-gray-400'}`} />
        {verified ? '🔐' : '🔓'}{' '}
        {actionLabel ? `${actionLabel} — ` : ''}
        <span className={`px-1 py-0.5 rounded ${meta.bg} ${meta.color} text-[10px] font-bold`}>
          {meta.label}
        </span>
      </div>
    );
  }

  /* --- Summary: full ZK coverage panel (for CompletePhase) --- */
  const pct = coverage && coverage.total > 0
    ? Math.round((coverage.verified / coverage.total) * 100)
    : 0;

  return (
    <div className="p-3 bg-gradient-to-r from-gray-50 to-slate-50 border border-gray-200 rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <ShieldIcon className="w-4 h-4 text-green-600" />
        <span className="text-xs font-bold text-gray-700">Zero-Knowledge Coverage</span>
        {coverage && (
          <span className="ml-auto text-xs font-mono text-green-700">
            {coverage.verified}/{coverage.total} ({pct}%)
          </span>
        )}
      </div>

      <div className="space-y-1">
        {Object.entries(PROOF_MODES).map(([key, m]) => (
          <div key={key} className="flex items-center gap-2">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${m.bg} ${m.color}`}
            >
              {m.label}
            </span>
            <span className="text-[11px] text-gray-600">{m.detail}</span>
            {proofMode === key && (
              <span className="text-[10px] text-green-600 font-semibold">● Active</span>
            )}
          </div>
        ))}
      </div>

      {coverage && (
        <div className="mt-2">
          <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      <p className="text-[10px] text-gray-400 mt-1.5">
        Every card play and seed reveal is verified through on-chain ZK proofs.
        Coverage indicates the percentage of actions with cryptographic verification.
      </p>
    </div>
  );
}

/* ---------- Inline helper for trick-level badge ---------- */

export function ZkTrickBadge({ verified }: { verified?: boolean }) {
  if (!verified) return null;
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded-full">
      🔐 ZK
    </span>
  );
}
