/**
 * WRFCoin Blockchain Integration Module
 * Task 76: Replace Mock Smart Contract API with Real Blockchain Integration
 *
 * This module provides a complete blockchain integration layer with:
 * - Multi-chain support (13+ EVM-compatible networks)
 * - HSM-backed transaction signing (private keys never leave the HSM)
 * - Contract deployment and interaction
 * - Event retrieval and monitoring
 * - Gas estimation and network health monitoring
 */

// Type exports
export type {
  NetworkId,
  NetworkConfig,
  DeployedContract,
  DeployContractParams,
  DeployContractResult,
  CallContractParams,
  CallContractResult,
  ContractEvent,
  GetEventsParams,
  EstimateGasParams,
  GasEstimateResult,
  VerifyContractParams,
  VerifyContractResult,
  HSMCredentials,
  HSMSession,
  HSMKeyInfo,
  ProviderHealth,
  ServiceStatus,
  ApiResponse,
  TransactionOptions,
  HSMSignatureResult,
  EthereumSignature,
} from './types/index.js';

// Configuration exports
export {
  NETWORK_CONFIGS,
  getNetworkConfig,
  getNetworkConfigByChainId,
  getSupportedNetworks,
  getMainnetNetworks,
  getTestnetNetworks,
  isValidNetworkId,
  getDefaultNetworkId,
  USE_REAL_BLOCKCHAIN,
  DEFAULT_GAS_LIMITS,
} from './config/networks.js';

// Provider manager exports
export {
  MultiChainProviderManager,
  providerManager,
} from './providers/multi-chain-manager.js';

// HSM signer exports
export {
  HSMSigner,
  HSMSessionManager,
  createHSMSigner,
} from './signers/hsm-signer.js';

// Smart contract service exports
export {
  SmartContractService,
  smartContractService,
} from './services/smart-contract-service.js';

/**
 * Initialize the blockchain integration module
 * This is a convenience function that initializes all components
 */
export async function initializeBlockchainModule(credentials?: {
  userId: string;
  pin: string;
}): Promise<void> {
  const { smartContractService } = await import('./services/smart-contract-service.js');
  await smartContractService.initialize(credentials);
}

/**
 * Shutdown the blockchain integration module
 * This ensures all connections and sessions are properly cleaned up
 */
export async function shutdownBlockchainModule(): Promise<void> {
  const { smartContractService } = await import('./services/smart-contract-service.js');
  await smartContractService.shutdown();
}
