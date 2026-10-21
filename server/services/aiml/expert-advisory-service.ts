import crypto from 'crypto';
import type {
  ActiveSevereWeatherAlert,
  SevereAlertSeverityClass,
  SevereAlertType,
} from '../weather/severe-weather-response-service.js';

export type AdvisoryEventClass = 'storm' | 'flood' | 'heat';
export type AdvisoryLevel = 'none' | 'monitor' | 'watch' | 'warning' | 'emergency';

export interface AdvisoryFeatureAttribution {
  feature: string;
  contribution: number;
  value: number;
}

export interface AdvisoryRequest {
  eventClass: AdvisoryEventClass;
  region?: {
    id?: string;
    bounds?: {
      north: number;
      south: number;
      east: number;
      west: number;
    };
  };
  alerts?: ActiveSevereWeatherAlert[];
  measurements?: Record<string, number>;
  policyVersion?: string;
  modelAssist?: boolean;
}

export interface AdvisoryDecision {
  advisoryId: string;
  eventClass: AdvisoryEventClass;
  advisoryLevel: AdvisoryLevel;
  policyVersion: string;
  ruleBundleVersion: string;
  generatedAt: string;
  model: {
    enabled: boolean;
    used: boolean;
    fallbackUsed: boolean;
    version: string | null;
    confidence: number;
    featureAttribution: AdvisoryFeatureAttribution[];
  };
  evidenceBundle: {
    matchedRules: Array<{
      id: string;
      description: string;
      weight: number;
      score: number;
    }>;
    alertSummary: {
      totalAlerts: number;
      bySeverity: Record<SevereAlertSeverityClass, number>;
      byType: Record<SevereAlertType, number>;
    };
    measurements: Record<string, number>;
    compositeRuleScore: number;
  };
}

interface PolicyRule {
  id: string;
  description: string;
  check: (ctx: AdvisoryContext) => boolean;
  weight: number;
}

interface PolicyBundle {
  version: string;
  policyId: string;
  eventClass: AdvisoryEventClass;
  rules: PolicyRule[];
  thresholds: {
    monitor: number;
    watch: number;
    warning: number;
    emergency: number;
  };
}

interface AdvisoryContext {
  alerts: ActiveSevereWeatherAlert[];
  measurements: Record<string, number>;
}

interface AdvisoryModelAdapter {
  score(eventClass: AdvisoryEventClass, ctx: AdvisoryContext): Promise<{
    confidence: number;
    modelVersion: string;
    attributions: AdvisoryFeatureAttribution[];
  }>;
}

interface AdvisoryDecisionRepository {
  saveDecision(decision: AdvisoryDecision): Promise<void>;
  savePolicy(bundle: PolicyBundle): Promise<void>;
  loadPolicies(): Promise<PolicyBundle[]>;
}

class InMemoryAdvisoryRepository implements AdvisoryDecisionRepository {
  private readonly decisions = new Map<string, AdvisoryDecision>();
  private readonly policies = new Map<string, PolicyBundle>();

  async saveDecision(decision: AdvisoryDecision): Promise<void> {
    this.decisions.set(decision.advisoryId, decision);
  }

  async savePolicy(bundle: PolicyBundle): Promise<void> {
    this.policies.set(policyKey(bundle.eventClass, bundle.version), bundle);
  }

  async loadPolicies(): Promise<PolicyBundle[]> {
    return Array.from(this.policies.values());
  }
}

class DatabaseAdvisoryRepository implements AdvisoryDecisionRepository {
  private readonly fallback = new InMemoryAdvisoryRepository();
  private initialized = false;
  private db: any;
  private schema: any;

  private async init(): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    if (!process.env.DATABASE_URL) {
      return false;
    }

    try {
      const dbModule = await import('../../db.js');
      const schemaModule = await import('../../../shared/schema.js');
      this.db = dbModule.db;
      this.schema = schemaModule;
      this.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  async saveDecision(decision: AdvisoryDecision): Promise<void> {
    const ready = await this.init();
    if (!ready) {
      return this.fallback.saveDecision(decision);
    }

    await this.db.insert(this.schema.advisoryDecisions).values({
      advisoryId: decision.advisoryId,
      eventClass: decision.eventClass,
      advisoryLevel: decision.advisoryLevel,
      policyVersion: decision.policyVersion,
      ruleBundleVersion: decision.ruleBundleVersion,
      modelEnabled: decision.model.enabled,
      modelUsed: decision.model.used,
      modelFallbackUsed: decision.model.fallbackUsed,
      modelVersion: decision.model.version,
      modelConfidence: decision.model.confidence,
      evidenceBundle: decision.evidenceBundle,
      generatedAt: new Date(decision.generatedAt),
    });
  }

  async savePolicy(bundle: PolicyBundle): Promise<void> {
    const ready = await this.init();
    if (!ready) {
      return this.fallback.savePolicy(bundle);
    }

    await this.db
      .insert(this.schema.advisoryPolicyVersions)
      .values({
        policyId: bundle.policyId,
        eventClass: bundle.eventClass,
        version: bundle.version,
        ruleBundle: {
          thresholds: bundle.thresholds,
          rules: bundle.rules.map(rule => ({
            id: rule.id,
            description: rule.description,
            weight: rule.weight,
          })),
        },
      })
      .onConflictDoNothing();
  }

  async loadPolicies(): Promise<PolicyBundle[]> {
    const ready = await this.init();
    if (!ready) {
      return this.fallback.loadPolicies();
    }

    const rows = await this.db.select().from(this.schema.advisoryPolicyVersions);
    return rows.map((row: any) => {
      const base = defaultPolicyBundles()[`${row.eventClass}:${row.version}` as keyof ReturnType<typeof defaultPolicyBundles>];
      return base || createFallbackPolicy(row.eventClass, row.version);
    });
  }
}

interface ExpertAdvisoryServiceOptions {
  nowFn?: () => Date;
  modelAdapter?: AdvisoryModelAdapter;
  repository?: AdvisoryDecisionRepository;
}

export class ExpertAdvisoryService {
  private readonly nowFn: () => Date;
  private readonly modelAdapter?: AdvisoryModelAdapter;
  private readonly repository: AdvisoryDecisionRepository;
  private readonly bundles = new Map<string, PolicyBundle>();
  private hydrated = false;

  constructor(options: ExpertAdvisoryServiceOptions = {}) {
    this.nowFn = options.nowFn || (() => new Date());
    this.modelAdapter = options.modelAdapter;
    this.repository = options.repository || new DatabaseAdvisoryRepository();
  }

  private async hydratePolicies(): Promise<void> {
    if (this.hydrated) {
      return;
    }

    const defaults = defaultPolicyBundles();
    for (const bundle of Object.values(defaults)) {
      this.bundles.set(policyKey(bundle.eventClass, bundle.version), bundle);
      await this.repository.savePolicy(bundle);
    }

    const persisted = await this.repository.loadPolicies();
    for (const bundle of persisted) {
      this.bundles.set(policyKey(bundle.eventClass, bundle.version), bundle);
    }

    this.hydrated = true;
  }

  async evaluate(request: AdvisoryRequest): Promise<AdvisoryDecision> {
    await this.hydratePolicies();
    validateRequest(request);

    const nowIso = this.nowFn().toISOString();
    const policyVersion = request.policyVersion || 'v1';
    const bundle =
      this.bundles.get(policyKey(request.eventClass, policyVersion)) ||
      createFallbackPolicy(request.eventClass, policyVersion);

    const ctx: AdvisoryContext = {
      alerts: Array.isArray(request.alerts) ? request.alerts : [],
      measurements: sanitizeMeasurements(request.measurements || {}),
    };

    const matchedRules = bundle.rules
      .filter(rule => rule.check(ctx))
      .map(rule => ({
        id: rule.id,
        description: rule.description,
        weight: rule.weight,
        score: Number((rule.weight * 100).toFixed(3)),
      }));

    const maxRuleWeight = bundle.rules.reduce((sum, rule) => sum + rule.weight, 0) || 1;
    const ruleWeight = matchedRules.reduce((sum, rule) => sum + rule.weight, 0);
    const compositeRuleScore = Number((ruleWeight / maxRuleWeight).toFixed(6));

    const modelEnabled = Boolean(request.modelAssist);
    let modelUsed = false;
    let fallbackUsed = false;
    let modelVersion: string | null = null;
    let modelConfidence = compositeRuleScore;
    let featureAttribution: AdvisoryFeatureAttribution[] = [];

    if (modelEnabled && this.modelAdapter) {
      try {
        const model = await this.modelAdapter.score(request.eventClass, ctx);
        modelUsed = true;
        modelVersion = model.modelVersion;
        modelConfidence = clamp01(model.confidence);
        featureAttribution = model.attributions.slice(0, 8);
      } catch {
        fallbackUsed = true;
      }
    } else if (modelEnabled) {
      fallbackUsed = true;
    }

    const finalScore = Number(
      (compositeRuleScore * 0.7 + clamp01(modelConfidence) * 0.3).toFixed(6)
    );

    const decision: AdvisoryDecision = {
      advisoryId: `advisory_${crypto.randomUUID().replace(/-/g, '')}`,
      eventClass: request.eventClass,
      advisoryLevel: determineLevel(bundle, finalScore),
      policyVersion: bundle.version,
      ruleBundleVersion: bundle.version,
      generatedAt: nowIso,
      model: {
        enabled: modelEnabled,
        used: modelUsed,
        fallbackUsed,
        version: modelVersion,
        confidence: modelConfidence,
        featureAttribution,
      },
      evidenceBundle: {
        matchedRules,
        alertSummary: summarizeAlerts(ctx.alerts),
        measurements: ctx.measurements,
        compositeRuleScore,
      },
    };

    await this.repository.saveDecision(decision);
    return decision;
  }

  async getPolicy(eventClass: AdvisoryEventClass, version = 'v1'): Promise<{
    policyId: string;
    eventClass: AdvisoryEventClass;
    version: string;
    thresholds: Record<string, number>;
    rules: Array<{ id: string; description: string; weight: number }>;
  } | null> {
    await this.hydratePolicies();
    const bundle = this.bundles.get(policyKey(eventClass, version));
    if (!bundle) {
      return null;
    }

    return {
      policyId: bundle.policyId,
      eventClass: bundle.eventClass,
      version: bundle.version,
      thresholds: bundle.thresholds,
      rules: bundle.rules.map(rule => ({
        id: rule.id,
        description: rule.description,
        weight: rule.weight,
      })),
    };
  }
}

function defaultPolicyBundles(): Record<string, PolicyBundle> {
  const storm: PolicyBundle = {
    policyId: 'storm-advisory-policy',
    eventClass: 'storm',
    version: 'v1',
    thresholds: {
      monitor: 0.15,
      watch: 0.35,
      warning: 0.55,
      emergency: 0.78,
    },
    rules: [
      {
        id: 'storm-warning-alert',
        description: 'Any storm/tornado warning present',
        weight: 0.35,
        check: ctx => ctx.alerts.some(alert => alert.severityClass === 'warning' && (alert.type === 'tornado' || alert.event.toLowerCase().includes('storm'))),
      },
      {
        id: 'storm-watch-alert',
        description: 'Storm watch alerts present',
        weight: 0.2,
        check: ctx => ctx.alerts.some(alert => alert.severityClass === 'watch' && (alert.type === 'tornado' || alert.event.toLowerCase().includes('storm'))),
      },
      {
        id: 'storm-wind-gust',
        description: 'Wind gust exceeds 55 mph',
        weight: 0.25,
        check: ctx => (ctx.measurements.windGustMph || 0) >= 55,
      },
      {
        id: 'storm-hail-size',
        description: 'Hail size exceeds 1 inch',
        weight: 0.2,
        check: ctx => (ctx.measurements.hailSizeIn || 0) >= 1,
      },
    ],
  };

  const flood: PolicyBundle = {
    policyId: 'flood-advisory-policy',
    eventClass: 'flood',
    version: 'v1',
    thresholds: {
      monitor: 0.1,
      watch: 0.3,
      warning: 0.55,
      emergency: 0.8,
    },
    rules: [
      {
        id: 'flood-warning-alert',
        description: 'Flood warning present',
        weight: 0.4,
        check: ctx => ctx.alerts.some(alert => alert.type === 'flood' && alert.severityClass === 'warning'),
      },
      {
        id: 'flood-watch-alert',
        description: 'Flood watch present',
        weight: 0.2,
        check: ctx => ctx.alerts.some(alert => alert.type === 'flood' && alert.severityClass === 'watch'),
      },
      {
        id: 'flood-rain-rate',
        description: 'Rainfall rate exceeds 2 in/hr',
        weight: 0.2,
        check: ctx => (ctx.measurements.rainRateInPerHour || 0) >= 2,
      },
      {
        id: 'flood-river-stage',
        description: 'River stage anomaly above threshold',
        weight: 0.2,
        check: ctx => (ctx.measurements.riverStagePercentile || 0) >= 95,
      },
    ],
  };

  const heat: PolicyBundle = {
    policyId: 'heat-advisory-policy',
    eventClass: 'heat',
    version: 'v1',
    thresholds: {
      monitor: 0.12,
      watch: 0.33,
      warning: 0.58,
      emergency: 0.82,
    },
    rules: [
      {
        id: 'heat-alert-warning',
        description: 'Heat warning alert present',
        weight: 0.35,
        check: ctx => ctx.alerts.some(alert => alert.event.toLowerCase().includes('heat') && alert.severityClass === 'warning'),
      },
      {
        id: 'heat-index-high',
        description: 'Heat index exceeds 105F',
        weight: 0.35,
        check: ctx => (ctx.measurements.heatIndexF || 0) >= 105,
      },
      {
        id: 'nighttime-min-temp',
        description: 'Nighttime low remains above 78F',
        weight: 0.15,
        check: ctx => (ctx.measurements.nightLowF || 0) >= 78,
      },
      {
        id: 'humidity-high',
        description: 'Relative humidity exceeds 70%',
        weight: 0.15,
        check: ctx => (ctx.measurements.relativeHumidity || 0) >= 70,
      },
    ],
  };

  return {
    [policyKey(storm.eventClass, storm.version)]: storm,
    [policyKey(flood.eventClass, flood.version)]: flood,
    [policyKey(heat.eventClass, heat.version)]: heat,
  };
}

function createFallbackPolicy(eventClass: AdvisoryEventClass, version: string): PolicyBundle {
  return {
    policyId: `${eventClass}-policy`,
    eventClass,
    version,
    thresholds: {
      monitor: 0.2,
      watch: 0.4,
      warning: 0.6,
      emergency: 0.8,
    },
    rules: [
      {
        id: `${eventClass}-fallback-alert-rule`,
        description: 'Any warning-class severe alert present',
        weight: 1,
        check: ctx => ctx.alerts.some(alert => alert.severityClass === 'warning'),
      },
    ],
  };
}

function validateRequest(request: AdvisoryRequest): void {
  if (!['storm', 'flood', 'heat'].includes(request.eventClass)) {
    throw new Error('eventClass must be one of: storm, flood, heat');
  }
}

function summarizeAlerts(alerts: ActiveSevereWeatherAlert[]): {
  totalAlerts: number;
  bySeverity: Record<SevereAlertSeverityClass, number>;
  byType: Record<SevereAlertType, number>;
} {
  const bySeverity: Record<SevereAlertSeverityClass, number> = {
    warning: 0,
    watch: 0,
    advisory: 0,
    statement: 0,
    unknown: 0,
  };

  const byType: Record<SevereAlertType, number> = {
    tornado: 0,
    wildfire_red_flag: 0,
    flood: 0,
    hurricane: 0,
    winter_storm: 0,
    other: 0,
  };

  for (const alert of alerts) {
    bySeverity[alert.severityClass] += 1;
    byType[alert.type] += 1;
  }

  return {
    totalAlerts: alerts.length,
    bySeverity,
    byType,
  };
}

function determineLevel(bundle: PolicyBundle, score: number): AdvisoryLevel {
  if (score >= bundle.thresholds.emergency) return 'emergency';
  if (score >= bundle.thresholds.warning) return 'warning';
  if (score >= bundle.thresholds.watch) return 'watch';
  if (score >= bundle.thresholds.monitor) return 'monitor';
  return 'none';
}

function sanitizeMeasurements(input: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      out[key] = Number(n.toFixed(6));
    }
  }
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.max(0, Math.min(1, value)).toFixed(6));
}

function policyKey(eventClass: AdvisoryEventClass, version: string): string {
  return `${eventClass}:${version}`;
}
