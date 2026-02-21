// =============================================================================
//  Seed Verification Circuit for Cangkulan ZK Card Game
// =============================================================================
//
//  Proves TWO properties simultaneously:
//    1. blake2s(seed) == seed_hash  (preimage knowledge)
//    2. seed[0..4] != [0,0,0,0]    (minimum entropy -- first 4 bytes non-zero)
//
//  Private input:  seed      (32 bytes) - the player's secret random seed
//  Public input:   seed_hash (32 bytes) - blake2s(seed), the commitment
//
//  This circuit is compiled to ACIR, then proved with UltraHonk (bb.js).
//  The resulting proof is verified on-chain by the Soroban UltraHonk verifier
//  contract on the Stellar network.
//
//  Security properties:
//  - Soundness: only someone who knows the actual seed preimage can produce
//    a valid proof
//  - Zero-knowledge: the proof reveals nothing about the seed beyond that
//    its hash matches seed_hash
//  - Binding: the prover cannot find a different seed that produces the same
//    hash (collision resistance of blake2s)
//  - Entropy: trivially weak seeds (leading 4 bytes all zero) are rejected
//    inside the circuit, so a valid proof guarantees non-trivial entropy
// =============================================================================

use std::hash::blake2s;

fn main(seed: [u8; 32], seed_hash: pub [u8; 32]) {
    // -- 1. Hash preimage constraint --
    // Compute blake2s hash of the private seed inside the circuit
    let computed_hash = blake2s(seed);

    // Constrain: computed hash must match the public seed_hash
    assert(computed_hash == seed_hash, "seed hash mismatch: blake2s(seed) != seed_hash");

    // -- 2. Minimum entropy constraint --
    // Reject seeds whose first 4 bytes are all zero.
    // This prevents trivially weak seeds like [0; 32] from producing valid
    // proofs -- the prover must demonstrate the seed has non-trivial entropy
    // WITHOUT revealing the seed itself.
    //
    // We compute the OR of the first 4 bytes; if all are zero the OR is zero.
    let prefix_or: u8 = seed[0] | seed[1] | seed[2] | seed[3];
    assert(prefix_or != 0, "seed entropy too low: first 4 bytes are all zero");
}

// =============================================================================
//  Tests
// =============================================================================

#[test]
fn test_valid_seed() {
    // Test with a known seed and hash pair
    let seed: [u8; 32] = [
         1,  2,  3,  4,  5,  6,  7,  8,
         9, 10, 11, 12, 13, 14, 15, 16,
        17, 18, 19, 20, 21, 22, 23, 24,
        25, 26, 27, 28, 29, 30, 31, 32,
    ];
    let hash = blake2s(seed);
    // This should pass - correct preimage + non-zero prefix
    main(seed, hash);
}

#[test]
fn test_seed_with_nonzero_prefix() {
    // Seed where only byte 0 is non-zero in the first 4 -- should pass
    let mut seed: [u8; 32] = [0; 32];
    seed[0] = 0x42;
    seed[16] = 0xff;
    let hash = blake2s(seed);
    main(seed, hash);
}

#[test]
fn test_seed_byte3_nonzero() {
    // Seed where only byte 3 (of the first 4) is non-zero -- should pass
    let mut seed: [u8; 32] = [0; 32];
    seed[3] = 1;
    seed[8] = 0xab;
    let hash = blake2s(seed);
    main(seed, hash);
}

#[test(should_fail_with = "seed hash mismatch")]
fn test_wrong_seed_fails() {
    let seed: [u8; 32] = [1; 32];
    let wrong_hash: [u8; 32] = [0; 32]; // wrong hash
    main(seed, wrong_hash);
}

#[test(should_fail_with = "seed entropy too low")]
fn test_zero_prefix_fails() {
    // All-zero seed -- first 4 bytes are zero, must fail
    let seed: [u8; 32] = [0; 32];
    let hash = blake2s(seed);
    main(seed, hash);
}

#[test(should_fail_with = "seed entropy too low")]
fn test_only_later_bytes_nonzero_fails() {
    // First 4 bytes zero, rest non-zero -- still fails entropy check
    let mut seed: [u8; 32] = [0; 32];
    seed[4] = 0xff;
    seed[5] = 0xff;
    seed[31] = 0x01;
    let hash = blake2s(seed);
    main(seed, hash);
}
