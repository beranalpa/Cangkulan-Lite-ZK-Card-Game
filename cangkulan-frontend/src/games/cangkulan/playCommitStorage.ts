import { Buffer } from 'buffer';
import { encryptForStorage, decryptFromStorage } from './storageEncryption';
import { log } from '@/utils/logger';

interface PlayCommitData {
  cardId: number;
  salt: string; // hex-encoded 32-byte salt (legacy) or blinding (ZK mode)
  zkMode?: boolean; // true = Pedersen commitment, false/undefined = keccak256 hash
}

/**
 * Play Commit Storage — dual-write sessionStorage + localStorage
 *
 * Same recovery pattern as seedStorage: sessionStorage is primary,
 * localStorage acts as backup so a closed tab doesn't lose the commit
 * data needed for the reveal phase.
 */

const STORAGE_PREFIX = 'cangkulan-play-commit';

function storageKey(sessionId: number, player: string): string {
  return `${STORAGE_PREFIX}:${sessionId}:${player}`;
}

export function savePlayCommit(sessionId: number, player: string, cardId: number, salt: Uint8Array, zkMode: boolean = false): boolean {
  const key = storageKey(sessionId, player);
  const data: PlayCommitData = {
    cardId,
    salt: Buffer.from(salt).toString('hex'),
    zkMode,
  };
  const json = JSON.stringify(data);
  const encrypted = encryptForStorage(key, json);
  let sessionOk = false;
  let localOk = false;
  try { sessionStorage.setItem(key, encrypted); sessionOk = true; } catch (e) {
    log.warn('[playCommitStorage] sessionStorage write failed:', e);
  }
  try { localStorage.setItem(key, encrypted); localOk = true; } catch (e) {
    log.warn('[playCommitStorage] localStorage write failed:', e);
  }
  if (!sessionOk && !localOk) {
    log.error('[playCommitStorage] CRITICAL: Both storage writes failed for play commit. Reveal will be impossible.');
  }
  return sessionOk || localOk;
}

export function loadPlayCommit(sessionId: number, player: string): PlayCommitData | null {
  const key = storageKey(sessionId, player);
  const raw = sessionStorage.getItem(key) ?? localStorage.getItem(key);
  if (!raw) return null;
  try {
    const json = decryptFromStorage(key, raw);
    return JSON.parse(json) as PlayCommitData;
  } catch {
    return null;
  }
}

export function clearPlayCommit(sessionId: number, player: string) {
  const key = storageKey(sessionId, player);
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
