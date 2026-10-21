/**
 * View Change Coordinator
 * Handles PBFT view changes for primary node failures
 *
 * VIEW CHANGE PROTOCOL:
 * 1. Timeout detection for unresponsive primary
 * 2. View change initiation by replicas
 * 3. New primary election (round-robin or reputation-based)
 * 4. State transfer to new primary
 * 5. Resume consensus in new view
 *
 * SAFETY: Ensures consensus continues even with Byzantine primary
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface ViewChangeMessage {
  type: 'view-change';
  newViewNumber: number;
  lastCheckpointHeight: number;
  validatorId: string;
  preparedCertificate?: PreparedCertificate;
  timestamp: number;
}

export interface PreparedCertificate {
  height: number;
  blockHash: string;
  prepareMessages: number;
  viewNumber: number;
}

export interface NewViewMessage {
  type: 'new-view';
  newViewNumber: number;
  viewChangeMessages: ViewChangeMessage[];
  newPrimaryId: string;
  timestamp: number;
}

export interface ViewChangeState {
  currentViewNumber: number;
  viewChangeInProgress: boolean;
  viewChangeMessages: Map<string, ViewChangeMessage>;
  newPrimaryId?: string;
  startTime?: Date;
}

export interface PrimaryFailureIndicator {
  indicatorType: 'timeout' | 'invalid-proposal' | 'no-response' | 'malicious-behavior';
  primaryId: string;
  evidence: any;
  detectedAt: Date;
}

/**
 * View Change Protocol Coordinator
 */
export class ViewChangeCoordinator extends EventEmitter {
  private currentViewNumber: number = 0;
  private currentPrimaryId?: string;
  private viewChangeState?: ViewChangeState;
  private failureIndicators: PrimaryFailureIndicator[] = [];
  private primaryTimeouts: Map<string, number> = new Map();
  private viewChangeHistory: Array<{
    oldView: number;
    newView: number;
    oldPrimary: string;
    newPrimary: string;
    timestamp: Date;
    reason: string;
  }> = [];

  private readonly PRIMARY_TIMEOUT = 15000; // 15 seconds
  private readonly VIEW_CHANGE_TIMEOUT = 30000; // 30 seconds
  private readonly MAX_CONSECUTIVE_FAILURES = 3;

  constructor(initialPrimaryId?: string) {
    super();
    this.currentPrimaryId = initialPrimaryId;
  }

  /**
   * Detect primary failure
   */
  async detectPrimaryFailure(
    primaryId: string,
    indicatorType: PrimaryFailureIndicator['indicatorType'],
    evidence: any
  ): Promise<boolean> {
    const indicator: PrimaryFailureIndicator = {
      indicatorType,
      primaryId,
      evidence,
      detectedAt: new Date(),
    };

    this.failureIndicators.push(indicator);

    // Count timeout failures
    if (indicatorType === 'timeout') {
      const timeouts = this.primaryTimeouts.get(primaryId) || 0;
      this.primaryTimeouts.set(primaryId, timeouts + 1);

      if (timeouts + 1 >= this.MAX_CONSECUTIVE_FAILURES) {
        this.emit('primaryFailureConfirmed', {
          primaryId,
          failureType: 'consecutive-timeouts',
          count: timeouts + 1,
        });

        await this.initiateViewChange(primaryId, 'Consecutive timeouts');
        return true;
      }
    }

    // Critical failures trigger immediate view change
    if (indicatorType === 'malicious-behavior') {
      this.emit('primaryFailureConfirmed', {
        primaryId,
        failureType: 'malicious-behavior',
        evidence,
      });

      await this.initiateViewChange(primaryId, 'Malicious behavior detected');
      return true;
    }

    return false;
  }

  /**
   * Initiate view change protocol
   */
  async initiateViewChange(
    failedPrimaryId: string,
    reason: string
  ): Promise<number> {
    if (this.viewChangeState?.viewChangeInProgress) {
      // View change already in progress
      return this.viewChangeState.currentViewNumber + 1;
    }

    const newViewNumber = this.currentViewNumber + 1;

    this.viewChangeState = {
      currentViewNumber: newViewNumber,
      viewChangeInProgress: true,
      viewChangeMessages: new Map(),
      startTime: new Date(),
    };

    this.emit('viewChangeInitiated', {
      oldViewNumber: this.currentViewNumber,
      newViewNumber,
      failedPrimaryId,
      reason,
    });

    // Set timeout for view change
    setTimeout(() => {
      if (this.viewChangeState?.viewChangeInProgress) {
        this.handleViewChangeTimeout();
      }
    }, this.VIEW_CHANGE_TIMEOUT);

    return newViewNumber;
  }

  /**
   * Process view change message from validator
   */
  async processViewChangeMessage(
    message: ViewChangeMessage,
    requiredQuorum: number
  ): Promise<boolean> {
    if (!this.viewChangeState) {
      throw new Error('No view change in progress');
    }

    if (message.newViewNumber !== this.viewChangeState.currentViewNumber) {
      return false;
    }

    // Store view change message
    this.viewChangeState.viewChangeMessages.set(message.validatorId, message);

    this.emit('viewChangeMessageReceived', {
      validatorId: message.validatorId,
      newViewNumber: message.newViewNumber,
      messageCount: this.viewChangeState.viewChangeMessages.size,
      requiredQuorum,
    });

    // Check if quorum achieved (2f+1)
    if (this.viewChangeState.viewChangeMessages.size >= requiredQuorum) {
      await this.completeViewChange(
        Array.from(this.viewChangeState.viewChangeMessages.values())
      );
      return true;
    }

    return false;
  }

  /**
   * Complete view change and elect new primary
   */
  private async completeViewChange(
    viewChangeMessages: ViewChangeMessage[]
  ): Promise<void> {
    if (!this.viewChangeState) return;

    // Select new primary (round-robin by view number)
    const newPrimaryId = this.selectNewPrimary(
      viewChangeMessages.map(m => m.validatorId),
      this.viewChangeState.currentViewNumber
    );

    this.viewChangeState.newPrimaryId = newPrimaryId;

    // Create new-view message
    const newViewMessage: NewViewMessage = {
      type: 'new-view',
      newViewNumber: this.viewChangeState.currentViewNumber,
      viewChangeMessages,
      newPrimaryId,
      timestamp: Date.now(),
    };

    // Record view change in history
    if (this.currentPrimaryId) {
      this.viewChangeHistory.push({
        oldView: this.currentViewNumber,
        newView: this.viewChangeState.currentViewNumber,
        oldPrimary: this.currentPrimaryId,
        newPrimary: newPrimaryId,
        timestamp: new Date(),
        reason: 'Primary failure',
      });
    }

    // Update state
    const oldPrimaryId = this.currentPrimaryId;
    this.currentViewNumber = this.viewChangeState.currentViewNumber;
    this.currentPrimaryId = newPrimaryId;
    const viewChangeDuration = Date.now() - (this.viewChangeState?.startTime?.getTime() || Date.now());
    this.viewChangeState = undefined;

    // Reset timeout counter for new primary
    this.primaryTimeouts.set(newPrimaryId, 0);

    this.emit('viewChangeCompleted', {
      newViewNumber: this.currentViewNumber,
      oldPrimaryId,
      newPrimaryId,
      duration: viewChangeDuration,
    });

    this.emit('newPrimaryElected', {
      viewNumber: this.currentViewNumber,
      primaryId: newPrimaryId,
    });
  }

  /**
   * Select new primary node
   * Uses round-robin based on view number
   */
  private selectNewPrimary(validators: string[], viewNumber: number): string {
    // Sort validators for deterministic selection
    const sortedValidators = validators.sort();

    // Round-robin: primary = validators[viewNumber % n]
    const primaryIndex = viewNumber % sortedValidators.length;

    return sortedValidators[primaryIndex];
  }

  /**
   * Handle view change timeout
   */
  private handleViewChangeTimeout(): void {
    if (!this.viewChangeState) return;

    this.emit('viewChangeTimeout', {
      viewNumber: this.viewChangeState.currentViewNumber,
      messagesReceived: this.viewChangeState.viewChangeMessages.size,
      duration: Date.now() - (this.viewChangeState.startTime?.getTime() || Date.now()),
    });

    // Retry with higher view number
    if (this.currentPrimaryId) {
      this.viewChangeState = undefined;
      this.initiateViewChange(this.currentPrimaryId, 'View change timeout');
    }
  }

  /**
   * Transfer state to new primary
   */
  async transferStateToNewPrimary(
    newPrimaryId: string,
    stateData: any
  ): Promise<void> {
    this.emit('stateTransferInitiated', {
      newPrimaryId,
      dataSize: JSON.stringify(stateData).length,
    });

    // Simulate state transfer
    await new Promise(resolve => setTimeout(resolve, 100));

    this.emit('stateTransferCompleted', {
      newPrimaryId,
    });
  }

  /**
   * Get current primary
   */
  getCurrentPrimary(): string | undefined {
    return this.currentPrimaryId;
  }

  /**
   * Get current view number
   */
  getCurrentViewNumber(): number {
    return this.currentViewNumber;
  }

  /**
   * Check if view change in progress
   */
  isViewChangeInProgress(): boolean {
    return this.viewChangeState?.viewChangeInProgress || false;
  }

  /**
   * Get view change history
   */
  getViewChangeHistory(): typeof this.viewChangeHistory {
    return [...this.viewChangeHistory];
  }

  /**
   * Get failure indicators
   */
  getFailureIndicators(primaryId?: string): PrimaryFailureIndicator[] {
    return primaryId
      ? this.failureIndicators.filter(i => i.primaryId === primaryId)
      : [...this.failureIndicators];
  }

  /**
   * Reset timeout counter for primary
   */
  resetPrimaryTimeout(primaryId: string): void {
    this.primaryTimeouts.set(primaryId, 0);
  }

  /**
   * Manually set primary (for testing)
   */
  setPrimary(primaryId: string, viewNumber?: number): void {
    this.currentPrimaryId = primaryId;
    if (viewNumber !== undefined) {
      this.currentViewNumber = viewNumber;
    }

    this.emit('primarySet', {
      primaryId,
      viewNumber: this.currentViewNumber,
    });
  }
}
