#!/usr/bin/env node
// =============================================================================
//  Noir UltraKeccakHonk Proof Generator for Cangkulan Seed Verification
// =============================================================================
//
//  Usage:
//    node generate-proof.mjs [seed_hex]
//
//  If no seed is provided, a random 32-byte seed is generated.
//
//  Outputs (in target/):
//    - vk            : Verification key (deploy to UltraHonk verifier contract)
//    - proof         : UltraHonk proof bytes (pass to verify_proof)
//    - public_inputs : Public inputs bytes (seed_hash as 32 BE field elements)
//    - seed.hex      : Seed used (hex string)
//    - seed_hash.hex : blake2s(seed) hash (hex string)
//
//  Requirements:
//    - nargo 1.0.0-beta.9 (for circuit compilation)
//    - @aztec/bb.js@0.87.0 (for proof generation)
//    - npm install (in this directory)
//
// =============================================================================

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { randomBytes } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(__dirname, 'target');
const CIRCUIT_JSON = resolve(TARGET, 'seed_verify.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blake2s(data) {
  return createHash('blake2s256').update(data).digest();
}

function toHex(buf) {
  return Buffer.from(buf).toString('hex');
}

function fromHex(hex) {
  return Buffer.from(hex, 'hex');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Noir Seed Verification Proof Generator ===\n');

  // 1. Parse or generate seed
  let seed;
  if (process.argv[2]) {
    seed = fromHex(process.argv[2]);
    if (seed.length !== 32) {
      console.error('Error: seed must be exactly 32 bytes (64 hex chars)');
      process.exit(1);
    }
  } else {
    seed = randomBytes(32);
    console.log('Generated random seed (no seed provided)');
  }

  const seedHash = blake2s(seed);
  console.log(`Seed:      ${toHex(seed)}`);
  console.log(`blake2s:   ${toHex(seedHash)}`);

  // Save for reference
  writeFileSync(resolve(TARGET, 'seed.hex'), toHex(seed));
  writeFileSync(resolve(TARGET, 'seed_hash.hex'), toHex(seedHash));

  // 2. Write Prover.toml
  const seedArr = Array.from(seed).join(', ');
  const hashArr = Array.from(seedHash).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ');
  const proverToml = `seed = [${seedArr}]\nseed_hash = [${hashArr}]\n`;
  writeFileSync(resolve(__dirname, 'Prover.toml'), proverToml);
  console.log('\nProver.toml written');

  // 3. Compile circuit (if not already compiled)
  if (!existsSync(CIRCUIT_JSON)) {
    console.log('\nCompiling circuit...');
    execSync('nargo compile', { cwd: __dirname, stdio: 'inherit' });
  }

  // 4. Execute circuit to generate witness
  console.log('\nGenerating witness...');
  execSync('nargo execute', { cwd: __dirname, stdio: 'inherit' });

  // 5. Generate VK
  console.log('\nGenerating verification key (UltraKeccakHonk)...');
  const bbjs = resolve(__dirname, 'node_modules/@aztec/bb.js/dest/node/main.js');
  execSync(
    `node ${bbjs} write_vk_ultra_keccak_honk -b ${CIRCUIT_JSON} -o ${resolve(TARGET, 'vk.keccak')}`,
    { cwd: __dirname, stdio: 'inherit' }
  );

  // 6. Generate proof
  console.log('\nGenerating UltraKeccakHonk proof...');
  execSync(
    `node ${bbjs} prove_ultra_keccak_honk -b ${CIRCUIT_JSON} -w ${resolve(TARGET, 'seed_verify.gz')} -o ${resolve(TARGET, 'proof.with_public_inputs')}`,
    { cwd: __dirname, stdio: 'inherit' }
  );

  // 7. Split proof into public_inputs and proof
  const proofWithPi = readFileSync(resolve(TARGET, 'proof.with_public_inputs'));
  
  // Count public input fields: seed_hash is [u8; 32] = 32 field elements, 32 bytes each
  const circuitJson = JSON.parse(readFileSync(CIRCUIT_JSON, 'utf8'));
  const pubFields = countPublicFields(circuitJson);
  const pubBytes = pubFields * 32;

  const publicInputs = proofWithPi.subarray(0, pubBytes);
  const proof = proofWithPi.subarray(pubBytes);

  writeFileSync(resolve(TARGET, 'public_inputs'), publicInputs);
  writeFileSync(resolve(TARGET, 'proof'), proof);
  writeFileSync(resolve(TARGET, 'vk'), readFileSync(resolve(TARGET, 'vk.keccak')));

  console.log('\n=== Proof Generation Complete ===');
  console.log(`VK size:             ${readFileSync(resolve(TARGET, 'vk')).length} bytes`);
  console.log(`Public inputs:       ${publicInputs.length} bytes (${pubFields} fields)`);
  console.log(`Proof size:          ${proof.length} bytes`);
  console.log(`Total proof+pi:      ${proofWithPi.length} bytes`);

  // 8. Verify public inputs match
  console.log('\n--- Public Input Verification ---');
  const extractedHash = [];
  for (let i = 0; i < 32; i++) {
    extractedHash.push(publicInputs[i * 32 + 31]);
  }
  const match = extractedHash.every((v, i) => v === seedHash[i]);
  console.log(`Extracted seed_hash: ${toHex(Buffer.from(extractedHash))}`);
  console.log(`Expected seed_hash:  ${toHex(seedHash)}`);
  console.log(`Match: ${match ? 'OK' : 'MISMATCH!'}`);

  if (!match) {
    console.error('\nERROR: Public inputs do not match expected seed_hash!');
    process.exit(1);
  }

  console.log('\n--- Deployment Commands ---');
  console.log(`
# Deploy UltraHonk verifier with this VK:
stellar contract deploy \\
  --source-account deployer \\
  --wasm contracts/ultrahonk-verifier/rs_soroban_ultrahonk.wasm \\
  --network testnet \\
  -- \\
  --vk_bytes-file-path circuits/seed_verify/target/vk

# Verify proof (simulation):
stellar contract invoke \\
  --source-account user \\
  --id <ULTRAHONK_CONTRACT_ID> \\
  --network testnet \\
  --send no \\
  -- \\
  verify_proof \\
  --public_inputs-file-path circuits/seed_verify/target/public_inputs \\
  --proof_bytes-file-path circuits/seed_verify/target/proof
`);
}

// Count total number of field elements for public parameters
function countPublicFields(circuitJson) {
  const params = circuitJson.abi?.parameters || [];
  let total = 0;
  for (const p of params) {
    if (p.visibility === 'public') {
      total += countTypeFields(p.type);
    }
  }
  return total;
}

function countTypeFields(type) {
  if (type.kind === 'array') {
    return type.length * countTypeFields(type.type);
  }
  if (type.kind === 'tuple') {
    return type.fields.reduce((s, f) => s + countTypeFields(f), 0);
  }
  if (type.kind === 'struct') {
    return type.fields.reduce((s, f) => s + countTypeFields(f.type), 0);
  }
  return 1; // scalar (field, integer, bool)
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
