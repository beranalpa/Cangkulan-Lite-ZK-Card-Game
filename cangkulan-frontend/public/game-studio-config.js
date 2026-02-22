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

globalThis.__STELLAR_GAME_STUDIO_CONFIG__ = {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    contractIds: {
        'mock-game-hub': 'CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG',
        'cangkulan': 'CBVDO5XYJF3KC72P7ONRXWSIRTX7IBWO4AYY3NRRDVQTERULU5WVZT6E',
        'zk-verifier': 'CA7RTG6G2WRKNKMJ57CAYWWC7IH3ZVIOLWVIUOMDTI65GMKGVO5YGRBM',
        'leaderboard': 'CDZNFIVDP5VJCD2YKPSY6ZHELGXJQVJK7NBI2S56PMK4QB4PIBMICVHB',
        'ultrahonk-verifier': 'CD52VAWNT5LP5S7CLTCFWOQ3FTOSNJMAUAQBTWPI4ECCR55S6LX6IZ6A',
    },
    // Uncomment to enable Dev Testing mode in production builds:
    // devSecrets: {
    //   player1: 'S...your_testnet_secret_key...',
    //   player2: 'S...your_testnet_secret_key...',
    // },
};
