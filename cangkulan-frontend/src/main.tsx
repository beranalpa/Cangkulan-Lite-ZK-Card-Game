import { Buffer } from 'buffer';
// Ensure Buffer is globally available for libraries that reference it
// without importing (e.g. @aztec/bb.js uses bare `Buffer` in browser builds).
// Unconditional: browser extensions (MetaMask SES) may inject an incomplete
// Buffer polyfill that lacks BigInt methods like writeBigUInt64BE.
globalThis.Buffer = Buffer;

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
)
