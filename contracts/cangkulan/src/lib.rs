#![no_std]

//! # Cangkulan Lite
//!
//! A two-player Indonesian card game using a 36-card deck (4 suits × values 2-10).
//! The draw pile acts as "lead" — a flipped card determines the suit for each trick.
//!
//! ## Game flow
//! 1. Both players commit a random seed hash (ZK commitment).
//! 2. Both players reveal their seed (verified by on-chain ZK verifier).
//! 3. Seeds are combined to derive a deterministic PRNG seed for the deck shuffle.
//! 4. 5 cards dealt to each player, 26 go to the draw pile.
//! 5. A card is flipped from the draw pile — its suit is the trick suit.
//! 6. Each trick uses a **commit-reveal** protocol:
//!    a. Both players commit `keccak256(action || salt)` where action is either
//!       `card_id` (0-35) or `CANNOT_FOLLOW_SENTINEL` (0xFFFFFFFF).
//!    b. Once both have committed, both reveal their action + salt.
//!    c. The contract verifies the reveal matches the commit, validates the
//!       action (card in hand, correct suit, etc.), and resolves the trick.
//!    This prevents opponents from seeing each other's card choices before
//!    both have committed.
//! 7. Winner: first to empty their hand, or fewer cards when the pile runs out.
//!    Tiebreaker: most tricks won, then lowest total card value, then draw.
//!
//! ## Card encoding
//! `card_id = suit * 9 + (value - 2)` where suit ∈ [0,3] and value ∈ [2,10].
//! Decode: `suit = id / 9`, `value = id % 9 + 2`.
//!
//! ## ZK seed commitment
//! Uses an on-chain ZK verifier contract for provably fair shuffle.
//! `commit_hash = keccak256(seed || player_address)`, verified on-chain.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, vec,
    Address, Bytes, BytesN, Env, IntoVal, Vec,
};
use soroban_sdk::crypto::bls12_381::{Fr, G1Affine};

// ═══════════════════════════════════════════════════════════════════════════════
//  Contract Events
// ═══════════════════════════════════════════════════════════════════════════════

#[contractevent]
pub struct EvGameStarted {
    pub session_id: u32,
    pub player1: Address,
    pub player2: Address,
}

#[contractevent]
pub struct EvSeedCommitted {
    pub session_id: u32,
    pub player: Address,
}

#[contractevent]
pub struct EvSeedRevealed {
    pub session_id: u32,
    pub player: Address,
}

#[contractevent]
pub struct EvDeckShuffled {
    pub session_id: u32,
}

/// Emitted when a player commits their play (card_id is hidden).
#[contractevent]
pub struct EvPlayCommitted {
    pub session_id: u32,
    pub player: Address,
}

/// Emitted when a ZK ring sigma proof validates a card play commitment.
#[contractevent]
pub struct EvZkCardPlayVerified {
    pub session_id: u32,
    pub player: Address,
    pub valid_set_size: u32,
}

/// Emitted when a ZK cangkul hand proof validates a cannot-follow-suit claim.
#[contractevent]
pub struct EvZkCangkulVerified {
    pub session_id: u32,
    pub player: Address,
    pub hand_size: u32,
    pub trick_suit: u32,
}

/// Emitted when a player reveals their play (card_id now visible).
#[contractevent]
pub struct EvPlayRevealed {
    pub session_id: u32,
    pub player: Address,
    pub card_id: u32,       // actual card_id or CANNOT_FOLLOW_SENTINEL
    pub is_cangkul: bool,   // true if player declared cannot follow
}

#[contractevent]
pub struct EvTrickResolved {
    pub session_id: u32,
    pub winner: u32,
    pub card1: Option<u32>,
    pub card2: Option<u32>,
}

#[contractevent]
pub struct EvGameEnded {
    pub session_id: u32,
    pub outcome: u32,
}

#[contractevent]
pub struct EvHubStartReported {
    pub session_id: u32,
    pub hub: Address,
}

#[contractevent]
pub struct EvHubEndReported {
    pub session_id: u32,
    pub hub: Address,
    pub player1_won: bool,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  External trait interfaces
// ═══════════════════════════════════════════════════════════════════════════════

#[contractclient(name = "GameHubClient")]
pub trait CangkulanGameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );

    fn end_game(env: Env, session_id: u32, player1_won: bool);
}

/// ZK verifier for seed commitment.
///
/// Public inputs layout for seed verification:
///   [0..32)   seed_value     : 32 bytes (the revealed seed)
///   [32..64)  commit_hash    : 32 bytes (keccak256 commitment)
///   [64..68)  session_id     : u32 big-endian
///   [68..)    player         : variable-length address string bytes
///
/// Proof layout: [0..32) salt : 32 bytes
#[contractclient(name = "ZkVerifierClient")]
pub trait ZkVerifier {
    fn verify(env: Env, public_inputs: Bytes, proof: Bytes) -> bool;
}

/// UltraHonk verifier for Noir ZK proofs (UltraKeccakHonk proving system).
///
/// This verifier contract is deployed separately with a verification key
/// baked in at deploy time. It verifies Noir circuit proofs on-chain.
/// Used as an optional alternative to the Pedersen/NIZK verifier.
#[contractclient(name = "UltraHonkClient")]
pub trait UltraHonkVerifier {
    fn verify_proof(env: Env, public_inputs: Bytes, proof_bytes: Bytes);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Errors
// ═══════════════════════════════════════════════════════════════════════════════

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CangkulanError {
    GameNotFound = 1,
    SessionAlreadyExists = 2,
    NotAPlayer = 3,
    SelfPlayNotAllowed = 4,
    GameAlreadyEnded = 5,
    WrongPhase = 6,
    CommitAlreadySubmitted = 7,
    RevealAlreadySubmitted = 8,
    CommitHashMismatch = 9,
    InvalidZkProof = 10,
    MissingCommit = 11,
    NotYourTurn = 12,
    CardNotInHand = 13,
    WrongSuit = 14,
    HasMatchingSuit = 15,
    DrawPileEmpty = 16,
    NoTrickInProgress = 17,
    AdminNotSet = 18,
    GameHubNotSet = 19,
    VerifierNotSet = 20,
    TimeoutNotReached = 21,
    TimeoutNotConfigured = 22,
    TimeoutNotApplicable = 23,
    WeakSeedEntropy = 24,
    InvalidNonce = 25,
    PlayCommitAlreadySubmitted = 26,
    PlayCommitMissing = 27,
    PlayRevealMismatch = 28,
    InvalidCardId = 29,
    UltraHonkVerifierNotSet = 30,
    UltraHonkVerificationFailed = 31,
    ZkPlayProofInvalid = 32,
    ZkPlaySetEmpty = 33,
    ZkPlayOpeningMismatch = 34,
    ZkCangkulProofInvalid = 35,
    TickTooSoon = 38,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Lifecycle states (compact u32 encoding for storage efficiency)
// ═══════════════════════════════════════════════════════════════════════════════

pub(crate) type LifecycleState = u32;

pub const STATE_SEED_COMMIT: LifecycleState = 1;
pub const STATE_SEED_REVEAL: LifecycleState = 2;
pub const STATE_PLAYING: LifecycleState = 3;
pub const STATE_FINISHED: LifecycleState = 4;

// Trick sub-states (who the contract is waiting for)
//
// Commit-Reveal protocol for each trick:
//   COMMIT_WAIT_BOTH → COMMIT_WAIT_P1/P2 → REVEAL_WAIT_BOTH → REVEAL_WAIT_P1/P2 → NONE (resolved)
pub(crate) type TrickState = u32;

pub const TRICK_NONE: TrickState = 0;
// Legacy states 1-3 removed (old direct play_card).
// New commit-reveal states:
pub const TRICK_COMMIT_WAIT_BOTH: TrickState = 10;
pub const TRICK_COMMIT_WAIT_P1: TrickState = 11;
pub const TRICK_COMMIT_WAIT_P2: TrickState = 12;
pub const TRICK_REVEAL_WAIT_BOTH: TrickState = 20;
pub const TRICK_REVEAL_WAIT_P1: TrickState = 21;
pub const TRICK_REVEAL_WAIT_P2: TrickState = 22;

/// Sentinel card_id used in commit_play to signal "cannot follow suit".
pub const CANNOT_FOLLOW_SENTINEL: u32 = 0xFFFF_FFFF;

// Outcome codes
pub(crate) type Outcome = u32;

pub const OUTCOME_UNRESOLVED: Outcome = 0;
pub const OUTCOME_PLAYER1_WIN: Outcome = 1;
pub const OUTCOME_PLAYER2_WIN: Outcome = 2;
pub const OUTCOME_DRAW: Outcome = 3;

// Player slots
const PLAYER_1: u32 = 1;
const PLAYER_2: u32 = 2;

// ═══════════════════════════════════════════════════════════════════════════════
//  Game state & storage keys
// ═══════════════════════════════════════════════════════════════════════════════

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CangkulanGame {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    // Seed commitment phase (NIZK ZK proof)
    pub seed_commit1: Option<BytesN<32>>,
    pub seed_commit2: Option<BytesN<32>>,
    pub seed_hash1: Option<BytesN<32>>,
    pub seed_hash2: Option<BytesN<32>>,
    pub seed_revealed1: bool,
    pub seed_revealed2: bool,
    // Hands and draw pile (card IDs 0-35)
    pub hand1: Vec<u32>,
    pub hand2: Vec<u32>,
    pub draw_pile: Vec<u32>,
    // Current trick
    pub trick_state: u32,
    pub trick_suit: Option<u32>,
    pub trick_card1: Option<u32>,
    pub trick_card2: Option<u32>,
    pub flipped_card: Option<u32>,
    // Commit-reveal for card plays
    pub play_commit1: Option<BytesN<32>>,
    pub play_commit2: Option<BytesN<32>>,
    // ZK card play flags (true = Pedersen commit, false = keccak256 commit)
    pub zk_play1: bool,
    pub zk_play2: bool,
    // Scoring
    pub tricks_won1: u32,
    pub tricks_won2: u32,
    // State machine
    pub lifecycle_state: u32,
    pub outcome: u32,
    // Timeout
    pub action_nonce: u32,
    pub deadline_nonce: Option<u32>,
    pub deadline_ledger: Option<u32>,
    /// Ledger sequence of the last tick_timeout call (rate limiting)
    pub last_tick_ledger: u32,
}

/// Compact summary of a finished game, stored persistently per player.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GameSummary {
    pub session_id: u32,
    pub opponent: Address,
    pub outcome: u32,        // 1=win, 2=loss, 3=draw (from this player's perspective)
    pub tricks_won: u32,
    pub tricks_lost: u32,
    pub ledger: u32,         // ledger sequence when game ended
}

#[contracttype]
#[derive(Clone)]
enum StorageKey {
    Game(u32),
    Admin,
    GameHubAddress,
    VerifierAddress,
    UltraHonkVerifierAddress,
    PlayerHistory(Address),
    /// Flag: Noir proof verified for (session_id, player_slot).
    /// Stored in temp storage; consumed by `reveal_seed`.
    NoirSeedVerified(u32, u32),
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

const DECK_SIZE: u32 = 36;
const CARDS_PER_SUIT: u32 = 9;
const HAND_SIZE: u32 = 5;
const TIMEOUT_ACTIONS: u32 = 2;

// Ledger rate is approximately 5 seconds per ledger on Stellar
const LEDGER_RATE_SECS: u32 = 5;

// Timeout for player actions: ~10 minutes
const TIMEOUT_MINUTES: u32 = 10;
const TIMEOUT_LEDGERS: u32 = TIMEOUT_MINUTES * 60 / LEDGER_RATE_SECS; // ~120 ledgers

/// Minimum ledger gap between tick_timeout calls to prevent nonce-pump exploit.
/// Equal to TIMEOUT_LEDGERS / TIMEOUT_ACTIONS so that the nonce path cannot
/// resolve faster than the ledger deadline.
const MIN_TICK_GAP_LEDGERS: u32 = TIMEOUT_LEDGERS / TIMEOUT_ACTIONS; // ~60 ledgers = ~5 min

// TTL expressed in human-readable time units (30 days)
const TTL_SECONDS: u32 = 30 * 24 * 60 * 60;      // 2,592,000 seconds

/// TTL for game storage in ledgers: 30 * 24 * 60 * 60 / 5 = 518,400 ledgers
const GAME_TTL_LEDGERS: u32 = TTL_SECONDS / LEDGER_RATE_SECS;

// History TTL: 120 days — persistent storage for player game history
const HISTORY_TTL_SECONDS: u32 = 120 * 24 * 60 * 60; // 10,368,000 seconds
const HISTORY_TTL_LEDGERS: u32 = HISTORY_TTL_SECONDS / LEDGER_RATE_SECS; // 2,073,600 ledgers

/// Max game summaries stored per player (ring buffer)
const MAX_HISTORY_PER_PLAYER: u32 = 50;

// ═══════════════════════════════════════════════════════════════════════════════
//  Contract
// ═══════════════════════════════════════════════════════════════════════════════

#[contract]
pub struct CangkulanContract;

#[contractimpl]
impl CangkulanContract {
    // ───────────────────────────────────────────────────────────────────────────
    //  Public: Constructor & Lifecycle
    // ───────────────────────────────────────────────────────────────────────────

    pub fn __constructor(env: Env, admin: Address, game_hub: Address, verifier: Address) {
        env.storage()
            .instance()
            .set(&StorageKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&StorageKey::GameHubAddress, &game_hub);
        env.storage()
            .instance()
            .set(&StorageKey::VerifierAddress, &verifier);
    }

    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), CangkulanError> {
        if player1 == player2 {
            return Err(CangkulanError::SelfPlayNotAllowed);
        }

        player1.require_auth_for_args(vec![
            &env,
            session_id.into_val(&env),
            player1_points.into_val(&env),
        ]);
        player2.require_auth_for_args(vec![
            &env,
            session_id.into_val(&env),
            player2_points.into_val(&env),
        ]);

        let key = StorageKey::Game(session_id);
        if env.storage().temporary().has(&key) {
            return Err(CangkulanError::SessionAlreadyExists);
        }

        // Game Hub lifecycle: start_game BEFORE storing state.
        let hub_addr = Self::load_hub(&env)?;
        let hub = GameHubClient::new(&env, &hub_addr);
        hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        EvHubStartReported {
            session_id,
            hub: hub_addr,
        }.publish(&env);

        let game = CangkulanGame {
            player1,
            player2,
            player1_points,
            player2_points,
            seed_commit1: None,
            seed_commit2: None,
            seed_hash1: None,
            seed_hash2: None,
            seed_revealed1: false,
            seed_revealed2: false,
            hand1: Vec::new(&env),
            hand2: Vec::new(&env),
            draw_pile: Vec::new(&env),
            trick_state: TRICK_NONE,
            trick_suit: None,
            trick_card1: None,
            trick_card2: None,
            flipped_card: None,
            play_commit1: None,
            play_commit2: None,
            zk_play1: false,
            zk_play2: false,
            tricks_won1: 0,
            tricks_won2: 0,
            lifecycle_state: STATE_SEED_COMMIT,
            outcome: OUTCOME_UNRESOLVED,
            action_nonce: 0,
            deadline_nonce: None,
            deadline_ledger: None,
            last_tick_ledger: 0,
        };

        EvGameStarted {
            session_id,
            player1: game.player1.clone(),
            player2: game.player2.clone(),
        }.publish(&env);

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  Public: Seed Commit-Reveal
    // ───────────────────────────────────────────────────────────────────────────

    /// Commit a seed hash. Both players must commit before reveal begins.
    pub fn commit_seed(
        env: Env,
        session_id: u32,
        player: Address,
        commit_hash: BytesN<32>,
    ) -> Result<(), CangkulanError> {
        player.require_auth();

        let mut game = Self::read_game(&env, session_id)?;
        if game.lifecycle_state != STATE_SEED_COMMIT {
            return Err(CangkulanError::WrongPhase);
        }

        let slot = Self::resolve_slot(&game, &player)?;
        match slot {
            PLAYER_1 => {
                if game.seed_commit1.is_some() {
                    return Err(CangkulanError::CommitAlreadySubmitted);
                }
                game.seed_commit1 = Some(commit_hash);
            }
            _ => {
                if game.seed_commit2.is_some() {
                    return Err(CangkulanError::CommitAlreadySubmitted);
                }
                game.seed_commit2 = Some(commit_hash);
            }
        }

        Self::bump_nonce(&mut game);

        // Start deadline on first commit
        if game.deadline_nonce.is_none() {
            game.deadline_nonce =
                Some(game.action_nonce.saturating_add(TIMEOUT_ACTIONS));
            game.deadline_ledger =
                Some(env.ledger().sequence().saturating_add(TIMEOUT_LEDGERS));
        }

        EvSeedCommitted {
            session_id,
            player: player.clone(),
        }.publish(&env);

        // Transition to reveal phase when both committed
        if game.seed_commit1.is_some() && game.seed_commit2.is_some() {
            game.lifecycle_state = STATE_SEED_REVEAL;
            game.deadline_nonce =
                Some(game.action_nonce.saturating_add(TIMEOUT_ACTIONS));
            game.deadline_ledger =
                Some(env.ledger().sequence().saturating_add(TIMEOUT_LEDGERS));
        }

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    /// Reveal a seed using a Zero-Knowledge Proof. The raw seed is
    /// **never** submitted on-chain; only `seed_hash = keccak256(seed)` is
    /// revealed. The proof demonstrates knowledge of the seed without
    /// disclosing it, verified via the ZK verifier contract.
    ///
    /// Two proof modes are supported (auto-detected by proof length):
    ///
    /// **NIZK Mode (64 bytes):** `blinding(32) || response(32)`
    ///   Hash-based Fiat-Shamir proof.
    ///
    /// **Pedersen Mode (224 bytes):** `C(96) || R(96) || z_r(32)`
    ///   BLS12-381 Pedersen commitment + Schnorr on blinding.
    ///   commit_hash = keccak256(C), verified on-chain for binding.
    ///
    /// Once both seeds are revealed, the deck is shuffled and cards are dealt.
    ///
    /// # Arguments
    /// * `seed_hash` - `keccak256(seed)`, the one-way hash of the raw seed
    /// * `proof` - ZK proof (64 bytes for NIZK, 224 bytes for Pedersen)
    pub fn reveal_seed(
        env: Env,
        session_id: u32,
        player: Address,
        seed_hash: BytesN<32>,
        proof: Bytes,
    ) -> Result<(), CangkulanError> {
        player.require_auth();

        let mut game = Self::read_game(&env, session_id)?;
        if game.lifecycle_state != STATE_SEED_REVEAL {
            return Err(CangkulanError::WrongPhase);
        }

        let slot = Self::resolve_slot(&game, &player)?;

        // Verify seed_hash against commitment
        let commit_hash = match slot {
            PLAYER_1 => {
                if game.seed_revealed1 {
                    return Err(CangkulanError::RevealAlreadySubmitted);
                }
                game.seed_commit1
                    .clone()
                    .ok_or(CangkulanError::MissingCommit)?
            }
            _ => {
                if game.seed_revealed2 {
                    return Err(CangkulanError::RevealAlreadySubmitted);
                }
                game.seed_commit2
                    .clone()
                    .ok_or(CangkulanError::MissingCommit)?
            }
        };

        // Reject trivially weak seed hashes
        Self::check_seed_entropy(&seed_hash)?;

        // Call NIZK ZK verifier for on-chain proof verification.
        // The verifier checks:
        //   1. keccak256(seed_hash || blinding || address) == commitment
        //   2. nullifier derivation matches session
        //   3. Fiat-Shamir response is valid
        //   4. Entropy check on seed_hash
        Self::call_seed_verifier(&env, session_id, slot, &player, &seed_hash, &commit_hash, &proof)?;

        // Mark as revealed and store seed_hash for shuffle derivation
        match slot {
            PLAYER_1 => {
                game.seed_revealed1 = true;
                game.seed_hash1 = Some(seed_hash.clone());
            }
            _ => {
                game.seed_revealed2 = true;
                game.seed_hash2 = Some(seed_hash.clone());
            }
        }

        Self::bump_nonce(&mut game);

        EvSeedRevealed {
            session_id,
            player: player.clone(),
        }.publish(&env);

        // Both revealed → shuffle and deal
        if game.seed_revealed1 && game.seed_revealed2 {
            Self::shuffle_and_deal(&env, &mut game, session_id);
            game.lifecycle_state = STATE_PLAYING;

            EvDeckShuffled { session_id }.publish(&env);

            // Flip the first card from draw pile
            Self::flip_next_card(&env, &mut game);
            game.deadline_nonce =
                Some(game.action_nonce.saturating_add(TIMEOUT_ACTIONS));
            game.deadline_ledger =
                Some(env.ledger().sequence().saturating_add(TIMEOUT_LEDGERS));
        }

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  Public: Game Actions (Commit-Reveal)
    // ───────────────────────────────────────────────────────────────────────────

    /// Commit a play action: `commit_hash = keccak256(action_u32_be || salt)`.
    ///
    /// `action` is either a valid `card_id` (0-35) to play a card, or
    /// `CANNOT_FOLLOW_SENTINEL` (0xFFFFFFFF) to declare cannot follow suit.
    /// The actual action is hidden until both players have committed.
    ///
    /// `expected_nonce` must equal the current `action_nonce` to prevent
    /// replay attacks and stale-state submissions.
    pub fn commit_play(
        env: Env,
        session_id: u32,
        player: Address,
        commit_hash: BytesN<32>,
        expected_nonce: u32,
    ) -> Result<(), CangkulanError> {
        player.require_auth();

        let mut game = Self::read_game(&env, session_id)?;
        if game.lifecycle_state != STATE_PLAYING {
            return Err(CangkulanError::WrongPhase);
        }
        if expected_nonce != game.action_nonce {
            return Err(CangkulanError::InvalidNonce);
        }

        let slot = Self::resolve_slot(&game, &player)?;
        Self::require_commit_phase(&game, slot)?;

        match slot {
            PLAYER_1 => {
                if game.play_commit1.is_some() {
                    return Err(CangkulanError::PlayCommitAlreadySubmitted);
                }
                game.play_commit1 = Some(commit_hash);
            }
            _ => {
                if game.play_commit2.is_some() {
                    return Err(CangkulanError::PlayCommitAlreadySubmitted);
                }
                game.play_commit2 = Some(commit_hash);
            }
        }

        EvPlayCommitted {
            session_id,
            player: player.clone(),
        }.publish(&env);

        // Advance commit state
        Self::advance_commit_state(&mut game, slot);
        Self::bump_nonce(&mut game);

        // Reset deadline on state transition
        game.deadline_nonce = Some(game.action_nonce.saturating_add(TIMEOUT_ACTIONS));
        game.deadline_ledger = Some(env.ledger().sequence().saturating_add(TIMEOUT_LEDGERS));

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    /// Commit a play action with a ZK ring sigma proof of suit compliance.
    ///
    /// `commit_hash = keccak256(C_bytes)` where C is a BLS12-381 Pedersen
    /// commitment to the card_id: `C = card_id·G + blinding·H`.
    ///
    /// `zk_proof` is the ring sigma proof: `C(96) || [e_i(32) || z_i(32)] × N`
    /// proving the committed card is in the player's valid set (hand ∩ trick suit)
    /// without revealing which specific card.
    ///
    /// The ZK verifier (Mode 7) checks the ring sigma and binding.
    pub fn commit_play_zk(
        env: Env,
        session_id: u32,
        player: Address,
        commit_hash: BytesN<32>,
        expected_nonce: u32,
        zk_proof: Bytes,
    ) -> Result<(), CangkulanError> {
        player.require_auth();

        let mut game = Self::read_game(&env, session_id)?;
        if game.lifecycle_state != STATE_PLAYING {
            return Err(CangkulanError::WrongPhase);
        }
        if expected_nonce != game.action_nonce {
            return Err(CangkulanError::InvalidNonce);
        }

        let slot = Self::resolve_slot(&game, &player)?;
        Self::require_commit_phase(&game, slot)?;

        match slot {
            PLAYER_1 => {
                if game.play_commit1.is_some() {
                    return Err(CangkulanError::PlayCommitAlreadySubmitted);
                }
            }
            _ => {
                if game.play_commit2.is_some() {
                    return Err(CangkulanError::PlayCommitAlreadySubmitted);
                }
            }
        }

        // Compute the valid set: cards in hand matching the trick suit
        let trick_suit = game.trick_suit.ok_or(CangkulanError::NoTrickInProgress)?;
        let hand = Self::get_hand(&game, slot);
        let mut valid_set: Vec<u32> = Vec::new(&env);
        let mut vi = 0u32;
        while vi < hand.len() {
            let card = hand.get(vi).unwrap();
            if card / CARDS_PER_SUIT == trick_suit {
                valid_set.push_back(card);
            }
            vi += 1;
        }
        let n = valid_set.len();
        if n == 0 {
            return Err(CangkulanError::ZkPlaySetEmpty);
        }

        // Build public_inputs for ZK verifier Mode 7:
        // commit_hash(32) || N(4, u32 BE) || valid_set[N](4 each, u32 BE) || session_id(4) || player(var)
        let mut public_inputs = Bytes::from_array(&env, &commit_hash.to_array());
        public_inputs.append(&Bytes::from_array(&env, &n.to_be_bytes()));
        let mut wi = 0u32;
        while wi < n {
            let card = valid_set.get(wi).unwrap();
            public_inputs.append(&Bytes::from_array(&env, &card.to_be_bytes()));
            wi += 1;
        }
        public_inputs.append(&Bytes::from_array(&env, &session_id.to_be_bytes()));
        public_inputs.append(&player.to_string().to_bytes());

        // Call ZK verifier
        let verifier_addr = Self::load_verifier(&env)?;
        let verifier = ZkVerifierClient::new(&env, &verifier_addr);
        if !verifier.verify(&public_inputs, &zk_proof) {
            return Err(CangkulanError::ZkPlayProofInvalid);
        }

        // Store commit and set ZK flag
        match slot {
            PLAYER_1 => {
                game.play_commit1 = Some(commit_hash);
                game.zk_play1 = true;
            }
            _ => {
                game.play_commit2 = Some(commit_hash);
                game.zk_play2 = true;
            }
        }

        EvZkCardPlayVerified {
            session_id,
            player: player.clone(),
            valid_set_size: n,
        }.publish(&env);

        EvPlayCommitted {
            session_id,
            player: player.clone(),
        }.publish(&env);

        // Advance commit state
        Self::advance_commit_state(&mut game, slot);
        Self::bump_nonce(&mut game);

        // Reset deadline on state transition
        game.deadline_nonce = Some(game.action_nonce.saturating_add(TIMEOUT_ACTIONS));
        game.deadline_ledger = Some(env.ledger().sequence().saturating_add(TIMEOUT_LEDGERS));

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    /// Commit a cangkul (cannot follow suit) action with a ZK hand proof.
    ///
    /// The player proves that NONE of the cards in their hand match
    /// the current trick suit. Uses an aggregate Pedersen commitment
    /// over the entire hand with a Schnorr proof of knowledge.
    ///
    /// `commit_hash = keccak256(A_bytes)` where A is the aggregate
    /// Pedersen commitment: `A = Σ(card_i·G + r_i·H)`.
    ///
    /// `zk_proof` layout: `k(4) || A(96, G1) || R(96, G1) || z(32, Fr) = 228 bytes`
    ///
    /// The ZK verifier (Mode 8) checks:
    /// 1. Aggregate Pedersen binding (keccak256(A) == commit_hash)
    /// 2. Schnorr proof of knowledge of aggregate blinding
    /// 3. Suit exclusion: no card matches trick_suit
    pub fn commit_cangkul_zk(
        env: Env,
        session_id: u32,
        player: Address,
        commit_hash: BytesN<32>,
        expected_nonce: u32,
        zk_proof: Bytes,
    ) -> Result<(), CangkulanError> {
        player.require_auth();

        let mut game = Self::read_game(&env, session_id)?;
        if game.lifecycle_state != STATE_PLAYING {
            return Err(CangkulanError::WrongPhase);
        }
        if expected_nonce != game.action_nonce {
            return Err(CangkulanError::InvalidNonce);
        }

        let slot = Self::resolve_slot(&game, &player)?;
        Self::require_commit_phase(&game, slot)?;

        match slot {
            PLAYER_1 => {
                if game.play_commit1.is_some() {
                    return Err(CangkulanError::PlayCommitAlreadySubmitted);
                }
            }
            _ => {
                if game.play_commit2.is_some() {
                    return Err(CangkulanError::PlayCommitAlreadySubmitted);
                }
            }
        }

        // Verify: player has no cards matching the trick suit
        let trick_suit = game.trick_suit.ok_or(CangkulanError::NoTrickInProgress)?;
        let hand = Self::get_hand(&game, slot);
        if Self::has_suit_in_hand(&hand, trick_suit) {
            return Err(CangkulanError::HasMatchingSuit);
        }

        let k = hand.len();

        // Build public_inputs for ZK verifier Mode 8:
        // commit_hash(32) || trick_suit(4) || k(4) || cards[k](4 each) || session_id(4) || player(var)
        let mut public_inputs = Bytes::from_array(&env, &commit_hash.to_array());
        public_inputs.append(&Bytes::from_array(&env, &trick_suit.to_be_bytes()));
        public_inputs.append(&Bytes::from_array(&env, &k.to_be_bytes()));
        let mut wi = 0u32;
        while wi < k {
            let card = hand.get(wi).unwrap();
            public_inputs.append(&Bytes::from_array(&env, &card.to_be_bytes()));
            wi += 1;
        }
        public_inputs.append(&Bytes::from_array(&env, &session_id.to_be_bytes()));
        public_inputs.append(&player.to_string().to_bytes());

        // Call ZK verifier (auto-detects Mode 8 from 228-byte proof)
        let verifier_addr = Self::load_verifier(&env)?;
        let verifier = ZkVerifierClient::new(&env, &verifier_addr);
        if !verifier.verify(&public_inputs, &zk_proof) {
            return Err(CangkulanError::ZkCangkulProofInvalid);
        }

        // Store commit and set ZK flag
        match slot {
            PLAYER_1 => {
                game.play_commit1 = Some(commit_hash);
                game.zk_play1 = true;
            }
            _ => {
                game.play_commit2 = Some(commit_hash);
                game.zk_play2 = true;
            }
        }

        EvZkCangkulVerified {
            session_id,
            player: player.clone(),
            hand_size: k,
            trick_suit,
        }.publish(&env);

        EvPlayCommitted {
            session_id,
            player: player.clone(),
        }.publish(&env);

        // Advance commit state
        Self::advance_commit_state(&mut game, slot);
        Self::bump_nonce(&mut game);

        // Reset deadline on state transition
        game.deadline_nonce = Some(game.action_nonce.saturating_add(TIMEOUT_ACTIONS));
        game.deadline_ledger = Some(env.ledger().sequence().saturating_add(TIMEOUT_LEDGERS));

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    /// Reveal a previously committed play action.
    ///
    /// `card_id` is the actual card to play (0-35), or `CANNOT_FOLLOW_SENTINEL`
    /// to declare cannot follow suit.
    /// `salt` is the random 32-byte value used in the commit:
    ///   - Legacy mode: keccak256(card_id_u32_be || salt) == commit_hash
    ///   - ZK mode: salt = blinding factor; keccak256(card_id·G + blinding·H) == commit_hash
    pub fn reveal_play(
        env: Env,
        session_id: u32,
        player: Address,
        card_id: u32,
        salt: BytesN<32>,
    ) -> Result<(), CangkulanError> {
        player.require_auth();

        let mut game = Self::read_game(&env, session_id)?;
        if game.lifecycle_state != STATE_PLAYING {
            return Err(CangkulanError::WrongPhase);
        }

        let slot = Self::resolve_slot(&game, &player)?;
        Self::require_reveal_phase(&game, slot)?;

        // Verify commit hash matches
        let commit = match slot {
            PLAYER_1 => game.play_commit1.clone().ok_or(CangkulanError::PlayCommitMissing)?,
            _ => game.play_commit2.clone().ok_or(CangkulanError::PlayCommitMissing)?,
        };

        let is_zk = match slot {
            PLAYER_1 => game.zk_play1,
            _ => game.zk_play2,
        };

        let is_cangkul = card_id == CANNOT_FOLLOW_SENTINEL;

        if is_zk {
            if is_cangkul {
                // Mode 8 aggregate opening: A = (Σhand_card_i)·G + r_agg·H
                // The player supplies r_agg as the `salt`.
                let hand = Self::get_hand(&game, slot);
                let card_sum: u32 = hand.iter().sum();
                let a_point = Self::pedersen_commit(&env, card_sum, &salt);
                let a_bytes = a_point.to_bytes();
                let computed_hash: BytesN<32> = env.crypto().keccak256(
                    &Bytes::from_array(&env, &a_bytes.to_array())
                ).into();
                if computed_hash != commit {
                    return Err(CangkulanError::ZkPlayOpeningMismatch);
                }
            } else {
                // Mode 7 single Pedersen opening: C = card_id·G + blinding·H
                let c_point = Self::pedersen_commit(&env, card_id, &salt);
                let c_bytes = c_point.to_bytes();
                let computed_hash: BytesN<32> = env.crypto().keccak256(
                    &Bytes::from_array(&env, &c_bytes.to_array())
                ).into();
                if computed_hash != commit {
                    return Err(CangkulanError::ZkPlayOpeningMismatch);
                }
            }
        } else {
            // Legacy keccak256 hash opening
            let mut preimage = Bytes::from_array(&env, &card_id.to_be_bytes());
            preimage.append(&Bytes::from_array(&env, &salt.to_array()));
            let computed_hash: BytesN<32> = env.crypto().keccak256(&preimage).into();
            if computed_hash != commit {
                return Err(CangkulanError::PlayRevealMismatch);
            }
        }

        if is_cangkul {
            // Validate: player truly has no matching suit cards
            let hand = Self::get_hand(&game, slot);
            let trick_suit = game.trick_suit.ok_or(CangkulanError::NoTrickInProgress)?;
            if Self::has_suit_in_hand(&hand, trick_suit) {
                return Err(CangkulanError::HasMatchingSuit);
            }
            // trick_card for this slot remains None — signals cannot_follow
        } else {
            // Validate card_id range
            if card_id >= DECK_SIZE {
                return Err(CangkulanError::InvalidCardId);
            }

            // Validate card is in hand
            let hand = Self::get_hand(&game, slot);
            let card_pos = Self::find_card_position(&hand, card_id)?;

            // Validate card matches trick suit
            let trick_suit = game.trick_suit.ok_or(CangkulanError::NoTrickInProgress)?;
            let card_suit = card_id / CARDS_PER_SUIT;
            if card_suit != trick_suit {
                return Err(CangkulanError::WrongSuit);
            }

            // Remove card from hand and record it
            let mut hand = hand;
            hand.remove(card_pos);
            Self::set_hand(&mut game, slot, hand);

            match slot {
                PLAYER_1 => game.trick_card1 = Some(card_id),
                _ => game.trick_card2 = Some(card_id),
            }
        }

        EvPlayRevealed {
            session_id,
            player: player.clone(),
            card_id,
            is_cangkul,
        }.publish(&env);

        // Advance reveal state
        Self::advance_reveal_state(&mut game, slot);
        Self::bump_nonce(&mut game);

        // If both have revealed, resolve the trick
        if game.trick_state == TRICK_NONE {
            Self::resolve_trick(&env, session_id, &mut game)?;
        } else {
            // Reset deadline for reveal phase
            game.deadline_nonce = Some(game.action_nonce.saturating_add(TIMEOUT_ACTIONS));
            game.deadline_ledger = Some(env.ledger().sequence().saturating_add(TIMEOUT_LEDGERS));
        }

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  Public: Timeout
    // ───────────────────────────────────────────────────────────────────────────

    pub fn tick_timeout(
        env: Env,
        session_id: u32,
        caller: Address,
    ) -> Result<u32, CangkulanError> {
        caller.require_auth();

        let mut game = Self::read_game(&env, session_id)?;
        Self::require_active(&game)?;
        // Only participants may tick the timeout clock
        Self::resolve_slot(&game, &caller)?;

        // Rate-limit: enforce minimum ledger gap between ticks to prevent
        // nonce-pump exploits (calling tick_timeout rapidly to force-win).
        let current_ledger = env.ledger().sequence();
        if current_ledger < game.last_tick_ledger.saturating_add(MIN_TICK_GAP_LEDGERS) {
            return Err(CangkulanError::TickTooSoon);
        }
        game.last_tick_ledger = current_ledger;

        Self::bump_nonce(&mut game);
        Self::write_game(&env, session_id, &game);
        Ok(game.action_nonce)
    }

    pub fn resolve_timeout(
        env: Env,
        session_id: u32,
        caller: Address,
    ) -> Result<(), CangkulanError> {
        caller.require_auth();

        let mut game = Self::read_game(&env, session_id)?;
        Self::require_active(&game)?;
        // Only players in the game may resolve a timeout
        Self::resolve_slot(&game, &caller)?;

        let deadline = game
            .deadline_nonce
            .ok_or(CangkulanError::TimeoutNotConfigured)?;

        // Timeout is reached if EITHER the nonce deadline passed OR
        // the ledger-based deadline has elapsed.
        let nonce_expired = game.action_nonce >= deadline;
        let ledger_expired = game
            .deadline_ledger
            .map_or(false, |dl| env.ledger().sequence() >= dl);

        if !nonce_expired && !ledger_expired {
            return Err(CangkulanError::TimeoutNotReached);
        }

        let outcome = Self::determine_timeout_outcome(&game)?;
        Self::finalize_game(&env, session_id, &mut game, outcome)?;

        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  Public: Forfeit (Withdraw = Lose)
    // ───────────────────────────────────────────────────────────────────────────

    /// Forfeit the game. The caller immediately loses.
    ///
    /// This allows a player to withdraw from an active game at any point.
    /// The opponent is declared the winner. This is irreversible.
    pub fn forfeit(
        env: Env,
        session_id: u32,
        caller: Address,
    ) -> Result<(), CangkulanError> {
        caller.require_auth();

        let mut game = Self::read_game(&env, session_id)?;
        Self::require_active(&game)?;
        let slot = Self::resolve_slot(&game, &caller)?;

        // The caller loses — opponent wins
        let outcome = if slot == PLAYER_1 {
            OUTCOME_PLAYER2_WIN
        } else {
            OUTCOME_PLAYER1_WIN
        };

        Self::finalize_game(&env, session_id, &mut game, outcome)?;
        Self::write_game(&env, session_id, &game);
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  Public: Read & Admin
    // ───────────────────────────────────────────────────────────────────────────

    /// Get game state with both hands redacted for active games.
    ///
    /// Returns full state (including hands) only for FINISHED games.
    /// During active games, hands are cleared to prevent card snooping
    /// via unauthenticated RPC queries. Use `get_game_view` with a viewer
    /// address to see your own hand during gameplay.
    pub fn get_game(env: Env, session_id: u32) -> Result<CangkulanGame, CangkulanError> {
        let game = Self::read_game(&env, session_id)?;
        if game.lifecycle_state != STATE_FINISHED {
            let mut view = game;
            view.hand1 = Vec::new(&env);
            view.hand2 = Vec::new(&env);
            view.draw_pile = Vec::new(&env);
            Ok(view)
        } else {
            Ok(game)
        }
    }

    /// Get full raw game state (admin-only). Requires admin authentication.
    /// Used for debugging and post-game verification. For normal gameplay
    /// use `get_game_view` which respects player-level privacy.
    pub fn get_game_debug(env: Env, session_id: u32) -> Result<CangkulanGame, CangkulanError> {
        let admin = Self::load_admin(&env)?;
        admin.require_auth();
        Self::read_game(&env, session_id)
    }

    /// Get game state with privacy: only the viewer's own hand is visible.
    /// The opponent's hand is redacted (empty) to prevent casual snooping
    /// via RPC queries. Non-players see both hands redacted.
    /// During the reveal phase, the opponent's trick_card is also redacted
    /// (it only becomes visible after both players have revealed).
    pub fn get_game_view(
        env: Env,
        session_id: u32,
        viewer: Address,
    ) -> Result<CangkulanGame, CangkulanError> {
        let game = Self::read_game(&env, session_id)?;
        let mut view = game;
        match Self::resolve_slot(&view, &viewer) {
            Ok(PLAYER_1) => {
                view.hand2 = Vec::new(&env);
                // Redact P2's trick_card during reveal phase (P2 revealed but P1 hasn't yet)
                if view.trick_state == TRICK_REVEAL_WAIT_P1 {
                    view.trick_card2 = None;
                }
            }
            Ok(_) => {
                view.hand1 = Vec::new(&env);
                // Redact P1's trick_card during reveal phase (P1 revealed but P2 hasn't yet)
                if view.trick_state == TRICK_REVEAL_WAIT_P2 {
                    view.trick_card1 = None;
                }
            }
            Err(_) => {
                view.hand1 = Vec::new(&env);
                view.hand2 = Vec::new(&env);
            }
        }
        Ok(view)
    }

    /// Get a player's game history (up to 50 most recent games).
    /// Returns a Vec of GameSummary with outcome from the player's perspective:
    ///   1 = win, 2 = loss, 3 = draw
    pub fn get_player_history(
        env: Env,
        player: Address,
    ) -> Vec<GameSummary> {
        let key = StorageKey::PlayerHistory(player);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Recompute and return the full shuffled deck order from ZK-verified seed hashes.
    /// Anyone can call this to independently verify the shuffle was fair. The
    /// seed hashes are `keccak256(raw_seed)` — the raw seeds never appear on-chain.
    /// Only available after both seeds have been revealed (PLAYING or FINISHED).
    pub fn verify_shuffle(env: Env, session_id: u32) -> Result<Vec<u32>, CangkulanError> {
        let game = Self::read_game(&env, session_id)?;
        if game.lifecycle_state < STATE_PLAYING {
            return Err(CangkulanError::WrongPhase);
        }

        let sh1 = game.seed_hash1.clone().ok_or(CangkulanError::MissingCommit)?;
        let sh2 = game.seed_hash2.clone().ok_or(CangkulanError::MissingCommit)?;

        let mut seed_data = Bytes::from_array(&env, &sh1.to_array());
        seed_data.append(&Bytes::from_array(&env, &sh2.to_array()));
        seed_data.append(&Bytes::from_array(&env, &session_id.to_be_bytes()));
        let seed_hash = env.crypto().keccak256(&seed_data);
        env.prng().seed(seed_hash.into());

        let mut deck: [u32; 36] = [0; 36];
        let mut i: u32 = 0;
        while i < DECK_SIZE {
            deck[i as usize] = i;
            i += 1;
        }

        let mut idx = DECK_SIZE;
        while idx > 1 {
            idx -= 1;
            let j = env.prng().gen_range::<u64>(0..=(idx as u64)) as u32;
            let tmp = deck[idx as usize];
            deck[idx as usize] = deck[j as usize];
            deck[j as usize] = tmp;
        }

        let mut result = Vec::new(&env);
        let mut d: u32 = 0;
        while d < DECK_SIZE {
            result.push_back(deck[d as usize]);
            d += 1;
        }
        Ok(result)
    }

    pub fn get_admin(env: Env) -> Result<Address, CangkulanError> {
        Self::load_admin(&env)
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), CangkulanError> {
        let admin = Self::load_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&StorageKey::Admin, &new_admin);
        Ok(())
    }

    pub fn get_hub(env: Env) -> Result<Address, CangkulanError> {
        Self::load_hub(&env)
    }

    pub fn set_hub(env: Env, new_hub: Address) -> Result<(), CangkulanError> {
        let admin = Self::load_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&StorageKey::GameHubAddress, &new_hub);
        Ok(())
    }

    pub fn get_verifier(env: Env) -> Result<Address, CangkulanError> {
        Self::load_verifier(&env)
    }

    pub fn set_verifier(env: Env, new_verifier: Address) -> Result<(), CangkulanError> {
        let admin = Self::load_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&StorageKey::VerifierAddress, &new_verifier);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), CangkulanError> {
        let admin = Self::load_admin(&env)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Get the UltraHonk verifier contract address (Noir proof verifier).
    pub fn get_ultrahonk_verifier(env: Env) -> Result<Address, CangkulanError> {
        Self::load_ultrahonk_verifier(&env)
    }

    /// Set the UltraHonk verifier contract address (admin only).
    /// This enables optional Noir UltraKeccakHonk proof verification.
    pub fn set_ultrahonk_verifier(
        env: Env,
        verifier_addr: Address,
    ) -> Result<(), CangkulanError> {
        let admin = Self::load_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&StorageKey::UltraHonkVerifierAddress, &verifier_addr);
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  Public: Split Noir Verification (budget-friendly two-TX flow)
    // ───────────────────────────────────────────────────────────────────────────

    /// Verify a Noir UltraKeccakHonk proof on-chain in a **separate
    /// transaction** from `reveal_seed`.  This splits the ~260M CPU cost
    /// into two transactions that each fit within Soroban limits:
    ///
    ///   TX 1: `verify_noir_seed` → UltraHonk verification (~215M CPU)
    ///   TX 2: `reveal_seed` with an empty proof → game logic (~50M CPU)
    ///
    /// The verified flag is stored in temporary storage and consumed by
    /// `reveal_seed` when it sees a zero-length proof.
    ///
    /// # Arguments
    /// * `session_id` - game session id
    /// * `player` - the player revealing (requires auth)
    /// * `seed_hash` - blake2s(seed) — the Noir public input
    /// * `proof` - raw UltraKeccakHonk proof (>4KB)
    pub fn verify_noir_seed(
        env: Env,
        session_id: u32,
        player: Address,
        seed_hash: BytesN<32>,
        proof: Bytes,
    ) -> Result<(), CangkulanError> {
        player.require_auth();

        // Validate game is in reveal phase
        let game = Self::read_game(&env, session_id)?;
        if game.lifecycle_state != STATE_SEED_REVEAL {
            return Err(CangkulanError::WrongPhase);
        }
        let slot = Self::resolve_slot(&game, &player)?;

        // Check not already revealed
        match slot {
            PLAYER_1 => {
                if game.seed_revealed1 {
                    return Err(CangkulanError::RevealAlreadySubmitted);
                }
            }
            _ => {
                if game.seed_revealed2 {
                    return Err(CangkulanError::RevealAlreadySubmitted);
                }
            }
        }

        // Entropy check
        Self::check_seed_entropy(&seed_hash)?;

        // Commit binding: commit_hash = keccak256(seed_hash) for Noir mode
        let commit_hash = match slot {
            PLAYER_1 => game.seed_commit1.clone().ok_or(CangkulanError::MissingCommit)?,
            _ => game.seed_commit2.clone().ok_or(CangkulanError::MissingCommit)?,
        };
        let expected_commit: BytesN<32> = env
            .crypto()
            .keccak256(&Bytes::from_array(&env, &seed_hash.to_array()))
            .into();
        if expected_commit != commit_hash {
            return Err(CangkulanError::CommitHashMismatch);
        }

        // Proof must be >4000 bytes (Noir proof)
        if proof.len() <= 4000 {
            return Err(CangkulanError::InvalidZkProof);
        }

        // Call UltraHonk verifier — the expensive part (~200M CPU)
        let ultrahonk_addr = Self::load_ultrahonk_verifier(&env)?;
        let ultrahonk = UltraHonkClient::new(&env, &ultrahonk_addr);

        let seed_bytes = seed_hash.to_array();
        let mut noir_public_inputs = Bytes::new(&env);
        for byte_val in seed_bytes.iter() {
            let mut k = 0u32;
            while k < 31 {
                noir_public_inputs.push_back(0u8);
                k += 1;
            }
            noir_public_inputs.push_back(*byte_val);
        }

        // This panics on failure (UltraHonk contract behavior)
        ultrahonk.verify_proof(&noir_public_inputs, &proof);

        // Store verified flag in temporary storage
        let flag_key = StorageKey::NoirSeedVerified(session_id, slot);
        env.storage().temporary().set(&flag_key, &seed_hash);
        env.storage()
            .temporary()
            .extend_ttl(&flag_key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Get the RISC Zero verifier contract address (removed — Noir SNARK is the production path).
    /// Kept as no-op for ABI compatibility with existing deployments.

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: Finalization (single end_game call-site)
    // ═══════════════════════════════════════════════════════════════════════════

    fn finalize_game(
        env: &Env,
        session_id: u32,
        game: &mut CangkulanGame,
        outcome: Outcome,
    ) -> Result<(), CangkulanError> {
        if game.lifecycle_state == STATE_FINISHED {
            return Err(CangkulanError::GameAlreadyEnded);
        }

        let hub_addr = Self::load_hub(env)?;
        let hub = GameHubClient::new(env, &hub_addr);

        // Game Hub only supports bool (player1_won), so on DRAW we
        // derive a fair coin-flip from the combined seed commitments
        // (unbiasable — neither player controls the combined hash).
        let player1_won = match outcome {
            OUTCOME_PLAYER1_WIN => true,
            OUTCOME_DRAW => match (&game.seed_commit1, &game.seed_commit2) {
                (Some(c1), Some(c2)) => {
                    let mut tb = Bytes::from_array(env, &c1.to_array());
                    tb.append(&Bytes::from_array(env, &c2.to_array()));
                    let h = env.crypto().keccak256(&tb);
                    h.to_array()[0] % 2 == 0
                }
                _ => session_id % 2 == 0,
            },
            _ => false,
        };

        // Game Hub lifecycle: end_game BEFORE finalizing state.
        hub.end_game(&session_id, &player1_won);

        EvHubEndReported {
            session_id,
            hub: hub_addr,
            player1_won,
        }.publish(&env);

        EvGameEnded {
            session_id,
            outcome,
        }.publish(&env);

        game.outcome = outcome;
        game.lifecycle_state = STATE_FINISHED;
        game.deadline_nonce = None;
        game.deadline_ledger = None;

        // Persist game summary to both players' history
        Self::save_player_history(
            env, session_id, &game.player1, &game.player2,
            outcome, game.tricks_won1, game.tricks_won2,
        );
        Self::save_player_history(
            env, session_id, &game.player2, &game.player1,
            Self::flip_outcome(outcome), game.tricks_won2, game.tricks_won1,
        );

        Ok(())
    }

    /// Flip outcome from the opponent's perspective.
    fn flip_outcome(outcome: Outcome) -> Outcome {
        match outcome {
            OUTCOME_PLAYER1_WIN => OUTCOME_PLAYER2_WIN,
            OUTCOME_PLAYER2_WIN => OUTCOME_PLAYER1_WIN,
            other => other, // DRAW stays the same
        }
    }

    /// Append a game summary to a player's persistent history (ring buffer, max 50).
    fn save_player_history(
        env: &Env,
        session_id: u32,
        player: &Address,
        opponent: &Address,
        outcome: Outcome,
        tricks_won: u32,
        tricks_lost: u32,
    ) {
        let key = StorageKey::PlayerHistory(player.clone());
        let mut history: Vec<GameSummary> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(env));

        // Ring buffer: drop oldest if at capacity
        while history.len() >= MAX_HISTORY_PER_PLAYER {
            history.remove(0);
        }

        history.push_back(GameSummary {
            session_id,
            opponent: opponent.clone(),
            outcome,
            tricks_won,
            tricks_lost,
            ledger: env.ledger().sequence(),
        });

        env.storage().persistent().set(&key, &history);
        env.storage()
            .persistent()
            .extend_ttl(&key, HISTORY_TTL_LEDGERS, HISTORY_TTL_LEDGERS);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: Phase guards
    // ═══════════════════════════════════════════════════════════════════════════

    fn require_active(game: &CangkulanGame) -> Result<(), CangkulanError> {
        if game.lifecycle_state == STATE_FINISHED {
            return Err(CangkulanError::GameAlreadyEnded);
        }
        Ok(())
    }

    fn resolve_slot(game: &CangkulanGame, player: &Address) -> Result<u32, CangkulanError> {
        if *player == game.player1 {
            Ok(PLAYER_1)
        } else if *player == game.player2 {
            Ok(PLAYER_2)
        } else {
            Err(CangkulanError::NotAPlayer)
        }
    }

    /// Check if the player is in the commit phase of a trick.
    fn require_commit_phase(game: &CangkulanGame, slot: u32) -> Result<(), CangkulanError> {
        let ok = match game.trick_state {
            TRICK_COMMIT_WAIT_BOTH => true,
            TRICK_COMMIT_WAIT_P1 => slot == PLAYER_1,
            TRICK_COMMIT_WAIT_P2 => slot == PLAYER_2,
            _ => false,
        };
        if !ok {
            return Err(CangkulanError::NotYourTurn);
        }
        Ok(())
    }

    /// Check if the player is in the reveal phase of a trick.
    fn require_reveal_phase(game: &CangkulanGame, slot: u32) -> Result<(), CangkulanError> {
        let ok = match game.trick_state {
            TRICK_REVEAL_WAIT_BOTH => true,
            TRICK_REVEAL_WAIT_P1 => slot == PLAYER_1,
            TRICK_REVEAL_WAIT_P2 => slot == PLAYER_2,
            _ => false,
        };
        if !ok {
            return Err(CangkulanError::NotYourTurn);
        }
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: Seed verification
    // ═══════════════════════════════════════════════════════════════════════════

    /// Reject seeds with insufficient entropy.  A seed must contain at
    /// least 4 distinct byte values; otherwise it is considered trivially
    /// predictable (e.g. `[0; 32]`, `[0,1,0,1,...]`, etc.).
    fn check_seed_entropy(seed: &BytesN<32>) -> Result<(), CangkulanError> {
        let arr = seed.to_array();
        // Count distinct byte values (simple linear scan, max 256)
        let mut seen = [false; 256];
        let mut distinct: u32 = 0;
        let mut i = 0usize;
        while i < 32 {
            let idx = arr[i] as usize;
            if !seen[idx] {
                seen[idx] = true;
                distinct += 1;
            }
            i += 1;
        }
        if distinct < 4 {
            return Err(CangkulanError::WeakSeedEntropy);
        }
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: BLS12-381 Pedersen commitment for ZK card plays
    // ═══════════════════════════════════════════════════════════════════════════

    /// BLS12-381 G1 generator (same bytes used in the ZK verifier).
    const G1_GENERATOR: [u8; 96] = [
        0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
        0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
        0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
        0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
        0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
        0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
        0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
        0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
    ];

    /// Pedersen H generator DST (same as ZK verifier).
    const PEDERSEN_H_MSG: &'static [u8] = b"PEDERSEN_H";
    const PEDERSEN_H_DST: &'static [u8] = b"SGS_CANGKULAN_V1";

    /// Compute Pedersen commitment: C = card_id·G + blinding·H
    fn pedersen_commit(env: &Env, card_id: u32, blinding: &BytesN<32>) -> G1Affine {
        let bls = env.crypto().bls12_381();

        let g = G1Affine::from_array(env, &Self::G1_GENERATOR);
        let h_msg = Bytes::from_slice(env, Self::PEDERSEN_H_MSG);
        let h_dst = Bytes::from_slice(env, Self::PEDERSEN_H_DST);
        let h = bls.hash_to_g1(&h_msg, &h_dst);

        // Fr(card_id): 32-byte big-endian with card_id in the last 4 bytes
        let mut card_fr_arr = [0u8; 32];
        card_fr_arr[28] = ((card_id >> 24) & 0xFF) as u8;
        card_fr_arr[29] = ((card_id >> 16) & 0xFF) as u8;
        card_fr_arr[30] = ((card_id >> 8) & 0xFF) as u8;
        card_fr_arr[31] = (card_id & 0xFF) as u8;
        let card_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &card_fr_arr));

        // Fr(blinding)
        let blinding_fr = Fr::from_bytes(blinding.clone());

        // C = card_id·G + blinding·H
        let card_g = bls.g1_mul(&g, &card_fr);
        let blind_h = bls.g1_mul(&h, &blinding_fr);
        bls.g1_add(&card_g, &blind_h)
    }

    /// Domain separator tags for the NIZK protocol
    const NULLIFIER_TAG: [u8; 4] = [0x4E, 0x55, 0x4C, 0x4C]; // "NULL"

    /// Encode seed verification public inputs and call the ZK verifier.
    ///
    /// Supports multiple proof modes (auto-detected by length and prefix):
    ///
    /// **NIZK Mode (proof = 64 bytes):**
    ///   public_inputs = seed_hash(32) || commitment(32) || nullifier(32) || session_id(4) || player(var)
    ///   proof = blinding(32) || response(32)
    ///
    /// **Pedersen Mode (proof = 224 bytes = C(96) + sigma(128)):**
    ///   C = first 96 bytes of proof (BLS12-381 G1 Pedersen commitment)
    ///   Verify keccak256(C) == commit_hash (binding check)
    ///   public_inputs = C(96) || seed_hash(32) || session_id(4) || player(var)
    ///   sigma_proof = R(96) || z_r(32)  (last 128 bytes of proof)
    ///
    /// **Noir pre-verified (proof = 0 bytes):**
    ///   Split TX flow — proof was verified via `verify_noir_seed`.
    ///   Checks and consumes the stored flag.
    ///
    /// **Noir UltraKeccakHonk (proof > 4000 bytes):**
    ///   Routes to UltraHonk verifier contract (single-TX flow, may exceed budget).
    ///
    /// The mode is auto-detected from proof length.
    fn call_seed_verifier(
        env: &Env,
        session_id: u32,
        slot: u32,
        player: &Address,
        seed_hash: &BytesN<32>,
        commit_hash: &BytesN<32>,
        proof: &Bytes,
    ) -> Result<(), CangkulanError> {
        let verifier_addr = Self::load_verifier(env)?;
        let verifier = ZkVerifierClient::new(env, &verifier_addr);

        let proof_len = proof.len();

        if proof_len == 0 {
            // ── Pre-verified Noir Mode (split TX flow) ──────────────────────
            // The proof was already verified via `verify_noir_seed`.
            // Check the flag and consume it (one-time use).
            let flag_key = StorageKey::NoirSeedVerified(session_id, slot);
            let stored_hash: Option<BytesN<32>> = env.storage().temporary().get(&flag_key);
            match stored_hash {
                Some(verified_hash) => {
                    if verified_hash != *seed_hash {
                        return Err(CangkulanError::CommitHashMismatch);
                    }
                    // Verify commit binding: keccak256(seed_hash) == commit_hash
                    let expected_commit: BytesN<32> = env
                        .crypto()
                        .keccak256(&Bytes::from_array(env, &seed_hash.to_array()))
                        .into();
                    if expected_commit != *commit_hash {
                        return Err(CangkulanError::CommitHashMismatch);
                    }
                    // Consume the flag — prevent replay
                    env.storage().temporary().remove(&flag_key);
                }
                None => {
                    return Err(CangkulanError::InvalidZkProof);
                }
            }
        } else if proof_len == 224 {
            // ── Pedersen+Sigma Mode (Mode 4) ────────────────────────────────
            // Extract C (G1 point) from proof[0..96)
            let mut c_bytes = Bytes::new(env);
            let mut i = 0u32;
            while i < 96 {
                c_bytes.push_back(proof.get(i).unwrap_or(0));
                i += 1;
            }

            // Verify keccak256(C) == stored commit_hash (binding)
            let c_hash: BytesN<32> = env.crypto().keccak256(&c_bytes).into();
            if c_hash != *commit_hash {
                return Err(CangkulanError::InvalidZkProof);
            }

            // Build Pedersen public inputs: C(96) || seed_hash(32) || session_id(4) || player(var)
            let mut public_inputs = c_bytes;
            public_inputs.append(&Bytes::from_array(env, &seed_hash.to_array()));
            public_inputs.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
            public_inputs.append(&player.to_string().to_bytes());

            // Extract sigma proof: proof[96..224) = 128 bytes
            let mut sigma_proof = Bytes::new(env);
            let mut j = 96u32;
            while j < 224 {
                sigma_proof.push_back(proof.get(j).unwrap_or(0));
                j += 1;
            }

            if !verifier.verify(&public_inputs, &sigma_proof) {
                return Err(CangkulanError::InvalidZkProof);
            }
        } else if proof_len == 64 {
            // ── NIZK Mode (Mode 2) — existing flow ─────────────────────────
            // Compute nullifier: keccak256(seed_hash || "NULL" || session_id_be4)
            let mut null_preimage = Bytes::from_array(env, &seed_hash.to_array());
            null_preimage.append(&Bytes::from_array(env, &Self::NULLIFIER_TAG));
            null_preimage.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
            let nullifier: BytesN<32> = env.crypto().keccak256(&null_preimage).into();

            // Build NIZK public inputs:
            // seed_hash(32) || commitment(32) || nullifier(32) || session_id(4) || player(var)
            let mut public_inputs = Bytes::from_array(env, &seed_hash.to_array());
            public_inputs.append(&Bytes::from_array(env, &commit_hash.to_array()));
            public_inputs.append(&Bytes::from_array(env, &nullifier.to_array()));
            public_inputs.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
            public_inputs.append(&player.to_string().to_bytes());

            if !verifier.verify(&public_inputs, proof) {
                return Err(CangkulanError::InvalidZkProof);
            }
        } else if proof_len > 4000 {
            // ── Noir UltraKeccakHonk Mode ────────────────────────────────
            // For Noir proofs, the proof is a raw UltraHonk proof blob (>4KB).
            // Public inputs = seed_hash encoded as 32 field elements (32 BE bytes each = 1024 bytes).
            // The UltraHonk verifier contract handles all verification internally.
            //
            // Commit binding: commit_hash = keccak256(seed_hash) for Noir mode.
            // This ensures the player cannot change their seed between commit and reveal.
            let expected_commit: BytesN<32> = env
                .crypto()
                .keccak256(&Bytes::from_array(env, &seed_hash.to_array()))
                .into();
            if expected_commit != *commit_hash {
                return Err(CangkulanError::CommitHashMismatch);
            }

            let ultrahonk_addr = Self::load_ultrahonk_verifier(env)?;
            let ultrahonk = UltraHonkClient::new(env, &ultrahonk_addr);

            // Encode seed_hash as UltraHonk public inputs:
            // Each u8 becomes a 32-byte big-endian field element.
            let seed_bytes = seed_hash.to_array();
            let mut noir_public_inputs = Bytes::new(env);
            for byte_val in seed_bytes.iter() {
                // 31 zero bytes + the u8 value
                let mut k = 0u32;
                while k < 31 {
                    noir_public_inputs.push_back(0u8);
                    k += 1;
                }
                noir_public_inputs.push_back(*byte_val);
            }

            // Call the UltraHonk verifier — it panics on failure
            ultrahonk.verify_proof(&noir_public_inputs, proof);
        } else {
            return Err(CangkulanError::InvalidZkProof);
        }

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: Shuffle & Deal
    // ═══════════════════════════════════════════════════════════════════════════

    /// Deterministic Fisher-Yates shuffle using ZK-verified seed hashes.
    ///
    /// Derives PRNG seed from `seed_hash1 || seed_hash2 || session_id` where
    /// each seed_hash = keccak256(raw_seed). Raw seeds never touch the chain.
    fn shuffle_and_deal(env: &Env, game: &mut CangkulanGame, session_id: u32) {
        // Derive PRNG seed from both ZK-verified seed hashes + session_id
        let sh1 = game.seed_hash1.clone().unwrap();
        let sh2 = game.seed_hash2.clone().unwrap();

        let mut seed_data = Bytes::from_array(env, &sh1.to_array());
        seed_data.append(&Bytes::from_array(env, &sh2.to_array()));
        seed_data.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
        let seed_hash = env.crypto().keccak256(&seed_data);
        env.prng().seed(seed_hash.into());

        // Create ordered deck [0..36)
        let mut deck: [u32; 36] = [0; 36];
        let mut i: u32 = 0;
        while i < DECK_SIZE {
            deck[i as usize] = i;
            i += 1;
        }

        // Fisher-Yates shuffle
        let mut idx = DECK_SIZE;
        while idx > 1 {
            idx -= 1;
            let j = env.prng().gen_range::<u64>(0..=(idx as u64)) as u32;
            let tmp = deck[idx as usize];
            deck[idx as usize] = deck[j as usize];
            deck[j as usize] = tmp;
        }

        // Deal: first 5 to P1, next 5 to P2, rest to draw pile
        let mut hand1 = Vec::new(env);
        let mut hand2 = Vec::new(env);
        let mut draw_pile = Vec::new(env);

        let mut d: u32 = 0;
        while d < DECK_SIZE {
            if d < HAND_SIZE {
                hand1.push_back(deck[d as usize]);
            } else if d < HAND_SIZE * 2 {
                hand2.push_back(deck[d as usize]);
            } else {
                draw_pile.push_back(deck[d as usize]);
            }
            d += 1;
        }

        game.hand1 = hand1;
        game.hand2 = hand2;
        game.draw_pile = draw_pile;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: Trick mechanics
    // ═══════════════════════════════════════════════════════════════════════════

    /// Flip the next card from the draw pile to start a new trick.
    fn flip_next_card(_env: &Env, game: &mut CangkulanGame) {
        if game.draw_pile.is_empty() {
            return;
        }

        let card = game.draw_pile.get(0).unwrap();
        game.draw_pile.remove(0);
        let suit = card / CARDS_PER_SUIT;

        game.flipped_card = Some(card);
        game.trick_suit = Some(suit);
        game.trick_card1 = None;
        game.trick_card2 = None;
        game.play_commit1 = None;
        game.play_commit2 = None;
        game.zk_play1 = false;
        game.zk_play2 = false;
        game.trick_state = TRICK_COMMIT_WAIT_BOTH;
    }

    /// After a player commits, advance the commit sub-state.
    fn advance_commit_state(game: &mut CangkulanGame, slot: u32) {
        game.trick_state = match game.trick_state {
            TRICK_COMMIT_WAIT_BOTH => {
                if slot == PLAYER_1 {
                    TRICK_COMMIT_WAIT_P2
                } else {
                    TRICK_COMMIT_WAIT_P1
                }
            }
            _ => TRICK_REVEAL_WAIT_BOTH, // Both have committed → reveal phase
        };
    }

    /// After a player reveals, advance the reveal sub-state.
    fn advance_reveal_state(game: &mut CangkulanGame, slot: u32) {
        game.trick_state = match game.trick_state {
            TRICK_REVEAL_WAIT_BOTH => {
                if slot == PLAYER_1 {
                    TRICK_REVEAL_WAIT_P2
                } else {
                    TRICK_REVEAL_WAIT_P1
                }
            }
            _ => TRICK_NONE, // Both have revealed → resolve
        };
    }

    /// Resolve a completed trick and check win conditions.
    fn resolve_trick(
        env: &Env,
        session_id: u32,
        game: &mut CangkulanGame,
    ) -> Result<(), CangkulanError> {
        let p1_played = game.trick_card1.is_some();
        let p2_played = game.trick_card2.is_some();

        match (p1_played, p2_played) {
            (true, true) => {
                // Both followed suit — highest value wins
                let c1 = game.trick_card1.unwrap();
                let c2 = game.trick_card2.unwrap();
                let v1 = c1 % CARDS_PER_SUIT;
                let v2 = c2 % CARDS_PER_SUIT;
                // Strictly greater wins; on tie the trick lead (P1/attacker) wins
                if v1 >= v2 {
                    game.tricks_won1 += 1;
                } else {
                    game.tricks_won2 += 1;
                }
            }
            (true, false) => {
                // P1 followed, P2 couldn't → P1 wins, P2 takes penalty
                game.tricks_won1 += 1;
                Self::give_penalty_card(game, PLAYER_2);
            }
            (false, true) => {
                // P2 followed, P1 couldn't → P2 wins, P1 takes penalty
                game.tricks_won2 += 1;
                Self::give_penalty_card(game, PLAYER_1);
            }
            (false, false) => {
                // Neither followed → waste trick, discard flipped card
                // (already removed from draw pile)
            }
        }

        // Emit trick resolved event (0 = waste, 1 = P1, 2 = P2)
        let trick_winner: u32 = match (p1_played, p2_played) {
            (true, true) => {
                let c1 = game.trick_card1.unwrap();
                let c2 = game.trick_card2.unwrap();
                if (c1 % CARDS_PER_SUIT) >= (c2 % CARDS_PER_SUIT) { PLAYER_1 } else { PLAYER_2 }  // lead wins ties
            }
            (true, false) => PLAYER_1,
            (false, true) => PLAYER_2,
            _ => 0,
        };
        EvTrickResolved {
            session_id,
            winner: trick_winner,
            card1: game.trick_card1,
            card2: game.trick_card2,
        }.publish(&env);

        // Clear trick state
        game.flipped_card = None;
        game.trick_suit = None;
        game.trick_card1 = None;
        game.trick_card2 = None;
        game.play_commit1 = None;
        game.play_commit2 = None;
        game.zk_play1 = false;
        game.zk_play2 = false;

        // Check win conditions
        if game.hand1.is_empty() || game.hand2.is_empty() {
            let outcome = Self::determine_winner(game);
            return Self::finalize_game(env, session_id, game, outcome);
        }

        // If draw pile is empty, game ends — count cards
        if game.draw_pile.is_empty() {
            let outcome = Self::determine_winner(game);
            return Self::finalize_game(env, session_id, game, outcome);
        }

        // Flip next card for new trick
        Self::flip_next_card(env, game);
        game.deadline_nonce =
            Some(game.action_nonce.saturating_add(TIMEOUT_ACTIONS));
        game.deadline_ledger =
            Some(env.ledger().sequence().saturating_add(TIMEOUT_LEDGERS));

        Ok(())
    }

    /// Give a penalty card from the draw pile to a player.
    fn give_penalty_card(game: &mut CangkulanGame, slot: u32) {
        if game.draw_pile.is_empty() {
            return;
        }
        let card = game.draw_pile.get(0).unwrap();
        game.draw_pile.remove(0);
        match slot {
            PLAYER_1 => game.hand1.push_back(card),
            _ => game.hand2.push_back(card),
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: Win determination
    // ═══════════════════════════════════════════════════════════════════════════

    fn determine_winner(game: &CangkulanGame) -> Outcome {
        let len1 = game.hand1.len();
        let len2 = game.hand2.len();

        // Primary: "habis duluan" — ran out of cards first wins.
        // If one player has 0 cards and the opponent still holds cards,
        // the empty-handed player wins outright.
        if len1 == 0 && len2 > 0 {
            return OUTCOME_PLAYER1_WIN;
        } else if len2 == 0 && len1 > 0 {
            return OUTCOME_PLAYER2_WIN;
        }

        // Secondary: most tricks won
        if game.tricks_won1 > game.tricks_won2 {
            return OUTCOME_PLAYER1_WIN;
        } else if game.tricks_won2 > game.tricks_won1 {
            return OUTCOME_PLAYER2_WIN;
        }

        // Tie-break 1: fewer cards remaining in hand
        if len1 < len2 {
            return OUTCOME_PLAYER1_WIN;
        } else if len2 < len1 {
            return OUTCOME_PLAYER2_WIN;
        }

        // Tie-break 2: lower total card value wins
        let sum1 = Self::hand_total_value(&game.hand1);
        let sum2 = Self::hand_total_value(&game.hand2);
        if sum1 < sum2 {
            OUTCOME_PLAYER1_WIN
        } else if sum2 < sum1 {
            OUTCOME_PLAYER2_WIN
        } else {
            OUTCOME_DRAW
        }
    }

    fn hand_total_value(hand: &Vec<u32>) -> u32 {
        let mut total: u32 = 0;
        let mut i: u32 = 0;
        while i < hand.len() {
            let card = hand.get(i).unwrap();
            total += card % CARDS_PER_SUIT + 2; // value = id % 9 + 2
            i += 1;
        }
        total
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: Hand helpers
    // ═══════════════════════════════════════════════════════════════════════════

    fn get_hand(game: &CangkulanGame, slot: u32) -> Vec<u32> {
        match slot {
            PLAYER_1 => game.hand1.clone(),
            _ => game.hand2.clone(),
        }
    }

    fn set_hand(game: &mut CangkulanGame, slot: u32, hand: Vec<u32>) {
        match slot {
            PLAYER_1 => game.hand1 = hand,
            _ => game.hand2 = hand,
        }
    }

    fn find_card_position(hand: &Vec<u32>, card_id: u32) -> Result<u32, CangkulanError> {
        let mut i: u32 = 0;
        while i < hand.len() {
            if hand.get(i).unwrap() == card_id {
                return Ok(i);
            }
            i += 1;
        }
        Err(CangkulanError::CardNotInHand)
    }

    fn has_suit_in_hand(hand: &Vec<u32>, suit: u32) -> bool {
        let mut i: u32 = 0;
        while i < hand.len() {
            let card = hand.get(i).unwrap();
            if card / CARDS_PER_SUIT == suit {
                return true;
            }
            i += 1;
        }
        false
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: Timeout logic
    // ═══════════════════════════════════════════════════════════════════════════

    fn determine_timeout_outcome(game: &CangkulanGame) -> Result<Outcome, CangkulanError> {
        match game.lifecycle_state {
            STATE_SEED_COMMIT => {
                match (game.seed_commit1.is_some(), game.seed_commit2.is_some()) {
                    (true, false) => Ok(OUTCOME_PLAYER1_WIN),
                    (false, true) => Ok(OUTCOME_PLAYER2_WIN),
                    _ => Err(CangkulanError::TimeoutNotApplicable),
                }
            }
            STATE_SEED_REVEAL => {
                match (game.seed_revealed1, game.seed_revealed2) {
                    (true, false) => Ok(OUTCOME_PLAYER1_WIN),
                    (false, true) => Ok(OUTCOME_PLAYER2_WIN),
                    (false, false) => Ok(OUTCOME_DRAW),
                    _ => Err(CangkulanError::TimeoutNotApplicable),
                }
            }
            STATE_PLAYING => {
                // During commit phase, whoever hasn't committed loses
                // During reveal phase, whoever hasn't revealed loses
                match game.trick_state {
                    TRICK_COMMIT_WAIT_P1 | TRICK_REVEAL_WAIT_P1 => Ok(OUTCOME_PLAYER2_WIN),
                    TRICK_COMMIT_WAIT_P2 | TRICK_REVEAL_WAIT_P2 => Ok(OUTCOME_PLAYER1_WIN),
                    TRICK_COMMIT_WAIT_BOTH | TRICK_REVEAL_WAIT_BOTH => {
                        // Both haven't responded — determine by cards count
                        Ok(Self::determine_winner(game))
                    }
                    _ => Err(CangkulanError::TimeoutNotApplicable),
                }
            }
            _ => Err(CangkulanError::TimeoutNotApplicable),
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal: Nonce & Storage
    // ═══════════════════════════════════════════════════════════════════════════

    fn bump_nonce(game: &mut CangkulanGame) {
        game.action_nonce = game.action_nonce.saturating_add(1);
    }

    fn read_game(env: &Env, session_id: u32) -> Result<CangkulanGame, CangkulanError> {
        env.storage()
            .temporary()
            .get(&StorageKey::Game(session_id))
            .ok_or(CangkulanError::GameNotFound)
    }

    fn write_game(env: &Env, session_id: u32, game: &CangkulanGame) {
        let key = StorageKey::Game(session_id);
        env.storage().temporary().set(&key, game);
        env.storage()
            .temporary()
            .extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);
        // Keep instance storage (admin, hub, verifier addresses) alive
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);
    }

    fn load_admin(env: &Env) -> Result<Address, CangkulanError> {
        env.storage()
            .instance()
            .get(&StorageKey::Admin)
            .ok_or(CangkulanError::AdminNotSet)
    }

    fn load_hub(env: &Env) -> Result<Address, CangkulanError> {
        env.storage()
            .instance()
            .get(&StorageKey::GameHubAddress)
            .ok_or(CangkulanError::GameHubNotSet)
    }

    fn load_verifier(env: &Env) -> Result<Address, CangkulanError> {
        env.storage()
            .instance()
            .get(&StorageKey::VerifierAddress)
            .ok_or(CangkulanError::VerifierNotSet)
    }

    fn load_ultrahonk_verifier(env: &Env) -> Result<Address, CangkulanError> {
        env.storage()
            .instance()
            .get(&StorageKey::UltraHonkVerifierAddress)
            .ok_or(CangkulanError::UltraHonkVerifierNotSet)
    }
}

#[cfg(test)]
mod test;
