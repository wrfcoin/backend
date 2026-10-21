/**
 * Regression test for #901: the /api/integrity/calibration family gates
 * anti-abuse threshold activate/rollback behind authenticateJWT, matching its
 * siblings (abuse-risk, sybil-detection).
 */
import { describe, expect, it, jest } from '@jest/globals';

const authSentinel = jest.fn((_req: any, _res: any, next: any) => next());

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: authSentinel,
}));

jest.mock('../../server/services/integrity-threshold-calibration-service.js', () => ({
  IntegrityThresholdCalibrationService: class {},
  integrityThresholdCalibrationService: {},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createIntegrityCalibrationRouter } = require('../../server/routes/integrity-calibration-routes.ts');

describe('integrity-calibration-routes auth (#901)', () => {
  it('mounts authenticateJWT ahead of every route', () => {
    const router = createIntegrityCalibrationRouter();
    const authIdx = router.stack.findIndex((l: any) => l.handle === authSentinel);
    const firstRouteIdx = router.stack.findIndex((l: any) => l.route);
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(firstRouteIdx).toBeGreaterThan(authIdx);
  });
});
