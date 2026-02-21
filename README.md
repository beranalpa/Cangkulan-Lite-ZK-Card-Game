# Cangkulan Lite — ZK Card Game on Stellar

[![Stellar](https://img.shields.io/badge/Stellar-Soroban-blue?logo=stellar)](https://stellar.org)
[![ZK Proofs](https://img.shields.io/badge/ZK-4%20Proof%20Modes-blueviolet)](#zk-verification-modes)
[![Tests](https://img.shields.io/badge/tests-286%2B%20passing-brightgreen)](#run-tests)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Live](https://img.shields.io/badge/play-live%20demo-orange)](https://cangkulan.hoshiyomi.my.id)

> **Stellar Hacks: ZK Gaming** hackathon submission

Cangkulan Lite is a two-player Indonesian trick-taking card game built on Stellar's Soroban smart contracts. It is a **trustless simultaneous-decision system** — using zero-knowledge seed commitment for **provably fair card shuffling**, commit-reveal protocols for **mempool front-running resistance**, and on-chain ZK verification for **trustless rule enforcement** — ensuring neither player can cheat, even without a trusted server or dealer.

> **Design Philosophy:** ZK is not a feature — it is the architecture. Without ZK-verified seed commitment, one player could control the shuffle. Without commit-reveal, a player could observe the opponent's pending transaction in the mempool and react. The ZK system enforces **verifiable fairness**, not card secrecy — Soroban's transparent storage model means on-chain state is publicly readable, which is why the commit-reveal protocol prevents front-running rather than hiding information permanently. All game-critical logic is enforced on-chain.

### Highlights

| | |
|---|---|
| **5 Smart Contracts** | Cangkulan game, ZK Verifier (4 modes), UltraHonk Verifier, Leaderboard, Game Hub |
| **4 ZK Proof Modes** | Pedersen+Sigma, Hash-based NIZK, Noir UltraKeccakHonk, Ring Sigma, Cangkul Hand |
| **286+ Tests Passing** | 103 on-chain (cargo test) + 183 frontend (Vitest) |
| **Full Multiplayer** | WebSocket rooms, matchmaking queue, spectator view, room chat |
| **AI Opponent** | Easy/Medium/Hard bot with ephemeral Stellar keypair — plays on-chain |
| **PWA + i18n** | Installable, offline-ready, English + Bahasa Indonesia |

## Demo

**Video:** [Watch on YouTube](https://www.youtube.com/watch?v=YBidqWeHZF4)

[![Cangkulan Lite Demo](https://img.youtube.com/vi/YBidqWeHZF4/maxresdefault.jpg)](https://www.youtube.com/watch?v=YBidqWeHZF4)

**Live Game:** [https://cangkulan.hoshiyomi.my.id](https://cangkulan.hoshiyomi.my.id)

**Run Locally:** `bun run dev:game cangkulan` (see [Getting Started](#getting-started))

---

## How It Works

### The Game

Cangkulan is a traditional Indonesian card game. Two players try to empty their hand first by playing tricks.

- **36-card deck** — 4 suits (♠♥♦♣) × values 2–10
- **5 cards** dealt to each player, 26 go to the draw pile
- Each trick: a card is flipped from the pile — its suit is the trick suit
- Players must follow suit if they can; if they can't, they call "cangkul" (cannot follow) and draw a penalty card
- **Winner (priority order):**
  1. **Habis duluan** — first to empty their hand while opponent still has cards wins instantly
  2. **Most tricks** — when draw pile runs out, most tricks won wins
  3. **Fewer cards** — tie-break if tricks are equal
  4. **Lower total card value** — final tie-break; draw if all equal

### The ZK Mechanic

The critical problem in on-chain card games: **who shuffles the deck?** If a server or single player shuffles, they can cheat. Cangkulan Lite solves this with a commit-reveal ZK scheme:

```
┌─────────────────────────────────────────────────────────────┐
│                   ZK Seed Commitment Flow                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. COMMIT PHASE (player chooses proof mode)                │
│                                                             │
│     [Pedersen — default, fast]                              │
│       seed_hash  = keccak256(seed)                          │
│       C          = Fr(seed_hash)·G + Fr(blinding)·H         │
│       commit_hash = keccak256(C_bytes)                      │
│                                                             │
│     [Noir — optional, UltraKeccakHonk]                      │
│       seed_hash  = blake2s(seed)                            │
│       commit_hash = keccak256(seed_hash)                    │
│                                                             │
│     → commit_hash stored on-chain, seed remains secret      │
│                                                             │
│  2. REVEAL PHASE                                            │
│     [Pedersen] 224-byte submission (BLS12-381)               │
│       C(96) + R(96) + z_r(32) = 224 bytes to contract       │
│       Contract extracts C, sends 128B sigma proof to        │
│       ZK verifier: z_r·H == R + e·D (blinding knowledge)   │
│     [Noir] ~14KB UltraKeccakHonk proof (blake2s circuit)    │
│       Proof generated client-side via bb.js                 │
│       Contract auto-routes by proof size                    │
│     → ZK Verifier validates → seed confirmed binding        │
│                                                             │
│  3. SHUFFLE                                                 │
│     combined_seed = keccak256(commit₁ ∥ commit₂ ∥ session)  │
│     → Deterministic PRNG seeded with combined_seed          │
│     → Fisher-Yates shuffle produces the deck order          │
│     → Both players contributed entropy — neither controls   │
│       the outcome alone                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Why this is meaningful ZK:** The seed commitment is not cosmetic — it is the *only* way the deck gets shuffled. Without both players committing and revealing valid seeds (verified on-chain by the ZK verifier contract), the game cannot proceed. Players can choose their proof mode before committing:

- **Pedersen+Sigma (default):** Fast BLS12-381 Schnorr proof (224 bytes), generated instantly client-side
- **Noir UltraKeccakHonk (optional):** General-purpose Noir circuit proof (~14KB), generated in-browser via bb.js (~10–30s)

Both modes provide the same security guarantees:

- **Fairness:** No single party controls the shuffle
- **Verifiability:** Anyone can recompute the shuffle from the on-chain commits
- **Non-repudiation:** Committed seeds are binding — players cannot change them after seeing the opponent's commit

### Noir Circuit Integration (UltraKeccakHonk)

In addition to the Pedersen+Sigma proof system, the game supports **Noir circuit-based ZK proofs** using UltraKeccakHonk:

```
┌─────────────────────────────────────────────────────────────┐
│              Noir UltraKeccakHonk Proof Flow                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Circuit: circuits/seed_verify/src/main.nr                  │
│  Proves TWO properties in zero knowledge:                   │
│    1. blake2s(seed) == seed_hash  (preimage knowledge)      │
│    2. seed[0..4] != [0,0,0,0]    (in-circuit entropy check) │
│                                                             │
│  1. Player generates seed, computes blake2s(seed)           │
│  2. Noir circuit compiled to ACIR (nargo compile)           │
│  3. UltraKeccakHonk proof generated (bb.js 0.87.0)         │
│  4. Proof (~14KB) generated in-browser (~10-30s)            │
│  5. Contract auto-detects Noir proof (size > 4KB)           │
│  6. Routes to UltraHonk verifier contract on-chain          │
│  7. Verifier checks proof against stored verification key   │
│                                                             │
│  Proof modes (auto-detected by size):                       │
│    224 bytes  → Pedersen+Sigma (BLS12-381, default)         │
│     64 bytes  → Hash-based PoK (legacy)                     │
│   >4KB bytes  → Noir UltraKeccakHonk                        │
│                                                             │
│  Tools: nargo 1.0.0-beta.9, @aztec/bb.js 0.87.0            │
│  Verifier: rs-soroban-ultrahonk (64KB WASM)                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

> **✅ Noir On-Chain Verification — Local Node**
>
> The UltraHonk verifier contract is **deployed** and functional, but because UltraKeccakHonk proof verification uses **~215M CPU instructions**, it exceeds Soroban's public Testnet per-tx CPU budget (~100M limit). Thus, full on-chain Noir verification is played exclusively on a **Local Node** running with unlimited CPU (`--limits unlimited`).
>
> **How Noir mode works on Local Node:**
> 1. Noir proof is generated in-browser (~14KB, ~10–30s) proving `blake2s(seed) == hash` AND entropy check
> 2. Proof is submitted on-chain and **verified by the UltraHonk verifier contract** via a split-tx architecture.
> 3. Full SNARK verification — strongest cryptographic guarantee available
>
> **Purpose-driven ZK selection:**
> - **VS AI** → Pedersen+Sigma (auto) — fast EC commitment, ~1.5M CPU
> - **Multiplayer (Testnet)** → Pedersen (default) or NIZK (quick option) — fully within public network limits
> - **Local Node / Dev Mode** → All 3 modes (NIZK, Pedersen, Noir) — including full Noir on-chain verification

Generate a Noir proof:
```bash
cd circuits/seed_verify
npm install
node generate-proof.mjs   # random seed, or provide hex
```

### Threat Model

Without ZK, a malicious player or infrastructure operator could:

| Threat | Attack Vector | ZK Mitigation |
|--------|--------------|----------------|
| **Rigged shuffle** | Dealer or single player controls deck order | Dual-seed commitment — neither player controls the combined PRNG seed |
| **Front-running** | Observe opponent's pending tx in mempool, choose card reactively | Commit-reveal — both players commit before either reveals |
| **Fake rule compliance** | Claim "can't follow suit" while holding a matching card | Cangkul Hand Proof (Mode 8) — ZK proves suit exclusion on-chain |
| **Invalid card play** | Play a card not in hand, or not matching trick suit | Ring Sigma (Mode 7) — ZK proves card-in-valid-set |
| **Seed manipulation** | Change seed after seeing opponent's commitment | Pedersen+Sigma — binding commitment; ZK proof verifies knowledge before reveal |
| **Replay / stale actions** | Resubmit old transactions to disrupt state | Monotonic action nonce + ledger deadline timeout |
| **Lobby manipulation** | Compromise WebSocket server to affect outcomes | WS server is stateless relay — all game logic enforced on-chain |

> **Key: this system removes ALL trust assumptions.** No trusted dealer, no trusted server, no trusted opponent. The only authority is the smart contract + ZK verifier.

### Why ZK is Essential (Not Optional)

In Cangkulan, ZK proofs solve a **fundamental problem** that cannot be solved any other way on a public blockchain:

```
┌─────────────────────────────────────────────────────────────┐
│         The Problem: Who Controls the Card Shuffle?         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Without ZK:                                                │
│  • Server shuffles → server can cheat                       │
│  • Player 1 shuffles → Player 1 can cheat                   │
│  • Random oracle → no randomness oracle on Soroban          │
│                                                             │
│  With ZK Seed Commitment:                                   │
│  • Both players contribute entropy (seed₁ + seed₂)          │
│  • Seeds are COMMITTED before either is revealed            │
│  • ZK proof verifies the seed is BINDING — once committed,  │
│    the player CANNOT change it after seeing the opponent's   │
│  • Combined seed deterministically shuffles the deck        │
│  • NEITHER player controls the shuffle alone                │
│                                                             │
│  → ZK IS the fairness mechanism. Remove it, and the game    │
│    cannot be played trustlessly between strangers.           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**What each ZK component provides:**

| ZK Component | What It Proves | Why It's Necessary |
|---|---|---|
| **Seed Commitment** (Modes 1-4) | Player knows a seed that matches the committed hash | Prevents shuffle manipulation — seeds are bound before reveal |
| **Pedersen+Sigma** (Mode 4, default) | Seed knowledge via BLS12-381 Schnorr sigma protocol (224 bytes submitted, 128-byte sigma proof verified on-chain) | Information-theoretic hiding — commitment reveals nothing about the seed |
| **Ring Sigma** (Mode 7) | Player holds at least one card from a valid set | On-chain rule compliance — proves card-in-hand without trusted server |
| **Cangkul Hand Proof** (Mode 8) | Player has NO card matching the trick suit | Proves "must draw" claim — prevents false cangkul calls |
| **Commit-Reveal Card Play** | Neither player sees opponent's choice before committing | Anti-front-running — simultaneous action without a mediator |
| **Noir Circuit** (UltraKeccakHonk) | Seed preimage + entropy constraint in zero-knowledge | General-purpose ZK — extensible to arbitrary game logic |

> **Key distinction:** The ZK system provides **verifiable fairness** (provably correct game mechanics) rather than **card secrecy** (hiding information from chain observers). Soroban storage is transparent by design — the commit-reveal protocol prevents mempool front-running during gameplay, not permanent information hiding. This is the correct security model for an on-chain card game: enforce rules trustlessly, make everything auditable.

### End-to-End Game Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Trustless Game Pipeline                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────────┐   │
│  │  CREATE   │───▶│ SEED COMMIT  │───▶│ SEED REVEAL  │───▶│   SHUFFLE   │   │
│  │ (on-chain)│    │  (ZK bound)  │    │ (ZK verified)│    │(deterministic)│ │
│  └──────────┘    └──────────────┘    └──────────────┘    └──────┬──────┘   │
│                                                                 │         │
│       ┌─────────────────────────────────────────────────────────┘         │
│       ▼                                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                 │
│  │ CARD COMMIT  │───▶│ CARD REVEAL  │───▶│TRICK RESOLVE │───▶ repeat...   │
│  │(anti-frontrun)│   │(ZK validated)│    │ (on-chain)   │                 │
│  └──────────────┘    └──────────────┘    └──────────────┘                 │
│                                                                           │
│  Every arrow = on-chain transaction. Every box = smart contract call.     │
│  No server, no dealer, no trusted third party at any step.                │
│                                                                           │
│  ZK checkpoints: Seed commit (binding) → Seed reveal (verified) →        │
│    Card commit (front-running resistance) → Card reveal (rule compliance) │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### ZK Verification Modes

The ZK Verifier contract supports **4 verification modes**, auto-detected by proof byte length. Each mode exists because different game actions have different cryptographic requirements:

| # | Mode | Curve / Hash | Proof Size | Use Case | Testnet |
|---|------|-------------|-----------|---------|---------|
| 2 | Hash-based NIZK PoK | keccak256 | 64 B | Cangkulan seed Fiat-Shamir binding | ✅ |
| 4 | Pedersen+Sigma | BLS12-381 | 224 B (128 B to verifier) | EC seed commitment (**AI default**) | ✅ |
| 7 | Ring Sigma Card Play | BLS12-381 | variable | ZK card-in-hand compliance | ✅ |
| 8 | Cangkul Hand Proof | BLS12-381 | 228 B | ZK suit exclusion (must draw) | ✅ |
| — | Noir UltraKeccakHonk | BN254 | ~14 KB | SNARK seed proof (**Local**) | ⚠️ (Local) |

Most modes are fully verified on-chain today on public Testnet. Noir requires a Local Node for unlimited CPU.

**Why multiple modes?** Each mode represents a different point in the speed/security/generality trade-off:
- **Mode 2** (hash-based NIZK): Minimal on-chain cost, sufficient for commitment binding
- **Mode 4** (Pedersen+Sigma): Information-theoretic hiding, the AI and MP default on Testnet
- **Modes 7-8** (Ring/Cangkul): Game-specific ZK — card play compliance and suit exclusion
- **Noir** (UltraKeccakHonk): Full SNARK verification — requires Local Node with unlimited CPU

### Simultaneous Card Play (Front-Running Resistance)

During gameplay, card plays use commit-reveal to guarantee **simultaneous action** — neither player can see the opponent's choice before committing their own:

```
┌─────────────────────────────────────────────────────────────┐
│          Simultaneous Card Play (Commit-Reveal)             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. COMMIT PHASE                                            │
│     Both players choose their card secretly:                │
│     commit_hash = keccak256(card_id_u32_be ∥ salt_32)       │
│     → Hash stored on-chain, card choice remains hidden      │
│     → CANNOT_FOLLOW_SENTINEL (0xFFFFFFFF) for "cangkul"     │
│                                                             │
│  2. REVEAL PHASE                                            │
│     Both players reveal card_id + salt:                     │
│     → Contract verifies keccak256(card_id ∥ salt) == commit │
│     → Card is validated (suit matching, in hand, etc.)      │
│     → Trick resolves only after both cards are revealed     │
│                                                             │
│  Result: Neither player can react to the opponent's choice  │
│  — both commit simultaneously, then reveal simultaneously.  │
│                                                             │
│  ⚠️ Transparency Note: Soroban storage is publicly          │
│  readable. The commit-reveal protocol prevents front-       │
│  running (seeing the opponent's move before choosing),      │
│  NOT permanent card secrecy. After both reveals, all        │
│  information is on-chain and verifiable by anyone.          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

This provides **mempool front-running resistance** — a critical property for on-chain games. Even if an observer monitors pending transactions, they cannot determine a player's card choice from the commit hash. The salt ensures commit hashes are unique and non-predictable.

### Why Serverless Multiplayer Needs ZK

Traditional multiplayer games rely on a trusted server to:
1. Shuffle the deck secretly
2. Enforce rules ("you must follow suit")
3. Sequence player actions fairly
4. Prevent cheating

On a public blockchain, there is **no server**. The smart contract is the only authority — but it cannot keep secrets (state is transparent) and it cannot enforce action ordering across players (transactions arrive asynchronously).

ZK + commit-reveal solves both problems:
- **No secrets needed:** ZK commitments are *binding* — seeds/cards are locked before reveal, so there's nothing to hide
- **Asynchronous but fair:** Commit-reveal decouples "choosing" from "revealing" — players choose independently, then both reveal, making transaction ordering irrelevant

This makes Cangkulan a **fully serverless multiplayer game** — the only infrastructure is the Stellar network itself. The WebSocket lobby is convenience, not a trust dependency.

---

## Deployed Contracts (Stellar Testnet)

| Contract | Address | Explorer |
|----------|---------|----------|
| **Cangkulan Lite** | `CABH7K6ZJNWKSLUIT4DYQZYLLWPKSRJXL6ECGBL3TMNZMY6V6M6BAOTS` | [View](https://stellar.expert/explorer/testnet/contract/CABH7K6ZJNWKSLUIT4DYQZYLLWPKSRJXL6ECGBL3TMNZMY6V6M6BAOTS) |
| **ZK Verifier** (4 modes) | `CBNKLVT3OVRERX2DFW74JJEZNLYTGJU5SXQA22M3KADWBQBC5EUROGA5` | [View](https://stellar.expert/explorer/testnet/contract/CBNKLVT3OVRERX2DFW74JJEZNLYTGJU5SXQA22M3KADWBQBC5EUROGA5) |
| **UltraHonk Verifier** | `CADH3QNOWXAGP2SCT2EO66CFE2Z454VZNNAJGV3DBY3FMHDRHYWVM33F` | [View](https://stellar.expert/explorer/testnet/contract/CADH3QNOWXAGP2SCT2EO66CFE2Z454VZNNAJGV3DBY3FMHDRHYWVM33F) |
| **Leaderboard** (ELO) | `CDSWKIK4WOGK2IP42VQSDUKG3B2OWRJE5NM7WEK2DCHPIQI5GW5UPCZS` | [View](https://stellar.expert/explorer/testnet/contract/CDSWKIK4WOGK2IP42VQSDUKG3B2OWRJE5NM7WEK2DCHPIQI5GW5UPCZS) |
| **Game Hub** | `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG` | [View](https://stellar.expert/explorer/testnet/contract/CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG) |

### Game Hub Integration

The Cangkulan contract calls `start_game()` and `end_game()` on the Game Hub:

```rust
// On game creation — registers the session with the hub
game_hub_client.start_game(
    &env.current_contract_address(),
    &session_id,
    &player1, &player2,
    &player1_points, &player2_points,
);

// On game completion — reports the winner to the hub
game_hub_client.end_game(&session_id, &player1_won);
```

---

## Architecture

```
contracts/
├── cangkulan/              # Main game contract (2,143 lines Rust)
│   └── src/
│       ├── lib.rs          # Game logic, state machine, multi-mode ZK
│       └── test.rs         # 58 unit tests — all passing
├── zk-verifier/            # ZK commitment verifier contract (~2,500 lines)
│   └── src/
│       ├── lib.rs          # 4-mode verifier: NIZK, Pedersen, Ring Sigma, Cangkul Hand (27 inline tests — all passing)
│       └── (tests inline in lib.rs)
├── ultrahonk-verifier/     # Noir UltraKeccakHonk verifier (pre-built 64KB WASM)
│   ├── rs_soroban_ultrahonk.wasm  # Deployed separately with VK
│   └── src-reference/      # Reference source (yugocabrio/rs-soroban-ultrahonk)
├── leaderboard/            # On-chain ELO rating contract
│   └── src/
│       ├── lib.rs      # ELO rating, match recording, player rankings
│       └── test.rs     # 17 unit tests — all passing
└── mock-game-hub/      # Game Hub mock for testing

circuits/
└── seed_verify/            # Noir ZK circuit for seed verification
    ├── src/main.nr         # blake2s(seed) == hash AND seed[0..4] != 0x00 circuit
    ├── generate-proof.mjs  # End-to-end proof generation script
    ├── Nargo.toml          # Noir project config (nargo 1.0.0-beta.9)
    └── target/             # Compiled ACIR, VK, proof, public_inputs

scripts/
├── build.ts / deploy.ts / bindings.ts   # Contract automation
├── ws-lobby.ts         # Bun WebSocket relay server (matchmaking + chat)
└── ...                 # create, publish, dev-game, setup

cangkulan-frontend/     # React 19 + TypeScript + Vite 7 frontend
├── public/
│   ├── cangkulan-logo.png       # Game logo / branding
│   ├── sw.js                    # Service Worker (PWA offline support)
│   └── manifest.json            # PWA manifest
├── src/
│   ├── pages/                   # 9 routed pages (lazy-loaded)
│   │   ├── HomePage.tsx         # Dashboard — stats + quick actions
│   │   ├── HistoryPage.tsx      # Full game history + W/L/D + streaks
│   │   ├── StatsPage.tsx        # On-chain analytics via event indexing
│   │   ├── LeaderboardPage.tsx  # ELO rankings from on-chain events
│   │   ├── ArchitecturePage.tsx # Interactive Mermaid architecture diagram
│   │   ├── DemoShowcasePage.tsx # Feature showcase overview
│   │   ├── RulesPage.tsx        # Complete rules guide
│   │   ├── SettingsPage.tsx     # Sound, theme, language, data, contract links
│   │   └── TutorialPage.tsx     # Play vs Bot wrapper
│   ├── components/              # Shared UI components
│   │   ├── Layout.tsx           # Header + footer + theme/sound toggles
│   │   ├── NavigationBar.tsx    # Bottom/top tab navigation (9 routes, i18n)
│   │   ├── ConnectionScreen.tsx # Wallet selection with logo branding
│   │   ├── Onboarding.tsx       # 7-slide intro walkthrough
│   │   ├── WalletSwitcher.tsx   # Wallet status + dev player switching
│   │   ├── TransactionLog.tsx   # On-chain proof links
│   │   ├── ErrorBoundary.tsx    # React error boundary
│   │   └── Toast.tsx            # Toast notification system
│   ├── games/cangkulan/         # Game-specific components (45 files)
│   │   ├── CangkulanGame.tsx    # Phase orchestrator (create→seed→play→done)
│   │   ├── CreatePhase.tsx      # Multi-sig game creation + QR invite
│   │   ├── SeedPhase.tsx        # ZK seed commit & reveal + verification badge
│   │   ├── PlayingPhase.tsx     # Card play (tap/drag), suit matching
│   │   ├── CompletePhase.tsx    # Win/loss + confetti + verification
│   │   ├── GameTable.tsx        # Visual card table
│   │   ├── PlayingCard.tsx      # Card rendering (suits, back)
│   │   ├── GameLobby.tsx        # On-chain game list + WS real-time lobby
│   │   ├── SpectatorView.tsx    # Read-only game observation
│   │   ├── TutorialMode.tsx     # Play vs Bot (no contract)
│   │   ├── GameReplay.tsx       # Step-by-step trick replay
│   │   ├── EmojiReactions.tsx   # Emoji reactions (8 emojis)
│   │   ├── CanvasConfetti.tsx   # 120-particle confetti + card sweep
│   │   ├── CardDealAnimation.tsx# Full-screen deal animation
│   │   ├── ProgressiveScore.tsx # Animated score counter
│   │   ├── TimeoutControls.tsx  # Circular timer visualization
│   │   ├── QRCode.tsx           # Pure TypeScript QR generator
│   │   ├── GameHistoryPanel.tsx # Expandable game history list
│   │   ├── GameLoadingSkeleton.tsx # Loading state skeleton
│   │   ├── noirUtils.ts        # Noir blake2s + proof format utilities
│   │   ├── noirProver.ts       # Browser Noir prover (bb.js + noir_js)
│   │   ├── seedStorage.ts      # Dual-write seed persistence (session+local)
│   │   └── ZkVerificationBadge.tsx # ZK proof mode indicator
│   ├── services/                # Wallet + RPC + lobby services
│   │   └── lobbySocket.ts       # WebSocket client (presence, matchmaking, chat)
│   ├── hooks/                   # useWallet, useHashRouter, useLobbyPresence
│   ├── i18n/                    # Internationalization (react-intl)
│   │   ├── en.json              # English (190+ keys)
│   │   ├── id.json              # Bahasa Indonesia (190+ keys)
│   │   └── index.tsx            # I18nProvider + locale detection
│   ├── store/                   # Zustand global state
│   ├── types/                   # TypeScript type definitions
│   └── utils/                   # Constants, auth, logger, runtime config
│
bindings/cangkulan/     # Auto-generated contract bindings
```

### Contract State Machine

```
START → SEED_COMMIT → SEED_REVEAL → PLAYING → FINISHED
           ↓              ↓            ↓
        timeout         timeout      timeout
        (ledger          (ledger      (nonce or
         deadline)        deadline)    ledger)
           ↓              ↓            ↓
        FINISHED        FINISHED    FINISHED
```

- **SEED_COMMIT:** Both players submit `keccak256(seed ∥ address)` hashes — entropy validated
- **SEED_REVEAL:** Both reveal seeds, ZK verifier validates, deck is shuffled
- **PLAYING:** Trick-by-trick gameplay via commit-reveal card plays, follow-suit rules, nonce-protected actions
- **FINISHED:** Winner determined, `end_game()` reported to Game Hub
- **Timeout:** Dual timeout — action counter (`TIMEOUT_ACTIONS = 2`) or ledger deadline (`TIMEOUT_LEDGERS = 120`)

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (v1.0+)
- [Rust](https://rustup.rs/) with `wasm32v1-none` target
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)

### Run Locally

```bash
git clone https://github.com/beranalpa/Cangkulan-Lite-ZK-Card-Game.git
cd Cangkulan-Lite-ZK-Card-Game
bun install

# Build contracts
bun run build cangkulan zk-verifier

# Run the frontend (connects to deployed testnet contracts)
bun run dev:game cangkulan
# → Open http://localhost:3007
```

### Run Tests

```bash
# Cangkulan contract — 58 tests
cargo test -p cangkulan

# ZK Verifier — 27 tests
cargo test -p zk-verifier

# Leaderboard contract — 17 tests
cargo test -p leaderboard

# All on-chain tests — 103 total
cargo test -p cangkulan -p zk-verifier -p leaderboard -p mock-game-hub

# Frontend — 183 tests (4 test suites: service, auth, crypto, ZK proof modes)
cd cangkulan-frontend && bun run test
```

### Full Setup (Deploy Your Own)

```bash
# Build + deploy all contracts to testnet, generate bindings, write .env
bun run setup

# Or deploy individually
bun run build cangkulan
bun run deploy cangkulan
bun run bindings cangkulan
```

---

## Gameplay Flow (Frontend)

### Game Mode Selection

When you click "Play Game," you're presented with three game modes:

| Mode | Description |
|------|-------------|
| **🎮 Multiplayer** | Create or join rooms — play against real opponents on Stellar testnet |
| **🤖 vs AI** | Practice against a bot (Easy/Medium/Hard) — all moves still verified on-chain |
| **🔧 Dev Testing** | ZK mode tester, contract inspector, quickstart games (dev mode only) |

### Multiplayer Room System

1. **Create Room** — Choose public/private, bet amount (Free/1/5/10 XLM display), ZK proof mode
2. **Waiting Room** — Share invite link + QR code, room chat, spectator count
3. **Guest Joins** — Auto-start game → seed commit phase
4. **Quick Match** — FIFO matchmaking queue for instant pairing
5. **Join Room** — Browse public rooms or enter invite code for private rooms

Public rooms are visible to all players. Private rooms require an invite code or link.

### vs AI (Bot)

The bot is a real Stellar wallet — it generates an ephemeral keypair, funds itself via Friendbot, and plays on-chain like a human. All ZK proofs are generated and verified on Soroban.

| Difficulty | Strategy |
|-----------|----------|
| 😊 Easy | Random valid card selection |
| 🧠 Medium | Follow suit with lowest rank; lead with dominant suit |
| 💀 Hard | Card counting — tracks played cards, forces opponent to draw |

### Standard Game Flow

1. **Connect Wallet** — Choose from 4 supported wallets or use dev mode for local testing
2. **Create Game** — Player 1 initiates with multi-sig auth (both players authorize points)
3. **Seed Commit** — Both players commit a secret seed (choose Pedersen or Noir proof mode)
4. **Seed Reveal** — Both reveal seeds with ZK proof; on-chain verifier validates; deck shuffles
5. **Play** — Trick-by-trick card game via commit-reveal (both players choose secretly, then reveal simultaneously), follow-suit rules, penalty draws, and cangkul calls
6. **Complete** — Winner announced, confetti animation, shuffle verification link, result recorded on Game Hub

### Frontend Features

| Feature | Description |
|---------|-------------|
| **4 Wallet Integrations** | Freighter, HOT Wallet, Hana, Klever |
| **Dev Mode** | Pre-funded testnet wallets with player switching |
| **Tutorial Mode** | Play vs Bot locally — no wallet or contract needed |
| **Spectator View** | Read-only game observation with LIVE indicator |
| **Game Replay** | Step-by-step trick replay with play/pause/speed controls |
| **Dark/Light Theme** | Toggle with localStorage persistence |
| **Sound Effects** | Web Audio API synthesized sounds (6 types, mute toggle) |
| **Emoji Reactions** | 8 emojis with BroadcastChannel cross-tab delivery |
| **QR Code Invites** | Pure TypeScript QR generator for game invite links |
| **Game History** | On-chain W/L/D stats, streak tracking, max 50 games (120-day TTL on-chain) |
| **On-Chain Analytics** | Game statistics dashboard via Soroban event indexing |
| **ELO Leaderboard** | On-chain ELO ratings with tier badges and search |
| **Game Mode Selector** | 3 game modes: Multiplayer (rooms), vs AI (bot), Dev Testing |
| **Multiplayer Rooms** | Create/join public & private rooms with invite links + QR codes |
| **Waiting Room** | Live player slots, spectators, per-room chat, auto-start on join |
| **AI Bot Opponent** | 3 difficulty levels (Easy/Medium/Hard) with real on-chain play |
| **Dev Testing Panel** | ZK mode quick launch, contract inspector, CLI test reference |
| **Multiplayer Lobby** | WebSocket real-time lobby: presence, matchmaking, invites, chat |
| **Internationalization** | Full i18n via react-intl — English + Bahasa Indonesia (190+ keys) |
| **Progressive Web App** | Service worker + manifest for offline support & installability |
| **Architecture Diagram** | Interactive Mermaid diagram of system components |
| **Card Animations** | Framer Motion library for deal, flip, and play animations |
| **Progressive Score** | Animated counter with direction indicators |
| **Timeout System** | Circular timer visualization + auto-resolve |
| **Canvas Confetti** | 120-particle confetti + card sweep overlay on win |
| **Card Deal Animation** | Full-screen cards-from-center animation |
| **Noir Mode Toggle** | Switch between Pedersen (default, fast) and Noir UltraKeccakHonk proof modes in UI |
| **Browser Noir Prover** | Client-side Noir witness + UltraKeccakHonk proof via @noir-lang/noir_js + @aztec/bb.js |
| **7-Slide Onboarding** | First-time walkthrough (rules, ZK modes, Pedersen/Noir, protections, lobby, contracts, setup) |
| **Responsive Design** | Mobile-friendly bottom nav, collapsible sections |
| **Logo Branding** | Custom Cangkulan Lite logo in header, connection screen, favicon |
| **Code Splitting** | Lazy-loaded routes + vendor chunks (initial load ~264KB gzipped) |
| **Production Logging** | Log-level system; debug/info stripped in production builds |
| **Seed Recovery** | Dual-write sessionStorage + localStorage for ZK seed persistence |

### Wallet Support

The frontend supports 4 Stellar wallets via [Stellar Wallets Kit](https://github.com/AhaLabs/stellar-wallets-kit):

| Wallet | Type |
|--------|------|
| Freighter | Browser extension |
| HOT Wallet | Browser extension |
| Hana | Browser extension |
| Klever | Browser extension |

A **dev mode** with pre-funded testnet keypairs is also available for local testing and wallet switching between both player perspectives.

---

## Technical Details

### Card Encoding

```
card_id = suit × 9 + (value - 2)

suit ∈ {0: ♠, 1: ♥, 2: ♦, 3: ♣}
value ∈ {2, 3, 4, 5, 6, 7, 8, 9, 10}

Decode: suit = id / 9, value = id % 9 + 2
```

### Deterministic Shuffle

```rust
// Combined seed from both players' commits + session ID
let combined = env.crypto().keccak256(&combined_bytes);
env.prng().seed(/* 32-byte seed from combined hash */);

// Fisher-Yates shuffle using seeded PRNG
for i in (1..DECK_SIZE).rev() {
    let j = prng.gen_range_u64(0..=(i as u64)) as u32;
    // swap deck[i] and deck[j]
}
```

### Storage

- Game state uses **temporary storage** with 30-day TTL (518,400 ledgers)
- TTL is extended on every state write
- **Instance storage** (admin, hub, verifier addresses) TTL is extended alongside game state writes to prevent contract from becoming unusable
- Each game tracks an `action_nonce` (monotonic counter) and `deadline_ledger` (absolute ledger number)
- No persistent storage pollution

### On-Chain Events

The contract emits structured events at every lifecycle point, making games fully observable and indexable via Stellar Expert:

| Event | Data | When |
|-------|------|------|
| `EvGameStarted` | session_id, player1, player2 | Game session created |
| `EvSeedCommitted` | session_id, player | Player commits seed hash |
| `EvSeedRevealed` | session_id, player | Player reveals seed |
| `EvDeckShuffled` | session_id | Both seeds revealed, deck shuffled |
| `EvPlayCommitted` | session_id, player | Player commits hidden card choice |
| `EvZkCardPlayVerified` | session_id, player, valid_set_size | ZK ring sigma card proof validated |
| `EvZkCangkulVerified` | session_id, player, hand_size, trick_suit | ZK cangkul hand exclusion proof validated |
| `EvPlayRevealed` | session_id, player, card_id, is_cangkul | Player reveals card (or cangkul) |
| `EvTrickResolved` | session_id, winner, card1, card2 | Trick resolved with both cards shown |
| `EvGameEnded` | session_id, outcome | Game finished (1=P1, 2=P2, 3=draw) |

### Shuffle Verification

Anyone can independently verify the fairness of any completed game's shuffle:

```bash
stellar contract invoke --id CABH7K6ZJNWKSLUIT4DYQZYLLWPKSRJXL6ECGBL3TMNZMY6V6M6BAOTS \
  --network testnet -- verify_shuffle --session_id <SESSION_ID>
```

This recomputes the deterministic Fisher-Yates shuffle from the stored commit hashes and returns the full 36-card deck order — proving that the shuffle was derived solely from both players' committed seeds.

### Error Handling

Every contract error is a numbered `CangkulanError` variant, making on-chain failures easy to diagnose:

| Code | Name | Description |
|------|------|-------------|
| 1 | `GameNotFound` | No game exists for the given session ID |
| 2 | `SessionAlreadyExists` | Session ID is already in use |
| 3 | `NotAPlayer` | Caller is not a participant in this game |
| 4 | `SelfPlayNotAllowed` | Player 1 and Player 2 cannot be the same address |
| 5 | `GameAlreadyEnded` | Game has already reached FINISHED state |
| 6 | `WrongPhase` | Action is not valid for the current lifecycle phase |
| 7 | `CommitAlreadySubmitted` | Player has already committed a seed |
| 8 | `RevealAlreadySubmitted` | Player has already revealed their seed |
| 9 | `CommitHashMismatch` | Revealed seed does not match the committed hash |
| 10 | `InvalidZkProof` | ZK Verifier rejected the proof |
| 11 | `MissingCommit` | Cannot reveal — seed commit not found |
| 12 | `NotYourTurn` | It is not the caller's turn to act |
| 13 | `CardNotInHand` | The played card is not in the player's hand |
| 14 | `WrongSuit` | Card does not match the trick suit |
| 15 | `HasMatchingSuit` | Cannot call cangkul when holding a matching suit |
| 16 | `DrawPileEmpty` | No cards left in the draw pile |
| 17 | `NoTrickInProgress` | No trick is currently active |
| 18 | `AdminNotSet` | Admin address not configured |
| 19 | `GameHubNotSet` | Game Hub address not configured |
| 20 | `VerifierNotSet` | ZK Verifier address not configured |
| 21 | `TimeoutNotReached` | Timeout threshold has not been reached yet |
| 22 | `TimeoutNotConfigured` | Timeout tracking is not set up for this game |
| 23 | `TimeoutNotApplicable` | Current game state does not support timeout resolution |
| 24 | `WeakSeedEntropy` | Seed does not have enough entropy (too many repeated bytes) |
| 25 | `InvalidNonce` | Action nonce does not match expected value (stale/replayed action) |
| 26 | `PlayCommitAlreadySubmitted` | Player has already committed a card play this trick |
| 27 | `PlayCommitMissing` | Cannot reveal — no play commit found for this player |
| 28 | `PlayRevealMismatch` | Revealed card+salt does not match the committed hash |
| 29 | `InvalidCardId` | Card ID is out of valid range (must be 0–35 or CANNOT_FOLLOW_SENTINEL) |
| 30 | `UltraHonkVerifierNotSet` | UltraHonk verifier address not configured |
| 31 | `UltraHonkVerificationFailed` | UltraHonk proof verification failed |
| 32 | `ZkPlayProofInvalid` | ZK card play ring sigma proof failed verification |
| 33 | `ZkPlaySetEmpty` | ZK card play valid set is empty |
| 34 | `ZkPlayOpeningMismatch` | ZK card play opening does not match commit |
| 35 | `ZkCangkulProofInvalid` | ZK cangkul hand exclusion proof failed verification |
| 38 | `TickTooSoon` | Action attempted too soon after last tick |

The ZK Verifier contract has its own `ZkVerifyError` enum with diagnostic events:

| Code | Name | Description |
|------|------|-------------|
| 1 | `ProofWrongLength` | keccak256 proof is not 32 bytes |
| 2 | `InputsTooShort` | Card verification inputs are too short |
| 3 | `SeedProofMismatch` | Seed proof length mismatch |
| 4 | `SeedInputsTooShort` | Seed verification inputs are too short |
| 5 | `EmptyPlayerAddress` | Player address is empty |
| 6 | `HashMismatch` | Computed hash does not match submitted proof |

The verifier emits `EvVerifyFailed { reason }` or `EvVerifySuccess { mode }` events for every verification call, making ZK proofs auditable on-chain.

### Security Model & Transparency

**On-Chain Transparency Disclosure** — Soroban smart contract storage is publicly readable. This means:
- Game state (hands, deck order) is visible in contract storage after cards are dealt
- The commit-reveal protocol protects against **front-running** (opponent reacting to your move), not permanent secrecy
- After both players reveal, all trick data is on-chain and auditable
- This is **by design** — full auditability is a feature, not a bug. Anyone can verify that the game was played fairly by inspecting the on-chain state

The ZK system's role is therefore **fairness enforcement**, not information hiding:
1. ZK seed commitment → prevents shuffle manipulation
2. Commit-reveal card plays → prevents front-running (simultaneous action)
3. Ring/Cangkul ZK proofs → enforces game rules without a trusted server
4. Public auditability → anyone can verify post-game that all rules were followed

**Seed Entropy Check** — Seeds must contain sufficient entropy. The contract requires at least 4 distinct byte values in the 32-byte seed, rejecting trivially predictable seeds like `[0; 32]`, `[0,1,0,1,...]`, or `[0,1,2,0,1,2,...]`.

**Session Nonce** — Every game action increments an `action_nonce` counter. Players must submit the current expected nonce with `commit_play()` calls. This prevents stale or replayed transactions from affecting game state if a network delay causes the same TX to land twice.

**Card Play Commit-Reveal** — Individual card plays use `commit_play()` + `reveal_play()` to enforce simultaneous action. The commit hash is `keccak256(card_id_u32_be ∥ salt_32)`. This prevents front-running — opponents cannot react to each other's card choice because both must commit before either can reveal.

**Commit-Reveal Deadline** — A ledger-based deadline (`TIMEOUT_LEDGERS = 120`, approximately 10 minutes on-chain) is set when the game begins. The frontend also shows a 60-second UI countdown for responsiveness. If an opponent stalls during seed commit or mid-game, the other player can call `resolve_timeout()` to claim victory. The timeout triggers when EITHER the action-based counter (`TIMEOUT_ACTIONS = 2` ticks) OR the ledger deadline is exceeded.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Smart Contracts | Rust + Soroban SDK v25.0.2 |
| ZK Verification | keccak256 commit-reveal (on-chain verifier contract) |
| Frontend | React 19 + TypeScript 5.9 + Vite 7 + TailwindCSS 4 |
| Animations | Framer Motion 12 (card animations, transitions) |
| Internationalization | react-intl 8 (English + Bahasa Indonesia) |
| Real-Time Lobby | Bun WebSocket relay server (presence, matchmaking, chat) |
| Wallet Integration | Stellar Wallets Kit (Freighter, HOT Wallet, Hana, Klever) |
| State Management | Zustand 5 |
| Blockchain | Stellar Testnet |
| Package Manager | Bun |
| Crypto (client) | js-sha3 (keccak256), @noble/curves (BLS12-381), @noble/hashes (blake2s) |
| ZK Proofs (client) | @noble/curves (BLS12-381 Pedersen), @noir-lang/noir_js + @aztec/bb.js (Noir UltraKeccakHonk) |
| Testing | Vitest (171 frontend) + cargo test (127 contract + 3 Noir circuit) |

---

## Multiplayer Lobby & Room System (WebSocket)

The game includes a real-time lobby and room system powered by a lightweight Bun WebSocket relay server:

> **Trust Boundary:** The WebSocket server is a **stateless relay** — it forwards messages between players but has **zero authority** over game state. **All game-critical logic is enforced on-chain.** Seed commitment, card plays, rule validation, and winner determination happen exclusively via Soroban smart contracts. A compromised or malicious lobby server cannot affect game outcomes, cheat, or forge ZK proofs. The lobby could go offline entirely and players could still complete games by submitting transactions directly. Players authenticate via challenge-response (sign a random nonce with their Stellar keypair), and the server validates signatures before granting lobby access.

```bash
# Start the lobby relay server (default port 8787)
bun run ws-lobby
```

### Lobby Features

| Feature | Description |
|---------|-------------|
| **Player Presence** | See who's online in the lobby with idle/queued/in-game status |
| **Matchmaking Queue** | "Find Match" button pairs you with a random opponent (FIFO) |
| **Direct Invites** | Challenge any idle player with an invite; they can accept or decline |
| **Lobby Chat** | Real-time text chat in the lobby (200 char limit) |
| **Auto-Reconnect** | Exponential backoff up to 30s; heartbeat every 30s |
| **Health Endpoint** | HTTP `GET /health` for monitoring |

### Room System

| Feature | Description |
|---------|-------------|
| **Create Room** | Host creates a room with type (public/private), bet amount, ZK mode |
| **Public Rooms** | Listed in the room browser — anyone can join |
| **Private Rooms** | Invite-only via unique code or link |
| **Waiting Room** | Host waits with invite link, QR code, and room chat |
| **Auto-Start** | Game automatically starts when guest joins the room |
| **Spectator Support** | Anyone can spectate active room games |
| **Room Expiry** | Idle rooms auto-close after 10 minutes |
| **Per-Room Chat** | Chat within the waiting room (separate from lobby chat) |

**Room WS Protocol:** `create-room`, `join-room`, `spectate-room`, `leave-room`, `room-chat`, `room-list`, `room-created`, `room-updated`, `room-game-start`, `room-closed`

The frontend WebSocket client (`src/services/lobbySocket.ts`) connects automatically when the user has a wallet. The `useLobbyPresence` hook provides React-friendly state. Set `VITE_WS_LOBBY_URL` to configure the server URL.

## On-Chain Leaderboard

The `contracts/leaderboard` contract provides an on-chain ELO rating system:

- **ELO Calculation** — K=32 for new players (<30 games), K=16 for established, floor at 100
- **Player Stats** — Wins, losses, draws, games played, current/best win streak
- **Sorted Rankings** — `get_top_players(limit)` returns ELO-sorted leaderboard
- **Access Control** — Only admin-authorized game contracts can record matches
- **17 tests** covering ELO symmetry, upsets, streaks, authorization, and more

The frontend `LeaderboardPage` computes ELO from on-chain game events with tier badges (Grandmaster → Novice), search, and multi-sort.

## Internationalization (i18n)

The frontend supports multiple languages via `react-intl`:

| Language | File | Keys |
|----------|------|------|
| English | `src/i18n/en.json` | 190+ |
| Bahasa Indonesia | `src/i18n/id.json` | 190+ |

- Auto-detects browser locale (Indonesian browsers default to `id`)
- Language switcher in Settings page (flag buttons)
- Locale persisted to `localStorage`
- All UI strings are translatable message IDs

## Progressive Web App (PWA)

- **Service Worker** (`public/sw.js`) — cache-first strategy for static assets, network-first for API calls
- **Web App Manifest** (`public/manifest.json`) — installable on mobile/desktop
- **Offline Support** — cached assets load without network; game state persisted in localStorage

---

## Repository Structure

This project is built on top of [Stellar Game Studio](https://github.com/jamesbachini/Stellar-Game-Studio) — a toolkit for building Soroban games. **Cangkulan Lite** is the game added for this hackathon submission, including the ZK verifier, leaderboard, and Noir circuit.

**Source:** [https://github.com/beranalpa/Cangkulan-Lite-ZK-Card-Game](https://github.com/beranalpa/Cangkulan-Lite-ZK-Card-Game)

---

## License

MIT — see [LICENSE](LICENSE)
