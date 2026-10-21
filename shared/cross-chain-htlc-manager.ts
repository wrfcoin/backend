/**
 * Cross-Chain HTLC (Hash Time-Locked Contract) Manager
 *
 * Implements atomic swap protocols using Hash Time-Locked Contracts for secure
 * cross-chain transfers without double-spending vulnerabilities.
 *
 * Security Features:
 * - Cryptographically secure secret generation
 * - SHA-256 hash locking for commitment
 * - Absolute time locking for refund protection
 * - Atomic claim/refund mechanisms
 * - Multi-chain HTLC coordination
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { blockchainLogger } from '../server/utils/logger.js';

// Network-specific timelock configurations (in seconds)
export const NETWORK_TIMELOCKS = {
  ethereum: 7200,      // 2 hours (12 confirmations * 12s * safety margin)
  polygon: 600,        // 10 minutes (128 confirmations * 2s * safety margin)
  bsc: 900,            // 15 minutes (15 confirmations * 3s * safety margin)
  avalanche: 300,      // 5 minutes (fast finality)
  cosmos: 120,         // 2 minutes (immediate finality)
  osmosis: 120,        // 2 minutes (IBC)
  polkadot: 240,       // 4 minutes (GRANDPA finality)
  kusama: 240,         // 4 minutes (GRANDPA finality)
  bitcoin: 3600,       // 1 hour (6 confirmations * 10min)
  optimism: 1800,      // 30 minutes (L2 settlement)
  arbitrum: 1800,      // 30 minutes (L2 settlement)
  base: 1800,          // 30 minutes (L2 settlement)
  near: 180,           // 3 minutes (fast finality)
  solana: 60,          // 1 minute (very fast finality)
} as const;

export type SupportedNetwork = keyof typeof NETWORK_TIMELOCKS;

export interface HTLCSecret {
  secret: Buffer;
  hash: string;
  algorithm: 'sha256';
}

export interface HTLCContract {
  id: string;
  sourceChain: SupportedNetwork;
  destinationChain: SupportedNetwork;
  sender: string;
  recipient: string;
  amount: string;
  asset: string;
  secretHash: string;
  timeLock: number; // Unix timestamp
  refundTimeLock: number; // Unix timestamp
  status: HTLCStatus;
  createdAt: Date;
  claimedAt?: Date;
  refundedAt?: Date;
  secret?: string; // Revealed when claimed
  transactionHashes: {
    source?: string;
    destination?: string;
    refund?: string;
  };
}

export enum HTLCStatus {
  PENDING = 'PENDING',
  LOCKED = 'LOCKED',
  CLAIMED = 'CLAIMED',
  REFUNDED = 'REFUNDED',
  EXPIRED = 'EXPIRED',
  FAILED = 'FAILED',
}

export interface HTLCCreateParams {
  sourceChain: SupportedNetwork;
  destinationChain: SupportedNetwork;
  sender: string;
  recipient: string;
  amount: string;
  asset: string;
  customTimeLock?: number; // Optional custom timelock duration
}

export interface HTLCClaimParams {
  htlcId: string;
  secret: string;
  claimant: string;
}

export interface HTLCRefundParams {
  htlcId: string;
  refundTo: string;
}

export class CrossChainHTLCManager extends EventEmitter {
  private htlcs: Map<string, HTLCContract> = new Map();
  private secretRegistry: Map<string, HTLCSecret> = new Map();
  private readonly MIN_TIMELOCK_DURATION = 60; // 1 minute minimum
  private readonly MAX_TIMELOCK_DURATION = 86400; // 24 hours maximum
  private readonly REFUND_GRACE_PERIOD = 3600; // 1 hour grace period
  /**
   * #977: the expiration monitor's handle. Previously the `setInterval` return
   * was discarded, so the timer could be neither unref'd nor cleared — the
   * module-scope singleton below leaked it for the life of the process.
   */
  private expirationMonitor?: ReturnType<typeof setInterval>;

  constructor() {
    super();
    this.startExpirationMonitor();
  }

  /**
   * Generate cryptographically secure secret for HTLC
   */
  public generateSecret(): HTLCSecret {
    // Generate 32 bytes of cryptographically secure random data
    const secret = crypto.randomBytes(32);

    // Create SHA-256 hash of the secret
    const hash = crypto.createHash('sha256').update(secret).digest('hex');

    const htlcSecret: HTLCSecret = {
      secret,
      hash,
      algorithm: 'sha256',
    };

    // Store secret in registry (will be cleared after use)
    this.secretRegistry.set(hash, htlcSecret);

    this.emit('secret:generated', { hash });

    return htlcSecret;
  }

  /**
   * Verify secret matches hash
   */
  public verifySecret(secret: string, hash: string): boolean {
    try {
      const secretBuffer = Buffer.from(secret, 'hex');
      const computedHash = crypto.createHash('sha256')
        .update(secretBuffer)
        .digest('hex');

      return computedHash === hash;
    } catch (error) {
      blockchainLogger.error('Secret verification failed', { module: 'HTLCManager', error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Create new HTLC contract
   */
  public async createHTLC(params: HTLCCreateParams): Promise<HTLCContract> {
    // Validate parameters
    this.validateHTLCParams(params);

    // Generate unique HTLC ID
    const htlcId = this.generateHTLCId(params);

    // Generate secret and hash
    const { secret, hash } = this.generateSecret();

    // Calculate timelocks
    const sourceTimeLock = params.customTimeLock ||
      NETWORK_TIMELOCKS[params.sourceChain];

    const destinationTimeLock = Math.floor(sourceTimeLock / 2);

    // Ensure destination timelock is before source timelock
    if (destinationTimeLock >= sourceTimeLock) {
      throw new Error('Invalid timelock configuration: destination must expire before source');
    }

    const now = Math.floor(Date.now() / 1000);
    const refundTimeLock = now + sourceTimeLock + this.REFUND_GRACE_PERIOD;

    const htlc: HTLCContract = {
      id: htlcId,
      sourceChain: params.sourceChain,
      destinationChain: params.destinationChain,
      sender: params.sender,
      recipient: params.recipient,
      amount: params.amount,
      asset: params.asset,
      secretHash: hash,
      timeLock: now + destinationTimeLock,
      refundTimeLock,
      status: HTLCStatus.PENDING,
      createdAt: new Date(),
      transactionHashes: {},
    };

    // Store HTLC
    this.htlcs.set(htlcId, htlc);

    this.emit('htlc:created', {
      htlcId,
      sourceChain: params.sourceChain,
      destinationChain: params.destinationChain,
      amount: params.amount,
      secretHash: hash,
    });

    return htlc;
  }

  /**
   * Lock assets on source chain (called after on-chain lock)
   */
  public async lockHTLC(
    htlcId: string,
    transactionHash: string
  ): Promise<HTLCContract> {
    const htlc = this.htlcs.get(htlcId);

    if (!htlc) {
      throw new Error(`HTLC not found: ${htlcId}`);
    }

    if (htlc.status !== HTLCStatus.PENDING) {
      throw new Error(`Invalid HTLC status for locking: ${htlc.status}`);
    }

    // Update status and transaction hash
    htlc.status = HTLCStatus.LOCKED;
    htlc.transactionHashes.source = transactionHash;

    this.emit('htlc:locked', {
      htlcId,
      chain: htlc.sourceChain,
      transactionHash,
    });

    return htlc;
  }

  /**
   * Claim HTLC with secret reveal
   */
  public async claimHTLC(params: HTLCClaimParams): Promise<HTLCContract> {
    const htlc = this.htlcs.get(params.htlcId);

    if (!htlc) {
      throw new Error(`HTLC not found: ${params.htlcId}`);
    }

    // Verify HTLC is locked
    if (htlc.status !== HTLCStatus.LOCKED) {
      throw new Error(`Invalid HTLC status for claiming: ${htlc.status}`);
    }

    // Verify timelock has not expired
    const now = Math.floor(Date.now() / 1000);
    if (now > htlc.timeLock) {
      htlc.status = HTLCStatus.EXPIRED;
      throw new Error('HTLC timelock expired');
    }

    // Verify secret matches hash
    if (!this.verifySecret(params.secret, htlc.secretHash)) {
      throw new Error('Invalid secret provided');
    }

    // Verify claimant is the recipient
    if (params.claimant.toLowerCase() !== htlc.recipient.toLowerCase()) {
      throw new Error('Unauthorized: claimant is not the recipient');
    }

    // Update HTLC status
    htlc.status = HTLCStatus.CLAIMED;
    htlc.secret = params.secret;
    htlc.claimedAt = new Date();

    this.emit('htlc:claimed', {
      htlcId: params.htlcId,
      recipient: htlc.recipient,
      amount: htlc.amount,
      secret: params.secret,
      secretHash: htlc.secretHash,
    });

    // Clear secret from registry for security
    this.secretRegistry.delete(htlc.secretHash);

    return htlc;
  }

  /**
   * Refund HTLC after timelock expiration
   */
  public async refundHTLC(params: HTLCRefundParams): Promise<HTLCContract> {
    const htlc = this.htlcs.get(params.htlcId);

    if (!htlc) {
      throw new Error(`HTLC not found: ${params.htlcId}`);
    }

    // Verify HTLC is locked or expired
    if (htlc.status !== HTLCStatus.LOCKED && htlc.status !== HTLCStatus.EXPIRED) {
      throw new Error(`Invalid HTLC status for refund: ${htlc.status}`);
    }

    // Verify refund timelock has expired
    const now = Math.floor(Date.now() / 1000);
    if (now < htlc.refundTimeLock) {
      throw new Error(
        `Refund timelock not yet expired. Expires at: ${new Date(htlc.refundTimeLock * 1000).toISOString()}`
      );
    }

    // Verify refund recipient is the sender
    if (params.refundTo.toLowerCase() !== htlc.sender.toLowerCase()) {
      throw new Error('Unauthorized: refund must go to original sender');
    }

    // Update HTLC status
    htlc.status = HTLCStatus.REFUNDED;
    htlc.refundedAt = new Date();

    this.emit('htlc:refunded', {
      htlcId: params.htlcId,
      sender: htlc.sender,
      amount: htlc.amount,
      reason: 'timelock_expired',
    });

    // Clear secret from registry
    this.secretRegistry.delete(htlc.secretHash);

    return htlc;
  }

  /**
   * Get HTLC by ID
   */
  public getHTLC(htlcId: string): HTLCContract | undefined {
    return this.htlcs.get(htlcId);
  }

  /**
   * Get all HTLCs for an address
   */
  public getHTLCsForAddress(address: string): HTLCContract[] {
    const normalizedAddress = address.toLowerCase();
    return Array.from(this.htlcs.values()).filter(
      htlc =>
        htlc.sender.toLowerCase() === normalizedAddress ||
        htlc.recipient.toLowerCase() === normalizedAddress
    );
  }

  /**
   * Get HTLCs by status
   */
  public getHTLCsByStatus(status: HTLCStatus): HTLCContract[] {
    return Array.from(this.htlcs.values()).filter(htlc => htlc.status === status);
  }

  /**
   * Get secret for HTLC (only before claim)
   */
  public getSecret(secretHash: string): HTLCSecret | undefined {
    return this.secretRegistry.get(secretHash);
  }

  /**
   * Validate HTLC creation parameters
   */
  private validateHTLCParams(params: HTLCCreateParams): void {
    if (!params.sourceChain || !NETWORK_TIMELOCKS[params.sourceChain]) {
      throw new Error(`Unsupported source chain: ${params.sourceChain}`);
    }

    if (!params.destinationChain || !NETWORK_TIMELOCKS[params.destinationChain]) {
      throw new Error(`Unsupported destination chain: ${params.destinationChain}`);
    }

    if (!params.sender || !this.isValidAddress(params.sender, params.sourceChain)) {
      throw new Error(`Invalid sender address for ${params.sourceChain}`);
    }

    if (!params.recipient || !this.isValidAddress(params.recipient, params.destinationChain)) {
      throw new Error(`Invalid recipient address for ${params.destinationChain}`);
    }

    if (!params.amount || BigInt(params.amount) <= 0n) {
      throw new Error('Amount must be greater than 0');
    }

    if (!params.asset || params.asset.trim() === '') {
      throw new Error('Asset identifier is required');
    }

    if (params.customTimeLock) {
      if (params.customTimeLock < this.MIN_TIMELOCK_DURATION) {
        throw new Error(
          `Custom timelock too short. Minimum: ${this.MIN_TIMELOCK_DURATION}s`
        );
      }
      if (params.customTimeLock > this.MAX_TIMELOCK_DURATION) {
        throw new Error(
          `Custom timelock too long. Maximum: ${this.MAX_TIMELOCK_DURATION}s`
        );
      }
    }
  }

  /**
   * Basic address validation (can be enhanced per chain)
   */
  private isValidAddress(address: string, chain: SupportedNetwork): boolean {
    // EVM chains
    const evmChains: SupportedNetwork[] = [
      'ethereum', 'polygon', 'bsc', 'avalanche', 'optimism', 'arbitrum', 'base'
    ];

    if (evmChains.includes(chain)) {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    // Cosmos chains
    if (chain === 'cosmos' || chain === 'osmosis') {
      return /^(cosmos|osmo)[a-z0-9]{39}$/.test(address);
    }

    // Polkadot/Kusama
    if (chain === 'polkadot' || chain === 'kusama') {
      return address.length >= 47 && address.length <= 48;
    }

    // Bitcoin
    if (chain === 'bitcoin') {
      return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address) ||
             /^bc1[a-z0-9]{39,59}$/.test(address);
    }

    // NEAR
    if (chain === 'near') {
      return /^[a-z0-9._-]+$/.test(address);
    }

    // Solana
    if (chain === 'solana') {
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    }

    return true; // Default to true for unknown chains
  }

  /**
   * Generate unique HTLC ID
   */
  private generateHTLCId(params: HTLCCreateParams): string {
    const data = JSON.stringify({
      sourceChain: params.sourceChain,
      destinationChain: params.destinationChain,
      sender: params.sender,
      recipient: params.recipient,
      amount: params.amount,
      asset: params.asset,
      timestamp: Date.now(),
      random: crypto.randomBytes(16).toString('hex'),
    });

    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Monitor for expired HTLCs
   */
  private startExpirationMonitor(): void {
    // #977: assigned and unref'd (it was previously discarded, so it could not
    // even be cleared). The constructor calls this and the module exports a
    // module-scope singleton (`export const htlcManager = new
    // CrossChainHTLCManager()`), so importing this file — or anything that
    // re-exports it, e.g. shared/bridge-rollback-coordinator.ts — starts a timer
    // that holds the event loop open.
    this.expirationMonitor = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);

      for (const htlc of this.htlcs.values()) {
        // Mark locked HTLCs as expired if timelock passed
        if (htlc.status === HTLCStatus.LOCKED && now > htlc.timeLock) {
          htlc.status = HTLCStatus.EXPIRED;
          this.emit('htlc:expired', {
            htlcId: htlc.id,
            timeLock: htlc.timeLock,
            now,
          });
        }
      }
    }, 30000); // Check every 30 seconds
    this.expirationMonitor.unref();
  }

  /**
   * Get HTLC statistics
   */
  public getStatistics() {
    const stats = {
      total: this.htlcs.size,
      pending: 0,
      locked: 0,
      claimed: 0,
      refunded: 0,
      expired: 0,
      failed: 0,
      byChain: {} as Record<string, number>,
    };

    for (const htlc of this.htlcs.values()) {
      stats[htlc.status.toLowerCase() as keyof typeof stats]++;

      const chainPair = `${htlc.sourceChain}-${htlc.destinationChain}`;
      stats.byChain[chainPair] = (stats.byChain[chainPair] || 0) + 1;
    }

    return stats;
  }

  /**
   * Clean up old completed HTLCs
   */
  public cleanup(olderThanDays: number = 30): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    let cleaned = 0;
    for (const [id, htlc] of this.htlcs.entries()) {
      const isCompleted =
        htlc.status === HTLCStatus.CLAIMED ||
        htlc.status === HTLCStatus.REFUNDED ||
        htlc.status === HTLCStatus.FAILED;

      if (isCompleted && htlc.createdAt < cutoffDate) {
        this.htlcs.delete(id);
        this.secretRegistry.delete(htlc.secretHash);
        cleaned++;
      }
    }

    this.emit('cleanup:completed', { cleaned, cutoffDate });
    return cleaned;
  }
}

// Singleton instance
export const htlcManager = new CrossChainHTLCManager();
