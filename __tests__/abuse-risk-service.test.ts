import {
  AbuseRiskService,
  ActorClass,
  RiskFactorKey,
} from '../server/services/abuse-risk-service.js';

function createHighRiskIndicators(): Record<RiskFactorKey, number> {
  return {
    spam_burst: 0.92,
    duplicate_payload: 0.84,
    failed_submission_rate: 0.52,
    shared_counterparty_overlap: 0.78,
    reciprocal_cluster_rate: 0.81,
    coordinated_timing_pattern: 0.73,
    price_impact_anomaly: 0.69,
    rapid_reversal_pattern: 0.66,
    sanction_recidivism: 0.51,
  };
}

describe('AbuseRiskService', () => {
  test('computes explainable abuse risk with top-factor notes', () => {
    const service = new AbuseRiskService();
    const assessment = service.assessParticipant({
      participantId: 'participant-001',
      actorClass: 'human',
      indicators: createHighRiskIndicators(),
      evidenceConfidence: 0.88,
      appealOverturnRate: 0.05,
    });

    expect(assessment.assessmentId).toMatch(/^RISK-\d{6}$/);
    expect(assessment.participantRef).toMatch(/^[a-f0-9]{16}$/);
    expect(assessment.participantRef).not.toContain('participant-001');
    expect(assessment.riskScore).toBeGreaterThan(50);
    expect(['high', 'critical']).toContain(assessment.riskBand);
    expect(assessment.explainabilityNotes.length).toBeGreaterThan(0);
    expect(assessment.falsePositiveHandling.actorClassNeutrality).toBe(true);
    expect(assessment.privacySafeTelemetry).toBe(true);
  });

  test('produces actor-class-neutral score for identical indicators', () => {
    const service = new AbuseRiskService();
    const actors: ActorClass[] = ['human', 'ai_agent', 'robot'];

    const scores = actors.map(actorClass =>
      service.assessParticipant({
        participantId: `participant-${actorClass}`,
        actorClass,
        indicators: createHighRiskIndicators(),
        evidenceConfidence: 0.9,
        appealOverturnRate: 0.02,
      }).riskScore
    );

    expect(scores[0]).toBe(scores[1]);
    expect(scores[1]).toBe(scores[2]);
  });

  test('routes to manual false-positive flow on elevated overturn rates', () => {
    const service = new AbuseRiskService();
    const assessment = service.assessParticipant({
      participantId: 'participant-review-needed',
      actorClass: 'robot',
      indicators: createHighRiskIndicators(),
      evidenceConfidence: 0.8,
      appealOverturnRate: 0.34,
    });

    expect(assessment.falsePositiveHandling.reviewRequired).toBe(true);
    expect(assessment.falsePositiveHandling.recommendedAction).toBe('expedited_appeal');
    expect(assessment.falsePositiveHandling.steps.join(' ')).toContain('fast-track appeal');
  });

  test('tracks precision/recall proxy and overturn telemetry metrics', () => {
    const service = new AbuseRiskService();
    const a1 = service.assessParticipant({
      participantId: 'participant-a1',
      actorClass: 'human',
      indicators: createHighRiskIndicators(),
    });
    const a2 = service.assessParticipant({
      participantId: 'participant-a2',
      actorClass: 'ai_agent',
      indicators: createHighRiskIndicators(),
    });
    const a3 = service.assessParticipant({
      participantId: 'participant-a3',
      actorClass: 'robot',
      indicators: createHighRiskIndicators(),
    });

    service.recordOutcome(a1.assessmentId, 'confirmed_abuse');
    service.recordOutcome(a2.assessmentId, 'false_positive');
    service.recordOutcome(a3.assessmentId, 'appeal_overturned');

    const metrics = service.getMetrics();
    expect(metrics.totalAssessments).toBe(3);
    expect(metrics.outcomes.confirmed_abuse).toBe(1);
    expect(metrics.outcomes.false_positive).toBe(1);
    expect(metrics.outcomes.appeal_overturned).toBe(1);
    expect(metrics.precision).toBe(0.5);
    expect(metrics.recallProxy).toBe(0.5);
    expect(metrics.appealOverturnRate).toBe(1);
    expect(metrics.falsePositiveRate).toBe(0.5);
  });
});
