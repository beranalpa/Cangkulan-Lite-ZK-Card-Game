import { useCallback, useEffect, useRef } from 'react';
import { useWalletStore } from '../store/walletSlice';
import { devWalletService, DevWalletService } from '../services/devWalletService';
import { connectViaKit, disconnectKit, getKitSigner, getWalletName, getWalletIcon, reconnectWallet } from '../services/walletKitService';
import { NETWORK, NETWORK_PASSPHRASE, RPC_URL, getActiveHorizonUrl, getActiveFriendbotUrl } from '../utils/constants';
import type { ContractSigner } from '../types/signer';
import { log } from '@/utils/logger';

// ─── Balance helpers ───────────────────────────────────────────────────────

const BALANCE_POLL_MS = 30_000; // 30 s

async function fetchXlmBalance(address: string): Promise<string | null> {
  try {
    // Use Horizon for balance (RPC is Soroban-only)
    const horizonUrl = getActiveHorizonUrl();
    const res = await fetch(`${horizonUrl}/accounts/${address}`);
    if (!res.ok) return null;
    const data = await res.json();
    const native = (data.balances as any[])?.find((b: any) => b.asset_type === 'native');
    if (!native) return '0';
    // Format: remove excessive decimals
    const val = parseFloat(native.balance);
    return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return null;
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useWallet() {
  const {
    publicKey,
    walletId,
    walletType,
    walletIcon,
    isConnected,
    isConnecting,
    balanceXlm,
    network,
    networkPassphrase,
    error,
    setWallet,
    setConnecting,
    setNetwork,
    setBalance,
    setError,
    disconnect: storeDisconnect,
  } = useWalletStore();

  const balanceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttempted = useRef(false);

  // ── Auto-reconnect real wallets on mount ─────────────────────────────
  useEffect(() => {
    if (reconnectAttempted.current) return;
    reconnectAttempted.current = true;

    const store = useWalletStore.getState();
    // Only attempt if we have a persisted real wallet that isn't already connected
    if (store.walletType === 'wallet' && store.walletId && store.publicKey && !store.isConnected) {
      (async () => {
        try {
          const addr = await reconnectWallet(store.walletId!);
          if (addr) {
            const icon = getWalletIcon();
            store.setWallet(addr, store.walletId!, 'wallet', icon);
            store.setNetwork(NETWORK, NETWORK_PASSPHRASE);
            log.info('Auto-reconnected wallet');
          } else {
            // Silently clear persisted state — wallet extension probably not available
            store.disconnect();
          }
        } catch {
          store.disconnect();
        }
      })();
    }
  }, []);

  // ── Balance polling ──────────────────────────────────────────────────
  useEffect(() => {
    // Clear any existing timer
    if (balanceTimerRef.current) {
      clearInterval(balanceTimerRef.current);
      balanceTimerRef.current = null;
    }

    if (!isConnected || !publicKey) {
      setBalance(null);
      return;
    }

    // Fetch immediately then poll
    const doFetch = () => {
      fetchXlmBalance(publicKey).then(setBalance);
    };
    doFetch();
    balanceTimerRef.current = setInterval(doFetch, BALANCE_POLL_MS);

    return () => {
      if (balanceTimerRef.current) {
        clearInterval(balanceTimerRef.current);
        balanceTimerRef.current = null;
      }
    };
  }, [isConnected, publicKey, setBalance]);

  /**
   * Connect via Stellar Wallets Kit modal (Freighter, HOT Wallet, Hana, Klever)
   */
  const connectWallet = useCallback(async () => {
    try {
      setConnecting(true);
      setError(null);

      const { address, walletId: wId } = await connectViaKit();
      const icon = getWalletIcon();

      setWallet(address, wId, 'wallet', icon);
      setNetwork(NETWORK, NETWORK_PASSPHRASE);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to connect wallet';
      setError(errorMessage);
      log.error('Wallet connection error:', err);
      throw err;
    } finally {
      setConnecting(false);
    }
  }, [setWallet, setConnecting, setNetwork, setError]);

  /**
   * Connect as a dev player (for testing)
   * DEV MODE ONLY - Not used in production
   */
  const connectDev = useCallback(
    async (playerNumber: 1 | 2) => {
      try {
        setConnecting(true);
        setError(null);

        await devWalletService.initPlayer(playerNumber);
        const address = devWalletService.getPublicKey();

        // Update store with dev wallet
        setWallet(address, `dev-player${playerNumber}`, 'dev');
        setNetwork(NETWORK, NETWORK_PASSPHRASE);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to connect dev wallet';
        setError(errorMessage);
        log.error('Dev wallet connection error:', err);
        throw err;
      } finally {
        setConnecting(false);
      }
    },
    [setWallet, setConnecting, setNetwork, setError]
  );

  /**
   * Switch between dev players
   * DEV MODE ONLY - Not used in production
   */
  const switchPlayer = useCallback(
    async (playerNumber: 1 | 2) => {
      if (walletType !== 'dev') {
        throw new Error('Can only switch players in dev mode');
      }

      try {
        setConnecting(true);
        setError(null);

        await devWalletService.switchPlayer(playerNumber);
        const address = devWalletService.getPublicKey();

        // Update store with new player
        setWallet(address, `dev-player${playerNumber}`, 'dev');
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to switch player';
        setError(errorMessage);
        log.error('Player switch error:', err);
        throw err;
      } finally {
        setConnecting(false);
      }
    },
    [walletType, setWallet, setConnecting, setError]
  );

  /**
   * Disconnect wallet
   */
  const disconnect = useCallback(async () => {
    if (walletType === 'dev') {
      devWalletService.disconnect();
    } else if (walletType === 'wallet') {
      await disconnectKit();
    }
    storeDisconnect();
  }, [walletType, storeDisconnect]);

  /**
   * Get a signer for contract interactions
   * Returns functions that the Stellar SDK TS bindings can use for signing
   */
  const getContractSigner = useCallback((): ContractSigner => {
    if (!isConnected || !publicKey || !walletType) {
      throw new Error('Wallet not connected');
    }

    if (walletType === 'dev') {
      // Defensive: ensure dev service is initialized even if auto-reconnect
      // hasn't finished yet (zustand restores state before async init completes)
      if (!devWalletService.getCurrentPlayer() && walletId) {
        const playerNum = walletId === 'dev-player1' ? 1 : walletId === 'dev-player2' ? 2 : null;
        if (playerNum) {
          // Synchronous-safe: initPlayer sets keypair from env vars (no network)
          // but it's async, so we throw a clear message if not ready
          throw new Error('Dev wallet reconnecting — please try again in a moment');
        }
      }
      return devWalletService.getSigner();
    } else if (walletType === 'wallet') {
      return getKitSigner(publicKey);
    } else {
      throw new Error('Unknown wallet type');
    }
  }, [isConnected, publicKey, walletType, walletId]);

  /**
   * Get the human-readable name of the connected wallet
   */
  const getConnectedWalletName = useCallback((): string => {
    if (walletType === 'dev') {
      return `Dev Player ${devWalletService.getCurrentPlayer()}`;
    }
    if (walletType === 'wallet') {
      return getWalletName();
    }
    return 'Not connected';
  }, [walletType]);

  /**
   * Check if dev mode is available
   */
  const isDevModeAvailable = useCallback(() => {
    return DevWalletService.isDevModeAvailable();
  }, []);

  /**
   * Check if a specific dev player is available
   */
  const isDevPlayerAvailable = useCallback((playerNumber: 1 | 2) => {
    return DevWalletService.isPlayerAvailable(playerNumber);
  }, []);

  /**
   * Get current dev player number
   */
  const getCurrentDevPlayer = useCallback(() => {
    if (walletType !== 'dev') {
      return null;
    }
    return devWalletService.getCurrentPlayer();
  }, [walletType]);

  /**
   * Fund the current testnet account via Friendbot.
   * Returns true on success.
   */
  const fundTestnet = useCallback(async (): Promise<boolean> => {
    if (!publicKey) return false;
    try {
      const res = await fetch(`${getActiveFriendbotUrl()}?addr=${publicKey}`);
      if (res.ok) {
        // Refresh balance after funding
        const bal = await fetchXlmBalance(publicKey);
        setBalance(bal);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [publicKey, setBalance]);

  return {
    // State
    publicKey,
    walletId,
    walletType,
    walletIcon,
    isConnected,
    isConnecting,
    balanceXlm,
    network,
    networkPassphrase,
    error,

    // Actions
    connectWallet,
    connectDev,
    switchPlayer,
    disconnect,
    getContractSigner,
    getConnectedWalletName,
    fundTestnet,
    isDevModeAvailable,
    isDevPlayerAvailable,
    getCurrentDevPlayer,
  };
}
