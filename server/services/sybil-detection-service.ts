import crypto from 'crypto';

export type ActorClass = 'human' | 'ai_agent' | 'robot';
export type SybilRiskLevel = 'none' | 'suspicious' | 'probable_sybil' | 'confirmed_cluster';

export type SybilRuleKey =
  | 'ip_node_density'
  | 'subnet_density'
  | 'asn_density'
  | 'did_reuse_count'
  | 'device_fingerprint_collisions'
  | 'temporal_sync_score'
  | 'payload_similarity_score'
  | 'reward_destination_overlap';

export interface SybilThresholdRule {
  key: SybilRuleKey;
  category: 'network' | 'identity' | 'behavioral';
  measurement: 'count' | 'ratio';
  warnThreshold: number;
  highThreshold: number;
  weight: number;
  rationale: string;
}

export interface SybilThresholdConfig {
  version: string;
  policyHashReference: string;
  retainedEvidenceDays: number;
  rules: Record<SybilRuleKey, SybilThresholdRule>;
}

export interface SybilDetectionInput {
  participantId: string;
  actorClass: ActorClass;
  indicators: Partial<Record<SybilRuleKey, number>>;
  source?: string;
  observedAt?: string;
}

export interface SybilRuleFinding {
  key: SybilRuleKey;
  category: 'network' | 'identity' | 'behavioral';
  measurement: 'count' | 'ratio';
  observed: number;
  warnThreshold: number;
  highThreshold: number;
  status: 'below_warn' | 'warn' | 'high';
  contributionScore: number;
  rationale: string;
}

export interface SybilEvidenceArtifact {
  artifactId: string;
  reportId: string;
  type: 'network_snapshot' | 'identity_linkage' | 'behavior_trace' | 'manual_review_note';
  summary: string;
  referenceHash: string;
  createdAt: string;
  retainedUntil: string;
}

export interface SybilDetectionReport {
  reportId: string;
  participantRef: string;
  actorClass: ActorClass;
  source: string;
  observedAt: string;
  thresholdVersion: string;
  policyHashReference: string;
  riskScore: number;
  riskLevel: SybilRiskLevel;
  findings: SybilRuleFinding[];
  explainabilityNotes: string[];
  evidenceArtifacts: SybilEvidenceArtifact[];
  privacySafeTelemetry: true;
}

const VALID_ACTOR_CLASSES: ReadonlySet<string> = new Set<ActorClass>([
  'human',
  'ai_agent',
  'robot',
]);

const THRESHOLD_CONFIG: SybilThresholdConfig = {
  version: '2026-03-04.v1',
  policyHashReference: 'sha256:sybil-thresholds-v1-20260304',
  retainedEvidenceDays: 90,
  rules: {
    ip_node_density: {
      key: 'ip_node_density',
      category: 'network',
      measurement: 'count',
      warnThreshold: 2,
      highThreshold: 4,
      weight: 0.14,
      rationale:
        'Multiple registrations sharing one IP in a short window indicate possible farming.',
    },
    subnet_density: {
      key: 'subnet_density',
      category: 'network',
      measurement: 'count',
      warnThreshold: 4,
      highThreshold: 8,
      weight: 0.14,
      rationale:
        'Concentrated registrations within a narrow subnet suggest coordinated infrastructure.',
    },
    asn_density: {
      key: 'asn_density',
      category: 'network',
      measurement: 'count',
      warnThreshold: 12,
      highThreshold: 20,
      weight: 0.09,
      rationale:
        'Heavy concentration inside one ASN can indicate centralized operator control.',
    },
    did_reuse_count: {
      key: 'did_reuse_count',
      category: 'identity',
      measurement: 'count',
      warnThreshold: 2,
      highThreshold: 4,
      weight: 0.14,
      rationale:
        'A single decentralized identifier repeatedly tied to many nodes is a sybil signal.',
    },
    device_fingerprint_collisions: {
      key: 'device_fingerprint_collisions',
      category: 'identity',
      measurement: 'count',
      warnThreshold: 3,
      highThreshold: 6,
      weight: 0.12,
      rationale:
        'Repeated device-level collisions suggest account farm orchestration.',
    },
    temporal_sync_score: {
      key: 'temporal_sync_score',
      category: 'behavioral',
      measurement: 'ratio',
      warnThreshold: 0.45,
      highThreshold: 0.7,
      weight: 0.12,
      rationale:
        'Highly synchronized action timing across participants is a collusion indicator.',
    },
    payload_similarity_score: {
      key: 'payload_similarity_score',
      category: 'behavioral',
      measurement: 'ratio',
      warnThreshold: 0.5,
      highThreshold: 0.75,
      weight: 0.12,
      rationale:
        'Near-identical submission payloads suggest scripted multi-account behavior.',
    },
    reward_destination_overlap: {
      key: 'reward_destination_overlap',
      category: 'behavioral',
      measurement: 'ratio',
      warnThreshold: 0.35,
      highThreshold: 0.65,
      weight: 0.13,
      rationale:
        'Strong payout convergence toward shared destinations indicates farm ownership overlap.',
    },
  },
};

const RULE_KEYS = Object.keys(THRESHOLD_CONFIG.rules) as SybilRuleKey[];

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

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function evaluateStatus(
  observed: number,
  rule: SybilThresholdRule
): 'below_warn' | 'warn' | 'high' {
  if (observed >= rule.highThreshold) return 'high';
  if (observed >= rule.warnThreshold) return 'warn';
  return 'below_warn';
}

function normalizeObserved(observed: number, rule: SybilThresholdRule): number {
  if (rule.measurement === 'ratio') {
    return clamp(observed, 0, 1);
  }
  const normalizationMax = Math.max(rule.highThreshold * 1.5, 1);
  return clamp(observed / normalizationMax, 0, 1);
}

function deriveRiskLevel(score: number): SybilRiskLevel {
  if (score >= 75) return 'confirmed_cluster';
  if (score >= 55) return 'probable_sybil';
  if (score >= 35) return 'suspicious';
  return 'none';
}

export class SybilDetectionService {
  private readonly reports: Map<string, SybilDetectionReport> = new Map();
  private readonly evidenceByReport: Map<string, SybilEvidenceArtifact[]> = new Map();
  private nextReportId = 1;
  private nextEvidenceId = 1;

  getThresholdConfig(): SybilThresholdConfig {
    return {
      ...THRESHOLD_CONFIG,
      rules: { ...THRESHOLD_CONFIG.rules },
    };
  }

  detect(input: SybilDetectionInput): SybilDetectionReport {
    if (!input.participantId || typeof input.participantId !== 'string') {
      throw new Error('participantId is required');
    }
    if (!VALID_ACTOR_CLASSES.has(input.actorClass)) {
      throw new Error('actorClass must be one of: human, ai_agent, robot');
    }

    const reportId = `SYB-${String(this.nextReportId++).padStart(6, '0')}`;
    const observedAt = toIso(input.observedAt);
    const source = input.source?.trim() || 'unknown';

    const findings: SybilRuleFinding[] = RULE_KEYS.map(key => {
      const rule = THRESHOLD_CONFIG.rules[key];
      const observed = clamp(Number(input.indicators[key] ?? 0), 0, Number.MAX_SAFE_INTEGER);
      const normalized = normalizeObserved(observed, rule);
      const contributionScore = Number((normalized * rule.weight * 100).toFixed(2));
      return {
        key,
        category: rule.category,
        measurement: rule.measurement,
        observed,
        warnThreshold: rule.warnThreshold,
        highThreshold: rule.highThreshold,
        status: evaluateStatus(observed, rule),
        contributionScore,
        rationale: rule.rationale,
      };
    }).sort((a, b) => b.contributionScore - a.contributionScore);

    const riskScore = Number(
      findings.reduce((sum, finding) => sum + finding.contributionScore, 0).toFixed(2)
    );
    const riskLevel = deriveRiskLevel(riskScore);

    const explainabilityNotes = findings
      .filter(finding => finding.status !== 'below_warn')
      .slice(0, 4)
      .map(
        finding =>
          `${finding.key} observed ${finding.observed} (warn=${finding.warnThreshold}, high=${finding.highThreshold})`
      );

    const evidenceArtifacts = this.buildInitialEvidence(reportId, input.participantId, findings, observedAt);

    const report: SybilDetectionReport = {
      reportId,
      participantRef: stableHash(input.participantId),
      actorClass: input.actorClass,
      source,
      observedAt,
      thresholdVersion: THRESHOLD_CONFIG.version,
      policyHashReference: THRESHOLD_CONFIG.policyHashReference,
      riskScore,
      riskLevel,
      findings,
      explainabilityNotes,
      evidenceArtifacts,
      privacySafeTelemetry: true,
    };

    this.reports.set(reportId, report);
    this.evidenceByReport.set(reportId, evidenceArtifacts);
    return report;
  }

  listReports(filters: { riskLevel?: SybilRiskLevel } = {}): SybilDetectionReport[] {
    const reports = Array.from(this.reports.values());
    if (!filters.riskLevel) return reports;
    return reports.filter(report => report.riskLevel === filters.riskLevel);
  }

  getReport(reportId: string): SybilDetectionReport | null {
    return this.reports.get(reportId) ?? null;
  }

  getEvidence(reportId: string): SybilEvidenceArtifact[] {
    return [...(this.evidenceByReport.get(reportId) ?? [])];
  }

  appendEvidence(
    reportId: string,
    input: { type: SybilEvidenceArtifact['type']; summary: string; opaqueReference: string }
  ): SybilEvidenceArtifact {
    const report = this.reports.get(reportId);
    if (!report) {
      throw new Error(`Report not found: ${reportId}`);
    }
    if (!input.summary) {
      throw new Error('summary is required');
    }
    if (!input.opaqueReference) {
      throw new Error('opaqueReference is required');
    }

    const artifact = this.makeEvidenceArtifact(
      reportId,
      input.type,
      input.summary,
      stableHash(`${reportId}:${input.opaqueReference}:${nowIso()}`),
      nowIso()
    );

    const existing = this.evidenceByReport.get(reportId) ?? [];
    existing.push(artifact);
    this.evidenceByReport.set(reportId, existing);

    report.evidenceArtifacts = [...existing];
    this.reports.set(reportId, report);

    return artifact;
  }

  private buildInitialEvidence(
    reportId: string,
    participantId: string,
    findings: SybilRuleFinding[],
    createdAt: string
  ): SybilEvidenceArtifact[] {
    const triggered = findings.filter(finding => finding.status !== 'below_warn');
    if (triggered.length === 0) {
      return [
        this.makeEvidenceArtifact(
          reportId,
          'manual_review_note',
          'No threshold breaches; baseline report stored for longitudinal review.',
          stableHash(`${participantId}:baseline:${createdAt}`),
          createdAt
        ),
      ];
    }

    return triggered.map(finding => {
      const type: SybilEvidenceArtifact['type'] =
        finding.category === 'network'
          ? 'network_snapshot'
          : finding.category === 'identity'
            ? 'identity_linkage'
            : 'behavior_trace';

      return this.makeEvidenceArtifact(
        reportId,
        type,
        `${finding.key} exceeded ${finding.status} threshold with observed=${finding.observed}.`,
        stableHash(`${participantId}:${finding.key}:${finding.observed}:${createdAt}`),
        createdAt
      );
    });
  }

  private makeEvidenceArtifact(
    reportId: string,
    type: SybilEvidenceArtifact['type'],
    summary: string,
    referenceHash: string,
    createdAt: string
  ): SybilEvidenceArtifact {
    const retainedUntil = new Date(
      new Date(createdAt).getTime() + THRESHOLD_CONFIG.retainedEvidenceDays * 24 * 60 * 60 * 1000
    ).toISOString();

    return {
      artifactId: `EV-SYB-${String(this.nextEvidenceId++).padStart(6, '0')}`,
      reportId,
      type,
      summary,
      referenceHash,
      createdAt,
      retainedUntil,
    };
  }
}

export const sybilDetectionService = new SybilDetectionService();
