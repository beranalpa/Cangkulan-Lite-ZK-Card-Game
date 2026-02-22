/**
 * Storage Obfuscation — protect sensitive data in localStorage/sessionStorage.
 *
 * Uses keccak256-CTR: a random 16-byte IV is generated per encryption and a
 * keccak256-based key stream is derived from (storageKey || salt || IV || counter).
 * This is NOT equivalent to AES-GCM (no authentication tag), but it provides
 * real cryptographic-strength confidentiality against offline inspection of
 * localStorage. It does NOT protect against active XSS (an attacker with code
 * execution can call decryptFromStorage directly).
 *
 * Trade-offs vs. Web Crypto AES-GCM:
 *  - Synchronous API (callers don't need refactoring)
 *  - No authentication tag (integrity not guaranteed)
 *  - Uses keccak256 already bundled for ZK proof construction
 */

import { keccak256 } from 'js-sha3';

const CIPHER_SALT = 'cangkulan-zk-storage-v2';

/**
 * Derive a cryptographic key stream using keccak256-CTR.
 * Each 32-byte block is H(storageKey || salt || iv || blockIndex).
 */
function deriveKeyStream(storageKey: string, iv: Uint8Array, length: number): Uint8Array {
  const stream = new Uint8Array(length);
  const prefix = new TextEncoder().encode(storageKey + ':' + CIPHER_SALT);
  const blocks = Math.ceil(length / 32);
  for (let block = 0; block < blocks; block++) {
    // Block counter as 4 big-endian bytes
    const ctr = new Uint8Array(4);
    ctr[0] = (block >>> 24) & 0xff;
    ctr[1] = (block >>> 16) & 0xff;
    ctr[2] = (block >>> 8) & 0xff;
    ctr[3] = block & 0xff;
    // H(prefix || iv || ctr)
    const input = new Uint8Array(prefix.length + iv.length + 4);
    input.set(prefix, 0);
    input.set(iv, prefix.length);
    input.set(ctr, prefix.length + iv.length);
    const hash = keccak256.arrayBuffer(input);
    const hashBytes = new Uint8Array(hash);
    const offset = block * 32;
    const copyLen = Math.min(32, length - offset);
    stream.set(hashBytes.subarray(0, copyLen), offset);
  }
  return stream;
}

/**
 * Encrypt a JSON string before storage.
 * Returns a base64-encoded string prefixed with 'enc2:' (v2 format with random IV).
 * Layout: enc2:<base64(iv(16) || ciphertext)>
 */
export function encryptForStorage(storageKey: string, plaintext: string): string {
  const bytes = new TextEncoder().encode(plaintext);
  // Random 16-byte IV — ensures identical plaintexts produce different ciphertexts
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const keyStream = deriveKeyStream(storageKey, iv, bytes.length);
  const output = new Uint8Array(16 + bytes.length);
  output.set(iv, 0);
  for (let i = 0; i < bytes.length; i++) {
    output[16 + i] = bytes[i] ^ keyStream[i];
  }
  // Convert to base64
  let binary = '';
  for (let i = 0; i < output.length; i++) {
    binary += String.fromCharCode(output[i]);
  }
  return 'enc2:' + btoa(binary);
}

/**
 * Decrypt a storage value. Handles:
 *  - 'enc2:' prefix (v2 keccak256-CTR with random IV)
 *  - 'enc:' prefix (legacy v1 — migrate on next write)
 *  - Plain JSON (legacy — return as-is)
 */
export function decryptFromStorage(storageKey: string, stored: string): string {
  if (stored.startsWith('enc2:')) {
    const b64 = stored.slice(5);
    const binary = atob(b64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }
    if (data.length < 16) return stored; // corrupt
    const iv = data.subarray(0, 16);
    const cipher = data.subarray(16);
    const keyStream = deriveKeyStream(storageKey, iv, cipher.length);
    const plain = new Uint8Array(cipher.length);
    for (let i = 0; i < cipher.length; i++) {
      plain[i] = cipher[i] ^ keyStream[i];
    }
    return new TextDecoder().decode(plain);
  }
  if (stored.startsWith('enc:')) {
    // Legacy v1 format — decrypt with old method and data will be
    // re-encrypted with v2 on next write. Use zero IV for backward compat.
    const b64 = stored.slice(4);
    const binary = atob(b64);
    const cipher = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      cipher[i] = binary.charCodeAt(i);
    }
    // Legacy v1 used deterministic zero-IV key stream with old salt
    const legacyStream = deriveKeyStreamLegacy(storageKey, cipher.length);
    const plain = new Uint8Array(cipher.length);
    for (let i = 0; i < cipher.length; i++) {
      plain[i] = cipher[i] ^ legacyStream[i];
    }
    return new TextDecoder().decode(plain);
  }
  // Plain JSON — return as-is for backwards compat
  return stored;
}

/**
 * Legacy v1 key derivation (FNV-1a) — kept only for reading old enc: data.
 * @internal
 */
function deriveKeyStreamLegacy(storageKey: string, length: number): Uint8Array {
  const combined = storageKey + ':' + 'cangkulan-zk-storage-v1';
  const stream = new Uint8Array(length);
  let h = 0x811c9dc5;
  for (let i = 0; i < length; i++) {
    h ^= combined.charCodeAt(i % combined.length);
    h = Math.imul(h, 0x01000193);
    h ^= (i * 0x9e3779b9);
    stream[i] = (h >>> 0) & 0xff;
  }
  return stream;
}
