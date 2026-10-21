import crypto from 'crypto';

export type ActorClass = 'human' | 'ai_agent' | 'robot';
export type RiskBand = 'low' | 'moderate' | 'high' | 'critical';
export type RiskOutcome =
  | 'confirmed_abuse'
  | 'false_positive'
  | 'appeal_upheld'
  | 'appeal_overturned';

export type RiskFactorKey =
  | 'spam_burst'
  | 'duplicate_payload'
  | 'failed_submission_rate'
  | 'shared_counterparty_overlap'
  | 'reciprocal_cluster_rate'
  | 'coordinated_timing_pattern'
  | 'price_impact_anomaly'
  | 'rapid_reversal_pattern'
  | 'sanction_recidivism';

export interface RiskFactorDefinition {
  key: RiskFactorKey;
  category: 'spam' | 'collusion' | 'manipulation';
  weight: number;
  warnThreshold: number;
  highThreshold: number;
  rationale: string;
}

export interface RiskAssessmentInput {
  participantId: string;
  actorClass: ActorClass;
  indicators: Partial<Record<RiskFactorKey, number>>;
  evidenceConfidence?: number;
  appealOverturnRate?: number;
  observedAt?: string;
}

export interface RiskFactorBreakdown {
  key: RiskFactorKey;
  category: 'spam' | 'collusion' | 'manipulation';
  indicator: number;
  weight: number;
  contributionScore: number;
  thresholdStatus: 'below_warn' | 'warn' | 'high';
  rationale: string;
}

export interface FalsePositiveHandlingPath {
  reviewRequired: boolean;
  recommendedAction:
    | 'monitor'
    | 'manual_review'
    | 'challenge_window'
    | 'expedited_appeal';
  steps: string[];
  actorClassNeutrality: true;
}

export interface AbuseRiskAssessment {
  assessmentId: string;
  participantRef: string;
  actorClass: ActorClass;
  riskScore: number;
  riskBand: RiskBand;
  observedAt: string;
  evidenceConfidence: number;
  appealOverturnRate: number;
  factors: RiskFactorBreakdown[];
  explainabilityNotes: string[];
  falsePositiveHandling: FalsePositiveHandlingPath;
  privacySafeTelemetry: true;
}

export interface AbuseRiskMetrics {
  totalAssessments: number;
  outcomes: Record<RiskOutcome, number>;
  precision: number | null;
  recallProxy: number | null;
  appealOverturnRate: number;
  falsePositiveRate: number;
  updatedAt: string;
}

const FACTOR_DEFINITIONS: Record<RiskFactorKey, RiskFactorDefinition> = {
  spam_burst: {
    key: 'spam_burst',
    category: 'spam',
    weight: 0.15,
    warnThreshold: 0.45,
    highThreshold: 0.75,
    rationale: 'Abnormal burst traffic indicates potential automated spam campaigns.',
  },
  duplicate_payload: {
    key: 'duplicate_payload',
    category: 'spam',
    weight: 0.12,
    warnThreshold: 0.35,
    highThreshold: 0.65,
    rationale:
      'Repeated near-identical submissions indicate low-entropy bot behavior.',
  },
  failed_submission_rate: {
    key: 'failed_submission_rate',
    category: 'spam',
    weight: 0.08,
    warnThreshold: 0.25,
    highThreshold: 0.5,
    rationale:
      'High rejection rates often correlate with scripted brute-force participation.',
  },
  shared_counterparty_overlap: {
    key: 'shared_counterparty_overlap',
    category: 'collusion',
    weight: 0.12,
    warnThreshold: 0.4,
    highThreshold: 0.7,
    rationale:
      'Dense overlap with the same counterparties can indicate farm-style coordination.',
  },
  reciprocal_cluster_rate: {
    key: 'reciprocal_cluster_rate',
    category: 'collusion',
    weight: 0.12,
    warnThreshold: 0.35,
    highThreshold: 0.65,
    rationale:
      'High reciprocal exchange concentration may indicate circular coordination.',
  },
  coordinated_timing_pattern: {
    key: 'coordinated_timing_pattern',
    category: 'collusion',
    weight: 0.1,
    warnThreshold: 0.3,
    highThreshold: 0.6,
    rationale:
      'Synchronized timing with peer clusters indicates possible coordinated behavior.',
  },
  price_impact_anomaly: {
    key: 'price_impact_anomaly',
    category: 'manipulation',
    weight: 0.13,
    warnThreshold: 0.3,
    highThreshold: 0.6,
    rationale:
      'Disproportionate market impact relative to typical activity indicates manipulation risk.',
  },
  rapid_reversal_pattern: {
    key: 'rapid_reversal_pattern',
    category: 'manipulation',
    weight: 0.1,
    warnThreshold: 0.25,
    highThreshold: 0.5,
    rationale:
      'Fast in-out reversal sequences are common in wash or baiting behavior.',
  },
  sanction_recidivism: {
    key: 'sanction_recidivism',
    category: 'manipulation',
    weight: 0.08,
    warnThreshold: 0.2,
    highThreshold: 0.5,
    rationale:
      'Repeated sanction history increases prior probability of future abuse.',
  },
};

const FACTOR_KEYS = Object.keys(FACTOR_DEFINITIONS) as RiskFactorKey[];
const VALID_ACTOR_CLASSES: ReadonlySet<string> = new Set<ActorClass>([
  'human',
  'ai_agent',
  'robot',
]);

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function stableHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function toIso(value?: string): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function deriveRiskBand(score: number): RiskBand {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'moderate';
  return 'low';
}

function thresholdStatus(
  value: number,
  definition: RiskFactorDefinition
): 'below_warn' | 'warn' | 'high' {
  if (value >= definition.highThreshold) return 'high';
  if (value >= definition.warnThreshold) return 'warn';
  return 'below_warn';
}

function buildFalsePositivePath(input: {
  riskBand: RiskBand;
  evidenceConfidence: number;
  appealOverturnRate: number;
}): FalsePositiveHandlingPath {
  const lowConfidence = input.evidenceConfidence < 0.6;
  const elevatedOverturnRate = input.appealOverturnRate >= 0.2;

  if ((input.riskBand === 'high' || input.riskBand === 'critical') && !lowConfidence && !elevatedOverturnRate) {
    return {
      reviewRequired: true,
      recommendedAction: 'challenge_window',
      steps: [
        'Open a 24-hour challenge window before automatic sanction request.',
        'Collect additional corroborating evidence from independent signals.',
        'Escalate to sanctions orchestration only if challenge window closes cleanly.',
      ],
      actorClassNeutrality: true,
    };
  }

  if (input.riskBand === 'high' || input.riskBand === 'critical' || lowConfidence || elevatedOverturnRate) {
    return {
      reviewRequired: true,
      recommendedAction: elevatedOverturnRate ? 'expedited_appeal' : 'manual_review',
      steps: [
        'Route assessment to analyst queue for manual validation.',
        'Preserve explainability factors and raw indicator snapshots for audit.',
        'If sanction is applied, auto-enroll case into fast-track appeal workflow.',
      ],
      actorClassNeutrality: true,
    };
  }

  return {
    reviewRequired: false,
    recommendedAction: 'monitor',
    steps: [
      'Keep participant under passive monitoring only.',
      'Re-score on new evidence without punitive action.',
      'Escalate to review only if risk trend remains upward.',
    ],
    actorClassNeutrality: true,
  };
}

export class AbuseRiskService {
  private readonly assessments: Map<string, AbuseRiskAssessment> = new Map();
  private readonly outcomes: Map<string, RiskOutcome> = new Map();
  private nextId = 1;

  getFactorDefinitions(): RiskFactorDefinition[] {
    return FACTOR_KEYS.map(key => ({ ...FACTOR_DEFINITIONS[key] }));
  }

  assessParticipant(input: RiskAssessmentInput): AbuseRiskAssessment {
    if (!input.participantId || typeof input.participantId !== 'string') {
      throw new Error('participantId is required');
    }
    if (!VALID_ACTOR_CLASSES.has(input.actorClass)) {
      throw new Error('actorClass must be one of: human, ai_agent, robot');
    }

    const evidenceConfidence = clampUnit(input.evidenceConfidence ?? 0.7);
    const appealOverturnRate = clampUnit(input.appealOverturnRate ?? 0);
    const observedAt = toIso(input.observedAt);

    const factors: RiskFactorBreakdown[] = FACTOR_KEYS.map(key => {
      const definition = FACTOR_DEFINITIONS[key];
      const indicator = clampUnit(input.indicators[key] ?? 0);
      const contributionScore = Number((indicator * definition.weight * 100).toFixed(2));
      return {
        key,
        category: definition.category,
        indicator,
        weight: definition.weight,
        contributionScore,
        thresholdStatus: thresholdStatus(indicator, definition),
        rationale: definition.rationale,
      };
    }).sort((a, b) => b.contributionScore - a.contributionScore);

    const riskScore = Number(
      factors.reduce((total, factor) => total + factor.contributionScore, 0).toFixed(2)
    );
    const riskBand = deriveRiskBand(riskScore);

    const explainabilityNotes = factors
      .filter(factor => factor.contributionScore > 0)
      .slice(0, 3)
      .map(
        factor =>
          `${factor.key} contributed ${factor.contributionScore.toFixed(2)} points (${factor.thresholdStatus})`
      );

    const falsePositiveHandling = buildFalsePositivePath({
      riskBand,
      evidenceConfidence,
      appealOverturnRate,
    });

    const assessment: AbuseRiskAssessment = {
      assessmentId: `RISK-${String(this.nextId++).padStart(6, '0')}`,
      participantRef: stableHash(input.participantId),
      actorClass: input.actorClass,
      riskScore,
      riskBand,
      observedAt,
      evidenceConfidence,
      appealOverturnRate,
      factors,
      explainabilityNotes,
      falsePositiveHandling,
      privacySafeTelemetry: true,
    };

    this.assessments.set(assessment.assessmentId, assessment);
    return assessment;
  }

  getAssessment(assessmentId: string): AbuseRiskAssessment | null {
    return this.assessments.get(assessmentId) ?? null;
  }

  listAssessments(filters: { riskBand?: RiskBand } = {}): AbuseRiskAssessment[] {
    const values = Array.from(this.assessments.values());
    if (!filters.riskBand) {
      return values;
    }
    return values.filter(assessment => assessment.riskBand === filters.riskBand);
  }

  recordOutcome(assessmentId: string, outcome: RiskOutcome): AbuseRiskAssessment {
    const assessment = this.assessments.get(assessmentId);
    if (!assessment) {
      throw new Error(`Assessment not found: ${assessmentId}`);
    }
    this.outcomes.set(assessmentId, outcome);
    return assessment;
  }

  getMetrics(): AbuseRiskMetrics {
    const counts: Record<RiskOutcome, number> = {
      confirmed_abuse: 0,
      false_positive: 0,
      appeal_upheld: 0,
      appeal_overturned: 0,
    };

    for (const outcome of this.outcomes.values()) {
      counts[outcome] += 1;
    }

    const resolved = counts.confirmed_abuse + counts.false_positive;
    const reviewedAppeals = counts.appeal_upheld + counts.appeal_overturned;
    const precision = resolved > 0 ? Number((counts.confirmed_abuse / resolved).toFixed(4)) : null;
    const recallProxyDenominator = counts.confirmed_abuse + counts.appeal_overturned;
    const recallProxy =
      recallProxyDenominator > 0
        ? Number((counts.confirmed_abuse / recallProxyDenominator).toFixed(4))
        : null;
    const appealOverturnRate =
      reviewedAppeals > 0 ? Number((counts.appeal_overturned / reviewedAppeals).toFixed(4)) : 0;
    const falsePositiveRate =
      resolved > 0 ? Number((counts.false_positive / resolved).toFixed(4)) : 0;

    return {
      totalAssessments: this.assessments.size,
      outcomes: counts,
      precision,
      recallProxy,
      appealOverturnRate,
      falsePositiveRate,
      updatedAt: new Date().toISOString(),
    };
  }
}

export const abuseRiskService = new AbuseRiskService();
