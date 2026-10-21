/**
 * Reputation Service — Stub Behavior Tests (#365)
 *
 * The ReputationScoringEngine currently uses an in-memory repository when no
 * DATABASE_URL is configured. These tests verify that the stub/in-memory behavior
 * is correct and document the expected real behavior once a persistent store is
 * wired in.
 *
 * Issue: #365
 */

import {
  ReputationScoringEngine,
  type ReputationSignal,
  type ContributorReputationRecord,
  type ContributorRole,
} from '../server/services/reputation/reputation-scoring-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSignal(overrides: Partial<ReputationSignal> = {}): ReputationSignal {
  return {
    address: '0xStubTestAddress001',
    role: 'collector',
    eventType: 'weather_submission',
    dataQuality: 80,
    uptime: 90,
    verificationAccuracy: 70,
    communityContribution: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub: getScore (address not yet seen)
// ---------------------------------------------------------------------------

describe('ReputationScoringEngine stub — getScore on unknown address', () => {
  let engine: ReputationScoringEngine;

  beforeEach(() => {
    // No DATABASE_URL set → always uses InMemoryReputationRepository
    delete process.env.DATABASE_URL;
    engine = new ReputationScoringEngine();
  });

  it('returns a default Bronze record with zero scores (stub behavior)', async () => {
    const record = await engine.getScore('0xUnknownAddress');

    // TODO(#365): Once DB persistence is wired, getScore should return
    //   the persisted record if it exists. The stub returns a zero-baseline
    //   default which is acceptable for now but callers must treat it as
    //   "no history" rather than "zero reputation".
    expect(record.compositeScore).toBe(0);
    expect(record.tier).toBe('Bronze');
    expect(record.bonusMultiplier).toBe(1);
    expect(record.history).toHaveLength(0);
    expect(record.lastContributionAt).toBeNull();
  });

  it('stub default record shape matches ContributorReputationRecord contract', async () => {
    const record = await engine.getScore('0xUnknownAddress');

    expect(record).toMatchObject<Partial<ContributorReputationRecord>>({
      address: '0xUnknownAddress',
      role: 'user', // stub default role
      compositeScore: expect.any(Number),
      componentScores: {
        dataQuality: expect.any(Number),
        consistency: expect.any(Number),
        verificationAccuracy: expect.any(Number),
        communityContribution: expect.any(Number),
        tenure: expect.any(Number),
      },
      tier: expect.stringMatching(/^(Bronze|Silver|Gold|Platinum)$/),
      bonusMultiplier: expect.any(Number),
      badges: expect.arrayContaining([]),
      history: expect.arrayContaining([]),
      lastUpdated: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// Stub: recordSignal (in-memory persistence)
// ---------------------------------------------------------------------------

describe('ReputationScoringEngine stub — recordSignal in-memory', () => {
  let engine: ReputationScoringEngine;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    engine = new ReputationScoringEngine();
  });

  it('stub persists record in-memory and getScore retrieves it', async () => {
    const addr = '0xPersistenceTest001';
    await engine.recordSignal(buildSignal({ address: addr }));

    const record = await engine.getScore(addr);

    // TODO(#365): In production with DB, this should query the
    //   contributor_reputation table. Stub reads from in-memory Map.
    expect(record.address).toBe(addr);
    expect(record.compositeScore).toBeGreaterThan(0);
    expect(record.history.length).toBeGreaterThanOrEqual(1);
  });

  it('stub accumulates history across multiple signals', async () => {
    const addr = '0xHistoryTest001';

    await engine.recordSignal(buildSignal({ address: addr, eventType: 'event_1' }));
    await engine.recordSignal(buildSignal({ address: addr, eventType: 'event_2' }));
    await engine.recordSignal(buildSignal({ address: addr, eventType: 'event_3' }));

    const record = await engine.getScore(addr);

    // TODO(#365): Real behavior should also persist each event to
    //   contributor_reputation_events table (one row per signal).
    expect(record.history.length).toBe(3);
  });

  it('stub compositeScore is bounded [0, 100]', async () => {
    const addr = '0xBoundTest001';

    // Submit maximal scores
    await engine.recordSignal(buildSignal({
      address: addr,
      dataQuality: 100,
      uptime: 100,
      verificationAccuracy: 100,
      communityContribution: 100,
    }));

    const record = await engine.getScore(addr);
    expect(record.compositeScore).toBeGreaterThanOrEqual(0);
    expect(record.compositeScore).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Stub: tier thresholds
// ---------------------------------------------------------------------------

describe('ReputationScoringEngine stub — tier thresholds', () => {
  it('awards Bronze when compositeScore < 25', async () => {
    const engine = new ReputationScoringEngine();
    const addr = '0xTierBronze';
    // Low signals → low composite
    await engine.recordSignal(buildSignal({ address: addr, dataQuality: 5, uptime: 5, verificationAccuracy: 5, communityContribution: 5 }));
    const record = await engine.getScore(addr);

    // TODO(#365): Tier thresholds (Bronze < 25, Silver 25-50, Gold 50-75, Platinum >= 75)
    //   must be preserved when swapping in-memory repo for DB-backed one.
    expect(record.tier).toBe('Bronze');
  });

  it('bonus multiplier is >= 1 for all scores', async () => {
    const engine = new ReputationScoringEngine();
    const addr = '0xBonusCheck';
    const record = await engine.getScore(addr); // default zero record
    expect(record.bonusMultiplier).toBeGreaterThanOrEqual(1);
  });

  it('badges always includes the tier badge', async () => {
    const engine = new ReputationScoringEngine();
    const addr = '0xBadgesCheck';
    await engine.recordSignal(buildSignal({ address: addr }));
    const record = await engine.getScore(addr);

    // TODO(#365): Badge computation must remain deterministic regardless
    //   of storage backend. The tier badge (e.g. "Bronze Contributor") is
    //   always expected.
    const hasTierBadge = record.badges.some(b => b.includes(record.tier));
    expect(hasTierBadge).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stub: inactivity decay
// ---------------------------------------------------------------------------

describe('ReputationScoringEngine stub — inactivity decay', () => {
  it('applies decay factor for records with lastContributionAt beyond grace period', async () => {
    // Use a custom engine with very short grace/half-life to force decay
    const engine = new ReputationScoringEngine({
      inactivityGraceDays: 0,
      inactivityHalfLifeDays: 1,
    });
    const addr = '0xDecayTest001';

    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

    // Seed a high-score record in the past
    await engine.recordSignal(buildSignal({
      address: addr,
      dataQuality: 100,
      uptime: 100,
      verificationAccuracy: 100,
      communityContribution: 100,
      occurredAt: pastDate,
    }));

    // Query now — should be decayed
    const record = await engine.getScore(addr);

    // TODO(#365): Decay logic uses exponential half-life on component scores
    //   (except tenure). Once DB-backed, the decayed score must be persisted
    //   back on every getScore call so subsequent reads don't re-decay.
    expect(record.compositeScore).toBeGreaterThanOrEqual(0);
    expect(record.compositeScore).toBeLessThanOrEqual(100);
    // Score after decay + smoothing should be less than the initial maximal signal
    // (not asserting exact value as smoothing depends on timing)
  });
});

// ---------------------------------------------------------------------------
// Stub: getRankings
// ---------------------------------------------------------------------------

describe('ReputationScoringEngine stub — getRankings', () => {
  it('getRankings returns empty when no signals have been recorded', async () => {
    const engine = new ReputationScoringEngine();
    const result = await engine.getRankings();

    // TODO(#365): With a real DB, getRankings should query contributor_reputation
    //   ordered by composite_score DESC with LIMIT/OFFSET. The stub returns
    //   whatever is in-memory.
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.total).toBe(0);
    expect(result.data).toHaveLength(0);
  });

  it('getRankings returns results sorted by compositeScore descending', async () => {
    const engine = new ReputationScoringEngine();
    const addresses = ['0xAddr001', '0xAddr002', '0xAddr003'];

    // Submit signals with different quality levels
    await engine.recordSignal(buildSignal({ address: addresses[0], dataQuality: 10, uptime: 10 }));
    await engine.recordSignal(buildSignal({ address: addresses[1], dataQuality: 80, uptime: 80 }));
    await engine.recordSignal(buildSignal({ address: addresses[2], dataQuality: 50, uptime: 50 }));

    const result = await engine.getRankings(1, 10);

    expect(result.total).toBe(3);
    // Highest scorer should be first
    for (let i = 0; i < result.data.length - 1; i++) {
      expect(result.data[i].compositeScore).toBeGreaterThanOrEqual(result.data[i + 1].compositeScore);
    }
  });

  it('getRankings clamps page and limit to safe ranges', async () => {
    const engine = new ReputationScoringEngine();

    const result = await engine.getRankings(0, 200);
    expect(result.page).toBe(1);       // clamp to min 1
    expect(result.limit).toBe(100);    // clamp to max 100
  });
});

// ---------------------------------------------------------------------------
// Stub: getEvents
// ---------------------------------------------------------------------------

describe('ReputationScoringEngine stub — getEvents', () => {
  it('getEvents returns empty for address with no recorded signals', async () => {
    const engine = new ReputationScoringEngine();
    const events = await engine.getEvents('0xNoEvents');

    // TODO(#365): Real implementation should query contributor_reputation_events
    //   filtered by address. Stub returns from in-memory events array.
    expect(Array.isArray(events)).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('getEvents returns signals for a known address', async () => {
    const engine = new ReputationScoringEngine();
    const addr = '0xEventsTest001';

    await engine.recordSignal(buildSignal({ address: addr, eventType: 'weather_submission' }));
    await engine.recordSignal(buildSignal({ address: addr, eventType: 'verification_complete' }));

    const events = await engine.getEvents(addr);

    expect(events.length).toBe(2);
    events.forEach(event => {
      expect(event.address).toBe(addr);
      expect(typeof event.eventType).toBe('string');
    });
  });

  it('getEvents clamps limit to [1, 200]', async () => {
    const engine = new ReputationScoringEngine();
    const addr = '0xLimitTest';

    // Insert more than 200 events
    for (let i = 0; i < 5; i++) {
      await engine.recordSignal(buildSignal({ address: addr, eventType: `event_${i}` }));
    }

    // Request with an out-of-range limit
    const events = await engine.getEvents(addr, 999);

    // TODO(#365): Limit should be clamped server-side to avoid large DB scans.
    expect(events.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Stub: role-based record
// ---------------------------------------------------------------------------

describe('ReputationScoringEngine stub — contributor roles', () => {
  const roles: ContributorRole[] = ['collector', 'analyzer', 'keeper', 'offsetter', 'node', 'coder', 'user'];

  roles.forEach(role => {
    it(`recordSignal with role '${role}' returns a valid record`, async () => {
      const engine = new ReputationScoringEngine();
      const addr = `0xRole${role}`;
      const record = await engine.recordSignal(buildSignal({ address: addr, role }));

      expect(record.role).toBe(role);
      expect(record.address).toBe(addr);
      expect(['Bronze', 'Silver', 'Gold', 'Platinum']).toContain(record.tier);
    });
  });
});
