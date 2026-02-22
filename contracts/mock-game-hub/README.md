# Mock Game Hub

A minimal stub contract that implements the Game Hub interface for development and testing.

## Overview

Game contracts in Stellar Game Studio depend on a Game Hub for lifecycle events
(`start_game`, `end_game`). This mock provides the same external interface but
performs no real logic — it simply emits events and extends its own TTL. Use it
when running unit tests or local development without deploying the full Game Hub.

## Contract Methods

### `start_game`
Record a game session start.

**Parameters:**
- `game_id: Address` — Address of the calling game contract
- `session_id: u32` — Unique session identifier
- `player1: Address` — First player
- `player2: Address` — Second player
- `player1_points: i128` — Points committed by player 1 (ignored)
- `player2_points: i128` — Points committed by player 2 (ignored)

**Auth:** None required (mock)

**Events:** Emits `GameStarted { session_id, game_id, player1, player2, player1_points, player2_points }`

### `end_game`
Record a game session end.

**Parameters:**
- `session_id: u32` — Session being ended
- `player1_won: bool` — Whether player 1 won

**Auth:** None required (mock)

**Events:** Emits `GameEnded { session_id, player1_won }`

## Usage in Tests

```rust
// Register the mock Game Hub
let hub_id = env.register_contract(None, MockGameHub);
let hub = MockGameHubClient::new(&env, &hub_id);

// Use hub_id when constructing your game contract
game_contract.__constructor(&admin, &hub_id);
```

See `contracts/cangkulan/src/test.rs` for a full example of test integration.

## Building

```bash
bun run build mock-game-hub
```

## Testing

```bash
cargo test -p mock-game-hub
# 1 test — covers start + end flow
```
