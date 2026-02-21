import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CCOMMIIORXZOAV3PJ32UUMTWCMWOAIT4RC4RLQFJW4XU6RNO3IPZKK65",
  }
} as const


/**
 * Compact summary of a finished game, stored persistently per player.
 */
export interface GameSummary {
  ledger: u32;
  opponent: string;
  outcome: u32;
  session_id: u32;
  tricks_lost: u32;
  tricks_won: u32;
}



export interface CangkulanGame {
  action_nonce: u32;
  deadline_ledger: Option<u32>;
  deadline_nonce: Option<u32>;
  draw_pile: Array<u32>;
  flipped_card: Option<u32>;
  hand1: Array<u32>;
  hand2: Array<u32>;
  /**
 * Ledger sequence of the last tick_timeout call (rate limiting)
 */
last_tick_ledger: u32;
  lifecycle_state: u32;
  outcome: u32;
  play_commit1: Option<Buffer>;
  play_commit2: Option<Buffer>;
  player1: string;
  player1_points: i128;
  player2: string;
  player2_points: i128;
  seed_commit1: Option<Buffer>;
  seed_commit2: Option<Buffer>;
  seed_hash1: Option<Buffer>;
  seed_hash2: Option<Buffer>;
  seed_revealed1: boolean;
  seed_revealed2: boolean;
  trick_card1: Option<u32>;
  trick_card2: Option<u32>;
  trick_state: u32;
  trick_suit: Option<u32>;
  tricks_won1: u32;
  tricks_won2: u32;
  zk_play1: boolean;
  zk_play2: boolean;
}


export const CangkulanError = {
  1: {message:"GameNotFound"},
  2: {message:"SessionAlreadyExists"},
  3: {message:"NotAPlayer"},
  4: {message:"SelfPlayNotAllowed"},
  5: {message:"GameAlreadyEnded"},
  6: {message:"WrongPhase"},
  7: {message:"CommitAlreadySubmitted"},
  8: {message:"RevealAlreadySubmitted"},
  9: {message:"CommitHashMismatch"},
  10: {message:"InvalidZkProof"},
  11: {message:"MissingCommit"},
  12: {message:"NotYourTurn"},
  13: {message:"CardNotInHand"},
  14: {message:"WrongSuit"},
  15: {message:"HasMatchingSuit"},
  16: {message:"DrawPileEmpty"},
  17: {message:"NoTrickInProgress"},
  18: {message:"AdminNotSet"},
  19: {message:"GameHubNotSet"},
  20: {message:"VerifierNotSet"},
  21: {message:"TimeoutNotReached"},
  22: {message:"TimeoutNotConfigured"},
  23: {message:"TimeoutNotApplicable"},
  24: {message:"WeakSeedEntropy"},
  25: {message:"InvalidNonce"},
  26: {message:"PlayCommitAlreadySubmitted"},
  27: {message:"PlayCommitMissing"},
  28: {message:"PlayRevealMismatch"},
  29: {message:"InvalidCardId"},
  30: {message:"UltraHonkVerifierNotSet"},
  31: {message:"UltraHonkVerificationFailed"},
  32: {message:"ZkPlayProofInvalid"},
  33: {message:"ZkPlaySetEmpty"},
  34: {message:"ZkPlayOpeningMismatch"},
  35: {message:"ZkCangkulProofInvalid"},
  38: {message:"TickTooSoon"}
}









export interface Client {
  /**
   * Construct and simulate a forfeit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Forfeit the game. The caller immediately loses.
   * 
   * This allows a player to withdraw from an active game at any point.
   * The opponent is declared the winner. This is irreversible.
   */
  forfeit: ({session_id, caller}: {session_id: u32, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_hub: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a set_hub transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_hub: ({new_hub}: {new_hub: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get game state with both hands redacted for active games.
   * 
   * Returns full state (including hands) only for FINISHED games.
   * During active games, hands are cleared to prevent card snooping
   * via unauthenticated RPC queries. Use `get_game_view` with a viewer
   * address to see your own hand during gameplay.
   */
  get_game: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<CangkulanGame>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a start_game transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  start_game: ({session_id, player1, player2, player1_points, player2_points}: {session_id: u32, player1: string, player2: string, player1_points: i128, player2_points: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a commit_play transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Commit a play action: `commit_hash = keccak256(action_u32_be || salt)`.
   * 
   * `action` is either a valid `card_id` (0-35) to play a card, or
   * `CANNOT_FOLLOW_SENTINEL` (0xFFFFFFFF) to declare cannot follow suit.
   * The actual action is hidden until both players have committed.
   * 
   * `expected_nonce` must equal the current `action_nonce` to prevent
   * replay attacks and stale-state submissions.
   */
  commit_play: ({session_id, player, commit_hash, expected_nonce}: {session_id: u32, player: string, commit_hash: Buffer, expected_nonce: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a commit_seed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Commit a seed hash. Both players must commit before reveal begins.
   */
  commit_seed: ({session_id, player, commit_hash}: {session_id: u32, player: string, commit_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reveal_play transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveal a previously committed play action.
   * 
   * `card_id` is the actual card to play (0-35), or `CANNOT_FOLLOW_SENTINEL`
   * to declare cannot follow suit.
   * `salt` is the random 32-byte value used in the commit:
   * - Legacy mode: keccak256(card_id_u32_be || salt) == commit_hash
   * - ZK mode: salt = blinding factor; keccak256(card_id·G + blinding·H) == commit_hash
   */
  reveal_play: ({session_id, player, card_id, salt}: {session_id: u32, player: string, card_id: u32, salt: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reveal_seed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveal a seed using a Zero-Knowledge Proof. The raw seed is
   * **never** submitted on-chain; only `seed_hash = keccak256(seed)` is
   * revealed. The proof demonstrates knowledge of the seed without
   * disclosing it, verified via the ZK verifier contract.
   * 
   * Two proof modes are supported (auto-detected by proof length):
   * 
   * **NIZK Mode (64 bytes):** `blinding(32) || response(32)`
   * Hash-based Fiat-Shamir proof.
   * 
   * **Pedersen Mode (224 bytes):** `C(96) || R(96) || z_r(32)`
   * BLS12-381 Pedersen commitment + Schnorr on blinding.
   * commit_hash = keccak256(C), verified on-chain for binding.
   * 
   * Once both seeds are revealed, the deck is shuffled and cards are dealt.
   * 
   * # Arguments
   * * `seed_hash` - `keccak256(seed)`, the one-way hash of the raw seed
   * * `proof` - ZK proof (64 bytes for NIZK, 224 bytes for Pedersen)
   */
  reveal_seed: ({session_id, player, seed_hash, proof}: {session_id: u32, player: string, seed_hash: Buffer, proof: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_verifier: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a set_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_verifier: ({new_verifier}: {new_verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a tick_timeout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  tick_timeout: ({session_id, caller}: {session_id: u32, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a get_game_view transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get game state with privacy: only the viewer's own hand is visible.
   * The opponent's hand is redacted (empty) to prevent casual snooping
   * via RPC queries. Non-players see both hands redacted.
   * During the reveal phase, the opponent's trick_card is also redacted
   * (it only becomes visible after both players have revealed).
   */
  get_game_view: ({session_id, viewer}: {session_id: u32, viewer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<CangkulanGame>>>

  /**
   * Construct and simulate a commit_play_zk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Commit a play action with a ZK ring sigma proof of suit compliance.
   * 
   * `commit_hash = keccak256(C_bytes)` where C is a BLS12-381 Pedersen
   * commitment to the card_id: `C = card_id·G + blinding·H`.
   * 
   * `zk_proof` is the ring sigma proof: `C(96) || [e_i(32) || z_i(32)] × N`
   * proving the committed card is in the player's valid set (hand ∩ trick suit)
   * without revealing which specific card.
   * 
   * The ZK verifier (Mode 7) checks the ring sigma and binding.
   */
  commit_play_zk: ({session_id, player, commit_hash, expected_nonce, zk_proof}: {session_id: u32, player: string, commit_hash: Buffer, expected_nonce: u32, zk_proof: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_game_debug transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get full raw game state (admin-only). Requires admin authentication.
   * Used for debugging and post-game verification. For normal gameplay
   * use `get_game_view` which respects player-level privacy.
   */
  get_game_debug: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<CangkulanGame>>>

  /**
   * Construct and simulate a verify_shuffle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Recompute and return the full shuffled deck order from ZK-verified seed hashes.
   * Anyone can call this to independently verify the shuffle was fair. The
   * seed hashes are `keccak256(raw_seed)` — the raw seeds never appear on-chain.
   * Only available after both seeds have been revealed (PLAYING or FINISHED).
   */
  verify_shuffle: ({session_id}: {session_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<u32>>>>

  /**
   * Construct and simulate a resolve_timeout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve_timeout: ({session_id, caller}: {session_id: u32, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a verify_noir_seed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Verify a Noir UltraKeccakHonk proof on-chain in a **separate
   * transaction** from `reveal_seed`.  This splits the ~260M CPU cost
   * into two transactions that each fit within Soroban limits:
   * 
   * TX 1: `verify_noir_seed` → UltraHonk verification (~215M CPU)
   * TX 2: `reveal_seed` with an empty proof → game logic (~50M CPU)
   * 
   * The verified flag is stored in temporary storage and consumed by
   * `reveal_seed` when it sees a zero-length proof.
   * 
   * # Arguments
   * * `session_id` - game session id
   * * `player` - the player revealing (requires auth)
   * * `seed_hash` - blake2s(seed) — the Noir public input
   * * `proof` - raw UltraKeccakHonk proof (>4KB)
   */
  verify_noir_seed: ({session_id, player, seed_hash, proof}: {session_id: u32, player: string, seed_hash: Buffer, proof: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a commit_cangkul_zk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Commit a cangkul (cannot follow suit) action with a ZK hand proof.
   * 
   * The player proves that NONE of the cards in their hand match
   * the current trick suit. Uses an aggregate Pedersen commitment
   * over the entire hand with a Schnorr proof of knowledge.
   * 
   * `commit_hash = keccak256(A_bytes)` where A is the aggregate
   * Pedersen commitment: `A = Σ(card_i·G + r_i·H)`.
   * 
   * `zk_proof` layout: `k(4) || A(96, G1) || R(96, G1) || z(32, Fr) = 228 bytes`
   * 
   * The ZK verifier (Mode 8) checks:
   * 1. Aggregate Pedersen binding (keccak256(A) == commit_hash)
   * 2. Schnorr proof of knowledge of aggregate blinding
   * 3. Suit exclusion: no card matches trick_suit
   */
  commit_cangkul_zk: ({session_id, player, commit_hash, expected_nonce, zk_proof}: {session_id: u32, player: string, commit_hash: Buffer, expected_nonce: u32, zk_proof: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_player_history transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get a player's game history (up to 50 most recent games).
   * Returns a Vec of GameSummary with outcome from the player's perspective:
   * 1 = win, 2 = loss, 3 = draw
   */
  get_player_history: ({player}: {player: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<GameSummary>>>

  /**
   * Construct and simulate a get_ultrahonk_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the UltraHonk verifier contract address (Noir proof verifier).
   */
  get_ultrahonk_verifier: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a set_ultrahonk_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the UltraHonk verifier contract address (admin only).
   * This enables optional Noir UltraKeccakHonk proof verification.
   */
  set_ultrahonk_verifier: ({verifier_addr}: {verifier_addr: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, game_hub, verifier}: {admin: string, game_hub: string, verifier: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, game_hub, verifier}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAQAAAENDb21wYWN0IHN1bW1hcnkgb2YgYSBmaW5pc2hlZCBnYW1lLCBzdG9yZWQgcGVyc2lzdGVudGx5IHBlciBwbGF5ZXIuAAAAAAAAAAALR2FtZVN1bW1hcnkAAAAABgAAAAAAAAAGbGVkZ2VyAAAAAAAEAAAAAAAAAAhvcHBvbmVudAAAABMAAAAAAAAAB291dGNvbWUAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAALdHJpY2tzX2xvc3QAAAAABAAAAAAAAAAKdHJpY2tzX3dvbgAAAAAABA==",
        "AAAABQAAAAAAAAAAAAAAC0V2R2FtZUVuZGVkAAAAAAEAAAANZXZfZ2FtZV9lbmRlZAAAAAAAAAIAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAAAAAAAAdvdXRjb21lAAAAAAQAAAAAAAAAAg==",
        "AAAAAQAAAAAAAAAAAAAADUNhbmdrdWxhbkdhbWUAAAAAAAAeAAAAAAAAAAxhY3Rpb25fbm9uY2UAAAAEAAAAAAAAAA9kZWFkbGluZV9sZWRnZXIAAAAD6AAAAAQAAAAAAAAADmRlYWRsaW5lX25vbmNlAAAAAAPoAAAABAAAAAAAAAAJZHJhd19waWxlAAAAAAAD6gAAAAQAAAAAAAAADGZsaXBwZWRfY2FyZAAAA+gAAAAEAAAAAAAAAAVoYW5kMQAAAAAAA+oAAAAEAAAAAAAAAAVoYW5kMgAAAAAAA+oAAAAEAAAAPUxlZGdlciBzZXF1ZW5jZSBvZiB0aGUgbGFzdCB0aWNrX3RpbWVvdXQgY2FsbCAocmF0ZSBsaW1pdGluZykAAAAAAAAQbGFzdF90aWNrX2xlZGdlcgAAAAQAAAAAAAAAD2xpZmVjeWNsZV9zdGF0ZQAAAAAEAAAAAAAAAAdvdXRjb21lAAAAAAQAAAAAAAAADHBsYXlfY29tbWl0MQAAA+gAAAPuAAAAIAAAAAAAAAAMcGxheV9jb21taXQyAAAD6AAAA+4AAAAgAAAAAAAAAAdwbGF5ZXIxAAAAABMAAAAAAAAADnBsYXllcjFfcG9pbnRzAAAAAAALAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAADnBsYXllcjJfcG9pbnRzAAAAAAALAAAAAAAAAAxzZWVkX2NvbW1pdDEAAAPoAAAD7gAAACAAAAAAAAAADHNlZWRfY29tbWl0MgAAA+gAAAPuAAAAIAAAAAAAAAAKc2VlZF9oYXNoMQAAAAAD6AAAA+4AAAAgAAAAAAAAAApzZWVkX2hhc2gyAAAAAAPoAAAD7gAAACAAAAAAAAAADnNlZWRfcmV2ZWFsZWQxAAAAAAABAAAAAAAAAA5zZWVkX3JldmVhbGVkMgAAAAAAAQAAAAAAAAALdHJpY2tfY2FyZDEAAAAD6AAAAAQAAAAAAAAAC3RyaWNrX2NhcmQyAAAAA+gAAAAEAAAAAAAAAAt0cmlja19zdGF0ZQAAAAAEAAAAAAAAAAp0cmlja19zdWl0AAAAAAPoAAAABAAAAAAAAAALdHJpY2tzX3dvbjEAAAAABAAAAAAAAAALdHJpY2tzX3dvbjIAAAAABAAAAAAAAAAIemtfcGxheTEAAAABAAAAAAAAAAh6a19wbGF5MgAAAAE=",
        "AAAABQAAAAAAAAAAAAAADUV2R2FtZVN0YXJ0ZWQAAAAAAAABAAAAD2V2X2dhbWVfc3RhcnRlZAAAAAADAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAAAAAAAAHcGxheWVyMgAAAAATAAAAAAAAAAI=",
        "AAAABAAAAAAAAAAAAAAADkNhbmdrdWxhbkVycm9yAAAAAAAkAAAAAAAAAAxHYW1lTm90Rm91bmQAAAABAAAAAAAAABRTZXNzaW9uQWxyZWFkeUV4aXN0cwAAAAIAAAAAAAAACk5vdEFQbGF5ZXIAAAAAAAMAAAAAAAAAElNlbGZQbGF5Tm90QWxsb3dlZAAAAAAABAAAAAAAAAAQR2FtZUFscmVhZHlFbmRlZAAAAAUAAAAAAAAACldyb25nUGhhc2UAAAAAAAYAAAAAAAAAFkNvbW1pdEFscmVhZHlTdWJtaXR0ZWQAAAAAAAcAAAAAAAAAFlJldmVhbEFscmVhZHlTdWJtaXR0ZWQAAAAAAAgAAAAAAAAAEkNvbW1pdEhhc2hNaXNtYXRjaAAAAAAACQAAAAAAAAAOSW52YWxpZFprUHJvb2YAAAAAAAoAAAAAAAAADU1pc3NpbmdDb21taXQAAAAAAAALAAAAAAAAAAtOb3RZb3VyVHVybgAAAAAMAAAAAAAAAA1DYXJkTm90SW5IYW5kAAAAAAAADQAAAAAAAAAJV3JvbmdTdWl0AAAAAAAADgAAAAAAAAAPSGFzTWF0Y2hpbmdTdWl0AAAAAA8AAAAAAAAADURyYXdQaWxlRW1wdHkAAAAAAAAQAAAAAAAAABFOb1RyaWNrSW5Qcm9ncmVzcwAAAAAAABEAAAAAAAAAC0FkbWluTm90U2V0AAAAABIAAAAAAAAADUdhbWVIdWJOb3RTZXQAAAAAAAATAAAAAAAAAA5WZXJpZmllck5vdFNldAAAAAAAFAAAAAAAAAARVGltZW91dE5vdFJlYWNoZWQAAAAAAAAVAAAAAAAAABRUaW1lb3V0Tm90Q29uZmlndXJlZAAAABYAAAAAAAAAFFRpbWVvdXROb3RBcHBsaWNhYmxlAAAAFwAAAAAAAAAPV2Vha1NlZWRFbnRyb3B5AAAAABgAAAAAAAAADEludmFsaWROb25jZQAAABkAAAAAAAAAGlBsYXlDb21taXRBbHJlYWR5U3VibWl0dGVkAAAAAAAaAAAAAAAAABFQbGF5Q29tbWl0TWlzc2luZwAAAAAAABsAAAAAAAAAElBsYXlSZXZlYWxNaXNtYXRjaAAAAAAAHAAAAAAAAAANSW52YWxpZENhcmRJZAAAAAAAAB0AAAAAAAAAF1VsdHJhSG9ua1ZlcmlmaWVyTm90U2V0AAAAAB4AAAAAAAAAG1VsdHJhSG9ua1ZlcmlmaWNhdGlvbkZhaWxlZAAAAAAfAAAAAAAAABJaa1BsYXlQcm9vZkludmFsaWQAAAAAACAAAAAAAAAADlprUGxheVNldEVtcHR5AAAAAAAhAAAAAAAAABVaa1BsYXlPcGVuaW5nTWlzbWF0Y2gAAAAAAAAiAAAAAAAAABVaa0NhbmdrdWxQcm9vZkludmFsaWQAAAAAAAAjAAAAAAAAAAtUaWNrVG9vU29vbgAAAAAm",
        "AAAABQAAAAAAAAAAAAAADkV2RGVja1NodWZmbGVkAAAAAAABAAAAEGV2X2RlY2tfc2h1ZmZsZWQAAAABAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAAD9FbWl0dGVkIHdoZW4gYSBwbGF5ZXIgcmV2ZWFscyB0aGVpciBwbGF5IChjYXJkX2lkIG5vdyB2aXNpYmxlKS4AAAAAAAAAAA5FdlBsYXlSZXZlYWxlZAAAAAAAAQAAABBldl9wbGF5X3JldmVhbGVkAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAAAAAABnBsYXllcgAAAAAAEwAAAAAAAAAAAAAAB2NhcmRfaWQAAAAABAAAAAAAAAAAAAAACmlzX2NhbmdrdWwAAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADkV2U2VlZFJldmVhbGVkAAAAAAABAAAAEGV2X3NlZWRfcmV2ZWFsZWQAAAACAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAI=",
        "AAAABQAAAD1FbWl0dGVkIHdoZW4gYSBwbGF5ZXIgY29tbWl0cyB0aGVpciBwbGF5IChjYXJkX2lkIGlzIGhpZGRlbikuAAAAAAAAAAAAAA9FdlBsYXlDb21taXR0ZWQAAAAAAQAAABFldl9wbGF5X2NvbW1pdHRlZAAAAAAAAAIAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAD0V2U2VlZENvbW1pdHRlZAAAAAABAAAAEWV2X3NlZWRfY29tbWl0dGVkAAAAAAAAAgAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAAAAAABnBsYXllcgAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD0V2VHJpY2tSZXNvbHZlZAAAAAABAAAAEWV2X3RyaWNrX3Jlc29sdmVkAAAAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAAAAAABndpbm5lcgAAAAAABAAAAAAAAAAAAAAABWNhcmQxAAAAAAAD6AAAAAQAAAAAAAAAAAAAAAVjYXJkMgAAAAAAA+gAAAAEAAAAAAAAAAI=",
        "AAAAAAAAAK5Gb3JmZWl0IHRoZSBnYW1lLiBUaGUgY2FsbGVyIGltbWVkaWF0ZWx5IGxvc2VzLgoKVGhpcyBhbGxvd3MgYSBwbGF5ZXIgdG8gd2l0aGRyYXcgZnJvbSBhbiBhY3RpdmUgZ2FtZSBhdCBhbnkgcG9pbnQuClRoZSBvcHBvbmVudCBpcyBkZWNsYXJlZCB0aGUgd2lubmVyLiBUaGlzIGlzIGlycmV2ZXJzaWJsZS4AAAAAAAdmb3JmZWl0AAAAAAIAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAEAAAPpAAAAAgAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAAAAAAAHZ2V0X2h1YgAAAAAAAAAAAQAAA+kAAAATAAAH0AAAAA5DYW5na3VsYW5FcnJvcgAA",
        "AAAAAAAAAAAAAAAHc2V0X2h1YgAAAAABAAAAAAAAAAduZXdfaHViAAAAABMAAAABAAAD6QAAAAIAAAfQAAAADkNhbmdrdWxhbkVycm9yAAA=",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAfQAAAADkNhbmdrdWxhbkVycm9yAAA=",
        "AAAAAAAAASlHZXQgZ2FtZSBzdGF0ZSB3aXRoIGJvdGggaGFuZHMgcmVkYWN0ZWQgZm9yIGFjdGl2ZSBnYW1lcy4KClJldHVybnMgZnVsbCBzdGF0ZSAoaW5jbHVkaW5nIGhhbmRzKSBvbmx5IGZvciBGSU5JU0hFRCBnYW1lcy4KRHVyaW5nIGFjdGl2ZSBnYW1lcywgaGFuZHMgYXJlIGNsZWFyZWQgdG8gcHJldmVudCBjYXJkIHNub29waW5nCnZpYSB1bmF1dGhlbnRpY2F0ZWQgUlBDIHF1ZXJpZXMuIFVzZSBgZ2V0X2dhbWVfdmlld2Agd2l0aCBhIHZpZXdlcgphZGRyZXNzIHRvIHNlZSB5b3VyIG93biBoYW5kIGR1cmluZyBnYW1lcGxheS4AAAAAAAAIZ2V0X2dhbWUAAAABAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAQAAA+kAAAfQAAAADUNhbmdrdWxhbkdhbWUAAAAAAAfQAAAADkNhbmdrdWxhbkVycm9yAAA=",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAPpAAAAEwAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAAAgAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAABQAAAEpFbWl0dGVkIHdoZW4gYSBaSyBjYW5na3VsIGhhbmQgcHJvb2YgdmFsaWRhdGVzIGEgY2Fubm90LWZvbGxvdy1zdWl0IGNsYWltLgAAAAAAAAAAABNFdlprQ2FuZ2t1bFZlcmlmaWVkAAAAAAEAAAAWZXZfemtfY2FuZ2t1bF92ZXJpZmllZAAAAAAABAAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAAAAAABnBsYXllcgAAAAAAEwAAAAAAAAAAAAAACWhhbmRfc2l6ZQAAAAAAAAQAAAAAAAAAAAAAAAp0cmlja19zdWl0AAAAAAAEAAAAAAAAAAI=",
        "AAAAAAAAAAAAAAAKc3RhcnRfZ2FtZQAAAAAABQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAHcGxheWVyMQAAAAATAAAAAAAAAAdwbGF5ZXIyAAAAABMAAAAAAAAADnBsYXllcjFfcG9pbnRzAAAAAAALAAAAAAAAAA5wbGF5ZXIyX3BvaW50cwAAAAAACwAAAAEAAAPpAAAAAgAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAABQAAAERFbWl0dGVkIHdoZW4gYSBaSyByaW5nIHNpZ21hIHByb29mIHZhbGlkYXRlcyBhIGNhcmQgcGxheSBjb21taXRtZW50LgAAAAAAAAAURXZaa0NhcmRQbGF5VmVyaWZpZWQAAAABAAAAGGV2X3prX2NhcmRfcGxheV92ZXJpZmllZAAAAAMAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAAAAAAAAAAAAA52YWxpZF9zZXRfc2l6ZQAAAAAABAAAAAAAAAAC",
        "AAAAAAAAAXpDb21taXQgYSBwbGF5IGFjdGlvbjogYGNvbW1pdF9oYXNoID0ga2VjY2FrMjU2KGFjdGlvbl91MzJfYmUgfHwgc2FsdClgLgoKYGFjdGlvbmAgaXMgZWl0aGVyIGEgdmFsaWQgYGNhcmRfaWRgICgwLTM1KSB0byBwbGF5IGEgY2FyZCwgb3IKYENBTk5PVF9GT0xMT1dfU0VOVElORUxgICgweEZGRkZGRkZGKSB0byBkZWNsYXJlIGNhbm5vdCBmb2xsb3cgc3VpdC4KVGhlIGFjdHVhbCBhY3Rpb24gaXMgaGlkZGVuIHVudGlsIGJvdGggcGxheWVycyBoYXZlIGNvbW1pdHRlZC4KCmBleHBlY3RlZF9ub25jZWAgbXVzdCBlcXVhbCB0aGUgY3VycmVudCBgYWN0aW9uX25vbmNlYCB0byBwcmV2ZW50CnJlcGxheSBhdHRhY2tzIGFuZCBzdGFsZS1zdGF0ZSBzdWJtaXNzaW9ucy4AAAAAAAtjb21taXRfcGxheQAAAAAEAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAAAAAAAC2NvbW1pdF9oYXNoAAAAA+4AAAAgAAAAAAAAAA5leHBlY3RlZF9ub25jZQAAAAAABAAAAAEAAAPpAAAAAgAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAEJDb21taXQgYSBzZWVkIGhhc2guIEJvdGggcGxheWVycyBtdXN0IGNvbW1pdCBiZWZvcmUgcmV2ZWFsIGJlZ2lucy4AAAAAAAtjb21taXRfc2VlZAAAAAADAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAAAAAAAC2NvbW1pdF9oYXNoAAAAA+4AAAAgAAAAAQAAA+kAAAACAAAH0AAAAA5DYW5na3VsYW5FcnJvcgAA",
        "AAAAAAAAAWBSZXZlYWwgYSBwcmV2aW91c2x5IGNvbW1pdHRlZCBwbGF5IGFjdGlvbi4KCmBjYXJkX2lkYCBpcyB0aGUgYWN0dWFsIGNhcmQgdG8gcGxheSAoMC0zNSksIG9yIGBDQU5OT1RfRk9MTE9XX1NFTlRJTkVMYAp0byBkZWNsYXJlIGNhbm5vdCBmb2xsb3cgc3VpdC4KYHNhbHRgIGlzIHRoZSByYW5kb20gMzItYnl0ZSB2YWx1ZSB1c2VkIGluIHRoZSBjb21taXQ6Ci0gTGVnYWN5IG1vZGU6IGtlY2NhazI1NihjYXJkX2lkX3UzMl9iZSB8fCBzYWx0KSA9PSBjb21taXRfaGFzaAotIFpLIG1vZGU6IHNhbHQgPSBibGluZGluZyBmYWN0b3I7IGtlY2NhazI1NihjYXJkX2lkwrdHICsgYmxpbmRpbmfCt0gpID09IGNvbW1pdF9oYXNoAAAAC3JldmVhbF9wbGF5AAAAAAQAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAABnBsYXllcgAAAAAAEwAAAAAAAAAHY2FyZF9pZAAAAAAEAAAAAAAAAARzYWx0AAAD7gAAACAAAAABAAAD6QAAAAIAAAfQAAAADkNhbmdrdWxhbkVycm9yAAA=",
        "AAAAAAAAAxNSZXZlYWwgYSBzZWVkIHVzaW5nIGEgWmVyby1Lbm93bGVkZ2UgUHJvb2YuIFRoZSByYXcgc2VlZCBpcwoqKm5ldmVyKiogc3VibWl0dGVkIG9uLWNoYWluOyBvbmx5IGBzZWVkX2hhc2ggPSBrZWNjYWsyNTYoc2VlZClgIGlzCnJldmVhbGVkLiBUaGUgcHJvb2YgZGVtb25zdHJhdGVzIGtub3dsZWRnZSBvZiB0aGUgc2VlZCB3aXRob3V0CmRpc2Nsb3NpbmcgaXQsIHZlcmlmaWVkIHZpYSB0aGUgWksgdmVyaWZpZXIgY29udHJhY3QuCgpUd28gcHJvb2YgbW9kZXMgYXJlIHN1cHBvcnRlZCAoYXV0by1kZXRlY3RlZCBieSBwcm9vZiBsZW5ndGgpOgoKKipOSVpLIE1vZGUgKDY0IGJ5dGVzKToqKiBgYmxpbmRpbmcoMzIpIHx8IHJlc3BvbnNlKDMyKWAKSGFzaC1iYXNlZCBGaWF0LVNoYW1pciBwcm9vZi4KCioqUGVkZXJzZW4gTW9kZSAoMjI0IGJ5dGVzKToqKiBgQyg5NikgfHwgUig5NikgfHwgel9yKDMyKWAKQkxTMTItMzgxIFBlZGVyc2VuIGNvbW1pdG1lbnQgKyBTY2hub3JyIG9uIGJsaW5kaW5nLgpjb21taXRfaGFzaCA9IGtlY2NhazI1NihDKSwgdmVyaWZpZWQgb24tY2hhaW4gZm9yIGJpbmRpbmcuCgpPbmNlIGJvdGggc2VlZHMgYXJlIHJldmVhbGVkLCB0aGUgZGVjayBpcyBzaHVmZmxlZCBhbmQgY2FyZHMgYXJlIGRlYWx0LgoKIyBBcmd1bWVudHMKKiBgc2VlZF9oYXNoYCAtIGBrZWNjYWsyNTYoc2VlZClgLCB0aGUgb25lLXdheSBoYXNoIG9mIHRoZSByYXcgc2VlZAoqIGBwcm9vZmAgLSBaSyBwcm9vZiAoNjQgYnl0ZXMgZm9yIE5JWkssIDIyNCBieXRlcyBmb3IgUGVkZXJzZW4pAAAAAAtyZXZlYWxfc2VlZAAAAAAEAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAAAAAAACXNlZWRfaGFzaAAAAAAAA+4AAAAgAAAAAAAAAAVwcm9vZgAAAAAAAA4AAAABAAAD6QAAAAIAAAfQAAAADkNhbmdrdWxhbkVycm9yAAA=",
        "AAAAAAAAAAAAAAAMZ2V0X3ZlcmlmaWVyAAAAAAAAAAEAAAPpAAAAEwAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAAAAAAAMc2V0X3ZlcmlmaWVyAAAAAQAAAAAAAAAMbmV3X3ZlcmlmaWVyAAAAEwAAAAEAAAPpAAAAAgAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAAAAAAAMdGlja190aW1lb3V0AAAAAgAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAAEAAAH0AAAAA5DYW5na3VsYW5FcnJvcgAA",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAMAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIZ2FtZV9odWIAAAATAAAAAAAAAAh2ZXJpZmllcgAAABMAAAAA",
        "AAAAAAAAATxHZXQgZ2FtZSBzdGF0ZSB3aXRoIHByaXZhY3k6IG9ubHkgdGhlIHZpZXdlcidzIG93biBoYW5kIGlzIHZpc2libGUuClRoZSBvcHBvbmVudCdzIGhhbmQgaXMgcmVkYWN0ZWQgKGVtcHR5KSB0byBwcmV2ZW50IGNhc3VhbCBzbm9vcGluZwp2aWEgUlBDIHF1ZXJpZXMuIE5vbi1wbGF5ZXJzIHNlZSBib3RoIGhhbmRzIHJlZGFjdGVkLgpEdXJpbmcgdGhlIHJldmVhbCBwaGFzZSwgdGhlIG9wcG9uZW50J3MgdHJpY2tfY2FyZCBpcyBhbHNvIHJlZGFjdGVkCihpdCBvbmx5IGJlY29tZXMgdmlzaWJsZSBhZnRlciBib3RoIHBsYXllcnMgaGF2ZSByZXZlYWxlZCkuAAAADWdldF9nYW1lX3ZpZXcAAAAAAAACAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZ2aWV3ZXIAAAAAABMAAAABAAAD6QAAB9AAAAANQ2FuZ2t1bGFuR2FtZQAAAAAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAb5Db21taXQgYSBwbGF5IGFjdGlvbiB3aXRoIGEgWksgcmluZyBzaWdtYSBwcm9vZiBvZiBzdWl0IGNvbXBsaWFuY2UuCgpgY29tbWl0X2hhc2ggPSBrZWNjYWsyNTYoQ19ieXRlcylgIHdoZXJlIEMgaXMgYSBCTFMxMi0zODEgUGVkZXJzZW4KY29tbWl0bWVudCB0byB0aGUgY2FyZF9pZDogYEMgPSBjYXJkX2lkwrdHICsgYmxpbmRpbmfCt0hgLgoKYHprX3Byb29mYCBpcyB0aGUgcmluZyBzaWdtYSBwcm9vZjogYEMoOTYpIHx8IFtlX2koMzIpIHx8IHpfaSgzMildIMOXIE5gCnByb3ZpbmcgdGhlIGNvbW1pdHRlZCBjYXJkIGlzIGluIHRoZSBwbGF5ZXIncyB2YWxpZCBzZXQgKGhhbmQg4oipIHRyaWNrIHN1aXQpCndpdGhvdXQgcmV2ZWFsaW5nIHdoaWNoIHNwZWNpZmljIGNhcmQuCgpUaGUgWksgdmVyaWZpZXIgKE1vZGUgNykgY2hlY2tzIHRoZSByaW5nIHNpZ21hIGFuZCBiaW5kaW5nLgAAAAAADmNvbW1pdF9wbGF5X3prAAAAAAAFAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAAAAAAAC2NvbW1pdF9oYXNoAAAAA+4AAAAgAAAAAAAAAA5leHBlY3RlZF9ub25jZQAAAAAABAAAAAAAAAAIemtfcHJvb2YAAAAOAAAAAQAAA+kAAAACAAAH0AAAAA5DYW5na3VsYW5FcnJvcgAA",
        "AAAAAAAAAMBHZXQgZnVsbCByYXcgZ2FtZSBzdGF0ZSAoYWRtaW4tb25seSkuIFJlcXVpcmVzIGFkbWluIGF1dGhlbnRpY2F0aW9uLgpVc2VkIGZvciBkZWJ1Z2dpbmcgYW5kIHBvc3QtZ2FtZSB2ZXJpZmljYXRpb24uIEZvciBub3JtYWwgZ2FtZXBsYXkKdXNlIGBnZXRfZ2FtZV92aWV3YCB3aGljaCByZXNwZWN0cyBwbGF5ZXItbGV2ZWwgcHJpdmFjeS4AAAAOZ2V0X2dhbWVfZGVidWcAAAAAAAEAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAABAAAD6QAAB9AAAAANQ2FuZ2t1bGFuR2FtZQAAAAAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAS9SZWNvbXB1dGUgYW5kIHJldHVybiB0aGUgZnVsbCBzaHVmZmxlZCBkZWNrIG9yZGVyIGZyb20gWkstdmVyaWZpZWQgc2VlZCBoYXNoZXMuCkFueW9uZSBjYW4gY2FsbCB0aGlzIHRvIGluZGVwZW5kZW50bHkgdmVyaWZ5IHRoZSBzaHVmZmxlIHdhcyBmYWlyLiBUaGUKc2VlZCBoYXNoZXMgYXJlIGBrZWNjYWsyNTYocmF3X3NlZWQpYCDigJQgdGhlIHJhdyBzZWVkcyBuZXZlciBhcHBlYXIgb24tY2hhaW4uCk9ubHkgYXZhaWxhYmxlIGFmdGVyIGJvdGggc2VlZHMgaGF2ZSBiZWVuIHJldmVhbGVkIChQTEFZSU5HIG9yIEZJTklTSEVEKS4AAAAADnZlcmlmeV9zaHVmZmxlAAAAAAABAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAQAAA+kAAAPqAAAABAAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAAAAAAAPcmVzb2x2ZV90aW1lb3V0AAAAAAIAAAAAAAAACnNlc3Npb25faWQAAAAAAAQAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAEAAAPpAAAAAgAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAnNWZXJpZnkgYSBOb2lyIFVsdHJhS2VjY2FrSG9uayBwcm9vZiBvbi1jaGFpbiBpbiBhICoqc2VwYXJhdGUKdHJhbnNhY3Rpb24qKiBmcm9tIGByZXZlYWxfc2VlZGAuICBUaGlzIHNwbGl0cyB0aGUgfjI2ME0gQ1BVIGNvc3QKaW50byB0d28gdHJhbnNhY3Rpb25zIHRoYXQgZWFjaCBmaXQgd2l0aGluIFNvcm9iYW4gbGltaXRzOgoKVFggMTogYHZlcmlmeV9ub2lyX3NlZWRgIOKGkiBVbHRyYUhvbmsgdmVyaWZpY2F0aW9uICh+MjE1TSBDUFUpClRYIDI6IGByZXZlYWxfc2VlZGAgd2l0aCBhbiBlbXB0eSBwcm9vZiDihpIgZ2FtZSBsb2dpYyAofjUwTSBDUFUpCgpUaGUgdmVyaWZpZWQgZmxhZyBpcyBzdG9yZWQgaW4gdGVtcG9yYXJ5IHN0b3JhZ2UgYW5kIGNvbnN1bWVkIGJ5CmByZXZlYWxfc2VlZGAgd2hlbiBpdCBzZWVzIGEgemVyby1sZW5ndGggcHJvb2YuCgojIEFyZ3VtZW50cwoqIGBzZXNzaW9uX2lkYCAtIGdhbWUgc2Vzc2lvbiBpZAoqIGBwbGF5ZXJgIC0gdGhlIHBsYXllciByZXZlYWxpbmcgKHJlcXVpcmVzIGF1dGgpCiogYHNlZWRfaGFzaGAgLSBibGFrZTJzKHNlZWQpIOKAlCB0aGUgTm9pciBwdWJsaWMgaW5wdXQKKiBgcHJvb2ZgIC0gcmF3IFVsdHJhS2VjY2FrSG9uayBwcm9vZiAoPjRLQikAAAAAEHZlcmlmeV9ub2lyX3NlZWQAAAAEAAAAAAAAAApzZXNzaW9uX2lkAAAAAAAEAAAAAAAAAAZwbGF5ZXIAAAAAABMAAAAAAAAACXNlZWRfaGFzaAAAAAAAA+4AAAAgAAAAAAAAAAVwcm9vZgAAAAAAAA4AAAABAAAD6QAAAAIAAAfQAAAADkNhbmdrdWxhbkVycm9yAAA=",
        "AAAAAAAAAnRDb21taXQgYSBjYW5na3VsIChjYW5ub3QgZm9sbG93IHN1aXQpIGFjdGlvbiB3aXRoIGEgWksgaGFuZCBwcm9vZi4KClRoZSBwbGF5ZXIgcHJvdmVzIHRoYXQgTk9ORSBvZiB0aGUgY2FyZHMgaW4gdGhlaXIgaGFuZCBtYXRjaAp0aGUgY3VycmVudCB0cmljayBzdWl0LiBVc2VzIGFuIGFnZ3JlZ2F0ZSBQZWRlcnNlbiBjb21taXRtZW50Cm92ZXIgdGhlIGVudGlyZSBoYW5kIHdpdGggYSBTY2hub3JyIHByb29mIG9mIGtub3dsZWRnZS4KCmBjb21taXRfaGFzaCA9IGtlY2NhazI1NihBX2J5dGVzKWAgd2hlcmUgQSBpcyB0aGUgYWdncmVnYXRlClBlZGVyc2VuIGNvbW1pdG1lbnQ6IGBBID0gzqMoY2FyZF9pwrdHICsgcl9pwrdIKWAuCgpgemtfcHJvb2ZgIGxheW91dDogYGsoNCkgfHwgQSg5NiwgRzEpIHx8IFIoOTYsIEcxKSB8fCB6KDMyLCBGcikgPSAyMjggYnl0ZXNgCgpUaGUgWksgdmVyaWZpZXIgKE1vZGUgOCkgY2hlY2tzOgoxLiBBZ2dyZWdhdGUgUGVkZXJzZW4gYmluZGluZyAoa2VjY2FrMjU2KEEpID09IGNvbW1pdF9oYXNoKQoyLiBTY2hub3JyIHByb29mIG9mIGtub3dsZWRnZSBvZiBhZ2dyZWdhdGUgYmxpbmRpbmcKMy4gU3VpdCBleGNsdXNpb246IG5vIGNhcmQgbWF0Y2hlcyB0cmlja19zdWl0AAAAEWNvbW1pdF9jYW5na3VsX3prAAAAAAAABQAAAAAAAAAKc2Vzc2lvbl9pZAAAAAAABAAAAAAAAAAGcGxheWVyAAAAAAATAAAAAAAAAAtjb21taXRfaGFzaAAAAAPuAAAAIAAAAAAAAAAOZXhwZWN0ZWRfbm9uY2UAAAAAAAQAAAAAAAAACHprX3Byb29mAAAADgAAAAEAAAPpAAAAAgAAB9AAAAAOQ2FuZ2t1bGFuRXJyb3IAAA==",
        "AAAAAAAAAJ5HZXQgYSBwbGF5ZXIncyBnYW1lIGhpc3RvcnkgKHVwIHRvIDUwIG1vc3QgcmVjZW50IGdhbWVzKS4KUmV0dXJucyBhIFZlYyBvZiBHYW1lU3VtbWFyeSB3aXRoIG91dGNvbWUgZnJvbSB0aGUgcGxheWVyJ3MgcGVyc3BlY3RpdmU6CjEgPSB3aW4sIDIgPSBsb3NzLCAzID0gZHJhdwAAAAAAEmdldF9wbGF5ZXJfaGlzdG9yeQAAAAAAAQAAAAAAAAAGcGxheWVyAAAAAAATAAAAAQAAA+oAAAfQAAAAC0dhbWVTdW1tYXJ5AA==",
        "AAAAAAAAAEJHZXQgdGhlIFVsdHJhSG9uayB2ZXJpZmllciBjb250cmFjdCBhZGRyZXNzIChOb2lyIHByb29mIHZlcmlmaWVyKS4AAAAAABZnZXRfdWx0cmFob25rX3ZlcmlmaWVyAAAAAAAAAAAAAQAAA+kAAAATAAAH0AAAAA5DYW5na3VsYW5FcnJvcgAA",
        "AAAAAAAAAHhTZXQgdGhlIFVsdHJhSG9uayB2ZXJpZmllciBjb250cmFjdCBhZGRyZXNzIChhZG1pbiBvbmx5KS4KVGhpcyBlbmFibGVzIG9wdGlvbmFsIE5vaXIgVWx0cmFLZWNjYWtIb25rIHByb29mIHZlcmlmaWNhdGlvbi4AAAAWc2V0X3VsdHJhaG9ua192ZXJpZmllcgAAAAAAAQAAAAAAAAANdmVyaWZpZXJfYWRkcgAAAAAAABMAAAABAAAD6QAAAAIAAAfQAAAADkNhbmdrdWxhbkVycm9yAAA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    forfeit: this.txFromJSON<Result<void>>,
        get_hub: this.txFromJSON<Result<string>>,
        set_hub: this.txFromJSON<Result<void>>,
        upgrade: this.txFromJSON<Result<void>>,
        get_game: this.txFromJSON<Result<CangkulanGame>>,
        get_admin: this.txFromJSON<Result<string>>,
        set_admin: this.txFromJSON<Result<void>>,
        start_game: this.txFromJSON<Result<void>>,
        commit_play: this.txFromJSON<Result<void>>,
        commit_seed: this.txFromJSON<Result<void>>,
        reveal_play: this.txFromJSON<Result<void>>,
        reveal_seed: this.txFromJSON<Result<void>>,
        get_verifier: this.txFromJSON<Result<string>>,
        set_verifier: this.txFromJSON<Result<void>>,
        tick_timeout: this.txFromJSON<Result<u32>>,
        get_game_view: this.txFromJSON<Result<CangkulanGame>>,
        commit_play_zk: this.txFromJSON<Result<void>>,
        get_game_debug: this.txFromJSON<Result<CangkulanGame>>,
        verify_shuffle: this.txFromJSON<Result<Array<u32>>>,
        resolve_timeout: this.txFromJSON<Result<void>>,
        verify_noir_seed: this.txFromJSON<Result<void>>,
        commit_cangkul_zk: this.txFromJSON<Result<void>>,
        get_player_history: this.txFromJSON<Array<GameSummary>>,
        get_ultrahonk_verifier: this.txFromJSON<Result<string>>,
        set_ultrahonk_verifier: this.txFromJSON<Result<void>>
  }
}