import {
  ExpertAdvisoryService,
  type AdvisoryFeatureAttribution,
} from '../../server/services/aiml/expert-advisory-service.js';

describe('ExpertAdvisoryService', () => {
  it('returns deterministic advisory level and evidence bundle', async () => {
    const service = new ExpertAdvisoryService({
      nowFn: () => new Date('2026-03-05T12:00:00Z'),
    });

    const decision = await service.evaluate({
      eventClass: 'flood',
      alerts: [
        {
          id: 'A1',
          event: 'Flood Warning',
          type: 'flood',
          severityClass: 'warning',
          sourceSeverity: 'Severe',
          areaDesc: 'River Basin',
          affectedZones: [],
          geocode: {},
          sent: '2026-03-05T11:00:00Z',
          effective: '2026-03-05T11:00:00Z',
          onset: null,
          expires: '2026-03-05T18:00:00Z',
          ends: null,
          status: 'Actual',
          messageType: 'Alert',
          category: 'Met',
          certainty: 'Likely',
          urgency: 'Immediate',
          sender: 'NWS',
          senderName: 'NWS',
          headline: 'Flood Warning in effect',
          description: 'Heavy rain and runoff',
          instruction: 'Move to higher ground',
          response: 'Shelter',
          parameters: {},
          references: [],
          sourceLocations: ['test'],
          firstSeenAt: '2026-03-05T11:00:00Z',
          lastSeenAt: '2026-03-05T11:00:00Z',
          lastUpdatedAt: '2026-03-05T11:00:00Z',
        },
      ] as any,
      measurements: {
        rainRateInPerHour: 2.4,
      },
      modelAssist: false,
    });

    expect(decision.advisoryLevel).toBe('warning');
    expect(decision.evidenceBundle.matchedRules.length).toBeGreaterThan(0);
    expect(decision.ruleBundleVersion).toBe('v1');
  });

  it('uses model adapter when enabled and available', async () => {
    const attributions: AdvisoryFeatureAttribution[] = [
      { feature: 'rainRateInPerHour', contribution: 0.6, value: 3.1 },
      { feature: 'warningAlerts', contribution: 0.4, value: 1 },
    ];

    const service = new ExpertAdvisoryService({
      modelAdapter: {
        score: async () => ({
          confidence: 0.85,
          modelVersion: 'advisory-model-1.2.0',
          attributions,
        }),
      },
      nowFn: () => new Date('2026-03-05T12:00:00Z'),
    });

    const decision = await service.evaluate({
      eventClass: 'storm',
      alerts: [],
      measurements: {
        windGustMph: 60,
      },
      modelAssist: true,
    });

    expect(decision.model.enabled).toBe(true);
    expect(decision.model.used).toBe(true);
    expect(decision.model.version).toBe('advisory-model-1.2.0');
    expect(decision.model.featureAttribution).toEqual(attributions);
  });

  it('falls back deterministically when model fails', async () => {
    const service = new ExpertAdvisoryService({
      modelAdapter: {
        score: async () => {
          throw new Error('model unavailable');
        },
      },
      nowFn: () => new Date('2026-03-05T12:00:00Z'),
    });

    const decision = await service.evaluate({
      eventClass: 'heat',
      alerts: [],
      measurements: {
        heatIndexF: 108,
      },
      modelAssist: true,
    });

    expect(decision.model.enabled).toBe(true);
    expect(decision.model.fallbackUsed).toBe(true);
    expect(decision.advisoryLevel === 'warning' || decision.advisoryLevel === 'watch').toBe(true);
  });
});
