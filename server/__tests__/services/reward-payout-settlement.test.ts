/**
 * #215 — settlement helpers: claim_id construction (collision-safe), points→base
 * units, and payout-result → settlement mapping.
 */
import { describe, it, expect, jest } from '@jest/globals';

// shared/core4-route-client.js (imported transitively by reward-payout-client) is
// ESM; stub it so this suite loads under ts-jest/CJS.
jest.mock('../../../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(),
  extractCore4Data: (p: any) => p,
  getCore4ErrorMessage: (_p: any, f: string) => f,
}));

import {
  buildClaimId,
  pointsToBaseUnits,
  settlementFromPayout,
} from '../../services/reward-payout-settlement.js';

describe('buildClaimId', () => {
  it('uses the readable form when within 128 bytes', () => {
    expect(buildClaimId(1, 'first-report')).toBe('ach:v1:1:first-report');
  });

  it('is collision-safe for over-long achievement ids sharing a prefix', () => {
    const prefix = 'x'.repeat(200);
    const a = buildClaimId(1, `${prefix}-alpha`);
    const b = buildClaimId(1, `${prefix}-beta`);
    // Both are hashed (not truncated to the same 128-byte prefix) → distinct.
    expect(a).not.toBe(b);
    expect(a.startsWith('ach:v1:1:h:')).toBe(true);
    expect(Buffer.byteLength(a, 'utf8')).toBeLessThanOrEqual(128);
    // Deterministic.
    expect(buildClaimId(1, `${prefix}-alpha`)).toBe(a);
  });
});

describe('pointsToBaseUnits', () => {
  it('converts whole points to base units (1 point = 1 WRF = 1e8)', () => {
    expect(pointsToBaseUnits(50)).toBe(5_000_000_000n);
    expect(pointsToBaseUnits(0)).toBe(0n);
    expect(pointsToBaseUnits(-5)).toBe(0n);
    expect(pointsToBaseUnits(1.9)).toBe(100_000_000n); // floored
  });
});

describe('settlementFromPayout', () => {
  it('already_processed → settled / 200', () => {
    const s = settlementFromPayout({ kind: 'success', status: 'already_processed', txHash: null } as any);
    expect(s).toMatchObject({ settlement: 'settled', httpStatus: 200 });
  });
  it('accepted → settling / 202', () => {
    const s = settlementFromPayout({ kind: 'success', status: 'accepted', txHash: '0x1' } as any);
    expect(s).toMatchObject({ settlement: 'settling', txHash: '0x1', httpStatus: 202 });
  });
  it('retryable and error → pending / 202 (claim never lost)', () => {
    const r = settlementFromPayout({ kind: 'retryable', reason: 'over_supply', code: 'OVER_SUPPLY', message: 'x', httpStatus: 422 } as any);
    expect(r).toMatchObject({ settlement: 'pending', httpStatus: 202 });
    const e = settlementFromPayout({ kind: 'error', code: 'UNAUTHORIZED', message: 'x', httpStatus: 401 } as any);
    expect(e).toMatchObject({ settlement: 'pending', httpStatus: 202 });
  });
});
