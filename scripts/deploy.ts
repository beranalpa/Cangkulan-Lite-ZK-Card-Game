#!/usr/bin/env bun

/**
 * Deploy script for Soroban contracts to testnet
 *
 * Deploys Soroban contracts to testnet
 * Returns the deployed contract IDs
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { readEnvFile, getEnvValue } from './utils/env';
import { getWorkspaceContracts, listContractNames, selectContracts } from "./utils/contracts";

type StellarKeypair = {
  publicKey(): string;
  secret(): string;
};

type StellarKeypairFactory = {
  random(): StellarKeypair;
  fromSecret(secret: string): StellarKeypair;
};

async function loadKeypairFactory(): Promise<StellarKeypairFactory> {
  try {
    const sdk = await import("@stellar/stellar-sdk");
    return sdk.Keypair;
  } catch (error) {
    console.warn("⚠️  @stellar/stellar-sdk is not installed. Running `bun install`...");
    try {
      await $`bun install`;
      const sdk = await import("@stellar/stellar-sdk");
      return sdk.Keypair;
    } catch (installError) {
      console.error("❌ Failed to load @stellar/stellar-sdk.");
      console.error("Run `bun install` in the repository root, then retry.");
      process.exit(1);
    }
  }
}

function usage() {
  console.log(`
Usage: bun run deploy [contract-name...]

Examples:
  bun run deploy
  bun run deploy cangkulan
  bun run deploy cangkulan zk-verifier
`);
}

console.log("🚀 Deploying contracts to Stellar testnet...\n");
const Keypair = await loadKeypairFactory();

const NETWORK = 'testnet';
const RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const EXISTING_GAME_HUB_TESTNET_CONTRACT_ID = 'CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG';

async function testnetAccountExists(address: string): Promise<boolean> {
  const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`, { method: 'GET' });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Horizon error ${res.status} checking ${address}`);
  return true;
}

async function ensureTestnetFunded(address: string): Promise<void> {
  if (await testnetAccountExists(address)) return;
  console.log(`💰 Funding ${address} via friendbot...`);
  const fundRes = await fetch(`https://friendbot.stellar.org?addr=${address}`, { method: 'GET' });
  if (!fundRes.ok) {
    throw new Error(`Friendbot funding failed (${fundRes.status}) for ${address}`);
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await testnetAccountExists(address)) {
      // Small extra buffer for Soroban RPC to catch up after Horizon sees it
      await new Promise((r) => setTimeout(r, 1000));
      return;
    }
  }
  throw new Error(`Funded ${address} but it still doesn't appear on Horizon yet`);
}

async function testnetContractExists(contractId: string): Promise<boolean> {
  const tmpPath = join(tmpdir(), `stellar-contract-${contractId}.wasm`);
  try {
    await $`stellar -q contract fetch --id ${contractId} --network ${NETWORK} --out-file ${tmpPath}`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore missing temp file
    }
  }
}

const args = process.argv.slice(2);
const force = args.includes("--force");
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const allContracts = await getWorkspaceContracts();
const contractTargets = args.filter(a => !a.startsWith("--"));
const selection = selectContracts(allContracts, contractTargets);
if (selection.unknown.length > 0 || selection.ambiguous.length > 0) {
  console.error("❌ Error: Unknown or ambiguous contract names.");
  if (selection.unknown.length > 0) {
    console.error("Unknown:");
    for (const name of selection.unknown) console.error(`  - ${name}`);
  }
  if (selection.ambiguous.length > 0) {
    console.error("Ambiguous:");
    for (const entry of selection.ambiguous) {
      console.error(`  - ${entry.target}: ${entry.matches.join(", ")}`);
    }
  }
  console.error(`\nAvailable contracts: ${listContractNames(allContracts)}`);
  process.exit(1);
}

const contracts = selection.contracts;
const mock = allContracts.find((c) => c.isMockHub);
if (!mock) {
  console.error("❌ Error: mock-game-hub contract not found in workspace members");
  process.exit(1);
}

const needsMock = contracts.some((c) => !c.isMockHub);
const deployMockRequested = contracts.some((c) => c.isMockHub);
const shouldEnsureMock = deployMockRequested || needsMock;

// Check required WASM files exist for selected contracts (non-mock first)
const missingWasm: string[] = [];
for (const contract of contracts) {
  if (contract.isMockHub) continue;
  if (!await Bun.file(contract.wasmPath).exists()) missingWasm.push(contract.wasmPath);
}
if (missingWasm.length > 0) {
  console.error("❌ Error: Missing WASM build outputs:");
  for (const p of missingWasm) console.error(`  - ${p}`);
  console.error("\nRun 'bun run build [contract-name]' first");
  process.exit(1);
}

// Create three testnet identities: admin, player1, player2
// Admin signs deployments directly via secret key (no CLI identity required).
// Player1 and player2 are keypairs for frontend dev use.
const walletAddresses: Record<string, string> = {};
const walletSecrets: Record<string, string> = {};

// Load existing secrets from .env if available
let existingSecrets: Record<string, string | null> = {
  player1: null,
  player2: null,
};

const existingEnv = await readEnvFile('.env');
for (const identity of ['player1', 'player2']) {
  const key = `VITE_DEV_${identity.toUpperCase()}_SECRET`;
  const v = getEnvValue(existingEnv, key);
  if (v && v !== 'NOT_AVAILABLE') existingSecrets[identity] = v;
}

// Load existing deployment info so partial deploys can preserve other IDs.
const existingContractIds: Record<string, string> = {};
let existingDeployment: any = null;
if (existsSync("deployment.json")) {
  try {
    existingDeployment = await Bun.file("deployment.json").json();
    if (existingDeployment?.contracts && typeof existingDeployment.contracts === "object") {
      Object.assign(existingContractIds, existingDeployment.contracts);
    } else {
      // Backwards compatible fallback
      if (existingDeployment?.mockGameHubId) existingContractIds["mock-game-hub"] = existingDeployment.mockGameHubId;
    }
  } catch (error) {
    console.warn("⚠️  Warning: Failed to parse deployment.json, continuing...");
  }
}

for (const contract of allContracts) {
  if (existingContractIds[contract.packageName]) continue;
  const envId = getEnvValue(existingEnv, `VITE_${contract.envKey}_CONTRACT_ID`);
  if (envId) existingContractIds[contract.packageName] = envId;
}

// Handle admin identity (needs to be in Stellar CLI for deployment)
console.log('Setting up admin identity...');

let adminKeypair: StellarKeypair;
const adminSecretFromEnv = getEnvValue(existingEnv, 'VITE_DEV_ADMIN_SECRET');

if (adminSecretFromEnv && adminSecretFromEnv !== 'NOT_AVAILABLE') {
  console.log('✅ Using existing admin from .env');
  adminKeypair = Keypair.fromSecret(adminSecretFromEnv);
} else {
  console.log('📝 Generating new admin identity...');
  adminKeypair = Keypair.random();
  walletSecrets.admin = adminKeypair.secret();
}

walletAddresses.admin = adminKeypair.publicKey();

try {
  await ensureTestnetFunded(walletAddresses.admin);
  console.log('✅ admin funded');
} catch (error) {
  console.error('❌ Failed to ensure admin is funded. Deployment cannot proceed.');
  process.exit(1);
}

// Handle player identities (don't need to be in CLI, just keypairs)
for (const identity of ['player1', 'player2']) {
  console.log(`Setting up ${identity}...`);

  let keypair: StellarKeypair;
  if (existingSecrets[identity]) {
    console.log(`✅ Using existing ${identity} from .env`);
    keypair = Keypair.fromSecret(existingSecrets[identity]!);
  } else {
    console.log(`📝 Generating new ${identity}...`);
    keypair = Keypair.random();
  }

  walletAddresses[identity] = keypair.publicKey();
  walletSecrets[identity] = keypair.secret();
  console.log(`✅ ${identity}: ${keypair.publicKey()}`);

  // Ensure player accounts exist on testnet (even if reusing keys from .env)
  try {
    await ensureTestnetFunded(keypair.publicKey());
    console.log(`✅ ${identity} funded\n`);
  } catch (error) {
    console.warn(`⚠️  Warning: Failed to ensure ${identity} is funded, continuing anyway...`);
  }
}

// Save to deployment.json and .env for setup script to use
console.log("🔐 Player secret keys will be saved to .env (gitignored)\n");

console.log("💼 Wallet addresses:");
console.log(`  Admin:   ${walletAddresses.admin}`);
console.log(`  Player1: ${walletAddresses.player1}`);
console.log(`  Player2: ${walletAddresses.player2}\n`);

// Use admin secret for contract deployment
const adminAddress = walletAddresses.admin;
const adminSecret = adminKeypair.secret();

const deployed: Record<string, string> = { ...existingContractIds };

// Ensure mock Game Hub exists so we can pass it into game constructors.
let mockGameHubId = existingContractIds[mock.packageName] || "";
if (shouldEnsureMock) {
  const candidateMockIds = [
    existingContractIds[mock.packageName],
    existingDeployment?.mockGameHubId,
    EXISTING_GAME_HUB_TESTNET_CONTRACT_ID,
  ].filter(Boolean) as string[];

  for (const candidate of candidateMockIds) {
    if (await testnetContractExists(candidate)) {
      mockGameHubId = candidate;
      break;
    }
  }

  if (mockGameHubId) {
    deployed[mock.packageName] = mockGameHubId;
    console.log(`✅ Using existing ${mock.packageName} on testnet: ${mockGameHubId}\n`);
  } else {
    if (!await Bun.file(mock.wasmPath).exists()) {
      console.error("❌ Error: Missing WASM build output for mock-game-hub:");
      console.error(`  - ${mock.wasmPath}`);
      console.error("\nRun 'bun run build mock-game-hub' first");
      process.exit(1);
    }

    console.warn(`⚠️  ${mock.packageName} not found on testnet (archived or reset). Deploying a new one...`);
    console.log(`Deploying ${mock.packageName}...`);
    try {
      const result =
        await $`stellar contract deploy --wasm ${mock.wasmPath} --source-account ${adminSecret} --network ${NETWORK}`.text();
      mockGameHubId = result.trim();
      deployed[mock.packageName] = mockGameHubId;
      console.log(`✅ ${mock.packageName} deployed: ${mockGameHubId}\n`);
    } catch (error) {
      console.error(`❌ Failed to deploy ${mock.packageName}:`, error);
      process.exit(1);
    }
  }
}

for (const contract of contracts) {
  if (contract.isMockHub) continue;

  const existingId = deployed[contract.packageName];
  if (!force && existingId && (await testnetContractExists(existingId))) {
    console.log(`✅ Using existing ${contract.packageName} on testnet: ${existingId}\n`);
    continue;
  }

  console.log(`Deploying ${contract.packageName}...`);
  try {
    console.log("  Installing WASM...");
    const installResult =
      await $`stellar contract install --wasm ${contract.wasmPath} --source-account ${adminSecret} --network ${NETWORK}`.text();
    const wasmHash = installResult.trim();
    console.log(`  WASM hash: ${wasmHash}`);

    console.log("  Deploying and initializing...");
    const extraArgs: string[] = [];

    // Cangkulan and other ZK-enabled games need the verifier address
    const zkVerifierId = deployed["zk-verifier"] || existingContractIds["zk-verifier"] || "";
    if (contract.packageName === "cangkulan" && zkVerifierId) {
      extraArgs.push("--verifier", zkVerifierId);
    }

    // Contracts that only take --admin (no --game-hub)
    const adminOnlyContracts = ["leaderboard", "zk-verifier"];
    // Contracts with bare constructors (no CLI args at all)
    const noArgContracts: string[] = [];
    const gameHubArgs = adminOnlyContracts.includes(contract.packageName)
      ? []
      : ["--game-hub", mockGameHubId];

    // Build constructor args: noArgContracts get none, adminOnly get --admin, others get --admin + --game-hub
    const constructorArgs = noArgContracts.includes(contract.packageName)
      ? []
      : ["--admin", adminAddress, ...gameHubArgs, ...extraArgs];
    const constructorSeparator = constructorArgs.length > 0 ? ["--"] : [];

    const deployResult =
      await $`stellar contract deploy --wasm-hash ${wasmHash} --source-account ${adminSecret} --network ${NETWORK} ${constructorSeparator} ${constructorArgs}`.text();
    const contractId = deployResult.trim();
    deployed[contract.packageName] = contractId;
    console.log(`✅ ${contract.packageName} deployed: ${contractId}\n`);
  } catch (error) {
    console.error(`❌ Failed to deploy ${contract.packageName}:`, error);
    process.exit(1);
  }
}

// ── UltraHonk Verifier (pre-built WASM, deployed separately) ──────────────
const ULTRAHONK_WASM = 'contracts/ultrahonk-verifier/rs_soroban_ultrahonk.wasm';
const ULTRAHONK_VK = 'circuits/seed_verify/target/vk';

let ultrahonkId = deployed['ultrahonk-verifier'] || existingContractIds['ultrahonk-verifier'] || '';
const cangkulanId = deployed['cangkulan'] || existingContractIds['cangkulan'] || '';

if (
  (await Bun.file(ULTRAHONK_WASM).exists()) &&
  (await Bun.file(ULTRAHONK_VK).exists())
) {
  // Deploy UltraHonk verifier if not already deployed (or if cangkulan was just redeployed)
  const needsUltraHonk =
    force ||
    !ultrahonkId ||
    !(await testnetContractExists(ultrahonkId)) ||
    contracts.some((c) => c.packageName === 'cangkulan');

  if (needsUltraHonk) {
    console.log('Deploying UltraHonk verifier (Noir proof verifier)...');
    try {
      // Read VK as hex for constructor arg
      const vkHex = Buffer.from(await Bun.file(ULTRAHONK_VK).arrayBuffer()).toString('hex');
      const result =
        await $`stellar contract deploy --wasm ${ULTRAHONK_WASM} --source-account ${adminSecret} --network ${NETWORK} -- --vk_bytes ${vkHex}`.text();
      ultrahonkId = result.trim();
      deployed['ultrahonk-verifier'] = ultrahonkId;
      console.log(`✅ ultrahonk-verifier deployed: ${ultrahonkId}\n`);
    } catch (error) {
      console.warn('⚠️  UltraHonk verifier deployment failed (Noir mode will be unavailable):', error);
    }
  } else {
    deployed['ultrahonk-verifier'] = ultrahonkId;
    console.log(`✅ Using existing ultrahonk-verifier: ${ultrahonkId}\n`);
  }

  // Link UltraHonk verifier to cangkulan contract
  if (ultrahonkId && cangkulanId) {
    console.log('Linking UltraHonk verifier to cangkulan contract...');
    try {
      await $`stellar contract invoke --id ${cangkulanId} --source-account ${adminSecret} --network ${NETWORK} -- set_ultrahonk_verifier --verifier_addr ${ultrahonkId}`;
      console.log(`✅ cangkulan.set_ultrahonk_verifier → ${ultrahonkId}\n`);
    } catch (error) {
      console.warn('⚠️  Failed to link UltraHonk verifier:', error);
    }
  }
} else {
  console.log('ℹ️  Skipping UltraHonk verifier (WASM or VK not found)\n');
}


// ── Re-link ZK Verifier to cangkulan (handles deploy order race) ──────────
// When both cangkulan and zk-verifier are deployed in the same run,
// cangkulan's constructor may get the OLD verifier address.
// This ensures the new ZK verifier is always linked after deployment.
const newZkVerifierId = deployed['zk-verifier'] || existingContractIds['zk-verifier'] || '';
if (newZkVerifierId && cangkulanId && contracts.some(c => c.packageName === 'zk-verifier' || c.packageName === 'cangkulan')) {
  console.log('Linking ZK verifier to cangkulan contract...');
  try {
    await $`stellar contract invoke --id ${cangkulanId} --source-account ${adminSecret} --network ${NETWORK} -- set_verifier --new_verifier ${newZkVerifierId}`;
    console.log(`✅ cangkulan.set_verifier → ${newZkVerifierId}\n`);
  } catch (error) {
    console.warn('⚠️  Failed to link ZK verifier:', error);
  }
}

console.log("🎉 Deployment complete!\n");
console.log("Contract IDs:");
const outputContracts = new Set<string>();
for (const contract of contracts) outputContracts.add(contract.packageName);
if (shouldEnsureMock) outputContracts.add(mock.packageName);
for (const contract of allContracts) {
  if (!outputContracts.has(contract.packageName)) continue;
  const id = deployed[contract.packageName];
  if (id) console.log(`  ${contract.packageName}: ${id}`);
}
if (deployed['ultrahonk-verifier']) {
  console.log(`  ultrahonk-verifier: ${deployed['ultrahonk-verifier']}`);
}

const deploymentContracts = allContracts.reduce<Record<string, string>>((acc, contract) => {
  acc[contract.packageName] = deployed[contract.packageName] || "";
  return acc;
}, {});

// Include UltraHonk verifier if deployed
if (deployed['ultrahonk-verifier']) {
  deploymentContracts['ultrahonk-verifier'] = deployed['ultrahonk-verifier'];
}

const deploymentInfo = {
  mockGameHubId,
  contracts: deploymentContracts,
  network: NETWORK,
  rpcUrl: RPC_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
  wallets: {
    admin: walletAddresses.admin,
    player1: walletAddresses.player1,
    player2: walletAddresses.player2,
  },
  deployedAt: new Date().toISOString(),
};

await Bun.write('deployment.json', JSON.stringify(deploymentInfo, null, 2) + '\n');
console.log("\n✅ Wrote deployment info to deployment.json");

const contractEnvLines = allContracts
  .map((c) => `VITE_${c.envKey}_CONTRACT_ID=${deploymentContracts[c.packageName] || ""}`)
  .join("\n");

// UltraHonk verifier env line (not in workspace members, handled separately)
const ultrahonkEnvLine = deploymentContracts['ultrahonk-verifier']
  ? `\nVITE_ULTRAHONK_VERIFIER_CONTRACT_ID=${deploymentContracts['ultrahonk-verifier']}`
  : '';

const envContent = `# Auto-generated by deploy script
# Do not edit manually - run 'bun run deploy' (or 'bun run setup') to regenerate
# WARNING: This file contains secret keys. Never commit to git!

VITE_SOROBAN_RPC_URL=${RPC_URL}
VITE_NETWORK_PASSPHRASE=${NETWORK_PASSPHRASE}
${contractEnvLines}${ultrahonkEnvLine}

# Dev wallet addresses for testing
VITE_DEV_ADMIN_ADDRESS=${walletAddresses.admin}
VITE_DEV_PLAYER1_ADDRESS=${walletAddresses.player1}
VITE_DEV_PLAYER2_ADDRESS=${walletAddresses.player2}

# Dev wallet secret keys (WARNING: Never commit this file!)
VITE_DEV_ADMIN_SECRET=${adminKeypair.secret()}
VITE_DEV_PLAYER1_SECRET=${walletSecrets.player1}
VITE_DEV_PLAYER2_SECRET=${walletSecrets.player2}
`;

await Bun.write('.env', envContent + '\n');
console.log("✅ Wrote secrets to .env (gitignored)");

export { mockGameHubId, deployed };
