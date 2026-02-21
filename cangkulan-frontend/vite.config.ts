import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import inject from '@rollup/plugin-inject'
import path from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // Inject Buffer import into @aztec/bb.js browser ESM files that use bare
    // `Buffer` global.  Restricted to @aztec to avoid breaking CJS modules.
    inject({
      include: /node_modules[\\/]@aztec/,
      modules: { Buffer: ['buffer', 'Buffer'] },
    }),
  ],
  // Load .env files from the parent directory (repo root)
  envDir: '..',
  define: {
    global: 'globalThis',
    __LOG_LEVEL__: JSON.stringify(mode === 'production' ? 'warn' : 'debug'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      buffer: path.resolve(__dirname, './node_modules/buffer/')
    },
    dedupe: ['@stellar/stellar-sdk']
  },
  optimizeDeps: {
    include: ['@stellar/stellar-sdk', '@stellar/stellar-sdk/contract', '@stellar/stellar-sdk/rpc', '@stellar/freighter-api', 'buffer'],
    esbuildOptions: {
      define: {
        global: 'globalThis'
      }
    }
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        manualChunks: {
          // Heavy vendor chunk — loaded once, cached long-term
          'vendor-stellar': ['@stellar/stellar-sdk'],
          'vendor-react': ['react', 'react-dom'],
          'vendor-wallets': ['@creit-tech/stellar-wallets-kit'],
          // Animation library — only used in game view
          'vendor-motion': ['framer-motion'],
          // i18n runtime
          'vendor-intl': ['react-intl'],
          // Noir ZK prover — 3.6 MB, lazy-loaded only when Noir mode is selected
          'vendor-noir': ['@aztec/bb.js', '@noir-lang/noir_js'],
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      // Proxy local Stellar quickstart node to avoid CORS issues
      '/local-rpc': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/local-rpc/, '/soroban/rpc'),
      },
    },
  }
}))
