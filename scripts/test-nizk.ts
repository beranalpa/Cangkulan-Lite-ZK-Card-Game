#!/usr/bin/env bun
/**
 * #️⃣  Hash-NIZK Mode Test — 64-byte proof on Stellar Testnet
 *
 * Individual test: start game → commit seed → reveal seed (NIZK 64B) → play tricks → finish.
 *
 * Usage:
 *   bun run test:nizk
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
const root = join(import.meta.dir, '..');
try {
  execSync('bun run scripts/test-zk-modes.ts --mode nizk', { cwd: root, stdio: 'inherit', timeout: 600_000 });
} catch { process.exit(1); }
