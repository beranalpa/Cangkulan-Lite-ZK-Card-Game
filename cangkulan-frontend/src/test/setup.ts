import '@testing-library/jest-dom/vitest';

// Polyfill crypto.getRandomValues for happy-dom if missing
if (typeof globalThis.crypto === 'undefined') {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

// Polyfill Buffer
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
