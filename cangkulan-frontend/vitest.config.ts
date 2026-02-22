/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      buffer: path.resolve(__dirname, './node_modules/buffer/'),
    },
  },
  define: {
    global: 'globalThis',
    __LOG_LEVEL__: JSON.stringify('warn'),
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    testTimeout: 30_000,
  },
});
