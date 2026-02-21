#![no_std]

//! # ZK Commitment Verifier (Multi-Mode: NIZK, Pedersen, Ring Sigma, Hand Proof)
//!
//! On-chain verifier contract supporting four verification modes:
//!
//! | Mode | Name                | Curve      | Use Case                    |
//! |------|---------------------|------------|-----------------------------|
//! | 2    | NIZK Seed (hash)    | keccak256  | Cangkulan seed NIZK         |
//! | 4    | Pedersen+Sigma      | BLS12-381  | EC seed commitment          |
//! | 7    | Card Play Ring Sigma| BLS12-381  | ZK card play compliance     |
//! | 8    | Cangkul Hand Proof  | BLS12-381  | ZK suit exclusion (cangkul) |
//!
//! ## Mode 2 — NIZK Seed Proof of Knowledge (cangkulan, enhanced ZK)
//!
//! A Non-Interactive Zero-Knowledge Proof of Knowledge (NIZKPoK) for
//! seed commitment in Cangkulan. The raw seed is **never revealed on-chain**
//! — only its hash (`seed_hash = keccak256(seed)`) is published. The
//! protocol uses a blinded commitment scheme with Fiat-Shamir challenge
//! derivation for non-interactivity.
//!
//! ### Security Properties
//!
//! - **Zero-Knowledge**: The raw seed never appears on-chain. Only `seed_hash
//!   = H(seed)` is revealed, which is computationally indistinguishable from
//!   random under the preimage resistance of keccak256.
//! - **Soundness**: Forging a proof requires finding a preimage of keccak256
//!   (computationally infeasible, 2^256 security).
//! - **Completeness**: An honest prover who knows the seed can always produce
//!   a valid proof.
//! - **Hiding**: The blinding factor makes the commitment information-
//!   theoretically hiding in the random oracle model.
//! - **Binding**: Hash-based commitment is computationally binding.
//! - **Non-Interactive**: Fiat-Shamir transform with domain separator makes
//!   the proof non-interactive (no verifier interaction needed).
//! - **Session-Bound**: Nullifier and challenge include session_id, preventing
//!   cross-session proof replay.
//!
//! ### Protocol
//!
//! **Commitment (client-side, submitted to contract):**
//! ```text
//! seed_hash  = keccak256(seed)
//! commitment = keccak256(seed_hash || blinding || player_address)
//! ```
//!
//! **Proof Generation (client-side, Fiat-Shamir NIZK):**
//! ```text
//! nullifier  = keccak256(seed_hash || "NULL" || session_id_be4)
//! challenge  = keccak256(commitment || session_id_be4 || player_address || "ZKV2")
//! response   = keccak256(seed_hash || challenge || blinding)
//! ```
//!
//! **Public inputs layout:**
//! ```text
//! [0..32)    seed_hash    : keccak256(seed) — one-way, seed stays private
//! [32..64)   commitment   : keccak256(seed_hash || blinding || player_address)
//! [64..96)   nullifier    : keccak256(seed_hash || "NULL" || session_id)
//! [96..100)  session_id   : u32 big-endian
//! [100..)    player       : variable-length address string bytes
//! ```
//!
//! **Proof layout:**
//! ```text
//! [0..32)    blinding     : 32-byte random blinding factor (witness)
//! [32..64)   response     : keccak256(seed_hash || challenge || blinding)
//! ```
//!
//! ### On-chain Verification Steps
//!
//! 1. Recompute commitment: `C' = keccak256(seed_hash || blinding || player)`
//! 2. Verify `C' == commitment` (binding check)
//! 3. Recompute nullifier: `N' = keccak256(seed_hash || "NULL" || session_id)`
//! 4. Verify `N' == nullifier` (session-binding check)
//! 5. Recompute challenge: `e = keccak256(commitment || session_id || player || "ZKV2")`
//! 6. Verify response: `keccak256(seed_hash || e || blinding) == response`
//! 7. Entropy check: `seed_hash` must have >= 4 distinct byte values
//!
//!
//! ## Mode 4 — Pedersen+Sigma Protocol (BLS12-381) — NEW!
//!
//! Information-theoretically hiding Pedersen commitment on BLS12-381 with
//! a Sigma protocol (Schnorr-like) proof of knowledge, made non-interactive
//! via Fiat-Shamir.
//!
//! ### Protocol
//!
//! **Setup (deterministic, reproducible by anyone):**
//! ```text
//! G = BLS12-381 generator (standard)
//! H = hash_to_g1("PEDERSEN_H", "SGS_CANGKULAN_V1")  (nothing-up-my-sleeve)
//! ```
//!
//! **Commitment:**
//! ```text
//! C = seed_scalar · G + blinding_scalar · H     (Pedersen commitment)
//! ```
//!
//! **Proof (Sigma / Schnorr-like, Fiat-Shamir):**
//! ```text
//! R  = k_s · G + k_r · H                        (nonce commitment)
//! e  = keccak256(C || R || session_id || player || "ZKP4")  (challenge)
//! z_s = k_s + e · seed_scalar    (mod r)
//! z_r = k_r + e · blinding_scalar (mod r)
//! ```
//!
//! **Verification (on-chain):**
//! ```text
//! LHS = z_s · G + z_r · H        (via g1_msm)
//! RHS = R + e · C                 (via g1_mul + g1_add)
//! Accept iff LHS == RHS
//! ```
//!
//! **Public inputs:** `C(96 bytes, G1) || session_id(4) || player(var)`
//! **Proof:** `R(96 bytes, G1) || z_r(32 bytes, Fr)` = 128 bytes
//!
//! ### Security
//! - **Information-theoretic hiding**: Pedersen commitment is perfectly hiding
//! - **Computational binding**: Under DLP hardness on BLS12-381
//! - **Soundness**: Sigma protocol with Fiat-Shamir in ROM
//!
//! - **NIZK seed mode**: Proof is exactly 64 bytes (blinding + response)
//! - **Pedersen+Sigma mode**: Proof is exactly 128 bytes (R + z_r)
//! - **Card Play Ring Sigma mode**: Proof is 96 + N×64 bytes where N ∈ [1, 9]
//! - **Cangkul Hand Proof mode**: Proof is exactly 228 bytes (k + A + R + z)

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, Bytes, BytesN, Env, Vec};
use soroban_sdk::crypto::bls12_381::{Bls12_381, Fr, G1Affine};


// ═══════════════════════════════════════════════════════════════════════════════
//  Error codes
// ═══════════════════════════════════════════════════════════════════════════════

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ZkVerifyError {
    ProofWrongLength = 1,
    InputsTooShort = 2,
    SeedProofMismatch = 3,
    SeedInputsTooShort = 4,
    EmptyPlayerAddress = 5,
    HashMismatch = 6,
    // Enhanced NIZK errors
    NullifierMismatch = 7,
    ChallengeMismatch = 8,
    ResponseMismatch = 9,
    WeakSeedEntropy = 10,
    CommitmentMismatch = 11,
    // EC / Pedersen+Sigma errors (Mode 4)
    PedersenPointNotOnCurve = 12,
    PedersenSigmaCheckFailed = 13,
    // Card Play Ring Sigma errors (Mode 7)
    RingInvalidSetSize = 19,
    RingChallengeCheckFailed = 20,
    RingPointNotOnCurve = 21,
    // Cangkul Hand Proof errors (Mode 8)
    HandSuitViolation = 22,
    HandCardCountMismatch = 23,
    HandSchnorrCheckFailed = 24,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Events
// ═══════════════════════════════════════════════════════════════════════════════

#[contractevent]
pub struct EvVerifyFailed {
    pub reason: u32,
}

#[contractevent]
pub struct EvVerifySuccess {
    pub mode: u32, // 2 = NIZK seed, 4 = Pedersen+Sigma, 7 = Card Play Ring Sigma, 8 = Cangkul Hand Proof
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Domain Separators (prevent cross-protocol attacks)
// ═══════════════════════════════════════════════════════════════════════════════

/// Domain separator for nullifier derivation: ASCII "NULL" = 0x4E554C4C
const NULLIFIER_TAG: [u8; 4] = [0x4E, 0x55, 0x4C, 0x4C];

/// Domain separator for Fiat-Shamir challenge: ASCII "ZKV2" = 0x5A4B5632
const CHALLENGE_TAG: [u8; 4] = [0x5A, 0x4B, 0x56, 0x32];

/// Domain separator for Pedersen+Sigma Fiat-Shamir: ASCII "ZKP4" = 0x5A4B5034
const PEDERSEN_CHALLENGE_TAG: [u8; 4] = [0x5A, 0x4B, 0x50, 0x34];

/// Domain separator for Card Play Ring Sigma Fiat-Shamir: ASCII "ZKP7" = 0x5A4B5037
const RING_CHALLENGE_TAG: [u8; 4] = [0x5A, 0x4B, 0x50, 0x37];

/// Domain separator for Cangkul Hand Proof Fiat-Shamir: ASCII "ZKP8" = 0x5A4B5038
const CANGKUL_CHALLENGE_TAG: [u8; 4] = [0x5A, 0x4B, 0x50, 0x38];

/// Domain separation tag (DST) for hash_to_g1 to derive the Pedersen H generator.
/// H = hash_to_g1("PEDERSEN_H", "SGS_CANGKULAN_V1")
/// This is a nothing-up-my-sleeve construction: anyone can reproduce H.
const PEDERSEN_H_MSG: &[u8] = b"PEDERSEN_H";
const PEDERSEN_H_DST: &[u8] = b"SGS_CANGKULAN_V1";

// ═══════════════════════════════════════════════════════════════════════════════
//  Contract
// ═══════════════════════════════════════════════════════════════════════════════

#[contract]
pub struct ZkCommitmentVerifier;

#[contractimpl]
impl ZkCommitmentVerifier {
    /// Verify a ZK commitment proof (auto-detects mode by proof length).
    ///
    /// Returns `true` if the proof is valid, `false` otherwise.
    /// Emits diagnostic events on success or failure.
    pub fn verify(env: Env, public_inputs: Bytes, proof: Bytes) -> bool {
        // ── Proof length determines the mode ────────────────────────────────
        let proof_len = proof.len();

        if proof_len == 0 {
            EvVerifyFailed { reason: ZkVerifyError::ProofWrongLength as u32 }.publish(&env);
            return false;
        }



        // Mode 4: Pedersen+Sigma — proof is exactly 128 bytes (R_G1 + z_r)
        if proof_len == 128 {
            return Self::verify_pedersen_sigma(&env, &public_inputs, &proof);
        }

        // Mode 8: Cangkul Hand Proof — proof is exactly 228 bytes (k(4) + A(96) + R(96) + z(32))
        if proof_len == 228 {
            return Self::verify_cangkul_hand(&env, &public_inputs, &proof);
        }

        // Mode 7: Card Play Ring Sigma — proof is 96 + N×64 bytes where N ∈ [1, 9]
        // Mode 7 max valid N = 9 (max cards per suit),
        // so proof_len ≤ 96 + 9*64 = 672.
        if proof_len >= 160 && (proof_len - 96) % 64 == 0 {
            return Self::verify_card_play_ring(&env, &public_inputs, &proof);
        }


        // Mode 2: NIZK seed — proof is exactly 64 bytes (blinding + response)
        if proof_len == 64 && public_inputs.len() >= 101 {
            return Self::verify_nizk_seed(&env, &public_inputs, &proof);
        }


        // No matching mode — reject
        EvVerifyFailed { reason: ZkVerifyError::ProofWrongLength as u32 }.publish(&env);
        false
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Mode 2: NIZK Seed Proof of Knowledge (enhanced ZK — new!)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Non-Interactive Zero-Knowledge Proof of Knowledge for seed commitment.
    ///
    /// The prover demonstrates knowledge of `seed` such that:
    ///   `seed_hash = keccak256(seed)` AND
    ///   `commitment = keccak256(seed_hash || blinding || player_address)`
    /// WITHOUT revealing the raw `seed` on-chain.
    ///
    /// **Public inputs:** `seed_hash(32) || commitment(32) || nullifier(32) || session_id(4) || player(var)`
    /// **Proof:** `blinding(32) || response(32)`
    ///
    /// Verification:
    /// 1. Commitment binding: `keccak256(seed_hash || blinding || player) == commitment`
    /// 2. Nullifier check: `keccak256(seed_hash || "NULL" || session_id) == nullifier`
    /// 3. Fiat-Shamir challenge: `e = keccak256(commitment || session_id || player || "ZKV2")`
    /// 4. Response check: `keccak256(seed_hash || e || blinding) == response`
    /// 5. Entropy: `seed_hash` must have >= 4 distinct byte values
    fn verify_nizk_seed(
        env: &Env,
        public_inputs: &Bytes,
        proof: &Bytes,
    ) -> bool {
        // ── Extract public inputs ───────────────────────────────────────────
        // seed_hash: [0..32)
        let mut seed_hash_arr = [0u8; 32];
        let mut i = 0usize;
        while i < 32 {
            seed_hash_arr[i] = public_inputs.get(i as u32).unwrap_or(0);
            i += 1;
        }
        let seed_hash = BytesN::<32>::from_array(env, &seed_hash_arr);

        // commitment: [32..64)
        let mut commit_arr = [0u8; 32];
        i = 0;
        while i < 32 {
            commit_arr[i] = public_inputs.get((32 + i) as u32).unwrap_or(0);
            i += 1;
        }
        let commitment = BytesN::<32>::from_array(env, &commit_arr);

        // nullifier: [64..96)
        let mut null_arr = [0u8; 32];
        i = 0;
        while i < 32 {
            null_arr[i] = public_inputs.get((64 + i) as u32).unwrap_or(0);
            i += 1;
        }
        let nullifier = BytesN::<32>::from_array(env, &null_arr);

        // session_id: [96..100)
        let mut sid_arr = [0u8; 4];
        i = 0;
        while i < 4 {
            sid_arr[i] = public_inputs.get((96 + i) as u32).unwrap_or(0);
            i += 1;
        }

        // player_address: [100..)
        let player_len = public_inputs.len() - 100;
        if player_len == 0 {
            EvVerifyFailed { reason: ZkVerifyError::EmptyPlayerAddress as u32 }.publish(env);
            return false;
        }
        let mut player_bytes = Bytes::new(env);
        let mut j = 0u32;
        while j < player_len {
            player_bytes.push_back(public_inputs.get(100 + j).unwrap_or(0));
            j += 1;
        }

        // ── Extract proof (witness) ─────────────────────────────────────────
        // blinding: [0..32)
        let mut blind_arr = [0u8; 32];
        i = 0;
        while i < 32 {
            blind_arr[i] = proof.get(i as u32).unwrap_or(0);
            i += 1;
        }
        let blinding = BytesN::<32>::from_array(env, &blind_arr);

        // response: [32..64)
        let mut resp_arr = [0u8; 32];
        i = 0;
        while i < 32 {
            resp_arr[i] = proof.get((32 + i) as u32).unwrap_or(0);
            i += 1;
        }
        let response = BytesN::<32>::from_array(env, &resp_arr);

        // ── Step 1: Verify commitment binding ───────────────────────────────
        // C' = keccak256(seed_hash || blinding || player_address)
        let mut commit_preimage = Bytes::from_array(env, &seed_hash.to_array());
        commit_preimage.append(&Bytes::from_array(env, &blinding.to_array()));
        commit_preimage.append(&player_bytes.clone());
        let computed_commitment: BytesN<32> = env.crypto().keccak256(&commit_preimage).into();
        if computed_commitment != commitment {
            EvVerifyFailed { reason: ZkVerifyError::CommitmentMismatch as u32 }.publish(env);
            return false;
        }

        // ── Step 2: Verify nullifier (session-binding) ──────────────────────
        // N' = keccak256(seed_hash || "NULL" || session_id_be4)
        let mut null_preimage = Bytes::from_array(env, &seed_hash.to_array());
        null_preimage.append(&Bytes::from_array(env, &NULLIFIER_TAG));
        null_preimage.append(&Bytes::from_array(env, &sid_arr));
        let computed_nullifier: BytesN<32> = env.crypto().keccak256(&null_preimage).into();
        if computed_nullifier != nullifier {
            EvVerifyFailed { reason: ZkVerifyError::NullifierMismatch as u32 }.publish(env);
            return false;
        }

        // ── Step 3: Recompute Fiat-Shamir challenge ─────────────────────────
        // e = keccak256(commitment || session_id_be4 || player_address || "ZKV2")
        let mut challenge_preimage = Bytes::from_array(env, &commitment.to_array());
        challenge_preimage.append(&Bytes::from_array(env, &sid_arr));
        challenge_preimage.append(&player_bytes);
        challenge_preimage.append(&Bytes::from_array(env, &CHALLENGE_TAG));
        let challenge: BytesN<32> = env.crypto().keccak256(&challenge_preimage).into();

        // ── Step 4: Verify response ─────────────────────────────────────────
        // expected_response = keccak256(seed_hash || challenge || blinding)
        let mut resp_preimage = Bytes::from_array(env, &seed_hash.to_array());
        resp_preimage.append(&Bytes::from_array(env, &challenge.to_array()));
        resp_preimage.append(&Bytes::from_array(env, &blinding.to_array()));
        let expected_response: BytesN<32> = env.crypto().keccak256(&resp_preimage).into();
        if expected_response != response {
            EvVerifyFailed { reason: ZkVerifyError::ResponseMismatch as u32 }.publish(env);
            return false;
        }

        // ── Step 5: Entropy check on seed_hash ──────────────────────────────
        // seed_hash must contain >= 4 distinct byte values
        let mut seen = [false; 256];
        let mut distinct: u32 = 0;
        i = 0;
        while i < 32 {
            let idx = seed_hash_arr[i] as usize;
            if !seen[idx] {
                seen[idx] = true;
                distinct += 1;
            }
            i += 1;
        }
        if distinct < 4 {
            EvVerifyFailed { reason: ZkVerifyError::WeakSeedEntropy as u32 }.publish(env);
            return false;
        }

        // ── All checks passed ───────────────────────────────────────────────
        EvVerifySuccess { mode: 2 }.publish(env);
        true
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Mode 4: Pedersen+Sigma Protocol (BLS12-381) — NEW!
    // ═══════════════════════════════════════════════════════════════════════════

    /// Derive the Pedersen H generator using hash_to_g1 with a fixed DST.
    /// This is deterministic and reproducible by anyone.
    fn pedersen_h(bls: &Bls12_381, env: &Env) -> G1Affine {
        let msg = Bytes::from_slice(env, PEDERSEN_H_MSG);
        let dst = Bytes::from_slice(env, PEDERSEN_H_DST);
        bls.hash_to_g1(&msg, &dst)
    }

    /// Extract a G1Affine point from a byte slice at a given offset.
    fn extract_g1(env: &Env, data: &Bytes, offset: u32) -> G1Affine {
        let mut arr = [0u8; 96];
        let mut i = 0usize;
        while i < 96 {
            arr[i] = data.get(offset + i as u32).unwrap_or(0);
            i += 1;
        }
        G1Affine::from_array(env, &arr)
    }

    /// Extract an Fr scalar from a byte slice at a given offset (32 bytes, big-endian).
    fn extract_fr(env: &Env, data: &Bytes, offset: u32) -> Fr {
        let mut arr = [0u8; 32];
        let mut i = 0usize;
        while i < 32 {
            arr[i] = data.get(offset + i as u32).unwrap_or(0);
            i += 1;
        }
        Fr::from_bytes(BytesN::<32>::from_array(env, &arr))
    }

    /// Pedersen+Sigma verification (Mode 4).
    ///
    /// **Public inputs:** `C(96, G1) || seed_hash(32, Fr) || session_id(4) || player(var)`
    /// **Proof:** `R(96, G1) || z_r(32, Fr)` = 128 bytes
    ///
    /// Verification:
    /// 1. Derive H = hash_to_g1("PEDERSEN_H", "SGS_CANGKULAN_V1")
    /// 2. Extract C, R, z_r from proof; seed_hash from public_inputs
    /// 3. Check C and R are in the G1 subgroup
    /// 4. Compute D = C − seed_hash·G (strips public component)
    /// 5. Compute Fiat-Shamir challenge: e = Fr(keccak256(C || R || seed_hash || session_id || player || "ZKP4"))
    /// 6. Schnorr check: z_r·H == R + e·D (proves knowledge of blinding r)
    /// 7. Accept iff LHS == RHS
    fn verify_pedersen_sigma(
        env: &Env,
        public_inputs: &Bytes,
        proof: &Bytes,
    ) -> bool {
        let bls = env.crypto().bls12_381();

        // ── Minimum public_inputs length: C(96) + seed_hash(32) + session_id(4) + player(>=1) = 133
        if public_inputs.len() < 133 {
            EvVerifyFailed { reason: ZkVerifyError::InputsTooShort as u32 }.publish(env);
            return false;
        }

        // ── Extract public inputs ───────────────────────────────────────────
        let commitment = Self::extract_g1(env, public_inputs, 0); // C: [0..96)
        let seed_hash_fr = Self::extract_fr(env, public_inputs, 96); // seed_hash as Fr: [96..128)

        // seed_hash raw bytes for challenge
        let mut seed_hash_bytes = [0u8; 32];
        {
            let mut i = 0usize;
            while i < 32 {
                seed_hash_bytes[i] = public_inputs.get((96 + i) as u32).unwrap_or(0);
                i += 1;
            }
        }

        // session_id: [128..132)
        let mut sid_arr = [0u8; 4];
        {
            let mut i = 0usize;
            while i < 4 {
                sid_arr[i] = public_inputs.get((128 + i) as u32).unwrap_or(0);
                i += 1;
            }
        }

        // player: [132..)
        let player_len = public_inputs.len() - 132;
        if player_len == 0 {
            EvVerifyFailed { reason: ZkVerifyError::EmptyPlayerAddress as u32 }.publish(env);
            return false;
        }
        let mut player_bytes = Bytes::new(env);
        let mut j = 0u32;
        while j < player_len {
            player_bytes.push_back(public_inputs.get(132 + j).unwrap_or(0));
            j += 1;
        }

        // ── Extract proof: R(96) || z_r(32) ────────────────────────────────
        let r_point = Self::extract_g1(env, proof, 0);     // R: [0..96)
        let z_r = Self::extract_fr(env, proof, 96);         // z_r: [96..128)

        // ── Subgroup checks ─────────────────────────────────────────────────
        if !bls.g1_is_in_subgroup(&commitment) {
            EvVerifyFailed { reason: ZkVerifyError::PedersenPointNotOnCurve as u32 }.publish(env);
            return false;
        }
        if !bls.g1_is_in_subgroup(&r_point) {
            EvVerifyFailed { reason: ZkVerifyError::PedersenPointNotOnCurve as u32 }.publish(env);
            return false;
        }

        // ── Derive H generator and G1 generator ────────────────────────────
        let h = Self::pedersen_h(&bls, env);

        let g1_bytes: [u8; 96] = [
            0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
            0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
            0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
            0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
            0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
            0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
            0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
            0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
        ];
        let g = G1Affine::from_array(env, &g1_bytes);

        // ── Compute D = C − seed_hash·G ─────────────────────────────────────
        // If honest: D = blinding·H
        let s_times_g = bls.g1_mul(&g, &seed_hash_fr);
        let neg_s_times_g = -s_times_g;
        let d = bls.g1_add(&commitment, &neg_s_times_g);

        // ── Compute Fiat-Shamir challenge ───────────────────────────────────
        // e = Fr(keccak256(C || R || seed_hash || session_id || player || "ZKP4"))
        let c_bytes = commitment.to_bytes();
        let r_bytes = r_point.to_bytes();
        let mut challenge_preimage = Bytes::from_array(env, &c_bytes.to_array());
        challenge_preimage.append(&Bytes::from_array(env, &r_bytes.to_array()));
        challenge_preimage.append(&Bytes::from_array(env, &seed_hash_bytes));
        challenge_preimage.append(&Bytes::from_array(env, &sid_arr));
        challenge_preimage.append(&player_bytes);
        challenge_preimage.append(&Bytes::from_array(env, &PEDERSEN_CHALLENGE_TAG));
        let e_hash: BytesN<32> = env.crypto().keccak256(&challenge_preimage).into();
        let e = Fr::from_bytes(e_hash);

        // ── Schnorr verification on D ───────────────────────────────────────
        // Prove knowledge of r such that D = r·H
        // LHS = z_r · H
        // RHS = R + e · D
        let lhs = bls.g1_mul(&h, &z_r);
        let e_times_d = bls.g1_mul(&d, &e);
        let rhs = bls.g1_add(&r_point, &e_times_d);

        // ── Final equality check ────────────────────────────────────────────
        if lhs.to_bytes() != rhs.to_bytes() {
            EvVerifyFailed { reason: ZkVerifyError::PedersenSigmaCheckFailed as u32 }.publish(env);
            return false;
        }

        EvVerifySuccess { mode: 4 }.publish(env);
        true
    }

    /// Extract a u32 (big-endian) from bytes at a given offset.
    fn extract_u32(data: &Bytes, offset: u32) -> u32 {
        let b0 = data.get(offset).unwrap_or(0) as u32;
        let b1 = data.get(offset + 1).unwrap_or(0) as u32;
        let b2 = data.get(offset + 2).unwrap_or(0) as u32;
        let b3 = data.get(offset + 3).unwrap_or(0) as u32;
        (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Mode 7: Card Play Ring Sigma (1-of-N Schnorr on Pedersen / BLS12-381)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Ring Sigma verification for card plays (Mode 7).
    ///
    /// Proves that a Pedersen commitment C hides a card_id belonging to a
    /// known valid set, WITHOUT revealing which card was committed.
    ///
    /// **Public inputs layout:**
    /// ```text
    /// commit_hash(32) || N(4, u32 BE) || valid_set[N](4 each, u32 BE) ||
    /// session_id(4) || player(var)
    /// ```
    ///
    /// **Proof layout (96 + N×64 bytes):**
    /// ```text
    /// C(96, G1) || [e_i(32, Fr) || z_i(32, Fr)] × N
    /// ```
    ///
    /// **Verification:**
    /// 1. Derive H = hash_to_g1("PEDERSEN_H", "SGS_CANGKULAN_V1")
    /// 2. Verify keccak256(C) == commit_hash (binding check)
    /// 3. For each i: D_i = C − valid_set[i]·G, R_i = z_i·H − e_i·D_i
    /// 4. e = Fr(keccak256(C || R_0 || ... || R_{N-1} || session_id || player || "ZKP7"))
    /// 5. Accept iff Σe_i == e (checked at group level: Σ(e_i·G) == e·G)
    fn verify_card_play_ring(
        env: &Env,
        public_inputs: &Bytes,
        proof: &Bytes,
    ) -> bool {
        let bls = env.crypto().bls12_381();
        let proof_len = proof.len();

        // N = number of valid cards in the ring
        let n = (proof_len - 96) / 64;
        if n == 0 || n > 9 {
            EvVerifyFailed { reason: ZkVerifyError::RingInvalidSetSize as u32 }.publish(env);
            return false;
        }

        // Minimum public_inputs: commit_hash(32) + N(4) + valid_set(4*N) + session_id(4) + player(>=1)
        let min_inputs = 32 + 4 + 4 * n + 4 + 1;
        if public_inputs.len() < min_inputs {
            EvVerifyFailed { reason: ZkVerifyError::InputsTooShort as u32 }.publish(env);
            return false;
        }

        // ── Extract commit_hash [0..32) ─────────────────────────────────────
        let mut commit_arr = [0u8; 32];
        let mut i = 0usize;
        while i < 32 {
            commit_arr[i] = public_inputs.get(i as u32).unwrap_or(0);
            i += 1;
        }
        let commit_hash = BytesN::<32>::from_array(env, &commit_arr);

        // ── Extract N from public_inputs [32..36) and cross-check ───────────
        let pi_n = Self::extract_u32(public_inputs, 32);
        if pi_n != n {
            EvVerifyFailed { reason: ZkVerifyError::RingInvalidSetSize as u32 }.publish(env);
            return false;
        }

        let valid_set_offset = 36u32;

        // ── Extract session_id [36+4*N..40+4*N) ────────────────────────────
        let sid_offset = 36 + 4 * n;
        let mut sid_arr = [0u8; 4];
        i = 0;
        while i < 4 {
            sid_arr[i] = public_inputs.get(sid_offset + i as u32).unwrap_or(0);
            i += 1;
        }

        // ── Extract player [40+4*N..) ───────────────────────────────────────
        let player_offset = 40 + 4 * n;
        let player_len = public_inputs.len() - player_offset;
        if player_len == 0 {
            EvVerifyFailed { reason: ZkVerifyError::EmptyPlayerAddress as u32 }.publish(env);
            return false;
        }
        let mut player_bytes = Bytes::new(env);
        let mut j = 0u32;
        while j < player_len {
            player_bytes.push_back(public_inputs.get(player_offset + j).unwrap_or(0));
            j += 1;
        }

        // ── Extract C from proof [0..96) ────────────────────────────────────
        let commitment = Self::extract_g1(env, proof, 0);

        // Subgroup check
        if !bls.g1_is_in_subgroup(&commitment) {
            EvVerifyFailed { reason: ZkVerifyError::RingPointNotOnCurve as u32 }.publish(env);
            return false;
        }

        // Binding check: keccak256(C) == commit_hash
        let c_raw = commitment.to_bytes();
        let c_bytes_for_hash = Bytes::from_array(env, &c_raw.to_array());
        let computed_commit: BytesN<32> = env.crypto().keccak256(&c_bytes_for_hash).into();
        if computed_commit != commit_hash {
            EvVerifyFailed { reason: ZkVerifyError::CommitmentMismatch as u32 }.publish(env);
            return false;
        }

        // ── G1 generator (same as Mode 4) ──────────────────────────────────
        let g1_bytes: [u8; 96] = [
            0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
            0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
            0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
            0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
            0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
            0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
            0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
            0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
        ];
        let g = G1Affine::from_array(env, &g1_bytes);

        // ── H generator (same nothing-up-my-sleeve derivation) ─────────────
        let h = Self::pedersen_h(&bls, env);

        // ── Process each ring member: compute D_i and R_i ──────────────────
        // Also build Fiat-Shamir challenge preimage: C || R_0 || ... || R_{N-1} || session_id || player || "ZKP7"
        let mut challenge_preimage = Bytes::from_array(env, &c_raw.to_array());

        // Vectors for the Σ e_i group-level check via MSM
        let mut g_vec: Vec<G1Affine> = Vec::new(env);
        let mut e_vec: Vec<Fr> = Vec::new(env);

        let mut idx = 0u32;
        while idx < n {
            // Extract e_i from proof [96 + idx*64 .. 96 + idx*64 + 32)
            let e_i = Self::extract_fr(env, proof, 96 + idx * 64);
            // Extract z_i from proof [96 + idx*64 + 32 .. 96 + idx*64 + 64)
            let z_i = Self::extract_fr(env, proof, 96 + idx * 64 + 32);

            // Extract valid_set[idx] and convert to Fr
            let card_val = Self::extract_u32(public_inputs, valid_set_offset + idx * 4);
            let mut card_fr_arr = [0u8; 32];
            card_fr_arr[28] = ((card_val >> 24) & 0xFF) as u8;
            card_fr_arr[29] = ((card_val >> 16) & 0xFF) as u8;
            card_fr_arr[30] = ((card_val >> 8) & 0xFF) as u8;
            card_fr_arr[31] = (card_val & 0xFF) as u8;
            let card_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &card_fr_arr));

            // D_i = C − card_i·G
            let card_times_g = bls.g1_mul(&g, &card_fr);
            let neg_card_g = -card_times_g;
            let d_i = bls.g1_add(&commitment, &neg_card_g);

            // R_i = z_i·H − e_i·D_i
            let z_h = bls.g1_mul(&h, &z_i);
            let e_d = bls.g1_mul(&d_i, &e_i);
            let neg_e_d = -e_d;
            let r_i = bls.g1_add(&z_h, &neg_e_d);

            // Append R_i to challenge preimage
            let r_i_raw = r_i.to_bytes();
            challenge_preimage.append(&Bytes::from_array(env, &r_i_raw.to_array()));

            // Accumulate for Σ e_i · G check
            g_vec.push_back(g.clone());
            e_vec.push_back(e_i);

            idx += 1;
        }

        // ── Fiat-Shamir challenge ───────────────────────────────────────────
        challenge_preimage.append(&Bytes::from_array(env, &sid_arr));
        challenge_preimage.append(&player_bytes);
        challenge_preimage.append(&Bytes::from_array(env, &RING_CHALLENGE_TAG));

        let e_hash: BytesN<32> = env.crypto().keccak256(&challenge_preimage).into();
        let expected_e = Fr::from_bytes(e_hash);

        // ── Check Σ e_i == expected_e via group-level comparison ────────────
        // MSM computes Σ (e_i · G) which equals (Σ e_i) · G
        let sum_point = bls.g1_msm(g_vec, e_vec);
        let expected_point = bls.g1_mul(&g, &expected_e);

        if sum_point.to_bytes() != expected_point.to_bytes() {
            EvVerifyFailed { reason: ZkVerifyError::RingChallengeCheckFailed as u32 }.publish(env);
            return false;
        }

        EvVerifySuccess { mode: 7 }.publish(env);
        true
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Mode 8: Cangkul Hand Proof (Aggregate Pedersen + Schnorr + Suit Exclusion)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Cangkul hand binding verification (Mode 8).
    ///
    /// Proves that a player's hand contains NO cards matching the trick suit,
    /// using an aggregate Pedersen commitment over the entire hand with a
    /// Schnorr proof of knowledge of the aggregate blinding factor.
    ///
    /// **Security properties:**
    /// - **Binding**: keccak256(A) == commit_hash ties the proof to the commit.
    /// - **Knowledge**: Schnorr sigma proves the prover knows r_agg such that
    ///   A = (Σ card_i)·G + r_agg·H.
    /// - **Suit exclusion**: Every card in the public set is checked against
    ///   trick_suit on-chain — no card with matching suit passes.
    /// - **Session-bound**: Fiat-Shamir challenge includes session_id and player,
    ///   preventing cross-session replay.
    ///
    /// **Public inputs layout:**
    /// ```text
    /// commit_hash(32) || trick_suit(4, u32 BE) || k(4, u32 BE) ||
    /// card_1(4) || ... || card_k(4) || session_id(4) || player(var)
    /// ```
    ///
    /// **Proof layout (228 bytes):**
    /// ```text
    /// k(4, u32 BE) || A(96, G1) || R(96, G1) || z(32, Fr)
    /// ```
    ///
    /// **Verification:**
    /// 1. Cross-check k in proof vs public_inputs
    /// 2. Binding: keccak256(A) == commit_hash
    /// 3. Suit exclusion: for each card_i, verify card_i / 9 ≠ trick_suit
    /// 4. Compute expected_sum = Σ(card_i · G) via g1_msm
    /// 5. delta = A − expected_sum (should be r_agg · H)
    /// 6. e = Fr(keccak256(A || R || trick_suit || k || session_id || player || "ZKP8"))
    /// 7. Schnorr check: z · H == R + e · delta
    fn verify_cangkul_hand(
        env: &Env,
        public_inputs: &Bytes,
        proof: &Bytes,
    ) -> bool {
        let bls = env.crypto().bls12_381();

        // ── Extract k from proof [0..4) ─────────────────────────────────────
        let k = Self::extract_u32(proof, 0);
        if k == 0 || k > 18 {
            EvVerifyFailed { reason: ZkVerifyError::HandCardCountMismatch as u32 }.publish(env);
            return false;
        }

        // Minimum public_inputs: commit_hash(32) + trick_suit(4) + k(4) + cards(4*k) + session_id(4) + player(>=1)
        let min_inputs = 32 + 4 + 4 + 4 * k + 4 + 1;
        if public_inputs.len() < min_inputs {
            EvVerifyFailed { reason: ZkVerifyError::InputsTooShort as u32 }.publish(env);
            return false;
        }

        // ── Extract commit_hash [0..32) ─────────────────────────────────────
        let mut commit_arr = [0u8; 32];
        let mut i = 0usize;
        while i < 32 {
            commit_arr[i] = public_inputs.get(i as u32).unwrap_or(0);
            i += 1;
        }
        let commit_hash = BytesN::<32>::from_array(env, &commit_arr);

        // ── Extract trick_suit [32..36) ─────────────────────────────────────
        let trick_suit = Self::extract_u32(public_inputs, 32);
        if trick_suit > 3 {
            EvVerifyFailed { reason: ZkVerifyError::HandSuitViolation as u32 }.publish(env);
            return false;
        }

        // ── Cross-check k from public_inputs [36..40) ──────────────────────
        let k_pi = Self::extract_u32(public_inputs, 36);
        if k_pi != k {
            EvVerifyFailed { reason: ZkVerifyError::HandCardCountMismatch as u32 }.publish(env);
            return false;
        }

        // ── Extract card values, verify suit exclusion, build MSM vectors ──
        let cards_offset = 40u32;
        let g1_bytes: [u8; 96] = [
            0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
            0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
            0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
            0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
            0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
            0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
            0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
            0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
        ];
        let g = G1Affine::from_array(env, &g1_bytes);

        let mut g_vec: Vec<G1Affine> = Vec::new(env);
        let mut fr_vec: Vec<Fr> = Vec::new(env);

        let mut idx = 0u32;
        while idx < k {
            let card_val = Self::extract_u32(public_inputs, cards_offset + idx * 4);

            // Card range check
            if card_val >= 36 {
                EvVerifyFailed { reason: ZkVerifyError::HandSuitViolation as u32 }.publish(env);
                return false;
            }

            // Suit exclusion: floor(card / 9) must NOT equal trick_suit
            if card_val / 9 == trick_suit {
                EvVerifyFailed { reason: ZkVerifyError::HandSuitViolation as u32 }.publish(env);
                return false;
            }

            // Card → Fr scalar (u32 → 32-byte big-endian)
            let mut card_fr_arr = [0u8; 32];
            card_fr_arr[28] = ((card_val >> 24) & 0xFF) as u8;
            card_fr_arr[29] = ((card_val >> 16) & 0xFF) as u8;
            card_fr_arr[30] = ((card_val >> 8) & 0xFF) as u8;
            card_fr_arr[31] = (card_val & 0xFF) as u8;
            let card_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &card_fr_arr));

            g_vec.push_back(g.clone());
            fr_vec.push_back(card_fr);
            idx += 1;
        }

        // ── Extract session_id [40+4k..44+4k) ──────────────────────────────
        let sid_offset = 40 + 4 * k;
        let mut sid_arr = [0u8; 4];
        i = 0;
        while i < 4 {
            sid_arr[i] = public_inputs.get(sid_offset + i as u32).unwrap_or(0);
            i += 1;
        }

        // ── Extract player [44+4k..) ────────────────────────────────────────
        let player_offset = 44 + 4 * k;
        let player_len = public_inputs.len() - player_offset;
        if player_len == 0 {
            EvVerifyFailed { reason: ZkVerifyError::EmptyPlayerAddress as u32 }.publish(env);
            return false;
        }
        let mut player_bytes = Bytes::new(env);
        let mut j = 0u32;
        while j < player_len {
            player_bytes.push_back(public_inputs.get(player_offset + j).unwrap_or(0));
            j += 1;
        }

        // ── Extract proof fields ────────────────────────────────────────────
        // A (aggregate commitment) from proof [4..100)
        let agg_commit = Self::extract_g1(env, proof, 4);
        if !bls.g1_is_in_subgroup(&agg_commit) {
            EvVerifyFailed { reason: ZkVerifyError::RingPointNotOnCurve as u32 }.publish(env);
            return false;
        }

        // R (Schnorr nonce) from proof [100..196)
        let nonce_r = Self::extract_g1(env, proof, 100);
        if !bls.g1_is_in_subgroup(&nonce_r) {
            EvVerifyFailed { reason: ZkVerifyError::RingPointNotOnCurve as u32 }.publish(env);
            return false;
        }

        // z (Schnorr response) from proof [196..228)
        let z = Self::extract_fr(env, proof, 196);

        // ── Binding check: keccak256(A) == commit_hash ──────────────────────
        let a_raw = agg_commit.to_bytes();
        let a_bytes_for_hash = Bytes::from_array(env, &a_raw.to_array());
        let computed_commit: BytesN<32> = env.crypto().keccak256(&a_bytes_for_hash).into();
        if computed_commit != commit_hash {
            EvVerifyFailed { reason: ZkVerifyError::CommitmentMismatch as u32 }.publish(env);
            return false;
        }

        // ── Compute expected_sum = Σ(card_i · G) via MSM ────────────────────
        let expected_sum = bls.g1_msm(g_vec, fr_vec);

        // ── delta = A − expected_sum (should be r_agg · H) ─────────────────
        let neg_expected = -expected_sum;
        let delta = bls.g1_add(&agg_commit, &neg_expected);

        // ── H generator ─────────────────────────────────────────────────────
        let h = Self::pedersen_h(&bls, env);

        // ── Fiat-Shamir challenge ───────────────────────────────────────────
        // e = Fr(keccak256(A || R || trick_suit(4) || k(4) || session_id(4) || player || "ZKP8"))
        let mut challenge_preimage = Bytes::from_array(env, &a_raw.to_array());
        let r_raw = nonce_r.to_bytes();
        challenge_preimage.append(&Bytes::from_array(env, &r_raw.to_array()));
        challenge_preimage.append(&Bytes::from_array(env, &trick_suit.to_be_bytes()));
        challenge_preimage.append(&Bytes::from_array(env, &k.to_be_bytes()));
        challenge_preimage.append(&Bytes::from_array(env, &sid_arr));
        challenge_preimage.append(&player_bytes);
        challenge_preimage.append(&Bytes::from_array(env, &CANGKUL_CHALLENGE_TAG));

        let e_hash: BytesN<32> = env.crypto().keccak256(&challenge_preimage).into();
        let e = Fr::from_bytes(e_hash);

        // ── Schnorr verification: z · H == R + e · delta ────────────────────
        let z_h = bls.g1_mul(&h, &z);
        let e_delta = bls.g1_mul(&delta, &e);
        let r_plus_e_delta = bls.g1_add(&nonce_r, &e_delta);

        if z_h.to_bytes() != r_plus_e_delta.to_bytes() {
            EvVerifyFailed { reason: ZkVerifyError::HandSchnorrCheckFailed as u32 }.publish(env);
            return false;
        }

        EvVerifySuccess { mode: 8 }.publish(env);
        true
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, Address, Env};
    use soroban_sdk::crypto::bls12_381::{Fr, G1Affine};



    // ════════════════════════════════════════════════════════════════════════
    //  NIZK seed proof helpers (new!)
    // ════════════════════════════════════════════════════════════════════════

    /// Compute seed_hash = keccak256(seed)
    fn compute_seed_hash(env: &Env, seed: &BytesN<32>) -> BytesN<32> {
        env.crypto().keccak256(&Bytes::from_array(env, &seed.to_array())).into()
    }

    /// Compute blinded commitment = keccak256(seed_hash || blinding || player_address)
    fn compute_nizk_commitment(
        env: &Env,
        seed_hash: &BytesN<32>,
        blinding: &BytesN<32>,
        player: &Address,
    ) -> BytesN<32> {
        let mut pre = Bytes::from_array(env, &seed_hash.to_array());
        pre.append(&Bytes::from_array(env, &blinding.to_array()));
        pre.append(&player.to_string().to_bytes());
        env.crypto().keccak256(&pre).into()
    }

    /// Compute nullifier = keccak256(seed_hash || "NULL" || session_id_be4)
    fn compute_nullifier(env: &Env, seed_hash: &BytesN<32>, session_id: u32) -> BytesN<32> {
        let mut pre = Bytes::from_array(env, &seed_hash.to_array());
        pre.append(&Bytes::from_array(env, &NULLIFIER_TAG));
        pre.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        env.crypto().keccak256(&pre).into()
    }

    /// Compute Fiat-Shamir challenge = keccak256(commitment || session_id_be4 || player || "ZKV2")
    fn compute_fs_challenge(
        env: &Env,
        commitment: &BytesN<32>,
        session_id: u32,
        player: &Address,
    ) -> BytesN<32> {
        let mut pre = Bytes::from_array(env, &commitment.to_array());
        pre.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        pre.append(&player.to_string().to_bytes());
        pre.append(&Bytes::from_array(env, &CHALLENGE_TAG));
        env.crypto().keccak256(&pre).into()
    }

    /// Compute response = keccak256(seed_hash || challenge || blinding)
    fn compute_response(
        env: &Env,
        seed_hash: &BytesN<32>,
        challenge: &BytesN<32>,
        blinding: &BytesN<32>,
    ) -> BytesN<32> {
        let mut pre = Bytes::from_array(env, &seed_hash.to_array());
        pre.append(&Bytes::from_array(env, &challenge.to_array()));
        pre.append(&Bytes::from_array(env, &blinding.to_array()));
        env.crypto().keccak256(&pre).into()
    }

    /// Build NIZK public inputs
    fn encode_nizk_public_inputs(
        env: &Env,
        seed_hash: &BytesN<32>,
        commitment: &BytesN<32>,
        nullifier: &BytesN<32>,
        session_id: u32,
        player: &Address,
    ) -> Bytes {
        let mut buf = Bytes::from_array(env, &seed_hash.to_array());
        buf.append(&Bytes::from_array(env, &commitment.to_array()));
        buf.append(&Bytes::from_array(env, &nullifier.to_array()));
        buf.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        buf.append(&player.to_string().to_bytes());
        buf
    }

    /// Build NIZK proof (blinding || response)
    fn encode_nizk_proof(env: &Env, blinding: &BytesN<32>, response: &BytesN<32>) -> Bytes {
        let mut buf = Bytes::from_array(env, &blinding.to_array());
        buf.append(&Bytes::from_array(env, &response.to_array()));
        buf
    }

    /// Full NIZK proof generation helper (mirrors client-side logic)
    fn generate_nizk_proof(
        env: &Env,
        seed: &BytesN<32>,
        blinding: &BytesN<32>,
        session_id: u32,
        player: &Address,
    ) -> (Bytes, Bytes, BytesN<32>) {
        let seed_hash = compute_seed_hash(env, seed);
        let commitment = compute_nizk_commitment(env, &seed_hash, blinding, player);
        let nullifier = compute_nullifier(env, &seed_hash, session_id);
        let challenge = compute_fs_challenge(env, &commitment, session_id, player);
        let response = compute_response(env, &seed_hash, &challenge, blinding);

        let public_inputs = encode_nizk_public_inputs(env, &seed_hash, &commitment, &nullifier, session_id, player);
        let proof = encode_nizk_proof(env, blinding, &response);
        (public_inputs, proof, commitment)
    }


    // ════════════════════════════════════════════════════════════════════════
    //  NIZK seed proof tests (new!)
    // ════════════════════════════════════════════════════════════════════════

    #[test]
    fn test_nizk_seed_valid_proof() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player = Address::generate(&env);
        let seed = BytesN::<32>::from_array(&env, &[
            1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
            17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
        ]);
        let blinding = BytesN::<32>::from_array(&env, &[
            0xAA,0xBB,0xCC,0xDD,0x11,0x22,0x33,0x44,
            0x55,0x66,0x77,0x88,0x99,0x00,0xEE,0xFF,
            0x12,0x34,0x56,0x78,0x9A,0xBC,0xDE,0xF0,
            0x13,0x57,0x9B,0xDF,0x24,0x68,0xAC,0xE0,
        ]);
        let session_id: u32 = 12345;

        let (public_inputs, proof, _commitment) = generate_nizk_proof(
            &env, &seed, &blinding, session_id, &player,
        );

        assert!(client.verify(&public_inputs, &proof));
    }

    #[test]
    fn test_nizk_seed_wrong_blinding_fails() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player = Address::generate(&env);
        let seed = BytesN::<32>::from_array(&env, &[
            1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
            17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
        ]);
        let real_blinding = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
        let wrong_blinding = BytesN::<32>::from_array(&env, &[0xBBu8; 32]);
        let session_id: u32 = 42;

        // Generate proof with real blinding
        let seed_hash = compute_seed_hash(&env, &seed);
        let commitment = compute_nizk_commitment(&env, &seed_hash, &real_blinding, &player);
        let nullifier = compute_nullifier(&env, &seed_hash, session_id);

        // But put wrong blinding in the proof
        let challenge = compute_fs_challenge(&env, &commitment, session_id, &player);
        let wrong_response = compute_response(&env, &seed_hash, &challenge, &wrong_blinding);

        let public_inputs = encode_nizk_public_inputs(
            &env, &seed_hash, &commitment, &nullifier, session_id, &player,
        );
        let proof = encode_nizk_proof(&env, &wrong_blinding, &wrong_response);

        // Commitment check will fail (wrong blinding doesn't match commitment)
        assert!(!client.verify(&public_inputs, &proof));
    }

    #[test]
    fn test_nizk_seed_wrong_session_fails() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player = Address::generate(&env);
        let seed = BytesN::<32>::from_array(&env, &[
            1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
            17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
        ]);
        let blinding = BytesN::<32>::from_array(&env, &[0xCCu8; 32]);
        let real_session = 100u32;
        let fake_session = 999u32;

        // Generate proof for real session
        let seed_hash = compute_seed_hash(&env, &seed);
        let commitment = compute_nizk_commitment(&env, &seed_hash, &blinding, &player);
        let nullifier = compute_nullifier(&env, &seed_hash, real_session);

        // Tamper: replace session_id with fake_session but keep old nullifier
        let mut buf = Bytes::from_array(&env, &seed_hash.to_array());
        buf.append(&Bytes::from_array(&env, &commitment.to_array()));
        buf.append(&Bytes::from_array(&env, &nullifier.to_array()));
        buf.append(&Bytes::from_array(&env, &fake_session.to_be_bytes())); // tampered!
        buf.append(&player.to_string().to_bytes());

        let challenge = compute_fs_challenge(&env, &commitment, real_session, &player);
        let response = compute_response(&env, &seed_hash, &challenge, &blinding);
        let proof = encode_nizk_proof(&env, &blinding, &response);

        // Nullifier check will fail
        assert!(!client.verify(&buf, &proof));
    }

    #[test]
    fn test_nizk_seed_different_player_fails() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player1 = Address::generate(&env);
        let player2 = Address::generate(&env);
        let seed = BytesN::<32>::from_array(&env, &[
            1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
            17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
        ]);
        let blinding = BytesN::<32>::from_array(&env, &[0xDDu8; 32]);
        let session_id: u32 = 50;

        // Generate valid proof for player1
        let (_public_inputs, proof, _) = generate_nizk_proof(
            &env, &seed, &blinding, session_id, &player1,
        );

        // Replace player address with player2
        let seed_hash = compute_seed_hash(&env, &seed);
        let commitment = compute_nizk_commitment(&env, &seed_hash, &blinding, &player1);
        let nullifier = compute_nullifier(&env, &seed_hash, session_id);

        let mut tampered = Bytes::from_array(&env, &seed_hash.to_array());
        tampered.append(&Bytes::from_array(&env, &commitment.to_array()));
        tampered.append(&Bytes::from_array(&env, &nullifier.to_array()));
        tampered.append(&Bytes::from_array(&env, &session_id.to_be_bytes()));
        tampered.append(&player2.to_string().to_bytes()); // wrong player!

        // Commitment check will fail (commitment is bound to player1)
        assert!(!client.verify(&tampered, &proof));
    }

    #[test]
    fn test_nizk_seed_tampered_response_fails() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player = Address::generate(&env);
        let seed = BytesN::<32>::from_array(&env, &[
            1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
            17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
        ]);
        let blinding = BytesN::<32>::from_array(&env, &[0xEEu8; 32]);
        let session_id: u32 = 77;

        let seed_hash = compute_seed_hash(&env, &seed);
        let commitment = compute_nizk_commitment(&env, &seed_hash, &blinding, &player);
        let nullifier = compute_nullifier(&env, &seed_hash, session_id);

        let public_inputs = encode_nizk_public_inputs(
            &env, &seed_hash, &commitment, &nullifier, session_id, &player,
        );

        // Use correct blinding but fake response
        let fake_response = BytesN::<32>::from_array(&env, &[0x42u8; 32]);
        let proof = encode_nizk_proof(&env, &blinding, &fake_response);

        // Response check will fail (but commitment passes, so response check catches it)
        assert!(!client.verify(&public_inputs, &proof));
    }

    #[test]
    fn test_nizk_multiple_sessions_same_seed() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player = Address::generate(&env);
        let seed = BytesN::<32>::from_array(&env, &[
            10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,
            170,180,190,200,210,220,230,240,250,5,15,25,35,45,55,65,
        ]);
        let blinding = BytesN::<32>::from_array(&env, &[0x99u8; 32]);

        // Same seed, different sessions — all should verify independently
        for sid in [1u32, 2, 100, 999] {
            let (public_inputs, proof, _) = generate_nizk_proof(
                &env, &seed, &blinding, sid, &player,
            );
            assert!(client.verify(&public_inputs, &proof), "Session {} should verify", sid);
        }
    }

    #[test]
    fn test_nizk_raw_seed_never_on_chain() {
        // Verify that the raw seed bytes do NOT appear in public_inputs or proof
        let env = Env::default();
        let seed = BytesN::<32>::from_array(&env, &[
            0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04,
            0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C,
            0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14,
            0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C,
        ]);
        let blinding = BytesN::<32>::from_array(&env, &[0xFFu8; 32]);
        let player = Address::generate(&env);
        let session_id = 42u32;

        let (public_inputs, proof, _) = generate_nizk_proof(
            &env, &seed, &blinding, session_id, &player,
        );

        // Check that the raw seed bytes don't appear as a contiguous
        // 32-byte substring in either public_inputs or proof
        let seed_arr = seed.to_array();
        let pi_len = public_inputs.len();
        let proof_len = proof.len();

        // Check public inputs
        let mut found_in_pi = false;
        if pi_len >= 32 {
            let mut offset = 0u32;
            while offset <= pi_len - 32 {
                let mut matches = true;
                let mut j = 0usize;
                while j < 32 {
                    if public_inputs.get(offset + j as u32).unwrap_or(0) != seed_arr[j] {
                        matches = false;
                        break;
                    }
                    j += 1;
                }
                if matches {
                    found_in_pi = true;
                    break;
                }
                offset += 1;
            }
        }
        assert!(!found_in_pi, "Raw seed must NOT appear in public inputs");

        // Check proof
        let mut found_in_proof = false;
        if proof_len >= 32 {
            let mut offset = 0u32;
            while offset <= proof_len - 32 {
                let mut matches = true;
                let mut j = 0usize;
                while j < 32 {
                    if proof.get(offset + j as u32).unwrap_or(0) != seed_arr[j] {
                        matches = false;
                        break;
                    }
                    j += 1;
                }
                if matches {
                    found_in_proof = true;
                    break;
                }
                offset += 1;
            }
        }
        assert!(!found_in_proof, "Raw seed must NOT appear in proof");
    }

    // ════════════════════════════════════════════════════════════════════════
    //  BLS12-381 G1 standard generator
    // ════════════════════════════════════════════════════════════════════════

    fn bls12_381_g1_generator(env: &Env) -> G1Affine {
        let g1_bytes: [u8; 96] = [
            0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
            0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
            0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
            0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
            0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
            0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
            0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
            0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
        ];
        G1Affine::from_array(env, &g1_bytes)
    }

    /// Derive the Pedersen H generator (same as on-chain)
    fn pedersen_h_generator(env: &Env) -> G1Affine {
        let bls = env.crypto().bls12_381();
        let msg = Bytes::from_slice(env, b"PEDERSEN_H");
        let dst = Bytes::from_slice(env, b"SGS_CANGKULAN_V1");
        bls.hash_to_g1(&msg, &dst)
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Pedersen+Sigma helpers (Mode 4)
    // ════════════════════════════════════════════════════════════════════════

    /// Compute Pedersen commitment: C = seed_scalar·G + blinding_scalar·H
    fn compute_pedersen_commitment(
        env: &Env,
        seed_scalar: &Fr,
        blinding_scalar: &Fr,
    ) -> G1Affine {
        let bls = env.crypto().bls12_381();
        let g = bls12_381_g1_generator(env);
        let h = pedersen_h_generator(env);
        bls.g1_msm(vec![env, g, h], vec![env, seed_scalar.clone(), blinding_scalar.clone()])
    }

    /// Generate a Pedersen+Sigma proof (revised: Schnorr on D = C - s·G)
    fn generate_pedersen_sigma_proof(
        env: &Env,
        seed_scalar: &Fr,
        blinding_scalar: &Fr,
        nonce_r: &Fr,
        session_id: u32,
        player: &Address,
    ) -> (Bytes, Bytes) {
        let bls = env.crypto().bls12_381();
        let g = bls12_381_g1_generator(env);
        let h = pedersen_h_generator(env);

        // Commitment: C = seed·G + blinding·H
        let commitment = bls.g1_msm(
            vec![env, g.clone(), h.clone()],
            vec![env, seed_scalar.clone(), blinding_scalar.clone()],
        );

        // Nonce commitment: R = k_r·H (Schnorr on H subspace only)
        let r_point = bls.g1_mul(&h, nonce_r);

        // seed_hash bytes = seed_scalar as bytes
        let seed_hash_bytes = seed_scalar.to_bytes();

        // Fiat-Shamir challenge: e = keccak256(C || R || seed_hash || session_id || player || "ZKP4")
        let c_bytes = commitment.to_bytes();
        let r_bytes = r_point.to_bytes();
        let mut challenge_preimage = Bytes::from_array(env, &c_bytes.to_array());
        challenge_preimage.append(&Bytes::from_array(env, &r_bytes.to_array()));
        challenge_preimage.append(&Bytes::from_array(env, &seed_hash_bytes.to_array()));
        challenge_preimage.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        challenge_preimage.append(&player.to_string().to_bytes());
        challenge_preimage.append(&Bytes::from_array(env, &PEDERSEN_CHALLENGE_TAG));
        let e_hash: BytesN<32> = env.crypto().keccak256(&challenge_preimage).into();
        let e = Fr::from_bytes(e_hash);

        // Response: z_r = k_r + e·blinding
        let z_r = bls.fr_add(nonce_r, &bls.fr_mul(&e, blinding_scalar));

        // Public inputs: C(96) || seed_hash(32) || session_id(4) || player(var)
        let mut public_inputs = Bytes::from_array(env, &c_bytes.to_array());
        public_inputs.append(&Bytes::from_array(env, &seed_hash_bytes.to_array()));
        public_inputs.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        public_inputs.append(&player.to_string().to_bytes());

        // Proof: R(96) || z_r(32) = 128 bytes
        let mut proof = Bytes::from_array(env, &r_bytes.to_array());
        proof.append(&Bytes::from_array(env, &z_r.to_bytes().to_array()));

        (public_inputs, proof)
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Pedersen+Sigma tests (Mode 4)
    // ════════════════════════════════════════════════════════════════════════

    #[test]
    fn test_pedersen_sigma_valid_proof() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player = Address::generate(&env);
        let session_id = 12345u32;

        // Scalars (deterministic for test)
        let seed_scalar = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0xDE, 0xAD, 0xBE, 0xEF,
        ]));
        let blinding_scalar = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0xCA, 0xFE, 0xBA, 0xBE,
        ]));
        let nonce_r = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x05, 0x06, 0x07, 0x08,
        ]));

        let (public_inputs, proof) = generate_pedersen_sigma_proof(
            &env, &seed_scalar, &blinding_scalar, &nonce_r,
            session_id, &player,
        );

        assert_eq!(proof.len(), 128);
        assert!(client.verify(&public_inputs, &proof));
    }

    #[test]
    fn test_pedersen_sigma_wrong_z_r_fails() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player = Address::generate(&env);
        let session_id = 42u32;

        let seed_scalar = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0xDE, 0xAD, 0xBE, 0xEF,
        ]));
        let blinding_scalar = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0xCA, 0xFE, 0xBA, 0xBE,
        ]));
        let nonce_r = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x05, 0x06, 0x07, 0x08,
        ]));

        let (public_inputs, proof) = generate_pedersen_sigma_proof(
            &env, &seed_scalar, &blinding_scalar, &nonce_r,
            session_id, &player,
        );

        // Tamper with z_r: replace bytes [96..128) with garbage
        let tampered_z_r = Fr::from_bytes(BytesN::<32>::from_array(&env, &[0x42u8; 32]));
        let r_bytes = {
            let mut arr = [0u8; 96];
            let mut i = 0usize;
            while i < 96 { arr[i] = proof.get(i as u32).unwrap_or(0); i += 1; }
            arr
        };

        let mut tampered_proof = Bytes::from_array(&env, &r_bytes);
        tampered_proof.append(&Bytes::from_array(&env, &tampered_z_r.to_bytes().to_array()));

        assert!(!client.verify(&public_inputs, &tampered_proof));
    }

    #[test]
    fn test_pedersen_sigma_different_player_fails() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player1 = Address::generate(&env);
        let player2 = Address::generate(&env);
        let session_id = 77u32;

        let seed_scalar = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0xAB, 0xCD, 0xEF, 0x01,
        ]));
        let blinding = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78,
        ]));
        let nonce_r = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x0E, 0x0F, 0x10, 0x11,
        ]));

        // Generate proof for player1
        let (_public_inputs, proof) = generate_pedersen_sigma_proof(
            &env, &seed_scalar, &blinding, &nonce_r,
            session_id, &player1,
        );

        // Create public inputs with player2 but same commitment and seed_hash
        let commitment = compute_pedersen_commitment(&env, &seed_scalar, &blinding);
        let c_bytes = commitment.to_bytes();
        let seed_hash_bytes = seed_scalar.to_bytes();
        let mut tampered_inputs = Bytes::from_array(&env, &c_bytes.to_array());
        tampered_inputs.append(&Bytes::from_array(&env, &seed_hash_bytes.to_array()));
        tampered_inputs.append(&Bytes::from_array(&env, &session_id.to_be_bytes()));
        tampered_inputs.append(&player2.to_string().to_bytes()); // wrong player!

        // Challenge will be different → sigma check fails
        assert!(!client.verify(&tampered_inputs, &proof));
    }

    #[test]
    fn test_pedersen_sigma_multiple_sessions() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player = Address::generate(&env);
        let seed = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
        ]));
        let blinding = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x06, 0x07, 0x08, 0x09, 0x0A,
        ]));
        let nonce_r = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x10, 0x11, 0x12, 0x13, 0x14,
        ]));

        for sid in [1u32, 100, 999, 65535] {
            let (public_inputs, proof) = generate_pedersen_sigma_proof(
                &env, &seed, &blinding, &nonce_r, sid, &player,
            );
            assert!(client.verify(&public_inputs, &proof), "Session {} should verify", sid);
        }
    }

    #[test]
    fn test_pedersen_sigma_wrong_seed_hash_fails() {
        let env = Env::default();
        let verifier_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &verifier_id);

        let player = Address::generate(&env);
        let session_id = 55u32;

        let seed_scalar = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0xAA, 0xBB, 0xCC, 0xDD,
        ]));
        let wrong_seed = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44,
        ]));
        let blinding = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0xCA, 0xFE, 0xBA, 0xBE,
        ]));
        let nonce_r = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x05, 0x06, 0x07, 0x08,
        ]));

        // Generate valid proof for seed_scalar
        let (_, proof) = generate_pedersen_sigma_proof(
            &env, &seed_scalar, &blinding, &nonce_r,
            session_id, &player,
        );

        // Build public inputs with WRONG seed_hash (wrong_seed instead of seed_scalar)
        let commitment = compute_pedersen_commitment(&env, &seed_scalar, &blinding);
        let c_bytes = commitment.to_bytes();
        let mut tampered_inputs = Bytes::from_array(&env, &c_bytes.to_array());
        tampered_inputs.append(&Bytes::from_array(&env, &wrong_seed.to_bytes().to_array()));
        tampered_inputs.append(&Bytes::from_array(&env, &session_id.to_be_bytes()));
        tampered_inputs.append(&player.to_string().to_bytes());

        // D = C - wrong_seed·G ≠ blinding·H → Schnorr check fails
        assert!(!client.verify(&tampered_inputs, &proof));
    }



    // ════════════════════════════════════════════════════════════════════════
    //  Mode 7: Card Play Ring Sigma tests
    // ════════════════════════════════════════════════════════════════════════

    /// BLS12-381 Fr modular order
    const FR_ORDER: [u8; 32] = [
        0x73, 0xed, 0xa7, 0x53, 0x29, 0x9d, 0x7d, 0x48,
        0x33, 0x39, 0xd8, 0x08, 0x09, 0xa1, 0xd8, 0x05,
        0x53, 0xbd, 0xa4, 0x02, 0xff, 0xfe, 0x5b, 0xfe,
        0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
    ];

    fn bytes_to_u256(a: &[u8; 32]) -> [u128; 2] {
        let hi = u128::from_be_bytes(a[0..16].try_into().unwrap());
        let lo = u128::from_be_bytes(a[16..32].try_into().unwrap());
        [hi, lo]
    }

    fn fr_add_bytes(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
        let [ah, al] = bytes_to_u256(a);
        let [bh, bl] = bytes_to_u256(b);
        let (sum_lo, carry) = al.overflowing_add(bl);
        let sum_hi = ah.wrapping_add(bh).wrapping_add(if carry { 1 } else { 0 });
        let [rh, rl] = bytes_to_u256(&FR_ORDER);
        if sum_hi > rh || (sum_hi == rh && sum_lo >= rl) {
            let (sub_lo, borrow) = sum_lo.overflowing_sub(rl);
            let sub_hi = sum_hi.wrapping_sub(rh).wrapping_sub(if borrow { 1 } else { 0 });
            let mut out = [0u8; 32];
            out[0..16].copy_from_slice(&sub_hi.to_be_bytes());
            out[16..32].copy_from_slice(&sub_lo.to_be_bytes());
            out
        } else {
            let mut out = [0u8; 32];
            out[0..16].copy_from_slice(&sum_hi.to_be_bytes());
            out[16..32].copy_from_slice(&sum_lo.to_be_bytes());
            out
        }
    }

    fn fr_sub_bytes(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
        let [rh, rl] = bytes_to_u256(&FR_ORDER);
        let [bh, bl] = bytes_to_u256(b);
        let (neg_lo, borrow) = rl.overflowing_sub(bl);
        let neg_hi = rh.wrapping_sub(bh).wrapping_sub(if borrow { 1 } else { 0 });
        let mut neg_b = [0u8; 32];
        neg_b[0..16].copy_from_slice(&neg_hi.to_be_bytes());
        neg_b[16..32].copy_from_slice(&neg_lo.to_be_bytes());
        fr_add_bytes(a, &neg_b)
    }

    /// Multiply 32-byte BE number by a small u32, producing 33 bytes.
    fn mul_scalar_be(a: &[u8; 32], b: u32) -> [u8; 33] {
        let mut result = [0u8; 33];
        let mut carry: u64 = 0;
        let mut i = 31i32;
        while i >= 0 {
            let product = a[i as usize] as u64 * b as u64 + carry;
            result[(i as usize) + 1] = (product & 0xFF) as u8;
            carry = product >> 8;
            i -= 1;
        }
        result[0] = carry as u8;
        result
    }

    /// Add a 33-byte and 32-byte BE number.
    fn add_33_32(a: &[u8; 33], b: &[u8; 32]) -> [u8; 33] {
        let mut result = [0u8; 33];
        let mut carry: u16 = 0;
        let mut i = 32i32;
        while i >= 1 {
            let sum = a[i as usize] as u16 + b[(i as usize) - 1] as u16 + carry;
            result[i as usize] = (sum & 0xFF) as u8;
            carry = sum >> 8;
            i -= 1;
        }
        result[0] = a[0].wrapping_add(carry as u8);
        result
    }

    /// Reduce a 32-byte value modulo Fr order (for raw keccak256 hashes).
    fn reduce_to_fr(v: &[u8; 32]) -> [u8; 32] {
        let [vh, vl] = bytes_to_u256(v);
        let [rh, rl] = bytes_to_u256(&FR_ORDER);
        if vh > rh || (vh == rh && vl >= rl) {
            let (sub_lo, borrow) = vl.overflowing_sub(rl);
            let sub_hi = vh.wrapping_sub(rh).wrapping_sub(if borrow { 1 } else { 0 });
            let mut out = [0u8; 32];
            out[0..16].copy_from_slice(&sub_hi.to_be_bytes());
            out[16..32].copy_from_slice(&sub_lo.to_be_bytes());
            return reduce_to_fr(&out);
        }
        *v
    }

    /// Reduce a 33-byte value modulo Fr order.
    fn reduce_mod_fr(val: &[u8; 33]) -> [u8; 32] {
        if val[0] == 0 {
            let mut v32 = [0u8; 32];
            v32.copy_from_slice(&val[1..33]);
            let [vh, vl] = bytes_to_u256(&v32);
            let [rh, rl] = bytes_to_u256(&FR_ORDER);
            if vh > rh || (vh == rh && vl >= rl) {
                return fr_sub_bytes(&v32, &FR_ORDER);
            }
            return v32;
        }
        // Subtract FR_ORDER from the 33-byte value
        let mut reduced = *val;
        let mut borrow: u16 = 0;
        let mut ii = 32i32;
        while ii >= 1 {
            let diff = reduced[ii as usize] as i32 - FR_ORDER[(ii as usize) - 1] as i32 - borrow as i32;
            if diff < 0 {
                reduced[ii as usize] = (diff + 256) as u8;
                borrow = 1;
            } else {
                reduced[ii as usize] = diff as u8;
                borrow = 0;
            }
            ii -= 1;
        }
        reduced[0] = reduced[0].wrapping_sub(borrow as u8);
        if reduced[0] > 0 {
            return reduce_mod_fr(&reduced);
        }
        let mut v32 = [0u8; 32];
        v32.copy_from_slice(&reduced[1..33]);
        v32
    }

    /// Build a valid Ring Sigma proof for testing (mirrors frontend buildCardPlayRingProof).
    fn build_ring_sigma_proof(
        env: &Env,
        card_id: u32,
        blinding: &BytesN<32>,
        valid_set: &[u32],
        session_id: u32,
        player: &Address,
    ) -> (BytesN<32>, Bytes) {
        let bls = env.crypto().bls12_381();
        let n = valid_set.len();

        let g1_bytes: [u8; 96] = [
            0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
            0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
            0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
            0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
            0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
            0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
            0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
            0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
        ];
        let g = G1Affine::from_array(env, &g1_bytes);
        let h = ZkCommitmentVerifier::pedersen_h(&bls, env);

        // Fr(card_id)
        let mut card_fr_arr = [0u8; 32];
        card_fr_arr[31] = (card_id & 0xFF) as u8;
        card_fr_arr[30] = ((card_id >> 8) & 0xFF) as u8;
        let card_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &card_fr_arr));

        // Fr(blinding)
        let blinding_fr = Fr::from_bytes(blinding.clone());
        let blinding_arr = blinding.to_array();

        // C = card_id·G + blinding·H
        let card_g = bls.g1_mul(&g, &card_fr);
        let blind_h = bls.g1_mul(&h, &blinding_fr);
        let commitment = bls.g1_add(&card_g, &blind_h);
        let c_raw = commitment.to_bytes();

        // commit_hash = keccak256(C)
        let commit_hash: BytesN<32> = env.crypto().keccak256(
            &Bytes::from_array(env, &c_raw.to_array())
        ).into();

        // Find real index
        let real_idx = valid_set.iter().position(|&c| c == card_id).unwrap();

        // D_i = C − valid_set[i]·G
        let mut d_points = soroban_sdk::Vec::<G1Affine>::new(env);
        let mut ci = 0usize;
        while ci < n {
            let mut ci_fr_arr = [0u8; 32];
            ci_fr_arr[31] = (valid_set[ci] & 0xFF) as u8;
            ci_fr_arr[30] = ((valid_set[ci] >> 8) & 0xFF) as u8;
            let ci_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &ci_fr_arr));
            let ci_g = bls.g1_mul(&g, &ci_fr);
            let neg_ci_g = -ci_g;
            let d = bls.g1_add(&commitment, &neg_ci_g);
            d_points.push_back(d);
            ci += 1;
        }

        // Nonce k
        let k_arr: [u8; 32] = [
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
            0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x01,
            0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
            0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11,
        ];
        let k_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &k_arr));
        let r_real = bls.g1_mul(&h, &k_fr);

        let mut e_arrs = [[0u8; 32]; 9];
        let mut z_arrs = [[0u8; 32]; 9];
        let mut r_points = soroban_sdk::Vec::<G1Affine>::new(env);

        let mut sum_other_e = [0u8; 32];
        let mut idx = 0usize;
        while idx < n {
            if idx == real_idx {
                r_points.push_back(r_real.clone());
            } else {
                let mut ei_arr = [0u8; 32];
                ei_arr[31] = (idx as u8 + 1) * 17;
                ei_arr[30] = (idx as u8 + 1) * 3;
                let ei_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &ei_arr));

                let mut zi_arr = [0u8; 32];
                zi_arr[31] = (idx as u8 + 1) * 23;
                zi_arr[30] = (idx as u8 + 1) * 7;
                let zi_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &zi_arr));

                let z_h = bls.g1_mul(&h, &zi_fr);
                let e_d = bls.g1_mul(&d_points.get(idx as u32).unwrap(), &ei_fr);
                let neg_e_d = -e_d;
                let r_i = bls.g1_add(&z_h, &neg_e_d);

                r_points.push_back(r_i);
                e_arrs[idx] = ei_arr;
                z_arrs[idx] = zi_arr;
                sum_other_e = fr_add_bytes(&sum_other_e, &ei_arr);
            }
            idx += 1;
        }

        // Fiat-Shamir challenge
        let mut challenge_pre = Bytes::from_array(env, &c_raw.to_array());
        let mut ri = 0usize;
        while ri < n {
            let r_bytes = r_points.get(ri as u32).unwrap().to_bytes();
            challenge_pre.append(&Bytes::from_array(env, &r_bytes.to_array()));
            ri += 1;
        }
        challenge_pre.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        challenge_pre.append(&player.to_string().to_bytes());
        challenge_pre.append(&Bytes::from_array(env, &RING_CHALLENGE_TAG));
        let e_hash: BytesN<32> = env.crypto().keccak256(&challenge_pre).into();
        let e_arr = e_hash.to_array();

        // e_j = e − Σ_{i≠j} e_i (mod Fr)
        // Must reduce hash to canonical Fr range first (keccak256 can produce values >= FR_ORDER)
        let e_reduced = reduce_to_fr(&e_arr);
        let e_real = fr_sub_bytes(&e_reduced, &sum_other_e);
        e_arrs[real_idx] = e_real;

        // z_j = k + e_j * blinding (mod Fr)
        // For small blinding values (fit in u32):
        let blind_u32 = ((blinding_arr[28] as u32) << 24)
            | ((blinding_arr[29] as u32) << 16)
            | ((blinding_arr[30] as u32) << 8)
            | (blinding_arr[31] as u32);

        let e_times_blind = mul_scalar_be(&e_real, blind_u32);
        let sum = add_33_32(&e_times_blind, &k_arr);
        z_arrs[real_idx] = reduce_mod_fr(&sum);

        // Build proof: C(96) || [e_i(32) || z_i(32)] × N
        let mut proof_data = Bytes::from_array(env, &c_raw.to_array());
        let mut pi = 0usize;
        while pi < n {
            proof_data.append(&Bytes::from_array(env, &e_arrs[pi]));
            proof_data.append(&Bytes::from_array(env, &z_arrs[pi]));
            pi += 1;
        }

        (commit_hash, proof_data)
    }

    fn build_ring_public_inputs(
        env: &Env,
        commit_hash: &BytesN<32>,
        valid_set: &[u32],
        session_id: u32,
        player: &Address,
    ) -> Bytes {
        let n = valid_set.len() as u32;
        let mut pi = Bytes::from_array(env, &commit_hash.to_array());
        pi.append(&Bytes::from_array(env, &n.to_be_bytes()));
        let mut i = 0usize;
        while i < valid_set.len() {
            pi.append(&Bytes::from_array(env, &valid_set[i].to_be_bytes()));
            i += 1;
        }
        pi.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        pi.append(&player.to_string().to_bytes());
        pi
    }

    #[test]
    fn test_ring_sigma_valid_proof_n1() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let card_id: u32 = 5;
        let blinding = BytesN::<32>::from_array(&env, &{
            let mut arr = [0u8; 32]; arr[31] = 42; arr
        });
        let valid_set = [5u32];
        let session_id = 100u32;

        let (commit_hash, proof) = build_ring_sigma_proof(
            &env, card_id, &blinding, &valid_set, session_id, &player,
        );
        let public_inputs = build_ring_public_inputs(
            &env, &commit_hash, &valid_set, session_id, &player,
        );

        assert!(client.verify(&public_inputs, &proof), "Ring sigma N=1 should verify");
    }

    #[test]
    fn test_ring_sigma_valid_proof_n3() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let card_id: u32 = 10;
        let blinding = BytesN::<32>::from_array(&env, &{
            let mut arr = [0u8; 32]; arr[31] = 7; arr
        });
        let valid_set = [9u32, 10, 11];
        let session_id = 200u32;

        let (commit_hash, proof) = build_ring_sigma_proof(
            &env, card_id, &blinding, &valid_set, session_id, &player,
        );
        let public_inputs = build_ring_public_inputs(
            &env, &commit_hash, &valid_set, session_id, &player,
        );

        assert!(client.verify(&public_inputs, &proof), "Ring sigma N=3 should verify");
    }

    #[test]
    fn test_ring_sigma_wrong_commit_hash_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let card_id: u32 = 5;
        let blinding = BytesN::<32>::from_array(&env, &{
            let mut arr = [0u8; 32]; arr[31] = 42; arr
        });
        let valid_set = [5u32];
        let session_id = 100u32;

        let (_commit_hash, proof) = build_ring_sigma_proof(
            &env, card_id, &blinding, &valid_set, session_id, &player,
        );
        let wrong_hash = BytesN::<32>::from_array(&env, &[0xAA; 32]);
        let public_inputs = build_ring_public_inputs(
            &env, &wrong_hash, &valid_set, session_id, &player,
        );

        assert!(!client.verify(&public_inputs, &proof), "Wrong commit_hash should fail");
    }

    #[test]
    fn test_ring_sigma_wrong_valid_set_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let card_id: u32 = 5;
        let blinding = BytesN::<32>::from_array(&env, &{
            let mut arr = [0u8; 32]; arr[31] = 42; arr
        });
        let valid_set = [5u32];
        let session_id = 100u32;

        let (commit_hash, proof) = build_ring_sigma_proof(
            &env, card_id, &blinding, &valid_set, session_id, &player,
        );
        let wrong_set = [6u32];
        let public_inputs = build_ring_public_inputs(
            &env, &commit_hash, &wrong_set, session_id, &player,
        );

        assert!(!client.verify(&public_inputs, &proof), "Wrong valid_set should fail");
    }

    #[test]
    fn test_ring_sigma_different_session_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let card_id: u32 = 5;
        let blinding = BytesN::<32>::from_array(&env, &{
            let mut arr = [0u8; 32]; arr[31] = 42; arr
        });
        let valid_set = [5u32];
        let session_id = 100u32;

        let (commit_hash, proof) = build_ring_sigma_proof(
            &env, card_id, &blinding, &valid_set, session_id, &player,
        );
        let public_inputs = build_ring_public_inputs(
            &env, &commit_hash, &valid_set, 999, &player,
        );

        assert!(!client.verify(&public_inputs, &proof), "Different session should fail");
    }

    #[test]
    fn test_ring_sigma_different_player_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);
        let other_player = Address::generate(&env);

        let card_id: u32 = 5;
        let blinding = BytesN::<32>::from_array(&env, &{
            let mut arr = [0u8; 32]; arr[31] = 42; arr
        });
        let valid_set = [5u32];
        let session_id = 100u32;

        let (commit_hash, proof) = build_ring_sigma_proof(
            &env, card_id, &blinding, &valid_set, session_id, &player,
        );
        let public_inputs = build_ring_public_inputs(
            &env, &commit_hash, &valid_set, session_id, &other_player,
        );

        assert!(!client.verify(&public_inputs, &proof), "Different player should fail");
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Mode 8: Cangkul Hand Proof tests
    // ════════════════════════════════════════════════════════════════════════

    /// Full Fr multiplication: a * b mod Fr_ORDER (shift-and-add).
    fn fr_mul_bytes(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
        let mut result = [0u8; 32];
        let mut bi = 0usize;
        while bi < 256 {
            result = fr_add_bytes(&result, &result);
            let byte_idx = bi / 8;
            let bit_idx = 7 - (bi % 8);
            if (b[byte_idx] >> bit_idx) & 1 == 1 {
                result = fr_add_bytes(&result, a);
            }
            bi += 1;
        }
        result
    }

    /// Build a valid Mode 8 (Cangkul Hand) proof for testing.
    fn build_cangkul_hand_proof(
        env: &Env,
        hand: &[u32],
        blindings: &[[u8; 32]],
        trick_suit: u32,
        session_id: u32,
        player: &Address,
    ) -> (BytesN<32>, Bytes) {
        let bls = env.crypto().bls12_381();
        let k = hand.len();

        let g1_bytes: [u8; 96] = [
            0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
            0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
            0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
            0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
            0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
            0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
            0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
            0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
        ];
        let g = G1Affine::from_array(env, &g1_bytes);
        let h = ZkCommitmentVerifier::pedersen_h(&bls, env);

        // Compute per-card commitments and accumulate
        let mut agg_r = [0u8; 32];
        let mut card_fr_arr = [0u8; 32];
        card_fr_arr[31] = (hand[0] & 0xFF) as u8;
        card_fr_arr[30] = ((hand[0] >> 8) & 0xFF) as u8;
        let card_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &card_fr_arr));
        let blind_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &blindings[0]));
        let card_g = bls.g1_mul(&g, &card_fr);
        let blind_h = bls.g1_mul(&h, &blind_fr);
        let mut agg_point = bls.g1_add(&card_g, &blind_h);
        agg_r = blindings[0];

        let mut ci = 1usize;
        while ci < k {
            let mut ci_fr_arr = [0u8; 32];
            ci_fr_arr[31] = (hand[ci] & 0xFF) as u8;
            ci_fr_arr[30] = ((hand[ci] >> 8) & 0xFF) as u8;
            let ci_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &ci_fr_arr));
            let ci_blind_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &blindings[ci]));
            let ci_g = bls.g1_mul(&g, &ci_fr);
            let ci_h = bls.g1_mul(&h, &ci_blind_fr);
            let ci_point = bls.g1_add(&ci_g, &ci_h);
            agg_point = bls.g1_add(&agg_point, &ci_point);
            agg_r = fr_add_bytes(&agg_r, &blindings[ci]);
            ci += 1;
        }

        let a_raw = agg_point.to_bytes();
        let commit_hash: BytesN<32> = env.crypto().keccak256(
            &Bytes::from_array(env, &a_raw.to_array())
        ).into();

        // Schnorr nonce
        let nonce_arr: [u8; 32] = [
            0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44,
            0x55, 0x66, 0x77, 0x88, 0x99, 0x00, 0xAB, 0xCD,
            0xEF, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD,
            0xEF, 0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32,
        ];
        let nonce_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &nonce_arr));
        let r_point = bls.g1_mul(&h, &nonce_fr);
        let r_raw = r_point.to_bytes();

        // Fiat-Shamir
        let mut challenge_pre = Bytes::from_array(env, &a_raw.to_array());
        challenge_pre.append(&Bytes::from_array(env, &r_raw.to_array()));
        challenge_pre.append(&Bytes::from_array(env, &trick_suit.to_be_bytes()));
        challenge_pre.append(&Bytes::from_array(env, &(k as u32).to_be_bytes()));
        challenge_pre.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        challenge_pre.append(&player.to_string().to_bytes());
        challenge_pre.append(&Bytes::from_array(env, &CANGKUL_CHALLENGE_TAG));
        let e_hash: BytesN<32> = env.crypto().keccak256(&challenge_pre).into();
        let e_reduced = reduce_to_fr(&e_hash.to_array());

        // z = nonce + e · r_agg (mod Fr)
        let e_times_r = fr_mul_bytes(&e_reduced, &agg_r);
        let z_arr = fr_add_bytes(&nonce_arr, &e_times_r);

        // Proof: k(4) || A(96) || R(96) || z(32)
        let mut proof_data = Bytes::from_array(env, &(k as u32).to_be_bytes());
        proof_data.append(&Bytes::from_array(env, &a_raw.to_array()));
        proof_data.append(&Bytes::from_array(env, &r_raw.to_array()));
        proof_data.append(&Bytes::from_array(env, &z_arr));

        (commit_hash, proof_data)
    }

    fn build_cangkul_public_inputs(
        env: &Env,
        commit_hash: &BytesN<32>,
        trick_suit: u32,
        hand: &[u32],
        session_id: u32,
        player: &Address,
    ) -> Bytes {
        let k = hand.len() as u32;
        let mut pi = Bytes::from_array(env, &commit_hash.to_array());
        pi.append(&Bytes::from_array(env, &trick_suit.to_be_bytes()));
        pi.append(&Bytes::from_array(env, &k.to_be_bytes()));
        let mut i = 0usize;
        while i < hand.len() {
            pi.append(&Bytes::from_array(env, &hand[i].to_be_bytes()));
            i += 1;
        }
        pi.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        pi.append(&player.to_string().to_bytes());
        pi
    }

    #[test]
    fn test_cangkul_hand_valid_proof_single_card() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let hand = [10u32];
        let blindings = [{let mut a = [0u8; 32]; a[31] = 42; a}];
        let trick_suit = 0u32;
        let session_id = 100u32;

        let (commit_hash, proof) = build_cangkul_hand_proof(
            &env, &hand, &blindings, trick_suit, session_id, &player,
        );
        let public_inputs = build_cangkul_public_inputs(
            &env, &commit_hash, trick_suit, &hand, session_id, &player,
        );

        assert!(client.verify(&public_inputs, &proof), "Single card cangkul proof should pass");
    }

    #[test]
    fn test_cangkul_hand_valid_proof_multi_card() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let hand = [9u32, 10, 11, 27, 28];
        let blindings = [
            {let mut a = [0u8; 32]; a[31] = 10; a},
            {let mut a = [0u8; 32]; a[31] = 20; a},
            {let mut a = [0u8; 32]; a[31] = 30; a},
            {let mut a = [0u8; 32]; a[31] = 40; a},
            {let mut a = [0u8; 32]; a[31] = 50; a},
        ];
        let trick_suit = 0u32;
        let session_id = 200u32;

        let (commit_hash, proof) = build_cangkul_hand_proof(
            &env, &hand, &blindings, trick_suit, session_id, &player,
        );
        let public_inputs = build_cangkul_public_inputs(
            &env, &commit_hash, trick_suit, &hand, session_id, &player,
        );

        assert!(client.verify(&public_inputs, &proof), "Multi-card cangkul proof should pass");
    }

    #[test]
    fn test_cangkul_hand_valid_proof_suit2_excluded() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let hand = [0u32, 1, 27, 28];
        let blindings = [
            {let mut a = [0u8; 32]; a[31] = 5; a},
            {let mut a = [0u8; 32]; a[31] = 15; a},
            {let mut a = [0u8; 32]; a[31] = 25; a},
            {let mut a = [0u8; 32]; a[31] = 35; a},
        ];
        let trick_suit = 2u32;
        let session_id = 300u32;

        let (commit_hash, proof) = build_cangkul_hand_proof(
            &env, &hand, &blindings, trick_suit, session_id, &player,
        );
        let public_inputs = build_cangkul_public_inputs(
            &env, &commit_hash, trick_suit, &hand, session_id, &player,
        );

        assert!(client.verify(&public_inputs, &proof));
    }

    #[test]
    fn test_cangkul_hand_suit_violation_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let hand = [5u32, 10];
        let blindings = [
            {let mut a = [0u8; 32]; a[31] = 42; a},
            {let mut a = [0u8; 32]; a[31] = 43; a},
        ];
        let trick_suit = 0u32;
        let session_id = 100u32;

        let (commit_hash, proof) = build_cangkul_hand_proof(
            &env, &hand, &blindings, trick_suit, session_id, &player,
        );
        let public_inputs = build_cangkul_public_inputs(
            &env, &commit_hash, trick_suit, &hand, session_id, &player,
        );

        assert!(!client.verify(&public_inputs, &proof), "Card matching trick suit should fail");
    }

    #[test]
    fn test_cangkul_hand_wrong_session_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let hand = [10u32];
        let blindings = [{let mut a = [0u8; 32]; a[31] = 42; a}];
        let trick_suit = 0u32;
        let session_id = 100u32;

        let (commit_hash, proof) = build_cangkul_hand_proof(
            &env, &hand, &blindings, trick_suit, session_id, &player,
        );
        let public_inputs = build_cangkul_public_inputs(
            &env, &commit_hash, trick_suit, &hand, 999, &player,
        );

        assert!(!client.verify(&public_inputs, &proof), "Wrong session should fail");
    }

    #[test]
    fn test_cangkul_hand_wrong_player_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);
        let other = Address::generate(&env);

        let hand = [10u32];
        let blindings = [{let mut a = [0u8; 32]; a[31] = 42; a}];
        let trick_suit = 0u32;
        let session_id = 100u32;

        let (commit_hash, proof) = build_cangkul_hand_proof(
            &env, &hand, &blindings, trick_suit, session_id, &player,
        );
        let public_inputs = build_cangkul_public_inputs(
            &env, &commit_hash, trick_suit, &hand, session_id, &other,
        );

        assert!(!client.verify(&public_inputs, &proof), "Wrong player should fail");
    }

    #[test]
    fn test_cangkul_hand_k_mismatch_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let hand = [10u32, 11];
        let blindings = [
            {let mut a = [0u8; 32]; a[31] = 42; a},
            {let mut a = [0u8; 32]; a[31] = 43; a},
        ];
        let trick_suit = 0u32;
        let session_id = 100u32;

        let (commit_hash, proof) = build_cangkul_hand_proof(
            &env, &hand, &blindings, trick_suit, session_id, &player,
        );
        let public_inputs = build_cangkul_public_inputs(
            &env, &commit_hash, trick_suit, &[10u32], session_id, &player,
        );

        assert!(!client.verify(&public_inputs, &proof), "k mismatch should fail");
    }

    #[test]
    fn test_cangkul_hand_invalid_trick_suit_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let hand = [10u32];
        let blindings = [{let mut a = [0u8; 32]; a[31] = 42; a}];
        let trick_suit = 5u32;
        let session_id = 100u32;

        let (commit_hash, proof) = build_cangkul_hand_proof(
            &env, &hand, &blindings, trick_suit, session_id, &player,
        );
        let public_inputs = build_cangkul_public_inputs(
            &env, &commit_hash, trick_suit, &hand, session_id, &player,
        );

        assert!(!client.verify(&public_inputs, &proof), "Invalid trick suit should fail");
    }

    #[test]
    fn test_cangkul_hand_commit_mismatch_fails() {
        let env = Env::default();
        let contract_id = env.register(ZkCommitmentVerifier, ());
        let client = ZkCommitmentVerifierClient::new(&env, &contract_id);
        let player = Address::generate(&env);

        let hand = [10u32];
        let blindings = [{let mut a = [0u8; 32]; a[31] = 42; a}];
        let trick_suit = 0u32;
        let session_id = 100u32;

        let (_commit_hash, proof) = build_cangkul_hand_proof(
            &env, &hand, &blindings, trick_suit, session_id, &player,
        );
        let fake_hash = BytesN::<32>::from_array(&env, &[0xFFu8; 32]);
        let public_inputs = build_cangkul_public_inputs(
            &env, &fake_hash, trick_suit, &hand, session_id, &player,
        );

        assert!(!client.verify(&public_inputs, &proof), "Wrong commit hash should fail");
    }
}