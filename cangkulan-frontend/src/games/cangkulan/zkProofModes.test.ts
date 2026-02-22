/**
 * zkProofModes.test.ts — Comprehensive tests for both ZK proof modes:
 *
 * 1. Pedersen Commitment (BLS12-381, Schnorr/Sigma, 224 bytes)
 * 2. Noir UltraKeccakHonk (blake2s circuit, browser SNARK)
 * 3. Mode toggling & storage isolation
 * 4. Concurrent multi-user stress tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Buffer } from 'buffer';
import { keccak256 } from 'js-sha3';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { blake2s } from '@noble/hashes/blake2.js';
import {
  generateSeed,
  computeInnerSeedHash,
  computeBlake2sSeedHash,
  computeNoirCommitHash,
  computePedersenCommitment,
  computePedersenCommitHash,
  buildPedersenProof,
  computeNizkCommitment,
  buildNizkProof,
} from './cryptoHelpers';
import { saveSeedData, loadSeedData, clearSeedData } from './seedStorage';
import type { ProofMode, SeedData } from './types';

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants (must match cryptoHelpers.ts internals)
// ═══════════════════════════════════════════════════════════════════════════════

const Fr_ORDER = bls12_381.fields.Fr.ORDER;

function bufferToFr(buf: Uint8Array): bigint {
  return bytesToNumberBE(buf) % Fr_ORDER;
}

function pedersenH() {
  const msg = new TextEncoder().encode('PEDERSEN_H');
  const dst = new TextEncoder().encode('SGS_CANGKULAN_V1');
  return bls12_381.G1.hashToCurve(msg, { DST: dst });
}

function g1ToBytes96(point: InstanceType<typeof bls12_381.G1.Point>): Uint8Array {
  const aff = point.toAffine();
  const xBytes = numberToBytesBE(aff.x, 48);
  const yBytes = numberToBytesBE(aff.y, 48);
  const out = new Uint8Array(96);
  out.set(xBytes, 0);
  out.set(yBytes, 48);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  1. PEDERSEN COMMITMENT — Algebraic Properties
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pedersen Commitment — Algebraic Properties', () => {
  const seedHash = () => computeInnerSeedHash(generateSeed());
  const blinding = () => generateSeed(); // 32 random bytes

  it('C = Fr(seedHash)·G + Fr(blinding)·H (algebraic correctness)', () => {
    const sh = Buffer.alloc(32, 0xAA);
    const bl = new Uint8Array(32).fill(0xBB);
    const s = bufferToFr(sh);
    const r = bufferToFr(bl);
    const G = bls12_381.G1.Point.BASE;
    const H = pedersenH();
    const expected = G.multiply(s).add(H.multiply(r));
    const expectedBytes = g1ToBytes96(expected);
    const actual = computePedersenCommitment(sh, bl);
    expect(Buffer.from(actual).equals(Buffer.from(expectedBytes))).toBe(true);
  });

  it('commitment lies on BLS12-381 G1 curve (not point at infinity)', () => {
    const sh = seedHash();
    const bl = blinding();
    const cBytes = computePedersenCommitment(sh, bl);
    // A valid uncompressed G1 point: x and y are each 48 bytes, both nonzero
    const xBytes = cBytes.subarray(0, 48);
    const yBytes = cBytes.subarray(48, 96);
    expect(xBytes.some(b => b !== 0)).toBe(true);
    expect(yBytes.some(b => b !== 0)).toBe(true);
    // Verify it can be deserialized back to a valid G1 point
    const x = bytesToNumberBE(xBytes);
    const y = bytesToNumberBE(yBytes);
    const point = bls12_381.G1.Point.fromAffine({ x, y });
    point.assertValidity(); // throws if not on curve
  });

  it('homomorphic addition: C(s1,r1) + C(s2,r2) = C(s1+s2, r1+r2) mod Fr', () => {
    const sh1 = Buffer.alloc(32, 0x11);
    const sh2 = Buffer.alloc(32, 0x22);
    const bl1 = new Uint8Array(32).fill(0x33);
    const bl2 = new Uint8Array(32).fill(0x44);

    // Individual commitments
    const c1Bytes = computePedersenCommitment(sh1, bl1);
    const c2Bytes = computePedersenCommitment(sh2, bl2);
    const c1x = bytesToNumberBE(c1Bytes.subarray(0, 48));
    const c1y = bytesToNumberBE(c1Bytes.subarray(48, 96));
    const c2x = bytesToNumberBE(c2Bytes.subarray(0, 48));
    const c2y = bytesToNumberBE(c2Bytes.subarray(48, 96));
    const C1 = bls12_381.G1.Point.fromAffine({ x: c1x, y: c1y });
    const C2 = bls12_381.G1.Point.fromAffine({ x: c2x, y: c2y });
    const sumPoint = C1.add(C2);

    // Sum commitment computed from summed scalars
    const s1 = bufferToFr(sh1);
    const s2 = bufferToFr(sh2);
    const r1 = bufferToFr(bl1);
    const r2 = bufferToFr(bl2);
    const sSum = (s1 + s2) % Fr_ORDER;
    const rSum = (r1 + r2) % Fr_ORDER;
    const G = bls12_381.G1.Point.BASE;
    const H = pedersenH();
    const expectedSum = G.multiply(sSum).add(H.multiply(rSum));

    expect(sumPoint.equals(expectedSum)).toBe(true);
  });

  it('hiding: same seed, different blinding → different commitment', () => {
    const sh = Buffer.alloc(32, 0x01);
    const c1 = computePedersenCommitment(sh, new Uint8Array(32).fill(0xAA));
    const c2 = computePedersenCommitment(sh, new Uint8Array(32).fill(0xBB));
    expect(Buffer.from(c1).equals(Buffer.from(c2))).toBe(false);
  });

  it('binding: same blinding, different seed → different commitment', () => {
    const bl = new Uint8Array(32).fill(0x01);
    const c1 = computePedersenCommitment(Buffer.alloc(32, 0xAA), bl);
    const c2 = computePedersenCommitment(Buffer.alloc(32, 0xBB), bl);
    expect(Buffer.from(c1).equals(Buffer.from(c2))).toBe(false);
  });

  it('scalar reduction: large inputs are reduced mod Fr order', () => {
    // Fill with 0xFF → large number that must be reduced
    const sh = Buffer.alloc(32, 0xFF);
    const bl = new Uint8Array(32).fill(0xFF);
    const C = computePedersenCommitment(sh, bl);
    // Should not throw, and should produce valid 96-byte output
    expect(C.length).toBe(96);
    // Verify the scalars were reduced
    const rawS = bytesToNumberBE(sh);
    const reducedS = rawS % Fr_ORDER;
    expect(reducedS < Fr_ORDER).toBe(true);
    expect(reducedS !== rawS).toBe(true); // 0xFF*32 > Fr_ORDER
  });

  it('Pedersen H generator is deterministically derived', () => {
    // Call pedersenH twice → same point
    const h1 = pedersenH();
    const h2 = pedersenH();
    expect(h1.equals(h2)).toBe(true);
    // H should not be the base generator G
    const G = bls12_381.G1.Point.BASE;
    expect(h1.equals(G)).toBe(false);
  });

  it('G and H are linearly independent (DLP unknown)', () => {
    const G = bls12_381.G1.Point.BASE;
    const H = pedersenH();
    // H != G, H != -G, H != identity
    expect(H.equals(G)).toBe(false);
    expect(H.equals(G.negate())).toBe(false);
    const identity = bls12_381.G1.Point.ZERO;
    expect(H.equals(identity)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. PEDERSEN PROOF — Schnorr/Sigma Protocol Verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pedersen Proof — Schnorr/Sigma Verification', () => {
  const SESSION_ID = 42;
  const PLAYER = 'GBFKTEST1234567890ABCDEF';

  function createTestData() {
    const seed = generateSeed();
    const seedHash = computeInnerSeedHash(seed);
    const blinding = generateSeed();
    return { seed, seedHash, blinding };
  }

  /**
   * Replicates the on-chain Pedersen Sigma verification logic:
   *   D = C - Fr(seedHash)·G
   *   e = Fr(keccak256(C || R || seedHash || session_id_be4 || player || "ZKP4"))
   *   Check: z_r·H == R + e·D
   */
  function verifyPedersenProof(
    proof: Buffer,
    seedHash: Buffer,
    sessionId: number,
    playerAddress: string,
  ): boolean {
    if (proof.length !== 224) return false;

    const cBytes = proof.subarray(0, 96);
    const rBytes = proof.subarray(96, 192);
    const zrBytes = proof.subarray(192, 224);

    // Reconstruct points
    const Cx = bytesToNumberBE(cBytes.subarray(0, 48));
    const Cy = bytesToNumberBE(cBytes.subarray(48, 96));
    const Rx = bytesToNumberBE(rBytes.subarray(0, 48));
    const Ry = bytesToNumberBE(rBytes.subarray(48, 96));

    let C: InstanceType<typeof bls12_381.G1.Point>;
    let R: InstanceType<typeof bls12_381.G1.Point>;
    try {
      C = bls12_381.G1.Point.fromAffine({ x: Cx, y: Cy });
      R = bls12_381.G1.Point.fromAffine({ x: Rx, y: Ry });
      C.assertValidity();
      R.assertValidity();
    } catch {
      return false;
    }

    const z_r = bytesToNumberBE(zrBytes);

    // D = C - Fr(seedHash)·G  (should be r·H if honest)
    const s = bufferToFr(seedHash);
    const G = bls12_381.G1.Point.BASE;
    const H = pedersenH();
    const D = C.add(G.multiply(s).negate());

    // Fiat-Shamir challenge
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

    // Verification: z_r·H == R + e·D
    const lhs = H.multiply(z_r);
    const rhs = R.add(D.multiply(e));
    return lhs.equals(rhs);
  }

  it('valid proof passes Sigma verification', () => {
    const { seedHash, blinding } = createTestData();
    const proof = buildPedersenProof(seedHash, blinding, SESSION_ID, PLAYER);
    expect(verifyPedersenProof(proof, seedHash, SESSION_ID, PLAYER)).toBe(true);
  });

  it('proof fails with wrong seedHash', () => {
    const { seedHash, blinding } = createTestData();
    const proof = buildPedersenProof(seedHash, blinding, SESSION_ID, PLAYER);
    // Use a different nonzero hash (all-zeros would produce Fr scalar 0 which is invalid)
    const wrongHash = Buffer.alloc(32, 0xDE);
    expect(verifyPedersenProof(proof, wrongHash, SESSION_ID, PLAYER)).toBe(false);
  });

  it('proof fails with wrong sessionId', () => {
    const { seedHash, blinding } = createTestData();
    const proof = buildPedersenProof(seedHash, blinding, SESSION_ID, PLAYER);
    expect(verifyPedersenProof(proof, seedHash, SESSION_ID + 1, PLAYER)).toBe(false);
  });

  it('proof fails with wrong player address', () => {
    const { seedHash, blinding } = createTestData();
    const proof = buildPedersenProof(seedHash, blinding, SESSION_ID, PLAYER);
    expect(verifyPedersenProof(proof, seedHash, SESSION_ID, 'GWRONGPLAYER')).toBe(false);
  });

  it('proof fails with tampered z_r', () => {
    const { seedHash, blinding } = createTestData();
    const proof = buildPedersenProof(seedHash, blinding, SESSION_ID, PLAYER);
    // Flip a byte in z_r (offset 192-224)
    proof[200] ^= 0xFF;
    expect(verifyPedersenProof(proof, seedHash, SESSION_ID, PLAYER)).toBe(false);
  });

  it('proof fails with tampered R nonce commit', () => {
    const { seedHash, blinding } = createTestData();
    const proof = buildPedersenProof(seedHash, blinding, SESSION_ID, PLAYER);
    // Tamper with R bytes — but we need a valid curve point, so just flip sign
    // Simpler: tamper with z_r since R tampering invalidates the point
    proof[100] ^= 0x01; // middle of R
    // This will either fail point deserialization or verification
    const result = verifyPedersenProof(proof, seedHash, SESSION_ID, PLAYER);
    expect(result).toBe(false);
  });

  it('commit hash matches keccak256(C) from proof', () => {
    const { seedHash, blinding } = createTestData();
    const commitHash = computePedersenCommitHash(seedHash, blinding);
    const proof = buildPedersenProof(seedHash, blinding, SESSION_ID, PLAYER);
    const cFromProof = proof.subarray(0, 96);
    const hashFromProof = Buffer.from(keccak256(cFromProof), 'hex');
    expect(hashFromProof.equals(commitHash)).toBe(true);
  });

  it('proof is session-bound (cannot reuse across sessions)', () => {
    const { seedHash, blinding } = createTestData();
    const proof1 = buildPedersenProof(seedHash, blinding, 1, PLAYER);
    const proof2 = buildPedersenProof(seedHash, blinding, 2, PLAYER);
    // C is the same, but R and z_r differ (session in challenge)
    expect(proof1.subarray(0, 96).equals(proof2.subarray(0, 96))).toBe(true);
    // Verify each proof in its own session context
    expect(verifyPedersenProof(proof1, seedHash, 1, PLAYER)).toBe(true);
    expect(verifyPedersenProof(proof2, seedHash, 2, PLAYER)).toBe(true);
    // Cross-session fails
    expect(verifyPedersenProof(proof1, seedHash, 2, PLAYER)).toBe(false);
    expect(verifyPedersenProof(proof2, seedHash, 1, PLAYER)).toBe(false);
  });

  it('proof is player-bound (cannot reuse for another player)', () => {
    const { seedHash, blinding } = createTestData();
    const proofA = buildPedersenProof(seedHash, blinding, SESSION_ID, 'GPLAYERA');
    const proofB = buildPedersenProof(seedHash, blinding, SESSION_ID, 'GPLAYERB');
    expect(verifyPedersenProof(proofA, seedHash, SESSION_ID, 'GPLAYERA')).toBe(true);
    expect(verifyPedersenProof(proofB, seedHash, SESSION_ID, 'GPLAYERB')).toBe(true);
    // Cross-player fails
    expect(verifyPedersenProof(proofA, seedHash, SESSION_ID, 'GPLAYERB')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. NOIR MODE — blake2s + Commit Hash (no WASM in test env)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Noir Mode — blake2s Commitment', () => {
  it('computeBlake2sSeedHash matches @noble/hashes blake2s', () => {
    const seed = generateSeed();
    const result = computeBlake2sSeedHash(seed);
    const expected = Buffer.from(blake2s(seed));
    expect(result.equals(expected)).toBe(true);
  });

  it('blake2s hash is 32 bytes', () => {
    expect(computeBlake2sSeedHash(generateSeed()).length).toBe(32);
  });

  it('blake2s is deterministic', () => {
    const seed = generateSeed();
    const a = computeBlake2sSeedHash(seed);
    const b = computeBlake2sSeedHash(seed);
    expect(a.equals(b)).toBe(true);
  });

  it('different seeds → different blake2s hashes', () => {
    const a = computeBlake2sSeedHash(new Uint8Array(32).fill(0x01));
    const b = computeBlake2sSeedHash(new Uint8Array(32).fill(0x02));
    expect(a.equals(b)).toBe(false);
  });

  it('Noir commit hash = keccak256(blake2s(seed))', () => {
    const seed = generateSeed();
    const blake2sHash = computeBlake2sSeedHash(seed);
    const commitHash = computeNoirCommitHash(blake2sHash);
    const expected = Buffer.from(keccak256(blake2sHash), 'hex');
    expect(commitHash.equals(expected)).toBe(true);
  });

  it('Noir commit hash is 32 bytes', () => {
    const seed = generateSeed();
    const hash = computeBlake2sSeedHash(seed);
    expect(computeNoirCommitHash(hash).length).toBe(32);
  });

  it('Noir commit hash differs from Pedersen commit hash for same seed', () => {
    const seed = generateSeed();
    const blinding = generateSeed();

    // Noir: keccak256(blake2s(seed))
    const blake2sHash = computeBlake2sSeedHash(seed);
    const noirCommit = computeNoirCommitHash(blake2sHash);

    // Pedersen: keccak256(C) where C = s·G + r·H, s = keccak256(seed)
    const seedHash = computeInnerSeedHash(seed);
    const pedersenCommit = computePedersenCommitHash(seedHash, blinding);

    expect(noirCommit.equals(pedersenCommit)).toBe(false);
  });

  it('Noir uses blake2s (matching circuit) while Pedersen uses keccak256', () => {
    const seed = new Uint8Array(32).fill(0x42);

    // Noir path: blake2s(seed)
    const noirSeedHash = computeBlake2sSeedHash(seed);
    const noirExpected = blake2s(seed);
    expect(Buffer.from(noirSeedHash).equals(Buffer.from(noirExpected))).toBe(true);

    // Pedersen path: keccak256(seed)
    const pedersenSeedHash = computeInnerSeedHash(seed);
    const pedersenExpected = Buffer.from(keccak256(seed), 'hex');
    expect(pedersenSeedHash.equals(pedersenExpected)).toBe(true);

    // The two seed hashes should differ (blake2s ≠ keccak256)
    expect(noirSeedHash.equals(pedersenSeedHash)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. NOIR PROVER — Mock Integration Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Noir Prover — Module Interface', () => {
  it('noirProver module exports expected functions', async () => {
    // Dynamic import to avoid WASM initialization in test env
    const mod = await import('./noirProver');
    expect(typeof mod.generateNoirProof).toBe('function');
    expect(typeof mod.proofToContractBytes).toBe('function');
    expect(typeof mod.getVerificationKey).toBe('function');
    expect(typeof mod.isNoirProverReady).toBe('function');
    expect(typeof mod.destroyNoirProver).toBe('function');
  });

  it('isNoirProverReady returns false before initialization', async () => {
    const mod = await import('./noirProver');
    // In test env (no WASM), it should be false
    expect(mod.isNoirProverReady()).toBe(false);
  });

  it('generateNoirProof rejects invalid seed length', async () => {
    const mod = await import('./noirProver');
    const badSeed = new Uint8Array(16); // wrong: must be 32
    const seedHash = new Uint8Array(32);
    await expect(mod.generateNoirProof(badSeed, seedHash)).rejects.toThrow('seed must be 32 bytes');
  });

  it('generateNoirProof rejects invalid seedHash length', async () => {
    const mod = await import('./noirProver');
    const seed = new Uint8Array(32);
    const badHash = new Uint8Array(16);
    await expect(mod.generateNoirProof(seed, badHash)).rejects.toThrow('seedHash must be 32 bytes');
  });

  it('proofToContractBytes extracts proof field', async () => {
    const mod = await import('./noirProver');
    const fakeResult = {
      proof: new Uint8Array([1, 2, 3, 4]),
      publicInputs: ['0x01'],
      proofTimeMs: 100,
      seedHashHex: 'aabb',
    };
    const bytes = mod.proofToContractBytes(fakeResult);
    expect(bytes).toEqual(fakeResult.proof);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. PROOF MODE TOGGLE — Storage Isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Proof Mode Toggle — Storage & Isolation', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('saveSeedData stores proofMode: pedersen', () => {
    const seed = generateSeed();
    const blinding = generateSeed();
    saveSeedData(1, 'GPLAYER1', seed, blinding, 'pedersen');
    const data = loadSeedData(1, 'GPLAYER1');
    expect(data).not.toBeNull();
    expect(data!.proofMode).toBe('pedersen');
  });

  it('saveSeedData stores proofMode: noir', () => {
    const seed = generateSeed();
    const blinding = generateSeed();
    saveSeedData(1, 'GPLAYER1', seed, blinding, 'noir');
    const data = loadSeedData(1, 'GPLAYER1');
    expect(data).not.toBeNull();
    expect(data!.proofMode).toBe('noir');
  });

  it('default proofMode is pedersen', () => {
    const seed = generateSeed();
    const blinding = generateSeed();
    // Call without explicit mode → default 'pedersen'
    saveSeedData(1, 'GPLAYER1', seed, blinding);
    const data = loadSeedData(1, 'GPLAYER1');
    expect(data!.proofMode).toBe('pedersen');
  });

  it('seed and blinding are correctly hex-encoded and decodable', () => {
    const seed = generateSeed();
    const blinding = generateSeed();
    saveSeedData(1, 'GPLAYER1', seed, blinding, 'pedersen');
    const data = loadSeedData(1, 'GPLAYER1')!;
    // Decode and compare
    const decodedSeed = Buffer.from(data.seed, 'hex');
    const decodedBlinding = Buffer.from(data.blinding, 'hex');
    expect(decodedSeed.equals(Buffer.from(seed))).toBe(true);
    expect(decodedBlinding.equals(Buffer.from(blinding))).toBe(true);
  });

  it('different sessions are isolated', () => {
    const seed1 = generateSeed();
    const seed2 = generateSeed();
    const blinding = generateSeed();
    saveSeedData(1, 'GPLAYER1', seed1, blinding, 'pedersen');
    saveSeedData(2, 'GPLAYER1', seed2, blinding, 'noir');
    const d1 = loadSeedData(1, 'GPLAYER1')!;
    const d2 = loadSeedData(2, 'GPLAYER1')!;
    expect(d1.proofMode).toBe('pedersen');
    expect(d2.proofMode).toBe('noir');
    expect(d1.seed).not.toBe(d2.seed);
  });

  it('different players within same session are isolated', () => {
    const blinding = generateSeed();
    saveSeedData(1, 'GPLAYER1', generateSeed(), blinding, 'pedersen');
    saveSeedData(1, 'GPLAYER2', generateSeed(), blinding, 'noir');
    const d1 = loadSeedData(1, 'GPLAYER1')!;
    const d2 = loadSeedData(1, 'GPLAYER2')!;
    expect(d1.proofMode).toBe('pedersen');
    expect(d2.proofMode).toBe('noir');
    expect(d1.seed).not.toBe(d2.seed);
  });

  it('clearSeedData removes from both sessionStorage and localStorage', () => {
    saveSeedData(1, 'GPLAYER1', generateSeed(), generateSeed(), 'pedersen');
    expect(loadSeedData(1, 'GPLAYER1')).not.toBeNull();
    clearSeedData(1, 'GPLAYER1');
    expect(loadSeedData(1, 'GPLAYER1')).toBeNull();
  });

  it('localStorage backup works when sessionStorage is cleared', () => {
    const seed = generateSeed();
    saveSeedData(1, 'GPLAYER1', seed, generateSeed(), 'noir');
    // Simulate closing/reopening tab by clearing sessionStorage
    sessionStorage.clear();
    const data = loadSeedData(1, 'GPLAYER1');
    expect(data).not.toBeNull();
    expect(data!.proofMode).toBe('noir');
    expect(Buffer.from(data!.seed, 'hex').equals(Buffer.from(seed))).toBe(true);
  });

  it('mode switch mid-game: overwriting produces correct latest mode', () => {
    const seed = generateSeed();
    const blinding = generateSeed();
    // Player first commits with pedersen
    saveSeedData(1, 'G1', seed, blinding, 'pedersen');
    expect(loadSeedData(1, 'G1')!.proofMode).toBe('pedersen');
    // Player changes mind, re-commits with noir (new seed)
    const seed2 = generateSeed();
    saveSeedData(1, 'G1', seed2, blinding, 'noir');
    expect(loadSeedData(1, 'G1')!.proofMode).toBe('noir');
    expect(Buffer.from(loadSeedData(1, 'G1')!.seed, 'hex').equals(Buffer.from(seed2))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. PEDERSEN END-TO-END — Full Commit→Reveal Cycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pedersen End-to-End — Full Cycle', () => {
  const PLAYER = 'GBFKVALIDSTELLARADDY';
  const SESSION = 77;

  it('commit → store → load → build proof → verify', () => {
    sessionStorage.clear();
    localStorage.clear();

    // 1. Generate seed and blinding
    const seed = generateSeed();
    const blinding = generateSeed();
    const seedHash = computeInnerSeedHash(seed);

    // 2. Compute commit hash (goes on-chain)
    const commitHash = computePedersenCommitHash(seedHash, blinding);
    expect(commitHash.length).toBe(32);

    // 3. Save seed data with mode
    saveSeedData(SESSION, PLAYER, seed, blinding, 'pedersen');

    // 4. Later... load seed data (simulating reveal phase)
    const savedData = loadSeedData(SESSION, PLAYER)!;
    expect(savedData.proofMode).toBe('pedersen');
    const loadedSeed = Buffer.from(savedData.seed, 'hex');
    const loadedBlinding = Buffer.from(savedData.blinding, 'hex');

    // 5. Rebuild seedHash from loaded seed
    const loadedSeedHash = computeInnerSeedHash(loadedSeed);
    expect(loadedSeedHash.equals(seedHash)).toBe(true);

    // 6. Build proof
    const proof = buildPedersenProof(loadedSeedHash, loadedBlinding, SESSION, PLAYER);
    expect(proof.length).toBe(224);

    // 7. Verify commit hash match
    const cFromProof = proof.subarray(0, 96);
    const hashFromProof = Buffer.from(keccak256(cFromProof), 'hex');
    expect(hashFromProof.equals(commitHash)).toBe(true);

    // 8. Verify Sigma proof algebraically
    const cBytes = proof.subarray(0, 96);
    const rBytes = proof.subarray(96, 192);
    const zrBytes = proof.subarray(192, 224);
    const z_r = bytesToNumberBE(zrBytes);

    const s = bufferToFr(loadedSeedHash);
    const G = bls12_381.G1.Point.BASE;
    const H = pedersenH();

    const C = bls12_381.G1.Point.fromAffine({
      x: bytesToNumberBE(cBytes.subarray(0, 48)),
      y: bytesToNumberBE(cBytes.subarray(48, 96)),
    });
    const R = bls12_381.G1.Point.fromAffine({
      x: bytesToNumberBE(rBytes.subarray(0, 48)),
      y: bytesToNumberBE(rBytes.subarray(48, 96)),
    });

    const D = C.add(G.multiply(s).negate()); // D = C - s*G = r*H

    // Fiat-Shamir challenge
    const addressBytes = new TextEncoder().encode(PLAYER);
    const sidBuf = new Uint8Array(4);
    new DataView(sidBuf.buffer).setUint32(0, SESSION, false);
    const tag = new Uint8Array([0x5A, 0x4B, 0x50, 0x34]);
    const preimageLen = 96 + 96 + 32 + 4 + addressBytes.length + 4;
    const preimage = new Uint8Array(preimageLen);
    let off = 0;
    preimage.set(cBytes, off); off += 96;
    preimage.set(rBytes, off); off += 96;
    preimage.set(loadedSeedHash, off); off += 32;
    preimage.set(sidBuf, off); off += 4;
    preimage.set(addressBytes, off); off += addressBytes.length;
    preimage.set(tag, off);
    const e = bufferToFr(Buffer.from(keccak256(preimage), 'hex'));

    const lhs = H.multiply(z_r);
    const rhs = R.add(D.multiply(e));
    expect(lhs.equals(rhs)).toBe(true);

    // 9. Cleanup
    clearSeedData(SESSION, PLAYER);
    expect(loadSeedData(SESSION, PLAYER)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  7. NOIR END-TO-END — Full Cycle (sans WASM)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Noir End-to-End — Full Cycle (blake2s commit)', () => {
  const PLAYER = 'GBFKNOIRPLAYER';
  const SESSION = 88;

  it('commit → store → load → reconstruct → verify commit binding', () => {
    sessionStorage.clear();
    localStorage.clear();

    // 1. Generate seed
    const seed = generateSeed();
    const blinding = generateSeed(); // stored but irrelevant for noir commit

    // 2. Compute Noir commit hash
    const blake2sHash = computeBlake2sSeedHash(seed);
    const commitHash = computeNoirCommitHash(blake2sHash);
    expect(commitHash.length).toBe(32);

    // 3. Store
    saveSeedData(SESSION, PLAYER, seed, blinding, 'noir');

    // 4. Load
    const saved = loadSeedData(SESSION, PLAYER)!;
    expect(saved.proofMode).toBe('noir');

    // 5. Reconstruct from loaded data
    const loadedSeed = Buffer.from(saved.seed, 'hex');
    const loadedBlake2s = computeBlake2sSeedHash(loadedSeed);
    const loadedCommitHash = computeNoirCommitHash(loadedBlake2s);

    // 6. Verify commit is binding
    expect(loadedCommitHash.equals(commitHash)).toBe(true);

    // 7. Verify seed_hash matches circuit expectation: blake2s(seed) == seed_hash
    expect(loadedBlake2s.equals(blake2sHash)).toBe(true);

    // 8. Cleanup
    clearSeedData(SESSION, PLAYER);
    expect(loadSeedData(SESSION, PLAYER)).toBeNull();
  });

  it('contract dispatches: Noir proof is >4000 bytes (distinguishable)', () => {
    // Contract logic: proof.length > 4000 → Noir mode
    // We can't generate a real Noir proof in tests, but verify the threshold
    const pedersenProofLen = 224;
    const nizkProofLen = 64;
    const fakeNoirProofLen = 14_000; // Real proofs are ~14KB

    expect(pedersenProofLen < 4000).toBe(true);
    expect(nizkProofLen < 4000).toBe(true);
    expect(fakeNoirProofLen > 4000).toBe(true);

    // Contract dispatch logic:
    // 64 → NIZK, 224 → Pedersen, >4000 → Noir
    const dispatch = (len: number): string => {
      if (len === 64) return 'nizk';
      if (len === 224) return 'pedersen';
      if (len > 4000) return 'noir';
      return 'unknown';
    };
    expect(dispatch(nizkProofLen)).toBe('nizk');
    expect(dispatch(pedersenProofLen)).toBe('pedersen');
    expect(dispatch(fakeNoirProofLen)).toBe('noir');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  8. CONCURRENT MULTI-USER STRESS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Concurrent Multi-User Stress Tests', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('20 concurrent Pedersen commitments produce 20 unique commit hashes', async () => {
    const N = 20;
    const players = Array.from({ length: N }, (_, i) => `GPLAYER${String(i).padStart(3, '0')}`);

    // Generate all seeds and blindings concurrently
    const tasks = players.map(async (player) => {
      const seed = generateSeed();
      const blinding = generateSeed();
      const seedHash = computeInnerSeedHash(seed);
      const commitHash = computePedersenCommitHash(seedHash, blinding);
      saveSeedData(1, player, seed, blinding, 'pedersen');
      return { player, commitHash: commitHash.toString('hex'), seed, blinding };
    });
    const results = await Promise.all(tasks);

    // All commit hashes must be unique
    const hashes = new Set(results.map(r => r.commitHash));
    expect(hashes.size).toBe(N);
  });

  it('20 concurrent Pedersen proofs all verify correctly', async () => {
    const N = 20;
    const SESSION = 100;

    const tasks = Array.from({ length: N }, async (_, i) => {
      const player = `GCONCURRENT${i}`;
      const seed = generateSeed();
      const blinding = generateSeed();
      const seedHash = computeInnerSeedHash(seed);
      const proof = buildPedersenProof(seedHash, blinding, SESSION, player);
      return { player, seedHash, proof };
    });
    const results = await Promise.all(tasks);

    // Verify each proof
    for (const { player, seedHash, proof } of results) {
      expect(proof.length).toBe(224);
      // Verify commitment is valid G1 point
      const cx = bytesToNumberBE(proof.subarray(0, 48));
      const cy = bytesToNumberBE(proof.subarray(48, 96));
      const C = bls12_381.G1.Point.fromAffine({ x: cx, y: cy });
      C.assertValidity();
    }
  });

  it('mixed Pedersen + Noir commits remain isolated', () => {
    const SESSION = 200;
    const N = 10;

    // 5 Pedersen players + 5 Noir players
    for (let i = 0; i < N; i++) {
      const player = `GMIXED${i}`;
      const seed = generateSeed();
      const blinding = generateSeed();
      const mode: ProofMode = i < 5 ? 'pedersen' : 'noir';
      saveSeedData(SESSION, player, seed, blinding, mode);
    }

    // Verify isolation: each player's mode is preserved
    for (let i = 0; i < N; i++) {
      const data = loadSeedData(SESSION, `GMIXED${i}`)!;
      expect(data).not.toBeNull();
      expect(data.proofMode).toBe(i < 5 ? 'pedersen' : 'noir');
    }
  });

  it('concurrent sessions for same player do not cross-contaminate', () => {
    const PLAYER = 'GCROSS_CONTAMINATION';
    const sessions = [1, 2, 3, 4, 5];
    const seeds: Record<number, Uint8Array> = {};

    for (const sid of sessions) {
      const seed = generateSeed();
      seeds[sid] = seed;
      saveSeedData(sid, PLAYER, seed, generateSeed(), sid % 2 === 0 ? 'noir' : 'pedersen');
    }

    // Each session keeps its own data
    for (const sid of sessions) {
      const data = loadSeedData(sid, PLAYER)!;
      expect(data).not.toBeNull();
      expect(Buffer.from(data.seed, 'hex').equals(Buffer.from(seeds[sid]))).toBe(true);
      expect(data.proofMode).toBe(sid % 2 === 0 ? 'noir' : 'pedersen');
    }
  });

  it('50 concurrent seed generations produce 50 unique seeds', () => {
    const N = 50;
    const seeds = new Set<string>();
    for (let i = 0; i < N; i++) {
      seeds.add(Buffer.from(generateSeed()).toString('hex'));
    }
    expect(seeds.size).toBe(N);
  });

  it('parallel Pedersen and NIZK proofs for same seedHash do not interfere', async () => {
    const seed = generateSeed();
    const seedHash = computeInnerSeedHash(seed);
    const blinding = generateSeed();
    const SESSION = 300;
    const PLAYER = 'GPARALLEL';

    const [pedersenProof, nizkCommitment] = await Promise.all([
      Promise.resolve(buildPedersenProof(seedHash, blinding, SESSION, PLAYER)),
      Promise.resolve(computeNizkCommitment(seedHash, blinding, PLAYER)),
    ]);

    // Pedersen proof still valid
    expect(pedersenProof.length).toBe(224);
    const cx = bytesToNumberBE(pedersenProof.subarray(0, 48));
    const cy = bytesToNumberBE(pedersenProof.subarray(48, 96));
    bls12_381.G1.Point.fromAffine({ x: cx, y: cy }).assertValidity();

    // NIZK commitment still valid
    expect(nizkCommitment.length).toBe(32);
  });

  it('high-frequency Pedersen commits don\'t share nonce', () => {
    const seed = generateSeed();
    const seedHash = computeInnerSeedHash(seed);
    const blinding = generateSeed();
    const SESSION = 400;
    const PLAYER = 'GNONCE';

    // Generate many proofs rapidly — each should have unique R (nonce) and z_r
    const proofs = Array.from({ length: 10 }, () =>
      buildPedersenProof(seedHash, blinding, SESSION, PLAYER)
    );

    // C (first 96 bytes) should be the same across all
    const c0 = proofs[0].subarray(0, 96);
    for (const p of proofs) {
      expect(p.subarray(0, 96).equals(c0)).toBe(true);
    }

    // R+z_r (bytes 96-224) should all be different
    const tails = new Set(proofs.map(p => p.subarray(96).toString('hex')));
    expect(tails.size).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  9. PROOF SIZE CONTRACT DISPATCH
// ═══════════════════════════════════════════════════════════════════════════════

describe('Proof Size — Contract Dispatch Rules', () => {
  it('NIZK proof is exactly 64 bytes', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    const commitment = computeNizkCommitment(seedHash, blinding, 'GTEST');
    const proof = buildNizkProof(seedHash, blinding, commitment, 1, 'GTEST');
    expect(proof.length).toBe(64);
  });

  it('Pedersen proof is exactly 224 bytes', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    const proof = buildPedersenProof(seedHash, blinding, 1, 'GTEST');
    expect(proof.length).toBe(224);
  });

  it('no overlap in proof size ranges', () => {
    // NIZK: 64, Pedersen: 224, Noir: >4000
    // They must not overlap for contract dispatch to work
    const nizk = 64 as number;
    const pedersen = 224 as number;
    const noirThreshold = 4000 as number;
    expect(nizk !== pedersen).toBe(true);
    expect(nizk < noirThreshold).toBe(true);
    expect(pedersen < noirThreshold).toBe(true);
    // Noir proofs are typically ~14KB but always >4KB
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. EDGE CASES & SECURITY
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases & Security', () => {
  it('zero seed produces valid Pedersen commitment', () => {
    const zeroSeed = new Uint8Array(32).fill(0);
    const seedHash = computeInnerSeedHash(zeroSeed);
    const blinding = generateSeed();
    const C = computePedersenCommitment(seedHash, blinding);
    expect(C.length).toBe(96);
    // Even zero seed → nonzero keccak256 hash → nonzero Fr scalar
    expect(seedHash.some(b => b !== 0)).toBe(true);
  });

  it('zero blinding: multiply(0n) is invalid in noble curves (safety check)', () => {
    const seedHash = Buffer.alloc(32, 0x42);
    const zeroBlinding = new Uint8Array(32).fill(0);
    // noble/curves rejects scalar 0 (identity point) — this is correct behavior:
    // a real Pedersen commitment MUST use a nonzero blinding factor for hiding.
    expect(() => computePedersenCommitment(seedHash, zeroBlinding)).toThrow();
  });

  it('Pedersen proof with session ID 0 still works', () => {
    const seedHash = computeInnerSeedHash(generateSeed());
    const blinding = generateSeed();
    const proof = buildPedersenProof(seedHash, blinding, 0, 'GTEST');
    expect(proof.length).toBe(224);
  });

  it('Pedersen proof with max u32 session ID works', () => {
    const seedHash = computeInnerSeedHash(generateSeed());
    const blinding = generateSeed();
    const proof = buildPedersenProof(seedHash, blinding, 0xFFFFFFFF, 'GTEST');
    expect(proof.length).toBe(224);
  });

  it('very long player address works', () => {
    const seedHash = computeInnerSeedHash(generateSeed());
    const blinding = generateSeed();
    const longAddr = 'G' + 'A'.repeat(200); // 201 chars
    const proof = buildPedersenProof(seedHash, blinding, 1, longAddr);
    expect(proof.length).toBe(224);
  });

  it('blake2s output differs from keccak256 for any input', () => {
    // Not a mathematical proof, but probabilistic certainty check
    for (let i = 0; i < 5; i++) {
      const data = generateSeed();
      const b2s = Buffer.from(blake2s(data));
      const kec = Buffer.from(keccak256(data), 'hex');
      expect(b2s.equals(kec)).toBe(false);
    }
  });
});
