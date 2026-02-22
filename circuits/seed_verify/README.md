# Noir Seed Verification Circuit

Zero-knowledge circuit proving knowledge of a seed such that `blake2s(seed) == seed_hash`, implemented in [Noir](https://noir-lang.org/) and verified on-chain via UltraKeccakHonk on Stellar/Soroban.

## Architecture

```
Player (browser/CLI)          Stellar Network
  |                              |
  | 1. Generate seed (32 bytes)  |
  | 2. Compute blake2s(seed)     |
  | 3. Generate Noir proof       |
  |                              |
  | --- proof + public_inputs -> |
  |                              | 4. UltraHonk verifier
  |                              |    checks proof against VK
  |                              |
  |                              | 5. Cangkulan contract
  |                              |    routes to UltraHonk verifier
  |                              |    for proofs > 4KB
```

## Circuit

**File:** `src/main.nr`

```noir
fn main(seed: [u8; 32], seed_hash: pub [u8; 32]) {
    let computed_hash = blake2s(seed);
    assert(computed_hash == seed_hash);
}
```

- **Private input:** `seed` (32 bytes) - the player's secret random seed
- **Public input:** `seed_hash` (32 bytes) - blake2s(seed), the commitment
- **Hash function:** blake2s (efficient in Noir, ~1K gates vs keccak256's ~50K)
- **Proving system:** UltraKeccakHonk (via bb.js)

## Quick Start

```bash
# Install nargo (Noir compiler)
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup -v 1.0.0-beta.9

# Install npm dependencies
cd circuits/seed_verify
npm install

# Run tests
nargo test

# Generate a proof with random seed
node generate-proof.mjs

# Generate a proof with specific seed
node generate-proof.mjs <64-char-hex-seed>
```

## Output Artifacts

After proof generation, `target/` contains:

| File | Size | Description |
|------|------|-------------|
| `vk` | 1,760 bytes | Verification key (deploy to UltraHonk contract) |
| `proof` | 14,592 bytes | UltraHonk proof (pass to `verify_proof`) |
| `public_inputs` | 1,024 bytes | 32 field elements (seed_hash, 32 bytes each) |
| `seed.hex` | 64 chars | Seed used (hex) |
| `seed_hash.hex` | 64 chars | blake2s(seed) hash (hex) |
| `seed_verify.json` | 4,629 bytes | Compiled ACIR bytecode |
| `seed_verify.gz` | ~varies | Witness (intermediate) |

## On-Chain Verification

### Deploy UltraHonk Verifier

```bash
stellar contract deploy \
  --source-account deployer \
  --wasm contracts/ultrahonk-verifier/rs_soroban_ultrahonk.wasm \
  --network testnet \
  -- \
  --vk_bytes-file-path circuits/seed_verify/target/vk
```

### Register with Cangkulan Contract

```bash
stellar contract invoke \
  --source-account admin \
  --id <CANGKULAN_CONTRACT_ID> \
  --network testnet \
  -- \
  set_ultrahonk_verifier \
  --verifier_addr <ULTRAHONK_CONTRACT_ID>
```

### Verify a Proof

```bash
stellar contract invoke \
  --source-account user \
  --id <ULTRAHONK_CONTRACT_ID> \
  --network testnet \
  --send no \
  -- \
  verify_proof \
  --public_inputs-file-path circuits/seed_verify/target/public_inputs \
  --proof_bytes-file-path circuits/seed_verify/target/proof
```

## Integration with Cangkulan

The cangkulan contract auto-detects proof mode by size:

| Mode | Proof Size | Verifier |
|------|-----------|----------|
| Pedersen+Sigma (default) | 224 bytes | ZK Verifier contract |
| Hash-based PoK (legacy) | 64 bytes | ZK Verifier contract |
| **Noir UltraHonk** | **>4,000 bytes** | **UltraHonk Verifier contract** |

When a player submits a proof larger than 4KB, the contract:
1. Encodes `seed_hash` as 32 big-endian field elements (1024 bytes)
2. Calls the UltraHonk verifier contract's `verify_proof` function
3. The verifier checks the proof against the stored verification key

## Version Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| nargo | 1.0.0-beta.9 | Noir compiler |
| @aztec/bb.js | 0.87.0 | UltraKeccakHonk prover |
| stellar-cli | latest | Contract deployment |

## Security Properties

- **Soundness:** Only someone knowing the seed preimage can produce a valid proof
- **Zero-knowledge:** The proof reveals nothing about the seed
- **Binding:** blake2s collision resistance prevents finding alternate seeds
- **On-chain verification:** UltraHonk verifier is trustless, no off-chain dependencies

## Testnet Limitations

UltraHonk verification is CPU-intensive (~64KB WASM verifier). On testnet:
- Use `--send no` for simulation (verification runs but no on-chain tx)
- Full on-chain execution may require Protocol 25 BN254 precompiles
- The Pedersen+Sigma mode (224 bytes) is recommended for production use
