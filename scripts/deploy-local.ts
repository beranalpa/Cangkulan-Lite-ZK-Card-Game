#!/usr/bin/env bun

/**
 * Deploy contracts to a local Stellar quickstart node with --limits unlimited.
 *
 * This enables Noir UltraHonk ZK proof verification on-chain (~215M CPU)
 * which exceeds the public testnet per-TX budget (~100M).
 *
 * Prerequisites:
 *   docker run -d -p 8000:8000 stellar/quickstart \
 *     --local --limits unlimited \
 *     --enable core,rpc,lab,horizon,friendbot
 *
 * Usage:
 *   bun run scripts/deploy-local.ts
 *
 * Based on: https://github.com/jamesbachini/Noirlang-Experiments
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { getWorkspaceContracts } from "./utils/contracts";

type StellarKeypair = {
  publicKey(): string;
  secret(): string;
};

type StellarKeypairFactory = {
  random(): StellarKeypair;
  fromSecret(secret: string): StellarKeypair;
};

async function loadKeypairFactory(): Promise<StellarKeypairFactory> {
  const sdk = await import("@stellar/stellar-sdk");
  return sdk.Keypair;
}

// ── Config ─────────────────────────────────────────────────────────────────

const LOCAL_RPC_URL = 'http://localhost:8000/soroban/rpc';
const LOCAL_NETWORK_PASSPHRASE = 'Standalone Network ; February 2017';
const LOCAL_FRIENDBOT = 'http://localhost:8000/friendbot';
const NETWORK_NAME = 'local'; // Stellar CLI network name

// ── Health check ───────────────────────────────────────────────────────────

async function waitForLocalNode(maxRetries = 30): Promise<void> {
  console.log('⏳ Waiting for local Stellar node to be ready...');
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(LOCAL_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: AbortSignal.timeout(2000),
      });
      const data = await res.json() as any;
      if (data?.result?.status === 'healthy') {
        console.log('✅ Local node is healthy!\n');
        return;
      }
    } catch { /* retry */ }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(
    '❌ Local Stellar node not reachable at ' + LOCAL_RPC_URL + '\n' +
    'Start it with:\n' +
    '  docker run -d -p 8000:8000 stellar/quickstart \\\n' +
    '    --local --limits unlimited \\\n' +
    '    --enable core,rpc,lab,horizon,friendbot'
  );
}

async function fundLocal(address: string, maxRetries = 30): Promise<void> {
  // Friendbot/Horizon may still be starting even after RPC is healthy.
  // Retry on 5xx errors until it's ready.
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(`${LOCAL_FRIENDBOT}?addr=${address}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) break;
      if (res.status >= 500 && attempt < maxRetries - 1) {
        // 502/503 = Horizon still starting, wait and retry
        if (attempt === 0) process.stdout.write('  ⏳ Waiting for Friendbot...');
        process.stdout.write('.');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw new Error(`Local friendbot funding failed (${res.status}) for ${address}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes('funding failed')) throw err;
      if (attempt >= maxRetries - 1) {
        throw new Error(`Friendbot not reachable after ${maxRetries} attempts for ${address}`);
      }
      if (attempt === 0) process.stdout.write('  ⏳ Waiting for Friendbot...');
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\n');
  // Wait for account to appear on Horizon
  for (let i = 0; i < 10; i++) {
    try {
      const check = await fetch(`http://localhost:8000/accounts/${address}`);
      if (check.ok) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('🚀 Deploying contracts to LOCAL Stellar node (--limits unlimited)\n');

const Keypair = await loadKeypairFactory();

// Ensure node is running
await waitForLocalNode();

// Set up the 'local' network in Stellar CLI
try {
  await $`stellar network add ${NETWORK_NAME} --rpc-url ${LOCAL_RPC_URL} --network-passphrase ${LOCAL_NETWORK_PASSPHRASE}`.quiet();
} catch {
  // Network might already exist — try removing and re-adding
  try { await $`stellar network rm ${NETWORK_NAME}`.quiet(); } catch { /* ok */ }
  await $`stellar network add ${NETWORK_NAME} --rpc-url ${LOCAL_RPC_URL} --network-passphrase ${LOCAL_NETWORK_PASSPHRASE}`;
}

// Generate admin + player keypairs
const admin = Keypair.random();
const player1 = Keypair.random();
const player2 = Keypair.random();

console.log('💼 Funding accounts...');
await fundLocal(admin.publicKey());
console.log(`  ✅ Admin:   ${admin.publicKey()}`);
await fundLocal(player1.publicKey());
console.log(`  ✅ Player1: ${player1.publicKey()}`);
await fundLocal(player2.publicKey());
console.log(`  ✅ Player2: ${player2.publicKey()}\n`);

const allContracts = await getWorkspaceContracts();
const deployed: Record<string, string> = {};

// ── Deploy mock-game-hub first ─────────────────────────────────────────────

const mock = allContracts.find(c => c.isMockHub);
if (!mock) throw new Error('mock-game-hub not found in workspace');

if (!existsSync(mock.wasmPath)) {
  console.error(`❌ Missing ${mock.wasmPath} — run 'bun run build' first`);
  process.exit(1);
}

console.log(`Deploying ${mock.packageName}...`);
const mockResult = await $`stellar contract deploy --wasm ${mock.wasmPath} --source-account ${admin.secret()} --network ${NETWORK_NAME}`.text();
const mockId = mockResult.trim();
deployed[mock.packageName] = mockId;
console.log(`  ✅ ${mock.packageName}: ${mockId}\n`);

// ── Deploy other contracts ─────────────────────────────────────────────────

const deployOrder = ['zk-verifier', 'leaderboard', 'cangkulan'];

for (const name of deployOrder) {
  const contract = allContracts.find(c => c.packageName === name);
  if (!contract) {
    console.warn(`⚠️  ${name} not found in workspace, skipping`);
    continue;
  }
  if (!existsSync(contract.wasmPath)) {
    console.warn(`⚠️  ${contract.wasmPath} not found, skipping ${name}`);
    continue;
  }

  console.log(`Deploying ${name}...`);

  // Install WASM
  const installResult = await $`stellar contract install --wasm ${contract.wasmPath} --source-account ${admin.secret()} --network ${NETWORK_NAME}`.text();
  const wasmHash = installResult.trim();

  // Build constructor args
  const adminOnlyContracts = ['leaderboard', 'zk-verifier'];
  const gameHubArgs = adminOnlyContracts.includes(name) ? [] : ['--game-hub', mockId];
  const extraArgs: string[] = [];

  if (name === 'cangkulan' && deployed['zk-verifier']) {
    extraArgs.push('--verifier', deployed['zk-verifier']);
  }

  const constructorArgs = ['--admin', admin.publicKey(), ...gameHubArgs, ...extraArgs];

  const deployResult = await $`stellar contract deploy --wasm-hash ${wasmHash} --source-account ${admin.secret()} --network ${NETWORK_NAME} -- ${constructorArgs}`.text();
  const contractId = deployResult.trim();
  deployed[name] = contractId;
  console.log(`  ✅ ${name}: ${contractId}\n`);
}

// ── Deploy UltraHonk Verifier ──────────────────────────────────────────────

const ULTRAHONK_WASM = 'contracts/ultrahonk-verifier/rs_soroban_ultrahonk.wasm';
const ULTRAHONK_VK = 'circuits/seed_verify/target/vk';

if (existsSync(ULTRAHONK_WASM) && existsSync(ULTRAHONK_VK)) {
  console.log('Deploying UltraHonk verifier...');
  try {
    const vkHex = Buffer.from(await Bun.file(ULTRAHONK_VK).arrayBuffer()).toString('hex');
    const result = await $`stellar contract deploy --wasm ${ULTRAHONK_WASM} --source-account ${admin.secret()} --network ${NETWORK_NAME} -- --vk_bytes ${vkHex}`.text();
    const uhId = result.trim();
    deployed['ultrahonk-verifier'] = uhId;
    console.log(`  ✅ ultrahonk-verifier: ${uhId}\n`);

    // Link to cangkulan
    if (deployed['cangkulan']) {
      await $`stellar contract invoke --id ${deployed['cangkulan']} --source-account ${admin.secret()} --network ${NETWORK_NAME} -- set_ultrahonk_verifier --verifier_addr ${uhId}`;
      console.log(`  ✅ Linked ultrahonk-verifier → cangkulan\n`);
    }
  } catch (err) {
    console.warn('⚠️  UltraHonk verifier deployment failed:', err);
  }
} else {
  console.log('ℹ️  Skipping UltraHonk verifier (WASM or VK not found)\n');
}

// ── Re-link ZK verifier to cangkulan ───────────────────────────────────────

if (deployed['zk-verifier'] && deployed['cangkulan']) {
  try {
    await $`stellar contract invoke --id ${deployed['cangkulan']} --source-account ${admin.secret()} --network ${NETWORK_NAME} -- set_verifier --new_verifier ${deployed['zk-verifier']}`;
    console.log(`✅ Linked zk-verifier → cangkulan\n`);
  } catch (err) {
    console.warn('⚠️  Failed to link ZK verifier:', err);
  }
}

// ── Write deployment-local.json ────────────────────────────────────────────

const deploymentInfo = {
  contracts: deployed,
  network: 'local',
  rpcUrl: LOCAL_RPC_URL,
  networkPassphrase: LOCAL_NETWORK_PASSPHRASE,
  wallets: {
    admin: admin.publicKey(),
    player1: player1.publicKey(),
    player2: player2.publicKey(),
  },
  secrets: {
    admin: admin.secret(),
    player1: player1.secret(),
    player2: player2.secret(),
  },
  deployedAt: new Date().toISOString(),
  note: 'Local node with --limits unlimited. Noir UltraHonk verification works on-chain.',
};

await Bun.write('deployment-local.json', JSON.stringify(deploymentInfo, null, 2) + '\n');
console.log('✅ Wrote deployment-local.json');

// Auto-copy to frontend public/ for auto-import
const frontendPublicPath = join(import.meta.dir, '..', 'cangkulan-frontend', 'public', 'deployment-local.json');
await Bun.write(frontendPublicPath, JSON.stringify(deploymentInfo, null, 2) + '\n');
console.log('✅ Copied to cangkulan-frontend/public/deployment-local.json (auto-import ready)');

console.log('\n🎉 Local deployment complete!\n');
console.log('Contract IDs:');
for (const [name, id] of Object.entries(deployed)) {
  console.log(`  ${name}: ${id}`);
}
console.log('\nWallets:');
console.log(`  Admin:   ${admin.publicKey()}`);
console.log(`  Player1: ${player1.publicKey()}`);
console.log(`  Player2: ${player2.publicKey()}`);
console.log('\n📋 Frontend will auto-import contract IDs on reload.');
console.log('  Just open Dev Testing → Local Node and start playing!');
