#!/usr/bin/env bun
/**
 * 🌑 Noir SNARK Mode Test — Local contract & circuit proof generation
 *
 * Individual test: cargo test (cangkulan + zk-verifier) → nargo + bb.js proof generation.
 * Noir is tested locally because it requires the UltraHonk verifier contract.
 *
 * Usage:
 *   bun run test:noir
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
const root = join(import.meta.dir, '..');
try {
  execSync('bun run scripts/test-zk-modes.ts --mode noir', { cwd: root, stdio: 'inherit', timeout: 600_000 });
} catch { process.exit(1); }
