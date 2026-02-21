# ZK Verifier — Soroban Smart Contract

On-chain zero-knowledge commitment verifier supporting **seven verification modes** for the Stellar Game Studio, built on **Stellar Protocol 25** cryptographic primitives (BLS12-381 and BN254).

## Protocol 25 Cryptographic Primitives

This contract makes extensive use of the new elliptic curve cryptography introduced in **Soroban Protocol 25**:

### BLS12-381 (Modes 4 & 5)
- `bls12_381().g1_mul()` / `g1_add()` / `g1_msm()` — G1 point arithmetic
- `bls12_381().g2_mul()` — G2 scalar multiplication
- `bls12_381().pairing_check()` — optimal Ate pairing (4-pair Groth16)
- `bls12_381().hash_to_g1()` — hash-to-curve for Pedersen commitments
- `bls12_381().fr_add()` / `fr_mul()` — scalar field arithmetic
- `bls12_381().g1_subgroup_check()` — G1 subgroup validation

### BN254 (Mode 6)
- `bn254().g1_mul()` / `g1_add()` — G1 point arithmetic
- `bn254().pairing_check()` — BN254 optimal Ate pairing (4-pair Groth16)
- `Bn254G1Affine` negation via Fp arithmetic — proof element negation

## Verification Modes

### Mode 1 — Card Commitment
Verifies a card commitment: `commit = keccak256(card_value(u32 BE) ∥ salt)`.

- **Proof:** 32-byte salt
- **Public inputs:** `card_value(4 bytes) ∥ commitment(32 bytes)`

### Mode 2 — Hash-based Proof of Knowledge (Cangkulan Seed)
Verifies a **hash-based proof of knowledge** for seed commitment using Fiat-Shamir binding. The raw seed **never** appears on-chain.

- **Proof:** 64 bytes — `blinding(32) ∥ response(32)`
- **Public inputs:** `seed_hash(32) ∥ commitment(32) ∥ nullifier(32) ∥ session_id(4 BE) ∥ player_address(var)`

**Verification steps:**
1. Recompute `commitment' = keccak256(seed_hash ∥ blinding ∥ player)`, check `commitment' == commitment`
2. Recompute `nullifier' = keccak256(seed_hash ∥ "NULL" ∥ session_id)`, check `nullifier' == nullifier`
3. Compute Fiat-Shamir challenge: `c = keccak256(commitment ∥ session_id ∥ player ∥ "ZKV2")`
4. Recompute `response' = keccak256(seed_hash ∥ c ∥ blinding)`, check `response' == response`
5. Entropy check: `seed_hash` must have ≥ 8 distinct bytes

### Mode 3 — Legacy Seed (Backward Compatible)
Simple seed-hash verification: `commit = keccak256(seed)`.

- **Proof:** 32-byte seed
- **Public inputs:** `commitment(32 bytes)`

### Mode 4 — Pedersen Sigma Protocol (BLS12-381)
Verifies a **Pedersen commitment** with Sigma protocol using BLS12-381 curve primitives.

- **Proof:** 128 bytes — `R(48, G1 compressed) ∥ z_r(32) ∥ z_s(32) ∥ padding(16)`
- **Public inputs:** `seed_hash(32) ∥ commitment(32) ∥ H_point(48, G1) ∥ session_id(4 BE) ∥ player_address(var)`

**Uses:** `bls12_381().hash_to_g1()`, `g1_mul()`, `g1_add()`, `fr_add()`, `fr_mul()`, `g1_subgroup_check()`

### Mode 5 — BLS12-381 Groth16 SNARK Verifier
Full **Groth16 zero-knowledge proof** verification using the BLS12-381 pairing.

- **Proof:** 384 bytes — `A(96, G1) ∥ B(192, G2) ∥ C(96, G1)` (uncompressed)
- **Public inputs:** `alpha_g1(96) ∥ beta_g2(192) ∥ gamma_g2(192) ∥ delta_g2(192) ∥ num_ic(4) ∥ IC[...](96 each) ∥ num_pub(4) ∥ scalars[...](32 each)`

**Uses:** `bls12_381().g1_mul()`, `g1_add()`, `g2_mul()`, `pairing_check()` (4-pair)

### Mode 6 — BN254 Groth16 SNARK Verifier
Full **Groth16 zero-knowledge proof** verification using the BN254 (alt_bn128) pairing — Ethereum-compatible.

- **Proof:** 256 bytes — `A(64, G1) ∥ B(128, G2) ∥ C(64, G1)` (uncompressed, Ethereum BE)
- **Public inputs:** `alpha_g1(64) ∥ beta_g2(128) ∥ gamma_g2(128) ∥ delta_g2(128) ∥ num_ic(4) ∥ IC[...](64 each) ∥ num_pub(4) ∥ scalars[...](32 each)`

**Uses:** `bn254().g1_mul()`, `g1_add()`, `pairing_check()` (4-pair), `Bn254G1Affine` negation

### Mode 7 — Card Play Ring Sigma (BLS12-381)
Verifies a **1-of-N Ring Sigma proof** proving a committed card belongs to a valid set, without revealing which card. Uses Pedersen commitments on BLS12-381.

- **Proof:** `96 + N×64` bytes — `C(96, G1 uncompressed) ∥ [e_i(32, Fr) ∥ z_i(32, Fr)] × N`
- **Public inputs:** `commit_hash(32) ∥ N(4, u32 BE) ∥ valid_set[N](4 each, u32 BE) ∥ session_id(4 BE) ∥ player_address(var)`

**Protocol:**
1. Extract commitment `C` from proof; verify `keccak256(C) == commit_hash`
2. For each valid card `i`: compute `D_i = C − card_i·G`
3. Reconstruct `R_i = z_i·H − e_i·D_i`
4. Fiat-Shamir: `e = Fr(keccak256(C ∥ R_0 ∥ … ∥ R_{N-1} ∥ session_id ∥ player ∥ "ZKP7"))`
5. Check `Σ e_i == e` via MSM group comparison: `g1_msm([G × N], [e_i]) == e·G`

**Uses:** `bls12_381().g1_mul()`, `g1_add()`, `g1_msm()`, `hash_to_g1()`, `g1_is_in_subgroup()`

**Budget:** ~52M CPU for N=3, ~81M for N=5 (within Soroban 100M limit)

## Auto-Detection

Mode is detected by proof length:
| Proof Length | Mode |
|---|---|
| \u2265 512, \u2264 1024 | Noir UltraKeccakHonk (routed externally) |
| \u2265 160, `(len-96) % 64 == 0` | Card Play Ring Sigma (Mode 7) |
| 384 bytes | BLS12-381 Groth16 (Mode 5) |
| 256 bytes | BN254 Groth16 (Mode 6) |
| 228 bytes | Cangkul Hand Proof (Mode 8) |
| 128 bytes | Pedersen Sigma BLS12-381 (Mode 4) |
| 64 bytes, public_inputs \u2265 101 | Hash-based PoK Seed (Mode 2) |
| 32 bytes, public_inputs ≥ 36 bytes | Card Commitment (Mode 1) |
| 32 bytes, public_inputs = 32 bytes | Legacy Seed (Mode 3) |

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 1 | `InvalidProof` | Generic proof verification failure |
| 2 | `InvalidCard` | Card value out of range (must be 1–13) |
| 3 | `InvalidCommitment` | Commitment doesn't match recomputed hash |
| 4 | `InvalidSalt` | Salt/proof format error |
| 5 | `EmptyPublicInputs` | No public inputs provided |
| 6 | `InvalidProofLength` | Proof is not 32 or 64 bytes |
| 7 | `NullifierMismatch` | Nullifier doesn't match recomputed value |
| 8 | `ChallengeMismatch` | Internal — challenge derivation issue |
| 9 | `ResponseMismatch` | Response doesn't match recomputed value |
| 10 | `WeakSeedEntropy` | Seed hash has < 8 distinct bytes |
| 11 | `CommitmentMismatch` | Recomputed commitment doesn't match |
| 12 | `Groth16PairingFailed` | BLS12-381 Groth16 pairing check failed |
| 13 | `Groth16InvalidInputCount` | BLS12-381 Groth16 IC/public input count mismatch |
| 14 | `PedersenCommitmentMismatch` | Pedersen-Sigma commitment mismatch |
| 15 | `PedersenChallengeFailed` | Pedersen-Sigma Fiat-Shamir challenge failed |
| 16 | `InputsTooShort` | Public inputs buffer too short for the mode |
| 17 | `Bn254Groth16PairingFailed` | BN254 Groth16 pairing check failed |
| 18 | `Bn254Groth16InvalidInputCount` | BN254 Groth16 IC/public input count mismatch |
| 19 | `RingInvalidSetSize` | Ring Sigma: N is 0 or > 9 |
| 20 | `RingChallengeCheckFailed` | Ring Sigma: Σe_i ≠ challenge hash |
| 21 | `RingPointNotOnCurve` | Ring Sigma: commitment C not on G1 subgroup |

## Events

On successful verification, emits `("verify", "mode")` with the mode number (1–7).

## Building

```bash
bun run build zk-verifier
```

## Testing

```bash
cargo test -p zk-verifier
# 40 tests — all passing
```
