/**
 * Noir UltraKeccakHonk Browser Prover for Cangkulan Seed Verification.
 *
 * Generates ZK proofs entirely in the browser using:
 * - @noir-lang/noir_js — circuit witness generation
 * - @aztec/bb.js — UltraKeccakHonk proof generation
 *
 * Circuit proves TWO properties:
 *   1. blake2s(seed) == seed_hash  (preimage knowledge)
 *   2. seed[0..4] != [0,0,0,0]    (minimum entropy — first 4 bytes non-zero)
 *
 * The entropy constraint is enforced inside the ZK circuit itself, so a valid
 * proof guarantees the seed has non-trivial randomness without revealing it.
 */

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';

// ============================================================================
//  Types
// ============================================================================

export interface NoirProofResult {
  /** Raw proof bytes (for on-chain verify_proof) */
  proof: Uint8Array;
  /** Public inputs: seed_hash as 32 BE field elements (1024 bytes) */
  publicInputs: string[];
  /** Proof generation time in milliseconds */
  proofTimeMs: number;
  /** The blake2s seed hash (32 bytes hex) */
  seedHashHex: string;
}

// ============================================================================
//  State (lazy-initialized singleton)
// ============================================================================

let cachedCircuit: any = null;
let cachedBackend: UltraHonkBackend | null = null;
let cachedNoir: Noir | null = null;
let initPromise: Promise<void> | null = null;

/** Load circuit JSON from public/ and initialize backend + noir. */
async function ensureInitialized(): Promise<{ noir: Noir; backend: UltraHonkBackend }> {
  if (cachedNoir && cachedBackend) {
    return { noir: cachedNoir, backend: cachedBackend };
  }

  if (initPromise) {
    await initPromise;
    return { noir: cachedNoir!, backend: cachedBackend! };
  }

  initPromise = (async () => {
    // Load compiled circuit from public directory
    const resp = await fetch('/seed_verify_circuit.json');
    if (!resp.ok) throw new Error(`Failed to load circuit: ${resp.status}`);
    cachedCircuit = await resp.json();

    // Extract bytecode - the circuit JSON has bytecode at top level
    const bytecode = cachedCircuit.bytecode;
    if (!bytecode) throw new Error('Circuit JSON missing bytecode field');

    // Initialize bb.js UltraHonk backend
    cachedBackend = new UltraHonkBackend(bytecode);

    // Initialize noir_js for witness generation
    cachedNoir = new Noir(cachedCircuit);
  })();

  await initPromise;
  return { noir: cachedNoir!, backend: cachedBackend! };
}

// ============================================================================
//  Public API
// ============================================================================

/**
 * Generate a Noir UltraKeccakHonk proof for seed verification.
 *
 * @param seed - 32-byte seed (Uint8Array)
 * @param seedHashBlake2s - 32-byte blake2s(seed) hash (Uint8Array)
 * @returns Proof result with raw proof bytes and public inputs
 */
export async function generateNoirProof(
  seed: Uint8Array,
  seedHashBlake2s: Uint8Array,
): Promise<NoirProofResult> {
  if (seed.length !== 32) throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  if (seedHashBlake2s.length !== 32) throw new Error(`seedHash must be 32 bytes, got ${seedHashBlake2s.length}`);

  const startTime = performance.now();

  const { noir, backend } = await ensureInitialized();

  // Prepare inputs for the Noir circuit
  // The circuit expects: seed: [u8; 32], seed_hash: pub [u8; 32]
  const inputMap: Record<string, string[]> = {
    seed: Array.from(seed).map(b => b.toString()),
    seed_hash: Array.from(seedHashBlake2s).map(b => b.toString()),
  };

  // Generate witness using noir_js
  const { witness } = await noir.execute(inputMap);

  // Generate UltraKeccakHonk proof using bb.js
  // The { keccak: true } flag is critical - it must match the verifier contract
  const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true });

  const proofTimeMs = Math.round(performance.now() - startTime);

  // Convert seed hash to hex for display
  const seedHashHex = Array.from(seedHashBlake2s)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    proof,
    publicInputs,
    proofTimeMs,
    seedHashHex,
  };
}

/**
 * Convert proof result into a flat bytes blob for the Soroban contract.
 * The contract expects just the raw proof (without public inputs inline).
 */
export function proofToContractBytes(result: NoirProofResult): Uint8Array {
  return result.proof;
}

/**
 * Get verification key bytes (for deploying UltraHonk verifier contract).
 * Only needed for admin deployment, not for regular gameplay.
 */
export async function getVerificationKey(): Promise<Uint8Array> {
  const { backend } = await ensureInitialized();
  return await backend.getVerificationKey({ keccak: true });
}

/**
 * Check if the Noir prover is initialized / circuit is loaded.
 */
export function isNoirProverReady(): boolean {
  return cachedNoir !== null && cachedBackend !== null;
}

/**
 * Clean up WASM resources.
 */
export async function destroyNoirProver(): Promise<void> {
  if (cachedBackend) {
    await cachedBackend.destroy();
    cachedBackend = null;
  }
  cachedNoir = null;
  cachedCircuit = null;
  initPromise = null;
}
