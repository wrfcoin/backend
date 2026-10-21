import crypto from 'crypto';
import type { ForecastAccuracyMetrics } from '../../../shared/generated-types/index.js';

export type { ForecastAccuracyMetrics } from '../../../shared/generated-types/index.js';

export interface EnsembleDomainBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface EnsembleValidTimeRange {
  start: string;
  end: string;
}

export interface EnsembleSubmissionInput {
  modelId: string;
  modelName?: string;
  contributorAddress?: string;
  domainBounds: EnsembleDomainBounds;
  validTimeRange: EnsembleValidTimeRange;
  forecastRef?: {
    cid?: string;
    model?: string;
    runId?: string;
  };
  metrics?: ForecastAccuracyMetrics;
  metadata?: Record<string, unknown>;
}

export interface EnsembleSubmissionRecord {
  submissionId: string;
  roundId: string;
  modelId: string;
  modelName: string;
  contributorAddress: string | null;
  domainBounds: EnsembleDomainBounds;
  validTimeRange: EnsembleValidTimeRange;
  forecastRef: {
    cid: string | null;
    model: string | null;
    runId: string | null;
  };
  metrics: ForecastAccuracyMetrics | null;
  status: 'pending' | 'scored';
  submittedAt: string;
  scoredAt: string | null;
  metadata: Record<string, unknown>;
}

export interface EnsembleModelStanding {
  modelId: string;
  modelName: string;
  rounds: number;
  wins: number;
  winRate: number;
  lastSkillScore: number;
  meanSkillScore: number;
  decayedSkillScore: number;
  retirement: {
    retired: boolean;
    consecutiveBelowThreshold: number;
    threshold: number;
    roundsToRetire: number;
  };
  popWeighting: {
    skill_score: number;
    multiplier: number;
  };
  lastScoredAt: string | null;
}

export interface EnsembleRoundSummary {
  roundId: string;
  scoredAt: string;
  winnerModelId: string | null;
  participants: number;
}

interface EnsembleScoreRecord {
  roundId: string;
  modelId: string;
  skillScore: number;
  scoredAt: string;
}

interface EnsembleModelAggregate {
  modelId: string;
  modelName: string;
  rounds: number;
  wins: number;
  totalSkill: number;
  lastSkill: number;
  decayedSkill: number;
  lastScoredAt: string | null;
  consecutiveBelowThreshold: number;
  retired: boolean;
}

interface EnsembleRepository {
  loadState(): Promise<{
    submissions: EnsembleSubmissionRecord[];
    rounds: EnsembleRoundSummary[];
    scores: EnsembleScoreRecord[];
    standings: EnsembleModelAggregate[];
  }>;
  saveSubmission(record: EnsembleSubmissionRecord): Promise<void>;
  saveRound(round: EnsembleRoundSummary): Promise<void>;
  saveScores(scores: EnsembleScoreRecord[]): Promise<void>;
  saveStanding(standing: EnsembleModelAggregate): Promise<void>;
}

class InMemoryEnsembleRepository implements EnsembleRepository {
  private readonly submissions = new Map<string, EnsembleSubmissionRecord>();
  private readonly rounds = new Map<string, EnsembleRoundSummary>();
  private readonly scores: EnsembleScoreRecord[] = [];
  private readonly standings = new Map<string, EnsembleModelAggregate>();

  async loadState() {
    return {
      submissions: Array.from(this.submissions.values()),
      rounds: Array.from(this.rounds.values()),
      scores: [...this.scores],
      standings: Array.from(this.standings.values()),
    };
  }

  async saveSubmission(record: EnsembleSubmissionRecord): Promise<void> {
    this.submissions.set(record.submissionId, record);
  }

  async saveRound(round: EnsembleRoundSummary): Promise<void> {
    this.rounds.set(round.roundId, round);
  }

  async saveScores(scores: EnsembleScoreRecord[]): Promise<void> {
    this.scores.push(...scores);
  }

  async saveStanding(standing: EnsembleModelAggregate): Promise<void> {
    this.standings.set(standing.modelId, standing);
  }
}

class DatabaseEnsembleRepository implements EnsembleRepository {
  private readonly fallback = new InMemoryEnsembleRepository();
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

  async loadState() {
    const ready = await this.init();
    if (!ready) {
      return this.fallback.loadState();
    }

    const [submissions, rounds, scores, standings] = await Promise.all([
      this.db.select().from(this.schema.forecastEnsembleSubmissions),
      this.db.select().from(this.schema.forecastEnsembleRounds),
      this.db.select().from(this.schema.forecastEnsembleScores),
      this.db.select().from(this.schema.forecastModelLifecycle),
    ]);

    return {
      submissions: submissions.map((row: any) => ({
        submissionId: row.submissionId,
        roundId: row.roundId,
        modelId: row.modelId,
        modelName: row.modelName,
        contributorAddress: row.contributorAddress,
        domainBounds: row.domainBounds,
        validTimeRange: row.validTimeRange,
        forecastRef: row.forecastRef,
        metrics: row.metrics,
        status: row.status,
        submittedAt: row.submittedAt.toISOString(),
        scoredAt: row.scoredAt ? row.scoredAt.toISOString() : null,
        metadata: row.metadata || {},
      })),
      rounds: rounds.map((row: any) => ({
        roundId: row.roundId,
        scoredAt: row.scoredAt.toISOString(),
        winnerModelId: row.winnerModelId,
        participants: row.participants,
      })),
      scores: scores.map((row: any) => ({
        roundId: row.roundId,
        modelId: row.modelId,
        skillScore: Number(row.skillScore),
        scoredAt: row.scoredAt.toISOString(),
      })),
      standings: standings.map((row: any) => ({
        modelId: row.modelId,
        modelName: row.modelName,
        rounds: row.rounds,
        wins: row.wins,
        totalSkill: Number(row.totalSkill),
        lastSkill: Number(row.lastSkill),
        decayedSkill: Number(row.decayedSkill),
        lastScoredAt: row.lastScoredAt ? row.lastScoredAt.toISOString() : null,
        consecutiveBelowThreshold: row.consecutiveBelowThreshold,
        retired: row.retired,
      })),
    };
  }

  async saveSubmission(record: EnsembleSubmissionRecord): Promise<void> {
    const ready = await this.init();
    if (!ready) {
      return this.fallback.saveSubmission(record);
    }

    await this.db
      .insert(this.schema.forecastEnsembleSubmissions)
      .values({
        submissionId: record.submissionId,
        roundId: record.roundId,
        modelId: record.modelId,
        modelName: record.modelName,
        contributorAddress: record.contributorAddress,
        domainBounds: record.domainBounds,
        validTimeRange: record.validTimeRange,
        forecastRef: record.forecastRef,
        metrics: record.metrics,
        status: record.status,
        submittedAt: new Date(record.submittedAt),
        scoredAt: record.scoredAt ? new Date(record.scoredAt) : null,
        metadata: record.metadata,
      })
      .onConflictDoUpdate({
        target: this.schema.forecastEnsembleSubmissions.submissionId,
        set: {
          status: record.status,
          scoredAt: record.scoredAt ? new Date(record.scoredAt) : null,
          metrics: record.metrics,
          metadata: record.metadata,
        },
      });
  }

  async saveRound(round: EnsembleRoundSummary): Promise<void> {
    const ready = await this.init();
    if (!ready) {
      return this.fallback.saveRound(round);
    }

    await this.db
      .insert(this.schema.forecastEnsembleRounds)
      .values({
        roundId: round.roundId,
        scoredAt: new Date(round.scoredAt),
        winnerModelId: round.winnerModelId,
        participants: round.participants,
      })
      .onConflictDoNothing();
  }

  async saveScores(scores: EnsembleScoreRecord[]): Promise<void> {
    const ready = await this.init();
    if (!ready) {
      return this.fallback.saveScores(scores);
    }

    if (!scores.length) {
      return;
    }

    await this.db.insert(this.schema.forecastEnsembleScores).values(
      scores.map(score => ({
        roundId: score.roundId,
        modelId: score.modelId,
        skillScore: score.skillScore,
        scoredAt: new Date(score.scoredAt),
      }))
    );
  }

  async saveStanding(standing: EnsembleModelAggregate): Promise<void> {
    const ready = await this.init();
    if (!ready) {
      return this.fallback.saveStanding(standing);
    }

    await this.db
      .insert(this.schema.forecastModelLifecycle)
      .values({
        modelId: standing.modelId,
        modelName: standing.modelName,
        rounds: standing.rounds,
        wins: standing.wins,
        totalSkill: standing.totalSkill,
        lastSkill: standing.lastSkill,
        decayedSkill: standing.decayedSkill,
        lastScoredAt: standing.lastScoredAt ? new Date(standing.lastScoredAt) : null,
        consecutiveBelowThreshold: standing.consecutiveBelowThreshold,
        retired: standing.retired,
      })
      .onConflictDoUpdate({
        target: this.schema.forecastModelLifecycle.modelId,
        set: {
          modelName: standing.modelName,
          rounds: standing.rounds,
          wins: standing.wins,
          totalSkill: standing.totalSkill,
          lastSkill: standing.lastSkill,
          decayedSkill: standing.decayedSkill,
          lastScoredAt: standing.lastScoredAt ? new Date(standing.lastScoredAt) : null,
          consecutiveBelowThreshold: standing.consecutiveBelowThreshold,
          retired: standing.retired,
          updatedAt: new Date(),
        },
      });
  }
}

interface EnsembleCompetitionServiceOptions {
  halfLifeDays?: number;
  retirementThreshold?: number;
  retirementConsecutiveRounds?: number;
  nowFn?: () => Date;
  repository?: EnsembleRepository;
}

export class EnsembleCompetitionService {
  private readonly nowFn: () => Date;
  private readonly halfLifeDays: number;
  private readonly retirementThreshold: number;
  private readonly retirementConsecutiveRounds: number;
  private readonly repository: EnsembleRepository;

  private readonly submissions = new Map<string, EnsembleSubmissionRecord>();
  private readonly rounds = new Map<string, EnsembleRoundSummary>();
  private readonly standings = new Map<string, EnsembleModelAggregate>();
  private hydrated = false;

  constructor(options: EnsembleCompetitionServiceOptions = {}) {
    this.nowFn = options.nowFn || (() => new Date());
    this.halfLifeDays = clampPositive(options.halfLifeDays ?? 14, 14);
    this.retirementThreshold = clampRange(options.retirementThreshold ?? 0.35, 0, 1, 0.35);
    this.retirementConsecutiveRounds = Math.max(
      1,
      Math.floor(options.retirementConsecutiveRounds ?? 3)
    );
    this.repository = options.repository || new DatabaseEnsembleRepository();
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) {
      return;
    }

    const state = await this.repository.loadState();
    for (const submission of state.submissions) {
      this.submissions.set(submission.submissionId, submission);
    }
    for (const round of state.rounds) {
      this.rounds.set(round.roundId, round);
    }
    for (const standing of state.standings) {
      this.standings.set(standing.modelId, standing);
    }

    this.hydrated = true;
  }

  async registerSubmission(input: EnsembleSubmissionInput): Promise<{
    submission: EnsembleSubmissionRecord;
    autoScored: boolean;
  }> {
    await this.hydrate();
    validateSubmissionInput(input);

    const nowIso = this.nowFn().toISOString();
    const roundId = computeRoundId(input.domainBounds, input.validTimeRange);

    const submission: EnsembleSubmissionRecord = {
      submissionId: `ens_sub_${crypto.randomUUID().replace(/-/g, '')}`,
      roundId,
      modelId: input.modelId,
      modelName: nonEmpty(input.modelName) || input.modelId,
      contributorAddress: nonEmpty(input.contributorAddress),
      domainBounds: input.domainBounds,
      validTimeRange: input.validTimeRange,
      forecastRef: {
        cid: nonEmpty(input.forecastRef?.cid),
        model: nonEmpty(input.forecastRef?.model),
        runId: nonEmpty(input.forecastRef?.runId),
      },
      metrics: input.metrics ? normalizeMetrics(input.metrics) : null,
      status: 'pending',
      submittedAt: nowIso,
      scoredAt: null,
      metadata: input.metadata || {},
    };

    this.submissions.set(submission.submissionId, submission);
    await this.repository.saveSubmission(submission);

    const autoScored = Date.parse(input.validTimeRange.end) <= Date.parse(nowIso);
    if (autoScored) {
      await this.scoreClosedRounds();
    }

    return { submission: this.submissions.get(submission.submissionId)!, autoScored };
  }

  async scoreClosedRounds(now = this.nowFn()): Promise<{
    scoredRounds: EnsembleRoundSummary[];
    updatedModels: number;
  }> {
    await this.hydrate();

    const nowMs = now.getTime();
    const byRound = groupPendingByRound(
      Array.from(this.submissions.values()).filter(record => record.status === 'pending')
    );

    const scoredRounds: EnsembleRoundSummary[] = [];
    const touchedModels = new Set<string>();

    for (const [roundId, roundSubmissions] of byRound.entries()) {
      if (!roundSubmissions.length) continue;
      const endMs = Date.parse(roundSubmissions[0].validTimeRange.end);
      if (!Number.isFinite(endMs) || endMs > nowMs) {
        continue;
      }

      const scoredAt = now.toISOString();
      const scoreRows: EnsembleScoreRecord[] = [];
      let winnerModelId: string | null = null;
      let winnerSkill = -1;

      for (const submission of roundSubmissions) {
        const metrics = submission.metrics || deterministicMissingMetrics(submission);
        const skill = clampRange(metrics.skill_score, 0, 1, 0);

        scoreRows.push({
          roundId,
          modelId: submission.modelId,
          skillScore: skill,
          scoredAt,
        });

        if (skill > winnerSkill) {
          winnerSkill = skill;
          winnerModelId = submission.modelId;
        }

        const standing = this.updateStanding(submission, skill, scoredAt, false);
        this.standings.set(standing.modelId, standing);
        touchedModels.add(standing.modelId);

        const scoredSubmission: EnsembleSubmissionRecord = {
          ...submission,
          metrics,
          status: 'scored',
          scoredAt,
        };
        this.submissions.set(submission.submissionId, scoredSubmission);
        await this.repository.saveSubmission(scoredSubmission);
      }

      if (winnerModelId) {
        const winnerStanding = this.standings.get(winnerModelId);
        if (winnerStanding) {
          winnerStanding.wins += 1;
          this.standings.set(winnerModelId, winnerStanding);
          await this.repository.saveStanding(winnerStanding);
        }
      }

      const round: EnsembleRoundSummary = {
        roundId,
        scoredAt,
        winnerModelId,
        participants: roundSubmissions.length,
      };

      this.rounds.set(roundId, round);
      scoredRounds.push(round);
      await this.repository.saveRound(round);
      await this.repository.saveScores(scoreRows);
    }

    for (const modelId of touchedModels) {
      const standing = this.standings.get(modelId);
      if (standing) {
        await this.repository.saveStanding(standing);
      }
    }

    return {
      scoredRounds,
      updatedModels: touchedModels.size,
    };
  }

  private updateStanding(
    submission: EnsembleSubmissionRecord,
    skillScore: number,
    scoredAt: string,
    isWinner: boolean
  ): EnsembleModelAggregate {
    const existing = this.standings.get(submission.modelId);
    if (!existing) {
      const below = skillScore < this.retirementThreshold ? 1 : 0;
      return {
        modelId: submission.modelId,
        modelName: submission.modelName,
        rounds: 1,
        wins: isWinner ? 1 : 0,
        totalSkill: skillScore,
        lastSkill: skillScore,
        decayedSkill: skillScore,
        lastScoredAt: scoredAt,
        consecutiveBelowThreshold: below,
        retired: below >= this.retirementConsecutiveRounds,
      };
    }

    const decayFactor = computeDecayFactor(existing.lastScoredAt, scoredAt, this.halfLifeDays);
    const decayedSkill = Number(
      (existing.decayedSkill * decayFactor + skillScore * (1 - decayFactor)).toFixed(6)
    );

    const consecutiveBelowThreshold =
      skillScore < this.retirementThreshold ? existing.consecutiveBelowThreshold + 1 : 0;

    return {
      ...existing,
      rounds: existing.rounds + 1,
      totalSkill: Number((existing.totalSkill + skillScore).toFixed(6)),
      lastSkill: skillScore,
      decayedSkill,
      lastScoredAt: scoredAt,
      consecutiveBelowThreshold,
      retired: consecutiveBelowThreshold >= this.retirementConsecutiveRounds,
    };
  }

  async getLeaderboard(options: {
    sortBy?: 'skill_score' | 'decayed_skill' | 'win_rate' | 'rounds';
    order?: 'asc' | 'desc';
    limit?: number;
  } = {}): Promise<{ standings: EnsembleModelStanding[]; generatedAt: string }> {
    await this.hydrate();
    await this.scoreClosedRounds();

    const sortBy = options.sortBy || 'decayed_skill';
    const order = options.order === 'asc' ? 'asc' : 'desc';
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));

    const standings = Array.from(this.standings.values()).map(standing => toModelStanding(
      standing,
      this.retirementThreshold,
      this.retirementConsecutiveRounds
    ));

    standings.sort((a, b) => {
      const direction = order === 'asc' ? 1 : -1;
      switch (sortBy) {
        case 'skill_score':
          return direction * (a.lastSkillScore - b.lastSkillScore);
        case 'win_rate':
          return direction * (a.winRate - b.winRate);
        case 'rounds':
          return direction * (a.rounds - b.rounds);
        default:
          return direction * (a.decayedSkillScore - b.decayedSkillScore);
      }
    });

    return {
      standings: standings.slice(0, limit),
      generatedAt: this.nowFn().toISOString(),
    };
  }

  async getModelStatus(modelId: string): Promise<EnsembleModelStanding | null> {
    await this.hydrate();
    const standing = this.standings.get(modelId);
    if (!standing) {
      return null;
    }

    return toModelStanding(
      standing,
      this.retirementThreshold,
      this.retirementConsecutiveRounds
    );
  }

  async getSubmissionsForRound(roundId: string): Promise<EnsembleSubmissionRecord[]> {
    await this.hydrate();
    return Array.from(this.submissions.values())
      .filter(submission => submission.roundId === roundId)
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  }
}

function toModelStanding(
  standing: EnsembleModelAggregate,
  retirementThreshold: number,
  retirementConsecutiveRounds: number
): EnsembleModelStanding {
  const meanSkillScore =
    standing.rounds > 0 ? Number((standing.totalSkill / standing.rounds).toFixed(6)) : 0;
  const winRate = standing.rounds > 0 ? Number((standing.wins / standing.rounds).toFixed(6)) : 0;
  const multiplier = Number((0.5 + standing.decayedSkill).toFixed(6));

  return {
    modelId: standing.modelId,
    modelName: standing.modelName,
    rounds: standing.rounds,
    wins: standing.wins,
    winRate,
    lastSkillScore: standing.lastSkill,
    meanSkillScore,
    decayedSkillScore: standing.decayedSkill,
    retirement: {
      retired: standing.retired,
      consecutiveBelowThreshold: standing.consecutiveBelowThreshold,
      threshold: retirementThreshold,
      roundsToRetire: retirementConsecutiveRounds,
    },
    popWeighting: {
      skill_score: standing.decayedSkill,
      multiplier,
    },
    lastScoredAt: standing.lastScoredAt,
  };
}

function groupPendingByRound(
  submissions: EnsembleSubmissionRecord[]
): Map<string, EnsembleSubmissionRecord[]> {
  const grouped = new Map<string, EnsembleSubmissionRecord[]>();
  for (const submission of submissions) {
    const list = grouped.get(submission.roundId) || [];
    list.push(submission);
    grouped.set(submission.roundId, list);
  }
  return grouped;
}

function deterministicMissingMetrics(submission: EnsembleSubmissionRecord): ForecastAccuracyMetrics {
  const seed = `${submission.modelId}:${submission.roundId}`;
  const digest = crypto.createHash('sha256').update(seed).digest();
  const normalized = digest[0] / 255;
  const skill = Number((normalized * 0.35).toFixed(6));

  return {
    mae: Number((1.5 + normalized).toFixed(6)),
    rmse: Number((2.0 + normalized).toFixed(6)),
    bias: Number((normalized - 0.5).toFixed(6)),
    skill_score: skill,
  };
}

function normalizeMetrics(metrics: ForecastAccuracyMetrics): ForecastAccuracyMetrics {
  return {
    mae: clampNonNegative(metrics.mae),
    rmse: clampNonNegative(metrics.rmse),
    bias: Number(Number(metrics.bias || 0).toFixed(6)),
    skill_score: clampRange(metrics.skill_score, 0, 1, 0),
  };
}

function computeRoundId(
  bounds: EnsembleDomainBounds,
  range: EnsembleValidTimeRange
): string {
  const canonical = JSON.stringify({
    bounds: {
      north: Number(bounds.north.toFixed(6)),
      south: Number(bounds.south.toFixed(6)),
      east: Number(bounds.east.toFixed(6)),
      west: Number(bounds.west.toFixed(6)),
    },
    start: new Date(range.start).toISOString(),
    end: new Date(range.end).toISOString(),
  });

  return `ens_round_${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20)}`;
}

function validateSubmissionInput(input: EnsembleSubmissionInput): void {
  if (!nonEmpty(input.modelId)) {
    throw new Error('modelId is required');
  }

  const start = Date.parse(input.validTimeRange?.start || '');
  const end = Date.parse(input.validTimeRange?.end || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('validTimeRange.start/end must be valid ISO timestamps and start < end');
  }

  validateBounds(input.domainBounds);

  if (input.metrics) {
    normalizeMetrics(input.metrics);
  }
}

function validateBounds(bounds: EnsembleDomainBounds): void {
  const values = [bounds?.north, bounds?.south, bounds?.east, bounds?.west];
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('domainBounds must include finite north/south/east/west values');
  }

  if (bounds.north <= bounds.south || bounds.east <= bounds.west) {
    throw new Error('domainBounds must satisfy north > south and east > west');
  }
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Number(value.toFixed(6));
}

function clampRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Number(Math.max(min, Math.min(max, value)).toFixed(6));
}

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function computeDecayFactor(
  previousIso: string | null,
  currentIso: string,
  halfLifeDays: number
): number {
  if (!previousIso) {
    return 0;
  }

  const prev = Date.parse(previousIso);
  const curr = Date.parse(currentIso);
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || curr <= prev) {
    return 0;
  }

  const deltaDays = (curr - prev) / (24 * 60 * 60 * 1000);
  const decayFactor = Math.pow(0.5, deltaDays / halfLifeDays);
  return Number(Math.max(0, Math.min(1, decayFactor)).toFixed(6));
}
