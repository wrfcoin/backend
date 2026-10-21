import {
  IntegrityThresholdCalibrationService,
  type LabeledOutcomeSample,
} from '../server/services/integrity-threshold-calibration-service.js';

function sample(
  actorClass: 'human' | 'ai_agent' | 'robot',
  model: 'abuse-risk' | 'sybil-detection',
  score: number,
  groundTruth: 'abuse' | 'benign',
): LabeledOutcomeSample {
  return {
    actorClass,
    model,
    score,
    groundTruth,
  };
}

describe('IntegrityThresholdCalibrationService', () => {
  let service: IntegrityThresholdCalibrationService;

  beforeEach(() => {
    service = new IntegrityThresholdCalibrationService();
  });

  test('runs calibration pipeline and exports fairness/fp metrics', () => {
    const samples: LabeledOutcomeSample[] = [
      sample('human', 'abuse-risk', 88, 'abuse'),
      sample('human', 'abuse-risk', 42, 'benign'),
      sample('human', 'sybil-detection', 75, 'abuse'),
      sample('ai_agent', 'abuse-risk', 81, 'abuse'),
      sample('ai_agent', 'abuse-risk', 31, 'benign'),
      sample('ai_agent', 'sybil-detection', 69, 'abuse'),
      sample('robot', 'abuse-risk', 84, 'abuse'),
      sample('robot', 'abuse-risk', 37, 'benign'),
      sample('robot', 'sybil-detection', 74, 'abuse'),
    ];

    const report = service.runCalibrationJob({
      requestedBy: 'analyst-1',
      samples,
      notes: 'phase-2 fairness tuning',
    });

    expect(report.runId).toMatch(/^CALRUN-\d{6}$/);
    expect(report.sampleCount).toBe(9);
    expect(report.metrics.falsePositiveRateByActorClass).toHaveProperty('human');
    expect(report.metrics.falsePositiveRateByActorClass).toHaveProperty('ai_agent');
    expect(report.metrics.falsePositiveRateByActorClass).toHaveProperty('robot');
    expect(report.metrics.parity.falsePositiveRateGap).toBeGreaterThanOrEqual(0);

    const latest = service.getLatestMetrics();
    expect(latest?.samples).toBe(9);
  });

  test('activates candidate config and supports rollback to prior version', () => {
    const activeBefore = service.getActiveConfig();

    const samples: LabeledOutcomeSample[] = [
      sample('human', 'abuse-risk', 90, 'abuse'),
      sample('human', 'sybil-detection', 25, 'benign'),
      sample('human', 'abuse-risk', 52, 'benign'),
      sample('ai_agent', 'abuse-risk', 88, 'abuse'),
      sample('ai_agent', 'sybil-detection', 44, 'benign'),
      sample('ai_agent', 'abuse-risk', 50, 'benign'),
      sample('robot', 'abuse-risk', 86, 'abuse'),
      sample('robot', 'sybil-detection', 43, 'benign'),
      sample('robot', 'abuse-risk', 49, 'benign'),
    ];

    const report = service.runCalibrationJob({
      requestedBy: 'analyst-2',
      samples,
      activateCandidate: true,
    });

    const activeAfter = service.getActiveConfig();
    expect(activeAfter.version).toBe(report.candidateConfigVersion);

    const rolledBack = service.rollbackConfig({
      targetVersion: activeBefore.version,
      requestedBy: 'analyst-2',
      reason: 'restore known-good thresholds',
    });

    expect(rolledBack.version).toBe(activeBefore.version);
    expect(service.getActiveConfig().version).toBe(activeBefore.version);
  });

  test('rejects calibration run when actor-class labels are insufficient', () => {
    const samples: LabeledOutcomeSample[] = [
      sample('human', 'abuse-risk', 70, 'abuse'),
      sample('human', 'abuse-risk', 35, 'benign'),
      sample('human', 'sybil-detection', 60, 'abuse'),
    ];

    expect(() =>
      service.runCalibrationJob({
        requestedBy: 'analyst-3',
        samples,
      }),
    ).toThrow(/Insufficient labeled outcomes/);
  });
});
