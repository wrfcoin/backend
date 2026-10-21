import { EnvironmentPhase2ReportsService } from '../server/services/environment-phase2-reports-service.js';

describe('EnvironmentPhase2ReportsService', () => {
  test('normalizes soil report into canonical output', () => {
    const service = new EnvironmentPhase2ReportsService();
    const report = service.ingestSoil({
      source: 'soil-station',
      providerId: 'provider-soil-1',
      region: 'us-gulf',
      actorClass: 'human',
      soilMoisture: 42,
      moistureUnit: 'percent',
      ph: 6.8,
      nitrogenPpm: 38,
      phosphorusPpm: 18,
      potassiumPpm: 60,
      erosionRiskScore: 0.32,
    });

    expect(report.domain).toBe('soil');
    expect(report.normalized.soilMoistureFraction).toBeCloseTo(0.42);
    expect(report.normalized.fertilityIndex).toBeGreaterThan(0);
    expect(report.normalized.droughtRisk).toBe('low');
  });

  test('normalizes ocean units to canonical SI fields', () => {
    const service = new EnvironmentPhase2ReportsService();
    const report = service.ingestOcean({
      source: 'ocean-buoy',
      providerId: 'provider-ocean-1',
      region: 'pacific-nw',
      actorClass: 'ai_agent',
      currentSpeed: 5,
      currentSpeedUnit: 'knots',
      tideHeight: 10,
      tideHeightUnit: 'ft',
      seaSurfaceTemp: 71.6,
      seaSurfaceTempUnit: 'f',
      salinityPsu: 34.8,
      waveHeightM: 2.4,
    });

    expect(report.domain).toBe('ocean');
    expect(report.normalized.currentSpeedMps).toBeCloseTo(2.5722, 3);
    expect(report.normalized.tideHeightM).toBeCloseTo(3.048, 3);
    expect(report.normalized.seaSurfaceTempC).toBeCloseTo(22, 1);
    expect(report.normalized.marineHazardIndex).toBeGreaterThan(0);
  });

  test('normalizes hydrology units and computes flood warning', () => {
    const service = new EnvironmentPhase2ReportsService();
    const report = service.ingestHydrology({
      source: 'river-sensor',
      providerId: 'provider-hydro-1',
      region: 'delta-east',
      actorClass: 'robot',
      precipitation: 2.5,
      precipitationUnit: 'in',
      riverDischarge: 62000,
      riverDischargeUnit: 'cfs',
      floodStage: 22,
      floodStageUnit: 'ft',
      soilSaturationPercent: 86,
    });

    expect(report.domain).toBe('hydrology');
    expect(report.normalized.precipitationMm).toBeCloseTo(63.5, 1);
    expect(report.normalized.riverDischargeCms).toBeCloseTo(1755.6416, 2);
    expect(report.normalized.floodStageM).toBeCloseTo(6.7056, 2);
    expect(['watch', 'warning']).toContain(report.normalized.floodWarningLevel);
  });

  test('provides domain summaries and phase2 overview', () => {
    const service = new EnvironmentPhase2ReportsService();
    service.ingestSoil({
      source: 'soil-station',
      providerId: 'p1',
      region: 'r1',
      actorClass: 'human',
      soilMoisture: 0.31,
      ph: 6.1,
      nitrogenPpm: 42,
      phosphorusPpm: 21,
      potassiumPpm: 70,
      erosionRiskScore: 0.2,
    });
    service.ingestOcean({
      source: 'ocean-buoy',
      providerId: 'p2',
      region: 'r2',
      actorClass: 'ai_agent',
      currentSpeed: 1.7,
      tideHeight: 1.4,
      seaSurfaceTemp: 18.6,
      salinityPsu: 35,
      waveHeightM: 2.1,
    });
    service.ingestHydrology({
      source: 'river-sensor',
      providerId: 'p3',
      region: 'r3',
      actorClass: 'robot',
      precipitation: 82,
      riverDischarge: 900,
      floodStage: 2.2,
      soilSaturationPercent: 64,
    });

    const soilSummary = service.getDomainSummary('soil');
    expect(soilSummary.totalReports).toBe(1);
    expect(soilSummary.privacySafeTelemetry).toBe(true);

    const overview = service.getPhase2Overview();
    expect(overview.canonicalSchemaVersion).toBe('env-phase2-v1');
    expect(overview.domains.soil.totalReports).toBe(1);
    expect(overview.domains.ocean.totalReports).toBe(1);
    expect(overview.domains.hydrology.totalReports).toBe(1);
  });
});
