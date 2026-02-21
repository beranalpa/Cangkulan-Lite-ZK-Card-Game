#![no_std]

//! # Leaderboard Contract
//!
//! On-chain ELO rating and win/loss tracking for Cangkulan players.
//! Called by the game contract (or admin) to record match results.
//!
//! ## Features
//! - ELO rating system (K=32 for new players, K=16 for established)
//! - Win/loss/draw counters
//! - Top-N leaderboard query
//! - Per-player stats query
//! - Event emission for indexing

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, Address, Env, Vec,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerStats {
    pub address: Address,
    pub elo: u32,
    pub wins: u32,
    pub losses: u32,
    pub draws: u32,
    pub games_played: u32,
    pub win_streak: u32,
    pub best_streak: u32,
    pub last_updated: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    /// Set of authorized game contracts that can report results
    AuthorizedGames,
    /// Player stats: DataKey::Player(address) → PlayerStats
    Player(Address),
    /// Sorted leaderboard index (top players by ELO)
    TopPlayers,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LeaderboardError {
    NotAdmin = 1,
    NotAuthorized = 2,
    PlayerNotFound = 3,
    SelfPlay = 4,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Events
// ═══════════════════════════════════════════════════════════════════════════════

#[contractevent]
pub struct EvMatchRecorded {
    pub player1: Address,
    pub player2: Address,
    pub outcome: u32, // 1 = P1 win, 2 = P2 win, 3 = draw
    pub p1_new_elo: u32,
    pub p2_new_elo: u32,
}

#[contractevent]
pub struct EvPlayerRegistered {
    pub player: Address,
    pub initial_elo: u32,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_ELO: u32 = 1200;
const K_NEW: u32 = 32;      // K-factor for players with < 30 games
const K_ESTABLISHED: u32 = 16; // K-factor for players with >= 30 games
const MAX_TOP_PLAYERS: u32 = 50;

// Ledger rate is approximately 5 seconds per ledger on Stellar
const LEDGER_RATE_SECS: u32 = 5;

// TTL expressed in human-readable time units (120 days)
const TTL_SECONDS: u32 = 120 * 24 * 60 * 60;    // 10,368,000 seconds
const TTL_MINUTES: u32 = TTL_SECONDS / 60;      // 172,800 minutes
const TTL_HOURS: u32 = TTL_MINUTES / 60;        // 2,880 hours
const TTL_DAYS: u32 = TTL_HOURS / 24;           // 120 days
const TTL_WEEKS: u32 = TTL_DAYS / 7;            // 17 weeks + 1 day

/// TTL for player data in ledgers: 120 * 24 * 60 * 60 / 5 = 2,073,600 ledgers
const TTL_LEDGERS: u32 = TTL_SECONDS / LEDGER_RATE_SECS;

// ═══════════════════════════════════════════════════════════════════════════════
//  Contract
// ═══════════════════════════════════════════════════════════════════════════════

#[contract]
pub struct Leaderboard;

#[contractimpl]
impl Leaderboard {
    /// Initialize with admin address
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        let empty_games: Vec<Address> = Vec::new(&env);
        env.storage().instance().set(&DataKey::AuthorizedGames, &empty_games);
        let empty_top: Vec<Address> = Vec::new(&env);
        env.storage().instance().set(&DataKey::TopPlayers, &empty_top);
    }

    /// Add a game contract address that's allowed to report results
    pub fn authorize_game(env: Env, caller: Address, game_contract: Address) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, LeaderboardError::NotAdmin);
        }
        let mut games: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedGames)
            .unwrap_or(Vec::new(&env));
        if !games.contains(&game_contract) {
            games.push_back(game_contract);
            env.storage().instance().set(&DataKey::AuthorizedGames, &games);
        }
    }

    /// Record a match result. Called by an authorized game contract or admin.
    /// outcome: 1 = player1 wins, 2 = player2 wins, 3 = draw
    pub fn record_match(
        env: Env,
        caller: Address,
        player1: Address,
        player2: Address,
        outcome: u32,
    ) {
        caller.require_auth();

        // Verify caller is admin or authorized game
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            let games: Vec<Address> = env
                .storage()
                .instance()
                .get(&DataKey::AuthorizedGames)
                .unwrap_or(Vec::new(&env));
            if !games.contains(&caller) {
                panic_with_error!(&env, LeaderboardError::NotAuthorized);
            }
        }

        if player1 == player2 {
            panic_with_error!(&env, LeaderboardError::SelfPlay);
        }

        let now = env.ledger().timestamp();

        // Get or create stats for both players
        let mut stats1 = Self::get_or_create_stats(&env, &player1, now);
        let mut stats2 = Self::get_or_create_stats(&env, &player2, now);

        // Calculate ELO changes
        let (new_elo1, new_elo2) = Self::calculate_elo(
            stats1.elo,
            stats2.elo,
            outcome,
            if stats1.games_played < 30 { K_NEW } else { K_ESTABLISHED },
            if stats2.games_played < 30 { K_NEW } else { K_ESTABLISHED },
        );

        // Update stats
        stats1.elo = new_elo1;
        stats2.elo = new_elo2;
        stats1.games_played += 1;
        stats2.games_played += 1;
        stats1.last_updated = now;
        stats2.last_updated = now;

        match outcome {
            1 => {
                stats1.wins += 1;
                stats1.win_streak += 1;
                if stats1.win_streak > stats1.best_streak {
                    stats1.best_streak = stats1.win_streak;
                }
                stats2.losses += 1;
                stats2.win_streak = 0;
            }
            2 => {
                stats2.wins += 1;
                stats2.win_streak += 1;
                if stats2.win_streak > stats2.best_streak {
                    stats2.best_streak = stats2.win_streak;
                }
                stats1.losses += 1;
                stats1.win_streak = 0;
            }
            _ => {
                // Draw
                stats1.draws += 1;
                stats2.draws += 1;
                stats1.win_streak = 0;
                stats2.win_streak = 0;
            }
        }

        // Persist
        Self::save_stats(&env, &stats1);
        Self::save_stats(&env, &stats2);

        // Update top players index
        Self::update_top_players(&env, &player1, new_elo1);
        Self::update_top_players(&env, &player2, new_elo2);

        // Emit event
        EvMatchRecorded {
            player1,
            player2,
            outcome,
            p1_new_elo: new_elo1,
            p2_new_elo: new_elo2,
        }.publish(&env);
    }

    /// Get stats for a player. Returns None if not found.
    pub fn get_player(env: Env, player: Address) -> Option<PlayerStats> {
        env.storage()
            .persistent()
            .get(&DataKey::Player(player))
    }

    /// Get top N players by ELO rating
    pub fn get_top_players(env: Env, limit: u32) -> Vec<PlayerStats> {
        let top: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::TopPlayers)
            .unwrap_or(Vec::new(&env));

        let n = if limit < top.len() { limit } else { top.len() };
        let mut result = Vec::new(&env);

        for i in 0..n {
            let addr = top.get(i).unwrap();
            if let Some(stats) = env.storage().persistent().get::<DataKey, PlayerStats>(
                &DataKey::Player(addr.clone()),
            ) {
                result.push_back(stats);
            }
        }
        result
    }

    /// Get total number of registered players (from top index length)
    pub fn total_players(env: Env) -> u32 {
        let top: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::TopPlayers)
            .unwrap_or(Vec::new(&env));
        top.len()
    }

    // ─── Internal helpers ──────────────────────────────────────────────────

    fn get_or_create_stats(env: &Env, player: &Address, now: u64) -> PlayerStats {
        match env
            .storage()
            .persistent()
            .get::<DataKey, PlayerStats>(&DataKey::Player(player.clone()))
        {
            Some(stats) => stats,
            None => {
                EvPlayerRegistered {
                    player: player.clone(),
                    initial_elo: DEFAULT_ELO,
                }.publish(env);
                PlayerStats {
                    address: player.clone(),
                    elo: DEFAULT_ELO,
                    wins: 0,
                    losses: 0,
                    draws: 0,
                    games_played: 0,
                    win_streak: 0,
                    best_streak: 0,
                    last_updated: now,
                }
            }
        }
    }

    fn save_stats(env: &Env, stats: &PlayerStats) {
        env.storage()
            .persistent()
            .set(&DataKey::Player(stats.address.clone()), stats);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Player(stats.address.clone()), TTL_LEDGERS, TTL_LEDGERS);
    }

    /// ELO calculation. Returns (new_elo1, new_elo2).
    /// Uses integer arithmetic to avoid floating point.
    fn calculate_elo(
        elo1: u32,
        elo2: u32,
        outcome: u32,
        k1: u32,
        k2: u32,
    ) -> (u32, u32) {
        // Expected score calculation using simplified logistic function
        // E(A) = 1 / (1 + 10^((Rb - Ra) / 400))
        // We use a lookup table approximation for integer math

        let diff1 = (elo2 as i64) - (elo1 as i64); // positive means P2 is higher rated
        let diff2 = -diff1;

        let expected1 = Self::expected_score_pct(diff1);
        let expected2 = Self::expected_score_pct(diff2);

        // Actual score: win=100, draw=50, loss=0 (scaled by 100)
        let (actual1, actual2) = match outcome {
            1 => (100i64, 0i64),
            2 => (0i64, 100i64),
            _ => (50i64, 50i64),
        };

        // New ELO = old + K * (actual - expected) / 100
        let change1 = (k1 as i64) * (actual1 - expected1) / 100;
        let change2 = (k2 as i64) * (actual2 - expected2) / 100;

        let new1 = ((elo1 as i64) + change1).max(100) as u32;
        let new2 = ((elo2 as i64) + change2).max(100) as u32;

        (new1, new2)
    }

    /// Approximate expected score as percentage (0-100) given rating difference.
    /// Uses a step function approximation of the logistic curve.
    fn expected_score_pct(diff: i64) -> i64 {
        // diff = opponent_elo - self_elo
        // Negative diff = I'm higher rated = higher expected score
        match diff {
            d if d <= -400 => 92,
            d if d <= -300 => 85,
            d if d <= -200 => 76,
            d if d <= -100 => 64,
            d if d <= -50  => 57,
            d if d <= 0    => 50,
            d if d <= 50   => 43,
            d if d <= 100  => 36,
            d if d <= 200  => 24,
            d if d <= 300  => 15,
            _              => 8,
        }
    }

    /// Keep the top players index sorted by ELO (descending).
    fn update_top_players(env: &Env, player: &Address, new_elo: u32) {
        let mut top: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::TopPlayers)
            .unwrap_or(Vec::new(env));

        // Remove player if already present
        let mut found_idx: Option<u32> = None;
        for i in 0..top.len() {
            if top.get(i).unwrap() == *player {
                found_idx = Some(i);
                break;
            }
        }
        if let Some(idx) = found_idx {
            top.remove(idx);
        }

        // Find insertion point (sorted descending by ELO)
        let mut insert_at = top.len();
        for i in 0..top.len() {
            let addr = top.get(i).unwrap();
            if let Some(stats) = env
                .storage()
                .persistent()
                .get::<DataKey, PlayerStats>(&DataKey::Player(addr))
            {
                if new_elo > stats.elo {
                    insert_at = i;
                    break;
                }
            }
        }

        top.insert(insert_at, player.clone());

        // Trim to MAX_TOP_PLAYERS
        while top.len() > MAX_TOP_PLAYERS {
            top.pop_back();
        }

        env.storage().instance().set(&DataKey::TopPlayers, &top);
    }
}

#[cfg(test)]
mod test;
