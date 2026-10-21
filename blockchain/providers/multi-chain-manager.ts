/**
 * Multi-Chain Provider Manager
 * Task 76: Replace Mock Smart Contract API with Real Blockchain Integration
 *
 * Manages ethers.js providers for 13+ EVM-compatible networks with:
 * - Lazy provider initialization
 * - Health monitoring with automatic failover
 * - RPC endpoint rotation
 * - Connection pooling
 */

import { JsonRpcProvider, FetchRequest } from 'ethers';
import type { NetworkConfig, NetworkId, ProviderHealth } from '../types/index.js';
import {
  NETWORK_CONFIGS,
  getNetworkConfig,
  getSupportedNetworks,
  isValidNetworkId,
} from '../config/networks.js';
import { blockchainLogger, crosschainLogger } from '../../server/utils/logger.js';

/** Health check interval in milliseconds (30 seconds) */
const HEALTH_CHECK_INTERVAL = 30_000;

/** Provider request timeout in milliseconds */
const PROVIDER_TIMEOUT = 15_000;

/** Maximum number of failover attempts */
const MAX_FAILOVER_ATTEMPTS = 3;

/**
 * Manages multiple blockchain providers with health monitoring and failover
 */
export class MultiChainProviderManager {
  /** Active providers by network ID */
  private providers: Map<NetworkId, JsonRpcProvider> = new Map();

  /** Current RPC URL index for each network (for failover) */
  private rpcUrlIndex: Map<NetworkId, number> = new Map();

  /** Health status for each network */
  private healthStatus: Map<NetworkId, ProviderHealth> = new Map();

  /** Health check timer */
  private healthCheckTimer: NodeJS.Timeout | null = null;

  /** In-flight health check sweep promise */
  private healthCheckInFlight: Promise<void> | null = null;

  /** Whether the manager has been initialized */
  private initialized = false;

  /**
   * Initialize the provider manager
   * Sets up health monitoring for active networks
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    crosschainLogger.info('Initializing provider manager', {
      component: 'multi-chain-manager',
    });

    // Initialize health status for all supported networks
    for (const networkId of getSupportedNetworks()) {
      this.rpcUrlIndex.set(networkId, 0);
      this.healthStatus.set(networkId, {
        networkId,
        isHealthy: false,
        latency: 0,
        lastChecked: new Date(),
      });
    }

    this.initialized = true;

    // Start health monitoring
    this.startHealthMonitoring();

    crosschainLogger.info('Provider manager initialized', {
      component: 'multi-chain-manager',
    });
  }

  /**
   * Get a provider for the specified network
   * Lazy initialization - provider is created on first request
   */
  async getProvider(networkId: NetworkId): Promise<JsonRpcProvider> {
    if (!isValidNetworkId(networkId)) {
      throw new Error(`Unsupported network: ${networkId}`);
    }

    // Return existing provider if available and healthy
    const existing = this.providers.get(networkId);
    const health = this.healthStatus.get(networkId);

    if (existing && health?.isHealthy) {
      return existing;
    }

    // Create new provider
    const provider = await this.createProvider(networkId);
    this.providers.set(networkId, provider);

    // Perform initial health check
    await this.checkProviderHealth(networkId);

    return provider;
  }

  /**
   * Create a new provider for the specified network
   */
  private async createProvider(networkId: NetworkId): Promise<JsonRpcProvider> {
    const config = getNetworkConfig(networkId);
    const rpcUrlIndex = this.rpcUrlIndex.get(networkId) || 0;

    // Get current RPC URL (primary or fallback based on index)
    const rpcUrl = this.getRpcUrl(config, rpcUrlIndex);

    crosschainLogger.debug(`Creating provider for ${networkId}`, {
      component: 'multi-chain-manager',
      networkId,
      rpcUrl,
    });

    // Create fetch request with timeout
    const fetchRequest = new FetchRequest(rpcUrl);
    fetchRequest.timeout = PROVIDER_TIMEOUT;

    // Create the provider
    const provider = new JsonRpcProvider(fetchRequest, {
      chainId: config.chainId,
      name: config.name,
    });

    return provider;
  }

  /**
   * Get RPC URL at the specified index (primary or fallback)
   */
  private getRpcUrl(config: NetworkConfig, index: number): string {
    if (index === 0) {
      return config.rpcUrl;
    }

    const fallbackIndex = index - 1;
    if (fallbackIndex < config.fallbackRpcUrls.length) {
      return config.fallbackRpcUrls[fallbackIndex];
    }

    // Wrap around to primary if all fallbacks exhausted
    return config.rpcUrl;
  }

  /**
   * Start periodic health monitoring for all active providers
   */
  private startHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.scheduleNextHealthCheck();

    crosschainLogger.info('Health monitoring started', {
      component: 'multi-chain-manager',
      intervalMs: HEALTH_CHECK_INTERVAL,
    });
  }

  /**
   * Schedule the next health monitoring sweep.
   * The next pass is only queued after the current one settles, which prevents
   * overlapping failover and provider mutation.
   */
  private scheduleNextHealthCheck(delayMs: number = HEALTH_CHECK_INTERVAL): void {
    if (!this.initialized) {
      return;
    }

    this.healthCheckTimer = setTimeout(() => {
      void this.runHealthCheckSweep();
    }, delayMs);
  }

  /**
   * Run a single health check sweep if one is not already in flight.
   */
  private async runHealthCheckSweep(): Promise<void> {
    if (this.healthCheckInFlight) {
      crosschainLogger.warn('Skipping provider health sweep because a prior sweep is still running', {
        component: 'multi-chain-manager',
      });
      return;
    }

    this.healthCheckInFlight = this.performHealthChecks();

    try {
      await this.healthCheckInFlight;
    } catch (error) {
      crosschainLogger.error('Provider health sweep failed', {
        component: 'multi-chain-manager',
        error: (error as Error).message,
      });
    } finally {
      this.healthCheckInFlight = null;
      this.healthCheckTimer = null;

      if (this.initialized) {
        this.scheduleNextHealthCheck();
      }
    }
  }

  /**
   * Perform health checks on all active providers
   */
  private async performHealthChecks(): Promise<void> {
    const activeNetworks = Array.from(this.providers.keys());

    await Promise.all(
      activeNetworks.map(async (networkId) => {
        try {
          await this.checkProviderHealth(networkId);
        } catch (error) {
          crosschainLogger.error(`Health check failed for ${networkId}`, {
            component: 'multi-chain-manager',
            networkId,
            error: (error as Error).message,
          });
        }
      })
    );
  }

  /**
   * Check health of a specific provider
   */
  private async checkProviderHealth(networkId: NetworkId): Promise<ProviderHealth> {
    const provider = this.providers.get(networkId);
    if (!provider) {
      const health: ProviderHealth = {
        networkId,
        isHealthy: false,
        latency: 0,
        lastChecked: new Date(),
        error: 'Provider not initialized',
      };
      this.healthStatus.set(networkId, health);
      return health;
    }

    const startTime = Date.now();

    try {
      // Get block number as a simple health check
      const blockNumber = await provider.getBlockNumber();
      const latency = Date.now() - startTime;

      const health: ProviderHealth = {
        networkId,
        isHealthy: true,
        latency,
        lastChecked: new Date(),
        blockNumber,
      };

      this.healthStatus.set(networkId, health);
      return health;
    } catch (error) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      const health: ProviderHealth = {
        networkId,
        isHealthy: false,
        latency,
        lastChecked: new Date(),
        error: errorMessage,
      };

      this.healthStatus.set(networkId, health);

      // Attempt failover to next RPC endpoint
      await this.attemptFailover(networkId);

      return health;
    }
  }

  /**
   * Attempt to failover to the next available RPC endpoint
   */
  private async attemptFailover(networkId: NetworkId): Promise<boolean> {
    const config = getNetworkConfig(networkId);
    const currentIndex = this.rpcUrlIndex.get(networkId) || 0;
    const maxIndex = config.fallbackRpcUrls.length + 1; // +1 for primary

    // Try the next RPC URL
    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      const nextIndex = (currentIndex + attempt + 1) % maxIndex;
      this.rpcUrlIndex.set(networkId, nextIndex);

      crosschainLogger.info(`Attempting failover for ${networkId}`, {
        component: 'multi-chain-manager',
        networkId,
        attempt: attempt + 1,
        maxAttempts: MAX_FAILOVER_ATTEMPTS,
      });

      try {
        // Create new provider with next RPC URL
        const provider = await this.createProvider(networkId);
        this.providers.set(networkId, provider);

        // Test the new provider
        await provider.getBlockNumber();

        crosschainLogger.info(`Failover successful for ${networkId}`, {
          component: 'multi-chain-manager',
          networkId,
        });

        // Update health status
        const health: ProviderHealth = {
          networkId,
          isHealthy: true,
          latency: 0,
          lastChecked: new Date(),
        };
        this.healthStatus.set(networkId, health);

        return true;
      } catch (error) {
        crosschainLogger.warn(`Failover attempt ${attempt + 1} failed for ${networkId}`, {
          component: 'multi-chain-manager',
          networkId,
          attempt: attempt + 1,
        });
      }
    }

    crosschainLogger.error(`All failover attempts exhausted for ${networkId}`, {
      component: 'multi-chain-manager',
      networkId,
      maxAttempts: MAX_FAILOVER_ATTEMPTS,
    });
    return false;
  }

  /**
   * Get health status for a specific network
   */
  getHealthStatus(networkId: NetworkId): ProviderHealth | undefined {
    return this.healthStatus.get(networkId);
  }

  /**
   * Get health status for all networks
   */
  getAllHealthStatus(): Map<NetworkId, ProviderHealth> {
    return new Map(this.healthStatus);
  }

  /**
   * Get list of healthy networks
   */
  getHealthyNetworks(): NetworkId[] {
    const healthy: NetworkId[] = [];
    for (const [networkId, health] of this.healthStatus) {
      if (health.isHealthy) {
        healthy.push(networkId);
      }
    }
    return healthy;
  }

  /**
   * Force refresh a provider for a specific network
   */
  async refreshProvider(networkId: NetworkId): Promise<JsonRpcProvider> {
    // Remove existing provider
    this.providers.delete(networkId);

    // Reset to primary RPC URL
    this.rpcUrlIndex.set(networkId, 0);

    // Create and return new provider
    return this.getProvider(networkId);
  }

  /**
   * Get current block number for a network
   */
  async getBlockNumber(networkId: NetworkId): Promise<number> {
    const provider = await this.getProvider(networkId);
    return provider.getBlockNumber();
  }

  /**
   * Get gas price for a network (legacy or EIP-1559)
   */
  async getGasPrice(networkId: NetworkId): Promise<{
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    isEip1559: boolean;
  }> {
    const config = getNetworkConfig(networkId);
    const provider = await this.getProvider(networkId);

    if (config.eip1559) {
      try {
        const feeData = await provider.getFeeData();
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
          // Apply gas price multiplier
          const multiplier = BigInt(Math.floor(config.gasPriceMultiplier * 100));
          const maxFeePerGas = (feeData.maxFeePerGas * multiplier) / 100n;
          const maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * multiplier) / 100n;

          return {
            maxFeePerGas,
            maxPriorityFeePerGas,
            isEip1559: true,
          };
        }
      } catch (error) {
        crosschainLogger.warn(`EIP-1559 fee data unavailable for ${networkId}, falling back to legacy`, {
          component: 'multi-chain-manager',
          networkId,
        });
      }
    }

    // Legacy gas price
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || 0n;

    // Apply gas price multiplier
    const multiplier = BigInt(Math.floor(config.gasPriceMultiplier * 100));
    const adjustedGasPrice = (gasPrice * multiplier) / 100n;

    return {
      gasPrice: adjustedGasPrice,
      isEip1559: false,
    };
  }

  /**
   * Wait for a transaction to be confirmed
   */
  async waitForTransaction(
    networkId: NetworkId,
    txHash: string,
    confirmations?: number
  ): Promise<{
    blockNumber: number;
    status: number;
    gasUsed: bigint;
  }> {
    const config = getNetworkConfig(networkId);
    const provider = await this.getProvider(networkId);
    const requiredConfirmations = confirmations ?? config.confirmations;

    const receipt = await provider.waitForTransaction(txHash, requiredConfirmations);

    if (!receipt) {
      throw new Error(`Transaction ${txHash} not found`);
    }

    return {
      blockNumber: receipt.blockNumber,
      status: receipt.status ?? 0,
      gasUsed: receipt.gasUsed,
    };
  }

  /**
   * Get transaction logs/events
   */
  async getLogs(
    networkId: NetworkId,
    filter: {
      address?: string;
      topics?: (string | string[] | null)[];
      fromBlock?: number | string;
      toBlock?: number | string;
    }
  ): Promise<Array<{
    address: string;
    topics: string[];
    data: string;
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
  }>> {
    const provider = await this.getProvider(networkId);
    const logs = await provider.getLogs(filter);

    return logs.map((log) => ({
      address: log.address,
      topics: [...log.topics],
      data: log.data,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    }));
  }

  /**
   * Shutdown the provider manager
   */
  async shutdown(): Promise<void> {
    crosschainLogger.info('Shutting down provider manager', {
      component: 'multi-chain-manager',
    });

    this.initialized = false;

    // Stop health monitoring
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Destroy all providers
    for (const [networkId, provider] of this.providers) {
      try {
        provider.destroy();
        crosschainLogger.debug(`Provider destroyed for ${networkId}`, {
          component: 'multi-chain-manager',
          networkId,
        });
      } catch (error) {
        crosschainLogger.error(`Error destroying provider for ${networkId}`, {
          component: 'multi-chain-manager',
          networkId,
          error: (error as Error).message,
        });
      }
    }

    this.providers.clear();

    crosschainLogger.info('Shutdown complete', {
      component: 'multi-chain-manager',
    });
  }
}

// Export singleton instance
export const providerManager = new MultiChainProviderManager();
