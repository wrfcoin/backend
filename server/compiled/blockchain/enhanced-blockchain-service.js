'use strict';
/**
 * Enhanced Blockchain Service
 * Manages integration between Rust blockchain core and Node.js simple blockchain
 * Provides fallback functionality and data transformation
 */
Object.defineProperty(exports, '__esModule', { value: true });
exports.enhancedBlockchainService = exports.EnhancedBlockchainService = void 0;
const rust_blockchain_client_1 = require('./rust-blockchain-client');
// Import the simple blockchain for fallback
const simpleBlockchain = require('./simple-blockchain');
// Import Winston logger for structured logging
const { blockchainLogger } = require('../../utils/logger');
/**
 * Enhanced blockchain service with Rust integration and fallback
 */
class EnhancedBlockchainService {
  constructor(config = {}) {
    this.isRustAvailable = false;
    this.config = {
      useRustBlockchain: process.env.USE_RUST_BLOCKCHAIN !== 'false',
      fallbackToSimple: process.env.FALLBACK_TO_SIMPLE !== 'false',
      rustApiTimeout: parseInt(process.env.RUST_API_TIMEOUT || '5000'),
      ...config,
    };
    this.rustClient = rust_blockchain_client_1.rustBlockchainClient;
    this.initializeRustConnection();
  }
  /**
   * Initialize connection to Rust blockchain
   */
  async initializeRustConnection() {
    if (!this.config.useRustBlockchain) {
      blockchainLogger.info('Rust blockchain integration disabled, using simple blockchain only', {
        service: 'enhanced-blockchain',
        operation: 'initialize'
      });
      return;
    }
    try {
      this.isRustAvailable = await this.rustClient.isAvailable();
      if (this.isRustAvailable) {
        blockchainLogger.info('Connected to Rust blockchain core', {
          service: 'enhanced-blockchain',
          operation: 'initialize',
          status: 'connected'
        });
      } else {
        blockchainLogger.warn('Rust blockchain core unavailable, using fallback', {
          service: 'enhanced-blockchain',
          operation: 'initialize',
          status: 'fallback'
        });
      }
    } catch (error) {
      blockchainLogger.error('Failed to connect to Rust blockchain', {
        service: 'enhanced-blockchain',
        operation: 'initialize',
        error: error.message
      });
      this.isRustAvailable = false;
    }
  }
  /**
   * Check Rust API availability and update status
   */
  async checkRustAvailability() {
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
  async executeWithFallback(rustOperation, fallbackOperation, operationName) {
    // Always check availability for critical operations
    if (this.config.useRustBlockchain && (await this.checkRustAvailability())) {
      try {
        blockchainLogger.debug(`Executing ${operationName} via Rust blockchain`, {
          service: 'enhanced-blockchain',
          operation: operationName,
          backend: 'rust'
        });
        return await rustOperation();
      } catch (error) {
        blockchainLogger.error(`Rust ${operationName} failed`, {
          service: 'enhanced-blockchain',
          operation: operationName,
          error: error.message
        });
        if (!this.config.fallbackToSimple) {
          throw error;
        }
        blockchainLogger.warn(`Falling back to simple blockchain for ${operationName}`, {
          service: 'enhanced-blockchain',
          operation: operationName,
          reason: 'rust_failure'
        });
      }
    }
    // Use simple blockchain fallback
    blockchainLogger.debug(`Executing ${operationName} via simple blockchain`, {
      service: 'enhanced-blockchain',
      operation: operationName,
      backend: 'simple'
    });
    return await fallbackOperation();
  }
  /**
   * Get comprehensive dashboard statistics
   */
  async getDashboardStats() {
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
  async getWalletBalance(address) {
    return this.executeWithFallback(
      async () => {
        const wallet = await this.rustClient.getAddressBalance(address);
        return {
          address: address,
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
          address: address,
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
  async getTransactionHistory(address, page = 1, limit = 20) {
    return this.executeWithFallback(
      async () => {
        const transactions = await this.rustClient.getAddressTransactions(
          address,
          page,
          limit
        );
        return transactions.map(tx => ({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          amount: `${tx.value} WRF`,
          fee: `${tx.gasPrice || 0.001} WRF`,
          timestamp: tx.timestamp,
          blockNumber: tx.blockNumber || 0,
          status: tx.status,
          type: tx.type,
        }));
      },
      () => {
        // Use simple blockchain transaction history
        const history = simpleBlockchain.getTransactionHistory(address);
        return history.map(tx => ({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          amount: `${tx.amount} WRF`,
          fee: `${tx.fee} WRF`,
          timestamp: new Date(tx.timestamp),
          blockNumber: tx.blockHeight || 0,
          status: tx.status,
          type: tx.type || 'transfer',
        }));
      },
      'getTransactionHistory'
    );
  }
  /**
   * Create a new transaction
   */
  async createTransaction(transactionData) {
    return this.executeWithFallback(
      async () => {
        const result = await this.rustClient.createTransaction(transactionData);
        return {
          hash: result.hash,
          from: result.from,
          to: result.to,
          amount: `${result.value} WRF`,
          fee: `${result.gasPrice || 0.001} WRF`,
          timestamp: result.timestamp,
          blockNumber: result.blockNumber || 0,
          status: result.status,
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
          hash: result.hash,
          from: result.from,
          to: result.to,
          amount: `${result.amount} WRF`,
          fee: `${result.fee} WRF`,
          timestamp: new Date(result.timestamp),
          blockNumber: result.blockHeight || 0,
          status: result.status,
          type: 'transfer',
        };
      },
      'createTransaction'
    );
  }
  /**
   * Process weather data submission and reward
   */
  async processWeatherReward(weatherData) {
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
  calculateWeatherReward(weatherData) {
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
      amount: rewardAmount,
      timestamp: new Date(),
      achievementTier: Math.floor(qualityScore / 25),
      transactionHash: `0x${require('crypto').randomBytes(32).toString('hex')}`,
      blockNumber: Math.floor(Math.random() * 1000000) + 500000,
    };
  }
  /**
   * Get mining statistics
   */
  async getMiningStats() {
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
  async getNetworkInfo() {
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
            decimals: 18,
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
  async getValidators() {
    return this.executeWithFallback(
      async () => {
        return await this.rustClient.getValidators();
      },
      () => {
        return [
          {
            address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
            stake: 50000,
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
  async getHealthStatus() {
    const rustAvailable = await this.checkRustAvailability();
    const simpleAvailable = simpleBlockchain !== undefined;
    let status = 'healthy';
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
exports.EnhancedBlockchainService = EnhancedBlockchainService;
// Export singleton instance
exports.enhancedBlockchainService = new EnhancedBlockchainService();
exports.default = exports.enhancedBlockchainService;
