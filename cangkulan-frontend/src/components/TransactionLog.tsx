import { useState } from 'react';
import { useNetworkStore } from '@/store/networkStore';
import { getStellarExpertLink } from '@/utils/constants';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface TxRecord {
  id: string;
  action: string;
  txHash: string;
  timestamp: number;
  player?: string;
  detail?: string;
}

const STELLAR_EXPERT_BASE = 'https://stellar.expert/explorer/testnet/tx';

// ═══════════════════════════════════════════════════════════════════════════════
//  Hook
// ═══════════════════════════════════════════════════════════════════════════════

export function useTransactionLog() {
  const [txLog, setTxLog] = useState<TxRecord[]>([]);

  const addTx = (action: string, txHash: string, player?: string, detail?: string) => {
    if (!txHash) return;
    setTxLog(prev => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        action,
        txHash,
        timestamp: Date.now(),
        player,
        detail,
      },
      ...prev,
    ]);
  };

  const clearLog = () => setTxLog([]);

  return { txLog, addTx, clearLog };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Action Labels (icons + descriptions)
// ═══════════════════════════════════════════════════════════════════════════════

const ACTION_META: Record<string, { icon: string; color: string }> = {
  'Start Game': { icon: '🎮', color: 'text-emerald-700' },
  'Commit Seed': { icon: '🔐', color: 'text-blue-700' },
  'Reveal Seed': { icon: '🔓', color: 'text-purple-700' },
  'Play Card': { icon: '🃏', color: 'text-amber-700' },
  'Cannot Follow': { icon: '🔄', color: 'text-orange-700' },
  'Tick Timeout': { icon: '⏱️', color: 'text-orange-700' },
  'Resolve Timeout': { icon: '⏰', color: 'text-red-700' },
};

function getActionMeta(action: string) {
  return ACTION_META[action] || { icon: '📝', color: 'text-gray-700' };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Component
// ═══════════════════════════════════════════════════════════════════════════════

export function TransactionLog({
  txLog,
  onClear,
  currentUser,
}: {
  txLog: TxRecord[];
  onClear: () => void;
  /** When set, only show entries from this address (dev wallet switching privacy). */
  currentUser?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const isLocalNetwork = useNetworkStore(s => s.activeNetwork === 'local');

  // Filter to current wallet — prevents leaking opponent card labels during dev wallet switching
  const visibleLog = currentUser
    ? txLog.filter(tx => !tx.player || tx.player === currentUser)
    : txLog;

  if (visibleLog.length === 0) return null;

  return (
    <div className="mt-6 border-2 border-indigo-200 rounded-xl overflow-hidden bg-gradient-to-b from-indigo-50/50 to-white">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gradient-to-r from-indigo-100 to-purple-100 hover:from-indigo-200 hover:to-purple-200 transition-colors border-0 rounded-none"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">🔗</span>
          <span className="text-sm font-bold text-indigo-900">
            On-Chain Transaction Proof
          </span>
          <span className="text-xs bg-indigo-200 text-indigo-800 rounded-full px-2 py-0.5 font-bold">
            {visibleLog.length}
          </span>
        </div>
        <span className="text-xs text-indigo-600 font-mono">
          {expanded ? '▲ collapse' : '▼ expand'}
        </span>
      </button>

      {/* Body */}
      {expanded && (
        <div className="px-4 py-3 space-y-2 max-h-64 overflow-y-auto">
          {visibleLog.map((tx) => {
            const meta = getActionMeta(tx.action);
            const shortHash = `${tx.txHash.slice(0, 8)}…${tx.txHash.slice(-8)}`;
            const time = new Date(tx.timestamp).toLocaleTimeString();

            return (
              <div
                key={tx.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white border border-gray-100 hover:border-indigo-200 hover:shadow-sm transition-all text-sm"
              >
                {/* Icon */}
                <span className="text-lg shrink-0">{meta.icon}</span>

                {/* Action + Detail */}
                <div className="flex-1 min-w-0">
                  <span className={`font-bold ${meta.color}`}>{tx.action}</span>
                  {tx.detail && (
                    <span className="text-gray-500 ml-1.5">{tx.detail}</span>
                  )}
                  {tx.player && (
                    <span className="text-gray-400 ml-1.5 text-xs font-mono">
                      ({tx.player.slice(0, 4)}…{tx.player.slice(-4)})
                    </span>
                  )}
                </div>

                {/* Time */}
                <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">
                  {time}
                </span>

                {/* Stellar Expert Link (only on Testnet or when URL is available) */}
                {(() => {
                  const explorerLink = getStellarExpertLink('tx', tx.txHash);
                  if (explorerLink) {
                    return (
                      <a
                        href={explorerLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-mono transition-colors border border-indigo-200 no-underline"
                        title={`View on Stellar Expert: ${tx.txHash}`}
                      >
                        <span>{shortHash}</span>
                        <span className="text-indigo-400">↗</span>
                      </a>
                    );
                  }
                  return (
                    <span
                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-gray-50 text-gray-500 text-xs font-mono border border-gray-200"
                      title="Local Node Tx: No explorer available"
                    >
                      {shortHash}
                    </span>
                  );
                })()}
              </div>
            );
          })}

          {/* Clear */}
          <div className="text-center pt-1">
            <button
              onClick={onClear}
              className="text-xs text-gray-400 hover:text-gray-600 underline px-2 py-1 bg-transparent border-0 shadow-none"
            >
              Clear log
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
