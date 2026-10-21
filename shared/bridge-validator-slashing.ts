/**
 * Bridge Validator Slashing System
 *
 * Implements economic penalties for malicious validator behavior:
 * - Double-signing detection
 * - Invalid fraud proof submission
 * - Failure to sign valid transactions
 * - Participation in bridge attacks
 *
 * Slashing mechanisms:
 * - Stake confiscation
 * - Reputation reduction
 * - Temporary/permanent removal
 * - Public slashing events
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

export enum SlashingOffense {
  DOUBLE_SIGNING = 'DOUBLE_SIGNING',
  INVALID_FRAUD_PROOF = 'INVALID_FRAUD_PROOF',
  MISSED_SIGNATURE = 'MISSED_SIGNATURE',
  MALICIOUS_BEHAVIOR = 'MALICIOUS_BEHAVIOR',
  BRIDGE_ATTACK = 'BRIDGE_ATTACK',
  UNAVAILABILITY = 'UNAVAILABILITY',
}

export interface SlashingEvent {
  id: string;
  validator: string;
  offense: SlashingOffense;
  severity: 'minor' | 'major' | 'critical';
  slashAmount: string;
  reputationPenalty: number;
  evidence: any;
  timestamp: Date;
  executed: boolean;
}

export interface ValidatorStake {
  validator: string;
  totalStake: string;
  lockedStake: string;
  slashedAmount: string;
  reputation: number;
  isActive: boolean;
  missedSignatures: number;
  slashingHistory: string[];
}

export class BridgeValidatorSlashing extends EventEmitter {
  private validators: Map<string, ValidatorStake> = new Map();
  private slashingEvents: Map<string, SlashingEvent> = new Map();

  private readonly SLASH_PERCENTAGES = {
    minor: 5,
    major: 25,
    critical: 100,
  };

  private readonly REPUTATION_PENALTIES = {
    minor: 10,
    major: 30,
    critical: 100,
  };

  private readonly MIN_REPUTATION = 0;
  private readonly REMOVAL_THRESHOLD = 20;

  constructor() {
    super();
  }

  /**
   * Register validator with stake
   */
  public registerValidator(
    validatorAddress: string,
    stakeAmount: string
  ): ValidatorStake {
    if (this.validators.has(validatorAddress)) {
      throw new Error(`Validator already registered: ${validatorAddress}`);
    }

    const validator: ValidatorStake = {
      validator: validatorAddress,
      totalStake: stakeAmount,
      lockedStake: '0',
      slashedAmount: '0',
      reputation: 100,
      isActive: true,
      missedSignatures: 0,
      slashingHistory: [],
    };

    this.validators.set(validatorAddress, validator);

    this.emit('validator:registered', {
      validator: validatorAddress,
      stake: stakeAmount,
    });

    return validator;
  }

  /**
   * Slash validator for offense
   */
  public async slashValidator(
    validatorAddress: string,
    offense: SlashingOffense,
    severity: 'minor' | 'major' | 'critical',
    evidence: any
  ): Promise<SlashingEvent> {
    const validator = this.validators.get(validatorAddress);

    if (!validator) {
      throw new Error(`Validator not found: ${validatorAddress}`);
    }

    if (!validator.isActive) {
      throw new Error(`Validator not active: ${validatorAddress}`);
    }

    const slashPercentage = this.SLASH_PERCENTAGES[severity];
    const reputationPenalty = this.REPUTATION_PENALTIES[severity];

    const totalStake = BigInt(validator.totalStake);
    const slashAmount = (totalStake * BigInt(slashPercentage)) / 100n;

    const slashingId = this.generateSlashingId(validatorAddress, offense);

    const slashingEvent: SlashingEvent = {
      id: slashingId,
      validator: validatorAddress,
      offense,
      severity,
      slashAmount: slashAmount.toString(),
      reputationPenalty,
      evidence,
      timestamp: new Date(),
      executed: false,
    };

    this.slashingEvents.set(slashingId, slashingEvent);

    // Execute slashing
    await this.executeSlashing(validator, slashingEvent);

    return slashingEvent;
  }

  /**
   * Execute slashing on validator
   */
  private async executeSlashing(
    validator: ValidatorStake,
    slashing: SlashingEvent
  ): Promise<void> {
    // Confiscate stake
    const currentTotal = BigInt(validator.totalStake);
    const slashAmount = BigInt(slashing.slashAmount);
    const newTotal = currentTotal - slashAmount;

    validator.totalStake = newTotal.toString();
    validator.slashedAmount = (
      BigInt(validator.slashedAmount) + slashAmount
    ).toString();

    // Reduce reputation
    validator.reputation = Math.max(
      this.MIN_REPUTATION,
      validator.reputation - slashing.reputationPenalty
    );

    // Record slashing
    validator.slashingHistory.push(slashing.id);

    slashing.executed = true;

    this.emit('validator:slashed', {
      validator: validator.validator,
      offense: slashing.offense,
      slashAmount: slashing.slashAmount,
      newReputation: validator.reputation,
      newStake: validator.totalStake,
    });

    // Check if validator should be removed
    if (
      validator.reputation <= this.REMOVAL_THRESHOLD ||
      slashing.severity === 'critical'
    ) {
      this.removeValidator(validator.validator);
    }
  }

  /**
   * Remove validator from active set
   */
  private removeValidator(validatorAddress: string): void {
    const validator = this.validators.get(validatorAddress);

    if (!validator) return;

    validator.isActive = false;

    this.emit('validator:removed', {
      validator: validatorAddress,
      reason: 'slashing',
      finalReputation: validator.reputation,
      slashedAmount: validator.slashedAmount,
    });
  }

  /**
   * Get validator stake info
   */
  public getValidator(validatorAddress: string): ValidatorStake | undefined {
    return this.validators.get(validatorAddress);
  }

  /**
   * Get all active validators
   */
  public getActiveValidators(): ValidatorStake[] {
    return Array.from(this.validators.values()).filter(v => v.isActive);
  }

  /**
   * Get slashing event
   */
  public getSlashingEvent(slashingId: string): SlashingEvent | undefined {
    return this.slashingEvents.get(slashingId);
  }

  /**
   * Generate slashing ID
   */
  private generateSlashingId(validator: string, offense: SlashingOffense): string {
    const data = `${validator}-${offense}-${Date.now()}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Get statistics
   */
  public getStatistics() {
    const validators = Array.from(this.validators.values());
    const slashings = Array.from(this.slashingEvents.values());

    return {
      validators: {
        total: validators.length,
        active: validators.filter(v => v.isActive).length,
        slashed: validators.filter(v => BigInt(v.slashedAmount) > 0n).length,
      },
      slashings: {
        total: slashings.length,
        byOffense: this.groupByOffense(),
        bySeverity: this.groupBySeverity(),
      },
    };
  }

  private groupByOffense(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const slashing of this.slashingEvents.values()) {
      result[slashing.offense] = (result[slashing.offense] || 0) + 1;
    }
    return result;
  }

  private groupBySeverity(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const slashing of this.slashingEvents.values()) {
      result[slashing.severity] = (result[slashing.severity] || 0) + 1;
    }
    return result;
  }
}

export const validatorSlashing = new BridgeValidatorSlashing();
