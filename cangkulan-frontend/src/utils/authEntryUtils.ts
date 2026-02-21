/**
 * Auth Entry utilities for multi-sig transaction flows
 */

import { Buffer } from 'buffer';
import { xdr, Address, authorizeEntry, TransactionBuilder } from '@stellar/stellar-sdk';
import { contract } from '@stellar/stellar-sdk';
import { calculateValidUntilLedger } from './ledgerUtils';
import { DEFAULT_AUTH_TTL_MINUTES } from './constants';
import { log } from '@/utils/logger';

/**
 * Inject a signed auth entry from Player 1 into Player 2's transaction
 * Used in multi-sig flows where Player 1 has pre-signed an auth entry
 *
 * @param tx - The assembled transaction from Player 2
 * @param player1AuthEntryXDR - Player 1's signed auth entry in XDR format
 * @param player2Address - Player 2's address
 * @param player2Signer - Player 2's signing functions
 * @returns Updated transaction with both auth entries signed
 */
export async function injectSignedAuthEntry(
  tx: contract.AssembledTransaction<any>,
  player1AuthEntryXDR: string,
  player2Address: string,
  player2Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  validUntilLedgerSeq?: number
): Promise<contract.AssembledTransaction<any>> {
  // Parse Player 1's signed auth entry
  const player1SignedAuthEntry = xdr.SorobanAuthorizationEntry.fromXDR(
    player1AuthEntryXDR,
    'base64'
  );
  const player1SignedAddress = player1SignedAuthEntry.credentials().address().address();
  const player1AddressString = Address.fromScAddress(player1SignedAddress).toString();

  // Get the simulation data
  if (!tx.simulationData?.result?.auth) {
    throw new Error('No auth entries found in transaction simulation');
  }

  const authEntries = tx.simulationData.result.auth;
  log.debug('[injectSignedAuthEntry] Found', authEntries.length, 'auth entries');

  // Find Player 1's stub entry and Player 2's entry
  let player1StubIndex = -1;
  let player2AuthEntry: xdr.SorobanAuthorizationEntry | null = null;
  let player2Index = -1;

  for (let i = 0; i < authEntries.length; i++) {
    const entry = authEntries[i];
    try {
      const credentialType = entry.credentials().switch().name;

      // Note: the invoker (transaction source) may show up as `sorobanCredentialsSourceAccount`,
      // which does NOT require an auth entry signature (it is authorized by the envelope signature).
      if (credentialType === 'sorobanCredentialsAddress') {
        const entryAddress = entry.credentials().address().address();
        const entryAddressString = Address.fromScAddress(entryAddress).toString();

        if (entryAddressString === player1AddressString) {
          player1StubIndex = i;
          log.debug(`[injectSignedAuthEntry] Found Player 1 stub at index ${i}`);
        } else if (entryAddressString === player2Address) {
          player2AuthEntry = entry;
          player2Index = i;
          log.debug(`[injectSignedAuthEntry] Found Player 2 auth entry at index ${i}`);
        }
      } else {
        log.debug(`[injectSignedAuthEntry] Skipping non-address credentials at index ${i}: ${credentialType}`);
      }
    } catch (err) {
      log.error('[injectSignedAuthEntry] Error processing auth entry:', err);
      continue;
    }
  }

  if (player1StubIndex === -1) {
    throw new Error('Could not find Player 1 stub entry in transaction');
  }

  if (!player2AuthEntry) {
    log.debug(
      `[injectSignedAuthEntry] No address-based auth entry found for Player 2 (${player2Address}); assuming Player 2 is the invoker/source account and does not require an auth entry signature`
    );
  }

  // Save the stub's nonce before replacing — needed to fix the footprint later.
  // When two separate simulations produce the transaction and the signed auth entry,
  // the nonces will differ, causing a footprint mismatch on-chain.
  const stubNonce = authEntries[player1StubIndex].credentials().address().nonce();

  // Replace Player 1's stub with their signed entry
  authEntries[player1StubIndex] = player1SignedAuthEntry;
  log.debug('[injectSignedAuthEntry] Replaced Player 1 stub with signed entry');

  // Sign Player 2's auth entry (only if Player 2 appears as a non-invoker address auth entry)
  if (player2AuthEntry && player2Index !== -1) {
    log.debug('[injectSignedAuthEntry] Signing Player 2 auth entry');

    if (!player2Signer.signAuthEntry) {
      throw new Error('signAuthEntry function not available');
    }

    const authValidUntilLedgerSeq =
      validUntilLedgerSeq ??
      (await calculateValidUntilLedger(tx.options.rpcUrl, DEFAULT_AUTH_TTL_MINUTES));

    const player2SignedAuthEntry = await authorizeEntry(
      player2AuthEntry,
      async (preimage) => {
        log.debug('[injectSignedAuthEntry] Signing Player 2 preimage...');

        if (!player2Signer.signAuthEntry) {
          throw new Error('Wallet does not support auth entry signing');
        }

        const signResult = await player2Signer.signAuthEntry(preimage.toXDR('base64'), {
          networkPassphrase: tx.options.networkPassphrase,
          address: player2Address,
        });

        if (signResult.error) {
          throw new Error(`Failed to sign auth entry: ${signResult.error.message}`);
        }

        return Buffer.from(signResult.signedAuthEntry, 'base64');
      },
      authValidUntilLedgerSeq,
      tx.options.networkPassphrase
    );

    // Replace Player 2's stub with their signed entry
    authEntries[player2Index] = player2SignedAuthEntry;
    log.debug('[injectSignedAuthEntry] Signed Player 2 auth entry');
  }

  // Update the transaction's auth entries in simulation data
  tx.simulationData.result.auth = authEntries;

  // CRITICAL: also sync to the built transaction so toXDR() serializes the
  // signed entries. simulationData.result.auth and built.operations[0].auth
  // are separate arrays — without this sync, toXDR() would serialize the
  // original unsigned stubs, losing Player 1's signed auth entry.
  const builtTx = tx as any;
  if (builtTx.built?.operations?.[0]) {
    builtTx.built.operations[0].auth = authEntries;
  }

  // Fix footprint nonce mismatch.
  // The signed auth entry was produced by a different simulation than the
  // current transaction, so its nonce differs from the one in the footprint.
  // The ledger requires the footprint's readWrite keys to contain the exact
  // nonce consumed by the auth entry — patch the footprint to match.
  const signedNonce = player1SignedAuthEntry.credentials().address().nonce();
  if (stubNonce.toString() !== signedNonce.toString()) {
    log.debug(
      `[injectSignedAuthEntry] Fixing footprint nonce: ${stubNonce.toString()} → ${signedNonce.toString()}`
    );

    const envelope = builtTx.built.toEnvelope();
    const sorobanData = envelope.v1().tx().ext().sorobanData();
    const rwKeys = sorobanData.resources().footprint().readWrite();

    let noncePatched = false;
    for (let i = 0; i < rwKeys.length; i++) {
      if (rwKeys[i].switch().name === 'contractData') {
        const cd = rwKeys[i].contractData();
        if (cd.key().switch().name === 'scvLedgerKeyNonce') {
          try {
            const keyAddr = Address.fromScAddress(cd.contract()).toString();
            if (keyAddr === player1AddressString) {
              rwKeys[i] = xdr.LedgerKey.contractData(
                new xdr.LedgerKeyContractData({
                  contract: cd.contract(),
                  key: xdr.ScVal.scvLedgerKeyNonce(
                    new xdr.ScNonceKey({ nonce: signedNonce })
                  ),
                  durability: cd.durability(),
                })
              );
              log.debug('[injectSignedAuthEntry] Footprint nonce updated');
              noncePatched = true;
              break;
            }
          } catch {
            continue;
          }
        }
      }
    }

    if (!noncePatched) {
      // Nonce key not found — add it explicitly to the readWrite footprint
      log.warn('[injectSignedAuthEntry] Nonce key not found in footprint — adding it');
      const p1ScAddress = player1SignedAuthEntry.credentials().address().address();
      rwKeys.push(
        xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: p1ScAddress,
            key: xdr.ScVal.scvLedgerKeyNonce(
              new xdr.ScNonceKey({ nonce: signedNonce })
            ),
            durability: xdr.ContractDataDurability.temporary(),
          })
        )
      );
    }

    // Rebuild the Transaction from the modified envelope so toXDR()
    // serializes the corrected footprint.
    builtTx.built = TransactionBuilder.fromXDR(
      envelope.toXDR('base64'),
      tx.options.networkPassphrase
    );
  }

  return tx;
}
