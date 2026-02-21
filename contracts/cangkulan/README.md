# Cangkulan Lite — Soroban Smart Contract

A two-player Indonesian trick-taking card game with **multi-mode ZK** seed commitment for provably fair deck shuffling, built on Stellar's Soroban platform.

## Overview

Cangkulan is a traditional Indonesian card game where two players compete to empty their hand first by playing tricks. The contract supports **four ZK proof modes** for seed verification, auto-detected by proof size and prefix:

| Mode | Proof Size | Description |
|------|-----------|-------------|
| **Pedersen+Sigma** (default) | 224 bytes | BLS12-381 Schnorr proof — fast, client-generated |
| **Hash-based PoK** (legacy) | 64 bytes | Fiat-Shamir binding protocol with keccak256 |
| **Noir UltraKeccakHonk** | >4 KB (~14 KB) | Noir circuit proof via bb.js — blake2s verification (off-chain proof; on-chain pending budget increase) |

- **36-card deck** — 4 suits (♠♥♦♣) × values 2–10
- **5 cards** dealt to each player, 26 go to the draw pile
- Each trick: a card is flipped from the pile — its suit is the trick suit
- Players must follow suit if they can; otherwise they call "cangkul" and draw a penalty card
- **Winner:** first to empty their hand, or fewer cards when the pile runs out

## Features

- **Multi-Mode ZK Seed Commitment**: Provably fair shuffle with three auto-detected proof modes:
  - **Pedersen+Sigma (default):** BLS12-381 Schnorr proof (224 bytes) — `C = Fr(seed_hash)·G + Fr(blinding)·H`, commit = `keccak256(C)`
  - **Hash-based PoK (legacy):** Fiat-Shamir transformed binding protocol (64 bytes) — blinded commitment + session-bound nullifier
  - **Noir UltraKeccakHonk:** General-purpose Noir circuit (~14KB proof) — proves `blake2s(seed) == seed_hash`, verified via UltraHonk verifier contract. On-chain verification uses ~200M of 400M per-tx CPU budget — fits within Soroban limits. Default for multiplayer games (strongest guarantee). Proof generation works fully in-browser.
  - The raw seed **never** touches the chain — only `seed_hash` is revealed
- **Card Play Commit-Reveal**: Individual card plays use either:
  - **ZK Pedersen + Ring Sigma** (default): `commit_play_zk` — Pedersen commitment `C = card_id·G + blinding·H` with a 1-of-N Ring Sigma proof that the committed card is in the valid set (hand ∩ trick suit). Provides on-chain rule compliance verification. *Note: the valid set is passed as public inputs for on-chain verification, so the rule enforcement is trustless but the valid set is visible on-chain.*
  - **Legacy keccak256**: `commit_play` — `keccak256(card_id_u32_be ∥ salt)` for CANNOT_FOLLOW_SENTINEL or fallback.
- **Deterministic Shuffle**: Combined seed hashes → keccak256 → Fisher-Yates shuffle (reproducible by anyone)
- **Game Hub Integration**: Lifecycle events (`start_game`, `end_game`) reported to the Game Hub contract
- **Timeout System**: Dual timeout — action-based counter + ledger deadline to prevent stalling
- **Nonce Protection**: Monotonic action nonce prevents replay attacks
- **Entropy Validation**: Rejects trivially predictable seeds
- **On-Chain Events**: Full game state observable via Stellar event indexers
- **Persistent Game History**: Per-player ring buffer (max 50 games) stored in persistent storage with 120-day TTL. Each `GameSummary` records session ID, opponent, outcome (from the player's perspective), tricks won/lost, and ending ledger.

## Contract Methods

### `__constructor`
Initialize the contract with admin, Game Hub, and ZK Verifier addresses.

**Parameters:**
- `admin: Address` — Contract admin
- `game_hub: Address` — Game Hub contract address
- `verifier: Address` — ZK Verifier contract address

### `start_game`
Start a new game session between two players.

**Parameters:**
- `session_id: u32` — Unique session identifier
- `player1: Address` — First player's address
- `player2: Address` — Second player's address
- `player1_points: i128` — Points wagered by Player 1
- `player2_points: i128` — Points wagered by Player 2

**Auth:** Requires authentication from both players for their respective point amounts.

### `commit_seed`
Submit a blinded commitment for the deck shuffle.

**Parameters:**
- `session_id: u32` — Game session ID
- `player: Address` — Player submitting the commitment
- `commit_hash: BytesN<32>` — `keccak256(seed_hash ∥ blinding ∥ player_address)` where `seed_hash = keccak256(seed)`

**Auth:** Requires authentication from the player.

### `reveal_seed`
Reveal the seed hash and submit a ZK proof. The raw seed is **never** sent on-chain.

**Parameters:**
- `session_id: u32` — Game session ID
- `player: Address` — Player revealing
- `seed_hash: BytesN<32>` — `keccak256(seed)` (Pedersen/Hash-PoK) or `blake2s(seed)` (Noir)
- `proof: Bytes` — 224-byte Pedersen proof, 64-byte hash-based proof, or >4KB Noir UltraHonk proof

**Auth:** Requires authentication from the player. The contract auto-detects the proof mode by size and routes to the appropriate verifier. When both seeds are revealed, the deck is automatically shuffled and 5 cards are dealt to each player.

### `commit_play`
Commit a hidden card play. Both players must commit before reveal begins.

**Parameters:**
- `session_id: u32` — Game session ID
- `player: Address` — Player making the move
- `commit_hash: BytesN<32>` — `keccak256(card_id_u32_be(4) ∥ salt(32))`
- `expected_nonce: u32` — Current action nonce (replay protection)

**Auth:** Requires authentication from the player.

Use `CANNOT_FOLLOW_SENTINEL` (0xFFFFFFFF) as `card_id` in the hash to declare "cannot follow suit" (cangkul).

### `commit_play_zk`
Submit a ZK-verified card play commitment with a Ring Sigma proof.

**Parameters:**
- `session_id: u32` — Game session ID
- `player: Address` — Player making the move
- `commit_hash: BytesN<32>` — `keccak256(C_bytes)` where `C = card_id·G + blinding·H` (Pedersen commitment on BLS12-381)
- `expected_nonce: u32` — Current action nonce (replay protection)
- `zk_proof: Bytes` — Ring Sigma proof: `C(96) ∥ [e_i(32) ∥ z_i(32)] × N`

**Auth:** Requires authentication from the player. The contract:
1. Computes the valid set: all cards in the player's hand matching the trick suit
2. Builds public inputs with `commit_hash`, valid set, session ID, and player address
3. Calls the ZK Verifier (Mode 7) to verify the Ring Sigma proof
4. Stores the commit and sets the `zk_play` flag for Pedersen opening on reveal

**Note:** Only use for cards that follow suit. For `CANNOT_FOLLOW_SENTINEL`, use `commit_play` instead.

### `reveal_play`
Reveal a previously committed card play. Supports two opening modes:
- **ZK mode** (if committed via `commit_play_zk`): `salt` is the blinding factor; verifies `keccak256(card_id·G + blinding·H) == stored_commit`
- **Legacy mode** (if committed via `commit_play`): verifies `keccak256(card_id_u32_be ∥ salt) == stored_commit`

**Parameters:**
- `session_id: u32` — Game session ID
- `player: Address` — Player revealing
- `card_id: u32` — The actual card to play (0–35), or `CANNOT_FOLLOW_SENTINEL` (0xFFFFFFFF)
- `salt: BytesN<32>` — The random salt (legacy) or blinding factor (ZK) used in the commit

**Auth:** Requires authentication from the player. The contract:
1. Detects ZK/legacy mode from the `zk_play` flag set during commit
2. Verifies the opening matches the stored commitment
3. Validates the card is in the player's hand and matches the trick suit
4. When both players have revealed, the trick resolves automatically

### `tick_timeout`
Start or advance the timeout counter for the current phase.

**Parameters:**
- `session_id: u32` — Game session ID
- `caller: Address` — Player initiating timeout

### `resolve_timeout`
Resolve a timeout — declares the non-stalling player as the winner.

**Parameters:**
- `session_id: u32` — Game session ID
- `caller: Address` — Player claiming timeout victory

### `get_game`
Read the current game state (read-only).

**Parameters:**
- `session_id: u32` — Game session ID

**Returns:** `CangkulanGame` — Full game state including hands, pile, phase, scores

### `get_player_history`
Get a player's on-chain game history (up to 50 most recent games).

**Parameters:**
- `player: Address` — Player's Stellar address

**Returns:** `Vec<GameSummary>` — List of game summaries with outcome from the player's perspective.

```rust
pub struct GameSummary {
    pub session_id: u32,
    pub opponent: Address,
    pub outcome: u32,        // 1 = win, 2 = loss, 3 = draw
    pub tricks_won: u32,
    pub tricks_lost: u32,
    pub ledger: u32,         // ledger sequence when game ended
}
```

**Storage:** Persistent with 120-day TTL, ring buffer capped at 50 entries per player. When capacity is reached, the oldest entry is dropped.

### `verify_shuffle`
Recompute and return the deterministic deck order for any game session.

**Parameters:**
- `session_id: u32` — Game session ID

**Returns:** `Vec<u32>` — The 36-card deck order, proving the shuffle was derived solely from both players' committed seeds.

## Game Flow

```
START → SEED_COMMIT → SEED_REVEAL → PLAYING → FINISHED
           ↓              ↓            ↓
        timeout         timeout      timeout
           ↓              ↓            ↓
        FINISHED        FINISHED    FINISHED
```

1. Two players call `start_game` to create a session (registered with Game Hub)
2. Both players `commit_seed` — submitting a commit hash (binding depends on proof mode)
3. Both players `reveal_seed` — submitting `seed_hash` + ZK proof (Pedersen 224B, Hash-PoK 64B, or Noir ~14KB); contract auto-detects and validates; deck is shuffled deterministically
4. Players use `commit_play` / `reveal_play` for each trick — cards are hidden until both commit
5. Game ends when a player empties their hand or the draw pile runs out
6. Winner reported to Game Hub via `end_game`

## ZK Protocol Details

The contract supports three proof modes, auto-detected by proof size:

### Mode 1: Pedersen+Sigma (Default — 224 bytes)

BLS12-381 Schnorr proof on the Pedersen blinding factor:

```
┌─────────────────── Client (off-chain) ───────────────────┐
│  seed_hash   = keccak256(seed)                           │
│  C           = Fr(seed_hash)·G + Fr(blinding)·H          │
│  commit_hash = keccak256(C_bytes)                        │
│  R           = k·H  (random nonce commitment)            │
│  e           = Fr(keccak256(C∥R∥seedHash∥sid∥player∥ZKP4)) │
│  z_r         = k + e·r  (response)                       │
│  proof       = C(96) ∥ R(96) ∥ z_r(32) = 224 bytes      │
│                                                          │
│  Verifier checks: z_r·H == R + e·(C − seed_hash·G)      │
└──────────────────────────────────────────────────────────┘
```

### Mode 2: Hash-based PoK (Legacy — 64 bytes)

Fiat-Shamir transformed binding protocol:

```
┌─────────────────── Client (off-chain) ───────────────────┐
│  seed_hash   = keccak256(seed)                           │
│  commitment  = keccak256(seed_hash ∥ blinding ∥ player)  │
│  nullifier   = keccak256(seed_hash ∥ "NULL" ∥ session)   │
│  challenge   = keccak256(commitment ∥ session ∥ player ∥ "ZKV2") │
│  response    = keccak256(seed_hash ∥ challenge ∥ blinding)│
│  proof       = blinding(32) ∥ response(32) = 64 bytes    │
└──────────────────────────────────────────────────────────┘
```

### Mode 3: Noir UltraKeccakHonk (Optional — ~14KB)

Noir circuit proves `blake2s(seed) == seed_hash`:

```
┌─────────────────── Client (browser) ─────────────────────┐
│  seed_hash   = blake2s(seed)                             │
│  commit_hash = keccak256(seed_hash)                      │
│  Noir witness generated via @noir-lang/noir_js           │
│  UltraKeccakHonk proof via @aztec/bb.js                  │
│  proof       ≈ 14,592 bytes                              │
│                                                          │
│  Contract routes proofs > 4KB to UltraHonk verifier      │
│  Verifier checks: verify_proof(vk, proof, public_inputs) │
└──────────────────────────────────────────────────────────┘
```

**ZK Properties (all seed modes):**
- **Zero-Knowledge**: The raw seed is never revealed on-chain; only `seed_hash = keccak256(seed)` is published
- **Soundness**: An adversary cannot forge a valid proof without knowing the correct seed
- **Completeness**: An honest prover with the correct seed always generates a valid proof
- **Hiding**: The blinded commitment reveals nothing about the seed before reveal
- **Binding**: The commitment cannot be opened to a different seed
- **Non-Interactive**: Single-round proof via Fiat-Shamir heuristic (no interaction needed)
- **Session-Bound**: Nullifier and challenge tie the proof to a specific game session

### ZK Card Play: Ring Sigma Proof (Mode 7)

Each card play can use a **1-of-N Ring Sigma proof** on BLS12-381 Pedersen commitments, proving the committed card belongs to the valid set (hand ∩ trick suit) without revealing which specific card:

```
┌─────────────────── Client (off-chain) ───────────────────┐
│  valid_set   = cards in hand matching trick suit         │
│  C           = card_id·G + blinding·H  (Pedersen)        │
│  commit_hash = keccak256(C_bytes)                        │
│                                                          │
│  Ring Sigma (1-of-N Schnorr):                            │
│  For each card i in valid_set:                           │
│    D_i = C − card_i·G                                    │
│    If i == real: R_i = k·H (nonce)                       │
│    Else:        R_i = z_i·H − e_i·D_i (simulated)       │
│                                                          │
│  e = Fr(keccak256(C∥R_0∥…∥R_{N-1}∥sid∥player∥"ZKP7"))   │
│  e_real = e − Σ(other e_i)                               │
│  z_real = k + e_real·blinding                            │
│  proof = C(96) ∥ [e_i(32)∥z_i(32)] × N                  │
│                                                          │
│  Budget: ~52M CPU (N=3), ~81M (N=5), fits 100M limit    │
└──────────────────────────────────────────────────────────┘
```

**ZK Properties (card play):**
- **Zero-Knowledge**: Observers see only that the card is *some* valid card in the suit — not which one
- **Soundness**: Cannot prove membership of a card not in the valid set
- **Binding**: Pedersen commitment binds `card_id` and `blinding`; opening verified on reveal

## Card Encoding

```
card_id = suit × 9 + (value - 2)

suit ∈ {0: ♠, 1: ♥, 2: ♦, 3: ♣}
value ∈ {2, 3, 4, 5, 6, 7, 8, 9, 10}

Decode: suit = id / 9, value = id % 9 + 2
```

## Error Codes

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
| 9 | `CommitHashMismatch` | Revealed seed does not match the committed hash (any proof mode) |
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
| 24 | `WeakSeedEntropy` | Seed does not have enough entropy |
| 25 | `InvalidNonce` | Action nonce mismatch (stale/replayed action) |
| 26 | `PlayCommitAlreadySubmitted` | Player has already committed a card play this trick |
| 27 | `PlayCommitMissing` | Cannot reveal — no play commit found for this player |
| 28 | `PlayRevealMismatch` | Revealed card+salt does not match the committed hash |
| 29 | `InvalidCardId` | Card ID is out of valid range (must be 0–35 or CANNOT_FOLLOW_SENTINEL) |
| 32 | `ZkPlayProofInvalid` | ZK Verifier rejected the Ring Sigma card play proof |
| 33 | `ZkPlaySetEmpty` | Player has no cards matching trick suit (use legacy `commit_play` for cangkul) |
| 34 | `ZkPlayOpeningMismatch` | Pedersen opening `keccak256(card_id·G + blinding·H) ≠ stored commit` |

## On-Chain Events

| Event | Data | When |
|-------|------|------|
| `EvGameStarted` | session_id, player1, player2 | Game session created |
| `EvSeedCommitted` | session_id, player | Player commits seed hash |
| `EvSeedRevealed` | session_id, player | Player reveals seed |
| `EvDeckShuffled` | session_id | Both seeds revealed, deck shuffled |
| `EvZkCardPlayVerified` | session_id, player, valid_set_size | ZK Ring Sigma proof verified for card play |
| `EvPlayCommitted` | session_id, player | Player commits hidden card choice |
| `EvPlayRevealed` | session_id, player, card_id, is_cangkul | Player reveals card (or cangkul declaration) |
| `EvTrickResolved` | session_id, winner, card1, card2 | Trick resolved with both cards shown |
| `EvGameEnded` | session_id, outcome | Game finished (1=P1, 2=P2, 3=draw) |

## Building

```bash
bun run build cangkulan
# or
stellar contract build
```

Output: `target/wasm32v1-none/release/cangkulan.wasm`

## Testing

```bash
cargo test -p cangkulan
# 45 tests — all passing
```

## Deployed (Testnet)

| Contract | Address |
|----------|---------|
| Cangkulan Lite | `CDMNR5KSRQXTKFL4QKZCHS7FE2JUP5UBJQNLWM75WXQNGGWCE5J4KBNG` |
| ZK Verifier | `CCMPSC6TGBPJEG4UCJ3YC2BWBPJSGABAE767FMD23V63FN2RJYELYKMC` |
| UltraHonk Verifier | `CAEOSCRFS57THHXU6HG3WISWOGKNNJO44RAR25F3OFMGWSJORX2I6XIV` |
| Game Hub | `CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG` |
| Leaderboard | `CDRXYYX5MNJO3ORK7X2NSQN2DQNSSK4GDDMHZJFROMGJGCWCO57IQKVD` |