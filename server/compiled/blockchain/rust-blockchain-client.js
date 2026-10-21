'use strict';
/**
 * Rust Blockchain Client
 * HTTP client to interface with the Rust blockchain core API
 */
const __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.rustBlockchainClient = exports.RustBlockchainClient = void 0;
const axios_1 = __importDefault(require('axios'));
// Import Winston logger for structured logging
const { blockchainLogger } = require('../../utils/logger');
/**
 * Client for interfacing with Rust blockchain core
 */
class RustBlockchainClient {
  constructor(config = {}) {
    this.config = {
      baseUrl: process.env.RUST_BLOCKCHAIN_URL || 'http://localhost:8000',
      timeout: parseInt(process.env.RUST_BLOCKCHAIN_TIMEOUT || '10000'),
      retries: parseInt(process.env.RUST_BLOCKCHAIN_RETRIES || '3'),
      ...config,
    };
    this.client = axios_1.default.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WrfCoin-NodeJS-API/1.0',
      },
    });
    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      error => {
        blockchainLogger.error(`Rust blockchain API error: ${error.message}`, {
          service: 'rust-blockchain-client',
          operation: 'api_request',
          status: error.response?.status,
          data: error.response?.data
        });
        throw error;
      }
    );
  }
  /**
   * Get blockchain summary statistics
   */
  async getBlockchainSummary() {
    try {
      const response = await this.client.get('/api/blockchain');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get blockchain summary', {
        service: 'rust-blockchain-client',
        operation: 'getBlockchainSummary',
        error: error.message
      });
      throw new Error('Blockchain API unavailable');
    }
  }
  /**
   * Get recent blocks
   */
  async getRecentBlocks(limit = 10) {
    try {
      const response = await this.client.get('/api/blockchain/blocks/recent', {
        params: { limit },
      });
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get recent blocks', {
        service: 'rust-blockchain-client',
        operation: 'getRecentBlocks',
        limit,
        error: error.message
      });
      throw new Error('Blockchain API unavailable');
    }
  }
  /**
   * Get block by hash
   */
  async getBlockByHash(hash) {
    try {
      const response = await this.client.get(
        `/api/blockchain/block/hash/${hash}`
      );
      return response.data;
    } catch (error) {
      blockchainLogger.error(`Failed to get block by hash`, {
        service: 'rust-blockchain-client',
        operation: 'getBlockByHash',
        blockHash: hash,
        error: error.message
      });
      throw new Error('Block not found');
    }
  }
  /**
   * Get block by height
   */
  async getBlockByHeight(height) {
    try {
      const response = await this.client.get(
        `/api/blockchain/block/height/${height}`
      );
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get block by height', {
        service: 'rust-blockchain-client',
        operation: 'getBlockByHeight',
        blockHeight: height,
        error: error.message
      });
      throw new Error('Block not found');
    }
  }
  /**
   * Get address balance
   */
  async getAddressBalance(address) {
    try {
      const response = await this.client.get(`/api/address/${address}/balance`);
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get address balance', {
        service: 'rust-blockchain-client',
        operation: 'getAddressBalance',
        address,
        error: error.message
      });
      throw new Error('Address not found');
    }
  }
  /**
   * Get transactions for address
   */
  async getAddressTransactions(address, page = 1, limit = 20) {
    try {
      const response = await this.client.get(
        `/api/address/${address}/transactions`,
        {
          params: { page, limit },
        }
      );
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get address transactions', {
        service: 'rust-blockchain-client',
        operation: 'getAddressTransactions',
        address,
        page,
        limit,
        error: error.message
      });
      throw new Error('Address not found');
    }
  }
  /**
   * Create new transaction
   */
  async createTransaction(transactionData) {
    try {
      const response = await this.client.post(
        '/api/transactions',
        transactionData
      );
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to create transaction', {
        service: 'rust-blockchain-client',
        operation: 'createTransaction',
        error: error.message
      });
      throw new Error('Transaction creation failed');
    }
  }
  /**
   * Get transaction by ID
   */
  async getTransactionById(txId) {
    try {
      const response = await this.client.get(`/api/transactions/${txId}`);
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get transaction by ID', {
        service: 'rust-blockchain-client',
        operation: 'getTransactionById',
        transactionId: txId,
        error: error.message
      });
      throw new Error('Transaction not found');
    }
  }
  /**
   * Get all NFTs
   */
  async getAllNFTs(page = 1, limit = 20) {
    try {
      const response = await this.client.get('/api/nft', {
        params: { page, limit },
      });
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get NFTs', {
        service: 'rust-blockchain-client',
        operation: 'getAllNFTs',
        page,
        limit,
        error: error.message
      });
      throw new Error('NFT API unavailable');
    }
  }
  /**
   * Get NFT by ID
   */
  async getNFTById(nftId) {
    try {
      const response = await this.client.get(`/api/nft/${nftId}`);
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get NFT by ID', {
        service: 'rust-blockchain-client',
        operation: 'getNFTById',
        nftId,
        error: error.message
      });
      throw new Error('NFT not found');
    }
  }
  /**
   * Create new NFT
   */
  async createNFT(nftData) {
    try {
      const response = await this.client.post('/api/nft', nftData);
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to create NFT', {
        service: 'rust-blockchain-client',
        operation: 'createNFT',
        error: error.message
      });
      throw new Error('NFT creation failed');
    }
  }
  /**
   * Get mining statistics
   */
  async getMiningStats() {
    try {
      const response = await this.client.get('/api/mining/stats');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get mining stats', {
        service: 'rust-blockchain-client',
        operation: 'getMiningStats',
        error: error.message
      });
      throw new Error('Mining API unavailable');
    }
  }
  /**
   * Get network information
   */
  async getNetworkInfo() {
    try {
      const response = await this.client.get('/api/network');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get network info', {
        service: 'rust-blockchain-client',
        operation: 'getNetworkInfo',
        error: error.message
      });
      throw new Error('Network API unavailable');
    }
  }
  /**
   * Get validator information
   */
  async getValidators() {
    try {
      const response = await this.client.get('/api/validators');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get validators', {
        service: 'rust-blockchain-client',
        operation: 'getValidators',
        error: error.message
      });
      throw new Error('Validator API unavailable');
    }
  }
  /**
   * Health check
   */
  async healthCheck() {
    try {
      const response = await this.client.get('/health');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Health check failed', {
        service: 'rust-blockchain-client',
        operation: 'healthCheck',
        error: error.message
      });
      throw new Error('Rust blockchain API is down');
    }
  }
  /**
   * Check if Rust blockchain API is available
   */
  async isAvailable() {
    try {
      await this.healthCheck();
      return true;
    } catch (error) {
      return false;
    }
  }
}
exports.RustBlockchainClient = RustBlockchainClient;
// Export singleton instance
exports.rustBlockchainClient = new RustBlockchainClient();
exports.default = exports.rustBlockchainClient;
