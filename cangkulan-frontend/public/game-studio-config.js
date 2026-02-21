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
//     'cangkulan':            'CCOMMIIORXZOAV3PJ32UUMTWCMWOAIT4RC4RLQFJW4XU6RNO3IPZKK65',
//     'zk-verifier':          'CBVCH6NE2SVE57JEL6QT4VRIQH5ESBRMMYCO3WMYBUWRPHSAEL5VW5PX',
//     'leaderboard':          'CCVCGEIXFHCX45SLZP6CERSMQXGVNA72DYYJCN6LYLWL6RXUEPI5O74B',
//     'ultrahonk-verifier':   'CBZFVNUDSWEPGMSIQZB3EN45BOCP6X3XP37CPPVVYQLFZI64TKSKQIAI',
//   },
//   // Uncomment to enable Dev Testing mode in production builds:
//   // devSecrets: {
//   //   player1: 'S...your_testnet_secret_key...',
//   //   player2: 'S...your_testnet_secret_key...',
//   // },
// };
