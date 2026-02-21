import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WalletState {
  // Wallet connection
  publicKey: string | null;
  walletId: string | null; // ID of the connected wallet
  walletType: 'dev' | 'wallet' | null; // Track if dev wallet or real wallet
  walletIcon: string | null; // URL of the wallet icon
  isConnected: boolean;
  isConnecting: boolean;

  // Balance
  balanceXlm: string | null; // XLM balance as formatted string

  // Network info
  network: string | null;
  networkPassphrase: string | null;

  // Error handling
  error: string | null;

  // Actions
  setWallet: (publicKey: string, walletId: string, walletType: 'dev' | 'wallet', walletIcon?: string | null) => void;
  setPublicKey: (publicKey: string) => void;
  setConnected: (connected: boolean) => void;
  setConnecting: (connecting: boolean) => void;
  setNetwork: (network: string, networkPassphrase: string) => void;
  setBalance: (balanceXlm: string | null) => void;
  setError: (error: string | null) => void;
  disconnect: () => void;
  reset: () => void;
}

const initialState = {
  publicKey: null,
  walletId: null,
  walletType: null,
  walletIcon: null,
  isConnected: false,
  isConnecting: false,
  balanceXlm: null,
  network: null,
  networkPassphrase: null,
  error: null,
};

export const useWalletStore = create<WalletState>()(
  persist(
    (set) => ({
      ...initialState,

      setWallet: (publicKey, walletId, walletType, walletIcon) =>
        set({
          publicKey,
          walletId,
          walletType,
          walletIcon: walletIcon ?? null,
          isConnected: true,
          isConnecting: false,
          error: null,
        }),

      setPublicKey: (publicKey) =>
        set({
          publicKey,
          isConnected: true,
          isConnecting: false,
          error: null,
        }),

      setConnected: (connected) =>
        set({
          isConnected: connected,
          isConnecting: false,
        }),

      setConnecting: (connecting) =>
        set({
          isConnecting: connecting,
          error: null,
        }),

      setNetwork: (network, networkPassphrase) =>
        set({
          network,
          networkPassphrase,
        }),

      setBalance: (balanceXlm) =>
        set({ balanceXlm }),

      setError: (error) =>
        set({
          error,
          isConnecting: false,
        }),

      disconnect: () =>
        set({
          ...initialState,
        }),

      reset: () => set(initialState),
    }),
    {
      name: 'cangkulan-wallet',
      partialize: (state) => ({
        // Persist connection info for both dev and real wallets.
        // Real wallets will attempt silent auto-reconnect on load.
        publicKey: state.publicKey,
        walletId: state.walletId,
        walletType: state.walletType,
        walletIcon: state.walletIcon,
        isConnected: state.walletType === 'dev' ? state.isConnected : false,
        network: state.network,
        networkPassphrase: state.networkPassphrase,
      }),
    },
  ),
);
