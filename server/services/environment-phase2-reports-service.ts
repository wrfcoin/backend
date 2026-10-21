export type ActorClass = 'human' | 'ai_agent' | 'robot';
export type EnvironmentDomain = 'soil' | 'ocean' | 'hydrology';

interface BaseInput {
  source: string;
  providerId: string;
  region: string;
  actorClass: ActorClass;
  observedAt?: string;
}

export interface SoilHealthInput extends BaseInput {
  soilMoisture: number;
  moistureUnit?: 'fraction' | 'percent';
  ph: number;
  nitrogenPpm: number;
  phosphorusPpm: number;
  potassiumPpm: number;
  erosionRiskScore: number;
}

export interface OceanIntelligenceInput extends BaseInput {
  currentSpeed: number;
  currentSpeedUnit?: 'mps' | 'knots';
  tideHeight: number;
  tideHeightUnit?: 'm' | 'ft';
  seaSurfaceTemp: number;
  seaSurfaceTempUnit?: 'c' | 'f';
  salinityPsu: number;
  waveHeightM: number;
}

export interface HydrologyInput extends BaseInput {
  precipitation: number;
  precipitationUnit?: 'mm' | 'in';
  riverDischarge: number;
  riverDischargeUnit?: 'cms' | 'cfs';
  floodStage: number;
  floodStageUnit?: 'm' | 'ft';
  soilSaturationPercent: number;
}

export interface CanonicalSoilReport {
  id: string;
  domain: 'soil';
  source: string;
  providerId: string;
  region: string;
  actorClass: ActorClass;
  observedAt: string;
  normalized: {
    soilMoistureFraction: number;
    ph: number;
    nitrogenKgHa: number;
    phosphorusKgHa: number;
    potassiumKgHa: number;
    erosionRiskScore: number;
    fertilityIndex: number;
    droughtRisk: 'low' | 'moderate' | 'high';
  };
}

export interface CanonicalOceanReport {
  id: string;
  domain: 'ocean';
  source: string;
  providerId: string;
  region: string;
  actorClass: ActorClass;
  observedAt: string;
  normalized: {
    currentSpeedMps: number;
    tideHeightM: number;
    seaSurfaceTempC: number;
    salinityPsu: number;
    waveHeightM: number;
    marineHazardIndex: number;
    tideAnomalyRisk: 'low' | 'moderate' | 'high';
  };
}

export interface CanonicalHydrologyReport {
  id: string;
  domain: 'hydrology';
  source: string;
  providerId: string;
  region: string;
  actorClass: ActorClass;
  observedAt: string;
  normalized: {
    precipitationMm: number;
    riverDischargeCms: number;
    floodStageM: number;
    soilSaturationFraction: number;
    floodRiskIndex: number;
    floodWarningLevel: 'none' | 'watch' | 'warning';
  };
}

export type CanonicalEnvironmentReport =
  | CanonicalSoilReport
  | CanonicalOceanReport
  | CanonicalHydrologyReport;

const VALID_ACTOR_CLASSES: ReadonlySet<string> = new Set<ActorClass>([
  'human',
  'ai_agent',
  'robot',
]);
const INMEMORY_LIMIT = 4000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function nowIso(): string {
  return new Date().toISOString();
}

function toIso(value?: string): string {
  if (!value) return nowIso();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? nowIso() : new Date(parsed).toISOString();
}

function assertBaseInput(value: BaseInput): void {
  if (!value.source) throw new Error('source is required');
  if (!value.providerId) throw new Error('providerId is required');
  if (!value.region) throw new Error('region is required');
  if (!VALID_ACTOR_CLASSES.has(value.actorClass)) {
    throw new Error('actorClass must be one of: human, ai_agent, robot');
  }
}

function droughtRiskFromMoisture(fraction: number): 'low' | 'moderate' | 'high' {
  if (fraction < 0.2) return 'high';
  if (fraction < 0.35) return 'moderate';
  return 'low';
}

function tideRiskFromIndex(index: number): 'low' | 'moderate' | 'high' {
  if (index >= 0.75) return 'high';
  if (index >= 0.5) return 'moderate';
  return 'low';
}

function floodWarningFromIndex(index: number): 'none' | 'watch' | 'warning' {
  if (index >= 0.75) return 'warning';
  if (index >= 0.5) return 'watch';
  return 'none';
}

export class EnvironmentPhase2ReportsService {
  private reports: CanonicalEnvironmentReport[] = [];
  private nextId = 1;

  ingestSoil(input: SoilHealthInput): CanonicalSoilReport {
    assertBaseInput(input);
    const soilMoistureFraction =
      input.moistureUnit === 'percent'
        ? clamp(input.soilMoisture / 100, 0, 1)
        : clamp(input.soilMoisture, 0, 1);
    const ph = clamp(input.ph, 0, 14);
    const erosionRiskScore = clamp(input.erosionRiskScore, 0, 1);

    // Approx conversion for topsoil nutrient ppm to kg/ha reference band.
    const nitrogenKgHa = Number((clamp(input.nitrogenPpm, 0, 2000) * 1.1).toFixed(2));
    const phosphorusKgHa = Number((clamp(input.phosphorusPpm, 0, 2000) * 2.3).toFixed(2));
    const potassiumKgHa = Number((clamp(input.potassiumPpm, 0, 2000) * 2.0).toFixed(2));

    const phScore = 1 - clamp(Math.abs(6.5 - ph) / 6.5, 0, 1);
    const nutrientScore = clamp(
      (nitrogenKgHa / 160 + phosphorusKgHa / 120 + potassiumKgHa / 180) / 3,
      0,
      1
    );
    const fertilityIndex = Number(
      (soilMoistureFraction * 0.35 + phScore * 0.25 + nutrientScore * 0.4).toFixed(4)
    );

    const report: CanonicalSoilReport = {
      id: `ENV-${String(this.nextId++).padStart(6, '0')}`,
      domain: 'soil',
      source: input.source,
      providerId: input.providerId,
      region: input.region,
      actorClass: input.actorClass,
      observedAt: toIso(input.observedAt),
      normalized: {
        soilMoistureFraction,
        ph,
        nitrogenKgHa,
        phosphorusKgHa,
        potassiumKgHa,
        erosionRiskScore,
        fertilityIndex,
        droughtRisk: droughtRiskFromMoisture(soilMoistureFraction),
      },
    };
    this.pushReport(report);
    return report;
  }

  ingestOcean(input: OceanIntelligenceInput): CanonicalOceanReport {
    assertBaseInput(input);
    const currentSpeedMps =
      input.currentSpeedUnit === 'knots'
        ? Number((clamp(input.currentSpeed, 0, 200) * 0.514444).toFixed(4))
        : Number(clamp(input.currentSpeed, 0, 200).toFixed(4));
    const tideHeightM =
      input.tideHeightUnit === 'ft'
        ? Number((clamp(input.tideHeight, -100, 100) * 0.3048).toFixed(4))
        : Number(clamp(input.tideHeight, -100, 100).toFixed(4));
    const seaSurfaceTempC =
      input.seaSurfaceTempUnit === 'f'
        ? Number((((input.seaSurfaceTemp - 32) * 5) / 9).toFixed(4))
        : Number(clamp(input.seaSurfaceTemp, -5, 60).toFixed(4));
    const salinityPsu = Number(clamp(input.salinityPsu, 0, 60).toFixed(4));
    const waveHeightM = Number(clamp(input.waveHeightM, 0, 50).toFixed(4));

    const marineHazardIndex = Number(
      clamp(
        currentSpeedMps / 4 * 0.35 +
          Math.abs(tideHeightM) / 3 * 0.25 +
          waveHeightM / 6 * 0.3 +
          clamp(Math.abs(seaSurfaceTempC - 18) / 20, 0, 1) * 0.1,
        0,
        1
      ).toFixed(4)
    );

    const report: CanonicalOceanReport = {
      id: `ENV-${String(this.nextId++).padStart(6, '0')}`,
      domain: 'ocean',
      source: input.source,
      providerId: input.providerId,
      region: input.region,
      actorClass: input.actorClass,
      observedAt: toIso(input.observedAt),
      normalized: {
        currentSpeedMps,
        tideHeightM,
        seaSurfaceTempC,
        salinityPsu,
        waveHeightM,
        marineHazardIndex,
        tideAnomalyRisk: tideRiskFromIndex(marineHazardIndex),
      },
    };
    this.pushReport(report);
    return report;
  }

  ingestHydrology(input: HydrologyInput): CanonicalHydrologyReport {
    assertBaseInput(input);
    const precipitationMm =
      input.precipitationUnit === 'in'
        ? Number((clamp(input.precipitation, 0, 500) * 25.4).toFixed(4))
        : Number(clamp(input.precipitation, 0, 20000).toFixed(4));
    const riverDischargeCms =
      input.riverDischargeUnit === 'cfs'
        ? Number((clamp(input.riverDischarge, 0, 5_000_000) * 0.0283168).toFixed(4))
        : Number(clamp(input.riverDischarge, 0, 200_000).toFixed(4));
    const floodStageM =
      input.floodStageUnit === 'ft'
        ? Number((clamp(input.floodStage, -20, 200) * 0.3048).toFixed(4))
        : Number(clamp(input.floodStage, -10, 80).toFixed(4));
    const soilSaturationFraction = Number(
      clamp(input.soilSaturationPercent / 100, 0, 1).toFixed(4)
    );

    const floodRiskIndex = Number(
      clamp(
        precipitationMm / 120 * 0.35 +
          riverDischargeCms / 1800 * 0.3 +
          floodStageM / 5 * 0.2 +
          soilSaturationFraction * 0.15,
        0,
        1
      ).toFixed(4)
    );

    const report: CanonicalHydrologyReport = {
      id: `ENV-${String(this.nextId++).padStart(6, '0')}`,
      domain: 'hydrology',
      source: input.source,
      providerId: input.providerId,
      region: input.region,
      actorClass: input.actorClass,
      observedAt: toIso(input.observedAt),
      normalized: {
        precipitationMm,
        riverDischargeCms,
        floodStageM,
        soilSaturationFraction,
        floodRiskIndex,
        floodWarningLevel: floodWarningFromIndex(floodRiskIndex),
      },
    };
    this.pushReport(report);
    return report;
  }

  listReports(filters: {
    domain?: EnvironmentDomain;
    region?: string;
    limit?: number;
  } = {}): CanonicalEnvironmentReport[] {
    const limit = Math.max(1, Math.min(500, Math.floor(filters.limit ?? 100)));
    let results = [...this.reports];
    if (filters.domain) {
      results = results.filter(report => report.domain === filters.domain);
    }
    if (filters.region) {
      results = results.filter(
        report => report.region.toLowerCase() === filters.region!.toLowerCase()
      );
    }

    return results
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .slice(0, limit);
  }

  getDomainSummary(domain: EnvironmentDomain): {
    domain: EnvironmentDomain;
    totalReports: number;
    uniqueProviders: number;
    uniqueRegions: number;
    actorClassDistribution: Record<ActorClass, number>;
    latestObservedAt: string | null;
    privacySafeTelemetry: true;
  } {
    const filtered = this.reports.filter(report => report.domain === domain);
    const providerSet = new Set(filtered.map(report => report.providerId));
    const regionSet = new Set(filtered.map(report => report.region.toLowerCase()));

    const actorClassDistribution: Record<ActorClass, number> = {
      human: 0,
      ai_agent: 0,
      robot: 0,
    };
    for (const report of filtered) {
      actorClassDistribution[report.actorClass] += 1;
    }

    return {
      domain,
      totalReports: filtered.length,
      uniqueProviders: providerSet.size,
      uniqueRegions: regionSet.size,
      actorClassDistribution,
      latestObservedAt: filtered.length > 0 ? filtered[0].observedAt : null,
      privacySafeTelemetry: true,
    };
  }

  getPhase2Overview(): {
    generatedAt: string;
    canonicalSchemaVersion: string;
    domains: Record<EnvironmentDomain, ReturnType<EnvironmentPhase2ReportsService['getDomainSummary']>>;
    policyNotes: string[];
  } {
    return {
      generatedAt: nowIso(),
      canonicalSchemaVersion: 'env-phase2-v1',
      domains: {
        soil: this.getDomainSummary('soil'),
        ocean: this.getDomainSummary('ocean'),
        hydrology: this.getDomainSummary('hydrology'),
      },
      policyNotes: [
        'Canonical outputs preserve equal-liability treatment across humans, AI agents, and robots.',
        'Outputs are aggregate and provider-level; no personal identifiers are emitted.',
        'Unit normalization is deterministic per domain schema.',
      ],
    };
  }

  private pushReport(report: CanonicalEnvironmentReport): void {
    this.reports.push(report);
    if (this.reports.length > INMEMORY_LIMIT) {
      this.reports.splice(0, this.reports.length - INMEMORY_LIMIT);
    }
  }
}

export const environmentPhase2ReportsService = new EnvironmentPhase2ReportsService();
