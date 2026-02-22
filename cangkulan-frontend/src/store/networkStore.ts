import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ═══════════════════════════════════════════════════════════════════════════════
//  Network Store — switch between Testnet and Local quickstart node
// ═══════════════════════════════════════════════════════════════════════════════

export type StellarNetwork = 'testnet' | 'local';

export interface NetworkPreset {
  rpcUrl: string;
  networkPassphrase: string;
  horizonUrl: string;
  friendbotUrl: string;
  label: string;
}

export const NETWORK_PRESETS: Record<StellarNetwork, NetworkPreset> = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    friendbotUrl: 'https://friendbot.stellar.org',
    label: 'Stellar Testnet',
  },
  local: {
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: 'Standalone Network ; February 2017',
    horizonUrl: 'http://localhost:8000',
    friendbotUrl: 'http://localhost:8000/friendbot',
    label: 'Local (--limits unlimited)',
  },
};

export interface LocalContractIds {
  'mock-game-hub'?: string;
  cangkulan?: string;
  'zk-verifier'?: string;
  leaderboard?: string;
  'ultrahonk-verifier'?: string;
  [key: string]: string | undefined;
}

export interface LocalSecrets {
  admin?: string;
  player1?: string;
  player2?: string;
}

export interface NetworkState {
  /** Active network selection */
  activeNetwork: StellarNetwork;
  /** Contract IDs deployed on the local node (set by deploy-local) */
  localContractIds: LocalContractIds;
  /** Wallet secrets for local node (from deployment-local.json) */
  localSecrets: LocalSecrets;
  /** Whether local node is reachable (last probe result) */
  localNodeReachable: boolean;

  // Actions
  setActiveNetwork: (network: StellarNetwork) => void;
  setLocalContractIds: (ids: LocalContractIds) => void;
  setLocalSecrets: (secrets: LocalSecrets) => void;
  setLocalNodeReachable: (reachable: boolean) => void;
}

export const useNetworkStore = create<NetworkState>()(
  persist(
    (set) => ({
      activeNetwork: 'testnet',
      localContractIds: {},
      localSecrets: {},
      localNodeReachable: false,

      setActiveNetwork: (network) => set({ activeNetwork: network }),
      setLocalContractIds: (ids) => set({ localContractIds: ids }),
      setLocalSecrets: (secrets) => set({ localSecrets: secrets }),
      setLocalNodeReachable: (reachable) => set({ localNodeReachable: reachable }),
    }),
    {
      name: 'stellar-network-store',
      partialize: (state) => ({
        activeNetwork: state.activeNetwork,
        localContractIds: state.localContractIds,
        localSecrets: state.localSecrets,
      }),
    },
  ),
);

// ─── Convenience getters (non-reactive, for use in service constructors) ───

export function getActiveNetworkConfig(): NetworkPreset {
  const { activeNetwork } = useNetworkStore.getState();
  return NETWORK_PRESETS[activeNetwork];
}

export function getActiveNetwork(): StellarNetwork {
  return useNetworkStore.getState().activeNetwork;
}

export function isLocalNetwork(): boolean {
  return useNetworkStore.getState().activeNetwork === 'local';
}

/**
 * Get contract ID for the active network.
 * Local network uses localContractIds from the store; testnet uses env/.env values.
 */
export function getActiveContractId(crateName: string, testnetFallback: string): string {
  const state = useNetworkStore.getState();
  if (state.activeNetwork === 'local') {
    return state.localContractIds[crateName] || '';
  }
  return testnetFallback;
}

/**
 * Probe the local quickstart node to check if it's reachable.
 */
export async function probeLocalNode(): Promise<boolean> {
  try {
    const res = await fetch(NETWORK_PRESETS.local.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const reachable = data?.result?.status === 'healthy';
    useNetworkStore.getState().setLocalNodeReachable(reachable);
    return reachable;
  } catch {
    useNetworkStore.getState().setLocalNodeReachable(false);
    return false;
  }
}
