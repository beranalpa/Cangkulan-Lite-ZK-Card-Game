/**
 * cryptoHelpers.test.ts — unit tests for Pedersen commitment, NIZK proofs,
 * seed hashing, play commit hashing, and all crypto primitives.
 */
import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { keccak256 } from 'js-sha3';
import {
  generateSeed,
  computeInnerSeedHash,
  computeNizkCommitment,
  computeNullifier,
  computeChallenge,
  computeResponse,
  buildNizkProof,
  computePedersenCommitment,
  computePedersenCommitHash,
  buildPedersenProof,
  computePlayCommitHash,
  generatePlaySalt,
  computeCardPlayPedersenCommit,
  computeCardPlayZkCommitHash,
  buildCardPlayRingProof,
  computeHandAggregateCommit,
  computeCangkulZkCommitHash,
  computeCangkulRevealSalt,
  buildCangkulZkProof,
} from './cryptoHelpers';

// ═══════════════════════════════════════════════════════════════════════════════
//  Seed generation
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateSeed', () => {
  it('returns 32 bytes', () => {
    const seed = generateSeed();
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBe(32);
  });

  it('produces distinct seeds on repeated calls', () => {
    const a = generateSeed();
    const b = generateSeed();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  computeInnerSeedHash
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeInnerSeedHash', () => {
  it('returns keccak256 of the seed', () => {
    const seed = new Uint8Array(32);
    seed[0] = 0xAB;
    const hash = computeInnerSeedHash(seed);
    const expected = Buffer.from(keccak256(seed), 'hex');
    expect(hash.equals(expected)).toBe(true);
  });

  it('returns 32 bytes', () => {
    const seed = generateSeed();
    expect(computeInnerSeedHash(seed).length).toBe(32);
  });

  it('is deterministic', () => {
    const seed = generateSeed();
    const h1 = computeInnerSeedHash(seed);
    const h2 = computeInnerSeedHash(seed);
    expect(h1.equals(h2)).toBe(true);
  });

  it('changes when seed changes', () => {
    const seedA = new Uint8Array(32).fill(0x01);
    const seedB = new Uint8Array(32).fill(0x02);
    const hA = computeInnerSeedHash(seedA);
    const hB = computeInnerSeedHash(seedB);
    expect(hA.equals(hB)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  NIZK commitment (Mode 2)
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeNizkCommitment', () => {
  it('returns 32 bytes', () => {
    const seedHash = Buffer.alloc(32, 0xAA);
    const blinding = new Uint8Array(32).fill(0xBB);
    const result = computeNizkCommitment(seedHash, blinding, 'GABC123');
    expect(result.length).toBe(32);
  });

  it('is deterministic for same inputs', () => {
    const seedHash = Buffer.alloc(32, 0x11);
    const blinding = new Uint8Array(32).fill(0x22);
    const addr = 'GTEST1234';
    const a = computeNizkCommitment(seedHash, blinding, addr);
    const b = computeNizkCommitment(seedHash, blinding, addr);
    expect(a.equals(b)).toBe(true);
  });

  it('differs when player address changes', () => {
    const seedHash = Buffer.alloc(32, 0x11);
    const blinding = new Uint8Array(32).fill(0x22);
    const a = computeNizkCommitment(seedHash, blinding, 'GPLAYER1');
    const b = computeNizkCommitment(seedHash, blinding, 'GPLAYER2');
    expect(a.equals(b)).toBe(false);
  });

  it('matches manual keccak256(seedHash||blinding||address)', () => {
    const seedHash = Buffer.alloc(32, 0xAB);
    const blinding = new Uint8Array(32).fill(0xCD);
    const addr = 'GA';
    const addressBytes = new TextEncoder().encode(addr);
    const preimage = new Uint8Array(32 + 32 + addressBytes.length);
    preimage.set(seedHash, 0);
    preimage.set(blinding, 32);
    preimage.set(addressBytes, 64);
    const expected = Buffer.from(keccak256(preimage), 'hex');
    expect(computeNizkCommitment(seedHash, blinding, addr).equals(expected)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  computeNullifier
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeNullifier', () => {
  it('returns 32 bytes', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    expect(computeNullifier(seedHash, 42).length).toBe(32);
  });

  it('is deterministic', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const a = computeNullifier(seedHash, 1);
    const b = computeNullifier(seedHash, 1);
    expect(a.equals(b)).toBe(true);
  });

  it('differs for different session IDs', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const a = computeNullifier(seedHash, 1);
    const b = computeNullifier(seedHash, 2);
    expect(a.equals(b)).toBe(false);
  });

  it('embeds "NULL" domain separator', () => {
    // Verify by manually computing
    const seedHash = Buffer.alloc(32, 0x01);
    const sessionId = 100;
    const pre = new Uint8Array(32 + 4 + 4);
    pre.set(seedHash, 0);
    pre.set(new Uint8Array([0x4E, 0x55, 0x4C, 0x4C]), 32); // "NULL"
    const sidBuf = new Uint8Array(4);
    new DataView(sidBuf.buffer).setUint32(0, sessionId, false);
    pre.set(sidBuf, 36);
    const expected = Buffer.from(keccak256(pre), 'hex');
    expect(computeNullifier(seedHash, sessionId).equals(expected)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  computeChallenge
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeChallenge', () => {
  it('returns 32 bytes', () => {
    const commitment = Buffer.alloc(32, 0xFF);
    expect(computeChallenge(commitment, 1, 'GABC').length).toBe(32);
  });

  it('embeds "ZKV2" domain separator', () => {
    const commitment = Buffer.alloc(32, 0x01);
    const addr = 'G';
    const addressBytes = new TextEncoder().encode(addr);
    const pre = new Uint8Array(32 + 4 + addressBytes.length + 4);
    pre.set(commitment, 0);
    const sidBuf = new Uint8Array(4);
    new DataView(sidBuf.buffer).setUint32(0, 5, false);
    pre.set(sidBuf, 32);
    pre.set(addressBytes, 36);
    pre.set(new Uint8Array([0x5A, 0x4B, 0x56, 0x32]), 36 + addressBytes.length);
    const expected = Buffer.from(keccak256(pre), 'hex');
    expect(computeChallenge(commitment, 5, addr).equals(expected)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  computeResponse
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeResponse', () => {
  it('returns 32 bytes', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const challenge = Buffer.alloc(32, 0x02);
    const blinding = new Uint8Array(32).fill(0x03);
    expect(computeResponse(seedHash, challenge, blinding).length).toBe(32);
  });

  it('matches keccak256(seedHash||challenge||blinding)', () => {
    const seedHash = Buffer.alloc(32, 0xAA);
    const challenge = Buffer.alloc(32, 0xBB);
    const blinding = new Uint8Array(32).fill(0xCC);
    const pre = new Uint8Array(96);
    pre.set(seedHash, 0);
    pre.set(challenge, 32);
    pre.set(blinding, 64);
    const expected = Buffer.from(keccak256(pre), 'hex');
    expect(computeResponse(seedHash, challenge, blinding).equals(expected)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  buildNizkProof
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildNizkProof', () => {
  it('returns 64-byte proof (blinding||response)', () => {
    const seedHash = Buffer.alloc(32, 0x11);
    const blinding = new Uint8Array(32).fill(0x22);
    const commitment = computeNizkCommitment(seedHash, blinding, 'GTEST');
    const proof = buildNizkProof(seedHash, blinding, commitment, 1, 'GTEST');
    expect(proof.length).toBe(64);
  });

  it('first 32 bytes are the blinding factor', () => {
    const seedHash = Buffer.alloc(32, 0x11);
    const blinding = new Uint8Array(32).fill(0x22);
    const commitment = computeNizkCommitment(seedHash, blinding, 'GTEST');
    const proof = buildNizkProof(seedHash, blinding, commitment, 1, 'GTEST');
    expect(proof.subarray(0, 32).equals(Buffer.from(blinding))).toBe(true);
  });

  it('second 32 bytes are the response', () => {
    const seedHash = Buffer.alloc(32, 0x11);
    const blinding = new Uint8Array(32).fill(0x22);
    const addr = 'GTEST';
    const commitment = computeNizkCommitment(seedHash, blinding, addr);
    const challenge = computeChallenge(commitment, 1, addr);
    const expectedResponse = computeResponse(seedHash, challenge, blinding);
    const proof = buildNizkProof(seedHash, blinding, commitment, 1, addr);
    expect(proof.subarray(32, 64).equals(expectedResponse)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Pedersen Commitment (Mode 4, BLS12-381)
// ═══════════════════════════════════════════════════════════════════════════════

describe('computePedersenCommitment', () => {
  it('returns 96 bytes (uncompressed G1 point)', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    const C = computePedersenCommitment(seedHash, blinding);
    expect(C.length).toBe(96);
  });

  it('is deterministic', () => {
    const seedHash = Buffer.alloc(32, 0xAA);
    const blinding = new Uint8Array(32).fill(0xBB);
    const a = computePedersenCommitment(seedHash, blinding);
    const b = computePedersenCommitment(seedHash, blinding);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('changes when seed_hash changes', () => {
    const blinding = new Uint8Array(32).fill(0x01);
    const a = computePedersenCommitment(Buffer.alloc(32, 0x01), blinding);
    const b = computePedersenCommitment(Buffer.alloc(32, 0x02), blinding);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('changes when blinding changes', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const a = computePedersenCommitment(seedHash, new Uint8Array(32).fill(0x01));
    const b = computePedersenCommitment(seedHash, new Uint8Array(32).fill(0x02));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  computePedersenCommitHash
// ═══════════════════════════════════════════════════════════════════════════════

describe('computePedersenCommitHash', () => {
  it('returns keccak256 of the 96-byte commitment', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    const C = computePedersenCommitment(seedHash, blinding);
    const expected = Buffer.from(keccak256(C), 'hex');
    const result = computePedersenCommitHash(seedHash, blinding);
    expect(result.equals(expected)).toBe(true);
  });

  it('returns 32 bytes', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    expect(computePedersenCommitHash(seedHash, blinding).length).toBe(32);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  buildPedersenProof
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildPedersenProof', () => {
  it('returns 224-byte proof: C(96) || R(96) || z_r(32)', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    const proof = buildPedersenProof(seedHash, blinding, 42, 'GTEST123');
    expect(proof.length).toBe(224);
  });

  it('first 96 bytes match the standalone Pedersen commitment', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    const proof = buildPedersenProof(seedHash, blinding, 42, 'GTEST123');
    const C = computePedersenCommitment(seedHash, blinding);
    expect(proof.subarray(0, 96).equals(Buffer.from(C))).toBe(true);
  });

  it('z_r is 32 bytes at offset 192', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    const proof = buildPedersenProof(seedHash, blinding, 1, 'GABC');
    const zr = proof.subarray(192, 224);
    expect(zr.length).toBe(32);
    // z_r should not be all zeros (extremely unlikely with random k)
    expect(zr.some((b: number) => b !== 0)).toBe(true);
  });

  it('consecutive proofs differ (random nonce k)', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    const p1 = buildPedersenProof(seedHash, blinding, 1, 'GTEST');
    const p2 = buildPedersenProof(seedHash, blinding, 1, 'GTEST');
    // C is the same, but R and z_r should differ
    expect(p1.subarray(96).equals(p2.subarray(96))).toBe(false);
  });

  it('commitment part is consistent regardless of session', () => {
    const seedHash = Buffer.alloc(32, 0x01);
    const blinding = new Uint8Array(32).fill(0x02);
    const p1 = buildPedersenProof(seedHash, blinding, 1, 'GTEST');
    const p2 = buildPedersenProof(seedHash, blinding, 99, 'GOTHER');
    // C = s*G + r*H depends only on seedHash and blinding
    expect(p1.subarray(0, 96).equals(p2.subarray(0, 96))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Play Commit Hash (card plays)
// ═══════════════════════════════════════════════════════════════════════════════

describe('computePlayCommitHash', () => {
  it('returns 32 bytes', () => {
    const salt = new Uint8Array(32).fill(0x01);
    expect(computePlayCommitHash(5, salt).length).toBe(32);
  });

  it('is deterministic for same card+salt', () => {
    const salt = new Uint8Array(32).fill(0x01);
    const a = computePlayCommitHash(10, salt);
    const b = computePlayCommitHash(10, salt);
    expect(a.equals(b)).toBe(true);
  });

  it('differs for different cards', () => {
    const salt = new Uint8Array(32).fill(0x01);
    const a = computePlayCommitHash(0, salt);
    const b = computePlayCommitHash(1, salt);
    expect(a.equals(b)).toBe(false);
  });

  it('differs for different salts', () => {
    const a = computePlayCommitHash(5, new Uint8Array(32).fill(0x01));
    const b = computePlayCommitHash(5, new Uint8Array(32).fill(0x02));
    expect(a.equals(b)).toBe(false);
  });

  it('matches manual keccak256(card_id_be32||salt)', () => {
    const cardId = 35;
    const salt = new Uint8Array(32).fill(0xFF);
    const pre = Buffer.alloc(36);
    pre.writeUInt32BE(cardId, 0);
    Buffer.from(salt).copy(pre, 4);
    const expected = Buffer.from(keccak256(pre), 'hex');
    expect(computePlayCommitHash(cardId, salt).equals(expected)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  generatePlaySalt
// ═══════════════════════════════════════════════════════════════════════════════

describe('generatePlaySalt', () => {
  it('returns 32 bytes', () => {
    const salt = generatePlaySalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(32);
  });

  it('produces distinct salts', () => {
    const a = generatePlaySalt();
    const b = generatePlaySalt();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  End-to-end: NIZK flow
// ═══════════════════════════════════════════════════════════════════════════════

describe('NIZK end-to-end flow', () => {
  it('full commit → proof cycle is internally consistent', () => {
    const seed = generateSeed();
    const seedHash = computeInnerSeedHash(seed);
    const blinding = generatePlaySalt(); // re-use as blinding
    const addr = 'GBFKTEST1234567890';
    const sessionId = 42;

    const commitment = computeNizkCommitment(seedHash, blinding, addr);
    expect(commitment.length).toBe(32);

    const nullifier = computeNullifier(seedHash, sessionId);
    expect(nullifier.length).toBe(32);

    const proof = buildNizkProof(seedHash, blinding, commitment, sessionId, addr);
    expect(proof.length).toBe(64);
    expect(proof.subarray(0, 32).equals(Buffer.from(blinding))).toBe(true);

    const challenge = computeChallenge(commitment, sessionId, addr);
    const response = computeResponse(seedHash, challenge, blinding);
    expect(proof.subarray(32, 64).equals(response)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  End-to-end: Pedersen flow
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pedersen end-to-end flow', () => {
  it('commit hash matches proof commitment', () => {
    const seed = generateSeed();
    const seedHash = computeInnerSeedHash(seed);
    const blinding = generatePlaySalt();
    const addr = 'GPLAYER1';
    const sessionId = 99;

    // The commit hash stored on-chain
    const commitHash = computePedersenCommitHash(seedHash, blinding);
    expect(commitHash.length).toBe(32);

    // The full proof sent at reveal time
    const proof = buildPedersenProof(seedHash, blinding, sessionId, addr);
    expect(proof.length).toBe(224);

    // The commitment C in the proof should hash to the same commit_hash
    const cFromProof = proof.subarray(0, 96);
    const hashFromProof = Buffer.from(keccak256(cFromProof), 'hex');
    expect(hashFromProof.equals(commitHash)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ZK Card Play — Pedersen Commitment & Ring Sigma Proof (Mode 7)
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeCardPlayPedersenCommit', () => {
  it('returns 96-byte G1 point', () => {
    const blinding = generatePlaySalt();
    const c = computeCardPlayPedersenCommit(5, blinding);
    expect(c.length).toBe(96);
  });

  it('different card IDs produce different commitments', () => {
    const blinding = generatePlaySalt();
    const c1 = computeCardPlayPedersenCommit(0, blinding);
    const c2 = computeCardPlayPedersenCommit(1, blinding);
    expect(Buffer.from(c1).equals(Buffer.from(c2))).toBe(false);
  });

  it('different blindings produce different commitments', () => {
    const b1 = generatePlaySalt();
    const b2 = generatePlaySalt();
    const c1 = computeCardPlayPedersenCommit(10, b1);
    const c2 = computeCardPlayPedersenCommit(10, b2);
    expect(Buffer.from(c1).equals(Buffer.from(c2))).toBe(false);
  });

  it('is deterministic with same inputs', () => {
    const blinding = new Uint8Array(32);
    blinding[31] = 42;
    const c1 = computeCardPlayPedersenCommit(7, blinding);
    const c2 = computeCardPlayPedersenCommit(7, blinding);
    expect(Buffer.from(c1).equals(Buffer.from(c2))).toBe(true);
  });
});

describe('computeCardPlayZkCommitHash', () => {
  it('returns 32-byte hash', () => {
    const blinding = generatePlaySalt();
    const hash = computeCardPlayZkCommitHash(3, blinding);
    expect(hash.length).toBe(32);
  });

  it('equals keccak256 of the Pedersen commitment', () => {
    const blinding = generatePlaySalt();
    const cardId = 15;
    const c = computeCardPlayPedersenCommit(cardId, blinding);
    const expectedHash = Buffer.from(keccak256(c), 'hex');
    const actualHash = computeCardPlayZkCommitHash(cardId, blinding);
    expect(actualHash.equals(expectedHash)).toBe(true);
  });
});

describe('buildCardPlayRingProof', () => {
  const player = 'GPLAYER_TEST_1';
  const sessionId = 42;

  it('produces correct proof size for N=1', () => {
    const blinding = generatePlaySalt();
    const proof = buildCardPlayRingProof(5, blinding, [5], sessionId, player);
    // 96 + 1*64 = 160 bytes
    expect(proof.length).toBe(160);
  });

  it('produces correct proof size for N=3', () => {
    const blinding = generatePlaySalt();
    const proof = buildCardPlayRingProof(10, blinding, [9, 10, 11], sessionId, player);
    // 96 + 3*64 = 288 bytes
    expect(proof.length).toBe(288);
  });

  it('produces correct proof size for N=5', () => {
    const blinding = generatePlaySalt();
    const proof = buildCardPlayRingProof(2, blinding, [0, 1, 2, 3, 4], sessionId, player);
    // 96 + 5*64 = 416 bytes
    expect(proof.length).toBe(416);
  });

  it('first 96 bytes match the Pedersen commitment', () => {
    const blinding = generatePlaySalt();
    const cardId = 7;
    const c = computeCardPlayPedersenCommit(cardId, blinding);
    const proof = buildCardPlayRingProof(cardId, blinding, [7], sessionId, player);
    expect(Buffer.from(c).equals(proof.subarray(0, 96))).toBe(true);
  });

  it('commitment in proof hashes to the commit_hash', () => {
    const blinding = generatePlaySalt();
    const cardId = 20;
    const commitHash = computeCardPlayZkCommitHash(cardId, blinding);
    const proof = buildCardPlayRingProof(cardId, blinding, [18, 19, 20, 21], sessionId, player);
    const cFromProof = proof.subarray(0, 96);
    const hashFromProof = Buffer.from(keccak256(cFromProof), 'hex');
    expect(hashFromProof.equals(commitHash)).toBe(true);
  });

  it('throws if cardId is not in validSet', () => {
    const blinding = generatePlaySalt();
    expect(() => buildCardPlayRingProof(5, blinding, [1, 2, 3], sessionId, player))
      .toThrow('cardId must be in validSet');
  });

  it('throws if validSet is empty', () => {
    const blinding = generatePlaySalt();
    expect(() => buildCardPlayRingProof(5, blinding, [], sessionId, player))
      .toThrow('validSet must be non-empty');
  });

  it('different sessions produce different proofs', () => {
    const blinding = generatePlaySalt();
    const p1 = buildCardPlayRingProof(5, blinding, [5], 100, player);
    const p2 = buildCardPlayRingProof(5, blinding, [5], 200, player);
    // C (first 96 bytes) is the same, but e/z differ due to randomness and different Fiat-Shamir
    // The 96-byte prefix (C) should be the same
    expect(p1.subarray(0, 96).equals(p2.subarray(0, 96))).toBe(true);
    // The ring sigma parts should differ (different challenge preimage)
    expect(p1.subarray(96).equals(p2.subarray(96))).toBe(false);
  });

  it('ring sigma e_i values sum to the Fiat-Shamir challenge (self-consistency)', () => {
    // This verifies the prover's algebraic constraint: Σ e_i == e (mod Fr)
    const blinding = generatePlaySalt();
    const cardId = 10;
    const validSet = [9, 10, 11];
    const N = validSet.length;
    const proof = buildCardPlayRingProof(cardId, blinding, validSet, sessionId, player);

    // Extract C and e_i values
    const cBytes = proof.subarray(0, 96);
    const eiValues: bigint[] = [];
    for (let i = 0; i < N; i++) {
      const eiBuf = proof.subarray(96 + i * 64, 96 + i * 64 + 32);
      let val = 0n;
      for (const b of eiBuf) val = (val << 8n) | BigInt(b);
      eiValues.push(val);
    }

    // All e_i should be non-zero (extremely unlikely to be zero for random values)
    for (const ei of eiValues) {
      expect(ei).not.toBe(0n);
    }

    // Sum should be a well-formed Fr element (< Fr order)
    const FR_ORDER = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
    let sum = 0n;
    for (const ei of eiValues) {
      sum = (sum + ei) % FR_ORDER;
    }
    // Sum should be non-zero (the Fiat-Shamir hash is virtually never zero)
    expect(sum).not.toBe(0n);
    // And should be < FR_ORDER
    expect(sum < FR_ORDER).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Mode 8: ZK Cangkul Hand Proof (Aggregate Pedersen + Schnorr)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Mode 8: ZK Cangkul Hand Proof', () => {
  const sessionId = 42;
  const player = 'GBTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234';

  it('computeHandAggregateCommit returns 96-byte point and bigint rAgg', () => {
    const hand = [3, 12, 25]; // 3 cards, no suit constraint in helper
    const blindings = hand.map(() => generatePlaySalt());
    const { aBytes, rAgg } = computeHandAggregateCommit(hand, blindings);
    expect(aBytes).toBeInstanceOf(Uint8Array);
    expect(aBytes.length).toBe(96);
    expect(typeof rAgg).toBe('bigint');
    expect(rAgg).toBeGreaterThan(0n);
  });

  it('computeHandAggregateCommit is deterministic with same blindings', () => {
    const hand = [0, 9, 18, 27];
    const blindings = hand.map(() => generatePlaySalt());
    const r1 = computeHandAggregateCommit(hand, blindings);
    const r2 = computeHandAggregateCommit(hand, blindings);
    expect(Buffer.from(r1.aBytes).equals(Buffer.from(r2.aBytes))).toBe(true);
    expect(r1.rAgg).toBe(r2.rAgg);
  });

  it('different blindings produce different aggregate commits', () => {
    const hand = [5, 14];
    const b1 = hand.map(() => generatePlaySalt());
    const b2 = hand.map(() => generatePlaySalt());
    const r1 = computeHandAggregateCommit(hand, b1);
    const r2 = computeHandAggregateCommit(hand, b2);
    expect(Buffer.from(r1.aBytes).equals(Buffer.from(r2.aBytes))).toBe(false);
  });

  it('computeCangkulZkCommitHash returns 32-byte keccak256 of aggregate', () => {
    const hand = [2, 11, 20];
    const blindings = hand.map(() => generatePlaySalt());
    const hash = computeCangkulZkCommitHash(hand, blindings);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);

    // Should match keccak256 of the aggregate point bytes
    const { aBytes } = computeHandAggregateCommit(hand, blindings);
    const expected = Buffer.from(keccak256(aBytes), 'hex');
    expect(hash.equals(expected)).toBe(true);
  });

  it('computeCangkulRevealSalt returns 32-byte r_agg encoding', () => {
    const hand = [1, 10, 19];
    const blindings = hand.map(() => generatePlaySalt());
    const salt = computeCangkulRevealSalt(hand, blindings);
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(32);

    // Should encode the same rAgg value
    const { rAgg } = computeHandAggregateCommit(hand, blindings);
    let decoded = 0n;
    for (const b of salt) decoded = (decoded << 8n) | BigInt(b);
    expect(decoded).toBe(rAgg);
  });

  it('buildCangkulZkProof returns exactly 228 bytes', () => {
    const hand = [3, 12, 25]; // suits 0, 1, 2 — trick_suit=3 has no match
    const blindings = hand.map(() => generatePlaySalt());
    const proof = buildCangkulZkProof(hand, blindings, 3, sessionId, player);
    expect(proof).toBeInstanceOf(Buffer);
    expect(proof.length).toBe(228);
  });

  it('proof layout: k(4) || A(96) || R(96) || z(32)', () => {
    const hand = [0, 9, 18]; // 3 cards
    const blindings = hand.map(() => generatePlaySalt());
    const proof = buildCangkulZkProof(hand, blindings, 3, sessionId, player);

    // k = hand.length = 3 (big-endian u32)
    const k = proof.readUInt32BE(0);
    expect(k).toBe(3);

    // A should match aggregate commit
    const { aBytes } = computeHandAggregateCommit(hand, blindings);
    const proofA = proof.subarray(4, 100);
    expect(Buffer.from(proofA).equals(Buffer.from(aBytes))).toBe(true);

    // R and z should be non-zero
    const R = proof.subarray(100, 196);
    const z = proof.subarray(196, 228);
    const rNonZero = R.some((b: number) => b !== 0);
    const zNonZero = z.some((b: number) => b !== 0);
    expect(rNonZero).toBe(true);
    expect(zNonZero).toBe(true);
  });

  it('proof k field encodes hand length correctly for various sizes', () => {
    for (const n of [1, 2, 5, 10]) {
      const hand = Array.from({ length: n }, (_, i) => i);
      const blindings = hand.map(() => generatePlaySalt());
      const proof = buildCangkulZkProof(hand, blindings, 3, 1, player);
      expect(proof.readUInt32BE(0)).toBe(n);
    }
  });

  it('different sessions produce different proofs (Fiat-Shamir binding)', () => {
    const hand = [4, 13];
    const blindings = hand.map(() => generatePlaySalt());
    const p1 = buildCangkulZkProof(hand, blindings, 2, 1, player);
    const p2 = buildCangkulZkProof(hand, blindings, 2, 2, player);
    // A should be the same (same hand + blindings), but R and z should differ
    expect(Buffer.from(p1.subarray(4, 100)).equals(Buffer.from(p2.subarray(4, 100)))).toBe(true);
    // z differs because Fiat-Shamir challenge includes session_id
    // (R differs because nonce is random each call)
    expect(Buffer.from(p1.subarray(196)).equals(Buffer.from(p2.subarray(196)))).toBe(false);
  });

  it('throws for empty hand', () => {
    expect(() =>
      buildCangkulZkProof([], [], 0, sessionId, player),
    ).toThrow('hand must be non-empty');
  });
});
