import { describe, it, expect, beforeEach } from '@jest/globals';
import { ResilienceCoreService } from '../../server/services/resilience-core-service.js';

describe('ResilienceCoreService', () => {
  let service: ResilienceCoreService;

  beforeEach(() => {
    service = new ResilienceCoreService();
  });

  it('flags geoblocking indicators in participation compliance', () => {
    service.addParticipationAuditEvent({
      source: 'ingress-gateway',
      ruleId: 'ingress.rule.1',
      action: 'deny',
      reasonCode: 'country_block',
      reasonText: 'country_deny list matched',
      actorFingerprint: 'actor-a',
    });

    const status = service.getParticipationComplianceStatus();
    expect(status.geoblockingViolations).toBe(1);
    expect(status.status).toBe('fail');
    expect(status.privacySafeTelemetry).toBe(true);
  });

  it('computes relay health and censorship degradation', () => {
    service.addRelayObservation({
      routeId: 'submit-v1',
      provider: 'relay-a',
      region: 'us-west',
      reachable: true,
      censorshipSignal: 'none',
    });
    service.addRelayObservation({
      routeId: 'submit-v1',
      provider: 'relay-b',
      region: 'eu-central',
      reachable: false,
      censorshipSignal: 'suspected',
    });
    service.addRelayObservation({
      routeId: 'submit-v1',
      provider: 'relay-c',
      region: 'ap-southeast',
      reachable: true,
      censorshipSignal: 'none',
    });
    service.addRelayObservation({
      routeId: 'submit-v1',
      provider: 'relay-d',
      region: 'sa-east',
      reachable: true,
      censorshipSignal: 'none',
    });

    const relay = service.getRelayHealth();
    expect(relay.status).toBe('degraded');
    expect(relay.censorshipSignalCount).toBeGreaterThanOrEqual(1);
    expect(relay.routes[0].routeId).toBe('submit-v1');
  });

  it('enforces synthetic incident state transitions', () => {
    const incident = service.createSyntheticIncident({
      campaignType: 'astroturf',
      severity: 'high',
      actorClass: 'ai-agent',
      summary: 'coordinated synthetic engagement spike',
    });

    service.transitionSyntheticIncident(incident.id, 'quarantined', 'threshold exceeded');
    const reviewed = service.transitionSyntheticIncident(incident.id, 'reviewed', 'manual triage');

    expect(reviewed.state).toBe('reviewed');
    expect(reviewed.history.length).toBe(3);

    expect(() =>
      service.transitionSyntheticIncident(incident.id, 'detected', 'invalid back transition')
    ).toThrow(/Invalid transition/);
  });

  it('exposes privacy-safe alignment KPI summary payload', () => {
    service.addForecastCoverageSnapshot({
      domain: 'soil',
      reportCount: 15,
      confidenceScore: 0.82,
    });
    service.addForecastCoverageSnapshot({
      domain: 'ocean',
      reportCount: 12,
      confidenceScore: 0.8,
    });
    service.addForecastCoverageSnapshot({
      domain: 'hydrology',
      reportCount: 18,
      confidenceScore: 0.84,
    });
    service.addForecastCoverageSnapshot({
      domain: 'atmosphere',
      reportCount: 20,
      confidenceScore: 0.86,
    });

    const summary = service.getAlignmentKpiSummary();
    expect(summary.privacySafeTelemetry).toBe(true);
    expect(summary.kpis.forecastCoverage.coveragePercent).toBe(100);
    expect(summary.kpis.participationAccessibility).toHaveProperty('relayAvailabilityPercent');
    expect(summary.kpis.sanctionsParity).toHaveProperty('actorNeutrality');
    expect(summary.rubricMapping.length).toBeGreaterThanOrEqual(4);
  });
});
