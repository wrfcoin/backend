/**
 * Identity Governance Service
 *
 * Evaluates authorization policies for identity mutations:
 * - Credential issuance and revocation
 * - Key epoch registration, rotation, and revocation
 * - Governance policy toggle
 *
 * Produces deterministic PolicyDecision outputs with sanitized reason codes.
 * Implements fail-closed semantics: ambiguous or missing context = DENY.
 *
 * Issues: #252, #237
 */

import { appLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyAction =
  | 'credential:issue'
  | 'credential:revoke'
  | 'key_epoch:register'
  | 'key_epoch:rotate'
  | 'key_epoch:revoke'
  | 'governance:toggle_policy';

export type PolicyVerdict = 'ALLOW' | 'DENY';

export type PolicyDenyReason =
  | 'UNAUTHENTICATED'
  | 'INSUFFICIENT_ROLE'
  | 'INSUFFICIENT_PERMISSION'
  | 'SCOPE_RESTRICTED'
  | 'POLICY_DISABLED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface PolicyDecision {
  verdict: PolicyVerdict;
  action: PolicyAction;
  reason: PolicyDenyReason | 'AUTHORIZED';
  /** Human-readable message safe for client display (no internal details). */
  message: string;
  /** ISO-8601 timestamp of the decision. */
  timestamp: string;
}

export interface PolicySubject {
  userId?: string;
  role?: string;
  permissions?: string[];
  authenticated: boolean;
}

// ---------------------------------------------------------------------------
// Permission requirements per action
// ---------------------------------------------------------------------------

const ACTION_REQUIREMENTS: Record<
  PolicyAction,
  { requiredPermissions: string[]; requiredRoles: string[] }
> = {
  'credential:issue': {
    requiredPermissions: ['identity:write', 'credential:issue'],
    requiredRoles: ['admin', 'issuer', 'governance'],
  },
  'credential:revoke': {
    requiredPermissions: ['identity:write', 'credential:revoke'],
    requiredRoles: ['admin', 'issuer', 'governance'],
  },
  'key_epoch:register': {
    requiredPermissions: ['identity:write', 'key:manage'],
    requiredRoles: ['admin', 'validator', 'operator'],
  },
  'key_epoch:rotate': {
    requiredPermissions: ['identity:write', 'key:manage'],
    requiredRoles: ['admin', 'validator', 'operator'],
  },
  'key_epoch:revoke': {
    requiredPermissions: ['identity:write', 'key:manage'],
    requiredRoles: ['admin'],
  },
  'governance:toggle_policy': {
    requiredPermissions: ['governance:write'],
    requiredRoles: ['admin', 'governance'],
  },
};

// Human-readable action labels for messages
const ACTION_LABELS: Record<PolicyAction, string> = {
  'credential:issue': 'issue credentials',
  'credential:revoke': 'revoke credentials',
  'key_epoch:register': 'register key epochs',
  'key_epoch:rotate': 'rotate key epochs',
  'key_epoch:revoke': 'revoke key epochs',
  'governance:toggle_policy': 'modify governance policies',
};

// ---------------------------------------------------------------------------
// Policy Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the given subject is authorized for the given action.
 *
 * Fail-closed: any ambiguity or missing data results in DENY.
 */
export function evaluatePolicy(
  action: PolicyAction,
  subject: PolicySubject,
): PolicyDecision {
  const now = new Date().toISOString();
  const label = ACTION_LABELS[action] || action;

  // Gate 1: Authentication
  if (!subject.authenticated) {
    return {
      verdict: 'DENY',
      action,
      reason: 'UNAUTHENTICATED',
      message: `Authentication required to ${label}.`,
      timestamp: now,
    };
  }

  const requirements = ACTION_REQUIREMENTS[action];
  if (!requirements) {
    // Unknown action => fail closed
    appLogger.warn('Policy evaluation for unknown action', {
      module: 'IdentityGovernance',
      action,
    });
    return {
      verdict: 'DENY',
      action,
      reason: 'SCOPE_RESTRICTED',
      message: 'This operation is not permitted.',
      timestamp: now,
    };
  }

  // Gate 2: Role check (any matching role suffices)
  const subjectRole = (subject.role || '').toLowerCase();
  const hasRole = requirements.requiredRoles.some(
    (r) => r.toLowerCase() === subjectRole,
  );

  if (!hasRole) {
    return {
      verdict: 'DENY',
      action,
      reason: 'INSUFFICIENT_ROLE',
      message: `Your current role does not permit you to ${label}. Required: ${requirements.requiredRoles.join(', ')}.`,
      timestamp: now,
    };
  }

  // Gate 3: Permission check (any matching permission suffices)
  const subjectPerms = (subject.permissions || []).map((p) => p.toLowerCase());
  const hasPerm = requirements.requiredPermissions.some((p) =>
    subjectPerms.includes(p.toLowerCase()),
  );

  if (!hasPerm) {
    return {
      verdict: 'DENY',
      action,
      reason: 'INSUFFICIENT_PERMISSION',
      message: `You lack the required permissions to ${label}.`,
      timestamp: now,
    };
  }

  // All gates passed
  return {
    verdict: 'ALLOW',
    action,
    reason: 'AUTHORIZED',
    message: `Authorized to ${label}.`,
    timestamp: now,
  };
}

// ---------------------------------------------------------------------------
// Batch policy evaluation for frontend policy-status endpoint
// ---------------------------------------------------------------------------

export interface PolicyStatusResponse {
  canIssueCredential: boolean;
  canRevokeCredential: boolean;
  canRegisterKeyEpoch: boolean;
  canRotateKeyEpoch: boolean;
  canRevokeKeyEpoch: boolean;
  canTogglePolicy: boolean;
  denialReasons: Record<string, string>;
  evaluatedAt: string;
}

/**
 * Evaluate all identity actions for a given subject and return
 * a summary suitable for driving frontend UI state.
 */
export function evaluatePolicyStatus(
  subject: PolicySubject,
): PolicyStatusResponse {
  const actions: PolicyAction[] = [
    'credential:issue',
    'credential:revoke',
    'key_epoch:register',
    'key_epoch:rotate',
    'key_epoch:revoke',
    'governance:toggle_policy',
  ];

  const decisions = actions.map((action) => ({
    action,
    decision: evaluatePolicy(action, subject),
  }));

  const denialReasons: Record<string, string> = {};
  for (const { action, decision } of decisions) {
    if (decision.verdict === 'DENY') {
      denialReasons[action] = decision.message;
    }
  }

  const allowed = (a: PolicyAction) =>
    decisions.find((d) => d.action === a)!.decision.verdict === 'ALLOW';

  return {
    canIssueCredential: allowed('credential:issue'),
    canRevokeCredential: allowed('credential:revoke'),
    canRegisterKeyEpoch: allowed('key_epoch:register'),
    canRotateKeyEpoch: allowed('key_epoch:rotate'),
    canRevokeKeyEpoch: allowed('key_epoch:revoke'),
    canTogglePolicy: allowed('governance:toggle_policy'),
    denialReasons,
    evaluatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Audit logging helper
// ---------------------------------------------------------------------------

export interface GovernanceAuditEntry {
  action: PolicyAction;
  decision: PolicyDecision;
  subjectId: string | undefined;
  subjectRole: string | undefined;
  resourceId?: string;
  ipAddress?: string;
}

/**
 * Log a governance policy decision to the audit trail.
 * Intentionally does NOT include sensitive details (tokens, keys).
 */
export function logGovernanceAudit(entry: GovernanceAuditEntry): void {
  const level = entry.decision.verdict === 'DENY' ? 'warn' : 'info';
  appLogger[level]('Identity governance decision', {
    module: 'IdentityGovernance',
    action: entry.action,
    verdict: entry.decision.verdict,
    reason: entry.decision.reason,
    subjectId: entry.subjectId || 'anonymous',
    subjectRole: entry.subjectRole || 'none',
    resourceId: entry.resourceId || 'N/A',
    timestamp: entry.decision.timestamp,
  });
}
