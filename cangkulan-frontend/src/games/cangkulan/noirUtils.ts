/**
 * Noir UltraKeccakHonk proof utilities for Cangkulan seed verification.
 *
 * This module provides blake2s hashing compatible with the Noir circuit
 * and proof format helpers for the UltraHonk verification path.
 *
 * The Noir circuit proves TWO properties:
 *   1. blake2s(seed) == seed_hash  (preimage knowledge)
 *   2. seed[0..4] != [0,0,0,0]    (minimum entropy check)
 *
 * A valid proof guarantees the seed has non-trivial randomness
 * WITHOUT revealing the seed itself.
 *
 * Proof generation uses @aztec/bb.js (heavy, done offline via CLI).
 * On-chain verification uses the UltraHonk verifier contract.
 */

import { blake2s } from '@noble/hashes/blake2.js';

// ==========================================================================
//  Blake2s - Noir-compatible seed hashing
// ==========================================================================

/**
 * Compute blake2s(seed) - matches the Noir circuit's std::hash::blake2s.
 * This produces the public input for the Noir proof.
 */
export function computeBlake2sSeedHash(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) {
    throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  }
  return blake2s(seed);
}

// ==========================================================================
//  Proof Format
// ==========================================================================

/** Minimum proof size for Noir UltraHonk proofs (auto-detection threshold) */
export const NOIR_PROOF_MIN_SIZE = 4000;

/** Expected proof size from bb.js UltraKeccakHonk */
export const NOIR_PROOF_EXPECTED_SIZE = 14592;

/** Public inputs size: 32 u8 fields x 32 bytes each */
export const NOIR_PUBLIC_INPUTS_SIZE = 1024;

/** VK size for our seed_verify circuit */
export const NOIR_VK_SIZE = 1760;

/**
 * Check if a proof blob is a Noir UltraHonk proof (vs Pedersen/NIZK).
 */
export function isNoirProof(proof: Uint8Array): boolean {
  return proof.length > NOIR_PROOF_MIN_SIZE;
}

/**
 * Encode a seed_hash as Noir public inputs.
 * Each u8 becomes a 32-byte big-endian field element.
 * Returns 1024 bytes (32 fields x 32 bytes).
 */
export function encodeSeedHashAsNoirPublicInputs(seedHash: Uint8Array): Uint8Array {
  if (seedHash.length !== 32) {
    throw new Error(`seedHash must be 32 bytes, got ${seedHash.length}`);
  }
  const publicInputs = new Uint8Array(32 * 32);
  for (let i = 0; i < 32; i++) {
    // 31 zero bytes + the u8 value (big-endian field element)
    publicInputs[i * 32 + 31] = seedHash[i];
  }
  return publicInputs;
}

/**
 * Decode Noir public inputs back to a seed_hash.
 * Extracts the last byte of each 32-byte field element.
 */
export function decodeSeedHashFromNoirPublicInputs(publicInputs: Uint8Array): Uint8Array {
  if (publicInputs.length !== NOIR_PUBLIC_INPUTS_SIZE) {
    throw new Error(`public inputs must be ${NOIR_PUBLIC_INPUTS_SIZE} bytes, got ${publicInputs.length}`);
  }
  const seedHash = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    seedHash[i] = publicInputs[i * 32 + 31];
  }
  return seedHash;
}

// ==========================================================================
//  Proof Verification Info
// ==========================================================================

export interface NoirProofInfo {
  isNoir: boolean;
  proofSize: number;
  publicInputsSize: number;
  seedHash: Uint8Array | null;
}

/**
 * Extract info from a combined proof+public_inputs blob.
 */
export function parseNoirProofInfo(proofWithPi: Uint8Array): NoirProofInfo {
  if (proofWithPi.length <= NOIR_PROOF_MIN_SIZE) {
    return { isNoir: false, proofSize: proofWithPi.length, publicInputsSize: 0, seedHash: null };
  }
  const publicInputs = proofWithPi.slice(0, NOIR_PUBLIC_INPUTS_SIZE);
  const proof = proofWithPi.slice(NOIR_PUBLIC_INPUTS_SIZE);
  return {
    isNoir: true,
    proofSize: proof.length,
    publicInputsSize: publicInputs.length,
    seedHash: decodeSeedHashFromNoirPublicInputs(publicInputs),
  };
}
