#![cfg(test)]

//! Unit tests for the Cangkulan Lite contract.
//!
//! Uses a mock Game Hub (tracks start/end counts) and a mock ZK verifier
//! (accepts any non-empty proof) for isolated testing.
//!
//! The playing phase uses a commit-reveal protocol:
//! 1. Both players commit keccak256(card_id_be4 || salt)
//! 2. Both players reveal card_id + salt
//! 3. Contract verifies, applies, and resolves the trick

use crate::{
    CangkulanContract, CangkulanContractClient, CangkulanError,
    CANNOT_FOLLOW_SENTINEL, CARDS_PER_SUIT, STATE_PLAYING, STATE_SEED_COMMIT,
    STATE_SEED_REVEAL, STATE_FINISHED, TRICK_COMMIT_WAIT_BOTH,
    TRICK_COMMIT_WAIT_P2, TRICK_REVEAL_WAIT_BOTH, TRICK_REVEAL_WAIT_P2,
    OUTCOME_PLAYER1_WIN, OUTCOME_PLAYER2_WIN,
};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Bytes, BytesN, Env, Vec};
use soroban_sdk::crypto::bls12_381::{Fr, G1Affine};

// ════════════════════════════════════════════════════════════════════════════
//  Mock Game Hub
// ════════════════════════════════════════════════════════════════════════════

#[contracttype]
#[derive(Clone)]
enum MockKey {
    StartCount,
    EndCount,
}

#[contract]
pub struct MockGameHub;

#[contractimpl]
impl MockGameHub {
    pub fn start_game(
        env: Env,
        _game_id: Address,
        _session_id: u32,
        _player1: Address,
        _player2: Address,
        _player1_points: i128,
        _player2_points: i128,
    ) {
        let count: u32 = env.storage().instance().get(&MockKey::StartCount).unwrap_or(0);
        env.storage().instance().set(&MockKey::StartCount, &(count + 1));
    }

    pub fn end_game(env: Env, _session_id: u32, _player1_won: bool) {
        let count: u32 = env.storage().instance().get(&MockKey::EndCount).unwrap_or(0);
        env.storage().instance().set(&MockKey::EndCount, &(count + 1));
    }

    pub fn get_start_count(env: Env) -> u32 {
        env.storage().instance().get(&MockKey::StartCount).unwrap_or(0)
    }

    pub fn get_end_count(env: Env) -> u32 {
        env.storage().instance().get(&MockKey::EndCount).unwrap_or(0)
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Mock ZK Verifier (accepts any non-empty proof)
// ════════════════════════════════════════════════════════════════════════════

#[contract]
pub struct MockZkVerifier;

#[contractimpl]
impl MockZkVerifier {
    pub fn verify(_env: Env, _public_inputs: Bytes, proof: Bytes) -> bool {
        proof.len() > 0
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Test Helpers
// ════════════════════════════════════════════════════════════════════════════

fn setup_test() -> (
    Env,
    CangkulanContractClient<'static>,
    MockGameHubClient<'static>,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1_700_000_000,
        protocol_version: 25,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    let hub_addr = env.register(MockGameHub, ());
    let hub_client = MockGameHubClient::new(&env, &hub_addr);

    let verifier_addr = env.register(MockZkVerifier, ());

    let admin = Address::generate(&env);
    let contract_id = env.register(CangkulanContract, (&admin, &hub_addr, &verifier_addr));
    let client = CangkulanContractClient::new(&env, &contract_id);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    (env, client, hub_client, player1, player2)
}

fn compute_seed_hash(env: &Env, seed: &BytesN<32>) -> BytesN<32> {
    env.crypto().keccak256(&Bytes::from_array(env, &seed.to_array())).into()
}

/// Compute blinded NIZK commitment = keccak256(seed_hash || blinding || player_address)
fn compute_nizk_commitment(
    env: &Env,
    seed_hash: &BytesN<32>,
    blinding: &BytesN<32>,
    player: &Address,
) -> BytesN<32> {
    let mut pre = Bytes::from_array(env, &seed_hash.to_array());
    pre.append(&Bytes::from_array(env, &blinding.to_array()));
    pre.append(&player.to_string().to_bytes());
    env.crypto().keccak256(&pre).into()
}

/// Build a 64-byte NIZK proof (blinding || response).
fn build_nizk_proof(env: &Env, blinding: &BytesN<32>) -> Bytes {
    let mut proof = Bytes::from_array(env, &blinding.to_array());
    proof.append(&Bytes::from_array(env, &[0u8; 32]));
    proof
}

/// Compute play commit hash: keccak256(card_id_u32_be || salt)
fn compute_play_commit(env: &Env, card_id: u32, salt: &BytesN<32>) -> BytesN<32> {
    let mut preimage = Bytes::from_array(env, &card_id.to_be_bytes());
    preimage.append(&Bytes::from_array(env, &salt.to_array()));
    env.crypto().keccak256(&preimage).into()
}

/// Generate a deterministic salt for testing
fn test_salt(env: &Env, unique: u8) -> BytesN<32> {
    BytesN::<32>::from_array(env, &[unique; 32])
}

/// Helper: advance the ledger forward by `delta` ledgers.
fn advance_ledger(env: &Env, delta: u32) {
    let info = env.ledger().get();
    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: info.timestamp + (delta as u64) * 5,
        protocol_version: info.protocol_version,
        sequence_number: info.sequence_number + delta,
        network_id: info.network_id,
        base_reserve: info.base_reserve,
        min_temp_entry_ttl: info.min_temp_entry_ttl,
        min_persistent_entry_ttl: info.min_persistent_entry_ttl,
        max_entry_ttl: info.max_entry_ttl,
    });
}

/// Helper: perform two rate-limited tick_timeout calls with ledger advancement.
fn tick_timeout_twice(env: &Env, client: &CangkulanContractClient, sid: &u32, caller: &Address) {
    client.tick_timeout(sid, caller);
    advance_ledger(env, 61); // pass MIN_TICK_GAP_LEDGERS
    client.tick_timeout(sid, caller);
}

/// Helper: advance a game through seed commit + reveal to the PLAYING state.
fn advance_to_playing(
    env: &Env,
    client: &CangkulanContractClient,
    session_id: u32,
    player1: &Address,
    player2: &Address,
) -> (BytesN<32>, BytesN<32>) {
    let seed1 = BytesN::<32>::from_array(env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let blinding1 = BytesN::<32>::from_array(env, &[0xAAu8; 32]);
    let blinding2 = BytesN::<32>::from_array(env, &[0xBBu8; 32]);

    let seed_hash1 = compute_seed_hash(env, &seed1);
    let seed_hash2 = compute_seed_hash(env, &seed2);

    let commit1 = compute_nizk_commitment(env, &seed_hash1, &blinding1, player1);
    let commit2 = compute_nizk_commitment(env, &seed_hash2, &blinding2, player2);

    client.commit_seed(&session_id, player1, &commit1);
    client.commit_seed(&session_id, player2, &commit2);

    let proof1 = build_nizk_proof(env, &blinding1);
    let proof2 = build_nizk_proof(env, &blinding2);
    client.reveal_seed(&session_id, player1, &seed_hash1, &proof1);
    client.reveal_seed(&session_id, player2, &seed_hash2, &proof2);

    (seed_hash1, seed_hash2)
}

fn assert_cangkulan_error<T, E>(
    result: &Result<Result<T, E>, Result<CangkulanError, soroban_sdk::InvokeError>>,
    expected: CangkulanError,
) {
    match result {
        Err(Ok(actual)) => {
            assert_eq!(
                *actual, expected,
                "Expected error {:?} ({}), got {:?} ({})",
                expected, expected as u32, actual, *actual as u32
            );
        }
        Err(Err(invoke_err)) => {
            panic!(
                "Expected {:?} ({}), got invoke error: {:?}",
                expected, expected as u32, invoke_err
            );
        }
        Ok(_) => {
            panic!(
                "Expected error {:?} ({}), but operation succeeded",
                expected, expected as u32
            );
        }
    }
}

fn card_suit(card_id: u32) -> u32 {
    card_id / CARDS_PER_SUIT
}

fn card_value(card_id: u32) -> u32 {
    card_id % CARDS_PER_SUIT + 2
}

/// Helper: check if any card in hand matches the given suit.
fn hand_has_suit(hand: &Vec<u32>, suit: u32) -> bool {
    let mut i: u32 = 0;
    while i < hand.len() {
        if card_suit(hand.get(i).unwrap()) == suit {
            return true;
        }
        i += 1;
    }
    false
}

/// Helper: find the first card in hand matching the given suit.
fn first_card_of_suit(hand: &Vec<u32>, suit: u32) -> Option<u32> {
    let mut i: u32 = 0;
    while i < hand.len() {
        let c = hand.get(i).unwrap();
        if card_suit(c) == suit {
            return Some(c);
        }
        i += 1;
    }
    None
}

/// Play one complete trick using commit-reveal protocol.
/// Both players act optimally (follow suit if possible).
/// Returns (p1_hand_delta, p2_hand_delta, draw_pile_delta).
fn play_one_trick(
    env: &Env,
    client: &CangkulanContractClient,
    player1: &Address,
    player2: &Address,
    sid: u32,
) -> (i32, i32, i32) {
    let before = client.get_game_debug(&sid);
    let h1_before = before.hand1.len() as i32;
    let h2_before = before.hand2.len() as i32;
    let dp_before = before.draw_pile.len() as i32;
    let trick_suit = before.trick_suit.unwrap();
    let nonce = before.action_nonce;

    let salt1 = test_salt(env, 0x11);
    let salt2 = test_salt(env, 0x22);

    // Determine actions
    let p1_action = match first_card_of_suit(&before.hand1, trick_suit) {
        Some(c) => c,
        None => CANNOT_FOLLOW_SENTINEL,
    };
    let p2_action = match first_card_of_suit(&before.hand2, trick_suit) {
        Some(c) => c,
        None => CANNOT_FOLLOW_SENTINEL,
    };

    // Phase 1: Both commit
    let commit1 = compute_play_commit(env, p1_action, &salt1);
    client.commit_play(&sid, player1, &commit1, &nonce);

    let mid = client.get_game_debug(&sid);
    let commit2 = compute_play_commit(env, p2_action, &salt2);
    client.commit_play(&sid, player2, &commit2, &mid.action_nonce);

    // Phase 2: Both reveal
    client.reveal_play(&sid, player1, &p1_action, &salt1);
    let mid2 = client.get_game_debug(&sid);

    if mid2.lifecycle_state == STATE_FINISHED {
        return (
            mid2.hand1.len() as i32 - h1_before,
            mid2.hand2.len() as i32 - h2_before,
            mid2.draw_pile.len() as i32 - dp_before,
        );
    }

    client.reveal_play(&sid, player2, &p2_action, &salt2);

    let after = client.get_game_debug(&sid);
    (
        after.hand1.len() as i32 - h1_before,
        after.hand2.len() as i32 - h2_before,
        after.draw_pile.len() as i32 - dp_before,
    )
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Game start
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn start_game_success() {
    let (_env, client, hub, player1, player2) = setup_test();
    let sid = 1u32;

    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let game = client.get_game_debug(&sid);
    assert_eq!(game.player1, player1);
    assert_eq!(game.player2, player2);
    assert_eq!(game.lifecycle_state, STATE_SEED_COMMIT);
    assert!(game.hand1.is_empty());
    assert!(game.hand2.is_empty());
    assert_eq!(hub.get_start_count(), 1);
}

#[test]
fn self_play_rejected() {
    let (_env, client, _hub, player1, _player2) = setup_test();
    let result = client.try_start_game(&1, &player1, &player1, &100_0000000, &100_0000000);
    assert_cangkulan_error(&result, CangkulanError::SelfPlayNotAllowed);
}

#[test]
fn duplicate_session_rejected() {
    let (_env, client, _hub, player1, player2) = setup_test();
    client.start_game(&1, &player1, &player2, &100_0000000, &100_0000000);
    let result = client.try_start_game(&1, &player1, &player2, &100_0000000, &100_0000000);
    assert_cangkulan_error(&result, CangkulanError::SessionAlreadyExists);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Seed commit-reveal
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn seed_commit_reveal_flow() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 10u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let blinding2 = BytesN::<32>::from_array(&env, &[0xBBu8; 32]);

    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let seed_hash2 = compute_seed_hash(&env, &seed2);
    let commit1 = compute_nizk_commitment(&env, &seed_hash1, &blinding1, &player1);
    let commit2 = compute_nizk_commitment(&env, &seed_hash2, &blinding2, &player2);

    client.commit_seed(&sid, &player1, &commit1);
    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_SEED_COMMIT);

    client.commit_seed(&sid, &player2, &commit2);
    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_SEED_REVEAL);

    let proof1 = build_nizk_proof(&env, &blinding1);
    client.reveal_seed(&sid, &player1, &seed_hash1, &proof1);
    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_SEED_REVEAL);

    let proof2 = build_nizk_proof(&env, &blinding2);
    client.reveal_seed(&sid, &player2, &seed_hash2, &proof2);
    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_PLAYING);

    assert_eq!(game.hand1.len(), 5);
    assert_eq!(game.hand2.len(), 5);
    assert_eq!(game.draw_pile.len(), 25);
    assert!(game.flipped_card.is_some());
    assert!(game.trick_suit.is_some());
    assert_eq!(game.trick_state, TRICK_COMMIT_WAIT_BOTH);
}

#[test]
fn double_commit_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 11u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let commit1 = compute_nizk_commitment(&env, &seed_hash1, &blinding1, &player1);

    client.commit_seed(&sid, &player1, &commit1);
    let result = client.try_commit_seed(&sid, &player1, &commit1);
    assert_cangkulan_error(&result, CangkulanError::CommitAlreadySubmitted);
}

#[test]
fn weak_seed_entropy_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 13u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let weak_seed_hash = BytesN::<32>::from_array(&env, &[0u8; 32]);
    let blinding = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let commit = compute_nizk_commitment(&env, &weak_seed_hash, &blinding, &player1);

    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let blinding2 = BytesN::<32>::from_array(&env, &[0xBBu8; 32]);
    let seed_hash2 = compute_seed_hash(&env, &seed2);
    let commit2 = compute_nizk_commitment(&env, &seed_hash2, &blinding2, &player2);

    client.commit_seed(&sid, &player1, &commit);
    client.commit_seed(&sid, &player2, &commit2);

    let proof = build_nizk_proof(&env, &blinding);
    let result = client.try_reveal_seed(&sid, &player1, &weak_seed_hash, &proof);
    assert_cangkulan_error(&result, CangkulanError::WeakSeedEntropy);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Card dealing
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn all_cards_unique_in_deal() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 20u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);

    let mut all_cards: Vec<u32> = Vec::new(&env);
    let mut i: u32 = 0;
    while i < game.hand1.len() {
        all_cards.push_back(game.hand1.get(i).unwrap());
        i += 1;
    }
    i = 0;
    while i < game.hand2.len() {
        all_cards.push_back(game.hand2.get(i).unwrap());
        i += 1;
    }
    i = 0;
    while i < game.draw_pile.len() {
        all_cards.push_back(game.draw_pile.get(i).unwrap());
        i += 1;
    }
    all_cards.push_back(game.flipped_card.unwrap());

    assert_eq!(all_cards.len(), 36);

    let mut seen = [false; 36];
    i = 0;
    while i < all_cards.len() {
        let card = all_cards.get(i).unwrap();
        assert!(card < 36, "Card {} out of range", card);
        assert!(!seen[card as usize], "Duplicate card {}", card);
        seen[card as usize] = true;
        i += 1;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Card encoding
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn card_encoding() {
    assert_eq!(card_suit(0), 0);
    assert_eq!(card_value(0), 2);
    assert_eq!(card_suit(8), 0);
    assert_eq!(card_value(8), 10);
    assert_eq!(card_suit(9), 1);
    assert_eq!(card_value(9), 2);
    assert_eq!(card_suit(35), 3);
    assert_eq!(card_value(35), 10);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Commit-reveal playing phase
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn commit_reveal_play_card() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 30u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    assert_eq!(game.trick_state, TRICK_COMMIT_WAIT_BOTH);
    let trick_suit = game.trick_suit.unwrap();

    // Find a card that matches the trick suit
    let p1_card = first_card_of_suit(&game.hand1, trick_suit);
    let p2_card = first_card_of_suit(&game.hand2, trick_suit);

    let salt1 = test_salt(&env, 0x11);
    let salt2 = test_salt(&env, 0x22);

    let p1_action = p1_card.unwrap_or(CANNOT_FOLLOW_SENTINEL);
    let p2_action = p2_card.unwrap_or(CANNOT_FOLLOW_SENTINEL);

    // Phase 1: Commit
    let commit1 = compute_play_commit(&env, p1_action, &salt1);
    client.commit_play(&sid, &player1, &commit1, &game.action_nonce);
    let g1 = client.get_game_debug(&sid);
    assert_eq!(g1.trick_state, TRICK_COMMIT_WAIT_P2);
    assert!(g1.play_commit1.is_some());
    assert!(g1.play_commit2.is_none());

    let commit2 = compute_play_commit(&env, p2_action, &salt2);
    client.commit_play(&sid, &player2, &commit2, &g1.action_nonce);
    let g2 = client.get_game_debug(&sid);
    assert_eq!(g2.trick_state, TRICK_REVEAL_WAIT_BOTH);
    assert!(g2.play_commit1.is_some());
    assert!(g2.play_commit2.is_some());

    // Phase 2: Reveal
    client.reveal_play(&sid, &player1, &p1_action, &salt1);
    let g3 = client.get_game_debug(&sid);
    assert_eq!(g3.trick_state, TRICK_REVEAL_WAIT_P2);

    client.reveal_play(&sid, &player2, &p2_action, &salt2);
    // Trick should be resolved now — new trick starts or game ends
    let g4 = client.get_game_debug(&sid);
    assert!(g4.trick_state == TRICK_COMMIT_WAIT_BOTH || g4.lifecycle_state == STATE_FINISHED);
}

#[test]
fn commit_play_wrong_reveal_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 31u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();
    let p1_action = first_card_of_suit(&game.hand1, trick_suit).unwrap_or(CANNOT_FOLLOW_SENTINEL);
    let p2_action = first_card_of_suit(&game.hand2, trick_suit).unwrap_or(CANNOT_FOLLOW_SENTINEL);

    let salt1 = test_salt(&env, 0x11);
    let salt2 = test_salt(&env, 0x22);
    let wrong_salt = test_salt(&env, 0xFF);

    // Both commit
    let commit1 = compute_play_commit(&env, p1_action, &salt1);
    let commit2 = compute_play_commit(&env, p2_action, &salt2);
    client.commit_play(&sid, &player1, &commit1, &game.action_nonce);
    let g = client.get_game_debug(&sid);
    client.commit_play(&sid, &player2, &commit2, &g.action_nonce);

    // P1 tries to reveal with wrong salt
    let result = client.try_reveal_play(&sid, &player1, &p1_action, &wrong_salt);
    assert_cangkulan_error(&result, CangkulanError::PlayRevealMismatch);

    // P1 reveals with correct salt — should work
    client.reveal_play(&sid, &player1, &p1_action, &salt1);
}

#[test]
fn double_commit_play_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 32u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let salt = test_salt(&env, 0x11);
    let commit = compute_play_commit(&env, CANNOT_FOLLOW_SENTINEL, &salt);

    client.commit_play(&sid, &player1, &commit, &game.action_nonce);
    let g = client.get_game_debug(&sid);
    // P1 tries to commit again — should fail
    let result = client.try_commit_play(&sid, &player1, &commit, &g.action_nonce);
    assert_cangkulan_error(&result, CangkulanError::NotYourTurn);
}

#[test]
fn stale_nonce_rejected_commit_play() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 33u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let stale_nonce = game.action_nonce.wrapping_add(1);
    let salt = test_salt(&env, 0x11);
    let commit = compute_play_commit(&env, CANNOT_FOLLOW_SENTINEL, &salt);

    let result = client.try_commit_play(&sid, &player1, &commit, &stale_nonce);
    assert_cangkulan_error(&result, CangkulanError::InvalidNonce);
}

#[test]
fn wrong_suit_reveal_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 34u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();

    // Find a card in P1's hand that does NOT match trick suit, but P1 also
    // HAS a matching suit card (otherwise it's a valid cannot-follow)
    if !hand_has_suit(&game.hand1, trick_suit) {
        return; // Can't test wrong-suit if P1 has no matching cards
    }
    let mut wrong_card: Option<u32> = None;
    let mut i: u32 = 0;
    while i < game.hand1.len() {
        let c = game.hand1.get(i).unwrap();
        if card_suit(c) != trick_suit {
            wrong_card = Some(c);
            break;
        }
        i += 1;
    }

    if let Some(card) = wrong_card {
        let salt1 = test_salt(&env, 0x11);
        let salt2 = test_salt(&env, 0x22);
        let p2_action = first_card_of_suit(&game.hand2, trick_suit).unwrap_or(CANNOT_FOLLOW_SENTINEL);

        // Both commit (P1 commits with the wrong card — commit succeeds, reveal will fail)
        let commit1 = compute_play_commit(&env, card, &salt1);
        let commit2 = compute_play_commit(&env, p2_action, &salt2);
        client.commit_play(&sid, &player1, &commit1, &game.action_nonce);
        let g = client.get_game_debug(&sid);
        client.commit_play(&sid, &player2, &commit2, &g.action_nonce);

        // P1 reveal with wrong suit card — should fail
        let result = client.try_reveal_play(&sid, &player1, &card, &salt1);
        assert_cangkulan_error(&result, CangkulanError::WrongSuit);
    }
}

#[test]
fn cannot_follow_when_has_suit_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();

    // Find session where P1 has a matching suit card
    let mut sid = 35u32;
    loop {
        assert!(sid < 100, "Could not find test setup");
        client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
        advance_to_playing(&env, &client, sid, &player1, &player2);
        let game = client.get_game_debug(&sid);
        let suit = game.trick_suit.unwrap();
        if hand_has_suit(&game.hand1, suit) {
            break;
        }
        sid += 1;
    }

    let game = client.get_game_debug(&sid);
    let salt1 = test_salt(&env, 0x11);
    let salt2 = test_salt(&env, 0x22);
    let p2_action = first_card_of_suit(&game.hand2, game.trick_suit.unwrap())
        .unwrap_or(CANNOT_FOLLOW_SENTINEL);

    // P1 commits CANNOT_FOLLOW_SENTINEL even though they have a matching suit card
    let commit1 = compute_play_commit(&env, CANNOT_FOLLOW_SENTINEL, &salt1);
    let commit2 = compute_play_commit(&env, p2_action, &salt2);
    client.commit_play(&sid, &player1, &commit1, &game.action_nonce);
    let g = client.get_game_debug(&sid);
    client.commit_play(&sid, &player2, &commit2, &g.action_nonce);

    // Reveal — contract catches that P1 lied about cannot follow
    let result = client.try_reveal_play(&sid, &player1, &CANNOT_FOLLOW_SENTINEL, &salt1);
    assert_cangkulan_error(&result, CangkulanError::HasMatchingSuit);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Full game play
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn play_full_game_until_finished() {
    let (env, client, hub, player1, player2) = setup_test();
    let sid = 40u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let mut iterations = 0u32;
    loop {
        let game = client.get_game_debug(&sid);
        if game.lifecycle_state == STATE_FINISHED {
            break;
        }
        assert!(iterations < 200, "Game did not finish after 200 iterations");
        iterations += 1;

        play_one_trick(&env, &client, &player1, &player2, sid);
    }

    let final_game = client.get_game_debug(&sid);
    assert_eq!(final_game.lifecycle_state, STATE_FINISHED);
    assert!(
        final_game.outcome == OUTCOME_PLAYER1_WIN
            || final_game.outcome == OUTCOME_PLAYER2_WIN
            || final_game.outcome == crate::OUTCOME_DRAW,
        "Game should have a result"
    );
    assert_eq!(hub.get_start_count(), 1);
    assert_eq!(hub.get_end_count(), 1);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Timeout
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn timeout_during_seed_commit() {
    let (env, client, hub, player1, player2) = setup_test();
    let sid = 50u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let commit1 = compute_nizk_commitment(&env, &seed_hash1, &blinding1, &player1);

    client.commit_seed(&sid, &player1, &commit1);

    tick_timeout_twice(&env, &client, &sid, &player1);
    client.resolve_timeout(&sid, &player1);

    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_FINISHED);
    assert_eq!(game.outcome, OUTCOME_PLAYER1_WIN);
    assert_eq!(hub.get_end_count(), 1);
}

#[test]
fn timeout_during_playing_commit_phase() {
    let (env, client, hub, player1, player2) = setup_test();
    let sid = 51u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    // P1 commits, P2 doesn't
    let game = client.get_game_debug(&sid);
    let salt = test_salt(&env, 0x11);
    let commit = compute_play_commit(&env, CANNOT_FOLLOW_SENTINEL, &salt);
    client.commit_play(&sid, &player1, &commit, &game.action_nonce);

    // Tick twice with ledger advances to reach deadline
    tick_timeout_twice(&env, &client, &sid, &player1);
    client.resolve_timeout(&sid, &player1);

    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_FINISHED);
    // P2 didn't commit → P1 wins
    assert_eq!(game.outcome, OUTCOME_PLAYER1_WIN);
    assert_eq!(hub.get_end_count(), 1);
}

#[test]
fn timeout_during_playing_reveal_phase() {
    let (env, client, hub, player1, player2) = setup_test();
    let sid = 53u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();
    let salt1 = test_salt(&env, 0x11);
    let salt2 = test_salt(&env, 0x22);
    let p1_action = first_card_of_suit(&game.hand1, trick_suit).unwrap_or(CANNOT_FOLLOW_SENTINEL);
    let p2_action = first_card_of_suit(&game.hand2, trick_suit).unwrap_or(CANNOT_FOLLOW_SENTINEL);

    // Both commit
    let commit1 = compute_play_commit(&env, p1_action, &salt1);
    let commit2 = compute_play_commit(&env, p2_action, &salt2);
    client.commit_play(&sid, &player1, &commit1, &game.action_nonce);
    let g = client.get_game_debug(&sid);
    client.commit_play(&sid, &player2, &commit2, &g.action_nonce);

    // P1 reveals, P2 doesn't
    client.reveal_play(&sid, &player1, &p1_action, &salt1);

    // P1 ticks timeout on P2 with rate-limited gaps
    tick_timeout_twice(&env, &client, &sid, &player1);
    client.resolve_timeout(&sid, &player1);

    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_FINISHED);
    // P2 didn't reveal → P1 wins
    assert_eq!(game.outcome, OUTCOME_PLAYER1_WIN);
    assert_eq!(hub.get_end_count(), 1);
}

#[test]
fn ledger_based_timeout_during_commit() {
    let (env, client, hub, player1, player2) = setup_test();
    let sid = 52u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let commit1 = compute_nizk_commitment(&env, &seed_hash1, &blinding1, &player1);

    client.commit_seed(&sid, &player1, &commit1);

    let result = client.try_resolve_timeout(&sid, &player1);
    assert_cangkulan_error(&result, CangkulanError::TimeoutNotReached);

    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1_700_001_000,
        protocol_version: 25,
        sequence_number: 100 + 121,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    client.resolve_timeout(&sid, &player1);

    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_FINISHED);
    assert_eq!(game.outcome, OUTCOME_PLAYER1_WIN);
    assert_eq!(hub.get_end_count(), 1);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Session independence
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn different_sessions_are_independent() {
    let (env, client, hub, player1, player2) = setup_test();
    let player3 = Address::generate(&env);
    let player4 = Address::generate(&env);

    client.start_game(&100, &player1, &player2, &100_0000000, &100_0000000);
    client.start_game(&101, &player3, &player4, &50_0000000, &50_0000000);

    let game1 = client.get_game_debug(&100);
    let game2 = client.get_game_debug(&101);

    assert_eq!(game1.player1, player1);
    assert_eq!(game2.player1, player3);
    assert_eq!(game1.player1_points, 100_0000000);
    assert_eq!(game2.player1_points, 50_0000000);
    assert_eq!(hub.get_start_count(), 2);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Security hardening
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn tick_timeout_rejected_for_non_player() {
    let (env, client, _hub, player1, player2) = setup_test();
    let outsider = Address::generate(&env);
    let sid = 60u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let commit1 = compute_nizk_commitment(&env, &seed_hash1, &blinding1, &player1);
    client.commit_seed(&sid, &player1, &commit1);

    let result = client.try_tick_timeout(&sid, &outsider);
    assert_cangkulan_error(&result, CangkulanError::NotAPlayer);

    client.tick_timeout(&sid, &player1);
}

#[test]
fn tick_timeout_rate_limited() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 61u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let commit1 = compute_nizk_commitment(&env, &seed_hash1, &blinding1, &player1);
    client.commit_seed(&sid, &player1, &commit1);

    // First tick succeeds
    client.tick_timeout(&sid, &player1);

    // Second tick immediately should fail with TickTooSoon
    let result = client.try_tick_timeout(&sid, &player1);
    assert_cangkulan_error(&result, CangkulanError::TickTooSoon);

    // Advance ledger past MIN_TICK_GAP_LEDGERS, then tick succeeds
    advance_ledger(&env, 61);
    client.tick_timeout(&sid, &player1);
}

#[test]
fn resolve_timeout_rejected_for_non_player() {
    let (env, client, _hub, player1, player2) = setup_test();
    let outsider = Address::generate(&env);
    let sid = 62u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let commit1 = compute_nizk_commitment(&env, &seed_hash1, &blinding1, &player1);
    client.commit_seed(&sid, &player1, &commit1);

    // Advance past ledger deadline
    advance_ledger(&env, 130);

    // Non-player cannot resolve timeout
    let result = client.try_resolve_timeout(&sid, &outsider);
    assert_cangkulan_error(&result, CangkulanError::NotAPlayer);

    // Player can resolve
    client.resolve_timeout(&sid, &player1);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Privacy (get_game / get_game_view)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn get_game_redacts_hands_during_active_play() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 69u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    // get_game_debug (admin) still returns full state
    let full = client.get_game_debug(&sid);
    assert_eq!(full.hand1.len(), 5);
    assert_eq!(full.hand2.len(), 5);
    assert!(full.draw_pile.len() > 0);

    // get_game (public) redacts hands and draw pile during active game
    let redacted = client.get_game(&sid);
    assert_eq!(redacted.hand1.len(), 0, "get_game should redact hand1 during PLAYING");
    assert_eq!(redacted.hand2.len(), 0, "get_game should redact hand2 during PLAYING");
    assert_eq!(redacted.draw_pile.len(), 0, "get_game should redact draw_pile during PLAYING");
    // But metadata is still visible
    assert_eq!(redacted.lifecycle_state, STATE_PLAYING);
    assert_eq!(redacted.player1, player1);
    assert_eq!(redacted.player2, player2);
}

#[test]
fn get_game_shows_hands_after_finished() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 69_1u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    // Play out until the game finishes
    loop {
        let game = client.get_game_debug(&sid);
        if game.lifecycle_state == STATE_FINISHED { break; }
        play_one_trick(&env, &client, &player1, &player2, sid);
    }

    // get_game should show full state for finished games
    let finished_game = client.get_game(&sid);
    assert_eq!(finished_game.lifecycle_state, STATE_FINISHED);
    // Finished games reveal everything (hands may be empty if all cards played)
}

#[test]
fn get_game_view_redacts_opponent_hand() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 70u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let full = client.get_game_debug(&sid);
    assert_eq!(full.hand1.len(), 5);
    assert_eq!(full.hand2.len(), 5);

    let p1_view = client.get_game_view(&sid, &player1);
    assert_eq!(p1_view.hand1.len(), 5);
    assert_eq!(p1_view.hand2.len(), 0);

    let p2_view = client.get_game_view(&sid, &player2);
    assert_eq!(p2_view.hand1.len(), 0);
    assert_eq!(p2_view.hand2.len(), 5);

    let outsider = Address::generate(&env);
    let outsider_view = client.get_game_view(&sid, &outsider);
    assert_eq!(outsider_view.hand1.len(), 0);
    assert_eq!(outsider_view.hand2.len(), 0);
}

#[test]
fn get_game_view_redacts_trick_card_during_reveal() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 71u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();

    let salt1 = test_salt(&env, 0x11);
    let salt2 = test_salt(&env, 0x22);
    let p1_action = first_card_of_suit(&game.hand1, trick_suit).unwrap_or(CANNOT_FOLLOW_SENTINEL);
    let p2_action = first_card_of_suit(&game.hand2, trick_suit).unwrap_or(CANNOT_FOLLOW_SENTINEL);

    // Both commit
    let commit1 = compute_play_commit(&env, p1_action, &salt1);
    let commit2 = compute_play_commit(&env, p2_action, &salt2);
    client.commit_play(&sid, &player1, &commit1, &game.action_nonce);
    let g1 = client.get_game_debug(&sid);
    client.commit_play(&sid, &player2, &commit2, &g1.action_nonce);

    // P1 reveals — now in REVEAL_WAIT_P2
    client.reveal_play(&sid, &player1, &p1_action, &salt1);
    let g2 = client.get_game_debug(&sid);
    assert_eq!(g2.trick_state, TRICK_REVEAL_WAIT_P2);

    // P2 should NOT see P1's trick card yet (if P1 played a real card)
    if p1_action != CANNOT_FOLLOW_SENTINEL {
        let p2_view = client.get_game_view(&sid, &player2);
        assert!(p2_view.trick_card1.is_none(), "P2 should not see P1's card during reveal");
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Shuffle verification
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn verify_shuffle_returns_full_deck() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 72u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let deck = client.verify_shuffle(&sid);
    assert_eq!(deck.len(), 36);

    let mut seen = [false; 36];
    let mut i: u32 = 0;
    while i < deck.len() {
        let card = deck.get(i).unwrap();
        assert!(card < 36, "Card {} out of range", card);
        assert!(!seen[card as usize], "Duplicate card {}", card);
        seen[card as usize] = true;
        i += 1;
    }

    let game = client.get_game_debug(&sid);
    let mut j: u32 = 0;
    while j < 5 {
        assert_eq!(deck.get(j).unwrap(), game.hand1.get(j).unwrap());
        assert_eq!(deck.get(j + 5).unwrap(), game.hand2.get(j).unwrap());
        j += 1;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Edge-case trick resolution
// ════════════════════════════════════════════════════════════════════════════

/// Both follow suit → highest value wins
#[test]
fn both_follow_suit_highest_value_wins() {
    let (env, client, _hub, player1, player2) = setup_test();

    let mut sid = 80u32;
    loop {
        assert!(sid < 150, "Could not find both-follow setup in 70 sessions");
        client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
        advance_to_playing(&env, &client, sid, &player1, &player2);

        let game = client.get_game_debug(&sid);
        let suit = game.trick_suit.unwrap();
        if hand_has_suit(&game.hand1, suit) && hand_has_suit(&game.hand2, suit) {
            break;
        }
        sid += 1;
    }

    let before = client.get_game_debug(&sid);
    let t1_before = before.tricks_won1;
    let t2_before = before.tricks_won2;

    let (d1, d2, _ddp) = play_one_trick(&env, &client, &player1, &player2, sid);
    assert_eq!(d1, -1, "P1 should have played one card");
    assert_eq!(d2, -1, "P2 should have played one card");

    let after = client.get_game_debug(&sid);
    assert_eq!(
        after.tricks_won1 + after.tricks_won2,
        t1_before + t2_before + 1,
        "Exactly one trick should be awarded"
    );
}

/// One follows, other doesn't → follower wins, non-follower gets penalty card
#[test]
fn penalty_card_on_cangkul() {
    let (env, client, _hub, player1, player2) = setup_test();

    let mut sid = 200u32;
    let mut p1_has: bool;
    let mut p2_has: bool;
    loop {
        assert!(sid < 350, "Could not find one-follows setup in 150 sessions");
        client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
        advance_to_playing(&env, &client, sid, &player1, &player2);

        let game = client.get_game_debug(&sid);
        let suit = game.trick_suit.unwrap();
        p1_has = hand_has_suit(&game.hand1, suit);
        p2_has = hand_has_suit(&game.hand2, suit);
        if p1_has != p2_has {
            break;
        }
        sid += 1;
    }

    let before = client.get_game_debug(&sid);
    let (d1, d2, _ddp) = play_one_trick(&env, &client, &player1, &player2, sid);

    if p1_has && !p2_has {
        assert_eq!(d1, -1, "P1 played a card");
        assert_eq!(d2, 1, "P2 should have drawn a penalty card");
        let after = client.get_game_debug(&sid);
        assert_eq!(after.tricks_won1, before.tricks_won1 + 1);
        assert_eq!(after.tricks_won2, before.tricks_won2);
    } else {
        assert_eq!(d2, -1, "P2 played a card");
        assert_eq!(d1, 1, "P1 should have drawn a penalty card");
        let after = client.get_game_debug(&sid);
        assert_eq!(after.tricks_won2, before.tricks_won2 + 1);
        assert_eq!(after.tricks_won1, before.tricks_won1);
    }
}

/// Neither follows → waste trick
#[test]
fn waste_trick_neither_follows() {
    let (env, client, _hub, player1, player2) = setup_test();

    let mut sid = 400u32;
    loop {
        assert!(sid < 600, "Could not find waste trick setup in 200 sessions");
        client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
        advance_to_playing(&env, &client, sid, &player1, &player2);

        let game = client.get_game_debug(&sid);
        let suit = game.trick_suit.unwrap();
        if !hand_has_suit(&game.hand1, suit) && !hand_has_suit(&game.hand2, suit) {
            break;
        }
        sid += 1;
    }

    let before = client.get_game_debug(&sid);
    let (d1, d2, _ddp) = play_one_trick(&env, &client, &player1, &player2, sid);

    assert_eq!(d1, 0, "P1 hand should not change on waste trick");
    assert_eq!(d2, 0, "P2 hand should not change on waste trick");

    let after = client.get_game_debug(&sid);
    assert_eq!(after.tricks_won1, before.tricks_won1);
    assert_eq!(after.tricks_won2, before.tricks_won2);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Timeout during seed reveal
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn timeout_during_seed_reveal_p1_wins() {
    let (env, client, hub, player1, player2) = setup_test();
    let sid = 500u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let blinding2 = BytesN::<32>::from_array(&env, &[0xBBu8; 32]);
    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let seed_hash2 = compute_seed_hash(&env, &seed2);
    let commit1 = compute_nizk_commitment(&env, &seed_hash1, &blinding1, &player1);
    let commit2 = compute_nizk_commitment(&env, &seed_hash2, &blinding2, &player2);

    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    let proof1 = build_nizk_proof(&env, &blinding1);
    client.reveal_seed(&sid, &player1, &seed_hash1, &proof1);

    tick_timeout_twice(&env, &client, &sid, &player1);
    client.resolve_timeout(&sid, &player1);

    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_FINISHED);
    assert_eq!(game.outcome, OUTCOME_PLAYER1_WIN);
    assert_eq!(hub.get_end_count(), 1);
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Draw pile exhaustion finishes game
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn game_ends_when_draw_pile_exhausted() {
    let (env, client, hub, player1, player2) = setup_test();
    let sid = 600u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let mut iterations = 0u32;
    loop {
        let game = client.get_game_debug(&sid);
        if game.lifecycle_state == STATE_FINISHED {
            break;
        }
        assert!(iterations < 200, "Game did not finish after 200 iterations");
        iterations += 1;

        play_one_trick(&env, &client, &player1, &player2, sid);
    }

    let final_game = client.get_game_debug(&sid);
    assert_eq!(final_game.lifecycle_state, STATE_FINISHED);
    assert!(
        final_game.outcome == OUTCOME_PLAYER1_WIN
            || final_game.outcome == OUTCOME_PLAYER2_WIN
            || final_game.outcome == crate::OUTCOME_DRAW,
    );
    assert_eq!(hub.get_end_count(), 1);
    assert!(
        final_game.hand1.is_empty()
            || final_game.hand2.is_empty()
            || final_game.draw_pile.is_empty(),
        "Game should end by empty hand or empty draw pile"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Pedersen Mode (Mode 4)
// ════════════════════════════════════════════════════════════════════════════

fn build_pedersen_proof(env: &Env, seed_hash: &BytesN<32>) -> (BytesN<32>, Bytes) {
    let mut c_bytes = Bytes::new(env);
    let mut i = 0u32;
    while i < 96 {
        let byte_val = seed_hash.to_array()[(i % 32) as usize];
        c_bytes.push_back(byte_val);
        i += 1;
    }

    let commit_hash: BytesN<32> = env.crypto().keccak256(&c_bytes).into();

    let mut proof = c_bytes;
    let mut j = 0u32;
    while j < 96 {
        proof.push_back(0xAA);
        j += 1;
    }
    let mut k = 0u32;
    while k < 32 {
        proof.push_back(0xBB);
        k += 1;
    }

    assert_eq!(proof.len(), 224);
    (commit_hash, proof)
}

fn advance_to_playing_pedersen(
    env: &Env,
    client: &CangkulanContractClient,
    session_id: u32,
    player1: &Address,
    player2: &Address,
) -> (BytesN<32>, BytesN<32>) {
    let seed1 = BytesN::<32>::from_array(env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);

    let seed_hash1 = compute_seed_hash(env, &seed1);
    let seed_hash2 = compute_seed_hash(env, &seed2);

    let (commit1, proof1) = build_pedersen_proof(env, &seed_hash1);
    let (commit2, proof2) = build_pedersen_proof(env, &seed_hash2);

    client.commit_seed(&session_id, player1, &commit1);
    client.commit_seed(&session_id, player2, &commit2);

    client.reveal_seed(&session_id, player1, &seed_hash1, &proof1);
    client.reveal_seed(&session_id, player2, &seed_hash2, &proof2);

    (seed_hash1, seed_hash2)
}

#[test]
fn seed_commit_reveal_pedersen_flow() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 700u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    advance_to_playing_pedersen(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_PLAYING);
    assert_eq!(game.hand1.len(), 5);
    assert_eq!(game.hand2.len(), 5);
    assert!(game.seed_hash1.is_some());
    assert!(game.seed_hash2.is_some());
}

#[test]
fn pedersen_full_game_flow() {
    let (env, client, hub, player1, player2) = setup_test();
    let sid = 701u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    advance_to_playing_pedersen(&env, &client, sid, &player1, &player2);

    let mut iterations = 0u32;
    loop {
        let game = client.get_game_debug(&sid);
        if game.lifecycle_state == STATE_FINISHED {
            break;
        }
        assert!(iterations < 200, "Game did not finish after 200 iterations");
        iterations += 1;
        play_one_trick(&env, &client, &player1, &player2, sid);
    }

    let final_game = client.get_game_debug(&sid);
    assert_eq!(final_game.lifecycle_state, STATE_FINISHED);
    assert_eq!(hub.get_end_count(), 1);
}

// ════════════════════════════════════════════════════════════════════════════
//  Additional edge-case tests
// ════════════════════════════════════════════════════════════════════════════

/// Committing a card_id >= 36 (and not CANNOT_FOLLOW_SENTINEL) should fail
/// with InvalidCardId on reveal.
#[test]
fn invalid_card_id_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 900u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();

    // P1 commits an out-of-range card_id (50) — commit succeeds (hash-only)
    let bad_card_id = 50u32;
    let salt1 = test_salt(&env, 0xAA);
    let commit1 = compute_play_commit(&env, bad_card_id, &salt1);
    let nonce = game.action_nonce;
    client.commit_play(&sid, &player1, &commit1, &nonce);

    // P2 commits a valid action
    let p2_action = first_card_of_suit(&game.hand2, trick_suit).unwrap_or(CANNOT_FOLLOW_SENTINEL);
    let salt2 = test_salt(&env, 0xBB);
    let commit2 = compute_play_commit(&env, p2_action, &salt2);
    let game2 = client.get_game_debug(&sid);
    client.commit_play(&sid, &player2, &commit2, &game2.action_nonce);

    // P1 reveal should fail with InvalidCardId (error 29)
    let result = client.try_reveal_play(&sid, &player1, &bad_card_id, &salt1);
    assert!(result.is_err());
    assert_eq!(
        result.unwrap_err(),
        Ok(CangkulanError::InvalidCardId)
    );
}

/// A non-player should not be able to commit a play.
#[test]
fn non_player_commit_play_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 901u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let outsider = Address::generate(&env);
    let salt = test_salt(&env, 0xCC);
    let commit = compute_play_commit(&env, 0, &salt);

    let result = client.try_commit_play(&sid, &outsider, &commit, &game.action_nonce);
    assert!(result.is_err());
    assert_eq!(
        result.unwrap_err(),
        Ok(CangkulanError::NotAPlayer)
    );
}

/// A non-player should not be able to reveal a play.
#[test]
fn non_player_reveal_play_rejected() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 902u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let outsider = Address::generate(&env);
    let salt = test_salt(&env, 0xDD);

    let result = client.try_reveal_play(&sid, &outsider, &0u32, &salt);
    assert!(result.is_err());
    assert_eq!(
        result.unwrap_err(),
        Ok(CangkulanError::NotAPlayer)
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Persistent Game History
// ════════════════════════════════════════════════════════════════════════════

/// Empty history for a player with no games.
#[test]
fn history_empty_for_new_player() {
    let (env, client, _hub, player1, _player2) = setup_test();
    let history = client.get_player_history(&player1);
    assert_eq!(history.len(), 0);
}

/// After a full game, both players should have exactly one history entry
/// with correct, perspective-flipped outcomes.
#[test]
fn history_recorded_after_full_game() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 950u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    // Play until finished
    let mut iterations = 0u32;
    loop {
        let game = client.get_game_debug(&sid);
        if game.lifecycle_state == STATE_FINISHED { break; }
        assert!(iterations < 200, "Game did not finish after 200 iterations");
        iterations += 1;
        play_one_trick(&env, &client, &player1, &player2, sid);
    }

    let final_game = client.get_game_debug(&sid);

    // Both players should have 1 history entry
    let h1 = client.get_player_history(&player1);
    let h2 = client.get_player_history(&player2);
    assert_eq!(h1.len(), 1);
    assert_eq!(h2.len(), 1);

    let entry1 = h1.get(0).unwrap();
    let entry2 = h2.get(0).unwrap();

    // Session ID matches
    assert_eq!(entry1.session_id, sid);
    assert_eq!(entry2.session_id, sid);

    // Opponents are correct
    assert_eq!(entry1.opponent, player2);
    assert_eq!(entry2.opponent, player1);

    // Outcomes are perspective-flipped
    if final_game.outcome == OUTCOME_PLAYER1_WIN {
        assert_eq!(entry1.outcome, 1); // win
        assert_eq!(entry2.outcome, 2); // loss
    } else if final_game.outcome == OUTCOME_PLAYER2_WIN {
        assert_eq!(entry1.outcome, 2); // loss
        assert_eq!(entry2.outcome, 1); // win
    } else {
        // draw
        assert_eq!(entry1.outcome, 3);
        assert_eq!(entry2.outcome, 3);
    }

    // Tricks are flipped
    assert_eq!(entry1.tricks_won, final_game.tricks_won1);
    assert_eq!(entry1.tricks_lost, final_game.tricks_won2);
    assert_eq!(entry2.tricks_won, final_game.tricks_won2);
    assert_eq!(entry2.tricks_lost, final_game.tricks_won1);

    // Ledger recorded
    assert!(entry1.ledger > 0);
    assert_eq!(entry1.ledger, entry2.ledger);
}

/// History accumulates across multiple games.
#[test]
fn history_accumulates_across_games() {
    let (env, client, _hub, player1, player2) = setup_test();

    for i in 0..3u32 {
        let sid = 960 + i;
        client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
        advance_to_playing(&env, &client, sid, &player1, &player2);

        let mut iterations = 0u32;
        loop {
            let game = client.get_game_debug(&sid);
            if game.lifecycle_state == STATE_FINISHED { break; }
            assert!(iterations < 200, "Game did not finish after 200 iterations");
            iterations += 1;
            play_one_trick(&env, &client, &player1, &player2, sid);
        }
    }

    let h1 = client.get_player_history(&player1);
    assert_eq!(h1.len(), 3);
    // Entries in chronological order
    assert_eq!(h1.get(0).unwrap().session_id, 960);
    assert_eq!(h1.get(1).unwrap().session_id, 961);
    assert_eq!(h1.get(2).unwrap().session_id, 962);
}

/// History is recorded after a timeout win.
#[test]
fn history_recorded_after_timeout() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 970u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    // P1 commits seed, P2 doesn't → timeout
    let seed1 = BytesN::<32>::from_array(&env, &[1u8; 32]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let commit1 = compute_nizk_commitment(&env, &seed_hash1, &blinding1, &player1);
    client.commit_seed(&sid, &player1, &commit1);

    tick_timeout_twice(&env, &client, &sid, &player1);
    client.resolve_timeout(&sid, &player1);

    let h1 = client.get_player_history(&player1);
    let h2 = client.get_player_history(&player2);
    assert_eq!(h1.len(), 1);
    assert_eq!(h2.len(), 1);

    // P1 won by timeout
    assert_eq!(h1.get(0).unwrap().outcome, 1); // win
    assert_eq!(h2.get(0).unwrap().outcome, 2); // loss
}

// ════════════════════════════════════════════════════════════════════════════
//  ZK Card Play (commit_play_zk + reveal_play Pedersen opening)
// ════════════════════════════════════════════════════════════════════════════

/// Compute Pedersen commitment: C = card_id·G + blinding·H on BLS12-381.
/// Returns the commitment hash (keccak256(C_bytes)) and C point bytes for reveal.
fn compute_zk_play_commit(env: &Env, card_id: u32, blinding: &BytesN<32>) -> BytesN<32> {
    let bls = env.crypto().bls12_381();

    let g1_bytes: [u8; 96] = [
        0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
        0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
        0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
        0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
        0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
        0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
        0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
        0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
    ];
    let g = G1Affine::from_array(env, &g1_bytes);

    // Same H derivation as the contract
    let h_msg = Bytes::from_slice(env, b"PEDERSEN_H");
    let h_dst = Bytes::from_slice(env, b"SGS_CANGKULAN_V1");
    let h = bls.hash_to_g1(&h_msg, &h_dst);

    let mut card_fr_arr = [0u8; 32];
    card_fr_arr[28] = ((card_id >> 24) & 0xFF) as u8;
    card_fr_arr[29] = ((card_id >> 16) & 0xFF) as u8;
    card_fr_arr[30] = ((card_id >> 8) & 0xFF) as u8;
    card_fr_arr[31] = (card_id & 0xFF) as u8;
    let card_fr = Fr::from_bytes(BytesN::<32>::from_array(env, &card_fr_arr));
    let blinding_fr = Fr::from_bytes(blinding.clone());

    let card_g = bls.g1_mul(&g, &card_fr);
    let blind_h = bls.g1_mul(&h, &blinding_fr);
    let c = bls.g1_add(&card_g, &blind_h);
    let c_raw = c.to_bytes();
    env.crypto().keccak256(&Bytes::from_array(env, &c_raw.to_array())).into()
}

/// Helper: find which player has a card matching the trick suit and return
/// (zk_player, zk_player_addr, other_player_addr, zk_card, is_slot1).
/// Returns None if neither player has the trick suit.
fn find_zk_candidate<'a>(
    game: &crate::CangkulanGame,
    trick_suit: u32,
    player1: &Address,
    player2: &Address,
) -> Option<(Address, Address, u32, bool)> {
    if let Some(card) = first_card_of_suit(&game.hand1, trick_suit) {
        return Some((player1.clone(), player2.clone(), card, true));
    }
    if let Some(card) = first_card_of_suit(&game.hand2, trick_suit) {
        return Some((player2.clone(), player1.clone(), card, false));
    }
    None
}

/// Full ZK card play cycle: commit_play_zk → reveal_play with Pedersen opening.
#[test]
fn zk_play_commit_and_reveal() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 800u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();

    let (zk_player, other_player, zk_card, is_slot1) =
        find_zk_candidate(&game, trick_suit, &player1, &player2)
            .expect("At least one player must have a card of the trick suit");

    let blinding = BytesN::<32>::from_array(&env, &{ let mut a = [0u8; 32]; a[31] = 99; a });
    let commit_hash = compute_zk_play_commit(&env, zk_card, &blinding);
    let dummy_proof = Bytes::from_array(&env, &[0xFFu8; 160]);

    // ZK player commits first
    client.commit_play_zk(&sid, &zk_player, &commit_hash, &game.action_nonce, &dummy_proof);

    let game2 = client.get_game_debug(&sid);
    if is_slot1 {
        assert!(game2.zk_play1, "ZK flag should be set");
    } else {
        assert!(game2.zk_play2, "ZK flag should be set");
    }

    // Other player uses legacy commit
    let other_hand = if is_slot1 { &game2.hand2 } else { &game2.hand1 };
    let other_action = match first_card_of_suit(other_hand, trick_suit) {
        Some(c) => c,
        None => CANNOT_FOLLOW_SENTINEL,
    };
    let salt2 = test_salt(&env, 0x22);
    let commit2 = compute_play_commit(&env, other_action, &salt2);
    client.commit_play(&sid, &other_player, &commit2, &game2.action_nonce);

    // ZK player reveals with Pedersen opening
    client.reveal_play(&sid, &zk_player, &zk_card, &blinding);

    // Other player reveals with legacy opening
    client.reveal_play(&sid, &other_player, &other_action, &salt2);

    // Trick should be resolved
    let game4 = client.get_game_debug(&sid);
    assert!(
        game4.trick_state == TRICK_COMMIT_WAIT_BOTH || game4.lifecycle_state == STATE_FINISHED,
        "Trick should be resolved to next commit phase or game finished"
    );
}

/// ZK commit with wrong blinding on reveal should fail.
#[test]
fn zk_play_wrong_blinding_fails() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 801u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();

    let (zk_player, other_player, zk_card, is_slot1) =
        find_zk_candidate(&game, trick_suit, &player1, &player2)
            .expect("Need at least one player with trick suit");

    let blinding = BytesN::<32>::from_array(&env, &{ let mut a = [0u8; 32]; a[31] = 99; a });
    let commit_hash = compute_zk_play_commit(&env, zk_card, &blinding);
    let dummy_proof = Bytes::from_array(&env, &[0xFFu8; 160]);

    client.commit_play_zk(&sid, &zk_player, &commit_hash, &game.action_nonce, &dummy_proof);

    // Other player legacy commit
    let game2 = client.get_game_debug(&sid);
    let other_hand = if is_slot1 { &game2.hand2 } else { &game2.hand1 };
    let other_action = match first_card_of_suit(other_hand, trick_suit) {
        Some(c) => c,
        None => CANNOT_FOLLOW_SENTINEL,
    };
    let salt2 = test_salt(&env, 0x22);
    let commit2 = compute_play_commit(&env, other_action, &salt2);
    client.commit_play(&sid, &other_player, &commit2, &game2.action_nonce);

    // Reveal with WRONG blinding
    let wrong_blinding = BytesN::<32>::from_array(&env, &{ let mut a = [0u8; 32]; a[31] = 1; a });
    let result = client.try_reveal_play(&sid, &zk_player, &zk_card, &wrong_blinding);
    assert_cangkulan_error(&result, CangkulanError::ZkPlayOpeningMismatch);
}

/// ZK commit with empty proof should fail (mock verifier rejects empty).
#[test]
fn zk_play_empty_proof_fails() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 802u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();

    let (zk_player, _other_player, zk_card, _is_slot1) =
        find_zk_candidate(&game, trick_suit, &player1, &player2)
            .expect("Need at least one player with trick suit");

    let blinding = BytesN::<32>::from_array(&env, &{ let mut a = [0u8; 32]; a[31] = 42; a });
    let commit_hash = compute_zk_play_commit(&env, zk_card, &blinding);
    let empty_proof = Bytes::new(&env);

    let result = client.try_commit_play_zk(&sid, &zk_player, &commit_hash, &game.action_nonce, &empty_proof);
    assert_cangkulan_error(&result, CangkulanError::ZkPlayProofInvalid);
}

/// ZK commit fails when player has no cards of trick suit (ZkPlaySetEmpty).
#[test]
fn zk_play_no_matching_suit_fails() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 803u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();

    // Find a player who has NO cards of the trick suit
    let no_suit_player = if !hand_has_suit(&game.hand1, trick_suit) {
        Some(player1.clone())
    } else if !hand_has_suit(&game.hand2, trick_suit) {
        // P2 commits second, but we can test by having P1 commit first (legacy),
        // then P2 tries commit_play_zk.
        // Actually P2 can't commit first in TRICK_COMMIT_WAIT_BOTH state.
        // Both can commit in any order in WAIT_BOTH. Let's use P2.
        Some(player2.clone())
    } else {
        None
    };

    if no_suit_player.is_none() {
        // Both players have trick suit cards — can't trigger ZkPlaySetEmpty.
        // Test passes vacuously.
        return;
    }
    let no_suit_player = no_suit_player.unwrap();

    let card_id = 0u32; // arbitrary card
    let blinding = BytesN::<32>::from_array(&env, &{ let mut a = [0u8; 32]; a[31] = 50; a });
    let commit_hash = compute_zk_play_commit(&env, card_id, &blinding);
    let dummy_proof = Bytes::from_array(&env, &[0xFFu8; 160]);

    let result = client.try_commit_play_zk(
        &sid, &no_suit_player, &commit_hash, &game.action_nonce, &dummy_proof,
    );
    assert_cangkulan_error(&result, CangkulanError::ZkPlaySetEmpty);
}

/// Both players using ZK commit_play_zk in the same trick.
#[test]
fn zk_play_both_players_zk() {
    let (env, client, _hub, player1, player2) = setup_test();
    let sid = 804u32;
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    advance_to_playing(&env, &client, sid, &player1, &player2);

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();

    let p1_card = first_card_of_suit(&game.hand1, trick_suit);
    let p2_card = first_card_of_suit(&game.hand2, trick_suit);

    if p1_card.is_none() || p2_card.is_none() {
        // Can't test both-ZK if one player lacks trick suit cards — skip
        return;
    }
    let p1_card = p1_card.unwrap();
    let p2_card = p2_card.unwrap();

    let blinding1 = BytesN::<32>::from_array(&env, &{ let mut a = [0u8; 32]; a[31] = 11; a });
    let blinding2 = BytesN::<32>::from_array(&env, &{ let mut a = [0u8; 32]; a[31] = 22; a });

    let commit_hash1 = compute_zk_play_commit(&env, p1_card, &blinding1);
    let commit_hash2 = compute_zk_play_commit(&env, p2_card, &blinding2);

    let dummy_proof = Bytes::from_array(&env, &[0xFFu8; 160]);

    // Both commit using ZK
    client.commit_play_zk(&sid, &player1, &commit_hash1, &game.action_nonce, &dummy_proof);
    let game2 = client.get_game_debug(&sid);
    assert!(game2.zk_play1);
    client.commit_play_zk(&sid, &player2, &commit_hash2, &game2.action_nonce, &dummy_proof);

    let game3 = client.get_game_debug(&sid);
    assert!(game3.zk_play1);
    assert!(game3.zk_play2);
    assert_eq!(game3.trick_state, TRICK_REVEAL_WAIT_BOTH);

    // Both reveal with Pedersen opening
    client.reveal_play(&sid, &player1, &p1_card, &blinding1);
    client.reveal_play(&sid, &player2, &p2_card, &blinding2);

    let game4 = client.get_game_debug(&sid);
    assert!(
        game4.trick_state == TRICK_COMMIT_WAIT_BOTH || game4.lifecycle_state == STATE_FINISHED,
        "Trick should be resolved"
    );
    // ZK flags should be reset after trick resolution
    assert!(!game4.zk_play1, "ZK flag should be reset after trick");
    assert!(!game4.zk_play2, "ZK flag should be reset after trick");
}

// ════════════════════════════════════════════════════════════════════════════
//  ZK Cangkul (Mode 8) tests
// ════════════════════════════════════════════════════════════════════════════

/// ZK cangkul commit succeeds when player has NO matching suit.
#[test]
fn zk_cangkul_commit_succeeds() {
    let (env, client, _hub, player1, player2) = setup_test();

    // Find a session where at least one player lacks trick suit cards
    let mut sid = 850u32;
    loop {
        assert!(sid < 1000, "Could not find no-suit setup in 150 sessions");
        client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
        advance_to_playing(&env, &client, sid, &player1, &player2);

        let game = client.get_game_debug(&sid);
        let suit = game.trick_suit.unwrap();
        if !hand_has_suit(&game.hand1, suit) || !hand_has_suit(&game.hand2, suit) {
            break;
        }
        sid += 1;
    }

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();

    // Find which player has no matching suit
    let (cangkul_player, other_player, is_slot1) = if !hand_has_suit(&game.hand1, trick_suit) {
        (player1.clone(), player2.clone(), true)
    } else {
        (player2.clone(), player1.clone(), false)
    };

    // 228-byte dummy proof (Mode 8: k(4) + A(96) + R(96) + z(32))
    let dummy_proof = Bytes::from_array(&env, &[0xFFu8; 228]);
    let commit_hash = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);

    client.commit_cangkul_zk(
        &sid, &cangkul_player, &commit_hash, &game.action_nonce, &dummy_proof,
    );

    let game2 = client.get_game_debug(&sid);
    if is_slot1 {
        assert!(game2.zk_play1, "ZK flag should be set for P1");
        assert_eq!(game2.play_commit1.unwrap(), commit_hash);
    } else {
        assert!(game2.zk_play2, "ZK flag should be set for P2");
        assert_eq!(game2.play_commit2.unwrap(), commit_hash);
    }
}

/// ZK cangkul commit fails when player HAS a matching suit card.
#[test]
fn zk_cangkul_has_matching_suit_fails() {
    let (env, client, _hub, player1, player2) = setup_test();

    let mut sid = 860u32;
    loop {
        assert!(sid < 1000, "Could not find setup in 140 sessions");
        client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
        advance_to_playing(&env, &client, sid, &player1, &player2);

        let game = client.get_game_debug(&sid);
        let suit = game.trick_suit.unwrap();
        // Need a player who HAS the trick suit
        if hand_has_suit(&game.hand1, suit) {
            break;
        }
        sid += 1;
    }

    let game = client.get_game_debug(&sid);
    let dummy_proof = Bytes::from_array(&env, &[0xFFu8; 228]);
    let commit_hash = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);

    let result = client.try_commit_cangkul_zk(
        &sid, &player1, &commit_hash, &game.action_nonce, &dummy_proof,
    );
    assert_cangkulan_error(&result, CangkulanError::HasMatchingSuit);
}

/// ZK cangkul commit with empty proof fails.
#[test]
fn zk_cangkul_empty_proof_fails() {
    let (env, client, _hub, player1, player2) = setup_test();

    let mut sid = 870u32;
    loop {
        assert!(sid < 1000, "Could not find no-suit setup");
        client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
        advance_to_playing(&env, &client, sid, &player1, &player2);

        let game = client.get_game_debug(&sid);
        let suit = game.trick_suit.unwrap();
        if !hand_has_suit(&game.hand1, suit) {
            break;
        }
        sid += 1;
    }

    let game = client.get_game_debug(&sid);
    let empty_proof = Bytes::new(&env);
    let commit_hash = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);

    let result = client.try_commit_cangkul_zk(
        &sid, &player1, &commit_hash, &game.action_nonce, &empty_proof,
    );
    assert_cangkulan_error(&result, CangkulanError::ZkCangkulProofInvalid);
}

/// Full ZK cangkul flow: commit_cangkul_zk → reveal_play with Pedersen opening.
#[test]
fn zk_cangkul_full_flow() {
    let (env, client, _hub, player1, player2) = setup_test();

    // Find session where one player has no matching suit
    let mut sid = 880u32;
    loop {
        assert!(sid < 1050, "Could not find one-follows setup");
        client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
        advance_to_playing(&env, &client, sid, &player1, &player2);

        let game = client.get_game_debug(&sid);
        let suit = game.trick_suit.unwrap();
        let p1_has = hand_has_suit(&game.hand1, suit);
        let p2_has = hand_has_suit(&game.hand2, suit);
        if p1_has != p2_has {
            break;
        }
        sid += 1;
    }

    let game = client.get_game_debug(&sid);
    let trick_suit = game.trick_suit.unwrap();
    let p1_has = hand_has_suit(&game.hand1, trick_suit);

    let (cangkul_player, follow_player, is_cangkul_p1) = if !p1_has {
        (player1.clone(), player2.clone(), true)
    } else {
        (player2.clone(), player1.clone(), false)
    };

    // ZK cangkul commit for the player without matching suit
    // For aggregate opening: commit_hash = keccak256(pedersen_commit(card_sum, r_agg))
    let cangkul_hand = if is_cangkul_p1 { &game.hand1 } else { &game.hand2 };
    let card_sum: u32 = cangkul_hand.iter().sum();
    let dummy_proof = Bytes::from_array(&env, &[0xFFu8; 228]);
    let r_agg = BytesN::<32>::from_array(&env, &{ let mut a = [0u8; 32]; a[31] = 77; a });
    let commit_hash = compute_zk_play_commit(&env, card_sum, &r_agg);
    client.commit_cangkul_zk(
        &sid, &cangkul_player, &commit_hash, &game.action_nonce, &dummy_proof,
    );

    // Follow player uses legacy commit
    let game2 = client.get_game_debug(&sid);
    let follow_hand = if is_cangkul_p1 { &game2.hand2 } else { &game2.hand1 };
    let follow_card = first_card_of_suit(follow_hand, trick_suit).unwrap();
    let salt2 = test_salt(&env, 0x33);
    let commit2 = compute_play_commit(&env, follow_card, &salt2);
    client.commit_play(&sid, &follow_player, &commit2, &game2.action_nonce);

    // Reveal: cangkul player reveals CANNOT_FOLLOW with r_agg as salt
    // Contract does aggregate opening: pedersen_commit(Σhand, r_agg)
    client.reveal_play(&sid, &cangkul_player, &CANNOT_FOLLOW_SENTINEL, &r_agg);

    // Follow player reveals normally
    client.reveal_play(&sid, &follow_player, &follow_card, &salt2);

    // Trick should be resolved
    let game4 = client.get_game_debug(&sid);
    assert!(
        game4.trick_state == TRICK_COMMIT_WAIT_BOTH || game4.lifecycle_state == STATE_FINISHED,
        "Trick should resolve"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  Integration Tests: Real ZK Verifier ↔ Cangkulan Contract
// ════════════════════════════════════════════════════════════════════════════
//
// These tests register the REAL ZkCommitmentVerifier instead of MockZkVerifier
// and generate cryptographically valid proofs, verifying the full commit →
// reveal → verify pipeline end-to-end.

use zk_verifier::ZkCommitmentVerifier;

/// NIZK challenge tag: "ZKV2" (must match zk-verifier constant)
const ZK_CHALLENGE_TAG: [u8; 4] = [0x5A, 0x4B, 0x56, 0x32];
/// Pedersen challenge tag: "ZKP4" (must match zk-verifier constant)
const ZK_PEDERSEN_CHALLENGE_TAG: [u8; 4] = [0x5A, 0x4B, 0x50, 0x34];

/// Setup with the REAL ZkCommitmentVerifier contract instead of mock.
fn setup_test_real_verifier() -> (
    Env,
    CangkulanContractClient<'static>,
    MockGameHubClient<'static>,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1_700_000_000,
        protocol_version: 25,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    let hub_addr = env.register(MockGameHub, ());
    let hub_client = MockGameHubClient::new(&env, &hub_addr);

    // Register the REAL ZK verifier instead of MockZkVerifier
    let verifier_addr = env.register(ZkCommitmentVerifier, ());

    let admin = Address::generate(&env);
    let contract_id = env.register(CangkulanContract, (&admin, &hub_addr, &verifier_addr));
    let client = CangkulanContractClient::new(&env, &contract_id);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    (env, client, hub_client, player1, player2)
}

/// Generate a valid 64-byte NIZK proof that the real ZK verifier will accept.
///
/// Returns (proof, commit_hash) where:
/// - proof = blinding(32) || response(32)
/// - commit_hash = the commitment to submit during commit_seed
fn generate_real_nizk_proof(
    env: &Env,
    seed_hash: &BytesN<32>,
    blinding: &BytesN<32>,
    session_id: u32,
    player: &Address,
) -> (Bytes, BytesN<32>) {
    // Step 1: Compute commitment = keccak256(seed_hash || blinding || player)
    let commitment = compute_nizk_commitment(env, seed_hash, blinding, player);

    // Step 2: Compute Fiat-Shamir challenge = keccak256(commitment || session_id || player || "ZKV2")
    let mut challenge_pre = Bytes::from_array(env, &commitment.to_array());
    challenge_pre.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
    challenge_pre.append(&player.to_string().to_bytes());
    challenge_pre.append(&Bytes::from_array(env, &ZK_CHALLENGE_TAG));
    let challenge: BytesN<32> = env.crypto().keccak256(&challenge_pre).into();

    // Step 3: Compute response = keccak256(seed_hash || challenge || blinding)
    let mut resp_pre = Bytes::from_array(env, &seed_hash.to_array());
    resp_pre.append(&Bytes::from_array(env, &challenge.to_array()));
    resp_pre.append(&Bytes::from_array(env, &blinding.to_array()));
    let response: BytesN<32> = env.crypto().keccak256(&resp_pre).into();

    // Build proof = blinding(32) || response(32)
    let mut proof = Bytes::from_array(env, &blinding.to_array());
    proof.append(&Bytes::from_array(env, &response.to_array()));

    (proof, commitment)
}

/// Generate a valid 224-byte Pedersen+Sigma proof (BLS12-381).
///
/// Returns (proof_224, commit_hash) where:
/// - proof_224 = C(96) || R(96) || z_r(32)
/// - commit_hash = keccak256(C)
fn generate_real_pedersen_proof(
    env: &Env,
    seed_hash: &BytesN<32>,
    blinding_scalar: &Fr,
    nonce_r: &Fr,
    session_id: u32,
    player: &Address,
) -> (Bytes, BytesN<32>) {
    let bls = env.crypto().bls12_381();

    // BLS12-381 G1 generator
    let g1_bytes: [u8; 96] = [
        0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
        0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
        0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
        0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
        0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
        0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
        0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
        0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
    ];
    let g = G1Affine::from_array(env, &g1_bytes);

    // Pedersen H generator (hash_to_g1)
    let msg = Bytes::from_slice(env, b"PEDERSEN_H");
    let dst = Bytes::from_slice(env, b"SGS_CANGKULAN_V1");
    let h = bls.hash_to_g1(&msg, &dst);

    // seed_scalar = Fr from seed_hash bytes
    let seed_scalar = Fr::from_bytes(seed_hash.clone());

    // Commitment: C = seed_scalar·G + blinding_scalar·H
    let commitment = bls.g1_msm(
        vec![env, g.clone(), h.clone()],
        vec![env, seed_scalar.clone(), blinding_scalar.clone()],
    );
    let c_bytes = commitment.to_bytes();

    // commit_hash = keccak256(C)
    let commit_hash: BytesN<32> = env.crypto().keccak256(
        &Bytes::from_array(env, &c_bytes.to_array()),
    ).into();

    // Nonce commitment: R = nonce_r·H
    let r_point = bls.g1_mul(&h, nonce_r);
    let r_bytes = r_point.to_bytes();

    // Fiat-Shamir challenge: e = keccak256(C || R || seed_hash || session_id || player || "ZKP4")
    let seed_hash_fr_bytes = seed_scalar.to_bytes();
    let mut challenge_pre = Bytes::from_array(env, &c_bytes.to_array());
    challenge_pre.append(&Bytes::from_array(env, &r_bytes.to_array()));
    challenge_pre.append(&Bytes::from_array(env, &seed_hash_fr_bytes.to_array()));
    challenge_pre.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
    challenge_pre.append(&player.to_string().to_bytes());
    challenge_pre.append(&Bytes::from_array(env, &ZK_PEDERSEN_CHALLENGE_TAG));
    let e_hash: BytesN<32> = env.crypto().keccak256(&challenge_pre).into();
    let e = Fr::from_bytes(e_hash);

    // Response: z_r = nonce_r + e·blinding
    let z_r = bls.fr_add(nonce_r, &bls.fr_mul(&e, blinding_scalar));

    // Build 224-byte proof: C(96) || R(96) || z_r(32)
    let mut proof = Bytes::from_array(env, &c_bytes.to_array());
    proof.append(&Bytes::from_array(env, &r_bytes.to_array()));
    proof.append(&Bytes::from_array(env, &z_r.to_bytes().to_array()));

    (proof, commit_hash)
}

// ────────────────────────────────────────────────────────────────────────────
//  NIZK Integration Tests
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_integration_nizk_seed_commit_reveal() {
    let (env, client, _hub, player1, player2) = setup_test_real_verifier();
    let sid = 1u32;

    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    // Generate seeds with sufficient entropy (>= 4 distinct bytes in keccak hash)
    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let blinding2 = BytesN::<32>::from_array(&env, &[0xBBu8; 32]);

    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let seed_hash2 = compute_seed_hash(&env, &seed2);

    // Generate real NIZK proofs (not mock!)
    let (proof1, commit1) = generate_real_nizk_proof(&env, &seed_hash1, &blinding1, sid, &player1);
    let (proof2, commit2) = generate_real_nizk_proof(&env, &seed_hash2, &blinding2, sid, &player2);

    // Commit phase
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Reveal phase — proofs go through real ZK verifier
    client.reveal_seed(&sid, &player1, &seed_hash1, &proof1);
    client.reveal_seed(&sid, &player2, &seed_hash2, &proof2);

    // Should be in PLAYING state now
    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_PLAYING);
    assert!(game.hand1.len() > 0, "Player 1 should have cards");
    assert!(game.hand2.len() > 0, "Player 2 should have cards");
}

#[test]
fn test_integration_nizk_wrong_blinding_rejected() {
    let (env, client, _hub, player1, player2) = setup_test_real_verifier();
    let sid = 1u32;

    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let blinding2 = BytesN::<32>::from_array(&env, &[0xBBu8; 32]);
    let wrong_blinding = BytesN::<32>::from_array(&env, &[0xCCu8; 32]);

    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let seed_hash2 = compute_seed_hash(&env, &seed2);

    // Player 1: valid proof
    let (proof1, commit1) = generate_real_nizk_proof(&env, &seed_hash1, &blinding1, sid, &player1);
    // Player 2: build commitment with correct blinding, but proof with wrong blinding
    let (_proof2_valid, commit2) = generate_real_nizk_proof(&env, &seed_hash2, &blinding2, sid, &player2);

    // Commit
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Player 1 reveal succeeds
    client.reveal_seed(&sid, &player1, &seed_hash1, &proof1);

    // Player 2: forge proof with wrong blinding (commitment mismatch)
    let (forged_proof, _) = generate_real_nizk_proof(&env, &seed_hash2, &wrong_blinding, sid, &player2);
    let result = client.try_reveal_seed(&sid, &player2, &seed_hash2, &forged_proof);
    assert!(result.is_err(), "Reveal with wrong blinding should fail");
}

#[test]
fn test_integration_nizk_wrong_seed_hash_rejected() {
    let (env, client, _hub, player1, player2) = setup_test_real_verifier();
    let sid = 1u32;

    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let blinding2 = BytesN::<32>::from_array(&env, &[0xBBu8; 32]);

    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let seed_hash2 = compute_seed_hash(&env, &seed2);

    // Both generate valid proofs
    let (proof1, commit1) = generate_real_nizk_proof(&env, &seed_hash1, &blinding1, sid, &player1);
    let (_proof2, commit2) = generate_real_nizk_proof(&env, &seed_hash2, &blinding2, sid, &player2);

    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Player 1 reveals normally
    client.reveal_seed(&sid, &player1, &seed_hash1, &proof1);

    // Player 2 tries to reveal with a different seed_hash
    let fake_seed = BytesN::<32>::from_array(&env, &[0xFFu8; 32]);
    let fake_seed_hash = compute_seed_hash(&env, &fake_seed);
    let (fake_proof, _) = generate_real_nizk_proof(&env, &fake_seed_hash, &blinding2, sid, &player2);
    let result = client.try_reveal_seed(&sid, &player2, &fake_seed_hash, &fake_proof);
    // The commitment stored was for the original seed, so this should fail
    assert!(result.is_err(), "Reveal with different seed_hash should fail");
}

// ────────────────────────────────────────────────────────────────────────────
//  Pedersen+Sigma Integration Tests
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_integration_pedersen_seed_commit_reveal() {
    let (env, client, _hub, player1, player2) = setup_test_real_verifier();
    let sid = 1u32;

    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);

    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let seed_hash2 = compute_seed_hash(&env, &seed2);

    // BLS12-381 Fr scalars for Pedersen commitments
    let blinding1 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0xCA, 0xFE, 0xBA, 0xBE,
    ]));
    let blinding2 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0xDE, 0xAD, 0xBE, 0xEF,
    ]));
    let nonce1 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x05, 0x06, 0x07, 0x08,
    ]));
    let nonce2 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x09, 0x0A, 0x0B, 0x0C,
    ]));

    // Generate real Pedersen proofs
    let (proof1, commit1) = generate_real_pedersen_proof(
        &env, &seed_hash1, &blinding1, &nonce1, sid, &player1,
    );
    let (proof2, commit2) = generate_real_pedersen_proof(
        &env, &seed_hash2, &blinding2, &nonce2, sid, &player2,
    );

    assert_eq!(proof1.len(), 224, "Pedersen proof should be 224 bytes");
    assert_eq!(proof2.len(), 224, "Pedersen proof should be 224 bytes");

    // Commit phase
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Reveal phase — real BLS12-381 ZK verification
    client.reveal_seed(&sid, &player1, &seed_hash1, &proof1);
    client.reveal_seed(&sid, &player2, &seed_hash2, &proof2);

    // Should proceed to PLAYING state
    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_PLAYING);
    assert!(game.hand1.len() > 0, "Player 1 should have cards dealt");
    assert!(game.hand2.len() > 0, "Player 2 should have cards dealt");
}

#[test]
fn test_integration_pedersen_tampered_sigma_rejected() {
    let (env, client, _hub, player1, player2) = setup_test_real_verifier();
    let sid = 1u32;

    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);

    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let seed_hash2 = compute_seed_hash(&env, &seed2);

    let blinding1 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0xCA, 0xFE, 0xBA, 0xBE,
    ]));
    let blinding2 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0xDE, 0xAD, 0xBE, 0xEF,
    ]));
    let nonce1 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x05, 0x06, 0x07, 0x08,
    ]));
    let nonce2 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x09, 0x0A, 0x0B, 0x0C,
    ]));

    // Generate valid proofs
    let (proof1, commit1) = generate_real_pedersen_proof(
        &env, &seed_hash1, &blinding1, &nonce1, sid, &player1,
    );
    let (proof2, commit2) = generate_real_pedersen_proof(
        &env, &seed_hash2, &blinding2, &nonce2, sid, &player2,
    );

    // Commit both seeds
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Player 1 reveals OK
    client.reveal_seed(&sid, &player1, &seed_hash1, &proof1);

    // Tamper with player 2's proof: corrupt z_r (last 32 bytes)
    let mut tampered_proof = Bytes::new(&env);
    let mut i = 0u32;
    while i < 192 {
        tampered_proof.push_back(proof2.get(i).unwrap_or(0));
        i += 1;
    }
    // Append garbage z_r
    tampered_proof.append(&Bytes::from_array(&env, &[0x42u8; 32]));

    let result = client.try_reveal_seed(&sid, &player2, &seed_hash2, &tampered_proof);
    assert!(result.is_err(), "Tampered Pedersen sigma proof should be rejected");
}

// ────────────────────────────────────────────────────────────────────────────
//  Mixed Mode Integration Test
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_integration_mixed_modes_nizk_and_pedersen() {
    let (env, client, _hub, player1, player2) = setup_test_real_verifier();
    let sid = 1u32;

    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);

    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let seed_hash2 = compute_seed_hash(&env, &seed2);

    // Player 1: NIZK mode (64-byte proof)
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let (proof1, commit1) = generate_real_nizk_proof(&env, &seed_hash1, &blinding1, sid, &player1);
    assert_eq!(proof1.len(), 64);

    // Player 2: Pedersen mode (224-byte proof)
    let blinding2 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0xDE, 0xAD, 0xBE, 0xEF,
    ]));
    let nonce2 = Fr::from_bytes(BytesN::<32>::from_array(&env, &[
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x09, 0x0A, 0x0B, 0x0C,
    ]));
    let (proof2, commit2) = generate_real_pedersen_proof(
        &env, &seed_hash2, &blinding2, &nonce2, sid, &player2,
    );
    assert_eq!(proof2.len(), 224);

    // Commit both (different modes doesn't matter for commit)
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Reveal — each uses their respective ZK mode
    client.reveal_seed(&sid, &player1, &seed_hash1, &proof1);
    client.reveal_seed(&sid, &player2, &seed_hash2, &proof2);

    // Should reach PLAYING state with both modes verified
    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_PLAYING);
}

// ────────────────────────────────────────────────────────────────────────────
//  Full Game Flow Integration Test
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_integration_full_game_with_real_verifier() {
    let (env, client, hub, player1, player2) = setup_test_real_verifier();
    let sid = 1u32;

    // Start game
    client.start_game(&sid, &player1, &player2, &100_0000000, &100_0000000);
    assert_eq!(hub.get_start_count(), 1);

    let seed1 = BytesN::<32>::from_array(&env, &[
        1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let blinding1 = BytesN::<32>::from_array(&env, &[0xAAu8; 32]);
    let blinding2 = BytesN::<32>::from_array(&env, &[0xBBu8; 32]);

    let seed_hash1 = compute_seed_hash(&env, &seed1);
    let seed_hash2 = compute_seed_hash(&env, &seed2);

    // Real NIZK proofs
    let (proof1, commit1) = generate_real_nizk_proof(&env, &seed_hash1, &blinding1, sid, &player1);
    let (proof2, commit2) = generate_real_nizk_proof(&env, &seed_hash2, &blinding2, sid, &player2);

    // Commit → Reveal with real ZK verification
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);
    client.reveal_seed(&sid, &player1, &seed_hash1, &proof1);
    client.reveal_seed(&sid, &player2, &seed_hash2, &proof2);

    // Game is now in PLAYING state
    let game = client.get_game_debug(&sid);
    assert_eq!(game.lifecycle_state, STATE_PLAYING);

    // Play a few tricks using the standard commit-reveal card protocol
    let mut current_state = game.lifecycle_state;
    let mut tricks_played = 0u32;

    while current_state == STATE_PLAYING && tricks_played < 5 {
        let g = client.get_game_debug(&sid);
        let trick_suit = match g.trick_suit {
            Some(s) => s,
            None => break,
        };
        let nonce = g.action_nonce;

        let salt1 = test_salt(&env, (tricks_played * 2 + 1) as u8);
        let salt2 = test_salt(&env, (tricks_played * 2 + 2) as u8);

        // Determine actions
        let p1_action = match first_card_of_suit(&g.hand1, trick_suit) {
            Some(c) => c,
            None => CANNOT_FOLLOW_SENTINEL,
        };
        let p2_action = match first_card_of_suit(&g.hand2, trick_suit) {
            Some(c) => c,
            None => CANNOT_FOLLOW_SENTINEL,
        };

        // Commit
        let c1 = compute_play_commit(&env, p1_action, &salt1);
        client.commit_play(&sid, &player1, &c1, &nonce);

        let mid = client.get_game_debug(&sid);
        let c2 = compute_play_commit(&env, p2_action, &salt2);
        client.commit_play(&sid, &player2, &c2, &mid.action_nonce);

        // Reveal
        client.reveal_play(&sid, &player1, &p1_action, &salt1);
        client.reveal_play(&sid, &player2, &p2_action, &salt2);

        tricks_played += 1;
        current_state = client.get_game_debug(&sid).lifecycle_state;
    }

    assert!(tricks_played > 0, "Should have played at least one trick");
}

// ════════════════════════════════════════════════════════════════════════════
//  Mock UltraHonk Verifier (accepts any proof for testing)
// ════════════════════════════════════════════════════════════════════════════

#[contract]
pub struct MockUltraHonk;

#[contractimpl]
impl MockUltraHonk {
    /// Accepts any proof — panics only if proof is empty.
    pub fn verify_proof(_env: Env, _public_inputs: Bytes, proof_bytes: Bytes) {
        if proof_bytes.len() == 0 {
            panic!("empty proof");
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Tests: Split Noir Verification (verify_noir_seed → reveal_seed)
// ════════════════════════════════════════════════════════════════════════════

/// Helper: setup with UltraHonk verifier linked.
fn setup_test_with_ultrahonk() -> (
    Env,
    CangkulanContractClient<'static>,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: 1_700_000_000,
        protocol_version: 25,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: u32::MAX / 2,
        min_persistent_entry_ttl: u32::MAX / 2,
        max_entry_ttl: u32::MAX / 2,
    });

    let hub_addr = env.register(MockGameHub, ());
    let verifier_addr = env.register(MockZkVerifier, ());
    let ultrahonk_addr = env.register(MockUltraHonk, ());

    let admin = Address::generate(&env);
    let contract_id = env.register(CangkulanContract, (&admin, &hub_addr, &verifier_addr));
    let client = CangkulanContractClient::new(&env, &contract_id);

    // Link UltraHonk verifier
    client.set_ultrahonk_verifier(&ultrahonk_addr);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    (env, client, player1, player2)
}

/// Compute Noir commit_hash = keccak256(seed_hash) where seed_hash = blake2s(seed).
/// In this test, since we don't have blake2s, we use a fixed seed_hash
/// and compute keccak256(seed_hash) as commit_hash.
fn compute_noir_commit_hash(env: &Env, seed_hash: &BytesN<32>) -> BytesN<32> {
    env.crypto().keccak256(&Bytes::from_array(env, &seed_hash.to_array())).into()
}

/// Build a big fake Noir proof (>4000 bytes). In tests, the MockUltraHonk accepts it.
fn build_fake_noir_proof(env: &Env) -> Bytes {
    let mut proof = Bytes::new(env);
    // 5000 bytes of dummy data
    let mut i = 0u32;
    while i < 5000 {
        proof.push_back(0xAB);
        i += 1;
    }
    proof
}

#[test]
fn test_verify_noir_seed_split_flow() {
    let (env, client, player1, player2) = setup_test_with_ultrahonk();
    let sid = 900u32;

    // Use seed hashes with enough entropy (≥4 distinct bytes)
    let seed_hash1 = BytesN::<32>::from_array(&env, &[
        10,20,30,40,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed_hash2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);

    let commit1 = compute_noir_commit_hash(&env, &seed_hash1);
    let commit2 = compute_noir_commit_hash(&env, &seed_hash2);

    // Start game
    client.start_game(&sid, &player1, &player2, &100, &100);

    // Commit seeds (Noir style: commit_hash = keccak256(seed_hash))
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    assert_eq!(client.get_game_debug(&sid).lifecycle_state, STATE_SEED_REVEAL);

    // TX 1: verify_noir_seed for P1
    let noir_proof = build_fake_noir_proof(&env);
    client.verify_noir_seed(&sid, &player1, &seed_hash1, &noir_proof);

    // TX 2: reveal_seed with empty proof for P1 (uses pre-verified flag)
    let empty_proof = Bytes::new(&env);
    client.reveal_seed(&sid, &player1, &seed_hash1, &empty_proof);

    // P1 revealed, P2 still pending
    let game = client.get_game_debug(&sid);
    assert!(game.seed_revealed1);
    assert!(!game.seed_revealed2);
    assert_eq!(game.lifecycle_state, STATE_SEED_REVEAL);

    // TX 1: verify_noir_seed for P2
    client.verify_noir_seed(&sid, &player2, &seed_hash2, &noir_proof);

    // TX 2: reveal_seed with empty proof for P2
    client.reveal_seed(&sid, &player2, &seed_hash2, &empty_proof);

    // Both revealed → should be PLAYING
    let game = client.get_game_debug(&sid);
    assert!(game.seed_revealed1);
    assert!(game.seed_revealed2);
    assert_eq!(game.lifecycle_state, STATE_PLAYING);
    assert!(game.hand1.len() > 0, "P1 should have cards dealt");
    assert!(game.hand2.len() > 0, "P2 should have cards dealt");
}

#[test]
fn test_verify_noir_seed_replay_prevented() {
    let (env, client, player1, player2) = setup_test_with_ultrahonk();
    let sid = 901u32;

    let seed_hash1 = BytesN::<32>::from_array(&env, &[
        10,20,30,40,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed_hash2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);

    let commit1 = compute_noir_commit_hash(&env, &seed_hash1);
    let commit2 = compute_noir_commit_hash(&env, &seed_hash2);

    client.start_game(&sid, &player1, &player2, &100, &100);
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Verify + reveal P1
    let noir_proof = build_fake_noir_proof(&env);
    client.verify_noir_seed(&sid, &player1, &seed_hash1, &noir_proof);
    let empty_proof = Bytes::new(&env);
    client.reveal_seed(&sid, &player1, &seed_hash1, &empty_proof);

    // Trying reveal_seed again with empty proof should fail (flag consumed + already revealed)
    let result = client.try_reveal_seed(&sid, &player1, &seed_hash1, &empty_proof);
    assert!(result.is_err(), "Should not allow double reveal");
}

#[test]
fn test_verify_noir_seed_wrong_hash_rejected() {
    let (env, client, player1, player2) = setup_test_with_ultrahonk();
    let sid = 902u32;

    let seed_hash1 = BytesN::<32>::from_array(&env, &[
        10,20,30,40,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed_hash2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let wrong_hash = BytesN::<32>::from_array(&env, &[
        99,98,97,96,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);

    let commit1 = compute_noir_commit_hash(&env, &seed_hash1);
    let commit2 = compute_noir_commit_hash(&env, &seed_hash2);

    client.start_game(&sid, &player1, &player2, &100, &100);
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Verify with correct hash
    let noir_proof = build_fake_noir_proof(&env);
    client.verify_noir_seed(&sid, &player1, &seed_hash1, &noir_proof);

    // Try reveal with WRONG hash — should fail (mismatch with stored flag)
    let empty_proof = Bytes::new(&env);
    let result = client.try_reveal_seed(&sid, &player1, &wrong_hash, &empty_proof);
    assert!(result.is_err(), "Should reject reveal with wrong seed_hash");
}

#[test]
fn test_verify_noir_seed_without_verify_rejected() {
    let (env, client, player1, player2) = setup_test_with_ultrahonk();
    let sid = 903u32;

    let seed_hash1 = BytesN::<32>::from_array(&env, &[
        10,20,30,40,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed_hash2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);

    let commit1 = compute_noir_commit_hash(&env, &seed_hash1);
    let commit2 = compute_noir_commit_hash(&env, &seed_hash2);

    client.start_game(&sid, &player1, &player2, &100, &100);
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Try reveal with empty proof WITHOUT calling verify_noir_seed first — should fail
    let empty_proof = Bytes::new(&env);
    let result = client.try_reveal_seed(&sid, &player1, &seed_hash1, &empty_proof);
    assert!(result.is_err(), "Should reject reveal without prior verify_noir_seed");
}

#[test]
fn test_verify_noir_commit_mismatch_rejected() {
    let (env, client, player1, player2) = setup_test_with_ultrahonk();
    let sid = 904u32;

    let seed_hash1 = BytesN::<32>::from_array(&env, &[
        10,20,30,40,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed_hash2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);
    let wrong_hash = BytesN::<32>::from_array(&env, &[
        99,98,97,96,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);

    let commit1 = compute_noir_commit_hash(&env, &seed_hash1);
    let commit2 = compute_noir_commit_hash(&env, &seed_hash2);

    client.start_game(&sid, &player1, &player2, &100, &100);
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Try verify_noir_seed with WRONG hash — commit binding should fail
    let noir_proof = build_fake_noir_proof(&env);
    let result = client.try_verify_noir_seed(&sid, &player1, &wrong_hash, &noir_proof);
    assert_cangkulan_error(&result, CangkulanError::CommitHashMismatch);
}

#[test]
fn test_verify_noir_small_proof_rejected() {
    let (env, client, player1, player2) = setup_test_with_ultrahonk();
    let sid = 905u32;

    let seed_hash1 = BytesN::<32>::from_array(&env, &[
        10,20,30,40,5,6,7,8,9,10,11,12,13,14,15,16,
        17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    ]);
    let seed_hash2 = BytesN::<32>::from_array(&env, &[
        32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,
        16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,
    ]);

    let commit1 = compute_noir_commit_hash(&env, &seed_hash1);
    let commit2 = compute_noir_commit_hash(&env, &seed_hash2);

    client.start_game(&sid, &player1, &player2, &100, &100);
    client.commit_seed(&sid, &player1, &commit1);
    client.commit_seed(&sid, &player2, &commit2);

    // Try verify_noir_seed with too-small proof (64 bytes) — should reject
    let small_proof = build_nizk_proof(&env, &BytesN::<32>::from_array(&env, &[0xCC; 32]));
    let result = client.try_verify_noir_seed(&sid, &player1, &seed_hash1, &small_proof);
    assert_cangkulan_error(&result, CangkulanError::InvalidZkProof);
}
