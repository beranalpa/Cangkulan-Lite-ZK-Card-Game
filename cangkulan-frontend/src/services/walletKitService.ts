import {
  StellarWalletsKit,
  type ModuleInterface,
} from '@creit-tech/stellar-wallets-kit';
import { FreighterModule } from '@creit-tech/stellar-wallets-kit/modules/freighter';
import { HanaModule } from '@creit-tech/stellar-wallets-kit/modules/hana';
import { HotWalletModule } from '@creit-tech/stellar-wallets-kit/modules/hotwallet';
import { KleverModule } from '@creit-tech/stellar-wallets-kit/modules/klever';
import { signAuthEntry as freighterSignAuthEntry } from '@stellar/freighter-api';
import { Buffer } from 'buffer';
import type { ContractSigner } from '../types/signer';
import { log } from '@/utils/logger';

/**
 * Wallet Kit Service
 * Uses @creit-tech/stellar-wallets-kit to support Stellar wallets that
 * implement Soroban signAuthEntry (required for multi-sig game creation):
 * Freighter, HOT Wallet, Hana, Klever.
 *
 * Provides a built-in wallet-picker modal and wraps any chosen wallet
 * into our ContractSigner interface.
 */

/**
 * Patched FreighterModule that handles Chrome extension messaging Buffer
 * serialization properly. The SDK's FreighterModule does
 * `encodeBase64(new Uint8Array(signedAuthEntry))` which silently produces
 * an empty array when `signedAuthEntry` is a JSON-serialized Buffer object
 * `{ type: 'Buffer', data: [...] }` from Chrome extension messaging.
 */
class PatchedFreighterModule extends FreighterModule {
  async signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }> {
    // runChecks is inherited — ensures Freighter is available
    await this.runChecks();

    // Call Freighter API directly to bypass the SDK module's broken
    // `encodeBase64(new Uint8Array(signedAuthEntry))` which fails when
    // Chrome extension messaging serializes Buffer as { type, data }.
    const { signedAuthEntry, signerAddress, error } = await freighterSignAuthEntry(authEntry, {
      address: opts?.address,
      networkPassphrase: opts?.networkPassphrase,
    });

    if (error) {
      return Promise.reject(error);
    }
    if (!signedAuthEntry) {
      return Promise.reject({
        code: -3,
        message: 'signedAuthEntry returned from Freighter is empty.',
      });
    }

    // Handle the many possible formats from Chrome extension messaging:
    // 1. Uint8Array/Buffer (structured clone preserved it) → convert to base64
    // 2. { type: 'Buffer', data: [...] } (JSON-serialized Buffer) → extract data array
    // 3. string (already base64 if the extension returned it that way) → use as-is
    // 4. Array of bytes → convert to base64
    let base64Sig: string;
    if (signedAuthEntry instanceof Uint8Array || Buffer.isBuffer(signedAuthEntry)) {
      base64Sig = Buffer.from(signedAuthEntry).toString('base64');
    } else if (typeof signedAuthEntry === 'string') {
      base64Sig = signedAuthEntry;
    } else if (Array.isArray(signedAuthEntry)) {
      base64Sig = Buffer.from(signedAuthEntry as number[]).toString('base64');
    } else if (signedAuthEntry && typeof signedAuthEntry === 'object') {
      // JSON-serialized Buffer: { type: 'Buffer', data: [byte, byte, ...] }
      const data = (signedAuthEntry as any).data;
      if (Array.isArray(data)) {
        base64Sig = Buffer.from(data).toString('base64');
      } else {
        log.error('[PatchedFreighter] Unexpected signedAuthEntry object shape:', signedAuthEntry);
        return Promise.reject({
          code: -3,
          message: `Unexpected signedAuthEntry format from Freighter: ${Object.keys(signedAuthEntry as any).join(',')}`,
        });
      }
    } else {
      log.error('[PatchedFreighter] Unknown signedAuthEntry type:', typeof signedAuthEntry, signedAuthEntry);
      return Promise.reject({
        code: -3,
        message: `Unexpected signedAuthEntry type from Freighter: ${typeof signedAuthEntry}`,
      });
    }

    log.debug('[PatchedFreighter] signAuthEntry success, base64 length:', base64Sig.length);
    return { signedAuthEntry: base64Sig, signerAddress: signerAddress ?? undefined };
  }
}

// Only register wallets that support Soroban signAuthEntry (required for multi-sig game start).
// Unsupported: xBull, Albedo, LOBSTR, Rabet, Ledger, Trezor, WalletConnect — they throw on signAuthEntry.
// Note: PatchedFreighterModule replaces FreighterModule to fix Chrome extension Buffer serialization.
const WALLET_MODULES: ModuleInterface[] = [
  new PatchedFreighterModule(),
  new HotWalletModule(),
  new HanaModule(),
  new KleverModule(),
];

let _initialized = false;

/**
 * Ensure the kit is initialized exactly once.
 */
function ensureInit(): void {
  if (_initialized) return;
  StellarWalletsKit.init({
    modules: WALLET_MODULES,
    network: 'Test SDF Network ; September 2015' as any,
    authModal: {
      showInstallLabel: true,
      hideUnsupportedWallets: false,
    },
  });
  _initialized = true;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Open the built-in auth modal so the user can pick a wallet.
 * Returns the connected address on success.
 */
export async function connectViaKit(): Promise<{ address: string; walletId: string }> {
  ensureInit();
  const { address } = await StellarWalletsKit.authModal();
  // After authModal resolves, selectedModule is set
  const walletId = StellarWalletsKit.selectedModule?.productId ?? 'unknown';
  log.info(`Wallet Kit connected: ${walletId} → ${address}`);
  return { address, walletId };
}

/**
 * Disconnect the currently selected wallet module (if supported).
 */
export async function disconnectKit(): Promise<void> {
  if (!_initialized) return;
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    // Some modules don't implement disconnect — ignore
  }
}

/**
 * Reconnect a previously-used wallet without showing the modal.
 * Returns the recovered address, or null if reconnection fails.
 */
export async function reconnectWallet(walletId: string): Promise<string | null> {
  ensureInit();
  try {
    StellarWalletsKit.setWallet(walletId);
    const { address } = await StellarWalletsKit.getAddress();
    log.info(`Wallet Kit reconnected: ${walletId} → ${address}`);
    return address;
  } catch (err) {
    log.warn('Wallet auto-reconnect failed:', err);
    return null;
  }
}

/**
 * Get the human-readable name of the currently selected wallet.
 */
export function getWalletName(): string {
  if (!_initialized) return 'Wallet';
  try {
    return StellarWalletsKit.selectedModule?.productName ?? 'Wallet';
  } catch {
    return 'Wallet';
  }
}

/**
 * Get the icon URL of the currently selected wallet.
 */
export function getWalletIcon(): string | null {
  if (!_initialized) return null;
  try {
    return StellarWalletsKit.selectedModule?.productIcon ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a ContractSigner that delegates to whichever wallet the user picked.
 * Compatible with the Stellar SDK TypeScript bindings.
 */
export function getKitSigner(address: string): ContractSigner {
  ensureInit();

  return {
    signTransaction: async (txXdr: string, opts?: any) => {
      try {
        const result = await StellarWalletsKit.signTransaction(txXdr, {
          networkPassphrase: opts?.networkPassphrase,
          address: opts?.address || address,
        });
        return {
          signedTxXdr: result.signedTxXdr,
          signerAddress: result.signerAddress || address,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message
          : (err && typeof err === 'object' && 'message' in err) ? String((err as any).message)
          : (typeof err === 'string') ? err
          : 'Transaction signing was cancelled or failed';
        throw new Error(msg);
      }
    },

    signAuthEntry: async (authEntry: string, opts?: any) => {
      try {
        log.debug('[walletKit] signAuthEntry request – address:', opts?.address || address);
        const result = await StellarWalletsKit.signAuthEntry(authEntry, {
          networkPassphrase: opts?.networkPassphrase,
          address: opts?.address || address,
        });
        log.debug('[walletKit] signAuthEntry raw result:', {
          hasSignedAuthEntry: !!result.signedAuthEntry,
          signedAuthEntryType: typeof result.signedAuthEntry,
          signedAuthEntryLength: result.signedAuthEntry?.length ?? 0,
          signerAddress: result.signerAddress,
        });
        if (!result.signedAuthEntry) {
          throw new Error('Wallet returned empty signedAuthEntry. The wallet may not support Soroban auth entry signing.');
        }
        return {
          signedAuthEntry: result.signedAuthEntry,
          signerAddress: result.signerAddress || address,
        };
      } catch (err: unknown) {
        log.error('[walletKit] signAuthEntry error:', err);
        const msg = err instanceof Error ? err.message
          : (err && typeof err === 'object' && 'message' in err) ? String((err as any).message)
          : (typeof err === 'string') ? err
          : 'Auth entry signing was cancelled or failed. Your wallet may not support Soroban auth entry signing.';
        throw new Error(msg);
      }
    },
  };
}
