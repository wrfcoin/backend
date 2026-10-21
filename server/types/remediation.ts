/**
 * Remediation Types - Shared types for the remediation API
 * Issue #256: Observability-to-remediation pipeline
 *
 * Defines the action allowlist, risk levels, rate limits, and
 * request/response interfaces for the remediation endpoints.
 */

import type { PlaybookAction, IncidentSeverity } from '../services/incidentPlaybookEngine.js';

// =====================================================
// RISK LEVELS & ACTION ALLOWLIST
// =====================================================

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ActionMeta {
  /** The playbook action identifier */
  action: PlaybookAction;
  /** Risk classification for this action */
  riskLevel: RiskLevel;
  /** Human-readable description of what the action does */
  description: string;
  /** Whether the operator must supply a reason before executing */
  requiresReason: boolean;
}

/**
 * Curated allowlist of actions that can be triggered through the remediation API.
 * Only these four actions are permitted; any other action string is rejected.
 * `emergency_key_rotation` is intentionally excluded due to its irreversible nature.
 */
export const ACTION_ALLOWLIST: readonly ActionMeta[] = [
  {
    action: 'escalate',
    riskLevel: 'low',
    description: 'Escalate the incident to the on-call team for manual review',
    requiresReason: false,
  },
  {
    action: 'tighten_caps',
    riskLevel: 'medium',
    description: 'Reduce transaction caps to 50% of normal limits',
    requiresReason: true,
  },
  {
    action: 'freeze_rewards',
    riskLevel: 'medium',
    description: 'Freeze reward distributions pending investigation',
    requiresReason: true,
  },
  {
    action: 'pause_bridge',
    riskLevel: 'high',
    description: 'Pause all cross-chain bridge transfers',
    requiresReason: true,
  },
] as const;

/**
 * Check whether the given action string is in the allowlist.
 */
export function isAllowlistedAction(action: string): boolean {
  return ACTION_ALLOWLIST.some(meta => meta.action === action);
}

/**
 * Retrieve metadata for an allowlisted action, or undefined if not found.
 */
export function getActionMeta(action: string): ActionMeta | undefined {
  return ACTION_ALLOWLIST.find(meta => meta.action === action);
}

// =====================================================
// RATE LIMITING
// =====================================================

/** Maximum number of remediation actions a single user can execute per hour */
export const REMEDIATION_RATE_LIMIT = 5;

// =====================================================
// REQUEST / RESPONSE INTERFACES
// =====================================================

export interface RemediationAlertResponse {
  id: string;
  alertName: string;
  severity: IncidentSeverity;
  status: 'firing' | 'resolved';
  description: string;
  availableActions: ActionMeta[];
  cooldownActive: boolean;
  cooldownRemainingSeconds: number;
}

export interface RemediationActionResponse {
  alertId: string;
  alertName: string;
  actions: ActionMeta[];
  cooldownActive: boolean;
  cooldownRemainingSeconds: number;
}

export interface RemediationResultResponse {
  incidentId: string;
  alertName: string;
  action: string;
  severity: string;
  status: string;
  actionsExecuted: Array<{
    action: string;
    success: boolean;
    details: string;
    reversible: boolean;
  }>;
}

export interface RemediationHistoryEntry {
  id: string;
  alertName: string;
  action: string;
  riskLevel: RiskLevel;
  reason: string | null;
  executedBy: string;
  executedAt: string;
  success: boolean;
  incidentId: string;
}

export interface RemediateRequestBody {
  action: string;
  reason?: string;
}
