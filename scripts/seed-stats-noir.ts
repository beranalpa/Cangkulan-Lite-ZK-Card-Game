#!/usr/bin/env bun

/**
 * Seed Stats Script — Noir UltraKeccakHonk Mode (Hybrid)
 *
 * Exercises the full Noir ZK proof pipeline (blake2s circuit +
 * UltraKeccakHonk prover via @aztec/bb.js), producing ~14KB proofs off-chain.
 *
 * On-chain submission uses NIZK (64-byte) proofs because UltraHonk
 * verification exceeds Soroban's per-tx CPU budget on testnet.
 * Full on-chain Noir verification requires Protocol 25 BN254 precompiles.
 *
 * Usage:
 *   bun run seed:noir              # Run once
 *   bun run seed:noir --loop       # Play 1 game every 5 minutes
 *   bun run seed:noir --loop 3     # Play 1 game every 3 minutes
 *   bun run seed:noir --wallets 8  # Use 8 wallets (default: 6)
 *
 * Note: Noir proof generation takes 2-10 s per proof (WASM proof gen).
 *       Each game needs 2 proofs (one per player), so seed reveal is slower.
 */

import {
  Keypair,
  TransactionBuilder,
  hash,
  rpc,
  Address,
  authorizeEntry,
  xdr,
  contract,
  Networks,
} from '@stellar/stellar-sdk';
import { Client as CangkulanClient } from '../bindings/cangkulan/src/index';
import type { CangkulanGame } from '../bindings/cangkulan/src/index';
import { Buffer } from 'buffer';
import { keccak256 } from 'js-sha3';
import { blake2s } from '@noble/hashes/blake2.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile, getEnvValue } from './utils/env';
import { randomBytes } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════════
//  Noir Prover — lazy-loaded from cangkulan-frontend deps
// ═══════════════════════════════════════════════════════════════════════════════

// Resolve @noir-lang and @aztec from cangkulan-frontend/node_modules
const FRONTEND_ROOT = join(import.meta.dir, '..', 'cangkulan-frontend');
const CIRCUIT_PATH = join(FRONTEND_ROOT, 'public', 'seed_verify_circuit.json');

let cachedNoir: any = null;
let cachedBackend: any = null;

async function ensureNoirInitialized(): Promise<{ noir: any; backend: any }> {
  if (cachedNoir && cachedBackend) return { noir: cachedNoir, backend: cachedBackend };

  console.log('  ⚡ Loading Noir circuit + UltraHonk backend (first time)...');
  const startMs = Date.now();

  // Dynamic imports from cangkulan-frontend's node_modules
  const noirMod = await import(join(FRONTEND_ROOT, 'node_modules', '@noir-lang', 'noir_js', 'lib', 'index.mjs'));
  const bbMod = await import(join(FRONTEND_ROOT, 'node_modules', '@aztec', 'bb.js', 'dest', 'node', 'index.js'));
  const Noir = noirMod.Noir;
  const UltraHonkBackend = bbMod.UltraHonkBackend;

  // Load circuit JSON
  const circuitJson = JSON.parse(readFileSync(CIRCUIT_PATH, 'utf-8'));
  const bytecode = circuitJson.bytecode;
  if (!bytecode) throw new Error('Circuit JSON missing bytecode field');

  cachedBackend = new UltraHonkBackend(bytecode);
  cachedNoir = new Noir(circuitJson);

  console.log(`  ⚡ Noir initialized in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
  return { noir: cachedNoir, backend: cachedBackend };
}

interface NoirProofResult {
  proof: Uint8Array;
  publicInputs: string[];
  proofTimeMs: number;
}

async function generateNoirProof(
  seed: Uint8Array,
  seedHashBlake2s: Uint8Array,
): Promise<NoirProofResult> {
  if (seed.length !== 32) throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  if (seedHashBlake2s.length !== 32) throw new Error(`seedHash must be 32 bytes, got ${seedHashBlake2s.length}`);

  const startTime = performance.now();
  const { noir, backend } = await ensureNoirInitialized();

  const inputMap: Record<string, string[]> = {
    seed: Array.from(seed).map(b => b.toString()),
    seed_hash: Array.from(seedHashBlake2s).map(b => b.toString()),
  };

  const { witness } = await noir.execute(inputMap);
  const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true });

  const proofTimeMs = Math.round(performance.now() - startTime);
  return { proof, publicInputs, proofTimeMs };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const REPO_ROOT = join(import.meta.dir, '..');
const ENV_PATH = join(REPO_ROOT, '.env');
const WALLETS_PATH = join(REPO_ROOT, '.seed-wallets.json');

const NETWORK_PASSPHRASE = Networks.TESTNET;
const RPC_URL = 'https://soroban-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

const envContent = await readEnvFile(ENV_PATH);
const CONTRACT_ID = getEnvValue(envContent, 'VITE_CANGKULAN_CONTRACT_ID');
if (!CONTRACT_ID) {
  console.error('❌ VITE_CANGKULAN_CONTRACT_ID not found in .env');
  process.exit(1);
}

const CARDS_PER_SUIT = 9;
const CANNOT_FOLLOW_SENTINEL = 0xFFFFFFFF;

const LIFECYCLE = {
  SEED_COMMIT: 1,
  SEED_REVEAL: 2,
  PLAYING: 3,
  FINISHED: 4,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
//  Crypto Helpers — Noir Mode (blake2s + UltraKeccakHonk)
// ═══════════════════════════════════════════════════════════════════════════════

function generateRandomBytes(len: number): Uint8Array {
  return new Uint8Array(randomBytes(len));
}

function keccak(data: Uint8Array): Buffer {
  return Buffer.from(keccak256(data), 'hex');
}

/** blake2s seed hash — matches the Noir circuit: blake2s(seed) */
function computeBlake2sSeedHash(seed: Uint8Array): Buffer {
  return Buffer.from(blake2s(seed));
}

/** Noir commit hash = keccak256(blake2s_seed_hash) — binding commitment */
function computeNoirCommitHash(blake2sSeedHash: Buffer): Buffer {
  return Buffer.from(keccak256(blake2sSeedHash), 'hex');
}

/** Play commit hash (card plays still use keccak) */
function computePlayCommitHash(cardId: number, salt: Uint8Array): Buffer {
  const pre = Buffer.alloc(36);
  pre.writeUInt32BE(cardId, 0);
  Buffer.from(salt).copy(pre, 4);
  return keccak(pre);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Crypto Helpers — NIZK (for on-chain fallback)
// ═══════════════════════════════════════════════════════════════════════════════

/** NIZK commit hash: keccak256(seedHash || blinding || playerAddressBytes) */
function computeNizkCommitHash(
  seedHash: Buffer,
  blinding: Uint8Array,
  playerAddress: string,
): Buffer {
  const addrBytes = new TextEncoder().encode(playerAddress);
  const preimage = new Uint8Array(32 + 32 + addrBytes.length);
  preimage.set(seedHash, 0);
  preimage.set(blinding, 32);
  preimage.set(addrBytes, 64);
  return keccak(preimage);
}

/**
 * Build 64-byte NIZK proof: blinding(32) || response(32)
 *
 * Protocol:
 *   commitment = keccak256(seedHash || blinding || playerAddress)
 *   challenge  = keccak256(commitment || session_id_be4 || playerAddress || "ZKV2")
 *   response   = keccak256(seedHash || challenge || blinding)
 */
function buildNizkProof(
  seedHash: Buffer,
  blinding: Uint8Array,
  sessionId: number,
  playerAddress: string,
): Buffer {
  const addrBytes = new TextEncoder().encode(playerAddress);
  const commitment = computeNizkCommitHash(seedHash, blinding, playerAddress);

  const sidBuf = new Uint8Array(4);
  new DataView(sidBuf.buffer).setUint32(0, sessionId, false);
  const tag = new Uint8Array([0x5A, 0x4B, 0x56, 0x32]); // "ZKV2"

  const challengePre = new Uint8Array(32 + 4 + addrBytes.length + 4);
  challengePre.set(commitment, 0);
  challengePre.set(sidBuf, 32);
  challengePre.set(addrBytes, 36);
  challengePre.set(tag, 36 + addrBytes.length);
  const challenge = keccak(challengePre);

  const responsePre = new Uint8Array(96);
  responsePre.set(seedHash, 0);
  responsePre.set(challenge, 32);
  responsePre.set(blinding, 64);
  const response = keccak(responsePre);

  const proof = Buffer.alloc(64);
  Buffer.from(blinding).copy(proof, 0);
  response.copy(proof, 32);
  return proof;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Card Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const SUIT_NAMES = ['♠', '♥', '♦', '♣'];
const VALUE_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', '10'];

function cardLabel(cardId: number): string {
  if (cardId === CANNOT_FOLLOW_SENTINEL) return 'Cangkul!';
  const suit = Math.floor(cardId / CARDS_PER_SUIT);
  const value = cardId % CARDS_PER_SUIT;
  return `${VALUE_NAMES[value]}${SUIT_NAMES[suit]}`;
}

function cardSuit(cardId: number): number {
  return Math.floor(cardId / CARDS_PER_SUIT);
}

function cardValue(cardId: number): number {
  return cardId % CARDS_PER_SUIT;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Wallet Management
// ═══════════════════════════════════════════════════════════════════════════════

interface WalletData { publicKey: string; secret: string; }
interface WalletsFile { wallets: WalletData[]; created: string; }

function loadOrCreateWallets(count: number): Keypair[] {
  if (existsSync(WALLETS_PATH)) {
    try {
      const data: WalletsFile = JSON.parse(readFileSync(WALLETS_PATH, 'utf-8'));
      if (data.wallets.length >= count) {
        console.log(`📂 Loaded ${data.wallets.length} wallets from .seed-wallets.json`);
        return data.wallets.slice(0, count).map(w => Keypair.fromSecret(w.secret));
      }
      const existing = data.wallets.map(w => Keypair.fromSecret(w.secret));
      const needed = count - existing.length;
      console.log(`📂 Loaded ${existing.length} wallets, generating ${needed} more...`);
      const newWallets = Array.from({ length: needed }, () => Keypair.random());
      const allWallets = [...existing, ...newWallets];
      saveWallets(allWallets);
      return allWallets;
    } catch {
      console.log('⚠️  Failed to parse .seed-wallets.json, regenerating...');
    }
  }
  console.log(`🔑 Generating ${count} new wallets...`);
  const wallets = Array.from({ length: count }, () => Keypair.random());
  saveWallets(wallets);
  return wallets;
}

function saveWallets(wallets: Keypair[]) {
  const data: WalletsFile = {
    wallets: wallets.map(kp => ({ publicKey: kp.publicKey(), secret: kp.secret() })),
    created: new Date().toISOString(),
  };
  writeFileSync(WALLETS_PATH, JSON.stringify(data, null, 2));
  console.log(`💾 Saved ${wallets.length} wallets to .seed-wallets.json`);
}

async function fundWallet(publicKey: string): Promise<boolean> {
  try {
    const resp = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
    if (resp.ok) {
      console.log(`  💰 Funded ${publicKey.slice(0, 8)}...${publicKey.slice(-4)}`);
      return true;
    }
    const text = await resp.text();
    if (text.includes('createAccountAlreadyExist') || text.includes('already exists')) {
      console.log(`  ✅ Already funded ${publicKey.slice(0, 8)}...${publicKey.slice(-4)}`);
      return true;
    }
    if (resp.status === 400 || resp.status === 429) {
      try {
        const server = new rpc.Server(RPC_URL);
        await server.getAccount(publicKey);
        console.log(`  ✅ Already funded ${publicKey.slice(0, 8)}...${publicKey.slice(-4)}`);
        return true;
      } catch {
        console.log(`  ⚠️  Friendbot returned ${resp.status}, retrying...`);
        await sleep(2000);
        const retry = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
        if (retry.ok) {
          console.log(`  💰 Funded ${publicKey.slice(0, 8)}...${publicKey.slice(-4)} (retry)`);
          return true;
        }
      }
    }
    console.log(`  ⚠️  Friendbot returned ${resp.status} for ${publicKey.slice(0, 8)}...`);
    return false;
  } catch (err) {
    console.log(`  ❌ Friendbot error for ${publicKey.slice(0, 8)}...: ${err}`);
    return false;
  }
}

async function ensureWalletsFunded(wallets: Keypair[]): Promise<void> {
  console.log('\n💰 Ensuring wallets are funded via Friendbot...');
  for (let i = 0; i < wallets.length; i += 3) {
    const batch = wallets.slice(i, i + 3);
    await Promise.all(batch.map(kp => fundWallet(kp.publicKey())));
    if (i + 3 < wallets.length) await sleep(1000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Contract Client Factory
// ═══════════════════════════════════════════════════════════════════════════════

function makeClient(kp: Keypair): CangkulanClient {
  return new CangkulanClient({
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: kp.publicKey(),
    signTransaction: async (txXdr: string, opts: any) => {
      const tx = TransactionBuilder.fromXDR(txXdr, opts?.networkPassphrase ?? NETWORK_PASSPHRASE);
      tx.sign(kp);
      return { signedTxXdr: tx.toXDR(), signerAddress: kp.publicKey() };
    },
    signAuthEntry: async (preimageXdr: string) => {
      const preimageBytes = Buffer.from(preimageXdr, 'base64');
      const payload = hash(preimageBytes);
      const sig = kp.sign(payload);
      return { signedAuthEntry: Buffer.from(sig).toString('base64'), signerAddress: kp.publicKey() };
    },
  });
}

function makeReadClient(): CangkulanClient {
  return new CangkulanClient({
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Game State Helpers
// ═══════════════════════════════════════════════════════════════════════════════

async function getGameView(sessionId: number, viewer: string): Promise<CangkulanGame | null> {
  try {
    const client = makeReadClient();
    const tx = await client.get_game_view({ session_id: sessionId, viewer });
    const result = await tx.simulate();
    if (result.result.isOk()) return result.result.unwrap();
    return null;
  } catch { return null; }
}

async function getGame(sessionId: number): Promise<CangkulanGame | null> {
  try {
    const client = makeReadClient();
    const tx = await client.get_game({ session_id: sessionId });
    const result = await tx.simulate();
    if (result.result.isOk()) return result.result.unwrap();
    return null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Transaction Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT = 30;

async function signAndSend(tx: contract.AssembledTransaction<any>): Promise<contract.SentTransaction<any>> {
  const simulated = await tx.simulate();
  try {
    return await simulated.signAndSend();
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('NoSignatureNeeded') || msg.includes('read call') || msg.includes('force: true')) {
      return await simulated.signAndSend({ force: true });
    }
    throw err;
  }
}

function i128ScVal(value: bigint): xdr.ScVal {
  const lo = value & BigInt('0xFFFFFFFFFFFFFFFF');
  const hi = value >> 64n;
  return xdr.ScVal.scvI128(new xdr.Int128Parts({
    lo: xdr.Uint64.fromString(lo.toString()),
    hi: xdr.Int64.fromString(hi.toString()),
  }));
}

async function startGame(
  sessionId: number, p1: Keypair, p2: Keypair,
  p1Points: bigint, p2Points: bigint,
): Promise<string> {
  const client2 = makeClient(p2);
  const tx = await client2.start_game({
    session_id: sessionId,
    player1: p1.publicKey(),
    player2: p2.publicKey(),
    player1_points: p1Points,
    player2_points: p2Points,
  }, { timeoutInSeconds: DEFAULT_TIMEOUT });

  if (!tx.simulationData?.result?.auth) {
    throw new Error('No auth entries found in simulation');
  }

  const server = new rpc.Server(RPC_URL);
  const validUntilLedger = (await server.getLatestLedger()).sequence + 100;
  const authEntries = tx.simulationData.result.auth;
  let p1Signed = false;

  for (let i = 0; i < authEntries.length; i++) {
    const entry = authEntries[i];
    try {
      if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') continue;
      const addr = Address.fromScAddress(entry.credentials().address().address()).toString();
      if (addr !== p1.publicKey()) continue;
      authEntries[i] = await authorizeEntry(
        entry,
        async (preimage) => p1.sign(hash(preimage.toXDR())),
        validUntilLedger,
        NETWORK_PASSPHRASE,
      );
      p1Signed = true;
      break;
    } catch { continue; }
  }

  if (!p1Signed) throw new Error(`No auth entry found for P1 (${p1.publicKey().slice(0, 8)}...)`);

  const builtTx = tx as any;
  if (builtTx.built?.operations?.[0]) {
    builtTx.built.operations[0].auth = authEntries;
  }

  const txXdr = tx.toXDR();
  const txObj = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
  txObj.sign(p2);

  const sendResponse = await server.sendTransaction(txObj);
  if (sendResponse.status === 'ERROR') {
    throw new Error(`TX submission failed: ${JSON.stringify(sendResponse.errorResult)}`);
  }

  const txHash = sendResponse.hash;
  let getResponse = await server.getTransaction(txHash);
  const deadline = Date.now() + 30_000;
  while (getResponse.status === 'NOT_FOUND' && Date.now() < deadline) {
    await sleep(1000);
    getResponse = await server.getTransaction(txHash);
  }
  if (getResponse.status === 'FAILED') throw new Error('TX failed on-chain');
  if (getResponse.status === 'NOT_FOUND') throw new Error('TX not confirmed within 30s');
  return txHash;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Game Bot — Noir Mode
// ═══════════════════════════════════════════════════════════════════════════════

interface SeedData {
  seed: Uint8Array;
  blinding: Uint8Array;
  seedHashBlake2s: Buffer;  // blake2s(seed) — used by Noir circuit
  seedHashKeccak: Buffer;   // keccak256(seed) — used by NIZK on-chain
  commitHash: Buffer;       // NIZK commit: keccak256(seedHashKeccak || blinding || address)
}

function prepareSeed(playerAddress: string): SeedData {
  const seed = generateRandomBytes(32);
  const blinding = generateRandomBytes(32);
  const seedHashBlake2s = computeBlake2sSeedHash(seed);
  const seedHashKeccak = keccak(seed);
  const commitHash = computeNizkCommitHash(seedHashKeccak, blinding, playerAddress);
  return { seed, blinding, seedHashBlake2s, seedHashKeccak, commitHash };
}

async function commitSeed(sessionId: number, player: Keypair, commitHash: Buffer): Promise<void> {
  const client = makeClient(player);
  const tx = await client.commit_seed({
    session_id: sessionId,
    player: player.publicKey(),
    commit_hash: commitHash,
  }, { timeoutInSeconds: DEFAULT_TIMEOUT });
  await signAndSend(tx);
}

async function revealSeed(
  sessionId: number,
  player: Keypair,
  seedData: SeedData,
): Promise<void> {
  const label = player.publicKey().slice(0, 6);

  // 1. Generate Noir proof off-chain (exercise the full pipeline)
  console.log(`     ${label}… Generating Noir UltraKeccakHonk proof (off-chain)…`);
  const noirResult = await generateNoirProof(seedData.seed, seedData.seedHashBlake2s);
  console.log(`     ${label}… Noir proof: ${(noirResult.proofTimeMs / 1000).toFixed(1)}s, ${noirResult.proof.length} bytes`);

  // 2. Build NIZK proof for on-chain submission (on-chain Noir requires BN254 precompiles)
  const nizkProof = buildNizkProof(
    seedData.seedHashKeccak,
    seedData.blinding,
    sessionId,
    player.publicKey(),
  );

  const client = makeClient(player);
  const tx = await client.reveal_seed({
    session_id: sessionId,
    player: player.publicKey(),
    seed_hash: seedData.seedHashKeccak,
    proof: nizkProof,
  }, { timeoutInSeconds: DEFAULT_TIMEOUT });
  await signAndSend(tx);
  console.log(`     ${label}… Seed revealed on-chain (NIZK fallback, 64 bytes)`);
}

async function commitPlay(
  sessionId: number, player: Keypair,
  cardId: number, salt: Uint8Array, nonce: number,
): Promise<void> {
  const commitHash = computePlayCommitHash(cardId, salt);
  const client = makeClient(player);
  const tx = await client.commit_play({
    session_id: sessionId,
    player: player.publicKey(),
    commit_hash: commitHash,
    expected_nonce: nonce,
  }, { timeoutInSeconds: DEFAULT_TIMEOUT });
  await signAndSend(tx);
}

async function revealPlay(
  sessionId: number, player: Keypair,
  cardId: number, salt: Uint8Array,
): Promise<void> {
  const client = makeClient(player);
  const tx = await client.reveal_play({
    session_id: sessionId,
    player: player.publicKey(),
    card_id: cardId,
    salt: Buffer.from(salt),
  }, { timeoutInSeconds: DEFAULT_TIMEOUT });
  await signAndSend(tx);
}

function chooseCard(hand: number[], trickSuit: number): { cardId: number; canFollow: boolean } {
  const matching = hand.filter(c => cardSuit(c) === trickSuit);
  if (matching.length === 0) return { cardId: CANNOT_FOLLOW_SENTINEL, canFollow: false };
  matching.sort((a, b) => cardValue(b) - cardValue(a));
  return { cardId: matching[0], canFollow: true };
}

async function playFullGame(
  sessionId: number, p1: Keypair, p2: Keypair,
): Promise<{ winner: string; tricks: number; outcome: number }> {
  const p1Addr = p1.publicKey();
  const p2Addr = p2.publicKey();
  const shortP1 = `${p1Addr.slice(0, 6)}…`;
  const shortP2 = `${p2Addr.slice(0, 6)}…`;

  console.log(`\n🎮 Game #${sessionId}: ${shortP1} vs ${shortP2}`);

  // 1. Start game
  console.log('  📋 Starting game...');
  const txHash = await startGame(sessionId, p1, p2, 100n, 100n);
  console.log(`  ✅ Game started (tx: ${txHash.slice(0, 12)}...)`);

  // 2. Commit seeds (NIZK commit: keccak256(seedHash || blinding || address))
  console.log('  🌱 Committing seeds (NIZK commitment for on-chain)...');
  const seed1 = prepareSeed(p1Addr);
  const seed2 = prepareSeed(p2Addr);

  await commitSeed(sessionId, p1, seed1.commitHash);
  console.log(`     P1 seed committed`);
  await commitSeed(sessionId, p2, seed2.commitHash);
  console.log(`     P2 seed committed`);

  // 3. Reveal seeds — Noir proof off-chain + NIZK on-chain
  console.log('  🔓 Revealing seeds (Noir off-chain + NIZK on-chain)...');
  await revealSeed(sessionId, p1, seed1);
  await revealSeed(sessionId, p2, seed2);
  console.log(`     Both seeds revealed → deck shuffled & dealt!`);

  // 4. Play tricks
  console.log('  🃏 Playing tricks...');
  let trickCount = 0;
  const MAX_TRICKS = 50;

  while (trickCount < MAX_TRICKS) {
    let game = await getGame(sessionId);
    if (!game) throw new Error('Failed to fetch game state');
    if (game.lifecycle_state === LIFECYCLE.FINISHED) break;
    if (game.lifecycle_state !== LIFECYCLE.PLAYING) {
      throw new Error(`Unexpected lifecycle state: ${game.lifecycle_state}`);
    }

    if (game.trick_suit == null && game.flipped_card == null) {
      await sleep(2000);
      game = await getGame(sessionId);
      if (!game || game.lifecycle_state === LIFECYCLE.FINISHED) break;
    }

    const trickSuit = game.trick_suit ?? 0;
    const flipped = game.flipped_card;
    trickCount++;

    if (flipped != null) {
      console.log(`     Trick ${trickCount}: lead ${cardLabel(flipped)} (suit: ${SUIT_NAMES[trickSuit]})`);
    }

    const p1View = await getGameView(sessionId, p1Addr);
    const p2View = await getGameView(sessionId, p2Addr);
    if (!p1View || !p2View) throw new Error('Failed to get game views');

    const hand1 = p1View.hand1 ?? [];
    const hand2 = p2View.hand2 ?? [];
    const p1Choice = chooseCard(hand1 as number[], trickSuit);
    const p2Choice = chooseCard(hand2 as number[], trickSuit);

    const p1Label = p1Choice.canFollow ? cardLabel(p1Choice.cardId) : 'Cangkul!';
    const p2Label = p2Choice.canFollow ? cardLabel(p2Choice.cardId) : 'Cangkul!';

    const salt1 = generateRandomBytes(32);
    const salt2 = generateRandomBytes(32);

    game = await getGame(sessionId);
    if (!game || game.lifecycle_state === LIFECYCLE.FINISHED) break;
    const nonce = game.action_nonce;

    try {
      await commitPlay(sessionId, p1, p1Choice.cardId, salt1, nonce);
    } catch (err: any) {
      const freshGame = await getGame(sessionId);
      if (freshGame && freshGame.lifecycle_state === LIFECYCLE.FINISHED) break;
      throw err;
    }

    game = await getGame(sessionId);
    if (!game || game.lifecycle_state === LIFECYCLE.FINISHED) break;
    await commitPlay(sessionId, p2, p2Choice.cardId, salt2, game.action_nonce);

    await revealPlay(sessionId, p1, p1Choice.cardId, salt1);
    await revealPlay(sessionId, p2, p2Choice.cardId, salt2);

    console.log(`       P1: ${p1Label}, P2: ${p2Label}`);
    await sleep(500);
  }

  // 5. Game finished
  const finalGame = await getGame(sessionId);
  if (!finalGame) throw new Error('Failed to fetch final game state');

  const outcome = finalGame.outcome;
  let winnerLabel: string;
  if (outcome === 1) winnerLabel = `P1 (${shortP1})`;
  else if (outcome === 2) winnerLabel = `P2 (${shortP2})`;
  else winnerLabel = 'Draw';

  console.log(`  🏆 Result: ${winnerLabel} | Tricks: P1=${finalGame.tricks_won1}, P2=${finalGame.tricks_won2} | Total tricks: ${trickCount}`);

  return { winner: winnerLabel, tricks: trickCount, outcome };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateSessionId(): number {
  return 900000 + Math.floor(Math.random() * 99000);
}

function pickRandomPair(wallets: Keypair[]): [Keypair, Keypair] {
  const indices = [...Array(wallets.length).keys()];
  const i1 = Math.floor(Math.random() * indices.length);
  [indices[0], indices[i1]] = [indices[i1], indices[0]];
  const i2 = 1 + Math.floor(Math.random() * (indices.length - 1));
  [indices[1], indices[i2]] = [indices[i2], indices[1]];
  return [wallets[indices[0]], wallets[indices[1]]];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const isLoop = args.includes('--loop');
  const walletCountIdx = args.indexOf('--wallets');
  const walletCount = walletCountIdx >= 0 ? parseInt(args[walletCountIdx + 1]) || 6 : 6;
  const loopIdx = args.indexOf('--loop');
  const loopInterval = loopIdx >= 0 && args[loopIdx + 1] && !args[loopIdx + 1].startsWith('--')
    ? parseInt(args[loopIdx + 1]) || 5
    : 5;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🌑 Cangkulan Seed Stats — Noir UltraKeccakHonk Mode (Hybrid)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Contract:   ${CONTRACT_ID.slice(0, 12)}...`);
  console.log(`  Proof Mode: Noir blake2s + UltraKeccakHonk (~14KB off-chain)`);
  console.log(`  On-chain:   NIZK fallback (64 bytes) — Noir on-chain needs BN254`);
  console.log(`  Network:    Stellar Testnet`);
  console.log(`  Wallets:    ${walletCount}`);
  console.log(`  Mode:       ${isLoop ? `Loop (every ${loopInterval} min)` : 'Single game'}`);
  console.log(`  ⚠️  Noir proof generated off-chain; NIZK used for on-chain verify`);
  console.log('');

  // Pre-initialize Noir (so the first game doesn't pay the full init cost)
  await ensureNoirInitialized();

  const wallets = loadOrCreateWallets(walletCount);
  await ensureWalletsFunded(wallets);

  let gameCount = 0;
  let totalTricks = 0;
  const outcomes: Record<string, number> = { p1: 0, p2: 0, draw: 0 };

  const playOneGame = async () => {
    gameCount++;
    const sessionId = generateSessionId();
    const [p1, p2] = pickRandomPair(wallets);

    try {
      const result = await playFullGame(sessionId, p1, p2);
      totalTricks += result.tricks;
      if (result.outcome === 1) outcomes.p1++;
      else if (result.outcome === 2) outcomes.p2++;
      else outcomes.draw++;

      console.log(`\n📊 Stats: ${gameCount} games played | ` +
        `Avg tricks: ${(totalTricks / gameCount).toFixed(1)} | ` +
        `P1 wins: ${outcomes.p1}, P2 wins: ${outcomes.p2}, Draws: ${outcomes.draw}`);
    } catch (err) {
      console.error(`\n❌ Game #${sessionId} failed:`, err instanceof Error ? err.message : err);
    }
  };

  await playOneGame();

  if (isLoop) {
    console.log(`\n⏰ Looping: next game in ${loopInterval} minutes...`);
    while (true) {
      await sleep(loopInterval * 60 * 1000);
      await playOneGame();
      console.log(`\n⏰ Next game in ${loopInterval} minutes...`);
    }
  }

  console.log('\n✅ Done!');
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
