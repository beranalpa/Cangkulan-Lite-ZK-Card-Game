/**
 * Runtime configuration for Cangkulan standalone frontend.
 *
 * This file is loaded before the app bundle and injects contract IDs
 * into `globalThis.__STELLAR_GAME_STUDIO_CONFIG__`.  Values here
 * override Vite `.env` variables, making it possible to swap contract
 * addresses at deploy time without rebuilding.
 *
 * For local dev the `.env` file is sufficient — this file is a no-op
 * unless you uncomment the block below.
 */

// globalThis.__STELLAR_GAME_STUDIO_CONFIG__ = {
//   rpcUrl: 'https://soroban-testnet.stellar.org',
//   networkPassphrase: 'Test SDF Network ; September 2015',
//   contractIds: {
//     'mock-game-hub':        'CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG',
//     'cangkulan':            'CCT7I2K2CNFMIHPBISSAJQLB5Y53PPJVU3XJNYKJQNYEN57JKEDYYXOE',
//     'zk-verifier':          'CBOIHT66ZGS27774KVO6CYFQ46VYG2SCKCQBG2LUO6JYRZGKHD3XBRMW',
//     'leaderboard':          'CAXFWRR7QPNPME24L7XM7LIWSZDKI4FONMIYQBPJNHNFZKJBG3RIPDWT',
//     'ultrahonk-verifier':   'CBYXG3RWXT5AFECZX35DWMFU6POWJPEU3MALK7OTYLEKG7R7ICHDZC6J',
//   },
//   // Uncomment to enable Dev Testing mode in production builds:
//   // devSecrets: {
//   //   player1: 'S...your_testnet_secret_key...',
//   //   player2: 'S...your_testnet_secret_key...',
//   // },
// };
