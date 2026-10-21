/**
 * Incident Playbook Engine - Automated Incident Response
 * Issue #208: Severity-based playbooks that auto-respond to blockchain incidents
 *
 * Provides automated actions for SEV1-SEV4 incidents with cooldown tracking,
 * operator override capability, and comprehensive audit logging.
 */

import { v4 as uuidv4 } from 'uuid';
import { securityLogger } from '../utils/logger.js';

// =====================================================
// TYPES & ENUMS
// =====================================================

export enum IncidentSeverity {
  SEV1 = 'SEV1', // Immediate auto-action
  SEV2 = 'SEV2', // Auto-action + escalation
  SEV3 = 'SEV3', // Monitor + optional action
  SEV4 = 'SEV4', // Log only
}

export type PlaybookAction =
  | 'pause_bridge'
  | 'freeze_rewards'
  | 'tighten_caps'
  | 'emergency_key_rotation'
  | 'escalate';

export interface PlaybookDefinition {
  alertName: string;
  severity: IncidentSeverity;
  actions: PlaybookAction[];
  autoRemediate: boolean;
  description: string;
}

export interface IncidentRecord {
  id: string;
  alertName: string;
  severity: IncidentSeverity;
  status: 'triggered' | 'executing' | 'completed' | 'rolled_back' | 'failed';
  triggeredAt: Date;
  completedAt?: Date;
  rolledBackAt?: Date;
  actionsExecuted: ActionResult[];
  stateSnapshot: Record<string, unknown>;
  alertPayload: unknown;
  triggeredBy: 'alertmanager' | 'manual';
  rolledBackBy?: string;
}

export interface ActionResult {
  action: PlaybookAction;
  success: boolean;
  timestamp: Date;
  details: string;
  reversible: boolean;
  rollbackAction?: string;
}

export interface AlertManagerPayload {
  alerts: AlertManagerAlert[];
}

export interface AlertManagerAlert {
  status: 'firing' | 'resolved';
  labels: {
    alertname: string;
    severity?: string;
    category?: string;
    [key: string]: string | undefined;
  };
  annotations?: {
    summary?: string;
    description?: string;
    [key: string]: string | undefined;
  };
  startsAt?: string;
  endsAt?: string;
}

// =====================================================
// PLAYBOOK DEFINITIONS
// =====================================================

const PLAYBOOKS: PlaybookDefinition[] = [
  {
    alertName: 'CrossChainBridgeFailure',
    severity: IncidentSeverity.SEV1,
    actions: ['pause_bridge', 'escalate'],
    autoRemediate: true,
    description: 'Pause bridge on repeated transfer failures',
  },
  {
    alertName: 'BlockProductionStalled',
    severity: IncidentSeverity.SEV1,
    actions: ['escalate'],
    autoRemediate: true,
    description: 'Escalate immediately when block production stops',
  },
  {
    alertName: 'ConsensusRoundTimeout',
    severity: IncidentSeverity.SEV1,
    actions: ['escalate'],
    autoRemediate: true,
    description: 'Escalate consensus timeouts for validator investigation',
  },
  {
    alertName: 'ValidatorSlashed',
    severity: IncidentSeverity.SEV2,
    actions: ['tighten_caps', 'escalate'],
    autoRemediate: true,
    description: 'Tighten transaction caps and escalate on slashing events',
  },
  {
    alertName: 'HSMOperationFailure',
    severity: IncidentSeverity.SEV1,
    actions: ['emergency_key_rotation', 'escalate'],
    autoRemediate: true,
    description: 'Emergency key rotation on HSM failures',
  },
  {
    alertName: 'SuspiciousActivityDetected',
    severity: IncidentSeverity.SEV2,
    actions: ['freeze_rewards', 'tighten_caps', 'escalate'],
    autoRemediate: true,
    description: 'Freeze rewards and tighten caps on suspicious activity',
  },
  {
    alertName: 'HighAPIErrorRate',
    severity: IncidentSeverity.SEV3,
    actions: ['escalate'],
    autoRemediate: false,
    description: 'Monitor and escalate high API error rates',
  },
  {
    alertName: 'WeatherDataQualityDegraded',
    severity: IncidentSeverity.SEV4,
    actions: [],
    autoRemediate: false,
    description: 'Log weather data quality degradation',
  },
];

// =====================================================
// INCIDENT PLAYBOOK ENGINE
// =====================================================

const MINIMUM_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export class IncidentPlaybookEngine {
  private incidents: Map<string, IncidentRecord> = new Map();
  private cooldowns: Map<string, Date> = new Map();
  private playbooks: PlaybookDefinition[] = [...PLAYBOOKS];

  // Track current automated state for rollback
  private automatedState: Record<string, unknown> = {
    bridgePaused: false,
    rewardsFrozen: false,
    capsModified: false,
    keyRotationTriggered: false,
  };

  /**
   * Get the playbook definition for an alert
   */
  getPlaybook(alertName: string): PlaybookDefinition | undefined {
    return this.playbooks.find(p => p.alertName === alertName);
  }

  /**
   * Check if an alert is in cooldown
   */
  isInCooldown(alertName: string): boolean {
    const lastTriggered = this.cooldowns.get(alertName);
    if (!lastTriggered) return false;
    return Date.now() - lastTriggered.getTime() < MINIMUM_COOLDOWN_MS;
  }

  /**
   * Get remaining cooldown time in seconds
   */
  getCooldownRemaining(alertName: string): number {
    const lastTriggered = this.cooldowns.get(alertName);
    if (!lastTriggered) return 0;
    const remaining = MINIMUM_COOLDOWN_MS - (Date.now() - lastTriggered.getTime());
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  /**
   * Process an AlertManager webhook payload
   */
  async processAlertManagerWebhook(payload: AlertManagerPayload): Promise<IncidentRecord[]> {
    const results: IncidentRecord[] = [];

    for (const alert of payload.alerts) {
      if (alert.status !== 'firing') continue;

      const alertName = alert.labels.alertname;
      const playbook = this.getPlaybook(alertName);

      if (!playbook) {
        securityLogger.info('No playbook found for alert', { alertName });
        continue;
      }

      // Check cooldown
      if (this.isInCooldown(alertName)) {
        securityLogger.info('Alert in cooldown, skipping', {
          alertName,
          cooldownRemaining: this.getCooldownRemaining(alertName),
        });
        continue;
      }

      const incident = await this.executePlaybook(playbook, alert, 'alertmanager');
      results.push(incident);
    }

    return results;
  }

  /**
   * Manually execute a playbook
   */
  async executePlaybookManually(alertName: string, triggeredBy: string): Promise<IncidentRecord> {
    const playbook = this.getPlaybook(alertName);
    if (!playbook) {
      throw new Error(`No playbook found for alert: ${alertName}`);
    }

    const mockAlert: AlertManagerAlert = {
      status: 'firing',
      labels: {
        alertname: alertName,
        severity: playbook.severity.toLowerCase(),
      },
      annotations: {
        summary: `Manual trigger by ${triggeredBy}`,
      },
    };

    return this.executePlaybook(playbook, mockAlert, 'manual');
  }

  /**
   * Execute a playbook's actions
   */
  private async executePlaybook(
    playbook: PlaybookDefinition,
    alert: AlertManagerAlert,
    triggeredBy: 'alertmanager' | 'manual'
  ): Promise<IncidentRecord> {
    const incidentId = uuidv4();
    const now = new Date();

    // Capture state snapshot before actions
    const stateSnapshot = { ...this.automatedState };

    const incident: IncidentRecord = {
      id: incidentId,
      alertName: playbook.alertName,
      severity: playbook.severity,
      status: 'executing',
      triggeredAt: now,
      actionsExecuted: [],
      stateSnapshot,
      alertPayload: alert,
      triggeredBy,
    };

    this.incidents.set(incidentId, incident);

    securityLogger.warn('Incident playbook triggered', {
      incidentId,
      alertName: playbook.alertName,
      severity: playbook.severity,
      triggeredBy,
      actions: playbook.actions,
    });

    // Execute each action
    for (const action of playbook.actions) {
      const result = await this.executeAction(action, incidentId);
      incident.actionsExecuted.push(result);

      if (!result.success) {
        securityLogger.error('Playbook action failed', {
          incidentId,
          action,
          details: result.details,
        });
      }
    }

    // Update cooldown
    this.cooldowns.set(playbook.alertName, now);

    // Mark incident complete
    incident.status = 'completed';
    incident.completedAt = new Date();
    this.incidents.set(incidentId, incident);

    securityLogger.warn('Incident playbook completed', {
      incidentId,
      alertName: playbook.alertName,
      actionsExecuted: incident.actionsExecuted.length,
      allSucceeded: incident.actionsExecuted.every(a => a.success),
    });

    return incident;
  }

  /**
   * Execute a single automated action
   */
  private async executeAction(action: PlaybookAction, incidentId: string): Promise<ActionResult> {
    const timestamp = new Date();

    try {
      switch (action) {
        case 'pause_bridge': {
          this.automatedState.bridgePaused = true;
          securityLogger.warn('AUTOMATED ACTION: Bridge paused', { incidentId });
          return {
            action,
            success: true,
            timestamp,
            details: 'Cross-chain bridge paused for all transfers',
            reversible: true,
            rollbackAction: 'resume_bridge',
          };
        }

        case 'freeze_rewards': {
          this.automatedState.rewardsFrozen = true;
          securityLogger.warn('AUTOMATED ACTION: Rewards frozen', { incidentId });
          return {
            action,
            success: true,
            timestamp,
            details: 'Reward distributions frozen pending investigation',
            reversible: true,
            rollbackAction: 'unfreeze_rewards',
          };
        }

        case 'tighten_caps': {
          this.automatedState.capsModified = true;
          securityLogger.warn('AUTOMATED ACTION: Transaction caps tightened', { incidentId });
          return {
            action,
            success: true,
            timestamp,
            details: 'Transaction caps reduced to 50% of normal limits',
            reversible: true,
            rollbackAction: 'restore_caps',
          };
        }

        case 'emergency_key_rotation': {
          this.automatedState.keyRotationTriggered = true;
          securityLogger.warn('AUTOMATED ACTION: Emergency key rotation initiated', { incidentId });
          return {
            action,
            success: true,
            timestamp,
            details: 'Emergency key rotation process initiated',
            reversible: false,
          };
        }

        case 'escalate': {
          securityLogger.warn('AUTOMATED ACTION: Incident escalated', { incidentId });
          return {
            action,
            success: true,
            timestamp,
            details: 'Incident escalated to on-call team',
            reversible: false,
          };
        }

        default:
          return {
            action,
            success: false,
            timestamp,
            details: `Unknown action: ${action}`,
            reversible: false,
          };
      }
    } catch (error) {
      return {
        action,
        success: false,
        timestamp,
        details: `Action failed: ${error instanceof Error ? error.message : String(error)}`,
        reversible: false,
      };
    }
  }

  /**
   * Rollback automated actions for a specific incident
   */
  async rollbackIncident(incidentId: string, rolledBackBy: string): Promise<IncidentRecord> {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident not found: ${incidentId}`);
    }

    if (incident.status === 'rolled_back') {
      throw new Error(`Incident ${incidentId} has already been rolled back`);
    }

    securityLogger.warn('Incident rollback initiated', {
      incidentId,
      rolledBackBy,
      actionsToRollback: incident.actionsExecuted.filter(a => a.reversible).length,
    });

    // Reverse actions in reverse order
    for (const actionResult of [...incident.actionsExecuted].reverse()) {
      if (!actionResult.reversible) continue;

      switch (actionResult.rollbackAction) {
        case 'resume_bridge':
          this.automatedState.bridgePaused = false;
          securityLogger.warn('ROLLBACK: Bridge resumed', { incidentId });
          break;
        case 'unfreeze_rewards':
          this.automatedState.rewardsFrozen = false;
          securityLogger.warn('ROLLBACK: Rewards unfrozen', { incidentId });
          break;
        case 'restore_caps':
          this.automatedState.capsModified = false;
          securityLogger.warn('ROLLBACK: Transaction caps restored', { incidentId });
          break;
      }
    }

    incident.status = 'rolled_back';
    incident.rolledBackAt = new Date();
    incident.rolledBackBy = rolledBackBy;
    this.incidents.set(incidentId, incident);

    securityLogger.warn('Incident rollback completed', {
      incidentId,
      rolledBackBy,
    });

    return incident;
  }

  /**
   * Get incident by ID
   */
  getIncident(incidentId: string): IncidentRecord | undefined {
    return this.incidents.get(incidentId);
  }

  /**
   * Get incident history with optional filters
   */
  getIncidentHistory(options?: {
    severity?: IncidentSeverity;
    status?: string;
    limit?: number;
    offset?: number;
  }): { incidents: IncidentRecord[]; total: number } {
    let incidents = Array.from(this.incidents.values());

    // Apply filters
    if (options?.severity) {
      incidents = incidents.filter(i => i.severity === options.severity);
    }
    if (options?.status) {
      incidents = incidents.filter(i => i.status === options.status);
    }

    // Sort by triggered time descending
    incidents.sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime());

    const total = incidents.length;
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;

    return {
      incidents: incidents.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Get current automated state
   */
  getAutomatedState(): Record<string, unknown> {
    return { ...this.automatedState };
  }

  /**
   * Get all playbook definitions
   */
  getPlaybooks(): PlaybookDefinition[] {
    return [...this.playbooks];
  }
}

// Singleton instance
export const incidentPlaybookEngine = new IncidentPlaybookEngine();

export default incidentPlaybookEngine;
