/**
 * Blockchain Modules
 *
 * TypeScript implementation providing core blockchain functionality
 * and module management for the Wrfcoin platform.
 */

import { EventEmitter } from 'events';
import { blockchainLogger } from '../utils/logger.js';
import {
  generateSecureHash,
  generateBlockHash,
  CryptoUtils,
} from '../utils/crypto.js';
import { TokenConstants, NetworkConfig } from '../utils/constants.js';

// Types
export interface Block {
  index: number;
  timestamp: number;
  previousHash: string;
  hash: string;
  merkleRoot: string;
  nonce: number;
  difficulty: number;
  transactions: Transaction[];
  validator?: string;
  gasUsed: number;
  gasLimit: number;
}

export interface Transaction {
  hash: string;
  from: string;
  to: string;
  amount: number;
  gasPrice: number;
  gasLimit: number;
  nonce: number;
  timestamp: number;
  signature: string;
  status: 'pending' | 'confirmed' | 'failed';
}

export interface ChainState {
  height: number;
  difficulty: number;
  totalSupply: number;
  circulatingSupply: number;
  pendingTransactions: Transaction[];
  lastBlock: Block | null;
}

/**
 * Core Blockchain Module
 */
export class BlockchainCore extends EventEmitter {
  private chain: Block[] = [];
  private pendingTransactions: Transaction[] = [];
  private difficulty: number = 4;
  private miningReward: number = TokenConstants.REWARD_PER_BLOCK;
  private crypto: CryptoUtils;

  constructor() {
    super();
    this.crypto = CryptoUtils.getInstance();
    this.createGenesisBlock();
  }

  /**
   * Create the genesis block
   */
  private createGenesisBlock(): void {
    const genesisBlock: Block = {
      index: 0,
      timestamp: Date.now(),
      previousHash: '0',
      hash: '',
      merkleRoot: '',
      nonce: 0,
      difficulty: this.difficulty,
      transactions: [],
      gasUsed: 0,
      gasLimit: 8000000,
    };

    genesisBlock.merkleRoot = this.calculateMerkleRoot(
      genesisBlock.transactions
    );
    genesisBlock.hash = this.calculateBlockHash(genesisBlock);

    this.chain.push(genesisBlock);
    this.emit('blockAdded', genesisBlock);
  }

  /**
   * Get the latest block
   */
  public getLatestBlock(): Block {
    return this.chain[this.chain.length - 1];
  }

  /**
   * Add a new transaction to the pending pool
   */
  public addTransaction(transaction: Transaction): void {
    if (this.validateTransaction(transaction)) {
      this.pendingTransactions.push(transaction);
      this.emit('transactionAdded', transaction);
    } else {
      throw new Error('Invalid transaction');
    }
  }

  /**
   * Mine a new block
   */
  public mineBlock(minerAddress: string): Block {
    const latestBlock = this.getLatestBlock();

    // Include mining reward transaction
    const rewardTransaction: Transaction = {
      hash: this.crypto.hash(`reward-${Date.now()}`),
      from: 'network',
      to: minerAddress,
      amount: this.miningReward,
      gasPrice: 0,
      gasLimit: 21000,
      nonce: 0,
      timestamp: Date.now(),
      signature: 'reward',
      status: 'confirmed',
    };

    const transactions = [...this.pendingTransactions, rewardTransaction];

    const newBlock: Block = {
      index: latestBlock.index + 1,
      timestamp: Date.now(),
      previousHash: latestBlock.hash,
      hash: '',
      merkleRoot: this.calculateMerkleRoot(transactions),
      nonce: 0,
      difficulty: this.difficulty,
      transactions,
      validator: minerAddress,
      gasUsed: this.calculateGasUsed(transactions),
      gasLimit: 8000000,
    };

    // Proof of work mining
    newBlock.hash = this.mineBlockWithProofOfWork(newBlock);

    this.chain.push(newBlock);
    this.pendingTransactions = [];

    this.emit('blockMined', newBlock);
    return newBlock;
  }

  /**
   * Validate a transaction
   */
  private validateTransaction(transaction: Transaction): boolean {
    // Basic validation
    if (!transaction.from || !transaction.to || transaction.amount <= 0) {
      return false;
    }

    // Check if sender has sufficient balance (simplified)
    const balance = this.getBalance(transaction.from);
    return balance >= transaction.amount;
  }

  /**
   * Calculate merkle root of transactions
   */
  private calculateMerkleRoot(transactions: Transaction[]): string {
    if (transactions.length === 0) return '';

    const hashes = transactions.map(tx => tx.hash);
    return this.crypto.hash(hashes.join(''));
  }

  /**
   * Calculate block hash
   */
  private calculateBlockHash(block: Block): string {
    return generateBlockHash(
      block.previousHash,
      block.merkleRoot,
      block.timestamp,
      block.nonce
    );
  }

  /**
   * Mine block with proof of work
   */
  private mineBlockWithProofOfWork(block: Block): string {
    const target = '0'.repeat(this.difficulty);

    while (true) {
      block.hash = this.calculateBlockHash(block);

      if (block.hash.startsWith(target)) {
        blockchainLogger.info('Block mined', { module: 'BlockchainCore', operation: 'mineBlockWithProofOfWork', blockHash: block.hash, nonce: block.nonce, difficulty: this.difficulty });
        return block.hash;
      }

      block.nonce++;
    }
  }

  /**
   * Calculate total gas used by transactions
   */
  private calculateGasUsed(transactions: Transaction[]): number {
    return transactions.reduce((total, tx) => total + tx.gasLimit, 0);
  }

  /**
   * Get balance for an address
   */
  public getBalance(address: string): number {
    let balance = 0;

    for (const block of this.chain) {
      for (const transaction of block.transactions) {
        if (transaction.from === address) {
          balance -= transaction.amount;
        }
        if (transaction.to === address) {
          balance += transaction.amount;
        }
      }
    }

    return balance;
  }

  /**
   * Get chain state
   */
  public getChainState(): ChainState {
    return {
      height: this.chain.length,
      difficulty: this.difficulty,
      totalSupply: TokenConstants.MAX_SUPPLY,
      circulatingSupply: this.calculateCirculatingSupply(),
      pendingTransactions: this.pendingTransactions,
      lastBlock: this.getLatestBlock(),
    };
  }

  /**
   * Calculate circulating supply
   */
  private calculateCirculatingSupply(): number {
    return this.chain.length * this.miningReward;
  }

  /**
   * Validate the entire blockchain
   */
  public validateChain(): boolean {
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];

      if (currentBlock.hash !== this.calculateBlockHash(currentBlock)) {
        return false;
      }

      if (currentBlock.previousHash !== previousBlock.hash) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get block by hash
   */
  public getBlockByHash(hash: string): Block | null {
    return this.chain.find(block => block.hash === hash) || null;
  }

  /**
   * Get transaction by hash
   */
  public getTransactionByHash(hash: string): Transaction | null {
    for (const block of this.chain) {
      const transaction = block.transactions.find(tx => tx.hash === hash);
      if (transaction) return transaction;
    }
    return null;
  }

  /**
   * Get all blocks
   */
  public getAllBlocks(): Block[] {
    return [...this.chain];
  }

  /**
   * Get recent transactions
   */
  public getRecentTransactions(limit: number = 10): Transaction[] {
    const transactions: Transaction[] = [];

    for (
      let i = this.chain.length - 1;
      i >= 0 && transactions.length < limit;
      i--
    ) {
      transactions.push(...this.chain[i].transactions);
    }

    return transactions.slice(0, limit);
  }
}

/**
 * Consensus Module
 */
export class ConsensusModule {
  private blockchain: BlockchainCore;
  private validators: Set<string> = new Set();

  constructor(blockchain: BlockchainCore) {
    this.blockchain = blockchain;
  }

  /**
   * Add a validator
   */
  public addValidator(address: string): void {
    this.validators.add(address);
  }

  /**
   * Remove a validator
   */
  public removeValidator(address: string): void {
    this.validators.delete(address);
  }

  /**
   * Get active validators
   */
  public getValidators(): string[] {
    return Array.from(this.validators);
  }

  /**
   * Validate a block
   */
  public validateBlock(block: Block): boolean {
    // Check if validator is authorized
    if (block.validator && !this.validators.has(block.validator)) {
      return false;
    }

    // Validate block structure and transactions
    return this.blockchain.validateChain();
  }
}

/**
 * Network Module
 */
export class NetworkModule extends EventEmitter {
  private peers: Map<string, any> = new Map();
  private blockchain: BlockchainCore;

  constructor(blockchain: BlockchainCore) {
    super();
    this.blockchain = blockchain;
  }

  /**
   * Add a peer
   */
  public addPeer(peerId: string, peerInfo: any): void {
    this.peers.set(peerId, peerInfo);
    this.emit('peerAdded', peerId);
  }

  /**
   * Remove a peer
   */
  public removePeer(peerId: string): void {
    this.peers.delete(peerId);
    this.emit('peerRemoved', peerId);
  }

  /**
   * Broadcast block to peers
   */
  public broadcastBlock(block: Block): void {
    this.emit('blockBroadcast', block);
  }

  /**
   * Broadcast transaction to peers
   */
  public broadcastTransaction(transaction: Transaction): void {
    this.emit('transactionBroadcast', transaction);
  }

  /**
   * Get network status
   */
  public getNetworkStatus(): any {
    return {
      peers: this.peers.size,
      height: this.blockchain.getChainState().height,
      network: NetworkConfig.MAINNET.name,
    };
  }
}

// Export singleton instances
export const blockchainCore = new BlockchainCore();
export const consensusModule = new ConsensusModule(blockchainCore);
export const networkModule = new NetworkModule(blockchainCore);
