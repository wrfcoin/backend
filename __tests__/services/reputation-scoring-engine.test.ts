import { ReputationScoringEngine } from '../../server/services/reputation/reputation-scoring-engine.js';

describe('ReputationScoringEngine', () => {
  it('computes score tiers and applies inactivity decay', async () => {
    const engine = new ReputationScoringEngine({
      inactivityGraceDays: 30,
      inactivityHalfLifeDays: 30,
    });

    const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

    const first = await engine.recordSignal({
      address,
      role: 'collector',
      eventType: 'weather_submission',
      dataQuality: 95,
      uptime: 94,
      verificationAccuracy: 93,
      communityContribution: 80,
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    expect(first.compositeScore).toBeGreaterThan(0);

    const decayed = await engine.recordSignal({
      address,
      role: 'collector',
      eventType: 'weather_submission',
      dataQuality: 10,
      uptime: 10,
      verificationAccuracy: 10,
      communityContribution: 10,
      occurredAt: '2026-03-04T00:00:00.000Z',
    });

    expect(decayed.compositeScore).toBeLessThan(first.compositeScore);
    expect(['Bronze', 'Silver', 'Gold', 'Platinum']).toContain(decayed.tier);
  });
});
