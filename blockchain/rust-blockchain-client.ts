/**
 * Rust Blockchain Client
 * HTTP client to interface with the Rust blockchain core API
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { blockchainLogger } from '../server/utils/logger.js';
import { getCore4ApiUrl } from '../src/config/core4.js';
import {
  Block,
  Transaction,
  Wallet,
  TokenBalance,
  NetworkInfo,
  ValidatorInfo,
  WeatherDataBlock,
} from '../shared/types/blockchain-types.js';

import { NFT, MiningStats } from '../shared/types/api-types.js';

import { EthereumAddress } from '../shared/types/security-types.js';

interface RustApiConfig {
  baseUrl: string;
  timeout: number;
  retries: number;
}

/**
 * Client for interfacing with Rust blockchain core
 */
export class RustBlockchainClient {
  private client: AxiosInstance;
  private config: RustApiConfig;

  constructor(config: Partial<RustApiConfig> = {}) {
    this.config = {
      baseUrl: getCore4ApiUrl(),
      timeout: parseInt(process.env.RUST_BLOCKCHAIN_TIMEOUT || '10000', 10),
      retries: parseInt(process.env.RUST_BLOCKCHAIN_RETRIES || '3', 10),
      ...config,
    };

    this.client = axios.create({
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
      (error: AxiosError) => {
        blockchainLogger.error('Rust blockchain API error', {
          error: error.message,
          status: error.response?.status,
          data: error.response?.data,
        });
        throw error;
      }
    );
  }

  /**
   * Get blockchain summary statistics
   */
  async getBlockchainSummary(): Promise<any> {
    try {
      const response = await this.client.get('/api/blockchain');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get blockchain summary', {
        error: (error as Error).message,
      });
      throw new Error('Blockchain API unavailable');
    }
  }

  /**
   * Get recent blocks
   */
  async getRecentBlocks(limit: number = 10): Promise<Block[]> {
    try {
      const response = await this.client.get('/api/blockchain/blocks/recent', {
        params: { limit },
      });
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get recent blocks', {
        error: (error as Error).message,
        limit,
      });
      throw new Error('Blockchain API unavailable');
    }
  }

  /**
   * Get block by hash
   */
  async getBlockByHash(hash: string): Promise<Block> {
    try {
      const response = await this.client.get(
        `/api/blockchain/block/hash/${hash}`
      );
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get block by hash', {
        error: (error as Error).message,
        hash,
      });
      throw new Error('Block not found');
    }
  }

  /**
   * Get block by height
   */
  async getBlockByHeight(height: number): Promise<Block> {
    try {
      const response = await this.client.get(
        `/api/blockchain/block/height/${height}`
      );
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get block at height', {
        error: (error as Error).message,
        height,
      });
      throw new Error('Block not found');
    }
  }

  /**
   * Get address balance
   */
  async getAddressBalance(address: string): Promise<Wallet> {
    try {
      const response = await this.client.get(`/api/address/${address}/balance`);
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get address balance', {
        error: (error as Error).message,
        address,
      });
      throw new Error('Address not found');
    }
  }

  /**
   * Get transactions for address
   */
  async getAddressTransactions(
    address: string,
    page: number = 1,
    limit: number = 20
  ): Promise<Transaction[]> {
    try {
      const response = await this.client.get(
        `/api/address/${address}/transactions`,
        {
          params: { page, limit },
        }
      );
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get transactions for address', {
        error: (error as Error).message,
        address,
        page,
        limit,
      });
      throw new Error('Address not found');
    }
  }

  /**
   * Create new transaction
   */
  async createTransaction(transactionData: {
    from: string;
    to: string;
    amount: number;
    token?: string;
    memo?: string;
  }): Promise<Transaction> {
    try {
      const response = await this.client.post(
        '/api/transactions',
        transactionData
      );
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to create transaction', {
        error: (error as Error).message,
        from: transactionData.from,
        to: transactionData.to,
        amount: transactionData.amount,
      });
      throw new Error('Transaction creation failed');
    }
  }

  /**
   * Get transaction by ID
   */
  async getTransactionById(txId: string): Promise<Transaction> {
    try {
      const response = await this.client.get(`/api/transactions/${txId}`);
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get transaction by ID', {
        error: (error as Error).message,
        txId,
      });
      throw new Error('Transaction not found');
    }
  }

  /**
   * Get all NFTs
   */
  async getAllNFTs(page: number = 1, limit: number = 20): Promise<NFT[]> {
    try {
      const response = await this.client.get('/api/nft', {
        params: { page, limit },
      });
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get NFTs', {
        error: (error as Error).message,
        page,
        limit,
      });
      throw new Error('NFT API unavailable');
    }
  }

  /**
   * Get NFT by ID
   */
  async getNFTById(nftId: string): Promise<NFT> {
    try {
      const response = await this.client.get(`/api/nft/${nftId}`);
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get NFT by ID', {
        error: (error as Error).message,
        nftId,
      });
      throw new Error('NFT not found');
    }
  }

  /**
   * Create new NFT
   */
  async createNFT(nftData: {
    name: string;
    description: string;
    image: string;
    creator: string;
    attributes?: Array<{ trait_type: string; value: string; rarity?: number }>;
  }): Promise<NFT> {
    try {
      const response = await this.client.post('/api/nft', nftData);
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to create NFT', {
        error: (error as Error).message,
        name: nftData.name,
        creator: nftData.creator,
      });
      throw new Error('NFT creation failed');
    }
  }

  /**
   * Get mining statistics
   */
  async getMiningStats(): Promise<MiningStats> {
    try {
      const response = await this.client.get('/api/mining/stats');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get mining stats', {
        error: (error as Error).message,
      });
      throw new Error('Mining API unavailable');
    }
  }

  /**
   * Get network information
   */
  async getNetworkInfo(): Promise<NetworkInfo> {
    try {
      const response = await this.client.get('/api/network');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get network info', {
        error: (error as Error).message,
      });
      throw new Error('Network API unavailable');
    }
  }

  /**
   * Get validator information
   */
  async getValidators(): Promise<ValidatorInfo[]> {
    try {
      const response = await this.client.get('/api/validators');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Failed to get validators', {
        error: (error as Error).message,
      });
      throw new Error('Validator API unavailable');
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    try {
      const response = await this.client.get('/health');
      return response.data;
    } catch (error) {
      blockchainLogger.error('Health check failed', {
        error: (error as Error).message,
      });
      throw new Error('Rust blockchain API is down');
    }
  }

  /**
   * Check if Rust blockchain API is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.healthCheck();
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Export singleton instance
export const rustBlockchainClient = new RustBlockchainClient();
export default rustBlockchainClient;
