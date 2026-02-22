import { Client as CangkulanClient, type CangkulanGame, type GameSummary } from './bindings';
import {
  DEFAULT_METHOD_OPTIONS, MULTI_SIG_AUTH_TTL_MINUTES,
  getActiveRpcUrl, getActivePassphrase, needsAllowHttp,
} from '@/utils/constants';
import { contract, TransactionBuilder, StrKey, xdr, Address, authorizeEntry, hash, rpc } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { simulateAndSend, extractTxHash, type TxResult } from '@/utils/transactionHelper';
import { calculateValidUntilLedger } from '@/utils/ledgerUtils';
import { injectSignedAuthEntry } from '@/utils/authEntryUtils';
import { log } from '@/utils/logger';

type ClientOptions = contract.ClientOptions;

/**
 * Correctly read a Soroban i128 value by combining hi (signed) and lo (unsigned) 64-bit words.
 * Without this, values whose high word is non-zero are silently truncated.
 */
function i128ToBigInt(parts: { hi: () => { toBigInt: () => bigint }; lo: () => { toBigInt: () => bigint } }): bigint {
  const hi = parts.hi().toBigInt();
  const lo = parts.lo().toBigInt();
  // lo is unsigned 64 bits, hi is signed 64 bits
  return (hi << 64n) | (lo & 0xFFFFFFFFFFFFFFFFn);
}

/** Network configuration for service instances. */
export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
}

/**
 * Service for interacting with the Cangkulan game contract.
 *
 * Cangkulan Lite is an Indonesian card game with:
 * - 36-card deck (4 suits × values 2-10)
 * - ZK seed commitment for provably fair shuffle
 * - Draw pile as lead, trick-based gameplay
 *
 * Supports both testnet and local quickstart node via optional `networkConfig`.
 */
export class CangkulanService {
  private baseClient: CangkulanClient;
  private contractId: string;
  private rpcUrl: string;
  private networkPassphrase: string;

  /**
   * @param contractId - The deployed contract address
   * @param networkConfig - Optional network override. Defaults to active network from networkStore.
   */
  constructor(contractId: string, networkConfig?: NetworkConfig) {
    this.contractId = contractId;
    this.rpcUrl = networkConfig?.rpcUrl ?? getActiveRpcUrl();
    this.networkPassphrase = networkConfig?.networkPassphrase ?? getActivePassphrase();
    this.baseClient = new CangkulanClient({
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: needsAllowHttp(this.rpcUrl),
    });
  }

  private createSigningClient(
    publicKey: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ): CangkulanClient {
    const options: ClientOptions = {
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: needsAllowHttp(this.rpcUrl),
      publicKey,
      ...signer,
    };
    return new CangkulanClient(options);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Read-Only Queries
  // ═══════════════════════════════════════════════════════════════════════════

  async getGame(sessionId: number): Promise<CangkulanGame | null> {
    try {
      const tx = await this.baseClient.get_game({ session_id: sessionId });
      const result = await tx.simulate();
      if (result.result.isOk()) {
        return result.result.unwrap();
      } else {
        // Distinguish between actual "not found" vs other simulation errors
        const errStr = String(result.result.unwrapErr());
        if (errStr.includes('HostError') || errStr.includes('1')) { // 1 = GameNotFound error code
          log.debug(`[getGame] Game #${sessionId} not found in contract storage (may have expired or never existed)`);
        } else {
          log.warn(`[getGame] Simulation failed for #${sessionId}:`, errStr);
        }
        return null;
      }
    } catch (err) {
      log.error(`[getGame] RPC Exception for #${sessionId}:`, err);
      // Return undefined or rethrow? For now return null but log as error
      return null;
    }
  }

  /**
   * Privacy-aware game query: only the viewer's own hand is visible.
   * The opponent's hand is redacted to prevent card snooping.
   */
  async getGameView(sessionId: number, viewer: string): Promise<CangkulanGame | null> {
    try {
      const tx = await this.baseClient.get_game_view({ session_id: sessionId, viewer });
      const result = await tx.simulate();
      if (result.result.isOk()) {
        return result.result.unwrap();
      }
      const errStr = String(result.result.unwrapErr());
      log.warn(`[getGameView] Simulation Error for Game #${sessionId}, Viewer ${viewer}:`, errStr);
      return null;
    } catch (err) {
      log.error(`[getGameView] RPC Exception for Game #${sessionId}:`, err);
      return null;
    }
  }

  /**
   * Verify the shuffle fairness: recomputes the full deck order from
   * the stored seed commitments. Returns the 36-card deck array.
   */
  async verifyShuffle(sessionId: number): Promise<number[] | null> {
    try {
      const tx = await this.baseClient.verify_shuffle({ session_id: sessionId });
      const result = await tx.simulate();
      if (result.result.isOk()) {
        return result.result.unwrap();
      }
      return null;
    } catch (err) {
      log.debug('[verifyShuffle] Error:', err);
      return null;
    }
  }

  /**
   * Get a player's game history (up to 50 most recent games).
   * Returns summaries with outcome from the player's perspective:
   *   1 = win, 2 = loss, 3 = draw
   */
  async getPlayerHistory(player: string): Promise<GameSummary[]> {
    try {
      const tx = await this.baseClient.get_player_history({ player });
      const result = await tx.simulate();
      return result.result ?? [];
    } catch (err) {
      log.debug('[getPlayerHistory] Error:', err);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Multi-Sig Start Game Flow
  // ═══════════════════════════════════════════════════════════════════════════

  async startGame(
    sessionId: number,
    player1: string, player2: string,
    player1Points: bigint, player2Points: bigint,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<TxResult<any>> {
    const client = this.createSigningClient(player1, signer);
    const tx = await client.start_game({
      session_id: sessionId, player1, player2,
      player1_points: player1Points, player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);
    const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
    return { result: sentTx.result, txHash: extractTxHash(sentTx) };
  }

  async prepareStartGame(
    sessionId: number,
    player1: string, player2: string,
    player1Points: bigint, player2Points: bigint,
    player1Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<string> {
    log.debug('[prepareStartGame] session:', sessionId, 'p1:', player1, 'p2 (sim):', player2);

    const buildClient = new CangkulanClient({
      contractId: this.contractId, // Cangkulan contract (requires multi-sig)
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: needsAllowHttp(this.rpcUrl),
      publicKey: player2,
    });

    log.debug('[prepareStartGame] Simulating start_game…');
    const tx = await buildClient.start_game({
      session_id: sessionId, player1, player2,
      player1_points: player1Points, player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    if (!tx.simulationData?.result?.auth) {
      throw new Error('No auth entries found in simulation');
    }
    const authEntries = tx.simulationData.result.auth;
    log.debug('[prepareStartGame] Auth entries found:', authEntries.length);

    let player1AuthEntry = null;
    for (let i = 0; i < authEntries.length; i++) {
      const entry = authEntries[i];
      try {
        const entryAddress = entry.credentials().address().address();
        const entryAddressString = Address.fromScAddress(entryAddress).toString();
        if (entryAddressString === player1) {
          player1AuthEntry = entry;
          break;
        }
      } catch { continue; }
    }
    if (!player1AuthEntry) {
      throw new Error(`No auth entry found for Player 1 (${player1}).`);
    }
    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(this.rpcUrl, authTtlMinutes)
      : await calculateValidUntilLedger(this.rpcUrl, MULTI_SIG_AUTH_TTL_MINUTES);
    log.debug('[prepareStartGame] validUntilLedgerSeq:', validUntilLedgerSeq);

    if (!player1Signer.signAuthEntry) {
      throw new Error('signAuthEntry function not available');
    }

    // Clone the auth entry and set expiration ledger for the preimage
    const entryClone = xdr.SorobanAuthorizationEntry.fromXDR(player1AuthEntry.toXDR());
    entryClone.credentials().address().signatureExpirationLedger(validUntilLedgerSeq);

    const networkId = hash(Buffer.from(this.networkPassphrase));
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: entryClone.credentials().address().nonce(),
        signatureExpirationLedger: validUntilLedgerSeq,
        invocation: entryClone.rootInvocation(),
      }),
    );

    // Ask the wallet to sign the preimage
    log.debug('[prepareStartGame] Requesting wallet signAuthEntry…');
    const signResult = await player1Signer.signAuthEntry(preimage.toXDR('base64'), {
      networkPassphrase: this.networkPassphrase, address: player1,
    });
    log.debug('[prepareStartGame] signResult received:', {
      hasSignedAuthEntry: !!signResult.signedAuthEntry,
      signedAuthEntryType: typeof signResult.signedAuthEntry,
      signedAuthEntryLen: signResult.signedAuthEntry?.length ?? 0,
      signerAddress: signResult.signerAddress,
      hasError: !!(signResult as any).error,
    });

    if ((signResult as any).error) throw new Error(`Failed to sign auth entry: ${(signResult as any).error.message || JSON.stringify((signResult as any).error)}`);
    if (!signResult.signedAuthEntry) throw new Error('Wallet returned empty signed auth entry. Your wallet may not support Soroban auth entry signing.');

    const sigBytes = Buffer.from(signResult.signedAuthEntry, 'base64');
    log.debug('[prepareStartGame] sigBytes length:', sigBytes.length, '(64=raw sig, >64=full XDR entry)');

    if (sigBytes.length === 64) {
      // Raw ed25519 signature (dev wallets) — let authorizeEntry wrap it.
      try {
        const signedEntry = await authorizeEntry(
          player1AuthEntry,
          async () => sigBytes,
          validUntilLedgerSeq, this.networkPassphrase,
        );
        log.debug('[prepareStartGame] authorizeEntry success');
        return signedEntry.toXDR('base64');
      } catch (authErr) {
        log.error('[prepareStartGame] authorizeEntry failed:', authErr);
        // If signature verification fails, the signature might not match
        // the preimage that authorizeEntry computed internally.
        const msg = authErr instanceof Error ? authErr.message : String(authErr);
        if (msg.includes("signature doesn't match")) {
          throw new Error(
            'Signature verification failed. This may happen if your wallet ' +
            'is connected to a different network (e.g. Mainnet instead of Testnet) ' +
            'or if the wallet modified the auth entry. Please check your wallet network settings.'
          );
        }
        throw authErr;
      }
    }

    // Full signed SorobanAuthorizationEntry XDR (Freighter, Hana, etc.)
    // The wallet already built the complete signed entry — validate & return.
    try {
      xdr.SorobanAuthorizationEntry.fromXDR(sigBytes);
      log.debug('[prepareStartGame] Validated wallet-signed full auth entry XDR');
    } catch {
      throw new Error(`Wallet returned an unexpected auth entry format (${sigBytes.length} bytes). Please try a different wallet.`);
    }
    return signResult.signedAuthEntry;
  }

  parseAuthEntry(authEntryXdr: string): {
    sessionId: number; player1: string; player1Points: bigint; functionName: string;
  } {
    try {
      const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64');
      const credentials = authEntry.credentials();
      const addressCreds = credentials.address();
      const player1Address = addressCreds.address();
      const player1 = Address.fromScAddress(player1Address).toString();
      const rootInvocation = authEntry.rootInvocation();
      const authorizedFunction = rootInvocation.function();
      const contractFn = authorizedFunction.contractFn();
      const functionName = contractFn.functionName().toString();
      if (functionName !== 'start_game') throw new Error(`Unexpected function: ${functionName}`);
      const args = contractFn.args();
      if (args.length !== 2) throw new Error(`Expected 2 arguments, got ${args.length}`);
      const sessionId = args[0].u32();
      const player1Points = i128ToBigInt(args[1].i128());
      return { sessionId, player1, player1Points, functionName };
    } catch (err: any) {
      throw new Error(`Failed to parse auth entry: ${err.message}`);
    }
  }

  async importAndSignAuthEntry(
    player1SignedAuthEntryXdr: string,
    player2Address: string, player2Points: bigint,
    player2Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<string> {
    const gameParams = this.parseAuthEntry(player1SignedAuthEntryXdr);
    if (player2Address === gameParams.player1) throw new Error('Cannot play against yourself.');
    const buildClient = new CangkulanClient({
      contractId: this.contractId, // Cangkulan contract (requires multi-sig)
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: needsAllowHttp(this.rpcUrl),
      publicKey: player2Address,
    });
    const tx = await buildClient.start_game({
      session_id: gameParams.sessionId,
      player1: gameParams.player1, player2: player2Address,
      player1_points: gameParams.player1Points, player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(this.rpcUrl, authTtlMinutes)
      : await calculateValidUntilLedger(this.rpcUrl, MULTI_SIG_AUTH_TTL_MINUTES);
    const txWithInjectedAuth = await injectSignedAuthEntry(
      tx, player1SignedAuthEntryXdr, player2Address, player2Signer, validUntilLedgerSeq,
    );
    // injectSignedAuthEntry already handles:
    // - Replacing P1's stub with signed entry
    // - Signing P2's auth entry (if P2 has an address-based entry)
    // - Syncing auth entries to built transaction
    // - Patching footprint nonce to match P1's signed entry
    // No need for txFromXDR/needsNonInvokerSigningBy/signAuthEntries roundtrip.
    return txWithInjectedAuth.toXDR();
  }

  async finalizeStartGame(
    txXdr: string, signerAddress: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  ): Promise<TxResult<any>> {
    // Sign the pre-built transaction envelope directly.
    // We bypass AssembledTransaction.signAndSend() because txFromXDR() does not
    // populate simulationData, and signAndSend requires it to rebuild the tx.
    // The transaction already has signed auth entries from importAndSignAuthEntry.
    if (!signer.signTransaction) {
      throw new Error('signTransaction function not available');
    }
    const signResult = await signer.signTransaction(txXdr, {
      networkPassphrase: this.networkPassphrase,
    });
    if (signResult.error) {
      throw new Error(`Failed to sign transaction: ${signResult.error.message || JSON.stringify(signResult.error)}`);
    }

    const signedTx = TransactionBuilder.fromXDR(signResult.signedTxXdr, this.networkPassphrase);
    const server = new rpc.Server(this.rpcUrl, { allowHttp: needsAllowHttp(this.rpcUrl) });
    const sendResponse = await server.sendTransaction(signedTx);

    if (sendResponse.status === 'ERROR') {
      throw new Error(`Transaction submission failed: ${JSON.stringify(sendResponse.errorResult)}`);
    }

    // Poll for confirmation
    const txHash = sendResponse.hash;
    let getResponse = await server.getTransaction(txHash);
    const deadline = Date.now() + 30_000;
    while (getResponse.status === 'NOT_FOUND' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      getResponse = await server.getTransaction(txHash);
    }
    if (getResponse.status === 'FAILED') {
      throw new Error(`Transaction failed on-chain: ${this.extractErrorFromDiagnostics(getResponse)}`);
    }
    if (getResponse.status === 'NOT_FOUND') {
      throw new Error('Transaction not confirmed within 30 seconds');
    }
    return { result: getResponse, txHash };
  }

  /**
   * Start a game with both signers available (e.g. quickstart / dev mode).
   *
   * Uses a SINGLE simulation so the auth entry nonce and the transaction
   * footprint are guaranteed to match — no cross-simulation nonce patching
   * needed.  Player 2 is the transaction source (invoker); Player 1 gets
   * an address-based auth entry that is signed explicitly.
   */
  async startGameDirect(
    sessionId: number,
    player1: string, player2: string,
    player1Points: bigint, player2Points: bigint,
    player1Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    player2Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<TxResult<any>> {
    // Build transaction with Player 2 as source (invoker — authorized by
    // the envelope signature, no separate auth entry needed).
    const client = new CangkulanClient({
      contractId: this.contractId, // Cangkulan contract (requires multi-sig)
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: needsAllowHttp(this.rpcUrl),
      publicKey: player2,
    });
    const tx = await client.start_game({
      session_id: sessionId, player1, player2,
      player1_points: player1Points, player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    if (!tx.simulationData?.result?.auth) {
      throw new Error('No auth entries found in simulation');
    }

    // Sign Player 1's address-based auth entry using the SAME simulation
    // nonce, ensuring a perfect footprint match.
    const validUntilLedger = authTtlMinutes
      ? await calculateValidUntilLedger(this.rpcUrl, authTtlMinutes)
      : await calculateValidUntilLedger(this.rpcUrl, MULTI_SIG_AUTH_TTL_MINUTES);

    const authEntries = tx.simulationData.result.auth;
    let p1Signed = false;
    for (let i = 0; i < authEntries.length; i++) {
      const entry = authEntries[i];
      try {
        if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') continue;
        const addr = Address.fromScAddress(entry.credentials().address().address()).toString();
        if (addr !== player1) continue;
        if (!player1Signer.signAuthEntry) throw new Error('Player 1 signAuthEntry not available');
        authEntries[i] = await authorizeEntry(
          entry,
          async (preimage) => {
            const result = await player1Signer.signAuthEntry!(preimage.toXDR('base64'), {
              networkPassphrase: this.networkPassphrase, address: player1,
            });
            if ((result as any).error) throw new Error(`Player 1 auth entry signing failed: ${(result as any).error.message}`);
            if (!result.signedAuthEntry) throw new Error('Player 1 wallet returned empty signed auth entry.');
            return Buffer.from(result.signedAuthEntry, 'base64');
          },
          validUntilLedger, this.networkPassphrase,
        );
        p1Signed = true;
        break;
      } catch (err) {
        if (err instanceof Error && (err.message.includes('Player 1') || err.message.includes("signature doesn't match"))) {
          if (err.message.includes("signature doesn't match")) {
            throw new Error(
              'Signature verification failed. Check your wallet is connected to the correct network (Testnet).'
            );
          }
          throw err;
        }
        continue;
      }
    }
    if (!p1Signed) {
      throw new Error(`No auth entry found for Player 1 (${player1})`);
    }

    // Sync signed auth entries to the built transaction so toXDR() picks them up
    const builtTx = tx as any;
    if (builtTx.built?.operations?.[0]) {
      builtTx.built.operations[0].auth = authEntries;
    }

    // Sign the transaction envelope as Player 2 (source) and submit directly
    const txXdr = tx.toXDR();
    if (!player2Signer.signTransaction) throw new Error('Player 2 signTransaction not available');
    const signResult = await player2Signer.signTransaction(txXdr, {
      networkPassphrase: this.networkPassphrase,
    });
    if (signResult.error) throw new Error(`Player 2 signing failed: ${signResult.error.message || JSON.stringify(signResult.error)}`);

    const signedTx = TransactionBuilder.fromXDR(signResult.signedTxXdr, this.networkPassphrase);
    const server = new rpc.Server(this.rpcUrl, { allowHttp: needsAllowHttp(this.rpcUrl) });
    const sendResponse = await server.sendTransaction(signedTx);
    if (sendResponse.status === 'ERROR') {
      throw new Error(`Transaction submission failed: ${JSON.stringify(sendResponse.errorResult)}`);
    }

    const txHash = sendResponse.hash;
    let getResponse = await server.getTransaction(txHash);
    const deadline = Date.now() + 30_000;
    while (getResponse.status === 'NOT_FOUND' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      getResponse = await server.getTransaction(txHash);
    }
    if (getResponse.status === 'FAILED') {
      throw new Error(`Transaction failed on-chain: ${this.extractErrorFromDiagnostics(getResponse)}`);
    }
    if (getResponse.status === 'NOT_FOUND') {
      throw new Error('Transaction not confirmed within 30 seconds');
    }
    return { result: getResponse, txHash };
  }

  parseTransactionXDR(txXdr: string): {
    sessionId: number; player1: string; player2: string;
    player1Points: bigint; player2Points: bigint;
    transactionSource: string; functionName: string;
  } {
    const transaction = TransactionBuilder.fromXDR(txXdr, this.networkPassphrase);
    const transactionSource = 'source' in transaction ? transaction.source : '';
    const operation = transaction.operations[0];
    if (!operation || operation.type !== 'invokeHostFunction') throw new Error('Not a contract invocation');
    const func = operation.func;
    const invokeContractArgs = func.invokeContract();
    const functionName = invokeContractArgs.functionName().toString();
    const args = invokeContractArgs.args();
    if (functionName !== 'start_game') throw new Error(`Unexpected function: ${functionName}`);
    if (args.length !== 5) throw new Error(`Expected 5 arguments, got ${args.length}`);
    const sessionId = args[0].u32();
    const player1 = StrKey.encodeEd25519PublicKey(args[1].address().accountId().ed25519());
    const player2 = StrKey.encodeEd25519PublicKey(args[2].address().accountId().ed25519());
    const player1Points = i128ToBigInt(args[3].i128());
    const player2Points = i128ToBigInt(args[4].i128());
    return { sessionId, player1, player2, player1Points, player2Points, transactionSource, functionName };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Seed Commitment Phase
  // ═══════════════════════════════════════════════════════════════════════════

  async commitSeed(
    sessionId: number, playerAddress: string, commitHash: Buffer,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    return this.withContentionRetry(async () => {
      const client = this.createSigningClient(playerAddress, signer);
      const tx = await client.commit_seed({
        session_id: sessionId, player: playerAddress, commit_hash: commitHash,
      }, DEFAULT_METHOD_OPTIONS);
      try {
        const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
        if (sentTx.getTransactionResponse?.status === 'FAILED') {
          throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
        }
        return { result: sentTx.result, txHash: extractTxHash(sentTx) };
      } catch (err) {
        if (err instanceof Error && err.message.includes('Transaction failed!')) {
          throw new Error('Transaction failed - check if the game is in seed commit phase');
        }
        throw err;
      }
    });
  }

  async revealSeed(
    sessionId: number, playerAddress: string,
    seedHash: Buffer, proof: Buffer,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    return this.withContentionRetry(async () => {
      const client = this.createSigningClient(playerAddress, signer);
      const tx = await client.reveal_seed({
        session_id: sessionId, player: playerAddress, seed_hash: seedHash, proof,
      }, DEFAULT_METHOD_OPTIONS);
      try {
        const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
        if (sentTx.getTransactionResponse?.status === 'FAILED') {
          throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
        }
        return { result: sentTx.result, txHash: extractTxHash(sentTx) };
      } catch (err) {
        if (err instanceof Error && err.message.includes('Transaction failed!')) {
          throw new Error('Transaction failed - check seed reveal and ZK proof');
        }
        throw err;
      }
    });
  }

  /**
   * Split-transaction Noir verification (TX 1 of 2).
   * Verifies the UltraKeccakHonk proof on-chain and stores a "verified" flag.
   * Follow with `revealSeed(sessionId, player, seedHash, emptyProof)` (TX 2).
   */
  async verifyNoirSeed(
    sessionId: number, playerAddress: string,
    seedHash: Buffer, proof: Buffer,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  ) {
    return this.withContentionRetry(async () => {
      const client = this.createSigningClient(playerAddress, signer);
      const tx = await client.verify_noir_seed({
        session_id: sessionId, player: playerAddress, seed_hash: seedHash, proof,
      }, DEFAULT_METHOD_OPTIONS);
      try {
        const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
        if (sentTx.getTransactionResponse?.status === 'FAILED') {
          throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
        }
        return { result: sentTx.result, txHash: extractTxHash(sentTx) };
      } catch (err) {
        if (err instanceof Error && err.message.includes('Transaction failed!')) {
          throw new Error('Transaction failed - Noir proof verification failed');
        }
        throw err;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Playing Phase (Commit-Reveal)
  // ═══════════════════════════════════════════════════════════════════════════

  async commitPlay(
    sessionId: number, playerAddress: string, commitHash: Buffer,
    expectedNonce: number,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  ) {
    let nonce = expectedNonce;
    return this.withContentionRetry(async (attempt) => {
      // On retry, fetch fresh nonce — the concurrent TX likely bumped it
      if (attempt > 0) {
        const game = await this.getGame(sessionId);
        if (game) nonce = game.action_nonce;
      }
      const client = this.createSigningClient(playerAddress, signer);
      const tx = await client.commit_play({
        session_id: sessionId, player: playerAddress,
        commit_hash: commitHash, expected_nonce: nonce,
      }, DEFAULT_METHOD_OPTIONS);
      try {
        const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
        if (sentTx.getTransactionResponse?.status === 'FAILED') {
          throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
        }
        return { result: sentTx.result, txHash: extractTxHash(sentTx) };
      } catch (err) {
        if (err instanceof Error && err.message.includes('Transaction failed!')) {
          throw new Error('Transaction failed - check if it is your turn to commit');
        }
        throw err;
      }
    });
  }

  /**
   * Commit a card play with a ZK ring sigma proof of suit compliance.
   * The proof proves the committed card is in the valid set (hand ∩ suit)
   * without revealing which specific card was chosen.
   */
  async commitPlayZk(
    sessionId: number, playerAddress: string, commitHash: Buffer,
    expectedNonce: number, zkProof: Buffer,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  ) {
    let nonce = expectedNonce;
    return this.withContentionRetry(async (attempt) => {
      if (attempt > 0) {
        const game = await this.getGame(sessionId);
        if (game) nonce = game.action_nonce;
      }
      const client = this.createSigningClient(playerAddress, signer);
      const tx = await client.commit_play_zk({
        session_id: sessionId, player: playerAddress,
        commit_hash: commitHash, expected_nonce: nonce,
        zk_proof: zkProof,
      }, DEFAULT_METHOD_OPTIONS);
      try {
        const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
        if (sentTx.getTransactionResponse?.status === 'FAILED') {
          throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
        }
        return { result: sentTx.result, txHash: extractTxHash(sentTx) };
      } catch (err) {
        if (err instanceof Error && err.message.includes('Transaction failed!')) {
          throw new Error('Transaction failed - ZK card play proof verification may have failed');
        }
        throw err;
      }
    });
  }

  /**
   * Commit a cangkul (cannot follow suit) with a ZK hand proof.
   * The proof proves the player's hand has NO cards matching trick suit
   * using aggregate Pedersen commitment + Schnorr proof.
   */
  async commitCangkulZk(
    sessionId: number, playerAddress: string, commitHash: Buffer,
    expectedNonce: number, zkProof: Buffer,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  ) {
    let nonce = expectedNonce;
    return this.withContentionRetry(async (attempt) => {
      if (attempt > 0) {
        const game = await this.getGame(sessionId);
        if (game) nonce = game.action_nonce;
      }
      const client = this.createSigningClient(playerAddress, signer);
      const tx = await client.commit_cangkul_zk({
        session_id: sessionId, player: playerAddress,
        commit_hash: commitHash, expected_nonce: nonce,
        zk_proof: zkProof,
      }, DEFAULT_METHOD_OPTIONS);
      try {
        const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
        if (sentTx.getTransactionResponse?.status === 'FAILED') {
          throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
        }
        return { result: sentTx.result, txHash: extractTxHash(sentTx) };
      } catch (err) {
        if (err instanceof Error && err.message.includes('Transaction failed!')) {
          throw new Error('Transaction failed - ZK cangkul proof verification may have failed');
        }
        throw err;
      }
    });
  }

  async revealPlay(
    sessionId: number, playerAddress: string,
    cardId: number, salt: Buffer,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  ) {
    return this.withContentionRetry(async () => {
      const client = this.createSigningClient(playerAddress, signer);
      const tx = await client.reveal_play({
        session_id: sessionId, player: playerAddress,
        card_id: cardId, salt,
      }, DEFAULT_METHOD_OPTIONS);
      try {
        const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
        if (sentTx.getTransactionResponse?.status === 'FAILED') {
          throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
        }
        return { result: sentTx.result, txHash: extractTxHash(sentTx) };
      } catch (err) {
        if (err instanceof Error && err.message.includes('Transaction failed!')) {
          throw new Error('Transaction failed - check card and salt values');
        }
        throw err;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Timeout
  // ═══════════════════════════════════════════════════════════════════════════

  async tickTimeout(
    sessionId: number, callerAddress: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(callerAddress, signer);
    const tx = await client.tick_timeout({
      session_id: sessionId, caller: callerAddress,
    }, DEFAULT_METHOD_OPTIONS);
    try {
      const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
      }
      return { result: sentTx.result, txHash: extractTxHash(sentTx) };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Transaction failed - timeout may not be applicable');
      }
      throw err;
    }
  }

  async resolveTimeout(
    sessionId: number, callerAddress: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(callerAddress, signer);
    const tx = await client.resolve_timeout({
      session_id: sessionId, caller: callerAddress,
    }, DEFAULT_METHOD_OPTIONS);
    try {
      const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
      }
      return { result: sentTx.result, txHash: extractTxHash(sentTx) };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Transaction failed - timeout deadline may not have been reached');
      }
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Forfeit
  // ═══════════════════════════════════════════════════════════════════════════

  async forfeit(
    sessionId: number, callerAddress: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
  ) {
    const client = this.createSigningClient(callerAddress, signer);
    const tx = await client.forfeit({
      session_id: sessionId, caller: callerAddress,
    }, DEFAULT_METHOD_OPTIONS);
    try {
      const sentTx = await simulateAndSend(tx, DEFAULT_METHOD_OPTIONS.timeoutInSeconds);
      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        throw new Error(`Transaction failed: ${this.extractErrorFromDiagnostics(sentTx.getTransactionResponse)}`);
      }
      return { result: sentTx.result, txHash: extractTxHash(sentTx) };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Transaction failed - forfeit may not be applicable');
      }
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Translate Cangkulan contract error codes to human-readable messages.
   * Maps to CangkulanError enum in contracts/cangkulan/src/lib.rs
   */
  static translateContractError(errorCode: number): string {
    const errorMessages: Record<number, string> = {
      1: 'Game not found — this session ID does not exist.',
      2: 'Session already exists — this session ID has already been used. Try a different one.',
      3: 'Not a player — your wallet address is not part of this game session.',
      4: 'Self-play not allowed — you cannot play against yourself.',
      5: 'Game already ended — this game session has already finished.',
      6: 'Wrong phase — this action is not valid in the current game phase.',
      7: 'Seed already committed — you have already submitted your seed commitment.',
      8: 'Seed already revealed — you have already revealed your seed.',
      9: 'Commit hash mismatch — the revealed seed does not match your original commitment.',
      10: 'Invalid ZK proof — the zero-knowledge proof verification failed.',
      11: 'Missing commit — both players must commit their seeds before revealing.',
      12: 'Not your turn — wait for the other player to make their move.',
      13: 'Card not in hand — you do not have this card in your hand.',
      14: 'Wrong suit — you must follow the trick suit if you have a matching card.',
      15: 'Has matching suit — you cannot call "cannot follow" when you have a matching suit card.',
      16: 'Draw pile empty — there are no more cards in the draw pile.',
      17: 'No trick in progress — there is no active trick to respond to.',
      18: 'Admin not set — contract admin has not been configured.',
      19: 'Game Hub not set — Game Hub contract address has not been configured.',
      20: 'Verifier not set — ZK Verifier contract address has not been configured.',
      21: 'Timeout not reached — the timeout deadline has not been reached yet.',
      22: 'Timeout not configured — no timeout is currently active for this game.',
      23: 'Timeout not applicable — timeout cannot be applied in the current game state.',
      24: 'Weak seed entropy — your random seed is too predictable. Please use a stronger seed.',
      25: 'Invalid nonce — game state has changed. Please refresh and try again.',
      26: 'Play commit already submitted — you have already committed your play for this trick.',
      27: 'Play commit missing — you must commit before revealing.',
      28: 'Play reveal mismatch — the revealed card and salt do not match your commitment.',
      29: 'Invalid card ID — the card ID is not valid.',
      30: 'UltraHonk verifier not set — Noir verifier contract address has not been configured.',
      31: 'UltraHonk verification failed — the Noir ZK proof did not pass on-chain verification.',
      32: 'ZK play proof invalid — the ring sigma proof for card play failed verification.',
      33: 'ZK play set empty — no valid cards in the ring for ZK proof (hand has no matching suit).',
      34: 'ZK play opening mismatch — the Pedersen commitment opening does not match the commit hash.',
      35: 'ZK cangkul proof invalid — the aggregate Pedersen proof for "cannot follow" failed verification.',
      38: 'Tick too soon — must wait before calling tick_timeout again.',
    };
    return errorMessages[errorCode] || `Unknown contract error #${errorCode}`;
  }

  /**
   * Extract contract error code from an error message string.
   * Looks for patterns like "Error(Contract, #2)" or "Contract, #2"
   */
  static extractErrorCode(message: string): number | null {
    const match = message.match(/Error\(Contract,\s*#(\d+)\)/);
    if (match) return parseInt(match[1], 10);
    const simMatch = message.match(/Contract,\s*#(\d+)/);
    if (simMatch) return parseInt(simMatch[1], 10);
    return null;
  }

  /**
   * Parse any error (simulation or transaction) into a user-friendly message.
   */
  static formatError(err: unknown): string {
    let message: string;
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === 'string') {
      message = err;
    } else if (err && typeof err === 'object') {
      // Handle plain objects with a message property (e.g. wallet SDK errors)
      if ('message' in err && typeof (err as any).message === 'string') {
        message = (err as any).message;
      } else {
        try { message = JSON.stringify(err); } catch { message = String(err); }
      }
    } else {
      message = String(err);
    }
    const errorCode = CangkulanService.extractErrorCode(message);
    if (errorCode !== null) {
      return CangkulanService.translateContractError(errorCode);
    }
    // Check for common simulation failure pattern
    if (message.includes('simulation failed') || message.includes('HostError')) {
      const codeMatch = message.match(/#(\d+)/);
      if (codeMatch) {
        const code = parseInt(codeMatch[1], 10);
        if (code >= 1 && code <= 38) {
          return CangkulanService.translateContractError(code);
        }
      }
    }
    return message;
  }

  async checkRequiredSignatures(txXdr: string, publicKey: string): Promise<string[]> {
    const client = this.createSigningClient(publicKey, {
      signTransaction: async (x: string) => ({ signedTxXdr: x }),
      signAuthEntry: async (x: string) => ({ signedAuthEntry: x }),
    });
    const tx = client.txFromXDR(txXdr);
    return await tx.needsNonInvokerSigningBy();
  }

  /**
   * Retry helper for Soroban transaction contention.
   *
   * When two players submit simultaneously, both read/write the same game
   * session storage key.  Soroban's optimistic concurrency causes the second
   * TX to fail (footprint conflict, stale nonce, etc.).  This wrapper detects
   * such transient execution failures and rebuilds the TX from scratch so the
   * fresh simulation picks up the updated ledger state.
   */
  private async withContentionRetry<T>(
    fn: (attempt: number) => Promise<T>,
    maxRetries = 2,
    baseDelayMs = 1500,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        const isContention =
          msg.includes('transaction failed') ||
          msg.includes('txbadseq') ||
          msg.includes('invalidnonce') ||
          msg.includes('expired in flight') ||
          msg.includes('resource_limit_exceeded');

        if (isContention && attempt < maxRetries) {
          const jitter = baseDelayMs * (0.75 + Math.random() * 0.5);
          log.warn(
            `[contention-retry] Attempt ${attempt + 1}/${maxRetries + 1} failed` +
            ` (${(err instanceof Error ? err.message : String(err)).slice(0, 100)}).` +
            ` Retrying in ${Math.round(jitter)}ms…`,
          );
          await new Promise(r => setTimeout(r, jitter));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Contention retry exhausted');
  }

  private extractErrorFromDiagnostics(transactionResponse: any): string {
    try {
      log.error('Transaction response:', JSON.stringify(transactionResponse, null, 2));
      const diagnosticEvents = transactionResponse?.diagnosticEventsXdr ||
        transactionResponse?.diagnostic_events || [];
      for (const event of diagnosticEvents) {
        if (event?.topics) {
          const topics = Array.isArray(event.topics) ? event.topics : [];
          const hasErrorTopic = topics.some((topic: any) => topic?.symbol === 'error' || topic?.error);
          if (hasErrorTopic && event.data) {
            if (typeof event.data === 'string') return event.data;
            else if (event.data.vec && Array.isArray(event.data.vec)) {
              const messages = event.data.vec.filter((item: any) => item?.string).map((item: any) => item.string);
              if (messages.length > 0) return messages.join(': ');
            }
          }
        }
      }
      return `Transaction ${transactionResponse?.status || 'Unknown'}. Check console for details.`;
    } catch (err) {
      log.error('Failed to extract error from diagnostics:', err);
      return 'Transaction failed with unknown error';
    }
  }
}
