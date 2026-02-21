#!/usr/bin/env bun
/**
 * 🔐 Pedersen Mode Test — 224-byte BLS12-381 proof on Stellar Testnet
 *
 * Individual test: start game → commit seed → reveal seed (Pedersen 224B) → play tricks → finish.
 *
 * Usage:
 *   bun run test:pedersen
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
const root = join(import.meta.dir, '..');
try {
  execSync('bun run scripts/test-zk-modes.ts --mode pedersen', { cwd: root, stdio: 'inherit', timeout: 600_000 });
} catch { process.exit(1); }
