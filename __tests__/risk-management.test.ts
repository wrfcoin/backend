const mockSecurityLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../server/utils/logger.js', () => ({
  securityLogger: mockSecurityLogger,
}));

function createRiskSchema() {
  return {
    weatherStations: {
      __tableName: 'weatherStations',
      isActive: 'weatherStations.isActive',
      updatedAt: 'weatherStations.updatedAt',
    },
    weatherData: {
      __tableName: 'weatherData',
      windSpeed: 'weatherData.windSpeed',
      precipitation: 'weatherData.precipitation',
      pressure: 'weatherData.pressure',
      timestamp: 'weatherData.timestamp',
    },
    carbonCredits: {
      __tableName: 'carbonCredits',
      certificationHash: 'carbonCredits.certificationHash',
      isRetired: 'carbonCredits.isRetired',
      createdAt: 'carbonCredits.createdAt',
    },
    carbonFootprints: {
      __tableName: 'carbonFootprints',
      netEmissions: 'carbonFootprints.netEmissions',
      totalEmissions: 'carbonFootprints.totalEmissions',
      totalOffsets: 'carbonFootprints.totalOffsets',
    },
    weatherDataQuality: {
      __tableName: 'weatherDataQuality',
      qualityScore: 'weatherDataQuality.qualityScore',
      confidence: 'weatherDataQuality.confidence',
    },
    securityEvents: {
      __tableName: 'securityEvents',
      severity: 'securityEvents.severity',
      eventType: 'securityEvents.eventType',
      createdAt: 'securityEvents.createdAt',
    },
  };
}

function createMockDb(dataByTable: Record<string, unknown[]>) {
  const resolveRows = (table: { __tableName?: string }, selection?: Record<string, unknown>) => {
    const rows = dataByTable[table?.__tableName || ''] || [];

    if (selection && Object.values(selection).includes('__count__')) {
      return [{ count: rows.length }];
    }

    return rows;
  };

  return {
    select(selection?: Record<string, unknown>) {
      const state: { selection?: Record<string, unknown>; table?: { __tableName?: string } } = {
        selection,
      };

      const builder = {
        from(table: { __tableName?: string }) {
          state.table = table;
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return Promise.resolve(resolveRows(state.table || {}, state.selection));
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(resolveRows(state.table || {}, state.selection)).then(
            resolve,
            reject
          );
        },
      };

      return builder;
    },
  };
}

function createDrizzleOps() {
  return {
    count: () => '__count__',
    gte: () => ({}),
    lt: () => ({}),
    eq: () => ({}),
    or: () => ({}),
  };
}

function mockDrizzleOrm() {
  jest.doMock('drizzle-orm', () => createDrizzleOps(), { virtual: true });
}

describe('risk management middleware live-data assessments', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('detects recent security threats from persisted security events', async () => {
    const schema = createRiskSchema();
    jest.doMock('../database/connection', () => ({
      db: createMockDb({
        securityEvents: [
          {
            severity: 'critical',
            eventType: 'suspicious_activity',
            createdAt: new Date().toISOString(),
          },
          {
            severity: 'medium',
            eventType: 'login',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    }));
    jest.doMock('../shared/schema', () => schema);
    mockDrizzleOrm();

    const { RiskManagementSystem } = require('../middleware/risk-management.js');
    const manager = new RiskManagementSystem();

    await expect(manager.hasRecentSecurityThreats()).resolves.toBe(true);
  });

  it('treats a single critical suspicious event as a recent security threat', async () => {
    const schema = createRiskSchema();
    jest.doMock('../database/connection', () => ({
      db: createMockDb({
        securityEvents: [
          {
            severity: 'critical',
            eventType: 'threat_detected',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    }));
    jest.doMock('../shared/schema', () => schema);
    mockDrizzleOrm();

    const { RiskManagementSystem } = require('../middleware/risk-management.js');
    const manager = new RiskManagementSystem();

    await expect(manager.hasRecentSecurityThreats()).resolves.toBe(true);
  });

  it('derives environmental risk metrics from live carbon and quality data', async () => {
    const schema = createRiskSchema();
    jest.doMock('../database/connection', () => ({
      db: createMockDb({
        carbonFootprints: [
          { netEmissions: '-2', totalEmissions: '10', totalOffsets: '12' },
          { netEmissions: '-1', totalEmissions: '8', totalOffsets: '10' },
        ],
        carbonCredits: [
          { certificationHash: 'ipfs://credit-1', isRetired: false },
          { certificationHash: 'ipfs://credit-2', isRetired: false },
        ],
        weatherDataQuality: [
          { qualityScore: 96, confidence: 0.9 },
          { qualityScore: 94, confidence: 0.95 },
        ],
      }),
    }));
    jest.doMock('../shared/schema', () => schema);
    mockDrizzleOrm();

    const { RiskManagementSystem } = require('../middleware/risk-management.js');
    const manager = new RiskManagementSystem();

    const assessment = await manager.assessEnvironmentalImpactRisks();

    expect(assessment.currentRiskScore).toBe(1);
    expect(assessment.metrics).toEqual({
      carbonFootprint: 'Net Negative',
      energyEfficiency: 95.4,
      sustainabilityScore: 'A+',
    });
    expect(assessment.recommendation).toBe('Maintain sustainable practices');
  });

  it('returns a normal posture for the bootstrap environmental baseline dataset', async () => {
    const schema = createRiskSchema();
    jest.doMock('../database/connection', () => ({
      db: createMockDb({
        carbonFootprints: [
          { netEmissions: '-2', totalEmissions: '10', totalOffsets: '12' },
        ],
        carbonCredits: [
          {
            certificationHash: 'ipfs://wrf/bootstrap-credit-001',
            isRetired: false,
          },
        ],
        weatherDataQuality: [
          { qualityScore: 96, confidence: 0.95 },
        ],
      }),
    }));
    jest.doMock('../shared/schema', () => schema);
    mockDrizzleOrm();

    const { RiskManagementSystem } = require('../middleware/risk-management.js');
    const manager = new RiskManagementSystem();

    const assessment = await manager.assessEnvironmentalImpactRisks();

    expect(assessment.currentRiskScore).toBe(1);
    expect(assessment.metrics).toEqual({
      carbonFootprint: 'Net Negative',
      energyEfficiency: 96.6,
      sustainabilityScore: 'A+',
    });
    expect(assessment.recommendation).toBe('Maintain sustainable practices');
  });

  it('returns a degraded recommendation when environmental assessment data is unavailable', async () => {
    const schema = createRiskSchema();
    const failingDb = {
      select() {
        return {
          from() {
            return {
              limit() {
                return Promise.reject(new Error('database offline'));
              },
            };
          },
        };
      },
    };
    jest.doMock('../database/connection', () => ({ db: failingDb }));
    jest.doMock('../shared/schema', () => schema);
    mockDrizzleOrm();

    const { RiskManagementSystem } = require('../middleware/risk-management.js');
    const manager = new RiskManagementSystem();

    const assessment = await manager.assessEnvironmentalImpactRisks();

    expect(assessment.currentRiskScore).toBe(2);
    expect(assessment.recommendation).toBe(
      'Environmental assessment data unavailable — investigate carbon, credit, and quality data pipelines'
    );
    expect(mockSecurityLogger.error).toHaveBeenCalledWith(
      'Risk Management: failed to query environmental impact metrics',
      expect.objectContaining({ error: 'database offline' })
    );
  });

  it('uses deterministic degraded environmental output when persisted datasets are empty', async () => {
    const schema = createRiskSchema();
    jest.doMock('../database/connection', () => ({
      db: createMockDb({
        carbonFootprints: [],
        carbonCredits: [],
        weatherDataQuality: [],
      }),
    }));
    jest.doMock('../shared/schema', () => schema);
    mockDrizzleOrm();

    const { RiskManagementSystem } = require('../middleware/risk-management.js');
    const manager = new RiskManagementSystem();

    const assessment = await manager.assessEnvironmentalImpactRisks();

    expect(assessment.currentRiskScore).toBe(2);
    expect(assessment.metrics).toEqual({
      carbonFootprint: 'Unknown',
      energyEfficiency: 0,
      sustainabilityScore: 'C',
    });
    expect(assessment.recommendation).toBe(
      'Environmental assessment data unavailable — investigate carbon, credit, and quality data pipelines'
    );
  });

  it('uses deterministic degraded quality metrics when weather-data queries fail', async () => {
    const schema = createRiskSchema();
    const failingDb = {
      select() {
        return {
          from() {
            return {
              where() {
                return Promise.reject(new Error('weather query timeout'));
              },
            };
          },
        };
      },
    };
    jest.doMock('../database/connection', () => ({ db: failingDb }));
    jest.doMock('../shared/schema', () => schema);
    mockDrizzleOrm();

    const { RiskManagementSystem } = require('../middleware/risk-management.js');
    const manager = new RiskManagementSystem();

    const assessment = await manager.assessClimateDataQuality();

    expect(assessment.currentRiskScore).toBe(2);
    expect(assessment.metrics).toEqual({
      accuracy: 0,
      completeness: 0,
      consistency: 0,
      timeliness: 0,
      dataSource: 'assessment_unavailable',
    });
    expect(assessment.recommendation).toBe(
      'Database unavailable — unable to assess data quality'
    );
    expect(mockSecurityLogger.error).toHaveBeenCalledWith(
      'Risk Management: failed to query weather data quality',
      expect.objectContaining({ error: 'weather query timeout' })
    );
  });

  it('calculates risk trend from historical assessments instead of random selection', async () => {
    const schema = createRiskSchema();
    jest.doMock('../database/connection', () => ({ db: createMockDb({}) }));
    jest.doMock('../shared/schema', () => schema);
    mockDrizzleOrm();

    const { RiskManagementSystem } = require('../middleware/risk-management.js');
    const manager = new RiskManagementSystem();
    manager.riskAssessments.set('older', {
      timestamp: '2026-03-01T00:00:00.000Z',
      risks: [{ riskId: 'OPS_001', residualRisk: 2 }],
    });
    manager.riskAssessments.set('newer', {
      timestamp: '2026-03-02T00:00:00.000Z',
      risks: [{ riskId: 'OPS_001', residualRisk: 3 }],
    });

    await expect(
      manager.calculateRiskTrend('OPS_001', 5, 'operational')
    ).resolves.toBe('increasing');
    await expect(
      manager.calculateRiskTrend('OPS_001', 1, 'operational')
    ).resolves.toBe('decreasing');
  });
});
