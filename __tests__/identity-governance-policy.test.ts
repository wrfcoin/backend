/**
 * Identity Governance Policy Tests
 *
 * Covers:
 * - Authorized vs unauthorized mutation paths
 * - Role/permission boundary regressions
 * - Epoch lifecycle state transitions
 * - Replay/idempotency of policy evaluations
 * - Fail-closed behavior for ambiguous/missing context
 *
 * Issues: #252, #237
 */

import {
  evaluatePolicy,
  evaluatePolicyStatus,
  logGovernanceAudit,
  type PolicyAction,
  type PolicySubject,
  type PolicyDecision,
} from '../server/services/identity-governance-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubject(overrides: Partial<PolicySubject> = {}): PolicySubject {
  return {
    authenticated: true,
    userId: 'user-001',
    role: 'admin',
    permissions: ['identity:write', 'credential:issue', 'credential:revoke', 'key:manage', 'governance:write'],
    ...overrides,
  };
}

const ALL_ACTIONS: PolicyAction[] = [
  'credential:issue',
  'credential:revoke',
  'key_epoch:register',
  'key_epoch:rotate',
  'key_epoch:revoke',
  'governance:toggle_policy',
];

// ---------------------------------------------------------------------------
// Authentication gate tests
// ---------------------------------------------------------------------------

describe('Identity Governance - Authentication Gate', () => {
  test('unauthenticated subject is denied for every action', () => {
    const subject = makeSubject({ authenticated: false });

    for (const action of ALL_ACTIONS) {
      const decision = evaluatePolicy(action, subject);
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason).toBe('UNAUTHENTICATED');
      expect(decision.message).toContain('Authentication required');
    }
  });

  test('authenticated admin is allowed for every action', () => {
    const subject = makeSubject(); // admin with all perms

    for (const action of ALL_ACTIONS) {
      const decision = evaluatePolicy(action, subject);
      expect(decision.verdict).toBe('ALLOW');
      expect(decision.reason).toBe('AUTHORIZED');
    }
  });

  test('missing userId still evaluates if authenticated flag is true', () => {
    const subject = makeSubject({ userId: undefined });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------------------
// Role boundary tests
// ---------------------------------------------------------------------------

describe('Identity Governance - Role Boundaries', () => {
  test('user role cannot issue credentials', () => {
    const subject = makeSubject({ role: 'user' });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('DENY');
    expect(decision.reason).toBe('INSUFFICIENT_ROLE');
    expect(decision.message).toContain('role does not permit');
  });

  test('issuer role can issue credentials', () => {
    const subject = makeSubject({
      role: 'issuer',
      permissions: ['identity:write', 'credential:issue'],
    });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('ALLOW');
  });

  test('issuer role can revoke credentials', () => {
    const subject = makeSubject({
      role: 'issuer',
      permissions: ['identity:write', 'credential:revoke'],
    });
    const decision = evaluatePolicy('credential:revoke', subject);
    expect(decision.verdict).toBe('ALLOW');
  });

  test('validator role can register key epochs', () => {
    const subject = makeSubject({
      role: 'validator',
      permissions: ['identity:write', 'key:manage'],
    });
    const decision = evaluatePolicy('key_epoch:register', subject);
    expect(decision.verdict).toBe('ALLOW');
  });

  test('validator role cannot revoke key epochs (admin only)', () => {
    const subject = makeSubject({
      role: 'validator',
      permissions: ['identity:write', 'key:manage'],
    });
    const decision = evaluatePolicy('key_epoch:revoke', subject);
    expect(decision.verdict).toBe('DENY');
    expect(decision.reason).toBe('INSUFFICIENT_ROLE');
  });

  test('governance role can toggle policies', () => {
    const subject = makeSubject({
      role: 'governance',
      permissions: ['governance:write'],
    });
    const decision = evaluatePolicy('governance:toggle_policy', subject);
    expect(decision.verdict).toBe('ALLOW');
  });

  test('operator role can rotate but not revoke epochs', () => {
    const subject = makeSubject({
      role: 'operator',
      permissions: ['identity:write', 'key:manage'],
    });
    expect(evaluatePolicy('key_epoch:rotate', subject).verdict).toBe('ALLOW');
    expect(evaluatePolicy('key_epoch:revoke', subject).verdict).toBe('DENY');
  });

  test('role check is case-insensitive', () => {
    const subject = makeSubject({ role: 'ADMIN' });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------------------
// Permission boundary tests
// ---------------------------------------------------------------------------

describe('Identity Governance - Permission Boundaries', () => {
  test('admin role with no permissions is denied', () => {
    const subject = makeSubject({ permissions: [] });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('DENY');
    expect(decision.reason).toBe('INSUFFICIENT_PERMISSION');
  });

  test('admin role with only read permission is denied', () => {
    const subject = makeSubject({ permissions: ['identity:read'] });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('DENY');
    expect(decision.reason).toBe('INSUFFICIENT_PERMISSION');
  });

  test('any single matching permission suffices', () => {
    const subject = makeSubject({
      permissions: ['credential:issue'],
    });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('ALLOW');
  });

  test('permission check is case-insensitive', () => {
    const subject = makeSubject({
      permissions: ['CREDENTIAL:ISSUE'],
    });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behavior
// ---------------------------------------------------------------------------

describe('Identity Governance - Fail-Closed', () => {
  test('undefined role defaults to empty string and fails', () => {
    const subject = makeSubject({ role: undefined });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('DENY');
    expect(decision.reason).toBe('INSUFFICIENT_ROLE');
  });

  test('undefined permissions defaults to empty array and fails', () => {
    const subject = makeSubject({ permissions: undefined });
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('DENY');
    expect(decision.reason).toBe('INSUFFICIENT_PERMISSION');
  });

  test('null-ish subject fields do not cause exceptions', () => {
    const subject: PolicySubject = {
      authenticated: true,
      userId: undefined,
      role: undefined,
      permissions: undefined,
    };
    expect(() => evaluatePolicy('credential:issue', subject)).not.toThrow();
    const decision = evaluatePolicy('credential:issue', subject);
    expect(decision.verdict).toBe('DENY');
  });
});

// ---------------------------------------------------------------------------
// Determinism / Idempotency
// ---------------------------------------------------------------------------

describe('Identity Governance - Determinism', () => {
  test('same inputs produce same verdict (no randomness)', () => {
    const subject = makeSubject();
    const d1 = evaluatePolicy('credential:issue', subject);
    const d2 = evaluatePolicy('credential:issue', subject);

    expect(d1.verdict).toBe(d2.verdict);
    expect(d1.reason).toBe(d2.reason);
    expect(d1.action).toBe(d2.action);
  });

  test('decision includes ISO timestamp', () => {
    const decision = evaluatePolicy('credential:issue', makeSubject());
    expect(decision.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('decision message does not leak internal details', () => {
    const decision = evaluatePolicy('credential:issue', makeSubject({ authenticated: false }));
    // Should not contain stack traces, file paths, or internal config
    expect(decision.message).not.toMatch(/\.(ts|js)|node_modules|__dirname/);
    expect(decision.message).not.toContain('Error:');
  });
});

// ---------------------------------------------------------------------------
// Policy Status (batch evaluation for frontend)
// ---------------------------------------------------------------------------

describe('Identity Governance - Policy Status', () => {
  test('admin gets all capabilities', () => {
    const status = evaluatePolicyStatus(makeSubject());
    expect(status.canIssueCredential).toBe(true);
    expect(status.canRevokeCredential).toBe(true);
    expect(status.canRegisterKeyEpoch).toBe(true);
    expect(status.canRotateKeyEpoch).toBe(true);
    expect(status.canRevokeKeyEpoch).toBe(true);
    expect(status.canTogglePolicy).toBe(true);
    expect(Object.keys(status.denialReasons)).toHaveLength(0);
  });

  test('unauthenticated gets zero capabilities', () => {
    const status = evaluatePolicyStatus({ authenticated: false });
    expect(status.canIssueCredential).toBe(false);
    expect(status.canRevokeCredential).toBe(false);
    expect(status.canRegisterKeyEpoch).toBe(false);
    expect(status.canRotateKeyEpoch).toBe(false);
    expect(status.canRevokeKeyEpoch).toBe(false);
    expect(status.canTogglePolicy).toBe(false);
    expect(Object.keys(status.denialReasons).length).toBeGreaterThan(0);
  });

  test('validator gets key epoch register/rotate but not revoke', () => {
    const subject = makeSubject({
      role: 'validator',
      permissions: ['identity:write', 'key:manage'],
    });
    const status = evaluatePolicyStatus(subject);
    expect(status.canRegisterKeyEpoch).toBe(true);
    expect(status.canRotateKeyEpoch).toBe(true);
    expect(status.canRevokeKeyEpoch).toBe(false);
    expect(status.canIssueCredential).toBe(false);
    expect(status.denialReasons).toHaveProperty('key_epoch:revoke');
  });

  test('evaluatedAt is a valid ISO timestamp', () => {
    const status = evaluatePolicyStatus(makeSubject());
    expect(status.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Audit logging (smoke test - just ensure no crash)
// ---------------------------------------------------------------------------

describe('Identity Governance - Audit Logging', () => {
  test('logGovernanceAudit does not throw for allow decision', () => {
    const decision: PolicyDecision = {
      verdict: 'ALLOW',
      action: 'credential:issue',
      reason: 'AUTHORIZED',
      message: 'Authorized',
      timestamp: new Date().toISOString(),
    };
    expect(() =>
      logGovernanceAudit({
        action: 'credential:issue',
        decision,
        subjectId: 'user-001',
        subjectRole: 'admin',
        resourceId: 'vc:wrf:test',
      }),
    ).not.toThrow();
  });

  test('logGovernanceAudit does not throw for deny decision', () => {
    const decision: PolicyDecision = {
      verdict: 'DENY',
      action: 'key_epoch:revoke',
      reason: 'INSUFFICIENT_ROLE',
      message: 'Denied',
      timestamp: new Date().toISOString(),
    };
    expect(() =>
      logGovernanceAudit({
        action: 'key_epoch:revoke',
        decision,
        subjectId: undefined,
        subjectRole: undefined,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Epoch lifecycle state transition tests
// ---------------------------------------------------------------------------

describe('Identity Governance - Epoch Lifecycle Transitions', () => {
  test('register requires key:manage + validator/operator/admin role', () => {
    // Valid: validator with key:manage
    expect(
      evaluatePolicy('key_epoch:register', makeSubject({
        role: 'validator',
        permissions: ['identity:write', 'key:manage'],
      })).verdict,
    ).toBe('ALLOW');

    // Valid: operator with key:manage
    expect(
      evaluatePolicy('key_epoch:register', makeSubject({
        role: 'operator',
        permissions: ['key:manage'],
      })).verdict,
    ).toBe('ALLOW');

    // Invalid: governance role (not in required roles)
    expect(
      evaluatePolicy('key_epoch:register', makeSubject({
        role: 'governance',
        permissions: ['key:manage'],
      })).verdict,
    ).toBe('DENY');
  });

  test('rotate follows same role rules as register', () => {
    const operatorSubject = makeSubject({
      role: 'operator',
      permissions: ['identity:write', 'key:manage'],
    });
    expect(evaluatePolicy('key_epoch:rotate', operatorSubject).verdict).toBe('ALLOW');
  });

  test('revoke is admin-only (most restrictive)', () => {
    const roles = ['validator', 'operator', 'issuer', 'governance', 'user'];
    for (const role of roles) {
      const decision = evaluatePolicy('key_epoch:revoke', makeSubject({
        role,
        permissions: ['identity:write', 'key:manage'],
      }));
      expect(decision.verdict).toBe('DENY');
      expect(decision.reason).toBe('INSUFFICIENT_ROLE');
    }

    // Only admin
    expect(
      evaluatePolicy('key_epoch:revoke', makeSubject({
        role: 'admin',
        permissions: ['identity:write', 'key:manage'],
      })).verdict,
    ).toBe('ALLOW');
  });

  test('lifecycle progression: register -> rotate -> revoke requires escalating privileges', () => {
    // Operator can register and rotate
    const operator = makeSubject({
      role: 'operator',
      permissions: ['identity:write', 'key:manage'],
    });
    expect(evaluatePolicy('key_epoch:register', operator).verdict).toBe('ALLOW');
    expect(evaluatePolicy('key_epoch:rotate', operator).verdict).toBe('ALLOW');
    expect(evaluatePolicy('key_epoch:revoke', operator).verdict).toBe('DENY');

    // Admin can do all three
    const admin = makeSubject();
    expect(evaluatePolicy('key_epoch:register', admin).verdict).toBe('ALLOW');
    expect(evaluatePolicy('key_epoch:rotate', admin).verdict).toBe('ALLOW');
    expect(evaluatePolicy('key_epoch:revoke', admin).verdict).toBe('ALLOW');
  });
});
