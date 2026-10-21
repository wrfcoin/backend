const { expect } = require('chai');
const {
  AntiFraudQualityPipeline,
  AntiFraudReasonCodes,
  PENALTY_POINTS,
  getSharedAntiFraudQualityPipeline,
} = require('../services/anti-fraud-quality-pipeline');
const WeatherIngestionValidator = require('../services/weather-ingestion-validator');

function createState() {
  return {
    fingerprintSeenAt: new Map(),
    sourceHistory: new Map(),
    crossSourceBuckets: new Map(),
    events: [],
    metrics: {
      totalEvaluated: 0,
      accepted: 0,
      rejected: 0,
      penalized: 0,
      reasonCounts: {},
      riskLevelCounts: {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      },
      lastEvaluatedAt: null,
    },
  };
}

function buildPayload(overrides = {}) {
  const base = {
    metadata: {
      sourceId: 'station-001',
      sourceType: 'api',
      provider: 'NOAA-NWS',
      dataType: 'current',
      timestamp: new Date().toISOString(),
    },
    location: {
      latitude: 41.98,
      longitude: -87.9,
    },
    measurements: {
      temperature: { value: 20, unit: 'celsius' },
      humidity: { value: 60, unit: 'percent' },
      pressure: { value: 1013, unit: 'hPa' },
    },
  };

  return {
    ...base,
    ...overrides,
    metadata: {
      ...base.metadata,
      ...(overrides.metadata || {}),
    },
    location: {
      ...base.location,
      ...(overrides.location || {}),
    },
    measurements: {
      ...base.measurements,
      ...(overrides.measurements || {}),
    },
  };
}

describe('Anti-Fraud Quality Pipeline (#204)', () => {
  let pipeline;

  beforeEach(() => {
    pipeline = new AntiFraudQualityPipeline({ state: createState() });
    getSharedAntiFraudQualityPipeline().resetStateForTests();
  });

  it('accepts valid payloads with low risk', () => {
    const result = pipeline.evaluateSubmission(buildPayload());

    expect(result.shouldReject).to.equal(false);
    expect(result.decision).to.equal('accepted');
    expect(result.reasonCodes).to.deep.equal([]);
    expect(result.riskLevel).to.equal('low');
  });

  it('rejects malformed/adversarial patterns with explicit reason code', () => {
    const result = pipeline.evaluateSubmission(
      buildPayload({
        metadata: {
          sourceId: '<script>alert(1)</script>',
        },
      })
    );

    expect(result.shouldReject).to.equal(true);
    expect(result.reasonCodes).to.include(
      AntiFraudReasonCodes.MALFORMED_PAYLOAD_PATTERN
    );
  });

  it('rejects duplicate replay submissions deterministically', () => {
    const payload = buildPayload({
      metadata: {
        timestamp: '2026-02-17T00:00:00.000Z',
      },
    });

    const first = pipeline.evaluateSubmission(payload);
    const second = pipeline.evaluateSubmission(payload);

    expect(first.shouldReject).to.equal(false);
    expect(second.shouldReject).to.equal(true);
    expect(second.reasonCodes).to.include(AntiFraudReasonCodes.DUPLICATE_REPLAY);
  });

  it('applies deterministic penalties from reason codes', () => {
    const result = pipeline.evaluateSubmission(
      buildPayload({
        metadata: {
          provider: 'Unknown',
          sourceId: 'unknown',
        },
        measurements: {
          temperature: { value: Number.POSITIVE_INFINITY, unit: 'celsius' },
        },
      })
    );

    const expected = result.reasonCodes.reduce(
      (sum, reasonCode) => sum + (PENALTY_POINTS[reasonCode] || 0),
      0
    );

    expect(result.reasonCodes).to.deep.equal([...result.reasonCodes].sort());
    expect(result.penaltyPoints).to.equal(expected);
  });

  it('enforces temporal boundary without false-positive and catches out-of-boundary', () => {
    const t0 = Date.parse('2026-02-17T00:00:00.000Z');

    const previous = pipeline.evaluateSubmission(
      buildPayload({
        metadata: {
          timestamp: new Date(t0).toISOString(),
        },
        measurements: {
          temperature: { value: 10, unit: 'celsius' },
        },
      })
    );
    expect(previous.shouldReject).to.equal(false);

    const atBoundary = pipeline.evaluateSubmission(
      buildPayload({
        metadata: {
          timestamp: new Date(t0 + 60 * 60 * 1000).toISOString(),
        },
        measurements: {
          temperature: { value: 30, unit: 'celsius' },
        },
      })
    );
    expect(atBoundary.reasonCodes).to.not.include(
      AntiFraudReasonCodes.TEMPORAL_INCONSISTENCY
    );

    const overBoundary = pipeline.evaluateSubmission(
      buildPayload({
        metadata: {
          timestamp: new Date(t0 + 2 * 60 * 60 * 1000).toISOString(),
        },
        measurements: {
          temperature: { value: 51, unit: 'celsius' },
        },
      })
    );

    expect(overBoundary.reasonCodes).to.include(
      AntiFraudReasonCodes.TEMPORAL_INCONSISTENCY
    );
  });

  it('detects cross-source inconsistency at same grid/time window', () => {
    const timestamp = '2026-02-17T00:00:00.000Z';

    const baseline = pipeline.evaluateSubmission(
      buildPayload({
        metadata: {
          sourceId: 'station-001',
          timestamp,
        },
        measurements: {
          temperature: { value: 10, unit: 'celsius' },
        },
      })
    );
    expect(baseline.shouldReject).to.equal(false);

    const conflicting = pipeline.evaluateSubmission(
      buildPayload({
        metadata: {
          sourceId: 'station-002',
          timestamp,
        },
        measurements: {
          temperature: { value: 30, unit: 'celsius' },
        },
      })
    );

    expect(conflicting.reasonCodes).to.include(
      AntiFraudReasonCodes.CROSS_SOURCE_INCONSISTENCY
    );
  });

  it('exposes sanitized public audit output without sourceId leakage', () => {
    pipeline.evaluateSubmission(buildPayload());

    const status = pipeline.getPublicRiskStatus();
    const events = pipeline.getPublicAuditEvents(1);

    expect(status.totalEvaluated).to.equal(1);
    expect(events).to.have.lengthOf(1);
    expect(events[0].source.sourceIdHash).to.be.a('string');
    expect(events[0].source.sourceId).to.equal(undefined);
  });

  it('integrates with ingestion validator and fails closed on replay', async () => {
    const validator = new WeatherIngestionValidator();
    const sharedPayload = buildPayload({
      metadata: {
        sourceId: 'shared-station',
        timestamp: '2026-02-17T00:00:00.000Z',
      },
    });

    const first = await validator.validateIngestionData(sharedPayload);
    const second = await validator.validateIngestionData(sharedPayload);

    expect(first.canIngest).to.equal(true);
    expect(second.canIngest).to.equal(false);
    expect(second.riskAssessment.reasonCodes).to.include(
      AntiFraudReasonCodes.DUPLICATE_REPLAY
    );
  });
});
