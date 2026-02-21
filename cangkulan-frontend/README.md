# Cangkulan Lite — Frontend

React 19 + TypeScript + Vite 7 frontend for the Cangkulan on-chain card game on Stellar.

## Quick Start

```bash
# From repo root
bun run dev:game cangkulan
# → http://localhost:3007

# Or directly
cd cangkulan-frontend
bun install
bun run dev
```

## Features

- **4 Wallet Integrations** — Freighter, HOT Wallet, Hana, Klever via Stellar Wallets Kit (all support Soroban `signAuthEntry`)
- **Dev Mode** — Pre-funded testnet wallets with player switching
- **Tutorial Mode** — Play vs Bot locally (no wallet or contract needed)
- **Spectator View** — Read-only game observation with LIVE indicator
- **Game Replay** — Step-by-step trick replay with play/pause/speed controls
- **Dark/Light Theme** — Toggle with localStorage persistence
- **Sound Effects** — Web Audio API synthesized sounds (6 types, mute toggle)
- **Emoji Reactions** — 8 emojis with BroadcastChannel cross-tab delivery + floating animations
- **QR Code Invites** — Pure TypeScript QR generator for game invite links
- **On-Chain Game History** — Persistent per-player history stored on-chain (max 50 games, 120-day TTL). W/L/D stats, streak tracking, tricks won/lost, opponent address, and time-ago display via `get_player_history` contract call
- **On-Chain Analytics** — Game statistics dashboard via Soroban event indexing (games played, outcomes, leaderboard, activity timeline)
- **Progressive Score** — Animated counter with comparative progress bar
- **Timeout Controls** — Circular timer visualization + auto-resolve
- **Canvas Confetti** — 120-particle confetti + card sweep overlay on win
- **Card Deal Animation** — Full-screen dealing animation on game start
- **7-Slide Onboarding** — First-time walkthrough (rules, ZK modes, contracts, setup)
- **Responsive Design** — Mobile-friendly bottom navigation, collapsible sections
- **Logo Branding** — Custom Cangkulan Lite logo in header, connection screen, favicon
- **Code Splitting** — Lazy-loaded pages + vendor chunk separation (initial load ~264KB gzipped, down from ~769KB)
- **Production Logging** — Log-level system; debug/info stripped in production builds
- **Seed Recovery** — Dual-write sessionStorage + localStorage for ZK seed persistence
- **ZK Proof Modes** — Pedersen+Sigma (BLS12-381, 224B, on-chain ✅), Noir UltraKeccakHonk (~14KB, in-browser proof; on-chain pending Soroban budget increase)
- **ELO Leaderboard** — On-chain ELO ratings with tier badges, win streaks, and sorted rankings
- **Multiplayer Lobby** — WebSocket real-time lobby: presence, matchmaking, invites, chat
- **Internationalization** — Full i18n via react-intl (English + Bahasa Indonesia, 190+ keys)

## Pages & Routes

| Route | Hash | Description |
|-------|------|-------------|
| Home | `#/home` | Dashboard — quick stats + play/tutorial/rules/history |
| Game | `#/game/:sessionId?` | Full game flow (create → seed → play → complete) |
| Spectate | `#/spectate/:sessionId` | Read-only game observation |
| Lobby | `#/lobby` | Discover live games on-chain |
| Tutorial | `#/tutorial` | Play vs Bot |
| History | `#/history` | Full game history + streaks + stats |
| Stats | `#/stats` | On-chain analytics dashboard |
| Leaderboard | `#/leaderboard` | ELO rankings with tier badges |
| Rules | `#/rules` | Complete rules guide |
| Architecture | `#/architecture` | Interactive Mermaid architecture diagram |
| Demo | `#/demo` | Feature showcase overview |
| Settings | `#/settings` | Sound, theme, data management, contract links |

## Project Structure

```
src/
├── pages/           # 9 routed page components
├── components/      # Shared UI (Layout, ConnectionScreen, NavigationBar, etc.)
├── games/cangkulan/ # 45 game-specific files (components, services, tests, helpers)
├── services/        # Wallet + RPC services
├── hooks/           # useWallet, useHashRouter
├── store/           # Zustand global state
├── types/           # TypeScript type definitions
└── utils/           # Constants, auth helpers, logger, runtime config
```

## Game Components (45 files)

| Component | Purpose |
|-----------|---------|
| `CangkulanGame` | Phase orchestrator — manages game lifecycle + polling |
| `CreatePhase` | Multi-sig game creation + QR invite + auth entry import |
| `SeedPhase` | Multi-mode ZK seed commit & reveal UI |
| `PlayingPhase` | Card selection (tap/drag), suit matching, cangkul button |
| `CompletePhase` | Win/loss display, confetti, shuffle verification |
| `GameTable` | Visual table — draw pile, flipped card, trick cards |
| `PlayingCard` | Card rendering with suit symbols |
| `SpectatorView` | Read-only observation mode |
| `TutorialMode` | Play vs Bot — local Fisher-Yates, no contract |
| `GameReplay` | Step-by-step trick replay with speed control |
| `EmojiReactions` | Off-chain emoji chat (8 emojis) |
| `CanvasConfetti` | Win celebration (120 particles + card sweep) |
| `CardDealAnimation` | Full-screen deal animation |
| `ProgressiveScore` | Animated score counter + progress bar |
| `TimeoutControls` | Circular timer, auto-resolve |
| `QRCode` | Pure TypeScript QR code generator (Reed-Solomon) |
| `GameHistoryPanel` | Expandable past-games list |
| `GameLoadingSkeleton` | Loading state skeleton |
| `GameLobby` | On-chain game list + WS real-time lobby |
| `ZkVerificationBadge` | ZK proof mode indicator badge |
| `cardAnimations` | Framer Motion card animation helpers |
| `cardHelpers` | Card value/suit utility functions |
| `soundHelpers` | Web Audio API synth sound effects |
| `cangkulanService` | Soroban contract interaction service |
| `cryptoHelpers` | keccak256 + ZK seed crypto utilities |
| `noirProver` | Browser Noir UltraKeccakHonk prover |
| `noirUtils` | Noir blake2s + proof format utilities |
| `seedStorage` | Dual-write seed persistence (session+local) |
| `playCommitStorage` | Play commit/reveal storage |
| `gameHistory` | On-chain game history fetch helper |
| `useCangkulanActions` | React hook — game action dispatchers |
| `useSmartPolling` | Adaptive polling with exponential backoff |
| `useTurnNotification` | Turn notification sound + visual cue |
| `types` | TypeScript type definitions (GameState, etc.) |
| `bindings` | Auto-generated Soroban contract bindings |
| `cangkulanService.test` | Service layer unit tests (20 tests) |
| `cryptoHelpers.test` | Crypto helper unit tests (83 tests) |
| `zkProofModes.test` | ZK proof mode tests (58 tests) |

## Environment Variables

Set in the root `.env` (loaded via `envDir: '..'` in Vite config):

| Variable | Description |
|----------|-------------|
| `VITE_CANGKULAN_CONTRACT_ID` | Cangkulan contract address |
| `VITE_ZK_VERIFIER_CONTRACT_ID` | ZK Verifier contract address |
| `VITE_MOCK_GAME_HUB_CONTRACT_ID` | Game Hub contract address |
| `VITE_SOROBAN_RPC_URL` | Soroban RPC endpoint |
| `VITE_NETWORK_PASSPHRASE` | Stellar network passphrase |
| `VITE_DEV_PLAYER1_ADDRESS` | Dev mode Player 1 address |
| `VITE_DEV_PLAYER2_ADDRESS` | Dev mode Player 2 address |
| `VITE_DEV_PLAYER1_SECRET` | Dev mode Player 1 secret key |
| `VITE_DEV_PLAYER2_SECRET` | Dev mode Player 2 secret key |

## Tech Stack

| Technology | Version |
|------------|---------|
| React | 19 |
| TypeScript | 5.9 |
| Vite | 7.2 |
| TailwindCSS | 4 |
| Zustand | 5 |
| Stellar Wallets Kit | 2.0-beta |
| js-sha3 | 0.9 (keccak256) |

## Build

```bash
bun run build    # Production build → dist/
```

The build uses code splitting with lazy-loaded routes and vendor chunk separation:

| Chunk | Size (gzip) | Loaded |
|-------|-------------|--------|
| `index.js` (core app) | ~210 KB | Always (initial) |
| `vendor-react.js` | ~4 KB | Always (initial) |
| `vendor-wallets.js` | ~34 KB | Always (initial) |
| CSS | ~16 KB | Always (initial) |
| `vendor-stellar.js` | ~267 KB | On demand (game/lobby/stats) |
| `CangkulanGame.js` | ~52 KB | On demand (game page) |
| `StatsPage.js` | ~4 KB | On demand (stats page) |
| Other pages | ~2-4 KB each | On demand |

**Initial load: ~264 KB gzipped** (down from ~769 KB single bundle).

## License

MIT
