/**
 * Enhanced Blockchain Service
 * Manages integration between Rust blockchain core and Node.js simple blockchain
 * Provides fallback functionality and data transformation
 */

import {
  rustBlockchainClient,
  RustBlockchainClient,
} from './rust-blockchain-client.js';
import {
  DashboardStats,
  WalletBalance,
  Transaction as APITransaction,
  MiningStats,
  NFT,
  WeatherReward,
} from '../shared/types/api-types.js';

import {
  EthereumAddress,
  PositiveNumber,
} from '../shared/types/security-types.js';

import {
  NetworkInfo,
  ValidatorInfo,
  Transaction,
  Wallet,
} from '../shared/types/blockchain-types.js';
import { WRF_DECIMALS } from '../shared/currency.js';

import { blockchainLogger } from '../server/utils/logger.js';

// Import the simple blockchain for fallback
const simpleBlockchain = require('./simple-blockchain');

interface BlockchainServiceConfig {
  useRustBlockchain: boolean;
  fallbackToSimple: boolean;
  rustApiTimeout: number;
}

/**
 * Enhanced blockchain service with Rust integration and fallback
 */
export class EnhancedBlockchainService {
  private config: BlockchainServiceConfig;
  private rustClient: RustBlockchainClient;
  private isRustAvailable: boolean = false;

  constructor(config: Partial<BlockchainServiceConfig> = {}) {
    this.config = {
      useRustBlockchain: process.env.USE_RUST_BLOCKCHAIN !== 'false',
      fallbackToSimple: process.env.FALLBACK_TO_SIMPLE !== 'false',
      rustApiTimeout: parseInt(process.env.RUST_API_TIMEOUT || '5000', 10),
      ...config,
    };

    this.rustClient = rustBlockchainClient;
    this.initializeRustConnection();
  }

  /**
   * Initialize connection to Rust blockchain
   */
  private async initializeRustConnection(): Promise<void> {
    if (!this.config.useRustBlockchain) {
      blockchainLogger.info('Rust blockchain integration disabled, using simple blockchain only', {
        component: 'enhanced-blockchain-service',
      });
      return;
    }

    try {
      this.isRustAvailable = await this.rustClient.isAvailable();
      if (this.isRustAvailable) {
        blockchainLogger.info('Connected to Rust blockchain core', {
          component: 'enhanced-blockchain-service',
        });
      } else {
        blockchainLogger.warn('Rust blockchain core unavailable, using fallback', {
          component: 'enhanced-blockchain-service',
        });
      }
    } catch (error) {
      blockchainLogger.error('Failed to connect to Rust blockchain', {
        component: 'enhanced-blockchain-service',
        error: (error as Error).message,
      });
      this.isRustAvailable = false;
    }
  }

  /**
   * Check Rust API availability and update status
   */
  private async checkRustAvailability(): Promise<boolean> {
    if (!this.config.useRustBlockchain) return false;

    try {
      this.isRustAvailable = await this.rustClient.isAvailable();
      return this.isRustAvailable;
    } catch (error) {
      this.isRustAvailable = false;
      return false;
    }
  }

  /**
   * Execute with fallback: try Rust first, then simple blockchain
   */
  private async executeWithFallback<T>(
    rustOperation: () => Promise<T>,
    fallbackOperation: () => T | Promise<T>,
    operationName: string
  ): Promise<T> {
    // Always check availability for critical operations
    if (this.config.useRustBlockchain && (await this.checkRustAvailability())) {
      try {
        blockchainLogger.debug(`Executing ${operationName} via Rust blockchain`, {
          component: 'enhanced-blockchain-service',
          operation: operationName,
        });
        return await rustOperation();
      } catch (error) {
        blockchainLogger.error(`Rust ${operationName} failed`, {
          component: 'enhanced-blockchain-service',
          operation: operationName,
          error: (error as Error).message,
        });

        if (!this.config.fallbackToSimple) {
          throw error;
        }

        blockchainLogger.warn(`Falling back to simple blockchain for ${operationName}`, {
          component: 'enhanced-blockchain-service',
          operation: operationName,
        });
      }
    }

    // Use simple blockchain fallback
    blockchainLogger.debug(`Executing ${operationName} via simple blockchain`, {
      component: 'enhanced-blockchain-service',
      operation: operationName,
    });
    return await fallbackOperation();
  }

  /**
   * Get comprehensive dashboard statistics
   */
  async getDashboardStats(): Promise<DashboardStats> {
    return this.executeWithFallback(
      async () => {
        const summary = await this.rustClient.getBlockchainSummary();
        const mining = await this.rustClient.getMiningStats();
        const network = await this.rustClient.getNetworkInfo();

        return {
          totalNodes: summary.pending_transactions || 12847,
          activeValidators: 2156, // Could get from validators endpoint
          totalTransactions: summary.total_transactions,
          networkHashrate: mining.hashrate || '1.2 PH/s',
          averageBlockTime: '5.2s',
          totalSupply: '21,000,000 WRF',
          circulatingSupply: '18,456,892 WRF',
          marketCap: '$45,892,156',
          price: '$2.48',
          volume24h: '$12,456,892',
        };
      },
      () => {
        // Simple blockchain fallback with mock data
        return {
          totalNodes: 12847,
          activeValidators: 2156,
          totalTransactions: 8942156,
          networkHashrate: '1.2 PH/s',
          averageBlockTime: '5.2s',
          totalSupply: '21,000,000 WRF',
          circulatingSupply: '18,456,892 WRF',
          marketCap: '$45,892,156',
          price: '$2.48',
          volume24h: '$12,456,892',
        };
      },
      'getDashboardStats'
    );
  }

  /**
   * Get wallet balance with enhanced information
   */
  async getWalletBalance(address: string): Promise<WalletBalance> {
    return this.executeWithFallback(
      async () => {
        const wallet = await this.rustClient.getAddressBalance(address);
        return {
          address: address as EthereumAddress,
          balance: `${wallet.balance} WRF`,
          tokens: wallet.tokenBalances?.map(token => ({
            symbol: 'WRF', // Could map from token data
            balance: token.balance.toString(),
            value: `$${(parseFloat(token.balance.toString()) * 2.48).toFixed(2)}`,
          })) || [
            {
              symbol: 'WRF',
              balance: wallet.balance.toString(),
              value: `$${(parseFloat(wallet.balance.toString()) * 2.48).toFixed(2)}`,
            },
          ],
          nfts: [], // NFTs would need separate endpoint
        };
      },
      () => {
        // Use simple blockchain for balance
        const balance = simpleBlockchain.getBalance(address);
        return {
          address: address as EthereumAddress,
          balance: `${balance.toFixed(2)} WRF`,
          tokens: [
            {
              symbol: 'WRF',
              balance: balance.toFixed(2),
              value: `$${(balance * 2.48).toFixed(2)}`,
            },
          ],
          nfts: [],
        };
      },
      'getWalletBalance'
    );
  }

  /**
   * Get transaction history for address
   */
  async getTransactionHistory(
    address: string,
    page: number = 1,
    limit: number = 20
  ): Promise<APITransaction[]> {
    return this.executeWithFallback(
      async () => {
        const transactions = await this.rustClient.getAddressTransactions(
          address,
          page,
          limit
        );
        return transactions.map(tx => ({
          hash: tx.hash as `0x${string}`,
          from: tx.from as EthereumAddress,
          to: tx.to as EthereumAddress,
          amount: `${tx.value} WRF`,
          fee: `${tx.gasPrice || 0.001} WRF`,
          timestamp: tx.timestamp,
          blockNumber: tx.blockNumber || 0,
          status: tx.status as 'confirmed' | 'pending' | 'failed',
          type: tx.type as 'transfer' | 'weather_reward' | 'mining_reward',
        }));
      },
      () => {
        // Use simple blockchain transaction history
        const history = simpleBlockchain.getTransactionHistory(address);
        return history.map(tx => ({
          hash: tx.hash as `0x${string}`,
          from: tx.from as EthereumAddress,
          to: tx.to as EthereumAddress,
          amount: `${tx.amount} WRF`,
          fee: `${tx.fee} WRF`,
          timestamp: new Date(tx.timestamp),
          blockNumber: tx.blockHeight || 0,
          status: tx.status as 'confirmed' | 'pending' | 'failed',
          type:
            tx.type ||
            ('transfer' as 'transfer' | 'weather_reward' | 'mining_reward'),
        }));
      },
      'getTransactionHistory'
    );
  }

  /**
   * Create a new transaction
   */
  async createTransaction(transactionData: {
    from: string;
    to: string;
    amount: number;
    memo?: string;
  }): Promise<APITransaction> {
    return this.executeWithFallback(
      async () => {
        const result = await this.rustClient.createTransaction(transactionData);
        return {
          hash: result.hash as `0x${string}`,
          from: result.from as EthereumAddress,
          to: result.to as EthereumAddress,
          amount: `${result.value} WRF`,
          fee: `${result.gasPrice || 0.001} WRF`,
          timestamp: result.timestamp,
          blockNumber: result.blockNumber || 0,
          status: result.status as 'confirmed' | 'pending' | 'failed',
          type: 'transfer',
        };
      },
      () => {
        // Use simple blockchain for transaction processing
        const result = simpleBlockchain.processTransaction(
          transactionData.from,
          transactionData.to,
          transactionData.amount,
          transactionData.memo
        );
        return {
          hash: result.hash as `0x${string}`,
          from: result.from as EthereumAddress,
          to: result.to as EthereumAddress,
          amount: `${result.amount} WRF`,
          fee: `${result.fee} WRF`,
          timestamp: new Date(result.timestamp),
          blockNumber: result.blockHeight || 0,
          status: result.status as 'confirmed' | 'pending' | 'failed',
          type: 'transfer',
        };
      },
      'createTransaction'
    );
  }

  /**
   * Process weather data submission and reward
   */
  async processWeatherReward(weatherData: {
    stationId: string;
    temperature: number;
    humidity: number;
    pressure?: number;
    windSpeed?: number;
    windDirection?: number;
    rainfall?: number;
  }): Promise<WeatherReward> {
    return this.executeWithFallback(
      async () => {
        // Could integrate with Rust weather processing
        // For now, use simple calculation
        return this.calculateWeatherReward(weatherData);
      },
      () => {
        return this.calculateWeatherReward(weatherData);
      },
      'processWeatherReward'
    );
  }

  /**
   * Calculate weather reward (shared logic)
   */
  private calculateWeatherReward(weatherData: any): WeatherReward {
    let score = 60; // Base score

    // Temperature validation
    if (weatherData.temperature >= -50 && weatherData.temperature <= 60) {
      score += 10;
    }

    // Humidity validation
    if (weatherData.humidity >= 0 && weatherData.humidity <= 100) {
      score += 10;
    }

    // Pressure validation
    if (weatherData.pressure >= 900 && weatherData.pressure <= 1100) {
      score += 10;
    }

    // Additional sensor bonus
    if (weatherData.windSpeed !== undefined) score += 5;
    if (weatherData.windDirection !== undefined) score += 5;
    if (weatherData.rainfall !== undefined) score += 5;

    const qualityScore = Math.min(score, 100);
    const baseReward = 0.1;
    const bonusMultiplier = Math.min(qualityScore / 100, 2.0);
    const rewardAmount = baseReward * bonusMultiplier;

    return {
      stationId: weatherData.stationId,
      amount: rewardAmount as PositiveNumber,
      timestamp: new Date(),
      achievementTier: Math.floor(qualityScore / 25),
      transactionHash:
        `0x${require('crypto').randomBytes(32).toString('hex')}` as `0x${string}`,
      blockNumber: Math.floor(Math.random() * 1000000) + 500000,
    };
  }

  /**
   * Get mining statistics
   */
  async getMiningStats(): Promise<MiningStats> {
    return this.executeWithFallback(
      async () => {
        return await this.rustClient.getMiningStats();
      },
      () => {
        return {
          hashrate: '1.2 PH/s',
          difficulty: '15.8T',
          blocksFound: 1247,
          lastBlockTime: new Date(),
          estimatedRewards: '45.2 WRF',
        };
      },
      'getMiningStats'
    );
  }

  /**
   * Get network information
   */
  async getNetworkInfo(): Promise<NetworkInfo> {
    return this.executeWithFallback(
      async () => {
        return await this.rustClient.getNetworkInfo();
      },
      () => {
        return {
          chainId: 8888,
          networkName: 'Wrfcoin Mainnet',
          rpcUrl: 'https://rpc.wrfcoin.io',
          blockExplorerUrl: 'https://explorer.wrfcoin.io',
          nativeCurrency: {
            name: 'Wrfcoin',
            symbol: 'WRF',
            decimals: WRF_DECIMALS,
          },
          consensusType: 'PoS',
          blockTime: 5.2,
          finalityBlocks: 12,
        };
      },
      'getNetworkInfo'
    );
  }

  /**
   * Get validator information
   */
  async getValidators(): Promise<ValidatorInfo[]> {
    return this.executeWithFallback(
      async () => {
        return await this.rustClient.getValidators();
      },
      () => {
        return [
          {
            address:
              '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234' as EthereumAddress,
            stake: 50000 as PositiveNumber,
            commission: 5,
            uptime: 99.8,
            blocksProposed: 1250,
            slashingEvents: 0,
            delegators: 450,
            isActive: true,
          },
        ];
      },
      'getValidators'
    );
  }

  /**
   * Get service health status
   */
  async getHealthStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    services: {
      rustBlockchain: boolean;
      simpleBlockchain: boolean;
    };
    timestamp: string;
  }> {
    const rustAvailable = await this.checkRustAvailability();
    const simpleAvailable = simpleBlockchain !== undefined;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    if (!rustAvailable && !simpleAvailable) {
      status = 'unhealthy';
    } else if (!rustAvailable || !simpleAvailable) {
      status = 'degraded';
    }

    return {
      status,
      services: {
        rustBlockchain: rustAvailable,
        simpleBlockchain: simpleAvailable,
      },
      timestamp: new Date().toISOString(),
    };
  }
}

// Export singleton instance
export const enhancedBlockchainService = new EnhancedBlockchainService();
export default enhancedBlockchainService;
