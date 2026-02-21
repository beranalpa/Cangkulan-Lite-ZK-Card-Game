# Leaderboard — On-Chain ELO Rating Contract

A Soroban smart contract that tracks player ELO ratings, win/loss records, and ranked leaderboards for games in the Stellar Game Studio.

## Overview

The Leaderboard contract provides a decentralized rating system where authorized game contracts report match results. It computes ELO deltas, maintains sorted player rankings, and exposes read-only queries for frontends and dashboards.

## Features

- **ELO Rating System** — Standard ELO with K-factor adjustment: K=32 for new players (<30 games), K=16 for established players
- **Player Statistics** — Wins, losses, draws, games played, current win streak, best win streak, last updated ledger
- **Sorted Rankings** — `get_top_players(limit)` returns an ELO-sorted leaderboard
- **Access Control** — Only admin-authorized game contracts can record match results
- **Self-Play Rejection** — Prevents the same address from recording a match against itself
- **ELO Floor** — Minimum ELO rating of 100 prevents negative scores
- **On-Chain Events** — `EvMatchRecorded` and `EvPlayerRegistered` events for indexing

## Contract Methods

### `__constructor(admin)`
Initialize the contract with an admin address.

### `authorize_game(caller, game_contract)`
Whitelist a game contract to record match results. Only callable by admin.

### `record_match(caller, player1, player2, outcome)`
Record a match result and update ELO ratings.

**Parameters:**
- `caller: Address` — Admin or authorized game contract
- `player1: Address` — First player
- `player2: Address` — Second player
- `outcome: u32` — `1` = player1 won, `2` = player2 won, `3` = draw

**Auth:** Requires authentication from `caller`, which must be admin or an authorized game contract.

### `get_player(player) → Option<PlayerStats>`
Read a player's current stats. Returns `None` for unknown players.

### `get_top_players(limit) → Vec<PlayerStats>`
Return up to `limit` players sorted by ELO descending.

### `total_players() → u32`
Return the total number of registered players.

## ELO Calculation

The contract uses a step-function approximation of the logistic expected score curve:

```
Expected score based on |ELO difference|:
  0–49   → 50/50
  50–99  → 57/43
  100–199 → 64/36
  200–299 → 76/24
  300–399 → 85/15
  400+   → 92/8

Δ ELO = K × (actual_score - expected_score)
  where actual_score: win=100, draw=50, loss=0
  K = 32 if games_played < 30, else K = 16
  Floor: ELO ≥ 100
```

## On-Chain Events

| Event | Data | When |
|-------|------|------|
| `EvMatchRecorded` | player1, player2, outcome, p1_new_elo, p2_new_elo | Match result recorded |
| `EvPlayerRegistered` | player, initial_elo | New player's first match |

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 1 | `NotAdmin` | Caller is not the admin |
| 2 | `NotAuthorized` | Caller is not admin or an authorized game contract |
| 3 | `PlayerNotFound` | Player does not exist in the leaderboard |
| 4 | `SelfPlay` | Cannot record a match of a player against themselves |

## Building

```bash
bun run build leaderboard
```

## Testing

```bash
cargo test -p leaderboard
# 17 tests — all passing
```

Tests cover: initialization, match recording (P1/P2 wins, draws), ELO symmetry, upset bonuses, ELO floor, win streak tracking, sorted leaderboard, limit capping, authorization checks, self-play rejection, and cumulative stats.
