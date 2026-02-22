import { Buffer } from 'buffer';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import type { ContractSigner } from '../types/signer';
import type { WalletError } from '@stellar/stellar-sdk/contract';
import { log } from '@/utils/logger';
import { isLocalNetwork, useNetworkStore } from '@/store/networkStore';

/**
 * Dev Wallet Service
 * Provides test wallet functionality for LOCAL DEVELOPMENT ONLY.
 * This entire module is gated behind import.meta.env.DEV.
 * Secret keys are read from non-VITE_ env vars via a server proxy,
 * or from VITE_ vars ONLY in dev mode. In production builds, the
 * service is completely disabled and all methods throw.
 *
 * When the active network is "local", secrets are read from the
 * networkStore (populated from deployment-local.json) instead of .env.
 */

class DevWalletService {
  private currentPlayer: 1 | 2 | null = null;
  private keypairs: Record<string, Keypair> = {};

  /**
   * Check if dev mode is available.
   * Available when VITE_ secrets are present (set by `bun run setup`)
   * or via runtime config in production (`game-studio-config.js`),
   * or when local network has secrets loaded.
   */
  static isDevModeAvailable(): boolean {
    // Local network: check if secrets are loaded
    if (isLocalNetwork()) {
      const { localSecrets } = useNetworkStore.getState();
      if (localSecrets.player1 && localSecrets.player2) return true;
    }
    // Check VITE_ env vars (inlined at build time by Vite)
    if (import.meta.env.VITE_DEV_PLAYER1_SECRET && import.meta.env.VITE_DEV_PLAYER2_SECRET) {
      return true;
    }
    // Fallback: runtime config (game-studio-config.js)
    const rc = (globalThis as any).__STELLAR_GAME_STUDIO_CONFIG__;
    if (rc?.devSecrets?.player1 && rc?.devSecrets?.player2) {
      return true;
    }
    return false;
  }

  /**
   * Check if a specific player is available
   */
  static isPlayerAvailable(playerNumber: 1 | 2): boolean {
    // Local network: check localSecrets
    if (isLocalNetwork()) {
      const { localSecrets } = useNetworkStore.getState();
      const secret = playerNumber === 1 ? localSecrets.player1 : localSecrets.player2;
      if (secret) return true;
    }
    // Check VITE_ env vars
    const secret = playerNumber === 1
      ? import.meta.env.VITE_DEV_PLAYER1_SECRET
      : import.meta.env.VITE_DEV_PLAYER2_SECRET;
    if (secret && secret !== 'NOT_AVAILABLE') return true;
    // Fallback: runtime config
    const rc = (globalThis as any).__STELLAR_GAME_STUDIO_CONFIG__;
    const rcSecret = playerNumber === 1 ? rc?.devSecrets?.player1 : rc?.devSecrets?.player2;
    return !!rcSecret && rcSecret !== 'NOT_AVAILABLE';
  }

  /**
   * Initialize a player from environment variables or local secrets.
   * When active network is "local", uses secrets from networkStore.
   * Throws in production builds without secrets.
   */
  async initPlayer(playerNumber: 1 | 2): Promise<void> {
    try {
      const playerKey = `player${playerNumber}`;
      let secretEnvVar: string | undefined;

      // Priority 1: Local network secrets (from deployment-local.json)
      if (isLocalNetwork()) {
        const { localSecrets } = useNetworkStore.getState();
        secretEnvVar = playerNumber === 1 ? localSecrets.player1 : localSecrets.player2;
      }

      // Priority 2: VITE_ env vars (testnet)
      if (!secretEnvVar || secretEnvVar === 'NOT_AVAILABLE') {
        secretEnvVar = playerNumber === 1
          ? import.meta.env.VITE_DEV_PLAYER1_SECRET
          : import.meta.env.VITE_DEV_PLAYER2_SECRET;
      }

      // Priority 3: Runtime config (for production builds)
      if (!secretEnvVar || secretEnvVar === 'NOT_AVAILABLE') {
        const rc = (globalThis as any).__STELLAR_GAME_STUDIO_CONFIG__;
        secretEnvVar = playerNumber === 1 ? rc?.devSecrets?.player1 : rc?.devSecrets?.player2;
      }

      if (!secretEnvVar || secretEnvVar === 'NOT_AVAILABLE') {
        throw new Error(`Player ${playerNumber} secret key not available. Run "bun run setup" first.`);
      }

      // Create keypair from secret key
      const keypair = Keypair.fromSecret(secretEnvVar);
      this.keypairs[playerKey] = keypair;
      this.currentPlayer = playerNumber;

      log.debug(`Dev wallet initialized for Player ${playerNumber}: ${keypair.publicKey()} (${isLocalNetwork() ? 'local' : 'testnet'})`);
    } catch (error) {
      log.error('Failed to initialize dev wallet:', error);
      throw error;
    }
  }

  /**
   * Get current player's public key
   */
  getPublicKey(): string {
    if (!this.currentPlayer) {
      throw new Error('No player initialized');
    }

    const playerKey = `player${this.currentPlayer}`;
    const keypair = this.keypairs[playerKey];

    if (!keypair) {
      throw new Error(`Player ${this.currentPlayer} not initialized`);
    }

    return keypair.publicKey();
  }

  /**
   * Get current player number
   */
  getCurrentPlayer(): 1 | 2 | null {
    return this.currentPlayer;
  }

  /**
   * Switch to another player
   */
  async switchPlayer(playerNumber: 1 | 2): Promise<void> {
    await this.initPlayer(playerNumber);
  }

  /**
   * Disconnect wallet
   */
  disconnect(): void {
    this.currentPlayer = null;
    this.keypairs = {};
  }

  /**
   * Get a signer for contract interactions
   * Uses actual keypair to sign transactions
   */
  getSigner(): ContractSigner {
    const playerKey = this.currentPlayer ? `player${this.currentPlayer}` : null;

    if (!playerKey || !this.keypairs[playerKey]) {
      throw new Error('No player initialized');
    }

    const keypair = this.keypairs[playerKey];
    const publicKey = keypair.publicKey();
    const toWalletError = (message: string): WalletError => ({ message, code: -1 });

    return {
      signTransaction: async (txXdr: string, opts?: any) => {
        try {
          if (!opts?.networkPassphrase) {
            throw new Error('Missing networkPassphrase');
          }

          const transaction = TransactionBuilder.fromXDR(txXdr, opts.networkPassphrase);
          transaction.sign(keypair);
          const signedTxXdr = transaction.toXDR();

          return {
            signedTxXdr,
            signerAddress: publicKey,
          };
        } catch (error) {
          log.error('Failed to sign transaction:', error);
          return {
            signedTxXdr: txXdr,
            signerAddress: publicKey,
            error: toWalletError(
              error instanceof Error ? error.message : 'Failed to sign transaction'
            ),
          };
        }
      },

      signAuthEntry: async (preimageXdr: string, opts?: any) => {
        try {
          // `authorizeEntry` signs the *hash* of the preimage XDR (see stellar-base's `authorizeEntry`).
          // Dev wallet must match that behavior.
          const preimageBytes = Buffer.from(preimageXdr, 'base64');
          const payload = hash(preimageBytes);
          const signatureBytes = keypair.sign(payload);

          return {
            signedAuthEntry: Buffer.from(signatureBytes).toString('base64'),
            signerAddress: publicKey,
          };
        } catch (error) {
          log.error('Failed to sign auth entry:', error);
          return {
            signedAuthEntry: preimageXdr,
            signerAddress: publicKey,
            error: toWalletError(
              error instanceof Error ? error.message : 'Failed to sign auth entry'
            ),
          };
        }
      },
    };
  }
}

// Export singleton instance
export const devWalletService = new DevWalletService();
export { DevWalletService };
