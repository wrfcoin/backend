import { SybilDetectionService } from '../server/services/sybil-detection-service.js';

function highRiskIndicators() {
  return {
    ip_node_density: 5,
    subnet_density: 10,
    asn_density: 24,
    did_reuse_count: 5,
    device_fingerprint_collisions: 8,
    temporal_sync_score: 0.92,
    payload_similarity_score: 0.88,
    reward_destination_overlap: 0.84,
  };
}

describe('SybilDetectionService', () => {
  test('uses explicit versioned threshold configuration', () => {
    const service = new SybilDetectionService();
    const config = service.getThresholdConfig();

    expect(config.version).toMatch(/^2026-03-04\.v1$/);
    expect(config.policyHashReference).toContain('sha256:');
    expect(config.rules.ip_node_density.warnThreshold).toBe(2);
    expect(config.rules.did_reuse_count.highThreshold).toBe(4);
  });

  test('detects high-risk sybil clusters with explainable findings', () => {
    const service = new SybilDetectionService();
    const report = service.detect({
      participantId: 'participant-sybil-1',
      actorClass: 'human',
      indicators: highRiskIndicators(),
      source: 'alignment-telemetry',
    });

    expect(report.reportId).toMatch(/^SYB-\d{6}$/);
    expect(report.participantRef).toMatch(/^[a-f0-9]{20}$/);
    expect(report.participantRef).not.toContain('participant-sybil-1');
    expect(report.riskScore).toBeGreaterThan(55);
    expect(['probable_sybil', 'confirmed_cluster']).toContain(report.riskLevel);
    expect(report.findings.some(f => f.status === 'high')).toBe(true);
    expect(report.explainabilityNotes.length).toBeGreaterThan(0);
    expect(report.evidenceArtifacts.length).toBeGreaterThan(0);
    expect(report.privacySafeTelemetry).toBe(true);
  });

  test('remains actor-class neutral for equivalent indicators', () => {
    const service = new SybilDetectionService();
    const indicators = highRiskIndicators();

    const human = service.detect({
      participantId: 'actor-human',
      actorClass: 'human',
      indicators,
    });
    const ai = service.detect({
      participantId: 'actor-ai',
      actorClass: 'ai_agent',
      indicators,
    });
    const robot = service.detect({
      participantId: 'actor-robot',
      actorClass: 'robot',
      indicators,
    });

    expect(human.riskScore).toBe(ai.riskScore);
    expect(ai.riskScore).toBe(robot.riskScore);
    expect(human.riskLevel).toBe(ai.riskLevel);
    expect(ai.riskLevel).toBe(robot.riskLevel);
  });

  test('retains evidence artifacts and supports append flow', () => {
    const service = new SybilDetectionService();
    const report = service.detect({
      participantId: 'participant-evidence-1',
      actorClass: 'robot',
      indicators: {
        ip_node_density: 3,
        did_reuse_count: 2,
        temporal_sync_score: 0.55,
      },
    });

    const initialEvidence = service.getEvidence(report.reportId);
    expect(initialEvidence.length).toBeGreaterThan(0);
    expect(initialEvidence[0].referenceHash).toMatch(/^[a-f0-9]{20}$/);
    expect(JSON.stringify(initialEvidence)).not.toContain('participant-evidence-1');

    const artifact = service.appendEvidence(report.reportId, {
      type: 'manual_review_note',
      summary: 'Reviewed cluster graph and requested additional DID proof.',
      opaqueReference: 'case-12345',
    });
    expect(artifact.artifactId).toMatch(/^EV-SYB-\d{6}$/);

    const allEvidence = service.getEvidence(report.reportId);
    expect(allEvidence.length).toBe(initialEvidence.length + 1);
  });
});
