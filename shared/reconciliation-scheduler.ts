/**
 * Reconciliation Scheduler
 * Automates state reconciliation by periodically checking for unresolved conflicts
 * and triggering reconciliation plans.
 *
 * Addresses backend#92: Manual state reconciliation automation
 */

import { EventEmitter } from 'events';
import { StateReconciliation, type StateConflict, type ReconciliationResult } from './state-reconciliation.js';
import { blockchainLogger } from '../server/utils/logger.js';

export interface SchedulerConfig {
  /** Interval in ms between reconciliation checks (default: 60000 = 1 minute) */
  checkIntervalMs: number;
  /** Maximum conflicts to process per check cycle */
  maxConflictsPerCycle: number;
  /** Whether to auto-resolve manual conflicts using fallback strategy */
  autoResolveManual: boolean;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  checkIntervalMs: 60_000,
  maxConflictsPerCycle: 10,
  autoResolveManual: true,
};

export class ReconciliationScheduler extends EventEmitter {
  private readonly reconciliation: StateReconciliation;
  private readonly config: SchedulerConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private processedConflicts: Set<string> = new Set();

  constructor(reconciliation: StateReconciliation, config?: Partial<SchedulerConfig>) {
    super();
    this.reconciliation = reconciliation;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start the periodic reconciliation scheduler */
  start(): void {
    if (this.timer) return;

    blockchainLogger.info('Reconciliation scheduler started', {
      module: 'ReconciliationScheduler',
      intervalMs: this.config.checkIntervalMs,
    });

    this.timer = setInterval(() => this.runCycle(), this.config.checkIntervalMs);
    this.emit('started');
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    blockchainLogger.info('Reconciliation scheduler stopped', {
      module: 'ReconciliationScheduler',
    });

    this.emit('stopped');
  }

  /** Run a single reconciliation cycle — can be called manually or by the timer */
  async runCycle(): Promise<ReconciliationResult[]> {
    if (this.running) {
      blockchainLogger.debug('Reconciliation cycle already in progress, skipping', {
        module: 'ReconciliationScheduler',
      });
      return [];
    }

    this.running = true;
    const results: ReconciliationResult[] = [];

    try {
      const status = this.reconciliation.getStatus();
      const unresolvedConflicts = status.conflicts.filter(
        (c) => !c.resolved && !this.processedConflicts.has(c.conflictId)
      );

      if (unresolvedConflicts.length === 0) {
        return results;
      }

      blockchainLogger.info('Reconciliation cycle: processing conflicts', {
        module: 'ReconciliationScheduler',
        count: unresolvedConflicts.length,
      });

      const toProcess = unresolvedConflicts.slice(0, this.config.maxConflictsPerCycle);

      for (const conflict of toProcess) {
        try {
          const result = await this.processConflict(conflict);
          results.push(result);
          this.processedConflicts.add(conflict.conflictId);

          blockchainLogger.info('Conflict resolved', {
            module: 'ReconciliationScheduler',
            conflictId: conflict.conflictId,
            success: result.success,
          });
        } catch (error) {
          blockchainLogger.error('Failed to process conflict', {
            module: 'ReconciliationScheduler',
            conflictId: conflict.conflictId,
            error: String(error),
          });
        }
      }

      this.emit('cycle_completed', { processed: results.length, total: unresolvedConflicts.length });
    } finally {
      this.running = false;
    }

    return results;
  }

  /** Process a single conflict: create plan and execute */
  private async processConflict(conflict: StateConflict): Promise<ReconciliationResult> {
    const plan = await this.reconciliation.createReconciliationPlan(conflict.conflictId);
    return this.reconciliation.executeReconciliation(plan);
  }

  /** Check if the scheduler is currently running */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Reset the set of already-processed conflicts */
  resetProcessed(): void {
    this.processedConflicts.clear();
  }
}
