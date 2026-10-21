import { desc, eq } from 'drizzle-orm';

export type ContributorRole =
  | 'collector'
  | 'analyzer'
  | 'keeper'
  | 'offsetter'
  | 'node'
  | 'coder'
  | 'user';

export interface ReputationSignal {
  address: string;
  role: ContributorRole;
  eventType: string;
  dataQuality?: number;
  uptime?: number;
  verificationAccuracy?: number;
  communityContribution?: number;
  details?: Record<string, unknown>;
  occurredAt?: string;
}

export interface ContributorReputationRecord {
  address: string;
  role: ContributorRole;
  compositeScore: number;
  componentScores: {
    dataQuality: number;
    consistency: number;
    verificationAccuracy: number;
    communityContribution: number;
    tenure: number;
  };
  tier: 'Bronze' | 'Silver' | 'Gold' | 'Platinum';
  bonusMultiplier: number;
  badges: string[];
  history: Array<Record<string, unknown>>;
  lastContributionAt: string | null;
  lastUpdated: string;
}

interface ReputationRepository {
  get(address: string): Promise<ContributorReputationRecord | null>;
  upsert(record: ContributorReputationRecord): Promise<void>;
  appendEvent(signal: ReputationSignal): Promise<void>;
  listEvents(address: string, limit: number): Promise<ReputationSignal[]>;
  listRankings(offset: number, limit: number): Promise<ContributorReputationRecord[]>;
}

class InMemoryReputationRepository implements ReputationRepository {
  private readonly records = new Map<string, ContributorReputationRecord>();
  private readonly events: ReputationSignal[] = [];

  async get(address: string): Promise<ContributorReputationRecord | null> {
    return this.records.get(address) || null;
  }

  async upsert(record: ContributorReputationRecord): Promise<void> {
    this.records.set(record.address, record);
  }

  async appendEvent(signal: ReputationSignal): Promise<void> {
    this.events.push({ ...signal });
  }

  async listEvents(address: string, limit: number): Promise<ReputationSignal[]> {
    return this.events
      .filter(event => event.address === address)
      .slice(-limit)
      .reverse();
  }

  async listRankings(offset: number, limit: number): Promise<ContributorReputationRecord[]> {
    return Array.from(this.records.values())
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(offset, offset + limit);
  }
}

class DatabaseReputationRepository implements ReputationRepository {
  private initialized = false;
  private db: any;
  private schema: any;
  private fallback: InMemoryReputationRepository;

  constructor(fallback: InMemoryReputationRepository) {
    this.fallback = fallback;
  }

  private async init(): Promise<boolean> {
    if (this.initialized) return true;
    if (!process.env.DATABASE_URL) return false;

    try {
      const dbModule = await import('../../db.js');
      const schema = await import('../../../shared/schema.js');
      this.db = dbModule.db;
      this.schema = schema;
      this.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  async get(address: string): Promise<ContributorReputationRecord | null> {
    const ready = await this.init();
    if (!ready) return this.fallback.get(address);

    const rows = await this.db
      .select()
      .from(this.schema.contributorReputation)
      .where(eq(this.schema.contributorReputation.address, address))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      address: row.address,
      role: row.role,
      compositeScore: Number(row.compositeScore || 0),
      componentScores: {
        dataQuality: Number(row.dataQualityScore || 0),
        consistency: Number(row.consistencyScore || 0),
        verificationAccuracy: Number(row.verificationAccuracyScore || 0),
        communityContribution: Number(row.communityContributionScore || 0),
        tenure: Number(row.tenureScore || 0),
      },
      tier: row.tier,
      bonusMultiplier: Number(row.bonusMultiplier || 1),
      badges: Array.isArray(row.badges) ? row.badges : [],
      history: Array.isArray(row.history) ? row.history : [],
      lastContributionAt: row.lastContributionAt ? row.lastContributionAt.toISOString() : null,
      lastUpdated: row.lastUpdated.toISOString(),
    };
  }

  async upsert(record: ContributorReputationRecord): Promise<void> {
    const ready = await this.init();
    if (!ready) return this.fallback.upsert(record);

    const payload = {
      address: record.address,
      role: record.role,
      compositeScore: record.compositeScore,
      dataQualityScore: record.componentScores.dataQuality,
      consistencyScore: record.componentScores.consistency,
      verificationAccuracyScore: record.componentScores.verificationAccuracy,
      communityContributionScore: record.componentScores.communityContribution,
      tenureScore: record.componentScores.tenure,
      bonusMultiplier: record.bonusMultiplier,
      tier: record.tier,
      badges: record.badges,
      history: record.history,
      lastContributionAt: record.lastContributionAt ? new Date(record.lastContributionAt) : null,
      lastUpdated: new Date(record.lastUpdated),
      metadata: { source: 'backend-62-reputation-engine' },
    };

    await this.db
      .insert(this.schema.contributorReputation)
      .values(payload)
      .onConflictDoUpdate({
        target: this.schema.contributorReputation.address,
        set: payload,
      });
  }

  async appendEvent(signal: ReputationSignal): Promise<void> {
    const ready = await this.init();
    if (!ready) return this.fallback.appendEvent(signal);

    await this.db.insert(this.schema.contributorReputationEvents).values({
      address: signal.address,
      role: signal.role,
      eventType: signal.eventType,
      dataQuality: normalizeScore(signal.dataQuality ?? 0),
      uptime: normalizeScore(signal.uptime ?? 0),
      verificationAccuracy: normalizeScore(signal.verificationAccuracy ?? 0),
      communityContribution: normalizeScore(signal.communityContribution ?? 0),
      details: signal.details ?? null,
    });
  }

  async listEvents(address: string, limit: number): Promise<ReputationSignal[]> {
    const ready = await this.init();
    if (!ready) return this.fallback.listEvents(address, limit);

    const rows = await this.db
      .select()
      .from(this.schema.contributorReputationEvents)
      .where(eq(this.schema.contributorReputationEvents.address, address))
      .orderBy(desc(this.schema.contributorReputationEvents.createdAt))
      .limit(limit);

    return rows.map((row: any) => ({
      address: row.address,
      role: row.role,
      eventType: row.eventType,
      dataQuality: Number(row.dataQuality || 0),
      uptime: Number(row.uptime || 0),
      verificationAccuracy: Number(row.verificationAccuracy || 0),
      communityContribution: Number(row.communityContribution || 0),
      details: row.details || undefined,
      occurredAt: row.createdAt.toISOString(),
    }));
  }

  async listRankings(offset: number, limit: number): Promise<ContributorReputationRecord[]> {
    const ready = await this.init();
    if (!ready) return this.fallback.listRankings(offset, limit);

    const rows = await this.db
      .select()
      .from(this.schema.contributorReputation)
      .orderBy(desc(this.schema.contributorReputation.compositeScore))
      .limit(limit)
      .offset(offset);

    return rows.map((row: any) => ({
      address: row.address,
      role: row.role,
      compositeScore: Number(row.compositeScore || 0),
      componentScores: {
        dataQuality: Number(row.dataQualityScore || 0),
        consistency: Number(row.consistencyScore || 0),
        verificationAccuracy: Number(row.verificationAccuracyScore || 0),
        communityContribution: Number(row.communityContributionScore || 0),
        tenure: Number(row.tenureScore || 0),
      },
      tier: row.tier,
      bonusMultiplier: Number(row.bonusMultiplier || 1),
      badges: Array.isArray(row.badges) ? row.badges : [],
      history: Array.isArray(row.history) ? row.history : [],
      lastContributionAt: row.lastContributionAt ? row.lastContributionAt.toISOString() : null,
      lastUpdated: row.lastUpdated.toISOString(),
    }));
  }
}

interface ReputationScoringEngineOptions {
  inactivityGraceDays?: number;
  inactivityHalfLifeDays?: number;
}

export class ReputationScoringEngine {
  private readonly inactivityGraceDays: number;
  private readonly inactivityHalfLifeDays: number;
  private readonly inMemory = new InMemoryReputationRepository();
  private readonly repository: ReputationRepository;

  constructor(options: ReputationScoringEngineOptions = {}) {
    this.inactivityGraceDays = options.inactivityGraceDays ?? 30;
    this.inactivityHalfLifeDays = options.inactivityHalfLifeDays ?? 30;
    this.repository = new DatabaseReputationRepository(this.inMemory);
  }

  async recordSignal(signal: ReputationSignal): Promise<ContributorReputationRecord> {
    assertAddress(signal.address);
    const normalizedSignal = {
      ...signal,
      dataQuality: normalizeScore(signal.dataQuality ?? 0),
      uptime: normalizeScore(signal.uptime ?? 0),
      verificationAccuracy: normalizeScore(signal.verificationAccuracy ?? 0),
      communityContribution: normalizeScore(signal.communityContribution ?? 0),
    };

    const existing = await this.repository.get(signal.address);
    const nowIso = normalizeIso(signal.occurredAt);
    const seeded = existing ?? this.buildDefault(signal.address, signal.role, nowIso);
    const decayed = this.applyDecay(seeded, nowIso);

    const updated: ContributorReputationRecord = {
      ...decayed,
      role: signal.role,
      componentScores: {
        dataQuality: smooth(decayed.componentScores.dataQuality, normalizedSignal.dataQuality),
        consistency: smooth(decayed.componentScores.consistency, normalizedSignal.uptime),
        verificationAccuracy: smooth(
          decayed.componentScores.verificationAccuracy,
          normalizedSignal.verificationAccuracy
        ),
        communityContribution: smooth(
          decayed.componentScores.communityContribution,
          normalizedSignal.communityContribution
        ),
        tenure: computeTenureScore(decayed.history.length + 1),
      },
      history: [...decayed.history.slice(-199), {
        eventType: signal.eventType,
        scoreSignals: {
          dataQuality: normalizedSignal.dataQuality,
          uptime: normalizedSignal.uptime,
          verificationAccuracy: normalizedSignal.verificationAccuracy,
          communityContribution: normalizedSignal.communityContribution,
        },
        details: signal.details ?? null,
        at: nowIso,
      }],
      lastContributionAt: nowIso,
      lastUpdated: nowIso,
    };

    updated.compositeScore = computeComposite(updated.componentScores);
    updated.tier = computeTier(updated.compositeScore);
    updated.bonusMultiplier = computeBonusMultiplier(updated.compositeScore);
    updated.badges = computeBadges(updated);

    await this.repository.appendEvent(normalizedSignal);
    await this.repository.upsert(updated);
    return updated;
  }

  async getScore(address: string): Promise<ContributorReputationRecord> {
    assertAddress(address);
    const nowIso = new Date().toISOString();
    const existing = await this.repository.get(address);
    if (!existing) {
      return this.buildDefault(address, 'user', nowIso);
    }

    const decayed = this.applyDecay(existing, nowIso);
    await this.repository.upsert(decayed);
    return decayed;
  }

  async getRankings(page = 1, limit = 20): Promise<{
    page: number;
    limit: number;
    total: number;
    data: ContributorReputationRecord[];
  }> {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const offset = (safePage - 1) * safeLimit;

    const data = await this.repository.listRankings(offset, safeLimit);
    return {
      page: safePage,
      limit: safeLimit,
      total: data.length,
      data,
    };
  }

  async getEvents(address: string, limit = 50): Promise<ReputationSignal[]> {
    assertAddress(address);
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    return this.repository.listEvents(address, safeLimit);
  }

  private buildDefault(
    address: string,
    role: ContributorRole,
    nowIso: string
  ): ContributorReputationRecord {
    return {
      address,
      role,
      compositeScore: 0,
      componentScores: {
        dataQuality: 0,
        consistency: 0,
        verificationAccuracy: 0,
        communityContribution: 0,
        tenure: 0,
      },
      tier: 'Bronze',
      bonusMultiplier: 1,
      badges: [],
      history: [],
      lastContributionAt: null,
      lastUpdated: nowIso,
    };
  }

  private applyDecay(
    record: ContributorReputationRecord,
    nowIso: string
  ): ContributorReputationRecord {
    if (!record.lastContributionAt) {
      return {
        ...record,
        lastUpdated: nowIso,
      };
    }

    const now = Date.parse(nowIso);
    const last = Date.parse(record.lastContributionAt);
    const inactiveDays = Math.max(0, (now - last) / (24 * 60 * 60 * 1000));

    if (inactiveDays <= this.inactivityGraceDays) {
      return {
        ...record,
        lastUpdated: nowIso,
      };
    }

    const postGraceDays = inactiveDays - this.inactivityGraceDays;
    const decayFactor = Math.pow(0.5, postGraceDays / this.inactivityHalfLifeDays);

    const decayedComponents = {
      dataQuality: clampScore(record.componentScores.dataQuality * decayFactor),
      consistency: clampScore(record.componentScores.consistency * decayFactor),
      verificationAccuracy: clampScore(record.componentScores.verificationAccuracy * decayFactor),
      communityContribution: clampScore(record.componentScores.communityContribution * decayFactor),
      tenure: record.componentScores.tenure,
    };

    const compositeScore = computeComposite(decayedComponents);

    return {
      ...record,
      componentScores: decayedComponents,
      compositeScore,
      tier: computeTier(compositeScore),
      bonusMultiplier: computeBonusMultiplier(compositeScore),
      badges: computeBadges({ ...record, componentScores: decayedComponents, compositeScore }),
      lastUpdated: nowIso,
    };
  }
}

function assertAddress(address: string): void {
  if (!address || typeof address !== 'string') {
    throw new Error('address is required');
  }
}

function normalizeIso(input?: string): string {
  if (!input) return new Date().toISOString();
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function normalizeScore(value: number): number {
  return clampScore(Number.isFinite(value) ? value : 0);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Number(value)));
}

function smooth(previous: number, incoming: number): number {
  const next = previous * 0.7 + incoming * 0.3;
  return Number(next.toFixed(4));
}

function computeTenureScore(eventCount: number): number {
  if (eventCount >= 365) return 100;
  return Number(Math.min(100, eventCount / 3.65).toFixed(4));
}

function computeComposite(scores: ContributorReputationRecord['componentScores']): number {
  const weighted =
    scores.dataQuality * 0.3 +
    scores.consistency * 0.25 +
    scores.verificationAccuracy * 0.25 +
    scores.communityContribution * 0.1 +
    scores.tenure * 0.1;

  return Number(weighted.toFixed(4));
}

function computeTier(score: number): 'Bronze' | 'Silver' | 'Gold' | 'Platinum' {
  if (score >= 75) return 'Platinum';
  if (score >= 50) return 'Gold';
  if (score >= 25) return 'Silver';
  return 'Bronze';
}

function computeBonusMultiplier(score: number): number {
  return Number((1 + score / 200).toFixed(4));
}

function computeBadges(
  record: Pick<ContributorReputationRecord, 'tier' | 'componentScores' | 'compositeScore'>
): string[] {
  const badges = new Set<string>();

  badges.add(`${record.tier} Contributor`);
  if (record.componentScores.dataQuality >= 90) badges.add('Data Quality Guardian');
  if (record.componentScores.verificationAccuracy >= 90) badges.add('Verification Sentinel');
  if (record.componentScores.consistency >= 85) badges.add('Consistency Anchor');
  if (record.compositeScore >= 95) badges.add('Network Vanguard');

  return Array.from(badges);
}

export const reputationScoringEngine = new ReputationScoringEngine();
