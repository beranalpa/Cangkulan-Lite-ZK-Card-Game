/**
 * Transaction helper utilities
 */

import { contract } from '@stellar/stellar-sdk';
import { log } from './logger';

export interface TxResult<T> {
  result: T;
  txHash: string;
}

// ─── Retry Configuration ────────────────────────────────────────────────────

interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  backoffFactor: 2,
};

/** Errors that indicate a transient failure worth retrying. */
function isTransientError(err: unknown): boolean {
  const msg =
    (err instanceof Error ? err.message : String(err)).toLowerCase();
  const transientPatterns = [
    'timeout',
    'econnreset',
    'econnrefused',
    'enotfound',
    'socket hang up',
    'network',
    'fetch failed',
    'failed to fetch',
    'failed to send transaction',
    'service unavailable',
    '503',
    '429',
    'too many requests',
    'rate limit',
    'resource exhausted',
    'try again',
    'txbadseq',         // sequence number mismatch (concurrent tx)
    'tx_too_late',
    'tx_too_early',
  ];
  return transientPatterns.some((p) => msg.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulate and send a transaction with exponential backoff retry.
 * Only transient network/RPC errors are retried — contract logic errors (like
 * "duplicate session", "wrong card") propagate immediately.
 */
export async function simulateAndSend(
  tx: contract.AssembledTransaction<any> | string,
  timeoutInSeconds: number = 30,
  retryConfig: Partial<RetryConfig> = {},
): Promise<contract.SentTransaction<any>> {
  const cfg = { ...DEFAULT_RETRY, ...retryConfig };
  let lastError: unknown;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await _simulateAndSendOnce(tx, timeoutInSeconds);
    } catch (err) {
      lastError = err;
      if (attempt < cfg.maxAttempts && isTransientError(err)) {
        const delay = Math.min(
          cfg.baseDelayMs * cfg.backoffFactor ** (attempt - 1),
          cfg.maxDelayMs,
        );
        // Add jitter (±25%) to avoid thundering herd
        const jitter = delay * (0.75 + Math.random() * 0.5);
        log.warn(
          `[tx-retry] Attempt ${attempt}/${cfg.maxAttempts} failed (${err instanceof Error ? err.message : String(err)}). Retrying in ${Math.round(jitter)}ms...`,
        );
        await sleep(jitter);
        continue;
      }
      throw err; // Not transient or exhausted retries — propagate
    }
  }

  throw lastError; // Shouldn't reach here, but TypeScript needs it
}

/** Single attempt — the original simulateAndSend logic. */
async function _simulateAndSendOnce(
  tx: contract.AssembledTransaction<any> | string,
  timeoutInSeconds: number,
): Promise<contract.SentTransaction<any>> {
  // If tx is an AssembledTransaction, simulate and send
  if (typeof tx !== 'string' && 'simulate' in tx) {
    const simulated = await tx.simulate();
    try {
      return await simulated.signAndSend();
    } catch (err: any) {
      const errName = err?.name ?? '';
      const errMessage = err instanceof Error ? err.message : String(err);
      const isNoSignatureNeeded =
        errName.includes('NoSignatureNeededError') ||
        errMessage.includes('NoSignatureNeededError') ||
        errMessage.includes('This is a read call') ||
        errMessage.includes('requires no signature') ||
        errMessage.includes('force: true');

      // Some contract bindings incorrectly classify state-changing methods as "read calls".
      // In those cases, the SDK requires `force: true` to sign and send anyway.
      if (isNoSignatureNeeded) {
        try {
          return await simulated.signAndSend({ force: true });
        } catch (forceErr: any) {
          const forceName = forceErr?.name ?? '';
          const forceMessage = forceErr instanceof Error ? forceErr.message : String(forceErr);
          const isStillReadOnly =
            forceName.includes('NoSignatureNeededError') ||
            forceMessage.includes('NoSignatureNeededError') ||
            forceMessage.includes('This is a read call') ||
            forceMessage.includes('requires no signature');

          // If the SDK still says it's a read call, treat the simulation result as the final result.
          if (isStillReadOnly) {
            const simulatedResult =
              (simulated as any).result ??
              (simulated as any).simulationResult?.result ??
              (simulated as any).returnValue ??
              (tx as any).result;

            return {
              result: simulatedResult,
              getTransactionResponse: undefined,
            } as unknown as contract.SentTransaction<any>;
          }

          throw forceErr;
        }
      }

      throw err;
    }
  }

  // If tx is XDR string, it needs to be sent directly
  // This is typically used for multi-sig flows where the transaction is already built
  throw new Error('Direct XDR submission not yet implemented. Use AssembledTransaction.signAndSend() instead.');
}

/**
 * Extract the transaction hash from a SentTransaction
 */
export function extractTxHash(sentTx: contract.SentTransaction<any>): string {
  return sentTx.sendTransactionResponse?.hash ?? '';
}
