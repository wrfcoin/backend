/**
 * Economic Staking Requirements for Validator Participation
 * Implements stake-based security with slashing mechanisms
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

interface StakeRequirement {
  minimumStake: bigint;
  lockupPeriod: number; // seconds
  slashingPercentage: number; // 0-100
  rewardRate: number; // annual percentage
}

interface NodeStake {
  nodeId: string;
  stakedAmount: bigint;
  stakedAt: Date;
  unlockAt: Date;
  votingPower: number;
  slashed: boolean;
  slashedAmount?: bigint;
  rewardsEarned: bigint;
}

interface SlashingEvent {
  nodeId: string;
  reason: string;
  slashedAmount: bigint;
  remainingStake: bigint;
  timestamp: Date;
}

export class NodeStakingManager extends EventEmitter {
  private stakes: Map<string, NodeStake> = new Map();
  private slashingEvents: SlashingEvent[] = [];

  private readonly MINIMUM_STAKE = BigInt(10000); // 10k tokens
  private readonly LOCKUP_PERIOD = 30 * 24 * 60 * 60; // 30 days
  private readonly SLASH_PERCENTAGE = 10; // 10% slash for misbehavior

  async stakeTokens(nodeId: string, amount: bigint): Promise<void> {
    if (amount < this.MINIMUM_STAKE) {
      throw new Error(
        `Insufficient stake: minimum ${this.MINIMUM_STAKE} required`
      );
    }

    const stake: NodeStake = {
      nodeId,
      stakedAmount: amount,
      stakedAt: new Date(),
      unlockAt: new Date(Date.now() + this.LOCKUP_PERIOD * 1000),
      votingPower: Number(amount / BigInt(1000)),
      slashed: false,
      rewardsEarned: BigInt(0),
    };

    this.stakes.set(nodeId, stake);
    this.emit('stakeCreated', { nodeId, amount });
  }

  async slashStake(nodeId: string, reason: string): Promise<void> {
    const stake = this.stakes.get(nodeId);
    if (!stake) throw new Error('No stake found');

    const slashAmount =
      (stake.stakedAmount * BigInt(this.SLASH_PERCENTAGE)) / BigInt(100);
    stake.stakedAmount -= slashAmount;
    stake.slashed = true;
    stake.slashedAmount = slashAmount;

    const event: SlashingEvent = {
      nodeId,
      reason,
      slashedAmount: slashAmount,
      remainingStake: stake.stakedAmount,
      timestamp: new Date(),
    };

    this.slashingEvents.push(event);
    this.emit('stakeSlashed', event);
  }

  getVotingPower(nodeId: string): number {
    return this.stakes.get(nodeId)?.votingPower || 0;
  }
}
