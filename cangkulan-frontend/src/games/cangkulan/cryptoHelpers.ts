import { keccak256 } from 'js-sha3';
import { Buffer } from 'buffer';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { blake2s } from '@noble/hashes/blake2.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

// ═══════════════════════════════════════════════════════════════════════════
//  Common helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Generate a random 32-byte seed */
export function generateSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

/**
 * Compute seed_hash = keccak256(seed).
 * The raw seed NEVER leaves the client — only seed_hash is sent on-chain.
 */
export function computeInnerSeedHash(seed: Uint8Array): Buffer {
  const hashHex = keccak256(seed);
  return Buffer.from(hashHex, 'hex');
}

// ═══════════════════════════════════════════════════════════════════════════
//  Noir Mode: blake2s-based commitment
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute seed_hash = blake2s(seed) for Noir circuit compatibility.
 * This matches the Noir circuit's std::hash::blake2s function.
 */
export function computeBlake2sSeedHash(seed: Uint8Array): Buffer {
  return Buffer.from(blake2s(seed));
}

/**
 * Compute commit_hash for Noir mode: keccak256(blake2s_seed_hash).
 * Simple binding — prevents player from changing seed between commit and reveal.
 * Must match the contract's expected_commit = keccak256(seed_hash) check.
 */
export function computeNoirCommitHash(blake2sSeedHash: Buffer): Buffer {
  const hashHex = keccak256(blake2sSeedHash);
  return Buffer.from(hashHex, 'hex');
}
//  Mode 2: NIZK (hash-based) — existing protocol
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the blinded NIZK commitment matching the enhanced ZK verifier:
 *   keccak256(seed_hash(32) || blinding(32) || player_address_string_bytes)
 */
export function computeNizkCommitment(seedHash: Buffer, blinding: Uint8Array, playerAddress: string): Buffer {
  const addressBytes = new TextEncoder().encode(playerAddress);
  const preimage = new Uint8Array(32 + 32 + addressBytes.length);
  preimage.set(seedHash, 0);
  preimage.set(blinding, 32);
  preimage.set(addressBytes, 64);
  const hashHex = keccak256(preimage);
  return Buffer.from(hashHex, 'hex');
}

/**
 * Compute the session-bound nullifier:
 *   keccak256(seed_hash(32) || "NULL"(4) || session_id_be(4))
 */
export function computeNullifier(seedHash: Buffer, sessionId: number): Buffer {
  const pre = new Uint8Array(32 + 4 + 4);
  pre.set(seedHash, 0);
  pre.set(new Uint8Array([0x4E, 0x55, 0x4C, 0x4C]), 32); // "NULL"
  const sidBuf = new Uint8Array(4);
  new DataView(sidBuf.buffer).setUint32(0, sessionId, false); // big-endian
  pre.set(sidBuf, 36);
  return Buffer.from(keccak256(pre), 'hex');
}

/**
 * Compute the Fiat-Shamir challenge:
 *   keccak256(commitment(32) || session_id_be(4) || player_address || "ZKV2"(4))
 */
export function computeChallenge(commitment: Buffer, sessionId: number, playerAddress: string): Buffer {
  const addressBytes = new TextEncoder().encode(playerAddress);
  const pre = new Uint8Array(32 + 4 + addressBytes.length + 4);
  pre.set(commitment, 0);
  const sidBuf = new Uint8Array(4);
  new DataView(sidBuf.buffer).setUint32(0, sessionId, false);
  pre.set(sidBuf, 32);
  pre.set(addressBytes, 36);
  pre.set(new Uint8Array([0x5A, 0x4B, 0x56, 0x32]), 36 + addressBytes.length); // "ZKV2"
  return Buffer.from(keccak256(pre), 'hex');
}

/**
 * Compute the NIZK response:
 *   keccak256(seed_hash(32) || challenge(32) || blinding(32))
 */
export function computeResponse(seedHash: Buffer, challenge: Buffer, blinding: Uint8Array): Buffer {
  const pre = new Uint8Array(96);
  pre.set(seedHash, 0);
  pre.set(challenge, 32);
  pre.set(blinding, 64);
  return Buffer.from(keccak256(pre), 'hex');
}

/**
 * Build the complete 64-byte NIZK proof: blinding(32) || response(32)
 */
export function buildNizkProof(
  seedHash: Buffer,
  blinding: Uint8Array,
  commitment: Buffer,
  sessionId: number,
  playerAddress: string,
): Buffer {
  const challenge = computeChallenge(commitment, sessionId, playerAddress);
  const response = computeResponse(seedHash, challenge, blinding);
  const proof = Buffer.alloc(64);
  Buffer.from(blinding).copy(proof, 0);
  response.copy(proof, 32);
  return proof;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Mode 4: Pedersen + Schnorr/Sigma (BLS12-381) — NEW!
// ═══════════════════════════════════════════════════════════════════════════

/** BLS12-381 Fr field order */
const Fr_ORDER = bls12_381.fields.Fr.ORDER;

/** BLS12-381 G1 point type alias */
type G1Point = InstanceType<typeof bls12_381.G1.Point>;

/**
 * Derive the Pedersen H generator via hash_to_g1("PEDERSEN_H", "SGS_CANGKULAN_V1").
 * Must match the on-chain derivation exactly.
 */
function pedersenH(): G1Point {
  const msg = new TextEncoder().encode('PEDERSEN_H');
  const dst = new TextEncoder().encode('SGS_CANGKULAN_V1');
  return bls12_381.G1.hashToCurve(msg, { DST: dst });
}

/**
 * Convert a 32-byte big-endian buffer to a BLS12-381 Fr scalar (mod r).
 */
function bufferToFr(buf: Uint8Array): bigint {
  const n = bytesToNumberBE(buf);
  return n % Fr_ORDER;
}

/**
 * Serialize a G1 affine point to 96 bytes (uncompressed, x:48||y:48, big-endian).
 * Matches Soroban's G1Affine::to_bytes format.
 */
function g1ToBytes96(point: G1Point): Uint8Array {
  const aff = point.toAffine();
  const xBytes = numberToBytesBE(aff.x, 48);
  const yBytes = numberToBytesBE(aff.y, 48);
  const out = new Uint8Array(96);
  out.set(xBytes, 0);
  out.set(yBytes, 48);
  return out;
}

/**
 * Compute Pedersen commitment: C = Fr(seedHash) · G + Fr(blinding) · H
 * Returns the serialized 96-byte G1 point.
 */
export function computePedersenCommitment(seedHash: Buffer, blinding: Uint8Array): Uint8Array {
  const s = bufferToFr(seedHash);
  const r = bufferToFr(blinding);
  const G = bls12_381.G1.Point.BASE;
  const H = pedersenH();
  const C = G.multiply(s).add(H.multiply(r));
  return g1ToBytes96(C);
}

/**
 * Compute Pedersen commit hash: keccak256(C_bytes).
 * This is what gets stored on-chain as commit_hash (32 bytes).
 */
export function computePedersenCommitHash(seedHash: Buffer, blinding: Uint8Array): Buffer {
  const cBytes = computePedersenCommitment(seedHash, blinding);
  return Buffer.from(keccak256(cBytes), 'hex');
}

/**
 * Build a 224-byte Pedersen proof: C(96) || R(96) || z_r(32)
 *
 * Protocol (Schnorr on blinding with seed binding):
 *   D = C - Fr(seedHash)·G  (should be r·H)
 *   R = k·H  (nonce commitment)
 *   e = Fr(keccak256(C || R || seedHash || session_id_be4 || player || "ZKP4"))
 *   z_r = k + e·r  (response)
 *
 * Verifier checks: z_r·H == R + e·D
 */
export function buildPedersenProof(
  seedHash: Buffer,
  blinding: Uint8Array,
  sessionId: number,
  playerAddress: string,
): Buffer {
  const s = bufferToFr(seedHash);
  const r = bufferToFr(blinding);
  const G = bls12_381.G1.Point.BASE;
  const H = pedersenH();

  // Commitment: C = s·G + r·H
  const C = G.multiply(s).add(H.multiply(r));
  const cBytes = g1ToBytes96(C);

  // Random nonce k (32 bytes → Fr)
  const kRaw = new Uint8Array(32);
  crypto.getRandomValues(kRaw);
  const k = bufferToFr(kRaw);

  // Nonce commitment: R = k·H
  const R = H.multiply(k);
  const rBytes = g1ToBytes96(R);

  // Fiat-Shamir challenge: e = keccak256(C || R || seedHash || sid || player || "ZKP4")
  const addressBytes = new TextEncoder().encode(playerAddress);
  const sidBuf = new Uint8Array(4);
  new DataView(sidBuf.buffer).setUint32(0, sessionId, false);
  const tag = new Uint8Array([0x5A, 0x4B, 0x50, 0x34]); // "ZKP4"

  const preimageLen = 96 + 96 + 32 + 4 + addressBytes.length + 4;
  const preimage = new Uint8Array(preimageLen);
  let offset = 0;
  preimage.set(cBytes, offset); offset += 96;
  preimage.set(rBytes, offset); offset += 96;
  preimage.set(seedHash, offset); offset += 32;
  preimage.set(sidBuf, offset); offset += 4;
  preimage.set(addressBytes, offset); offset += addressBytes.length;
  preimage.set(tag, offset);

  const eHash = Buffer.from(keccak256(preimage), 'hex');
  const e = bufferToFr(eHash);

  // Response: z_r = k + e·r (mod Fr order)
  const z_r = (k + e * r) % Fr_ORDER;
  const zrBytes = numberToBytesBE(z_r, 32);

  // Proof blob: C(96) || R(96) || z_r(32) = 224 bytes
  const proof = Buffer.alloc(224);
  Buffer.from(cBytes).copy(proof, 0);
  Buffer.from(rBytes).copy(proof, 96);
  Buffer.from(zrBytes).copy(proof, 192);
  return proof;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Commit-Reveal for Card Plays
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute play commit hash (legacy mode): keccak256(card_id_u32_be(4) || salt(32)).
 * Used to hide the card choice until both players commit.
 */
export function computePlayCommitHash(cardId: number, salt: Uint8Array): Buffer {
  const pre = Buffer.alloc(36);
  pre.writeUInt32BE(cardId, 0);
  Buffer.from(salt).copy(pre, 4);
  return Buffer.from(keccak256(pre), 'hex');
}

/** Generate a random 32-byte salt for play commit */
export function generatePlaySalt(): Uint8Array {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return salt;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Mode 7: Card Play Ring Sigma (1-of-N Schnorr on Pedersen / BLS12-381)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute Pedersen commitment for a card play: C = Fr(cardId)·G + Fr(blinding)·H.
 * Returns the serialized 96-byte G1 point.
 */
export function computeCardPlayPedersenCommit(cardId: number, blinding: Uint8Array): Uint8Array {
  const cardScalar = BigInt(cardId) % Fr_ORDER;
  const r = bufferToFr(blinding);
  const G = bls12_381.G1.Point.BASE;
  const H = pedersenH();
  // card_id=0 → cardScalar=0 → skip G term (identity), C = 0·G + r·H = r·H
  const C = cardScalar === 0n
    ? H.multiply(r)
    : G.multiply(cardScalar).add(H.multiply(r));
  return g1ToBytes96(C);
}

/**
 * Compute ZK-mode commit hash: keccak256(C_bytes) where C is the Pedersen commitment.
 */
export function computeCardPlayZkCommitHash(cardId: number, blinding: Uint8Array): Buffer {
  const cBytes = computeCardPlayPedersenCommit(cardId, blinding);
  return Buffer.from(keccak256(cBytes), 'hex');
}

/**
 * Build a Card Play Ring Sigma proof (Mode 7).
 *
 * Proves that the committed card is in `validSet` without revealing which one.
 *
 * **Proof layout:** `C(96) || [e_i(32, Fr) || z_i(32, Fr)] × N`
 *
 * **Protocol (1-of-N Schnorr Ring Sigma on Pedersen commitments):**
 * - Let real index `j` be the position of `cardId` in `validSet`.
 * - For each i ≠ j: pick random e_i, z_i, compute R_i = z_i·H − e_i·D_i (simulated).
 * - For j: pick random k, compute R_j = k·H (honest nonce commitment).
 * - Fiat-Shamir: e = Fr(keccak256(C || R_0 || ... || R_{N-1} || session_id || player || "ZKP7")).
 * - e_j = e − Σ_{i≠j} e_i (mod Fr order).
 * - z_j = k + e_j · blinding (mod Fr order).
 */
export function buildCardPlayRingProof(
  cardId: number,
  blinding: Uint8Array,
  validSet: number[],
  sessionId: number,
  playerAddress: string,
): Buffer {
  const N = validSet.length;
  if (N === 0) throw new Error('validSet must be non-empty');

  const realIdx = validSet.indexOf(cardId);
  if (realIdx < 0) throw new Error('cardId must be in validSet');

  const G = bls12_381.G1.Point.BASE;
  const H = pedersenH();
  const r = bufferToFr(blinding);

  // Commitment: C = Fr(cardId)·G + r·H
  const cardScalar = BigInt(cardId) % Fr_ORDER;
  const C = cardScalar === 0n
    ? H.multiply(r)
    : G.multiply(cardScalar).add(H.multiply(r));
  const cBytes = g1ToBytes96(C);

  // For each i, compute D_i = C − validSet[i]·G
  const D: G1Point[] = [];
  for (let i = 0; i < N; i++) {
    const ci = BigInt(validSet[i]) % Fr_ORDER;
    D.push(ci === 0n ? C : C.add(G.multiply(ci).negate()));
  }

  // Simulate non-real members, compute real nonce
  const e_arr: bigint[] = new Array(N).fill(0n);
  const z_arr: bigint[] = new Array(N).fill(0n);
  const R_arr: G1Point[] = new Array(N);

  // Random nonce for real index
  const kRaw = new Uint8Array(32);
  crypto.getRandomValues(kRaw);
  const k = bufferToFr(kRaw);

  // Real R_j = k·H
  R_arr[realIdx] = H.multiply(k);

  // Simulate all non-real indexes: pick random e_i, z_i, compute R_i = z_i·H − e_i·D_i
  let sumOtherE = 0n;
  for (let i = 0; i < N; i++) {
    if (i === realIdx) continue;
    const eiRaw = new Uint8Array(32);
    crypto.getRandomValues(eiRaw);
    const ei = bufferToFr(eiRaw);
    const ziRaw = new Uint8Array(32);
    crypto.getRandomValues(ziRaw);
    const zi = bufferToFr(ziRaw);

    // R_i = z_i·H − e_i·D_i
    R_arr[i] = H.multiply(zi).add(D[i].multiply(ei).negate());
    e_arr[i] = ei;
    z_arr[i] = zi;
    sumOtherE = (sumOtherE + ei) % Fr_ORDER;
  }

  // Fiat-Shamir challenge: e = Fr(keccak256(C || R_0 || ... || R_{N-1} || session_id || player || "ZKP7"))
  const addressBytes = new TextEncoder().encode(playerAddress);
  const sidBuf = new Uint8Array(4);
  new DataView(sidBuf.buffer).setUint32(0, sessionId, false);
  const tag = new Uint8Array([0x5A, 0x4B, 0x50, 0x37]); // "ZKP7"

  const preLen = 96 + N * 96 + 4 + addressBytes.length + 4;
  const preimage = new Uint8Array(preLen);
  let offset = 0;
  preimage.set(cBytes, offset); offset += 96;
  for (let i = 0; i < N; i++) {
    preimage.set(g1ToBytes96(R_arr[i]), offset); offset += 96;
  }
  preimage.set(sidBuf, offset); offset += 4;
  preimage.set(addressBytes, offset); offset += addressBytes.length;
  preimage.set(tag, offset);

  const eHash = Buffer.from(keccak256(preimage), 'hex');
  const e = bufferToFr(eHash);

  // e_j = e − Σ_{i≠j} e_i (mod Fr order)
  e_arr[realIdx] = (e - sumOtherE + Fr_ORDER) % Fr_ORDER;

  // z_j = k + e_j · blinding (mod Fr order)
  z_arr[realIdx] = (k + e_arr[realIdx] * r) % Fr_ORDER;

  // Build proof blob: C(96) || [e_i(32) || z_i(32)] × N = 96 + N*64 bytes
  const proofSize = 96 + N * 64;
  const proof = Buffer.alloc(proofSize);
  Buffer.from(cBytes).copy(proof, 0);
  for (let i = 0; i < N; i++) {
    const eiBytes = numberToBytesBE(e_arr[i], 32);
    const ziBytes = numberToBytesBE(z_arr[i], 32);
    Buffer.from(eiBytes).copy(proof, 96 + i * 64);
    Buffer.from(ziBytes).copy(proof, 96 + i * 64 + 32);
  }

  return proof;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Mode 8: ZK Cangkul Hand Proof (Aggregate Pedersen + Schnorr)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the aggregate Pedersen commitment over a hand of cards:
 *   A = Σ (card_i·G + r_i·H)
 *
 * Returns [aBytes(96), rAgg(bigint)] where aBytes is the serialized G1 point
 * and rAgg is the sum of per-card blinding scalars (mod Fr_ORDER).
 */
export function computeHandAggregateCommit(
  hand: number[],
  perCardBlindings: Uint8Array[],
): { aBytes: Uint8Array; rAgg: bigint } {
  const G = bls12_381.G1.Point.BASE;
  const H = pedersenH();
  let rAgg = 0n;
  let aPoint: InstanceType<typeof bls12_381.G1.Point> | null = null;

  for (let i = 0; i < hand.length; i++) {
    const cardScalar = BigInt(hand[i]) % Fr_ORDER;
    const ri = bufferToFr(perCardBlindings[i]);
    const ci = cardScalar === 0n
      ? H.multiply(ri)
      : G.multiply(cardScalar).add(H.multiply(ri));
    aPoint = aPoint === null ? ci : aPoint.add(ci);
    rAgg = (rAgg + ri) % Fr_ORDER;
  }

  return { aBytes: g1ToBytes96(aPoint!), rAgg };
}

/**
 * Compute ZK cangkul commit hash: keccak256(A_bytes) where A is the
 * aggregate Pedersen commitment over the hand.
 */
export function computeCangkulZkCommitHash(
  hand: number[],
  perCardBlindings: Uint8Array[],
): Buffer {
  const { aBytes } = computeHandAggregateCommit(hand, perCardBlindings);
  return Buffer.from(keccak256(aBytes), 'hex');
}

/**
 * Compute the aggregate blinding r_agg as a 32-byte Uint8Array.
 * This is used as the "salt" in the reveal phase for ZK cangkul (Mode 8).
 *
 * r_agg = Σ(per_card_blinding_i) mod Fr_ORDER
 */
export function computeCangkulRevealSalt(
  hand: number[],
  perCardBlindings: Uint8Array[],
): Uint8Array {
  const { rAgg } = computeHandAggregateCommit(hand, perCardBlindings);
  return new Uint8Array(numberToBytesBE(rAgg, 32));
}

/**
 * Build a ZK Cangkul Hand Proof (Mode 8).
 *
 * Proves that the player's hand contains no card matching trick_suit,
 * using an aggregate Pedersen commitment with a Schnorr proof of knowledge.
 *
 * **Proof layout (228 bytes):**
 * `k(4, u32 BE) || A(96, G1) || R(96, G1) || z(32, Fr)`
 *
 * **Protocol (Schnorr on aggregate Pedersen):**
 * - A = Σ(card_i·G + r_i·H) = (Σcard_i)·G + r_agg·H
 * - Pick random nonce k, compute R = k·H
 * - Fiat-Shamir: e = Fr(keccak256(A || R || trick_suit(4) || k_count(4) || session_id(4) || player || "ZKP8"))
 * - z = nonce_k + e·r_agg (mod Fr_ORDER)
 */
export function buildCangkulZkProof(
  hand: number[],
  perCardBlindings: Uint8Array[],
  trickSuit: number,
  sessionId: number,
  playerAddress: string,
): Buffer {
  const k = hand.length;
  if (k === 0) throw new Error('hand must be non-empty');

  const H = pedersenH();
  const { aBytes, rAgg } = computeHandAggregateCommit(hand, perCardBlindings);

  // Random Schnorr nonce
  const nonceRaw = new Uint8Array(32);
  crypto.getRandomValues(nonceRaw);
  const nonce = bufferToFr(nonceRaw);

  // R = nonce · H
  const R = H.multiply(nonce);
  const rBytes = g1ToBytes96(R);

  // Fiat-Shamir: e = Fr(keccak256(A || R || trick_suit(4) || k(4) || session_id(4) || player || "ZKP8"))
  const addressBytes = new TextEncoder().encode(playerAddress);
  const suitBuf = new Uint8Array(4);
  new DataView(suitBuf.buffer).setUint32(0, trickSuit, false);
  const kBuf = new Uint8Array(4);
  new DataView(kBuf.buffer).setUint32(0, k, false);
  const sidBuf = new Uint8Array(4);
  new DataView(sidBuf.buffer).setUint32(0, sessionId, false);
  const tag = new Uint8Array([0x5A, 0x4B, 0x50, 0x38]); // "ZKP8"

  const preLen = 96 + 96 + 4 + 4 + 4 + addressBytes.length + 4;
  const preimage = new Uint8Array(preLen);
  let offset = 0;
  preimage.set(aBytes, offset); offset += 96;
  preimage.set(rBytes, offset); offset += 96;
  preimage.set(suitBuf, offset); offset += 4;
  preimage.set(kBuf, offset); offset += 4;
  preimage.set(sidBuf, offset); offset += 4;
  preimage.set(addressBytes, offset); offset += addressBytes.length;
  preimage.set(tag, offset);

  const eHash = Buffer.from(keccak256(preimage), 'hex');
  const e = bufferToFr(eHash);

  // z = nonce + e · r_agg (mod Fr_ORDER)
  const z = (nonce + e * rAgg) % Fr_ORDER;

  // Proof: k(4) || A(96) || R(96) || z(32) = 228 bytes
  const proof = Buffer.alloc(228);
  proof.writeUInt32BE(k, 0);
  Buffer.from(aBytes).copy(proof, 4);
  Buffer.from(rBytes).copy(proof, 100);
  const zBytes = numberToBytesBE(z, 32);
  Buffer.from(zBytes).copy(proof, 196);

  return proof;
}
