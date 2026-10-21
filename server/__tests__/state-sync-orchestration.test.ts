import { describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import {
  resolveSyncActor,
  StateSyncOrchestrationService,
  type SyncActor,
} from '../services/state-sync-orchestration.js';

function actor(role: 'admin' | 'operator' | 'observer', id: string): SyncActor {
  const permissions =
    role === 'observer'
      ? new Set(['sync:read'])
      : new Set(['sync:read', 'sync:operate']);

  return {
    id,
    role,
    permissions: permissions as Set<'sync:read' | 'sync:operate'>,
  };
}

describe('StateSyncOrchestrationService', () => {
  let now = Date.parse('2026-02-17T00:00:00.000Z');
  let service: StateSyncOrchestrationService;
  const jwtSecret = 'state-sync-wallet-login-secret'.padEnd(64, 'x');

  beforeEach(() => {
    process.env.STATE_SYNC_PROOF_TOKEN = 'test-proof-token';
    process.env.JWT_SECRET = jwtSecret;
    now = Date.parse('2026-02-17T00:00:00.000Z');
    service = new StateSyncOrchestrationService(() => now);
  });

  function walletLoginJwt(address: string): string {
    return jwt.sign(
      {
        sub: address,
        address,
        role: 'wallet',
        type: 'access',
      },
      jwtSecret,
      {
        algorithm: 'HS256',
        issuer: 'wrfcoin-platform',
        audience: 'wrfcoin-api',
        expiresIn: '15m',
        notBefore: 0,
      }
    );
  }

  it('does not grant operator authority from spoofed role headers', () => {
    const spoofed = resolveSyncActor(
      {
        'x-wrf-role': 'operator',
        'x-operator-id': 'attacker-controlled',
      },
      '203.0.113.10'
    );

    expect(spoofed).toMatchObject({
      id: '203.0.113.10',
      role: 'anonymous',
      ip: '203.0.113.10',
    });
    expect(spoofed.permissions.has('sync:operate')).toBe(false);

    const result = service.runAction(spoofed, {
      action: 'pause_all',
      operationNonce: 'nonce-spoofed-role',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unauthorized');
  });

  it('does not fall back to spoofed role headers when JWT verification fails', () => {
    const spoofed = resolveSyncActor(
      {
        authorization: 'Bearer not-a-real-wallet-login-jwt',
        'x-wrf-role': 'operator',
        'x-operator-id': 'attacker-controlled',
      },
      '203.0.113.11'
    );

    expect(spoofed.role).toBe('anonymous');
    expect(spoofed.id).toBe('203.0.113.11');
    expect(spoofed.permissions.has('sync:operate')).toBe(false);
  });

  it('derives operator authority from a verified wallet-login access JWT', () => {
    const address = '0x1234567890abcdef1234567890abcdef12345678';
    const signed = resolveSyncActor(
      {
        authorization: `Bearer ${walletLoginJwt(address)}`,
        'x-wrf-role': 'observer',
        'x-operator-id': 'client-controlled-id',
      },
      '203.0.113.12'
    );

    expect(signed).toMatchObject({
      id: address,
      role: 'operator',
      ip: '203.0.113.12',
    });
    expect(signed.permissions.has('sync:operate')).toBe(true);

    const result = service.runAction(signed, {
      action: 'pause_all',
      operationNonce: 'nonce-wallet-jwt-operator',
    });
    expect(result.ok).toBe(true);
  });

  it('enforces authz boundary for sync operations', () => {
    const result = service.runAction(actor('observer', 'observer-1'), {
      action: 'trigger_sync',
      operationNonce: 'nonce-authz-1',
      proofToken: 'test-proof-token',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('unauthorized');
  });

  it('applies anti-abuse burst guardrails', () => {
    const op = actor('operator', 'operator-burst');

    const first = service.runAction(op, {
      action: 'pause_all',
      operationNonce: 'nonce-burst-1',
    });
    const second = service.runAction(op, {
      action: 'pause_all',
      operationNonce: 'nonce-burst-2',
    });
    const third = service.runAction(op, {
      action: 'pause_all',
      operationNonce: 'nonce-burst-3',
    });
    const fourth = service.runAction(op, {
      action: 'pause_all',
      operationNonce: 'nonce-burst-4',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    expect(fourth.ok).toBe(false);
    expect(fourth.code).toBe('rate_limited');

    const status = service.getP2PSyncStatus(op);
    expect(status.antiAbuse.totalRequestsBlocked).toBeGreaterThan(0);
  });

  it('rejects replayed operation nonces and updates replay state', () => {
    const op = actor('operator', 'operator-replay');

    const first = service.runAction(op, {
      action: 'pause_all',
      operationNonce: 'nonce-replay-same',
    });

    const replayed = service.runAction(op, {
      action: 'pause_all',
      operationNonce: 'nonce-replay-same',
    });

    expect(first.ok).toBe(true);
    expect(replayed.ok).toBe(false);
    expect(replayed.code).toBe('replay_rejected');

    const sync = service.getStateSyncStatus(op);
    expect(sync.replay.status).toBe('rejected');
    expect(sync.replay.lastRejectedNonce).toBe('nonce-replay-same');
  });

  it('makes proof verification state explicit when invalid proof is supplied', () => {
    const op = actor('operator', 'operator-proof');

    const result = service.runAction(op, {
      action: 'trigger_sync',
      operationNonce: 'nonce-proof-1',
      proofToken: 'bad-proof-token',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_proof');

    const status = service.getStateSyncStatus(op);
    expect(status.proof.status).toBe('failed');
    expect(status.failureCauses.some(c => c.code === 'invalid_operator_proof')).toBe(true);
  });

  it('handles orchestration transitions across pause and resume', () => {
    const op = actor('operator', 'operator-transitions');

    const before = service.getP2PSyncStatus(op);
    const activeBefore = before.syncJobs.filter(j => j.status === 'active').length;
    expect(activeBefore).toBeGreaterThan(0);

    const paused = service.runAction(op, {
      action: 'pause_all',
      operationNonce: 'nonce-transition-pause',
    });

    expect(paused.ok).toBe(true);

    const pausedStatus = service.getP2PSyncStatus(op);
    const pausedJobs = pausedStatus.syncJobs.filter(j => j.status === 'paused').length;
    expect(pausedJobs).toBeGreaterThan(0);

    const pausedJob = pausedStatus.syncJobs.find(j => j.status === 'paused');
    expect(pausedJob).toBeDefined();

    const resumed = service.runAction(op, {
      action: 'resume_job',
      operationNonce: 'nonce-transition-resume',
      jobId: pausedJob!.id,
      proofToken: 'test-proof-token',
    });

    expect(resumed.ok).toBe(true);

    const resumedStatus = service.getP2PSyncStatus(op);
    const resumedJob = resumedStatus.syncJobs.find(j => j.id === pausedJob!.id);
    expect(['active', 'completed']).toContain(resumedJob?.status);
  });

  it('updates readiness when critical failures are present', () => {
    const op = actor('operator', 'operator-health');

    service.runAction(op, {
      action: 'trigger_sync',
      operationNonce: 'nonce-health-proof-fail',
      proofToken: 'bad-proof-token',
    });

    service.runAction(op, {
      action: 'pause_all',
      operationNonce: 'nonce-health-replay',
    });

    service.runAction(op, {
      action: 'pause_all',
      operationNonce: 'nonce-health-replay',
    });

    const status = service.getStateSyncStatus(op);
    expect(['degraded', 'unavailable']).toContain(status.readiness);
    expect(status.failureCauses.length).toBeGreaterThan(0);
  });
});
