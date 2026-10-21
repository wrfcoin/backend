/**
 * Integrity threshold calibration service -- implements backend#37.
 *
 * Provides periodic threshold calibration jobs using labeled outcomes,
 * fairness diagnostics, and rollbackable configuration versions.
 */

export type ActorClass = 'human' | 'ai_agent' | 'robot';
export type CalibrationModel = 'abuse-risk' | 'sybil-detection';
export type GroundTruthLabel = 'abuse' | 'benign';

export interface LabeledOutcomeSample {
  sampleId?: string;
  actorClass: ActorClass;
  model: CalibrationModel;
  score: number; // normalized 0-100 risk score
  groundTruth: GroundTruthLabel;
  observedAt?: string;
}

export interface CalibrationThresholds {
  abuseRiskFlagThreshold: number;
  sybilFlagThreshold: number;
  targetFalsePositiveRate: number;
  targetActorClassParityGap: number;
  minimumSamplesPerActorClass: number;
}

export interface CalibrationConfig {
  version: string;
  status: 'active' | 'candidate' | 'rolled_back';
  createdAt: string;
  createdBy: string;
  notes: string | null;
  previousVersion: string | null;
  thresholds: CalibrationThresholds;
}

export interface ConfusionMetrics {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  samples: number;
  flagged: number;
  falsePositiveRate: number;
  precision: number;
  recall: number;
  flagRate: number;
}

export interface CalibrationMetricsSnapshot {
  generatedAt: string;
  configVersion: string;
  samples: number;
  byActorClass: Record<ActorClass, ConfusionMetrics>;
  falsePositiveRateByActorClass: Record<ActorClass, number>;
  global: {
    falsePositiveRate: number;
    precision: number;
    recall: number;
    flagRate: number;
  };
  parity: {
    falsePositiveRateGap: number;
    flagRateGap: number;
  };
  modelMetrics: Record<CalibrationModel, {
    falsePositiveRate: number;
    precision: number;
    recall: number;
    threshold: number;
    samples: number;
  }>;
}

export interface CalibrationRunReport {
  runId: string;
  requestedBy: string;
  startedAt: string;
  completedAt: string;
  sampleCount: number;
  configVersionEvaluated: string;
  candidateConfigVersion: string;
  candidateThresholds: CalibrationThresholds;
  metrics: CalibrationMetricsSnapshot;
  appliedCandidate: boolean;
  referenceSuites: string[];
  notes: string | null;
}

export interface CalibrationAuditEvent {
  id: string;
  type: 'calibration_job_run' | 'config_activated' | 'config_rolled_back';
  requestedBy: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

const VALID_ACTOR_CLASSES: ReadonlySet<ActorClass> = new Set<ActorClass>([
  'human',
  'ai_agent',
  'robot',
]);

const VALID_MODELS: ReadonlySet<CalibrationModel> = new Set<CalibrationModel>([
  'abuse-risk',
  'sybil-detection',
]);

const ROLLBACK_RUNBOOK_PATH = 'docs/integrity-threshold-calibration-rollback.md';

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(4));
}

function ensureNonEmpty(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function nextVersion(prefix: string, count: number): string {
  return `${prefix}-${Date.now()}-${String(count).padStart(4, '0')}`;
}

function createEmptyConfusion(): ConfusionMetrics {
  return {
    tp: 0,
    fp: 0,
    tn: 0,
    fn: 0,
    samples: 0,
    flagged: 0,
    falsePositiveRate: 0,
    precision: 0,
    recall: 0,
    flagRate: 0,
  };
}

export class IntegrityThresholdCalibrationService {
  private configs: Map<string, CalibrationConfig> = new Map();
  private runs: CalibrationRunReport[] = [];
  private audit: CalibrationAuditEvent[] = [];
  private latestMetrics: CalibrationMetricsSnapshot | null = null;
  private activeVersion: string;
  private nextRunId = 1;
  private nextAuditId = 1;

  constructor() {
    const baseline: CalibrationConfig = {
      version: 'cal-baseline-2026-03-04',
      status: 'active',
      createdAt: nowIso(),
      createdBy: 'system-bootstrap',
      notes: 'Baseline calibration thresholds before phase-2 fairness tuning.',
      previousVersion: null,
      thresholds: {
        abuseRiskFlagThreshold: 55,
        sybilFlagThreshold: 60,
        targetFalsePositiveRate: 0.08,
        targetActorClassParityGap: 0.05,
        minimumSamplesPerActorClass: 3,
      },
    };

    this.configs.set(baseline.version, baseline);
    this.activeVersion = baseline.version;
  }

  getRollbackMetadata(): {
    runbookPath: string;
    summary: string;
  } {
    return {
      runbookPath: ROLLBACK_RUNBOOK_PATH,
      summary: 'Rollback by re-activating a prior config version and auditing the rollback reason.',
    };
  }

  getActiveConfig(): CalibrationConfig {
    return { ...this.mustGetConfig(this.activeVersion) };
  }

  listConfigs(): CalibrationConfig[] {
    return Array.from(this.configs.values()).map(config => ({ ...config }));
  }

  listRuns(): CalibrationRunReport[] {
    return [...this.runs];
  }

  listAuditEvents(): CalibrationAuditEvent[] {
    return [...this.audit];
  }

  getLatestMetrics(): CalibrationMetricsSnapshot | null {
    return this.latestMetrics ? { ...this.latestMetrics } : null;
  }

  runCalibrationJob(params: {
    requestedBy: string;
    samples: LabeledOutcomeSample[];
    notes?: string;
    activateCandidate?: boolean;
    referenceSuites?: string[];
  }): CalibrationRunReport {
    const requestedBy = ensureNonEmpty('requestedBy', params.requestedBy);
    if (!Array.isArray(params.samples) || params.samples.length === 0) {
      throw new Error('samples must be a non-empty array');
    }

    const active = this.mustGetConfig(this.activeVersion);
    const normalized = params.samples.map((sample, index) => this.normalizeSample(sample, index));

    this.assertMinimumSamplesPerActorClass(normalized, active.thresholds.minimumSamplesPerActorClass);

    const startedAt = nowIso();
    const metrics = this.computeMetrics(normalized, active);
    const candidateThresholds = this.proposeThresholds(active.thresholds, metrics);

    const candidate: CalibrationConfig = {
      version: nextVersion('cal-candidate', this.runs.length + 1),
      status: params.activateCandidate ? 'active' : 'candidate',
      createdAt: nowIso(),
      createdBy: requestedBy,
      notes: params.notes?.trim() || null,
      previousVersion: this.activeVersion,
      thresholds: candidateThresholds,
    };

    this.configs.set(candidate.version, candidate);

    if (params.activateCandidate) {
      this.markConfigStatus(this.activeVersion, 'candidate');
      this.activeVersion = candidate.version;
    }

    const report: CalibrationRunReport = {
      runId: `CALRUN-${String(this.nextRunId++).padStart(6, '0')}`,
      requestedBy,
      startedAt,
      completedAt: nowIso(),
      sampleCount: normalized.length,
      configVersionEvaluated: active.version,
      candidateConfigVersion: candidate.version,
      candidateThresholds,
      metrics,
      appliedCandidate: Boolean(params.activateCandidate),
      referenceSuites: Array.isArray(params.referenceSuites) ? params.referenceSuites : [],
      notes: params.notes?.trim() || null,
    };

    this.runs.unshift(report);
    this.latestMetrics = metrics;

    this.pushAuditEvent({
      type: 'calibration_job_run',
      requestedBy,
      metadata: {
        runId: report.runId,
        sampleCount: report.sampleCount,
        evaluatedConfigVersion: report.configVersionEvaluated,
        candidateConfigVersion: report.candidateConfigVersion,
        appliedCandidate: report.appliedCandidate,
      },
    });

    if (params.activateCandidate) {
      this.pushAuditEvent({
        type: 'config_activated',
        requestedBy,
        metadata: {
          activatedVersion: candidate.version,
          previousVersion: active.version,
          source: 'calibration_job',
        },
      });
    }

    return report;
  }

  activateConfig(version: string, requestedByInput: string): CalibrationConfig {
    const requestedBy = ensureNonEmpty('requestedBy', requestedByInput);
    const target = this.mustGetConfig(version);
    if (target.version === this.activeVersion) {
      return { ...target };
    }

    const previous = this.activeVersion;
    this.markConfigStatus(previous, 'candidate');
    this.activeVersion = target.version;
    this.markConfigStatus(target.version, 'active');

    this.pushAuditEvent({
      type: 'config_activated',
      requestedBy,
      metadata: {
        activatedVersion: target.version,
        previousVersion: previous,
        source: 'manual_activate',
      },
    });

    return { ...this.mustGetConfig(this.activeVersion) };
  }

  rollbackConfig(params: {
    targetVersion: string;
    requestedBy: string;
    reason: string;
  }): CalibrationConfig {
    const targetVersion = ensureNonEmpty('targetVersion', params.targetVersion);
    const requestedBy = ensureNonEmpty('requestedBy', params.requestedBy);
    const reason = ensureNonEmpty('reason', params.reason);

    const current = this.mustGetConfig(this.activeVersion);
    const target = this.mustGetConfig(targetVersion);

    this.markConfigStatus(current.version, 'rolled_back');
    this.activeVersion = target.version;
    this.markConfigStatus(target.version, 'active');

    this.pushAuditEvent({
      type: 'config_rolled_back',
      requestedBy,
      metadata: {
        fromVersion: current.version,
        toVersion: target.version,
        reason,
      },
    });

    return { ...this.mustGetConfig(this.activeVersion) };
  }

  private normalizeSample(sample: LabeledOutcomeSample, index: number): Required<LabeledOutcomeSample> {
    if (!VALID_ACTOR_CLASSES.has(sample.actorClass)) {
      throw new Error(`samples[${index}].actorClass must be one of: human, ai_agent, robot`);
    }
    if (!VALID_MODELS.has(sample.model)) {
      throw new Error(`samples[${index}].model must be one of: abuse-risk, sybil-detection`);
    }
    if (sample.groundTruth !== 'abuse' && sample.groundTruth !== 'benign') {
      throw new Error(`samples[${index}].groundTruth must be one of: abuse, benign`);
    }

    return {
      sampleId: sample.sampleId?.trim() || `sample-${index + 1}`,
      actorClass: sample.actorClass,
      model: sample.model,
      score: clamp(sample.score, 0, 100),
      groundTruth: sample.groundTruth,
      observedAt: sample.observedAt || nowIso(),
    };
  }

  private assertMinimumSamplesPerActorClass(
    samples: Required<LabeledOutcomeSample>[],
    minimum: number,
  ): void {
    const counts: Record<ActorClass, number> = {
      human: 0,
      ai_agent: 0,
      robot: 0,
    };

    for (const sample of samples) {
      counts[sample.actorClass] += 1;
    }

    const missing = (Object.keys(counts) as ActorClass[]).filter(actorClass => counts[actorClass] < minimum);
    if (missing.length > 0) {
      throw new Error(
        `Insufficient labeled outcomes for actor classes: ${missing.join(', ')} (minimum ${minimum} each)`,
      );
    }
  }

  private computeMetrics(
    samples: Required<LabeledOutcomeSample>[],
    config: CalibrationConfig,
  ): CalibrationMetricsSnapshot {
    const byActorClass: Record<ActorClass, ConfusionMetrics> = {
      human: createEmptyConfusion(),
      ai_agent: createEmptyConfusion(),
      robot: createEmptyConfusion(),
    };

    const byModel: Record<CalibrationModel, ConfusionMetrics> = {
      'abuse-risk': createEmptyConfusion(),
      'sybil-detection': createEmptyConfusion(),
    };

    for (const sample of samples) {
      const threshold = sample.model === 'abuse-risk'
        ? config.thresholds.abuseRiskFlagThreshold
        : config.thresholds.sybilFlagThreshold;

      const flagged = sample.score >= threshold;
      const isAbuse = sample.groundTruth === 'abuse';

      this.applyConfusion(byActorClass[sample.actorClass], flagged, isAbuse);
      this.applyConfusion(byModel[sample.model], flagged, isAbuse);
    }

    const finalizedByActor: Record<ActorClass, ConfusionMetrics> = {
      human: this.finalizeConfusion(byActorClass.human),
      ai_agent: this.finalizeConfusion(byActorClass.ai_agent),
      robot: this.finalizeConfusion(byActorClass.robot),
    };

    const globalAggregate = this.finalizeConfusion(
      this.mergeConfusion([byActorClass.human, byActorClass.ai_agent, byActorClass.robot]),
    );

    const falsePositiveRateByActorClass: Record<ActorClass, number> = {
      human: finalizedByActor.human.falsePositiveRate,
      ai_agent: finalizedByActor.ai_agent.falsePositiveRate,
      robot: finalizedByActor.robot.falsePositiveRate,
    };

    const flagRates = [
      finalizedByActor.human.flagRate,
      finalizedByActor.ai_agent.flagRate,
      finalizedByActor.robot.flagRate,
    ];

    const fpRates = [
      finalizedByActor.human.falsePositiveRate,
      finalizedByActor.ai_agent.falsePositiveRate,
      finalizedByActor.robot.falsePositiveRate,
    ];

    return {
      generatedAt: nowIso(),
      configVersion: config.version,
      samples: samples.length,
      byActorClass: finalizedByActor,
      falsePositiveRateByActorClass,
      global: {
        falsePositiveRate: globalAggregate.falsePositiveRate,
        precision: globalAggregate.precision,
        recall: globalAggregate.recall,
        flagRate: globalAggregate.flagRate,
      },
      parity: {
        falsePositiveRateGap: Number((Math.max(...fpRates) - Math.min(...fpRates)).toFixed(4)),
        flagRateGap: Number((Math.max(...flagRates) - Math.min(...flagRates)).toFixed(4)),
      },
      modelMetrics: {
        'abuse-risk': {
          falsePositiveRate: this.finalizeConfusion(byModel['abuse-risk']).falsePositiveRate,
          precision: this.finalizeConfusion(byModel['abuse-risk']).precision,
          recall: this.finalizeConfusion(byModel['abuse-risk']).recall,
          threshold: config.thresholds.abuseRiskFlagThreshold,
          samples: byModel['abuse-risk'].samples,
        },
        'sybil-detection': {
          falsePositiveRate: this.finalizeConfusion(byModel['sybil-detection']).falsePositiveRate,
          precision: this.finalizeConfusion(byModel['sybil-detection']).precision,
          recall: this.finalizeConfusion(byModel['sybil-detection']).recall,
          threshold: config.thresholds.sybilFlagThreshold,
          samples: byModel['sybil-detection'].samples,
        },
      },
    };
  }

  private proposeThresholds(
    current: CalibrationThresholds,
    metrics: CalibrationMetricsSnapshot,
  ): CalibrationThresholds {
    let abuseThreshold = current.abuseRiskFlagThreshold;
    let sybilThreshold = current.sybilFlagThreshold;

    const targetFp = current.targetFalsePositiveRate;

    if (metrics.global.falsePositiveRate > targetFp + 0.01) {
      abuseThreshold += 5;
      sybilThreshold += 5;
    } else if (metrics.global.falsePositiveRate < targetFp * 0.5 && metrics.global.recall < 0.6) {
      abuseThreshold -= 3;
      sybilThreshold -= 3;
    }

    if (metrics.parity.falsePositiveRateGap > current.targetActorClassParityGap) {
      abuseThreshold += 2;
      sybilThreshold += 2;
    }

    return {
      ...current,
      abuseRiskFlagThreshold: clamp(Math.round(abuseThreshold), 10, 95),
      sybilFlagThreshold: clamp(Math.round(sybilThreshold), 10, 95),
    };
  }

  private applyConfusion(target: ConfusionMetrics, flagged: boolean, isAbuse: boolean): void {
    target.samples += 1;
    if (flagged) {
      target.flagged += 1;
    }

    if (flagged && isAbuse) target.tp += 1;
    if (flagged && !isAbuse) target.fp += 1;
    if (!flagged && !isAbuse) target.tn += 1;
    if (!flagged && isAbuse) target.fn += 1;
  }

  private mergeConfusion(items: ConfusionMetrics[]): ConfusionMetrics {
    const merged = createEmptyConfusion();
    for (const item of items) {
      merged.tp += item.tp;
      merged.fp += item.fp;
      merged.tn += item.tn;
      merged.fn += item.fn;
      merged.samples += item.samples;
      merged.flagged += item.flagged;
    }
    return merged;
  }

  private finalizeConfusion(item: ConfusionMetrics): ConfusionMetrics {
    return {
      ...item,
      falsePositiveRate: safeRate(item.fp, item.fp + item.tn),
      precision: safeRate(item.tp, item.tp + item.fp),
      recall: safeRate(item.tp, item.tp + item.fn),
      flagRate: safeRate(item.flagged, item.samples),
    };
  }

  private markConfigStatus(version: string, status: CalibrationConfig['status']): void {
    const config = this.mustGetConfig(version);
    this.configs.set(version, { ...config, status });
  }

  private pushAuditEvent(event: Omit<CalibrationAuditEvent, 'id' | 'timestamp'>): void {
    const record: CalibrationAuditEvent = {
      ...event,
      id: `CAL-AUD-${String(this.nextAuditId++).padStart(6, '0')}`,
      timestamp: nowIso(),
    };
    this.audit.unshift(record);
  }

  private mustGetConfig(version: string): CalibrationConfig {
    const config = this.configs.get(version);
    if (!config) {
      throw new Error(`Calibration config not found: ${version}`);
    }
    return config;
  }
}

export const integrityThresholdCalibrationService = new IntegrityThresholdCalibrationService();
