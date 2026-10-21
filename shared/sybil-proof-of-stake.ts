/**
 * Sybil Attack Prevention - Proof-of-Stake Verification System
 *
 * Implements comprehensive stake-based node registration requirements
 * to prevent Sybil attacks through economic barriers.
 */

import { createHash, randomBytes } from 'crypto';
import { ethers } from 'ethers';
import { securityLogger } from '../server/utils/logger.js';

export interface StakeRequirement {
  minStake: string; // WRF tokens (in wei)
  minDuration: number; // seconds
  slashingPercentage: number; // 0-100
  dynamicAdjustment: boolean;
}

export interface StakeProof {
  nodeId: string;
  stakeAmount: string;
  stakeAddress: string;
  stakeTxHash: string;
  blockNumber: number;
  timestamp: number;
  maturityTime: number;
  signature: string;
  chainId: number;
}

export interface StakeVerificationResult {
  isValid: boolean;
  stakeAmount: string;
  maturityStatus: 'immature' | 'mature' | 'expired';
  remainingTime: number;
  slashingRisk: number;
  errors: string[];
}

export interface SlashingEvent {
  nodeId: string;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  slashedAmount: string;
  remainingStake: string;
  timestamp: Date;
  txHash: string;
}

export interface DynamicStakeAdjustment {
  currentMinStake: string;
  adjustmentFactor: number;
  networkConditions: {
    totalNodes: number;
    avgStake: string;
    networkSecurity: number;
  };
  nextAdjustment: Date;
}

/**
 * Proof-of-Stake Verification System
 * Manages stake requirements, verification, and slashing
 */
export class ProofOfStakeManager {
  private readonly MIN_STAKE_DEFAULT = '1000000000000000000000'; // 1000 WRF
  private readonly MIN_DURATION_DEFAULT = 30 * 24 * 60 * 60; // 30 days
  private readonly SLASHING_PERCENTAGE_DEFAULT = 50; // 50%

  private stakeRegistry = new Map<string, StakeProof>();
  private slashingHistory = new Map<string, SlashingEvent[]>();
  private currentRequirements: StakeRequirement;

  private provider: ethers.Provider;
  private wrfTokenContract: ethers.Contract;
  private stakingContract: ethers.Contract;

  constructor(
    providerUrl: string,
    wrfTokenAddress: string,
    stakingContractAddress: string
  ) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);

    // WRF Token ABI (minimal for balance/transfer checks)
    const tokenAbi = [
      'function balanceOf(address owner) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)',
      'event Transfer(address indexed from, address indexed to, uint256 value)'
    ];

    // Staking Contract ABI
    const stakingAbi = [
      'function stake(uint256 amount, uint256 duration) returns (bytes32)',
      'function getStake(address staker) view returns (uint256 amount, uint256 lockTime, uint256 maturityTime)',
      'function slash(address staker, uint256 percentage) returns (bool)',
      'function unstake() returns (bool)',
      'event Staked(address indexed staker, uint256 amount, uint256 duration, uint256 maturityTime)',
      'event Slashed(address indexed staker, uint256 amount, string reason)',
      'event Unstaked(address indexed staker, uint256 amount)'
    ];

    this.wrfTokenContract = new ethers.Contract(wrfTokenAddress, tokenAbi, this.provider);
    this.stakingContract = new ethers.Contract(stakingContractAddress, stakingAbi, this.provider);

    this.currentRequirements = {
      minStake: this.MIN_STAKE_DEFAULT,
      minDuration: this.MIN_DURATION_DEFAULT,
      slashingPercentage: this.SLASHING_PERCENTAGE_DEFAULT,
      dynamicAdjustment: true
    };
  }

  /**
   * Verify stake proof for node registration
   */
  async verifyStakeProof(proof: StakeProof): Promise<StakeVerificationResult> {
    const errors: string[] = [];
    const now = Date.now() / 1000;

    try {
      // 1. Verify signature
      const isValidSignature = await this.verifyStakeSignature(proof);
      if (!isValidSignature) {
        errors.push('Invalid stake proof signature');
      }

      // 2. Verify on-chain stake
      const onChainStake = await this.stakingContract.getStake(proof.stakeAddress);
      const [stakeAmount, lockTime, maturityTime] = onChainStake;

      // 3. Verify stake amount meets minimum requirement
      if (BigInt(stakeAmount.toString()) < BigInt(this.currentRequirements.minStake)) {
        errors.push(`Stake amount ${stakeAmount} below minimum ${this.currentRequirements.minStake}`);
      }

      // 4. Verify stake amount matches proof
      if (stakeAmount.toString() !== proof.stakeAmount) {
        errors.push('Stake amount mismatch between proof and on-chain data');
      }

      // 5. Determine maturity status
      let maturityStatus: 'immature' | 'mature' | 'expired';
      let remainingTime: number;

      if (now < lockTime) {
        maturityStatus = 'immature';
        remainingTime = lockTime - now;
      } else if (now >= lockTime && now < maturityTime) {
        maturityStatus = 'mature';
        remainingTime = maturityTime - now;
      } else {
        maturityStatus = 'expired';
        remainingTime = 0;
        errors.push('Stake has expired and needs renewal');
      }

      // 6. Verify transaction hash
      const tx = await this.provider.getTransaction(proof.stakeTxHash);
      if (!tx) {
        errors.push('Stake transaction not found on blockchain');
      } else if (tx.blockNumber !== proof.blockNumber) {
        errors.push('Block number mismatch');
      }

      // 7. Calculate slashing risk based on history
      const slashingRisk = this.calculateSlashingRisk(proof.nodeId);

      // 8. Check if node has been slashed before
      const previousSlashing = this.slashingHistory.get(proof.nodeId);
      if (previousSlashing && previousSlashing.length > 0) {
        const recentSlashing = previousSlashing.filter(
          event => (Date.now() - event.timestamp.getTime()) < 90 * 24 * 60 * 60 * 1000 // 90 days
        );
        if (recentSlashing.length > 0) {
          errors.push('Node has recent slashing history');
        }
      }

      return {
        isValid: errors.length === 0 && maturityStatus === 'mature',
        stakeAmount: stakeAmount.toString(),
        maturityStatus,
        remainingTime,
        slashingRisk,
        errors
      };

    } catch (error) {
      errors.push(`Verification error: ${(error as Error).message}`);
      return {
        isValid: false,
        stakeAmount: '0',
        maturityStatus: 'immature',
        remainingTime: 0,
        slashingRisk: 1.0,
        errors
      };
    }
  }

  /**
   * Generate stake proof for node
   */
  async generateStakeProof(
    nodeId: string,
    stakeAddress: string,
    privateKey: string
  ): Promise<StakeProof> {
    // Get on-chain stake information
    const onChainStake = await this.stakingContract.getStake(stakeAddress);
    const [stakeAmount, lockTime, maturityTime] = onChainStake;

    // Find the staking transaction
    const stakeTx = await this.findStakingTransaction(stakeAddress);

    if (!stakeTx) {
      throw new Error('Staking transaction not found');
    }

    const proof: StakeProof = {
      nodeId,
      stakeAmount: stakeAmount.toString(),
      stakeAddress,
      stakeTxHash: stakeTx.hash,
      blockNumber: stakeTx.blockNumber!,
      timestamp: Date.now(),
      maturityTime: Number(maturityTime),
      signature: '',
      chainId: (await this.provider.getNetwork()).chainId as any
    };

    // Sign the proof
    proof.signature = await this.signStakeProof(proof, privateKey);

    // Cache the proof
    this.stakeRegistry.set(nodeId, proof);

    return proof;
  }

  /**
   * Execute stake slashing for malicious behavior
   */
  async slashStake(
    nodeId: string,
    reason: string,
    severity: 'low' | 'medium' | 'high' | 'critical'
  ): Promise<SlashingEvent> {
    const proof = this.stakeRegistry.get(nodeId);
    if (!proof) {
      throw new Error(`No stake proof found for node ${nodeId}`);
    }

    // Calculate slashing percentage based on severity
    const slashingPercentage = this.calculateSlashingPercentage(severity);

    // Get current stake
    const onChainStake = await this.stakingContract.getStake(proof.stakeAddress);
    const [currentStake] = onChainStake;

    // Calculate slashed amount
    const slashedAmount = (BigInt(currentStake.toString()) * BigInt(slashingPercentage)) / BigInt(100);
    const remainingStake = BigInt(currentStake.toString()) - slashedAmount;

    // Execute slashing on-chain (requires authorized signer)
    // In production, this would be executed by a governance contract
    // For now, we log the slashing event

    const slashingEvent: SlashingEvent = {
      nodeId,
      reason,
      severity,
      slashedAmount: slashedAmount.toString(),
      remainingStake: remainingStake.toString(),
      timestamp: new Date(),
      txHash: '' // Would be populated after on-chain execution
    };

    // Record slashing history
    const history = this.slashingHistory.get(nodeId) || [];
    history.push(slashingEvent);
    this.slashingHistory.set(nodeId, history);

    // If stake falls below minimum, remove from registry
    if (remainingStake < BigInt(this.currentRequirements.minStake)) {
      this.stakeRegistry.delete(nodeId);
    }

    return slashingEvent;
  }

  /**
   * Adjust stake requirements dynamically based on network conditions
   */
  async adjustStakeRequirements(
    networkConditions: DynamicStakeAdjustment['networkConditions']
  ): Promise<DynamicStakeAdjustment> {
    if (!this.currentRequirements.dynamicAdjustment) {
      return {
        currentMinStake: this.currentRequirements.minStake,
        adjustmentFactor: 1.0,
        networkConditions,
        nextAdjustment: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
      };
    }

    // Calculate adjustment factor based on network security
    let adjustmentFactor = 1.0;

    // If network security is low, increase stake requirement
    if (networkConditions.networkSecurity < 0.7) {
      adjustmentFactor = 1.5;
    } else if (networkConditions.networkSecurity < 0.5) {
      adjustmentFactor = 2.0;
    }

    // If too many nodes, increase stake to limit growth
    if (networkConditions.totalNodes > 10000) {
      adjustmentFactor *= 1.2;
    }

    // Calculate new minimum stake
    const baseStake = BigInt(this.MIN_STAKE_DEFAULT);
    const newMinStake = (baseStake * BigInt(Math.floor(adjustmentFactor * 100))) / BigInt(100);

    this.currentRequirements.minStake = newMinStake.toString();

    return {
      currentMinStake: newMinStake.toString(),
      adjustmentFactor,
      networkConditions,
      nextAdjustment: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    };
  }

  /**
   * Get current stake requirements
   */
  getStakeRequirements(): StakeRequirement {
    return { ...this.currentRequirements };
  }

  /**
   * Check if node has valid mature stake
   */
  async hasValidStake(nodeId: string): Promise<boolean> {
    const proof = this.stakeRegistry.get(nodeId);
    if (!proof) {
      return false;
    }

    const verification = await this.verifyStakeProof(proof);
    return verification.isValid && verification.maturityStatus === 'mature';
  }

  /**
   * Private helper: Verify stake signature
   */
  private async verifyStakeSignature(proof: StakeProof): Promise<boolean> {
    try {
      const message = this.createStakeProofMessage(proof);
      const messageHash = ethers.hashMessage(message);
      const recoveredAddress = ethers.recoverAddress(messageHash, proof.signature);

      return recoveredAddress.toLowerCase() === proof.stakeAddress.toLowerCase();
    } catch (error) {
      return false;
    }
  }

  /**
   * Private helper: Sign stake proof
   */
  private async signStakeProof(proof: StakeProof, privateKey: string): Promise<string> {
    const wallet = new ethers.Wallet(privateKey);
    const message = this.createStakeProofMessage(proof);
    return await wallet.signMessage(message);
  }

  /**
   * Private helper: Create message to sign for stake proof
   */
  private createStakeProofMessage(proof: StakeProof): string {
    return JSON.stringify({
      nodeId: proof.nodeId,
      stakeAmount: proof.stakeAmount,
      stakeAddress: proof.stakeAddress,
      stakeTxHash: proof.stakeTxHash,
      blockNumber: proof.blockNumber,
      timestamp: proof.timestamp,
      maturityTime: proof.maturityTime,
      chainId: proof.chainId
    });
  }

  /**
   * Private helper: Find staking transaction
   */
  private async findStakingTransaction(stakeAddress: string): Promise<any> {
    // Query events from staking contract
    const filter = this.stakingContract.filters.Staked(stakeAddress);
    const events = await this.stakingContract.queryFilter(filter, -10000); // Last 10000 blocks

    if (events.length === 0) {
      return null;
    }

    // Get the most recent staking event
    const latestEvent = events[events.length - 1];
    return await this.provider.getTransaction(latestEvent.transactionHash);
  }

  /**
   * Private helper: Calculate slashing risk
   */
  private calculateSlashingRisk(nodeId: string): number {
    const history = this.slashingHistory.get(nodeId);
    if (!history || history.length === 0) {
      return 0;
    }

    // Calculate risk based on number and severity of past slashings
    let riskScore = 0;
    const now = Date.now();

    for (const event of history) {
      const age = now - event.timestamp.getTime();
      const ageMonths = age / (30 * 24 * 60 * 60 * 1000);

      // Risk decreases over time
      const timeFactor = Math.max(0, 1 - (ageMonths / 12)); // Decay over 12 months

      // Severity weights
      const severityWeight = {
        low: 0.1,
        medium: 0.3,
        high: 0.6,
        critical: 1.0
      }[event.severity];

      riskScore += severityWeight * timeFactor;
    }

    return Math.min(1.0, riskScore);
  }

  /**
   * Private helper: Calculate slashing percentage based on severity
   */
  private calculateSlashingPercentage(severity: 'low' | 'medium' | 'high' | 'critical'): number {
    const basePercentage = this.currentRequirements.slashingPercentage;

    const severityMultiplier = {
      low: 0.2,      // 10% of stake (if base is 50%)
      medium: 0.5,   // 25% of stake
      high: 1.0,     // 50% of stake
      critical: 2.0  // 100% of stake
    }[severity];

    return Math.min(100, Math.floor(basePercentage * severityMultiplier));
  }

  /**
   * Get stake statistics for network
   */
  getStakeStatistics(): {
    totalStaked: string;
    totalNodes: number;
    averageStake: string;
    medianStake: string;
    slashingRate: number;
  } {
    const stakes = Array.from(this.stakeRegistry.values());

    if (stakes.length === 0) {
      return {
        totalStaked: '0',
        totalNodes: 0,
        averageStake: '0',
        medianStake: '0',
        slashingRate: 0
      };
    }

    const stakeAmounts = stakes.map(s => BigInt(s.stakeAmount));
    const totalStaked = stakeAmounts.reduce((a, b) => a + b, BigInt(0));
    const averageStake = totalStaked / BigInt(stakes.length);

    // Calculate median
    const sortedStakes = [...stakeAmounts].sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    const medianStake = sortedStakes[Math.floor(sortedStakes.length / 2)];

    // Calculate slashing rate
    const totalSlashings = Array.from(this.slashingHistory.values())
      .reduce((sum, events) => sum + events.length, 0);
    const slashingRate = stakes.length > 0 ? totalSlashings / stakes.length : 0;

    return {
      totalStaked: totalStaked.toString(),
      totalNodes: stakes.length,
      averageStake: averageStake.toString(),
      medianStake: medianStake.toString(),
      slashingRate
    };
  }
}

/**
 * Stake monitoring service for automated checks
 */
export class StakeMonitoringService {
  private posManager: ProofOfStakeManager;
  private monitoringInterval: NodeJS.Timeout | null = null;

  constructor(posManager: ProofOfStakeManager) {
    this.posManager = posManager;
  }

  /**
   * Start monitoring stakes
   */
  startMonitoring(intervalMs: number = 60000): void {
    if (this.monitoringInterval) {
      return;
    }

    this.monitoringInterval = setInterval(async () => {
      await this.performStakeChecks();
    }, intervalMs);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  /**
   * Perform periodic stake checks
   */
  private async performStakeChecks(): Promise<void> {
    // This would check all registered nodes and verify stakes are still valid
    // Implementation would depend on node registry integration
    securityLogger.info('Performing stake checks', { module: 'StakeMonitoringService' });
  }
}
