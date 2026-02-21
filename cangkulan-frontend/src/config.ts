/**
 * Configuration loaded from environment variables
 * These are set by the setup script after deployment
 */

import { getAllContractIds, getContractId } from './utils/constants';
import { log } from '@/utils/logger';

export const config = {
  rpcUrl: import.meta.env.VITE_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase: import.meta.env.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  contractIds: getAllContractIds(),

  // Named aliases for key contracts
  mockGameHubId: getContractId('mock-game-hub'),
  cangkulanId: getContractId('cangkulan'),

  devPlayer1Address: import.meta.env.VITE_DEV_PLAYER1_ADDRESS || '',
  devPlayer2Address: import.meta.env.VITE_DEV_PLAYER2_ADDRESS || '',
};

if (Object.keys(config.contractIds).length === 0) {
  log.warn('Contract IDs not configured. Run `bun run setup` from the repo root.');
}
