import { Buffer } from 'buffer';
import type { ProofMode, SeedData } from './types';
import { encryptForStorage, decryptFromStorage } from './storageEncryption';
import { log } from '@/utils/logger';

/**
 * Seed Storage — dual-write to sessionStorage + localStorage
 *
 * sessionStorage is primary (auto-clears on tab close for hygiene).
 * localStorage is a backup so closing a tab by accident doesn't lock
 * you out of the game — the seed can be recovered on a new tab.
 */

function makeKey(sessionId: number, player: string): string {
  return `cangkulan-seed:${sessionId}:${player}`;
}

export function saveSeedData(
  sessionId: number,
  player: string,
  seed: Uint8Array,
  blinding: Uint8Array,
  proofMode: ProofMode = 'pedersen',
): boolean {
  const key = makeKey(sessionId, player);
  const data: SeedData = {
    seed: Buffer.from(seed).toString('hex'),
    blinding: Buffer.from(blinding).toString('hex'),
    proofMode,
  };
  const json = JSON.stringify(data);
  const encrypted = encryptForStorage(key, json);
  let sessionOk = false;
  let localOk = false;
  try { sessionStorage.setItem(key, encrypted); sessionOk = true; } catch (e) {
    log.warn('[seedStorage] sessionStorage write failed:', e);
  }
  try { localStorage.setItem(key, encrypted); localOk = true; } catch (e) {
    log.warn('[seedStorage] localStorage write failed:', e);
  }
  if (!sessionOk && !localOk) {
    log.error('[seedStorage] CRITICAL: Both storage writes failed for seed data. Reveal will be impossible.');
  }
  return sessionOk || localOk;
}

export function loadSeedData(sessionId: number, player: string): SeedData | null {
  const key = makeKey(sessionId, player);
  // Try sessionStorage first (most current), fall back to localStorage
  const raw = sessionStorage.getItem(key) ?? localStorage.getItem(key);
  if (!raw) return null;
  try {
    const json = decryptFromStorage(key, raw);
    return JSON.parse(json) as SeedData;
  } catch {
    return null;
  }
}

export function clearSeedData(sessionId: number, player: string) {
  const key = makeKey(sessionId, player);
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
