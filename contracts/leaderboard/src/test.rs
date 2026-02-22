#![cfg(test)]

use crate::{Leaderboard, LeaderboardClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env};

// ════════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════════

fn setup() -> (Env, LeaderboardClient<'static>, Address) {
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

    let admin = Address::generate(&env);
    let contract_id = env.register(Leaderboard, (&admin,));
    let client = LeaderboardClient::new(&env, &contract_id);

    (env, client, admin)
}

fn players(env: &Env) -> (Address, Address) {
    (Address::generate(env), Address::generate(env))
}

// ════════════════════════════════════════════════════════════════════════════
//  Initialization
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn test_init_empty() {
    let (_env, client, _admin) = setup();
    assert_eq!(client.total_players(), 0);
    let top = client.get_top_players(&10);
    assert_eq!(top.len(), 0);
}

// ════════════════════════════════════════════════════════════════════════════
//  Record Match — basic
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn test_record_single_match_p1_wins() {
    let (env, client, admin) = setup();
    let (p1, p2) = players(&env);

    client.record_match(&admin, &p1, &p2, &1);

    let s1 = client.get_player(&p1).unwrap();
    assert_eq!(s1.wins, 1);
    assert_eq!(s1.losses, 0);
    assert_eq!(s1.games_played, 1);
    assert!(s1.elo > 1200); // winner gains ELO

    let s2 = client.get_player(&p2).unwrap();
    assert_eq!(s2.wins, 0);
    assert_eq!(s2.losses, 1);
    assert_eq!(s2.games_played, 1);
    assert!(s2.elo < 1200); // loser loses ELO
}

#[test]
fn test_record_single_match_p2_wins() {
    let (env, client, admin) = setup();
    let (p1, p2) = players(&env);

    client.record_match(&admin, &p1, &p2, &2);

    let s1 = client.get_player(&p1).unwrap();
    assert_eq!(s1.losses, 1);
    assert!(s1.elo < 1200);

    let s2 = client.get_player(&p2).unwrap();
    assert_eq!(s2.wins, 1);
    assert!(s2.elo > 1200);
}

#[test]
fn test_record_draw() {
    let (env, client, admin) = setup();
    let (p1, p2) = players(&env);

    client.record_match(&admin, &p1, &p2, &3);

    let s1 = client.get_player(&p1).unwrap();
    let s2 = client.get_player(&p2).unwrap();
    assert_eq!(s1.draws, 1);
    assert_eq!(s2.draws, 1);
    // Equal-rated draw → no change (expected 50, actual 50)
    assert_eq!(s1.elo, 1200);
    assert_eq!(s2.elo, 1200);
}

// ════════════════════════════════════════════════════════════════════════════
//  ELO System
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn test_elo_symmetric_for_equal_players() {
    let (env, client, admin) = setup();
    let (p1, p2) = players(&env);

    client.record_match(&admin, &p1, &p2, &1);

    let s1 = client.get_player(&p1).unwrap();
    let s2 = client.get_player(&p2).unwrap();

    // Equal players: winner gains K*(1-0.5) = 16, loser loses 16
    let gain = s1.elo - 1200;
    let loss = 1200 - s2.elo;
    assert_eq!(gain, loss); // symmetric change
    assert_eq!(gain, 16);   // K=32 * (100-50)/100 = 16
}

#[test]
fn test_elo_upset_gives_more_points() {
    let (env, client, admin) = setup();
    let (p1, p2) = players(&env);

    // Give p1 a higher rating by winning 5 games
    let dummy = Address::generate(&env);
    for _ in 0..5 {
        client.record_match(&admin, &p1, &dummy, &1);
    }
    let high_elo = client.get_player(&p1).unwrap().elo;
    assert!(high_elo > 1200);

    // Now p2 (1200) beats p1 (high ELO) — an upset
    client.record_match(&admin, &p1, &p2, &2);
    let s2 = client.get_player(&p2).unwrap();
    let upset_gain = s2.elo - 1200;

    // Normal gain against equal opponent would be 16
    // Upset gain should be larger
    assert!(upset_gain > 16);
}

#[test]
fn test_elo_minimum_floor() {
    let (env, client, admin) = setup();
    let (p1, p2) = players(&env);

    // Make p1 lose many times so ELO drops
    for _ in 0..80 {
        client.record_match(&admin, &p1, &p2, &2);
    }

    let s1 = client.get_player(&p1).unwrap();
    assert!(s1.elo >= 100, "ELO should never drop below 100");
}

// ════════════════════════════════════════════════════════════════════════════
//  Win Streak
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn test_win_streak_tracking() {
    let (env, client, admin) = setup();
    let (p1, p2) = players(&env);

    // P1 wins 3 in a row
    for _ in 0..3 {
        client.record_match(&admin, &p1, &p2, &1);
    }
    let s1 = client.get_player(&p1).unwrap();
    assert_eq!(s1.win_streak, 3);
    assert_eq!(s1.best_streak, 3);

    // P1 loses → streak resets
    client.record_match(&admin, &p1, &p2, &2);
    let s1 = client.get_player(&p1).unwrap();
    assert_eq!(s1.win_streak, 0);
    assert_eq!(s1.best_streak, 3); // best preserved

    // P1 wins 2 → new streak
    for _ in 0..2 {
        client.record_match(&admin, &p1, &p2, &1);
    }
    let s1 = client.get_player(&p1).unwrap();
    assert_eq!(s1.win_streak, 2);
    assert_eq!(s1.best_streak, 3); // still 3 from before
}

// ════════════════════════════════════════════════════════════════════════════
//  Leaderboard Ordering
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn test_top_players_sorted_by_elo() {
    let (env, client, admin) = setup();

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);
    let loser = Address::generate(&env);

    // p1 wins 5, p2 wins 3, p3 wins 1
    for _ in 0..5 {
        client.record_match(&admin, &p1, &loser, &1);
    }
    for _ in 0..3 {
        client.record_match(&admin, &p2, &loser, &1);
    }
    client.record_match(&admin, &p3, &loser, &1);

    let top = client.get_top_players(&10);
    assert!(top.len() >= 3);

    // Verify sorted descending
    let elos: soroban_sdk::Vec<u32> = {
        let mut v = soroban_sdk::Vec::new(&env);
        for i in 0..top.len() {
            v.push_back(top.get(i).unwrap().elo);
        }
        v
    };

    for i in 0..elos.len().saturating_sub(1) {
        assert!(
            elos.get(i).unwrap() >= elos.get(i + 1).unwrap(),
            "Leaderboard must be sorted descending by ELO"
        );
    }
}

#[test]
fn test_top_players_limit() {
    let (env, client, admin) = setup();
    let loser = Address::generate(&env);

    // Create 5 players
    for _ in 0..5 {
        let p = Address::generate(&env);
        client.record_match(&admin, &p, &loser, &1);
    }

    // Request only top 3
    let top3 = client.get_top_players(&3);
    assert_eq!(top3.len(), 3);

    // Request more than exist
    let all = client.get_top_players(&100);
    assert!(all.len() <= 6); // 5 players + loser = 6
}

// ════════════════════════════════════════════════════════════════════════════
//  Player Not Found
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn test_unknown_player_returns_none() {
    let (env, client, _) = setup();
    let unknown = Address::generate(&env);
    assert!(client.get_player(&unknown).is_none());
}

// ════════════════════════════════════════════════════════════════════════════
//  Authorization
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn test_authorized_game_can_record() {
    let (env, client, admin) = setup();
    let game_contract = Address::generate(&env);
    let (p1, p2) = players(&env);

    client.authorize_game(&admin, &game_contract);
    client.record_match(&game_contract, &p1, &p2, &1);

    assert_eq!(client.get_player(&p1).unwrap().wins, 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // NotAuthorized
fn test_unauthorized_caller_rejected() {
    let (env, client, _admin) = setup();
    let rando = Address::generate(&env);
    let (p1, p2) = players(&env);

    client.record_match(&rando, &p1, &p2, &1);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAdmin
fn test_non_admin_cannot_authorize() {
    let (env, client, _admin) = setup();
    let rando = Address::generate(&env);
    let game = Address::generate(&env);

    client.authorize_game(&rando, &game);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // SelfPlay
fn test_self_play_rejected() {
    let (env, client, admin) = setup();
    let p = Address::generate(&env);

    client.record_match(&admin, &p, &p, &1);
}

// ════════════════════════════════════════════════════════════════════════════
//  Multiple Games Accumulation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn test_multiple_games_accumulate() {
    let (env, client, admin) = setup();
    let (p1, p2) = players(&env);

    client.record_match(&admin, &p1, &p2, &1); // P1 wins
    client.record_match(&admin, &p1, &p2, &1); // P1 wins
    client.record_match(&admin, &p1, &p2, &2); // P2 wins
    client.record_match(&admin, &p1, &p2, &3); // Draw

    let s1 = client.get_player(&p1).unwrap();
    assert_eq!(s1.games_played, 4);
    assert_eq!(s1.wins, 2);
    assert_eq!(s1.losses, 1);
    assert_eq!(s1.draws, 1);

    let s2 = client.get_player(&p2).unwrap();
    assert_eq!(s2.games_played, 4);
    assert_eq!(s2.wins, 1);
    assert_eq!(s2.losses, 2);
    assert_eq!(s2.draws, 1);
}

#[test]
fn test_total_players_count() {
    let (env, client, admin) = setup();

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);

    assert_eq!(client.total_players(), 0);

    client.record_match(&admin, &p1, &p2, &1);
    assert_eq!(client.total_players(), 2);

    client.record_match(&admin, &p1, &p3, &1);
    assert_eq!(client.total_players(), 3);

    // P1 plays again — no new player
    client.record_match(&admin, &p1, &p2, &2);
    assert_eq!(client.total_players(), 3);
}
