#!/usr/bin/env bun

/**
 * Seed Stats Script — Automated On-Chain Game Player
 *
 * Plays real Cangkulan games on Stellar testnet to populate
 * the Stats and Leaderboard pages with live data.
 *
 * Usage:
 *   bun run seed:stats              # Run once
 *   bun run seed:stats --loop       # Play 1 game every 5 minutes
 *   bun run seed:stats --loop 3     # Play 1 game every 3 minutes
 *   bun run seed:stats --wallets 8  # Use 8 wallets (default: 6)
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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile, getEnvValue } from './utils/env';
import { randomBytes } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const REPO_ROOT = join(import.meta.dir, '..');
const ENV_PATH = join(REPO_ROOT, '.env');
const WALLETS_PATH = join(REPO_ROOT, '.seed-wallets.json');

const NETWORK_PASSPHRASE = Networks.TESTNET;
const RPC_URL = 'https://soroban-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

// Read contract IDs from .env (async)
const envContent = await readEnvFile(ENV_PATH);
const CONTRACT_ID = getEnvValue(envContent, 'VITE_CANGKULAN_CONTRACT_ID');
if (!CONTRACT_ID) {
  console.error('❌ VITE_CANGKULAN_CONTRACT_ID not found in .env');
  process.exit(1);
}

// Card constants
const CARDS_PER_SUIT = 9;
const DECK_SIZE = 36;
const CANNOT_FOLLOW_SENTINEL = 0xFFFFFFFF;

// Game lifecycle states
const LIFECYCLE = {
  SEED_COMMIT: 1,
  SEED_REVEAL: 2,
  PLAYING: 3,
  FINISHED: 4,
} as const;

// Trick states
const TRICK = {
  NONE: 0,
  COMMIT_WAIT_BOTH: 1,
  COMMIT_WAIT_P1: 2,
  COMMIT_WAIT_P2: 3,
  REVEAL_WAIT_BOTH: 4,
  REVEAL_WAIT_P1: 5,
  REVEAL_WAIT_P2: 6,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
//  Crypto Helpers (NIZK Mode — hash-only, no BLS12-381 needed)
// ═══════════════════════════════════════════════════════════════════════════════

function generateRandomBytes(len: number): Uint8Array {
  return new Uint8Array(randomBytes(len));
}

/** keccak256 hash → Buffer */
function keccak(data: Uint8Array): Buffer {
  return Buffer.from(keccak256(data), 'hex');
}

/** seed_hash = keccak256(seed) */
function computeSeedHash(seed: Uint8Array): Buffer {
  return keccak(seed);
}

/**
 * NIZK commit hash: keccak256(seedHash || blinding || playerAddressBytes)
 * This is Mode 2 in the ZK verifier.
 */
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

  // Commitment (same as commit hash)
  const commitment = computeNizkCommitHash(seedHash, blinding, playerAddress);

  // Challenge: keccak256(commitment || session_id_be4 || playerAddress || "ZKV2")
  const sidBuf = new Uint8Array(4);
  new DataView(sidBuf.buffer).setUint32(0, sessionId, false);
  const tag = new Uint8Array([0x5A, 0x4B, 0x56, 0x32]); // "ZKV2"

  const challengePre = new Uint8Array(32 + 4 + addrBytes.length + 4);
  challengePre.set(commitment, 0);
  challengePre.set(sidBuf, 32);
  challengePre.set(addrBytes, 36);
  challengePre.set(tag, 36 + addrBytes.length);
  const challenge = keccak(challengePre);

  // Response: keccak256(seedHash || challenge || blinding)
  const responsePre = new Uint8Array(96);
  responsePre.set(seedHash, 0);
  responsePre.set(challenge, 32);
  responsePre.set(blinding, 64);
  const response = keccak(responsePre);

  // Proof: blinding(32) || response(32) = 64 bytes
  const proof = Buffer.alloc(64);
  Buffer.from(blinding).copy(proof, 0);
  response.copy(proof, 32);
  return proof;
}

/** Play commit hash: keccak256(card_id_u32_be(4) || salt(32)) */
function computePlayCommitHash(cardId: number, salt: Uint8Array): Buffer {
  const pre = Buffer.alloc(36);
  pre.writeUInt32BE(cardId, 0);
  Buffer.from(salt).copy(pre, 4);
  return keccak(pre);
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

interface WalletData {
  publicKey: string;
  secret: string;
}

interface WalletsFile {
  wallets: WalletData[];
  created: string;
}

function loadOrCreateWallets(count: number): Keypair[] {
  if (existsSync(WALLETS_PATH)) {
    try {
      const data: WalletsFile = JSON.parse(readFileSync(WALLETS_PATH, 'utf-8'));
      if (data.wallets.length >= count) {
        console.log(`📂 Loaded ${data.wallets.length} wallets from .seed-wallets.json`);
        return data.wallets.slice(0, count).map(w => Keypair.fromSecret(w.secret));
      }
      // Need more wallets — extend the existing set
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
    wallets: wallets.map(kp => ({
      publicKey: kp.publicKey(),
      secret: kp.secret(),
    })),
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
    // Already funded or other error
    const text = await resp.text();
    if (text.includes('createAccountAlreadyExist') || text.includes('already exists')) {
      console.log(`  ✅ Already funded ${publicKey.slice(0, 8)}...${publicKey.slice(-4)}`);
      return true;
    }
    // Rate limited or other transient error — still might be funded
    if (resp.status === 400 || resp.status === 429) {
      // Check if account exists via RPC
      try {
        const server = new rpc.Server(RPC_URL);
        await server.getAccount(publicKey);
        console.log(`  ✅ Already funded ${publicKey.slice(0, 8)}...${publicKey.slice(-4)}`);
        return true;
      } catch {
        console.log(`  ⚠️  Friendbot returned ${resp.status} for ${publicKey.slice(0, 8)}..., retrying...`);
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
  // Fund in parallel batches of 3 to avoid rate limiting
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

/** Read-only client (no signing) */
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

async function getGameView(
  sessionId: number,
  viewer: string,
): Promise<CangkulanGame | null> {
  try {
    const client = makeReadClient();
    const tx = await client.get_game_view({ session_id: sessionId, viewer });
    const result = await tx.simulate();
    if (result.result.isOk()) return result.result.unwrap();
    return null;
  } catch {
    return null;
  }
}

async function getGame(sessionId: number): Promise<CangkulanGame | null> {
  try {
    const client = makeReadClient();
    const tx = await client.get_game({ session_id: sessionId });
    const result = await tx.simulate();
    if (result.result.isOk()) return result.result.unwrap();
    return null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Transaction Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT = 30; // seconds

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

/** Helper to create i128 ScVal from bigint */
function i128ScVal(value: bigint): xdr.ScVal {
  const lo = value & BigInt('0xFFFFFFFFFFFFFFFF');
  const hi = value >> 64n;
  return xdr.ScVal.scvI128(new xdr.Int128Parts({
    lo: xdr.Uint64.fromString(lo.toString()),
    hi: xdr.Int64.fromString(hi.toString()),
  }));
}

/**
 * Start a game with dual auth.
 * Player 2 is the invoker (transaction source).
 * Player 1's auth entry is signed explicitly.
 */
async function startGame(
  sessionId: number,
  p1: Keypair,
  p2: Keypair,
  p1Points: bigint,
  p2Points: bigint,
): Promise<string> {
  // Use the generated Client for simulation
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

  // Get current ledger for auth entry expiration
  const server = new rpc.Server(RPC_URL);
  const validUntilLedger = (await server.getLatestLedger()).sequence + 100;

  // Sign P1's auth entry
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

  if (!p1Signed) {
    throw new Error(`No auth entry found for P1 (${p1.publicKey().slice(0, 8)}...)`);
  }

  // Sync auth entries to the built transaction
  const builtTx = tx as any;
  if (builtTx.built?.operations?.[0]) {
    builtTx.built.operations[0].auth = authEntries;
  }

  // Sign envelope as P2 and submit
  const txXdr = tx.toXDR();
  const txObj = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
  txObj.sign(p2);

  const sendResponse = await server.sendTransaction(txObj);
  if (sendResponse.status === 'ERROR') {
    throw new Error(`TX submission failed: ${JSON.stringify(sendResponse.errorResult)}`);
  }

  // Poll for confirmation
  const txHash = sendResponse.hash;
  let getResponse = await server.getTransaction(txHash);
  const deadline = Date.now() + 30_000;
  while (getResponse.status === 'NOT_FOUND' && Date.now() < deadline) {
    await sleep(1000);
    getResponse = await server.getTransaction(txHash);
  }
  if (getResponse.status === 'FAILED') {
    throw new Error(`TX failed on-chain`);
  }
  if (getResponse.status === 'NOT_FOUND') {
    throw new Error('TX not confirmed within 30s');
  }
  return txHash;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Game Bot — Full Game Orchestration
// ═══════════════════════════════════════════════════════════════════════════════

interface SeedData {
  seed: Uint8Array;
  blinding: Uint8Array;
  seedHash: Buffer;
  commitHash: Buffer;
}

function prepareSeed(playerAddress: string): SeedData {
  const seed = generateRandomBytes(32);
  const blinding = generateRandomBytes(32);
  const seedHash = computeSeedHash(seed);
  const commitHash = computeNizkCommitHash(seedHash, blinding, playerAddress);
  return { seed, blinding, seedHash, commitHash };
}

async function commitSeed(
  sessionId: number,
  player: Keypair,
  commitHash: Buffer,
): Promise<void> {
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
  const proof = buildNizkProof(
    seedData.seedHash,
    seedData.blinding,
    sessionId,
    player.publicKey(),
  );
  const client = makeClient(player);
  const tx = await client.reveal_seed({
    session_id: sessionId,
    player: player.publicKey(),
    seed_hash: seedData.seedHash,
    proof,
  }, { timeoutInSeconds: DEFAULT_TIMEOUT });
  await signAndSend(tx);
}

async function commitPlay(
  sessionId: number,
  player: Keypair,
  cardId: number,
  salt: Uint8Array,
  nonce: number,
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
  sessionId: number,
  player: Keypair,
  cardId: number,
  salt: Uint8Array,
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

/**
 * Choose the best card to play for a given hand and trick suit.
 * Strategy: play the highest matching card for variety.
 */
function chooseCard(hand: number[], trickSuit: number): { cardId: number; canFollow: boolean } {
  const matching = hand.filter(c => cardSuit(c) === trickSuit);
  if (matching.length === 0) {
    return { cardId: CANNOT_FOLLOW_SENTINEL, canFollow: false };
  }
  // Play the highest value card of the matching suit
  matching.sort((a, b) => cardValue(b) - cardValue(a));
  return { cardId: matching[0], canFollow: true };
}

/**
 * Play a full game from start to finish.
 */
async function playFullGame(
  sessionId: number,
  p1: Keypair,
  p2: Keypair,
): Promise<{ winner: string; tricks: number; outcome: number }> {
  const p1Addr = p1.publicKey();
  const p2Addr = p2.publicKey();
  const shortP1 = `${p1Addr.slice(0, 6)}…`;
  const shortP2 = `${p2Addr.slice(0, 6)}…`;

  console.log(`\n🎮 Game #${sessionId}: ${shortP1} vs ${shortP2}`);

  // ── 1. Start game ──────────────────────────────────────────────────────
  console.log('  📋 Starting game...');
  const txHash = await startGame(sessionId, p1, p2, 100n, 100n);
  console.log(`  ✅ Game started (tx: ${txHash.slice(0, 12)}...)`);

  // ── 2. Commit seeds ────────────────────────────────────────────────────
  console.log('  🌱 Committing seeds...');
  const seed1 = prepareSeed(p1Addr);
  const seed2 = prepareSeed(p2Addr);

  await commitSeed(sessionId, p1, seed1.commitHash);
  console.log(`     P1 seed committed`);
  await commitSeed(sessionId, p2, seed2.commitHash);
  console.log(`     P2 seed committed`);

  // ── 3. Reveal seeds ────────────────────────────────────────────────────
  console.log('  🔓 Revealing seeds (NIZK ZK proof)...');
  await revealSeed(sessionId, p1, seed1);
  console.log(`     P1 seed revealed`);
  await revealSeed(sessionId, p2, seed2);
  console.log(`     P2 seed revealed → deck shuffled & dealt!`);

  // ── 4. Play tricks ─────────────────────────────────────────────────────
  console.log('  🃏 Playing tricks...');
  let trickCount = 0;
  const MAX_TRICKS = 50; // Safety limit

  while (trickCount < MAX_TRICKS) {
    // Fetch game state
    let game = await getGame(sessionId);
    if (!game) throw new Error('Failed to fetch game state');

    if (game.lifecycle_state === LIFECYCLE.FINISHED) break;
    if (game.lifecycle_state !== LIFECYCLE.PLAYING) {
      throw new Error(`Unexpected lifecycle state: ${game.lifecycle_state}`);
    }

    // Wait for trick to be ready (should have flipped_card and trick_suit)
    if (game.trick_suit == null && game.flipped_card == null) {
      // This could happen if we're between tricks. Wait and retry.
      await sleep(2000);
      game = await getGame(sessionId);
      if (!game || game.lifecycle_state === LIFECYCLE.FINISHED) break;
    }

    const trickSuit = game.trick_suit ?? 0;
    const flipped = game.flipped_card;
    trickCount++;

    if (flipped != null) {
      console.log(`     Trick ${trickCount}: lead card ${cardLabel(flipped)} (suit: ${SUIT_NAMES[trickSuit]})`);
    }

    // Get each player's hand via get_game_view
    const p1View = await getGameView(sessionId, p1Addr);
    const p2View = await getGameView(sessionId, p2Addr);
    if (!p1View || !p2View) throw new Error('Failed to get game views');

    const hand1 = p1View.hand1 ?? [];
    const hand2 = p2View.hand2 ?? [];

    // Choose cards
    const p1Choice = chooseCard(hand1 as number[], trickSuit);
    const p2Choice = chooseCard(hand2 as number[], trickSuit);

    const p1Label = p1Choice.canFollow ? cardLabel(p1Choice.cardId) : 'Cangkul!';
    const p2Label = p2Choice.canFollow ? cardLabel(p2Choice.cardId) : 'Cangkul!';

    // Generate salts
    const salt1 = generateRandomBytes(32);
    const salt2 = generateRandomBytes(32);

    // ── Commit phase ──────────────────────────────────────────────────
    // Need fresh nonce before each commit
    game = await getGame(sessionId);
    if (!game || game.lifecycle_state === LIFECYCLE.FINISHED) break;
    const nonce = game.action_nonce;

    try {
      await commitPlay(sessionId, p1, p1Choice.cardId, salt1, nonce);
    } catch (err: any) {
      // Nonce may have changed, re-fetch
      const freshGame = await getGame(sessionId);
      if (freshGame && freshGame.lifecycle_state === LIFECYCLE.FINISHED) break;
      throw err;
    }

    // Fetch updated nonce for P2
    game = await getGame(sessionId);
    if (!game || game.lifecycle_state === LIFECYCLE.FINISHED) break;

    await commitPlay(sessionId, p2, p2Choice.cardId, salt2, game.action_nonce);

    // ── Reveal phase ──────────────────────────────────────────────────
    await revealPlay(sessionId, p1, p1Choice.cardId, salt1);
    await revealPlay(sessionId, p2, p2Choice.cardId, salt2);

    console.log(`       P1: ${p1Label}, P2: ${p2Label}`);

    // Small delay between tricks
    await sleep(500);
  }

  // ── 5. Game finished ───────────────────────────────────────────────────
  const finalGame = await getGame(sessionId);
  if (!finalGame) throw new Error('Failed to fetch final game state');

  const outcome = finalGame.outcome;
  let winnerLabel: string;
  if (outcome === 1) winnerLabel = `P1 (${shortP1})`;
  else if (outcome === 2) winnerLabel = `P2 (${shortP2})`;
  else winnerLabel = 'Draw';

  console.log(`  🏆 Result: ${winnerLabel} | Tricks: P1=${finalGame.tricks_won1}, P2=${finalGame.tricks_won2} | Total tricks: ${trickCount}`);

  return {
    winner: winnerLabel,
    tricks: trickCount,
    outcome,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateSessionId(): number {
  // Random session ID in a reasonable range (avoid collisions)
  return 900000 + Math.floor(Math.random() * 99000);
}

function pickRandomPair(wallets: Keypair[]): [Keypair, Keypair] {
  const indices = [...Array(wallets.length).keys()];
  // Fisher-Yates shuffle first two
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
  // Parse CLI arguments
  const args = process.argv.slice(2);
  const isLoop = args.includes('--loop');
  const walletCountIdx = args.indexOf('--wallets');
  const walletCount = walletCountIdx >= 0 ? parseInt(args[walletCountIdx + 1]) || 6 : 6;
  const loopIdx = args.indexOf('--loop');
  const loopInterval = loopIdx >= 0 && args[loopIdx + 1] && !args[loopIdx + 1].startsWith('--')
    ? parseInt(args[loopIdx + 1]) || 5
    : 5;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🎲 Cangkulan Seed Stats — Automated Game Player');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Contract:   ${CONTRACT_ID.slice(0, 12)}...`);
  console.log(`  Network:    Stellar Testnet`);
  console.log(`  Wallets:    ${walletCount}`);
  console.log(`  Mode:       ${isLoop ? `Loop (every ${loopInterval} min)` : 'Single game'}`);
  console.log('');

  // 1. Load or create wallets
  const wallets = loadOrCreateWallets(walletCount);

  // 2. Fund all wallets
  await ensureWalletsFunded(wallets);

  // 3. Play games
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
