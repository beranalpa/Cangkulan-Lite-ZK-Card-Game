import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { CangkulanService } from '../cangkulanService';
import { CANGKULAN_CONTRACT, getActiveCangkulanContract } from '@/utils/constants';
import { useNetworkStore, probeLocalNode, NETWORK_PRESETS, type StellarNetwork } from '@/store/networkStore';
import type { AppRoute } from '@/hooks/useHashRouter';
import type { ProofMode, GameState } from '../types';

const CangkulanGame = lazy(() => import('../CangkulanGame').then(m => ({ default: m.CangkulanGame })));

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Contract Inspector
// ═══════════════════════════════════════════════════════════════════════════════

function ContractInspector() {
  const [sessionId, setSessionId] = useState('');
  const [gameState, setGameState] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeNetwork = useNetworkStore(s => s.activeNetwork);

  const service = new CangkulanService(getActiveCangkulanContract());

  const loadState = async () => {
    const sid = parseInt(sessionId, 10);
    if (!sid || sid <= 0) { setError('Invalid session ID'); return; }
    setLoading(true);
    setError(null);
    try {
      const state = await service.getGame(sid);
      setGameState(state);
    } catch (err) {
      setError(String(err));
      setGameState(null);
    } finally {
      setLoading(false);
    }
  };

  const lifecycleLabel = (lc: number) => {
    switch (lc) {
      case 1: return '🌱 Seed Commit';
      case 2: return '🔓 Seed Reveal';
      case 3: return '🎴 Playing';
      case 4: return '🏁 Finished';
      default: return `Unknown (${lc})`;
    }
  };

  return (
    <div className="card space-y-3">
      <h4 className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>🔍 Contract Inspector</h4>
      <div className="flex gap-2">
        <input
          type="number"
          value={sessionId}
          onChange={e => setSessionId(e.target.value)}
          placeholder="Session ID"
          className="flex-1 px-3 py-2 rounded-lg text-sm bg-gray-100 dark:bg-gray-700 font-mono"
          style={{ color: 'var(--color-ink)' }}
        />
        <button
          onClick={loadState}
          disabled={loading}
          className="px-4 py-2 rounded-lg text-sm font-bold bg-amber-500 text-white hover:bg-amber-600 transition-colors disabled:opacity-50"
        >
          {loading ? '...' : 'Load'}
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {gameState && (
        <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 text-xs font-mono space-y-1" style={{ color: 'var(--color-ink)' }}>
          <div><span className="text-gray-500">Lifecycle:</span> {lifecycleLabel(gameState.lifecycle_state)}</div>
          <div><span className="text-gray-500">Player 1:</span> {gameState.player1?.slice(0, 12)}...</div>
          <div><span className="text-gray-500">Player 2:</span> {gameState.player2?.slice(0, 12)}...</div>
          <div><span className="text-gray-500">Tricks:</span> P1={gameState.tricks_won1} P2={gameState.tricks_won2}</div>
          <div><span className="text-gray-500">Outcome:</span> {gameState.outcome === 0 ? 'Unresolved' : gameState.outcome === 1 ? 'P1 Win' : gameState.outcome === 2 ? 'P2 Win' : 'Draw'}</div>
          <div><span className="text-gray-500">Seed P1:</span> {gameState.seed_commit1 ? '✅ Committed' : '❌'} {gameState.seed_revealed1 ? '/ ✅ Revealed' : ''}</div>
          <div><span className="text-gray-500">Seed P2:</span> {gameState.seed_commit2 ? '✅ Committed' : '❌'} {gameState.seed_revealed2 ? '/ ✅ Revealed' : ''}</div>
          <details className="mt-2">
            <summary className="cursor-pointer text-blue-500 hover:underline">Raw JSON</summary>
            <pre className="mt-1 p-2 rounded bg-gray-100 dark:bg-gray-900 overflow-x-auto text-[10px] max-h-48">
              {JSON.stringify(gameState, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DevTestingPage — ZK mode tester, inspector, quickstart
// ═══════════════════════════════════════════════════════════════════════════════

interface DevTestingPageProps {
  userAddress: string;
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}

export function DevTestingPage({ userAddress, navigate, onBack }: DevTestingPageProps) {
  const { connectDev, switchPlayer, walletType, walletId } = useWallet();
  const [showGame, setShowGame] = useState(false);
  const [selectedZkMode, setSelectedZkMode] = useState<ProofMode>('nizk');

  // Network store
  const activeNetwork = useNetworkStore(s => s.activeNetwork);
  const localNodeReachable = useNetworkStore(s => s.localNodeReachable);
  const setActiveNetwork = useNetworkStore(s => s.setActiveNetwork);
  const localContractIds = useNetworkStore(s => s.localContractIds);
  const setLocalContractIds = useNetworkStore(s => s.setLocalContractIds);
  const setLocalSecrets = useNetworkStore(s => s.setLocalSecrets);
  const [probing, setProbing] = useState(false);
  const [autoImportStatus, setAutoImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isLocal = activeNetwork === 'local';
  const hasLocalContracts = !!localContractIds.cangkulan;

  // Sync selectedZkMode based on active network rules
  useEffect(() => {
    if (activeNetwork === 'local') {
      setSelectedZkMode('noir');
    } else if (activeNetwork === 'testnet' && selectedZkMode === 'noir') {
      setSelectedZkMode('nizk');
    }
  }, [activeNetwork, selectedZkMode]);

  // Probe local node on mount and when switching to local
  useEffect(() => {
    probeLocalNode();
  }, []);

  // Auto-import deployment-local.json on mount when local is active and no contracts set
  useEffect(() => {
    if (hasLocalContracts) return;
    const tryAutoImport = async () => {
      try {
        // Try fetching from Vite dev server (repo root or public/)
        const res = await fetch('/deployment-local.json', { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return;
        const data = await res.json();
        const ids = data.contracts || data;
        if (typeof ids === 'object' && ids.cangkulan) {
          setLocalContractIds(ids);
          // Also save wallet secrets if present
          if (data.secrets) {
            setLocalSecrets(data.secrets);
          }
          setAutoImportStatus('✅ Auto-imported from deployment-local.json');
        }
      } catch { /* file not available — user can paste manually */ }
    };
    tryAutoImport();
  }, [hasLocalContracts, setLocalContractIds, setLocalSecrets]);

  const handleProbeLocal = useCallback(async () => {
    setProbing(true);
    await probeLocalNode();
    setProbing(false);
  }, []);

  const handleNetworkSwitch = useCallback(async (network: StellarNetwork) => {
    if (network === 'local') {
      setProbing(true);
      const reachable = await probeLocalNode();
      setProbing(false);
      if (!reachable) {
        // Still switch but warn — user might start the node after
      }
    }
    setActiveNetwork(network);
    // Force page refresh to re-create service instances with new network
    setShowGame(false);
    // Re-init dev wallet with correct network secrets
    if (walletType === 'dev') {
      const currentPlayer = walletId === 'dev-player1' ? 1 : walletId === 'dev-player2' ? 2 : null;
      if (currentPlayer) {
        try { await connectDev(currentPlayer); } catch { /* will need manual reconnect */ }
      }
    }
  }, [setActiveNetwork, walletType, walletId, connectDev]);

  const handleSwitchPlayer = useCallback(async (player: 1 | 2) => {
    try {
      if (walletType === 'dev') {
        await switchPlayer(player);
      } else {
        await connectDev(player);
      }
    } catch (err) {
      console.error('Switch failed:', err);
    }
  }, [walletType, switchPlayer, connectDev]);

  // Parse contract IDs + secrets from paste (deployment-local.json format)
  const handlePasteLocalIds = useCallback((text: string) => {
    try {
      const parsed = JSON.parse(text);
      const ids = parsed.contracts || parsed;
      if (typeof ids === 'object' && ids.cangkulan) {
        setLocalContractIds(ids);
        // Also save wallet secrets if present
        if (parsed.secrets) {
          setLocalSecrets(parsed.secrets);
        }
        setAutoImportStatus('✅ Contract IDs loaded');
      }
    } catch { /* ignore invalid JSON */ }
  }, [setLocalContractIds, setLocalSecrets]);

  // Import from file picker
  const handleFileImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        handlePasteLocalIds(reader.result);
      }
    };
    reader.readAsText(file);
  }, [handlePasteLocalIds]);

  if (showGame) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-3">
          <button
            onClick={() => setShowGame(false)}
            className="text-sm font-medium hover:underline"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            ← Back to Dev Tools
          </button>
          {isLocal && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              LOCAL NODE — unlimited CPU
            </span>
          )}
        </div>
        <Suspense fallback={<PageLoader />}>
          <CangkulanGame
            userAddress={userAddress}
            availablePoints={1000000000n}
            onStandingsRefresh={() => { }}
            onGameComplete={() => setShowGame(false)}
            navigate={navigate}
            gameMode="dev"
            autoQuickstart={true}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="text-sm font-medium hover:underline"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        ← Back to Mode Select
      </button>

      <div className="text-center">
        <h2 className="text-2xl font-bold gradient-text">🔧 Dev Testing</h2>
        <p className="text-xs mt-1" style={{ color: 'var(--color-ink-muted)' }}>
          Wallet testing, ZK mode selection, contract inspection
        </p>
      </div>

      {/* ── Network Switcher ────────────────────────────────────────────── */}
      <div className="card space-y-3">
        <h4 className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>🌐 Network</h4>
        <div className="flex gap-2">
          <button
            onClick={() => handleNetworkSwitch('testnet')}
            className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${!isLocal ? 'bg-blue-600 text-white shadow-lg' : 'bg-gray-100 dark:bg-gray-700'
              }`}
            style={isLocal ? { color: 'var(--color-ink-muted)' } : undefined}
          >
            🌍 Testnet
          </button>
          <button
            onClick={() => handleNetworkSwitch('local')}
            className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${isLocal ? 'bg-emerald-600 text-white shadow-lg' : 'bg-gray-100 dark:bg-gray-700'
              }`}
            style={!isLocal ? { color: 'var(--color-ink-muted)' } : undefined}
          >
            🖥️ Local Node
          </button>
        </div>

        {/* Network status */}
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          <span className={`inline-block w-2 h-2 rounded-full ${isLocal
            ? localNodeReachable ? 'bg-emerald-500' : 'bg-red-500'
            : 'bg-blue-500'
            }`} />
          {isLocal ? (
            localNodeReachable
              ? <span className="text-emerald-600 dark:text-emerald-400 font-medium">Local node healthy — <code className="text-[10px]">--limits unlimited</code></span>
              : <span className="text-red-500 font-medium">Local node not reachable</span>
          ) : (
            <span>Connected to Stellar Testnet</span>
          )}
          {isLocal && (
            <button onClick={handleProbeLocal} disabled={probing} className="ml-auto text-blue-500 hover:underline text-[10px]">
              {probing ? '...' : '↻ Re-check'}
            </button>
          )}
        </div>

        {/* RPC endpoint */}
        <div className="text-[10px] font-mono p-1.5 rounded bg-gray-100 dark:bg-gray-800/50 truncate" style={{ color: 'var(--color-ink-muted)' }}>
          RPC: {NETWORK_PRESETS[activeNetwork].rpcUrl}
        </div>

        {/* Local node: contract IDs */}
        {isLocal && !hasLocalContracts && (
          <div className="p-2.5 rounded-lg text-xs bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30">
            <p className="font-semibold text-amber-700 dark:text-amber-400 mb-1">⚠️ No local contract IDs configured</p>
            <p style={{ color: 'var(--color-ink-muted)' }}>
              Deploy contracts to your local node first, then paste the <code className="text-[10px]">deployment-local.json</code> contents below:
            </p>
            <textarea
              className="mt-2 w-full p-2 rounded text-[10px] font-mono bg-gray-100 dark:bg-gray-800 border"
              style={{ color: 'var(--color-ink)', borderColor: 'var(--color-border)' }}
              rows={4}
              placeholder='Paste deployment-local.json content here...'
              onPaste={e => handlePasteLocalIds(e.clipboardData.getData('text'))}
              onChange={e => handlePasteLocalIds(e.target.value)}
            />
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 rounded-lg text-[10px] font-bold bg-amber-500 text-white hover:bg-amber-600 transition-colors"
              >
                📁 Import from file
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleFileImport}
              />
            </div>
          </div>
        )}

        {isLocal && hasLocalContracts && (
          <div className="space-y-1.5">
            {autoImportStatus && (
              <div className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">{autoImportStatus}</div>
            )}
            <div className="text-[10px] font-mono space-y-0.5" style={{ color: 'var(--color-ink-muted)' }}>
              {Object.entries(localContractIds).map(([k, v]) => v && (
                <div key={k} className="truncate"><span className="text-gray-500">{k}:</span> {v}</div>
              ))}
            </div>
            <button
              onClick={() => { setLocalContractIds({}); setAutoImportStatus(null); }}
              className="text-[10px] text-red-500 hover:underline"
            >
              ✕ Clear local contract IDs
            </button>
          </div>
        )}


      </div>

      {/* Quick Wallet Switch */}
      <div className="card">
        <h4 className="text-sm font-bold mb-2" style={{ color: 'var(--color-ink)' }}>Quick Wallet Switch</h4>
        <div className="flex gap-2">
          <button
            onClick={() => handleSwitchPlayer(1)}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-blue-500 to-cyan-500 text-white hover:shadow-lg transition-all"
          >
            👤 Player 1
          </button>
          <button
            onClick={() => handleSwitchPlayer(2)}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-pink-500 to-rose-500 text-white hover:shadow-lg transition-all"
          >
            👤 Player 2
          </button>
        </div>
        <p className="text-[10px] mt-1.5 font-mono truncate" style={{ color: 'var(--color-ink-muted)' }}>
          Current: {userAddress || 'Not connected'}
        </p>
      </div>

      {/* ZK Mode Quick Launch */}
      <div className="card space-y-3">
        <h4 className="text-sm font-bold" style={{ color: 'var(--color-ink)' }}>ZK Mode Quick Launch</h4>
        <p className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          Select a ZK proof mode, then start a quickstart game with that mode.
        </p>
        <div className="flex gap-2 flex-wrap">
          {(isLocal ? (['noir'] as const) : (['nizk', 'pedersen'] as const)).map(mode => (
            <button
              key={mode}
              onClick={() => setSelectedZkMode(mode)}
              className={`px-3 py-2 rounded-xl text-sm font-semibold transition-all ${selectedZkMode === mode
                ? mode === 'noir' ? 'bg-violet-600 text-white shadow-lg' : 'bg-amber-500 text-white shadow-lg'
                : 'bg-gray-100 dark:bg-gray-700'
                }`}
              style={selectedZkMode !== mode ? { color: 'var(--color-ink-muted)' } : undefined}
            >
              {mode === 'nizk' ? '#️⃣ NIZK (64B)' : mode === 'pedersen' ? '🔐 Pedersen (224B)' : '🌑 Noir (~14KB)'}
            </button>
          ))}
        </div>

        <div className={`p-2.5 rounded-lg text-xs border ${selectedZkMode === 'noir'
          ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-700/30'
          : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700/30'
          }`}>
          {selectedZkMode === 'nizk' && (
            <>
              <p className="font-semibold text-amber-700 dark:text-amber-300 mb-1">
                #️⃣ NIZK — Testnet
              </p>
              <p style={{ color: 'var(--color-ink-muted)' }}>
                Non-Interactive Zero-Knowledge (NIZK) Proof (64 bytes). Uses standard keccak256 commitments with signature verification. Very fast computation, tiny proof size, fully verified on-chain.
              </p>
            </>
          )}
          {selectedZkMode === 'pedersen' && (
            <>
              <p className="font-semibold text-amber-700 dark:text-amber-300 mb-1">
                🔐 Pedersen — Testnet
              </p>
              <p style={{ color: 'var(--color-ink-muted)' }}>
                Pedersen Commitments + Schnorr Proofs (224 bytes). Uses elliptic curve cryptography. Fast generation, small size, fully verified on-chain.
              </p>
            </>
          )}
          {selectedZkMode === 'noir' && (
            <>
              <p className="font-semibold text-emerald-700 dark:text-emerald-300 mb-1">
                🌑 Noir — Local Node (Unlimited CPU) ✅
              </p>
              <p style={{ color: 'var(--color-ink-muted)' }}>
                Noir UltraKeccakHonk SNARK (~14 KB) generated in-browser via @aztec/bb.js. Split-TX: TX 1 = verify_noir_seed (UltraHonk on-chain) → TX 2 = reveal_seed. Local node has unlimited CPU budget — full on-chain verification works!
              </p>
            </>
          )}
        </div>
        <button
          onClick={() => setShowGame(true)}
          disabled={isLocal && !hasLocalContracts}
          className={`w-full py-2.5 rounded-xl text-sm font-bold text-white hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed ${selectedZkMode === 'noir'
            ? isLocal && localNodeReachable
              ? 'bg-gradient-to-r from-emerald-600 to-teal-700'
              : 'bg-gradient-to-r from-violet-600 to-purple-700'
            : 'bg-gradient-to-r from-amber-500 to-orange-600'
            }`}
        >
          ▶ Start Quickstart Game ({selectedZkMode.toUpperCase()}
          {selectedZkMode === 'noir'
            ? isLocal && localNodeReachable ? ' — Local ✅' : !isLocal ? ' — Testnet ⚠️' : ''
            : ''}
          )
        </button>
      </div>

      {/* Contract Inspector */}
      <ContractInspector />


    </div>
  );
}
